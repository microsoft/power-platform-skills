#!/usr/bin/env node

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  deriveProjectIdentity,
  safeHandoff,
} = require('./lib/apple-signing-keychain');

const SWIFT_HELPER = path.resolve(
  __dirname,
  '..',
  'assets',
  'apple-fastlane',
  'fastlane',
  'lib',
  'apple_signing_keychain.swift',
);

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const ownArgs = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  const parsed = { command, timeout: 3600 };
  for (let index = 0; index < ownArgs.length; index += 1) {
    if (ownArgs[index] === '--project-root') parsed.projectRoot = ownArgs[++index];
    else if (ownArgs[index] === '--timeout') parsed.timeout = Number(ownArgs[++index]);
    else throw new Error(`Unknown argument: ${ownArgs[index]}`);
  }
  return parsed;
}

function run(argv, options = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.projectRoot) throw new Error('--project-root is required.');
  if (!Number.isInteger(parsed.timeout) || parsed.timeout < 60 || parsed.timeout > 86400) {
    throw new Error('--timeout must be an integer from 60 through 86400 seconds.');
  }
  const identity = deriveProjectIdentity(parsed.projectRoot, options);
  const swiftArgs = [
    SWIFT_HELPER,
    '--keychain-path', identity.keychainPath,
    '--service-id', identity.serviceIdentifier,
    '--account-id', identity.projectFingerprint,
    '--timeout', String(parsed.timeout),
  ];
  if (
    parsed.command.includes('ensure_signing_certificates')
    || parsed.command.includes('ensure_provisioning_profiles')
  ) {
    swiftArgs.push('--inject-keychain-option');
  }
  if (parsed.command.includes('ensure_provisioning_profiles')) {
    swiftArgs.push(
      '--inject-safe-handoff',
      safeHandoff(identity).serviceIdentifier,
      `sha256:${safeHandoff(identity).pathFingerprint}`,
    );
  }
  if (parsed.command.length > 0) swiftArgs.push('--', ...parsed.command);

  const spawn = options.spawnSync || spawnSync;
  const result = spawn('/usr/bin/xcrun', ['swift', ...swiftArgs], {
    cwd: identity.realProjectRoot,
    stdio: 'inherit',
    // Preserve the build toolchain environment, but never add the keychain
    // password (which exists only inside the Swift Security API process).
    env: process.env,
  });
  if (result.error) throw new Error('Secure keychain helper could not start.');
  if (result.status !== 0) return result.status || 1;
  process.stdout.write(`${JSON.stringify(safeHandoff(identity))}\n`);
  return 0;
}

function main(argv) {
  try {
    return run(argv);
  } catch (error) {
    process.stderr.write(`Signing keychain blocked: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SWIFT_HELPER, main, parseArgs, run };
