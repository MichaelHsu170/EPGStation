require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const RecordedState = require('../test-build/model/state/recorded/RecordedState').default;
const RecordingState = require('../test-build/model/state/recording/RecordingState').default;
const ReservesState = require('../test-build/model/state/reserve/ReservesState').default;
const RuleState = require('../test-build/model/state/rule/RuleState').default;
const EncodeState = require('../test-build/model/state/encode/EncodeState').default;

/**
 * An API whose gets() calls resolve in the order the test chooses: gets(...) returns a pending promise,
 * and api.resolve(i, value) resolves the i-th call.
 */
const createApi = () => {
    const api = { calls: [] };
    api.gets = () => new Promise(resolve => api.calls.push(resolve));
    api.resolve = (i, value) => api.calls[i](value);

    return api;
};

const recordedUtil = { convertRecordedItemToDisplayData: r => ({ recordedItem: r, isSelected: false }) };
const reserveStateUtil = { convertReserveItemsToStateDatas: reserves => reserves.map(r => ({ reserveItem: r, isSelected: false })) };
const channelModel = { findChannel: () => null };

const rule = id => ({ id, searchOption: {}, reserveOption: { enable: true } });
const encodeItem = id => ({ id, mode: 'H.264', recorded: { channelId: 1, name: `program ${id}`, startAt: 0, endAt: 60 * 1000 } });

// [name, create state, fetch, response with the given ids, ids shown by the state]
const states = [
    [
        'RecordedState',
        api => new RecordedState(api, recordedUtil, null),
        s => s.fetchData({ isHalfWidth: true }),
        ids => ({ records: ids.map(id => ({ id })), total: ids.length }),
        s => s.getRecorded().map(r => r.recordedItem.id),
    ],
    [
        'RecordingState',
        api => new RecordingState(api, recordedUtil, null),
        s => s.fetchData({ isHalfWidth: true }),
        ids => ({ records: ids.map(id => ({ id })), total: ids.length }),
        s => s.getRecorded().map(r => r.recordedItem.id),
    ],
    [
        'ReservesState',
        api => new ReservesState(api, reserveStateUtil),
        s => s.fetchData({ type: 'all', isHalfWidth: true }),
        ids => ({ reserves: ids.map(id => ({ id })), total: ids.length }),
        s => s.getReserves().map(r => r.reserveItem.id),
    ],
    [
        'RuleState',
        api => new RuleState(channelModel, api),
        s => s.fetchData({ type: 'normal', isHalfWidth: true }),
        ids => ({ rules: ids.map(rule), total: ids.length }),
        s => s.getRules().map(r => r.item.id),
    ],
    [
        'EncodeState',
        api => new EncodeState(api, channelModel),
        s => s.fetchData(true),
        ids => ({ runningItems: ids.map(encodeItem), waitItems: [] }),
        s => s.getEncodeInfo().runningItems.map(e => e.encodeItem.id),
    ],
];

for (const [name, create, fetch, response, shownIds] of states) {
    test(`${name}: an older response that arrives last does not replace the newer one`, async () => {
        const api = createApi();
        const state = create(api);

        const older = fetch(state); // e.g. page 1
        const newer = fetch(state); // e.g. page 2, requested later
        api.resolve(1, response([2]));
        await newer;
        api.resolve(0, response([1]));
        await older;

        assert.deepStrictEqual(shownIds(state), [2]);
    });

    test(`${name}: a response to a request made before clearing the data is not shown`, async () => {
        const api = createApi();
        const state = create(api);

        const fetching = fetch(state);
        typeof state.clearData === 'function' ? state.clearData() : state.clearDate();
        api.resolve(0, response([1]));
        await fetching;

        assert.deepStrictEqual(shownIds(state), []);
    });

    test(`${name}: a response is shown while a later request is still pending`, async () => {
        // e.g. the encode progress, refreshed again before each response arrives
        const api = createApi();
        const state = create(api);

        const first = fetch(state);
        const second = fetch(state);
        api.resolve(0, response([1]));
        await first;
        assert.deepStrictEqual(shownIds(state), [1]);

        const third = fetch(state);
        api.resolve(1, response([2]));
        await second;
        assert.deepStrictEqual(shownIds(state), [2]);

        api.resolve(2, response([3]));
        await third;
        assert.deepStrictEqual(shownIds(state), [3]);
    });

    test(`${name}: responses in request order are all shown`, async () => {
        const api = createApi();
        const state = create(api);

        const first = fetch(state);
        api.resolve(0, response([1]));
        await first;
        assert.deepStrictEqual(shownIds(state), [1]);

        const second = fetch(state);
        api.resolve(1, response([3, 4]));
        await second;
        assert.deepStrictEqual(shownIds(state), [3, 4]);
    });
}

test('EncodeState: the selection of waiting encodes survives a refresh', async () => {
    const api = createApi();
    const state = new EncodeState(api, channelModel);
    const info = { runningItems: [encodeItem(1)], waitItems: [encodeItem(2), encodeItem(3)] };

    const first = state.fetchData(true);
    api.resolve(0, info);
    await first;
    state.select(1);
    state.select(3);

    const refresh = state.fetchData(true); // e.g. an encode progress event
    api.resolve(1, info);
    await refresh;

    const selected = e => [e.encodeItem.id, e.isSelected];
    assert.deepStrictEqual(state.getEncodeInfo().runningItems.map(selected), [[1, true]]);
    assert.deepStrictEqual(state.getEncodeInfo().waitItems.map(selected), [
        [2, false],
        [3, true],
    ]);
});
