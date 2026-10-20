<template>
    <video ref="video" autoplay playsinline></video>
</template>

<script lang="ts">
import BaseVideo from '@/components/video/BaseVideo';
import container from '@/model/ModelContainer';
import ISocketIOModel from '@/model/socketio/ISocketIOModel';
import IRecordedStreamingVideoState from '@/model/state/recorded/streaming/IRecordedStreamingVideoState';
import { Component, Prop, Watch } from 'vue-property-decorator';
import * as apid from '../../../../api';

interface VideoSrcInfo {
    videoFileId: apid.VideoFileId;
    streamingType: string;
    mode: number;
    playPosition: number;
}

@Component({})
export default class RecordedStreamingVideo extends BaseVideo {
    @Prop({ required: true })
    public recordedId!: apid.RecordedId;

    @Prop({ required: true })
    public mode!: number;

    @Prop({ required: true })
    public videoFileId!: apid.VideoFileId;

    @Prop({ required: true })
    public streamingType!: string;

    private videoState = container.get<IRecordedStreamingVideoState>('IRecordedStreamingVideoState');
    private socketIoModel: ISocketIOModel = container.get<ISocketIOModel>('ISocketIOModel');
    private onUpdateStatusCallback = (async (): Promise<void> => {
        await this.updateVideoInfo().catch(err => {
            console.error(err);
        });
    }).bind(this);
    private basePlayPosition: number = 0;
    private dummyPlayPosition: number | null = null; // setCurrentTime が呼ばれている間に再生位置として返すダミー値
    private pauseStateBeforeCurrentTime: boolean = false; // setCurrentTime が処理終了時に再生状態を復元するための値
    private updateDurationTimerId: number | undefined; // 録画中の番組の動画長を更新するためのタイマー
    private setCurrentTimeTimerId: number | undefined; // setCurrentTime を大量に呼び出さないようにするためのタイマー
    private isDestroyed: boolean = false; // 画面を離れた後に再生を開始しないためのフラグ

    public created(): void {
        // socket.io イベント
        this.socketIoModel.onUpdateState(this.onUpdateStatusCallback);
    }

    public async mounted(): Promise<void> {
        await this.videoState.clear();
        await this.updateVideoInfo();

        // 情報取得中に画面を離れた場合は再生を開始しない
        if (this.isDestroyed === true) {
            return;
        }

        super.mounted();

        // 録画中の場合は duration が変化するので定期的に timeupdate を発行する
        if (this.videoState.isRecording() === true) {
            this.updateDurationTimerId = setInterval(() => {
                this.onTimeupdate();

                // 録画中でなくなったらタイマーを止める
                if (this.videoState.isRecording() === false) {
                    clearInterval(this.updateDurationTimerId);
                }
            }, 1000);
        }
    }

    /**
     * socket.io での状態更新通知時処理
     * @return Promise<void>
     */
    private async updateVideoInfo(): Promise<void> {
        await this.videoState.fetchInfo(this.recordedId, this.videoFileId);
        if (this.videoState.isRecording() === false) {
            clearInterval(this.updateDurationTimerId);
        }
    }

    public async beforeDestroy(): Promise<void> {
        this.isDestroyed = true;

        // socket.io イベント
        this.socketIoModel.offUpdateState(this.onUpdateStatusCallback);

        clearInterval(this.updateDurationTimerId);
        clearTimeout(this.setCurrentTimeTimerId);

        super.beforeDestroy();
    }

    /**
     * video 再生初期設定
     */
    protected initVideoSetting(): void {
        this.setSrc(
            this.createVideoSrc({
                videoFileId: this.videoFileId,
                streamingType: this.streamingType,
                mode: this.mode,
                playPosition: this.basePlayPosition,
            }),
        );
        this.load();
    }

    /**
     * video src を生成する
     */
    private createVideoSrc(info: VideoSrcInfo): string {
        return `./api/streams/recorded/${info.videoFileId}/${info.streamingType}?mode=${info.mode}&ss=${info.playPosition}`;
    }

    /**
     * 動画の長さを返す (秒)
     * @return number
     */
    public getDuration(): number {
        return this.videoState.getDuration();
    }

    /**
     * 動画の現在再生位置を返す (秒)
     * @return number
     */
    public getCurrentTime(): number {
        if (this.dummyPlayPosition !== null) {
            return this.dummyPlayPosition;
        }

        return this.video === null ? 0 : this.basePlayPosition + super.getCurrentTime();
    }

    /**
     * 動画再生.
     * 再生位置変更の読み直し待ちの間に再生を指示された場合は, 読み直し後も再生する
     */
    public async play(): Promise<void> {
        if (this.dummyPlayPosition !== null) {
            this.pauseStateBeforeCurrentTime = false;
        }

        await super.play();
    }

    /**
     * 動画停止.
     * 再生位置変更の読み直し待ちの間に停止を指示された場合は, 読み直し後も停止する
     */
    public pause(): void {
        if (this.dummyPlayPosition !== null) {
            this.pauseStateBeforeCurrentTime = true;
        }

        super.pause();
    }

    /**
     * 再生位置設定
     * @param time: number (秒)
     */
    public setCurrentTime(time: number): void {
        if (this.video === null) {
            return;
        }

        // エンコード済み範囲か。実際にシークできる範囲かも見る (fragmented MP4 は読み込んだ長さを duration に返すが
        // seekable は空で、シークすると同じ ss から読み直す)。できなければ ss を指定して読み直す
        const seekable = this.video.seekable;
        const relTime = time - this.basePlayPosition;
        if (
            time >= this.basePlayPosition &&
            time <= this.basePlayPosition + super.getDuration() &&
            seekable.length > 0 &&
            relTime >= seekable.start(0) &&
            relTime <= seekable.end(seekable.length - 1)
        ) {
            super.setCurrentTime(time - this.basePlayPosition);
            this.onTimeupdate();

            return;
        }

        if (this.dummyPlayPosition === null) {
            this.pauseStateBeforeCurrentTime = this.paused();
        }
        this.dummyPlayPosition = time;
        this.onTimeupdate();

        clearTimeout(this.setCurrentTimeTimerId);
        this.setCurrentTimeTimerId = setTimeout(async () => {
            const timerId = this.setCurrentTimeTimerId;
            if (this.video === null) {
                return;
            }

            const playbackRate = this.video.playbackRate;

            this.unload();
            this.basePlayPosition = time;
            this.onWaiting();
            this.onPause();
            this.setSrc(
                this.createVideoSrc({
                    videoFileId: this.videoFileId,
                    streamingType: this.streamingType,
                    mode: this.mode,
                    playPosition: this.basePlayPosition,
                }),
            );
            this.load();

            this.video.playbackRate = playbackRate;
            if (this.pauseStateBeforeCurrentTime === true) {
                this.pause();
            } else {
                await this.play().catch(err => {
                    // console.error(err);
                });
            }
            // 読み直しの再生開始を待つ間に次のシークが来ていれば, 読み直し待ちはそちらが終える
            if (this.setCurrentTimeTimerId === timerId) {
                this.dummyPlayPosition = null;
            }
        }, 200);
    }
}
</script>
