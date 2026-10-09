const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const api = require('../dist/model/service/api');

/**
 * serves filePath through api.responseFile and returns a request function
 */
const serve = (t, filePath) => {
    const app = express();
    app.get('/file', (req, res) => {
        try {
            api.responseFile(req, res, filePath, 'text/plain');
        } catch (err) {
            res.status(500).end();
        }
    });
    const server = app.listen(0);
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });

    return range =>
        new Promise((resolve, reject) => {
            const req = http.get({ port: server.address().port, path: '/file', headers: range ? { Range: range } : {} }, res => {
                let body = '';
                res.on('data', d => (body += d));
                res.on('end', () => resolve({ status: res.statusCode, length: res.headers['content-length'], body }));
                res.on('error', reject);
            });
            req.on('error', reject);
        });
};

const createFile = t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'a.txt');
    fs.writeFileSync(filePath, '0123456789');

    return filePath;
};

test('a range request returns the requested bytes with their length', async t => {
    const get = serve(t, createFile(t));

    assert.deepStrictEqual(await get('bytes=2-4'), { status: 206, length: '3', body: '234' });
    assert.deepStrictEqual(await get('bytes=0-0'), { status: 206, length: '1', body: '0' });
    assert.deepStrictEqual(await get('bytes=-3'), { status: 206, length: '3', body: '789' });
});

test('a suffix range longer than the file returns the whole file (RFC 7233)', async t => {
    const get = serve(t, createFile(t));

    assert.deepStrictEqual(await get('bytes=-11'), { status: 206, length: '10', body: '0123456789' });
});

test('an unsatisfiable range request gets 416', async t => {
    const get = serve(t, createFile(t));

    assert.strictEqual((await get('bytes=5-2')).status, 416);
    assert.strictEqual((await get('bytes=10-')).status, 416);
});

test('a read error while sending a file closes the response instead of crashing the process', { timeout: 10000 }, async t => {
    // /proc/self/mem can be opened but reading offset 0 fails (EIO)
    const get = serve(t, '/proc/self/mem');

    await assert.rejects(get(), /socket hang up|aborted|ECONNRESET/);
});
