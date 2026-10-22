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
const { KEY_BYTES_LIMIT, PRIMARY_NAME_MAX_LENGTH, keyBytesAtLeast, keyCannotFitAt, keyHasRoomOnlyAfterLength, maxLengthSent } = require('../lib/app-spec.js');
const { SDK_COLUMN_TYPE } = require('../lib/entity-provision.js');

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

// A column is judged by the length the build creates it with, which is not always the length the spec writes. The build sends a column's
// `maxLength` only when the column names its type Text (or Memo, which a key cannot hold) — maxLengthSent, the one rule what the build sends
// (columnOptions, lib/entity-provision.js) and the floor both follow — so an auto-number column and a column that gives no type, which the build
// creates as text all the same, are the 100 characters the SDK gives a text column, whatever maxLength they carry. What the real bundle makes of
// each column is pinned where it runs (table-columns-in-create.test.js).

test('the maxLength the build passes on is a Text or Memo column\'s own, when it is truthy, as written — and no other column\'s, whatever it carries', () => {
  for (const type of ['Text', 'Memo']) {
    assert.strictEqual(maxLengthSent({ schemaName: 'new_c', type, maxLength: 300 }), 300, type);
    assert.strictEqual(maxLengthSent({ schemaName: 'new_c', type, maxLength: '300' }), '300', `${type}: as written, for the platform to judge`);
    for (const unsent of [undefined, null, 0, '', false, NaN]) assert.strictEqual(maxLengthSent({ schemaName: 'new_c', type, maxLength: unsent }), undefined, `${type}: ${String(unsent)}`);
  }
  for (const [what, column] of [
    ['an auto-number column', { schemaName: 'new_c', type: 'AutoNumber', autoNumberFormat: 'R-{SEQNUM:4}', maxLength: 300 }],
    ['a column that gives no type', { schemaName: 'new_c', maxLength: 300 }],
    ['a column of another type', { schemaName: 'new_c', type: 'Integer', maxLength: 300 }],
    ['a type the build does not know', { schemaName: 'new_c', type: 'text', maxLength: 300 }],
    ['no column', undefined],
    ['a hole', null],
    ['a name', 'new_c'],
  ]) assert.strictEqual(maxLengthSent(column), undefined, what);
});

test('a column counts for the characters the build creates it with: only a column that names its type Text is as long as its maxLength says', () => {
  const e = entity(undefined, [
    { schemaName: 'new_text', type: 'Text', maxLength: 300 },
    { schemaName: 'new_ref', type: 'AutoNumber', autoNumberFormat: 'R-{SEQNUM:4}', maxLength: 900 },
    { schemaName: 'new_untyped', maxLength: 900 },
  ]);
  assert.strictEqual(keyBytesAtLeast(e, key(['new_text']), 120), 600, 'a Text column is created at its maxLength');
  assert.strictEqual(keyBytesAtLeast(e, key(['new_ref']), 120), 200, 'an auto-number column is created 100 characters long: the build sends no length for it, whatever maxLength it carries');
  assert.strictEqual(keyBytesAtLeast(e, key(['new_untyped']), 120), 200, 'and so is a column that gives no type: it is created as text, but its length is read only for the type it names');
  assert.strictEqual(keyBytesAtLeast(e, key(['new_name', 'new_ref', 'new_untyped']), 850), 1700 + 200 + 200, 'in a key, beside the name column');
});

test('a maxLength the build sends that is no length counts one character, and one it never sends the 100 of the SDK: the floor is never more than can have been created', () => {
  // The build sends any value that is truthy as it is (`if (c.maxLength)`), and the platform refuses it or reads it as it pleases.
  for (const sent of ['300', 1.5, -5, true, Infinity, [], {}]) {
    const e = entity(undefined, [{ schemaName: 'new_odd', type: 'Text', maxLength: sent }]);
    assert.strictEqual(keyBytesAtLeast(e, key(['new_odd']), 120), 2, `${typeof sent} ${String(sent)}`);
  }
  for (const unsent of [0, '', null, false, undefined, NaN]) {
    const e = entity(undefined, [{ schemaName: 'new_odd', type: 'Text', maxLength: unsent }]);
    assert.strictEqual(keyBytesAtLeast(e, key(['new_odd']), 120), 200, `${typeof unsent} ${String(unsent)}`);
  }
});

test('every type of column the build creates is sized on purpose: a text column by its length, and every other as a single byte — the floor claims nothing about a size that was not measured', () => {
  const sized = { Text: 2 * 300, AutoNumber: 2 * 100 };
  for (const type of Object.keys(SDK_COLUMN_TYPE)) {
    const e = entity(undefined, [{ schemaName: 'new_col', type, maxLength: 300 }]);
    assert.strictEqual(keyBytesAtLeast(e, key(['new_col']), 120), sized[type] || 1, type);
  }
  // Customer is no entry of SDK_COLUMN_TYPE: createCustomerColumn makes it — a lookup, a type a key can hold, whose size was not measured either.
  assert.strictEqual(keyBytesAtLeast(entity(undefined, [{ schemaName: 'new_col', type: 'Customer' }]), key(['new_col']), 120), 1, 'Customer');
});

test('where a key has room follows from the lengths the build creates: an auto-number column, or one that gives no type, is 100 characters whatever maxLength it carries', () => {
  for (const [what, column] of [
    ['an auto-number column', { schemaName: 'new_ref', type: 'AutoNumber', autoNumberFormat: 'R-{SEQNUM:4}', maxLength: 900 }],
    ['a column that gives no type', { schemaName: 'new_ref', maxLength: 900 }],
  ]) {
    const e = entity(undefined, [column]);
    const pair = key(['new_name', 'new_ref']);
    assert.strictEqual(keyCannotFitAt(e, pair, 850), true, `${what}: 1,900 bytes beside a name column of 850 characters`);
    assert.strictEqual(keyCannotFitAt(e, pair, 120), false, `${what}: 440 bytes at the 120 the spec asks`);
    assert.strictEqual(keyHasRoomOnlyAfterLength(e, pair), true, `${what}: so only the length step gives it room`);
    assert.strictEqual(keyCannotFitAt(e, pair, 600), false, `${what}: 1,400 bytes beside a name column of 600 characters — it fits, and a key that fits is not moved`);
    assert.strictEqual(keyCannotFitAt(e, pair, 750), false, `${what}: 1,700 bytes, to the byte`);
    assert.strictEqual(keyCannotFitAt(e, pair, 751), true, what);
  }
  const text = entity(undefined, [{ schemaName: 'new_ref', type: 'Text', maxLength: 900 }]);
  assert.strictEqual(keyHasRoomOnlyAfterLength(text, key(['new_name', 'new_ref'])), false, 'a Text column of 900 characters is created 900 long: no length of the name column leaves room for it');
});
