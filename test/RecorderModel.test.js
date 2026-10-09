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

const flushIO = async () => {
    for (let i = 0; i < 20; i++) {
        await new Promise(setImmediate);
    }
};

test('a recording cancelled before its first data is not started again', async t => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { EventEmitter } = require('events');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ['setTimeout'] });

    let streams = 0;
    const failed = [];
    const model = Object.create(RecorderModel.prototype);
    Object.assign(model, {
        log: silentLog,
        config: { isEnabledDropCheck: false },
        reserve: { id: 1, programId: null },
        isStopPrepRec: false,
        isPrepRecording: false,
        isRecording: false,
        isPlanToDelete: false,
        stream: null,
        recFile: null,
        abortController: null,
        dropLogFileId: null,
        timerId: null,
        eventEmitter: new EventEmitter(),
        streamCreator: {
            create: async () => {
                streams++;

                return new PassThrough();
            },
        },
        reserveDB: { findId: async () => ({ id: 1 }) },
        recordingUtil: { getRecPath: async () => ({ fullPath: path.join(dir, `rec${streams}.m2ts`) }) },
        recordingEvent: {
            emitStartPrepRecording: () => {},
            emitCancelPrepRecording: () => {},
            emitPrepRecordingFailed: reserve => failed.push(reserve.id),
        },
        dropChecker: { stop: async () => {} },
    });

    model.prepRecord();
    await flushIO();
    assert.strictEqual(model.isRecording, true); // the stream is open, waiting for its first data
    await model.cancel(false);

    t.mock.timers.tick(5 * 1000); // the first data does not come
    await flushIO();
    t.mock.timers.tick(5 * 1000); // the retry delay
    await flushIO();

    assert.strictEqual(streams, 1);
    assert.deepStrictEqual(failed, []);
    assert.strictEqual(model.isRecording, false);
});

test('a recording start whose video file could not be added removes its recorded row and retries with a new one', async () => {
    const inserted = [];
    const deleted = [];
    let videoFileFailures = 1;
    const model = Object.create(RecorderModel.prototype);
    Object.assign(model, {
        log: silentLog,
        reserve: { id: 1, programId: 5, isTimeSpecified: false, name: 'n', halfWidthName: 'n', startAt: 0, endAt: 1 },
        recordedId: null,
        dropLogFileId: null,
        isRecording: true,
        stream: null,
        recFile: null,
        recordedDB: {
            // like the database: an id given by the caller must be new, otherwise the next one is used
            insertOnce: async recorded => {
                if (typeof recorded.id !== 'undefined') {
                    throw new Error(`ER_DUP_ENTRY ${recorded.id}`);
                }
                inserted.push(100 + inserted.length);

                return inserted[inserted.length - 1];
            },
            deleteOnce: async id => {
                deleted.push(id);
            },
        },
        videoFileDB: {
            insertOnce: async () => {
                if (videoFileFailures-- > 0) {
                    throw new Error('db down');
                }

                return 7;
            },
        },
    });
    const recPath = { parendDir: { name: 'recorded' }, subDir: '', fileName: 'a.m2ts', fullPath: '/nonexistent/a.m2ts' };

    await assert.rejects(model.addRecorded(recPath), /AddRecordedDBError/);
    assert.deepStrictEqual(deleted, [100]);
    assert.strictEqual(model.recordedId, null);

    const recorded = await model.addRecorded(recPath);
    assert.strictEqual(recorded.id, 101);
    assert.strictEqual(model.videoFileId, 7);
});

test('a reservation whose program is missing at preparation is retried, then reported as failed', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let lookups = 0;
    let streams = 0;
    const failed = [];
    const model = Object.create(RecorderModel.prototype);
    Object.assign(model, {
        log: silentLog,
        reserve: { id: 1, programId: 5 },
        isStopPrepRec: false,
        stream: null,
        recFile: null,
        abortController: null,
        dropLogFileId: null,
        eventEmitter: { emit: () => {} },
        programDB: {
            findId: async () => {
                lookups++;

                return null;
            },
        },
        streamCreator: {
            create: async () => {
                streams++;

                return new PassThrough();
            },
        },
        recordingEvent: { emitStartPrepRecording: () => {}, emitPrepRecordingFailed: reserve => failed.push(reserve.id) },
    });

    await model.prepRecord();
    for (let i = 0; i < 3; i++) {
        assert.deepStrictEqual(failed, []);
        t.mock.timers.tick(5 * 1000);
        await new Promise(setImmediate);
    }

    assert.strictEqual(lookups, 4);
    assert.strictEqual(streams, 0);
    assert.deepStrictEqual(failed, [1]);
    assert.strictEqual(model.isPrepRecording, false);
});
