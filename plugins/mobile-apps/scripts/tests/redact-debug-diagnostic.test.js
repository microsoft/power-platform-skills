'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '..', 'redact-debug-diagnostic.js');
const { redact } = require(scriptPath);

test('keeps project paths relative and removes complete home paths with spaces', () => {
  const workingDir = path.join(os.tmpdir(), 'debug-redaction-project');
  const projectFile = path.join(workingDir, 'app', 'orders.tsx');
  const homeFile = path.join(os.homedir(), 'Other Project', 'customer export.ts');

  const output = redact(`${projectFile}:12:3\n${homeFile}:8:1`, workingDir);

  assert.equal(output, `${path.join('app', 'orders.tsx')}:12:3\n[REDACTED_PATH]:8:1`);
  assert.doesNotMatch(output, /Other Project|customer export/);
});

test('does not relativize a sibling path that only shares the project prefix', () => {
  const workingDir = path.join(os.homedir(), 'app');
  const siblingFile = path.join(os.homedir(), 'application-secrets', 'token.txt');

  assert.equal(redact(`${siblingFile}:3:1`, workingDir), '[REDACTED_PATH]:3:1');
});

test('redacts headers, secrets, emails, and record identifiers', () => {
  const output = redact([
    'Authorization: Bearer abc.def.ghi',
    'Proxy-Authorization \t: Basic dXNlcjpwYXNz',
    'transport failed for Bearer standalone-token',
    'claim=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
    'request?sig=secret&se=expiry&sp=read&sv=version&code=oauth;token=other',
    'my_password=hunter2 _token=token-value authToken=auth-value api_key=key-value',
    'owner@example.com 11111111-1111-1111-1111-111111111111',
    `ghp_${'a'.repeat(30)}`,
  ].join('\n'), path.join(os.tmpdir(), 'project'));

  assert.match(output, /Authorization: \[REDACTED_HEADER\]/);
  assert.match(output, /Proxy-Authorization: \[REDACTED_HEADER\]/);
  assert.match(output, /transport failed for Bearer \[REDACTED_SECRET\]/);
  assert.match(output, /claim=\[REDACTED_SECRET\]/);
  assert.match(output, /sig=\[REDACTED_SECRET\]&se=\[REDACTED_SECRET\]&sp=\[REDACTED_SECRET\]&sv=\[REDACTED_SECRET\]&code=\[REDACTED_SECRET\];token=\[REDACTED_SECRET\]/);
  assert.match(output, /my_password=\[REDACTED_SECRET\] _token=\[REDACTED_SECRET\] authToken=\[REDACTED_SECRET\] api_key=\[REDACTED_SECRET\]/);
  assert.match(output, /\[REDACTED_EMAIL\] \[REDACTED_ID\]/);
  assert.doesNotMatch(output, /dXNlcjpwYXNz|secret|expiry|read|version|oauth|other|hunter2|token-value|auth-value|key-value|owner@example\.com|11111111|ghp_/);
});

test('bounds persisted diagnostics after redaction', () => {
  const output = redact('x'.repeat(5000), path.join(os.tmpdir(), 'project'));

  assert.equal(output, `${'x'.repeat(4096)}\n[TRUNCATED]`);
});

test('CLI applies the same redaction contract', () => {
  const workingDir = path.join(os.tmpdir(), 'debug-redaction-cli');
  const result = spawnSync(
    process.execPath,
    [scriptPath, '--working-dir', workingDir],
    {
      input: `${path.join(workingDir, 'src', 'screen.tsx')}:4 token=secret`,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${path.join('src', 'screen.tsx')}:4 token=[REDACTED_SECRET]`);
});