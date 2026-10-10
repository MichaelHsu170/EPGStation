require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const RecordedHLSStreamModel = require('../dist/model/service/stream/RecordedHLSStreamModel').default;
const LiveHLSStreamModel = require('../dist/model/service/stream/LiveHLSStreamModel').default;
const StreamBaseModel = require('../dist/model/service/stream/base/StreamBaseModel').default;
const HLSFileDeleterModel = require('../dist/model/service/stream/util/HLSFileDeleterModel').default;
const StreamManageModel = require('../dist/model/service/stream/manager/StreamManageModel').default;
const ExecutionManagementModel = require('../dist/model/ExecutionManagementModel').default;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const silentLog = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
const logger = { getLogger: () => ({ stream: silentLog, system: silentLog }) };

const FIRST_SEGMENT_MS = 1500;
const SEGMENT_MS = 300;
const EXIT_AFTER_SIGINT_MS = 1000;

/**
 * A stand-in for the hls commands of config.yml (ffmpeg 9.0.1, the image's), as measured in a throwaway container
 * (recorded hls 480p on an encoded recording, the directory polled every 10 ms):
 * - a segment file appears whole when the segment closes (ffmpeg buffers it), then the playlist is rewritten through
 *   "<name>.tmp" and a rename, listing every closed segment (-hls_list_size 0);
 * - the first segment closes some time after the start (0.5 s on an idle tmpfs; 3.4-6.8 s live, as a new ffmpeg's
 *   first playlist after a seek);
 * - on SIGINT ffmpeg goes on encoding, writes its last segment and a final playlist ending in #EXT-X-ENDLIST, and
 *   exits with code 255: 0.1-1.1 s after SIGINT in the container, up to about 1.8 s live.
 * stdin is read and ignored (the live command reads the broadcast from it; a recorded one gets an EOF at stop).
 * With "ignore-sigint" the process stands in for an ffmpeg that hangs after SIGINT: it writes nothing more and does
 * not exit.
 */
const FAKE_FFMPEG = `
const fs = require('fs');
const path = require('path');
const [dir, id, writer, mode] = process.argv.slice(1);
const playList = path.join(dir, 'stream' + id + '.m3u8');
const closed = [];
const closeSegment = ended => {
    const name = 'stream' + id + '-' + String(closed.length).padStart(9, '0') + '.ts';
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(188 * 100, 0x47));
    closed.push(name);
    const body =
        '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:3\\n#EXT-X-MEDIA-SEQUENCE:0\\n# writer: ' + writer + '\\n' +
        closed.map(s => '#EXTINF:3.000000,\\n' + s + '\\n').join('') + (ended ? '#EXT-X-ENDLIST\\n' : '');
    fs.writeFileSync(playList + '.tmp', body);
    fs.renameSync(playList + '.tmp', playList);
};
let timer = setTimeout(function next() {
    closeSegment(false);
    timer = setTimeout(next, ${SEGMENT_MS});
}, ${FIRST_SEGMENT_MS});
process.stdin.resume();
process.on('SIGINT', () => {
    clearTimeout(timer);
    if (mode === 'ignore-sigint') {
        setInterval(() => {}, 1000);
        return;
    }
    setTimeout(() => {
        closeSegment(true);
        process.exit(255);
    }, ${EXIT_AFTER_SIGINT_MS});
});
`;

const tmpDir = t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-stop-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    return dir;
};

const waitFor = async (check, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (check() !== true) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await sleep(20);
    }
};

/**
 * The processManager stand-in: spawns the fake ffmpeg for the stream id the model was started with.
 * The spawned processes are in .children, killed after the test.
 */
const createProcessManager = (dir, t, writer, mode = '') => {
    const pm = { children: [], streamId: null };
    pm.create = async () => {
        const child = spawn(process.execPath, ['-e', FAKE_FFMPEG, dir, String(pm.streamId), writer, mode]);
        pm.children.push(child);
        t.after(() => child.kill('SIGKILL'));

        return child;
    };

    return pm;
};

/**
 * A recorded HLS stream of an encoded file (no file stream: ffmpeg reads the file itself).
 * enabledWith holds the playlist on disk at each moment the model enabled the stream.
 */
const createRecordedHLS = (dir, t, writer, mode) => {
    const pm = createProcessManager(dir, t, writer, mode);
    const enabledWith = [];
    const config = { getConfig: () => ({ streamFilePath: dir }) };
    const socketIO = {
        notifyClient: () => {
            const playList = fs.readdirSync(dir).find(f => f.endsWith('.m3u8'));
            enabledWith.push(playList ? fs.readFileSync(path.join(dir, playList), 'utf8') : null);
        },
    };
    const model = new RecordedHLSStreamModel(config, logger, pm, new HLSFileDeleterModel(logger), socketIO, {}, {}, {});
    model.setOption({ playPosition: 0, videoFileId: 1, cmd: 'ffmpeg' }, 1);
    model.setVideFileInfo = async function () {
        this.videoFilePath = '/recorded/a.mkv';
        this.videoFileInfo = { duration: 1800, bitRate: 0 };
        this.videoFileType = 'encoded';
        this.isRecording = false;
    };
    const start = model.start.bind(model);
    model.start = async streamId => {
        pm.streamId = streamId;
        await start(streamId);
    };
    t.after(() => clearTimeout(model.streamStopTimer));

    return { model, pm, enabledWith };
};

test('stopping a recorded HLS stream waits for ffmpeg to exit, so nothing it writes after SIGINT is left on disk', async t => {
    const dir = tmpDir(t);
    const { model, pm } = createRecordedHLS(dir, t, 'old');
    await model.start(0);
    await waitFor(() => model.isEnable());

    await model.stop();
    assert.strictEqual(pm.children[0].exitCode, 255);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    await sleep(EXIT_AFTER_SIGINT_MS + 500);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('stopping a live HLS stream waits for ffmpeg to exit, so nothing it writes after SIGINT is left on disk', async t => {
    const dir = tmpDir(t);
    const pm = createProcessManager(dir, t, 'old');
    pm.streamId = 0;
    const config = { getConfig: () => ({ streamFilePath: dir, streamingPriority: 0, ffmpeg: 'ffmpeg' }) };
    const broadcast = new PassThrough();
    const mirakurun = { getClient: () => ({ getServiceStream: async () => broadcast }) };
    const model = new LiveHLSStreamModel(config, logger, pm, new HLSFileDeleterModel(logger), mirakurun, {
        notifyClient: () => {},
    });
    t.after(() => clearTimeout(model.streamStopTimer));
    model.setOption({ channelId: 1, cmd: '%FFMPEG% -i pipe:0 %OUTPUT%' }, 0);
    await model.start(0);
    await waitFor(() => model.isEnable());

    await model.stop();
    assert.strictEqual(pm.children[0].exitCode, 255);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    await sleep(EXIT_AFTER_SIGINT_MS + 500);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a seek (stop, then a new stream at once) enables the new stream on its own playlist, not the old finished one', async t => {
    const dir = tmpDir(t);
    const manager = new StreamManageModel(logger, new ExecutionManagementModel(logger), { notifyClient: () => {} });
    const old = createRecordedHLS(dir, t, 'old');
    assert.strictEqual(await manager.start(old.model), 0);
    await waitFor(() => old.model.isEnable());

    // what the recorded HLS player does on a seek: DELETE /api/streams/0, then a new stream as soon as it returns
    const seek = createRecordedHLS(dir, t, 'new');
    await manager.stop(0);
    assert.strictEqual(await manager.start(seek.model), 0);

    await waitFor(() => seek.model.isEnable());
    // two overlapping checks can both enable the stream on a loaded machine (upstream), so every one is checked
    assert.ok(seek.enabledWith.length >= 1);
    for (const playList of seek.enabledWith) {
        assert.match(playList, /# writer: new\n/);
        assert.doesNotMatch(playList, /#EXT-X-ENDLIST/);
    }
    await manager.stop(0);
});

test('a stop whose ffmpeg does not exit after SIGINT gives up after the time limit, warns, and deletes the files', async t => {
    const dir = tmpDir(t);
    const timeout = StreamBaseModel.PROCESS_EXIT_TIMEOUT;
    StreamBaseModel.PROCESS_EXIT_TIMEOUT = 1000;
    t.after(() => (StreamBaseModel.PROCESS_EXIT_TIMEOUT = timeout));
    const warnings = [];
    silentLog.warn = message => warnings.push(message);
    t.after(() => (silentLog.warn = () => {}));
    const { model, pm } = createRecordedHLS(dir, t, 'old', 'ignore-sigint');
    await model.start(0);
    await waitFor(() => model.isEnable());

    const begin = Date.now();
    await model.stop();
    const took = Date.now() - begin;
    // ProcessUtil.kill waits 500 ms before SIGINT, then the 1000 ms limit
    assert.ok(took >= 1500 && took < 2500, `stop took ${took} ms`);
    assert.strictEqual(pm.children[0].exitCode, null);
    assert.deepStrictEqual(warnings, ['stream process did not exit in 1000 ms']);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('stopping a stream whose ffmpeg already exited (killed by a signal) does not wait for the time limit', async t => {
    const dir = tmpDir(t);
    const { model, pm } = createRecordedHLS(dir, t, 'old');
    await model.start(0);
    await waitFor(() => model.isEnable());
    pm.children[0].kill('SIGTERM');
    await new Promise(resolve => pm.children[0].once('exit', resolve));
    assert.strictEqual(pm.children[0].exitCode, null); // a signal exit leaves exitCode null

    const begin = Date.now();
    await model.stop();
    const took = Date.now() - begin;
    // only ProcessUtil.kill's 500 ms before SIGINT
    assert.ok(took < 1500, `stop took ${took} ms`);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
});
