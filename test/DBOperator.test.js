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

    // CONVERT: utf8mb4_bin is valid only on utf8mb4, and older databases have utf8 (utf8mb3) columns
    assert.strictEqual(
        `${mysql.getCSRegexpTarget('halfWidthName')} ${mysql.getRegexpStr(true)}`,
        'CONVERT(halfWidthName USING utf8mb4) COLLATE utf8mb4_bin regexp',
    );
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

test('a call made while SQLite extensions are loading waits for them', async () => {
    let releaseExtensions;
    const op = createOperator(async () => ({ name: 'connection' }));
    op.setSQLiteExtensions = () => new Promise(resolve => (releaseExtensions = resolve));

    const first = op.getConnection();
    await new Promise(setImmediate);
    let secondDone = false;
    const second = op.getConnection().then(c => {
        secondDone = true;

        return c;
    });
    await new Promise(setImmediate);
    assert.strictEqual(secondDone, false);

    releaseExtensions();
    assert.strictEqual(await second, await first);
});

test('a connection whose SQLite extensions fail to load is closed and retried on the next call', async () => {
    const connections = [];
    const op = createOperator(async () => {
        const connection = { destroyed: false, destroy: async () => (connection.destroyed = true) };
        connections.push(connection);

        return connection;
    });
    op.setSQLiteExtensions = async connection => {
        if (connection === connections[0]) {
            throw new Error('failed to load extension');
        }
    };

    await assert.rejects(op.getConnection(), /failed to load extension/);
    assert.strictEqual(connections[0].destroyed, true);
    assert.strictEqual(await op.getConnection(), connections[1]);
});

test('LIKE search conditions per database', () => {
    const op = dbtype => Object.assign(Object.create(DBOperator.prototype), { config: { dbtype } });

    // utf8mb4_unicode_ci treats voiced and unvoiced kana as equal (ハ = パ); utf8mb4_0900_as_ci does not
    assert.strictEqual(op('mysql').getLikeQuery('halfWidthName', 'v', false), "halfWidthName like :v collate utf8mb4_0900_as_ci escape '!'");
    assert.strictEqual(op('mysql').getLikeQuery('halfWidthName', 'v', true), "halfWidthName like binary :v escape '!'");
    assert.strictEqual(op('postgres').getLikeQuery('halfWidthName', 'v', false), "halfWidthName ilike :v escape '!'");
    assert.strictEqual(op('postgres').getLikeQuery('halfWidthName', 'v', true), "halfWidthName like :v escape '!'");
    assert.strictEqual(op('sqlite').getLikeQuery('halfWidthName', 'v', false), "halfWidthName like :v escape '!'");
});

test('a LIKE keyword matches its % _ and ! literally', () => {
    const op = Object.assign(Object.create(DBOperator.prototype), { config: { dbtype: 'mysql' } });

    assert.strictEqual(op.getLikeValue('100%'), '%100!%%');
    assert.strictEqual(op.getLikeValue('A_B!'), '%A!_B!!%');
    assert.strictEqual(op.getLikeValue('ドラマ'), '%ドラマ%');
});
