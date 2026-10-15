'use strict';
// A page's key is its identity in a rebuild. A spec that was deployed to another environment holds no page ids (they belong to the
// environment it was downloaded from), so the environment it was deployed to binds each key to the page it created there, through
// the page manifest it keeps. If a later download of the same app gave a page another key, that environment would update a different
// page with this page's content: the build succeeds, the verifier passes, and two pages have swapped what they hold.
//
// So a key may never depend on the order pages are read or written in. It comes, in this order, from:
//   1. the page manifest the app carries (the key it binds to the page's id: the authority, as before);
//   2. the app-spec.json an earlier download of the same app left in the output folder (the page's id, read again, is the same page);
//   3. a fresh slug of the page's name, for a page with neither — and when two new pages make one slug, the lower page id gets the
//      plain slug and the other `-2`. The id, never the name: a page's name can be renamed or share a slug with another.
// The order the pages are WRITTEN in (by name, then id) is computed separately and decides no key.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDownload, assignPageKeys, readPreviousPageKeys, parseDownloadedPages } = require('../download-model-app.js');
const { currentReadSdk } = require('./helpers/app-membership-sdk.js');
const { fakeGenpage } = require('./helpers/fake-genpage.js');

const g = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const APP_ID = g('a1b2c3d4', 1);
const LAYER = g('c0ffee00', 1);
const SITEMAP_ID = g('5111e0f2', 1);
const SOLUTION_ID = g('6111e0f2', 1);
const APP_UNIQUE = 'test_keys';
// Two names, one slug (`work-order`): the name order ('Work Order' first: a space sorts before an underscore) is the reverse of the id order.
const LOW = g('10000000', 1);
const HIGH = g('f0000000', 1);
const LOW_PAGE = { pageId: LOW, name: 'Work_Order' };
const HIGH_PAGE = { pageId: HIGH, name: 'Work Order' };

// The page's own name in its source tells the pages apart. It holds no page id: a download reports one it finds in a page's source as a navigation id it left there.
const sourceOf = (page) => `export default function Page() { return ${JSON.stringify(page.name)}; }\n`;

// An app whose navigation holds exactly `pages` (and no table), served through the stand-in SDK the download tests use.
function pagesSdk(pages, { manifest } = {}) {
  const xml = `<SiteMap><Area Id="A"><Group Id="G">${pages.map((p, i) => `<SubArea Id="p${i}" GenPageId="${p.pageId}" Title="Title ${i}"/>`).join('')}</Group></Area></SiteMap>`;
  const sdk = {
    fetchArtifact: async () => ({
      name: 'Keys App', description: '',
      siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: pages.map((p, i) => ({ type: 'GenPage', genPageId: p.pageId, title: `Title ${i}` })) }] }] },
    }),
    queryRecords: async (logical, opts) => {
      const filter = (opts && opts.filter) || '';
      switch (logical) {
        case 'appmodule': return [{ appmoduleid: APP_ID, appmoduleidunique: LAYER, uniquename: APP_UNIQUE }];
        case 'appmodulecomponent': return /componenttype eq 62/.test(filter) ? [{ objectid: SITEMAP_ID, componenttype: 62 }] : [];
        case 'sitemap': return [{ sitemapxml: xml }];
        case 'webresource': return manifest ? [{ content: Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64') }] : [];
        case 'solutioncomponent': return filter === `objectid eq ${APP_ID}` ? [{ _solutionid_value: SOLUTION_ID }] : [];
        case 'solution':
          return /solutionid eq/.test(filter)
            ? [{ solutionid: SOLUTION_ID, uniquename: 'ContosoSln', ismanaged: false, description: '' }]
            : [{ solutionid: SOLUTION_ID }];
        default: return [];
      }
    },
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, schemaName: logical, displayName: logical, primaryNameAttribute: 'contoso_name', attributes: [] }),
    dataverse: { get: async () => ({ status: 200, headers: {}, body: { value: [] } }) },
  };
  return currentReadSdk(sdk, { appId: APP_ID, layerId: LAYER, sitemapXml: xml });
}

// The spec an earlier download left in the folder: what matters of it is the app it describes and each page's id and key.
const earlierSpec = (pages, { uniqueName = APP_UNIQUE } = {}) => ({
  schemaVersion: 2,
  app: { name: 'Keys App', ...(uniqueName === undefined ? {} : { uniqueName }) },
  pages: pages.map((p) => ({ key: p.key, name: p.name, pageId: p.pageId, source: { kind: 'tsx', codeFile: `pages/${p.pageId}/page.tsx` } })),
});

// Runs one download into `out` (made, and removed, by the caller), answering the pages through the stand-in page backend. Returns the
// result and what the download said on stderr.
async function download(out, pages, options = {}) {
  const stderr = [];
  const realWrite = process.stderr.write;
  try {
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
    const genpage = fakeGenpage({ pages: pages.map((p) => ({ ...p, source: sourceOf(p) })) });
    const res = await runDownload({ sdk: pagesSdk(pages, options), genpage, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE });
    assert.ok(res.ok, JSON.stringify(res));
    return { res, stderr: stderr.join('') };
  } finally {
    process.stderr.write = realWrite;
  }
}

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const keysOf = (res) => Object.fromEntries(res.spec.pages.map((p) => [p.pageId, p.key]));
const idsOf = (pages) => pages.map((p) => ({ ...p, dataSources: [], codeFile: `pages/${p.pageId}/page.tsx` }));

// ── the keys of a download that has an earlier download beside it ────────────────────────────────────────────────────────────────

// Two earlier downloads of one app. One was made on a file system that lists the page folders by name (NTFS, HFS+: the id order, since the folders are named by
// GUID), so the lower id has the plain slug. One was made on a file system that lists them in another order (ext4's hash order): the plain slug is the other page's.
// Neither is the other's, and a re-download must keep whichever it finds. Minting afresh by id gives the first and never the second.
const EARLIER = {
  'in id order': { [LOW]: 'work-order', [HIGH]: 'work-order-2' },
  'in another order': { [LOW]: 'work-order-2', [HIGH]: 'work-order' },
};
const earlierFile = (keyOfId) => JSON.stringify(earlierSpec([{ ...LOW_PAGE, key: keyOfId[LOW] }, { ...HIGH_PAGE, key: keyOfId[HIGH] }]));

for (const [label, keyOfId] of Object.entries(EARLIER)) {
  test(`a re-download into the folder of an earlier one keeps every page's key, though the names now sort the other way (earlier download ${label})`, async (t) => {
    const out = folder(t);
    fs.writeFileSync(path.join(out, 'app-spec.json'), earlierFile(keyOfId));
    const { res, stderr } = await download(out, [LOW_PAGE, HIGH_PAGE]);
    assert.deepStrictEqual(keysOf(res), keyOfId, 'each page keeps the key the earlier download gave it');
    // The keys follow the page ids; the order the pages are written in follows their names ('Work Order' < 'Work_Order'). Neither decides the other.
    assert.deepStrictEqual(res.spec.pages.map((p) => [p.name, p.key]), [['Work Order', keyOfId[HIGH]], ['Work_Order', keyOfId[LOW]]]);
    assert.doesNotMatch(stderr, /different key/, 'nothing moved, so nothing is said');
    // The appShell points at the keys, so the navigation still reaches the same pages, in the sitemap's order.
    const targets = res.spec.appShell.areas[0].groups[0].subAreas.map((s) => s.page);
    assert.deepStrictEqual(targets, [keyOfId[LOW], keyOfId[HIGH]]);
  });
}

test('the same re-download gives the same keys whatever order the pages folder is listed in or the backend answers in', async (t) => {
  const real = fs.readdirSync;
  for (const [label, keyOfId] of Object.entries(EARLIER)) {
    const results = [];
    for (const [pages, listing] of [[[LOW_PAGE, HIGH_PAGE], (names) => names], [[HIGH_PAGE, LOW_PAGE], (names) => [...names].reverse()]]) {
      const out = folder(t);
      fs.writeFileSync(path.join(out, 'app-spec.json'), earlierFile(keyOfId));
      fs.readdirSync = (target, ...rest) => {
        const names = real(target, ...rest);
        return path.basename(String(target)) === 'pages' && Array.isArray(names) ? listing(names) : names;
      };
      try { results.push((await download(out, pages)).res); } finally { fs.readdirSync = real; }
    }
    assert.deepStrictEqual(keysOf(results[1]), keysOf(results[0]), label);
    assert.deepStrictEqual(keysOf(results[0]), keyOfId, label);
  }
});

test('a download into an empty folder gives the keys an earlier release gave: the plain slug of the name, and for two names that make one slug the plain one to the lower page id', async (t) => {
  const out = folder(t);
  const pages = [
    { pageId: g('90000000', 1), name: 'Archive Notes' }, { pageId: g('50000000', 1), name: 'Dashboard' },
    LOW_PAGE, HIGH_PAGE, { pageId: g('30000000', 1), name: 'KPI / Analytics' },
  ];
  const { res } = await download(out, pages);
  // An earlier release minted in the order the file system listed the folders, which on NTFS (and HFS+) is the id order: the same as this rule, so a spec
  // that was downloaded then and deployed elsewhere gets the keys it was built with.
  const earlier = (list) => {
    const used = new Set();
    return Object.fromEntries([...list].sort((a, b) => (a.pageId < b.pageId ? -1 : 1)).map((p) => {
      const base = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
      let key = base;
      for (let n = 2; used.has(key); n += 1) key = `${base}-${n}`;
      used.add(key);
      return [p.pageId, key];
    }));
  };
  assert.deepStrictEqual(keysOf(res), earlier(pages));
  assert.deepStrictEqual(keysOf(res), {
    [g('90000000', 1)]: 'archive-notes', [g('50000000', 1)]: 'dashboard', [LOW]: 'work-order', [HIGH]: 'work-order-2', [g('30000000', 1)]: 'kpi-analytics',
  });
});

test('a page the earlier download did not know is minted after the kept keys, and cannot take one an existing page holds', async (t) => {
  const out = folder(t);
  fs.writeFileSync(path.join(out, 'app-spec.json'), JSON.stringify(earlierSpec([{ ...LOW_PAGE, key: 'work-order' }, { ...HIGH_PAGE, key: 'work-order-2' }])));
  // New in the app, with the LOWEST id of all and a name of the same slug: it would have been the plain `work-order` if keys were minted afresh.
  const added = { pageId: g('00000000', 1), name: 'work-order' };
  const { res } = await download(out, [LOW_PAGE, HIGH_PAGE, added]);
  assert.deepStrictEqual(keysOf(res), { [LOW]: 'work-order', [HIGH]: 'work-order-2', [added.pageId]: 'work-order-3' });
});

test('a page the app lost does not keep its key for another: a new page of the same name is minted the plain slug again', async (t) => {
  const out = folder(t);
  fs.writeFileSync(path.join(out, 'app-spec.json'), JSON.stringify(earlierSpec([{ ...LOW_PAGE, key: 'work-order' }, { ...HIGH_PAGE, key: 'work-order-2' }])));
  // LOW is gone from the app; a new page of the same name has taken its place. The key was LOW's (a page that no longer exists), not a reservation.
  const replacement = { pageId: g('20000000', 1), name: 'Work Order' };
  const { res } = await download(out, [HIGH_PAGE, replacement]);
  assert.deepStrictEqual(keysOf(res), { [HIGH]: 'work-order-2', [replacement.pageId]: 'work-order' });
});

test('the page manifest still outranks the earlier download, and a key the manifest binds is not given to another page', async (t) => {
  const out = folder(t);
  // The earlier download says LOW is `work-order` and HIGH `work-order-2`; the manifest the app carries says the opposite for LOW and nothing about HIGH.
  fs.writeFileSync(path.join(out, 'app-spec.json'), JSON.stringify(earlierSpec([{ ...LOW_PAGE, key: 'work-order' }, { ...HIGH_PAGE, key: 'work-order-2' }])));
  const manifest = { schemaVersion: 1, pages: [{ key: 'work-order-2', name: 'Work_Order', pageId: LOW }] };
  const { res, stderr } = await download(out, [LOW_PAGE, HIGH_PAGE], { manifest });
  // LOW is bound by the manifest to `work-order-2`. HIGH's kept key `work-order-2` is taken, so HIGH is minted afresh: `work-order`, the slug of its name.
  assert.deepStrictEqual(keysOf(res), { [LOW]: 'work-order-2', [HIGH]: 'work-order' });
  // Both keys moved, and a copy of the earlier spec deployed elsewhere would now update the other page: said, with the pages and both keys.
  assert.match(stderr, /WARNING: 2 page\(s\) have a different key than in the app-spec\.json this download replaces/);
  assert.match(stderr, /"Work_Order" \(work-order -> work-order-2\)/);
  assert.match(stderr, /"Work Order" \(work-order-2 -> work-order\)/);
});

test('the earlier spec of ANOTHER app is not read, and an unreadable one is said, not guessed at', async (t) => {
  const other = folder(t);
  // Keys the other app gave the same two page ids, the opposite of what minting by id gives.
  fs.writeFileSync(path.join(other, 'app-spec.json'), JSON.stringify(earlierSpec([{ ...LOW_PAGE, key: 'work-order-2' }, { ...HIGH_PAGE, key: 'work-order' }], { uniqueName: 'Another_App' })));
  const { res: another, stderr: quiet } = await download(other, [LOW_PAGE, HIGH_PAGE]);
  // Minted afresh: the other app's page keys say nothing of this one's, and a spec of another app is no error.
  assert.deepStrictEqual(keysOf(another), { [LOW]: 'work-order', [HIGH]: 'work-order-2' });
  assert.doesNotMatch(quiet, /app-spec\.json/);

  const broken = folder(t);
  fs.writeFileSync(path.join(broken, 'app-spec.json'), '{ this is not json');
  const { res, stderr } = await download(broken, [LOW_PAGE, HIGH_PAGE]);
  assert.deepStrictEqual(keysOf(res), { [LOW]: 'work-order', [HIGH]: 'work-order-2' });
  assert.match(stderr, /WARNING: the app-spec\.json in .* could not be read \(.*\), so the page keys of an earlier download were not kept/);
});

// ── the pieces ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('assignPageKeys: a page keeps the key of an earlier download by its id, and only new pages are minted, by id', () => {
  const pages = (order) => order.map((p) => ({ ...p, dataSources: [], codeFile: p.pageId }));
  const extra = { pageId: g('50000000', 1), name: 'work order' }; // a new page of the same slug, between the two ids
  const previous = new Map([[LOW, 'work-order'], [HIGH, 'work-order-2']]);
  const forward = pages([LOW_PAGE, HIGH_PAGE, extra]);
  const backward = pages([extra, HIGH_PAGE, LOW_PAGE]);
  for (const list of [forward, backward]) assignPageKeys(list, null, new Map(), previous);
  const keys = (list) => Object.fromEntries(list.map((p) => [p.pageId, p.key]));
  assert.deepStrictEqual(keys(forward), { [LOW]: 'work-order', [HIGH]: 'work-order-2', [extra.pageId]: 'work-order-3' });
  assert.deepStrictEqual(keys(backward), keys(forward), 'the order the pages arrive in decides nothing');
});

test('assignPageKeys: new pages that make one slug are minted by page id, not by name or arrival', () => {
  // Names in the order Work Order < Work_Order < work-order (lower-cased: a space, then a hyphen, then an underscore); ids in the reverse order.
  const make = () => [
    { pageId: g('10000000', 1), name: 'work-order', dataSources: [], codeFile: 'a' },
    { pageId: g('50000000', 1), name: 'Work_Order', dataSources: [], codeFile: 'b' },
    { pageId: g('f0000000', 1), name: 'Work Order', dataSources: [], codeFile: 'c' },
  ];
  const forward = make();
  const backward = make().reverse();
  assignPageKeys(forward, null, new Map());
  assignPageKeys(backward, null, new Map());
  const keys = (list) => Object.fromEntries(list.map((p) => [p.pageId, p.key]));
  assert.deepStrictEqual(keys(forward), { [g('10000000', 1)]: 'work-order', [g('50000000', 1)]: 'work-order-2', [g('f0000000', 1)]: 'work-order-3' });
  assert.deepStrictEqual(keys(backward), keys(forward));
});

test('assignPageKeys: a previous key that two pages claim goes to the lower page id, whichever page arrives first, and ids are compared without case', () => {
  const a = { pageId: g('10000000', 1).toUpperCase(), name: 'Alpha', dataSources: [], codeFile: 'a' };
  const b = { pageId: g('20000000', 1), name: 'Beta', dataSources: [], codeFile: 'b' };
  // The map is keyed by lower-cased id, as a download reads ids; both pages claim `shared` (readPreviousPageKeys never hands over such a map).
  const previous = new Map([[g('10000000', 1), 'shared'], [g('20000000', 1), 'shared']]);
  for (const order of [[a, b], [b, a]]) {
    const list = order.map((p) => ({ ...p }));
    assignPageKeys(list, null, new Map(), previous);
    const keys = Object.fromEntries(list.map((p) => [p.name, p.key]));
    assert.deepStrictEqual(keys, { Alpha: 'shared', Beta: 'beta' });
  }
});

test('readPreviousPageKeys reads page id -> key of the same app, and nothing it cannot trust', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'app-spec.json');
  const write = (value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));

  // The usual case: ids are read without case; a page with no key or no id, or a key outside the key grammar, is skipped; the rest are kept.
  write({
    app: { uniqueName: APP_UNIQUE.toUpperCase() },
    pages: [
      { key: 'one', pageId: LOW.toUpperCase() }, { key: 'two', pageId: HIGH }, { key: 'no-id' }, { pageId: g('30000000', 1) },
      { key: 'Bad Key', pageId: g('40000000', 1) }, { key: 7, pageId: g('50000000', 1) }, null, 'text',
    ],
  });
  let read = readPreviousPageKeys(file, APP_UNIQUE);
  assert.strictEqual(read.problem, null);
  assert.deepStrictEqual([...read.keys], [[LOW, 'one'], [HIGH, 'two']]);

  // A spec that names no app (a hand-authored one) is read; one that names another app is not.
  write({ pages: [{ key: 'one', pageId: LOW }] });
  assert.deepStrictEqual([...readPreviousPageKeys(file, APP_UNIQUE).keys], [[LOW, 'one']]);
  write({ app: { uniqueName: 'other_app' }, pages: [{ key: 'one', pageId: LOW }] });
  assert.deepStrictEqual([...readPreviousPageKeys(file, APP_UNIQUE).keys], []);

  // A key claimed by two pages, or a page given two keys, is ambiguous: nothing is kept for either.
  write({ pages: [{ key: 'one', pageId: LOW }, { key: 'one', pageId: HIGH }, { key: 'solo', pageId: g('30000000', 1) }, { key: 'x', pageId: g('40000000', 1) }, { key: 'y', pageId: g('40000000', 1) }] });
  assert.deepStrictEqual([...readPreviousPageKeys(file, APP_UNIQUE).keys], [[g('30000000', 1), 'solo']]);

  // Absent is no problem; present and unreadable is one; a BOM (an editor's) is not.
  fs.rmSync(file);
  assert.deepStrictEqual(readPreviousPageKeys(file, APP_UNIQUE), { keys: new Map(), problem: null });
  write('{ nope');
  read = readPreviousPageKeys(file, APP_UNIQUE);
  assert.strictEqual(read.keys.size, 0);
  assert.match(read.problem, /JSON|Expected|position/);
  write('\uFEFF' + JSON.stringify({ pages: [{ key: 'one', pageId: LOW }] }));
  assert.deepStrictEqual([...readPreviousPageKeys(file, APP_UNIQUE).keys], [[LOW, 'one']]);
  write('[1, 2]');
  assert.strictEqual(readPreviousPageKeys(file, APP_UNIQUE).keys.size, 0);
});

test('parseDownloadedPages still lists pages by name then id: the order they are written in is not the order keys are minted in', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-keys-parse-'));
  try {
    const names = new Map();
    for (const p of [LOW_PAGE, HIGH_PAGE]) {
      fs.mkdirSync(path.join(root, 'pages', p.pageId), { recursive: true });
      fs.writeFileSync(path.join(root, 'pages', p.pageId, 'page.tsx'), sourceOf(p));
      names.set(p.pageId, p.name);
    }
    const pages = parseDownloadedPages(path.join(root, 'pages'), root, names, [], []);
    assert.deepStrictEqual(pages.map((p) => [p.name, p.pageId]), [['Work Order', HIGH], ['Work_Order', LOW]]);
    // Minted from that very list, the plain slug would go to the first page written (HIGH, by name). It goes to the lower id.
    assignPageKeys(pages, null, new Map());
    assert.deepStrictEqual(pages.map((p) => [p.pageId, p.key]), [[HIGH, 'work-order-2'], [LOW, 'work-order']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assignPageKeys with no previous keys behaves as before for a page the manifest binds and for one it does not', () => {
  const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_X = '9f2b1a3c-77de-4a10-8b6e-2c4d5e6f7a8b';
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O, purpose: 'Home' }] };
  const pages = idsOf([{ pageId: GP_O, name: 'Overview' }, { pageId: GP_X, name: 'Some Legacy Page' }]);
  const idToKey = assignPageKeys(pages, manifest, new Map([['overview', GP_O]]));
  assert.deepStrictEqual(pages.map((p) => p.key), ['overview', 'some-legacy-page']);
  assert.strictEqual(pages[0].purpose, 'Home');
  assert.strictEqual(idToKey.get(GP_X), 'some-legacy-page');
  // An empty or missing previous map changes nothing.
  for (const previous of [undefined, null, new Map()]) {
    const again = idsOf([{ pageId: GP_O, name: 'Overview' }, { pageId: GP_X, name: 'Some Legacy Page' }]);
    assignPageKeys(again, manifest, new Map([['overview', GP_O]]), previous);
    assert.deepStrictEqual(again.map((p) => p.key), ['overview', 'some-legacy-page']);
  }
});
