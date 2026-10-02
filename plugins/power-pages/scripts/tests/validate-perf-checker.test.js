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
  'perf-checker',
  'scripts',
  'validate-perf-checker.js',
);

function runValidator(projectRoot) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
  });
}

// A minimally realistic rendered report: >500 bytes and free of __KEY__ tokens.
const GOOD_REPORT = '<!doctype html><html><head><title>Performance Check</title></head><body>' +
  '<h1>Performance Check</h1>' + 'x'.repeat(600) + '</body></html>';

function createClassicProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-classic-validator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.portalconfig'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web-pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'website.yml'), 'adx_name: Classic Site\n');
  return root;
}

test('approves when the cwd is outside any Power Pages project', (t) => {
  // createTempProject seeds .powerpages-site/, so write to a bare tmp dir instead.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-noproj-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));

  const result = runValidator(bare);
  assert.equal(result.status, 0, result.stderr);
});

test('approves when the project has no perf report yet (in-progress / prereqs failed)', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  // No docs/perf-check-*.html written.
  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('approves a well-formed timestamped perf report', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'docs/perf-check-2026-05-14-053805.html', GOOD_REPORT);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('picks the newest report when several exist', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  // Older report is broken; newest is good. Lexicographic sort ⇒ newest wins,
  // so the validator must approve based on the newest file.
  writeProjectFile(projectRoot, 'docs/perf-check-2026-01-01-000000.html', 'tiny');
  writeProjectFile(projectRoot, 'docs/perf-check-2026-05-14-053805.html', GOOD_REPORT);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks a report with unreplaced template placeholders', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  // __REVIEW_DATA__ left in place means render-template.js could not populate it.
  const broken = '<html><body>' + 'y'.repeat(600) + '__REVIEW_DATA__</body></html>';
  writeProjectFile(projectRoot, 'docs/perf-check-2026-05-14-053805.html', broken);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unreplaced template placeholders/);
});

test('blocks a suspiciously small report', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'docs/perf-check-2026-05-14-053805.html', '<html></html>');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /suspiciously small/);
});

test('approves a declarative site (only .powerpages-site, no config) with a good report', (t) => {
  const projectRoot = createTempProject(t); // seeds .powerpages-site/ but no config
  writeProjectFile(projectRoot, 'docs/perf-check-2026-05-14-053805.html', GOOD_REPORT);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('approves a classic PAC download with a good report', (t) => {
  const projectRoot = createClassicProject(t);
  writeProjectFile(projectRoot, 'docs/perf-check-2026-05-14-053805.html', GOOD_REPORT);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks a suspiciously small classic PAC download report', (t) => {
  const projectRoot = createClassicProject(t);
  writeProjectFile(projectRoot, 'docs/perf-check-2026-05-14-053805.html', '<html></html>');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /suspiciously small/);
});
