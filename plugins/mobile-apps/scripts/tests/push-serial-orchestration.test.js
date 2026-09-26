'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), 'utf8');
}

test('remaining push workers are removed', () => {
  assert.equal(
    fs.existsSync(path.join(PLUGIN_ROOT, 'agents/push-runtime-worker.md')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(PLUGIN_ROOT, 'agents/push-ios-prerequisites-worker.md')),
    false,
  );
});

test('add-push-notifications owns runtime work without Task delegation', () => {
  const skill = read('skills/add-push-notifications/SKILL.md');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';

  assert.doesNotMatch(frontmatter, /\bTask\b/);
  assert.match(skill, /implements runtime integration directly/i);
  assert.match(skill, /Execute them\s+directly and serially in this skill/);
  assert.doesNotMatch(
    skill,
    /push-runtime-worker|push-ios-prerequisites-worker|WORKER_RESULT|operation: preflight|exclusive_files/,
  );
});

test('iOS prerequisites run through separate serial owners', () => {
  const skill = read('skills/add-push-notifications/SKILL.md');
  const appleIndex = skill.indexOf('/setup-apple-ios --working-dir <root>');
  const apnsIndex = skill.indexOf('/setup-apns --working-dir <root>');

  assert.ok(appleIndex >= 0, 'setup-apple-ios is invoked');
  assert.ok(apnsIndex > appleIndex, 'setup-apns follows setup-apple-ios');
  assert.match(skill, /Never invoke `\/setup-apns` before `\/setup-apple-ios` is complete/);
});

test('Apple and APNs owners expose only direct interactive contracts', () => {
  for (const relativePath of [
    'skills/setup-apple-ios/SKILL.md',
    'skills/setup-apns/SKILL.md',
    'shared/references/apple-ios-signing-provisioning.md',
  ]) {
    const content = read(relativePath);
    assert.doesNotMatch(
      content,
      /push-ios-prerequisites-worker|WORKER_RESULT|operation: preflight|exclusive_files|pre-wave/,
      `${relativePath} has no worker protocol`,
    );
  }

  assert.match(read('skills/setup-apple-ios/SKILL.md'), /update `memory-bank\.md`/);
  assert.match(read('skills/setup-apns/SKILL.md'), /update\s+`memory-bank\.md`/);
});

test('serial orchestration evals cover runtime and Apple-to-APNs ordering', () => {
  const evals = JSON.parse(
    read('skills/add-push-notifications/evals/evals.json'),
  ).evals;
  const coverage = new Set(evals.map((entry) => entry.coverage));

  for (const expected of [
    'fully-serial-push-orchestration',
    'inline-single-platform-runtime',
    'task-unavailable-irrelevant',
    'serial-owner-tool-context',
    'serial-memory-updates',
    'serial-ios-owner-order',
    'no-push-worker-preflight',
  ]) {
    assert.ok(coverage.has(expected), expected);
  }
});
