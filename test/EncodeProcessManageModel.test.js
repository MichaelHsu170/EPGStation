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

test('two processes started in the same millisecond are tracked apart: the one that exits is the one removed', async t => {
    t.mock.timers.enable({ apis: ['Date'] }); // the clock stands still: both processes start in the same millisecond
    const model = new EncodeProcessManageModel(
        { getLogger: () => ({ encode: { info: () => {}, error: () => {} } }) },
        { getConfig: () => ({ encodeProcessNum: 4 }) },
    );

    const short = await model.create({ cmd: '/bin/sleep 0.1', input: null, output: null, priority: 1 });
    const long = await model.create({ cmd: '/bin/sleep 30', input: null, output: null, priority: 1 });
    t.after(() => long.kill());
    await new Promise(resolve => short.once('exit', resolve));
    for (let i = 0; i < 5; i++) {
        await new Promise(setImmediate);
    }

    assert.deepStrictEqual(
        model.childs.map(c => c.child.pid),
        [long.pid],
    );
});

test('a process killed to make room is removed by its own id: the new process and the other running ones stay tracked', async t => {
    const model = new EncodeProcessManageModel(
        { getLogger: () => ({ encode: { info: () => {}, error: () => {} } }) },
        { getConfig: () => ({ encodeProcessNum: 3 }) },
    );

    // 3 low-priority "streams": cat exits as soon as kill() ends its stdin, i.e. during kill's 500 ms wait
    const streams = [];
    for (let i = 0; i < 3; i++) {
        streams.push(await model.create({ cmd: '/bin/cat', input: null, output: null, priority: 1 }));
    }
    t.after(() => streams.forEach(s => s.kill()));
    const encode = await model.create({ cmd: '/bin/sleep 30', input: null, output: null, priority: 10 });
    t.after(() => encode.kill());
    await new Promise(resolve => setTimeout(resolve, 1000));

    const running = streams.filter(s => s.exitCode === null && s.signalCode === null).concat(encode);
    assert.strictEqual(running.length, 3);
    assert.deepStrictEqual(model.childs.map(c => c.child.pid).sort(), running.map(c => c.pid).sort());
});
