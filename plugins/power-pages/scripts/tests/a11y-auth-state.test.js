const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DIR_PREFIX, FILE_NAME, createAuthStatePath, filterAuthStateForSite, isManagedAuthStatePath, openAuthStateFile, removeAuthState, summarizeAuthState, writeAuthState,
} = require('../lib/a11y/auth-state');
const { SessionCleanupError, capture, main, parse } = require('../a11y-capture-auth');

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

test('writeAuthState writes JSON through the exclusive descriptor and removeAuthState deletes only the managed folder', () => {
  const { file, fd } = openAuthStateFile();
  try {
    writeAuthState(fd, { cookies: [{ name: 'a', value: 'secret', domain: 'contoso.com' }, { name: 'b', value: 'longer-secret', domain: 'contoso.com' }], origins: [] });
    // A later, shorter refresh must replace the content, not leave a stale tail.
    writeAuthState(fd, { cookies: [{ name: 'a', value: 'x', domain: 'contoso.com' }], origins: [] });
  } finally {
    fs.closeSync(fd);
  }
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.cookies.length, 1);
  assert.equal(saved.cookies[0].name, 'a');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  removeAuthState(file);
  assert.equal(fs.existsSync(path.dirname(file)), false);
  // Removing again is a no-op, not an error.
  assert.deepEqual(removeAuthState(file), { keptDir: false });
});

test('removeAuthState deletes only the session file when the folder holds anything else', () => {
  const { file, fd } = openAuthStateFile();
  fs.closeSync(fd);
  const other = path.join(path.dirname(file), 'unrelated.txt');
  fs.writeFileSync(other, 'keep me');
  try {
    assert.deepEqual(removeAuthState(file), { keptDir: true });
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(other, 'utf8'), 'keep me');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('openAuthStateFile creates the file exclusively and never reuses an existing path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-test-'));
  try {
    // mkdtemp stub returns a directory that already holds the session file name, as a
    // planted file or link would; exclusive creation must refuse it.
    const planted = path.join(dir, FILE_NAME);
    fs.writeFileSync(planted, 'planted');
    assert.throws(() => openAuthStateFile({ mkdtemp: () => dir }), (e) => e.code === 'EEXIST');
    assert.equal(fs.readFileSync(planted, 'utf8'), 'planted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAuthState refuses a path instead of a descriptor', () => {
  assert.throws(() => writeAuthState('/tmp/x.json', {}), /descriptor/);
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

test('filterAuthStateForSite keeps only cookies and storage for the audited site', () => {
  const state = {
    cookies: [
      { name: 'a', value: 'v', domain: 'contoso.powerappsportals.com' },
      { name: 'b', value: 'v', domain: '.powerappsportals.com' },
      { name: 'c', value: 'v', domain: 'login.microsoftonline.com' },
      { name: 'd', value: 'v', domain: 'evilcontoso.powerappsportals.com' },
      { name: 'e', value: 'v', domain: '' },
    ],
    origins: [
      { origin: 'https://contoso.powerappsportals.com', localStorage: [] },
      { origin: 'https://login.microsoftonline.com', localStorage: [] },
    ],
  };
  const filtered = filterAuthStateForSite(state, 'https://contoso.powerappsportals.com/start');
  assert.deepEqual(filtered.cookies.map((c) => c.name), ['a', 'b']);
  assert.deepEqual(filtered.origins.map((o) => o.origin), ['https://contoso.powerappsportals.com']);
  assert.deepEqual(filterAuthStateForSite({}, 'https://contoso.powerappsportals.com'), { cookies: [], origins: [] });
});

test('a11y-capture-auth refuses credentials in --url', () => {
  assert.throws(() => parse(['--url', 'https://maker:secret@contoso.powerappsportals.com']), (err) => /user name or password/.test(err.message) && !err.message.includes('secret'));
});

test('removeAuthState refuses a pp-a11y-auth-* folder that is a link to somewhere else', (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-target-'));
  const victim = path.join(target, FILE_NAME);
  fs.writeFileSync(victim, 'keep me');
  const link = path.join(os.tmpdir(), `${DIR_PREFIX}link-${process.pid}-${Date.now()}`);
  try {
    try {
      // A junction needs no admin rights on Windows; lstat reports it as a link too.
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`cannot create a directory link here: ${err.code}`);
      return;
    }
    assert.equal(isManagedAuthStatePath(path.join(link, FILE_NAME)), true, 'the path alone looks managed');
    assert.throws(() => removeAuthState(path.join(link, FILE_NAME)), /link or not a folder/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
  } finally {
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* not created */ } }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('a capture that fails and cannot delete its partial session hands the path to the caller', async () => {
  const files = [];
  const deps = {
    loadPw: () => ({ chromium: {} }),
    launch: async () => { throw new Error('browser crashed'); },
    removeState: (f) => { files.push(f); const err = new Error('EBUSY: resource busy'); err.code = 'EBUSY'; throw err; },
  };
  try {
    await assert.rejects(capture({ url: 'https://contoso.powerappsportals.com/' }, { stderr: { write() {} }, ...deps }), (err) => {
      assert.ok(err instanceof SessionCleanupError);
      assert.equal(err.file, files[0]);
      assert.match(err.message, /browser crashed/);
      assert.match(err.message, /EBUSY/);
      return true;
    });
    let out = '';
    let errOut = '';
    const code = await main(['--url', 'https://contoso.powerappsportals.com/'], {
      stdout: { write: (d) => { out += d; } }, stderr: { write: (d) => { errOut += d; } }, captureDeps: deps,
    });
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(out), { cleanupRequired: files[1] });
    assert.match(errOut, /browser crashed/);
    assert.match(errOut, /--remove/);
  } finally {
    for (const file of files) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
