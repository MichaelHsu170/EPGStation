require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const EventSetter = require('../dist/model/event/EventSetter').default;

/**
 * EventSetter with only the EPG-updated handler wired. Returns the handler and the
 * updateAll calls (each resolves when its release function is called).
 */
const setUp = () => {
    let handler = null;
    const calls = [];
    const setter = Object.create(EventSetter.prototype);
    Object.assign(setter, {
        log: { system: { error: () => {} } },
        isFirstreserveationUpdate: true,
        isUpdatingReservations: false,
        needsUpdateReservations: false,
        epgUpdateEvent: { setUpdated: cb => (handler = cb) },
        recordedManage: { historyCleanup: async () => {} },
        reservationManage: {
            updateAll: isFirst =>
                new Promise((resolve, reject) => {
                    calls.push({ isFirst, resolve, reject });
                }),
        },
    });
    // set() wires many other events; wire only the EPG one
    const noop = () => {};
    const events = new Proxy({}, { get: () => noop });
    for (const key of ['encodeEvent', 'ruleEvent', 'reserveEvent', 'recordedEvent', 'recordingEvent', 'recordedTagEvent', 'thumbnailEvent']) {
        setter[key] = events;
    }
    setter.set();

    return { handler, calls };
};

const flush = () => new Promise(setImmediate);

test('EPG updates arriving during a reservation update run it once more afterwards, not concurrently', async () => {
    const { handler, calls } = setUp();

    const first = handler();
    await flush();
    handler();
    handler();
    await flush();
    assert.strictEqual(calls.length, 1);

    calls[0].resolve();
    await flush();
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(
        calls.map(c => c.isFirst),
        [true, false],
    );

    calls[1].resolve();
    await first;
    assert.strictEqual(calls.length, 2);
});

test('a failed reservation update does not block later EPG updates', async () => {
    const { handler, calls } = setUp();

    const first = handler();
    await flush();
    calls[0].reject(new Error('GetExecutionTimeoutError'));
    await first;

    handler();
    await flush();
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].isFirst, true);
    calls[1].resolve();
});
