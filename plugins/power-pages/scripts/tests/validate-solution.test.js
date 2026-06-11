#!/usr/bin/env node
/**
 * Tests for setup-solution/scripts/validate-solution.js
 *
 * Coverage focus: the v1/v2 schema dispatch in the manifest validator.
 * Pre-fix the validator was v1-only — a v2 multi-solution manifest hit
 * `block('.solution-manifest.json is missing solution.uniqueName...')`
 * immediately because the singular `solution` field doesn't exist in v2.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const VALIDATOR = path.join(
  __dirname,
  '../../skills/setup-solution/scripts/validate-solution.js',
);

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-solution-'));
  // Validators need a project root with a powerpages.config.json — minimum
  // shape so `findProjectRoot` doesn't return null and silent-approve.
  fs.writeFileSync(
    path.join(dir, 'powerpages.config.json'),
    JSON.stringify({ siteName: 'TestSite' }),
    'utf8',
  );
  return dir;
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(
    path.join(dir, '.solution-manifest.json'),
    JSON.stringify(manifest),
    'utf8',
  );
}

function run(cwd) {
  const cliIsolatedEnv = {
    ...process.env,
    PATH: path.dirname(process.execPath),
    Path: path.dirname(process.execPath),
  };
  const result = spawnSync(process.execPath, [VALIDATOR], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    env: cliIsolatedEnv,
    timeout: 10000,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// --- v1 (legacy) path ------------------------------------------------------

test('v1 manifest with all required fields and website componentType 61 → approve', () => {
  const dir = makeTempProject();
  writeManifest(dir, {
    solution: { uniqueName: 'TestSolution', solutionId: 'sol-1' },
    publisher: { publisherId: 'pub-1' },
    components: [{ componentId: 'web-1', componentType: 61 }],
  });
  const r = run(dir);
  // No env URL configured; validator silent-approves rather than reaching Dataverse.
  assert.equal(r.code, 0, r.stderr);
});

test('v1 manifest missing solution.uniqueName → block', () => {
  const dir = makeTempProject();
  writeManifest(dir, {
    solution: { solutionId: 'sol-1' }, // missing uniqueName
    publisher: { publisherId: 'pub-1' },
    components: [{ componentId: 'web-1', componentType: 61 }],
  });
  const r = run(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /missing solution\.uniqueName/);
});

test('v1 manifest missing website componentType 61 → block', () => {
  const dir = makeTempProject();
  writeManifest(dir, {
    solution: { uniqueName: 'TestSolution', solutionId: 'sol-1' },
    publisher: { publisherId: 'pub-1' },
    components: [{ componentId: 'other', componentType: 99 }],
  });
  const r = run(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /No website component/);
});

// --- v2 (multi-solution) path ---------------------------------------------

test('v2 manifest with solutions[] and website component in one of them → approve', () => {
  const dir = makeTempProject();
  writeManifest(dir, {
    schemaVersion: 2,
    publisher: { publisherId: 'pub-1' },
    solutions: [
      {
        uniqueName: 'TestSite_Core',
        solutionId: 'sol-core',
        order: 1,
        componentTypes: ['Table', 'Web Role'],
        components: [{ componentId: 'web-root', componentType: 61 }],
      },
      {
        uniqueName: 'TestSite_WebAssets',
        solutionId: 'sol-web',
        order: 2,
        componentTypes: ['Web File'],
        components: [],
      },
    ],
  });
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
});

test('v2 manifest detected by Array.isArray(solutions) even when schemaVersion is absent', () => {
  // Defensive: hand-edited manifests sometimes omit schemaVersion but have
  // the v2 solutions[] array. The validator should still dispatch to v2.
  const dir = makeTempProject();
  writeManifest(dir, {
    publisher: { publisherId: 'pub-1' },
    solutions: [
      { uniqueName: 'X_Core', solutionId: 'sx', components: [{ componentType: 61 }] },
    ],
  });
  const r = run(dir);
  assert.equal(r.code, 0, r.stderr);
});

test('v2 manifest with empty solutions[] → block', () => {
  const dir = makeTempProject();
  writeManifest(dir, {
    schemaVersion: 2,
    publisher: { publisherId: 'pub-1' },
    solutions: [],
  });
  const r = run(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /solutions\[\]`? is missing or empty/);
});

test('v2 manifest with an entry missing uniqueName → block with the specific failure', () => {
  const dir = makeTempProject();
  writeManifest(dir, {
    schemaVersion: 2,
    publisher: { publisherId: 'pub-1' },
    solutions: [
      { uniqueName: 'X_Core', solutionId: 'sc', components: [{ componentType: 61 }] },
      { solutionId: 'sw', components: [] },  // missing uniqueName
    ],
  });
  const r = run(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /missing uniqueName/);
});

test('v2 manifest with an entry missing solutionId → block citing the entry by name', () => {
  const dir = makeTempProject();
  writeManifest(dir, {
    schemaVersion: 2,
    publisher: { publisherId: 'pub-1' },
    solutions: [
      { uniqueName: 'X_Core', solutionId: 'sc', components: [{ componentType: 61 }] },
      { uniqueName: 'X_WebAssets', components: [] },  // missing solutionId
    ],
  });
  const r = run(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /X_WebAssets.*missing solutionId/);
});

test('v2 manifest missing publisher.publisherId → block', () => {
  const dir = makeTempProject();
  writeManifest(dir, {
    schemaVersion: 2,
    solutions: [
      { uniqueName: 'X_Core', solutionId: 'sc', components: [{ componentType: 61 }] },
    ],
  });
  const r = run(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /missing publisher\.publisherId/);
});

test('v2 manifest with website component absent from ALL solutions → block', () => {
  const dir = makeTempProject();
  writeManifest(dir, {
    schemaVersion: 2,
    publisher: { publisherId: 'pub-1' },
    solutions: [
      { uniqueName: 'X_Core', solutionId: 'sc', components: [{ componentType: 1 }] },
      { uniqueName: 'X_WebAssets', solutionId: 'sw', components: [] },
    ],
  });
  const r = run(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /No website component/);
});

// --- common safety paths ---------------------------------------------------

test('no manifest at all → silent approve (not a setup-solution session)', () => {
  const dir = makeTempProject();
  const r = run(dir);
  assert.equal(r.code, 0);
});

test('malformed JSON manifest → block with parse error', () => {
  const dir = makeTempProject();
  fs.writeFileSync(path.join(dir, '.solution-manifest.json'), '{ not json ', 'utf8');
  const r = run(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /could not be parsed as JSON/);
});
