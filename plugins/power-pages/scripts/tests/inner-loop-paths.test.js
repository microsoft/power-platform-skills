'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  INNER_LOOP_DIR,
  FILE_NAMES,
  innerLoopDir,
  innerLoopPath,
  ensureInnerLoopDir,
  gitIntegrationManifestPath,
  requireProjectRoot,
  RUNWAY_HARD_ERROR_DATE,
} = require('../lib/inner-loop-paths');

function makeTmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-loop-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('INNER_LOOP_DIR is the canonical docs/inner-loop folder (sibling of docs/alm)', () => {
  assert.equal(INNER_LOOP_DIR, 'docs/inner-loop');
});

test('FILE_NAMES exposes the inner-loop artifact keys and uses kebab-case file names', () => {
  // Snapshot test: lock the key set so a careless rename or missing key is loud.
  const expected = [
    'plan', 'planHtml',
    'lastCommit', 'lastSync', 'lastValidation',
    'lastConflictResolution', 'lastRevert',
    'lastBranchRevert', 'lastPr', 'lastDiagnosis',
    'preCommitReportHtml', 'conflictsHtml', 'diagnosisHtml',
    'pendingChangesSnapshot', 'pendingChangesCache',
    'lastValidationJunit', 'lastValidationSarif',
    'skillMetricsJsonl',
    'pendingCommitTicket', 'lastTag',
  ];
  assert.deepEqual(Object.keys(FILE_NAMES).sort(), expected.slice().sort());
  for (const name of Object.values(FILE_NAMES)) {
    assert.ok(!name.startsWith('.'),
      `file name ${name} should not start with a dot — it lives in docs/inner-loop/`);
    assert.ok(/^[a-z0-9.-]+\.(json|jsonl|html|xml|sarif)$/.test(name),
      `file name ${name} should be kebab-case .json/.jsonl/.html/.xml/.sarif`);
  }
});

test('FILE_NAMES is frozen (cannot be mutated at runtime)', () => {
  assert.throws(() => { FILE_NAMES.lastCommit = 'last-commit-v2.json'; }, /read.?only|assign|cannot/i);
});

test('innerLoopDir(projectRoot) joins INNER_LOOP_DIR onto the project root', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  assert.equal(innerLoopDir(root), path.join(root, 'docs', 'inner-loop'));
});

test('innerLoopDir throws when projectRoot is missing', () => {
  assert.throws(() => innerLoopDir(undefined), /projectRoot is required/);
  assert.throws(() => innerLoopDir(''), /projectRoot is required/);
});

test('innerLoopPath returns a stable absolute path for known keys', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  assert.equal(
    innerLoopPath(root, 'plan'),
    path.join(root, 'docs', 'inner-loop', 'inner-loop-plan.json'),
  );
  assert.equal(
    innerLoopPath(root, 'lastCommit'),
    path.join(root, 'docs', 'inner-loop', 'last-commit.json'),
  );
  assert.equal(
    innerLoopPath(root, 'conflictsHtml'),
    path.join(root, 'docs', 'inner-loop', 'conflicts.html'),
  );
  assert.equal(
    innerLoopPath(root, 'pendingChangesSnapshot'),
    path.join(root, 'docs', 'inner-loop', 'pending-changes-snapshot.json'),
  );
  assert.equal(
    innerLoopPath(root, 'pendingChangesCache'),
    path.join(root, 'docs', 'inner-loop', 'pending-changes-cache.json'),
  );
  assert.equal(
    innerLoopPath(root, 'lastValidationJunit'),
    path.join(root, 'docs', 'inner-loop', 'last-validation.junit.xml'),
  );
  assert.equal(
    innerLoopPath(root, 'lastValidationSarif'),
    path.join(root, 'docs', 'inner-loop', 'last-validation.sarif'),
  );
});

test('innerLoopPath throws for unknown keys (catches typos at call-site)', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  assert.throws(() => innerLoopPath(root, 'lastCommt'), /unknown key/);
  assert.throws(() => innerLoopPath(root, 'somethingMadeUp'), /unknown key/);
});

test('ensureInnerLoopDir creates docs/inner-loop/ if it does not exist', (t) => {
  const root = makeTmp(t);
  assert.equal(fs.existsSync(path.join(root, 'docs', 'inner-loop')), false,
    'precondition: docs/inner-loop/ should not exist yet');
  const created = ensureInnerLoopDir(root);
  assert.equal(created, path.join(root, 'docs', 'inner-loop'));
  assert.ok(fs.statSync(created).isDirectory());
});

test('ensureInnerLoopDir is idempotent when docs/inner-loop/ already exists', (t) => {
  const root = makeTmp(t);
  fs.mkdirSync(path.join(root, 'docs', 'inner-loop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'inner-loop', 'sentinel.txt'), 'pre-existing');
  ensureInnerLoopDir(root);
  assert.equal(
    fs.readFileSync(path.join(root, 'docs', 'inner-loop', 'sentinel.txt'), 'utf8'),
    'pre-existing',
  );
});

test('every FILE_NAMES entry resolves via innerLoopPath without error', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  for (const key of Object.keys(FILE_NAMES)) {
    const p = innerLoopPath(root, key);
    assert.ok(p.includes(FILE_NAMES[key]),
      `${key} → ${p} should contain ${FILE_NAMES[key]}`);
    assert.ok(p.startsWith(path.join(root, 'docs', 'inner-loop')),
      `${key} should live under docs/inner-loop/`);
  }
});

test('gitIntegrationManifestPath returns project-root manifest (NOT under docs/inner-loop/)', () => {
  const root = path.join(path.sep, 'tmp', 'project');
  const expected = path.join(root, '.git-integration-manifest.json');
  assert.equal(gitIntegrationManifestPath(root), expected);
  // Must NOT live under docs/inner-loop/ — see file header rationale.
  assert.ok(!gitIntegrationManifestPath(root).includes('inner-loop'));
});

test('gitIntegrationManifestPath throws when projectRoot is missing', () => {
  assert.throws(() => gitIntegrationManifestPath(undefined), /projectRoot is required/);
  assert.throws(() => gitIntegrationManifestPath(''), /projectRoot is required/);
});

// ===== requireProjectRoot (B2) =====

test('requireProjectRoot returns the explicit root unchanged and never warns', () => {
  let warned = false;
  const out = requireProjectRoot('C:/explicit/root', { _warn: () => { warned = true; } });
  assert.equal(out, 'C:/explicit/root');
  assert.equal(warned, false, 'explicit root must not trigger the deprecation warning');
});

test('requireProjectRoot warns and falls back to fallbackResolver when root is absent', () => {
  const msgs = [];
  const out = requireProjectRoot(undefined, {
    caller: 'unit-test',
    fallbackResolver: () => 'C:/fallback/root',
    _warn: (m) => msgs.push(m),
  });
  assert.equal(out, 'C:/fallback/root');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /DEPRECATION WARN/);
  assert.match(msgs[0], /unit-test/);
  assert.match(msgs[0], /C:\/fallback\/root/);
  assert.match(msgs[0], new RegExp(RUNWAY_HARD_ERROR_DATE));
});

test('requireProjectRoot falls back to cwd when no fallbackResolver is supplied', () => {
  const msgs = [];
  const out = requireProjectRoot(null, { _warn: (m) => msgs.push(m) });
  assert.equal(out, process.cwd());
  assert.equal(msgs.length, 1);
});

test('RUNWAY_HARD_ERROR_DATE is an ISO date string', () => {
  assert.match(RUNWAY_HARD_ERROR_DATE, /^\d{4}-\d{2}-\d{2}$/);
});
