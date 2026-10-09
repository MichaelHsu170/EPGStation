require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { DataSource } = require('typeorm');
const DBOperator = require('../dist/model/db/DBOperator').default;
const RecordedTagDB = require('../dist/model/db/RecordedTagDB').default;

/**
 * RecordedTagDB over an in-memory sqlite database with the real entities
 */
const createDB = async t => {
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

    return { connection, db: new RecordedTagDB(op, { run: fn => fn() }) };
};

const insertRecorded = async connection => {
    await connection.query(
        `INSERT INTO recorded (id, channelId, isProtected, startAt, endAt, duration, name, halfWidthName, isRecording)
         VALUES (1, 100, 0, 0, 1000, 1000, 'n', 'n', 1)`,
    );
};

const isRecording = async connection => (await connection.query('SELECT isRecording FROM recorded WHERE id = 1'))[0].isRecording;

test('tag name search treats % and _ in the keyword literally', async t => {
    const { db } = await createDB(t);
    for (const name of ['100%', '1000', 'A_B', 'AxB', 'Hi!', 'Hi']) {
        await db.insertOnce({ name, halfWidthName: name, color: 'red' });
    }

    const names = async keyword => (await db.findAll({ name: keyword }))[0].map(tag => tag.name).sort();

    // full-width ％ and ＿ become % and _ when the keyword is made half-width
    assert.deepStrictEqual(await names('100％'), ['100%']);
    assert.deepStrictEqual(await names('Ａ＿Ｂ'), ['A_B']);
    assert.deepStrictEqual(await names('Hi!'), ['Hi!']);
    assert.deepStrictEqual(await names('Hi'), ['Hi', 'Hi!']);
});

test('changing tags does not write back recording fields that changed after the recording was read', async t => {
    const { connection, db } = await createDB(t);
    await insertRecorded(connection);
    const tagId = await db.insertOnce({ name: 'tag', halfWidthName: 'tag', color: 'red' });
    // the recording ends right after the tag change has read the recording
    const findRecorded = db.findRecorded.bind(db);
    db.findRecorded = async recordedId => {
        const recorded = await findRecorded(recordedId);
        await connection.query('UPDATE recorded SET isRecording = 0 WHERE id = 1');

        return recorded;
    };
    const tagIds = async () => (await connection.query('SELECT * FROM recorded_tags_recorded_tag')).map(r => r.recordedTagId);

    await db.setRelation(tagId, 1);
    assert.strictEqual(await isRecording(connection), 0);
    assert.deepStrictEqual(await tagIds(), [tagId]);

    // adding the same tag again keeps one link
    await connection.query('UPDATE recorded SET isRecording = 1 WHERE id = 1');
    await db.setRelation(tagId, 1);
    assert.strictEqual(await isRecording(connection), 0);
    assert.deepStrictEqual(await tagIds(), [tagId]);

    await connection.query('UPDATE recorded SET isRecording = 1 WHERE id = 1');
    await db.deleteRelation(tagId, 1);
    assert.strictEqual(await isRecording(connection), 0);
    assert.deepStrictEqual(await tagIds(), []);

    await db.setRelation(tagId, 1);
    await connection.query('UPDATE recorded SET isRecording = 1 WHERE id = 1');
    await db.deleteAllRelation(1);
    assert.strictEqual(await isRecording(connection), 0);
    assert.deepStrictEqual(await tagIds(), []);
});

test('tag changes on a missing recording or tag fail as before', async t => {
    const { connection, db } = await createDB(t);
    await insertRecorded(connection);

    await assert.rejects(db.setRelation(99, 1), /RecordedTagIsUndefined/);
    await assert.rejects(db.setRelation(1, 99), /RecordedIsUndefined/);
    await assert.rejects(db.deleteRelation(1, 99), /RecordedIsUndefined/);
    await assert.rejects(db.deleteAllRelation(99), /RecordedIsUndefined/);
});
