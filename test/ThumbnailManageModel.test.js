require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ThumbnailManageModel = require('../dist/model/operator/thumbnail/ThumbnailManageModel').default;

/**
 * ThumbnailManageModel whose "ffmpeg" is the shell script ffmpegScript; the video file path is videoPath.
 */
const createModel = (t, ffmpegScript, videoPath) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ffmpeg = path.join(dir, 'ffmpeg');
    fs.writeFileSync(ffmpeg, `#!/bin/sh\n${ffmpegScript}\n`, { mode: 0o755 });

    const model = Object.create(ThumbnailManageModel.prototype);
    Object.assign(model, {
        log: { system: { info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, debug: () => {} } },
        config: {
            thumbnail: dir,
            thumbnailCmd: '%FFMPEG% %INPUT% %OUTPUT%',
            ffmpeg,
            thumbnailPosition: 5,
            thumbnailSize: '480x270',
        },
        videoFileDB: { findId: async () => ({ recordedId: 1 }) },
        videoUtil: { getFullFilePathFromId: async () => videoPath },
        thumbnailDB: { insertOnce: async () => 1 },
        thumbnailEvent: { emitAdded: () => {} },
        getSaveFileName: async () => 'thumb.jpg',
    });

    return { model, dir };
};

test('a thumbnail ffmpeg that never exits is stopped and the next thumbnail can run', { timeout: 10000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { model } = createModel(t, 'exec sleep 1000', '/rec/a.m2ts');

    const creating = model.create(1);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(10 * 60 * 1000);

    await assert.rejects(creating, /CreateThumbnailExitError/);
});

test('the video path is passed to the thumbnail command literally, even with $& in it', async t => {
    const out = path.join(os.tmpdir(), `thumb-args-${process.pid}`);
    t.after(() => fs.rmSync(out, { force: true }));
    const { model } = createModel(t, `printf '%s' "$1" > '${out}'`, '/rec/Price $& more.m2ts');

    await model.create(1);

    assert.strictEqual(fs.readFileSync(out, 'utf8'), '/rec/Price $& more.m2ts');
});

test('a failed thumbnail command leaves no partial file behind', async t => {
    // the command writes part of the image, then fails (as ffmpeg killed by the timeout does)
    const { model, dir } = createModel(t, 'printf partial > "$2"; exit 1', '/rec/a.m2ts');

    await assert.rejects(model.create(1), /CreateThumbnailExitError/);

    assert.deepStrictEqual(fs.readdirSync(dir), ['ffmpeg']);
});

test('thumbnail cleanup keeps a thumbnail written in the last minutes, such as one still being created', async t => {
    const { model, dir } = createModel(t, 'exit 0', '/rec/a.m2ts');
    model.thumbnailDB = { findAll: async () => [] };
    fs.rmSync(path.join(dir, 'ffmpeg'));
    fs.writeFileSync(path.join(dir, '1.jpg'), 'old orphan');
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, '1.jpg'), hourAgo, hourAgo);
    fs.writeFileSync(path.join(dir, '2.jpg'), 'being created'); // DB 登録前

    await model.fileCleanup();

    assert.deepStrictEqual(fs.readdirSync(dir), ['2.jpg']);
});
