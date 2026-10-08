require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const events = require('events');
const IPCClient = require('../dist/model/ipc/IPCClient').default;

/**
 * IPCClient whose messages to the operator are collected instead of sent.
 */
const createClient = t => {
    const sent = [];
    const originalSend = process.send;
    process.send = msg => sent.push(msg);
    t.after(() => {
        process.send = originalSend;
    });

    const client = Object.create(IPCClient.prototype);
    client.log = { system: { info: () => {}, error: () => {} } };
    client.listener = new events.EventEmitter();
    client.lastMessageId = 0;
    client.setReserveation();
    client.setRecorded();

    const reply = (msg, result) => client.listener.emit(msg.id.toString(10), { id: msg.id, result });

    return { client, sent, reply };
};

test('two calls sent in the same millisecond get their own replies', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const { client, sent, reply } = createClient(t);

    const a = client.reserveation.cancel(1);
    const b = client.reserveation.cancel(2);
    await new Promise(process.nextTick);

    assert.notStrictEqual(sent[0].id, sent[1].id);
    reply(sent[1], 'second');
    reply(sent[0], 'first');
    assert.deepStrictEqual(await Promise.all([a, b]), ['first', 'second']);
});

test('reservation calls wait longer than the operator waits for the reservation lock', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, sent, reply } = createClient(t);

    let settled = false;
    const call = client.reserveation.add({}).finally(() => (settled = true));
    await new Promise(process.nextTick);

    t.mock.timers.tick(61 * 1000);
    await new Promise(setImmediate);
    assert.strictEqual(settled, false);

    reply(sent[0], 7);
    assert.strictEqual(await call, 7);
});

test('other calls keep the 5 second timeout', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client } = createClient(t);

    const call = client.recorded.delete(1);
    await new Promise(process.nextTick);
    t.mock.timers.tick(5000);

    await assert.rejects(call, /IPCTimeout/);
});
