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

const ignoreKeywordOption = () => ({ keyCS: false, keyRegExp: false, name: true, description: true, extended: false });

test('search rule: an ignore keyword is sent with its options', () => {
    const ruleOption = createRuleSearchOption({ ...createOption(), ignoreKeyword: '再放送', ignoreKeywordOption: ignoreKeywordOption() });

    assert.strictEqual(ruleOption.ignoreKeyword, '再放送');
    assert.strictEqual(ruleOption.ignoreName, true);
    assert.strictEqual(ruleOption.ignoreDescription, true);
    assert.strictEqual(ruleOption.ignoreExtended, false);
});

test('search rule: an ignore keyword that was cleared, deleted with the keyboard or is only spaces is not sent', () => {
    for (const ignoreKeyword of [null, '', ' ', '　 ']) {
        const ruleOption = createRuleSearchOption({ ...createOption(), ignoreKeyword, ignoreKeywordOption: ignoreKeywordOption() });

        assert.deepStrictEqual(
            Object.keys(ruleOption).filter(key => key.startsWith('ignore')),
            [],
            `ignoreKeyword ${JSON.stringify(ignoreKeyword)}`,
        );
    }
});

const prepSearchOption = searchOption => {
    const state = Object.create(SearchState.prototype);
    state.searchOption = searchOption;
    state.prepSearchOption();

    return state.searchOption;
};

test('search option: an ignore keyword gets name and description when no target is checked', () => {
    const searchOption = prepSearchOption({
        ...createOption(),
        ignoreKeyword: '再放送',
        ignoreKeywordOption: { keyCS: false, keyRegExp: false, name: false, description: false, extended: false },
    });

    assert.deepStrictEqual(searchOption.ignoreKeywordOption, { keyCS: false, keyRegExp: false, name: true, description: true, extended: false });
});

test('search option: an ignore keyword deleted with the keyboard or only spaces turns its options off, as a cleared one does', () => {
    for (const ignoreKeyword of [null, '', '  ']) {
        const searchOption = prepSearchOption({
            ...createOption(),
            ignoreKeyword,
            ignoreKeywordOption: { keyCS: true, keyRegExp: true, name: true, description: false, extended: true },
        });

        assert.deepStrictEqual(
            searchOption.ignoreKeywordOption,
            { keyCS: false, keyRegExp: false, name: false, description: false, extended: false },
            `ignoreKeyword ${JSON.stringify(ignoreKeyword)}`,
        );
    }
});

const createTimeSpecificationRuleSearchOption = option => Object.create(SearchState.prototype).createTimeSpecificationRuleSearchOption(option);
const timeReserveOption = keyword => ({
    keyword,
    channel: 3273601024,
    startTime: '01:30',
    endTime: '02:00',
    week: { sun: false, mon: true, tue: false, wed: false, thu: false, fri: false, sat: false },
});

test('time specified rule: the program name is sent', () => {
    assert.deepStrictEqual(createTimeSpecificationRuleSearchOption(timeReserveOption('深夜番組')), {
        keyword: '深夜番組',
        channelIds: [3273601024],
        times: [{ start: 5400, range: 1800, week: 0x02 }],
    });
});

test('time specified rule: a program name that was cleared or deleted with the keyboard is an input error', () => {
    assert.throws(() => createTimeSpecificationRuleSearchOption(timeReserveOption(null)), { message: 'TimeReserveOptionIsInvalidValue' });
    assert.throws(() => createTimeSpecificationRuleSearchOption(timeReserveOption('')), { message: 'TimeReserveOptionIsInvalidValue' });
    assert.throws(() => createTimeSpecificationRuleSearchOption(timeReserveOption('  ')), { message: 'TimeReserveOptionIsInvalidValue' });
    assert.throws(() => createTimeSpecificationRuleSearchOption(timeReserveOption('\u3000')), { message: 'TimeReserveOptionIsInvalidValue' });
});

test("search option: a start or range cleared with the select's clear icon (null) removes the time range", () => {
    for (const [startTime, rangeTime] of [
        [null, null],
        [6, null],
        [null, 3],
        [6, undefined],
    ]) {
        const searchOption = prepSearchOption({ ...createOption(), startTime, rangeTime });

        assert.deepStrictEqual([searchOption.startTime, searchOption.rangeTime], [undefined, undefined], `start ${startTime}, range ${rangeTime}`);
    }
});

test('search option: a start and range that are both set are kept', () => {
    const searchOption = prepSearchOption({ ...createOption(), startTime: 0, rangeTime: 3 });

    assert.deepStrictEqual([searchOption.startTime, searchOption.rangeTime], [0, 3]);
});

test('search rule: the time range is sent only when start and range are both numbers', () => {
    assert.deepStrictEqual(createRuleSearchOption({ ...createOption(), startTime: 6, rangeTime: 3 }).times, [{ week: 0x7f, start: 6, range: 3 }]);
    assert.deepStrictEqual(createRuleSearchOption({ ...createOption(), startTime: 0, rangeTime: 1 }).times, [{ week: 0x7f, start: 0, range: 1 }]);
    assert.deepStrictEqual(createRuleSearchOption({ ...createOption(), startTime: null, rangeTime: null }).times, [{ week: 0x7f }]);
    assert.deepStrictEqual(createRuleSearchOption({ ...createOption(), startTime: 6, rangeTime: null }).times, [{ week: 0x7f }]);
    assert.deepStrictEqual(createRuleSearchOption({ ...createOption(), startTime: null, rangeTime: 3 }).times, [{ week: 0x7f }]);
});

// the rule as 追加 / 更新 sends it, from the form as it is when the button is clicked
const createAddRuleOption = searchOption => {
    const state = Object.create(SearchState.prototype);
    Object.assign(state, {
        isTimeSpecification: false,
        searchOption,
        reserveOption: reserveOption(null),
        saveOption: null,
        encodeOption: null,
    });

    return state.createAddRuleOption().searchOption;
};

test('add / update rule: an ignore keyword typed after the last search gets name and description, as a search gives it', () => {
    const sent = createAddRuleOption({
        ...createOption(),
        keywordOption: { keyCS: false, keyRegExp: false, name: true, description: true, extended: false },
        ignoreKeyword: '再放送',
        ignoreKeywordOption: { keyCS: false, keyRegExp: false, name: false, description: false, extended: false },
    });

    assert.deepStrictEqual(
        [sent.ignoreKeyword, sent.ignoreKeyCS, sent.ignoreKeyRegExp, sent.ignoreName, sent.ignoreDescription, sent.ignoreExtended],
        ['再放送', false, false, true, true, false],
    );
});

test('add / update rule: a keyword typed after a search without one gets name and description', () => {
    const sent = createAddRuleOption({
        ...createOption(),
        keyword: 'ニュース',
        keywordOption: { keyCS: false, keyRegExp: false, name: false, description: false, extended: false },
    });

    assert.deepStrictEqual([sent.keyword, sent.keyCS, sent.keyRegExp, sent.name, sent.description, sent.extended], ['ニュース', false, false, true, true, false]);
});

test('update rule: the targets stored in an edited rule are sent unchanged', () => {
    const sent = createAddRuleOption({
        ...createOption(),
        keyword: 'ニュース',
        keywordOption: { keyCS: true, keyRegExp: false, name: false, description: false, extended: true },
        ignoreKeyword: '再放送',
        ignoreKeywordOption: { keyCS: false, keyRegExp: true, name: false, description: true, extended: false },
        startTime: 6,
        rangeTime: 3,
    });

    assert.deepStrictEqual(sent, {
        keyword: 'ニュース',
        keyCS: true,
        keyRegExp: false,
        name: false,
        description: false,
        extended: true,
        ignoreKeyword: '再放送',
        ignoreKeyCS: false,
        ignoreKeyRegExp: true,
        ignoreName: false,
        ignoreDescription: true,
        ignoreExtended: false,
        times: [{ week: 0x7f, start: 6, range: 3 }],
    });
});

// the search page with a fresh form; requests records every search sent to the server
const createSearchPage = () => {
    const requests = [];
    const state = new SearchState(
        {},
        { getConfig: () => null },
        {
            getScheduleSearch: async option => {
                requests.push(option);

                return [];
            },
        },
        {},
        {},
        {},
        {},
        { close: () => {} },
        { getSavedValue: () => ({ isHalfWidthDisplayed: true, searchLength: 300 }) },
    );
    state.clear();

    return { state, requests };
};

// what 検索 sends for the keyword ニュース typed into a fresh form (the targets are off until the search turns on 番組名 and 概要)
const newsSearch = {
    option: { keyword: 'ニュース', keyCS: false, keyRegExp: false, name: true, description: true, extended: false, times: [{ week: 0x7f }] },
    isHalfWidth: true,
    limit: 300,
};

test('search results: a refresh before any search sends nothing, not the form with every target off', async () => {
    const { state, requests } = createSearchPage();
    state.searchOption.keyword = 'ニュース';

    await state.fetchSearchResult();

    assert.deepStrictEqual(requests, []);
    assert.strictEqual(state.getSearchResult(), null);
});

test('search results: a refresh re-runs the last search, not the form as it was edited since', async () => {
    const { state, requests } = createSearchPage();
    state.searchOption.keyword = 'ニュース';
    state.prepSearch();
    await state.fetchSearchResult();

    state.searchOption.keyword = 'ドラマ';
    state.searchOption.keywordOption.extended = true;
    state.searchOption.week.sun = false;
    await state.fetchSearchResult();

    assert.deepStrictEqual(requests, [newsSearch, newsSearch]);
    assert.deepStrictEqual(state.getSearchResult(), []);
});

test('search results: a refresh after the form is cleared or the page is opened again sends nothing', async () => {
    for (const reset of [state => state.clear(), state => state.init()]) {
        const { state, requests } = createSearchPage();
        state.searchOption.keyword = 'ニュース';
        state.prepSearch();
        await state.fetchSearchResult();

        await reset(state);
        await state.fetchSearchResult();

        assert.deepStrictEqual(requests, [newsSearch]);
        assert.strictEqual(state.getSearchResult(), null);
    }
});
