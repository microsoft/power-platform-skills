'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, readJsonArg, label, requiredLevel } = require('../lib/dataverse-auth');

test('parseArgs: positional only', () => {
  const { positional, flags } = parseArgs(['a', 'b', 'c']);
  assert.deepEqual(positional, ['a', 'b', 'c']);
  assert.deepEqual(flags, {});
});

test('parseArgs: mix of positional and flags', () => {
  const { positional, flags } = parseArgs(['a', '--foo', 'bar', 'b', '--baz']);
  assert.deepEqual(positional, ['a', 'b']);
  assert.deepEqual(flags, { foo: 'bar', baz: true });
});

test('parseArgs: bool flag followed by another flag treats first as bool', () => {
  const { flags } = parseArgs(['--x', '--y', '1']);
  assert.deepEqual(flags, { x: true, y: '1' });
});

test('parseArgs: repeated flag overwrites', () => {
  const { flags } = parseArgs(['--foo', '1', '--foo', '2']);
  assert.equal(flags.foo, '2');
});

test('parseArgs: --key=value form', () => {
  const { positional, flags } = parseArgs(['x', '--foo=bar', '--baz=qux', 'y']);
  assert.deepEqual(positional, ['x', 'y']);
  assert.deepEqual(flags, { foo: 'bar', baz: 'qux' });
});

test('parseArgs: --key=value with empty value', () => {
  const { flags } = parseArgs(['--foo=']);
  assert.equal(flags.foo, '');
});

test('parseArgs: --key=value preserves additional = signs in value', () => {
  const { flags } = parseArgs(['--query=a=b=c']);
  assert.equal(flags.query, 'a=b=c');
});

test('parseArgs: mixed --key=value and --key value forms', () => {
  const { flags } = parseArgs(['--foo=bar', '--baz', 'qux']);
  assert.deepEqual(flags, { foo: 'bar', baz: 'qux' });
});

test('readJsonArg: inline JSON', () => {
  assert.deepEqual(readJsonArg('{"a":1}'), { a: 1 });
});

test('readJsonArg: file path with @ prefix', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), `dv-auth-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ from: 'file' }));
  try {
    assert.deepEqual(readJsonArg('@' + tmp), { from: 'file' });
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('readJsonArg: null and undefined pass through', () => {
  assert.equal(readJsonArg(null), null);
  assert.equal(readJsonArg(undefined), null);
});

test('label: builds Dataverse verbose Label object', () => {
  const out = label('Hello');
  assert.equal(out['@odata.type'], 'Microsoft.Dynamics.CRM.Label');
  assert.equal(out.LocalizedLabels.length, 1);
  assert.equal(out.LocalizedLabels[0].Label, 'Hello');
  assert.equal(out.LocalizedLabels[0].LanguageCode, 1033);
});

test('label: respects custom language code', () => {
  const out = label('Bonjour', 1036);
  assert.equal(out.LocalizedLabels[0].LanguageCode, 1036);
});

test('requiredLevel: defaults to None and is mutable', () => {
  const out = requiredLevel();
  assert.equal(out.Value, 'None');
  assert.equal(out.CanBeChanged, true);
});

test('requiredLevel: respects argument', () => {
  assert.equal(requiredLevel('ApplicationRequired').Value, 'ApplicationRequired');
});

test('emitResult: partial-failure object writes JSON to stdout (not [object Object])', () => {
  // Spawn a tiny script that calls emitResult(false, {errors:[...]}) and
  // verify that stdout contains the JSON payload — not the literal string
  // "[object Object]". Regression guard for the bulk-insert failure path.
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const libPath = path.join(__dirname, '..', 'lib', 'dataverse-auth.js');
  const code = `
    const { emitResult } = require(${JSON.stringify(libPath)});
    emitResult(false, { ok: false, count: 0, ids: [], errors: [{ index: 0, status: 400, message: 'bad row' }] });
  `;
  const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.equal(res.status, 1, 'expected exit 1');
  assert.doesNotMatch(res.stdout, /\[object Object\]/, 'stdout must not be [object Object]');
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].index, 0);
  assert.equal(parsed.errors[0].status, 400);
  assert.equal(parsed.errors[0].message, 'bad row');
  assert.match(res.stderr, /Operation completed with 1 error/);
});
