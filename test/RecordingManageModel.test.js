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
