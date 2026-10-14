'use strict';

// Marketplace installs contain only this plugin. Compare bytes, not normalized
// text, so a refresh cannot silently change the bundled sources' line endings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `${relative} must be a physical copy`);
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), relative) : [relative];
  }).sort();
}

for (const [label, sourceParts, targetName] of [
  ['shared telemetry library', ['shared', 'telemetry', 'lib'], 'lib'],
  ['Power Pages region router', ['plugins', 'power-pages', 'scripts', 'lib', 'telemetry', 'region'], 'region'],
]) {
  test(`bundled ${label} is byte-identical to its source`, (t) => {
    const source = path.join(REPO_ROOT, ...sourceParts);
    if (!fs.existsSync(source)) {
      t.skip('source not present in an installed plugin');
      return;
    }
    const copy = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'telemetry', targetName);
    assert.ok(fs.existsSync(copy), `${label} must be bundled inside pcf`);
    const sourceFiles = listFiles(source);
    assert.deepEqual(listFiles(copy), sourceFiles, 'refresh the complete directory, including nested files');
    const drift = sourceFiles.filter((file) =>
      !fs.readFileSync(path.join(source, file)).equals(fs.readFileSync(path.join(copy, file))));
    assert.deepEqual(drift, [], 'refresh the copy without changing source bytes or line endings');
  });
}
