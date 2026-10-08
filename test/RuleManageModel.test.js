require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const RuleManageModel = require('../dist/model/operator/rule/RuleManageModel').default;

const createModel = members => {
    const model = Object.create(RuleManageModel.prototype);
    Object.assign(model, {
        log: { system: { info: () => {}, error: () => {} } },
        isRunning: false,
        optionChecker: { checkRuleOption: () => true },
        op: { isValidRegexp: async pattern => pattern !== 'foo(bar' },
        ruleEvent: { emitAdded: () => {}, emitUpdated: () => {} },
        ruleDB: {},
        ...members,
    });

    return model;
};

const rule = searchOption => ({ isTimeSpecification: false, searchOption, reserveOption: {} });

test('a rule that fails to insert is reported as failed and announces nothing', async () => {
    const added = [];
    const model = createModel({
        ruleDB: { insertOnce: async () => Promise.reject(new Error('Duplicate entry')) },
        ruleEvent: { emitAdded: id => added.push(id) },
    });

    await assert.rejects(model.add(rule({ keyword: 'a' })), /Duplicate entry/);
    assert.deepStrictEqual(added, []);
});

test('a new rule ignores an id and updateCnt sent by the client', async () => {
    const inserted = [];
    const model = createModel({ ruleDB: { insertOnce: async r => (inserted.push(r), 7) } });

    assert.strictEqual(await model.add({ ...rule({ keyword: 'a' }), id: 2147483647, updateCnt: 9 }), 7);
    assert.strictEqual('id' in inserted[0], false);
    assert.strictEqual('updateCnt' in inserted[0], false);
});

test('a rule with an invalid keyword regex is refused on add and update', async () => {
    const saved = [];
    const model = createModel({
        ruleDB: {
            insertOnce: async r => (saved.push(r), 1),
            findId: async () => ({ id: 1 }),
            updateOnce: async r => saved.push(r),
        },
    });

    await assert.rejects(model.add(rule({ keyword: 'foo(bar', keyRegExp: true })), /AddRuleError/);
    await assert.rejects(model.update({ id: 1, ...rule({ ignoreKeyword: 'foo(bar', ignoreKeyRegExp: true }) }), /UpdateRuleError/);
    assert.deepStrictEqual(saved, []);
});

test('a valid regex, or the same text without the regex option, is accepted', async () => {
    const model = createModel({ ruleDB: { insertOnce: async () => 1 } });

    assert.strictEqual(await model.add(rule({ keyword: 'foo(bar' })), 1);
    assert.strictEqual(await model.add(rule({ keyword: '^ド.マ$', keyRegExp: true })), 1);
});
