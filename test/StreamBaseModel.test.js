require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RecordedHLSStreamModel = require('../dist/model/service/stream/RecordedHLSStreamModel').default;
const LiveHLSStreamModel = require('../dist/model/service/stream/LiveHLSStreamModel').default;
const FileUtil = require('../dist/util/FileUtil').default;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const silentLog = { info: () => {}, debug: () => {}, error: () => {} };

// ffmpeg's playlists for the recorded hls commands of config.yml, as ffmpeg 9.0.1 (the image's) wrote them in a
// throwaway container from a 10 s TS: -ss 8.6 wrote one segment and exited; -ss 0 listed its first closed segment
// before the second appeared, then finished with two.
const PLAYLIST_ENDED_ONE_SEGMENT =
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ALLOW-CACHE:YES\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n' +
    '#EXTINF:1.400000,\nstream0-000000000.ts\n#EXT-X-ENDLIST\n';
const PLAYLIST_RUNNING_ONE_SEGMENT =
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ALLOW-CACHE:YES\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:0\n' +
    '#EXTINF:8.333333,\nstream0-000000000.ts\n';

/**
 * Writes HLS output the way ffmpeg's hls muxer does with those commands (-hls_list_size 0, no -hls_playlist_type,
 * file output; ffmpeg libavformat/hlsenc.c):
 * - a segment is written in place, growing as it is encoded (no temp file without -hls_flags temp_file);
 * - the playlist is first written when segment 0 closes, and rewritten after each later segment, each time to
 *   "<name>.tmp" and then renamed over the playlist (hls_window: use_temp_file for a non-VOD playlist);
 * - on exit ffmpeg closes the last segment and writes the playlist once more, ending in #EXT-X-ENDLIST.
 */
const createFakeFfmpegHls = dir => {
    const playList = path.join(dir, 'stream0.m3u8');

    return {
        writeSegment: async n => {
            const segment = path.join(dir, `stream0-${String(n).padStart(9, '0')}.ts`);
            for (let i = 0; i < 4; i++) {
                fs.appendFileSync(segment, Buffer.alloc(188 * 100, 0x47));
                await sleep(20);
            }
        },
        writePlayList: content => {
            fs.writeFileSync(`${playList}.tmp`, content);
            fs.renameSync(`${playList}.tmp`, playList);
        },
    };
};

const createModel = (Model, dir, t) => {
    const notified = [];
    const config = { getConfig: () => ({ streamFilePath: dir }) };
    const logger = { getLogger: () => ({ stream: silentLog }) };
    const socketIO = { notifyClient: () => notified.push(Date.now()) };
    const model =
        Model === LiveHLSStreamModel
            ? new Model(config, logger, {}, {}, {}, socketIO)
            : new Model(config, logger, {}, {}, socketIO, {}, {}, {});
    t.after(() => clearInterval(model.streamCheckTimer));

    return { model, notified };
};

const tmpDir = t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-enable-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    return dir;
};

test('a recorded HLS stream whose ffmpeg finished after one segment (a seek into the last seconds) is enabled', async t => {
    const dir = tmpDir(t);
    const ffmpeg = createFakeFfmpegHls(dir);
    const { model, notified } = createModel(RecordedHLSStreamModel, dir, t);
    model.startCheckStreamEnable(0);

    await ffmpeg.writeSegment(0);
    ffmpeg.writePlayList(PLAYLIST_ENDED_ONE_SEGMENT);
    await sleep(300);
    assert.strictEqual(model.isEnable(), true);
    assert.strictEqual(notified.length, 1);
    assert.strictEqual(model.streamCheckTimer, null);
});

test('a recorded HLS stream with one closed segment and an unfinished playlist waits for the second segment', async t => {
    const dir = tmpDir(t);
    const ffmpeg = createFakeFfmpegHls(dir);
    const { model, notified } = createModel(RecordedHLSStreamModel, dir, t);
    model.startCheckStreamEnable(0);

    await ffmpeg.writeSegment(0);
    ffmpeg.writePlayList(PLAYLIST_RUNNING_ONE_SEGMENT);
    await sleep(300);
    assert.strictEqual(model.isEnable(), false);

    await ffmpeg.writeSegment(1);
    await sleep(300);
    assert.strictEqual(model.isEnable(), true);
    assert.strictEqual(notified.length, 1);
});

test('a live HLS stream whose playlist finished after one segment is not enabled (live waits for two segments)', async t => {
    const dir = tmpDir(t);
    const ffmpeg = createFakeFfmpegHls(dir);
    const { model, notified } = createModel(LiveHLSStreamModel, dir, t);
    model.startCheckStreamEnable(0);

    await ffmpeg.writeSegment(0);
    ffmpeg.writePlayList(PLAYLIST_ENDED_ONE_SEGMENT);
    await sleep(500);
    assert.strictEqual(model.isEnable(), false);
    assert.strictEqual(notified.length, 0);
});

test('a recorded HLS playlist deleted before it is read (stop cleaning up) leaves the stream disabled, without a rejection', async t => {
    const dir = tmpDir(t);
    const ffmpeg = createFakeFfmpegHls(dir);
    const { model, notified } = createModel(RecordedHLSStreamModel, dir, t);
    const rejections = [];
    const onRejection = err => rejections.push(err);
    process.on('unhandledRejection', onRejection);
    t.after(() => process.removeListener('unhandledRejection', onRejection));
    // HLSFileDeleterModel.deleteAllFiles removing the playlist between the directory listing and the read
    const readFile = FileUtil.readFile;
    FileUtil.readFile = async filePath => {
        fs.rmSync(filePath, { force: true });
        return readFile(filePath);
    };
    t.after(() => (FileUtil.readFile = readFile));

    await ffmpeg.writeSegment(0);
    ffmpeg.writePlayList(PLAYLIST_ENDED_ONE_SEGMENT);
    model.startCheckStreamEnable(0);
    await sleep(300);
    assert.strictEqual(model.isEnable(), false);
    assert.strictEqual(notified.length, 0);
    assert.deepStrictEqual(rejections, []);
});
