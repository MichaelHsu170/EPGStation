require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const RecordingStreamCreator = require('../dist/model/operator/recording/RecordingStreamCreator').default;

test('each recording stream request carries its own priority', async () => {
    const requests = [];
    const client = {
        priority: 0,
        getProgramStream: async opt => {
            // the real client awaits before it reads the priority, so another recording can run here
            await new Promise(setImmediate);
            requests.push({ id: opt.id, priority: typeof opt.priority === 'undefined' ? client.priority : opt.priority });

            return {};
        },
    };
    const creator = Object.create(RecordingStreamCreator.prototype);
    creator.config = { recPriority: 2, conflictPriority: 1 };
    creator.mirakurunClientModel = { getClient: () => client };

    await Promise.all([
        creator.getStream({ programId: 10, isConflict: false }),
        creator.getStream({ programId: 20, isConflict: true }),
    ]);

    assert.deepStrictEqual(
        requests.sort((a, b) => a.id - b.id),
        [
            { id: 10, priority: 2 },
            { id: 20, priority: 1 },
        ],
    );
});

const { PassThrough } = require('stream');
const silentLog = { system: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } };

const timeSpecifiedCreator = (stream, tuners) => {
    const creator = Object.create(RecordingStreamCreator.prototype);
    Object.assign(creator, {
        log: silentLog,
        config: { recPriority: 2, conflictPriority: 1, timeSpecifiedStartMargin: 0, timeSpecifiedEndMargin: 0 },
        tuners,
        timerIndex: {},
        timeSpecifiedStreams: {},
        mirakurunClientModel: { getClient: () => ({ getServiceStream: async () => stream }) },
    });

    return creator;
};
const timeSpecifiedReserve = (endIn, isConflict) => {
    const now = Date.now();

    return { id: 1, programId: null, isConflict, channelType: 'GR', channel: '27', channelId: 1, startAt: now, endAt: now + endIn, allowEndLack: true };
};

for (const [name, isConflict, tuners] of [
    ['with a tuner slot', false, [{ types: ['GR'], programs: [] }]],
    ['flagged as a conflict', true, [{ types: ['GR'], programs: [] }]],
    ['with no tuner slot left', false, []],
]) {
    test(`a time-specified recording ${name} stops at its end time`, async () => {
        const stream = new PassThrough();
        stream.resume();
        const creator = timeSpecifiedCreator(stream, tuners);
        await creator.create(timeSpecifiedReserve(100, isConflict));
        assert.strictEqual(stream.destroyed, false);
        await new Promise(r => setTimeout(r, 400));
        assert.strictEqual(stream.destroyed, true);
        assert.deepStrictEqual(creator.timeSpecifiedStreams, {});
    });
}

test('changing a time-specified recording end time cancels the old end timer', async () => {
    const stream = new PassThrough();
    stream.resume();
    const creator = timeSpecifiedCreator(stream, [{ types: ['GR'], programs: [] }]);
    const reserve = timeSpecifiedReserve(100, false);
    await creator.create(reserve);
    creator.changeEndAt({ ...reserve, endAt: Date.now() + 600 });
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(stream.destroyed, false);
    await new Promise(r => setTimeout(r, 600));
    assert.strictEqual(stream.destroyed, true);
});
