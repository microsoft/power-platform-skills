'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeGenpageCli, parsePageId, parseList, quoteArg, buildPacInvocation, classifyListOutput, parseListCount } = require('../lib/genpage-cli.js');

const GUID = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';

// REAL `pac model genpage list` output — a fixed-width TABLE (header + GUID/Name/Published rows), captured
// LIVE from env aurorabapenv03468 (2026-07). Columns auto-size to the longest name. `listText` reproduces
// that exact shape; `countOverride` lets a test set the "Found N" summary independently of the rows (to
// exercise the count-mismatch fail-closed path). NOTE (live): pac lists only SITEMAP-reachable pages.
function listText(rows, countOverride) {
  const count = countOverride == null ? rows.length : countOverride;
  const nameW = Math.max(4, ...rows.map((r) => String(r.name || '').length));
  const header = 'Page ID'.padEnd(37) + 'Name'.padEnd(nameW + 1) + 'Published';
  const body = rows.map((r) => `${r.pageId} ${String(r.name || '').padEnd(nameW)} ${r.published || '-'}`).join('\n');
  return `Connected as tester@contoso.com\nRetrieving generated pages...\nFound ${count} generated page(s):\n\n${header}\n${body}\n`;
}
// Empty app: the summary with count 0 and no rows (live-confirmed "Found 0 generated page(s):"; any
// unmatched zero-exit output is safely fail-closed 'unrecognized', never 'empty').
const LIST_ONE = listText([{ pageId: GUID, name: 'Overview' }]);
const LIST_EMPTY = 'Connected as tester@contoso.com\nRetrieving generated pages...\nFound 0 generated page(s):\n';

test('quoteArg quotes args with spaces/specials, leaves plain args', () => {
  assert.strictEqual(quoteArg('Overview'), 'Overview');
  assert.strictEqual(quoteArg('A responsive cards overview'), '"A responsive cards overview"');
  assert.strictEqual(quoteArg('has"quote'), '"has""quote"');
  assert.strictEqual(quoteArg('https://x'), 'https://x');
});

test('quoteArg collapses newlines to spaces (a multi-line prompt must not break the command line)', () => {
  assert.strictEqual(quoteArg('Conversation with 2 prompts:\r\n1. A\r\n2. B'), '"Conversation with 2 prompts: 1. A 2. B"');
  assert.strictEqual(quoteArg('line1\nline2'), '"line1 line2"');
  assert.ok(!quoteArg('a\r\nb').includes('\n'), 'no raw newline survives into the command line');
});

test('buildPacInvocation (win32) builds a shell command line with cmd-style quoting', () => {
  const inv = buildPacInvocation(['model', 'genpage', 'upload', '--prompt', 'a "quote"'], 'win32');
  assert.strictEqual(inv.options.shell, true);
  assert.strictEqual(inv.args, undefined);
  assert.ok(inv.command.startsWith('pac '));
  assert.ok(inv.command.includes('"a ""quote"""'), 'embedded quotes are cmd-escaped by doubling');
});

test('buildPacInvocation (posix) spawns pac directly with an args array and no shell', () => {
  const inv = buildPacInvocation(['model', 'genpage', 'upload', '--prompt', 'a "quote" & more'], 'linux');
  assert.strictEqual(inv.command, 'pac');
  assert.strictEqual(inv.options.shell, undefined, 'no shell on POSIX so metacharacters round-trip verbatim');
  assert.deepStrictEqual(inv.args, ['model', 'genpage', 'upload', '--prompt', 'a "quote" & more']);
});

test('buildPacInvocation collapses embedded newlines in args (both platforms)', () => {
  const posix = buildPacInvocation(['--prompt', 'l1\r\nl2\nl3'], 'linux');
  assert.deepStrictEqual(posix.args, ['--prompt', 'l1 l2 l3'], 'multi-line prompt collapsed to spaces');
  const win = buildPacInvocation(['--prompt', 'l1\r\nl2'], 'win32');
  assert.ok(!win.command.includes('\n'), 'no raw newline survives into the Windows command line');
});

test('parsePageId extracts the guid from upload output', () => {
  assert.strictEqual(parsePageId(`Successfully pushed page. Page ID: ${GUID}\n`), GUID);
  assert.strictEqual(parsePageId('no id here'), null);
});

test('parseList parses the fixed-width GUID/Name/Published table (a spaced name is not split)', () => {
  const out = listText([{ pageId: GUID, name: 'Overview' }, { pageId: '11111111-2222-3333-4444-555555555555', name: 'Order Detail' }]);
  const pages = parseList(out);
  assert.strictEqual(pages.length, 2);
  assert.deepStrictEqual(pages[0], { pageId: GUID, name: 'Overview' });
  assert.strictEqual(pages[1].name, 'Order Detail'); // a name containing a space stays intact
});

test('upload builds pac args WITHOUT --add-to-sitemap and returns the pageId', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; };
  const cli = makeGenpageCli('https://x', { run });
  const r = await cli.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', dataSources: ['new_o'] });
  assert.strictEqual(r.pageId, GUID);
  const args = calls[0];
  assert.ok(!args.includes('--add-to-sitemap'), 'never adds to sitemap (the SDK owns it)');
  assert.ok(args.includes('--prompt') && args.includes('--agent-message'), 'always supplies pac-required prompt + agent-message');
  assert.ok(args.includes('--data-sources') && args.includes('new_o'));
  assert.ok(args.includes('--environment') && args.includes('https://x'));
});

test('upload defaults prompt + agent-message when absent (pac requires both)', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; };
  await makeGenpageCli('https://x', { run }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'X' });
  assert.ok(calls[0].includes('--prompt') && calls[0].includes('--agent-message'));
});

test('upload with a pageId updates in place (adds --page-id)', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; };
  // Use GUID as the pageId so the I7 guard (returned id must equal pid) does not fire.
  await makeGenpageCli('https://x', { run }).upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' });
  assert.ok(calls[0].includes('--page-id') && calls[0].includes(GUID));
});

test('upload retries a transient pac failure then succeeds', async () => {
  let n = 0;
  const run = async () => { n += 1; return n === 1 ? { status: 1, stdout: '', stderr: 'flaky help dump' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; };
  // Use GUID as pageId (UPDATE path): no CREATE reconcile, I7 guard matches returned GUID.
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.ok(n >= 2, 'retried after the transient failure');
});

// Updated per plan Task 4: list mock now provides a COMPLETE listing ("Found N" summary) so
// classifyListOutput recognises it; behavior unchanged — adopt the matched page as an UPDATE.
test('upload converts a failed CREATE to an UPDATE on retry (resolve by name, no duplicate)', async () => {
  const uploadArgs = [];
  let up = 0;
  const run = async (args) => {
    if (args[2] === 'list') return { status: 0, stdout: listText([{ pageId: GUID, name: 'Overview' }]), stderr: '' };
    up += 1; uploadArgs.push(args);
    return up === 1 ? { status: 1, stdout: '', stderr: 'flaky' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.ok(!uploadArgs[0].includes('--page-id'), 'first attempt was a create (no page-id)');
  assert.ok(uploadArgs[1].includes('--page-id') && uploadArgs[1].includes(GUID), 'retry updates in place via the resolved page id (never duplicates)');
});

// Updated per plan Task 4: a persistent pac CREATE failure where enumeration ALSO fails is now
// FAIL-CLOSED — the first uncertain CREATE + failed enumeration THROWS immediately (no blind retries).
test('upload is fail-closed when a CREATE is uncertain and enumeration cannot run (no blind retry)', async () => {
  let creates = 0;
  const run = async (args) => { if (args[2] === 'list') return { status: 1, stdout: '', stderr: '' }; creates += 1; return { status: 1, stdout: '', stderr: 'boom' }; };
  await assert.rejects(makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'X' }), /uncertain result and page enumeration failed|refusing to retry/i);
  assert.strictEqual(creates, 1, 'exactly one create attempt — never a blind duplicate on an unverifiable failure');
});

test('list returns [] when pac fails', async () => {
  const run = async () => ({ status: 1, stdout: '', stderr: 'boom' });
  assert.deepStrictEqual(await makeGenpageCli('https://x', { run }).list({ appId: 'a' }), []);
});

// ── Task 4: parseListCount ────────────────────────────────────────────────────────────────────────

test('parseListCount reads the summary "Found N generated page(s)" count (else null)', () => {
  assert.strictEqual(parseListCount(LIST_ONE), 1);
  assert.strictEqual(parseListCount(LIST_EMPTY), 0);
  assert.strictEqual(parseListCount('  Overview\n    Page ID: abc'), null);
  assert.strictEqual(parseListCount(''), null);
  assert.strictEqual(parseListCount('Found 3 generated page(s):'), 3);
});

// ── Task 4: classifyListOutput (tri-state, COMPLETE-listing, I2) ──────────────────────────────────

test('classifyListOutput: pages / empty / unrecognized (tri-state, COMPLETE-listing, I2)', () => {
  // recognized-pages: count matches parsed pages, all have names
  assert.strictEqual(classifyListOutput(LIST_ONE).kind, 'pages');
  assert.deepStrictEqual(classifyListOutput(LIST_ONE).pages, [{ pageId: GUID, name: 'Overview' }]);
  // recognized-empty: explicit "Found 0" marker
  assert.strictEqual(classifyListOutput(LIST_EMPTY).kind, 'empty');
  assert.deepStrictEqual(classifyListOutput(LIST_EMPTY).pages, []);
  // recognized-empty: "no pages" phrase variant (observed in older pac builds)
  assert.strictEqual(classifyListOutput('No generated pages found.\n').kind, 'empty');
  // unrecognized: blank output (not proof of empty — could be a timeout or help-dump with no banner)
  assert.strictEqual(classifyListOutput('').kind, 'unrecognized');
  // unrecognized: help/usage banner (pac dumps usage on a flag error but exits 0 on some builds)
  assert.strictEqual(classifyListOutput('pac model genpage list\nUsage: pac model genpage ...\n').kind, 'unrecognized');
  // unrecognized: count mismatch — summary says 3 but only 1 row parsed → truncated listing
  assert.strictEqual(classifyListOutput(listText([{ pageId: GUID, name: 'Overview' }], 3)).kind, 'unrecognized');
  // unrecognized: an UNNAMED row (a GUID with a blank Name column) — fail-closed, would else reconcile
  // blindly against an unknown page
  assert.strictEqual(classifyListOutput(listText([{ pageId: GUID, name: '' }])).kind, 'unrecognized');
});

// REGRESSION (whole-branch review, Critical fail-OPEN): the "no pages" phrase is tested against the WHOLE
// stdout (names + descriptions), so a page NAMED or DESCRIBED with "no page(s)" text must NOT force an app
// WITH live pages to classify as EMPTY. A false 'empty' → reconcile sees zero live → duplicate CREATE on
// build + silent page-drop on download. Empty requires NO positive page evidence.
test('classifyListOutput: a page NAMED "no pages" does NOT force empty when real pages are listed', () => {
  // A page literally named "No Pages" with a valid 1-page summary → 'pages', not 'empty'. The "no pages"
  // phrase is tested against the whole stdout (which includes page NAMES), so it must not fire here.
  const namedNoPages = listText([{ pageId: GUID, name: 'No Pages' }]);
  assert.strictEqual(classifyListOutput(namedNoPages).kind, 'pages');
  assert.deepStrictEqual(classifyListOutput(namedNoPages).pages, [{ pageId: GUID, name: 'No Pages' }]);
  // A 2-page listing where one page is named "No Pages" → 'pages' (both rows parsed, count matches).
  const OTHER = '11111111-2222-3333-4444-555555555555';
  const twoWithNoPages = listText([{ pageId: GUID, name: 'Overview' }, { pageId: OTHER, name: 'No Pages' }]);
  assert.strictEqual(classifyListOutput(twoWithNoPages).kind, 'pages');
  assert.strictEqual(classifyListOutput(twoWithNoPages).pages.length, 2);
  // enumerate must therefore report ok:true with the pages, NOT empty (the fail-OPEN blast radius).
  return makeGenpageCli('env', { run: async () => ({ status: 0, stdout: namedNoPages, stderr: '' }), sleep: async () => {} })
    .enumerate({ appId: 'a' })
    .then((r) => { assert.strictEqual(r.ok, true); assert.ok(!r.empty, 'a page named "No Pages" is NOT an empty app'); assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'No Pages' }]); });
});

// ── Task 4: enumerate (fail-closed, tri-state, retrying) ─────────────────────────────────────────

test('enumerate returns { ok:true, pages } on a COMPLETE zero-exit list (no retry on success)', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return { status: 0, stdout: LIST_ONE, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'Overview' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(n, 1, 'no retry needed when first response is a complete listing');
});

test('enumerate returns { ok:true, pages:[], empty:true } for an app that genuinely has no pages', async () => {
  const cli = makeGenpageCli('env', { run: async () => ({ status: 0, stdout: LIST_EMPTY, stderr: '' }), sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empty, true);
  assert.deepStrictEqual(r.pages, []);
});

test('enumerate is fail-closed on a zero-exit UNRECOGNIZED / INCOMPLETE listing (blank/help/count-mismatch) — NOT empty (I2)', async () => {
  // count-mismatch: summary says 2 but only 1 Page ID parsed — could be a truncated/partial listing
  const cli = makeGenpageCli('env', { run: async () => ({ status: 0, stdout: listText([{ pageId: GUID, name: 'Overview' }], 2), stderr: '' }), sleep: async () => {}, attempts: 2 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.pages, []);
  assert.match(r.error, /unrecognized|incomplete/i);
});

test('enumerate is fail-closed on a persistent non-zero exit, after retrying', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return { status: 1, stdout: '', stderr: 'auth expired' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /after 3 attempt\(s\)/);
  assert.strictEqual(n, 3, 'retried the configured number of times before giving up');
});

test('enumerate recovers on a later attempt (transient flake)', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return n < 2 ? { status: 1, stdout: '', stderr: 'flake' } : { status: 0, stdout: LIST_ONE, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'Overview' }]);
  assert.strictEqual(n, 2, 'recovered on the second attempt');
});

// ── Task 4: upload uncertain-CREATE fail-closed retry (C3) ───────────────────────────────────────

test('upload: a possibly-successful CREATE + a failing enumeration NEVER issues a 2nd CREATE (C3)', async () => {
  let creates = 0;
  let lists = 0;
  const run = async (args) => {
    if (args.includes('upload')) { creates += 1; return { status: 0, stdout: 'done, no id here', stderr: '' }; } // zero-exit, NO Page ID → uncertain
    lists += 1; return { status: 1, stdout: '', stderr: 'list failed' }; // enumeration fails
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  await assert.rejects(cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' }), /uncertain result and page enumeration failed|refusing to retry/i);
  assert.strictEqual(creates, 1, 'exactly ONE create attempt — no blind duplicate');
  assert.ok(lists >= 1, 'it did try to enumerate before deciding');
});

test('upload: an uncertain CREATE adopts the one same-named live page and UPDATES it (no duplicate)', async () => {
  let creates = 0, updates = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      if (args.includes('--page-id')) { updates += 1; return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }
      creates += 1; return { status: 0, stdout: 'no id', stderr: '' }; // uncertain create
    }
    return { status: 0, stdout: LIST_ONE, stderr: '' }; // enumeration: the create DID land as "Overview"
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  const r = await cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.strictEqual(creates, 1, 'one create attempt');
  assert.strictEqual(updates, 1, 'retry UPDATED the adopted page in place — no second create');
});

test('upload: an uncertain CREATE whose enumeration shows ZERO matches safely retries the CREATE', async () => {
  let creates = 0;
  const run = async (args) => {
    if (args.includes('upload')) { creates += 1; return creates === 1 ? { status: 0, stdout: 'no id', stderr: '' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }
    return { status: 0, stdout: LIST_EMPTY, stderr: '' }; // enumeration proves the create did NOT land
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  const r = await cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.strictEqual(creates, 2, 'zero live matches → the retry re-issues a CREATE (not a duplicate — none existed)');
});

// ── Task 4: I7 upload-id guard (UPDATE returned id must equal pid) ───────────────────────────────

test('upload (I7): direct UPDATE with caller-provided pageId returns wrong Page ID → throws', async () => {
  const WRONG_ID = 'aaaaaaaa-0000-0000-0000-000000000000';
  const run = async () => ({ status: 0, stdout: `Page ID: ${WRONG_ID}`, stderr: '' });
  const cli = makeGenpageCli('env', { run, sleep: async () => {} });
  // pageId: GUID but pac returns WRONG_ID → mismatch must halt
  await assert.rejects(
    cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'x.tsx', name: 'Overview' }),
    /unexpected Page ID|mismatched/i
  );
});

test('upload (I7): uncertain-CREATE adopts pid then UPDATE returns wrong Page ID → throws', async () => {
  // CREATE returns no id (uncertain) → enumerate finds "Overview" → adopt GUID as pid →
  // UPDATE with pid=GUID but pac returns WRONG_ID → I7 must halt (internally-adopted pid guard).
  const WRONG_ID = 'aaaaaaaa-0000-0000-0000-000000000000';
  const run = async (args) => {
    if (args.includes('upload')) {
      if (args.includes('--page-id')) return { status: 0, stdout: `Page ID: ${WRONG_ID}`, stderr: '' }; // UPDATE returns wrong id
      return { status: 0, stdout: 'no id', stderr: '' }; // CREATE uncertain
    }
    return { status: 0, stdout: LIST_ONE, stderr: '' }; // enumerate: "Overview" = GUID found
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {} });
  await assert.rejects(
    cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' }),
    /unexpected Page ID|mismatched/i
  );
});
