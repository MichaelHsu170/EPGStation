require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const RecordedDetailState = require('../test-build/model/state/recorded/detail/RecordedDetailState').default;

const useLocation = t => {
    global.location = { host: 'tv.example:8888', protocol: 'https:', pathname: '/' };
    global.window = { location: global.location };
    t.after(() => {
        delete global.location;
        delete global.window;
    });
};

const createState = () => {
    const setting = {
        shouldUseRecordedViewURLScheme: true,
        recordedViewURLScheme: 'player://play?url=PROTOCOL://ADDRESS&name=FILENAME',
        shouldUseRecordedDownloadURLScheme: true,
        recordedDownloadURLScheme: 'player://get?url=ADDRESS&name=FILENAME',
    };

    return new RecordedDetailState(null, null, { getConfig: () => null }, { getSavedValue: () => setting });
};

// a program title with the replacement patterns $& $' $` $$
const video = { id: 5, filename: "News $& Sports $' Weather $` $$.ts" };

// the file name goes into a URL, so it is URL-encoded (and $& $' $` $$ are not expanded)
const encodedName = "News%20%24%26%20Sports%20%24'%20Weather%20%24%60%20%24%24.ts";

test("getVideoURL inserts the file name URL-encoded, without expanding $& $' $` $$", t => {
    useLocation(t);

    assert.strictEqual(createState().getVideoURL(video), `player://play?url=https://tv.example:8888/api/videos/5&name=${encodedName}`);
});

test("getVideoDownloadURL inserts the file name URL-encoded, without expanding $& $' $` $$", t => {
    useLocation(t);

    assert.strictEqual(createState().getVideoDownloadURL(video), `player://get?url=tv.example:8888/api/videos/5?isDownload=true&name=${encodedName}`);
});

test("a file name with & ? # cannot break the player URL's query", t => {
    useLocation(t);

    const url = createState().getVideoURL({ id: 5, filename: 'Q&A ?#1.ts' });
    assert.strictEqual(new URL(url).searchParams.get('name'), 'Q&A ?#1.ts');
});
