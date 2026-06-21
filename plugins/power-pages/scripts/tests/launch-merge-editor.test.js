'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildLaunchPlan, launchEditor, quoteWinArg } = require('../lib/launch-merge-editor');

const RUN = path.join(path.sep, 'tmp', 'pp-merge', 'run-1');
const manifest = {
  units: [{
    unitId: 'Search__source', componentName: 'Search Results', field: 'source',
    files: {
      base: 'units/Search__source/base.html',
      ours: 'units/Search__source/dataverse.html',
      theirs: 'units/Search__source/ado.html',
      result: 'units/Search__source/merged.html',
    },
  }],
};

test('buildLaunchPlan: requires runDir', () => {
  assert.throws(() => buildLaunchPlan({}), /runDir is required/);
});

test('buildLaunchPlan: deep link + open-folder commands', () => {
  const p = buildLaunchPlan({ runDir: RUN, launchUri: 'vscode://power-pages.powerpages-merge/open?dir=x' });
  assert.match(p.deepLink, /code --open-url "vscode:\/\/power-pages\.powerpages-merge\/open\?dir=x"/);
  assert.match(p.openFolder, /code ".*run-1"/);
});

test('buildLaunchPlan: per-unit CLI merge uses code --merge <dataverse> <ado> <base> <merged>', () => {
  const p = buildLaunchPlan({ runDir: RUN, manifest });
  assert.equal(p.cliMerge.length, 1);
  const c = p.cliMerge[0];
  assert.equal(c.unitId, 'Search__source');
  // order: current(dataverse) incoming(ado) base result(merged)
  const order = c.command.match(/--merge "([^"]+)" "([^"]+)" "([^"]+)" "([^"]+)"/);
  assert.ok(order, 'matches the 4-arg --merge signature');
  assert.match(order[1], /dataverse\.html$/);
  assert.match(order[2], /ado\.html$/);
  assert.match(order[3], /base\.html$/);
  assert.match(order[4], /merged\.html$/);
});

test('buildLaunchPlan: no launchUri → deepLink null, still has folder + cli', () => {
  const p = buildLaunchPlan({ runDir: RUN, manifest });
  assert.equal(p.deepLink, null);
  assert.ok(p.openFolder);
  assert.equal(p.cliMerge.length, 1);
});

test('launchEditor: deep link succeeds → via deep-link, no folder attempt', () => {
  const calls = [];
  const exec = (cmd, args) => { calls.push(args); return { status: 0 }; };
  const r = launchEditor({ runDir: RUN, launchUri: 'vscode://x', manifest, exec });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'deep-link');
  assert.deepEqual(r.tried, ['deep-link']);
  assert.equal(calls.length, 1);
});

test('launchEditor: deep link fails → falls back to open-folder', () => {
  const exec = (cmd, args) => (args[0] === '--open-url' ? { status: 1 } : { status: 0 });
  const r = launchEditor({ runDir: RUN, launchUri: 'vscode://x', manifest, exec });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'open-folder');
  assert.deepEqual(r.tried, ['deep-link', 'open-folder']);
});

test('launchEditor: all attempts fail → ok:false with the plan (CLI merge lines available)', () => {
  const exec = () => ({ status: 127 }); // code not found
  const r = launchEditor({ runDir: RUN, launchUri: 'vscode://x', manifest, exec });
  assert.equal(r.ok, false);
  assert.equal(r.via, null);
  assert.ok(r.plan.cliMerge.length === 1, 'still surfaces the no-extension CLI merge command');
});

test('quoteWinArg: quotes a deep-link URI containing & so cmd.exe does not split it', () => {
  const uri = 'vscode://power-pages.powerpages-merge/open?runId=abc&dir=C:%5CTemp%5Cpp-merge%5Cabc';
  const q = quoteWinArg(uri);
  assert.ok(q.startsWith('"') && q.endsWith('"'), 'URI with & must be wrapped in double quotes');
  assert.ok(q.includes('&dir='), 'the & is preserved inside the quotes');
});

test('quoteWinArg: leaves a simple token unquoted', () => {
  assert.equal(quoteWinArg('--open-url'), '--open-url');
});

test('quoteWinArg: quotes a path with spaces and escapes embedded quotes', () => {
  assert.equal(quoteWinArg('C:\\Temp\\pp merge\\run'), '"C:\\Temp\\pp merge\\run"');
});
