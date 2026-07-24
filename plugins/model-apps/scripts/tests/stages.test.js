const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { PHASES, STAGES, phasesForStage, stagePhasesOrResolve } = require(path.join(__dirname, '..', 'lib', 'stages.js'));
const { resolvePhases } = require(path.join(__dirname, '..', 'lib', 'sdk-build.js'));

test('PHASES is the canonical 13-phase ordered list', () => {
  assert.deepStrictEqual(PHASES, ['solution', 'data-model', 'sample-data', 'web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards', 'app-shell', 'pages', 'ai-features', 'publish']);
});

test('STAGES map groups contiguous phase ranges', () => {
  assert.deepStrictEqual(STAGES.data, ['solution', 'data-model', 'sample-data']);
  assert.deepStrictEqual(STAGES.ui, ['web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards']);
  assert.deepStrictEqual(STAGES.app, ['app-shell', 'pages', 'ai-features']);
  assert.deepStrictEqual(STAGES.publish, ['publish']);
  // Every stage phase is a real engine phase, and the four stages tile PHASES with no gaps/overlaps.
  assert.deepStrictEqual([...STAGES.data, ...STAGES.ui, ...STAGES.app, ...STAGES.publish], PHASES);
});

test('phasesForStage returns the range; unknown stage throws', () => {
  assert.deepStrictEqual(phasesForStage('data'), ['solution', 'data-model', 'sample-data']);
  assert.throws(() => phasesForStage('bogus'), /unknown stage 'bogus'/);
});

test('stagePhasesOrResolve: --stage wins; conflicting selectors throw', () => {
  assert.deepStrictEqual(stagePhasesOrResolve({ stage: 'data' }), ['solution', 'data-model', 'sample-data']);
  assert.throws(() => stagePhasesOrResolve({ stage: 'data', only: ['forms'] }), /--stage cannot be combined/);
});

test('stagePhasesOrResolve without --stage delegates to resolvePhases', () => {
  assert.deepStrictEqual(stagePhasesOrResolve({ from: 'forms' }), ['forms', 'commands', 'dashboards', 'app-shell', 'pages', 'ai-features', 'publish']);
});

test('resolvePhases rejects an unknown phase instead of silently ignoring it', () => {
  assert.throws(() => resolvePhases({ from: 'bogus' }), /unknown phase\(s\): bogus/);
  assert.throws(() => resolvePhases({ only: ['forms', 'nope'] }), /unknown phase\(s\): nope/);
  // Known selectors still work.
  assert.deepStrictEqual(resolvePhases({ to: 'sample-data' }), ['solution', 'data-model', 'sample-data']);
});
