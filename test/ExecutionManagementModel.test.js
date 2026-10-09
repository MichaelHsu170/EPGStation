require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const ExecutionManagementModel = require('../dist/model/ExecutionManagementModel').default;

const logger = { getLogger: () => ({ system: { error: () => {} } }) };

test('a waiter that timed out does not keep the lock after the holder releases it', async () => {
    const model = new ExecutionManagementModel(logger);
    const holder = await model.getExecution(1, 1000);

    await assert.rejects(model.getExecution(1, 50), /GetExecutionTimeoutError/);
    model.unLockExecution(holder);

    const next = await model.getExecution(1, 200);
    model.unLockExecution(next);
});

test('a timed-out waiter does not block the waiters queued behind it', async () => {
    const model = new ExecutionManagementModel(logger);
    const holder = await model.getExecution(1, 1000);

    const timedOut = assert.rejects(model.getExecution(1, 50), /GetExecutionTimeoutError/);
    const waiting = model.getExecution(1, 1000);
    await timedOut;
    model.unLockExecution(holder);

    model.unLockExecution(await waiting);
});

test('two callers queued in the same millisecond never hold the lock at once', async t => {
    // pin the clock and the random numbers that ids could be made of
    t.mock.timers.enable({ apis: ['Date'], now: 1790000000000 });
    t.mock.method(Math, 'random', () => 0.5);
    const model = new ExecutionManagementModel(logger);
    const holder = await model.getExecution(1);

    const holders = [];
    const a = model.getExecution(1).then(id => holders.push('a') && id);
    const b = model.getExecution(1).then(id => holders.push('b') && id);
    model.unLockExecution(holder);
    await new Promise(setImmediate);

    assert.deepStrictEqual(holders, ['a']);
    model.unLockExecution(await a);
    model.unLockExecution(await b);
    assert.deepStrictEqual(holders, ['a', 'b']);
});
