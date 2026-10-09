require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const RecordedApiModel = require('../dist/model/api/recorded/RecordedApiModel').default;

const createModel = recorded => {
    const calls = [];
    const model = new RecordedApiModel(
        { recorded: { delete: async id => calls.push(`delete ${id}`) } },
        { findId: async () => recorded },
        { cancelEncodeByRecordedId: async id => calls.push(`cancel encode ${id}`) },
        {},
    );

    return { model, calls };
};

test('deleting a protected recording is refused before its encode is cancelled', async () => {
    const { model, calls } = createModel({ id: 1, isProtected: true });

    await assert.rejects(model.delete(1), /RecordedIsProtected/);
    assert.deepStrictEqual(calls, []);
});

test('deleting an unprotected recording cancels its encode, then deletes it', async () => {
    const { model, calls } = createModel({ id: 1, isProtected: false });

    await model.delete(1);
    assert.deepStrictEqual(calls, ['cancel encode 1', 'delete 1']);
});
