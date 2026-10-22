'use strict';

// Verify reads the code of the pages whose navigation it checks. It once ran `pac model genpage download` per page —
// a process start, an auth and a round trip each — and then one run per chunk of pages. The reader now reads each page
// through the SDK by its id (`pageCodes`: a few reads at a time, each page answered on its own), and the page reads begin
// with the pass instead of after every other check. These tests count the reads and prove each page is still reported
// exactly as it was.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { readerFor } = require('../verify-model-app.js');
const { verifySpec } = require('../lib/verify-spec.js');
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

// Stands in for the page backend (lib/genpage-sdk.js): `read(id)` answers the page's source, throws what the backend throws for a page it
// cannot read, and records every read and how many were in flight at once.
// `hold`, a promise, keeps every read open until it settles — for a test that must prove an order without a clock.
function fakeGenpage({ failIds = new Set(), rawIds = new Set(), delayMs = 0, hold } = {}) {
  const reads = [];
  const state = { inFlight: 0, peak: 0 };
  return {
    reads,
    state,
    enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
    read: async (id) => {
      reads.push(id);
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (hold) await hold;
        if (failIds.has(String(id).toLowerCase())) throw Object.assign(new Error(`page ${id} does not exist in this environment`), { code: 'GENPAGE_NOT_FOUND' });
        if (rawIds.has(String(id).toLowerCase())) throw Object.assign(new Error(`page ${id} has no source this tool can read`), { code: 'GENPAGE_NO_SOURCE' });
        return { id, name: 'Page', source: source(id) };
      } finally {
        state.inFlight -= 1;
      }
    },
  };
}

const readerWith = (genpage) => readerFor(stubSdk(), 'contoso_app', { genpage, workspaceDir: os.tmpdir() });

test('the code of several pages is read by id, each page answered with its own code', async () => {
  const genpage = fakeGenpage();
  const reader = readerWith(genpage);
  const ids = [1, 2, 3, 4, 5].map(pid);
  const answers = await reader.pageCodes(ids);
  assert.deepStrictEqual([...genpage.reads].sort(), [...ids].sort(), 'every id read once');
  assert.deepStrictEqual([...answers.keys()], ids);
  const single = readerWith(fakeGenpage());
  for (const id of ids) {
    assert.deepStrictEqual(answers.get(id), { code: source(id) });
    assert.strictEqual(answers.get(id).code, await single.pageCode(id), 'byte-for-byte the code the one-page reader returns');
  }
});

test('a long list is read a few pages at a time — never more than four in flight — and every id exactly once', async () => {
  for (const count of [1, 4, 5, 26, 60]) {
    const genpage = fakeGenpage({ delayMs: 2 });
    const ids = Array.from({ length: count }, (_, n) => pid(n + 1));
    const answers = await readerWith(genpage).pageCodes(ids);
    assert.ok(genpage.state.peak <= 4, `${count} ids: ${genpage.state.peak} reads at once`);
    if (count >= 4) assert.strictEqual(genpage.state.peak, 4, `${count} ids: the reads overlap`);
    assert.deepStrictEqual([...genpage.reads].sort(), [...ids].sort(), `${count} ids: every id once`);
    assert.strictEqual(answers.size, count);
    for (const id of ids) assert.deepStrictEqual(answers.get(id), { code: source(id) });
  }
});

test('a page is found by the id it was asked for, whatever the case, and never from another page\'s source', async () => {
  const genpage = fakeGenpage();
  const ids = [1, 2, 3].map(pid);
  const answers = await readerWith(genpage).pageCodes(ids.map((id) => id.toUpperCase()));
  assert.deepStrictEqual([...answers.keys()], ids, 'answers are keyed by the lower-cased id');
  for (const id of ids) assert.deepStrictEqual(answers.get(id), { code: source(id.toUpperCase()) });
  assert.ok([...answers.entries()].every(([id, a]) => a.code === source(id)), 'each answer is its own page\'s source');
});

test('a page the backend cannot read costs its own miss — the neighbours are answered — and the miss carries what the one-page read throws', async () => {
  const bad = pid(2);
  const genpage = fakeGenpage({ failIds: new Set([bad]) });
  const reader = readerWith(genpage);
  const answers = await reader.pageCodes([pid(1), bad, pid(3)]);
  assert.deepStrictEqual(answers.get(pid(1)), { code: source(pid(1)) });
  assert.deepStrictEqual(answers.get(pid(3)), { code: source(pid(3)) });
  const alone = await reader.pageCode(bad).then(() => null, (e) => e);
  assert.ok(answers.get(bad).error instanceof Error);
  assert.strictEqual(answers.get(bad).error.message, alone.message);
  assert.strictEqual(answers.get(bad).error.code, 'GENPAGE_NOT_FOUND');
});

test('a page the SDK holds as raw files is a MISS, never empty code that a page check would read as "no navigation"', async () => {
  const raw = pid(3);
  const reader = readerWith(fakeGenpage({ rawIds: new Set([raw]) }));
  const answers = await reader.pageCodes([pid(1), raw]);
  assert.deepStrictEqual(answers.get(pid(1)), { code: source(pid(1)) });
  assert.ok(answers.get(raw).error instanceof Error);
  assert.strictEqual(answers.get(raw).error.code, 'GENPAGE_NO_SOURCE');
  assert.ok(!('code' in answers.get(raw)));
  await assert.rejects(reader.pageCode(raw), (e) => e.code === 'GENPAGE_NO_SOURCE');
});

test('pages already read are not read again, and a duplicate in the list is read once', async () => {
  const genpage = fakeGenpage();
  const reader = readerWith(genpage);
  await reader.pageCode(pid(1));
  const answers = await reader.pageCodes([pid(1), pid(2), pid(3), pid(2).toUpperCase(), pid(3)]);
  assert.deepStrictEqual([...genpage.reads].sort(), [pid(1), pid(2), pid(3)].sort());
  assert.strictEqual(answers.size, 3);
  await reader.pageCodes([pid(3), pid(2), pid(1)]);
  assert.strictEqual(genpage.reads.length, 3, 'asked again: answered from what was read');
});

test('once a pass ends its page reads none starts until the next pass begins — a read that is still to start is refused, not made behind the pass', async () => {
  const genpage = fakeGenpage();
  const reader = readerWith(genpage);
  await reader.endPageReads();
  await assert.rejects(reader.pageCode(pid(1)), /page reads were ended/);
  await assert.rejects(reader.existenceIds(), /page reads were ended/);
  const answers = await reader.pageCodes([pid(1)]);
  assert.match(answers.get(pid(1)).error.message, /page reads were ended/, 'a batch reports the same miss for each page it was asked for');
  assert.deepStrictEqual(genpage.reads, [], 'nothing was read');
  reader.beginVerificationPass();
  assert.deepStrictEqual(await reader.pageCode(pid(1)), source(pid(1)), 'the next pass reads again');
});

// The read is held open until the test lets it go, so "endPageReads did not wait for it" is proven by order, not by a clock: the
// earlier form (a 20 ms read, endPageReads back within 15 ms) failed on a loaded machine. The 5 s race only turns a regression —
// endPageReads waiting for the read, which never ends while it is held — into a failure instead of a hang.
test('ending the reads never waits for, or cancels, a read in flight — it is a request, and finishes by itself', async () => {
  let release;
  const genpage = fakeGenpage({ hold: new Promise((resolve) => { release = resolve; }) });
  const reader = readerWith(genpage);
  const reading = reader.pageCode(pid(1));
  let readSettled = false;
  reading.then(() => { readSettled = true; }, () => { readSettled = true; });
  let timer;
  const stillWaiting = new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), 5000); });
  try {
    assert.strictEqual(await Promise.race([reader.endPageReads().then(() => 'ended'), stillWaiting]), 'ended', 'endPageReads does not wait for the read');
  } finally {
    clearTimeout(timer);
  }
  assert.strictEqual(readSettled, false, 'the read was still in flight when the reads were ended');
  release();
  assert.strictEqual(await reading, source(pid(1)), 'the read in flight finishes');
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
  assert.deepStrictEqual(perPage.calls.pageCode, [pid(0), pid(1), pid(3)], 'one read per page before');
  assert.deepStrictEqual(batched.calls.pageCodes, [[pid(0), pid(1), pid(3)]], 'one batch: deployed pages with navigation, once each, in spec order');
  assert.deepStrictEqual(batched.calls.pageCode, [], 'and no per-page run');
  assert.deepStrictEqual(after, before);
  assert.ok(after.checks.some((c) => c.kind === 'page-nav' && c.present) && after.checks.some((c) => c.kind === 'page-nav' && !c.present), 'the fixture reports passes and failures');
});

test('a page whose code could not be read is the same page-code miss with or without the batch', async () => {
  const failing = { [pid(1)]: 'page was not found' };
  const before = await verifySpec(pagesSpec(), pageReader({ failing }).read);
  const after = await verifySpec(pagesSpec(), pageReader({ batch: true, failing }).read);
  assert.deepStrictEqual(after, before);
  assert.deepStrictEqual(after.checks.filter((c) => c.kind === 'page-code').map((c) => [c.name, c.present, c.detail]), [['Page 1', false, 'page was not found']]);
});

test('a reader whose pageCodes fails outright is asked page by page — the report is unchanged', async () => {
  const before = await verifySpec(pagesSpec(), pageReader().read);
  const broken = pageReader({ batch: true, pageCodesThrows: true });
  const after = await verifySpec(pagesSpec(), broken.read);
  assert.deepStrictEqual(after, before);
  assert.deepStrictEqual(broken.calls.pageCode, [pid(0), pid(1), pid(3)]);
});

test('a single page with navigation is the one-page read — no batch', async () => {
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
  assert.ok(overlapped.existence < overlapped.lastEntityRead, `the page listing started at read ${overlapped.existence}, before the entity checks were through (${overlapped.lastEntityRead})`);
  const sequential = await order(1);
  assert.ok(sequential.existence > sequential.lastEntityRead, 'one at a time it is made where the page checks come, after the entity checks');
});

test('a failed page-authority read ends the pass with the same error wherever it happened, and an earlier failure outranks it', async () => {
  const boom = new Error('the page listing failed');
  const failingListing = (extra = {}) => ({ ...pageReader({ batch: true }).read, existenceIds: async () => { throw boom; }, ...extra });
  for (const concurrency of [1, 4]) {
    await assert.rejects(verifySpec(pagesSpec(), failingListing(), { concurrency }), (e) => e === boom, `width ${concurrency}`);
  }
  const entityFails = failingListing({ findColumns: async () => { throw new Error('entity read failed'); } });
  for (const concurrency of [1, 4]) {
    await assert.rejects(verifySpec(pagesSpec(), entityFails, { concurrency }), /entity read failed/, `width ${concurrency}`);
  }
});
