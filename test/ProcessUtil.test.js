const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const ProcessUtil = require('../dist/util/ProcessUtil').default;

const exited = child => new Promise(resolve => child.once('exit', resolve));

test('waitExit resolves true at once for a process that already exited with a code', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(3)']);
    await exited(child);

    const begin = Date.now();
    assert.strictEqual(await ProcessUtil.waitExit(child, 2000), true);
    assert.ok(Date.now() - begin < 500);
});

test('waitExit resolves true at once for a process that already exited by a signal (exitCode stays null)', async () => {
    const child = spawn('/bin/sleep', ['30']);
    child.kill('SIGTERM');
    await exited(child);
    assert.strictEqual(child.exitCode, null);
    assert.strictEqual(child.signalCode, 'SIGTERM');

    const begin = Date.now();
    assert.strictEqual(await ProcessUtil.waitExit(child, 2000), true);
    assert.ok(Date.now() - begin < 500);
});

test('waitExit resolves true when the process exits during the wait, without waiting for the time limit', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 300)']);

    const begin = Date.now();
    assert.strictEqual(await ProcessUtil.waitExit(child, 3000), true);
    const took = Date.now() - begin;
    assert.ok(took >= 200 && took < 2000, `took ${took} ms`);
    assert.strictEqual(child.listenerCount('exit'), 0);
});

test('waitExit resolves false after the time limit for a process that keeps running, and stops listening', async t => {
    const child = spawn('/bin/sleep', ['30']);
    t.after(() => child.kill('SIGKILL'));

    const begin = Date.now();
    assert.strictEqual(await ProcessUtil.waitExit(child, 400), false);
    const took = Date.now() - begin;
    assert.ok(took >= 380 && took < 1500, `took ${took} ms`);
    assert.strictEqual(child.exitCode, null);
    assert.strictEqual(child.listenerCount('exit'), 0);
});
