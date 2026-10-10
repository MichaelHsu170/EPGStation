require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const ProgramDB = require('../dist/model/db/ProgramDB').default;

test('a program with an empty genre list is stored without genres', () => {
    const db = Object.create(ProgramDB.prototype);
    db.config = { needToReplaceEnclosingCharacters: false };
    const channelTypes = { 1: { 2: { id: 100, type: 'GR', channel: '27' } } };

    const value = db.createProgramValue(
        channelTypes,
        { id: 1, eventId: 1, serviceId: 2, networkId: 1, startAt: 0, duration: 1000, isFree: true, name: 'n', genres: [] },
        0,
    );

    assert.strictEqual(value.genre1, null);
    assert.strictEqual(value.genre2, null);
    assert.strictEqual(value.genre3, null);
});

test('a case-sensitive regex keyword is searched through the database operator', () => {
    const db = Object.create(ProgramDB.prototype);
    db.op = { getRegexpStr: () => 'regexp', getCSRegexpTarget: column => `${column} COLLATE utf8mb4_bin` };
    const query = { strs: [], param: {} };

    db.setKeywordOption('^ド.マ$', { cs: true, regexp: true, name: true, description: true, extended: false }, 'keyword', false, query);

    assert.deepStrictEqual(query.param, { keywordRegexp: '^ド.マ$' });
    assert.strictEqual(query.strs.length, 1);
    assert.ok(query.strs[0].includes('halfWidthName COLLATE utf8mb4_bin regexp :keywordRegexp'), query.strs[0]);
    assert.ok(query.strs[0].includes("COALESCE(halfWidthDescription,'') COLLATE utf8mb4_bin regexp :keywordRegexp"), query.strs[0]);
    assert.ok(!query.strs[0].includes('AS BINARY'), query.strs[0]);
});

test('avoid duplicates compares program and recorded history titles through the database operator', () => {
    const db = Object.create(ProgramDB.prototype);
    db.op = { getEqualQuery: (a, b) => `${a} = ${b} COLLATE x` };

    const str = db.createOverlapQueryStr(0);

    assert.ok(str.includes('where P.shortName = R.name COLLATE x and P.channelId = R.channelId '), str);
});
