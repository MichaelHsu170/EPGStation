require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RecordingUtilModel = require('../dist/model/operator/recording/RecordingUtilModel').default;

/**
 * RecordingUtilModel whose only recorded directory is <root>/recorded.
 */
const createModel = t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-path-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const recorded = path.join(root, 'recorded');
    fs.mkdirSync(recorded);

    const model = Object.create(RecordingUtilModel.prototype);
    model.log = { system: { info: () => {}, error: () => {}, fatal: () => {} } };
    model.config = {
        recorded: [{ name: 'recorded', path: recorded }],
        recordedFormat: 'name',
        recordedFileExtension: '.m2ts',
    };
    model.formatFilePathString = async str => str;

    return { model, root, recorded };
};

const reserve = directory => ({ parentDirectoryName: null, directory, recordedFormat: null });

test('a reservation directory below the recorded root is used', async t => {
    const { model, recorded } = createModel(t);

    const result = await model._getRecPath(reserve('sub/dir'), false);

    assert.strictEqual(result.fullPath, path.join(recorded, 'sub', 'dir', 'name.m2ts'));
    assert.strictEqual(fs.existsSync(path.join(recorded, 'sub', 'dir')), true);
});

test('a reservation directory that leaves the recorded root is rejected', async t => {
    const { model, root } = createModel(t);

    await assert.rejects(model._getRecPath(reserve('../outside'), false), /DirectoryIsOutsideParentDirectory/);
    assert.strictEqual(fs.existsSync(path.join(root, 'outside')), false);
});

test('program and channel names are put into file names literally, even with $& in them', async () => {
    const Reserve = require('../dist/db/entities/Reserve').default;
    const reserve = Object.assign(new Reserve(), {
        id: 3,
        name: 'Price $& more',
        halfWidthName: 'half $`',
        channelId: 1,
        channelType: 'GR',
        channel: '27',
        startAt: 0,
        isTimeSpecified: false,
    });
    const model = Object.create(RecordingUtilModel.prototype);
    model.log = { system: { warn: () => {} } };
    model.channelDB = { findId: async () => ({ name: 'Ch $1', halfWidthName: 'h', serviceId: 1, channelType: 'GR', channel: '27' }) };

    assert.strictEqual(
        await model.formatFilePathString('%TITLE%|%HALF_WIDTH_TITLE%|%CHNAME%', reserve),
        'Price $& more|half $`|Ch $1',
    );
});
