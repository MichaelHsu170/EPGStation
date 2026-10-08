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
        config: { thumbnail: dir, thumbnailCmd: '%FFMPEG% %INPUT% %OUTPUT%', ffmpeg, thumbnailPosition: 5, thumbnailSize: '480x270' },
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
