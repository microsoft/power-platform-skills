'use strict';
// ASYNC-SURFACE INVARIANT — the guard for the SDK's sync -> async read/mutate change.
//
// Upstream made the generic artifact surface asynchronous ("300s cache staleness with async
// revalidating reads"): a read may now revalidate against the server before serving the cached
// copy, so `getArtifact` and every generic mutator return Promises. The bundle the plugin shipped
// before that change returned plain values.
//
// Why this needs a guard rather than trusting the suite: dropping an `await` does NOT throw.
// A Promise is truthy, so the engine's `|| {}` fallbacks stay dormant, and the PURE helpers that
// consume the result silently see a Promise instead of an artifact:
//
//   hasSubgrid(Promise)          -> false  -> a rebuild splices a DUPLICATE sub-grid
//   hasQuickView(Promise)        -> false  -> a rebuild splices a DUPLICATE quick-view
//   formFieldLogicals(Promise)   -> []     -> every spec field looks missing, so all are re-added
//   findFieldCellPointer(Promise)-> null   -> an explicit-layout removal silently never happens
//
// Each of those is a wrong-artifact outcome on a real org with a 2xx status and a green build.
// Only 4 of the plugin's ~1590 tests caught the original breakage, because most engine paths are
// covered through mocks that resolve synchronously. So the scan below is the real gate.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const SCRIPTS_DIR = path.resolve(__dirname, '..');

// The generic-surface methods that became async. Keep in sync with the dynamic check below — that
// test fails if the bundle disagrees with this list, in either direction.
const ASYNC_SDK_METHODS = [
  'addElement',
  'findElements',
  'getArtifact',
  'moveElement',
  'queryTree',
  'removeElement',
  'updateElement',
];

// Matching is by METHOD NAME on ANY receiver, not on an allow-list of receiver identifiers.
//
// An earlier version scanned only `provision.` and `sdk.`, which an adversarial review broke in one
// line: `const client = provision; client.getArtifact(...)` is a real bug that the receiver list
// cannot see, and no list can, because a receiver can be aliased, destructured, or passed as a
// parameter. Matching the method name instead is sound here for a checked reason, not a hopeful
// one: a scan of the plugin found NO local definition of any of these names (they exist only on the
// SDK), so a same-named method on some unrelated object does not currently exist. If one is ever
// introduced, it lands as a loud failure here — which is the correct direction for this trade —
// and is resolved with the waiver below or by renaming.
const CALL_RE = new RegExp(`(await\\s+)?\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*(${ASYNC_SDK_METHODS.join('|')})\\s*\\(`, 'g');

// An intentionally unawaited call (e.g. handing the promise to Promise.all) must say so, either on
// the same line or on the line immediately above it — the latter because these calls are often too
// long for a readable trailing comment. Requiring adjacency keeps the waiver next to the code it
// excuses, so it cannot drift onto an unrelated call later.
const OPT_OUT = 'sdk-async-ok';

/**
 * Blank out comments and string/template literals, preserving every byte offset and newline so
 * match indices still map to the original line numbers.
 *
 * Why a character scanner instead of "skip lines that start with //": the line-prefix filter was a
 * real hole. `/* legacy *\/ provision.getArtifact(id);` starts with a comment, so a prefix filter
 * discards the WHOLE line — including the live call after it. Conversely a naive regex strip would
 * corrupt `'https://x'`, whose `//` is inside a string.
 *
 * String literals are blanked too, so a method name quoted in a message (or in this file's own
 * documentation of the rule) can never be mistaken for a call.
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const keep = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') { out += keep(src[i]); i++; }
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) { out += keep(src[i]); i++; }
      continue;
    }
    const q = src[i];
    if (q === '"' || q === "'" || q === '`') {
      out += ' ';
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += '  '.slice(0, Math.min(2, src.length - i)); i += 2; continue; }
        if (src[i] === q) { out += ' '; i++; break; }
        out += keep(src[i]);
        i++;
      }
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function pluginSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // The vendored bundle is generated SDK code, and _vendor-build is the dev-only bundler.
      if (entry.isDirectory()) {
        if (entry.name === 'vendor' || entry.name === '_vendor-build' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  };
  walk(SCRIPTS_DIR);
  return out;
}

test('every SDK generic-surface call in the plugin is awaited', () => {
  const findings = [];
  let scanned = 0;
  let calls = 0;
  let waived = 0;

  for (const file of pluginSourceFiles()) {
    // This file names the methods in prose and in the ASYNC_SDK_METHODS list; scanning it would
    // match its own documentation. (Strings are blanked, but the list itself is real code.)
    if (path.basename(file) === path.basename(__filename)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    // Scan CODE ONLY. Offsets are preserved, so match indices still map to real line numbers, and
    // the reported text is taken from the ORIGINAL source so a finding is readable.
    const code = stripCommentsAndStrings(raw);
    scanned++;
    const rawLines = raw.split('\n');
    CALL_RE.lastIndex = 0;
    for (const m of code.matchAll(CALL_RE)) {
      calls++;
      if (m[1]) continue; // awaited — `await` must be ADJACENT, so `await other(); x.get(...)` still counts
      const line = code.slice(0, m.index).split('\n').length;
      const text = rawLines[line - 1] || '';
      // The waiver is read from the ORIGINAL source, because it lives in a comment.
      if (text.includes(OPT_OUT) || String(rawLines[line - 2] || '').includes(OPT_OUT)) { waived++; continue; }
      findings.push(`${path.relative(SCRIPTS_DIR, file)}:${line}: ${text.trim()}`);
    }
  }

  // Positive assertions first: a scan that silently matched nothing would "pass" forever.
  assert.ok(scanned > 50, `the scan walked the plugin source (saw ${scanned} files)`);
  assert.ok(calls > 30, `the scan found the SDK calls it is meant to guard (saw ${calls})`);
  // The waiver must stay RARE and deliberate. If this ever grows large, the rule is being routed
  // around rather than followed.
  assert.ok(waived <= 5, `only a handful of deliberate ${OPT_OUT} waivers exist (saw ${waived})`);
  assert.deepStrictEqual(findings, [],
    'these SDK calls are NOT awaited, but the vendored SDK returns a Promise. Unawaited, they do '
    + 'not throw — they silently feed a Promise to a pure helper and corrupt the artifact '
    + `(see this file's header). Add \`await\`, or annotate the line with ${OPT_OUT} if the promise `
    + `is deliberately handed elsewhere:\n  ${findings.join('\n  ')}`);
});

test('a STALE_ARTIFACT from the async surface HALTS the build (fails closed, with the SDK remedy)', async () => {
  // `StaleArtifactError` is a NEW error class that only exists because reads became revalidating:
  // the SDK raises it when a mutation is applied to a copy it just refreshed, because "any pointer
  // derived from the old copy may now identify a different node". The engine has never seen it.
  //
  // It is reachable in production without any bug on our side: a long build can leave more than the
  // SDK's 300s staleness window between an artifact's fetch and a later mutation, and if someone
  // edits that artifact in Maker inside that window, the next mutation raises it.
  //
  // The requirement is NOT that the engine recovers — it is that it fails CLOSED and says what to
  // do, rather than continuing and shipping a half-applied artifact. This pins that, so a future
  // refactor of the error path cannot quietly downgrade it to a warning.
  const { makeRunner, BuildHalt } = require(path.resolve(SCRIPTS_DIR, 'lib', 'entity-provision.js'));
  const { SdkError } = require(BUNDLE);

  const events = [];
  const runner = makeRunner({ emit: (e) => events.push(e), total: 1 });
  const stale = new SdkError('STALE_ARTIFACT',
    'Cannot apply the edit at /tabs/0 to form/abc: the cached copy was stale and the server copy '
    + 'has since changed, so any pointer derived from the old copy may now identify a different '
    + 'node. The local copy has been refreshed — re-read the artifact, re-derive the pointer, and retry.');

  await assert.rejects(
    () => runner.run('forms', 'form "Customer"', async () => { throw stale; }),
    (err) => {
      assert.ok(err instanceof BuildHalt, 'a stale-artifact mutation halts the build');
      assert.strictEqual(err.code, 'STALE_ARTIFACT', 'the SDK error code is preserved for the caller');
      assert.match(err.message, /re-read the artifact, re-derive the pointer, and retry/,
        'the operator is told the remedy, not just that something failed');
      return true;
    });

  assert.ok(events.some((e) => e.status === 'error' && e.phase === 'forms'),
    'the failure is reported on the phase, not swallowed');
});

test('the real vendored bundle agrees with ASYNC_SDK_METHODS (no drift in either direction)', async () => {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-surface-'));
  try {
    const httpClient = {
      get: async () => ({ status: 200, headers: {}, body: {} }),
      post: async () => ({ status: 204, headers: { 'odata-entityid': 'https://x/y(11111111-1111-1111-1111-111111111111)' }, body: {} }),
      patch: async () => ({ status: 204, headers: {}, body: {} }),
      delete: async () => ({ status: 204, headers: {}, body: {} }),
      put: async () => ({ status: 204, headers: {}, body: {} }),
    };
    const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
    sdk.initWorkspace();
    const art = sdk.createArtifact('form', { name: 'F', entityLogicalName: 'account', formType: 'main', status: 'draft' });

    for (const method of ASYNC_SDK_METHODS) {
      assert.strictEqual(typeof sdk[method], 'function', `${method} exists on the bundle`);
      // Called with deliberately incomplete arguments: the point is only whether the failure is
      // delivered synchronously (a sync method throws) or as a rejected Promise (an async one).
      let returned;
      try {
        returned = sdk[method]('form', art.id);
      } catch {
        assert.fail(`${method} threw SYNCHRONOUSLY, so the bundle still has a sync ${method}. `
          + 'Remove it from ASYNC_SDK_METHODS and drop the now-pointless awaits, or the await scan '
          + 'above is enforcing a rule the SDK no longer has.');
      }
      assert.ok(returned && typeof returned.then === 'function',
        `${method} must return a Promise on the vendored bundle`);
      // A rejected probe must never surface as an unhandled rejection and fail an unrelated test.
      await Promise.resolve(returned).catch(() => {});
    }

    // createArtifact is the counter-example that proves the check discriminates: it is still
    // synchronous, so a test that called everything "async" would be vacuous.
    assert.ok(!(art && typeof art.then === 'function'), 'createArtifact is still synchronous');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
