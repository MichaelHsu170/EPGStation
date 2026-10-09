require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const IPCServer = require('../dist/model/ipc/IPCServer').default;

const fakeChild = () => {
    const child = new EventEmitter();
    child.sent = [];
    child.send = msg => child.sent.push(msg);

    return child;
};

test('a reply is sent to the process that asked, not to the one that replaced it in the meantime', async () => {
    let finishCall;
    const server = Object.create(IPCServer.prototype);
    server.child = null;
    server.functions = { reserveation: { add: () => new Promise(resolve => (finishCall = resolve)) } };

    const oldChild = fakeChild();
    server.register(oldChild);
    oldChild.emit('message', { id: 1, model: 'reserveation', func: 'add' });

    // the service process restarts while the call is running; the new one numbers its requests from 1 again
    const newChild = fakeChild();
    server.register(newChild);
    finishCall('result of the old request');
    await new Promise(setImmediate);

    assert.deepStrictEqual(oldChild.sent, [{ id: 1, result: 'result of the old request' }]);
    assert.deepStrictEqual(newChild.sent, []);
});
