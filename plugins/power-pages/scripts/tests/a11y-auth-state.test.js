const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DIR_PREFIX, FILE_NAME, createAuthStatePath, isManagedAuthStatePath, removeAuthState, summarizeAuthState, writeAuthState,
} = require('../lib/a11y/auth-state');
const { parse } = require('../a11y-capture-auth');

test('createAuthStatePath creates a private temp folder with the managed layout', () => {
  const file = createAuthStatePath();
  try {
    assert.equal(path.basename(file), FILE_NAME);
    assert.ok(path.basename(path.dirname(file)).startsWith(DIR_PREFIX));
    assert.equal(isManagedAuthStatePath(file), true);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('isManagedAuthStatePath rejects anything outside the managed layout', () => {
  const tmp = os.tmpdir();
  assert.equal(isManagedAuthStatePath(path.join(tmp, `${DIR_PREFIX}abc`, FILE_NAME)), true);
  assert.equal(isManagedAuthStatePath(path.join(tmp, `${DIR_PREFIX}abc`, 'other.json')), false);
  assert.equal(isManagedAuthStatePath(path.join(tmp, 'project', FILE_NAME)), false);
  assert.equal(isManagedAuthStatePath(path.join(tmp, 'nested', `${DIR_PREFIX}abc`, FILE_NAME)), false);
  assert.equal(isManagedAuthStatePath(path.join(process.cwd(), `${DIR_PREFIX}abc`, FILE_NAME)), false);
  assert.equal(isManagedAuthStatePath(''), false);
  assert.equal(isManagedAuthStatePath(undefined), false);
});

test('writeAuthState writes JSON and removeAuthState deletes only the managed folder', () => {
  const file = createAuthStatePath();
  writeAuthState(file, { cookies: [{ name: 'a', value: 'secret', domain: 'contoso.com' }], origins: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).cookies[0].name, 'a');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  removeAuthState(file);
  assert.equal(fs.existsSync(path.dirname(file)), false);
});

test('removeAuthState refuses unmanaged paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-test-'));
  const file = path.join(dir, FILE_NAME);
  fs.writeFileSync(file, '{}');
  try {
    assert.throws(() => removeAuthState(file), /Refusing to remove/);
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeAuthState returns counts only', () => {
  const summary = summarizeAuthState({
    cookies: [{ name: 'a', value: 'x', domain: 'contoso.com' }, { name: 'b', value: 'y', domain: 'contoso.com' }, { name: 'c', value: 'z', domain: 'login.example' }],
    origins: [{ origin: 'https://contoso.com', localStorage: [] }],
  });
  assert.deepEqual(summary, { cookies: 3, domains: 2, originsWithStorage: 1 });
  assert.equal(JSON.stringify(summary).includes('x'), false);
  assert.deepEqual(summarizeAuthState(null), { cookies: 0, domains: 0, originsWithStorage: 0 });
});

test('a11y-capture-auth parse validates arguments', () => {
  assert.equal(parse(['--url', 'https://contoso.com']).timeoutSec, 600);
  assert.equal(parse(['--remove', 'x']).remove, 'x');
  assert.equal(parse(['--url', 'http://x', '--timeout-sec', '30', '--done-file', 'd']).doneFile, 'd');
  assert.throws(() => parse([]), /--url is required/);
  assert.throws(() => parse(['--url', 'ftp://x']), /http or https/);
  assert.throws(() => parse(['--url', 'http://x', '--timeout-sec', '5']), /10-3600/);
  assert.throws(() => parse(['--url']), /requires a value/);
  assert.throws(() => parse(['--bogus', '1']), /Unknown argument/);
  // Dependencies resolve only from --deps-dir or the plugin cache, never the site
  // project, so the flag was removed rather than silently ignored.
  assert.throws(() => parse(['--url', 'http://x', '--project-root', '.']), /Unknown argument: --project-root/);
});
