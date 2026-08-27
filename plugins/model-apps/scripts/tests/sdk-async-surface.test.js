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
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS GUARD IS, AND IS NOT.
//
// It is a TRIPWIRE for the realistic regression — someone adds `provision.getArtifact(...)` and
// forgets the `await` — not a proof. It is built to fail in the safe direction: candidates are
// matched against the RAW source and only dismissed when two INDEPENDENT signals agree, so a flaw
// in its lexer produces a false positive (loud, waivable) rather than a hidden call.
//
// It is not sound, and cannot be made sound with regular expressions. Four rounds of adversarial
// review each found new constructs, and the residual known limits are:
//   * PARAMETER destructuring — `function use({ getArtifact }) { getArtifact(id); }`. No textual
//     anchor distinguishes an ObjectPattern from an ObjectExpression, so trying to catch it flagged
//     every mock object literal in the suite. An AST distinguishes them; a regex cannot.
//   * A receiver reached through a value the scanner cannot follow (returned from a function,
//     stored in an array, rebound conditionally).
//   * A call written inside a string or template on a code line is REPORTED (an accepted false
//     positive, asserted below so nobody "fixes" it by reopening the dismissal path).
// The exhaustive version needs a JavaScript parser. That is deliberately not done here: the plugin
// ships with no runtime dependencies and CI runs `node scripts/run-tests.js` with no install step,
// so adding a parser is a larger change than this belongs in. Tracked in
// https://github.com/microsoft/power-platform-skills/issues/475, where the corpus below doubles as
// the acceptance suite for the replacement.
// ---------------------------------------------------------------------------------------------
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
// Comments are whitespace in JavaScript, so `provision /* note */ .getArtifact(...)` and
// `provision // note` + `.getArtifact(...)` are ordinary calls. They are NOT handled by widening
// this pattern: an alternation containing `/\*[\s\S]*?\*/` inside a `*` quantifier rescans the rest
// of the file from every position, which hung the whole test run. They are handled instead by
// running the same pattern a second time over the COMMENT-BLANKED view, where a comment has already
// become spaces — see the two-pass scan in findUnawaitedCalls.
// `(?:\\?\\.)?` before the argument list accepts optional INVOCATION, `getArtifact?.(...)`, which is
// a different construct from optional MEMBER access.
const SEP = '\\s*';
const CALL_RE = new RegExp(`(await\\s+)?(?:\\b[A-Za-z_$][\\w$]*|\\))${SEP}\\??\\.${SEP}(${ASYNC_SDK_METHODS.join('|')})${SEP}(?:\\?\\.)?\\(`, 'g');

// Computed access — `provision['getArtifact'](...)` — needs a SEPARATE pass, because the method
// name lives inside a string literal and the scanner below blanks strings (deliberately: a method
// name quoted in a log message is not a call). So this pattern is matched against a
// comments-stripped-but-strings-intact copy instead.
const COMPUTED_RE = new RegExp(`(await\\s+)?(?:\\b[A-Za-z_$][\\w$]*|\\))${SEP}(?:\\?\\.)?${SEP}\\[${SEP}['"\`](${ASYNC_SDK_METHODS.join('|')})['"\`]${SEP}\\]${SEP}(?:\\?\\.)?\\(`, 'g');

// DESTRUCTURING these methods off the SDK is banned outright rather than tracked.
//
// `const { getArtifact } = provision; getArtifact(id)` is a real evasion, and following it properly
// needs data-flow analysis: the bare call site carries no receiver, so no pattern can tell it from
// an unrelated local function. Banning the binding is the honest alternative — it is a construct
// the plugin never uses, it costs nothing to avoid, and it turns an undetectable call site into a
// detectable declaration.
//
// `[^{}();]` rather than a narrow identifier class: a binding pattern legitimately contains
// defaults (`= fallback`), renames, rest (`...rest`) and computed keys (`['getArtifact']`), all of
// which a `[\w$\s,:]`-style class silently missed. Excluding braces, parentheses and semicolons is
// what keeps it from matching an ordinary `for (…) { … }` block that merely mentions one of these
// names — a false positive the permissive version really did produce.
// Two anchors were tried; only the DECLARATION form survives. Anchoring on `}` followed by `,` or
// `)` was meant to catch parameter destructuring, but it matched every mock object literal in the
// suite (`{ name: 'getArtifact', args: [...] }` passed to a function), which is a false positive
// the ban cannot afford — a binding finding is not waivable by the ordinary marker. Parameter
// destructuring of the SDK therefore remains undetected; it is a construct nothing here would
// plausibly write, and catching it costs more than it is worth.
// `[^{};]` rather than `[^{}();]`: a default can be a CALL (`{ getArtifact = fallback() }`), which
// excluding parens made invisible. Braces and semicolons stay excluded — they are what keep this
// from matching an ordinary `for (…) { … }` block that merely mentions one of these names.
// `=[^=>]` so `=>` is not mistaken for an assignment.
const DESTRUCTURE_RE = new RegExp(`\\{[^{};]*\\b(${ASYNC_SDK_METHODS.join('|')})\\b[^{};]*\\}\\s*=[^=>]`, 'g');

// An intentionally unawaited call (e.g. handing the promise to Promise.all) must say so IN A
// COMMENT, either on the same line or on the line immediately above it — the latter because these
// calls are often too long for a readable trailing comment.
//
// The marker must be a real comment, not merely the characters appearing somewhere on the line: a
// review pointed out that `console.log('sdk-async-ok')` on the previous line would otherwise waive
// the call below it. Requiring adjacency keeps the waiver next to the code it excuses, so it cannot
// drift onto an unrelated call later.
const OPT_OUT = 'sdk-async-ok';
// A destructuring finding needs its OWN marker. The ordinary waiver must never hide a binding —
// one comment would otherwise conceal every call made through it — but a genuine false positive
// still needs an escape that is not "rename your variable".
const OPT_OUT_BINDING = 'sdk-async-binding-ok';

/**
 * True only when `marker` appears inside a real `//` COMMENT on this line.
 *
 * Determined from the RAW line by SYNTAX, not by comparing transformed views. Two earlier versions
 * inferred "comment" from "present in the raw text but absent from a stripped copy", and both were
 * wrong in the same way — anything else the stripper happened to blank also looked like a comment.
 * First it was strings (`console.log('sdk-async-ok')`), then, after that was fixed, regex literals
 * and template text (`const marker = /sdk-async-ok/;`). Inference from absence keeps finding new
 * ways to be wrong, so this asks a question with a definite answer instead.
 *
 * Accepted shape: the line is ONLY a comment — trimmed, it starts with `//`.
 *
 * A TRAILING comment is deliberately not accepted. Deciding whether a `//` late in a line is a
 * comment start or part of a string/regex requires the very lexing that may have desynced, and
 * every shortcut tried for it was wrong in a new way. Requiring the waiver to sit on its own line
 * makes the question unanswerable-by-ambiguity: nothing can span into a line that begins with `//`.
 * The cost is one extra line at three call sites; the benefit is that a waiver cannot be forged.
 */
function markerInComment(rawLine, marker) {
  const trimmed = String(rawLine || '').trimStart();
  return trimmed.startsWith('//') && trimmed.includes(marker);
}

const isWaiverLine = (rawLine) => markerInComment(rawLine, OPT_OUT);

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

  // A '/' starts a regex only where a VALUE may begin; after a value it is division.
  //
  // The last significant CHARACTER is not sufficient on its own: `return /['"]/.test(s)` is real
  // code in this plugin (scripts/lib/genpage-cli.js), and after `return` the previous character is
  // `n`, so a character-only rule reads the `/` as division and then treats the regex's quote as a
  // string opener. So keywords are checked too.
  //
  // Even with that, `/` after `)` stays genuinely ambiguous without a parser. Rather than pretend
  // otherwise, the string scanner below FAILS CLOSED: a single- or double-quoted string cannot
  // contain a raw newline in JavaScript, so if one is hit before the closing quote the scanner has
  // mis-lexed and reverts, leaving the text as code. That converts every possible regex
  // misclassification from "silently erases the following lines" into "leaves them visible" — the
  // safe direction for a guard, and the property that actually matters here.
  const REGEX_CAN_FOLLOW = '(,=:[!&|?{};+-*%~^<>';
  const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw)$/;
  let prev = '';
  let i = 0;
  const regexMayStart = () => {
    if (prev === '' || REGEX_CAN_FOLLOW.includes(prev)) return true;
    // Look back over the code emitted so far for a keyword ending at this point.
    const back = out.slice(Math.max(0, i - 12), i).join('').replace(/\s+$/, '');
    return REGEX_KEYWORDS.test(back);
  };
  // Brace depth at which each open template interpolation closes.
  const templates = [];
  let braceDepth = 0;

  // Consume a template literal from `i`, stopping either at its closing backtick or at the start
  // of an interpolation (whose code the MAIN loop then scans normally). Returns false when the
  // literal never terminates, which means it was not a template at all.
  const runTemplate = () => {
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i] === '`') { i++; return true; }
      if (source.slice(i, i + 2) === '${') {
        live(i, i + 2);
        i += 2;
        braceDepth++;
        templates.push(braceDepth);
        return true;
      }
      i++;
    }
    return false;
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
      const open = i;
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '\n') break; // a quoted string cannot span a line -> we mis-lexed
        if (source[j] === ch) { j++; closed = true; break; }
        j++;
      }
      if (!closed) {
        // Not a string. Emit the quote as ordinary code and carry on from the next character, so a
        // misread apostrophe or regex quote can never blank the lines that follow it.
        out[i] = ch;
        prev = ch;
        i++;
        continue;
      }
      i = j;
      if (keepStrings) live(open, i);
      prev = 'x';
      continue;
    }

    if (ch === '`') {
      const open = i;
      i++;
      if (!runTemplate()) {
        // Unterminated: treat the backtick as code rather than swallowing the rest of the file.
        i = open;
        out[i] = ch;
        prev = ch;
        i++;
        continue;
      }
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

    if (ch === '/' && regexMayStart()) {
      const open = i;
      i++;
      let inClass = false;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) { i++; closed = true; break; }
        else if (source[i] === '\n') break; // unterminated: not a regex after all
        i++;
      }
      if (!closed) { i = open; out[i] = ch; prev = ch; i++; continue; }
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

/**
 * Find every un-awaited SDK call in `raw`, returning `{ line, text, kind }` findings.
 *
 * DIRECTION OF FAILURE — the property that makes this trustworthy.
 *
 * Candidates are matched against the RAW source, and a candidate is only DISMISSED when it can be
 * shown to be inert. Earlier versions did the opposite: they matched against a stripped copy, so
 * any flaw in the stripper made a real call invisible. Two separate stripper flaws did exactly
 * that (a regex literal's quote opening a fake string; a template literal swallowing its own
 * interpolation), and each turned the guard into a green light over a live bug.
 *
 * A candidate is DISMISSED only when both hold:
 *   1. the lexer blanked that offset, AND
 *   2. the ENTIRE raw line is inert — either it is trimmed-`//`, or the lexer blanked every
 *      non-whitespace character on it.
 *
 * (2) is whole-LINE on purpose. Testing only `startsWith('/*')` or `startsWith('*')` was wrong:
 * `/* legacy *\/ provision.getArtifact(id)` starts with a block comment and then contains a LIVE
 * call, so a prefix test dismissed it — the same class of bug as the very first line-prefix filter.
 * Requiring the whole line to be blank means live code on the line always keeps it visible.
 *
 * Deliberately NOT included: "the match is inside quotes on this line". Deciding that needs the
 * very lexing that may have desynced, and the quote-counting shortcut fails on
 * `if (c) /['"]/.test(v) && provision.getArtifact('form', id)` — an odd quote count before a LIVE
 * call. The cost of leaving it out is a false positive when a call appears inside a string literal
 * on a code line — rare, loud, waivable, and asserted below as a KNOWN accepted false positive.
 */
function findUnawaitedCalls(raw) {
  const code = stripCommentsAndStrings(raw);
  const codeWithStrings = stripCommentsAndStrings(raw, { keepStrings: true });
  const rawLines = raw.split('\n');
  const found = [];
  let candidates = 0;

  const lineAt = (index) => raw.slice(0, index).split('\n').length;
  const codeLines = code.split('\n');
  const strLines = codeWithStrings.split('\n');
  // A waiver must be a whole-line `//` comment AND be blanked in BOTH lexer views.
  //
  // The second condition closes a forge: a raw line beginning with `//` is not necessarily a
  // comment — inside a template literal it is just text, e.g.
  //     const note = `
  //       // sdk-async-ok`;
  //     provision.getArtifact('form', id);
  // A real comment is blanked in both views; template/string text survives in the
  // string-preserving view. Note the direction: this condition only ever REJECTS a waiver, and a
  // rejected waiver produces a loud finding, so being wrong here is safe.
  const waives = (lineNo, marker = OPT_OUT) => {
    const rawLine = rawLines[lineNo - 1];
    if (!markerInComment(rawLine, marker)) return false;
    const inCode = codeLines[lineNo - 1];
    const inStr = strLines[lineNo - 1];
    return inCode !== undefined && inCode.trim() === '' && inStr !== undefined && inStr.trim() === '';
  };
  // Reading the RAW lines above `lineNo`, is there an unclosed `/*`? Independent of the lexer.
  const insideOpenBlockComment = (lineNo) => {
    for (let n = lineNo - 2; n >= 0; n--) {
      const l = rawLines[n] || '';
      const open = l.lastIndexOf('/*');
      const close = l.lastIndexOf('*/');
      if (open > close) return true;   // this line opens a comment that is still open
      if (close > open) return false;  // a comment closed above us, so we are not inside one
    }
    return false;
  };
  const wholeLineInert = (lineText, lineNo) => {
    const trimmed = String(lineText || '').trimStart();
    if (trimmed.startsWith('//')) return true;
    const blankedLine = codeLines[lineNo - 1];
    const lexerSaysBlank = blankedLine !== undefined && blankedLine.trim() === '';
    // A block-comment CONTINUATION line. THREE signals must agree, because two were not enough:
    // a composed desync can blank a line that legitimately begins with `*` —
    //     if (c) /`/.test(v);
    //     const n = x
    //       * provision.getArtifact('f', id);     <- multiplication, not a comment
    //     const s = `ok`;
    // So besides the `*` shape and the lexer, the RAW SOURCE ABOVE must show an open block comment:
    // searching upward, a `/*` must appear before any `*/`. That check reads the raw text and does
    // not depend on the lexer, so a desync cannot supply it.
    if (trimmed.startsWith('*') && lexerSaysBlank && insideOpenBlockComment(lineNo)) return true;
    // Otherwise decide from the RAW LINE ALONE, independently of the lexer.
    //
    // This matters because the lexer-derived signal is not independent of the lexer: a multi-line
    // desync blanks the WHOLE line, so "the lexer blanked every character" agreed with itself and
    // dismissed a live call —
    //     if (c) /`/.test(v);
    //      /* legacy *\/ provision.getArtifact('f', id);   <- blanked by the desync, and dismissed
    //     const s = `ok`;
    // Removing the complete comments from the raw line leaves `provision.getArtifact(...)`, which
    // is code, so the line is not inert no matter what the lexer believes.
    let s = String(lineText || '').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const lineComment = s.indexOf('//');
    if (lineComment !== -1) s = s.slice(0, lineComment);
    const unterminated = s.indexOf('/*');
    if (unterminated !== -1) s = s.slice(0, unterminated);
    return s.trim() === '';
  };
  const dismissed = (index, lineText, lineNo, blankedView) => {
    const blanked = blankedView[index] !== raw[index];
    return blanked && wholeLineInert(lineText, lineNo);
  };

  const consider = (m, kind, blankedView) => {
    candidates++;
    if (m[1]) return; // awaited
    const index = m.index;
    const line = lineAt(index);
    const text = rawLines[line - 1] || '';
    if (dismissed(index, text, line, blankedView)) return;
    if (waives(line - 1) || waives(line - 2)) {
      // Deduplicated by line: the two-pass scan can match the same call twice, and a doubled count
      // would trip the "waivers must stay rare" assertion for no real reason.
      found.waivedLines = found.waivedLines || new Set();
      found.waivedLines.add(line);
      return;
    }
    const finding = { line, text: text.trim(), kind };
    if (!found.some((f) => f.line === line && f.kind === kind)) found.push(finding);
  };

  // TWO PASSES per pattern.
  //
  // The RAW pass is the one that cannot be defeated by a lexer flaw. The COMMENT-BLANKED pass
  // exists because comments are whitespace in JavaScript, so `provision /* note */ .getArtifact()`
  // is a real call that the raw pass cannot see with a `\s*` separator — and widening the separator
  // to include comments made the regex rescan the file from every position and hang the run.
  // Findings are the UNION, deduplicated by line, so the extra pass can only ADD detection.
  CALL_RE.lastIndex = 0;
  for (const m of raw.matchAll(CALL_RE)) consider(m, 'call', code);
  CALL_RE.lastIndex = 0;
  for (const m of code.matchAll(CALL_RE)) consider(m, 'call', code);
  COMPUTED_RE.lastIndex = 0;
  for (const m of raw.matchAll(COMPUTED_RE)) consider(m, 'computed', codeWithStrings);
  COMPUTED_RE.lastIndex = 0;
  for (const m of codeWithStrings.matchAll(COMPUTED_RE)) consider(m, 'computed', codeWithStrings);
  DESTRUCTURE_RE.lastIndex = 0;
  for (const m of raw.matchAll(DESTRUCTURE_RE)) {
    const line = lineAt(m.index);
    const text = rawLines[line - 1] || '';
    if (dismissed(m.index, text, line, code)) continue;
    // The ordinary waiver must NOT apply here: one comment would hide every call made through the
    // binding, and those call sites carry no receiver, so nothing else could ever see them. A
    // dedicated marker exists for a genuine false positive.
    if (waives(line - 1, OPT_OUT_BINDING)) continue;
    found.push({ line, text: text.trim(), kind: 'destructured binding' });
  }
  found.candidates = candidates;
  found.waived = found.waivedLines ? found.waivedLines.size : 0;
  return found;
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
    // This file names the methods in prose and in its own pattern definitions; scanning it would
    // match its own documentation.
    if (path.basename(file) === path.basename(__filename)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    scanned++;
    const hits = findUnawaitedCalls(raw);
    calls += hits.candidates;
    waived += hits.waived || 0;
    for (const h of hits) {
      const finding = `${path.relative(SCRIPTS_DIR, file)}:${h.line}: [${h.kind}] ${h.text}`;
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
  // `check` calls the REAL production scanner, not a re-implementation of it. An earlier version
  // approximated the scan and diverged from it in exactly the way that mattered (it passed a
  // different view to the waiver check), so the test passed while production was broken. Anything
  // this test proves is therefore a property of the shipped code.
  const check = (code) => findUnawaitedCalls(code).length > 0;

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
    'destructured ACROSS LINES': "const {\n  getArtifact: readArtifact,\n} = provision;",
    'destructured with a waiver comment (the ban is NOT waivable)':
      "const { getArtifact } = provision; // sdk-async-ok\nconst a = getArtifact('f', id);",
    'optional COMPUTED access': "const a = provision?.['getArtifact']('f', id);",
    // The string-blanked view made a marker in a STRING look exactly like a comment, so this
    // waived the call below it. That is a bypass anyone could have written by accident.
    'a call whose previous line merely PRINTS the waiver marker':
      "console.log('sdk-async-ok');\nconst a = provision.getArtifact('f', id);",
    // A regex after `return` is real code in this plugin. Misreading it as division made the
    // regex's quote open a fake string, blanking the following lines — the guard erasing the code
    // it exists to inspect.
    'a call after a regex following a KEYWORD (return)':
      "function q(s) { return /['\"]/.test(s); }\nconst a = provision.getArtifact('f', id);",
    'a call after a regex containing a BACKTICK':
      "function q(s) { return /`/.test(s); }\nconst a = provision.getArtifact('f', id);",
    'a call after a regex following a control parenthesis':
      "if (c) /['\"]/.test(v);\nconst a = provision.getArtifact('f', id);",
    'a call after an apostrophe that cannot be a string (unterminated on its line)':
      "const n = 5; // it's fine\nconst a = provision.getArtifact('f', id);",
    // Sol round 3: SAME-LINE ambiguity, where the newline fallback cannot help. These are the
    // cases that motivated inverting the scan to dismiss-only-when-provably-inert.
    'SAME LINE: a regex after a control paren whose quote could close before the call':
      "if (c) /['\"]/.test(v) && provision.getArtifact('form', id);",
    'SAME LINE: division mistaken for a regex, spanning the call':
      "const n = x++ / provision.getArtifact('form', id) / divisor;",
    'SAME LINE: a regex containing a backtick, with a real template later on the line':
      "if (c) /`/.test(v) && provision.getArtifact('f', id); const s = `ok`;",
    // Sol round 3: binding forms a narrow character class silently missed.
    'destructured with a DEFAULT': "const { getArtifact = fallback } = provision;",
    'destructured with a rename AND a default': "const { getArtifact: read = fallback } = provision;",
    'destructured with a REST element': "const { getArtifact, ...rest } = provision;",
    'destructured with a COMPUTED key': "const { ['getArtifact']: read } = provision;",
    // Sol round 4: constructs where NO raw candidate was produced, or both dismissal signals
    // agreed wrongly.
    'a comment between receiver and method (comments are whitespace in JS)':
      "provision /* note */ .getArtifact('form', id);",
    'a comment between method and its argument list':
      "provision.getArtifact /* note */ ('form', id);",
    'optional INVOCATION': "provision.getArtifact?.('form', id);",
    'optional invocation of a computed access': "provision['getArtifact']?.('form', id);",
    'a LIVE call on a line that merely STARTS with a block comment':
      "if (c) /`/.test(v);\n /* legacy */ provision.getArtifact('f', id);\nconst s = `ok`;",
    'a default that is a CALL in a destructuring pattern':
      "const { getArtifact = fallback() } = provision;",
    // Sol round 5 (non-blocking, fixed anyway): a LINE comment is whitespace too, and a composed
    // desync could satisfy the block-comment-continuation exception on a multiplication line.
    'a LINE comment between receiver and method':
      "provision // note\n  .getArtifact('form', id);",
    'a multiplication line that only LOOKS like a comment continuation':
      "if (c) /`/.test(v);\nconst n = x\n  * provision.getArtifact('f', id);\nconst s = `ok`;",
  };
  for (const [label, code] of Object.entries(MUST_FLAG)) {
    assert.strictEqual(check(code), true, `the matcher must flag: ${label}`);
  }

  const MUST_NOT_FLAG = {
    'a correctly awaited call': "const a = await provision.getArtifact('form', id);",
    'an awaited optional-chained call': "const a = await provision?.getArtifact('f', id);",
    'an awaited computed call': "const a = await provision['getArtifact']('f', id);",
    'the method name inside a string': "log('call getArtifact() next');",
    'the method name inside a comment': '// see provision.getArtifact(id) for why',
    'the method name inside a regex literal': 'const re = /x\\.getArtifact\\(/;',
    'a URL whose // sits inside a string': "const u = 'https://example.com/a//b'; const a = await sdk.getArtifact('f', id);",
    'an object literal that merely mentions the name as a VALUE': "const m = { name: getArtifactLabel };",
    'a mock object literal passed as an argument (must not read as destructuring)':
      "calls.push({ name: 'getArtifact', args: [t, id] });",
    'documentation prose inside a real block comment':
      "/**\n * See provision.getArtifact(id) for the rationale.\n */\nconst x = 1;",
  };
  for (const [label, code] of Object.entries(MUST_NOT_FLAG)) {
    assert.strictEqual(check(code), false, `the matcher must NOT flag: ${label}`);
  }

  // ACCEPTED FALSE POSITIVES — documented, not fixed, because fixing them reopens a fail-open path.
  //
  // A receiver-and-method that appears inside a STRING on a CODE line is reported. Suppressing it
  // would mean deciding "this offset is inside a string", which needs the lexing that may itself
  // have desynced — the exact inference that hid a live call twice. So the guard reports it, and
  // the author adds a waiver comment. A false positive costs one line; a false negative ships
  // corrupted artifacts.
  const ACCEPTED_FALSE_POSITIVES = {
    'a call written inside a template literal on a code line': 'log(`use x.getArtifact(y)`);',
  };
  for (const [label, code] of Object.entries(ACCEPTED_FALSE_POSITIVES)) {
    assert.strictEqual(check(code), true,
      `this is a KNOWN, accepted false positive and must stay detected rather than be silently `
      + `suppressed: ${label}`);
  }

  const waiverCase = (line) => isWaiverLine(line);
  assert.strictEqual(waiverCase('  // sdk-async-ok: handed to Promise.all'), true, 'a whole-line comment waives');
  assert.strictEqual(waiverCase("  console.log('sdk-async-ok');"), false, 'a marker inside a STRING must not waive');
  // Sol round 3: inference-from-absence also mistook regex and template text for a comment.
  assert.strictEqual(waiverCase('  const marker = /sdk-async-ok/;'), false, 'a marker inside a REGEX must not waive');
  assert.strictEqual(waiverCase('  const marker = `${v}sdk-async-ok`;'), false, 'a marker inside a TEMPLATE must not waive');
  assert.strictEqual(waiverCase('  x(); // sdk-async-ok'), false,
    'a TRAILING comment does not waive — whether a late // is a comment cannot be decided without '
    + 'the lexing that may itself be wrong, so the waiver must be a whole-line comment');
  // A whole-line `//` is not necessarily a comment — inside a template it is text. A forged waiver
  // must not silence the call below it.
  assert.strictEqual(
    check("const note = `\n  // sdk-async-ok`;\nprovision.getArtifact('form', id);"), true,
    'a waiver forged from TEMPLATE TEXT must not waive the call below it');
  assert.strictEqual(
    check("// sdk-async-ok: genuinely handed elsewhere\nprovision.getArtifact('form', id);"), false,
    'a REAL whole-line comment waiver still works');
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
  // Hash the LF-NORMALISED content, not the raw bytes.
  //
  // The raw bytes are not stable across platforms: git's end-of-line normalisation rewrites LF to
  // CRLF on a Windows checkout, so the same commit yields a different size and hash than on Linux.
  // This was not theoretical — the first version of this test passed on ubuntu and macOS and failed
  // on windows-latest by exactly 60 bytes. `vendor/.gitattributes` marks the bundle `-text` so git
  // stops converting it, and this normalisation keeps the assertion true even in a checkout that
  // predates that rule or ignores it.
  const normalised = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  const sha256 = require('node:crypto').createHash('sha256').update(normalised).digest('hex');
  assert.strictEqual(prov.bundleBytes, normalised.length,
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
  // NOSTUB disables the stub plugin, pulling the real shell/UI packages into the bundle. Besides
  // being ~10x larger, those packages embed an internal ownership table that must not ship in a
  // public repo — so a NOSTUB build is never a committable artifact.
  assert.strictEqual(prov.nostub, false,
    'the committed bundle was built WITH the stubs (a NOSTUB build pulls in shell packages that '
    + 'must not ship in a public repo)');
  // The recorded subject is committed to a PUBLIC repo, so it must not carry the upstream
  // merge-tool's PR id: unresolvable from here, and it advertises a tracker nobody reading this can
  // open. `sanitizeSubject` strips it at record time; this pins the committed artifact, which is the
  // thing that actually ships.
  //
  // Asserts against the sanitizer's OWN patterns rather than a local copy, so a prefix shape added
  // there can never be one this check silently stops looking for.
  const { MERGE_PREFIXES } = require(path.resolve(__dirname, '..', '_vendor-build', 'sanitize-subject.js'));
  assert.strictEqual(typeof prov.subject, 'string', 'the upstream commit subject is recorded');
  for (const re of MERGE_PREFIXES) {
    assert.doesNotMatch(prov.subject, re,
      `the recorded subject must not keep an upstream merge-tool prefix (matched ${re})`);
  }
});

// The sanitizer that produces the above. Unit-tested against the shapes the SDK's own history
// actually emits, plus the cases where it must NOT fire — a subject that merely mentions a merge is
// prose, and over-stripping would destroy the only human-readable part of the provenance record.
//
// Every id used here is SYNTHETIC. An earlier version of this test quoted the real upstream PR id as
// its example, which reintroduced into a public file exactly the identifier the function exists to
// remove — the fix and the test cancelling each other out.
test('sanitizeSubject strips merge-tool prefixes and nothing else', () => {
  const { sanitizeSubject, NO_DESCRIPTION } = require(path.resolve(__dirname, '..', '_vendor-build', 'sanitize-subject.js'));

  assert.strictEqual(
    sanitizeSubject('Merged PR 12345678: feat(cds-maker-sdk): configurable authoring LCID'),
    'feat(cds-maker-sdk): configurable authoring LCID');
  assert.strictEqual(
    sanitizeSubject('merged pr 42 : fix(sdk): tolerate a missing label'),
    'fix(sdk): tolerate a missing label');
  // A GitHub merge subject with a description after the branch ref keeps only the description.
  assert.strictEqual(
    sanitizeSubject('Merge pull request #4312 from someone/some-branch: fix(sdk): tolerate a missing label'),
    'fix(sdk): tolerate a missing label');
  // The `#` is OPTIONAL — not every tool emits it, and requiring it let a real merge subject through
  // untouched while every test stayed green.
  assert.strictEqual(
    sanitizeSubject('Merge pull request 4312 from someone/some-branch: fix(sdk): x'),
    'fix(sdk): x');
  // The ref is matched with [^:\s]+, not \S+. A greedy \S+ swallows a colon that belongs to the
  // DESCRIPTION, silently deleting the part that says what changed.
  assert.strictEqual(
    sanitizeSubject('Merge pull request #9 from owner/ref:fix(sdk): tolerate x'),
    'fix(sdk): tolerate x');

  // Must NOT fire: the prefix is anchored, so a mid-sentence mention survives verbatim.
  const prose = 'fix(sdk): revert the change merged PR 99 introduced';
  assert.strictEqual(sanitizeSubject(prose), prose, 'a mid-sentence mention is prose, not a prefix');
  const plain = 'feat(sdk): add setHeaderAndNavigationRefresh';
  assert.strictEqual(sanitizeSubject(plain), plain, 'an already-clean subject is unchanged');

  // A subject that is ONLY a prefix yields a neutral placeholder. Returning the ORIGINAL (the
  // previous behaviour) put the identifier straight back and produced a value that failed the
  // committed-provenance assertion above — the sanitizer breaking its own contract.
  assert.strictEqual(sanitizeSubject('Merged PR 123:'), NO_DESCRIPTION);
  assert.strictEqual(sanitizeSubject('Merge pull request #4312 from someone/some-branch'), NO_DESCRIPTION,
    'GitHub puts the description on the body line, so a bare merge subject is entirely prefix');
  // COLONLESS prefix-only subject. This is supported deliberately: requiring the colon left it
  // unchanged, and the invariant test could not see the hole because it uses the same patterns as
  // its oracle. Recorded as an exact input->output pair so the decision is visible, not implied.
  assert.strictEqual(sanitizeSubject('Merged PR 123'), NO_DESCRIPTION,
    'a bare "Merged PR <n>" with no colon is still entirely prefix');

  // NEGATIVE CONTROLS for the colon-or-end alternation: text after the id is a real description, so
  // the subject is prose and must survive untouched. If these ever start changing, the alternation
  // has become too greedy.
  for (const keep of ['Merged PR 99 rollback of the shell change', 'Merge pull request 7 from owner/ref is not this shape']) {
    assert.strictEqual(sanitizeSubject(keep), keep, `must not fire on: ${keep}`);
  }
  // Non-strings pass through, because `git()` records null when the call fails and null must stay
  // distinguishable from an empty subject.
  assert.strictEqual(sanitizeSubject(null), null);
});

test('sanitizeSubject strips ARBITRARILY nested prefixes, not a fixed number', () => {
  // A capped loop looked defensive and silently reintroduced the bug past the cap: at a cap of 8,
  // nine nested prefixes returned a value still carrying the ninth. Depths well past any plausible
  // cap are asserted here. This cannot PROVE no cap is ever reintroduced — a cap above 100 would
  // still pass — but it catches any cap small enough that a reviewer would plausibly write it.
  const { sanitizeSubject, NO_DESCRIPTION } = require(path.resolve(__dirname, '..', '_vendor-build', 'sanitize-subject.js'));

  for (const depth of [1, 2, 8, 9, 25, 100]) {
    const nested = Array.from({ length: depth }, (_, i) => `Merged PR ${i + 1}: `).join('') + 'real description';
    assert.strictEqual(sanitizeSubject(nested), 'real description',
      `depth ${depth} must strip every prefix`);
  }
  // Nested prefixes with NO description at the end still resolve to the placeholder.
  const bare = Array.from({ length: 12 }, (_, i) => `Merged PR ${i + 1}:`).join(' ');
  assert.strictEqual(sanitizeSubject(bare), NO_DESCRIPTION);
  // Mixed tools nest too.
  assert.strictEqual(
    sanitizeSubject('Merged PR 5: Merge pull request 9 from owner/ref: real desc'),
    'real desc');
});

test('sanitizeSubject output can NEVER match a merge prefix (the actual contract)', () => {
  // Case-by-case assertions only prove the cases someone thought of. The property that matters is
  // that NO input produces an output still carrying a prefix — which is what the committed
  // PROVENANCE.json must satisfy.
  //
  // STATED LIMIT, because it is easy to over-read this test: its oracle is MERGE_PREFIXES, the same
  // set the implementation strips with. It therefore proves "no output matches a pattern we
  // enumerate" — NOT "no output retains a merge prefix in some syntax nobody enumerated". A new
  // merge-tool syntax is invisible to both halves at once. The exact input->output assertions above
  // are what pin the enumerated shapes; this pins that stripping is exhaustive for them.
  const { sanitizeSubject, MERGE_PREFIXES } = require(path.resolve(__dirname, '..', '_vendor-build', 'sanitize-subject.js'));

  const corpus = [
    'Merged PR 12345678: feat(sdk): x',
    'Merged PR 123:',
    'Merged PR 123',
    '  merged   pr   7  :  ',
    'Merge pull request #4312 from someone/some-branch',
    'Merge pull request 4312 from someone/some-branch',
    'Merge pull request #4312 from someone/some-branch: desc',
    'Merge pull request #9 from owner/ref:fix(sdk): tolerate x',
    'Merged PR 1: Merged PR 2: doubly prefixed',
    Array.from({ length: 9 }, (_, i) => `Merged PR ${i + 1}: `).join('') + 'nine deep',
    Array.from({ length: 40 }, (_, i) => `Merged PR ${i + 1}: `).join('') + 'forty deep',
    'Merged PR 5: Merge pull request 9 from owner/ref: mixed nesting',
    'feat(sdk): plain',
    'fix(sdk): revert the change merged PR 99 introduced',
    'Merged PR 99 rollback of the shell change',
    '',
    '   ',
  ];

  for (const input of corpus) {
    const out = sanitizeSubject(input);
    for (const re of MERGE_PREFIXES) {
      assert.doesNotMatch(out, re,
        `sanitizeSubject(${JSON.stringify(input)}) returned ${JSON.stringify(out)}, which still matches ${re}`);
    }
  }
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
