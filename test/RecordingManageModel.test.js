require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const RecordingManageModel = require('../dist/model/operator/recording/RecordingManageModel').default;

const silentLog = { system: { info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, debug: () => {} } };

test('startup cleanup keeps and resumes a recording whose program is still on air, and finishes one that is over', async () => {
    const now = Date.now();
    const reserves = {
        3: { id: 3, ruleId: null, programId: 9, startAt: now - 1800e3, endAt: now + 1800e3 }, // still on air
        4: { id: 4, ruleId: null, programId: 10, startAt: now - 7200e3, endAt: now - 3600e3 }, // over
    };
    const finished = [];
    const timers = [];
    const manage = Object.create(RecordingManageModel.prototype);
    Object.assign(manage, {
        log: silentLog,
        config: {},
        recordingIndex: {},
        recordingEvent: { emitFinishRecording: (reserve, recorded, isNeedDeleteReservation) => finished.push([reserve.id, recorded.id, isNeedDeleteReservation]) },
        recordedDB: {
            findAll: async () => [[{ id: 50, reserveId: 3, videoFiles: [] }, { id: 51, reserveId: 4, videoFiles: [] }], 2],
            removeRecording: async () => {},
            findId: async id => ({ id, videoFiles: [] }),
        },
        reserveDB: { findId: async id => reserves[id] },
        provider: async () => ({
            setTimer: (reserve, isSuppressLog) => {
                timers.push([reserve.id, isSuppressLog]);

                return true;
            },
        }),
    });

    await manage.cleanup();

    assert.deepStrictEqual(finished, [
        [3, 50, false],
        [4, 51, true],
    ]);
    assert.deepStrictEqual(timers, [[3, false]]);
    assert.deepStrictEqual(Object.keys(manage.recordingIndex), ['3']);
});

test('startup cleanup keeps and resumes a recording whose program duration is undetermined (endAt = startAt + 1)', async () => {
    const now = Date.now();
    const startAt = now - 3 * 3600e3;
    const reserves = {
        6: { id: 6, ruleId: null, programId: 40010101444, startAt, endAt: startAt + 1 }, // overrunning, end not known yet
        7: { id: 7, ruleId: null, programId: null, startAt, endAt: startAt + 1 }, // a time-specified reservation is over
    };
    const finished = [];
    const timers = [];
    const manage = Object.create(RecordingManageModel.prototype);
    Object.assign(manage, {
        log: silentLog,
        config: {},
        recordingIndex: {},
        recordingEvent: { emitFinishRecording: (reserve, recorded, isNeedDeleteReservation) => finished.push([reserve.id, recorded.id, isNeedDeleteReservation]) },
        recordedDB: {
            findAll: async () => [[{ id: 60, reserveId: 6, startAt, videoFiles: [] }, { id: 70, reserveId: 7, startAt, videoFiles: [] }], 2],
            removeRecording: async () => {},
            updateOnce: async () => {},
            findId: async id => ({ id, videoFiles: [] }),
        },
        reserveDB: { findId: async id => reserves[id] },
        provider: async () => ({
            setTimer: reserve => {
                timers.push(reserve.id);

                return true;
            },
        }),
    });

    await manage.cleanup();

    assert.deepStrictEqual(finished, [
        [6, 60, false],
        [7, 70, true],
    ]);
    assert.deepStrictEqual(timers, [6]);
    assert.deepStrictEqual(Object.keys(manage.recordingIndex), ['6']);
});

test('startup cleanup stores the restart time as the end of a part whose program duration is undetermined, and leaves a known end', async t => {
    const startAt = 1792576800000; // 2026-10-21 19:00 JST
    t.mock.timers.enable({ apis: ['Date'], now: startAt + 2 * 3600e3 + 754e3 }); // restarted at 21:12:34
    const reserves = {
        6: { id: 6, ruleId: null, programId: 327360102400123, startAt, endAt: startAt + 1 }, // overrunning, end not known yet
        8: { id: 8, ruleId: null, programId: 327360102400124, startAt, endAt: startAt + 3 * 3600e3 }, // on air until 22:00
    };
    const rows = {
        60: { id: 60, reserveId: 6, startAt, endAt: startAt + 1, duration: 1, isRecording: true, videoFiles: [] },
        80: { id: 80, reserveId: 8, startAt, endAt: startAt + 3 * 3600e3, duration: 3 * 3600e3, isRecording: true, videoFiles: [] },
    };
    const finished = [];
    const manage = Object.create(RecordingManageModel.prototype);
    Object.assign(manage, {
        log: silentLog,
        config: {},
        recordingIndex: {},
        recordingEvent: {
            emitFinishRecording: (reserve, recorded) => finished.push([recorded.id, recorded.endAt, recorded.duration]),
        },
        recordedDB: {
            findAll: async () => [Object.values(rows).map(r => ({ ...r })), 2],
            removeRecording: async id => {
                rows[id].isRecording = false;
            },
            // like the query builder's set(): only the columns given are written
            updateOnce: async recorded => {
                for (const [key, value] of Object.entries(recorded)) {
                    if (typeof value !== 'undefined') {
                        rows[recorded.id][key] = value;
                    }
                }
            },
            findId: async id => ({ ...rows[id] }),
        },
        reserveDB: { findId: async id => reserves[id] },
        provider: async () => ({ setTimer: () => true }),
    });

    await manage.cleanup();

    assert.deepStrictEqual(finished, [
        [60, 1792584754000, 7954000],
        [80, 1792587600000, 10800000],
    ]);
    assert.deepStrictEqual(Object.keys(manage.recordingIndex), ['6', '8']); // both still resume
    assert.strictEqual(reserves[6].endAt, startAt + 1); // the reservation still holds the undetermined end
});
