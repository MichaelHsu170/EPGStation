require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const container = require('../dist/model/ModelContainer').default;

const log = { error: () => {}, debug: () => {} };
container.bind('ILoggerModel').toConstantValue({ getLogger: () => ({ stream: log }) });
const fst = require('../dist/lib/TailStream');

const makeFile = (t, size) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailstream-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'rec.m2ts');
    fs.writeFileSync(file, Buffer.alloc(size, 0x47));

    return file;
};

// この process で file を開いている fd の数
const openFds = file =>
    fs
        .readdirSync('/proc/self/fd')
        .map(fd => {
            try {
                return fs.readlinkSync(`/proc/self/fd/${fd}`);
            } catch (err) {
                return '';
            }
        })
        .filter(link => link.startsWith(file)).length;

const closed = stream => new Promise(resolve => stream.once('close', resolve));

test('a stream destroyed while it reads (a stopped recorded stream) closes its file', async t => {
    const file = makeFile(t, 1024 * 1024);
    const stream = fst.createReadStream(file, { start: 0 });
    await new Promise(resolve => stream.once('data', resolve));
    assert.strictEqual(openFds(file), 1);

    stream.unpipe();
    stream.destroy();
    await closed(stream);

    assert.strictEqual(openFds(file), 0);
});

test('a stream destroyed before its file is open closes the file once it opens', async t => {
    const file = makeFile(t, 188);
    const stream = fst.createReadStream(file, { start: 0 });
    stream.destroy();
    await closed(stream);
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.strictEqual(openFds(file), 0);
});

test('a stream that reaches the end of a file that stopped growing ends and closes the file', async t => {
    const file = makeFile(t, 188 * 10);
    const stream = fst.createReadStream(file, { start: 0 });
    let bytes = 0;
    stream.on('data', chunk => (bytes += chunk.length));
    await closed(stream);

    assert.strictEqual(bytes, 188 * 10);
    assert.strictEqual(openFds(file), 0);
});

test('a stream destroyed while it waits for more data stops polling the file', async t => {
    const file = makeFile(t, 188 * 10);
    const errors = [];
    const onUncaught = err => errors.push(err);
    process.on('uncaughtException', onUncaught);
    t.after(() => process.removeListener('uncaughtException', onUncaught));

    const stream = fst.createReadStream(file, { start: 0 });
    stream.on('data', () => {});
    await new Promise(resolve => setTimeout(resolve, 300)); // all read: it now polls the file every second
    fs.appendFileSync(file, Buffer.alloc(188, 0x47)); // the recording grows, so the poll would read again
    stream.destroy();
    await new Promise(resolve => setTimeout(resolve, 1200));

    assert.deepStrictEqual(errors, []);
});

test('a recording deleted while the stream waits for more data ends the stream without an exception', async t => {
    const file = makeFile(t, 188 * 10);
    const errors = [];
    const onUncaught = err => errors.push(err);
    process.on('uncaughtException', onUncaught);
    t.after(() => process.removeListener('uncaughtException', onUncaught));

    const stream = fst.createReadStream(file, { start: 0 });
    let isEnded = false;
    stream.on('end', () => (isEnded = true));
    stream.on('data', () => {});
    await new Promise(resolve => setTimeout(resolve, 300)); // all read: it now polls the file every second
    fs.unlinkSync(file);
    await new Promise(resolve => setTimeout(resolve, 1500));

    assert.deepStrictEqual(
        errors.map(e => e.code),
        [],
    );
    assert.strictEqual(isEnded, true);
});

test('a recording deleted after the stream opened it is read to its end, then the stream ends without an exception', async t => {
    const file = makeFile(t, 188 * 10);
    const errors = [];
    const onUncaught = err => errors.push(err);
    process.on('uncaughtException', onUncaught);
    t.after(() => process.removeListener('uncaughtException', onUncaught));

    const stream = fst.createReadStream(file, { start: 0 });
    await new Promise(resolve => setTimeout(resolve, 100)); // the file is open, nothing read yet
    fs.unlinkSync(file);
    let bytes = 0;
    stream.on('data', chunk => (bytes += chunk.length));
    await closed(stream);

    assert.deepStrictEqual(errors, []);
    assert.strictEqual(bytes, 188 * 10);
});
