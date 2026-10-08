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

const states = [
    ['live', api => Object.assign(Object.create(LiveHLSVideoState.prototype), { streamApiModel: api, streamId: null }), s => s.start(1, 0)],
    [
        'recorded',
        api => Object.assign(Object.create(RecordedHLSStreamingVideoState.prototype), { streamApiModel: api, streamId: null, isStarting: false }),
        s => s.start(1, 0, 0),
    ],
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
}
