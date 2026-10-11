import Reserve from '../../../db/entities/Reserve';

export type RecorderModelProvider = () => Promise<IRecorderModel>;

export default interface IRecorderModel {
    setTimer(reserve: Reserve, isSuppressLog: boolean): boolean;
    cancel(isPlanToDelete: boolean): Promise<void>;
    update(newReserve: Reserve, isSuppressLog: boolean): Promise<void>;
    resetTimer(): boolean;
}

/**
 * program id 予約の番組の終了時刻が未定か
 * Mirakurun は長さ未定 (延長中など) の番組を duration 1 ms として返すため、予約の endAt は startAt + 1 になる
 */
export const isUndeterminedEnd = (reserve: Reserve): boolean => {
    return reserve.programId !== null && reserve.endAt - reserve.startAt === 1;
};

/**
 * 予約の番組が放送中か
 * 終了時刻未定の番組は、Mirakurun が EIT p/f に載っている間は番組ストリームを開いたままにするため放送中として扱う
 */
export const isReserveOnAir = (reserve: Reserve, now: number): boolean => {
    return now < reserve.endAt || isUndeterminedEnd(reserve);
};
