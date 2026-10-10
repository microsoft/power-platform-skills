'use strict';
// The oracle loaders (helpers/typescript-oracle.js). A parser or a lexer that a test is pointed at by an environment variable must load: the CI job that runs the oracle tests (test-model-apps-lexer-oracles) sets the three
// variables, and a wrong path or a renamed file must fail the job, not skip every oracle test and pass. Unset, a loader answers null and its tests skip.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER = path.join(__dirname, 'helpers', 'typescript-oracle.js');
const VARIABLES = ['TYPESCRIPT_ORACLE_PATH', 'BABEL_ORACLE_PATH', 'BASE_LIB_PATH'];
const LOADERS = [['loadTypescriptOracle', 'TYPESCRIPT_ORACLE_PATH'], ['loadBabelOracle', 'BABEL_ORACLE_PATH'], ['loadBaseLexer', 'BASE_LIB_PATH']];

// One loader in a process of its own, with the three variables removed from the environment and `env` added: the loaders read it when they are called, and a child keeps the test from changing what the tests that run after it see.
function load(loader, env) {
  const script = `const h = require(${JSON.stringify(HELPER)}); try { const r = h.${loader}(); console.log(JSON.stringify({ loaded: r === null ? null : typeof r })); } catch (e) { console.log(JSON.stringify({ error: e.message })); }`;
  const base = { ...process.env };
  for (const name of VARIABLES) delete base[name];
  const result = spawnSync(process.execPath, ['-e', script], { env: { ...base, ...env }, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('an oracle that no variable points at loads as null, so the tests that need it skip', () => {
  for (const [loader] of LOADERS) assert.deepStrictEqual(load(loader, {}), { loaded: null }, loader);
  // An empty variable is unset.
  for (const [loader, variable] of LOADERS) assert.deepStrictEqual(load(loader, { [variable]: '' }), { loaded: null }, `${loader} with ${variable} empty`);
});

test('an oracle that a variable points at and that does not load throws, naming the variable, so the tests that need it fail', () => {
  const missing = path.join(__dirname, 'no-such-oracle');
  for (const [loader, variable] of LOADERS) {
    const result = load(loader, { [variable]: missing });
    assert.strictEqual(result.loaded, undefined, `${loader} did not load`);
    assert.ok(result.error.startsWith(`${variable} is set to `), `${loader}: ${result.error}`);
    assert.ok(result.error.includes('does not load as'), `${loader}: ${result.error}`);
  }
  // A directory that holds no package, where a package is wanted, and a directory without the lexer's file, are the same.
  assert.ok(load('loadTypescriptOracle', { TYPESCRIPT_ORACLE_PATH: path.join(__dirname, 'helpers') }).error.startsWith('TYPESCRIPT_ORACLE_PATH is set to '));
  assert.ok(load('loadBaseLexer', { BASE_LIB_PATH: path.join(__dirname, 'helpers') }).error.startsWith('BASE_LIB_PATH is set to '));
});

test('an oracle that a variable points at and that loads is returned', () => {
  // Any module stands for a package here; the lexer's own scripts/lib stands for the base.
  const module = path.join(__dirname, 'helpers', 'misread-page.js');
  assert.deepStrictEqual(load('loadTypescriptOracle', { TYPESCRIPT_ORACLE_PATH: module }), { loaded: 'object' });
  assert.deepStrictEqual(load('loadBabelOracle', { BABEL_ORACLE_PATH: module }), { loaded: 'object' });
  assert.deepStrictEqual(load('loadBaseLexer', { BASE_LIB_PATH: path.join(__dirname, '..', 'lib') }), { loaded: 'object' });
});
