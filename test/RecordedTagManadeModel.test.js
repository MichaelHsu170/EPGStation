require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const RecordedTagManadeModel = require('../dist/model/operator/recordedTag/RecordedTagManadeModel').default;

test('a failed tag delete reports the database error', async () => {
    const errors = [];
    const model = Object.create(RecordedTagManadeModel.prototype);
    model.log = { system: { info: () => {}, error: e => errors.push(e) } };
    model.recordedTagDB = { deleteOnce: async () => Promise.reject(new Error('db down')) };

    await assert.rejects(model.delete(3), /db down/);
    assert.deepStrictEqual(errors, ['delete tag error: 3']);
});
