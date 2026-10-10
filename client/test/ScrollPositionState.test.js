require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const ScrollPositionState = require('../test-build/model/state/ScrollPositionState').default;

/**
 * Replaces window.sessionStorage and location for one test. items holds the stored strings;
 * setItem throws when isFull is true (quota exceeded).
 */
const useSession = (t, items, isFull = false) => {
    global.window = {
        sessionStorage: {
            getItem: key => (typeof items[key] === 'undefined' ? null : items[key]),
            setItem: (key, value) => {
                if (isFull) {
                    throw new Error('QuotaExceededError');
                }
                items[key] = value;
            },
        },
    };
    global.location = { href: '' };
    t.after(() => {
        delete global.window;
        delete global.location;
    });
    t.mock.method(console, 'error', () => {});
};

const goTo = (state, timestamp) => {
    global.location.href = `http://localhost/#/recorded?timestamp=${timestamp}`;
    state.updateHistoryPosition();
};

// what the page saved before a reload: two pages, the second one shown
const savedBeforeReload = () =>
    JSON.stringify({
        history: [
            { id: 1, url: 'http://localhost/#/?timestamp=1', data: { x: 10 } },
            { id: 2, url: 'http://localhost/#/recorded?timestamp=2', data: { x: 20 } },
        ],
        curentPosition: 1,
    });

test('after a reload a new page gets its own history entry and can save its scroll data', t => {
    const items = { historyInfo: savedBeforeReload() };
    useSession(t, items);
    const state = new ScrollPositionState();

    goTo(state, 3);
    state.saveScrollData({ x: 30 });

    const saved = JSON.parse(items.historyInfo);
    assert.strictEqual(saved.curentPosition, 2);
    assert.deepStrictEqual(
        saved.history.map(h => [h.id, h.data]),
        [
            [1, { x: 10 }],
            [2, { x: 20 }],
            [3, { x: 30 }],
        ],
    );
});

test('after a reload going back to a saved page restores its scroll data', t => {
    useSession(t, { historyInfo: savedBeforeReload() });
    const state = new ScrollPositionState();

    goTo(state, 1);

    assert.strictEqual(state.isNeedRestoreHistory, true);
    assert.deepStrictEqual(state.getScrollData(), { x: 10 });
});

test('a corrupt saved history is ignored and a new one is started', t => {
    const items = { historyInfo: 'not json{' };
    useSession(t, items);
    const state = new ScrollPositionState();

    goTo(state, 5);
    state.saveScrollData({ x: 50 });

    const saved = JSON.parse(items.historyInfo);
    assert.strictEqual(saved.curentPosition, 0);
    assert.deepStrictEqual(
        saved.history.map(h => [h.id, h.data]),
        [[5, { x: 50 }]],
    );
});

test('a full session storage does not stop navigation', t => {
    useSession(t, {}, true);
    const state = new ScrollPositionState();

    goTo(state, 1);
    goTo(state, 2);
    state.saveScrollData({ x: 1 });
    goTo(state, 1);

    assert.strictEqual(state.isNeedRestoreHistory, true);
    assert.strictEqual(state.getScrollData(), null);
});

test('a page opened without a timestamp does not get the saved data of another such page', t => {
    useSession(t, {});
    const state = new ScrollPositionState();

    global.location.href = 'http://localhost/#/rule';
    state.updateHistoryPosition();
    state.saveScrollData({ page: 'rule' });
    global.location.href = 'http://localhost/#/search';
    state.updateHistoryPosition();

    assert.strictEqual(state.getScrollData(), null);
    assert.strictEqual(state.isNeedRestoreHistory, false);
});

test('reloading a page opened without a timestamp restores its own saved data', t => {
    const items = {};
    useSession(t, items);
    global.location.href = 'http://localhost/#/search';
    const before = new ScrollPositionState();
    before.updateHistoryPosition();
    before.saveScrollData({ page: 'search' });

    const after = new ScrollPositionState();
    after.updateHistoryPosition();

    assert.deepStrictEqual(after.getScrollData(), { page: 'search' });
    assert.strictEqual(after.isNeedRestoreHistory, true);
});
