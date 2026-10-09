require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const RecorderModel = require('../dist/model/operator/recording/RecorderModel').default;

const MAX_TIMER_DELAY = 2 ** 31 - 1;
const DAY = 24 * 60 * 60 * 1000;
const silentLog = { system: { info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} } };

test('a reservation more than 24.8 days ahead is not prepared before its start', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    // setTimeout treats a delay above MAX_TIMER_DELAY as 1 ms, which the mock does not
    // reproduce, so every delay passed to setTimeout is checked too
    const mockedSetTimeout = global.setTimeout;
    const delays = [];
    global.setTimeout = (fn, delay, ...args) => {
        delays.push(delay);

        return mockedSetTimeout(fn, delay, ...args);
    };
    t.after(() => {
        global.setTimeout = mockedSetTimeout;
    });

    const model = Object.create(RecorderModel.prototype);
    model.log = silentLog;
    model.timerId = null;
    let prepared = 0;
    model.prepRecord = () => {
        prepared++;
    };

    const startAt = 30 * DAY;
    assert.strictEqual(model.setTimer({ id: 1, isSkip: false, isOverlap: false, startAt, endAt: startAt + 1000 }, true), true);

    t.mock.timers.tick(MAX_TIMER_DELAY);
    assert.strictEqual(prepared, 0);
    t.mock.timers.tick(startAt - MAX_TIMER_DELAY);
    assert.strictEqual(prepared, 1);
    assert.ok(delays.every(delay => delay <= MAX_TIMER_DELAY), `delays: ${delays}`);
});

test('a failed recording preparation closes the Mirakurun stream it opened', async () => {
    const stream = new PassThrough();
    const model = Object.create(RecorderModel.prototype);
    Object.assign(model, {
        log: silentLog,
        reserve: { id: 1, programId: null },
        isStopPrepRec: false,
        stream: null,
        recFile: null,
        abortController: null,
        streamCreator: { create: async () => stream },
        reserveDB: { findId: async () => ({ id: 1 }) },
        recordingUtil: { getRecPath: async () => Promise.reject(new Error('GetExecutionTimeoutError')) },
        recordingEvent: { emitStartPrepRecording: () => {}, emitPrepRecordingFailed: () => {} },
        eventEmitter: { emit: () => {} },
        dropChecker: { stop: async () => {} },
    });

    await model.prepRecord(3); // the last retry: no further retry is scheduled

    assert.strictEqual(stream.destroyed, true);
    assert.strictEqual(model.stream, null);
});

test('recording finish is still reported when clearing the recording flag fails', async () => {
    const finished = [];
    const model = Object.create(RecorderModel.prototype);
    Object.assign(model, {
        log: silentLog,
        reserve: { id: 1, isTimeSpecified: true, ruleId: null, isEventRelay: false },
        config: {},
        stream: null,
        recFile: null,
        eventRelayTimerId: null,
        isPlanToDelete: false,
        recordedId: 5,
        videoFileId: null,
        videoFileFulPath: null,
        dropLogFileId: null,
        isNeedDeleteReservation: true,
        recordedDB: {
            removeRecording: async () => Promise.reject(new Error('db down')),
            findId: async () => ({ id: 5 }),
        },
        recordingEvent: { emitFinishRecording: (reserve, recorded) => finished.push(recorded.id) },
    });

    await model.recEnd();

    assert.deepStrictEqual(finished, [5]);
});

test('a database error when the recording starts reaches the retry and failure handling', async t => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const stream = new PassThrough();
    const failed = [];
    const model = Object.create(RecorderModel.prototype);
    Object.assign(model, {
        log: silentLog,
        config: { isEnabledDropCheck: false },
        reserve: { id: 1, programId: null },
        isStopPrepRec: false,
        stream: null,
        recFile: null,
        abortController: null,
        dropLogFileId: null,
        streamCreator: { create: async () => stream },
        reserveDB: { findId: async () => ({ id: 1 }) },
        recordingUtil: { getRecPath: async () => ({ fullPath: path.join(dir, 'rec.m2ts') }) },
        createRecorded: async () => ({}),
        recordedDB: { insertOnce: async () => Promise.reject(new Error('db down')) },
        recordingEvent: { emitStartPrepRecording: () => {}, emitPrepRecordingFailed: reserve => failed.push(reserve.id) },
        eventEmitter: { emit: () => {} },
    });

    // the last retry: a failure is reported instead of retrying
    const preparing = model.prepRecord(3);
    await new Promise(resolve => setTimeout(resolve, 50));
    stream.write(Buffer.alloc(188)); // first data: the recording is added to the database
    const settled = await Promise.race([preparing.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 2000))]);

    assert.strictEqual(settled, true);
    assert.deepStrictEqual(failed, [1]);
});
