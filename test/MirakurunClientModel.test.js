require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const MirakurunClientModel = require('../dist/model/MirakurunClientModel').default;

const clientFor = mirakurunPath => new MirakurunClientModel({ getConfig: () => ({ mirakurunPath }) }).getClient();

// first in the file: Node emits a deprecation warning only once per process
test('parsing mirakurunPath emits no deprecation warning', async () => {
    const warnings = [];
    const onWarning = warning => warnings.push(warning.code);
    process.on('warning', onWarning);
    try {
        clientFor('http://mirakurun:40772/');
        await new Promise(setImmediate); // warnings are emitted on the next tick
    } finally {
        process.off('warning', onWarning);
    }

    assert.deepStrictEqual(warnings, []);
});

test('an http mirakurunPath sets host, port and base path', () => {
    const client = clientFor('http://mirakurun:40772/sub/');

    assert.strictEqual(client.host, 'mirakurun');
    assert.strictEqual(client.port, 40772);
    assert.strictEqual(client.basePath, '/sub/api');
});

test('an IPv6 mirakurunPath sets the host without brackets', () => {
    const client = clientFor('http://[::1]:40772/');

    assert.strictEqual(client.host, '::1');
    assert.strictEqual(client.port, 40772);
});
