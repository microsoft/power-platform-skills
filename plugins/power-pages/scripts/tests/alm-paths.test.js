'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { almDir, almPath, ensureAlmDir, FILE_NAMES, ALM_DIR, planDataPath, planHtmlPath } = require('../lib/alm-paths');

function makeTmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alm-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('ALM_DIR is the canonical docs/alm folder', () => {
  assert.equal(ALM_DIR, 'docs/alm');
});

test('FILE_NAMES exposes the 14 ALM artifact keys without leading dots', () => {
  const expected = [
    'planContext', 'sizeEstimate', 'splitPlan', 'hostResolution', 'envVars',
    'lastPipeline', 'lastDeploy', 'lastHostCheck', 'lastImport',
    'lastActivate', 'lastTestSite', 'lastForceLink', 'lastEnvVars',
    'lastExport',
  ];
  assert.deepEqual(Object.keys(FILE_NAMES).sort(), expected.slice().sort());
  for (const name of Object.values(FILE_NAMES)) {
    assert.ok(!name.startsWith('.'), `file name ${name} should not start with a dot — it lives in docs/alm/, not the project root`);
    assert.ok(name.endsWith('.json'), `file name ${name} should end with .json`);
  }
});

test('almDir(projectRoot) joins the ALM_DIR onto the project root', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  assert.equal(almDir(root), path.join(root, 'docs', 'alm'));
});

test('almDir throws when projectRoot is missing', () => {
  assert.throws(() => almDir(undefined), /projectRoot is required/);
  assert.throws(() => almDir(''), /projectRoot is required/);
});

test('almPath returns a stable absolute path for known keys', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  assert.equal(almPath(root, 'lastDeploy'), path.join(root, 'docs', 'alm', 'last-deploy.json'));
  assert.equal(almPath(root, 'planContext'), path.join(root, 'docs', 'alm', 'alm-plan-context.json'));
  assert.equal(almPath(root, 'hostResolution'), path.join(root, 'docs', 'alm', 'alm-host-resolution.json'));
});

test('almPath throws for unknown keys (catches typos at call-site)', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  assert.throws(() => almPath(root, 'lastPipelne'), /unknown key/);
  assert.throws(() => almPath(root, 'somethingMadeUp'), /unknown key/);
});

test('ensureAlmDir creates docs/alm/ if it does not exist', (t) => {
  const root = makeTmp(t);
  assert.equal(fs.existsSync(path.join(root, 'docs', 'alm')), false, 'precondition: docs/alm/ should not exist');
  const created = ensureAlmDir(root);
  assert.equal(created, path.join(root, 'docs', 'alm'));
  assert.equal(fs.existsSync(created), true);
  assert.equal(fs.statSync(created).isDirectory(), true);
});

test('ensureAlmDir is idempotent when docs/alm/ already exists', (t) => {
  const root = makeTmp(t);
  fs.mkdirSync(path.join(root, 'docs', 'alm'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'alm', 'sentinel.txt'), 'pre-existing');
  ensureAlmDir(root);
  // Sentinel file must still be there — recursive mkdir on existing dir is a no-op
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'alm', 'sentinel.txt'), 'utf8'), 'pre-existing');
});

test('planDataPath / planHtmlPath resolve to the docs/ ROOT, not docs/alm/', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  // The rendered plan + backing JSON intentionally live at docs/ (NOT docs/alm/).
  assert.equal(planDataPath(root), path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planHtmlPath(root), path.join(root, 'docs', 'alm-plan.html'));
  // Guard the dotfile + non-alm-subdir invariant the helpers exist to centralize.
  assert.ok(planDataPath(root).endsWith(path.join('docs', '.alm-plan-data.json')));
  assert.ok(!planDataPath(root).includes(path.join('docs', 'alm', '')), 'plan data must NOT be under docs/alm/');
});

test('planDataPath / planHtmlPath throw when projectRoot is missing', () => {
  assert.throws(() => planDataPath(undefined), /projectRoot is required/);
  assert.throws(() => planDataPath(''), /projectRoot is required/);
  assert.throws(() => planHtmlPath(undefined), /projectRoot is required/);
  assert.throws(() => planHtmlPath(''), /projectRoot is required/);
});

test('every FILE_NAMES entry resolves via almPath without error', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  for (const key of Object.keys(FILE_NAMES)) {
    const p = almPath(root, key);
    assert.ok(p.includes(FILE_NAMES[key]), `${key} → ${p} should contain ${FILE_NAMES[key]}`);
    assert.ok(p.startsWith(path.join(root, 'docs', 'alm')), `${key} should live under docs/alm/`);
  }
});
