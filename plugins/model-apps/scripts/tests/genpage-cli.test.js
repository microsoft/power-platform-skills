'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeGenpageCli, parsePageId, parseList, quoteArg, buildPacInvocation, classifyListOutput, parseListCount } = require('../lib/genpage-cli.js');

const GUID = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';
const scratchDirs = [];
test.after(() => { for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true }); });

// REAL `pac model genpage list` output — a fixed-width TABLE (header + GUID/Name/Published rows), captured
// LIVE from a Dataverse test environment (2026-07). Columns auto-size to the longest name. `listText` reproduces
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

test('quoteArg doubles a backslash run before a percent escape quote', () => {
  assert.strictEqual(quoteArg('a\\%b'), '"' + 'a' + '\\\\' + '"^%"' + 'b' + '"');
  assert.strictEqual(quoteArg('D:\\data\\%PATH%\\x'), '"' + 'D:\\data' + '\\\\' + '"^%"' + 'PATH' + '"^%"' + '\\x' + '"');
});

test('quoteArg doubles a backslash run before an interior quote', () => {
  assert.strictEqual(quoteArg('qa slash\\"quote'), '"' + 'qa slash' + '\\\\' + '""' + 'quote' + '"');
  assert.strictEqual(quoteArg(String.raw`a\\\\"b`), '"' + 'a' + '\\\\'.repeat(4) + '""' + 'b' + '"');
});

test('quoteArg round-trips through a real Windows shell parse', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.genpage-cli-roundtrip-'));
  scratchDirs.push(dir);
  const script = path.join(dir, 'argv.js');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
  for (const value of [
    'qa slash\\"quote',
    'qa "Quoted" 東京 %PATH%',
    'D:\\space path\\\\',
    String.raw`a\\\\"b`,
    'a\\%b',
    'D:\\data\\%PATH%\\x',
    '50\\%',
    '\\\\%',
    'a\\\"%b',
    'Overview',
  ]) {
    const command = 'node ' + quoteArg(script) + ' ' + quoteArg(value) + ' after';
    const r = spawnSync(command, { shell: true, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    assert.deepStrictEqual(JSON.parse(r.stdout), [value, 'after'], `round-trip failed for ${JSON.stringify(value)} via ${command}`);
  }
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
  assert.ok(args.includes('--prompt-file') && args.includes('--agent-message-file'), 'supplies pac-required prompt + agent-message BY FILE (multi-line safe)');
  assert.ok(!args.includes('--prompt') && !args.includes('--agent-message'), 'never inline --prompt/--agent-message (they would be lossily newline-collapsed)');
  assert.ok(args.includes('--data-sources') && args.includes('new_o'));
  assert.ok(args.includes('--environment') && args.includes('https://x'));
});

test('upload defaults prompt + agent-message when absent (pac requires both), delivered by file', async () => {
  const fs = require('node:fs');
  const calls = [];
  let promptText = null;
  let agentText = null;
  const run = async (args) => {
    calls.push(args);
    if (args[2] === 'list') return { status: 0, stdout: LIST_EMPTY, stderr: '' };
    // Read the temp files back while upload() still owns them (before its finally cleans up).
    const pi = args.indexOf('--prompt-file');
    const ai = args.indexOf('--agent-message-file');
    promptText = fs.readFileSync(args[pi + 1], 'utf8');
    agentText = fs.readFileSync(args[ai + 1], 'utf8');
    return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  await makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'X' });
  const uploadCall = calls.find((a) => a[2] === 'upload');
  assert.ok(uploadCall.includes('--prompt-file') && uploadCall.includes('--agent-message-file'));
  assert.ok(!uploadCall.includes('--prompt') && !uploadCall.includes('--agent-message'), 'defaults go by file too, never inline');
  assert.strictEqual(promptText, 'Generative page X', 'historical default prompt preserved, just delivered by file');
  assert.strictEqual(agentText, 'Authored by app-builder', 'historical default agent-message preserved, just delivered by file');
});

test('upload delivers the prompt via --prompt-file and a multi-line transcript round-trips verbatim (#565)', async () => {
  const fs = require('node:fs');
  // A real downloaded page prompt: a multi-line conversation transcript carrying BOTH \r\n and \n
  // breaks plus non-ASCII — exactly the shape the old inline --prompt path collapsed to spaces on an
  // edit-rebuild (`pac model genpage upload --help` documents --prompt-file for precisely this).
  const multiline = 'Conversation with 2 prompts:\r\n1. Show an overview \u2014 caf\u00e9 \u2615\n2. Add a bar chart';
  let promptFilePath = null;
  let roundTripped = null;
  const run = async (args) => {
    if (args[2] === 'list') return { status: 0, stdout: LIST_EMPTY, stderr: '' };
    assert.ok(!args.includes('--prompt'), 'prompt is never passed inline (that path is lossy for newlines)');
    const i = args.indexOf('--prompt-file');
    assert.ok(i >= 0, 'prompt is delivered via --prompt-file');
    promptFilePath = args[i + 1];
    // Read the file back while upload() still owns it (before the finally cleans it up).
    roundTripped = fs.readFileSync(promptFilePath, 'utf8');
    return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} })
    .upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview', prompt: multiline });
  assert.strictEqual(r.pageId, GUID);
  assert.strictEqual(roundTripped, multiline, 'every \\r\\n and \\n line break and the non-ASCII survive byte-for-byte');
  assert.ok(promptFilePath && !fs.existsSync(promptFilePath), 'the prompt temp file is cleaned up on success');
});

test('upload threads --compiled-code-file only when the caller supplies it (else pac auto-transpiles) (#565)', async () => {
  const seen = [];
  const run = async (args) => {
    if (args[2] === 'list') return { status: 0, stdout: LIST_EMPTY, stderr: '' };
    seen.push(args);
    return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const cli = makeGenpageCli('https://x', { run, sleep: async () => {} });
  // Absent → flag omitted so pac auto-transpiles the TypeScript (the live-verified default path).
  await cli.upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' });
  assert.ok(!seen[0].includes('--compiled-code-file'), 'no --compiled-code-file when the caller omits it');
  // Supplied → flag present with the exact caller path.
  await cli.upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', compiledCodeFile: 'o.js', name: 'Overview' });
  const ci = seen[1].indexOf('--compiled-code-file');
  assert.ok(ci >= 0 && seen[1][ci + 1] === 'o.js', 'passes --compiled-code-file <path> when supplied');
});

test('upload cleans up its temp files even when it throws after exhausting retries (#565)', async () => {
  const fs = require('node:fs');
  let promptPath = null;
  let agentPath = null;
  const run = async (args) => {
    const pi = args.indexOf('--prompt-file');
    const ai = args.indexOf('--agent-message-file');
    if (pi >= 0) promptPath = args[pi + 1];
    if (ai >= 0) agentPath = args[ai + 1];
    // UPDATE path (caller pageId) so there is no CREATE reconcile — every attempt just fails and the
    // wrapper throws after `attempts`. The finally must still remove the temp dir.
    return { status: 1, stdout: '', stderr: 'boom' };
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }),
    /pac genpage upload failed/i
  );
  assert.ok(promptPath && !fs.existsSync(promptPath), 'prompt temp file removed on the retry-exhaustion throw');
  assert.ok(agentPath && !fs.existsSync(agentPath), 'agent-message temp file removed on the retry-exhaustion throw');
});

test('upload cleans up its temp files even when it throws mid-loop (I7 identity mismatch) (#565)', async () => {
  const fs = require('node:fs');
  let promptPath = null;
  const run = async (args) => {
    const pi = args.indexOf('--prompt-file');
    if (pi >= 0) promptPath = args[pi + 1];
    // Return a DIFFERENT id than the requested pageId → the I7 guard throws from inside the loop.
    return { status: 0, stdout: `Page ID: ${GP_A}`, stderr: '' };
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run }).upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }),
    /unexpected Page ID|refusing to persist/i
  );
  assert.ok(promptPath && !fs.existsSync(promptPath), 'temp file removed even on a mid-loop throw');
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
  assert.strictEqual(classifyListOutput('  No pages found  \n').kind, 'empty', 'a standalone no-pages line is accepted');
  assert.strictEqual(classifyListOutput('Warning: no pages could be retrieved because the service is unavailable\n').kind, 'unrecognized', 'a warning sentence is not proof of an empty app');
  assert.strictEqual(classifyListOutput('Status: No generated pages found after retry\n').kind, 'unrecognized', 'the no-pages phrase must occupy the whole trimmed line');
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
test('classifyListOutput: repeated page ids make a matching-count listing unrecognized', () => {
  const duplicateId = listText([
    { pageId: GUID, name: 'Overview' },
    { pageId: GUID.toUpperCase(), name: 'Summary' },
  ], 2);
  const k = classifyListOutput(duplicateId);
  assert.strictEqual(k.kind, 'unrecognized', `duplicate page identity must fail closed; got ${JSON.stringify(k)}`);
  assert.deepStrictEqual(k.pages, [], 'duplicate identities are not an authoritative set of pages');
});

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

// --- PR review: duplicate-create recovery must not depend on a NAME ------------------------------
// Both the pre-create snapshot and the uncertain-result reconciliation used to require `name`, so a
// name-less create skipped both and retried BLINDLY after an uncertain result — the way pac ends up
// with duplicate pages. The recovery is pure id arithmetic (enumerateEnv is id-keyed and name
// matching is explicitly never used), so the name was vestigial in those gates.
test('a name-less create still snapshots and reconciles an uncertain result (no blind retry)', async () => {
  const GP_NEW = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const seen = [];
  let uploads = 0;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      seen.push(args);
      if (args.includes('list')) {
        // Before the create: empty. After it: the page exists, so the create DID land.
        return { status: 0, stdout: uploads === 0 ? LIST_EMPTY : listText([{ pageId: GP_NEW, name: 'Whatever' }]), stderr: '' };
      }
      uploads += 1;
      // An UNCERTAIN result: zero exit, no Page ID. The create may or may not have landed.
      if (uploads === 1) return { status: 0, stdout: 'done', stderr: '' };
      return { status: 0, stdout: `Page ID: ${GP_NEW}`, stderr: '' };
    },
    sleep: async () => {},
  });
  const res = await cli.upload({ appId: 'a1', codeFile: 'p.tsx', prompt: 'p', agentMessage: 'm' }); // NO name
  assert.strictEqual(res.pageId, GP_NEW,
    'the landed create must be ADOPTED, not created a second time');
  // The retry must have run as an UPDATE against the adopted id, never as a second blind create.
  const uploadCalls = seen.filter((a) => a.includes('upload'));
  assert.strictEqual(uploadCalls.length, 2, `expected one create + one adopted update; got ${uploadCalls.length}`);
  assert.ok(!uploadCalls[0].includes('--page-id'), 'the first attempt is a create');
  assert.deepStrictEqual(uploadCalls[1].slice(uploadCalls[1].indexOf('--page-id'), uploadCalls[1].indexOf('--page-id') + 2),
    ['--page-id', GP_NEW], 'the retry targets the adopted page instead of creating a duplicate');
});

// --- #588.1: a page NAME must not be able to supply the list summary ----------------------------
// The count was matched anywhere in stdout, and pac prints names in a fixed-width table — so a page
// called "Found 1 generated page" made a listing with NO real summary line read as AUTHORITATIVE.
// An authoritative-looking but truncated listing is what drives a duplicate CREATE.
test('a page NAME cannot spoof the summary and make a truncated listing authoritative', () => {
  const spoof = [
    'Connected as tester@contoso.com',
    'Page ID                              Name                     Published',
    `${GUID} Found 1 generated page   Yes`,
  ].join('\n');
  const k = classifyListOutput(spoof);
  assert.strictEqual(k.kind, 'unrecognized',
    `a name-supplied count is not a summary; got ${JSON.stringify(k)}`);
  assert.deepStrictEqual(k.pages, [], 'an unrecognized listing yields no authoritative pages');
});

test('a REAL standalone summary line is still read (the fix must not break normal listings)', () => {
  const k = classifyListOutput(listText([{ pageId: GUID, name: 'Overview' }]));
  assert.strictEqual(k.kind, 'pages');
  assert.strictEqual(k.pages.length, 1);
  assert.strictEqual(parseListCount(LIST_EMPTY), 0, 'an explicit Found 0 is still read');
});

// --- #588.5: a page id is durable identity, so only a canonical GUID may become one --------------
// `[0-9a-fA-F-]{36}` accepted 36 characters from an alphabet containing `-`, so a row of dashes and
// any mis-grouped hex passed — and an OVERLONG token matched its first 36 characters, silently
// TRUNCATING a malformed id into a plausible one.
test('parsePageId REFUSES malformed and overlong ids instead of truncating them', () => {
  assert.strictEqual(parsePageId('Page ID: ------------------------------------'), null,
    'a run of dashes is 36 characters but not a GUID');
  assert.strictEqual(parsePageId('Page ID: 111111112222333344445555555555555555'), null,
    'ungrouped hex is not a canonical GUID');
  assert.strictEqual(parsePageId('Page ID: 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35f'), null,
    'an OVERLONG token must be refused, never trimmed to a valid-looking id');
  assert.strictEqual(parsePageId('Page ID: 6e0c28a2-cdbf-41ec-9186-d10fd5de6e3'), null,
    'a short token is refused too');
});

test('parsePageId still accepts a real id, in either case, with trailing output', () => {
  assert.strictEqual(parsePageId('Page ID: 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35'),
    '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35');
  assert.strictEqual(parsePageId('Page ID: 6E0C28A2-CDBF-41EC-9186-D10FD5DE6E35\nDone.'),
    '6E0C28A2-CDBF-41EC-9186-D10FD5DE6E35', 'pac may normalize GUID casing');
});

// A malformed id must not simply vanish: with no parsable identity the upload is UNCERTAIN, and the
// env-wide before/after diff has to run so a landed create is adopted rather than blindly retried.
test('a malformed Page ID drives uncertain-create reconciliation, not a blind retry', async () => {
  const seen = [];
  let uploads = 0;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      seen.push(args);
      if (args.includes('list')) {
        return { status: 0, stdout: uploads === 0 ? LIST_EMPTY : listText([{ pageId: GUID, name: 'N' }]), stderr: '' };
      }
      uploads += 1;
      // Zero exit, but the id is malformed — historically parsed and stored as identity.
      if (uploads === 1) return { status: 0, stdout: 'Page ID: ------------------------------------', stderr: '' };
      return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
    },
    sleep: async () => {},
  });
  const res = await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' });
  assert.strictEqual(res.pageId, GUID,
    'the landed create must be ADOPTED by id diff, not identified by the malformed token');
  const uploadCalls = seen.filter((a) => a.includes('upload'));
  assert.strictEqual(uploadCalls.length, 2, 'one create + one adopted update');
  assert.ok(uploadCalls[1].includes('--page-id'), 'the retry targets the adopted page');
});

// --- G4: keep the diagnostic pac produced, and do not retry a deterministic failure -------------
// CAPTURED VERBATIM from `pac model genpage download` with no --app-id. pac prints a banner, then
// the error, then a full help dump — so the LAST non-empty line is a flag description and the real
// cause sits in the middle. The wrapper used to report exactly that last line.
const REAL_PAC_ARG_FAILURE = [
  'Microsoft PowerPlatform CLI',
  'Version: 0.1.0-dev (.NET 10.0.12)',
  'Online documentation: https://aka.ms/PowerPlatformCLI',
  'Feedback, Suggestions, Issues: https://github.com/microsoft/powerplatform-build-tools/discussions',
  '',
  'Error: A required argument --app-id is missing.',
  '',
  'Usage: pac model genpage download [--environment] --app-id [--page-id] [--output-directory]',
  '',
  '  --environment               Specifies the target Dataverse. (alias: -env)',
  '  --app-id                    The ID of the model-driven app.',
  '  --output-directory          Directory to save pulled pages. (alias: -o)',
].join('\n');

test('a REAL pac failure banner reports the Error line, not the last help row', async () => {
  let thrown = null;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      if (args.includes('list')) return { status: 0, stdout: LIST_EMPTY, stderr: '' };
      return { status: 1, stdout: REAL_PAC_ARG_FAILURE, stderr: '' };
    },
    sleep: async () => {},
  });
  try { await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' }); }
  catch (e) { thrown = e; }
  assert.ok(thrown, 'the upload must fail');
  assert.match(thrown.message, /required argument --app-id is missing/,
    `the real cause must survive; got ${thrown.message}`);
  assert.ok(!/alias: -o/.test(thrown.message),
    `a help row must not be reported as the error; got ${thrown.message}`);
});

test('a deterministic failure is reported at once, not retried until the budget is spent', async () => {
  let uploadAttempts = 0;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      if (args.includes('list')) return { status: 0, stdout: LIST_EMPTY, stderr: '' };
      uploadAttempts += 1;
      return { status: 1, stdout: REAL_PAC_ARG_FAILURE, stderr: '' };
    },
    sleep: async () => {},
  });
  await assert.rejects(() => cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' }));
  assert.strictEqual(uploadAttempts, 1,
    `an argument fault cannot succeed on a retry; attempted ${uploadAttempts} times`);
});

// The retry budget still exists for what it was built for: transient service flakes.
test('a TRANSIENT failure is still retried and can succeed', async () => {
  let uploadAttempts = 0;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      if (args.includes('list')) {
        return { status: 0, stdout: uploadAttempts === 0 ? LIST_EMPTY : LIST_EMPTY, stderr: '' };
      }
      uploadAttempts += 1;
      if (uploadAttempts === 1) return { status: 1, stdout: '', stderr: 'The service is temporarily unavailable. Please try again.' };
      return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
    },
    sleep: async () => {},
  });
  const res = await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' });
  assert.strictEqual(res.pageId, GUID);
  assert.strictEqual(uploadAttempts, 2, 'a transient failure must still be retried');
});

// --- #588.6: a path ending in a separator must not swallow the flags that follow ----------------
// Windows command-line parsing treats `\"` as an ESCAPED QUOTE, so a directory argument ending in
// a backslash escaped its own closing quote. Captured from a real cmd.exe parse before the fix:
//   ["--output-directory", "C:\\Users\\Power User\\download\" --app-id after"]
// i.e. the path absorbed the rest of the command line and --app-id was never passed.
test('a trailing backslash is doubled so it cannot escape the closing quote', () => {
  // `String.raw` cannot be used here: a template literal may not END with a backslash, because it
  // escapes the closing backtick. Ordinary escapes it is.
  const dir = 'C:\\Users\\Power User\\download\\';
  const inv = buildPacInvocation(['model', 'genpage', 'download', '--output-directory', dir, '--app-id', 'after'], 'win32');
  // The run before the closing quote is doubled; the following flag stays a separate argument.
  assert.match(inv.command, /--output-directory "C:\\Users\\Power User\\download\\\\" --app-id after$/,
    `the trailing separator must be escaped; got ${inv.command}`);
});

test('interior backslashes are left alone (every Windows path has them)', () => {
  const inv = buildPacInvocation(['model', 'genpage', 'download', '--output-directory', String.raw`C:\Users\Power User\download`], 'win32');
  assert.match(inv.command, /"C:\\Users\\Power User\\download"/,
    `an ordinary path must round-trip unchanged; got ${inv.command}`);
});

test('POSIX passes args verbatim, with no cmd-style quoting at all', () => {
  const dir = '/home/user/download\\';
  const inv = buildPacInvocation(['model', 'genpage', 'download', '--output-directory', dir], 'linux');
  assert.deepStrictEqual(inv.args, ['model', 'genpage', 'download', '--output-directory', dir],
    'the POSIX path spawns pac directly, so nothing may be rewritten');
});

// --- review follow-up: a TRANSIENT message must NOT be mistaken for a deterministic one --------
// The first version matched the bare phrases "does not exist" and "could not be found", so a
// service message like "The resource does not exist yet; please retry." aborted the retry loop —
// losing a retry that would have SUCCEEDED. A lost retry fails a build; a needless retry costs
// about a second, and that asymmetry is what decides the trade.
const runRetryCase = async (stderr) => {
  let attempts = 0;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      if (args.includes('list')) return { status: 0, stdout: LIST_EMPTY, stderr: '' };
      attempts += 1;
      return { status: 1, stdout: '', stderr };
    },
    sleep: async () => {},
  });
  try { await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' }); } catch { /* expected */ }
  return attempts;
};

test('a transient message containing "does not exist" is still RETRIED', async () => {
  for (const msg of [
    'The resource does not exist yet; please retry.',
    'Error: The specified environment does not exist.',
    'Error: The app module could not be found.',
    'The service is temporarily unavailable. Please try again.',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const attempts = await runRetryCase(msg);
    assert.strictEqual(attempts, 3, `"${msg}" must be retried; attempted ${attempts} time(s)`);
  }
});

// The real pac wording for a missing file, MEASURED, carries argument AND file context — which is
// what makes it unambiguously deterministic where a bare phrase is not.
test('a REAL pac argument/file fault is still short-circuited', async () => {
  for (const msg of [
    'Error: A required argument --app-id is missing.',
    "Error: The value passed to '--code-file' is invalid. The file 'D:\\nope\\absent.tsx' could not be found.",
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const attempts = await runRetryCase(msg);
    assert.strictEqual(attempts, 1, `"${msg}" cannot succeed on a retry; attempted ${attempts} time(s)`);
  }
});

// --- review follow-up: the diagnostic fallback must not report only the banner -----------------
// `FLAG_HELP_RE` drops the help dump, but pac can print the ONLY diagnostic in that same indented
// shape. With no `Error:` line, the filtered set was empty and the fallback took the FIRST four
// lines — the banner — discarding the one line that said anything.
test('a flag-SHAPED sole diagnostic survives instead of being replaced by the banner', async () => {
  const out = [
    'Microsoft PowerPlatform CLI',
    'Version: 0.1.0-dev (.NET 10.0.12)',
    'Online documentation: https://aka.ms/PowerPlatformCLI',
    'Feedback, Suggestions, Issues: https://github.com/microsoft/powerplatform-build-tools/discussions',
    '  --output-directory does not exist: C:\\missing',
  ].join('\n');
  let thrown = null;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      if (args.includes('list')) return { status: 0, stdout: LIST_EMPTY, stderr: '' };
      return { status: 1, stdout: out, stderr: '' };
    },
    sleep: async () => {},
  });
  try { await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' }); }
  catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.match(thrown.message, /output-directory does not exist/,
    `the only real line must survive; got ${thrown.message}`);
  assert.ok(!/Microsoft PowerPlatform CLI/.test(thrown.message),
    `the banner must not be reported as the diagnostic; got ${thrown.message}`);
});

// --- review follow-up: both boundaries were the wrong SHAPE, not just missing ------------------

// The trailing boundary only rejected the GUID alphabet, so a suffix starting with any other
// character passed the lookahead and the id was accepted with the rest silently dropped. This
// value becomes DURABLE page identity, so a truncated id is a wrong-page write later.
test('parsePageId refuses a GUID followed by any identifier character, not just hex', () => {
  const G = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';
  assert.strictEqual(parsePageId(`Page ID: ${G}`), G, 'the control: a clean id still parses');
  for (const suffix of ['oops', 'f', '-', '_x', '0', 'Z']) {
    assert.strictEqual(parsePageId(`Page ID: ${G}${suffix}`), null,
      `a token continuing with ${JSON.stringify(suffix)} must be refused, not trimmed to the GUID`);
  }
  // ...but punctuation genuinely ENDS the token — pac prints the id inside prose.
  assert.strictEqual(parsePageId(`Page ID: ${G}東京`), null,
    'a Unicode letter continues the token and must not be silently dropped');
  for (const suffix of ['.', ',', ')', ' ', '\n']) {
    assert.strictEqual(parsePageId(`Page ID: ${G}${suffix}`), G,
      `${JSON.stringify(suffix)} terminates the id and must still parse`);
  }
});

// Anchoring the START defeated the table-row spoof, but with the line END unconstrained a name
// that merely BEGAN with the summary text was accepted just the same — and a listing that looks
// authoritative but is truncated is exactly what drives a duplicate CREATE.
test('parseListCount requires the WHOLE line to be the summary, not just its start', () => {
  assert.strictEqual(parseListCount('Found 3 generated page(s):'), 3, 'the live-captured form still parses');
  assert.strictEqual(parseListCount('Found 0 generated page(s):'), 0);
  for (const bad of [
    'Found 1 generated pagex',
    'Found 1 generated page(s) extra',
    'Found 1 generated page(s): and then some',
  ]) {
    assert.strictEqual(parseListCount(bad), null,
      `${JSON.stringify(bad)} is not the summary grammar and must not supply a count`);
  }
});

// And the whole point: an unparsable summary must make the listing UNRECOGNIZED, never "empty" —
// "empty" is what authorises a create.
test('a malformed summary line makes the listing unrecognized, not empty', () => {
  const out = 'Connected as tester@contoso.com\nRetrieving generated pages...\nFound 0 generated pagex\n';
  assert.strictEqual(classifyListOutput(out).kind, 'unrecognized',
    'a summary that does not parse must fail closed');
});

// --- review follow-up: the retry guard was keyed on the wrong condition ------------------------
// "Stop retrying a deterministic failure" was gated on `!pid`, i.e. only on a CREATE. An ordinary
// update — where the caller supplies `pageId`, so `pid` is truthy from the first attempt — sat
// through every attempt on a fault that can never resolve itself, burying the real message under
// "after 3 attempt(s)". The correct test is whether the NEXT attempt runs the SAME command.
test('a deterministic failure on an ORDINARY update stops after one attempt', async () => {
  let attempts = 0;
  const run = async () => {
    attempts += 1;
    // Real pac wording for an argument fault — retrying cannot change the outcome.
    return { status: 1, stdout: '', stderr: "Error: The value passed to '--code-file' is invalid. The file 'o.tsx' could not be found." };
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {} })
      .upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }),
    /pac genpage upload failed/i);
  assert.strictEqual(attempts, 1,
    `a deterministic UPDATE fault must not be retried; ran ${attempts} attempt(s)`);
});

// The control: a TRANSIENT failure on the same ordinary update is still retried, so the guard did
// not simply disable retries for updates.
test('a transient failure on an ordinary update is still retried', async () => {
  let attempts = 0;
  const run = async () => {
    attempts += 1;
    return { status: 1, stdout: '', stderr: 'Error: The service is temporarily unavailable. Please try again.' };
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {} })
      .upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }),
    /pac genpage upload failed/i);
  assert.ok(attempts > 1,
    `a transient fault must still be retried; ran ${attempts} attempt(s)`);
});

// The ONE case the deterministic-failure stop must not break: an uncertain CREATE that actually
// landed. Once the env diff adopts the new page, the next attempt is an UPDATE by id — a different
// command — so the create's argument fault says nothing about it. Every other adoption test used a
// transient error, so a guard that ignored the adoption transition survived the whole suite; and
// that mutant is a duplicate-create hazard, because the call throws without returning the id the
// create already minted.
test('a deterministic-looking error on a CREATE that landed is still adopted and returned', async () => {
  const uploads = [];
  let listN = 0;
  const run = async (args) => {
    if (args[2] === 'list') {
      listN += 1;
      // before the create: empty; after it: the page exists — the create DID land.
      return { status: 0, stdout: listN === 1 ? LIST_EMPTY : listText([{ pageId: GUID, name: 'Overview' }]), stderr: '' };
    }
    uploads.push(args);
    return uploads.length === 1
      ? { status: 1, stdout: '', stderr: "Error: The value passed to '--code-file' is invalid. The file 'o.tsx' could not be found." }
      : { status: 0, stdout: `Successfully pushed page. Page ID: ${GUID}`, stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} })
    .upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID, 'the adopted page must be returned, not lost to a thrown error');
  assert.strictEqual(uploads.length, 2, 'exactly one follow-up attempt — the UPDATE of the adopted page');
  assert.ok(!uploads[0].includes('--page-id'), 'the first attempt was the create');
  assert.ok(uploads[1].includes('--page-id') && uploads[1].includes(GUID), 'the second attempt updated the adopted id');
});
