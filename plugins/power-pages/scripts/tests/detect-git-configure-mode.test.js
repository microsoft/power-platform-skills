'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectGitConfigureMode,
  parseModeArgs,
  VALID_MODES,
} = require('../lib/detect-git-configure-mode');

// Shorthand binding fixtures.
const UNBOUND = Object.freeze({ bound: false });
const BOUND_BASE = Object.freeze({
  bound: true,
  bindingType: 'environment',
  organization: 'GitIntegration22',
  project: 'srijan-pp-alm',
  repository: 'srijan-pp-alm',
  branch: 'main',
  gitFolder: 'solutions',
});

// ---------- VALID_MODES ----------

test('VALID_MODES enumerates exactly the 4 dispatched modes', () => {
  assert.deepEqual(
    [...VALID_MODES].sort(),
    ['disconnect', 'rebind', 'setup', 'switch-branch'].sort(),
  );
});

test('VALID_MODES is frozen', () => {
  assert.throws(() => { VALID_MODES.push('extra'); }, /read.?only|assign|cannot/i);
});

// ---------- parseModeArgs ----------

test('parseModeArgs: --mode=setup parses long-equal form', () => {
  assert.deepEqual(parseModeArgs(['--mode=setup']), { mode: 'setup' });
});

test('parseModeArgs: --mode setup parses space-separated form', () => {
  assert.deepEqual(parseModeArgs(['--mode', 'setup']), { mode: 'setup' });
});

test('parseModeArgs: --validate / --dry-run are no longer modes (validate removed)', () => {
  // These flags used to alias validate mode; that mode is gone, so they are
  // now ignored (no mode set).
  assert.deepEqual(parseModeArgs(['--validate']), {});
  assert.deepEqual(parseModeArgs(['--dry-run']), {});
});

test('parseModeArgs: --branch parses both --branch=X and --branch X', () => {
  assert.deepEqual(parseModeArgs(['--branch=feature/x']), { targetBranch: 'feature/x' });
  assert.deepEqual(parseModeArgs(['--branch', 'feature/x']), { targetBranch: 'feature/x' });
});

test('parseModeArgs: --headless and --interactive set the right flags', () => {
  assert.deepEqual(parseModeArgs(['--headless']), { headless: true });
  assert.deepEqual(parseModeArgs(['--interactive']), { interactive: true });
});

test('parseModeArgs: --non-interactive (and --no-interactive alias) sets nonInteractive (N7)', () => {
  assert.deepEqual(parseModeArgs(['--non-interactive']), { nonInteractive: true });
  assert.deepEqual(parseModeArgs(['--no-interactive']), { nonInteractive: true });
});

test('parseModeArgs: --no-intro sets noIntro (N1)', () => {
  assert.deepEqual(parseModeArgs(['--no-intro']), { noIntro: true });
});

test('parseModeArgs: unknown flags are silently ignored (forward-compat)', () => {
  assert.deepEqual(parseModeArgs(['--something-weird', '--ok']), {});
});

test('parseModeArgs: non-array input returns {}', () => {
  assert.deepEqual(parseModeArgs(null), {});
  assert.deepEqual(parseModeArgs(undefined), {});
  assert.deepEqual(parseModeArgs('--mode=setup'), {});
});

// ---------- detectGitConfigureMode: input validation ----------

test('throws when binding is missing', () => {
  assert.throws(() => detectGitConfigureMode({}), /binding is required/);
  assert.throws(() => detectGitConfigureMode({ binding: null }), /binding is required/);
});

test('throws when binding is not an object', () => {
  assert.throws(() => detectGitConfigureMode({ binding: 'bound' }), /binding must be an object/);
});

test('throws when binding probe itself errored', () => {
  assert.throws(
    () => detectGitConfigureMode({ binding: { error: 'auth failed', statusCode: 401 } }),
    /binding probe failed.*auth failed/,
  );
});

// ---------- Auto-detection: unbound → setup ----------

test('unbound env auto-detects setup mode', () => {
  const r = detectGitConfigureMode({ binding: UNBOUND });
  assert.equal(r.mode, 'setup');
  assert.equal(r.explicitOverride, false);
  assert.match(r.reason, /No Git binding/i);
});

test('unbound env with full context auto-allows headless setup', () => {
  const r = detectGitConfigureMode({
    binding: { ...UNBOUND, codeSiteName: 'retailos', solutionUniqueName: 'RetailOsSolution' },
  });
  assert.equal(r.mode, 'setup');
  assert.equal(r.headless.eligible, true);
  assert.deepEqual(r.headless.blockers, []);
});

test('unbound env with NO context blocks headless setup', () => {
  const r = detectGitConfigureMode({ binding: UNBOUND });
  assert.equal(r.mode, 'setup');
  assert.equal(r.headless.eligible, false);
  assert.ok(r.headless.blockers.includes('no code site or solution manifest detected'));
});

test('unbound env with PARTIAL context refuses headless unless --headless is passed', () => {
  // Only code site, no solution manifest.
  const r1 = detectGitConfigureMode({
    binding: { ...UNBOUND, codeSiteName: 'retailos' },
  });
  assert.equal(r1.headless.eligible, false);
  assert.ok(r1.headless.blockers.some((b) => /partial context/.test(b)));

  // Same, but user opts in.
  const r2 = detectGitConfigureMode({
    binding: { ...UNBOUND, codeSiteName: 'retailos' },
    args: ['--headless'],
  });
  assert.equal(r2.headless.eligible, true);
});

test('--interactive disables headless even when full context is present', () => {
  const r = detectGitConfigureMode({
    binding: { ...UNBOUND, codeSiteName: 'retailos', solutionUniqueName: 'X' },
    args: ['--interactive'],
  });
  assert.equal(r.headless.eligible, false);
  assert.ok(r.headless.blockers.includes('--interactive flag set'));
});

// ---------- Auto-detection: bound → switch-branch (default) ----------

test('bound env with no args requires an intent prompt (N2) and does not silently switch-branch', () => {
  const r = detectGitConfigureMode({ binding: BOUND_BASE });
  assert.equal(r.mode, 'switch-branch');
  assert.equal(r.explicitOverride, false);
  assert.equal(r.requiresIntentPrompt, true, 'bound + no args must confirm intent before mutating');
  assert.match(r.reason, /confirm intent/i);
  // Switch-branch never headless — must confirm target branch.
  assert.equal(r.headless.eligible, false);
});

test('bound env + --branch=NEW where NEW != current → switch-branch with explicit target', () => {
  const r = detectGitConfigureMode({
    binding: BOUND_BASE,
    args: ['--branch=feature/x'],
  });
  assert.equal(r.mode, 'switch-branch');
  assert.match(r.reason, /switch-branch/i);
  assert.notEqual(r.requiresIntentPrompt, true, 'explicit branch target needs no intent prompt');
});

test('bound env + --branch=current (same as binding.branch) is a no-op (N2)', () => {
  // Equal branches should short-circuit as a no-op so the SKILL.md reports
  // "already on that branch" instead of running a pointless disconnect+reconnect.
  const r = detectGitConfigureMode({
    binding: BOUND_BASE,
    args: ['--branch=main'],
  });
  assert.equal(r.mode, 'switch-branch');
  assert.equal(r.noOp, true, 'requested branch matches current → noOp');
  assert.match(r.reason, /nothing to switch/i);
});

// ---------- Explicit --mode overrides ----------

test('--mode=setup on an unbound env → setup', () => {
  const r = detectGitConfigureMode({ binding: UNBOUND, args: ['--mode=setup'] });
  assert.equal(r.mode, 'setup');
  assert.equal(r.explicitOverride, true);
});

test('--mode=setup on a BOUND env returns setup but flags the inconsistency', () => {
  const r = detectGitConfigureMode({ binding: BOUND_BASE, args: ['--mode=setup'] });
  assert.equal(r.mode, 'setup');
  assert.equal(r.explicitOverride, true);
  assert.match(r.reason, /already bound/i);
  assert.equal(r.headless.eligible, false);
});

test('--mode=switch-branch on UNBOUND env returns switch-branch but flags the inconsistency', () => {
  const r = detectGitConfigureMode({ binding: UNBOUND, args: ['--mode=switch-branch'] });
  assert.equal(r.mode, 'switch-branch');
  assert.equal(r.explicitOverride, true);
  assert.match(r.reason, /not bound/i);
});

test('--mode=rebind on UNBOUND env returns rebind but flags fallback', () => {
  const r = detectGitConfigureMode({ binding: UNBOUND, args: ['--mode=rebind'] });
  assert.equal(r.mode, 'rebind');
  assert.match(r.reason, /not bound/i);
});

test('--mode=disconnect on UNBOUND env returns disconnect but flags nothing-to-disconnect', () => {
  const r = detectGitConfigureMode({ binding: UNBOUND, args: ['--mode=disconnect'] });
  assert.equal(r.mode, 'disconnect');
  assert.match(r.reason, /nothing to disconnect/i);
});

test('--validate / --dry-run flags no longer select a mode (validate removed) — auto-detect wins', () => {
  // On a bound env with no real mode, these flags are ignored and the skill
  // falls through to the intent-prompt path rather than a validate mode.
  const r = detectGitConfigureMode({ binding: BOUND_BASE, args: ['--validate'] });
  assert.notEqual(r.mode, 'validate');
  assert.equal(r.requiresIntentPrompt, true);
});

test('--mode=validate is rejected as an unknown mode', () => {
  assert.throws(
    () => detectGitConfigureMode({ binding: UNBOUND, args: ['--mode=validate'] }),
    /not one of.*setup.*switch-branch.*rebind.*disconnect/,
  );
});

test('--mode=bogus throws with a descriptive error listing the valid modes', () => {
  assert.throws(
    () => detectGitConfigureMode({ binding: UNBOUND, args: ['--mode=bogus'] }),
    /not one of.*setup.*switch-branch.*rebind.*disconnect/,
  );
});

// ---------- Headless eligibility: only setup mode ----------

test('headless eligible flag is never true for non-setup modes', () => {
  // switch-branch, rebind, disconnect — all never headless.
  for (const mode of ['switch-branch', 'rebind', 'disconnect']) {
    const r = detectGitConfigureMode({
      binding: BOUND_BASE,
      args: [`--mode=${mode}`],
    });
    assert.equal(r.headless.eligible, false, `mode=${mode} must NOT be headless`);
    assert.ok(r.headless.blockers.length > 0, `mode=${mode} must report a blocker`);
  }
});
