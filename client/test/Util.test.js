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

test('getApiErrorReason is empty when there is no reason', () => {
    assert.strictEqual(Util.getApiErrorReason(undefined), '');
    assert.strictEqual(Util.getApiErrorReason({}), '');
});
