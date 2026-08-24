'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  ProfileDirectoryError,
  parseXcodeMajor,
  resolveProvisioningProfilesDirectory,
} = require('../../assets/apple-fastlane/fastlane/lib/apple_profile_directory');

const HELPER = path.resolve(
  __dirname,
  '..',
  '..',
  'assets',
  'apple-fastlane',
  'fastlane',
  'lib',
  'apple_profile_directory.js',
);

test('selects the Xcode 16+ UserData provisioning profile directory', () => {
  assert.equal(parseXcodeMajor('Xcode 16.0\nBuild version 16A242d'), 16);
  assert.equal(
    resolveProvisioningProfilesDirectory({
      home: '/Users/sanitized',
      xcodeVersion: 'Xcode 17.1\nBuild version 17B40',
    }),
    '/Users/sanitized/Library/Developer/Xcode/UserData/Provisioning Profiles',
  );
});

test('selects the legacy provisioning profile directory before Xcode 16', () => {
  assert.equal(
    resolveProvisioningProfilesDirectory({
      home: '/Users/sanitized',
      xcodeVersion: '15.4',
    }),
    '/Users/sanitized/Library/MobileDevice/Provisioning Profiles',
  );
});

test('offline callers must supply an explicit mocked version when xcodebuild is absent', () => {
  assert.throws(
    () => resolveProvisioningProfilesDirectory({
      home: '/Users/sanitized',
      spawnSync: () => ({ status: null, error: new Error('missing') }),
    }),
    (error) => error instanceof ProfileDirectoryError
      && error.code === 'xcode-version-unavailable',
  );
  const result = spawnSync(
    'node',
    [HELPER, '--home', '/Users/sanitized', '--xcode-version', 'Xcode 16.4'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(result.stdout).directory,
    '/Users/sanitized/Library/Developer/Xcode/UserData/Provisioning Profiles',
  );
});
