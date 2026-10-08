require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const EncoderModel = require('../dist/model/service/encode/EncoderModel').default;

const createModel = () => {
    const model = Object.create(EncoderModel.prototype);
    model.log = { encode: { error: () => {} } };
    model.videoUtil = { getParentDirPath: () => '/rec' };
    model.recordedDB = { findId: async () => null };

    return model;
};

test('the encode output directory defaults to the parent directory', async () => {
    assert.strictEqual(await createModel().getDirPath({ parentDir: 'recorded', recordedId: 1 }), '/rec');
});

test('an encode output directory below the parent directory is used', async () => {
    const dir = await createModel().getDirPath({ parentDir: 'recorded', recordedId: 1, directory: 'encoded' });

    assert.strictEqual(dir, '/rec/encoded');
});

test('an encode output directory that leaves the parent directory is rejected', async () => {
    await assert.rejects(
        createModel().getDirPath({ parentDir: 'recorded', recordedId: 1, directory: '../../etc' }),
        /DirectoryIsOutsideParentDirectory/,
    );
});
