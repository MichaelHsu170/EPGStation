import * as path from 'path';
import { inject, injectable } from 'inversify';
import { DataSource } from 'typeorm';
import IConfigFile from '../IConfigFile';
import IConfiguration from '../IConfiguration';
import ILogger from '../ILogger';
import ILoggerModel from '../ILoggerModel';
import IDBOperator from './IDBOperator';

@injectable()
export default class DBOperator implements IDBOperator {
    private connection: DataSource | null = null;
    // 接続処理中の呼び出しが同じ接続を待つようにする (並行に呼ばれると DataSource が 2 つ作られてしまう)
    private connecting: Promise<void> | null = null;
    private config: IConfigFile;
    private log: ILogger;

    constructor(@inject('ILoggerModel') logger: ILoggerModel, @inject('IConfiguration') conf: IConfiguration) {
        this.log = logger.getLogger();
        this.config = conf.getConfig();
    }

    public async getConnection(): Promise<DataSource> {
        if (this.connection === null) {
            if (this.connecting === null) {
                this.connecting = (async () => {
                    // 拡張の読み込みが終わるまで this.connection に設定しない (先に設定すると、後から来た呼び出しが
                    // 読み込みを待たずに regexp などを使う)
                    const connection = await this.createConnection();
                    try {
                        await this.setSQLiteExtensions(connection);
                    } catch (err: any) {
                        await connection.destroy().catch(() => {});
                        throw err;
                    }
                    this.connection = connection;
                })().finally(() => {
                    this.connecting = null;
                });
            }
            await this.connecting;
        }

        return <DataSource>this.connection;
    }

    /**
     * DB へ接続を行い接続済みのDataSourceを返す
     * @returns DataSource
     */
    private async createConnection(): Promise<DataSource> {
        // アプリのルートディレクトリ
        const appRootPath = path.join(__dirname, '..', '..', '..');

        // dist 下のディレクトリ設定
        const distDBBasePath = path.join(appRootPath, 'dist', 'db');
        const entitie = path.join(distDBBasePath, 'entities', '**', '*.js');
        const subscriber = path.join(distDBBasePath, 'subscribers', '**', '*.js');

        // マイグレーションファイルの場所
        const migrations = [path.join(distDBBasePath, 'migrations', this.config.dbtype, '**', '*.js')];

        let connection: DataSource;
        if (this.config.dbtype === 'sqlite') {
            connection = new DataSource({
                type: 'sqlite',
                database: path.join(appRootPath, 'data', 'database.db'),
                synchronize: false,
                logging: false,
                entities: [entitie],
                subscribers: [subscriber],
                migrationsRun: true,
                migrations: migrations,
            });
        } else if (this.config.dbtype === 'mysql' && typeof this.config.mysql !== 'undefined') {
            connection = new DataSource({
                type: 'mysql',
                host: this.config.mysql.host,
                port: this.config.mysql.port,
                username: this.config.mysql.user,
                password: this.config.mysql.password,
                database: this.config.mysql.database,
                charset: typeof this.config.mysql.charset === 'undefined' ? 'utf8mb4' : this.config.mysql.charset,
                bigNumberStrings: false,
                synchronize: false,
                logging: false,
                entities: [entitie],
                subscribers: [subscriber],
                migrationsRun: true,
                migrations: migrations,
            });
        } else {
            throw new Error('DBTypeError');
        }

        // 接続処理実施
        await connection.initialize();

        return connection;
    }

    /**
     * 接続確認
     * @return Promise<void>
     */
    public async checkConnection(): Promise<void> {
        const connection = await this.getConnection();
        await connection.manager.query('select 1');
    }

    /**
     * DB との接続を切断する
     * @return Promise<void>
     */
    public async closeConnection(): Promise<void> {
        if (this.connection === null) {
            return;
        }

        await this.connection.destroy();
    }

    /**
     * sqlite の外部拡張読み込み
     * @param connection: DataSource
     */
    private async setSQLiteExtensions(connection: DataSource): Promise<void> {
        if (
            this.config.dbtype !== 'sqlite' ||
            typeof this.config.sqlite === 'undefined' ||
            typeof this.config.sqlite.extensions === 'undefined'
        ) {
            return;
        }

        // 外部拡張読み込み
        for (const extension of this.config.sqlite.extensions) {
            this.log.system.info(`load extension: ${extension}`);
            await new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
                (<any>connection).driver.databaseConnection.loadExtension(extension, (err: Error | null) => {
                    if (err) {
                        this.log.system.error(`failed to load extension: ${extension}`);
                        reject(err);
                    } else {
                        this.log.system.info(`loaded extension success: ${extension}`);
                        resolve();
                    }
                });
            });
        }
    }

    /**
     * regexp が有効か返す
     */
    public isEnabledRegexp(): boolean {
        if (this.config.dbtype !== 'sqlite') {
            return true;
        }

        return typeof this.config.sqlite === 'undefined' ? false : !!this.config.sqlite.regexp;
    }

    /**
     * boolean 型を変換する
     */
    public convertBoolean(value: boolean): boolean | number {
        if (this.config.dbtype !== 'sqlite') {
            return value;
        }

        return value === true ? 1 : 0;
    }

    /**
     * 大文字小文字の区別が有効か返す
     * @return boolean
     */
    public isEnableCS(): boolean {
        return this.config.dbtype === 'sqlite' ? false : true;
    }

    /**
     * regexp を返す
     * @param cs: boolean 大小文字区別の有無
     * @return string
     */
    public getRegexpStr(cs: boolean): string {
        switch (this.config.dbtype) {
            case 'mysql':
                // 大小文字の区別は getCSRegexpTarget の照合順序で行う (regexp binary はバイト単位の照合になる)
                return 'regexp';
            case 'postgres':
                return cs ? '~' : '~*';
            case 'sqlite':
            default:
                return 'regexp';
        }
    }

    /**
     * 大小文字を区別する正規表現検索で、検索対象の列に付ける式を返す
     * mysql でバイト列 (CAST AS BINARY) にすると . や文字クラスが日本語 1 文字に一致しないため、
     * 大小文字を区別しつつ文字単位で照合する utf8mb4_bin 照合順序を使う
     * (utf8mb4_bin は utf8mb4 の列にしか指定できないため、列の文字コードが utf8 (utf8mb3) でも使えるよう変換する)
     * @param column: string 列 (式)
     * @return string
     */
    public getCSRegexpTarget(column: string): string {
        return this.config.dbtype === 'mysql'
            ? `CONVERT(${column} USING utf8mb4) COLLATE utf8mb4_bin`
            : `CAST(${column} AS BINARY)`;
    }

    /**
     * 正規表現が DB で使用できるか (構文が正しいか) を DB 自身に判定させる
     * (検索は DB の正規表現エンジンで行うため、同じエンジンで確認する)
     * @param pattern: string
     * @return Promise<boolean>
     */
    public async isValidRegexp(pattern: string): Promise<boolean> {
        if (this.isEnabledRegexp() === false) {
            return true;
        }

        const connection = await this.getConnection();
        const param = this.config.dbtype === 'postgres' ? '$1' : '?';
        try {
            await connection.query(`SELECT '' ${this.getRegexpStr(false)} ${param}`, [pattern]);

            return true;
        } catch (err: any) {
            return false;
        }
    }

    /**
     * 部分一致 (like) 検索の条件式を返す. 値は getLikeValue で生成したものを渡す
     * (エスケープ文字は ! を使う. バックスラッシュは文字列リテラルでの書き方が mysql と他の DB で異なるため)
     * @param column: string 列 (式)
     * @param valueName: string パラメータ名
     * @param cs boolean 大小文字区別の有無
     * @return string
     */
    public getLikeQuery(column: string, valueName: string, cs: boolean): string {
        switch (this.config.dbtype) {
            case 'mysql':
                // 列の照合順序 utf8mb4_unicode_ci は濁点・半濁点を区別しない (ハ・バ・パが一致する) ため、大小文字を
                // 区別しない検索は、濁点・半濁点を区別する utf8mb4_0900_as_ci (MySQL 8.0 以降, MariaDB 12.3 で確認) で照合する
                return cs
                    ? `${column} like binary :${valueName} escape '!'`
                    : `${column} like :${valueName} collate utf8mb4_0900_as_ci escape '!'`;
            case 'postgres':
                return `${column} ${cs ? 'like' : 'ilike'} :${valueName} escape '!'`;
            case 'sqlite':
            default:
                return `${column} like :${valueName} escape '!'`;
        }
    }

    /**
     * 2 つの列 (式) の値が一致する条件式を返す
     * 照合は大小文字を区別しない部分一致検索 (getLikeQuery) と同じ (濁点・半濁点は区別し、大小文字は区別しない)
     * @param column1: string 列 (式)
     * @param column2: string 列 (式)
     * @return string
     */
    public getEqualQuery(column1: string, column2: string): string {
        switch (this.config.dbtype) {
            case 'mysql':
                // getLikeQuery と同じく utf8mb4_0900_as_ci で照合する
                // (utf8mb4_0900_as_ci は utf8mb4 の値にしか指定できないため、列が utf8 (utf8mb3) でも使えるよう変換する)
                return `${column1} = CONVERT(${column2} USING utf8mb4) COLLATE utf8mb4_0900_as_ci`;
            case 'postgres':
                // ilike と同じく大小文字を区別しない
                return `lower(${column1}) = lower(${column2})`;
            case 'sqlite':
            default:
                // like と同じく ASCII の大小文字のみ区別しない
                return `${column1} = ${column2} collate nocase`;
        }
    }

    /**
     * str を含む部分一致 (like) 検索の値を返す
     * str 中の % と _ はワイルドカードとして扱わない (全角の ％ ＿ も半角化で % _ になるため)
     * @param str: string
     * @return string
     */
    public getLikeValue(str: string): string {
        return `%${str.replace(/[!%_]/g, '!$&')}%`;
    }
}
