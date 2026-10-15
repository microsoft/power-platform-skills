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
//     prose, test titles and assertion messages (scope 'note'). They never look at code, where `T1`, `C1`
//     and `M1<T>` are ordinary type parameters, names and test inputs (a TypeScript snippet such as
//     "(T1 | T2)[]" must not fail the build), nor at the data beside a message. The one broad rule,
//     `id-bare-in-prose`, is narrower still: comments and Markdown prose only, never fenced code, and
//     it skips function keys.
//   * The plain words a pointer is made of ("Task 1", "Plan 2", "Addendum") are also ordinary data: a fixture
//     row, a slug test's input, the name of a contract document, an app called "Task 1 (Plan 2)". They are
//     flagged only in the SHAPE of a pointer (in parentheses, hyphenated, a label before a colon or dash,
//     followed by an id) and only where a person wrote prose (scope 'note') — never in a JSON value, an
//     object literal, an assertion's data, or fenced code.
//   * A message is found by its POSITION, not by looking like one. An assertion takes its message last,
//     after what it compares — assert.ok(value[, message]), assert.equal(actual, expected[, message]),
//     assert.match(string, regexp[, message]) — so the second argument of a two-argument
//     `assert.equal(label, 'Task-6: Overview')` is the expected value, which is data, and the third of
//     `assert.equal(label, 'x', 'Task-6: Overview')` is a message. That needs the lexical structure of the call
//     (a comma inside a nested call, a string, a template or a regular expression separates nothing; a call
//     written inside a string or a comment is not one), so `lex` below reads it.
//   * A rule about the numbered titles under a heading needs the heading. A test title that opens with its own
//     number ("#2b ...") is flagged only in a file whose prose also labels its groups "Finding N"
//     (`numbered-title-under-finding`): there the numbers are the review's, not the suite's. Elsewhere it is an
//     ordinary numbered test ("#4 view pure column append -> fast"), and a title that opens with an issue
//     number ("#545: ...") is a pointer a reader can follow; neither is flagged.
//   * Every pattern carries examples it must flag, and LEGITIMATE carries text that no pattern may flag;
//     the first two tests below run both, so a pattern cannot drift without this file noticing.
//
// NOT SCANNED: the vendored SDK bundle (not authored here) and the genpage fixtures (recorded agent runs:
// their text is whatever the agent produced, not guidance written for this repository). JSON, XML and
// transcript files are only checked by the patterns with scope 'any'.
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
// A numbered finding of a review: "Finding 3", "findings #4". The pattern `finding-number` flags it, and a file whose prose carries one is a file whose
// numbered test titles are probably the findings' own numbers (`numbered-title-under-finding`).
const FINDING_NUMBER = /\b[Ff]indings?\s+#?\d{1,2}[a-z]?\b/;

// scope 'any': every line. scope 'prose': comments and Markdown prose only (a Markdown code fence is data). scope 'note': what a person wrote for a
// reader and nothing a program reads — prose, the title literal of a test, the message of an assertion or of a skip (found by its position among the
// call's arguments) — never the data on the same line. scope 'title': the title literal of a test alone. A pattern with `inFile` applies only in a file
// in which the pattern it names flags something: a rule about the numbered titles under a heading needs the heading.
const PATTERNS = [
  {
    name: 'id-in-parens',
    scope: 'note',
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
    scope: 'note',
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
    scope: 'note',
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
    scope: 'note',
    why: 'several ids in one list: "C1/I1/R2/R3/T5".',
    re: new RegExp(String.raw`${TOKEN_START}(?:[CIRT]\d{1,2}/)+[CIRT]\d{1,2}${TOKEN_END}`),
    bad: ['// C2/I3/R4/R5/T6 all apply here', '// the retry fix (R7/R8) covers it'],
  },
  {
    name: 'id-before-guard-word',
    scope: 'note',
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
    scope: 'note',
    why: 'a numbered new finding: "#N2".',
    re: /#N\d{1,2}\b/,
    bad: ['// --- #N6: widening a field must re-pack its row ---', "test('#N7: the verifier matches containers', () => {});"],
  },
  {
    name: 'finding-number',
    scope: 'note',
    why: 'a numbered finding of a review, as a heading or a label: "Finding 3: ...", "--- Finding 4 ---", "(Finding 7)", "Findings 1 and 2". The number indexes a list of findings that this repository does not hold; say what the group pins. "finding" with no number is not flagged, nor is a fixture or an expected value that holds the words.',
    re: FINDING_NUMBER,
    bad: [
      '// --- Finding 1: a stale cache entry was served ---------------------------------------',
      '// Finding #4 regression: a view filter on a localized option',
      "test('Finding 7: the primary attribute keeps its label', () => {});",
      "assert.ok(ok, 'the label is kept (Finding 2b)');",
      '// Findings 3 and 4 are covered by the same test',
    ],
  },
  {
    name: 'numbered-title-under-finding',
    scope: 'title',
    inFile: 'finding-number',
    why: 'a test title that opens with its own number ("#1 ...", "#2b-bis ...", "#6a5 ...") in a file whose groups are labelled "Finding N": the numbers are the findings\' and mean nothing to whoever reads the suite; say what the test proves. In a file with no such labels a numbered title ("#4 view pure column append -> fast") is an ordinary numbered test, and an issue number ("#545: ...") is a pointer a reader can follow: neither is flagged.',
    re: /^#\d{1,2}(?:[a-z](?:-bis|\d)?)?(?=[\s:.)]|$)/,
    bad: [
      "// --- Finding 1: a stale cache entry was served ---\ntest('#1 a stale entry is refreshed before it is served', async () => {});",
      "// --- Finding 2: the retry could be skipped ---\ntest('#2b-bis a retry after a timeout is not skipped', async () => {});",
      "// --- Finding 6: the report failed open ---\ntest('#6a5 a failed read is reported as unknown', async () => {});",
    ],
  },
  {
    name: 'review-finding-count',
    scope: 'note',
    why: 'a count or a batch of the findings of a review: "the six defects an adversarial peer review found", "Further review findings". A single reason ("found in review", "an adversarial review caught ...") is generic provenance and stays.',
    re: /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:defects|findings|bugs|issues)\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+){0,3}reviews?\b[^.]{0,20}\bfound\b|\b(?:further|more|additional|remaining|other)\s+review\s+findings\b/i,
    bad: [
      '// Regression tests for the six defects an adversarial peer review found in the importer',
      '// --- Further review findings: key escaping, and the two parsers that still disagreed ---',
      '// the 3 bugs a review found in the importer',
    ],
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
    scope: 'note',
    why: 'a pointer into a numbered plan, in the parentheses a pointer is written in: "(Plan 4)", "(Task 3 / Plan 5 v2)", "(design §7 / Plan-3 C2)". A year ("Plan 2026") has more than two digits, and a name in quotes or brackets ("Task 1", [\'Task 1\']) is data, not flagged; so is the same shape in a JSON value, an object literal or an assertion\'s expected value ("Task 1 (Plan 2)").',
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
  // The same names in data, parenthesised or labelled: a JSON value, an object literal, and the expected value of an assertion. The second argument of a
  // two-argument assert.equal is what the code under test must give, not a message; only the argument after it is read as one.
  ['fixture.json', '{"app":{"name":"Task 1 (Plan 2)"}}'],
  ['a.js', 'const source = { name: "Task 1 (Plan 2)" };'],
  ['a.js', "assert.equal(label, 'Task-6: Overview');"],
  ['a.js', "assert.equal(label, 'see the addenda');"],
  ['a.js', "assert.equal(label, 'Task-6: Overview', 'name kept');"],
  ['a.js', "assert.strictEqual(rows[0].title, 'Task 3 — every page');"],
  ['a.js', "assert.deepEqual(titles, ['Task 12: the verify gate', 'Task 1 (Plan 2)']);"],
  ['a.js', "assert.deepStrictEqual(f(a, 'x'), { name: 'Task 1 (Plan 2)' });"],
  ['a.js', "assert.match(text, /Task-6: (Plan 4)/);"],
  ['a.js', "assert.throws(run, 'Task-6: Overview');"],
  ['a.js', "assert.ok('Task 12: a value');"],
  ['a.js', "assert.ok(ok, `Task ${n} follows ${'Task 1 (Plan 2)'}`);"],
  ['a.js', "assert.equal(app.name,\n  'Task 1 (Plan 2)');"],
  ['a.js', "const sample = `\nassert.ok(x, 'Task 12: the gate (Plan 4)');\n`;"],
  ['a.js', "const rule = /assert.ok(x, 'Task 12: gate')/;"],
  // Words and numbers that look like the findings of a review but are not: a finding with no number, the name of a lint result, a numbered test that belongs
  // to no review, an issue number a reader can follow, and a review mentioned as the place a fix was found.
  ['a.js', '// each finding names its table; a finding is a warning, not an error'],
  ['a.js', '// the lint reports 3 findings, 1 per table'],
  ['a.js', 'assert.equal(report.findings.length, 3);'],
  ['a.js', "assert.equal(report.findings[0].title, 'Finding 1');"],
  ['a.js', "const rows = [{ title: 'Finding 1' }, { title: 'Finding 2' }];"],
  ['fixture.json', '{ "title": "Finding 1", "body": "Findings 2 and 3" }'],
  ['a.js', "test('#4 view pure column APPEND -> fast (view shape)', () => {});"],
  ['a.js', "test('#1 build-status.json is overwritten each step', () => {});"],
  ['a.js', "test('#545: preserves hand-authored page keys when only the top-level schemaVersion is missing', () => {});"],
  ['a.js', "// the 3 issues were found in review and fixed\ntest('#2 the second case', () => {});"],
  ['a.js', '// found in review: three issues were reported against the importer'],
  ['a.js', '// a per-table OVERRIDE that beats the default, and an override of the default view'],
  ['a.js', '// the important part is that a minor change keeps its key; Major versions bump'],
];

const COMMENT_LEAD = /^\s*(?:\/\/|\/\*|\*(?!\/)|#|<!--)/;
const TRAILING_COMMENT = /\s\/\/\s(.*)$/;
// The title of a test: its first argument, a string literal.   test('a page keeps its key', async () => {
const TITLE_LITERAL = /^\s*(?:test|it|describe)(?:\.\w+)?\(\s*(['"\x60])((?:\\.|(?!\1)[^\\])*)\1/;
// JavaScript and TypeScript source, whose calls `messageLiterals` reads.
const SOURCE_FILE = /\.(?:[cm]?js|jsx|ts|tsx)$/i;

// ── where the message of an assertion sits ─────────────────────────────────────────────────────────────────────────────────────

// A call whose message is a string a person reads, and the position of that argument among its top-level arguments. An assertion takes its message
// LAST, after what it compares: assert.ok(value[, message]), assert.equal(actual, expected[, message]), assert.match(string, regexp[, message]).
// With fewer arguments there is none, whatever the last one is: `assert.equal(label, 'Task-6: Overview')` asserts a label. assert.throws and its
// kin take (fn[, error][, message]), so with two arguments the second may be the error to expect, and only a third is read. A skip takes its reason.
const MESSAGE_ARGUMENT = {
  assert: 1, 'assert.ok': 1,
  'assert.equal': 2, 'assert.notEqual': 2, 'assert.strictEqual': 2, 'assert.notStrictEqual': 2,
  'assert.deepEqual': 2, 'assert.notDeepEqual': 2, 'assert.deepStrictEqual': 2, 'assert.notDeepStrictEqual': 2,
  'assert.match': 2, 'assert.doesNotMatch': 2,
  'assert.throws': 2, 'assert.doesNotThrow': 2, 'assert.rejects': 2, 'assert.doesNotReject': 2,
  'assert.fail': 0,
  skip: 0, todo: 0, 't.skip': 0, 't.todo': 0,
};
const CALLEE = /(?<![\w$.])(assert(?:\.[A-Za-z]+)?|t\.skip|t\.todo|skip|todo)\s*\(/g;

const CODE = 0;
const STRING = 1;
const COMMENT = 2;
const REGEX = 3;
// A `/` opens a regular expression, not a division, after one of these characters or words: where an operand is expected.
const REGEX_AFTER_CHAR = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_AFTER_WORD = /^(?:return|typeof|case|in|of|delete|void|throw|new|else|do)$/;

// Classifies every character of a JavaScript source as code, string (the quotes, and the text of a template), comment or regular expression, and
// records where each string or template starts and ends (`ends`: start -> index after the last character) and which stretches of it are its own text
// (`texts`: start -> [from, to) ranges; a template's `${ ... }` is code again, with braces that nest, and a string inside it is another token). It does
// not parse: whatever it cannot read (a string that does not close, a regular expression that does not close on its line) ends where the line does,
// because a wrong guess may lose a message and must never make one up.
function lex(text) {
  const kind = new Uint8Array(text.length);
  const ends = new Map();
  const texts = new Map();
  const templates = [];
  let depth = 0;
  const mark = (from, to, as) => kind.fill(as, from, Math.min(to, text.length));
  const lineEnd = (from) => { const at = text.indexOf('\n', from); return at < 0 ? text.length : at; };
  const own = (start, from, to) => { if (to > from) texts.set(start, [...(texts.get(start) || []), [from, to]]); };
  const quoted = (from, quote) => {
    let j = from + 1;
    while (j < text.length && text[j] !== '\n') {
      if (text[j] === '\\') j += 2;
      else if (text[j] === quote) { j += 1; break; } else j += 1;
    }
    return Math.min(j, text.length);
  };
  // A template's own text, from `from` to the closing backtick (which ends the token) or the next `${` (which hands back to code).
  const templateText = (start, from) => {
    let j = from;
    while (j < text.length) {
      if (text[j] === '\\') { mark(j, j + 2, STRING); j += 2; continue; }
      if (text[j] === '`') { mark(j, j + 1, STRING); own(start, from, j); ends.set(start, j + 1); return j + 1; }
      if (text[j] === '$' && text[j + 1] === '{') { own(start, from, j); templates.push({ start, depth }); depth += 1; return j + 2; }
      mark(j, j + 1, STRING);
      j += 1;
    }
    own(start, from, text.length);
    ends.set(start, text.length);
    return text.length;
  };
  const regexAllowed = (at) => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(text[j])) j -= 1;
    if (j < 0) return true;
    if (/[\w$]/.test(text[j])) {
      let k = j;
      while (k > 0 && /[\w$]/.test(text[k - 1])) k -= 1;
      return REGEX_AFTER_WORD.test(text.slice(k, j + 1));
    }
    return text[j] === '}' || REGEX_AFTER_CHAR.test(text[j]);
  };
  // A regular expression from `from` to its closing slash (a slash inside [...] does not close it) and flags; 0 when it does not close on its line.
  const regex = (from) => {
    let j = from + 1;
    let inClass = false;
    while (j < text.length && text[j] !== '\n') {
      if (text[j] === '\\') j += 2;
      else if (text[j] === '[') { inClass = true; j += 1; } else if (text[j] === ']') { inClass = false; j += 1; } else if (text[j] === '/' && !inClass) {
        j += 1;
        while (/[a-z]/i.test(text[j] || '')) j += 1;
        return j;
      } else j += 1;
    }
    return 0;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') { const stop = lineEnd(i); mark(i, stop, COMMENT); i = stop; continue; }
    if (c === '/' && next === '*') { const close = text.indexOf('*/', i + 2); const stop = close < 0 ? text.length : close + 2; mark(i, stop, COMMENT); i = stop; continue; }
    if (c === "'" || c === '"') { const stop = quoted(i, c); mark(i, stop, STRING); ends.set(i, stop); own(i, i + 1, Math.max(i + 1, stop - 1)); i = stop; continue; }
    if (c === '`') { mark(i, i + 1, STRING); i = templateText(i, i + 1); continue; }
    if (c === '/' && regexAllowed(i)) { const stop = regex(i); if (stop) { mark(i, stop, REGEX); i = stop; continue; } }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      // The brace that closes a `${ ... }` hands the text back to its template.
      if (templates.length && templates[templates.length - 1].depth === depth) { const open = templates.pop(); i = templateText(open.start, i + 1); continue; }
    }
    i += 1;
  }
  return { kind, ends, texts };
}

// The messages of `text` by line: Map<line index, string[]>. Each is the text of the string or template literal that sits at the message position of an
// assertion or a skip (MESSAGE_ARGUMENT) — a template's own text, not the code of its `${ }` — credited to the line it is written on.
function messageLiterals(text) {
  const { kind, ends, texts } = lex(text);
  const lineStarts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (lineStarts[mid] <= offset) low = mid; else high = mid - 1; }
    return low;
  };
  const found = new Map();
  for (const call of text.matchAll(CALLEE)) {
    if (kind[call.index] !== CODE) continue;
    const position = MESSAGE_ARGUMENT[call[1]];
    // The top-level arguments: `[from, to)` of each, without the white space and comments around it.
    const args = [];
    let depth = 0;
    let from = -1;
    let to = -1;
    let closed = false;
    for (let at = call.index + call[0].length; at < text.length; at += 1) {
      if (kind[at] === COMMENT || (kind[at] === CODE && /\s/.test(text[at]))) continue;
      const c = text[at];
      if (kind[at] === CODE && (c === ')' || c === ']' || c === '}') && depth === 0) {
        if (c === ')') { if (from >= 0) args.push({ from, to }); closed = true; }
        break;
      }
      if (kind[at] === CODE && c === ',' && depth === 0) { args.push({ from, to }); from = -1; continue; }
      if (kind[at] === CODE && (c === '(' || c === '[' || c === '{')) depth += 1;
      else if (kind[at] === CODE && (c === ')' || c === ']' || c === '}')) depth -= 1;
      if (from < 0) from = at;
      to = at + 1;
    }
    if (!closed || position === undefined || args.length <= position || args[position].from < 0) continue;
    const literal = args[position];
    // One string or template and nothing else: `'a' + b` and `fn('a')` are not a message.
    if (ends.get(literal.from) !== literal.to) continue;
    // Its own text by line, so a pointer's shape on one line survives an interpolation on another.
    const written = new Map();
    for (const [start, stop] of texts.get(literal.from) || []) {
      for (let at = start; at < stop; at += 1) {
        if (text[at] !== '\n' && text[at] !== '\r') written.set(lineOf(at), (written.get(lineOf(at)) || '') + text[at]);
      }
    }
    for (const [line, piece] of written) found.set(line, [...(found.get(line) || []), piece]);
  }
  return found;
}

// The part of `line` that is prose: a whole comment line, the comment after code (`foo(); // why`), or any
// Markdown line outside a fenced code block. Null for code.
function proseOf(file, line, inFence) {
  if (/\.md$/i.test(file)) return inFence ? null : line;
  if (COMMENT_LEAD.test(line)) return line;
  const trailing = TRAILING_COMMENT.exec(line);
  return trailing ? `// ${trailing[1]}` : null;
}

// What a person wrote for a reader, and not the data beside it: the prose, the title of a test, and the messages of the assertions and skips written on the
// line (found by their position: see messageLiterals). Null for code, a JSON value, and a Markdown code fence (`prose` is already null there, and a fence
// is never searched for titles).
function noteOf(file, line, prose, messages) {
  const parts = [];
  if (prose !== null) parts.push(prose);
  if (!/\.md$/i.test(file)) {
    const title = TITLE_LITERAL.exec(line);
    if (title) parts.push(title[2]);
    if (messages) parts.push(...messages);
  }
  return parts.length ? parts.join('\n') : null;
}

function matches(p, row) {
  const subject = p.scope === 'any' ? row.line : p.scope === 'note' ? row.note : p.scope === 'title' ? row.title : row.prose;
  if (subject === null) return false;
  return p.re.test(p.strip ? subject.replace(p.strip, ' ') : subject);
}

function scanText(file, text) {
  const markdown = /\.md$/i.test(file);
  const messages = SOURCE_FILE.test(file) ? messageLiterals(text) : new Map();
  let inFence = false;
  const rows = text.split(/\r?\n/).map((line, index) => {
    // A fence line toggles the state and is itself code: ```js
    if (markdown && /^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    const prose = proseOf(file, line, inFence);
    const title = markdown ? null : TITLE_LITERAL.exec(line);
    return { line, index, prose, note: noteOf(file, line, prose, messages.get(index)), title: title ? title[2] : null };
  });
  const hits = [];
  const flagged = new Set();
  // The patterns that need a context come after the ones that make it: `inFile` names the pattern that must have flagged something in this file.
  const sweep = (patterns) => {
    for (const p of patterns) {
      for (const row of rows) {
        if (!matches(p, row)) continue;
        hits.push({ file, line: row.index + 1, name: p.name, text: row.line.trim().slice(0, 160) });
        flagged.add(p.name);
      }
    }
  };
  sweep(PATTERNS.filter((p) => !p.inFile));
  sweep(PATTERNS.filter((p) => p.inFile && flagged.has(p.inFile)));
  const order = (hit) => PATTERNS.findIndex((p) => p.name === hit.name);
  return hits.sort((a, b) => a.line - b.line || order(a) - order(b));
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
  // Data: the very same words are not flagged in a JSON value, an object literal or an assertion's data — parenthesised or not.
  assert.deepEqual(names('f.json', '{ "name": "Task 1", "title": "Plan 2" }'), []);
  assert.deepEqual(names('f.json', '{"app":{"name":"Task 1 (Plan 2)"}}'), []);
  assert.deepEqual(names('a.js', 'const row = { name: "Task 1", note: \'Plan 2\' };'), []);
  assert.deepEqual(names('a.js', 'const source = { name: "Task 1 (Plan 2)" };'), []);
  assert.deepEqual(names('a.js', 'assert.equal(slug("Task 1"), "task-1");'), []);
  assert.deepEqual(names('a.js', "assert.equal(label, 'Task 1');"), []);
  assert.deepEqual(names('a.js', "assert.equal(label, 'Task 1 (Plan 2)');"), []);
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
  assert.deepEqual(names("test('C2 exception: a changed-only apply is not refused', async () => {});"), ['id-before-guard-word', 'id-title-prefix'], 'it also names the exception as a rule');
  assert.deepEqual(names('// new-Important-1 (fail-closed): a nav pageId must be declared'), ['finding-label-hyphenated']);
  assert.deepEqual(names('// OVERRIDE 2: the nav check also rejects a dynamic id'), ['override-number']);
  assert.deepEqual(names('// Minor #7 additions ---------------'), ['severity-numbered']);
  // The same words in an ordinary title or sentence are not pointers.
  assert.deepEqual(names("test('the I/O error is reported (the C library is not used)', () => {});"), []);
  assert.deepEqual(names("test('an important change keeps its key; a minor one does too', () => {});"), []);
  assert.deepEqual(names("test('C is a column, I is an index', () => {});"), []);
});

test('an assertion\'s message is the argument after what it compares: the second argument of a two-argument assert.equal is data', () => {
  const names = (text) => scanText('a.js', text).map((hit) => `${hit.line}:${hit.name}`);
  // Two arguments: the expected value, whatever it says. Three: the third is the message, and is read.
  assert.deepEqual(names("assert.equal(label, 'Task-6: Overview');"), []);
  assert.deepEqual(names("assert.equal(label, 'see the addenda');"), []);
  assert.deepEqual(names("assert.equal(label, 'Task-6: Overview', 'name kept');"), []);
  assert.deepEqual(names("assert.equal(label, 'x', 'Task-6: Overview');"), ['1:plan-task-label']);
  assert.deepEqual(names("assert.strictEqual(label, 'Task-6: Overview', 'Task 12: the verify gate');"), ['1:plan-task-label']);
  assert.deepEqual(names("assert.deepStrictEqual(rows, ['Task 3 — a page'], 'the step is not landed (Task 3)');"), ['1:plan-task-in-parens']);
  assert.deepEqual(names("assert.equal(label, 'x', 'see the addenda');"), ['1:addenda']);
  // assert.ok takes its message second, and assert.match third; with one (two) argument(s) there is none.
  assert.deepEqual(names("assert.ok(ok, 'the step is not landed (Task 3)');"), ['1:plan-task-in-parens']);
  assert.deepEqual(names("assert.ok('Task 12: a value');"), []);
  assert.deepEqual(names("assert.match(text, /Task 12: gate/, 'Task 12: the verify gate');"), ['1:plan-task-label']);
  assert.deepEqual(names("assert.match(text, /Task-6: (Plan 4)/);"), []);
  // assert.throws takes (fn[, error][, message]): with two arguments the second may be the error to expect, so only a third is a message.
  assert.deepEqual(names("assert.throws(run, 'Task-6: Overview');"), []);
  assert.deepEqual(names("assert.throws(run, /gate/, 'Task 12: the verify gate');"), ['1:plan-task-label']);
  assert.deepEqual(names("assert.fail('the step is not landed (Task 3)');"), ['1:plan-task-in-parens']);
  assert.deepEqual(names("assert(ok, 'Task 12: the verify gate');"), ['1:plan-task-label']);
  // A skip gives its reason.
  assert.deepEqual(names("return skip('the resolver is not landed (Plan 3)');"), ['1:plan-task-in-parens']);
  assert.deepEqual(names('return skip(reason);'), []);
  // Commas inside a nested call, a string, a template or a regular expression separate no arguments.
  assert.deepEqual(names("assert.equal(f(a, 'Task-6: Overview'), 'x', 'Task 12: the gate');"), ['1:plan-task-label']);
  assert.deepEqual(names("assert.equal(f(a, b), 'Task-6: Overview');"), []);
  assert.deepEqual(names("assert.equal([a, b], `Task-6, Overview`, 'Task 12: the gate');"), ['1:plan-task-label']);
  assert.deepEqual(names("assert.match(text, /it's (a), \"b\"/, 'Task 12: the gate');"), ['1:plan-task-label']);
  assert.deepEqual(names("assert.deepEqual(f({ a: 1, b: 'Task 12: x' }), { c: 'Task-6: y' });"), []);
  // The message may continue on a line of its own, and so may the data before it.
  assert.deepEqual(names("assert.strictEqual(rows.length, 0,\n  'the step is not landed (Task 3)');"), ['2:plan-task-in-parens']);
  assert.deepEqual(names("assert.deepEqual(rows,\n  ['Task-6: Overview']);"), []);
  assert.deepEqual(names("assert.equal(app.name,\n  'Task 1 (Plan 2)');"), []);
  assert.deepEqual(names("assert.ok(\n  ok,\n  `Task 12: the verify gate ${n}`,\n);"), ['3:plan-task-label']);
  // A message is one literal. Whatever else is there is code, or a value built at run time, and says nothing to a reader of the source.
  assert.deepEqual(names("assert.ok(ok, 'Task 12: ' + why);"), []);
  assert.deepEqual(names("assert.ok(ok, label('Task 12: the gate'));"), []);
  assert.deepEqual(names("assert.ok(ok, `fine ${'(Task 3)'}`);"), []);
  // A call written in a string, a template, a regular expression or a comment is not one.
  assert.deepEqual(names("const sample = 'assert.ok(ok, \"Task 12: the gate\")';"), []);
  assert.deepEqual(names("const sample = `\nassert.ok(ok, 'Task 12: the gate');\n`;"), []);
  assert.deepEqual(names("const rule = /assert.ok(ok, 'Task 12: the gate')/;"), []);
  assert.deepEqual(names("// assert.ok(ok, 'the step is not landed (Task 3)') was the old check"), ['1:plan-task-in-parens'], 'a comment is prose, whatever it quotes');
  assert.deepEqual(names("// assert.ok(\nok, 'Task 12: the gate');"), [], 'what follows a commented-out call is not its arguments');
  assert.deepEqual(names("foo.assert.ok(ok, 'Task 12: the gate'); myassert(ok, 'Task 12: the gate');"), []);
  // A division is not a regular expression, after a name, a call or an index: the commas around it still separate arguments.
  assert.deepEqual(names("assert.equal(a / 2, b / 2, 'Task 12: the gate');"), ['1:plan-task-label']);
  assert.deepEqual(names("assert.equal(f(a) / 2, g(b) / 2, 'Task 12: the gate');"), ['1:plan-task-label']);
  assert.deepEqual(names("assert.equal(rows[0] / 2, rows[1] / 2, 'Task 12: the gate');"), ['1:plan-task-label']);
  // A comment after the call does not hide its message.
  assert.deepEqual(names("assert.ok(ok, 'the step is not landed (Task 3)'); // why"), ['1:plan-task-in-parens']);
  assert.deepEqual(names("test('Task-6: a title', () => {}); // fine"), ['1:plan-task-label']);
});

test('the reader of messages follows the language: a division is not a regular expression, templates nest, and comments and strings hide what they hold', () => {
  const messages = (text) => [...messageLiterals(text)].map(([line, pieces]) => `${line}:${pieces.join('|')}`);
  assert.deepEqual(messages("assert.ok(a / b > 1 && c / d, 'x / y');"), ['0:x / y'], 'two divisions, and a slash in the message');
  assert.deepEqual(messages("assert.ok(/'/.test(s), 'm');"), ['0:m'], 'a quote inside a regular expression opens no string');
  assert.deepEqual(messages("assert.ok(/[/']+/.test(s), 'm');"), ['0:m'], 'a slash inside a class does not close the regular expression');
  assert.deepEqual(messages("assert.ok(`a ${f(`b ${c}`, 'd, e')} f`.length, 'm');"), ['0:m'], 'a template inside the expression of a template');
  assert.deepEqual(messages('assert.ok(ok, `one\ntwo ${n} three`);'), ['0:one', '1:two  three'], 'a template over two lines is credited to each');
  assert.deepEqual(messages("assert.ok(x, /* why, (really) */ 'm');"), ['0:m'], 'a comment inside the arguments');
  assert.deepEqual(messages("// assert.ok(x, 'm');\nassert.ok(x, 'n');"), ['1:n'], 'a comment holds no call');
  assert.deepEqual(messages("const s = \"assert.ok(x, 'm')\"; assert.ok(x, 'n');"), ['0:n'], 'a string holds no call');
  assert.deepEqual(messages("assert.ok(x, 'it\\'s, fine');"), ["0:it\\'s, fine"], 'an escaped quote');
  assert.deepEqual(messages("assert.ok(x, 'unfinished"), [], 'a call that does not close says nothing');
  assert.deepEqual(messages("assert.ok(x, 'a'); assert.equal(y, 'b'); assert.equal(y, 'c', 'd');"), ['0:a|d']);
});

test('a numbered finding heading, the numbered titles under it and a count of a review\'s findings are flagged; ordinary numbered tests and fixture values are not', () => {
  const names = (file, text) => scanText(file, text).map((hit) => `${hit.line}:${hit.name}`);
  // The shape a file of regression tests can have: a header that counts the defects, a heading per finding, and titles that carry the finding's own number.
  const numbered = [
    '// Regression tests for the six defects an adversarial peer review found in the importer.',
    '// --- Finding 1: a stale cache entry was served -----------------------',
    "test('#1 a stale entry is refreshed before it is served', async () => {});",
    '// --- Finding 2: the retry could be skipped -------------------------',
    "test('#2a a retry after a timeout is not skipped', async () => {});",
    "test('#2b-bis a second retry is not skipped either', async () => {});",
    "test('#6a5 a failed read is reported as unknown', async () => {});",
    "test('#9d a message with a quote is escaped once', () => {});",
    '// --- Further review findings: key escaping, and the two parsers that still disagreed ---',
    "test('an option label of \"__proto__\" resolves to its own value', () => {});",
  ].join('\n');
  assert.deepEqual(names('a.js', numbered), [
    '1:review-finding-count', '2:finding-number', '3:numbered-title-under-finding', '4:finding-number', '5:numbered-title-under-finding',
    '6:numbered-title-under-finding', '7:numbered-title-under-finding', '8:numbered-title-under-finding', '9:review-finding-count',
  ]);
  // The same titles with no finding label in the file are ordinary numbered tests; the context is the heading, not the number.
  assert.deepEqual(names('a.js', ["test('#1 a numbered case', () => {});", "test('#2b-bis another one', () => {});"].join('\n')), []);
  // Under a heading, an issue number is still a pointer a reader can follow, and a title with no number is no ordinal.
  assert.deepEqual(names('a.js', ['// --- Finding 3: a ---', "test('#545: preserves hand-authored page keys', () => {});", "test('keeps the key', () => {});"].join('\n')), ['1:finding-number']);
  // The words are data in a JSON value, an object literal, an expected value and a Markdown code fence, and prose that says "finding" has no number to flag.
  assert.deepEqual(names('f.json', '{ "title": "Finding 1" }'), []);
  assert.deepEqual(names('a.js', "const rows = [{ title: 'Finding 1' }];"), []);
  assert.deepEqual(names('a.js', "assert.equal(label, 'Finding 1');"), []);
  assert.deepEqual(names('a.js', "assert.equal(label, 'x', 'Finding 1: the label');"), ['1:finding-number']);
  assert.deepEqual(names('a.md', ['```js', '// Finding 1: a sample', '```'].join('\n')), []);
  assert.deepEqual(names('a.md', 'Each finding names its table.'), []);
  assert.deepEqual(names('a.md', 'Finding 1 of the report names the table.'), ['1:finding-number']);
  assert.deepEqual(names('a.js', '// this is finding 3 from the report'), ['1:finding-number'], 'a lower-case label is a label');
  // A test title is the title literal of a test call; a line of prose that happens to start with a number under a heading is not one.
  assert.deepEqual(names('a.md', ['Finding 3: a heading', '#2 an item of a list'].join('\n')), ['1:finding-number']);
  assert.deepEqual(names('a.js', ['// Finding 3: a heading', "const label = '#2 a label';", "log('#2 a message');"].join('\n')), ['1:finding-number']);
});

test('a schema-valid fixture whose names read like pointers is data, whatever it is called', () => {
  // The app, a table and a page are named with the words a pointer is made of, the app's even in the parentheses a pointer is written in. The spec is
  // valid (so a fixture like it is a legitimate thing to commit), and the guard reads none of it as a review reference.
  const spec = {
    schemaVersion: 2,
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Task 1 (Plan 2)', description: 'Contract Addendum - Plan 2 of the offsite' },
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
