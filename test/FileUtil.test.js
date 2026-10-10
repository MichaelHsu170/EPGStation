require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileUtil = require('../dist/util/FileUtil').default;

test('isInsideDir accepts the directory itself and paths below it', () => {
    assert.strictEqual(FileUtil.isInsideDir('/rec', '/rec'), true);
    assert.strictEqual(FileUtil.isInsideDir('/rec', '/rec/a/b.ts'), true);
    assert.strictEqual(FileUtil.isInsideDir('/rec', '/rec/..name'), true);
});

test('isInsideDir rejects paths outside the directory', () => {
    assert.strictEqual(FileUtil.isInsideDir('/rec', '/'), false);
    assert.strictEqual(FileUtil.isInsideDir('/rec', '/etc/passwd'), false);
    assert.strictEqual(FileUtil.isInsideDir('/rec', '/rec2/a.ts'), false);
});

test('isRecentlyModified is true within 10 minutes of the last write and false after', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileutil-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'a');
    fs.writeFileSync(file, 'a');

    assert.strictEqual(await FileUtil.isRecentlyModified(file), true);
    const nineMinutesAgo = new Date(Date.now() - 9 * 60 * 1000);
    fs.utimesSync(file, nineMinutesAgo, nineMinutesAgo);
    assert.strictEqual(await FileUtil.isRecentlyModified(file), true);
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(file, elevenMinutesAgo, elevenMinutesAgo);
    assert.strictEqual(await FileUtil.isRecentlyModified(file), false);
});

test('isRecentlyModified is false for a file that does not exist', async () => {
    assert.strictEqual(await FileUtil.isRecentlyModified('/nonexistent/epgstation-test'), false);
});
