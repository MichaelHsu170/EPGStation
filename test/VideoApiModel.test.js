require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const EncodeManageModel = require('../dist/model/service/encode/EncodeManageModel').default;
const VideoApiModel = require('../dist/model/api/video/VideoApiModel').default;

// recorded 1 has the TS (video file 10) and an encoded file (11); recorded 2 has video file 20.
// Encode 1 runs from file 10; encode 2 (another mode) waits on file 10, encode 3 on file 11, encode 4 on file 20.
// The fake encoders stand in for EncoderModel: getEncodeOption() returns the option the encode was queued with,
// and cancel() is what kills a running encode's process (EncoderModel then leaves the running queue by itself).
const createEncodeManage = () => {
    const calls = [];
    const encodeManage = new EncodeManageModel(
        { getLogger: () => ({ encode: { info: () => {}, warn: () => {}, error: () => {} } }) },
        { getConfig: () => ({ concurrentEncodeNum: 1 }) },
        { getExecution: async () => 1, unLockExecution: () => {} },
        async () => {
            throw new Error('no encoder is created in this test');
        },
        { emitCancelEncode: id => calls.push(`cancel event ${id}`) },
    );
    const encoder = (encodeId, recordedId, sourceVideoFileId) => ({
        getEncodeId: () => encodeId,
        getEncodeOption: () => ({ encodeId, recordedId, sourceVideoFileId, mode: 'H.264' }),
        cancel: async () => calls.push(`kill running ${encodeId}`),
    });
    encodeManage.runningQueue = [encoder(1, 1, 10)];
    encodeManage.waitQueue = [encoder(2, 1, 10), encoder(3, 1, 11), encoder(4, 2, 20)];
    const waitingIds = () => encodeManage.waitQueue.map(e => e.getEncodeId());

    return { encodeManage, calls, waitingIds };
};

const createVideoApi = (encodeManage, calls, recorded) =>
    new VideoApiModel(
        {},
        { findId: async id => ({ id, recordedId: 1 }) },
        { findId: async () => recorded },
        {},
        {},
        { recorded: { deleteVideoFile: async id => calls.push(`delete video file ${id}`) } },
        encodeManage,
    );

test('deleting a video file cancels the running and waiting encodes from that file, then deletes it', async () => {
    const { encodeManage, calls, waitingIds } = createEncodeManage();

    await createVideoApi(encodeManage, calls, { id: 1, isProtected: false }).deleteVideoFile(10);

    assert.deepStrictEqual(calls, ['cancel event 2', 'kill running 1', 'cancel event 1', 'delete video file 10']);
    assert.deepStrictEqual(waitingIds(), [3, 4]);
});

test('deleting a video file of a protected recording is refused before any encode is cancelled', async () => {
    const { encodeManage, calls, waitingIds } = createEncodeManage();

    await assert.rejects(
        createVideoApi(encodeManage, calls, { id: 1, isProtected: true }).deleteVideoFile(10),
        /RecordedIsProtected/,
    );
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(waitingIds(), [2, 3, 4]);
});

test('cancelling by recorded id still cancels every encode of that recording, whatever its source file', async () => {
    const { encodeManage, calls, waitingIds } = createEncodeManage();

    await encodeManage.cancelEncodeByRecordedId(1);

    assert.deepStrictEqual(calls, ['cancel event 2', 'cancel event 3', 'kill running 1', 'cancel event 1']);
    assert.deepStrictEqual(waitingIds(), [4]);
});
