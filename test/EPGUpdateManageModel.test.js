require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const EPGUpdateManageModel = require('../dist/model/epgUpdater/EPGUpdateManageModel').default;
const { EPGUpdateEvent } = require('../dist/model/epgUpdater/IEPGUpdateManageModel');

const createModel = (members, errors = []) => {
    const model = new EPGUpdateManageModel(
        { getLogger: () => ({ system: { info: () => {}, debug: () => {}, error: e => errors.push(String(e)) } }) },
        { getConfig: () => ({ mirakurunPath: 'http://localhost' }) },
        { getClient: () => ({}) },
        {},
        {},
    );

    return Object.assign(model, members);
};

for (const [name, finish, message] of [
    ['ends', s => s.end(), /EndedEventStream/],
    ['closes', s => s.destroy(), /ClosedEventStream/],
]) {
    test(`an event stream that ${name} is reported as disconnected`, async () => {
        const stream = new PassThrough();
        const model = createModel({ mirakurunClient: { getEventsStream: async () => stream } });
        const events = [];
        model.on(EPGUpdateEvent.STREAM_STARTED, () => events.push('started'));
        model.on(EPGUpdateEvent.STREAM_ABORTED, () => events.push('aborted'));

        const analysis = model.startAnalayzingMirakurunEvents();
        await new Promise(setImmediate);
        stream.resume();
        finish(stream);

        await assert.rejects(analysis, message);
        assert.deepStrictEqual(events, ['started', 'aborted']);
    });
}

test('a failure to open the event stream is passed on as it is', async () => {
    const errors = [];
    const model = createModel({ mirakurunClient: { getEventsStream: async () => Promise.reject(new Error('ECONNREFUSED')) } }, errors);

    await assert.rejects(model.startAnalayzingMirakurunEvents(), /ECONNREFUSED/);
    assert.deepStrictEqual(errors, ['event stream get error', 'Error: ECONNREFUSED']);
});

test('a full update that runs past its timeout logs it without throwing from the timer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const errors = [];
    let releasePrograms;
    const model = createModel(
        {
            updateChannels: async () => {},
            mirakurunClient: { getPrograms: () => new Promise(resolve => (releasePrograms = () => resolve([]))) },
            programDB: { insert: async () => {} },
        },
        errors,
    );

    const update = model.updateAll();
    await new Promise(setImmediate);
    assert.doesNotThrow(() => t.mock.timers.tick(10 * 60 * 1000));
    assert.deepStrictEqual(errors, ['update all timeout']);

    releasePrograms();
    await update;
});
