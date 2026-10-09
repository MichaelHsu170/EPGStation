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

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

/**
 * Starts an encode whose process is a fake child; returns the child, the encode-log lines by level and the finish.
 */
const startEncode = async t => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encoder-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const input = path.join(dir, 'in.m2ts');
    fs.writeFileSync(input, '');

    const child = new EventEmitter();
    Object.assign(child, { stderr: new PassThrough(), stdout: null, exitCode: null, signalCode: null });
    const logs = { info: [], error: [] };
    const model = Object.create(EncoderModel.prototype);
    Object.assign(model, {
        log: { encode: { info: l => logs.info.push(String(l)), error: l => logs.error.push(String(l)), debug: () => {} } },
        listener: new EventEmitter(),
        encodeOption: null,
        childProcess: null,
        timerId: null,
        isCanceld: false,
        stderrTail: [],
        configure: { getConfig: () => ({ encode: [{ name: 'H264', cmd: 'enc' }] }) },
        videoFileDB: { findId: async () => ({}) },
        recordedDB: { findId: async () => ({ id: 1, channelId: 2, name: 'n', halfWidthName: 'n', startAt: 0, endAt: 1, duration: 60000 }) },
        channelDB: { findId: async () => ({}) },
        videoUtil: { getFullFilePathFromId: async () => input },
        processManager: { create: async () => child },
    });
    model.setOption({ encodeId: 3, recordedId: 1, sourceVideoFileId: 1, parentDir: 'recorded', mode: 'H264' });
    const finished = new Promise(resolve => model.setOnFinish(isError => resolve(isError)));
    await model.start();
    t.after(() => clearTimeout(model.timerId));

    return { child, logs, finished };
};

test('a failed encode logs the last 5 lines its process wrote to stderr', async t => {
    const { child, logs, finished } = await startEncode(t);

    child.stderr.write('line 1\nline 2\n\nline 3\n');
    child.stderr.write('line 4\n   \nline 5\nline 6\n');
    await new Promise(setImmediate);
    child.emit('exit', 1, null);

    assert.strictEqual(await finished, true);
    assert.deepStrictEqual(logs.error, ['encode failed: 3 null', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6']);
});

test('a successful encode does not log its stderr as errors', async t => {
    const { child, logs, finished } = await startEncode(t);

    child.stderr.write('frame=1\n');
    await new Promise(setImmediate);
    child.emit('exit', 0, null);

    assert.strictEqual(await finished, false);
    assert.deepStrictEqual(logs.error, []);
});
