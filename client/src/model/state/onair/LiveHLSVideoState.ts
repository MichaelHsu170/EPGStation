import { inject, injectable } from 'inversify';
import * as apid from '../../../../../api';
import IStreamApiModel from '../../api/streams/IStreamApiModel';
import ILiveHLSVideoState from './ILiveHLSVideoState';

@injectable()
class LiveHLSVideoState implements ILiveHLSVideoState {
    private streamApiModel: IStreamApiModel;
    private streamId: apid.StreamId | null = null;
    private keepTimerId: number | undefined;
    private isStopRequested: boolean = false;

    constructor(@inject('IStreamApiModel') streamApiModel: IStreamApiModel) {
        this.streamApiModel = streamApiModel;
    }

    /**
     * ストリーム開始
     * @param channelId: apid.ChannelId
     * @param mode: number
     * @return Promise<void>
     */
    public async start(channelId: apid.ChannelId, mode: number): Promise<void> {
        this.isStopRequested = false;
        this.streamId = await this.streamApiModel.startLiveHLS(channelId, mode);
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
        }, LiveHLSVideoState.KEEP_INTERVAL * 1000);
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

namespace LiveHLSVideoState {
    export const KEEP_INTERVAL = 10;
}

export default LiveHLSVideoState;
