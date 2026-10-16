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

const H = 60 * 60 * 1000;

test('a manual time reservation whose end is not after its start is refused', async () => {
    const start = Date.now() + 24 * H;
    const looked = [];
    const model = createModel({
        // a valid time gets past the time check to the duplicate lookup, which reports an existing reservation
        reserveDB: { findTimeSpecification: async o => (looked.push(o), {}) },
    });
    const option = (startAt, endAt) => ({
        allowEndLack: true,
        timeSpecifiedOption: { name: 'n', channelId: 1, startAt, endAt },
    });

    await assert.rejects(model.createManualReserveWithSpecifiedTime(option(start, start)), /TimeSpecifiedOptionError/);
    await assert.rejects(
        model.createManualReserveWithSpecifiedTime(option(start + H, start)),
        /TimeSpecifiedOptionError/,
    );
    assert.deepStrictEqual(looked, []);

    await assert.rejects(
        model.createManualReserveWithSpecifiedTime(option(start, start + 1)),
        /AddReservationConflictError/,
    );
    assert.strictEqual(looked.length, 1);
});

test('a reservation whose end comes before its start does not drop another one from the conflict check', () => {
    const model = createModel({ log: { system: { ...silentLog.system, debug: () => {} } } });
    model.setTuners([{ name: 't0', types: ['GR'] }]);
    const T0 = Date.UTC(2026, 9, 11, 1);
    const reserve = r => ({
        isSkip: false,
        isOverlap: false,
        isConflict: false,
        isTimeSpecified: false,
        channelType: 'GR',
        updateTime: 1,
        ...r,
    });

    const result = model.createReserves([
        reserve({ id: 1, ruleId: 1, programId: 101, channel: '23', startAt: T0, endAt: T0 + 2 * H }),
        // a zero-length program: its end sorts before its start
        reserve({ id: 2, ruleId: 9, programId: 102, channel: '25', startAt: T0 + H / 2, endAt: T0 + H / 2 }),
        reserve({ id: 3, ruleId: 2, programId: 103, channel: '24', startAt: T0 + H, endAt: T0 + 1.5 * H }),
    ]);

    // one tuner: rule 1 (id 1) and rule 2 (id 3) overlap on different channels, and rule 1 has priority
    const conflicts = Object.fromEntries(result.map(r => [r.id, r.isConflict]));
    assert.strictEqual(conflicts[1], false);
    assert.strictEqual(conflicts[3], true);
});

test('startup cleanup deletes the reservations that are over, except one whose recording was resumed', async () => {
    const deleted = [];
    const emitted = [];
    const old = [
        { id: 6, programId: 40010101444, startAt: 1000, endAt: 1001 }, // resumed: its duration is undetermined
        { id: 7, programId: 40010101445, startAt: 1000, endAt: 2000 },
    ];
    const model = createModel({
        reserveDB: {
            findOldTime: async () => old,
            updateMany: async values => deleted.push(...values.delete.map(r => r.id)),
        },
        reserveEvent: { emitUpdated: values => emitted.push(...values.delete.map(r => r.id)) },
    });

    await model.cleanup(reserveId => reserveId === 6);

    assert.deepStrictEqual(deleted, [7]);
    assert.deepStrictEqual(emitted, [7]);
    await assertLockReleased(model);
});

/**
 * Rule 1 (keyword search) whose search returns `search.found`, with the reservations in a store that the updates
 * change. Reservations: 1 is recording a program in an undetermined overrun whose row the old-program cleanup has
 * deleted; 2 is recording one whose row still says 1 ms; 3 is recording past the known end of its program; 4 has
 * started but is not recording (skipped); 5 is a future reservation that is armed but whose program row is gone.
 */
const ruleUpdateModel = (search, emitted) => {
    const now = Date.now();
    const reserve = (id, programId, startAt, endAt, r = {}) => ({
        id,
        ruleId: 1,
        ruleUpdateCnt: 0,
        programId,
        programUpdateTime: 10,
        updateTime: 10,
        channel: '23',
        channelType: 'GR',
        startAt,
        endAt,
        isSkip: false,
        isConflict: false,
        isOverlap: false,
        isIgnoreOverlap: false,
        isTimeSpecified: false,
        isEventRelay: false,
        ...r,
    });
    let store = [
        reserve(1, 501, now - H, now - 10 * 60e3),
        reserve(2, 502, now - H, now - H + 1),
        reserve(3, 503, now - H, now - 60e3),
        reserve(4, 504, now - H, now - 10 * 60e3, { isSkip: true }),
        reserve(5, 505, now + H, now + 2 * H),
    ];
    const rows = { 502: { id: 502, duration: 1 }, 503: { id: 503, duration: H - 60e3 } };
    const model = createModel({
        log: { system: { ...silentLog.system, debug: () => {} } },
        ruleDB: {
            findId: async () => ({
                id: 1,
                updateCnt: 0,
                isTimeSpecification: false,
                reserveOption: { enable: true, allowEndLack: true },
                searchOption: { keyword: 'x' },
            }),
        },
        reserveDB: {
            findRuleId: async () => store.map(r => ({ ...r })),
            findTimeRanges: async () => [],
            updateMany: async d => {
                const gone = d.delete.map(r => r.id);
                store = store.filter(r => !gone.includes(r.id));
                for (const u of d.update) store = store.map(r => (r.id === u.id ? { ...u } : r));
                for (const n of d.insert) store.push({ ...n, id: 100 + store.length });
            },
        },
        programDB: { findRule: async () => search.found, findId: async id => rows[id] ?? null },
        recordingManageModel: { hasReserve: id => [1, 2, 3, 5].includes(id) },
        reserveEvent: { emitUpdated: d => emitted.push(d) },
    });
    model.setTuners([{ name: 't0', types: ['GR'] }]);

    return { model, getStore: () => store };
};

const diffIds = d => ({
    insert: d.insert.map(r => r.programId),
    update: d.update.map(r => r.id),
    delete: d.delete.map(r => r.id).sort(),
});

test('a rule update keeps a recording reservation whose program is in an undetermined overrun', async () => {
    const emitted = [];
    const { model, getStore } = ruleUpdateModel({ found: [] }, emitted);

    await model.updateRule(1, true);

    // 1 and 2 keep recording; an ended program with a known end (3), a skipped one (4) and a future one whose
    // program is gone (5) are deleted as before
    assert.deepStrictEqual(diffIds(emitted[0]), { insert: [], update: [], delete: [3, 4, 5] });
    assert.deepStrictEqual(getStore().map(r => r.id), [1, 2]);
    await assertLockReleased(model);
});

test('when the real end of the overrun arrives, the same rule reservation takes it', async () => {
    const emitted = [];
    const search = { found: [] };
    const { model, getStore } = ruleUpdateModel(search, emitted);
    await model.updateRule(1, true); // during the overrun

    const realEnd = Date.now() + 20 * 60e3;
    search.found = [
        {
            id: 501,
            updateTime: 20,
            channel: '23',
            channelType: 'GR',
            startAt: Date.now() - H,
            endAt: realEnd,
            overlap: false,
        },
    ];
    await model.updateRule(1, true);

    // reservation 1 is updated (its recorder follows it), not deleted and reserved again
    assert.deepStrictEqual(diffIds(emitted[1]), { insert: [], update: [1], delete: [] });
    assert.deepStrictEqual(
        getStore()
            .filter(r => r.programId === 501)
            .map(r => [r.id, r.endAt]),
        [[1, realEnd]],
    );
});

/**
 * Runs the test in Japan time (as the live container, TZ=Asia/Tokyo) with the clock at `iso`.
 */
const inJapanAt = (t, iso) => {
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    t.after(() => {
        if (typeof tz === 'undefined') {
            delete process.env.TZ;
        } else {
            process.env.TZ = tz;
        }
    });
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
};

/**
 * Time-specified rule 1: Fridays 23:00 for 2 hours on channel 1, with its reservations in a store that the update
 * changes. `slots` are the start times (Japan time) of the reservations already stored.
 */
const timeRuleModel = (slots, emitted) => {
    let store = slots.map((start, i) => ({
        id: i + 1,
        ruleId: 1,
        ruleUpdateCnt: 0,
        programId: null,
        isTimeSpecified: true,
        channelId: 1,
        channel: '23',
        channelType: 'GR',
        startAt: Date.parse(start),
        endAt: Date.parse(start) + 2 * H,
        isSkip: false,
        isConflict: false,
        isOverlap: false,
        isIgnoreOverlap: false,
        isEventRelay: false,
        updateTime: 1,
    }));
    const model = createModel({
        log: { system: { ...silentLog.system, debug: () => {} } },
        ruleDB: {
            findId: async () => ({
                id: 1,
                updateCnt: 0,
                isTimeSpecification: true,
                reserveOption: { enable: true, allowEndLack: true },
                searchOption: {
                    keyword: 'late show',
                    channelIds: [1],
                    times: [{ week: 0x20, start: 23 * 3600, range: 2 * 3600 }],
                },
            }),
        },
        channelDB: { findId: async () => ({ id: 1, channel: '23', channelType: 'GR' }) },
        reserveDB: {
            findRuleId: async () => store.map(r => ({ ...r })),
            findTimeRanges: async () => [],
            updateMany: async d => {
                const gone = d.delete.map(r => r.id);
                store = store.filter(r => !gone.includes(r.id));
                for (const n of d.insert) store.push({ ...n, id: 100 + store.length });
            },
        },
        reserveEvent: { emitUpdated: d => emitted.push(d) },
    });
    model.setTuners([{ name: 't0', types: ['GR'] }]);

    return { model, getSlots: () => store.map(r => new Date(r.startAt).toISOString()).sort() };
};

test('a time-specified rule recording that crosses midnight is kept by the first rule update after midnight', async t => {
    // Saturday 00:05, while the Friday 10-16 23:00-01:00 slot records
    inJapanAt(t, '2026-10-17T00:05:00+09:00');
    const emitted = [];
    const { model, getSlots } = timeRuleModel(['2026-10-16T23:00:00+09:00', '2026-10-23T23:00:00+09:00'], emitted);

    await model.updateRule(1, true);

    assert.deepStrictEqual(diffIds(emitted[0]), { insert: [], update: [], delete: [] });
    assert.deepStrictEqual(getSlots(), ['2026-10-16T14:00:00.000Z', '2026-10-23T14:00:00.000Z']);
});

test('a time-specified rule slot that has ended is not reserved again', async t => {
    // Saturday 01:30: the Friday 10-16 slot ended at 01:00
    inJapanAt(t, '2026-10-17T01:30:00+09:00');
    const emitted = [];
    const { model, getSlots } = timeRuleModel(['2026-10-23T23:00:00+09:00'], emitted);

    await model.updateRule(1, true);

    assert.deepStrictEqual(diffIds(emitted[0]), { insert: [], update: [], delete: [] });
    assert.deepStrictEqual(getSlots(), ['2026-10-23T14:00:00.000Z']);
});

/**
 * Keyword rule 1 whose search finds programs 601 and 602, and a manual reservation (7) of program 601, in a store
 * that the updates change.
 */
const manualAndRuleModel = emitted => {
    const now = Date.now();
    const program = (id, startAt) => ({
        id,
        updateTime: 10,
        channel: '23',
        channelType: 'GR',
        startAt,
        endAt: startAt + H,
        overlap: false,
    });
    const found = [program(601, now + H), program(602, now + 3 * H)];
    let store = [
        {
            id: 7,
            ruleId: null,
            programId: 601,
            programUpdateTime: 10,
            updateTime: 5,
            channel: '23',
            channelType: 'GR',
            startAt: now + H,
            endAt: now + 2 * H,
            isSkip: false,
            isConflict: false,
            isOverlap: false,
            isTimeSpecified: false,
            isEventRelay: false,
        },
    ];
    const model = createModel({
        log: { system: { ...silentLog.system, debug: () => {} } },
        ruleDB: {
            findId: async () => ({
                id: 1,
                updateCnt: 0,
                isTimeSpecification: false,
                reserveOption: { enable: true, allowEndLack: true },
                searchOption: { keyword: 'x' },
            }),
        },
        reserveDB: {
            findRuleId: async () => store.filter(r => r.ruleId === 1).map(r => ({ ...r })),
            findTimeRanges: async () => store.filter(r => r.ruleId !== 1).map(r => ({ ...r })),
            updateMany: async d => {
                const gone = d.delete.map(r => r.id);
                store = store.filter(r => !gone.includes(r.id));
                for (const n of d.insert) store.push({ ...n, id: 100 + store.length });
            },
        },
        programDB: { findRule: async () => found },
        recordingManageModel: { hasReserve: () => false },
        reserveEvent: { emitUpdated: d => emitted.push(d) },
    });
    model.setTuners([{ name: 't0', types: ['GR'] }]);

    return {
        model,
        cancelManual: () => (store = store.filter(r => r.id !== 7)),
        getStore: () => store.map(r => [r.programId, r.ruleId]).sort(),
    };
};

test('a rule does not reserve a program again that is already reserved manually', async () => {
    const emitted = [];
    const { model, getStore } = manualAndRuleModel(emitted);

    await model.updateRule(1, true);

    assert.deepStrictEqual(diffIds(emitted[0]), { insert: [602], update: [], delete: [] });
    assert.deepStrictEqual(getStore(), [
        [601, null],
        [602, 1],
    ]);
});

test('after the manual reservation is cancelled, the next rule update reserves the program', async () => {
    const emitted = [];
    const { model, cancelManual, getStore } = manualAndRuleModel(emitted);
    await model.updateRule(1, true);

    cancelManual();
    await model.updateRule(1, true);

    assert.deepStrictEqual(diffIds(emitted[1]), { insert: [601], update: [], delete: [] });
    assert.deepStrictEqual(getStore(), [
        [601, 1],
        [602, 1],
    ]);
});

test('a program that one rule skips is still reserved by another rule', () => {
    const model = createModel({ log: { system: { ...silentLog.system, debug: () => {} } } });
    model.setTuners([{ name: 't0', types: ['GR'] }]);
    const T0 = Date.UTC(2026, 9, 11, 1);
    const reserve = r => ({
        programId: 701,
        channel: '23',
        channelType: 'GR',
        startAt: T0,
        endAt: T0 + H,
        isSkip: false,
        isOverlap: false,
        isConflict: false,
        isTimeSpecified: false,
        updateTime: 1,
        ...r,
    });

    const result = model.createReserves([reserve({ id: 1, ruleId: 1, isSkip: true }), reserve({ id: 2, ruleId: 2 })]);

    assert.deepStrictEqual(
        result.map(r => [r.id, r.isSkip, r.isConflict]),
        [
            [1, true, false],
            [2, false, false],
        ],
    );
});
