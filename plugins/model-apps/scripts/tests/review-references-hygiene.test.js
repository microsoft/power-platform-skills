'use strict';
// Keeps internal review references out of this plugin and its evals.
//
// WHY: this repository is public (see "This Repo Is PUBLIC" in the root AGENTS.md). A comment such as
// "(C4)", "reviewer I3", "Round-2 fixes" or "Plan 3" points into a review that a reader outside
// Microsoft cannot open. It adds no reason, and it tells the reader that the document exists. The REASON
// for a line of code belongs in its comment; the POINTER does not. This test fails when such a pointer
// reappears in a tracked text file of plugins/model-apps or evals/model-apps.
//
// KEPT ON PURPOSE (and pinned by the LEGITIMATE list below, so a pattern cannot start flagging it):
//   * generic provenance that names no reviewer, round or id: "found in review", "an adversarial review
//     caught ...", "adversarially reviewed". It says why the code exists and discloses nothing internal;
//   * pointers a reader CAN follow: "design §13.1", "Rule 15", "Step 5", "adversarial test #1", AB# work
//     items and PR numbers;
//   * the human "reviewer" of a generated document ("so a reviewer can approve the omission"): product
//     vocabulary, not a review of this code.
//
// HOW THE PATTERNS STAY PRECISE
//   * Each pattern is anchored on a shape that only a review pointer has ("(C4)", "reviewer C4", "Round-2",
//     "(Plan 3)", "new-Important-1", a test title that opens "I1:"), not on a bare letter-and-digit token.
//   * The shapes that contain an id only look at text a person wrote for a reader: comments, Markdown
//     prose, test titles and assertion messages (scope 'text'). They never look at code, where `T1`, `C1`
//     and `M1<T>` are ordinary type parameters, names and test inputs (a TypeScript snippet such as
//     "(T1 | T2)[]" must not fail the build). The one broad rule, `id-bare-in-prose`, is narrower still:
//     comments and Markdown prose only, never fenced code, and it skips function keys.
//   * The plain words a pointer is made of ("Task 1", "Plan 2", "Addendum") are also ordinary data: a fixture
//     row, a slug test's input, the name of a contract document. They are flagged only in the SHAPE of a
//     pointer (in parentheses, hyphenated, a label before a colon or dash, followed by an id) and only where a
//     person wrote prose (scope 'note': a comment, Markdown prose outside a code fence, the title of a test, the
//     message of an assertion) — never in a JSON value, an object literal, an assertion's data, or fenced code.
//   * Every pattern carries examples it must flag, and LEGITIMATE carries text that no pattern may flag;
//     the first two tests below run both, so a pattern cannot drift without this file noticing.
//
// NOT SCANNED: the vendored SDK bundle (not authored here) and the genpage fixtures (recorded agent runs:
// their text is whatever the agent produced, not guidance written for this repository). JSON, XML and
// transcript files are only checked by the patterns with scope 'any' or 'unfenced'.
//
// When this fails: reword the line so the reason stays and the pointer goes. If the token is not a review
// pointer (a table column, a fixture row), spell it out ("the first column") instead of using the bare id.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { validateAppSpec, migrateAppSpec } = require('../lib/app-spec.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCAN_ROOTS = ['plugins/model-apps', 'evals/model-apps'];
const THIS_FILE = 'plugins/model-apps/scripts/tests/review-references-hygiene.test.js';
const NOT_SCANNED_PREFIXES = ['plugins/model-apps/scripts/vendor/', 'evals/model-apps/genpage/fixtures/'];

// A finding id as the reviews wrote it: one letter and one or two digits ("C4", "I3", "R2", "T5", "F9",
// "H2", "M6", "N3") or "Imp" and digits ("Imp6"). "L" is left out on purpose: the genpage evals call their
// layers L1 and L2, and "(L1)" in an eval comment is not a pointer.
const ID = String.raw`(?:[CIRTFHMN]\d{1,2}|Imp\d{1,2})`;
// Left and right edge of a STANDALONE token: not glued to a longer identifier, path, URL, percent-escape
// ("%C3%A9"), ISO time ("T00:00:00") or quoted fixture string. \x60 is a backtick.
const TOKEN_START = String.raw`(?<![\w$.'"\x60/#%-])`;
const TOKEN_END = String.raw`(?![\w'"\x60-])`;
// The function keys read like ids ("F12 -> Network" in a troubleshooting step); they are removed before the
// broad rule runs.
const FUNCTION_KEY = /\bF(?:[1-9]|1[0-2])\b(?=\s*(?:→|->|keys?\b))|\b[Pp]ress\s+F(?:[1-9]|1[0-2])\b/g;

// scope 'any': every line. scope 'unfenced': every line except those of a Markdown code fence (an example's code is data).
// scope 'text': comments, Markdown prose, test titles and assertion messages (the whole line of a test or an
// assertion). scope 'prose': comments and Markdown prose only. scope 'note': what a person wrote for a reader and nothing a program
// reads — prose, the title literal of a test, the message literal of an assertion — never the data on the same line.
const PATTERNS = [
  {
    name: 'id-in-parens',
    scope: 'text',
    why: 'a finding id opening a parenthesis: "(C4)", "(R2/R3)", "(H4: ...)", "(I1 recovery guard ...)". A word character before the paren means a call, `fn(T1)`, which is not a pointer.',
    re: new RegExp(String.raw`(?<![\w$.)\]'"\x60-])\(${ID}(?:[\s,;:/)]|$)`),
    bad: [
      '// guard the loop (C8)',
      "test('rejects a stale key (I9 exact equality)', () => {});",
      '// retry on a stale lock (R5/R6)',
      '// (H7: the adapter picks the default)',
      '// the pages phase gates removals (Imp9)',
      "assert.ok(ok, 'the final persist is deduped (I6)');",
    ],
  },
  {
    name: 'id-closing-paren',
    scope: 'text',
    why: 'a finding id closing a parenthesis: "(stale snapshot, C2)", "(see T3)".',
    re: new RegExp(String.raw`(?<![\w$.'"\x60#%(-])${ID}\)`),
    bad: [
      '// stale snapshot (missing row, C2)',
      '// keep the order (see T3)',
      '// escalate (new Critical from R4)',
      "assert.ok(ok, 'ZERO updates (see I6)');",
    ],
  },
  {
    name: 'id-after-review-word',
    scope: 'text',
    why: 'an id introduced by a word that names where it came from: "reviewer C4", "finding I3", "addendum I5", "per T4", "rule T5", "design §9 T5".',
    re: new RegExp(String.raw`\b(?:[Rr]eview(?:er)?|[Ff]indings?|[Aa]ddend(?:um|a)|[Tt]enet|[Rr]ule|[Pp]er|[Ss]pec)\s+\*{0,2}#?${ID}${TOKEN_END}|§\d+(?:\.\d+)*\s+${ID}${TOKEN_END}`),
    bad: [
      '// reviewer C7 asked for this',
      '// per T3 the adapter derives the label',
      '// forbidden by design §9 T6',
      '// addendum I8: parse fail-closed',
    ],
  },
  {
    name: 'id-slash-list',
    scope: 'text',
    why: 'several ids in one list: "C1/I1/R2/R3/T5".',
    re: new RegExp(String.raw`${TOKEN_START}(?:[CIRT]\d{1,2}/)+[CIRT]\d{1,2}${TOKEN_END}`),
    bad: ['// C2/I3/R4/R5/T6 all apply here', '// the retry fix (R7/R8) covers it'],
  },
  {
    name: 'id-before-guard-word',
    scope: 'text',
    why: 'an id used as the name of a rule: "the I1 gate", "I1-gate exception", "the C1 hazard".',
    re: new RegExp(String.raw`${TOKEN_START}${ID}-?\s*(?:gate|guard|exception|hazard|invariant|mitigation|recovery)\b`),
    bad: [
      '// the I2 gate refuses partial ranges',
      '// I2-gate exception',
      '// avoids the C3 hazard',
      "assert.ok(ok, 'must pass the I2 gate');",
    ],
  },
  {
    name: 'new-hash-id',
    scope: 'text',
    why: 'a numbered new finding: "#N2".',
    re: /#N\d{1,2}\b/,
    bad: ['// --- #N6: widening a field must re-pack its row ---', "test('#N7: the verifier matches containers', () => {});"],
  },
  {
    name: 'severity-numbered',
    scope: 'any',
    why: 'a numbered severity: "Imp8", "Critical 7", "Critical #2", "Minor #7", "IMPORTANT #2". "Critical 4xx" and a plain "Critical" are not flagged.',
    re: /\bImp\d{1,2}\b|\bCritical\s\d{1,2}\b|\b(?:Crit(?:ical)?|CRITICAL|Important|IMPORTANT|Minor|MINOR|Major|MAJOR)\s?#\d{1,2}\b/,
    bad: [
      '// stricter path check (Imp8)',
      "test('rejects a duplicate path (Critical 7)', () => {});",
      '// Regression test for Critical #2: the build threw',
      '// Crit #3',
      '// Minor #7 additions ----------------------------',
      '// IMPORTANT #2 regression: a name-ref collides with a minted key',
    ],
  },
  {
    name: 'finding-label-hyphenated',
    scope: 'any',
    why: 'a finding label written with a hyphen: "new-Important-1", "Critical-2". A plain "important" or "critical" is not flagged.',
    re: /\b(?:new-)?(?:Critical|Important|Minor|Major|Blocker)-\d{1,2}\b/,
    bad: [
      '// new-Important-1 (fail-closed): a nav pageId must be a DECLARED "PAGEREF_<key>"',
      "assert.strictEqual(uploads.length, 0, 'rejected before any write (new-Important-1)');",
      '// Critical-2 regression: the lookup returned the wrong row',
    ],
  },
  {
    name: 'override-number',
    scope: 'any',
    why: 'a numbered override of a review finding: "OVERRIDE 2", "override-2". A plain "OVERRIDE" (a per-table override) is not flagged.',
    re: /\bOVERRIDE\s+\d{1,2}\b|\b[Oo]verride-\d{1,2}\b/,
    bad: [
      '// OVERRIDE 2 (new-Important-1): a nav pageId that is dynamic is rejected',
      "test('a dynamic nav pageId halts before any write — override-2', () => {});",
      '// only the detection (OVERRIDE 2) rejects this before any write',
    ],
  },
  {
    name: 'id-title-prefix',
    scope: 'any',
    why: 'a finding id opening a test title: "I1: ...", "C2 exception: ...". The title is read by everyone who runs the suite, and the id points into a review; say what the test proves.',
    re: new RegExp(String.raw`^\s*(?:test|it|describe)(?:\.\w+)?\(\s*['"\x60]${ID}(?::|\s+[a-z]+:)`),
    bad: [
      "test('I1: apply refuses ANY partial phase range except the full build', async () => {});",
      "test('I1 exception: a changed-only pages-only fast apply is NOT refused', async () => {});",
      "test('C2: an EXISTING page-backed app does NOT push its sitemap in app-shell', async () => {});",
      '  it("R4: the retry is idempotent", () => {});',
    ],
  },
  {
    name: 'addenda',
    scope: 'note',
    why: 'the word named the internal review addenda when it points at one: "(addendum I5)", "addenda Task 4", "(addenda)", "see the addenda". The word on its own ("a contract addendum") is not flagged, nor is any use in data or fenced code.',
    re: /\b[Aa]ddend(?:a|um)\s+(?:#?\d|[A-Z]\d|new-\d|Crit(?:ical)?\b|Task\b|Plan\b)|\((?:the\s+)?[Aa]ddend(?:a|um)[,;)]|\b(?:[Ss]ee|[Pp]er|[Ff]rom)\s+(?:the\s+)?addenda\b/,
    bad: [
      '// see the addenda',
      '// (addendum new-1)',
      '// reconcilePageIds authority logic (addenda Task 4 / C3) consumes it',
      '// Addendum Crit 4: path aliases that resolve to one file are duplicates',
      "test('rejects a non-string element (addendum I5)', () => {});",
      '// the sitemap check (addenda): a truncated XML must be rejected',
    ],
  },
  {
    name: 'reviewer-verb',
    scope: 'any',
    why: 'a named act of a reviewer on this code: "a reviewer pointed out". "so a reviewer can approve the doc" is not flagged.',
    re: /\breviewer\s+(?:caught|pointed|showed|found|flagged|noted|asked|said)\b/i,
    bad: ['// a reviewer pointed out the gap', '// the reviewer caught a prefix-only match'],
  },
  {
    name: 'review-round',
    scope: 'any',
    why: 'a count of review rounds: "Round-2 hardening", "review round", "rounds of adversarial review", "second review round". The word "round-trip" is not flagged.',
    re: /\b(?:review|adversarial)\s+rounds?\b(?!-)|\brounds?\s+of\s+(?:adversarial|(?:\w+\s+){0,2}review)|\b[Rr]ound[- ]\d\b|\b(?:first|second|third|fourth|fifth|sixth|seventh|final|last)\s+(?:review|adversarial)\s+(?:round|pass)\b/i,
    bad: [
      '// Round-5 hardening: the scoper is literal-aware',
      '// the fix survived a second review round',
      '// Six rounds of adversarial',
      '// after rounds of peer review',
      '// the third adversarial pass',
    ],
  },
  {
    name: 'plan-task-in-parens',
    scope: 'unfenced',
    why: 'a pointer into a numbered plan, in the parentheses a pointer is written in: "(Plan 4)", "(Task 3 / Plan 5 v2)", "(design §7 / Plan-3 C2)". A year ("Plan 2026") has more than two digits, and a name in quotes or brackets ("Task 1", [\'Task 1\']) is data, not flagged.',
    re: /\((?!\s*['"\x60[{])(?:[^()"\x60'[\]{}]|\w'\w)*\b(?:Plan|Task)[- ]\d{1,2}(?!\d)\b/,
    bad: [
      '// not landed (Plan 4)',
      '// every page must be placed (Task 3 / Plan 5 v2)',
      "return skip('pageref-resolver.js not landed (Plan 3)');",
      "// the membership read (this app's live sitemap, Task 1) fails closed",
    ],
  },
  {
    name: 'plan-task-label',
    scope: 'note',
    why: 'a label that points into a numbered plan, in prose or a test title: "Task 12: the verify gate", "Task 3 — every page", "Task-6: ...", "Plan-4 coupling", "Task 8\'s phase", "// Plan 5 safety gates: ...". "Task 1" or "Plan 2" with no label shape is a name, not flagged.',
    re: /\b(?:Plan|Task)-\d{1,2}\b|\b(?:Plan|Task) \d{1,2}'s\b|\b(?:Plan|Task)[- ]\d{1,2}(?!\d)\s*[:—–]|^\s*(?:\/\/|\*|#|<!--)\s*(?:[-=─]{2,}\s*)?(?:NEW\s+)?(?:Plan|Task)[- ]\d{1,2}\b[^:\n]{0,60}:/,
    bad: [
      '// Task 12: the verify gate is mandatory',
      '// Task 3 — every page must be an appShell subarea',
      '// ── Task 11: assignPageKeys + missingDownloads ──',
      "test('Task-6: a Maker-added page gets a minted key', () => {});",
      '// loose Plan-4 coupling',
      "// Task 8's pages phase needs a real file",
      '// ── Plan 5 three-authority safety gates: existence-driven',
      '// NEW Task 7 tests: name differs from title',
    ],
  },
  {
    name: 'group-priority',
    scope: 'any',
    why: 'an index into an internal priority list: "Group N P1".',
    re: /\bGroup\s+[A-Z0-9]\s+P\d\b/,
    bad: ['// --- Security personas (Group N P1) ---'],
  },
  {
    name: 'spec-rank',
    scope: 'any',
    why: 'an index into an internal spec: "spec rank 14".',
    re: /\bspec\s+rank\b/i,
    bad: ['// (spec rank 14)'],
  },
  {
    name: 'ask-number',
    scope: 'any',
    why: 'a numbered ask: "(Ask 2)", "Ask 3:". "Ask the user" is not flagged.',
    re: /\(Ask\s+\d+\)|\bAsk\s+\d+:/,
    bad: ['// shared dependency list (Ask 5)', '// Ask 6: do not drop the icon silently'],
  },
  {
    name: 'review-title-label',
    scope: 'any',
    why: 'a review label used as a test title prefix: "REVIEW-A".',
    re: /\bREVIEW-[A-Z]\b/,
    bad: ["test('REVIEW-A an ambiguous set stays untyped', () => {});"],
  },
  {
    name: 'dated-review-pointer',
    scope: 'any',
    why: 'a dated pointer to a review or its fixes: "2031-01-02 review", "the 2031-01-02 fixes".',
    re: /\b20\d\d-\d\d-\d\d\s+(?:review|fixes)\b/i,
    bad: ['// #5 (2031-01-02 review): a full-width section', 'The 2031-01-02 fixes: a lookup-heavy child'],
  },
  {
    name: 'whole-branch-review',
    scope: 'any',
    why: 'a pointer to a pass over a whole branch.',
    re: /\bwhole-branch\s+review\b/i,
    bad: ['// guarded twice (whole-branch review)'],
  },
  {
    name: 'reconciliation-number',
    scope: 'any',
    why: 'a numbered reconciliation of two reviews: "RECONCILIATION 3".',
    re: /\bRECONCILIATION\s+\d\b/,
    bad: ['// trigger mandatory verify (RECONCILIATION 3).'],
  },
  {
    name: 'id-comment-lead',
    scope: 'prose',
    why: 'a comment that opens with an id used as a heading: "// R4 - the retry rule", "// --- N6 label tests ---", "// F7: the cache key". Adds H, M and N to what the broad rule covers.',
    re: new RegExp(String.raw`^\s*(?:\/\/|\*|#|<!--)\s*(?:[-=─]{2,}\s*)?${ID}\b\s*(?:[:—–(]|-\s|\s+[a-z])`),
    bad: [
      '// R4 - the retry rule applies here',
      '// --- N6 label and exclusion tests ---',
      '// F7: the cache is keyed by name',
      '    // M8 falls back to a full build',
    ],
  },
  {
    name: 'id-bare-in-prose',
    scope: 'prose',
    strip: FUNCTION_KEY,
    why: 'a bare C, I, R, T or F id inside comment or Markdown prose: "the I1 hazard returns", "T4 says so".',
    re: new RegExp(String.raw`${TOKEN_START}[CIRTF]\d{1,2}${TOKEN_END}`),
    bad: [
      '// retries are idempotent, T3 says so',
      '// the I2 hazard returns on a retry',
      '// this is the F6 "convergence" mitigation',
      '// C4 outranks C5 when both are set',
    ],
  },
];

// Text that must stay unflagged; each entry is [file name, text]. Most are real lines of this plugin.
const LEGITIMATE = [
  ['a.js', '// found in review: the lookup returned the wrong row'],
  ['a.js', '// an adversarial review caught the prefix-only match'],
  ['a.js', '// design §13.1 and Rule 15 apply; see Step 5'],
  ['a.js', '// adversarial test #1: the form-placement collision'],
  ['a.js', '// so a reviewer can approve the omission, and the reviewer sees a garbled table'],
  ['a.js', "test('round-trips the deployed ids', () => {});"],
  ['a.js', '// The fix ROUND-TRIPS it rather than dropping it'],
  ['a.js', "assert.equal(deriveUniqueName('Q3 Plan 2026', hex), 'q3_plan_2026_1a2b3c4d');"],
  ['a.js', 'const dt = new Date(`${key}T00:00:00`);'],
  ['a.js', 'const path = `M0,${h} L${w},${h} Z`;'],
  ['a.js', "'type C1<T> = T extends (infer U)[] ? U : never;',"],
  ['a.js', "'type Pair<T1, T2> = (T1 | T2)[]; function f(a: T1, b: T2) {}',"],
  ['a.js', "['%C3%A9', '\\u00e9'],"],
  ['a.js', 'assert.ok(pos(LEAF1) < pos(GROUP), `leaf must precede its group`);'],
  ['a.js', 'render(C1, I2);'],
  ['a.js', '// layer 1 (L1) runs offline, and L2 needs a model'],
  ['a.js', '// Critical 4xx responses are retried once'],
  ['a.js', '// Ask the user once; Ask 3 questions at most'],
  ['a.js', '// spec ranking is stable'],
  ['a.js', '// reconciliation of the spec with the live app'],
  ['a.js', '// review the whole branch before merging'],
  ['a.js', '// verified on 2031-01-02 against a live app'],
  ['a.js', '// Press F12 in the browser, then open the Network tab'],
  ['a.md', '- **Capture the query first**: F12 → Network → filter `api/data` → find the 4xx response.'],
  ['a.md', 'Open the tools with the F12 key, then reload.'],
  ['a.md', 'Use `C1` as the sample column.\n\n```js\nconst C1 = 1;\nrender(T1, I2); // (T1)\n```'],
  // Names and documents that read like a pointer's words are data: a JSON value, an object literal, a slug test's input and expected
  // value, a fixture row, prose that names the fixture, a document type. The words alone are not a pointer.
  ['fixture.json', '{ "app": { "name": "Task 1", "description": "The first task" } }'],
  ['fixture.json', '{"app":{"name":"Contract Addendum"}}'],
  ['fixture.json', '  "description": "Plan 2 of the offsite, Task 3 and Task 4",'],
  ['a.js', 'const source = { name: "Task 1" };'],
  ['a.js', 'assert.equal(slug("Task 1"), "task-1");'],
  ['a.js', "assert.deepEqual(rows.map((r) => r.title), ['Task 1', 'Task 2', 'Plan 3']);"],
  ['a.js', "const rows = [{ title: 'Task 1' }, { title: 'Task 2' }];"],
  ['a.js', "render(fn('Task 1'), new Set(['Plan 2']), `Task ${n}`);"],
  ['a.js', "test('sorts Task 1 before Task 2, and Plan 10 after Plan 9', () => {});"],
  ['a.js', "assert.ok(ok, 'Task 2 follows Task 1 in the list');"],
  ['a.js', '// the fixture names its first row Task 1 and its second Task 2'],
  ['a.js', '// Sign the addendum, then attach the contract addendum to the order; an addendum plan follows'],
  ['a.js', 'const doc = "Contract Addendum";'],
  ['a.js', 'return `Addendum ${n}`;'],
  ['a.md', 'Create two tasks, named Task 1 and Task 2, then open the first one. A contract addendum is a document.'],
  ['a.md', '```js\nconst source = { name: "Task 1" };\nconst title = "Plan 2"; // Task 3: a sample\n// (Plan 4) and (Task 5)\ntest("Task-6: a title", () => {});\n```'],
  ['a.md', '~~~json\n{ "app": { "name": "Task 1 (Plan 2)", "note": "see the addenda" } }\n~~~'],
  ['a.js', '// a per-table OVERRIDE that beats the default, and an override of the default view'],
  ['a.js', '// the important part is that a minor change keeps its key; Major versions bump'],
];

const COMMENT_LEAD = /^\s*(?:\/\/|\/\*|\*(?!\/)|#|<!--)/;
const TRAILING_COMMENT = /\s\/\/\s(.*)$/;
// A line that carries a message for the reader: a test title or an assertion (whose last argument is the message).
const MESSAGE_LINE = /^\s*(?:(?:test|it|describe)(?:\.\w+)?|assert(?:\.\w+)?)\(/;
// The title of a test: its first argument, a string literal.   test('a page keeps its key', async () => {
const TITLE_LITERAL = /^\s*(?:test|it|describe)(?:\.\w+)?\(\s*(['"\x60])((?:\\.|(?!\1)[^\\])*)\1/;
// The message of an assertion: its last argument, a string literal that closes the call.   assert.ok(ok, 'the final persist is deduped');
// The other arguments are data (`assert.equal(slug("Task 1"), "task-1")` has no message: its last literal is the expected value).
const ASSERT_MESSAGE = /^\s*assert(?:\.\w+)?\(.*,\s*(['"\x60])((?:\\.|(?!\1)[^\\])*)\1\s*\)\s*;?\s*(?:\/\/.*)?$/;

// The part of `line` that is prose: a whole comment line, the comment after code (`foo(); // why`), or any
// Markdown line outside a fenced code block. Null for code.
function proseOf(file, line, inFence) {
  if (/\.md$/i.test(file)) return inFence ? null : line;
  if (COMMENT_LEAD.test(line)) return line;
  const trailing = TRAILING_COMMENT.exec(line);
  return trailing ? `// ${trailing[1]}` : null;
}

// What a person wrote for a reader, and not the data beside it: the prose, the title of a test, the message of an assertion. Null for
// code, a JSON value, and a Markdown code fence (`prose` is already null there, and a fence is never searched for titles).
function noteOf(file, line, prose) {
  if (prose !== null) return prose;
  if (/\.md$/i.test(file)) return null;
  const title = TITLE_LITERAL.exec(line) || ASSERT_MESSAGE.exec(line);
  return title ? title[2] : null;
}

function flagsFor(file, line, prose, fenced) {
  const text = MESSAGE_LINE.test(line) ? line : prose;
  const note = noteOf(file, line, prose);
  const names = [];
  for (const p of PATTERNS) {
    const subject = p.scope === 'any' ? line : p.scope === 'unfenced' ? (fenced ? null : line) : p.scope === 'text' ? text : p.scope === 'note' ? note : prose;
    if (subject === null) continue;
    if (p.re.test(p.strip ? subject.replace(p.strip, ' ') : subject)) names.push(p.name);
  }
  return names;
}

function scanText(file, text) {
  const hits = [];
  const markdown = /\.md$/i.test(file);
  let inFence = false;
  text.split(/\r?\n/).forEach((line, index) => {
    // A fence line toggles the state and is itself code: ```js
    if (markdown && /^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    for (const name of flagsFor(file, line, proseOf(file, line, inFence), markdown && inFence)) {
      hits.push({ file, line: index + 1, name, text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}

// `git ls-files`, not a directory walk: other tests create and delete transient folders under these trees
// while the suite runs, and untracked scratch files are not part of what the public repository publishes.
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_ROOTS], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function isScanned(file) {
  return file !== THIS_FILE && !NOT_SCANNED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

// Returns null for a binary file (a NUL byte), which has no lines to read.
function readText(file) {
  const buffer = fs.readFileSync(path.join(REPO_ROOT, file));
  return buffer.includes(0) ? null : buffer.toString('utf8');
}

test('every pattern flags its own examples', () => {
  for (const p of PATTERNS) {
    assert.ok(p.why && p.bad.length > 0, `${p.name}: needs a "why" and at least one example`);
    for (const sample of p.bad) {
      assert.ok(scanText('a.js', sample).some((hit) => hit.name === p.name), `${p.name} must flag: ${sample}`);
    }
  }
  const names = PATTERNS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'pattern names are unique');
});

test('legitimate text is not flagged by any pattern', () => {
  for (const [file, text] of LEGITIMATE) {
    assert.deepEqual(scanText(file, text), [], `must not flag: ${text}`);
  }
});

test('Markdown prose, comments after code and message lines are scanned; code and fenced code are not', () => {
  assert.ok(scanText('a.md', 'The spec pageId outranks the manifest entry, T4 says so.').some((hit) => hit.name === 'id-bare-in-prose'));
  assert.ok(scanText('a.md', '- **T1 canonical desired state** - restored').some((hit) => hit.name === 'id-bare-in-prose'));
  const fenced = ['```js', 'const T4 = 1; // inside a fence: code, not prose', '```', 'T4 says so, outside the fence'].join('\n');
  assert.deepEqual(scanText('a.md', fenced).map((hit) => [hit.line, hit.name]), [[4, 'id-bare-in-prose']]);
  assert.ok(scanText('a.js', 'const x = 1; // T4 says so').some((hit) => hit.name === 'id-bare-in-prose'));
  assert.deepEqual(scanText('a.js', 'const T4 = 1; const x = C1 + T1; run(C1, I2);'), []);
});

test('the plain words of a plan pointer are flagged in its shape and in prose, never in data or a code fence', () => {
  const names = (file, text) => scanText(file, text).map((hit) => `${hit.line}:${hit.name}`);
  // Prose and titles: the shape is flagged.
  assert.deepEqual(names('a.md', 'The gate is not landed yet (Plan 4).'), ['1:plan-task-in-parens']);
  assert.deepEqual(names('a.md', 'Task 12: the verify gate is mandatory'), ['1:plan-task-label']);
  assert.deepEqual(names('a.js', "test('Task-6: a Maker-added page gets a minted key', () => {});"), ['1:plan-task-label']);
  assert.deepEqual(names('a.js', "assert.ok(ok, 'the step is not landed (Task 3)');"), ['1:plan-task-in-parens']);
  assert.deepEqual(names('a.js', "return skip('the resolver is not landed (Plan 3)');"), ['1:plan-task-in-parens'], 'a message in code is still a message');
  // Data: the very same words are not flagged in a JSON value, an object literal or an assertion's data.
  assert.deepEqual(names('f.json', '{ "name": "Task 1", "title": "Plan 2" }'), []);
  assert.deepEqual(names('a.js', 'const row = { name: "Task 1", note: \'Plan 2\' };'), []);
  assert.deepEqual(names('a.js', 'assert.equal(slug("Task 1"), "task-1");'), []);
  assert.deepEqual(names('a.js', "assert.equal(label, 'Task 1');"), []);
  // A code fence is code, whatever it holds — a label, a parenthesis, a test title — and the same text outside the fence is prose.
  const md = ['Before.', '```js', '// Task 3: sample', 'test("Task-6: a title", () => {}); // (Plan 4)', '```', 'After: (Plan 4)'].join('\n');
  assert.deepEqual(names('a.md', md), ['6:plan-task-in-parens']);
  // "addenda" and "addendum" are pointers only when they point: at an id, in parentheses, or "see the addenda".
  assert.deepEqual(names('a.js', '// the gate is described in the addenda, see the addenda'), ['1:addenda']);
  assert.deepEqual(names('a.js', '// (addendum new-1)'), ['1:addenda']);
  assert.deepEqual(names('a.js', 'const doc = { type: "Contract Addendum" };'), []);
  assert.deepEqual(names('f.json', '{ "app": { "name": "Contract Addendum", "note": "see the addenda" } }'), []);
});

test('a title that opens with a finding id, a hyphenated finding label and a numbered severity are flagged', () => {
  const names = (text) => scanText('a.js', text).map((hit) => hit.name);
  assert.deepEqual(names("test('I1: apply refuses a partial phase range', async () => {});"), ['id-title-prefix']);
  assert.deepEqual(names("test('C2 exception: a changed-only apply is not refused', async () => {});"), ['id-title-prefix']);
  assert.deepEqual(names('// new-Important-1 (fail-closed): a nav pageId must be declared'), ['finding-label-hyphenated']);
  assert.deepEqual(names('// OVERRIDE 2: the nav check also rejects a dynamic id'), ['override-number']);
  assert.deepEqual(names('// Minor #7 additions ---------------'), ['severity-numbered']);
  // The same words in an ordinary title or sentence are not pointers.
  assert.deepEqual(names("test('the I/O error is reported (the C library is not used)', () => {});"), []);
  assert.deepEqual(names("test('an important change keeps its key; a minor one does too', () => {});"), []);
  assert.deepEqual(names("test('C is a column, I is an index', () => {});"), []);
});

test('a schema-valid fixture whose names read like pointers is data, whatever it is called', () => {
  // The app, a table and a page are named with the words a pointer is made of. The spec is valid (so a fixture like it is a legitimate thing to
  // commit), and the guard reads none of it as a review reference.
  const spec = {
    schemaVersion: 2,
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Task 1', description: 'Contract Addendum - Plan 2 of the offsite' },
    entities: [{ schemaName: 'contoso_task', displayName: 'Task 1', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_task', title: 'Task 1' }] }] }] },
  };
  for (const profile of ['plan', 'deploy']) {
    const validation = validateAppSpec(migrateAppSpec(spec), { profile });
    assert.equal(validation.ok, true, `${profile}: ${JSON.stringify(validation.errors)}`);
  }
  assert.deepEqual(scanText('fixtures/app-spec.json', JSON.stringify(spec, null, 2)), []);
  // The same document in a Markdown example is a code fence.
  assert.deepEqual(scanText('guide.md', ['A downloaded spec looks like this:', '', '```json', JSON.stringify(spec, null, 2), '```'].join('\n')), []);
});

test('plugins/model-apps and evals/model-apps carry no internal review references', (t) => {
  const files = trackedFiles();
  if (!files) {
    t.skip('not a git checkout: there is nothing to enumerate');
    return;
  }
  const scanned = files.filter(isScanned);
  // A scan that read nothing would pass for the wrong reason.
  assert.ok(scanned.includes('plugins/model-apps/AGENTS.md') && scanned.includes('evals/model-apps/app-builder/EVAL_GUIDE.md'), 'the scan must cover the plugin and its evals');
  assert.ok(scanned.length > 300, `expected hundreds of tracked files, got ${scanned.length}`);

  const hits = [];
  for (const file of scanned) {
    const text = readText(file);
    if (text !== null) hits.push(...scanText(file, text));
  }
  const reasons = [...new Set(hits.map((hit) => hit.name))].map((name) => `  ${name}: ${PATTERNS.find((p) => p.name === name).why}`);
  assert.equal(
    hits.length,
    0,
    `${hits.length} internal review reference(s) in public files. Keep the REASON and drop the POINTER (see the header of ${THIS_FILE}).\n` +
      `${hits.slice(0, 40).map((hit) => `  ${hit.file}:${hit.line} [${hit.name}] ${hit.text}`).join('\n')}\n${reasons.join('\n')}`,
  );
});
