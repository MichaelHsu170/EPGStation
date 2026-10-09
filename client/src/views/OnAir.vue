<template>
    <v-main>
        <TitleBar title="放映中">
            <template v-slot:extension>
                <v-tabs v-if="isTabView === true && onAirState.getSchedules().length > 0" v-model="onAirState.selectedTab" centered>
                    <v-tab v-for="item in onAirState.getTabs()" :key="item" :href="`#${item}`">{{ item }}</v-tab>
                </v-tabs>
            </template>
        </TitleBar>
        <transition name="page">
            <div v-if="onAirState.getSchedules().length > 0">
                <v-tabs-items v-if="isTabView === true" v-model="onAirState.selectedTab">
                    <v-tab-item v-for="item in onAirState.getTabs()" :key="item" :value="`${item}`">
                        <OnAirCard :items="onAirState.getSchedules(item)" :reserveIndex="onAirState.getReserveIndex()"></OnAirCard>
                    </v-tab-item>
                </v-tabs-items>
                <div v-else>
                    <OnAirCard :items="onAirState.getSchedules()" :reserveIndex="onAirState.getReserveIndex()"></OnAirCard>
                </div>
            </div>
        </transition>
        <div style="visibility: hidden">dummy</div>
        <OnAirSelectStream></OnAirSelectStream>
        <ProgramDialog></ProgramDialog>
    </v-main>
</template>

<script lang="ts">
import ProgramDialog from '@/components/guide/ProgramDialog.vue';
import OnAirCard from '@/components/onair/OnAirCard.vue';
import OnAirSelectStream from '@/components/onair/OnAirSelectStream.vue';
import TitleBar from '@/components/titleBar/TitleBar.vue';
import container from '@/model/ModelContainer';
import ISocketIOModel from '@/model/socketio/ISocketIOModel';
import IScrollPositionState from '@/model/state/IScrollPositionState';
import IOnAirState from '@/model/state/onair/IOnAirState';
import ISnackbarState from '@/model/state/snackbar/ISnackbarState';
import { ISettingStorageModel, ISettingValue } from '@/model/storage/setting/ISettingStorageModel';
import Util from '@/util/Util';
import { Component, Vue, Watch } from 'vue-property-decorator';
import { Route } from 'vue-router';

Component.registerHooks(['beforeRouteUpdate', 'beforeRouteLeave']);

@Component({
    components: {
        TitleBar,
        OnAirCard,
        OnAirSelectStream,
        ProgramDialog,
    },
})
export default class OnAir extends Vue {
    public onAirState: IOnAirState = container.get<IOnAirState>('IOnAirState');
    private settingValue: ISettingValue = container.get<ISettingStorageModel>('ISettingStorageModel').getSavedValue();
    private scrollState: IScrollPositionState = container.get<IScrollPositionState>('IScrollPositionState');
    private snackbarState: ISnackbarState = container.get<ISnackbarState>('ISnackbarState');
    private socketIoModel: ISocketIOModel = container.get<ISocketIOModel>('ISocketIOModel');
    private onUpdateStatusCallback = (async (): Promise<void> => {
        await this.fetchData();
    }).bind(this);
    private updateTimer: number | null = null;
    private updateDigestibilityTimer: number | null = null;
    private isDestroyed: boolean = false; // 画面を離れた後にタイマーを設定しないためのフラグ

    get isTabView(): boolean {
        return this.settingValue.isOnAirTabListView;
    }

    public created(): void {
        // socket.io イベント
        this.socketIoModel.onUpdateState(this.onUpdateStatusCallback);
    }

    public beforeDestroy(): void {
        this.isDestroyed = true;

        // socket.io イベント
        this.socketIoModel.offUpdateState(this.onUpdateStatusCallback);

        if (this.updateTimer !== null) {
            clearTimeout(this.updateTimer);
        }
        if (this.updateDigestibilityTimer !== null) {
            clearInterval(this.updateDigestibilityTimer);
        }
    }

    @Watch('$route', { immediate: true, deep: true })
    public onUrlChange(): void {
        this.onAirState.clearData();
        this.$nextTick(async () => {
            await this.fetchData();

            // データ取得完了を通知
            await this.scrollState.emitDoneGetData();
        });
    }

    @Watch('onAirState.selectedTab')
    onTabChanged(): void {
        window.scroll(0, 0);
    }

    /**
     * 番組データ取得
     * @return Promise<void>
     */
    private async fetchData(): Promise<void> {
        if (this.updateTimer !== null) {
            clearTimeout(this.updateTimer);
        }

        let updateTime: number;
        try {
            await this.onAirState.fetchData({
                isHalfWidth: this.settingValue.isHalfWidthDisplayed,
            });
            // 時計のずれで放送終了済みの番組が返ってきても連続で取得しないように最低 1 秒は待つ
            updateTime = Math.max(this.onAirState.getUpdateTime(), 1000);
        } catch (err) {
            this.snackbarState.open({
                color: 'error',
                text: '番組情報取得に失敗',
            });
            console.error(err);
            // 取得に失敗しても更新を止めずに 10 秒後に再取得する
            updateTime = 10 * 1000;
        }

        // 取得中に画面を離れた場合はタイマーを設定しない
        if (this.isDestroyed === true) {
            return;
        }

        if (this.updateTimer !== null) {
            clearTimeout(this.updateTimer);
        }
        this.updateTimer = setTimeout(() => {
            this.fetchData();
        }, updateTime);

        if (this.updateDigestibilityTimer !== null) {
            clearInterval(this.updateDigestibilityTimer);
        }
        this.updateDigestibilityTimer = setInterval(() => {
            this.onAirState.updateDigestibility();
        }, 10 * 1000);
    }
}
</script>

<style lang="sass" scoped>
.theme--dark.v-tabs-items
    background-color: transparent !important
</style>
