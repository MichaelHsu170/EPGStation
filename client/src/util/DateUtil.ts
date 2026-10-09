namespace DateUtil {
    const fmt = {
        yyyy: (date: Date): string => {
            return date.getFullYear() + '';
        },
        YY: (date: Date): string => {
            return `${date.getFullYear()}`.slice(2, 4);
        },
        MM: (date: Date): string => {
            return ('0' + (date.getMonth() + 1)).slice(-2);
        },
        dd: (date: Date): string => {
            return ('0' + date.getDate()).slice(-2);
        },
        hh: (date: Date): string => {
            return ('0' + date.getHours()).slice(-2);
        },
        mm: (date: Date): string => {
            return ('0' + date.getMinutes()).slice(-2);
        },
        ss: (date: Date): string => {
            return ('0' + date.getSeconds()).slice(-2);
        },
        SSS: (date: Date): string => {
            return ('000' + date.getMilliseconds()).slice(-3);
        },
        w: (date: Date): string => {
            return ['日', '月', '火', '水', '木', '金', '土'][date.getDay()];
        },
    };

    /**
     * Date を string に変換
     * @param date: Date
     * @param formatStr: string yyyy MM dd hh mm ss w
     * @return string
     */
    export const format = (date: Date, formatStr: string): string => {
        for (const key in fmt) {
            formatStr = formatStr.replace(key, (fmt as any)[key](date));
        }

        return formatStr;
    };

    /**
     * 日本時間を返す
     * @param localDate Date
     * @return Date
     */
    export const getJaDate = (localDate: Date): Date => {
        const offSet = localDate.getTimezoneOffset() * 60 * 1000 + 1000 * 60 * 60 * 9;
        const jaDate = new Date(localDate.getTime() + offSet);

        // ずらした先で夏時間が切り替わる場合は、ずらした先の時差でずらし直す.
        // ずらす前の時差のままだと表示が 1 時間ずれ、getTimeFromJaDate() で戻した時刻も 1 時間ずれる
        // (日本時間のブラウザは時差が変わらないので結果は同じ)
        const jaOffSet = jaDate.getTimezoneOffset() * 60 * 1000 + 1000 * 60 * 60 * 9;

        return new Date(localDate.getTime() + jaOffSet);
    };

    /**
     * JSON から戻した日時を Date にする
     * sessionStorage に保存したページ情報を再読み込み後に戻すと, Date は文字列になっている
     * @param date Date | string | null
     * @return Date | null
     */
    export const restoreDate = (date: Date | string | null): Date | null => {
        return typeof date === 'string' ? new Date(date) : date;
    };

    /**
     * getJaDate() で日本時間にした Date を元の時刻 (UnixtimeMS) に戻す
     * @param jaDate Date
     * @return number
     */
    export const getTimeFromJaDate = (jaDate: Date): number => {
        const offSet = jaDate.getTimezoneOffset() * 60 * 1000 + 1000 * 60 * 60 * 9;

        return jaDate.getTime() - offSet;
    };
}

export default DateUtil;
