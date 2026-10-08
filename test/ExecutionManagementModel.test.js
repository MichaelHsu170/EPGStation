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
