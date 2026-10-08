require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
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
