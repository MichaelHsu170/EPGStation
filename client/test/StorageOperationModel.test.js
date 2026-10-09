require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const StorageOperationModel = require('../test-build/model/storage/StorageOperationModel').default;

/**
 * Replaces window.localStorage for one test: items is the stored strings, or null for a storage
 * whose every access throws (blocked by the browser).
 */
const useLocalStorage = (t, items) => {
    const storage =
        items === null
            ? {
                  getItem: () => {
                      throw new Error('SecurityError');
                  },
                  setItem: () => {
                      throw new Error('SecurityError');
                  },
              }
            : {
                  getItem: key => (typeof items[key] === 'undefined' ? null : items[key]),
                  setItem: (key, value) => (items[key] = value),
              };
    global.window = { localStorage: storage };
    t.after(() => delete global.window);
    t.mock.method(console, 'error', () => {});
};

test('get returns the saved object', t => {
    useLocalStorage(t, { settings: '{"a":1}' });

    assert.deepStrictEqual(new StorageOperationModel().get('settings'), { a: 1 });
    assert.strictEqual(new StorageOperationModel().get('missing'), null);
});

test('get returns null for a value that is not JSON, so the defaults replace it', t => {
    useLocalStorage(t, { settings: 'not json{' });

    assert.strictEqual(new StorageOperationModel().get('settings'), null);
});

test('get returns null for a JSON value that is not an object (saved by another app on the same origin)', t => {
    useLocalStorage(t, { a: '42', b: '"text"', c: 'true', d: 'null' });
    const op = new StorageOperationModel();

    assert.strictEqual(op.get('a'), null);
    assert.strictEqual(op.get('b'), null);
    assert.strictEqual(op.get('c'), null);
    assert.strictEqual(op.get('d'), null);
});

test('with blocked storage each key keeps its own value', t => {
    useLocalStorage(t, null);
    const op = new StorageOperationModel();

    assert.strictEqual(op.get('settings'), null);
    op.set('settings', { a: 1 });
    op.set('guideSize', { b: 2 });

    assert.deepStrictEqual(op.get('settings'), { a: 1 });
    assert.deepStrictEqual(op.get('guideSize'), { b: 2 });
    assert.strictEqual(op.get('genre'), null);
});

test('with blocked storage a returned value is a copy, so changing it does not change the saved value', t => {
    useLocalStorage(t, null);
    const op = new StorageOperationModel();

    op.set('settings', { a: 1 });
    op.get('settings').a = 2;

    assert.deepStrictEqual(op.get('settings'), { a: 1 });
});
