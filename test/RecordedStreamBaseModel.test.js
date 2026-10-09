require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const RecordedStreamModel = require('../dist/model/service/stream/RecordedStreamModel').default;

test('stopping a recorded ts stream whose process has unread input does not throw EPIPE out of the process', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recstream-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'rec.m2ts');
    fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 0x47));

    const errors = [];
    const onUncaught = err => errors.push(err);
    process.on('uncaughtException', onUncaught);
    t.after(() => process.removeListener('uncaughtException', onUncaught));

    const log = { info: () => {}, debug: () => {}, error: () => {} };
    // a process that does not read its stdin, as ffmpeg busy encoding
    const child = spawn('/bin/sleep', ['30']);
    t.after(() => child.kill('SIGKILL'));
    const model = new RecordedStreamModel(
        { getConfig: () => ({}) },
        { getLogger: () => ({ stream: log }) },
        { create: async () => child },
        {},
        {},
        {},
        {},
        {},
    );
    model.setOption({ playPosition: 0 }, 0);
    model.setVideFileInfo = async function () {
        this.videoFilePath = file;
        this.videoFileInfo = { duration: 100, bitRate: 0 };
        this.videoFileType = 'ts';
        this.isRecording = false;
    };
    model.createProcessOption = async () => ({ cmd: '/bin/sleep 30' });

    await model.start(0);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(child.stdin.writableLength > 0); // writes are queued when the stream stops
    await model.stop();
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => setTimeout(resolve, 200));

    assert.deepStrictEqual(
        errors.map(e => e.code),
        [],
    );
});
