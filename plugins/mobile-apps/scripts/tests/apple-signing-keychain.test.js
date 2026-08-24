'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  classifyState,
  deriveProjectIdentity,
  recoveryMessage,
  safeHandoff,
} = require('../lib/apple-signing-keychain');
const { run } = require('../manage-apple-signing-keychain');

const WORK = path.join(__dirname, '.apple-signing-keychain-work');
const HOME = path.join(__dirname, '.apple-signing-keychain-home');

test.afterEach(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('derives a stable external path, service id, and safe handoff', () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  const first = deriveProjectIdentity(WORK, { home: HOME });
  const second = deriveProjectIdentity(WORK, { home: HOME });
  assert.deepEqual(first, second);
  assert.equal(path.relative(WORK, first.keychainPath).startsWith('..'), true);
  assert.match(first.serviceIdentifier, /^com\.microsoft\..+\.[a-f0-9]{24}$/);
  assert.match(first.pathFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(safeHandoff(first)), ['serviceIdentifier', 'pathFingerprint']);
  assert.doesNotMatch(JSON.stringify(safeHandoff(first)), /keychain-db|Application Support/);
});

test('rejects symlinked project and external path components', () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  const linkedProject = `${WORK}-link`;
  fs.symlinkSync(WORK, linkedProject, 'dir');
  assert.throws(() => deriveProjectIdentity(linkedProject, { home: HOME }), /symbolic link/);
  fs.rmSync(linkedProject);

  fs.mkdirSync(path.join(HOME, 'Library'), { recursive: true });
  fs.mkdirSync(path.join(HOME, 'target'), { recursive: true });
  fs.symlinkSync(path.join(HOME, 'target'), path.join(HOME, 'Library', 'Application Support'), 'dir');
  assert.throws(() => deriveProjectIdentity(WORK, { home: HOME }), /symbolic links/);
});

test('state machine fails closed and describes explicit recovery', () => {
  assert.equal(classifyState({ keychainExists: false, passwordExists: false }), 'create');
  assert.equal(classifyState({ keychainExists: true, passwordExists: true }), 'reuse');
  for (const state of ['corrupt', 'missing-keychain', 'missing-password']) {
    assert.match(recoveryMessage(state), /explicit|restore|Recover/i);
    assert.doesNotMatch(recoveryMessage(state), /delete automatically|silent/i);
  }
});

test('CLI operation is mocked and passes no password through argv or environment', () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  let invocation;
  const status = run([
    '--project-root', WORK,
    '--timeout', '900',
    '--', '/usr/bin/true',
  ], {
    home: HOME,
    spawnSync(command, args, options) {
      invocation = { command, args, options };
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(invocation.command, '/usr/bin/xcrun');
  assert.deepEqual(invocation.options.stdio, 'inherit');
  assert.equal(invocation.options.env, process.env);
  assert.doesNotMatch(JSON.stringify({
    command: invocation.command,
    args: invocation.args,
  }), /password|secret|credential/i);
  assert.equal(invocation.args.includes('/usr/bin/true'), true);
});

test('certificate lane receives the dedicated keychain path only inside the Swift helper', () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  let args;
  const status = run([
    '--project-root', WORK,
    '--', '/usr/bin/env', 'bundle', 'exec', 'fastlane', 'ios',
    'ensure_signing_certificates', 'team_id:A1B2C3D4E5',
  ], {
    home: HOME,
    spawnSync(_command, invocationArgs) {
      args = invocationArgs;
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.equal(args.includes('--inject-keychain-option'), true);
  assert.equal(args.some((arg) => arg.startsWith('keychain_path:')), false);
});

test('profile lane receives only the safe keychain handoff plus the internal path', () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  let args;
  const status = run([
    '--project-root', WORK,
    '--', '/usr/bin/env', 'bundle', 'exec', 'fastlane', 'ios',
    'ensure_provisioning_profiles',
    'team_id:A1B2C3D4E5',
    'bundle_id:com.contoso.fieldapp',
  ], {
    home: HOME,
    spawnSync(_command, invocationArgs) {
      args = invocationArgs;
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.equal(args.includes('--inject-keychain-option'), true);
  const safeIndex = args.indexOf('--inject-safe-handoff');
  assert.notEqual(safeIndex, -1);
  assert.match(args[safeIndex + 1], /^com\.microsoft\./);
  assert.match(args[safeIndex + 2], /^sha256:[a-f0-9]{64}$/);
  assert.equal(args.some((arg) => arg.startsWith('keychain_path:')), false);
});

test('Swift helper uses Security APIs and always restores the search list', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../../assets/apple-fastlane/fastlane/lib/apple_signing_keychain.swift',
  ), 'utf8');
  assert.match(source, /SecRandomCopyBytes/);
  assert.match(source, /kSecClassGenericPassword/);
  assert.match(source, /SecKeychainCreate/);
  assert.match(source, /SecKeychainUnlock/);
  assert.match(source, /defer\s*\{/);
  assert.match(source, /SecKeychainSetSearchList\(original as CFArray\)/);
  assert.doesNotMatch(source, /print\(.*secret|ProcessInfo\.processInfo\.environment/);
});
