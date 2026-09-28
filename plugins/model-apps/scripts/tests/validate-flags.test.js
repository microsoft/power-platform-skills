// plugins/model-apps/scripts/tests/validate-flags.test.js
// Contract for the shared CLI flag validator and the "did you mean" matcher behind it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { validateFlags, parseArgs } = require('../lib/dataverse-auth.js');
const { nearestName } = require('../lib/nearest-name.js');

const PLUGIN = path.join(__dirname, '..', '..');
const script = (n) => path.join(PLUGIN, 'scripts', n);
const SPEC = path.join(PLUGIN, 'samples', 'app-spec.project-tracker.json');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('validateFlags accepts a declared flag set', () => {
  assert.strictEqual(validateFlags(['--env', 'https://x', '--apply'], { known: ['env', 'apply'], needValue: ['env'] }), null);
});

test('validateFlags rejects an unknown flag and names it', () => {
  const msg = validateFlags(['--nope', 'x'], { known: ['env'], needValue: ['env'] });
  assert.match(msg, /unknown flag\(s\): --nope/);
});

test('validateFlags suggests the near miss that caused the swallowed token', () => {
  // The bug this exists for: `--stagee ui` is silently dropped AND eats `ui`.
  const msg = validateFlags(['--stagee', 'ui'], { known: ['stage', 'env'], needValue: ['stage'] });
  assert.match(msg, /did you mean --stage\?/);
});

test('validateFlags reports an unknown flag BEFORE a value-less one it may have caused', () => {
  // `--stagee ui --workspace` leaves --workspace looking bare; naming that would hide the typo.
  const msg = validateFlags(['--stagee', 'ui', '--workspace'], { known: ['stage', 'workspace'], needValue: ['stage', 'workspace'] });
  assert.match(msg, /unknown flag/);
  assert.doesNotMatch(msg, /--workspace requires/);
});

test('validateFlags rejects a bare value-bearing flag', () => {
  assert.match(validateFlags(['--stage'], { known: ['stage'], needValue: ['stage'] }), /--stage requires a value/);
});

test('validateFlags rejects --flag= and --flag "" as value-less', () => {
  assert.match(validateFlags(['--stage='], { known: ['stage'], needValue: ['stage'] }), /--stage requires a value/);
  assert.match(validateFlags(['--stage', '   '], { known: ['stage'], needValue: ['stage'] }), /--stage requires a value/);
});

test('validateFlags leaves a bare BOOLEAN flag alone', () => {
  assert.strictEqual(validateFlags(['--apply'], { known: ['apply'], needValue: [] }), null);
});

test('validateFlags treats an absent flag as acceptable — requiredness is the CLI\'s call', () => {
  assert.strictEqual(validateFlags([], { known: ['env'], needValue: ['env'] }), null);
});

test('validateFlags catches --__proto__, which never becomes an own property of flags', () => {
  // parseArgs accumulates into a plain {}, so Object.keys() cannot see this one.
  assert.strictEqual(Object.keys(parseArgs(['--__proto__', 'x']).flags).length, 0);
  assert.match(validateFlags(['--__proto__', 'x'], { known: ['env'] }), /unknown flag/);
});

test('validateFlags fails loudly when needValue names a flag missing from known', () => {
  // Guards the rename-one-list-not-the-other drift that would silently stop enforcing the value.
  assert.throws(() => validateFlags([], { known: ['env'], needValue: ['stage'] }), /needValue but not in known/);
});

test('nearestName prefers an exact case-insensitive match over a near one', () => {
  assert.strictEqual(nearestName('STAGE', ['stage', 'stages']), 'stage');
});

test('nearestName declines a suggestion beyond a single edit', () => {
  assert.strictEqual(nearestName('stgee', ['stage']), null);
});

// --- End-to-end: the dangerous case this whole change exists for -------------------------------

test('build-model-app rejects a typo\'d phase selector instead of planning every phase', () => {
  const base = ['--env', 'https://contoso.crm.dynamics.com', '--spec', '@' + SPEC, '--no-live-plan'];
  const good = run([script('build-model-app.js'), ...base, '--stage', 'ui']);
  assert.strictEqual(good.code, 0, good.stderr);
  const planned = JSON.parse(good.stdout).planItems.length;

  const typo = run([script('build-model-app.js'), ...base, '--stagee', 'ui']);
  assert.notStrictEqual(typo.code, 0, 'a typo\'d phase selector must not exit 0');
  assert.match(typo.stderr, /unknown flag\(s\): --stagee \(did you mean --stage\?\)/);
  // The regression being pinned: before this guard the typo planned strictly MORE than --stage ui.
  assert.ok(planned > 0 && planned < 9, `--stage ui should plan a subset, planned ${planned}`);
});

test('teardown-model-app rejects an unknown flag rather than ignoring it', () => {
  const r = run([script('teardown-model-app.js'), '--env', 'https://contoso.crm.dynamics.com', '--spec', '@' + SPEC, '--allow-destructiv']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /unknown flag\(s\): --allow-destructiv \(did you mean --allow-destructive\?\)/);
});

test('verify-model-app rejects an unknown flag rather than ignoring it', () => {
  const r = run([script('verify-model-app.js'), '--env', 'https://contoso.crm.dynamics.com', '--spec', '@' + SPEC, '--workspce', 'x']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /unknown flag\(s\): --workspce \(did you mean --workspace\?\)/);
});

test('a correct invocation still succeeds after the guard', () => {
  const r = run([script('build-model-app.js'), '--env', 'https://contoso.crm.dynamics.com', '--spec', '@' + SPEC, '--no-live-plan', '--stage', 'ui']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).dryRun, true);
});
