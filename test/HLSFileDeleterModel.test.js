require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileUtil = require('../dist/util/FileUtil').default;
const HLSFileDeleterModel = require('../dist/model/service/stream/util/HLSFileDeleterModel').default;

test('deleting the HLS files goes on when ffmpeg already removed one of them', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const file of ['stream1.m3u8', 'stream1-1.ts', 'stream1-2.ts']) {
        fs.writeFileSync(path.join(dir, file), '');
    }
    // the listing still has a segment that ffmpeg deletes before EPGStation gets to it
    const originalReadDir = FileUtil.readDir;
    FileUtil.readDir = async dirPath => ['stream1-0.ts', ...(await originalReadDir(dirPath))];
    t.after(() => {
        FileUtil.readDir = originalReadDir;
    });

    const deleter = new HLSFileDeleterModel({ getLogger: () => ({ stream: { info: () => {}, error: () => {} } }) });
    deleter.setOption({ streamId: 1, streamFilePath: dir });
    await deleter.deleteAllFiles();

    assert.deepStrictEqual(fs.readdirSync(dir), []);
});
