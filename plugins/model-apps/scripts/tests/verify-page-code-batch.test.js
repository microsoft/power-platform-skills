'use strict';

// Verify reads the code of the pages whose navigation it checks. It ran `pac model genpage download` once per
// page — a process start, an auth and a round trip each. A reader that can (`pageCodes`) now downloads the pages
// together, and the page reads begin with the pass instead of after every other check. These tests count pac
// runs and prove each page is still reported exactly as it was.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readerFor } = require('../verify-model-app.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { makeGenpageCli } = require('../lib/genpage-cli.js');
const { instrument } = require('./helpers/read-probe.js');

const pid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-0000000000aa`;
const source = (id) => `// source of ${String(id).toLowerCase()}\n`;
const NAV = (id) => `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "${id}", data: {} });`;

// --- the reader ------------------------------------------------------------------------------------

const stubSdk = () => ({
  queryRecords: async (set) => (set === 'appmodule' ? [{ appmoduleid: 'app-uuid-1', appmoduleidunique: 'uid-1' }] : []),
  findTables: async () => [],
  findColumns: async () => [],
});

// Stands in for `pac model genpage download`: writes <outDir>/<dirName(id)>/page.tsx for each id it is given.
function fakeGenpageCli({ dirName = (id) => id, omitInBatch = new Set(), failBatch = false, failIds = new Set(), extraDirs = {} } = {}) {
  const runs = [];
  return {
    runs,
    enumerateEnv: async () => ({ ok: true, ids: [] }),
    download: async ({ outputDir, pageIds }) => {
      runs.push([...pageIds]);
      if (failBatch && pageIds.length > 1) throw new Error('pac genpage download failed: the batch was refused');
      const bad = pageIds.find((id) => failIds.has(String(id).toLowerCase()));
      if (bad) throw new Error(`pac genpage download failed: page ${bad} was not found`);
      for (const id of pageIds) {
        if (pageIds.length > 1 && omitInBatch.has(String(id).toLowerCase())) continue;
        fs.mkdirSync(path.join(outputDir, dirName(id)), { recursive: true });
        fs.writeFileSync(path.join(outputDir, dirName(id), 'page.tsx'), source(id), 'utf8');
      }
      for (const [dir, text] of Object.entries(extraDirs)) {
        fs.mkdirSync(path.join(outputDir, dir), { recursive: true });
        fs.writeFileSync(path.join(outputDir, dir, 'page.tsx'), text, 'utf8');
      }
      return true;
    },
  };
}

const readerWith = (genpageCli) => readerFor(stubSdk(), 'contoso_app', { genpageCli, workspaceDir: os.tmpdir() });

test('the code of several pages comes from ONE pac run, each page answered with its own code', async () => {
  const cli = fakeGenpageCli();
  const reader = readerWith(cli);
  const ids = [1, 2, 3, 4, 5].map(pid);
  const answers = await reader.pageCodes(ids);
  assert.deepStrictEqual(cli.runs, [ids], 'one download holding every id, in order (five before)');
  assert.deepStrictEqual([...answers.keys()], ids);
  const single = readerWith(fakeGenpageCli());
  for (const id of ids) {
    assert.deepStrictEqual(answers.get(id), { code: source(id) });
    assert.strictEqual(answers.get(id).code, await single.pageCode(id), 'byte-for-byte the code the one-page reader returns');
  }
});

test('a long list goes in chunks of 25 ids — one run per chunk, no id in two runs', async () => {
  for (const [count, shape] of [[25, [25]], [26, [25, 1]], [60, [25, 25, 10]]]) {
    const cli = fakeGenpageCli();
    const ids = Array.from({ length: count }, (_, n) => pid(n + 1));
    const answers = await readerWith(cli).pageCodes(ids);
    assert.deepStrictEqual(cli.runs.map((run) => run.length), shape, `${count} ids`);
    assert.deepStrictEqual(cli.runs.flat(), ids, `${count} ids: every id once, in order`);
    assert.strictEqual(answers.size, count);
    for (const id of ids) assert.deepStrictEqual(answers.get(id), { code: source(id) });
  }
});

test('a page is found by its own directory name, whatever the case, and never from another page\'s files', async () => {
  const cli = fakeGenpageCli({ dirName: (id) => id.toUpperCase(), extraDirs: { 'not-a-requested-page': '// stray code' } });
  const ids = [1, 2, 3].map(pid);
  const answers = await readerWith(cli).pageCodes(ids);
  assert.strictEqual(cli.runs.length, 1);
  for (const id of ids) assert.deepStrictEqual(answers.get(id), { code: source(id) });
  assert.ok([...answers.values()].every((a) => !/stray/.test(a.code)), 'a directory nobody asked for is nobody\'s code');
});

test('a page the successful batch left no directory for is asked for by itself, as before', async () => {
  const missing = pid(3);
  const cli = fakeGenpageCli({ omitInBatch: new Set([missing]) });
  const answers = await readerWith(cli).pageCodes([pid(1), pid(2), missing, pid(4)]);
  assert.deepStrictEqual(cli.runs, [[pid(1), pid(2), missing, pid(4)], [missing]]);
  assert.deepStrictEqual(answers.get(missing), { code: source(missing) });
  assert.deepStrictEqual(answers.get(pid(4)), { code: source(pid(4)) });
});

test('a batch pac refuses falls back to one run per page — a bad page costs its own miss, not its neighbours\'', async () => {
  const bad = pid(2);
  const cli = fakeGenpageCli({ failBatch: true, failIds: new Set([bad]) });
  const reader = readerWith(cli);
  const answers = await reader.pageCodes([pid(1), bad, pid(3)]);
  assert.deepStrictEqual(cli.runs, [[pid(1), bad, pid(3)], [pid(1)], [bad], [pid(3)]], 'the batch, then each page alone');
  assert.deepStrictEqual(answers.get(pid(1)), { code: source(pid(1)) });
  assert.deepStrictEqual(answers.get(pid(3)), { code: source(pid(3)) });
  const alone = await reader.pageCode(bad).then(() => null, (e) => e);
  assert.ok(answers.get(bad).error instanceof Error);
  assert.strictEqual(answers.get(bad).error.message, alone.message, 'the miss carries what the one-page download throws');
});

test('pages already downloaded are not downloaded again, and a duplicate in the list is fetched once', async () => {
  const cli = fakeGenpageCli();
  const reader = readerWith(cli);
  await reader.pageCode(pid(1));
  const answers = await reader.pageCodes([pid(1), pid(2), pid(3), pid(2).toUpperCase(), pid(3)]);
  assert.deepStrictEqual(cli.runs, [[pid(1)], [pid(2), pid(3)]]);
  assert.strictEqual(answers.size, 3);
  await reader.pageCodes([pid(3), pid(2), pid(1)]);
  assert.strictEqual(cli.runs.length, 2, 'asked again: answered from what was downloaded');
});

test('through the real genpage CLI wrapper, N pages are one `pac model genpage download --page-id a,b,c` run', async () => {
  const downloads = [];
  const run = async (args) => {
    if (args[2] !== 'download') return { status: 0, stdout: '', stderr: '' };
    downloads.push(args);
    const outDir = args[args.indexOf('--output-directory') + 1];
    for (const id of args[args.indexOf('--page-id') + 1].split(',')) {
      fs.mkdirSync(path.join(outDir, id), { recursive: true });
      fs.writeFileSync(path.join(outDir, id, 'page.tsx'), source(id), 'utf8');
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const genpageCli = makeGenpageCli('https://contoso.crm.dynamics.com', { run, sleep: async () => {} });
  const ids = [1, 2, 3, 4].map(pid);
  const answers = await readerWith(genpageCli).pageCodes(ids);
  assert.strictEqual(downloads.length, 1, 'one pac run for four pages');
  assert.strictEqual(downloads[0][downloads[0].indexOf('--page-id') + 1], ids.join(','));
  assert.strictEqual(downloads[0][downloads[0].indexOf('--app-id') + 1], 'app-uuid-1');
  for (const id of ids) assert.deepStrictEqual(answers.get(id), { code: source(id) });
});

// --- verify ----------------------------------------------------------------------------------------

// Six pages; each navigates to the next except the page numbered 4 and the last. Page 2 is not in the app's
// sitemap, so its code is never read. Page 3's deployed code navigates to a wrong id.
function pagesSpec(count = 6, extraEntities = []) {
  const pages = Array.from({ length: count }, (_, n) => ({
    key: `p${n}`,
    name: `Page ${n}`,
    ...(n === 4 || n === count - 1 ? {} : { navigatesTo: [{ targetKey: `p${n + 1}` }] }),
    source: { kind: 'tsx', codeFile: `p${n}.tsx` },
  }));
  return {
    entities: [...extraEntities, { schemaName: 'contoso_item', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    schemaVersion: 2,
    pages,
    appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: pages.map((p) => ({ page: p.key, title: p.name })) }] }] },
  };
}

function pageReader({ count = 6, batch = false, failing = {}, pageCodesThrows = false } = {}) {
  const calls = { pageCode: [], pageCodes: [] };
  const all = Array.from({ length: count }, (_, n) => pid(n));
  const inSitemap = all.filter((id) => id !== pid(2));
  const sitemap = `<SiteMap><Area><Group>${inSitemap.map((id, i) => `<SubArea Id="s${i}" GenPageId="${id}"/>`).join('')}</Group></Area></SiteMap>`;
  const codeFor = (id) => {
    const n = all.indexOf(String(id).toLowerCase());
    return n === 3 ? NAV(pid(99)) : NAV(pid(n + 1));
  };
  const read = {
    findTable: async () => ({ logicalName: 'contoso_item' }),
    findColumns: async () => [],
    queryRecords: async () => [],
    sitemapXml: async () => sitemap,
    sitemapPageIds: async () => inSitemap,
    existenceIds: async () => all,
    manifest: async () => ({ schemaVersion: 1, pages: all.map((id, n) => ({ key: `p${n}`, name: `Page ${n}`, pageId: id })) }),
    pageCode: async (id) => {
      calls.pageCode.push(id);
      if (failing[id]) throw new Error(failing[id]);
      return codeFor(id);
    },
  };
  if (batch) {
    read.pageCodes = async (ids) => {
      calls.pageCodes.push([...ids]);
      if (pageCodesThrows) throw new Error('the reader broke');
      return new Map(ids.map((id) => [String(id).toLowerCase(), failing[id] ? { error: new Error(failing[id]) } : { code: codeFor(id) }]));
    };
  }
  return { read, calls };
}

test('verify asks for the code of the pages it checks in one batch — same pages, same order, same report', async () => {
  const perPage = pageReader();
  const batched = pageReader({ batch: true });
  const before = await verifySpec(pagesSpec(), perPage.read);
  const after = await verifySpec(pagesSpec(), batched.read);
  assert.deepStrictEqual(perPage.calls.pageCode, [pid(0), pid(1), pid(3)], 'one pac run per page before');
  assert.deepStrictEqual(batched.calls.pageCodes, [[pid(0), pid(1), pid(3)]], 'one batch: deployed pages with navigation, once each, in spec order');
  assert.deepStrictEqual(batched.calls.pageCode, [], 'and no per-page run');
  assert.deepStrictEqual(after, before);
  assert.ok(after.checks.some((c) => c.kind === 'page-nav' && c.present) && after.checks.some((c) => c.kind === 'page-nav' && !c.present), 'the fixture reports passes and failures');
});

test('a page whose code could not be downloaded is the same page-code miss with or without the batch', async () => {
  const failing = { [pid(1)]: 'pac genpage download failed: page was not found' };
  const before = await verifySpec(pagesSpec(), pageReader({ failing }).read);
  const after = await verifySpec(pagesSpec(), pageReader({ batch: true, failing }).read);
  assert.deepStrictEqual(after, before);
  assert.deepStrictEqual(after.checks.filter((c) => c.kind === 'page-code').map((c) => [c.name, c.present, c.detail]), [['Page 1', false, 'pac genpage download failed: page was not found']]);
});

test('a reader whose pageCodes fails outright is asked page by page — the report is unchanged', async () => {
  const before = await verifySpec(pagesSpec(), pageReader().read);
  const broken = pageReader({ batch: true, pageCodesThrows: true });
  const after = await verifySpec(pagesSpec(), broken.read);
  assert.deepStrictEqual(after, before);
  assert.deepStrictEqual(broken.calls.pageCode, [pid(0), pid(1), pid(3)]);
});

test('a single page with navigation is the one-page download — no batch', async () => {
  const one = pageReader({ count: 2, batch: true });
  const result = await verifySpec(pagesSpec(2), one.read);
  assert.deepStrictEqual(one.calls.pageCodes, []);
  assert.deepStrictEqual(one.calls.pageCode, [pid(0)]);
  assert.ok(result.checks.some((c) => c.kind === 'page-nav'));
});

test('the page reads start with the pass, ahead of the other checks — and at their old place one read at a time', async () => {
  const entities = Array.from({ length: 8 }, (_, n) => ({ schemaName: `new_e${n}`, columns: [{ schemaName: `new_e${n}_a` }] }));
  const order = async (concurrency) => {
    const { read } = pageReader({ batch: true });
    const probe = instrument({ ...read, findColumns: async () => [] }, { latency: () => 2 });
    await verifySpec(pagesSpec(6, entities), probe.read, { concurrency });
    const names = probe.stats.calls.map((c) => c.name);
    return { existence: names.indexOf('existenceIds'), lastEntityRead: names.lastIndexOf('findColumns') };
  };
  const overlapped = await order(4);
  assert.ok(overlapped.existence < overlapped.lastEntityRead, `the pac listing started at read ${overlapped.existence}, before the entity checks were through (${overlapped.lastEntityRead})`);
  const sequential = await order(1);
  assert.ok(sequential.existence > sequential.lastEntityRead, 'one at a time it is made where the page checks come, after the entity checks');
});

test('a failed page-authority read ends the pass with the same error wherever it happened, and an earlier failure outranks it', async () => {
  const boom = new Error('pac listing failed');
  const failingListing = (extra = {}) => ({ ...pageReader({ batch: true }).read, existenceIds: async () => { throw boom; }, ...extra });
  for (const concurrency of [1, 4]) {
    await assert.rejects(verifySpec(pagesSpec(), failingListing(), { concurrency }), (e) => e === boom, `width ${concurrency}`);
  }
  const entityFails = failingListing({ findColumns: async () => { throw new Error('entity read failed'); } });
  for (const concurrency of [1, 4]) {
    await assert.rejects(verifySpec(pagesSpec(), entityFails, { concurrency }), /entity read failed/, `width ${concurrency}`);
  }
});
