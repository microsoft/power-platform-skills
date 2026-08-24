#!/usr/bin/env node

'use strict';

const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

class ProfileDirectoryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parseXcodeMajor(versionOutput) {
  const match = String(versionOutput || '').match(/(?:^|\n)?Xcode\s+(\d+)(?:\.\d+)*/i)
    || String(versionOutput || '').match(/^\s*(\d+)(?:\.\d+)*/);
  if (!match) throw new ProfileDirectoryError('xcode-version-invalid');
  return Number(match[1]);
}

function readXcodeVersion(options = {}) {
  if (options.xcodeVersion) return String(options.xcodeVersion);
  const result = (options.spawnSync || spawnSync)(
    '/usr/bin/xcodebuild',
    ['-version'],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) {
    throw new ProfileDirectoryError('xcode-version-unavailable');
  }
  return result.stdout;
}

function resolveProvisioningProfilesDirectory(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const major = parseXcodeMajor(readXcodeVersion(options));
  const components = major >= 16
    ? ['Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles']
    : ['Library', 'MobileDevice', 'Provisioning Profiles'];
  return path.join(home, ...components);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--home', '--xcode-version'].includes(key) || !value || value.startsWith('--')) {
      throw new ProfileDirectoryError('invalid-arguments');
    }
    result[key === '--home' ? 'home' : 'xcodeVersion'] = value;
    index += 1;
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  try {
    const directory = resolveProvisioningProfilesDirectory(parseArgs(argv));
    process.stdout.write(`${JSON.stringify({ status: 'ready', directory })}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ProfileDirectoryError
      ? error.code
      : 'profile-directory-resolution-failed';
    process.stdout.write(`${JSON.stringify({ status: 'blocked', code })}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ProfileDirectoryError,
  main,
  parseArgs,
  parseXcodeMajor,
  readXcodeVersion,
  resolveProvisioningProfilesDirectory,
};
