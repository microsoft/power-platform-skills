'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeGenpageCli, parsePageId, parseList, quoteArg } = require('../lib/genpage-cli.js');

const GUID = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';

test('quoteArg quotes args with spaces/specials, leaves plain args', () => {
  assert.strictEqual(quoteArg('Overview'), 'Overview');
  assert.strictEqual(quoteArg('A responsive cards overview'), '"A responsive cards overview"');
  assert.strictEqual(quoteArg('has"quote'), '"has""quote"');
  assert.strictEqual(quoteArg('https://x'), 'https://x');
});

test('parsePageId extracts the guid from upload output', () => {
  assert.strictEqual(parsePageId(`Successfully pushed page. Page ID: ${GUID}\n`), GUID);
  assert.strictEqual(parsePageId('no id here'), null);
});

test('parseList maps guids to names', () => {
  const pages = parseList(`Overview   ${GUID}\nDashboard  11111111-2222-3333-4444-555555555555`);
  assert.strictEqual(pages.length, 2);
  assert.strictEqual(pages[0].pageId, GUID);
  assert.strictEqual(pages[0].name, 'Overview');
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

test('upload throws on a pac failure', async () => {
  const run = async () => ({ status: 1, stdout: '', stderr: 'boom' });
  await assert.rejects(makeGenpageCli('https://x', { run }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'X' }), /pac genpage upload failed/);
});

test('list returns [] when pac fails', async () => {
  const run = async () => ({ status: 1, stdout: '', stderr: 'boom' });
  assert.deepStrictEqual(await makeGenpageCli('https://x', { run }).list({ appId: 'a' }), []);
});
