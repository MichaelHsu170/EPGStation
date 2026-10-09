import { inject, injectable } from 'inversify';
import * as apid from '../../../../../../api';
import Util from '../../../../util/Util';
import IStreamApiModel from '../../..//api/streams/IStreamApiModel';
import IRecordedApiModel from '../../../api/recorded/IRecordedApiModel';
import IVideoApiModel from '../../../api/video/IVideoApiModel';
import IRecordedHLSStreamingVideoState from './IRecordedHLSStreamingVideoState';
import RecordedStreamingVideoState from './RecordedStreamingVideoState';

@injectable()
class RecordedHLSStreamingVideoState extends RecordedStreamingVideoState implements IRecordedHLSStreamingVideoState {
    private streamApiModel: IStreamApiModel;
    private streamId: apid.StreamId | null = null;
    private keepTimerId: number | undefined;
    private isStopRequested: boolean = false;

    private startingPromise: Promise<void> | null = null; // 実行中の startStream()

    constructor(
        @inject('IStreamApiModel') streamApiModel: IStreamApiModel,
        @inject('IVideoApiModel') videoApiModel: IVideoApiModel,
        @inject('IRecordedApiModel') recordedApiModel: IRecordedApiModel,
    ) {
        super(videoApiModel, recordedApiModel);

        this.streamApiModel = streamApiModel;
    }

    /**
     * ストリーム開始
     * @param videoFileId: apid.VideoFileId
     * @param playPosition: number 再生位置
     * @param mode: number
     * @return Promise<void>
     */
    public async start(videoFileId: apid.VideoFileId, playPosition: number, mode: number): Promise<void> {
        // 開始待ちの間に start が呼ばれた (シーク中に再度シークした) 場合は, 前の開始が終わってから開始し直す.
        // 何もせずに戻ると, ストリームが無いまま呼び出し元が待ち続ける
        if (this.startingPromise !== null) {
            // それまでの stop 要求は, startStream() の stop() で前のストリームを止めて満たす
            this.isStopRequested = false;
            while (this.startingPromise !== null) {
                await this.startingPromise.catch(() => {});
            }

            // 待っている間に stop が呼ばれた (画面を離れた) 場合は開始しない
            if ((this.isStopRequested as boolean) === true) {
                return;
            }
        }

        this.startingPromise = this.startStream(videoFileId, playPosition, mode);
        try {
            await this.startingPromise;
        } finally {
            this.startingPromise = null;
        }
    }

    /**
     * ストリーム開始 (start() から 1 つずつ実行される)
     * @param videoFileId: apid.VideoFileId
     * @param playPosition: number 再生位置
     * @param mode: number
     * @return Promise<void>
     */
    private async startStream(videoFileId: apid.VideoFileId, playPosition: number, mode: number): Promise<void> {
        if (this.streamId !== null) {
            await this.stop();
        }

        this.isStopRequested = false;
        this.streamId = await this.streamApiModel.startRecordedHLS(videoFileId, playPosition, mode);

        // 開始待ちの間に stop が呼ばれていた (画面を離れた) 場合は、ここでストリームを止める.
        // そのままだと keep し続けるタイマーが残り、タブを閉じるまでチューナーが確保され続ける
        if ((this.isStopRequested as boolean) === true) {
            await this.stop();

            return;
        }

        // ストリームを保持し続ける
        this.keepTimerId = setInterval(async () => {
            if (this.streamId === null) {
                return;
            }

            await this.streamApiModel.keep(this.streamId).catch(err => {
                console.error(err);
            });
        }, RecordedHLSStreamingVideoState.KEEP_INTERVAL * 1000);

        await Util.sleep(1000);
    }

    /**
     * ストリーム停止
     * @return Promise<void>
     */
    public async stop(): Promise<void> {
        this.isStopRequested = true;
        if (typeof this.keepTimerId !== 'undefined') {
            clearInterval(this.keepTimerId);
            this.keepTimerId = undefined;
        }

        if (this.streamId !== null) {
            await this.streamApiModel.stop(this.streamId);
            this.streamId = null;
        }
    }

    /**
     * streamId を返す
     * @return apid.StreamId | null
     */
    public getStreamId(): apid.StreamId | null {
        return this.streamId;
    }

    /**
     * ストリームが有効になったか
     * @return Promise<boolean> true で有効
     */
    public async isEnabled(): Promise<boolean> {
        const info = await this.streamApiModel.getStreamInfo(true);

        for (const item of info.items) {
            if (item.streamId === this.streamId && item.isEnable === true) {
                return true;
            }
        }

        return false;
    }
}

namespace RecordedHLSStreamingVideoState {
    export const KEEP_INTERVAL = 10;
}

export default RecordedHLSStreamingVideoState;
