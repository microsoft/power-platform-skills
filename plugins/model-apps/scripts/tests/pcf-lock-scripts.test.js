'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planScaffold } = require('../lib/pcf-scaffold.js');

const pluginRoot = path.join(__dirname, '..', '..');

const REQUIRED_MSBUILD_SCRIPTS = [
  'build',
  'clean',
  'rebuild',
  'lint',
  'lint:fix',
  'start',
  'start:watch',
  'refreshTypes',
];

function readPackage(rel) {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, rel, 'package.json'), 'utf8'));
}

function renderedPackage(template) {
  const plan = planScaffold({
    template,
    namespace: 'Contoso.Controls',
    name: 'StarRating',
  });
  return JSON.parse(plan.files.find((file) => file.relPath === 'package.json').content);
}

function assertPcfScriptSet(pkg) {
  // Microsoft.PowerApps.MSBuild.Pcf runs `npm run clean` and `npm run build -- ...` while packaging
  // or pushing a PCF project, so these lock packages must contain the same pcf-scripts entry points
  // that a fresh `pac pcf init` project contains. Otherwise CI can pass while generated controls fail
  // only when MSBuild invokes npm from `pac pcf push` or `dotnet build`.
  assert.equal(pkg.scripts.test, 'jest --runInBand');
  for (const script of REQUIRED_MSBUILD_SCRIPTS) {
    assert.equal(pkg.scripts[script], `pcf-scripts ${script.replace(':', ' ')}`);
  }
}

test('standard and virtual lock package scripts include the pac/MSBuild pcf-scripts entry points', () => {
  assertPcfScriptSet(readPackage(path.join('pcf', 'lock', 'standard')));
  assertPcfScriptSet(readPackage(path.join('pcf', 'lock', 'virtual')));
});

test('rendered standard and virtual scaffolds preserve the pac/MSBuild pcf-scripts entry points', () => {
  assertPcfScriptSet(renderedPackage('field-standard'));
  assertPcfScriptSet(renderedPackage('field-virtual'));
});
