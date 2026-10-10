import { inject, injectable } from 'inversify';
import * as apid from '../../../../api';
import IDBOperator from '../../db/IDBOperator';
import IRuleDB from '../../db/IRuleDB';
import IRuleEvent from '../../event/IRuleEvent';
import ILogger from '../../ILogger';
import ILoggerModel from '../../ILoggerModel';
import IReserveOptionChecker from '../IReserveOptionChecker';
import IRuleManageModel from './IRuleManageModel';

@injectable()
export default class RuleManageModel implements IRuleManageModel {
    private isRunning: boolean = false;
    private lockTimer: NodeJS.Timeout | undefined;

    private log: ILogger;
    private optionChecker: IReserveOptionChecker;
    private ruleDB: IRuleDB;
    private ruleEvent: IRuleEvent;
    private op: IDBOperator;

    constructor(
        @inject('ILoggerModel') logger: ILoggerModel,
        @inject('IReserveOptionChecker') optionChecker: IReserveOptionChecker,
        @inject('IRuleDB') ruleDB: IRuleDB,
        @inject('IRuleEvent') ruleEvent: IRuleEvent,
        @inject('IDBOperator') op: IDBOperator,
    ) {
        this.log = logger.getLogger();
        this.optionChecker = optionChecker;
        this.ruleDB = ruleDB;
        this.ruleEvent = ruleEvent;
        this.op = op;
    }

    /**
     * ルールの追加
     * @param rule: apid.AddRuleOption
     * @return Promise<apid.Rule>
     */
    public async add(rule: apid.AddRuleOption): Promise<apid.RuleId> {
        this.lockExecution();

        this.log.system.info('add rule');

        // check option (DB エラー等で例外が発生してもロックを開放する)
        const isValid = await this.isValidRule(rule).catch(err => {
            this.unlockExecution();
            this.log.system.error(err);
            throw err;
        });
        if (isValid === false) {
            this.unlockExecution();
            this.log.system.error('failed to add rule');
            throw new Error('AddRuleError');
        }

        // 新規追加なので id はクライアントの指定を使わない (既存の id や上限値を指定されると追加できなくなる)
        delete (<any>rule).id;
        delete (<any>rule).updateCnt;

        let ruleId!: apid.RuleId;
        try {
            ruleId = await this.ruleDB.insertOnce(rule);
        } catch (err: any) {
            this.unlockExecution();
            this.log.system.error('insert rule error');
            this.log.system.error(err);
            // 失敗を返さないと id 無しで追加イベントが発行され、全ルールの予約が更新対象になってしまう
            throw err;
        }

        this.unlockExecution();
        this.log.system.info(`rule added successfully: ${ruleId}`);

        // 通知
        this.ruleEvent.emitAdded(ruleId);

        return ruleId;
    }

    /**
     * ルールの更新
     * @param rule: apid.Rule
     */
    public async update(rule: apid.Rule): Promise<void> {
        this.lockExecution();

        // rule が存在するか確認
        const oldRule = await this.ruleDB.findId(rule.id).catch(err => {
            this.unlockExecution();
            this.log.system.error(err);
            throw err;
        });

        if (oldRule === null) {
            this.unlockExecution();
            throw new Error('RuleIsNotFound');
        }

        this.log.system.info(`update rule: ${rule.id}`);

        // check option (DB エラー等で例外が発生してもロックを開放する)
        const isValid = await this.isValidRule(rule).catch(err => {
            this.unlockExecution();
            this.log.system.error(err);
            throw err;
        });
        if (isValid === false) {
            this.unlockExecution();
            this.log.system.error('failed to update rule');
            throw new Error('UpdateRuleError');
        }

        // rule 更新
        try {
            await this.ruleDB.updateOnce(rule);
        } catch (err: any) {
            this.unlockExecution();
            this.log.system.error(`update rule error: ${rule.id}`);
            throw err;
        }
        this.unlockExecution();
        this.log.system.info(`rule updated successfully: ${rule.id}`);

        // 通知
        this.ruleEvent.emitUpdated(rule.id);
    }

    /**
     * ルール有効化
     * @param ruleId: rule id
     */
    public async enable(ruleId: apid.RuleId): Promise<void> {
        this.lockExecution();

        this.log.system.info(`enable rule: ${ruleId}`);

        try {
            await this.ruleDB.enableOnce(ruleId);
        } catch (err: any) {
            this.unlockExecution();
            this.log.system.error(`enable rule error: ${ruleId}`);
            throw err;
        }

        this.unlockExecution();
        this.log.system.info(`rule enabled successfully: ${ruleId}`);

        // 通知
        this.ruleEvent.emitEnabled(ruleId);
    }

    /**
     * ルール無効化
     * @param ruleId: rule id
     */
    public async disable(ruleId: apid.RuleId): Promise<void> {
        this.lockExecution();

        this.log.system.info(`disable rule: ${ruleId}`);

        try {
            await this.ruleDB.disableOnce(ruleId);
        } catch (err: any) {
            this.unlockExecution();
            this.log.system.error(`disable rule error: ${ruleId}`);
            throw err;
        }

        this.unlockExecution();
        this.log.system.info(`rule disabled successfully: ${ruleId}`);

        // 通知
        this.ruleEvent.emitDisabled(ruleId);
    }

    /**
     * ルール削除
     * @param ruleId: rule id
     */
    public async delete(ruleId: apid.RuleId): Promise<void> {
        this.lockExecution();

        this.log.system.info(`delete rule: ${ruleId}`);

        try {
            await this.ruleDB.deleteOnce(ruleId);
        } catch (err: any) {
            this.unlockExecution();
            this.log.system.error(`delete rule error: ${ruleId}`);
            throw err;
        }

        this.unlockExecution();
        this.log.system.info(`rule deleted successfully: ${ruleId}`);

        // 通知
        this.ruleEvent.emitDeleted(ruleId);
    }

    /**
     * ルール複数削除
     * @param ruleIds: rule ids
     * @return Promise<apid.RuleId[]> 削除出来なかった ruleId を返す
     */
    public async deletes(ruleIds: apid.RuleId[]): Promise<apid.RuleId[]> {
        const failedIds: apid.RuleId[] = [];

        this.log.system.info('deletes rule');
        for (const ruleId of ruleIds) {
            try {
                await this.delete(ruleId);
            } catch (err: any) {
                failedIds.push(ruleId);
            }
        }

        return failedIds;
    }

    /**
     * ルールのオプションと正規表現をチェックする
     * @param rule: apid.AddRuleOption
     * @return Promise<boolean>
     */
    private async isValidRule(rule: apid.AddRuleOption): Promise<boolean> {
        return this.optionChecker.checkRuleOption(rule) === true && (await this.hasValidRegexps(rule)) === true;
    }

    /**
     * 正規表現として指定されたキーワードが DB で使用できるか
     * (使用できないと予約更新が毎回失敗し、更新前の予約が残り続ける)
     * @param rule: apid.AddRuleOption
     * @return Promise<boolean>
     */
    private async hasValidRegexps(rule: apid.AddRuleOption): Promise<boolean> {
        const option = rule.searchOption;
        if (option.keyRegExp === true && typeof option.keyword !== 'undefined') {
            if ((await this.op.isValidRegexp(option.keyword)) === false) {
                return false;
            }
        }
        if (option.ignoreKeyRegExp === true && typeof option.ignoreKeyword !== 'undefined') {
            if ((await this.op.isValidRegexp(option.ignoreKeyword)) === false) {
                return false;
            }
        }

        return true;
    }

    /**
     * 実行権をロックする
     */
    private lockExecution(): void {
        if (this.isRunning === true) {
            throw new Error('RuleManageModelIsRunning');
        }
        this.isRunning = true;

        this.lockTimer = setTimeout(() => {
            this.unlockExecution();
        }, 1000 * 10);
    }

    /**
     * 実行権の開放
     */
    private unlockExecution(): void {
        this.isRunning = false;
        clearTimeout(<any>this.lockTimer);
    }
}
