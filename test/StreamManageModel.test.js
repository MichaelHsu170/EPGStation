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

const ExecutionManagementModel = require('../dist/model/ExecutionManagementModel').default;
const StreamBaseModel = require('../dist/model/service/stream/base/StreamBaseModel').default;

const silentLog = { info: () => {}, error: () => {} };
const settle = async () => {
    for (let i = 0; i < 20; i++) {
        await new Promise(setImmediate);
    }
};

/**
 * A stream on StreamBaseModel's real exit event: like the recorded and live stream models, stop() emits the exit
 * event (which the manager's exit callback handles), and the process's exit emits it too.
 */
class FakeStream extends StreamBaseModel {
    constructor(name) {
        super({ getConfig: () => ({}) }, { getLogger: () => ({ stream: silentLog }) }, {}, {}, {});
        this.name = name;
        this.stopCount = 0;
    }

    async start() {}

    async stop() {
        this.stopCount++;
        await super.stop();
    }

    exitProcess() {
        this.emitExitStream();
    }

    getStream() {}

    getInfo() {
        return { name: this.name };
    }

    getStreamType() {
        return 'RecordedStreaming';
    }
}

const createManager = () => {
    const execution = new ExecutionManagementModel({ getLogger: () => ({ system: silentLog }) });
    const manager = new StreamManageModel({ getLogger: () => ({ stream: silentLog }) }, execution, {
        notifyClient: () => {},
    });

    return { execution, manager };
};

const runningStreams = manager => manager.getStreamInfos().map(s => [s.streamId, s.info.name]);

test('a stream that starts while an earlier stream with the same id is being stopped keeps running', async () => {
    const { execution, manager } = createManager();
    const oldStream = new FakeStream('old');
    assert.strictEqual(await manager.start(oldStream), 0);

    // another stream operation holds the lock while a seek closes the old stream's request (forced stop) and
    // requests the new stream
    const held = await execution.getExecution(1);
    const stopped = manager.stop(0, true);
    const newStream = new FakeStream('new');
    const started = manager.start(newStream);
    execution.unLockExecution(held);
    await stopped;
    assert.strictEqual(await started, 0);
    await settle();

    assert.deepStrictEqual(runningStreams(manager), [[0, 'new']]);
    assert.strictEqual(newStream.stopCount, 0);
    assert.strictEqual(oldStream.stopCount, 1);
});

test('a stream whose process exits is stopped once and its id is freed', async () => {
    const { manager } = createManager();
    const stream = new FakeStream('a');
    assert.strictEqual(await manager.start(stream), 0);

    stream.exitProcess();
    await settle();

    assert.deepStrictEqual(runningStreams(manager), []);
    assert.strictEqual(stream.stopCount, 1);
    assert.strictEqual(await manager.start(new FakeStream('b')), 0);
});

test('a stream stopped through the stop API is stopped once and its id is freed', async () => {
    const { manager } = createManager();
    const stream = new FakeStream('a');
    await manager.start(stream);
    await manager.start(new FakeStream('b'));

    await manager.stop(0);
    await settle();

    assert.deepStrictEqual(runningStreams(manager), [[1, 'b']]);
    assert.strictEqual(stream.stopCount, 1);
});

test('a stream that fails to start is stopped and its id is freed', async () => {
    const { manager } = createManager();
    const stream = new FakeStream('a');
    stream.start = async () => Promise.reject(new Error('CreateStreamProcessError'));

    await assert.rejects(manager.start(stream), /CreateStreamProcessError/);
    await settle();

    assert.deepStrictEqual(runningStreams(manager), []);
    assert.strictEqual(stream.stopCount, 1);
});

test('stopAll stops every stream once', async () => {
    const { manager } = createManager();
    const streams = [new FakeStream('a'), new FakeStream('b')];
    for (const s of streams) {
        await manager.start(s);
    }

    await manager.stopAll();
    await settle();

    assert.deepStrictEqual(runningStreams(manager), []);
    assert.deepStrictEqual(
        streams.map(s => s.stopCount),
        [1, 1],
    );
});
