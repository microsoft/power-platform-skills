'use strict';

// N6 — security: the ADO token file must be owner-only on disk.
//
// get-ado-token.js writes a JSON envelope containing a live ADO bearer token.
// On POSIX it is chmod 0o600; on Windows NTFS ignores the POSIX mode and the
// file inherits the parent directory's ACL, which on a shared host may grant
// other principals read access. writeTokenFile() therefore runs `icacls` to
// strip inheritance and grant only the current user + SYSTEM.
//
// These tests assert (a) the exact hardening command is issued on win32, (b) it
// is NOT issued off-Windows, and (c) — on a real Windows host — the written file
// genuinely denies broad principals (BUILTIN\Users / Authenticated Users).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { writeTokenFile } = require('../lib/get-ado-token');

function tmpFile(t, name = 'ado-token.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-token-acl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

const PAYLOAD = { token: 'fake.jwt.value', tenantId: 't', expiresOn: '2026-01-01' };

test('writeTokenFile issues an icacls inheritance-strip + owner-only grant on win32 (DI)', () => {
  const calls = [];
  const file = path.join(os.tmpdir(), 'never-written-by-di.json');
  // Use DI for both platform and exec so this runs identically on any OS.
  const prevUser = process.env.USERNAME;
  process.env.USERNAME = process.env.USERNAME || 'testuser';
  try {
    writeTokenFile(file, PAYLOAD, {
      _platform: 'win32',
      _execImpl: (cmd) => { calls.push(cmd); },
    });
  } finally {
    if (prevUser === undefined) delete process.env.USERNAME; else process.env.USERNAME = prevUser;
    fs.rmSync(file, { force: true });
  }
  assert.equal(calls.length, 1, 'exactly one icacls invocation expected');
  const cmd = calls[0];
  assert.match(cmd, /^icacls /, 'must invoke icacls');
  assert.match(cmd, /\/inheritance:r/, 'must strip inherited ACEs');
  assert.match(cmd, /\/grant:r "SYSTEM:F"/, 'must grant SYSTEM (OS requirement)');
  assert.match(cmd, /\/grant:r ".+:F" /, 'must grant the current user full control');
});

test('writeTokenFile does NOT invoke icacls on non-Windows platforms (DI)', (t) => {
  const calls = [];
  const file = tmpFile(t);
  writeTokenFile(file, PAYLOAD, {
    _platform: 'linux',
    _execImpl: (cmd) => { calls.push(cmd); },
  });
  assert.equal(calls.length, 0, 'icacls is Windows-only');
  assert.ok(fs.existsSync(file), 'file still written on non-Windows');
});

// Real ACL round-trip — only meaningful on an actual Windows host.
test('written token file denies broad principals on a real Windows host', { skip: process.platform !== 'win32' }, (t) => {
  const file = tmpFile(t);
  // Real write path (real icacls runs inside writeTokenFile).
  writeTokenFile(file, PAYLOAD);
  const acl = execSync(`icacls "${file}"`, { encoding: 'utf8' });
  // After /inheritance:r with only current-user + SYSTEM grants, none of these
  // broad principals should appear in the ACL listing.
  for (const principal of ['Everyone', 'Authenticated Users', 'BUILTIN\\Users']) {
    assert.ok(
      !acl.includes(principal),
      `token file ACL must not grant '${principal}' — got:\n${acl}`,
    );
  }
  // The current user must retain access.
  const me = process.env.USERNAME;
  assert.ok(me && acl.includes(me), `current user '${me}' must retain access — got:\n${acl}`);
});
