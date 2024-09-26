import { inject, injectable } from 'inversify';
import * as apid from '../../../../api';
import FileUtil from '../../../util/FileUtil';
import IEncodeEvent, { FinishEncodeInfo } from '../../event/IEncodeEvent';
import ILogger from '../../ILogger';
import ILoggerModel from '../../ILoggerModel';
import IIPCClient from '../../ipc/IIPCClient';
import ISocketIOManageModel from '../socketio/ISocketIOManageModel';
import IEncodeFinishModel from './IEncodeFinishModel';

@injectable()
export default class EncodeFinishModel implements IEncodeFinishModel {
    private log: ILogger;
    private socket: ISocketIOManageModel;
    private ipc: IIPCClient;
    private encodeEvent: IEncodeEvent;

    constructor(
        @inject('ILoggerModel') logger: ILoggerModel,
        @inject('ISocketIOManageModel') socket: ISocketIOManageModel,
        @inject('IIPCClient') ipc: IIPCClient,
        @inject('IEncodeEvent') encodeEvent: IEncodeEvent,
    ) {
        this.log = logger.getLogger();
        this.socket = socket;
        this.ipc = ipc;
        this.encodeEvent = encodeEvent;
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
                    const id = await this.ipc.recorded.addVideoFile({
                        recordedId: info.recordedId,
                        parentDirectoryName: info.parentDirName,
                        filePath: info.filePath,
                        type: 'encoded',
                        name: info.mode,
                    });
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
            await this.ipc.recorded.deleteVideoFile(info.videoFileId, true);
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
