import { injectable } from 'inversify';
import IStorageOperationModel from './IStorageOperationModel';

/**
 * StorageOperationModel
 * local storage の set, get, remove を行う
 */
@injectable()
export default class StorageOperationModel implements IStorageOperationModel {
    // local storage が使えない場合に key ごとに値を保持する
    private dummySavedValues: { [key: string]: string } = {};

    /**
     * 値のセット
     * @param key: string key
     * @param value: 保存する値
     */
    public set(key: string, value: any): void {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (err) {
            console.error('local storage save error');
            this.dummySavedValues[key] = JSON.stringify(value);
        }
    }

    /**
     * key で指定した値の取得
     * @param key: string key
     * @return any | null
     */
    public get(key: string): any | null {
        let value: string | null = null;
        try {
            value = window.localStorage.getItem(key);
        } catch (err) {
            value = typeof this.dummySavedValues[key] === 'undefined' ? null : this.dummySavedValues[key];
        }

        if (value === null) {
            return null;
        }

        // 壊れた値やオブジェクトではない値 (同じ origin の他のアプリが保存した値など) は null を返してデフォルト値で上書きさせる
        try {
            const parsed = JSON.parse(value);

            return parsed !== null && typeof parsed === 'object' ? parsed : null;
        } catch (err) {
            console.error(`local storage parse error: ${key}`);

            return null;
        }
    }

    /**
     * key で指定した値の削除
     * @param key: string key
     */
    public remove(key: string): void {
        window.localStorage.removeItem(key);
    }
}
