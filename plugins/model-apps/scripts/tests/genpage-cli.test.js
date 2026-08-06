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

// Real GUIDs for env-wide enumeration tests (C2 / addenda cross-cutting note Imp9).
const GP_A = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_B = '5c0a4889-45fd-46ea-91a8-ff876914d644';
// Build a real fixed-width `pac model genpage list` table for env-wide enumerateEnv mocks.
// Column widths auto-size to the longest name (same as listText above); this helper uses a fixed
// 16-char name column wide enough for "Order Detail" so tests don't need to compute widths.
function envList(rows) {
  const nameW = 16;
  const header = `${'Page ID'.padEnd(37)}${'Name'.padEnd(nameW + 1)}Published`;
  const body = rows.map((r) => `${r.pageId} ${String(r.name || '').padEnd(nameW)} -`).join('\n');
  const count = rows.length;
  return `Connected as user@contoso.com\nRetrieving generated pages...\nFound ${count} generated page(s):\n\n${header}\n${body}\n`;
}

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

test('quoteArg caret-escapes % so cmd.exe does not expand %VAR% inside the quoted arg (Windows)', () => {
  // cmd.exe expands %VAR% even inside double quotes; breaking out of the quotes and caret-escaping each
  // % (verified to round-trip literally through cmd.exe) keeps prompts/names with env-var syntax intact.
  assert.strictEqual(quoteArg('plain%PATH%end'), '"plain"^%"PATH"^%"end"');
  assert.ok(quoteArg('50% off').includes('"^%"'), 'a bare % triggers quoting + escaping');
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
  const run = async (args) => {
    calls.push(args);
    // before-snapshot call: return an empty-env listing so enumerateEnv succeeds
    if (args[2] === 'list') return { status: 0, stdout: LIST_EMPTY, stderr: '' };
    return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const cli = makeGenpageCli('https://x', { run, sleep: async () => {} });
  const r = await cli.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', dataSources: ['new_o'] });
  assert.strictEqual(r.pageId, GUID);
  // The upload call is NOT calls[0] any more (before-snapshot is first); find by verb.
  const args = calls.find((a) => a[2] === 'upload');
  assert.ok(!args.includes('--add-to-sitemap'), 'never adds to sitemap (the SDK owns it)');
  assert.ok(args.includes('--prompt') && args.includes('--agent-message'), 'always supplies pac-required prompt + agent-message');
  assert.ok(args.includes('--data-sources') && args.includes('new_o'));
  assert.ok(args.includes('--environment') && args.includes('https://x'));
});

test('upload defaults prompt + agent-message when absent (pac requires both)', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[2] === 'list') return { status: 0, stdout: LIST_EMPTY, stderr: '' };
    return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  await makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'X' });
  const uploadCall = calls.find((a) => a[2] === 'upload');
  assert.ok(uploadCall.includes('--prompt') && uploadCall.includes('--agent-message'));
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

// Updated for Plan 5 (C2): recovery now uses a strict env-wide before/after id diff (no name matching).
// The mock returns an empty env BEFORE the first CREATE and a page-present env AFTER so the diff finds
// exactly one new id, which is adopted — the second attempt is an UPDATE (not another CREATE).
test('upload converts a failed CREATE to an UPDATE on retry (env-id-diff recovery, no duplicate)', async () => {
  const uploadArgs = [];
  let up = 0;
  let listN = 0;
  const run = async (args) => {
    if (args[2] === 'list') {
      listN++;
      // before-snapshot (listN=1): env is empty; after-snapshot (listN=2): GUID appeared
      return { status: 0, stdout: listN === 1 ? LIST_EMPTY : listText([{ pageId: GUID, name: 'Overview' }]), stderr: '' };
    }
    up += 1; uploadArgs.push(args);
    return up === 1 ? { status: 1, stdout: '', stderr: 'flaky' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.ok(!uploadArgs[0].includes('--page-id'), 'first attempt was a create (no page-id)');
  assert.ok(uploadArgs[1].includes('--page-id') && uploadArgs[1].includes(GUID), 'retry updates in place via the env-diff adopted id (never duplicates)');
});

// Updated for Plan 5 (C2): the BEFORE-snapshot is taken PRIOR to issuing any CREATE; if it fails,
// we HALT immediately — no CREATE is ever issued, so there is nothing to accidentally duplicate.
test('upload is fail-closed when a CREATE is uncertain and enumeration cannot run (no blind retry)', async () => {
  let creates = 0;
  const run = async (args) => { if (args[2] === 'list') return { status: 1, stdout: '', stderr: '' }; creates += 1; return { status: 1, stdout: '', stderr: 'boom' }; };
  await assert.rejects(makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'X' }), /cannot snapshot|refusing to (create|retry)/i);
  assert.strictEqual(creates, 0, 'no create issued — halted at before-env-snapshot (never risks a duplicate)');
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

// Updated for Plan 5 (C2): with the strict before/after diff, the BEFORE-snapshot is taken prior to
// any CREATE. If enumeration is broken, we HALT before issuing the CREATE — creates === 0.
test('upload: a possibly-successful CREATE + a failing enumeration NEVER issues a 2nd CREATE (C3)', async () => {
  let creates = 0;
  let lists = 0;
  const run = async (args) => {
    if (args.includes('upload')) { creates += 1; return { status: 0, stdout: 'done, no id here', stderr: '' }; }
    lists += 1; return { status: 1, stdout: '', stderr: 'list failed' };
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  await assert.rejects(cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' }), /cannot snapshot|refusing to (create|retry)/i);
  assert.strictEqual(creates, 0, 'zero creates — halted at before-env-snapshot, never risks a duplicate');
  assert.ok(lists >= 1, 'it tried to enumerate before deciding');
});

// Updated for Plan 5 (C2): adopt by strict env-id diff (before=empty, after=GUID appeared), not name.
test('upload: an uncertain CREATE adopts the one new env id and UPDATES it (no duplicate)', async () => {
  let creates = 0, updates = 0;
  let listN = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      if (args.includes('--page-id')) { updates += 1; return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }
      creates += 1; return { status: 0, stdout: 'no id', stderr: '' }; // uncertain create
    }
    listN++;
    // before-snapshot (listN=1): env empty; after-snapshot (listN=2): GUID appeared
    return { status: 0, stdout: listN === 1 ? LIST_EMPTY : LIST_ONE, stderr: '' };
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  const r = await cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.strictEqual(creates, 1, 'one create attempt');
  assert.strictEqual(updates, 1, 'retry UPDATED the adopted env-diff id in place — no second create');
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

// Updated for Plan 5 (C2): adoption is now by strict env-id diff. Before=empty, after=GUID → adopt
// GUID → UPDATE returns WRONG_ID → I7 guard fires (adopted id != returned id → refuse to persist).
test('upload (I7): uncertain-CREATE adopts env id then UPDATE returns wrong Page ID → throws', async () => {
  const WRONG_ID = 'aaaaaaaa-0000-0000-0000-000000000000';
  let listN = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      if (args.includes('--page-id')) return { status: 0, stdout: `Page ID: ${WRONG_ID}`, stderr: '' }; // UPDATE returns wrong id
      return { status: 0, stdout: 'no id', stderr: '' }; // CREATE uncertain
    }
    listN++;
    // before-snapshot (listN=1): empty; after-snapshot (listN=2): GUID appeared → adopt GUID
    return { status: 0, stdout: listN === 1 ? LIST_EMPTY : LIST_ONE, stderr: '' };
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {} });
  await assert.rejects(
    cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' }),
    /unexpected Page ID|mismatched/i
  );
});

// ── Task 2: enumerateEnv (env-wide EXISTENCE authority) ──────────────────────────────────────────

test('enumerateEnv runs env-wide (no --app-id, with --include-unpublished) and returns lower-cased ids + pages', async () => {
  let seen;
  const run = async (args) => {
    seen = args;
    return { status: 0, stdout: envList([{ pageId: GP_A, name: 'Overview' }, { pageId: GP_B, name: 'Order Detail' }]), stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).enumerateEnv();
  assert.ok(!seen.includes('--app-id'), 'env-wide: no --app-id');
  assert.ok(seen.includes('--include-unpublished'), 'drafts included so a just-created page counts (C1)');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ids, [GP_A, GP_B]); // GP_A/GP_B are already lower-case GUIDs
  assert.strictEqual(r.pages.length, 2);
  assert.deepStrictEqual(r.pages[0], { pageId: GP_A, name: 'Overview' });
});

test('enumerateEnv returns { ok:true, ids:[], pages:[] } for an empty environment ("Found 0")', async () => {
  const run = async () => ({ status: 0, stdout: LIST_EMPTY, stderr: '' });
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).enumerateEnv();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ids, []);
  assert.deepStrictEqual(r.pages, []);
});

test('enumerateEnv is FAIL-CLOSED on an unrecognized/incomplete listing (never masquerades as empty)', async () => {
  // summary says 2 but only 1 row parsed → classifyListOutput 'unrecognized' → ok:false
  const bad = envList([{ pageId: GP_A, name: 'Overview' }]).replace('Found 1', 'Found 2');
  const run = async () => ({ status: 0, stdout: bad, stderr: '' });
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 2 }).enumerateEnv();
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.ids, []);
  assert.match(r.error, /unrecognized|incomplete|after 2 attempt/i);
});

test('enumerateEnv is FAIL-CLOSED on a non-zero exit, returns ok:false after retries', async () => {
  let n = 0;
  const run = async () => { n++; return { status: 1, stdout: '', stderr: 'auth expired' }; };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 2 }).enumerateEnv();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /after 2 attempt/i);
  assert.strictEqual(n, 2);
});

// ── Task 2: uncertain-CREATE strict env-id diff (C2 / addenda) ───────────────────────────────────

test('upload uncertain-CREATE: strict env-id diff finds ONE new id → adopt and UPDATE (C2)', async () => {
  let uploadCalls = 0;
  let listN = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      uploadCalls++;
      // First call is the uncertain CREATE (returns no id); second is the UPDATE after adoption
      if (uploadCalls === 1) return { status: 0, stdout: 'created, no id returned', stderr: '' };
      return { status: 0, stdout: `Page ID: ${GP_A}`, stderr: '' };
    }
    listN++;
    if (listN === 1) return { status: 0, stdout: envList([]), stderr: '' };                 // before: empty
    return { status: 0, stdout: envList([{ pageId: GP_A, name: 'Overview' }]), stderr: '' }; // after: GP_A appeared
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 3 })
    .upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' });
  assert.strictEqual(r.pageId, GP_A, 'adopted the single new env id (== the env-diff result)');
  assert.strictEqual(uploadCalls, 2, 'first CREATE (uncertain) + one UPDATE (adopted id) — never a blind 2nd CREATE');
});

test('upload uncertain-CREATE: newIds>1 → throws (ambiguous — cannot attribute) (C2)', async () => {
  let listN = 0;
  const run = async (args) => {
    if (args.includes('upload')) return { status: 0, stdout: 'no id', stderr: '' };
    listN++;
    if (listN === 1) return { status: 0, stdout: envList([]), stderr: '' };
    // after: TWO new pages appeared — cannot tell which one is ours
    return { status: 0, stdout: envList([{ pageId: GP_A, name: 'Page A' }, { pageId: GP_B, name: 'Page B' }]), stderr: '' };
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 3 })
      .upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' }),
    /ambiguous|cannot attribute/i
  );
});

test('upload uncertain-CREATE: newIds===0 (create did not land) → retries CREATE, then succeeds (C2)', async () => {
  let uploadCalls = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      uploadCalls++;
      // First two attempts return no id (page not yet visible); third succeeds
      if (uploadCalls < 3) return { status: 0, stdout: 'no id', stderr: '' };
      return { status: 0, stdout: `Page ID: ${GP_A}`, stderr: '' };
    }
    // env always empty → newIds===0 on each after-snapshot → proved not-landed → safe retry
    return { status: 0, stdout: envList([]), stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 3 })
    .upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' });
  assert.strictEqual(r.pageId, GP_A);
  assert.strictEqual(uploadCalls, 3, 'two proved-not-landed CREATEs + one successful CREATE');
});

test('upload uncertain-CREATE: enumerateEnv failure BEFORE CREATE → throws (fail-closed, no CREATE issued)', async () => {
  let uploadCalls = 0;
  const run = async (args) => {
    if (args.includes('upload')) { uploadCalls++; return { status: 0, stdout: `Page ID: ${GP_A}`, stderr: '' }; }
    return { status: 1, stdout: '', stderr: 'env-list failed' }; // before-snapshot always fails
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 2 })
      .upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' }),
    /cannot snapshot|refusing to (create|retry)/i
  );
  assert.strictEqual(uploadCalls, 0, 'no CREATE issued — halted at before-snapshot');
});

test('upload uncertain-CREATE: enumerateEnv failure DURING recovery (after-snapshot) → throws (fail-closed) (C2)', async () => {
  let listN = 0;
  const run = async (args) => {
    if (args.includes('upload')) return { status: 0, stdout: 'no id', stderr: '' }; // uncertain CREATE
    listN++;
    if (listN === 1) return { status: 0, stdout: envList([]), stderr: '' }; // before-snapshot succeeds
    return { status: 1, stdout: '', stderr: 'list failed' }; // after-snapshot fails → THROW
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 2 })
      .upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' }),
    /refusing to (retry|create)|enumeration failed/i
  );
});

// ── Task 2: download --page-id (by-id pull for sitemap membership) ───────────────────────────────

test('download passes --page-id <comma-joined> when pageIds provided; omits it otherwise (back-compat)', async () => {
  const downloadCalls = [];
  const run = async (args) => { if (args[2] === 'download') downloadCalls.push(args); return { status: 0, stdout: '', stderr: '' }; };
  const cli = makeGenpageCli('https://x', { run, sleep: async () => {} });

  await cli.download({ appId: 'a', outputDir: 'o', pageIds: [GP_A, GP_B] });
  await cli.download({ appId: 'a', outputDir: 'o' }); // no pageIds → all-pages

  const withIds = downloadCalls[0];
  const withoutIds = downloadCalls[1];
  const i = withIds.indexOf('--page-id');
  assert.ok(i > 0 && withIds[i + 1] === `${GP_A},${GP_B}`, 'ids comma-joined as a single --page-id arg');
  assert.ok(!withoutIds.includes('--page-id'), 'no --page-id when pageIds absent (all-pages back-compat)');
});

test('download passes --page-id for a single id (no trailing comma)', async () => {
  let seen;
  const run = async (args) => { if (args[2] === 'download') seen = args; return { status: 0, stdout: '', stderr: '' }; };
  await makeGenpageCli('https://x', { run, sleep: async () => {} }).download({ appId: 'a', outputDir: 'o', pageIds: [GP_A] });
  const i = seen.indexOf('--page-id');
  assert.ok(i > 0 && seen[i + 1] === GP_A, 'single id, no trailing comma');
});
