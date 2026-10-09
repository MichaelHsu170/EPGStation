require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert');
const SearchState = require('../test-build/model/state/search/SearchState').default;
const ManualReserveState = require('../test-build/model/state/reserve/manual/ManualReserveState').default;

const createRuleSaveOption = option => Object.create(SearchState.prototype).createReserveSaveOption(option);
const createManualSaveOption = option => {
    const state = Object.create(ManualReserveState.prototype);
    state.saveOption = option;

    return state.getSaveOption();
};

test('rule save option: a file name format is sent', () => {
    assert.deepStrictEqual(createRuleSaveOption({ parentDirectoryName: null, directory: null, recordedFormat: '%TITLE%' }), { recordedFormat: '%TITLE%' });
});

test('rule save option: a file name format that was cleared or deleted with the keyboard is not sent', () => {
    assert.deepStrictEqual(createRuleSaveOption({ parentDirectoryName: null, directory: null, recordedFormat: null }), {});
    assert.deepStrictEqual(createRuleSaveOption({ parentDirectoryName: null, directory: null, recordedFormat: '' }), {});
});

test('manual reserve save option: a file name format is sent', () => {
    assert.deepStrictEqual(createManualSaveOption({ parentDirectoryName: null, directory: null, recordedFormat: '%TITLE%' }), { recordedFormat: '%TITLE%' });
});

test('manual reserve save option: a file name format that was cleared or deleted with the keyboard is not sent', () => {
    assert.strictEqual(createManualSaveOption({ parentDirectoryName: null, directory: null, recordedFormat: null }), null);
    assert.strictEqual(createManualSaveOption({ parentDirectoryName: null, directory: null, recordedFormat: '' }), null);
});
