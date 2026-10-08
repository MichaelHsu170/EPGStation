require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const ExternalCommandManageModel = require('../dist/model/operator/externalCommand/ExternalCommandManageModel').default;

const createModel = videoUtil => {
    const model = Object.create(ExternalCommandManageModel.prototype);
    Object.assign(model, {
        log: { system: { info: () => {}, error: () => {} } },
        config: { dropLog: '/drop' },
        channelDB: { findId: async () => null },
        videoUtil,
    });

    return model;
};

const recorded = videoFiles => ({ id: 1, channelId: 1, startAt: 0, endAt: 1, name: 'n', halfWidthName: 'n', videoFiles, dropLogFile: null });

test('a recording command runs for a recording without video files', async () => {
    const model = createModel({ getFullFilePathFromId: async () => '/rec/a.m2ts' });

    await model.createRecordedCmd('/bin/true', recorded([]));
});

test('a recording command whose video path cannot be read fails instead of never finishing', async () => {
    const model = createModel({ getFullFilePathFromId: async () => Promise.reject(new Error('db down')) });

    await assert.rejects(model.createRecordedCmd('/bin/true', recorded([{ id: 5 }])), /db down/);
});
