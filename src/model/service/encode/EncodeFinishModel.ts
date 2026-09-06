import { inject, injectable } from 'inversify';
import * as apid from '../../../../api';
import FileUtil from '../../../util/FileUtil';
import IEncodeEvent, { FinishEncodeInfo } from '../../event/IEncodeEvent';
import ILogger from '../../ILogger';
import ILoggerModel from '../../ILoggerModel';
import IIPCClient from '../../ipc/IIPCClient';
import IPromiseRetry from '../../IPromiseRetry';
import ISocketIOManageModel from '../socketio/ISocketIOManageModel';
import IEncodeFinishModel from './IEncodeFinishModel';

@injectable()
export default class EncodeFinishModel implements IEncodeFinishModel {
    private log: ILogger;
    private socket: ISocketIOManageModel;
    private ipc: IIPCClient;
    private encodeEvent: IEncodeEvent;
    private promiseRetry: IPromiseRetry;

    constructor(
        @inject('ILoggerModel') logger: ILoggerModel,
        @inject('ISocketIOManageModel') socket: ISocketIOManageModel,
        @inject('IIPCClient') ipc: IIPCClient,
        @inject('IEncodeEvent') encodeEvent: IEncodeEvent,
        @inject('IPromiseRetry') promiseRetry: IPromiseRetry,
    ) {
        this.log = logger.getLogger();
        this.socket = socket;
        this.ipc = ipc;
        this.encodeEvent = encodeEvent;
        this.promiseRetry = promiseRetry;
    }

    public set(): void {
        this.encodeEvent.setAddEncode(this.addEncode.bind(this));
        this.encodeEvent.setCancelEncode(this.cancelEncode.bind(this));
        this.encodeEvent.setFinishEncode(this.finishEncode.bind(this));
        this.encodeEvent.setErrorEncode(this.errorEncode.bind(this));
        this.encodeEvent.setUpdateEncodeProgress(this.updateEncodeProgress.bind(this));
    }

    /**
     * エンコード追加処理
     * @param encodeId
     */
    private addEncode(_encodeId: apid.EncodeId): void {
        this.socket.notifyClient();
    }

    /**
     * エンコードキャンセル処理
     * @param encodeId
     */
    private cancelEncode(_encodeId: apid.EncodeId): void {
        this.socket.notifyClient();
    }

    /**
     * エンコード終了処理
     * @param info: FinishEncodeInfo
     */
    private async finishEncode(info: FinishEncodeInfo): Promise<void> {
        let newVideoFileId: apid.VideoFileId | null = null;
        try {
            if (info.fullOutputPath === null || info.filePath === null) {
                // update file size
                await this.ipc.recorded.updateVideoFileSize(info.videoFileId);
            } else {
                const fileSize = await FileUtil.getFileSize(info.fullOutputPath);
                if (fileSize > 0) {
                    // add encode file
                    // 操作対象の operator プロセスがイベントループの混雑や DB 書き込みの
                    // リトライ待ちで一時的に応答できないことがあるため、1回の失敗で
                    // エンコード済みファイルを孤立させないようリトライする
                    const filePath = info.filePath;
                    const id = await this.promiseRetry.run(
                        () =>
                            this.ipc.recorded.addVideoFile({
                                recordedId: info.recordedId,
                                parentDirectoryName: info.parentDirName,
                                filePath: filePath,
                                type: 'encoded',
                                name: info.mode,
                            }),
                        { cnt: 3, waitTime: 2000 },
                    );
                    newVideoFileId = id;
                } else {
                    if (info.fullOutputPath !== null) {
                        this.log.encode.info(`delete: ${info.fullOutputPath}`);
                        await FileUtil.unlink(info.fullOutputPath).catch(err => {
                            this.log.encode.error(`failed to delete ${info.fullOutputPath}`);
                            this.log.encode.error(err);
                        });
                    }
                    info.removeOriginal = false;
                }
            }
        } catch (err: any) {
            this.log.encode.error('finish encode error');
            this.log.encode.error(err);
            info.removeOriginal = false;
        }

        if (info.removeOriginal === true) {
            // delete source video file
            // addVideoFile と同様、一時的な応答遅延で本来成功するはずの削除が
            // 失敗扱いになることを避けるためリトライする。またこの呼び出しが
            // 失敗しても後続の notifyClient / emitFinishEncode は必ず実行する
            await this.promiseRetry
                .run(() => this.ipc.recorded.deleteVideoFile(info.videoFileId, true), { cnt: 3, waitTime: 2000 })
                .catch(err => {
                    this.log.encode.error(`failed to delete original video file: ${info.videoFileId}`);
                    this.log.encode.error(err);
                });
        }

        this.socket.notifyClient();

        // Operator にイベントを転送
        await this.ipc.encodeEvent.emitFinishEncode({
            recordedId: info.recordedId,
            videoFileId: newVideoFileId,
            mode: info.mode,
        });
    }

    /**
     * エンコード失敗処理
     */
    private errorEncode(): void {
        this.socket.notifyClient();
    }

    /**
     * エンコード進捗情報更新
     */
    private updateEncodeProgress(): void {
        this.socket.notifyUpdateEncodeProgress();
    }
}
