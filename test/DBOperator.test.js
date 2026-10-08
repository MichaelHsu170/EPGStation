require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const DBOperator = require('../dist/model/db/DBOperator').default;

const createOperator = createConnection => {
    const op = Object.create(DBOperator.prototype);
    op.connection = null;
    op.connecting = null;
    op.createConnection = createConnection;
    op.setSQLiteExtensions = async () => {};

    return op;
};

test('concurrent first calls share one database connection', async () => {
    let created = 0;
    const op = createOperator(async () => {
        created++;
        await new Promise(setImmediate);

        return { name: `connection ${created}` };
    });

    const [a, b] = await Promise.all([op.getConnection(), op.getConnection()]);

    assert.strictEqual(created, 1);
    assert.strictEqual(a, b);
    assert.strictEqual(await op.getConnection(), a);
});

test('a failed connection is retried on the next call', async () => {
    let attempts = 0;
    const op = createOperator(async () => {
        attempts++;
        if (attempts === 1) {
            throw new Error('db down');
        }

        return { name: 'connection' };
    });

    await assert.rejects(op.getConnection(), /db down/);
    assert.deepStrictEqual(await op.getConnection(), { name: 'connection' });
});
