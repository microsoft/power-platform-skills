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
//
// `\\s*\\??\\.\\s*` accepts optional chaining (`provision?.getArtifact(...)`) and a receiver split
// from its method across lines; both are ordinary JS that an earlier version of this pattern
// silently ignored.
const CALL_RE = new RegExp(`(await\\s+)?(?:\\b[A-Za-z_$][\\w$]*|\\))\\s*\\??\\.\\s*(${ASYNC_SDK_METHODS.join('|')})\\s*\\(`, 'g');

// Computed access — `provision['getArtifact'](...)` — needs a SEPARATE pass, because the method
// name lives inside a string literal and the scanner below blanks strings (deliberately: a method
// name quoted in a log message is not a call). So this pattern is matched against a
// comments-stripped-but-strings-intact copy instead.
const COMPUTED_RE = new RegExp(`(await\\s+)?(?:\\b[A-Za-z_$][\\w$]*|\\))\\s*\\??\\[\\s*['"\`](${ASYNC_SDK_METHODS.join('|')})['"\`]\\s*\\]\\s*\\(`, 'g');

// DESTRUCTURING these methods off the SDK is banned outright rather than tracked.
//
// `const { getArtifact } = provision; getArtifact(id)` is a real evasion, and following it properly
// needs data-flow analysis: the bare call site carries no receiver, so no pattern can tell it from
// an unrelated local function. Banning the binding is the honest alternative — it is a construct
// the plugin never uses, it costs nothing to avoid, and it turns an undetectable call site into a
// detectable declaration.
const DESTRUCTURE_RE = new RegExp(`\\{[^}\\n]*\\b(${ASYNC_SDK_METHODS.join('|')})\\b[^}\\n]*\\}\\s*=`, 'g');

// An intentionally unawaited call (e.g. handing the promise to Promise.all) must say so IN A
// COMMENT, either on the same line or on the line immediately above it — the latter because these
// calls are often too long for a readable trailing comment.
//
// The marker must be a real comment, not merely the characters appearing somewhere on the line: a
// review pointed out that `console.log('sdk-async-ok')` on the previous line would otherwise waive
// the call below it. Requiring adjacency keeps the waiver next to the code it excuses, so it cannot
// drift onto an unrelated call later.
const OPT_OUT = 'sdk-async-ok';

// True only when OPT_OUT appears inside a comment on that line. Comparing the raw line against the
// comment-blanked line is enough: anything blanked was a comment or a string, and a string
// occurrence must NOT waive, so the marker must be absent from the code view AND present in the raw.
function isWaiverLine(rawLine, codeLine) {
  return rawLine.includes(OPT_OUT) && !String(codeLine || '').includes(OPT_OUT);
}

/**
 * Blank out comments and string-literal TEXT, preserving every byte offset and newline so match
 * indices still map to the original line numbers.
 *
 * This is a small LEXER, not a regex pass, because every cheaper approach was proven wrong here:
 *
 *   - "skip lines starting with //" discarded the whole line, so live code after a block comment
 *     hid an un-awaited call.
 *   - a naive strip corrupts a URL like https://x when it sits inside a string.
 *   - ignoring REGEX LITERALS is worse than either. A regex such as one matching a quote
 *     character contains a lone quote, which a regex-unaware scanner treats as an opening quote
 *     and then blanks everything up to the next quote — silently erasing the CODE ON FOLLOWING
 *     LINES. A guard that erases the code it is meant to inspect fails OPEN, which is the one
 *     thing it must never do.
 *   - blanking a template literal wholesale erases its ${...} interpolations, which are ordinary
 *     executable code and can contain a real un-awaited call.
 *
 * So: comments and quoted TEXT are blanked, regex literals are consumed as opaque tokens, and
 * template interpolations stay live (with a depth stack, so nesting works). `keepStrings` leaves
 * quoted text intact for the computed-access pass, which must see the quoted method name.
 *
 * The output array is pre-sized to the input length, so a byte can never be added or dropped and
 * an offset bug is impossible by construction — an earlier version could lose a byte when a
 * backslash escape ran past the end, shifting every reported line number after it.
 */
function stripCommentsAndStrings(source, { keepStrings = false } = {}) {
  const out = new Array(source.length);
  for (let k = 0; k < source.length; k++) out[k] = source[k] === '\n' ? '\n' : ' ';
  const live = (from, to) => { for (let k = from; k < to && k < source.length; k++) out[k] = source[k]; };

  // A '/' starts a regex only where a VALUE may begin; after a value it is division. Tracking the
  // last significant character is the standard cheap disambiguation and is sufficient for this code.
  const REGEX_CAN_FOLLOW = '(,=:[!&|?{};+-*%~^<>';
  let prev = '';
  let i = 0;
  // Brace depth at which each open template interpolation closes.
  const templates = [];
  let braceDepth = 0;

  // Consume a template literal from `i`, stopping either at its closing backtick or at the start
  // of an interpolation (whose code the MAIN loop then scans normally).
  const runTemplate = () => {
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i] === '`') { i++; return; }
      if (source.slice(i, i + 2) === '${') {
        live(i, i + 2);
        i += 2;
        braceDepth++;
        templates.push(braceDepth);
        return;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i];
    const two = source.slice(i, i + 2);

    if (two === '//') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (two === '/*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const open = i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === ch) { i++; break; }
        i++;
      }
      if (keepStrings) live(open, i);
      prev = 'x';
      continue;
    }

    if (ch === '`') {
      const open = i++;
      runTemplate();
      if (keepStrings) live(open, Math.min(i, source.length));
      prev = 'x';
      continue;
    }

    if (ch === '}' && templates.length && braceDepth === templates[templates.length - 1]) {
      // Closing an interpolation: resume the enclosing template literal.
      out[i] = '}';
      i++;
      braceDepth--;
      templates.pop();
      runTemplate();
      prev = 'x';
      continue;
    }

    if (ch === '/' && (prev === '' || REGEX_CAN_FOLLOW.includes(prev))) {
      i++;
      let inClass = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) { i++; break; }
        else if (source[i] === '\n') break; // unterminated: not a regex after all
        i++;
      }
      while (i < source.length && /[a-z]/.test(source[i])) i++; // flags
      prev = 'x';
      continue;
    }

    if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
    out[i] = ch;
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out.join('');
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
    // Second view for computed access, where the method name must survive inside its quotes.
    const codeWithStrings = stripCommentsAndStrings(raw, { keepStrings: true });
    scanned++;
    const rawLines = raw.split('\n');
    const codeLines = code.split('\n');
    const record = (m, haystack) => {
      calls++;
      if (m[1]) return; // awaited — `await` must be ADJACENT, so `await other(); x.get(...)` still counts
      const line = haystack.slice(0, m.index).split('\n').length;
      const text = rawLines[line - 1] || '';
      // The waiver lives in a comment, so it is read from the ORIGINAL source — but only counts
      // when it is genuinely a comment (see isWaiverLine).
      if (isWaiverLine(text, codeLines[line - 1]) || isWaiverLine(String(rawLines[line - 2] || ''), codeLines[line - 2])) { waived++; return; }
      const finding = `${path.relative(SCRIPTS_DIR, file)}:${line}: ${text.trim()}`;
      if (!findings.includes(finding)) findings.push(finding);
    };
    CALL_RE.lastIndex = 0;
    for (const m of code.matchAll(CALL_RE)) record(m, code);
    COMPUTED_RE.lastIndex = 0;
    for (const m of codeWithStrings.matchAll(COMPUTED_RE)) record(m, codeWithStrings);
    DESTRUCTURE_RE.lastIndex = 0;
    for (const m of code.matchAll(DESTRUCTURE_RE)) {
      const line = code.slice(0, m.index).split('\n').length;
      const text = rawLines[line - 1] || '';
      if (isWaiverLine(text, codeLines[line - 1])) continue;
      const finding = `${path.relative(SCRIPTS_DIR, file)}:${line}: [destructured] ${text.trim()}`;
      if (!findings.includes(finding)) findings.push(finding);
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

test('GUARD-THE-GUARD: the matcher catches evasions and does not fire on look-alikes', () => {
  // The scan above can only be trusted if its matcher is itself tested. Two of these cases were
  // proven evasions of an earlier version of this file (aliased receiver; live code after a block
  // comment), and two more were found by probing it afterwards (optional chaining; computed
  // access). Pinning them here means a future "simplification" of the regex fails loudly instead of
  // quietly reopening the hole.
  const check = (code) => {
    const noStr = stripCommentsAndStrings(code);
    const withStr = stripCommentsAndStrings(code, { keepStrings: true });
    // Offsets must be preserved or every reported line number is wrong.
    assert.strictEqual(noStr.length, code.length, 'stripping preserves byte offsets');
    assert.strictEqual(withStr.length, code.length, 'string-preserving strip also preserves offsets');
    let flagged = false;
    CALL_RE.lastIndex = 0;
    for (const m of noStr.matchAll(CALL_RE)) if (!m[1]) flagged = true;
    COMPUTED_RE.lastIndex = 0;
    for (const m of withStr.matchAll(COMPUTED_RE)) if (!m[1]) flagged = true;
    DESTRUCTURE_RE.lastIndex = 0;
    if (DESTRUCTURE_RE.test(noStr)) flagged = true;
    return flagged;
  };

  const MUST_FLAG = {
    'plain un-awaited call': "const a = provision.getArtifact('form', id);",
    'ALIASED receiver': "const c = provision; const a = c.getArtifact('f', id);",
    'live code AFTER a block comment': "/* legacy */ const a = provision.getArtifact('f', id);",
    'optional chaining': "const a = provision?.getArtifact('f', id);",
    'computed access': "const a = provision['getArtifact']('f', id);",
    'computed access via backticks': 'const a = provision[`getArtifact`](\'f\', id);',
    'receiver split from method across lines': "const a = provision\n  .getArtifact('f', id);",
    'promise handed to Promise.all without a waiver': "await Promise.all(ids.map((i) => sdk.getArtifact('f', i)));",
    // A regex literal containing a lone quote used to desynchronise the scanner: the quote was read
    // as a string opener, blanking every following line up to the next quote — including this call.
    // That made the guard fail OPEN, which is strictly worse than a missed edge case.
    'a call AFTER a regex literal containing a quote': "const q = /['\"]/;\nconst a = provision.getArtifact('f', id);",
    // A `${}` interpolation is ordinary executable code; blanking the whole template hid it.
    'a call inside a template interpolation': "const s = `${provision.getArtifact('f', id)}`;",
    'a call after a multi-line template': "const s = `line1\n${x.y}\nline2`;\nconst a = provision.getArtifact('f', id);",
    'parenthesized receiver': "const a = (provision).getArtifact('f', id);",
    'DESTRUCTURED off the SDK (banned outright — a bare call site has no receiver to match)':
      "const { getArtifact } = provision;\nconst a = getArtifact('f', id);",
    'destructured with a rename': "const { getArtifact: g } = provision;",
  };
  for (const [label, code] of Object.entries(MUST_FLAG)) {
    assert.strictEqual(check(code), true, `the matcher must flag: ${label}`);
  }

  const MUST_NOT_FLAG = {
    'a correctly awaited call': "const a = await provision.getArtifact('form', id);",
    'an awaited optional-chained call': "const a = await provision?.getArtifact('f', id);",
    'an awaited computed call': "const a = await provision['getArtifact']('f', id);",
    'the method name inside a string': "log('call getArtifact() next');",
    'the method name inside a template literal': 'log(`use x.getArtifact(y)`);',
    'the method name inside a comment': '// see provision.getArtifact(id) for why',
    'the method name inside a regex literal': 'const re = /x\\.getArtifact\\(/;',
    'a URL whose // sits inside a string': "const u = 'https://example.com/a//b'; const a = await sdk.getArtifact('f', id);",
    'an object literal that merely mentions the name as a VALUE': "const m = { name: getArtifactLabel };",
  };
  for (const [label, code] of Object.entries(MUST_NOT_FLAG)) {
    assert.strictEqual(check(code), false, `the matcher must NOT flag: ${label}`);
  }

  // The waiver must be a real COMMENT. `console.log('sdk-async-ok')` on the preceding line used to
  // waive the call below it, which would let anyone silence this guard with a string.
  assert.strictEqual(
    isWaiverLine("  x(); // sdk-async-ok", stripCommentsAndStrings("  x(); // sdk-async-ok")),
    true, 'a marker in a comment waives');
  assert.strictEqual(
    isWaiverLine("  console.log('sdk-async-ok');", stripCommentsAndStrings("  console.log('sdk-async-ok');", { keepStrings: true })),
    false, 'a marker inside a STRING must not waive');
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

test('the committed bundle MATCHES its recorded provenance (a bundle-only change cannot go unnoticed)', () => {
  // Provenance that is not checked against the artifact is decoration. Without this, someone could
  // rebuild or hand-edit the bundle and leave PROVENANCE.json describing the previous one — which
  // is a more convincing version of exactly the failure that motivated the file: a committed bundle
  // whose stated origin was not its real origin.
  const provPath = path.resolve(__dirname, '..', 'vendor', 'PROVENANCE.json');
  assert.ok(fs.existsSync(provPath), 'the vendored bundle ships a PROVENANCE.json');
  const prov = JSON.parse(fs.readFileSync(provPath, 'utf8'));

  const bytes = fs.readFileSync(BUNDLE);
  const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  assert.strictEqual(prov.bundleBytes, bytes.length,
    'PROVENANCE.json records the size of the bundle actually committed');
  assert.strictEqual(prov.bundleSha256, sha256,
    'PROVENANCE.json records the sha256 of the bundle actually committed — re-run '
    + 'scripts/_vendor-build/build.js so the record matches the artifact');

  // A committed bundle must be reproducible: it may not come from an unknown or dirty source.
  assert.strictEqual(typeof prov.commit, 'string', 'the upstream commit is recorded');
  assert.match(prov.commit, /^[0-9a-f]{40}$/, 'the upstream commit is a full SHA, not a moving ref');
  assert.strictEqual(prov.dirtySdkPackage, 0,
    'the bundle was built from a CLEAN SDK package (null means it could not be determined, which '
    + 'is not good enough for a committed artifact)');
  assert.notStrictEqual(prov.allowUnreproducible, true,
    'a bundle built with --allow-unreproducible must never be committed');
  assert.strictEqual(prov.libIsStale, false, 'the SDK lib/ was not stale relative to its src/');
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

    // The counter-examples that make "in either direction" true rather than a slogan. These are
    // called SYNCHRONOUSLY throughout the plugin, in many places, without `await`. If the SDK ever
    // makes one of them async, every one of those call sites becomes the same silent-corruption bug
    // — and nothing else in the suite would notice, because the async list above would still be
    // satisfied. A review pointed out this test proved only one direction; this is the other.
    assert.ok(!(art && typeof art.then === 'function'),
      'createArtifact is still synchronous — the plugin uses its return value directly');
    const ws = sdk.initWorkspace();
    assert.ok(!(ws && typeof ws.then === 'function'),
      'initWorkspace is still synchronous — every engine calls it un-awaited before any other work; '
      + 'if it became async, the workspace could be unready when the first artifact call runs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
