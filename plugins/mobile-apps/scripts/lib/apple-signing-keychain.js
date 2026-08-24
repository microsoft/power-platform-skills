'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVICE_PREFIX = 'com.microsoft.power-platform-skills.mobile-app.apple-signing';

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(candidate, stopAt = path.parse(candidate).root, fileSystem = fs) {
  const absolute = path.resolve(candidate);
  const root = path.resolve(stopAt);
  if (!isWithin(absolute, root)) throw new Error('Path is outside its trusted root.');
  let current = root;
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fileSystem.lstatSync(current).isSymbolicLink()) {
        throw new Error('Signing keychain path must not contain symbolic links.');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function deriveProjectIdentity(projectRoot, options = {}) {
  const fileSystem = options.fs || fs;
  const home = path.resolve(options.home || os.homedir());
  const requestedRoot = path.resolve(projectRoot);
  const stat = fileSystem.lstatSync(requestedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Project root must be a real directory, not a symbolic link.');
  }
  const realProjectRoot = fileSystem.realpathSync(requestedRoot);
  const digest = crypto.createHash('sha256').update(realProjectRoot).digest('hex');
  const storageRoot = path.join(
    home,
    'Library',
    'Application Support',
    'PowerPlatformSkills',
    'mobile-apps',
    'apple-signing',
  );
  const keychainPath = path.join(storageRoot, digest, 'signing.keychain-db');

  if (isWithin(keychainPath, realProjectRoot)) {
    throw new Error('Signing keychain must be retained outside the repository.');
  }
  assertNoSymlinkComponents(storageRoot, home, fileSystem);
  assertNoSymlinkComponents(keychainPath, home, fileSystem);

  return Object.freeze({
    projectFingerprint: digest,
    pathFingerprint: crypto.createHash('sha256').update(keychainPath).digest('hex'),
    serviceIdentifier: `${SERVICE_PREFIX}.${digest.slice(0, 24)}`,
    keychainPath,
    storageRoot,
    realProjectRoot,
  });
}

function classifyState({ keychainExists, passwordExists, keychainReadable = true }) {
  if (keychainExists && passwordExists && keychainReadable) return 'reuse';
  if (!keychainExists && !passwordExists) return 'create';
  if (keychainExists && passwordExists && !keychainReadable) return 'corrupt';
  if (!keychainExists && passwordExists) return 'missing-keychain';
  return 'missing-password';
}

function recoveryMessage(state) {
  const messages = {
    corrupt: 'Retained signing keychain is unreadable. Recover or explicitly archive it and reset the matching login-Keychain item; no files were deleted.',
    'missing-keychain': 'The retained keychain is missing while its login-Keychain password remains. Restore it or explicitly reset both retained assets.',
    'missing-password': 'The retained keychain exists but its login-Keychain password is missing. Restore the item or explicitly reset both retained assets.',
  };
  return messages[state] || null;
}

function safeHandoff(identity) {
  return {
    serviceIdentifier: identity.serviceIdentifier,
    pathFingerprint: identity.pathFingerprint,
  };
}

module.exports = {
  SERVICE_PREFIX,
  assertNoSymlinkComponents,
  classifyState,
  deriveProjectIdentity,
  isWithin,
  recoveryMessage,
  safeHandoff,
};
