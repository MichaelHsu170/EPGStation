require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const RecordedUploadState = require('../test-build/model/state/recorded/upload/RecordedUploadState').default;

// an upload form filled in with one video file whose name is viewName; calls records the API calls
const createState = (viewName, calls) => {
    const state = Object.create(RecordedUploadState.prototype);
    Object.assign(state, {
        recordedApiModel: {
            createNewRecorded: async option => {
                calls.push(`createNewRecorded ${option.name}`);

                return 42;
            },
        },
        videoApiModel: { uploadedVideoFile: async option => calls.push(`uploadedVideoFile ${option.recordedId} ${option.viewName}`) },
        programOption: { ruleId: null, channelId: 1, startAt: new Date(0), duration: 30, name: 'program', description: null, extended: null },
        videoFileItems: [{ key: 0, parentDirectoryName: 'recorded', subDirectory: null, viewName, fileType: 'ts', file: { name: 'a.ts' } }],
    });

    return state;
};

test('upload: a video file with a name is uploaded to the new program', async () => {
    const calls = [];
    const state = createState('TS', calls);

    assert.strictEqual(state.checkInput(), true);
    await state.upload();
    assert.deepStrictEqual(calls, ['createNewRecorded program', 'uploadedVideoFile 42 TS']);
});

test('upload: a video file whose name was deleted with the keyboard is an input error, and no program is created', async () => {
    const calls = [];
    const state = createState('', calls);

    assert.strictEqual(state.checkInput(), false);
    await assert.rejects(state.upload(), { message: 'InputError' });
    assert.deepStrictEqual(calls, []);
});
