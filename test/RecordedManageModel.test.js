require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RecordedManageModel = require('../dist/model/operator/recorded/RecordedManageModel').default;

/**
 * RecordedManageModel over two temporary recorded directories, A and B. existingEncoded is
 * what findEncodedByRecordedIdAndName returns.
 */
const createModel = (t, existingEncoded = []) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-manage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dirs = { A: path.join(root, 'A'), B: path.join(root, 'B') };
    fs.mkdirSync(dirs.A);
    fs.mkdirSync(dirs.B);

    const model = Object.create(RecordedManageModel.prototype);
    model.log = { system: { info: () => {}, error: () => {} } };
    model.recordedDB = { findId: async () => ({ thumbnails: [1] }) };
    model.recordingUtilModel = { formatFilePathString: async str => str };
    model.recordedEvent = {
        emitAddVideoFile: () => {},
        emitUpdateVideoFileSize: () => {},
        emitAddUploadedVideoFile: () => {},
    };
    model.videoUtil = {
        getParentDirPath: name => dirs[name] ?? null,
        getFullFilePathFromVideoFile: v => (dirs[v.parentDirectoryName] ? path.join(dirs[v.parentDirectoryName], v.filePath) : null),
    };
    model.inserted = [];
    model.videoFileDB = {
        findByRecordedIdAndFilePath: async () => null,
        findEncodedByRecordedIdAndName: async () => existingEncoded,
        updateSize: async () => {},
        deleteOnce: async () => {},
        insertOnce: async videoFile => {
            model.inserted.push(videoFile);

            return 100;
        },
    };

    return { model, root, dirs };
};

test('a re-encode replaces the old encoded file in its own directory and keeps its id', async t => {
    const old = { id: 7, parentDirectoryName: 'B', filePath: 'old.mkv' };
    const { model, dirs } = createModel(t, [old]);
    fs.writeFileSync(path.join(dirs.B, 'old.mkv'), 'old encode');
    fs.writeFileSync(path.join(dirs.A, 'new.mkv'), 'new encode');
    fs.writeFileSync(path.join(dirs.A, 'old.mkv'), 'unrelated file');

    const id = await model.addVideoFile({
        recordedId: 1,
        parentDirectoryName: 'A',
        filePath: 'new.mkv',
        type: 'encoded',
        name: 'H.264',
    });

    assert.strictEqual(id, 7);
    assert.strictEqual(fs.readFileSync(path.join(dirs.B, 'old.mkv'), 'utf8'), 'new encode');
    assert.strictEqual(fs.existsSync(path.join(dirs.A, 'new.mkv')), false);
    assert.strictEqual(fs.readFileSync(path.join(dirs.A, 'old.mkv'), 'utf8'), 'unrelated file');
});
