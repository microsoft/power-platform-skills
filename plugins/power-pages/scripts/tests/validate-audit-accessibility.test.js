#!/usr/bin/env node
/**
 * Tests for audit-accessibility/scripts/validate-audit-accessibility.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const VALIDATOR = path.join(
  __dirname,
  '../../skills/audit-accessibility/scripts/validate-audit-accessibility.js'
);

const REPORT_REL = 'docs/accessibility/accessibility-audit.md';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-audit-accessibility-'));
  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), '{}', 'utf8');
  return dir;
}

function writeMarker(dir, data) {
  const target = path.join(dir, 'docs', 'accessibility');
  fs.mkdirSync(target, { recursive: true });
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  fs.writeFileSync(path.join(target, 'last-audit.json'), body, 'utf8');
}

function writeReport(dir, content = '# Accessibility audit: Contoso\n\nNo issues.\n') {
  const full = path.join(dir, REPORT_REL);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function validMarker(overrides = {}) {
  return {
    schemaVersion: 1,
    skill: 'audit-accessibility',
    status: 'Completed',
    outcome: 'failed',
    baseUrl: 'https://contoso.powerappsportals.com/',
    finishedAt: '2025-01-01T00:00:00.000Z',
    signedIn: false,
    sessionRemoved: true,
    reportFile: REPORT_REL,
    summary: { pagesAudited: 3, pageErrors: 0, statesAudited: 1, stateErrors: 0, violations: 4, blocking: 2, needsReview: 1 },
    ...overrides,
  };
}

function runValidator(cwd) {
  const result = spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { code: result.status, stderr: result.stderr || '' };
}

test('approves when no marker exists (skill just invoked)', () => {
  const dir = makeProject();
  assert.equal(runValidator(dir).code, 0);
});

test('approves when cwd is not a Power Pages project and has no marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-audit-accessibility-'));
  assert.equal(runValidator(dir).code, 0);
});

test('approves a completed audit with blocking violations (failures are a normal result)', () => {
  const dir = makeProject();
  writeReport(dir);
  writeMarker(dir, validMarker());
  const result = runValidator(dir);
  assert.equal(result.code, 0, result.stderr);
});

test('approves a signed-in audit after the session is removed', () => {
  const dir = makeProject();
  writeReport(dir);
  writeMarker(dir, validMarker({ signedIn: true, sessionRemoved: true }));
  assert.equal(runValidator(dir).code, 0);
});

test('approves an incomplete audit without a report', () => {
  const dir = makeProject();
  writeMarker(dir, { schemaVersion: 1, skill: 'audit-accessibility', status: 'Incomplete', signedIn: false });
  assert.equal(runValidator(dir).code, 0);
});

test('finds the marker from a subdirectory of the project', () => {
  const dir = makeProject();
  writeReport(dir);
  writeMarker(dir, validMarker());
  const sub = path.join(dir, 'src');
  fs.mkdirSync(sub);
  assert.equal(runValidator(sub).code, 0);
});

test('blocks malformed JSON', () => {
  const dir = makeProject();
  writeMarker(dir, '{ not json');
  const result = runValidator(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /not valid JSON/);
});

test('blocks an unknown status', () => {
  const dir = makeProject();
  writeReport(dir);
  writeMarker(dir, validMarker({ status: 'Done' }));
  const result = runValidator(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /status must be/);
});

test('blocks a completed audit missing required fields', () => {
  const dir = makeProject();
  writeReport(dir);
  writeMarker(dir, validMarker({ baseUrl: undefined, summary: undefined, outcome: 'ok' }));
  const result = runValidator(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /missing baseUrl/);
  assert.match(result.stderr, /missing summary/);
  assert.match(result.stderr, /outcome must be/);
});

test('blocks an outcome that hides blocking issues', () => {
  const dir = makeProject();
  writeReport(dir);
  writeMarker(dir, validMarker({ outcome: 'passed' }));
  const result = runValidator(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /use "failed"/);
});

test('blocks when a signed-in session was not removed', () => {
  const dir = makeProject();
  writeReport(dir);
  writeMarker(dir, validMarker({ signedIn: true, sessionRemoved: false }));
  const result = runValidator(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /session file may still be on disk/);
});

test('blocks when the report file is missing', () => {
  const dir = makeProject();
  writeMarker(dir, validMarker());
  const result = runValidator(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /reportFile not found/);
});

test('blocks a report path outside the project', () => {
  const dir = makeProject();
  writeMarker(dir, validMarker({ reportFile: '../outside.md' }));
  const result = runValidator(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /inside the project/);
});

test('blocks a report with unreplaced template placeholders', () => {
  const dir = makeProject();
  writeReport(dir, '# Accessibility audit: {{site name}}\n');
  writeMarker(dir, validMarker());
  const result = runValidator(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unreplaced/);
});

test('blocks a report that references the session file', () => {
  const dir = makeProject();
  writeReport(dir, '# Audit\n\nSession: /tmp/pp-a11y-auth-abc/storage-state.json\n');
  writeMarker(dir, validMarker());
  const result = runValidator(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /references the session file/);
});
