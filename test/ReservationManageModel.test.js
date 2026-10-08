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
