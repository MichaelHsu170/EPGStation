require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const StreamManageModel = require('../dist/model/service/stream/manager/StreamManageModel').default;

test('a stream that fails to stop after its process exits is logged, not left as an unhandled rejection', async () => {
    const errors = [];
    const manager = new StreamManageModel(
        { getLogger: () => ({ stream: { info: () => {}, error: e => errors.push(String(e)) } }) },
        { getExecution: async () => 1, unLockExecution: () => {} },
        { notifyClient: () => {} },
    );
    let onExit = null;
    await manager.start({
        start: async () => {},
        setExitStream: cb => (onExit = cb),
        stop: async () => Promise.reject(new Error('ENOENT: hls segment')),
    });

    const unhandled = [];
    const onUnhandled = err => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
        await onExit();
        await new Promise(setImmediate);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }

    assert.deepStrictEqual(unhandled, []);
    assert.ok(errors.some(e => e.includes('ENOENT: hls segment')), errors.join('\n'));
});
