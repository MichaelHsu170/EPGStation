const test = require('node:test');
const assert = require('node:assert');
const DateUtil = require('../test-build/util/DateUtil').default;

// v-date-picker passes each day cell to day-format as 'YYYY-MM-DD'
for (const [tz, offset] of [
    ['America/New_York', 240],
    ['Asia/Tokyo', -540],
]) {
    test(`getDayOfMonth labels the date picker day cells with their own day in ${tz}`, () => {
        process.env.TZ = tz;
        // the zone took effect (2026-10-09 is in daylight saving time in New York)
        assert.strictEqual(new Date(2026, 9, 9).getTimezoneOffset(), offset);

        assert.strictEqual(DateUtil.getDayOfMonth('2026-10-09'), 9);
        assert.strictEqual(DateUtil.getDayOfMonth('2026-11-01'), 1);
        assert.strictEqual(DateUtil.getDayOfMonth('2026-12-31'), 31);
    });
}
