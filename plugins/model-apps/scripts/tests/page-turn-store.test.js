'use strict';
// The file store of page turn records (lib/page-turn-store.js): the first record for an id wins, and a record it cannot read is refused and left as it is.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeTurnBindingStore, appTurnsDir } = require('../lib/page-turn-store.js');
const { makeTurnRecord } = require('../lib/page-turn-intent.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const TURN = '6f1c2a4e-9b3d-47a1-b85c-0e2f7d914a63';
const PAGE = '77777777-7777-4777-8777-777777777777';
const recordFor = (pageId, request = 'a') => makeTurnRecord({ turnId: TURN, operation: 'update', environmentFingerprint: 'e'.repeat(64), pageId, requestSha256: request.repeat(64), effectiveInputsSha256: 'f'.repeat(64) });
const incomplete = (e) => e.code === 'GENPAGE_TURN_STATE_INCOMPLETE' && e.outcome === 'nothing';

test('the first record bound for an id wins — across two store objects on one folder — and the folder holds only it', () => {
  const folder = path.join(makeTempDir('turn-store-'), 'turns');
  const one = makeTurnBindingStore(folder);
  const two = makeTurnBindingStore(folder);
  assert.strictEqual(one.get(TURN), null);
  const first = recordFor(PAGE);
  assert.deepStrictEqual(one.bind(TURN, first), first);
  const second = recordFor('88888888-8888-4888-8888-888888888888', 'b');
  assert.deepStrictEqual(two.bind(TURN.toUpperCase(), second), first, 'the loser reads the winner back');
  assert.deepStrictEqual(two.get(TURN), first);
  assert.deepStrictEqual(fs.readdirSync(folder), [`${TURN}.json`], 'no temporary file is left behind');
  assert.strictEqual(appTurnsDir(path.join('apps', 'contoso')), path.join('apps', 'contoso', '.maker-workspace', 'turns'));
});

test('a record that cannot be read as a complete one — broken JSON, an earlier format — is refused, by get and by bind, and left exactly as it was', () => {
  const folder = makeTempDir('turn-store-');
  const store = makeTurnBindingStore(folder);
  const file = path.join(folder, `${TURN}.json`);
  for (const text of ['{"formatVersion": 2, "turnId"', JSON.stringify({ formatVersion: 1, turnId: TURN, pageId: PAGE, requestSha256: 'a'.repeat(64) })]) {
    fs.writeFileSync(file, text);
    assert.throws(() => store.get(TURN), incomplete);
    assert.throws(() => store.bind(TURN, recordFor(PAGE)), incomplete);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'never overwritten or repaired');
  }
});

test('a record a store is handed must be a complete one, and a read that fails other than "not there" is not "no record"', () => {
  const folder = makeTempDir('turn-store-');
  assert.throws(() => makeTurnBindingStore(folder).bind(TURN, { ...recordFor(PAGE), pageId: 'x' }), incomplete);
  assert.deepStrictEqual(fs.readdirSync(folder), []);
  const denied = makeTurnBindingStore(folder, { fs: { ...fs, readFileSync: () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); } } });
  assert.throws(() => denied.get(TURN), (e) => e.code === 'EACCES');
});
