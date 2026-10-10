const test = require('node:test');
const assert = require('node:assert');
const Util = require('../test-build/util/Util').default;

test('getApiErrorReason shows the server reason of a failed API call', () => {
    const err = { message: 'Request failed with status code 500', response: { data: { code: 500, message: 'Internal Server Error', errors: 'GetExecutionTimeoutError' } } };

    assert.strictEqual(Util.getApiErrorReason(err), ' (GetExecutionTimeoutError)');
});

test('getApiErrorReason falls back to the response message, then the error message', () => {
    assert.strictEqual(Util.getApiErrorReason({ response: { data: { code: 400, message: 'Bad Request' } } }), ' (Bad Request)');
    assert.strictEqual(Util.getApiErrorReason({ message: 'Network Error' }), ' (Network Error)');
});

test('getApiErrorReason shows the reasons of an API input check error once each', () => {
    // the body the server sends for a request its OpenAPI schema rejects (checked on the live API)
    const err = {
        message: 'Request failed with status code 400',
        response: { data: { status: 400, errors: [{ message: 'must be integer' }, { message: 'must be integer' }, { message: 'must be >= 0' }] } },
    };

    assert.strictEqual(Util.getApiErrorReason(err), ' (must be integer, must be >= 0)');
});

test('getApiErrorReason falls back to the error message when an input check error has no reason', () => {
    const err = { message: 'Request failed with status code 400', response: { data: { status: 400, errors: [{}] } } };

    assert.strictEqual(Util.getApiErrorReason(err), ' (Request failed with status code 400)');
});

test('getApiErrorReason is empty when there is no reason', () => {
    assert.strictEqual(Util.getApiErrorReason(undefined), '');
    assert.strictEqual(Util.getApiErrorReason({}), '');
});

test('linkifyUrls links an http URL that contains https:// once, with nothing added to the anchor', () => {
    const payload = 'http://a/?https://onmouseover=alert(1)//';

    assert.strictEqual(Util.linkifyUrls(payload), "<a href='http://a/?https://onmouseover=alert(1)//' target='_blank'>http://a/?https://onmouseover=alert(1)//</a>");
});

test('linkifyUrls links http and https URLs and ends a URL at a quote or space', () => {
    assert.strictEqual(
        Util.linkifyUrls("see https://x.jp/a'b and http://y.jp/?q=1&amp;r=2<br>"),
        "see <a href='https://x.jp/a' target='_blank'>https://x.jp/a</a>'b and <a href='http://y.jp/?q=1&amp;r=2' target='_blank'>http://y.jp/?q=1&amp;r=2</a><br>",
    );
    assert.strictEqual(Util.linkifyUrls('no link here'), 'no link here');
});
