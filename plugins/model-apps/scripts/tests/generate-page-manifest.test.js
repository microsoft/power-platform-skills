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
    try { writeIfAllowed(link, '{"overwritten":true}', true); } catch (e) { threw = e; }
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
    try { writeIfAllowed(target, '{}', true); } catch (e) { threw = e; }
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
    const r = writeIfAllowed(target, '{"new":true}', true);
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
    try { writeIfAllowed(link, '{"escaped":true}', true); } catch (e) { threw = e; }
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
    const r = writeIfAllowed(target, '{"new":true}', false);
    assert.strictEqual(r.wrote, false);
    assert.match(r.reason, /exists/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"old":true}');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('a brand-new file is written normally (the guard must not block the common case)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-new-'));
  try {
    const target = path.join(work, 'package.json');
    const r = writeIfAllowed(target, '{"fresh":true}', false);
    assert.strictEqual(r.wrote, true);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"fresh":true}');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
