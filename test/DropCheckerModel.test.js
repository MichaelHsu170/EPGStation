require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const DropCheckerModel = require('../dist/model/operator/recording/DropCheckerModel').default;

test('a burst of drops is logged in order through one open file', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-check-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let appendFileCalls = 0;
    const originalAppendFile = fs.appendFile;
    fs.appendFile = (...args) => {
        appendFileCalls++;
        return originalAppendFile(...args);
    };
    t.after(() => {
        fs.appendFile = originalAppendFile;
    });

    const silent = { system: { info() {}, warn() {}, error() {}, fatal() {}, debug() {} } };
    const checker = new DropCheckerModel({ getLogger: () => silent });
    await checker.start(dir, path.join(dir, 'rec.m2ts'), new PassThrough());

    // what a reception dropout looks like: many drop events at once
    for (let i = 1; i <= 1000; i++) {
        checker.tsPacketAnalyzer.emit('packetDrop', 0x100, i, i - 1);
    }
    await checker.stop();

    const lines = fs.readFileSync(checker.getFilePath(), 'utf8').split('\n').filter(l => l.startsWith('drop'));
    assert.strictEqual(lines.length, 1000);
    assert.deepStrictEqual(
        lines.map(l => Number(/counter: (\d+)/.exec(l)[1])),
        [...Array(1000).keys()].map(i => i + 1),
    );
    assert.strictEqual(appendFileCalls, 0);
});

test('stopping twice at once still writes the whole summary', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-check-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const silent = { system: { info() {}, warn() {}, error() {}, fatal() {}, debug() {} } };
    const checker = new DropCheckerModel({ getLogger: () => silent });
    const source = new PassThrough();
    await checker.start(dir, path.join(dir, 'rec.m2ts'), source);
    // packets on several PIDs, so the summary has several lines
    for (const pid of [0x0, 0x100, 0x111, 0x112]) {
        const packet = Buffer.alloc(188);
        packet[0] = 0x47;
        packet[1] = (pid >> 8) & 0x1f;
        packet[2] = pid & 0xff;
        packet[3] = 0x10;
        source.write(packet);
    }
    await new Promise(resolve => setTimeout(resolve, 100));

    // the recorder's stop() and the stream's own end/error both finish the check
    await Promise.all([checker.stop(), checker.stop()]);

    const summary = fs.readFileSync(checker.getFilePath(), 'utf8').split('\n').filter(l => l.startsWith('pid'));
    assert.strictEqual(summary.length, 4);
});

test('a retried recording on the same checker gets its own summary and result', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-check-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const silent = { system: { info() {}, warn() {}, error() {}, fatal() {}, debug() {} } };
    const checker = new DropCheckerModel({ getLogger: () => silent });

    // first attempt: a drop, then the recorder gives up (no data within the start timeout)
    await checker.start(dir, path.join(dir, 'rec.m2ts'), new PassThrough());
    checker.tsPacketAnalyzer.emit('packetDrop', 0x100, 2, 1);
    await checker.stop();

    // the retry records 50 packets on PID 0x100
    const source = new PassThrough();
    await checker.start(dir, path.join(dir, 'rec.m2ts'), source);
    for (let i = 0; i < 50; i++) {
        const packet = Buffer.alloc(188);
        packet[0] = 0x47;
        packet[1] = 0x01;
        packet[2] = 0x00;
        packet[3] = 0x10 | (i & 0x0f);
        source.write(packet);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    await checker.stop();

    assert.strictEqual(path.basename(checker.getFilePath()), 'rec.m2ts(1).log');
    assert.deepStrictEqual(await checker.getResult(), { 256: { packet: 50, error: 0, drop: 0, scrambling: 0 } });
    // no blank line: the first attempt's drop is not counted as an error of the retry
    assert.strictEqual(
        fs.readFileSync(checker.getFilePath(), 'utf8'),
        'pid: 0x0100, error: 0, drop: 0, scrambling: 0, packet: 50, name: -\n',
    );
});
