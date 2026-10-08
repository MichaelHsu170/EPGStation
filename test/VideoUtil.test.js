require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const VideoUtil = require('../dist/model/api/video/VideoUtil').default;
const RecordedStreamBaseModel = require('../dist/model/service/stream/base/RecordedStreamBaseModel').default;

test('getInfo passes the file path to ffprobe as one argument, without a shell', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-util-'));
    try {
        // fake ffprobe: records its last argument and prints a fixed format
        const argFile = path.join(dir, 'arg');
        const ffprobe = path.join(dir, 'ffprobe');
        fs.writeFileSync(
            ffprobe,
            `#!/bin/sh\nfor a; do last="$a"; done\nprintf '%s' "$last" > '${argFile}'\n` +
                `echo '{"format":{"duration":"12.5","size":"1000","bit_rate":"640"}}'\n`,
            { mode: 0o755 },
        );
        const marker = path.join(dir, 'MARKER');
        const filePath = path.join(dir, `a$(touch ${marker}).ts`);

        const util = Object.create(VideoUtil.prototype);
        util.config = { ffprobe };

        assert.deepStrictEqual(await util.getInfo(filePath), { duration: 12.5, size: 1000, bitRate: 640 });
        assert.strictEqual(fs.readFileSync(argFile, 'utf8'), filePath);
        assert.strictEqual(fs.existsSync(marker), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('recorded streams read the video file info through VideoUtil.getInfo', async () => {
    const info = { duration: 1, size: 2, bitRate: 3 };
    const model = Object.create(RecordedStreamBaseModel.prototype);
    model.processOption = { videoFileId: 5 };
    model.videoFileDB = { findId: async () => ({ id: 5, recordedId: 1, type: 'ts' }) };
    model.recordedDB = { findId: async () => ({ isRecording: false }) };
    model.videoUtil = {
        getFullFilePathFromId: async () => '/recorded/a$(reboot).ts',
        getInfo: async filePath => {
            assert.strictEqual(filePath, '/recorded/a$(reboot).ts');

            return info;
        },
    };

    await model.setVideFileInfo();
    assert.strictEqual(model.videoFileInfo, info);
});
