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
