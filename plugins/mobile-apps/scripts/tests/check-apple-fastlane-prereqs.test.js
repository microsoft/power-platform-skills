'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  atLeast,
  check,
  inspectText,
  parseVersion,
} = require('../check-apple-fastlane-prereqs');

const SCAFFOLD_ROOT = path.resolve(__dirname, '..', '..', 'assets', 'apple-fastlane');

test('parses and compares semantic tool versions', () => {
  assert.deepEqual(parseVersion('ruby 3.3.7p123', 'Ruby'), [3, 3, 7]);
  assert.deepEqual(parseVersion('Bundler version 4.0.19', 'Bundler'), [4, 0, 19]);
  assert.equal(atLeast([3, 3, 0], [3, 3, 0]), true);
  assert.equal(atLeast([3, 2, 9], [3, 3, 0]), false);
});

test('reads the exact pinned Fastlane and Bundler versions', () => {
  const pins = inspectText(
    'gem "fastlane", "= 2.238.0"\n',
    'DEPENDENCIES\n\nBUNDLED WITH\n   4.0.19\n',
  );
  assert.deepEqual(pins, { fastlane: '2.238.0', bundler: '4.0.19' });
});

test('accepts the supported macOS managed Ruby toolchain', () => {
  const result = check({
    projectRoot: SCAFFOLD_ROOT,
    platform: 'darwin',
    rubyOutput: 'ruby 3.3.7',
    bundlerOutput: 'Bundler version 4.0.19',
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.issues, []);
});

test('reports platform, Ruby, Bundler, and pin drift independently', () => {
  const result = check({
    projectRoot: SCAFFOLD_ROOT,
    platform: 'linux',
    rubyOutput: 'ruby 3.2.9',
    bundlerOutput: 'Bundler version 2.6.9',
  });
  assert.deepEqual(result.issues, [
    'macos-required',
    'ruby-too-old',
    'bundler-version-mismatch',
  ]);
});
