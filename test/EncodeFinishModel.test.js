require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EncodeFinishModel = require('../dist/model/service/encode/EncodeFinishModel').default;

/**
 * Runs finishEncode for an encode whose source is video file 10 with "remove original" on,
 * where addVideoFile answers addedVideoFileId. Returns the ids passed to deleteVideoFile.
 */
const finishEncode = async addedVideoFileId => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-finish-'));
    const output = path.join(dir, 'out.mkv');
    fs.writeFileSync(output, 'encoded');

    const deleted = [];
    const model = Object.create(EncodeFinishModel.prototype);
    model.log = { encode: { info: () => {}, error: () => {} } };
    model.socket = { notifyClient: () => {} };
    model.promiseRetry = { run: fn => fn() };
    model.ipc = {
        recorded: {
            addVideoFile: async () => addedVideoFileId,
            deleteVideoFile: async id => {
                deleted.push(id);
            },
        },
        encodeEvent: { emitFinishEncode: async () => {} },
    };

    try {
        await model.finishEncode({
            recordedId: 1,
            videoFileId: 10,
            parentDirName: 'recorded',
            filePath: 'out.mkv',
            fullOutputPath: output,
            mode: 'H.264',
            removeOriginal: true,
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    return deleted;
};

test('remove original deletes the source when the encode was added as a new video file', async () => {
    assert.deepStrictEqual(await finishEncode(11), [10]);
});

test('remove original keeps the file when the encode replaced the source video file in place', async () => {
    assert.deepStrictEqual(await finishEncode(10), []);
});
