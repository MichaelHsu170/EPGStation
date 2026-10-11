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

    await model.prepRecord(3, 3); // the last retry: no further retry is scheduled

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

    // the last retry (3 failures so far): a failure is reported instead of retrying
    const preparing = model.prepRecord(3, 3);
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

const connectionError = code => Object.assign(new Error(`connect ${code} 172.18.0.4:40772`), { code });

// a recorder about to prepare a recording, whose stream requests go to createStream
const createPrepModel = (reserve, createStream) => {
    const failed = [];
    const warnings = [];
    const errors = [];
    const model = Object.create(RecorderModel.prototype);
    Object.assign(model, {
        log: {
            system: {
                info: () => {},
                warn: message => warnings.push(message),
                error: message => errors.push(message),
                fatal: () => {},
            },
        },
        reserve,
        isStopPrepRec: false,
        isPrepRecording: false,
        isRecording: false,
        stream: null,
        recFile: null,
        abortController: null,
        dropLogFileId: null,
        eventEmitter: new (require('events').EventEmitter)(),
        streamCreator: { create: createStream },
        reserveDB: { findId: async () => ({ id: reserve.id }) },
        recordingEvent: {
            emitStartPrepRecording: () => {},
            emitCancelPrepRecording: () => {},
            emitPrepRecordingFailed: r => failed.push(r.id),
        },
        dropChecker: { stop: async () => {} },
    });

    return { model, failed, warnings, errors };
};

test('while Mirakurun is unreachable, preparation is retried every 5 s until it answers, as long as the program is on air', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const outage = 25 * 1000; // the Mirakurun container takes about 25 s to listen again
    const attempts = [];
    const { model, failed, warnings, errors } = createPrepModel(
        { id: 7, programId: null, endAt: 60 * 60 * 1000 },
        async () => {
            attempts.push(Date.now());
            if (Date.now() < outage) {
                throw connectionError(attempts.length % 2 === 0 ? 'ECONNREFUSED' : 'ENOTFOUND');
            }

            return new PassThrough();
        },
    );
    let recording = 0;
    model.doRecord = async () => {
        recording++;
    };

    await model.prepRecord();
    for (let i = 0; i < 5; i++) {
        t.mock.timers.tick(5 * 1000);
        await flushIO();
    }

    assert.deepStrictEqual(attempts, [0, 5000, 10000, 15000, 20000, 25000]);
    assert.strictEqual(recording, 1);
    assert.deepStrictEqual(failed, []);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(warnings.length, 5); // one line per retry
    assert.match(warnings[0], /^preprec failed, Mirakurun is unreachable\. retry in 5 s: 7 \(connect ENOTFOUND /);
});

test('a reservation whose program ends while Mirakurun is unreachable is reported as failed at its end', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let attempts = 0;
    const { model, failed } = createPrepModel({ id: 7, programId: null, endAt: 32 * 1000 }, async () => {
        attempts++;
        throw connectionError('ECONNREFUSED');
    });

    await model.prepRecord();
    for (let i = 0; i < 10; i++) {
        t.mock.timers.tick(5 * 1000);
        await flushIO();
    }

    // attempts at 0, 5, ..., 30 s are on air; the one at 35 s is past the end and the first of the
    // failures that keep the 3 retries (40, 45 and 50 s)
    assert.strictEqual(attempts, 11);
    assert.deepStrictEqual(failed, [7]);
    assert.strictEqual(model.isPrepRecording, false);
});

test('a stream refused for another reason than the connection keeps the 3 retries', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let attempts = 0;
    const { model, failed } = createPrepModel({ id: 7, programId: null, endAt: 60 * 60 * 1000 }, async () => {
        attempts++;
        throw new Error('Bad status respond (503 Service Unavailable).');
    });

    await model.prepRecord();
    for (let i = 0; i < 10; i++) {
        t.mock.timers.tick(5 * 1000);
        await flushIO();
    }

    assert.strictEqual(attempts, 4);
    assert.deepStrictEqual(failed, [7]);
});

test('another failure right after Mirakurun is reachable again still gets the 3 retries', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let attempts = 0;
    const { model, failed } = createPrepModel({ id: 7, programId: null, endAt: 60 * 60 * 1000 }, async () => {
        attempts++;
        if (attempts <= 5) {
            throw connectionError('ECONNREFUSED');
        }
        if (attempts === 6) {
            throw new Error('Bad status respond (503 Service Unavailable).');
        }

        return new PassThrough();
    });
    let recording = 0;
    model.doRecord = async () => {
        recording++;
    };

    await model.prepRecord();
    for (let i = 0; i < 10; i++) {
        t.mock.timers.tick(5 * 1000);
        await flushIO();
    }

    assert.strictEqual(attempts, 7);
    assert.strictEqual(recording, 1);
    assert.deepStrictEqual(failed, []);
});

test('the 3 retries of other failures are not reset by connection errors in between', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let attempts = 0;
    const { model, failed } = createPrepModel({ id: 7, programId: null, endAt: 60 * 60 * 1000 }, async () => {
        attempts++;
        if (attempts % 2 === 0) {
            throw connectionError('ECONNREFUSED');
        }
        throw new Error('Bad status respond (503 Service Unavailable).');
    });

    await model.prepRecord();
    for (let i = 0; i < 20; i++) {
        t.mock.timers.tick(5 * 1000);
        await flushIO();
    }

    // 503 at attempts 1, 3, 5, 7: the 4th 503 is the last
    assert.strictEqual(attempts, 7);
    assert.deepStrictEqual(failed, [7]);
});

test('cancelling a reservation while Mirakurun is unreachable stops the retries', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let attempts = 0;
    const { model, failed } = createPrepModel({ id: 7, programId: null, endAt: 60 * 60 * 1000 }, async () => {
        attempts++;
        throw connectionError('ECONNREFUSED');
    });

    await model.prepRecord();
    for (let i = 0; i < 4; i++) {
        t.mock.timers.tick(5 * 1000);
        await flushIO();
    }
    const cancelling = model.cancel(false);
    t.mock.timers.tick(5 * 1000);
    await flushIO();
    await cancelling;
    for (let i = 0; i < 4; i++) {
        t.mock.timers.tick(5 * 1000);
        await flushIO();
    }

    assert.strictEqual(attempts, 5);
    assert.deepStrictEqual(failed, []);
    assert.strictEqual(model.isPrepRecording, false);
});

test('a connection error from the database, after the stream was opened, keeps the 3 retries', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let attempts = 0;
    const { model, failed } = createPrepModel({ id: 7, programId: null, endAt: 60 * 60 * 1000 }, async () => {
        attempts++;

        return new PassThrough();
    });
    model.reserveDB = { findId: async () => Promise.reject(connectionError('ECONNREFUSED')) };

    await model.prepRecord();
    for (let i = 0; i < 10; i++) {
        t.mock.timers.tick(5 * 1000);
        await flushIO();
    }

    assert.strictEqual(attempts, 4);
    assert.deepStrictEqual(failed, [7]);
});

// Mirakurun gives a program whose duration is undetermined (an overrun) as duration 1 ms, so its program id
// reservation has endAt = startAt + 1 (S14 review: NHK BS 101, event 1444, on 2026-10-11)
const HOUR = 60 * 60 * 1000;
const overrunReserve = (fields = {}) => ({ id: 6, programId: 40010101444, isSkip: false, isOverlap: false, startAt: -3 * HOUR, endAt: -3 * HOUR + 1, ...fields });

test('a reservation of a program whose duration became undetermined is still armed and prepared at once', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const model = Object.create(RecorderModel.prototype);
    model.log = silentLog;
    model.timerId = null;
    let prepared = 0;
    model.prepRecord = () => {
        prepared++;
    };

    assert.strictEqual(model.setTimer(overrunReserve(), true), true);
    t.mock.timers.tick(0);
    assert.strictEqual(prepared, 1);

    // an ended program, and a 1 ms time-specified reservation, are not on air
    assert.strictEqual(model.setTimer(overrunReserve({ endAt: -1 }), true), false);
    assert.strictEqual(model.setTimer(overrunReserve({ programId: null }), true), false);
});

test('while Mirakurun is unreachable, preparation of a program whose duration is undetermined keeps retrying', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const attempts = [];
    const { model, failed } = createPrepModel(overrunReserve(), async () => {
        attempts.push(Date.now());
        if (Date.now() < 25 * 1000) {
            throw connectionError('ECONNREFUSED');
        }

        return new PassThrough();
    });
    model.programDB = { findId: async id => ({ id }) };
    let recording = 0;
    model.doRecord = async () => {
        recording++;
    };

    await model.prepRecord();
    for (let i = 0; i < 5; i++) {
        t.mock.timers.tick(5 * 1000);
        await flushIO();
    }

    assert.deepStrictEqual(attempts, [0, 5000, 10000, 15000, 20000, 25000]);
    assert.strictEqual(recording, 1);
    assert.deepStrictEqual(failed, []);
});

/**
 * A recorder (made by its constructor, so its fields have their initial values) that is recording reserve.
 * The fake Mirakurun gives the program with a relay item to 102/3193 (as it did for 1444), which the program DB knows.
 */
const createRecordingModel = (reserve, { findRelayError = null } = {}) => {
    const checks = [];
    const relays = [];
    const recordingFailed = [];
    const log = { system: { ...silentLog.system, debug: () => {} } };
    const model = new RecorderModel(
        { getLogger: () => log },
        { getConfig: () => ({}) },
        {
            findEventRelayProgram: async (networkId, serviceId, eventId) => {
                if (findRelayError !== null) {
                    throw findRelayError;
                }

                return { id: networkId * 10000000000 + serviceId * 100000 + eventId };
            },
        },
        {},
        { removeRecording: async () => {}, findId: async id => ({ id }), updateOnce: async () => {} },
        {},
        {},
        {},
        {},
        { stop: async () => {} },
        {},
        {
            emitEventRelay: programs => relays.push(programs.map(p => p.programId)),
            emitFinishRecording: () => {},
            emitRecordingFailed: r => recordingFailed.push(r.id),
        },
        {
            getClient: () => ({
                getProgram: async programId => {
                    checks.push(Date.now());

                    return { id: programId, networkId: 4, relatedItems: [{ type: 'relay', serviceId: 102, eventId: 3193 }] };
                },
            }),
        },
    );
    // the state doRecord leaves: recording into recorded 9, its stream watched, the relay check armed
    model.reserve = reserve;
    model.isRecording = true;
    model.recordedId = 9;
    model.createRecorded = async () => ({ id: 9 });
    const stream = new PassThrough();
    stream.resume();
    model.stream = stream;
    model.setEndProcess(stream);
    model.setEventRelayTimer(reserve);

    return { model, stream, checks, relays, recordingFailed };
};

test('a recording whose duration becomes undetermined checks the event relay when its stream ends, not at once', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const reserve = overrunReserve({ endAt: 10 * 60 * 1000 }); // planned end in 10 min
    const { model, stream, checks, relays } = createRecordingModel(reserve);

    t.mock.timers.tick(60 * 1000);
    await model.update({ ...reserve, endAt: reserve.startAt + 1 }, true);
    await flushIO();
    t.mock.timers.tick(60 * 60 * 1000); // past the planned end: the overrun goes on
    await flushIO();
    assert.deepStrictEqual(checks, []);

    stream.end(); // Mirakurun closes the program stream when the event leaves EIT p/f
    await flushIO();

    assert.deepStrictEqual(checks, [61 * 60 * 1000]);
    assert.deepStrictEqual(relays, [[40010203193]]);
});

test('a recording whose duration is undetermined, then known again, checks the event relay 20 s before the new end only', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const reserve = overrunReserve({ endAt: 10 * 60 * 1000 });
    const { model, stream, checks, relays } = createRecordingModel(reserve);

    t.mock.timers.tick(60 * 1000);
    await model.update({ ...reserve, endAt: reserve.startAt + 1 }, true);
    t.mock.timers.tick(60 * 1000);
    await model.update({ ...reserve, endAt: 30 * 60 * 1000 }, true); // the broadcaster gives the real end
    t.mock.timers.tick(30 * 60 * 1000 - 20 * 1000 - 2 * 60 * 1000);
    await flushIO();
    assert.deepStrictEqual(checks, [30 * 60 * 1000 - 20 * 1000]);

    t.mock.timers.tick(20 * 1000);
    stream.end();
    await flushIO();

    assert.deepStrictEqual(checks, [30 * 60 * 1000 - 20 * 1000]);
    assert.deepStrictEqual(relays, [[40010203193]]);
});

test('a recording with a known end checks the event relay once, 20 s before its end', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { stream, checks } = createRecordingModel(overrunReserve({ endAt: 10 * 60 * 1000 }));

    t.mock.timers.tick(10 * 60 * 1000 - 20 * 1000);
    await flushIO();
    t.mock.timers.tick(20 * 1000);
    stream.end();
    await flushIO();

    assert.deepStrictEqual(checks, [10 * 60 * 1000 - 20 * 1000]);
});

test('a recording whose duration becomes undetermined after the relay check checks it again when its stream ends', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const reserve = overrunReserve({ endAt: 10 * 60 * 1000 });
    const { model, stream, checks, relays } = createRecordingModel(reserve);

    t.mock.timers.tick(10 * 60 * 1000 - 20 * 1000);
    await flushIO();
    t.mock.timers.tick(5 * 60 * 1000); // the game overruns; the relay target is decided later
    await model.update({ ...reserve, endAt: reserve.startAt + 1 }, true);
    t.mock.timers.tick(60 * 60 * 1000);
    stream.end();
    await flushIO();

    assert.deepStrictEqual(checks, [10 * 60 * 1000 - 20 * 1000, 75 * 60 * 1000 - 20 * 1000]);
    // both checks ask for 102/3193: ReservationManageModel.addEventRelay reserves it once
    assert.deepStrictEqual(relays, [[40010203193], [40010203193]]);
});

test('a recording whose program ends before the relay check time checks the event relay when its stream ends', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { stream, checks } = createRecordingModel(overrunReserve({ endAt: 10 * 60 * 1000 }));

    t.mock.timers.tick(5 * 60 * 1000); // the event ends early
    stream.end();
    await flushIO();
    t.mock.timers.tick(10 * 60 * 1000);
    await flushIO();

    assert.deepStrictEqual(checks, [5 * 60 * 1000]);
});

test('a recording cancelled while its duration is undetermined does not check the event relay', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { model, checks, recordingFailed } = createRecordingModel(overrunReserve());

    t.mock.timers.tick(60 * 1000);
    await model.cancel(false);
    await flushIO();

    assert.deepStrictEqual(recordingFailed, [6]); // the stream closed by the cancel ends through recFailed
    assert.deepStrictEqual(checks, []);
});

test('an event relay check at the end of a stream whose program lookup fails is logged, not left unhandled', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const unhandled = [];
    const onUnhandled = err => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    const { stream, checks } = createRecordingModel(overrunReserve(), { findRelayError: new Error('db down') });

    stream.end();
    await flushIO();

    assert.deepStrictEqual(checks, [0]);
    assert.deepStrictEqual(unhandled, []);
});
