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

test('case-sensitive regex search on mysql compares characters, not bytes', () => {
    const mysql = Object.assign(Object.create(DBOperator.prototype), { config: { dbtype: 'mysql' } });
    const sqlite = Object.assign(Object.create(DBOperator.prototype), { config: { dbtype: 'sqlite' } });

    assert.strictEqual(`${mysql.getCSRegexpTarget('halfWidthName')} ${mysql.getRegexpStr(true)}`, 'halfWidthName COLLATE utf8mb4_bin regexp');
    assert.strictEqual(sqlite.getCSRegexpTarget('halfWidthName'), 'CAST(halfWidthName AS BINARY)');
});

test('isValidRegexp asks the database to evaluate the pattern', async () => {
    const queries = [];
    const op = Object.assign(Object.create(DBOperator.prototype), { config: { dbtype: 'mysql' } });
    op.connection = {
        query: async (sql, params) => {
            queries.push([sql, params]);
            if (params[0] === '(') {
                throw new Error("Regex error 'missing closing parenthesis'");
            }
        },
    };

    assert.strictEqual(await op.isValidRegexp('^ド.マ$'), true);
    assert.strictEqual(await op.isValidRegexp('('), false);
    assert.deepStrictEqual(queries[0], ["SELECT '' regexp ?", ['^ド.マ$']]);
});
