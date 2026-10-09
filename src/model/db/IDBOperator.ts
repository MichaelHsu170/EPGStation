import { DataSource } from 'typeorm';

export default interface IDBOperator {
    getConnection(): Promise<DataSource>;
    checkConnection(): Promise<void>;
    closeConnection(): Promise<void>;
    isEnabledRegexp(): boolean;
    convertBoolean(value: boolean): boolean | number;
    isEnableCS(): boolean;
    getRegexpStr(cs: boolean): string;
    getCSRegexpTarget(column: string): string;
    isValidRegexp(pattern: string): Promise<boolean>;
    getLikeQuery(column: string, valueName: string, cs: boolean): string;
    getLikeValue(str: string): string;
}
