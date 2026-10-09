require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const ExecutionManagementModel = require('../dist/model/ExecutionManagementModel').default;
const ReservationManageModel = require('../dist/model/operator/reservation/ReservationManageModel').default;

const silentLog = { system: { info: () => {}, warn: () => {}, error: () => {} } };

/**
 * ReservationManageModel with a real lock and only the members the tested paths read.
 */
const createModel = members => {
    const model = Object.create(ReservationManageModel.prototype);
    model.log = silentLog;
    model.executeManagementModel = new ExecutionManagementModel({ getLogger: () => silentLog });

    return Object.assign(model, members);
};

/**
 * The lock is free again when another caller can take it right away.
 */
const assertLockReleased = async model => {
    const id = await model.executeManagementModel.getExecution(1, 100);
    model.executeManagementModel.unLockExecution(id);
};

test('edit releases the lock when the option check fails', async () => {
    const model = createModel({ checkManualReserveOption: () => false });

    await assert.rejects(model.edit(1, {}), /ReservationEditError/);
    await assertLockReleased(model);
});

test('updateRule releases the lock when reading the rule fails', async () => {
    const model = createModel({ ruleDB: { findId: async () => Promise.reject(new Error('db down')) } });

    await assert.rejects(model.updateRule(1), /db down/);
    await assertLockReleased(model);
});

test('updateRule releases the lock when a time-specified rule has a time without start', async () => {
    const model = createModel({
        ruleDB: {
            findId: async () => ({
                id: 1,
                isTimeSpecification: true,
                reserveOption: { enable: true },
                searchOption: { keyword: 'x', channelIds: [1], times: [{ week: 0x7f }] },
            }),
        },
        reserveDB: { findRuleId: async () => [] },
    });

    await assert.rejects(model.updateRule(1), /RuleSearchTimesOptionError/);
    await assertLockReleased(model);
});

test('event relays for the same program added at the same time reserve it once', async () => {
    const inserted = [];
    const model = createModel({
        reserveDB: {
            findProgramId: async programId => inserted.filter(r => r.programId === programId),
            insertOnce: async reserve => {
                inserted.push(reserve);

                return inserted.length;
            },
        },
        createEventRelayReserve: async programId => ({ programId }),
        checkSingleReserveConflict: async () => {},
        reserveEvent: { emitUpdated: () => {} },
    });

    const results = await Promise.all([model.addEventRelay(9, { id: 1 }), model.addEventRelay(9, { id: 1 })]);

    assert.strictEqual(inserted.length, 1);
    assert.deepStrictEqual(results.sort(), [1, null].sort());
    await assertLockReleased(model);
});

test('adding a reservation with an invalid encode mode is refused', async () => {
    const model = createModel({ optionChecker: { checkEncodeOption: () => false } });

    await assert.rejects(model.add({ programId: 1, encodeOption: { mode1: 'nope', isDeleteOriginalAfterEncode: false } }), /AddReservationOptionError/);
});

/**
 * Startup reservation update with a manual time-specified reservation still to come (7), one already over (8),
 * a manual program reservation (9) and nothing else. getManualIds applies ReserveDB's programId filter.
 */
const startupUpdateModel = emitted => {
    const now = Date.now();
    const reserves = [
        { id: 7, ruleId: null, programId: null, startAt: now + 3600e3, endAt: now + 7200e3 },
        { id: 8, ruleId: null, programId: null, startAt: now - 7200e3, endAt: now - 3600e3 },
        { id: 9, ruleId: null, programId: 123, startAt: now + 3600e3, endAt: now + 7200e3 },
    ];

    return createModel({
        config: { isSuppressReservesUpdateAllLog: true },
        reserveDB: {
            getManualIds: async o => reserves.filter(r => o.hasTimeReserve || r.programId !== null).map(r => r.id),
            getRuleEventRelayIds: async () => [],
            findId: async id => reserves.find(r => r.id === id) ?? null,
        },
        ruleDB: { getIds: async () => [] },
        programDB: { findId: async () => null },
        reserveEvent: { emitUpdated: d => emitted.push(d) },
    });
};

test('the first reservation update after startup arms the pending manual time-specified reservations', async () => {
    const emitted = [];
    await startupUpdateModel(emitted).updateAll(true);

    assert.deepStrictEqual(
        emitted.map(d => ({ insert: d.insert, update: d.update?.map(r => r.id), delete: d.delete })),
        [{ insert: undefined, update: [7], delete: undefined }],
    );
});

test('later reservation updates do not re-arm manual time-specified reservations', async () => {
    const emitted = [];
    await startupUpdateModel(emitted).updateAll(false);

    assert.deepStrictEqual(emitted, []);
});
