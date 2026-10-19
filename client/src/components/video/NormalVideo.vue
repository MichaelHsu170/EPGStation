<template>
    <video ref="video" autoplay playsinline></video>
</template>

<script lang="ts">
import BaseVideo from '@/components/video/BaseVideo';
import UaUtil from '@/util/UaUtil';
import { Component, Prop, Watch } from 'vue-property-decorator';

@Component({})
export default class NormalVideo extends BaseVideo {
    @Prop({ required: true })
    public videoSrc!: string;

    public mounted(): void {
        super.mounted();
    }

    public async beforeDestroy(): Promise<void> {
        super.beforeDestroy();
    }

    /**
     * video 再生初期設定
     */
    protected initVideoSetting(): void {
        this.setSrc(this.videoSrc);
        this.load();
    }

    /**
     * 動画の長さを返す (秒)
     * シークできないストリーム (ライブの fragmented MP4: duration は読み込んだ長さ, seekable は [0, 0]) は 0 を返す
     * @return number
     */
    public getDuration(): number {
        if (this.video === null || this.video.seekable.length === 0 || this.video.seekable.end(this.video.seekable.length - 1) <= 0) {
            return 0;
        }

        return super.getDuration();
    }
}
</script>
