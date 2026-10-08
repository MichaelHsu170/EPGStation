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
