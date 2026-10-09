// a device outside Japan (UTC-5 in January); set before any Date is used
process.env.TZ = 'America/New_York';

require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const DateUtil = require('../test-build/util/DateUtil').default;
const ManualReserveState = require('../test-build/model/state/reserve/manual/ManualReserveState').default;

// 2024-01-15 20:00 and 20:54 JST
const startAt = 1705316400000;
const endAt = 1705319640000;

test('the test runs in a time zone other than JST', () => {
    assert.strictEqual(new Date(startAt).getTimezoneOffset(), 300);
});

test('getTimeFromJaDate turns a date from getJaDate back into the original time', () => {
    const jaDate = DateUtil.getJaDate(new Date(startAt));

    assert.strictEqual(DateUtil.format(jaDate, 'yyyy/MM/dd hh:mm'), '2024/01/15 20:00');
    assert.strictEqual(DateUtil.getTimeFromJaDate(jaDate), startAt);
});

test('getTimeFromJaDate reads a date entered as 20:00 as 20:00 JST', () => {
    // what the date time picker returns when 2024-01-15 20:00 is chosen on this device
    assert.strictEqual(DateUtil.getTimeFromJaDate(new Date(2024, 0, 15, 20, 0)), startAt);
});

test('a time specified reservation is shown and saved in JST on a device outside Japan', async () => {
    const added = [];
    const state = new ManualReserveState(null, { add: async option => added.push(option) }, null, null, null);
    state.setOptions({ isTimeSpecified: true, name: 'News', channelId: 1, startAt, endAt, allowEndLack: true });

    // the picker shows the JST time
    assert.strictEqual(DateUtil.format(state.timeSpecifiedOption.startAt, 'MM/dd hh:mm'), '01/15 20:00');
    assert.strictEqual(DateUtil.format(state.timeSpecifiedOption.endAt, 'MM/dd hh:mm'), '01/15 20:54');

    await state.addReserve();

    assert.deepStrictEqual(added[0].timeSpecifiedOption, { name: 'News', channelId: 1, startAt, endAt });
});

test('a time entered in the picker is reserved at that JST time', async () => {
    const added = [];
    const state = new ManualReserveState(null, { add: async option => added.push(option) }, null, null, null);
    state.isTimeSpecification = true;
    state.timeSpecifiedOption = { name: 'News', channelId: 1, startAt: new Date(2024, 0, 15, 20, 0), endAt: new Date(2024, 0, 15, 20, 54) };

    await state.addReserve();

    assert.strictEqual(added[0].timeSpecifiedOption.startAt, startAt);
    assert.strictEqual(added[0].timeSpecifiedOption.endAt, endAt);
});

test('switching a program reservation to time specified fills in the JST times', () => {
    const state = new ManualReserveState(null, null, null, null, null);
    state.programInfo = { programItem: { name: 'News', channelId: 1, startAt, endAt } };

    state.setTimeSpecifiedOption();

    assert.strictEqual(DateUtil.format(state.timeSpecifiedOption.startAt, 'MM/dd hh:mm'), '01/15 20:00');
    assert.strictEqual(DateUtil.format(state.timeSpecifiedOption.endAt, 'MM/dd hh:mm'), '01/15 20:54');
});

// New York changes to daylight saving time on 2026-03-08 at 07:00 UTC and back on 2026-11-01 at 06:00 UTC

test('getJaDate shows the JST time when the shift crosses the change to daylight saving time', () => {
    const time = Date.parse('2026-03-07T20:00:00Z'); // 2026-03-08 05:00 JST
    const jaDate = DateUtil.getJaDate(new Date(time));

    assert.strictEqual(DateUtil.format(jaDate, 'yyyy/MM/dd hh:mm'), '2026/03/08 05:00');
    assert.strictEqual(DateUtil.getTimeFromJaDate(jaDate), time);
});

test('getJaDate shows the JST time when the shift crosses the change back to standard time', () => {
    const time = Date.parse('2026-10-31T17:00:00Z'); // 2026-11-01 02:00 JST
    const jaDate = DateUtil.getJaDate(new Date(time));

    assert.strictEqual(DateUtil.format(jaDate, 'yyyy/MM/dd hh:mm'), '2026/11/01 02:00');
    assert.strictEqual(DateUtil.getTimeFromJaDate(jaDate), time);
});

test('getTimeFromJaDate reads a time entered on a daylight saving time change day as JST', () => {
    assert.strictEqual(DateUtil.getTimeFromJaDate(new Date(2026, 2, 8, 5, 0)), Date.parse('2026-03-07T20:00:00Z'));
    assert.strictEqual(DateUtil.getTimeFromJaDate(new Date(2026, 10, 1, 2, 0)), Date.parse('2026-10-31T17:00:00Z'));
});

test('restoreDate turns a date that went through JSON back into the same Date', () => {
    const restored = DateUtil.restoreDate(JSON.parse(JSON.stringify({ startAt: new Date(startAt) })).startAt);

    assert.ok(restored instanceof Date);
    assert.strictEqual(restored.getTime(), startAt);
});

test('restoreDate keeps a Date and null as they are', () => {
    const date = new Date(startAt);

    assert.strictEqual(DateUtil.restoreDate(date), date);
    assert.strictEqual(DateUtil.restoreDate(null), null);
});

test('a time reservation restored from saved page info after a reload is saved at its time', async () => {
    const added = [];
    const state = new ManualReserveState(null, { add: async option => added.push(option) }, null, null, null);
    state.isTimeSpecification = true;
    const saved = JSON.parse(JSON.stringify({ name: 'News', channelId: 1, startAt: new Date(2024, 0, 15, 20, 0), endAt: new Date(2024, 0, 15, 20, 54) }));
    state.timeSpecifiedOption = { ...saved, startAt: DateUtil.restoreDate(saved.startAt), endAt: DateUtil.restoreDate(saved.endAt) };

    await state.addReserve();

    assert.strictEqual(added[0].timeSpecifiedOption.startAt, startAt);
    assert.strictEqual(added[0].timeSpecifiedOption.endAt, endAt);
});
