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
