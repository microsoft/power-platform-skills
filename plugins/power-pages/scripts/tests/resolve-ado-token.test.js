'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveAdoToken } = require('../lib/resolve-ado-token');

// ===== resolution order =====

test('explicit --token wins over everything', () => {
  const r = resolveAdoToken({
    token: 'raw-bearer',
    tokenFile: '/should/not/read',
    env: { ADO_TOKEN: 'env-bearer' },
    _readFileImpl: () => { throw new Error('should not read'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'raw-bearer');
  assert.equal(r.source, 'token');
});

test('--tokenFile JSON envelope (get-ado-token --writeToFile format) → extracts .token', () => {
  const envelope = JSON.stringify({ token: 'jwt-from-envelope', tokenFile: '/x', tokenSha256: 'abc' });
  const r = resolveAdoToken({
    tokenFile: 'C:/tmp/.ado-token',
    env: { ADO_TOKEN: 'env-bearer' },
    _readFileImpl: () => envelope,
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'jwt-from-envelope', 'must extract .token from the envelope, not env');
  assert.equal(r.source, 'tokenFile:json');
});

test('--tokenFile raw token file → uses trimmed content', () => {
  const r = resolveAdoToken({
    tokenFile: 'C:/tmp/raw.txt',
    _readFileImpl: () => '  raw-token-value\n',
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'raw-token-value');
  assert.equal(r.source, 'tokenFile:raw');
});

test('ADO_TOKEN env var is used when no token/tokenFile given', () => {
  const r = resolveAdoToken({ env: { ADO_TOKEN: 'env-bearer' } });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'env-bearer');
  assert.equal(r.source, 'env:ADO_TOKEN');
});

test('error when nothing is provided', () => {
  const r = resolveAdoToken({ env: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /No ADO token provided/);
  assert.match(r.error, /--tokenFile/);
});

// ===== robustness =====

test('JSON envelope with no token field → clear error', () => {
  const r = resolveAdoToken({
    tokenFile: 'C:/tmp/.ado-token',
    _readFileImpl: () => JSON.stringify({ tokenFile: '/x', tokenSha256: 'abc' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no non-empty "token" field/);
});

test('malformed JSON tokenFile → clear error', () => {
  const r = resolveAdoToken({
    tokenFile: 'C:/tmp/.ado-token',
    _readFileImpl: () => '{ not json',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /failed to parse/);
});

test('empty tokenFile → clear error', () => {
  const r = resolveAdoToken({ tokenFile: 'C:/tmp/empty', _readFileImpl: () => '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /is empty/);
});

test('unreadable tokenFile → clear error', () => {
  const r = resolveAdoToken({
    tokenFile: 'C:/tmp/missing',
    _readFileImpl: () => { throw new Error('ENOENT'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not read --tokenFile/);
});

// ===== real-file round trip with the actual get-ado-token envelope shape =====

test('round-trips a real on-disk JSON envelope', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-ado-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.ado-token');
  fs.writeFileSync(file, JSON.stringify({ token: 'disk-jwt', tokenFile: file, tokenSha256: 'deadbeef' }, null, 2));
  const r = resolveAdoToken({ tokenFile: file });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'disk-jwt');
});
