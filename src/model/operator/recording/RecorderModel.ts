import * as events from 'events';
import * as fs from 'fs';
import * as http from 'http';
import { inject, injectable } from 'inversify';
import * as path from 'path';
import * as stream from 'stream';
import * as mapid from '../../../../node_modules/mirakurun/api';
import * as apid from '../../../../api';
import DropLogFile from '../../../db/entities/DropLogFile';
import Recorded from '../../../db/entities/Recorded';
import RecordedHistory from '../../../db/entities/RecordedHistory';
import Reserve from '../../../db/entities/Reserve';
import VideoFile from '../../../db/entities/VideoFile';
import FileUtil from '../../../util/FileUtil';
import StrUtil from '../../../util/StrUtil';
import IDropLogFileDB from '../../db/IDropLogFileDB';
import IProgramDB from '../../db/IProgramDB';
import IRecordedDB from '../../db/IRecordedDB';
import IRecordedHistoryDB from '../../db/IRecordedHistoryDB';
import IReserveDB from '../../db/IReserveDB';
import IVideoFileDB from '../../db/IVideoFileDB';
import IRecordingEvent from '../../event/IRecordingEvent';
import IConfigFile from '../../IConfigFile';
import IConfiguration from '../../IConfiguration';
import ILogger from '../../ILogger';
import ILoggerModel from '../../ILoggerModel';
import IMirakurunClientModel from '../../IMirakurunClientModel';
import IDropCheckerModel from './IDropCheckerModel';
import IRecorderModel, { isReserveOnAir, isUndeterminedEnd } from './IRecorderModel';
import IRecordingStreamCreator from './IRecordingStreamCreator';
import IRecordingUtilModel, { RecFilePathInfo } from './IRecordingUtilModel';

/**
 * Recorder
 */
@injectable()
class RecorderModel implements IRecorderModel {
    private log: ILogger;
    private config: IConfigFile;
    private programDB: IProgramDB;
    private reserveDB: IReserveDB;
    private recordedDB: IRecordedDB;
    private recordedHistoryDB: IRecordedHistoryDB;
    private videoFileDB: IVideoFileDB;
    private dropLogFileDB: IDropLogFileDB;
    private streamCreator: IRecordingStreamCreator;
    private dropChecker: IDropCheckerModel;
    private recordingUtil: IRecordingUtilModel;
    private recordingEvent: IRecordingEvent;
    private mirakurunClientModel: IMirakurunClientModel;

    private reserve!: Reserve;
    private recordedId: apid.RecordedId | null = null;
    private videoFileId: apid.VideoFileId | null = null;
    private videoFileFulPath: string | null = null;
    private timerId: NodeJS.Timeout | null = null;
    private stream: http.IncomingMessage | null = null;
    private recFile: fs.WriteStream | null = null;
    private isStopPrepRec: boolean = false;
    private isNeedDeleteReservation: boolean = true;
    private isPrepRecording: boolean = false;
    private isRecording: boolean = false;
    private isPlanToDelete: boolean = false;
    private isCanceledCallingFinished: boolean = false; // mirakurun の stream の終了検知をキャンセルするか
    private eventEmitter = new events.EventEmitter();

    private dropLogFileId: apid.DropLogFileId | null = null;

    private abortController: AbortController | null = null;

    // イベントリレータイマー
    private eventRelayTimerId: NodeJS.Timeout | null = null;
    // 予定の時刻にイベントリレーを確認したか (未確認なら番組ストリームの終了時に確認する)
    private isEventRelayChecked: boolean = false;

    constructor(
        @inject('ILoggerModel') logger: ILoggerModel,
        @inject('IConfiguration') configuration: IConfiguration,
        @inject('IProgramDB') programDB: IProgramDB,
        @inject('IReserveDB') reserveDB: IReserveDB,
        @inject('IRecordedDB') recordedDB: IRecordedDB,
        @inject('IRecordedHistoryDB') recordedHistoryDB: IRecordedHistoryDB,
        @inject('IVideoFileDB') videoFileDB: IVideoFileDB,
        @inject('IDropLogFileDB') dropLogFileDB: IDropLogFileDB,
        @inject('IRecordingStreamCreator')
        streamCreator: IRecordingStreamCreator,
        @inject('IDropCheckerModel') dropChecker: IDropCheckerModel,
        @inject('IRecordingUtilModel') recordingUtil: IRecordingUtilModel,
        @inject('IRecordingEvent') recordingEvent: IRecordingEvent,
        @inject('IMirakurunClientModel') mirakurunClientModel: IMirakurunClientModel,
    ) {
        this.log = logger.getLogger();
        this.config = configuration.getConfig();
        this.programDB = programDB;
        this.reserveDB = reserveDB;
        this.recordedDB = recordedDB;
        this.recordedHistoryDB = recordedHistoryDB;
        this.videoFileDB = videoFileDB;
        this.dropLogFileDB = dropLogFileDB;
        this.streamCreator = streamCreator;
        this.dropChecker = dropChecker;
        this.recordingUtil = recordingUtil;
        this.recordingEvent = recordingEvent;
        this.mirakurunClientModel = mirakurunClientModel;
    }

    /**
     * タイマーをセットする
     * @param reserve: Reserve 予約情報
     * @param isSuppressLog: boolean ログ出力を抑えるか
     * @return boolean セットに成功したら true を返す
     */
    public setTimer(reserve: Reserve, isSuppressLog: boolean): boolean {
        this.reserve = reserve;

        // 除外, 重複しているものはタイマーをセットしない
        if (this.reserve.isSkip === true || this.reserve.isOverlap === true) {
            return false;
        }

        const now = new Date().getTime();
        if (isReserveOnAir(this.reserve, now) === false) {
            return false;
        }

        // 待機時間を計算
        let time = this.reserve.startAt - now - IRecordingStreamCreator.PREP_TIME;
        if (time < 0) {
            time = 0;
        }

        // タイマーをセット
        if (this.timerId !== null) {
            clearTimeout(this.timerId);
        }

        if (isSuppressLog === false) {
            this.log.system.info(`set timer: ${this.reserve.id}, ${time}`);
        }

        // setTimeout は MAX_TIMER_DELAY を超える待機時間を 1ms として扱い即時に発火するため、
        // それより先の予約は MAX_TIMER_DELAY 後にタイマーを再設定する
        if (time > RecorderModel.MAX_TIMER_DELAY) {
            this.timerId = setTimeout(() => {
                this.setTimer(this.reserve, true);
            }, RecorderModel.MAX_TIMER_DELAY);

            return true;
        }

        this.timerId = setTimeout(async () => {
            try {
                this.prepRecord();
            } catch (err: any) {
                this.log.system.error(`failed prep record: ${this.reserve.id}`);
            }
        }, time);

        return true;
    }

    /**
     * 録画準備
     * @param retry 再試行回数
     * @param failures 放送中に Mirakurun に接続できなかった失敗を除く失敗回数 (3 回までの再試行はこちらで数える)
     */
    private async prepRecord(retry: number = 0, failures: number = 0): Promise<void> {
        if (this.isStopPrepRec === true) {
            this.isPlanToDelete = false;
            this.emitCancelEvent();

            return;
        }

        this.isPrepRecording = true;
        this.isRecording = false;
        this.isPlanToDelete = false;

        if (retry === 0) {
            // 再試行は catch で 1 行ずつログに出す
            this.log.system.info(`preprec: ${this.reserve.id}`);
            // 録画準備開始通知
            this.recordingEvent.emitStartPrepRecording(this.reserve);
        }

        // Mirakurun からストリームを取得中か (catch でエラーの発生元を判別する)
        let isGettingStream = false;

        // 番組ストリームを取得する
        try {
            // 番組開始時刻が変更されたことに伴い番組間に重なりが生じ、当該番組が削除されている
            // NOTE: mirakurunの不具合に対処
            // 終了時刻未定の番組の行は古い番組の削除で消え、番組が変わるまで戻らないため確認しない
            // (ストリームは番組 id で Mirakurun に要求する)
            if (this.reserve.programId && isUndeterminedEnd(this.reserve) === false) {
                const program = await this.programDB.findId(this.reserve.programId);
                if (program === null) {
                    this.log.system.warn(
                        `the program data does not found in database. retry later, (reerveId: ${this.reserve.id}, programId: ${this.reserve.programId})`,
                    );
                    // 下の catch で再試行し、見つからないままなら録画準備失敗を通知する
                    throw new Error('ProgramIsNotFound');
                }
            }

            this.abortController = new AbortController();
            isGettingStream = true;
            this.stream = await this.streamCreator.create(this.reserve, this.abortController.signal);
            isGettingStream = false;

            // 録画準備のキャンセル or ストリーム取得中に予約が削除されていないかチェック
            if ((await this.reserveDB.findId(this.reserve.id)) === null) {
                this.log.system.error(`canceled preprec: ${this.reserve.id}`);
                this.destroyStream();
                this.emitCancelEvent();
            } else {
                await this.doRecord();
            }
        } catch (err: any) {
            if ((this.isStopPrepRec as any) === true) {
                this.destroyStream();
                this.emitCancelEvent();
                return;
            }

            // Mirakurun の再起動中などで接続できない間は、放送中である限り再試行を続ける
            // (停止中の放送は失われ、再接続後は通常どおり新しいファイルに録画する)
            const isRetryUntilEnd =
                isGettingStream === true &&
                RecorderModel.CONNECTION_ERROR_CODES.includes(err?.code) &&
                isReserveOnAir(this.reserve, new Date().getTime());
            if (isRetryUntilEnd === true) {
                this.log.system.warn(
                    `preprec failed, Mirakurun is unreachable. retry in 5 s: ${this.reserve.id} (${err.message})`,
                );
            } else {
                this.log.system.error(`preprec failed: ${this.reserve.id}`);
                this.log.system.error(err);
            }
            // 取得済みの stream を閉じないとチューナーが番組終了まで確保されたままになる
            this.destroyStream();
            if (failures < 3 || isRetryUntilEnd === true) {
                // retry
                setTimeout(() => {
                    this.prepRecord(retry + 1, isRetryUntilEnd === true ? failures : failures + 1);
                }, 1000 * 5);
            } else {
                this.isPrepRecording = false;
                // 録画準備失敗を通知
                this.recordingEvent.emitPrepRecordingFailed(this.reserve);
            }
        } finally {
            this.abortController = null;
        }
    }

    /**
     * 録画準備キャンセル完了時に発行するイベント
     */
    private emitCancelEvent(): void {
        this.isStopPrepRec = false;
        this.isPrepRecording = false;
        this.isRecording = false;

        this.eventEmitter.emit(RecorderModel.CANCEL_EVENT);
    }

    /**
     * strem 破棄
     * @param needesUnpip: boolean
     */
    private destroyStream(needesUnpip: boolean = true): void {
        // stop stream
        if (this.stream !== null) {
            try {
                if (needesUnpip === true) {
                    this.stream.unpipe();
                }
                this.stream.destroy();
                this.stream.push(null); // eof 通知
                this.stream.removeAllListeners('data');
                this.stream = null;
            } catch (err: any) {
                this.log.system.error(`destroy stream error: ${this.reserve.id}`);
                this.log.system.error(err);
            }
        }

        // stop save file
        if (this.recFile !== null) {
            try {
                this.recFile.removeAllListeners('error');
                this.recFile.end();
            } catch (err: any) {
                this.log.system.error(`end recFile error: ${this.reserve.id}`);
                this.log.system.error(err);
            }
        }

        // stop drop check
        if (this.dropLogFileId !== null) {
            this.dropChecker.stop().catch(err => {
                this.log.system.error(`dropChecker stop error: ${this.reserve.id}`);
                this.log.system.error(err);
            });
        }
    }

    /**
     * 録画処理
     */
    private async doRecord(): Promise<void> {
        if (this.stream === null) {
            return;
        }

        // 録画キャンセル
        if (this.isStopPrepRec === true) {
            this.log.system.error(`cancel recording: ${this.reserve.id}`);
            this.destroyStream();
            this.emitCancelEvent();

            return;
        }

        this.isPrepRecording = false;
        this.isRecording = true;

        // 録画開始内部イベント発行
        // 時刻指定予約で録画準備中に endAt を変えようとした場合にこのイベントを受信してから変える
        this.eventEmitter.emit(RecorderModel.START_RECORDING_EVENT);

        // 保存先を取得
        const recPath = await this.recordingUtil.getRecPath(this.reserve, true);

        this.log.system.info(`recording: ${this.reserve.id} ${recPath.fullPath}`);

        // save stream
        // 録画番組を登録して録画を開始したか (開始前の書き込みエラーは録画準備の失敗として prepRecord が再試行する)
        let isStarted = false;
        this.recFile = fs.createWriteStream(recPath.fullPath, { flags: 'a' });
        this.recFile.once('error', async err => {
            // 書き込みエラー発生
            this.log.system.error(`recFile error reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}`);
            this.log.system.error(err);
            if (this.stream === null) {
                this.cancel(false);
            } else if (isStarted === false) {
                // 最初の書き込みで失敗した (ディスクが一杯など). 録画失敗にすると即座に録画し直す別の録画と
                // この録画準備の再試行が並行して増え続けるため、ストリームを閉じてファイルを消し、
                // prepRecord の再試行 (5 秒おきに 3 回まで) だけに任せる (登録中の録画番組は onData が消す)
                this.destroyStream();
                await FileUtil.unlink(recPath.fullPath).catch(err => {
                    this.log.system.error(`delete error: ${this.reserve.id} ${recPath.fullPath}`);
                    this.log.system.error(err);
                });
            } else {
                this.isCanceledCallingFinished = true; // mirakurun の stream の終了処理を行わないようにセット
                await this.recFailed(err).catch(err => {
                    this.log.system.fatal(
                        `Unexpected recFailed error: reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}`,
                    );
                    this.log.system.fatal(err);
                });
            }
        });
        this.stream.pipe(this.recFile);

        // drop checker
        if (this.config.isEnabledDropCheck === true) {
            let dropFilePath: string | null = null;
            try {
                await this.dropChecker.start(this.config.dropLog, recPath.fullPath, this.stream);
                dropFilePath = this.dropChecker.getFilePath();
            } catch (err: any) {
                this.log.system.error(`drop check error: ${recPath.fullPath}`);
                this.log.system.error(err);
                dropFilePath = null;
            }

            // drop 情報を DB へ反映
            if (dropFilePath !== null) {
                const dropLogFile = new DropLogFile();
                dropLogFile.errorCnt = 0;
                dropLogFile.dropCnt = 0;
                dropLogFile.scramblingCnt = 0;
                dropLogFile.filePath = path.basename(dropFilePath);
                this.log.system.info(`add drop log file: ${dropFilePath}`);
                try {
                    this.dropLogFileId = await this.dropLogFileDB.insertOnce(dropLogFile);
                } catch (err: any) {
                    this.dropLogFileId = null;
                    this.log.system.error(`add drop log file error: ${dropFilePath}`);
                    this.log.system.error(err);
                }
            }
        }

        return new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            if (this.stream === null) {
                reject(new Error('StreamIsNull'));

                return;
            }

            // stream データ受信のタイムアウト設定
            let isStreamTimeout = false; // stream データ受信がタイムアウトした場合は true
            const recordingTimeoutId = setTimeout(async () => {
                isStreamTimeout = true;
                this.log.system.error(`recording failed: ${this.reserve.id}`);

                if (this.stream !== null) {
                    this.stream.removeListener('data', onData); // stream データ受信時のコールバックの登録を削除
                    this.destroyStream();

                    // delete file
                    await FileUtil.unlink(recPath.fullPath).catch(err => {
                        this.log.system.error(`delete error: ${this.reserve.id} ${recPath.fullPath}`);
                        this.log.system.error(err);
                    });
                }

                reject(new Error('recordingStartError'));
            }, 1000 * 5);

            // stream データ受診時のコールバック関数定義
            const onData = async () => {
                clearTimeout(recordingTimeoutId);

                if (isStreamTimeout === true) {
                    // timeout が発生していたため何もしない
                    this.log.system.error(`stream is timeouted. reserveId: ${this.reserve.id}`);

                    return;
                }

                // 番組情報追加
                // (失敗を reject しないと prepRecord が終わらず、再試行も失敗通知も行われない)
                let recorded: Recorded;
                try {
                    recorded = await this.addRecorded(recPath);
                } catch (err: any) {
                    reject(err);

                    return;
                }

                // 終了処理セット
                if (this.stream !== null) {
                    isStarted = true;
                    this.setEndProcess(this.stream);
                } else {
                    // 登録中に最初の書き込みが失敗した. 再試行で録画番組が増えないよう、登録した行を消す
                    // (addRecorded の失敗時と同じく、再試行は新しい id で登録させる)
                    this.recordedId = null;
                    await this.videoFileDB
                        .deleteRecordedId(recorded.id)
                        .then(() => this.recordedDB.deleteOnce(recorded.id))
                        .catch(err => {
                            this.log.system.error(`delete recorded error: ${recorded.id}`);
                            this.log.system.error(err);
                        });
                    reject(new Error('StreamIsNull'));

                    return;
                }

                // 録画開始を通知
                this.recordingEvent.emitStartRecording(this.reserve, recorded);

                // program id が指定されていればイベントリレーの確認を行う
                if (this.reserve.programId !== null) {
                    // イベントリレーを確認するために番組終了時間間近にタイマーをセットする
                    this.setEventRelayTimer(this.reserve);
                }

                resolve();
            };

            // stream データ受診時のコールバック設定
            this.stream.once('data', onData);
        }).catch(err => {
            // 予想外の録画失敗エラー
            this.destroyStream();
            throw err;
        });
    }

    /**
     * 録画開始時の録画番組情報追加処理
     * @param recPath: RecFilePathInfo
     * @returns Promise<Recorded>
     */
    private async addRecorded(recPath: RecFilePathInfo): Promise<Recorded> {
        this.log.system.info(`add recorded ${this.reserve.id} ${recPath.fullPath}`);
        try {
            const recorded = await this.createRecorded();
            this.recordedId = await this.recordedDB.insertOnce(recorded);
            recorded.id = this.recordedId;
            this.log.system.info(`recording added reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}`);

            // add video file
            const videoFile = new VideoFile();
            videoFile.parentDirectoryName = recPath.parendDir.name;
            videoFile.filePath = path.join(recPath.subDir, recPath.fileName);
            videoFile.type = 'ts';
            videoFile.name = 'TS';
            videoFile.recordedId = this.recordedId;
            this.log.system.info(`create video file: ${videoFile.filePath}`);
            this.videoFileId = await this.videoFileDB.insertOnce(videoFile);
            this.videoFileFulPath = recPath.fullPath;

            recorded.videoFiles = [videoFile];

            return recorded;
        } catch (err: any) {
            // DB 登録エラー
            this.log.system.error('add recorded DB error');
            this.log.system.error(err);
            this.destroyStream();

            // 登録済みの recorded を削除し、再試行時は新しい id で登録させる (同じ id での登録は重複エラーになる)
            if (this.recordedId !== null) {
                await this.recordedDB.deleteOnce(this.recordedId).catch(e => {
                    this.log.system.error(`delete recorded error: ${this.recordedId}`);
                    this.log.system.error(e);
                });
                this.recordedId = null;
            }

            // delete file
            await FileUtil.unlink(recPath.fullPath).catch(err => {
                this.log.system.error(`delete error: ${this.reserve.id} ${recPath.fullPath}`);
                this.log.system.error(err);
            });

            throw new Error('AddRecordedDBError');
        }
    }

    /**
     * 終了処理追加
     * @param s: Mirakurun からのストリーム
     * @returns Promise<Recorded>
     */
    private async setEndProcess(s: http.IncomingMessage): Promise<void> {
        this.log.system.info(`set stream.finished: reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`);
        stream.finished(s, {}, async err => {
            // 終了処理が呼ばれていたら無視する
            if (this.isCanceledCallingFinished === true) {
                return;
            }

            if (err) {
                this.log.system.error(
                    `stream.finished error: reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`,
                );
                await this.recFailed(err);
            } else {
                await this.recEnd().catch(e => {
                    this.log.system.fatal(
                        `unexpected recEnd error: reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`,
                    );
                    this.log.system.fatal(e);
                });
            }
        });
    }

    /**
     * 録画失敗処理
     * @param err: Error
     */
    private async recFailed(err: Error): Promise<void> {
        this.destroyStream();
        this.log.system.error(`recording end error reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`);
        this.log.system.error(err);

        // 録画終了処理
        this.isNeedDeleteReservation = false;
        await this.recEnd().catch(e => {
            this.log.system.error(`recEnd error reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`);
            this.log.system.error(e);
        });

        // 録画終了処理失敗を通知
        let recorded: Recorded | null = null;
        if (this.recordedId !== null) {
            try {
                recorded = await this.recordedDB.findId(this.recordedId);
            } catch (e: any) {
                this.log.system.error(`reocrded is deleted: ${this.recordedId}`);
                recorded = null;
            }
        }
        this.recordingEvent.emitRecordingFailed(this.reserve, recorded);
    }

    /**
     * this.reserve から Recorded を生成する
     * @return Promise<Recorded>
     */
    private async createRecorded(): Promise<Recorded> {
        const recorded = new Recorded();
        if (this.recordedId !== null) {
            recorded.id = this.recordedId;
        }
        recorded.isRecording = this.isRecording;
        recorded.reserveId = this.reserve.id;
        recorded.ruleId = this.reserve.ruleId;
        recorded.programId = this.reserve.programId;
        recorded.channelId = this.reserve.channelId;
        recorded.startAt = this.reserve.startAt;
        recorded.endAt = this.reserve.endAt;
        recorded.duration = this.reserve.endAt - this.reserve.startAt;

        if (this.reserve.isTimeSpecified === true) {
            // 時刻指定予約なので channelId と startAt を元に番組情報を取得する
            const program = await this.programDB.findChannelIdAndTime(this.reserve.channelId, this.reserve.startAt);
            if (program === null) {
                // 番組情報が取れなかった場合
                this.log.system.warn(
                    `get program info warn channelId: ${this.reserve.channelId}, startAt: ${this.reserve.startAt}`,
                );
                // (開始時の番組が古い番組の削除で消えた後など) 録画中の更新では保存済みの番組名を残し
                // (undefined の項目は更新されない)、新規登録 (再開した録画など) では予約名を使う
                if (this.recordedId === null) {
                    recorded.name = this.reserve.name;
                    recorded.halfWidthName = this.reserve.halfWidthName;
                }
            } else {
                recorded.name = program.name;
                recorded.halfWidthName = program.halfWidthName;
                recorded.description = program.description;
                recorded.halfWidthDescription = program.halfWidthDescription;
                recorded.extended = program.extended;
                recorded.halfWidthExtended = program.halfWidthExtended;
                recorded.rawExtended = program.rawExtended;
                recorded.rawHalfWidthExtended = program.rawHalfWidthExtended;
                recorded.genre1 = program.genre1;
                recorded.subGenre1 = program.subGenre1;
                recorded.genre2 = program.genre2;
                recorded.subGenre2 = program.subGenre2;
                recorded.genre3 = program.genre3;
                recorded.subGenre3 = program.subGenre3;
                recorded.videoType = program.videoType;
                recorded.videoResolution = program.videoResolution;
                recorded.videoStreamContent = program.videoStreamContent;
                recorded.videoComponentType = program.videoComponentType;
                recorded.audioSamplingRate = program.audioSamplingRate;
                recorded.audioComponentType = program.audioComponentType;
            }
        } else if (this.reserve.name !== null && this.reserve.halfWidthName !== null) {
            recorded.name = this.reserve.name;
            recorded.halfWidthName = this.reserve.halfWidthName;
            recorded.description = this.reserve.description;
            recorded.halfWidthDescription = this.reserve.halfWidthDescription;
            recorded.extended = this.reserve.extended;
            recorded.halfWidthExtended = this.reserve.halfWidthExtended;
            recorded.rawExtended = this.reserve.rawExtended;
            recorded.rawHalfWidthExtended = this.reserve.rawHalfWidthExtended;
            recorded.genre1 = this.reserve.genre1;
            recorded.subGenre1 = this.reserve.subGenre1;
            recorded.genre2 = this.reserve.genre2;
            recorded.subGenre2 = this.reserve.subGenre2;
            recorded.genre3 = this.reserve.genre3;
            recorded.subGenre3 = this.reserve.subGenre3;
            recorded.videoType = this.reserve.videoType;
            recorded.videoResolution = this.reserve.videoResolution;
            recorded.videoStreamContent = this.reserve.videoStreamContent;
            recorded.videoComponentType = this.reserve.videoComponentType;
            recorded.audioSamplingRate = this.reserve.audioSamplingRate;
            recorded.audioComponentType = this.reserve.audioComponentType;
        } else {
            // 時刻指定予約ではないのに、name が null
            throw new Error('CreateRecordedError');
        }

        if (this.dropLogFileId !== null) {
            recorded.dropLogFileId = this.dropLogFileId;
        }

        return recorded;
    }

    /**
     * 録画終了処理
     */
    private async recEnd(): Promise<void> {
        this.log.system.info(`start recEnd reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`);

        // stream 停止
        this.destroyStream();

        // イベントリレーのチェック用タイマーをクリア
        if (this.eventRelayTimerId !== null) {
            clearTimeout(this.eventRelayTimerId);
        }

        // 番組の終了でストリームが閉じたのに予定の時刻に確認していなければ (終了時刻が未定だった場合など) ここで確認する
        // (キャンセルやエラーで閉じた場合は recFailed により isNeedDeleteReservation が false)
        if (this.isEventRelayChecked === false && this.isNeedDeleteReservation === true) {
            this.checkEventRelay().catch(err => {
                this.log.system.error(`check event relay error: ${this.reserve.id}`);
                this.log.system.error(err);
            });
        }

        // 削除予定か?
        if (this.isPlanToDelete === true) {
            this.log.system.info(`plan to delete reserveId: ${this.reserve.id} recordedId: ${this.recordedId}`);

            if (this.dropLogFileId !== null) {
                await this.dropChecker.stop().catch(err => {
                    this.log.system.error(`stop drop checker error: ${this.dropLogFileId}`);
                    this.log.system.error(err);
                });
            }

            return;
        }

        if (this.recordedId !== null) {
            // 終了時刻未定 (1 ms) のまま終わった録画は止まった時刻を終了時刻として保存する
            // (エンコードのタイムアウトは duration から決まるため)。予約の終了時刻は変えない
            if (isUndeterminedEnd(this.reserve) === true) {
                const ended = new Recorded();
                ended.id = this.recordedId;
                ended.endAt = new Date().getTime();
                ended.duration = ended.endAt - this.reserve.startAt;
                this.log.system.info(`set undetermined recorded end: ${this.recordedId}, ${ended.endAt}`);
                await this.recordedDB.updateOnce(ended).catch(err => {
                    this.log.system.error(`update recorded end error: ${this.recordedId}`);
                    this.log.system.error(err);
                });
            }

            // remove recording flag
            this.log.system.info(`remove recording flag: ${this.recordedId}`);
            // 失敗しても以降の終了処理 (終了イベント, エンコード) は行う. フラグは起動時の recordings cleanup で消える
            await this.recordedDB.removeRecording(this.recordedId).catch(err => {
                this.log.system.error(`remove recording flag error: ${this.recordedId}`);
                this.log.system.error(err);
            });
            this.isRecording = false;

            // tmp に録画していた場合は移動する
            if (typeof this.config.recordedTmp !== 'undefined' && this.videoFileId !== null) {
                try {
                    const newVdeoFileFulPath = await this.recordingUtil.movingFromTmp(this.reserve, this.videoFileId);
                    this.videoFileFulPath = newVdeoFileFulPath;
                } catch (err: any) {
                    this.log.system.fatal(`movingFromTmp error: ${this.videoFileId}`);
                    this.log.system.fatal(err);
                }
            }

            // update video file size
            if (this.videoFileId !== null && this.videoFileFulPath !== null) {
                this.recordingUtil.updateVideoFileSize(this.videoFileId).catch(err => {
                    this.log.system.error(`update file size error: ${this.videoFileId}`);
                    this.log.system.error(err);
                });
            }

            // drop 情報更新
            await this.updateDropFileLog().catch(err => {
                this.log.system.fatal(`updateDropFileLog error: ${this.dropLogFileId}`);
                this.log.stream.fatal(err);
            });

            // recorded 情報取得
            const recorded = await this.recordedDB.findId(this.recordedId);

            // Recorded history 追加
            if (
                this.reserve.isTimeSpecified === false &&
                this.reserve.ruleId !== null &&
                this.reserve.isEventRelay === false &&
                this.isNeedDeleteReservation === true
            ) {
                // ルール(Program Id 予約)の場合のみ記録する
                try {
                    if (recorded !== null) {
                        this.log.system.info(`add recorded history: ${this.recordedId}`);
                        const history = new RecordedHistory();
                        history.name = StrUtil.deleteBrackets(recorded.halfWidthName);
                        history.channelId = recorded.channelId;
                        history.endAt = recorded.endAt;
                        await this.recordedHistoryDB.insertOnce(history);
                    }
                } catch (err: any) {
                    this.log.system.error(`add recorded history error: ${this.recordedId}`);
                    this.log.system.error(err);
                }
            }

            // 録画完了の通知
            if (recorded !== null) {
                this.log.system.info(
                    `emit finish recording reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}, isNeedDeleteReservation: ${this.isNeedDeleteReservation}`,
                );
                this.recordingEvent.emitFinishRecording(this.reserve, recorded, this.isNeedDeleteReservation);
            }
        } else {
            this.log.system.info('failed to recording: recorded id is null');
        }

        this.log.system.info(
            `recording finish reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}, videoFileFulPath: ${this.videoFileFulPath}`,
        );
    }

    /**
     * drop log file 情報を更新する
     * @return Promise<void>
     */
    private async updateDropFileLog(): Promise<void> {
        if (this.dropLogFileId === null) {
            return;
        }

        // ドロップ情報カウント
        let error = 0;
        let drop = 0;
        let scrambling = 0;
        try {
            const dropResult = await this.dropChecker.getResult();
            for (const pid in dropResult) {
                error += dropResult[pid].error;
                drop += dropResult[pid].drop;
                scrambling += dropResult[pid].scrambling;
            }
        } catch (err: any) {
            this.log.system.error(`get drop result error: ${this.dropLogFileId}`);
            this.log.system.error(err);
            await this.dropChecker.stop().catch(() => {});

            return;
        }

        // ドロップ数をログに残す
        this.log.system.info({
            recordedId: this.recordedId,
            error: error,
            drop: drop,
            scrambling: scrambling,
        });

        // DB へ反映
        await this.dropLogFileDB
            .updateCnt({
                id: this.dropLogFileId,
                errorCnt: error,
                dropCnt: drop,
                scramblingCnt: scrambling,
            })
            .catch(err => {
                this.log.system.error(`update drop cnt error: ${this.dropLogFileId}`);
                this.log.system.error(err);
            });
    }

    /**
     * 予約のキャンセル
     */
    private async _cancel(): Promise<void> {
        if (this.isPrepRecording === false && this.isRecording === false) {
            // 録画処理が開始されていない
            if (this.timerId !== null) {
                clearTimeout(this.timerId);
            }
        } else if (this.isPrepRecording === true) {
            this.log.system.info(`cancel preprec: ${this.reserve.id}`);

            // 録画準備中
            return new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
                // タイムアウト設定
                const timerId = setTimeout(() => {
                    reject(new Error('PrepRecCancelTimeoutError'));
                }, 60 * 1000);

                // 録画準備中
                this.isStopPrepRec = true;
                if (this.abortController !== null) {
                    this.abortController.abort();
                }
                this.eventEmitter.once(RecorderModel.CANCEL_EVENT, () => {
                    clearTimeout(timerId);
                    // prep rec キャンセル完了
                    resolve();
                });
            });
        } else if (this.isRecording === true) {
            this.log.system.info(`stop recording: ${this.reserve.id}`);
            // 録画中
            // 最初のデータ受信前 (録画開始のタイムアウト待ち) のキャンセルで prepRecord が再試行しないようにする
            this.isStopPrepRec = true;
            if (this.stream !== null) {
                this.stream.destroy();
                this.stream.push(null); // eof 通知
            }
        }
    }

    /**
     * 予約のキャンセル
     * @param isPlanToDelete: boolean ファイルが削除される予定か
     */
    public async cancel(isPlanToDelete: boolean): Promise<void> {
        this.log.system.info(
            `recording cancel reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}, isPlanToDelete: ${isPlanToDelete}`,
        );

        this.isPlanToDelete = isPlanToDelete;

        if (this.isPrepRecording === true) {
            await this._cancel();
            // 録画準備失敗を通知
            this.recordingEvent.emitCancelPrepRecording(this.reserve);
        } else if (this.isRecording === true) {
            await this._cancel();
            this.isNeedDeleteReservation = false;
        } else {
            await this._cancel();
        }
    }

    /**
     * 予約情報を更新する
     * @param newReserve: 新しい予約情報
     * @param isSuppressLog: boolean ログ出力を抑えるか
     */
    public async update(newReserve: Reserve, isSuppressLog: boolean): Promise<void> {
        if (newReserve.isSkip === true || newReserve.isOverlap === true) {
            // skip されたかチェック
            this.log.system.info(
                `cancel recording by skip or overlap reserveId: ${this.reserve.id}, recordedId: ${this.recordedId}`,
            );
            await this.cancel(false).catch(err => {
                this.log.system.error(`cancel recording error: ${newReserve.id}`);
                this.log.system.error(err);
            });
        } else if (this.reserve.startAt !== newReserve.startAt || this.reserve.endAt !== newReserve.endAt) {
            // 時刻に変更がないか確認
            // 録画処理が実行されていない場合
            if (this.isPrepRecording === false && this.isRecording === false) {
                this.setTimer(newReserve, isSuppressLog);
            } else {
                // 録画準備中 or 録画中
                if (this.reserve.programId === null) {
                    // 時間指定予約で時刻に変更があった
                    // TODO 現時点では時刻指定で時間変更を受け入れられるようにな api になっていない
                    // TODO 録画中 or 録画準備中の開始時刻変更にも対応していない
                    if (this.reserve.endAt !== newReserve.endAt) {
                        // 時間指定予約で終了時刻に変更があった
                        this.log.system.info(`change recording endAt: ${newReserve.id}`);

                        if (this.isPrepRecording === true) {
                            // 録画準備中なら録画中になるまで待つ
                            await new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
                                this.log.system.debug(`wait change endAt: ${newReserve.id}`);
                                // タイムアウト設定
                                const timeoutId = setTimeout(() => {
                                    reject(new Error('ChangeEndAtTimeoutError'));
                                }, IRecordingStreamCreator.PREP_TIME);

                                // 録画開始内部イベント発行街
                                this.eventEmitter.once(RecorderModel.START_RECORDING_EVENT, () => {
                                    clearTimeout(timeoutId);
                                    resolve();
                                });
                            });
                        }

                        // 終了時刻変更
                        try {
                            this.streamCreator.changeEndAt(newReserve);
                        } catch (err: any) {
                            this.log.system.error(`change recording endAt: ${newReserve.id}`);
                            this.log.system.error(err);
                        }
                    }
                } else {
                    // 録画中に終了時間が変更されたらイベントリレーの確認タイマーも再設定する
                    if (this.reserve.endAt !== newReserve.endAt && this.isRecording === true) {
                        this.setEventRelayTimer(newReserve);
                    }

                    if (this.reserve.startAt < newReserve.startAt) {
                        // 開始時刻が遅くなった
                        if (this.isRecording === false) {
                            // まだ録画準備中なのでキャンセルしてタイマーを再セット
                            this.log.system.info(
                                `cancel prepare recording.`,
                                `(reserveId: ${this.reserve.id}, programId: ${this.reserve.programId}, recordedId: ${this.recordedId})`,
                            );
                            await this._cancel().catch(err => {
                                this.log.system.error(
                                    `cancel recording error: (reserveId: ${newReserve.id}, programId: ${this.reserve.programId})`,
                                );
                                this.log.system.error(err);
                            });
                            // NOTE: キャンセルエラーが発生したとしてもタイマーを再セット
                            this.setTimer(newReserve, isSuppressLog);
                        } else {
                            // 録画中
                            // NOTE:
                            //  EPGstationがスケジュール変更を遅れて把握した可能性がある
                            //  一度ストリームを開始した番組の開始時刻が変更されることはないのでここでは何もしない
                            this.log.system.info(
                                `Ignores schedule changes because this program is already recording.`,
                                ` (reserveId: ${this.reserve.id}, programId: ${this.reserve.programId}, recordedId: ${this.recordedId})`,
                            );
                        }
                    }
                }
            }
        }

        this.reserve = newReserve;

        // update recorded DB
        if (this.isRecording === true && this.recordedId !== null) {
            const recorded = await this.createRecorded();
            this.log.system.info(`update reocrded: ${this.recordedId}`);
            this.recordedDB.updateOnce(recorded).catch(err => {
                this.log.system.error(`update recorded error: ${this.recordedId}`);
                this.log.system.error(err);
            });
        }
    }

    /**
     * イベントリレーをチェックするためのタイマーをセットする
     * @param reserve: Reserve 予約情報
     */
    private setEventRelayTimer(reserve: Reserve): void {
        // 除外, 重複しているものはタイマーをセットしない
        if (reserve.isSkip === true || reserve.isOverlap === true) {
            return;
        }

        // 終了時刻が未定の間はタイマーをセットせず (セット済みのものは止める)、番組ストリームの終了時に確認する
        this.isEventRelayChecked = false;
        if (isUndeterminedEnd(reserve) === true) {
            if (this.eventRelayTimerId !== null) {
                clearTimeout(this.eventRelayTimerId);
            }

            return;
        }

        // 待機時間を計算
        const now = new Date().getTime();
        let time = reserve.endAt - RecorderModel.EVENT_RELAY_CHECK_TIME - now;
        if (time < 0) {
            time = 0;
        }

        // タイマーをセットする
        if (this.eventRelayTimerId !== null) {
            clearTimeout(this.eventRelayTimerId);
        }
        this.eventRelayTimerId = setTimeout(async () => {
            this.isEventRelayChecked = true;
            await this.checkEventRelay();
        }, time);
    }

    /**
     * イベントリレーの対象となる予約情報の確認を行う
     */
    private async checkEventRelay(): Promise<void> {
        // ProgramId の指定がない場合は何もしない
        if (this.reserve.programId === null) {
            return;
        }

        this.log.system.debug(
            `check event relay program. reserveId: ${this.reserve.id}, programId: ${this.reserve.programId}`,
        );
        const mirakurun = this.mirakurunClientModel.getClient();

        // program 情報の取得
        let parentProgram: mapid.Program;
        try {
            parentProgram = await mirakurun.getProgram(this.reserve.programId);
            this.log.system.debug(parentProgram);
        } catch (err: any) {
            this.log.system.error(
                `failed to get event relay info. reserveId: ${this.reserve.id}, programId: ${this.reserve.programId}`,
            );
            return;
        }

        // event relay の設定の有無を調べる
        if (typeof parentProgram.relatedItems === 'undefined') {
            this.log.system.debug(
                `event relay porgram does not exist. reserveId: ${this.reserve.id}, programId: ${this.reserve.programId}`,
            );
            return;
        }

        // event relay 対象の ProgramId のリストを作成する
        const reserveProgramIds: { programId: apid.ProgramId; parentReserve: Reserve }[] = [];
        for (const relatedItem of parentProgram.relatedItems) {
            // type が ralay 出ないなら skip
            if (relatedItem.type !== 'relay') {
                continue;
            }

            // 番組を予約するための networkId を生成する
            let networkId = relatedItem.networkId;
            if (typeof networkId === 'undefined' || networkId === null) {
                // 本来 networkId は null を取らないはずだが、mirakc は null を返す
                // networkId が存在しない場合は自ネットワークのイベントリレーと判断する
                networkId = parentProgram.networkId;
            }

            // networkId, serviceId, eventId から該当する番組情報を検索する
            const reserveProgram = await this.programDB.findEventRelayProgram(
                networkId,
                relatedItem.serviceId,
                relatedItem.eventId,
            );
            if (reserveProgram === null) {
                this.log.system.warn(
                    `event relay program is not found. networkId: ${networkId}, serviceId: ${relatedItem.serviceId}, eventId: ${relatedItem.eventId}`,
                );
                continue;
            }

            // 予約に必要な情報を詰める
            // parentReserve は deep copy して渡す
            reserveProgramIds.push({ programId: reserveProgram.id, parentReserve: Object.assign({}, this.reserve) });
            this.log.system.info(
                `set event relay program. programId ${this.reserve.programId} -> ${reserveProgram.id}`,
            );
        }

        // イベントリレーの ProgramId が存在するなら予約を依頼する
        if (reserveProgramIds.length > 0) {
            this.recordingEvent.emitEventRelay(reserveProgramIds);
        }
    }

    /**
     * タイマーを再設定する
     * @return boolean セットに成功したら true を返す
     */
    public resetTimer(): boolean {
        // 録画中ならイベントリレーのチェック用のタイマーを再設定
        if (this.isRecording === true) {
            if (this.eventRelayTimerId !== null) {
                this.setEventRelayTimer(this.reserve);
            }
            return true;
        }

        return this.setTimer(this.reserve, false);
    }
}

namespace RecorderModel {
    export const CANCEL_EVENT = 'RecordingCancelEvent';
    export const START_RECORDING_EVENT = 'StartRecordingEvent';
    export const EVENT_RELAY_CHECK_TIME = 20 * 1000; // イベントリレーの確認時間 20秒
    export const MAX_TIMER_DELAY = 2 ** 31 - 1; // setTimeout に指定できる最大の待機時間 (約 24.8 日)
    // Mirakurun に接続できないことを表すエラーコード (ENOENT は unix socket が無い場合)
    export const CONNECTION_ERROR_CODES = [
        'ECONNREFUSED',
        'ECONNRESET',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ETIMEDOUT',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EPIPE',
        'ENOENT',
    ];
}

export default RecorderModel;
