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
