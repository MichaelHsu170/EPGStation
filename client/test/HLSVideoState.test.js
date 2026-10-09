require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const LiveHLSVideoState = require('../test-build/model/state/onair/LiveHLSVideoState').default;
const RecordedHLSStreamingVideoState = require('../test-build/model/state/recorded/streaming/RecordedHLSStreamingVideoState').default;

/**
 * A stream API whose start resolves only when release() is called.
 */
const createStreamApi = () => {
    const api = { stopped: [], kept: [], release: null };
    const start = () => new Promise(resolve => (api.release = () => resolve(42)));
    api.startLiveHLS = start;
    api.startRecordedHLS = start;
    api.stop = async id => api.stopped.push(id);
    api.keep = async id => api.kept.push(id);

    return api;
};

const createRecorded = api => Object.assign(Object.create(RecordedHLSStreamingVideoState.prototype), { streamApiModel: api, streamId: null, startingPromise: null });

const states = [
    ['live', api => Object.assign(Object.create(LiveHLSVideoState.prototype), { streamApiModel: api, streamId: null }), s => s.start(1, 0)],
    ['recorded', createRecorded, s => s.start(1, 0, 0)],
];

for (const [name, create, start] of states) {
    test(`${name} HLS: leaving the page while the stream is starting stops it and keeps nothing alive`, { timeout: 5000 }, async t => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
        const api = createStreamApi();
        const state = create(api);

        const starting = start(state);
        await state.stop(); // the page is left before the server answered
        api.release();
        await starting;

        assert.deepStrictEqual(api.stopped, [42]);
        assert.strictEqual(state.getStreamId(), null);
        t.mock.timers.tick(60 * 1000);
        assert.deepStrictEqual(api.kept, []);
    });

    test(`${name} HLS: a started stream is kept alive until it is stopped`, { timeout: 5000 }, async t => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
        const api = createStreamApi();
        const state = create(api);

        const starting = start(state);
        api.release();
        await new Promise(setImmediate);
        t.mock.timers.tick(1000); // the recorded state waits 1 s after starting
        await starting;
        t.mock.timers.tick(10 * 1000);
        await new Promise(setImmediate);
        assert.deepStrictEqual(api.kept, [42]);

        await state.stop();
        assert.deepStrictEqual(api.stopped, [42]);
    });

    test(`${name} HLS: a failed keep-alive is logged, not left as an unhandled rejection`, { timeout: 5000 }, async t => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
        const api = createStreamApi();
        api.keep = async () => {
            throw new Error('KeepFailed');
        };
        const errors = t.mock.method(console, 'error', () => {});
        const unhandled = [];
        const onUnhandled = err => unhandled.push(err);
        process.on('unhandledRejection', onUnhandled);
        t.after(() => process.off('unhandledRejection', onUnhandled));
        const state = create(api);

        const starting = start(state);
        api.release();
        await new Promise(setImmediate);
        t.mock.timers.tick(1000);
        await starting;
        t.mock.timers.tick(10 * 1000);
        await new Promise(setImmediate);
        await new Promise(setImmediate);

        assert.deepStrictEqual(unhandled, []);
        assert.strictEqual(errors.mock.calls.length, 1);
        assert.strictEqual(errors.mock.calls[0].arguments[0].message, 'KeepFailed');
        await state.stop();
    });
}

/**
 * A recorded stream API whose n-th start (from 1) answers stream id 42 + n when releases[n - 1]() is called.
 */
const createSeekStreamApi = () => {
    const api = { stopped: [], kept: [], positions: [], releases: [] };
    api.startRecordedHLS = (videoFileId, playPosition) => {
        api.positions.push(playPosition);
        const streamId = 42 + api.positions.length;

        return new Promise(resolve => api.releases.push(() => resolve(streamId)));
    };
    api.stop = async id => api.stopped.push(id);
    api.keep = async id => api.kept.push(id);

    return api;
};

const settle = async () => {
    for (let i = 0; i < 10; i++) {
        await new Promise(setImmediate);
    }
};

/**
 * Seeks as RecordedHLSStreamingVideo.setCurrentTime does: stop, then start at the new position.
 */
const seek = async (state, playPosition) => {
    await state.stop();

    return state.start(1, playPosition, 0);
};

/**
 * Answers the n-th start and lets that start finish (it waits 1 s after the server answered).
 */
const answerStart = async (t, api, n) => {
    api.releases[n - 1]();
    await settle();
    t.mock.timers.tick(1000);
    await settle();
};

test('recorded HLS: a seek made while the previous seek is starting starts the new position and stops the old stream', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const api = createSeekStreamApi();
    const state = createRecorded(api);

    const seek1 = seek(state, 100);
    await settle();
    const seek2 = seek(state, 200);
    await settle();
    assert.deepStrictEqual(api.positions, [100]); // seek 2 waits for seek 1's start

    await answerStart(t, api, 1);
    await seek1;
    assert.deepStrictEqual(api.positions, [100, 200]);
    assert.deepStrictEqual(api.stopped, [43]);

    await answerStart(t, api, 2);
    await seek2;
    assert.strictEqual(state.getStreamId(), 44);
    t.mock.timers.tick(10 * 1000);
    await settle();
    assert.deepStrictEqual(api.kept, [44]);
});

test('recorded HLS: with three overlapping seeks only the last position is left streaming', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const api = createSeekStreamApi();
    const state = createRecorded(api);

    const seeks = [seek(state, 100)];
    await settle();
    seeks.push(seek(state, 200));
    seeks.push(seek(state, 300));
    await settle();

    await answerStart(t, api, 1);
    await answerStart(t, api, 2);
    await answerStart(t, api, 3);
    await Promise.all(seeks);

    assert.deepStrictEqual(api.positions, [100, 200, 300]);
    assert.deepStrictEqual(api.stopped, [43, 44]);
    assert.strictEqual(state.getStreamId(), 45);
    t.mock.timers.tick(10 * 1000);
    await settle();
    assert.deepStrictEqual(api.kept, [45]);
});

test('recorded HLS: leaving the page while a seek waits for the previous start leaves no stream', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const api = createSeekStreamApi();
    const state = createRecorded(api);

    const seek1 = seek(state, 100);
    await settle();
    const seek2 = seek(state, 200);
    await settle();
    await state.stop(); // the page is left
    api.releases[0]();
    await seek1;
    await seek2;

    assert.deepStrictEqual(api.positions, [100]);
    assert.deepStrictEqual(api.stopped, [43]);
    assert.strictEqual(state.getStreamId(), null);
    t.mock.timers.tick(60 * 1000);
    await settle();
    assert.deepStrictEqual(api.kept, []);
});

test('recorded HLS: a seek after a failed start still starts', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const api = createSeekStreamApi();
    const failing = api.startRecordedHLS;
    let isFirst = true;
    api.startRecordedHLS = (videoFileId, playPosition) => {
        const started = failing(videoFileId, playPosition);
        if (isFirst === false) {
            return started;
        }
        isFirst = false;

        return started.then(() => {
            throw new Error('StartFailed');
        });
    };
    const state = createRecorded(api);

    const seek1 = seek(state, 100);
    await settle();
    const seek2 = seek(state, 200);
    await settle();
    api.releases[0]();
    await assert.rejects(seek1, /StartFailed/);
    await answerStart(t, api, 2);
    await seek2;

    assert.deepStrictEqual(api.positions, [100, 200]);
    assert.strictEqual(state.getStreamId(), 44);
});
