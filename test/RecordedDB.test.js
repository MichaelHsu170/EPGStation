require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { DataSource } = require('typeorm');
const DBOperator = require('../dist/model/db/DBOperator').default;
const RecordedDB = require('../dist/model/db/RecordedDB').default;

test('findOld returns the recording that was broadcast first, not the lowest id', async t => {
    const connection = new DataSource({
        type: 'sqlite',
        database: ':memory:',
        entities: [path.join(__dirname, '..', 'dist', 'db', 'entities', '*.js')],
        synchronize: true,
        logging: false,
    });
    await connection.initialize();
    t.after(() => connection.destroy());
    const op = Object.assign(Object.create(DBOperator.prototype), { config: { dbtype: 'sqlite' }, connection });
    const db = Object.assign(Object.create(RecordedDB.prototype), { op, promieRetry: { run: fn => fn() } });

    // id 1 was broadcast later than id 2 (e.g. id 2 is an older program uploaded afterwards); id 3 is protected
    for (const [id, startAt, isProtected] of [
        [1, 2000, 0],
        [2, 1000, 0],
        [3, 500, 1],
    ]) {
        await connection.query(
            `INSERT INTO recorded (id, channelId, isProtected, startAt, endAt, duration, name, halfWidthName, isRecording)
             VALUES (${id}, 100, ${isProtected}, ${startAt}, ${startAt + 100}, 100, 'n', 'n', 0)`,
        );
    }

    assert.strictEqual((await db.findOld()).id, 2);
});
