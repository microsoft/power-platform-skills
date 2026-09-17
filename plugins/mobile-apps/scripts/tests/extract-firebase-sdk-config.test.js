'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  extractFirebaseSdkConfig,
} = require('../extract-firebase-sdk-config');

const SCRIPT = path.join(__dirname, '..', 'extract-firebase-sdk-config.js');

function createFixture() {
  return fs.mkdtempSync(path.join(__dirname, '.firebase-sdk-config-fixture-'));
}

function wrap(filename, content) {
  return `SDK config content for \`${filename}\`:\n\n\`\`\`\n${content}\n\`\`\`\n`;
}

function run(root, args, input = '') {
  return spawnSync(process.execPath, [
    SCRIPT,
    '--project-root', root,
    ...args,
  ], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    input,
  });
}

test('extracts the fenced Android config content without rewriting it', () => {
  const content = '{\n  "project_info": { "project_id": "field-service-prod" }\n}';
  assert.deepStrictEqual(
    extractFirebaseSdkConfig(wrap('google-services.json', content), 'android'),
    {
      filename: 'google-services.json',
      content,
    },
  );
});

test('CLI writes the exact extracted config to the candidate path', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firebase'));
  fs.writeFileSync(
    path.join(root, 'firebase', '.android-sdk-config.mcp.txt'),
    wrap('google-services.json', '{ "project_info": { "project_id": "field-service-prod" } }'),
  );

  const result = run(root, [
    '--platform', 'android',
    '--input', 'firebase/.android-sdk-config.mcp.txt',
    '--output', 'firebase/google-services.download.json',
  ]);

  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.status, 'ready');
  assert.deepStrictEqual(output.source, {
    kind: 'file',
    path: 'firebase/.android-sdk-config.mcp.txt',
  });
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'firebase', 'google-services.download.json'), 'utf8'),
    '{ "project_info": { "project_id": "field-service-prod" } }',
  );
});

test('rejects malformed wrappers, unexpected filenames, and credential-shaped payloads', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firebase'));

  const malformed = run(root, [
    '--platform', 'android',
    '--output', 'firebase/google-services.download.json',
  ], 'google-services.json\n{}');
  assert.strictEqual(malformed.status, 1);
  assert.strictEqual(JSON.parse(malformed.stdout).issues[0].code, 'sdk-config-wrapper-invalid');

  const wrongFile = run(root, [
    '--platform', 'android',
    '--output', 'firebase/google-services.download.json',
  ], wrap('GoogleService-Info.plist', '<plist/>'));
  assert.strictEqual(wrongFile.status, 1);
  assert.strictEqual(JSON.parse(wrongFile.stdout).issues[0].code, 'sdk-config-filename-mismatch');

  const secretLike = run(root, [
    '--platform', 'android',
    '--output', 'firebase/google-services.download.json',
  ], wrap('google-services.json', JSON.stringify({
    type: 'service_account',
    private_key: '-----BEGIN PRIVATE KEY-----\nredacted\n-----END PRIVATE KEY-----',
  })));
  assert.strictEqual(secretLike.status, 1);
  assert.strictEqual(JSON.parse(secretLike.stdout).issues[0].code, 'mcp-secret-shaped-content');
});

test('rejects output symlink targets and out-of-root paths', (t) => {
  const root = createFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firebase'));
  fs.symlinkSync(
    path.join(root, 'firebase', 'real.json'),
    path.join(root, 'firebase', 'google-services.download.json'),
  );

  const symlink = run(root, [
    '--platform', 'android',
    '--output', 'firebase/google-services.download.json',
  ], wrap('google-services.json', '{}'));
  assert.strictEqual(symlink.status, 1);
  assert.strictEqual(JSON.parse(symlink.stdout).issues[0].code, 'output-symbolic-link');

  const traversal = run(root, [
    '--platform', 'android',
    '--output', '../outside.json',
  ], wrap('google-services.json', '{}'));
  assert.strictEqual(traversal.status, 1);
  assert.strictEqual(JSON.parse(traversal.stdout).issues[0].code, 'output-outside-project-root');
});
