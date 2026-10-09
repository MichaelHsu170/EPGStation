require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const SearchState = require('../test-build/model/state/search/SearchState').default;

// the search form's option with every condition off but the keyword
const createOption = () => ({
    keyword: 'news',
    keywordOption: {},
    ignoreKeyword: null,
    ignoreKeywordOption: {},
    channels: [],
    broadcastWave: {
        GR: { isShow: true, isEnable: true },
        BS: { isShow: true, isEnable: true },
        CS: { isShow: false, isEnable: false },
        SKY: { isShow: false, isEnable: false },
    },
    genres: {},
    week: { sun: true, mon: true, tue: true, wed: true, thu: true, fri: true, sat: true },
    isFree: false,
    durationMin: null,
    durationMax: null,
    startPeriod: null,
    endPeriod: null,
});

const createRuleSearchOption = option => Object.create(SearchState.prototype).createRuleSearchOption(option);

test('search rule: durations in minutes are sent in seconds', () => {
    const ruleOption = createRuleSearchOption({ ...createOption(), durationMin: 10, durationMax: 30 });

    assert.strictEqual(ruleOption.durationMin, 600);
    assert.strictEqual(ruleOption.durationMax, 1800);
});

test('search rule: a duration of 0 minutes is sent', () => {
    const ruleOption = createRuleSearchOption({ ...createOption(), durationMin: 0 });

    assert.strictEqual(ruleOption.durationMin, 0);
});

test('search rule: durations that were never entered are not sent', () => {
    const ruleOption = createRuleSearchOption(createOption());

    assert.strictEqual('durationMin' in ruleOption, false);
    assert.strictEqual('durationMax' in ruleOption, false);
});

test('search rule: durations deleted with the keyboard (the text field gives an empty string) are not sent', () => {
    const ruleOption = createRuleSearchOption({ ...createOption(), durationMin: '', durationMax: '' });

    assert.strictEqual('durationMin' in ruleOption, false);
    assert.strictEqual('durationMax' in ruleOption, false);
});

const createRuleReserveOption = option => Object.create(SearchState.prototype).createRuleReserveOption(option);
const reserveOption = periodToAvoidDuplicate => ({
    enable: true,
    allowEndLack: true,
    avoidDuplicate: true,
    periodToAvoidDuplicate,
});

test('rule reserve option: the days to avoid duplicates are sent as a number, also when the text field gives a string', () => {
    assert.strictEqual(createRuleReserveOption(reserveOption(7)).periodToAvoidDuplicate, 7);
    assert.strictEqual(createRuleReserveOption(reserveOption('3')).periodToAvoidDuplicate, 3);
    assert.strictEqual(createRuleReserveOption(reserveOption(0)).periodToAvoidDuplicate, 0);
});

test('rule reserve option: days to avoid duplicates that were cleared or deleted with the keyboard are not sent', () => {
    assert.strictEqual('periodToAvoidDuplicate' in createRuleReserveOption(reserveOption(null)), false);
    assert.strictEqual('periodToAvoidDuplicate' in createRuleReserveOption(reserveOption('')), false);
});
