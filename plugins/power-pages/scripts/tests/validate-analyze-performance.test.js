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

function runValidator(projectRoot, reportPath = null) {
  const args = [VALIDATOR_PATH];
  if (reportPath) args.push('--reportPath', reportPath);
  return spawnSync(process.execPath, args, {
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
  const reportPath = writeProjectFile(
    projectRoot,
    'docs/performance-analysis-2026-05-14-053805.html',
    GOOD_REPORT,
  );

  const result = runValidator(projectRoot, reportPath);
  assert.equal(result.status, 0, result.stderr);
});

test('validates the explicit report instead of historical reports', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'docs/performance-analysis-2026-01-01-000000.html', 'tiny');
  const currentReport = writeProjectFile(
    projectRoot,
    'docs/performance-analysis-2026-05-14-053805.html',
    GOOD_REPORT,
  );

  const result = runValidator(projectRoot, currentReport);
  assert.equal(result.status, 0, result.stderr);
});

test('hook mode ignores historical malformed reports', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'docs/performance-analysis-2026-01-01-000000.html', 'tiny');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks when the explicit report was not created', (t) => {
  const projectRoot = createTempProject(t);
  const missing = path.join(projectRoot, 'docs', 'performance-analysis-2026-05-14-053805.html');

  const result = runValidator(projectRoot, missing);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /was not created/);
});

test('blocks a report with unreplaced template placeholders', (t) => {
  const projectRoot = createTempProject(t);
  // __REVIEW_DATA__ left in place means render-template.js could not populate it.
  const broken = '<html><body>' + 'y'.repeat(600) + '__REVIEW_DATA__</body></html>';
  const reportPath = writeProjectFile(
    projectRoot,
    'docs/performance-analysis-2026-05-14-053805.html',
    broken,
  );

  const result = runValidator(projectRoot, reportPath);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unreplaced template placeholders/);
});

test('blocks a suspiciously small report', (t) => {
  const projectRoot = createTempProject(t);
  const reportPath = writeProjectFile(
    projectRoot,
    'docs/performance-analysis-2026-05-14-053805.html',
    '<html></html>',
  );

  const result = runValidator(projectRoot, reportPath);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /suspiciously small/);
});

test('approves a non-SPA site (only .powerpages-site, no config) with a good report', (t) => {
  const projectRoot = createTempProject(t); // seeds .powerpages-site/ but no config
  const reportPath = writeProjectFile(
    projectRoot,
    'docs/performance-analysis-2026-05-14-053805.html',
    GOOD_REPORT,
  );

  const result = runValidator(projectRoot, reportPath);
  assert.equal(result.status, 0, result.stderr);
});

test('approves a non-SPA PAC download with a good report', (t) => {
  const projectRoot = createNonSpaProject(t);
  const reportPath = writeProjectFile(
    projectRoot,
    'docs/performance-analysis-2026-05-14-053805.html',
    GOOD_REPORT,
  );

  const result = runValidator(projectRoot, reportPath);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks a suspiciously small non-SPA PAC download report', (t) => {
  const projectRoot = createNonSpaProject(t);
  const reportPath = writeProjectFile(
    projectRoot,
    'docs/performance-analysis-2026-05-14-053805.html',
    '<html></html>',
  );

  const result = runValidator(projectRoot, reportPath);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /suspiciously small/);
});
