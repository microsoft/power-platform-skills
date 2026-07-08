'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeGenpageCli, parsePageId, parseList, quoteArg, buildPacInvocation } = require('../lib/genpage-cli.js');

const GUID = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';

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

test('parseList maps names to guids (name line precedes the "Page ID:" line)', () => {
  const out = `Found 1 generated page(s):\n\n  Overview\n    Page ID: ${GUID}\n    Description: Created: 2026-07-07\n\n  Dashboard\n    Page ID: 11111111-2222-3333-4444-555555555555`;
  const pages = parseList(out);
  assert.strictEqual(pages.length, 2);
  assert.deepStrictEqual(pages[0], { pageId: GUID, name: 'Overview' });
  assert.strictEqual(pages[1].name, 'Dashboard');
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
  await makeGenpageCli('https://x', { run }).upload({ appId: 'a', pageId: 'existing', codeFile: 'o.tsx', name: 'Overview' });
  assert.ok(calls[0].includes('--page-id') && calls[0].includes('existing'));
});

test('upload retries a transient pac failure then succeeds', async () => {
  let n = 0;
  const run = async () => { n += 1; return n === 1 ? { status: 1, stdout: '', stderr: 'flaky help dump' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', pageId: 'existing', codeFile: 'o.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.ok(n >= 2, 'retried after the transient failure');
});

test('upload converts a failed CREATE to an UPDATE on retry (resolve by name, no duplicate)', async () => {
  const uploadArgs = [];
  let up = 0;
  const run = async (args) => {
    if (args[2] === 'list') return { status: 0, stdout: `  Overview\n    Page ID: ${GUID}`, stderr: '' };
    up += 1; uploadArgs.push(args);
    return up === 1 ? { status: 1, stdout: '', stderr: 'flaky' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.ok(!uploadArgs[0].includes('--page-id'), 'first attempt was a create (no page-id)');
  assert.ok(uploadArgs[1].includes('--page-id') && uploadArgs[1].includes(GUID), 'retry updates in place via the resolved page id (never duplicates)');
});

test('upload throws after exhausting retries on a persistent pac failure', async () => {
  let n = 0;
  const run = async (args) => { if (args[2] === 'list') return { status: 1, stdout: '', stderr: '' }; n += 1; return { status: 1, stdout: '', stderr: 'boom' }; };
  await assert.rejects(makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'X' }), /pac genpage upload failed for 'X' after 3 attempt\(s\)/);
  assert.strictEqual(n, 3, 'tried the configured number of attempts');
});

test('list returns [] when pac fails', async () => {
  const run = async () => ({ status: 1, stdout: '', stderr: 'boom' });
  assert.deepStrictEqual(await makeGenpageCli('https://x', { run }).list({ appId: 'a' }), []);
});
