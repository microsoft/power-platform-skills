'use strict';

// How much room an alternate key has beside its table's name column. The platform takes a key of at most 1,700 bytes, 2 for each character of
// text, and a name column is 850 characters at most — 1,700 bytes by themselves — so a key over the column and any other column cannot fit while
// the column is that long, and a key over it alone always does. The build decides where to make a key labelled in several languages from a floor
// of the key's size (lib/app-spec.js, keyBytesAtLeast): what the floor shows is certain, and what it leaves open the platform decides.
// Measured: a key over a name column of 850 characters alone was accepted, and the same key with a column of one character or of a hundred was
// refused (HTTP 400, code 0x80060895, "Index size exceeded the size limit of 1700 bytes").
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/define-alternate-keys-entity#create-alternate-keys

const { test } = require('node:test');
const assert = require('node:assert');
const { KEY_BYTES_LIMIT, PRIMARY_NAME_MAX_LENGTH, keyBytesAtLeast, keyCannotFitAt, keyHasRoomOnlyAfterLength } = require('../lib/app-spec.js');

const entity = (primaryAttribute = { schemaName: 'new_Name', maxLength: 120 }, columns = [{ schemaName: 'new_code', type: 'Text' }]) => ({ schemaName: 'new_t', primaryAttribute, columns });
const key = (columns, extra = {}) => ({ schemaName: 'new_k', columns, ...extra });

test('the longest name column is exactly the bytes a key may hold', () => {
  assert.strictEqual(KEY_BYTES_LIMIT, 1700);
  assert.strictEqual(PRIMARY_NAME_MAX_LENGTH * 2, KEY_BYTES_LIMIT, '850 characters, 2 bytes each');
});

test('a text column takes 2 bytes for each character: the name column at the length it has, another at its maxLength, else the 100 the SDK gives it', () => {
  const e = entity(undefined, [
    { schemaName: 'new_code', type: 'Text' },
    { schemaName: 'new_long', type: 'Text', maxLength: 200 },
    { schemaName: 'new_ref', type: 'AutoNumber', autoNumberFormat: 'R-{SEQNUM:4}' },
    { schemaName: 'new_odd', type: 'Text', maxLength: 0 },
    { schemaName: 'new_untyped' },
  ]);
  assert.strictEqual(keyBytesAtLeast(e, key(['new_name']), 850), 1700);
  assert.strictEqual(keyBytesAtLeast(e, key(['new_name']), 120), 240);
  assert.strictEqual(keyBytesAtLeast(e, key(['new_name', 'new_code']), 120), 240 + 200, 'a text column with no maxLength is 100 characters');
  assert.strictEqual(keyBytesAtLeast(e, key(['new_name', 'new_long']), 120), 240 + 400, 'and one with a maxLength is that many');
  assert.strictEqual(keyBytesAtLeast(e, key(['new_ref']), 120), 200, 'an auto-number column is text');
  assert.strictEqual(keyBytesAtLeast(e, key(['new_odd']), 120), 200, 'a maxLength that is not a length is the default');
  assert.strictEqual(keyBytesAtLeast(e, key(['new_untyped']), 120), 200, 'a column that gives no type is a text column, as the build creates it');
});

test('every other column counts for one byte, however much more it takes: the floor shows only what is certain', () => {
  const e = entity(undefined, [{ schemaName: 'new_count', type: 'Integer' }, { schemaName: 'new_when', type: 'DateTime' }, { schemaName: 'new_kind', type: 'Choice' }]);
  assert.strictEqual(keyBytesAtLeast(e, key(['new_name', 'new_count']), 120), 240 + 1);
  assert.strictEqual(keyBytesAtLeast(e, key(['new_name', 'new_count', 'new_when', 'new_kind']), 120), 240 + 3);
  assert.strictEqual(keyBytesAtLeast(e, key(['new_name', 'createdon', 'new_parentid']), 120), 240 + 2, 'nor does a column the spec does not describe: a system column, a lookup a relationship makes');
});

test('a name column is matched whatever the case, and a length that is no length counts as one character', () => {
  assert.strictEqual(keyBytesAtLeast(entity(), key(['NEW_NAME']), 120), 240, 'logical names are lower case, whatever case the spec writes');
  assert.strictEqual(keyBytesAtLeast(entity(), key(['NEW_NAME', 'New_Code']), 120), 240 + 200);
  for (const nameLength of [undefined, null, 0, -5, 1.5, '120', NaN]) assert.strictEqual(keyBytesAtLeast(entity(), key(['new_name']), nameLength), 2, `${nameLength}`);
});

test('the measured answers: the name column of 850 characters alone fits, and any column beside it does not — a character, a hundred, a number', () => {
  const e = entity(undefined, [{ schemaName: 'new_one', type: 'Text', maxLength: 1 }, { schemaName: 'new_code', type: 'Text', maxLength: 100 }, { schemaName: 'new_count', type: 'Integer' }]);
  assert.strictEqual(keyCannotFitAt(e, key(['new_name']), 850), false, 'accepted');
  assert.strictEqual(keyCannotFitAt(e, key(['new_name', 'new_one']), 850), true, '1,702 bytes: refused');
  assert.strictEqual(keyCannotFitAt(e, key(['new_name', 'new_code']), 850), true, '1,900 bytes: refused');
  assert.strictEqual(keyCannotFitAt(e, key(['new_name', 'new_count']), 850), true, 'a column of any type takes at least a byte');
  for (const columns of [['new_name', 'new_one'], ['new_name', 'new_code'], ['new_name', 'new_count']]) {
    assert.strictEqual(keyCannotFitAt(e, key(columns), 120), false, `${columns}: at the length the spec asks it has room`);
  }
  assert.strictEqual(keyCannotFitAt(e, key(['new_name', 'new_code']), 750), false, '1,700 bytes, to the byte: the platform takes a key of the limit itself');
  assert.strictEqual(keyCannotFitAt(e, key(['new_name', 'new_code']), 751), true);
});

test('only a key that holds the name column and cannot fit at 850 characters, but may at the length the spec asks, has room only after the length step', () => {
  const e = entity(undefined, [{ schemaName: 'new_code', type: 'Text' }, { schemaName: 'new_wide', type: 'Text', maxLength: 900 }]);
  assert.strictEqual(keyHasRoomOnlyAfterLength(e, key(['new_name', 'new_code'])), true, 'the name column and another column');
  assert.strictEqual(keyHasRoomOnlyAfterLength(e, key(['new_code', 'NEW_NAME'])), true, 'in any order and case');
  assert.strictEqual(keyHasRoomOnlyAfterLength(e, key(['new_name'])), false, 'the name column alone fits at 850 characters: nothing depends on the length');
  assert.strictEqual(keyHasRoomOnlyAfterLength(e, key(['new_code'])), false, 'a key that does not hold the name column is not in its way');
  assert.strictEqual(keyHasRoomOnlyAfterLength(e, key(['new_name', 'new_wide'])), false, '1,800 bytes beside the name column: too large at the length asked as well, so waiting changes nothing');
  assert.strictEqual(keyHasRoomOnlyAfterLength(entity({ schemaName: 'new_name' }), key(['new_name', 'new_code'])), false, 'a spec that asks no length has no length step to wait for');
  assert.strictEqual(keyHasRoomOnlyAfterLength(entity({ schemaName: 'new_name', maxLength: 850 }), key(['new_name', 'new_code'])), false, 'and one that asks the longest has nothing to shorten');
  assert.strictEqual(keyHasRoomOnlyAfterLength(entity({ schemaName: 'new_name', maxLength: 760 }), key(['new_name', 'new_code'])), false, '1,720 bytes at the length asked');
  assert.strictEqual(keyHasRoomOnlyAfterLength(entity({ schemaName: 'new_name', maxLength: 750 }), key(['new_name', 'new_code'])), true, '1,700 bytes at the length asked: the platform takes it');
});

test('the floor never throws: a key, an entity or a column that is not what it should be holds what can be counted of it', () => {
  for (const [what, e, k, room] of [
    ['no key', entity(), undefined, false],
    ['no columns', entity(), { schemaName: 'new_k' }, false],
    ['columns that are not a list', entity(), { schemaName: 'new_k', columns: 'new_name' }, false],
    ['no entity', undefined, key(['new_name']), false],
    ['no primary attribute', { schemaName: 'new_t', columns: [] }, key(['new_name']), false],
    // The key holds the name column and a column the spec does not describe, which counts for a byte: too large at 850 characters, not at 120.
    ['columns that are not a list, on the entity', { schemaName: 'new_t', primaryAttribute: { schemaName: 'new_name', maxLength: 120 }, columns: 'x' }, key(['new_name', 'new_code']), true],
    ['a hole among the columns', { schemaName: 'new_t', primaryAttribute: { schemaName: 'new_name', maxLength: 120 }, columns: [null, { schemaName: 'new_code' }] }, key(['new_name', 'new_code']), true],
  ]) {
    assert.doesNotThrow(() => keyBytesAtLeast(e, k, 120), what);
    assert.doesNotThrow(() => keyCannotFitAt(e, k, 850), what);
    assert.strictEqual(keyHasRoomOnlyAfterLength(e, k), room, what);
  }
});
