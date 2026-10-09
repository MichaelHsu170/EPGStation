require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const EPGUpdater = require('../dist/model/epgUpdater/EPGUpdater').default;

test('an EPG update cycle does not start while the previous one is still running', async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });

    let running = 0;
    let maxRunning = 0;
    let started = 0;
    const releases = [];
    const updater = Object.create(EPGUpdater.prototype);
    Object.assign(updater, {
        log: { system: { info: () => {}, error: () => {} } },
        config: { epgUpdateIntervalTime: 10 },
        isEventStreamAlive: true,
        updateStartedAt: null,
        lastUpdatedTime: 0,
        lastDeletedTime: 0,
        updateManage: { checkTunerServerType: async () => 0, deleteOldPrograms: async () => {} },
        startEventStreamAnalysis: async () => {},
        // a save that takes longer than the 10 s interval
        updateMirakurunEventStream: async () => {
            started++;
            running++;
            maxRunning = Math.max(maxRunning, running);
            await new Promise(resolve => releases.push(resolve));
            running--;
        },
    });
    updater.updateMirakcEvent = updater.updateMirakurunEventStream;

    await updater.start();
    for (let i = 0; i < 3; i++) {
        t.mock.timers.tick(10 * 1000);
        await new Promise(setImmediate);
    }
    assert.strictEqual(started, 1);

    releases.shift()();
    await new Promise(setImmediate);
    t.mock.timers.tick(10 * 1000);
    await new Promise(setImmediate);
    assert.strictEqual(started, 2);
    assert.strictEqual(maxRunning, 1);
    releases.shift()();
});

test('an EPG update cycle that has not finished in 10 minutes no longer blocks the next one', async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });

    let started = 0;
    const releases = [];
    const errors = [];
    const updater = Object.create(EPGUpdater.prototype);
    Object.assign(updater, {
        log: { system: { info: () => {}, error: e => errors.push(String(e)) } },
        config: { epgUpdateIntervalTime: 10 },
        isEventStreamAlive: true,
        updateStartedAt: null,
        lastUpdatedTime: 0,
        lastDeletedTime: 0,
        updateManage: { checkTunerServerType: async () => 0, deleteOldPrograms: async () => {} },
        startEventStreamAnalysis: async () => {},
        // the first cycle hangs (e.g. a DB query that never returns)
        updateMirakurunEventStream: async () => {
            started++;
            await new Promise(resolve => releases.push(resolve));
        },
    });

    await updater.start();
    // ticks at 10 s .. 600 s: the first starts at 10 s, the cycle at 600 s is only 590 s later
    for (let i = 0; i < 60; i++) {
        t.mock.timers.tick(10 * 1000);
        await new Promise(setImmediate);
    }
    assert.strictEqual(started, 1);
    assert.deepStrictEqual(errors, []);

    // 610 s: 10 minutes after the hung cycle started
    t.mock.timers.tick(10 * 1000);
    await new Promise(setImmediate);
    assert.strictEqual(started, 2);
    assert.strictEqual(errors.length, 1);

    // the hung cycle finishing late does not let a third cycle overlap the second
    releases.shift()();
    await new Promise(setImmediate);
    t.mock.timers.tick(10 * 1000);
    await new Promise(setImmediate);
    assert.strictEqual(started, 2);
    releases.shift()();
});

test('the mirakc path waits for the full save before the cycle ends', async () => {
    let releaseSave;
    let saveFailed = null;
    const updater = Object.create(EPGUpdater.prototype);
    Object.assign(updater, {
        log: { system: { info: () => {}, error: () => {} } },
        lastUpdatedTime: 0,
        updateManage: {
            saveOnAirServices: async () => {},
            saveUpdateServices: () =>
                new Promise((resolve, reject) => {
                    releaseSave = () => reject(new Error('db down'));
                }),
        },
    });

    const cycle = updater.updateMirakcEvent(60 * 1000, 60 * 1000).catch(err => {
        saveFailed = err;
    });
    await new Promise(setImmediate);
    assert.strictEqual(saveFailed, null);

    releaseSave();
    await cycle;
    assert.match(String(saveFailed), /db down/);
});

/**
 * EPGUpdater built by its constructor (so the event stream handlers are wired) around an update manager whose
 * updateAll calls wait until released. Counts the full updates and how many ran at once.
 */
const setUpStreamUpdater = () => {
    const { EventEmitter } = require('events');
    const manage = new EventEmitter();
    const state = { calls: 0, running: 0, maxRunning: 0, releases: [] };
    Object.assign(manage, {
        checkTunerServerType: async () => 0,
        start: () => new Promise(() => {}), // the event stream stays connected
        updateAll: async () => {
            state.calls++;
            state.running++;
            state.maxRunning = Math.max(state.maxRunning, state.running);
            await new Promise(resolve => state.releases.push(resolve));
            state.running--;
        },
        saveProgram: async () => {},
        saveService: async () => {},
        deleteOldPrograms: async () => {},
    });
    const log = { system: { info: () => {}, error: () => {} } };
    const updater = new EPGUpdater({ getLogger: () => log }, { getConfig: () => ({ epgUpdateIntervalTime: 10 }) }, manage);

    return { manage, updater, state };
};

const advance = async (t, ms) => {
    for (let i = 0; i < ms / 1000; i++) {
        t.mock.timers.tick(1000);
        await new Promise(setImmediate);
    }
};

test('the full update when the event stream starts is not run again by the update cycle meanwhile', async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1790000000000 });
    const { manage, updater, state } = setUpStreamUpdater();

    await updater.start();
    manage.emit('event stream started');
    await advance(t, 30 * 1000);
    assert.strictEqual(state.calls, 1);

    state.releases.shift()();
    await advance(t, 30 * 1000);
    assert.strictEqual(state.calls, 1);
    assert.strictEqual(updater.isEventStreamAlive, true);
});

test('when the event stream starts during a full update of the update cycle, its own full update waits for it', async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1790000000000 });
    const { manage, updater, state } = setUpStreamUpdater();

    await updater.start();
    await advance(t, 10 * 1000); // the cycle at 10 s starts a full update (no event stream yet)
    assert.strictEqual(state.calls, 1);
    manage.emit('event stream started');
    await advance(t, 30 * 1000);
    assert.strictEqual(state.calls, 1);

    state.releases.shift()();
    await advance(t, 2 * 1000);
    assert.strictEqual(state.calls, 2);
    assert.strictEqual(state.maxRunning, 1);
    state.releases.shift()();
    await advance(t, 1000);
    assert.strictEqual(updater.isEventStreamAlive, true);
});
