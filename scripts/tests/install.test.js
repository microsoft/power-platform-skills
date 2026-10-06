// Covers the installer's argument handling and plugin selection. Importing install.js
// must not start an install, so a regression in its entry-point guard shows up here as a
// test run that tries to register marketplaces instead of passing quietly.

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs, selectPlugins, OPT_IN_PLUGINS } = require('../install.js');

const MARKETPLACE = ['power-pages', 'model-apps', 'dataverse', 'power-automate'];

test('dataverse is opt-in through --include-dataverse', () => {
  assert.equal(OPT_IN_PLUGINS.dataverse, '--include-dataverse');
});

test('without flags, every plugin except dataverse is installed', () => {
  const { selected, skipped } = selectPlugins(MARKETPLACE, parseArgs([]).includedOptIn);
  assert.deepEqual(selected, ['power-pages', 'model-apps', 'power-automate']);
  assert.deepEqual(skipped, ['dataverse']);
});

test('--include-dataverse installs dataverse alongside the other plugins', () => {
  const { selected, skipped } = selectPlugins(MARKETPLACE, parseArgs(['--include-dataverse']).includedOptIn);
  assert.deepEqual(selected, MARKETPLACE);
  assert.deepEqual(skipped, []);
});

test('--help is recognised', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('an unknown or misspelled argument fails instead of silently skipping a plugin', () => {
  assert.throws(() => parseArgs(['--include-dataverze']), /Unknown argument '--include-dataverze'/);
  assert.throws(() => parseArgs(['dataverse']), /Unknown argument/);
});
