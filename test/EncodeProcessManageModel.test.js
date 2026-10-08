require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const EncodeProcessManageModel = require('../dist/model/service/encode/EncodeProcessManageModel').default;

test('input and output paths are passed to the command literally, even with $& in them', async () => {
    const model = Object.create(EncodeProcessManageModel.prototype);
    model.log = { encode: { error: () => {} } };
    model.killChild = async () => {};
    model.eventsNotify = () => {};

    const info = model.buildProcess({
        input: '/rec/a$&b.m2ts',
        output: "/rec/c$'d.mkv",
        cmd: '/bin/echo %INPUT% %OUTPUT%',
        priority: 0,
    });
    let out = '';
    info.child.stdout.on('data', data => (out += data));
    await new Promise(resolve => info.child.on('close', resolve));

    assert.strictEqual(out, "/rec/a$&b.m2ts /rec/c$'d.mkv\n");
});
