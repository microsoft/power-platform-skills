'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTempProject, writeProjectFile } = require('./test-utils');

const VALIDATOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'analyze-performance',
  'scripts',
  'validate-analyze-performance.js',
);

function runValidator(projectRoot) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
  });
}

// A minimally realistic rendered report: >500 bytes and free of __KEY__ tokens.
const GOOD_REPORT = '<!doctype html><html><head><title>Performance Analysis</title></head><body>' +
  '<h1>Performance Analysis</h1>' + 'x'.repeat(600) + '</body></html>';

function createNonSpaProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-non-spa-validator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.portalconfig'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web-pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'website.yml'), 'adx_name: Non-SPA Site\n');
  return root;
}

test('approves when the cwd is outside any Power Pages project', (t) => {
  // createTempProject seeds .powerpages-site/, so write to a bare tmp dir instead.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-noproj-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));

  const result = runValidator(bare);
  assert.equal(result.status, 0, result.stderr);
});

test('approves when the project has no performance report yet (in-progress / prereqs failed)', (t) => {
  const projectRoot = createTempProject(t);
  // No docs/performance-analysis-*.html written.
  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('approves a well-formed timestamped performance report', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'docs/performance-analysis-2026-05-14-053805.html', GOOD_REPORT);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('picks the newest report when several exist', (t) => {
  const projectRoot = createTempProject(t);
  // Older report is broken; newest is good. Lexicographic sort ⇒ newest wins,
  // so the validator must approve based on the newest file.
  writeProjectFile(projectRoot, 'docs/performance-analysis-2026-01-01-000000.html', 'tiny');
  writeProjectFile(projectRoot, 'docs/performance-analysis-2026-05-14-053805.html', GOOD_REPORT);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks a report with unreplaced template placeholders', (t) => {
  const projectRoot = createTempProject(t);
  // __REVIEW_DATA__ left in place means render-template.js could not populate it.
  const broken = '<html><body>' + 'y'.repeat(600) + '__REVIEW_DATA__</body></html>';
  writeProjectFile(projectRoot, 'docs/performance-analysis-2026-05-14-053805.html', broken);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unreplaced template placeholders/);
});

test('blocks a suspiciously small report', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'docs/performance-analysis-2026-05-14-053805.html', '<html></html>');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /suspiciously small/);
});

test('approves a non-SPA site (only .powerpages-site, no config) with a good report', (t) => {
  const projectRoot = createTempProject(t); // seeds .powerpages-site/ but no config
  writeProjectFile(projectRoot, 'docs/performance-analysis-2026-05-14-053805.html', GOOD_REPORT);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('approves a non-SPA PAC download with a good report', (t) => {
  const projectRoot = createNonSpaProject(t);
  writeProjectFile(projectRoot, 'docs/performance-analysis-2026-05-14-053805.html', GOOD_REPORT);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks a suspiciously small non-SPA PAC download report', (t) => {
  const projectRoot = createNonSpaProject(t);
  writeProjectFile(projectRoot, 'docs/performance-analysis-2026-05-14-053805.html', '<html></html>');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /suspiciously small/);
});
