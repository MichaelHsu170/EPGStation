require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const ReserveOptionChecker = require('../dist/model/operator/ReserveOptionChecker').default;

const checker = new ReserveOptionChecker({ getConfig: () => ({}) });
const timeRule = time => ({
    isTimeSpecification: true,
    searchOption: { keyword: 'x', channelIds: [1], times: [{ week: 0x7f, ...time }] },
    reserveOption: { enable: true, allowEndLack: true, avoidDuplicate: false },
});

test('time-specified rules within one day are accepted', () => {
    assert.strictEqual(checker.checkRuleOption(timeRule({ start: 0, range: 3600 })), true);
    assert.strictEqual(checker.checkRuleOption(timeRule({ start: 23 * 3600, range: 24 * 3600 })), true);
});

test('time-specified rules starting after the day or lasting longer than a day are refused', () => {
    assert.strictEqual(checker.checkRuleOption(timeRule({ start: 24 * 3600, range: 3600 })), false);
    assert.strictEqual(checker.checkRuleOption(timeRule({ start: 0, range: 24 * 3600 + 1 })), false);
});
