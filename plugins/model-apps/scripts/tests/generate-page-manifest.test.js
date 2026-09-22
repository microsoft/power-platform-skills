'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'generate-page-manifest.js');

const {
  parseArgs,
  buildPackageJson,
  buildAmbientDeclarations,
  writeIfAllowed,
} = require('../generate-page-manifest.js');

function mkdirTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-manifest-test-'));
}

function runScript(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ---------- parseArgs ----------

test('parseArgs: requires two positional arguments', () => {
  assert.throws(() => parseArgs(['/tmp/foo']), /expected.*positional/);
});

test('parseArgs: rejects unknown flags', () => {
  assert.throws(() => parseArgs(['/tmp/foo', 'slug', '--bogus']), /Unknown flag/);
});

test('parseArgs: parses --features comma list', () => {
  const args = parseArgs(['/tmp/foo', 'slug', '--features', 'charts,datepicker']);
  assert.deepEqual(args.features, ['charts', 'datepicker']);
});

test('parseArgs: rejects unknown feature', () => {
  assert.throws(() => parseArgs(['/tmp/foo', 'slug', '--features', 'unicorn']), /Unknown feature/);
});

test('parseArgs: --force defaults to false', () => {
  const args = parseArgs(['/tmp/foo', 'slug']);
  assert.equal(args.force, false);
});

// ---------- buildPackageJson ----------

test('buildPackageJson: default has react + fluent + icons but NOT d3', () => {
  const pkg = buildPackageJson('slug', []);
  assert.ok(pkg.dependencies['react'], 'react present');
  assert.ok(pkg.dependencies['@fluentui/react-components'], 'fluent present');
  assert.ok(pkg.dependencies['@fluentui/react-icons'], 'icons present');
  assert.equal(pkg.dependencies['d3'], undefined, 'd3 absent by default');
});

test('buildPackageJson: charts feature adds d3 + @types/d3', () => {
  const pkg = buildPackageJson('slug', ['charts']);
  assert.ok(pkg.dependencies['d3'], 'd3 added');
  assert.ok(pkg.devDependencies['@types/d3'], '@types/d3 added');
});

test('buildPackageJson: datepicker feature adds the compat package', () => {
  const pkg = buildPackageJson('slug', ['datepicker']);
  assert.ok(pkg.dependencies['@fluentui/react-datepicker-compat']);
});

test('buildPackageJson: icons version stays pinned (no caret)', () => {
  const pkg = buildPackageJson('slug', []);
  assert.equal(
    pkg.dependencies['@fluentui/react-icons'],
    '2.0.326',
    'icon version pinned exact per regenerate-verified-icons.js'
  );
});

test('buildPackageJson: name uses provided slug, marked private', () => {
  const pkg = buildPackageJson('account-card-gallery', []);
  assert.equal(pkg.name, 'account-card-gallery');
  assert.equal(pkg.private, true);
});

// ---------- buildAmbientDeclarations ----------

test('genpage.d.ts: declares Window.Xrm with Navigation.navigateTo', () => {
  const dts = buildAmbientDeclarations();
  assert.match(dts, /interface Window/);
  assert.match(dts, /Xrm: XrmShape/);
  assert.match(dts, /Navigation:/);
  assert.match(dts, /navigateTo:/);
});

test('genpage.d.ts: types the window cache key pattern', () => {
  const dts = buildAmbientDeclarations();
  assert.match(dts, /__genpage_/);
});

test('genpage.d.ts: declares Utility.getGlobalContext()', () => {
  const dts = buildAmbientDeclarations();
  assert.match(dts, /getGlobalContext/);
  assert.match(dts, /languageId:/);
});

test('genpage.d.ts: is a TypeScript module (has export {})', () => {
  const dts = buildAmbientDeclarations();
  assert.match(dts, /^export\s*\{\s*\}\s*;/m);
});

// ---------- CLI: invalid args ----------

test('CLI: exits 1 when args missing', () => {
  const r = runScript([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /expected.*positional/);
});

test('CLI: exits 1 when slug is not kebab-case', () => {
  const dir = mkdirTemp();
  try {
    const r = runScript([dir, 'CapitalCase']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /kebab-case/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: exits 2 when working dir does not exist', () => {
  const r = runScript(['/nonexistent/zzz/yyy', 'foo']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /does not exist/);
});

// ---------- CLI: writes files ----------

test('CLI: writes package.json and genpage.d.ts to working dir', () => {
  const dir = mkdirTemp();
  try {
    const r = runScript([dir, 'my-page']);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(dir, 'package.json')), 'package.json written');
    assert.ok(fs.existsSync(path.join(dir, 'genpage.d.ts')), 'genpage.d.ts written');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-page');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: idempotent — does NOT overwrite without --force', () => {
  const dir = mkdirTemp();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"already-here"}');
    const r = runScript([dir, 'my-page']);
    assert.equal(r.code, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'already-here', 'existing package.json preserved');
    assert.match(r.stdout, /"wrote": false/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --force overwrites existing files', () => {
  const dir = mkdirTemp();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"already-here"}');
    const r = runScript([dir, 'my-page', '--force']);
    assert.equal(r.code, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-page', 'package.json overwritten by --force');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --features charts includes d3 in written package.json', () => {
  const dir = mkdirTemp();
  try {
    const r = runScript([dir, 'chart-page', '--features', 'charts']);
    assert.equal(r.code, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies['d3'], 'd3 in dependencies');
    assert.ok(pkg.devDependencies['@types/d3'], '@types/d3 in devDeps');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: stdout is valid JSON summary', () => {
  const dir = mkdirTemp();
  try {
    const r = runScript([dir, 'my-page']);
    assert.equal(r.code, 0);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.slug, 'my-page');
    assert.equal(summary.files['package.json'].wrote, true);
    assert.equal(summary.files['genpage.d.ts'].wrote, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- #585.10: --force must overwrite the file this tool OWNS, not whatever it points at ---------
// `writeFileSync` follows a symlink, so a `package.json` symlinked outside the working directory
// was overwritten AT ITS REAL TARGET — turning a scaffolding step into an arbitrary-file write.
//
// Creating a symlink needs elevation or Developer Mode on Windows, so the test SKIPS rather than
// fails when it cannot make one. It still runs the non-regular-file branch below, which needs no
// privilege, so the guard is never left completely unexercised.
test('--force refuses to write through a symlink that escapes the working directory', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-outside-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-work-'));
  try {
    const victim = path.join(outside, 'precious.json');
    fs.writeFileSync(victim, '{"keep":true}', 'utf8');
    const link = path.join(work, 'package.json');
    try { fs.symlinkSync(victim, link, 'file'); }
    catch { return t.skip('cannot create a symlink on this machine (needs elevation/Developer Mode)'); }

    let threw = null;
    try { writeIfAllowed(link, '{"overwritten":true}', true, fs.realpathSync(work)); } catch (e) { threw = e; }
    assert.ok(threw, 'writing through the symlink must be refused');
    assert.strictEqual(threw.code, 'UNSAFE_OUTPUT');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), '{"keep":true}',
      'the file outside the working directory must be untouched');
    return undefined;
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('--force refuses a non-regular output file (needs no symlink privilege)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-dir-'));
  try {
    // A DIRECTORY named package.json reproduces "exists but is not ours to overwrite" portably.
    const target = path.join(work, 'package.json');
    fs.mkdirSync(target);
    let threw = null;
    try { writeIfAllowed(target, '{}', true, fs.realpathSync(work)); } catch (e) { threw = e; }
    assert.ok(threw, 'a non-regular target must be refused');
    assert.strictEqual(threw.code, 'UNSAFE_OUTPUT');
    assert.match(threw.message, /not a regular file/);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

// The control: an ordinary regular file is still overwritten by --force, so the guard cannot be
// satisfied by refusing everything.
test('--force still overwrites an ordinary file in the working directory', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-ok-'));
  try {
    const target = path.join(work, 'package.json');
    fs.writeFileSync(target, '{"old":true}', 'utf8');
    const r = writeIfAllowed(target, '{"new":true}', true, fs.realpathSync(work));
    assert.strictEqual(r.wrote, true);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"new":true}');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

// A DANGLING symlink is the sharper version of the same bug, and the first fix for it missed this:
// `existsSync` FOLLOWS symlinks, so a link whose target does not exist yet reported "nothing here",
// skipped every check, and `writeFileSync` CREATED the file at the outside target. MEASURED before
// the guard moved to `lstat`. That is worse than the overwrite case — it puts a file where none was.
test('--force refuses a DANGLING symlink instead of creating its outside target', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-dangle-out-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-dangle-work-'));
  try {
    const victim = path.join(outside, 'created-by-escape.json'); // deliberately NOT created
    const link = path.join(work, 'package.json');
    try { fs.symlinkSync(victim, link, 'file'); }
    catch { return t.skip('cannot create a symlink on this machine (needs elevation/Developer Mode)'); }

    assert.strictEqual(fs.existsSync(link), false,
      'precondition: existsSync follows the link, so a dangling one reads false');

    let threw = null;
    try { writeIfAllowed(link, '{"escaped":true}', true, fs.realpathSync(work)); } catch (e) { threw = e; }
    assert.ok(threw, 'a dangling symlink must be refused');
    assert.strictEqual(threw.code, 'UNSAFE_OUTPUT');
    assert.strictEqual(fs.existsSync(victim), false,
      'nothing may be CREATED outside the working directory');
    return undefined;
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// Without --force an ordinary existing file is still preserved, not refused: the new lstat probe
// must not turn "already there" into an error.
test('without --force an existing ordinary file is preserved, not an error', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-keep-'));
  try {
    const target = path.join(work, 'package.json');
    fs.writeFileSync(target, '{"old":true}', 'utf8');
    const r = writeIfAllowed(target, '{"new":true}', false, fs.realpathSync(work));
    assert.strictEqual(r.wrote, false);
    assert.match(r.reason, /exists/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"old":true}');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('a brand-new file is written normally (the guard must not block the common case)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-new-'));
  try {
    const target = path.join(work, 'package.json');
    const r = writeIfAllowed(target, '{"fresh":true}', false, fs.realpathSync(work));
    assert.strictEqual(r.wrote, true);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"fresh":true}');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

// --- review follow-up: the leaf check alone did not confine anything --------------------------
// Three separate escapes survived a guard that only lstat-ed the final path component.

// 1. A HARD LINK is a regular file. `isFile()` is true, there is no link to notice, and the inode
// is shared — so writing "the file in the working directory" edited the outside file just as
// surely as a symlink would. A file this tool owns has exactly one name.
test('--force refuses a hard link into a file outside the working directory', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-hl-out-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-hl-work-'));
  try {
    const victim = path.join(outside, 'precious.json');
    fs.writeFileSync(victim, '{"keep":true}', 'utf8');
    const target = path.join(work, 'package.json');
    try { fs.linkSync(victim, target); }
    catch { return t.skip('cannot create a hard link on this filesystem'); }

    assert.strictEqual(fs.lstatSync(target).isFile(), true,
      'precondition: a hard link IS a regular file, which is why the isFile() check missed it');

    let threw = null;
    try { writeIfAllowed(target, '{"overwritten":true}', true, fs.realpathSync(work)); } catch (e) { threw = e; }
    assert.ok(threw, 'writing through a hard link must be refused');
    assert.strictEqual(threw.code, 'UNSAFE_OUTPUT');
    assert.match(threw.message, /hard link/);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), '{"keep":true}',
      'the file outside the working directory must be untouched');
    return undefined;
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// 2. THE WORKING DIRECTORY RESOLVES SOMEWHERE ELSE AT WRITE TIME. `main` takes the approved root
// once, at startup; if the directory is swapped for a link afterwards, the leaf is still an ordinary
// file and passes every leaf check — only the re-resolution at write time can see that the output
// now lands outside the root. That is what this pins: the approved root and the directory the write
// resolves into disagree, so the write is refused. (A link planted at the working-directory path
// BEFORE startup is refused by `main` itself — see the CLI tests below.)
test('an output that no longer resolves inside the approved root is refused (directory swapped after startup)', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-anc-out-'));
  const approved = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-anc-root-'));
  try {
    // `approved/work` is a LINK to a directory outside the approved root.
    const linkedWork = path.join(approved, 'work');
    try { fs.symlinkSync(outside, linkedWork, 'dir'); }
    catch { return t.skip('cannot create a symlink on this machine (needs elevation/Developer Mode)'); }

    const victim = path.join(outside, 'package.json');
    fs.writeFileSync(victim, '{"keep":true}', 'utf8');
    const target = path.join(linkedWork, 'package.json');
    assert.strictEqual(fs.lstatSync(target).isFile(), true,
      'precondition: the LEAF is an ordinary file — only the directory escapes');

    let threw = null;
    try { writeIfAllowed(target, '{"overwritten":true}', true, fs.realpathSync(approved)); } catch (e) { threw = e; }
    assert.ok(threw, 'an output resolving outside the approved root must be refused');
    assert.strictEqual(threw.code, 'UNSAFE_OUTPUT');
    assert.match(threw.message, /outside the working directory/);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), '{"keep":true}');
    return undefined;
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(approved, { recursive: true, force: true });
  }
});

// 3. A PARENT THAT IS NOT A DIRECTORY. `realpath` succeeds on a regular file, so a parent that is a
// file must be refused by the directory check rather than surfacing as a failed write. ENOTDIR is
// portable: a path whose PARENT is a regular file cannot be written into.
test('a parent that is a regular file is refused as unsafe, not reported as a failed write', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-probe-'));
  try {
    const notADir = path.join(work, 'blocker');
    fs.writeFileSync(notADir, 'i am a file', 'utf8');
    const target = path.join(notADir, 'package.json'); // parent is a FILE -> ENOTDIR
    let threw = null;
    try { writeIfAllowed(target, '{}', true, fs.realpathSync(work)); } catch (e) { threw = e; }
    assert.ok(threw, 'an uninspectable output must be refused');
    assert.strictEqual(threw.code, 'UNSAFE_OUTPUT');
    assert.strictEqual(fs.readFileSync(notADir, 'utf8'), 'i am a file',
      'and nothing may be written through it');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

// The write is a temp-file-and-rename, so it must leave no debris behind on the happy path.
test('the atomic replace leaves no temp file behind', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-tmp-'));
  try {
    const target = path.join(work, 'package.json');
    writeIfAllowed(target, '{"fresh":true}', false, fs.realpathSync(work));
    const left = fs.readdirSync(work);
    assert.deepStrictEqual(left, ['package.json'],
      `only the intended output may remain; got ${JSON.stringify(left)}`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

// --- review follow-up: pin each part of the confinement, one mutant at a time ------------------
// Three parts could be reverted without any test failing: the fail-closed probe (only reached via a
// case the directory check already caught), the atomic replace (a direct write also leaves no temp
// file), and the retry guard's adoption case. Each test below fails when its part is reverted.

// FAIL CLOSED: a leaf that cannot be INSPECTED is refused as unsafe. EACCES from a directory without
// search permission is the portable-enough trigger; Windows has no such mode, and root bypasses it.
test('a leaf whose probe fails with anything but ENOENT is refused as unsafe (POSIX)', (t) => {
  if (process.platform === 'win32') return t.skip('no search-permission bit on Windows');
  if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('root bypasses permission checks');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-eacces-'));
  const locked = path.join(work, 'locked');
  fs.mkdirSync(locked);
  try {
    fs.chmodSync(locked, 0o600); // readable, but no search permission: lstat of a child is EACCES
    let threw = null;
    try { writeIfAllowed(path.join(locked, 'package.json'), '{}', true, fs.realpathSync(locked)); } catch (e) { threw = e; }
    assert.ok(threw, 'an uninspectable leaf must be refused');
    assert.strictEqual(threw.code, 'UNSAFE_OUTPUT',
      `"could not look" must be a safety refusal, not a failed write; got ${threw.code}: ${threw.message}`);
    return undefined;
  } finally {
    fs.chmodSync(locked, 0o700);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// The same branch on EVERY platform, deterministically: the leaf probe itself fails with EACCES.
// With the probe swallowed as "nothing there", the write would simply go ahead.
test('a leaf probe failing with EACCES is refused as unsafe (all platforms, stubbed probe)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-eacces-stub-'));
  const target = path.join(work, 'package.json');
  const real = fs.lstatSync;
  try {
    const resolvedTarget = path.join(fs.realpathSync(work), 'package.json');
    fs.lstatSync = (p, ...rest) => {
      if (path.resolve(String(p)) === resolvedTarget) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
      return real(p, ...rest);
    };
    let threw = null;
    try { writeIfAllowed(target, '{}', true, fs.realpathSync(work)); } catch (e) { threw = e; }
    assert.ok(threw, 'an uninspectable leaf must be refused, not written');
    assert.strictEqual(threw.code, 'UNSAFE_OUTPUT');
    assert.strictEqual(fs.existsSync(target), false, 'nothing may be written');
  } finally {
    fs.lstatSync = real;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ATOMIC REPLACE: --force must replace the directory ENTRY, not write into the existing file. The
// observable difference is the file identity — an in-place write keeps it, a rename changes it.
test('--force replaces the file entry rather than writing into the existing file', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-atomic-'));
  try {
    const target = path.join(work, 'package.json');
    fs.writeFileSync(target, '{"old":true}');
    const before = fs.statSync(target, { bigint: true }).ino;
    writeIfAllowed(target, '{"new":true}', true, fs.realpathSync(work));
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"new":true}');
    assert.notStrictEqual(fs.statSync(target, { bigint: true }).ino, before,
      'the target must be a NEW file renamed into place — an in-place write would follow a link swapped in after the checks');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

// Without --force nothing that exists is written, so it must be SKIPPED, not refused — refusing a
// hard-linked package.json aborted the whole run, and genpage.d.ts was then never written.
test('without --force a hard-linked existing file is skipped, and the run still writes the rest', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-hlskip-out-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-hlskip-'));
  try {
    const victim = path.join(outside, 'precious.json');
    fs.writeFileSync(victim, '{"keep":true}');
    try { fs.linkSync(victim, path.join(work, 'package.json')); }
    catch { return t.skip('cannot create a hard link on this filesystem'); }
    const r = runScript([work, 'probe-page']);
    assert.strictEqual(r.code, 0, `a run without --force must not fail on an existing file; stderr: ${r.stderr}`);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), '{"keep":true}', 'the linked file is untouched');
    assert.ok(fs.existsSync(path.join(work, 'genpage.d.ts')), 'and the other output is still written');
    return undefined;
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// A read-only file is a deliberate "do not modify". The in-place write refused it; a rename would
// replace it silently, because replacing an entry needs write access to the directory, not the file.
test('--force refuses a read-only file instead of silently replacing it', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-ro-'));
  const target = path.join(work, 'package.json');
  try {
    fs.writeFileSync(target, '{"frozen":true}');
    fs.chmodSync(target, 0o444);
    let threw = null;
    try { writeIfAllowed(target, '{}', true, fs.realpathSync(work)); } catch (e) { threw = e; }
    assert.ok(threw, 'a read-only target must be refused');
    assert.match(threw.message, /read-only/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"frozen":true}');
  } finally {
    fs.chmodSync(target, 0o644);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// A replaced file keeps its permission bits — the rename would otherwise hand it the temp file's.
test('--force keeps the replaced file\'s permission bits (POSIX)', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission bits only');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-mode-'));
  try {
    const target = path.join(work, 'package.json');
    fs.writeFileSync(target, '{}');
    fs.chmodSync(target, 0o640);
    writeIfAllowed(target, '{"new":true}', true, fs.realpathSync(work));
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o640);
    return undefined;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

// A temp name that someone ELSE created is not ours to delete. `wx` refuses to reuse it; cleanup
// must then leave it alone rather than remove a file this call never wrote.
test('cleanup never deletes a temp-named file this call did not create', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-foreign-tmp-'));
  const real = fs.writeFileSync;
  let foreign = null;
  try {
    fs.writeFileSync = (p, data, opts) => {
      if (/\.tmp$/.test(String(p)) && opts && opts.flag === 'wx') {
        real(p, 'someone else'); // another process got there first...
        foreign = String(p);
        const e = new Error('EEXIST: file already exists'); e.code = 'EEXIST'; throw e; // ...so wx refuses
      }
      return real(p, data, opts);
    };
    let threw = null;
    try { writeIfAllowed(path.join(work, 'package.json'), '{}', false, fs.realpathSync(work)); } catch (e) { threw = e; }
    assert.ok(threw, 'the write must fail when its temp name is taken');
    assert.ok(foreign && fs.existsSync(foreign), 'the other process\'s file must survive our cleanup');
  } finally {
    fs.writeFileSync = real;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// A failed replace must clean up ITS OWN temp file and report an I/O error.
test('a failed rename removes the temp file this call created', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-fail-'));
  const real = fs.renameSync;
  try {
    fs.renameSync = () => { const e = new Error('EXDEV: cross-device link not permitted'); e.code = 'EXDEV'; throw e; };
    let threw = null;
    try { writeIfAllowed(path.join(work, 'package.json'), '{}', false, fs.realpathSync(work)); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, 'IO_ERROR');
    assert.deepStrictEqual(fs.readdirSync(work), [], 'no temp debris may remain');
  } finally {
    fs.renameSync = real;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// Windows: a scanner or indexer briefly holding the destination is retried; a lock that outlasts
// the retry is reported as what it almost certainly is.
test('a transiently locked destination is retried on Windows', (t) => {
  if (process.platform !== 'win32') return t.skip('the lock retry is Windows-only');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-lock-'));
  const real = fs.renameSync;
  try {
    let calls = 0;
    fs.renameSync = (a, b) => {
      calls += 1;
      if (calls <= 2) { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; }
      return real(a, b);
    };
    const r = writeIfAllowed(path.join(work, 'package.json'), '{"ok":true}', false, fs.realpathSync(work));
    assert.strictEqual(r.wrote, true);
    assert.strictEqual(calls, 3, 'two refused renames, then success');
    assert.deepStrictEqual(fs.readdirSync(work), ['package.json']);
    return undefined;
  } finally {
    fs.renameSync = real;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a persistently locked destination fails with an actionable message on Windows', (t) => {
  if (process.platform !== 'win32') return t.skip('the lock retry is Windows-only');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-lock2-'));
  const real = fs.renameSync;
  try {
    fs.renameSync = () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; };
    let threw = null;
    try { writeIfAllowed(path.join(work, 'package.json'), '{}', false, fs.realpathSync(work)); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, 'IO_ERROR');
    assert.match(threw.message, /another program may have it open/);
    assert.deepStrictEqual(fs.readdirSync(work), [], 'the temp file is cleaned up');
    return undefined;
  } finally {
    fs.renameSync = real;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// --- the working directory itself, through the REAL CLI ------------------------------------------
// A link pre-planted at the path a caller creates (`mkdir -p` succeeds on one silently) would
// redirect every write the run makes. A junction needs no privilege on Windows, so this runs there.
function linkDir(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

test('CLI: a working directory that is itself a link or junction is refused', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-cli-link-'));
  try {
    const realDir = path.join(base, 'real');
    fs.mkdirSync(realDir);
    const link = path.join(base, 'work');
    try { linkDir(realDir, link); } catch { return t.skip('cannot create a directory link here'); }
    const r = runScript([link, 'probe-page', '--force']);
    assert.strictEqual(r.code, 2, `a linked working directory must be refused; stdout: ${r.stdout}`);
    assert.match(r.stderr, /symbolic link or junction/);
    assert.deepStrictEqual(fs.readdirSync(realDir), [], 'nothing may be written through the link');
    return undefined;
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CLI: a linked ANCESTOR is followed — the output lands in the real directory', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-cli-anc-'));
  try {
    const realParent = path.join(base, 'realParent');
    fs.mkdirSync(realParent);
    const linkParent = path.join(base, 'linkParent');
    try { linkDir(realParent, linkParent); } catch { return t.skip('cannot create a directory link here'); }
    const work = path.join(linkParent, 'page');
    fs.mkdirSync(work);
    const r = runScript([work, 'probe-page']);
    assert.strictEqual(r.code, 0, `a linked ancestor is a normal setup and must work; stderr: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(realParent, 'page', 'package.json')), 'written at the real location');
    return undefined;
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('writeIfAllowed without an approved root refuses the write, like every other unsafe output', () => {
  const target = path.join(os.tmpdir(), `gpm-noroot-${process.pid}.json`);
  assert.throws(() => writeIfAllowed(target, '{}', true), (e) => e.code === 'UNSAFE_OUTPUT');
  assert.strictEqual(fs.existsSync(target), false, 'nothing may be written without a root to confine it to');
});
