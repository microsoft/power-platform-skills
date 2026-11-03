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
const { runDownload, assignPageKeys, readPreviousPageKeys, parseDownloadedPages, main } = require('../download-model-app.js');
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
  app: { name: 'Keys App', uniqueName },
  pages: pages.map((p) => ({ key: p.key, name: p.name, pageId: p.pageId, source: { kind: 'tsx', codeFile: `pages/${p.pageId}/page.tsx` } })),
});

// Runs one download into `out` (made, and removed, by the caller), answering the pages through the stand-in page backend. Returns what
// `runDownload` answered, what the download said on stderr and the page backend (to see what was read from it). `options.manifest` is the
// page manifest the app carries; `options.resetPageKeys` is the switch of the same name.
async function attempt(out, pages, options = {}) {
  const stderr = [];
  const realWrite = process.stderr.write;
  try {
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
    const genpage = fakeGenpage({ pages: pages.map((p) => ({ ...p, source: sourceOf(p) })) });
    const res = await runDownload({ sdk: pagesSdk(pages, options), genpage, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE, resetPageKeys: options.resetPageKeys });
    return { res, stderr: stderr.join(''), genpage };
  } finally {
    process.stderr.write = realWrite;
  }
}

// The same, for a download that must succeed.
async function download(out, pages, options = {}) {
  const done = await attempt(out, pages, options);
  assert.ok(done.res.ok, JSON.stringify(done.res));
  return done;
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

// A file whose app is not named is not this app's: a page id does not say which app a key belongs to — a page can be in several apps, each with
// its own page manifest and its own keys — so the id is matched only inside a spec that says the spec is of THIS app. `app.uniqueName` says it;
// an authored spec derives its identity from its publisher prefix and name (appUniqueName in lib/sdk-build.js) and carries none, and a hand-edited
// one can hold anything. None of these stands for "this app".
const WITHOUT_IDENTITY = {
  'no app.uniqueName, as in an authored spec': (spec) => { delete spec.app.uniqueName; spec.app.name = 'Other App'; },
  'a blank app.uniqueName': (spec) => { spec.app.uniqueName = '   '; },
  'a null app.uniqueName': (spec) => { spec.app.uniqueName = null; },
  'an app.uniqueName that is a number': (spec) => { spec.app.uniqueName = 12; },
  'an app.uniqueName that is a list holding this very name': (spec) => { spec.app.uniqueName = [APP_UNIQUE]; },
  'an app that is a text': (spec) => { spec.app = APP_UNIQUE; },
  'a null app': (spec) => { spec.app = null; },
  'no app at all': (spec) => { delete spec.app; },
};

for (const [label, withoutIdentity] of Object.entries(WITHOUT_IDENTITY)) {
  test(`an earlier spec that does not say which app it describes is not read, and the download says so (${label})`, async (t) => {
    const out = folder(t);
    // The keys another app (or an old copy) gave these two page ids: the opposite of what minting by page id gives.
    const foreign = earlierSpec([{ ...LOW_PAGE, key: 'work-order-2' }, { ...HIGH_PAGE, key: 'work-order' }]);
    withoutIdentity(foreign);
    fs.writeFileSync(path.join(out, 'app-spec.json'), JSON.stringify(foreign));
    const { res, stderr } = await download(out, [LOW_PAGE, HIGH_PAGE]);
    assert.deepStrictEqual(keysOf(res), { [LOW]: 'work-order', [HIGH]: 'work-order-2' }, 'minted afresh, by page id: the file\'s keys are another spec\'s');
    assert.ok(stderr.includes(`WARNING: the app-spec.json in ${out} does not say which app it describes`), `the warning names the file: ${stderr}`);
    assert.match(stderr, /so its page keys were not used as the earlier keys of this app/);
  });
}

test('a spec that does not say which app it describes is not reported when it holds no page keys to use, and one of this app\'s own is read whatever the case of its name', async (t) => {
  const quiet = folder(t);
  const keyless = earlierSpec([{ ...LOW_PAGE, key: 'work-order-2' }]);
  delete keyless.app.uniqueName;
  keyless.pages = [{ name: 'Work_Order' }, { key: 'no-id' }, { pageId: LOW }];
  fs.writeFileSync(path.join(quiet, 'app-spec.json'), JSON.stringify(keyless));
  const { stderr: said } = await download(quiet, [LOW_PAGE, HIGH_PAGE]);
  assert.doesNotMatch(said, /does not say which app/, 'nothing it holds could have been used, so there is nothing to say');

  const own = folder(t);
  fs.writeFileSync(path.join(own, 'app-spec.json'), JSON.stringify(earlierSpec([{ ...LOW_PAGE, key: 'work-order-2' }, { ...HIGH_PAGE, key: 'work-order' }], { uniqueName: ` ${APP_UNIQUE.toUpperCase()} ` })));
  const { res, stderr } = await download(own, [LOW_PAGE, HIGH_PAGE]);
  assert.deepStrictEqual(keysOf(res), { [LOW]: 'work-order-2', [HIGH]: 'work-order' }, 'Dataverse compares unique names without case, so this is the same app');
  assert.doesNotMatch(stderr, /app-spec\.json/);
});

// ── an earlier spec whose keys cannot be told apart ──────────────────────────────────────────────────────────────────────────

// A page's key was written by an earlier download of this app, and a hand edit has since left the file giving a key to two pages and a page two keys:
//   HIGH -> work-order     LOW -> work-order-2     LOW -> work-order (the edit)
// Which of these is what a copy deployed to another environment was built with is not in the file. Giving the pages fresh keys would exchange what two
// pages hold there, silently, so unless something else says which is right the download stops and says what to do. What else can say: the app's page
// manifest binds the page to a key (the authority), or the file's row is about a page the app no longer has.
const ambiguousSpec = () => {
  const spec = earlierSpec([{ ...LOW_PAGE, key: 'work-order-2' }, { ...HIGH_PAGE, key: 'work-order' }]);
  spec.pages.push({ ...spec.pages[0], key: 'work-order' });
  return spec;
};

test('a download refuses, before it writes anything, when the earlier spec gives its pages keys that cannot be told apart', async (t) => {
  const out = folder(t);
  const file = path.join(out, 'app-spec.json');
  const before = JSON.stringify(ambiguousSpec(), null, 2);
  fs.writeFileSync(file, before);
  const { res, genpage } = await attempt(out, [LOW_PAGE, HIGH_PAGE]);
  assert.strictEqual(res.ok, false, 'the download must not go on with keys it would have to guess');
  assert.strictEqual(res.code, 'page-keys-ambiguous');
  // It names the pages (with their ids) and the keys, and says how to go on: correct the file, or accept fresh keys.
  for (const part of ['"Work_Order"', LOW, '"Work Order"', HIGH, "'work-order'", "'work-order-2'", '--reset-page-keys', file]) {
    assert.ok(res.error.includes(part), `the refusal names ${part}: ${res.error}`);
  }
  assert.deepStrictEqual(res.pages.map((p) => [p.pageId, p.name]), [[HIGH, 'Work Order'], [LOW, 'Work_Order']]);
  // Nothing was changed: the file (the only record of the earlier keys), and no page folder, and no page was even read.
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(out), ['app-spec.json']);
  assert.strictEqual(genpage.of('read').length, 0);
});

test('the refusal also stops a file in which a page is given two keys, or two entries share a page id', async (t) => {
  const out = folder(t);
  const twoKeys = earlierSpec([{ ...LOW_PAGE, key: 'work-order' }, { ...LOW_PAGE, key: 'work-order-2' }, { ...HIGH_PAGE, key: 'other-order' }]);
  fs.writeFileSync(path.join(out, 'app-spec.json'), JSON.stringify(twoKeys));
  const { res } = await attempt(out, [LOW_PAGE, HIGH_PAGE]);
  assert.strictEqual(res.code, 'page-keys-ambiguous');
  assert.match(res.error, /"Work_Order" \(10000000-0000-4000-8000-000000000001\) is given 2 keys: 'work-order', 'work-order-2'/);
  assert.deepStrictEqual(res.pages.map((p) => p.pageId), [LOW], 'the page with one clear key is not named');

  const sameKey = folder(t);
  const twoPages = earlierSpec([{ ...LOW_PAGE, key: 'shared' }, { ...HIGH_PAGE, key: 'shared' }]);
  fs.writeFileSync(path.join(sameKey, 'app-spec.json'), JSON.stringify(twoPages));
  const { res: refused } = await attempt(sameKey, [LOW_PAGE, HIGH_PAGE]);
  assert.strictEqual(refused.code, 'page-keys-ambiguous');
  assert.match(refused.error, /the key 'shared' is given to 2 pages: "Work Order" \(f0000000-0000-4000-8000-000000000001\), "Work_Order" \(10000000-0000-4000-8000-000000000001\)/);
});

test('with --reset-page-keys the pages whose keys cannot be told apart are given fresh keys by page id, and the download says which', async (t) => {
  const out = folder(t);
  fs.writeFileSync(path.join(out, 'app-spec.json'), JSON.stringify(ambiguousSpec()));
  const { res, stderr } = await download(out, [LOW_PAGE, HIGH_PAGE], { resetPageKeys: true });
  assert.deepStrictEqual(keysOf(res), { [LOW]: 'work-order', [HIGH]: 'work-order-2' }, 'minted afresh, in page-id order');
  assert.match(stderr, /WARNING: --reset-page-keys: 2 page\(s\) were given a fresh key because the app-spec\.json in .* gave them keys that cannot be told apart/);
  assert.match(stderr, /"Work_Order" \(work-order\)/);
  assert.match(stderr, /"Work Order" \(work-order-2\)/);
  assert.ok(fs.existsSync(path.join(out, 'pages', LOW, 'page.tsx')) && fs.existsSync(path.join(out, 'pages', HIGH, 'page.tsx')), 'the pages are written');
});

test('only the pages whose earlier keys cannot be told apart are named, and only they are re-keyed: a clear key is kept, and the manifest outranks the file', async (t) => {
  // Alpha: one clear key in the file. Beta and Gamma: the file gives both `shared`. Delta: the page manifest binds it, and the file gives it two keys.
  const [alpha, beta, gamma, delta] = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name, i) => ({ pageId: g(`${i + 1}0000000`, 1), name }));
  const earlier = earlierSpec([{ ...alpha, key: 'kept-a' }, { ...beta, key: 'shared' }, { ...gamma, key: 'shared' }, { ...delta, key: 'd-one' }, { ...delta, key: 'd-two' }]);
  const manifest = { schemaVersion: 1, pages: [{ key: 'from-manifest', name: 'Delta', pageId: delta.pageId }] };
  const pages = [alpha, beta, gamma, delta];

  const stopped = folder(t);
  fs.writeFileSync(path.join(stopped, 'app-spec.json'), JSON.stringify(earlier));
  const { res: refused } = await attempt(stopped, pages, { manifest });
  assert.strictEqual(refused.code, 'page-keys-ambiguous');
  assert.deepStrictEqual(refused.pages.map((p) => p.name), ['Beta', 'Gamma'], 'a page with a clear key, and one the manifest binds, are not part of it');
  assert.doesNotMatch(refused.error.split(stopped).join(''), /Alpha|Delta|kept-a|d-one|from-manifest/);

  const reset = folder(t);
  fs.writeFileSync(path.join(reset, 'app-spec.json'), JSON.stringify(earlier));
  const { res, stderr } = await download(reset, pages, { manifest, resetPageKeys: true });
  assert.deepStrictEqual(keysOf(res), { [alpha.pageId]: 'kept-a', [beta.pageId]: 'beta', [gamma.pageId]: 'gamma', [delta.pageId]: 'from-manifest' });
  assert.match(stderr, /--reset-page-keys: 2 page\(s\)/);
  assert.doesNotMatch(stderr.split(reset).join(''), /Alpha|Delta/, 'the others are not mentioned');
});

test('a manifest that binds every page makes the file\'s ambiguity moot, and a flag nobody needs changes nothing', async (t) => {
  const manifest = { schemaVersion: 1, pages: [{ key: 'm-low', name: 'Work_Order', pageId: LOW }, { key: 'm-high', name: 'Work Order', pageId: HIGH }] };
  for (const resetPageKeys of [false, true]) {
    const out = folder(t);
    fs.writeFileSync(path.join(out, 'app-spec.json'), JSON.stringify(ambiguousSpec()));
    const { res, stderr } = await download(out, [LOW_PAGE, HIGH_PAGE], { manifest, resetPageKeys });
    assert.deepStrictEqual(keysOf(res), { [LOW]: 'm-low', [HIGH]: 'm-high' });
    assert.doesNotMatch(stderr, /reset-page-keys|cannot be told apart/);
  }
  // And with nothing ambiguous, the flag is not an instruction to forget the earlier keys.
  const clear = folder(t);
  fs.writeFileSync(path.join(clear, 'app-spec.json'), earlierFile(EARLIER['in another order']));
  const { res, stderr } = await download(clear, [LOW_PAGE, HIGH_PAGE], { resetPageKeys: true });
  assert.deepStrictEqual(keysOf(res), EARLIER['in another order']);
  assert.doesNotMatch(stderr, /reset-page-keys/);
});

test('rows about pages the app no longer has never stop a download, and never void the clear key of a page it has', async (t) => {
  const gone = [g('90000000', 1), g('90000000', 2), g('90000000', 3)];
  const out = folder(t);
  // Duplicates among pages that are gone; and one of them shares the key of LOW, which is still there.
  const earlier = earlierSpec([
    { ...LOW_PAGE, key: 'custom-key' },
    { pageId: gone[0], name: 'Gone 1', key: 'dup' }, { pageId: gone[1], name: 'Gone 2', key: 'dup' },
    { pageId: gone[2], name: 'Gone 3', key: 'custom-key' }, { pageId: gone[2], name: 'Gone 3', key: 'another' },
  ]);
  fs.writeFileSync(path.join(out, 'app-spec.json'), JSON.stringify(earlier));
  const { res, stderr } = await download(out, [LOW_PAGE, HIGH_PAGE]);
  assert.deepStrictEqual(keysOf(res), { [LOW]: 'custom-key', [HIGH]: 'work-order' }, 'LOW keeps its key; HIGH, new to the file, is minted afresh');
  assert.doesNotMatch(stderr, /reset-page-keys|cannot be told apart|app-spec\.json/);
});

// ── the switch on the command line ───────────────────────────────────────────────────────────────────────────────────────────

// `main` with every side effect replaced: what it asked `runDownload` for, what it printed and with which exit status.
async function cli(argv, runDownloadAnswer) {
  const asked = [];
  const emitted = [];
  const said = [];
  let exited = null;
  await main({
    argv,
    stderr: { write: (text) => { said.push(String(text)); return true; } },
    exit: (code) => { exited = code; },
    emitResult: (ok, payload) => emitted.push({ ok, payload }),
    preflightAuth: async () => ({ ok: true }),
    makeDownloadSdk: async () => ({ sdk: { queryRecords: async () => [{ uniquename: APP_UNIQUE }] }, cleanup() {} }),
    makeGenpageSdk: () => ({}),
    runDownload: async (args) => { asked.push(args); return runDownloadAnswer; },
  });
  return { asked, emitted, said: said.join(''), exited };
}

test('--reset-page-keys is a switch of the download: off unless it is given, and given it reaches the download', async (t) => {
  const out = folder(t);
  const base = ['--env', 'https://contoso.crm.dynamics.com', '--app', APP_ID, '--out', out];
  const refusal = { ok: false, code: 'page-keys-ambiguous', error: 'refused', pages: [] };
  const plain = await cli(base, refusal);
  assert.strictEqual(plain.asked.length, 1);
  assert.strictEqual(plain.asked[0].resetPageKeys, false);
  const reset = await cli([...base, '--reset-page-keys'], refusal);
  assert.strictEqual(reset.asked[0].resetPageKeys, true);
  assert.strictEqual(reset.exited, null, 'a known switch is no usage error');
  // The refusal is the download's answer, printed as it is: the code and the pages are in the JSON a caller reads.
  assert.deepStrictEqual(plain.emitted, [{ ok: false, payload: refusal }]);
});

test('the usage line names --reset-page-keys, and a misspelling of it is a usage error that suggests it', async () => {
  const bare = await cli([], { ok: true });
  assert.match(bare.said, /Usage: node download-model-app\.js --env <url> --app <appId\|uniqueName\|displayName> --out <dir> \[--allow-lossy-download\] \[--reset-page-keys\]/);
  const typo = await cli(['--env', 'x', '--app', 'y', '--reset-page-key'], { ok: true });
  assert.strictEqual(typo.exited, 1);
  assert.match(typo.said, /--reset-page-key \(did you mean --reset-page-keys\?\)/);
  assert.strictEqual(typo.asked.length, 0);
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
  const own = { uniqueName: APP_UNIQUE };

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
  assert.deepStrictEqual(read.conflicts, []);

  // Only a spec that says it is of this app is read. One that names another app is not, and no more is one that names none: a hand-authored spec,
  // a null, a blank or a mistyped name do not stand for this app. The second kind is reported (`unidentified`) when it held keys that could have been used.
  write({ app: { uniqueName: 'other_app' }, pages: [{ key: 'one', pageId: LOW }] });
  read = readPreviousPageKeys(file, APP_UNIQUE);
  assert.deepStrictEqual([[...read.keys], read.unidentified], [[], false]);
  for (const app of [undefined, null, 'text', {}, { uniqueName: null }, { uniqueName: '' }, { uniqueName: ' ' }, { uniqueName: 7 }, { uniqueName: [APP_UNIQUE] }, { uniqueName: { name: APP_UNIQUE } }]) {
    write({ app, pages: [{ key: 'one', pageId: LOW }] });
    read = readPreviousPageKeys(file, APP_UNIQUE);
    assert.deepStrictEqual([[...read.keys], read.unidentified, read.problem], [[], true, null], JSON.stringify(app));
  }
  write({ app: {}, pages: [{ key: 'one' }, { pageId: LOW }] });
  assert.deepStrictEqual([readPreviousPageKeys(file, APP_UNIQUE).keys.size, readPreviousPageKeys(file, APP_UNIQUE).unidentified], [0, false], 'nothing in it could have been used');
  // Nor is a file read when the app it would be read for has no name to compare with — and then what is missing is not the file's name, so it is not reported.
  write({ app: own, pages: [{ key: 'one', pageId: LOW }] });
  for (const unnamed of [undefined, null, '', '  ']) assert.strictEqual(readPreviousPageKeys(file, unnamed).keys.size, 0);
  write({ app: {}, pages: [{ key: 'one', pageId: LOW }] });
  assert.strictEqual(readPreviousPageKeys(file, undefined).unidentified, false);

  // A key claimed by two pages, or a page given two keys, is ambiguous: nothing is kept for either, and each is reported with what it holds.
  const P3 = g('30000000', 1);
  const P4 = g('40000000', 1);
  write({ app: own, pages: [{ key: 'one', pageId: LOW }, { key: 'one', pageId: HIGH }, { key: 'solo', pageId: P3 }, { key: 'x', pageId: P4 }, { key: 'y', pageId: P4 }] });
  read = readPreviousPageKeys(file, APP_UNIQUE);
  assert.deepStrictEqual([...read.keys], [[P3, 'solo']]);
  assert.deepStrictEqual(read.conflicts, [{ keys: ['x', 'y'], pageIds: [P4] }, { keys: ['one'], pageIds: [LOW, HIGH] }]);
  // The same entry twice is not a conflict, and ids are compared without case.
  write({ app: own, pages: [{ key: 'one', pageId: LOW }, { key: 'one', pageId: LOW.toUpperCase() }] });
  read = readPreviousPageKeys(file, APP_UNIQUE);
  assert.deepStrictEqual([[...read.keys], read.conflicts], [[[LOW, 'one']], []]);

  // Absent is no problem; present and unreadable is one; a BOM (an editor's) is not.
  fs.rmSync(file);
  assert.deepStrictEqual(readPreviousPageKeys(file, APP_UNIQUE), { keys: new Map(), conflicts: [], problem: null, unidentified: false });
  write('{ nope');
  read = readPreviousPageKeys(file, APP_UNIQUE);
  assert.strictEqual(read.keys.size, 0);
  assert.match(read.problem, /JSON|Expected|position/);
  write('\uFEFF' + JSON.stringify({ app: own, pages: [{ key: 'one', pageId: LOW }] }));
  assert.deepStrictEqual([...readPreviousPageKeys(file, APP_UNIQUE).keys], [[LOW, 'one']]);
  write('[1, 2]');
  assert.strictEqual(readPreviousPageKeys(file, APP_UNIQUE).keys.size, 0);
});

test('readPreviousPageKeys looks only at the rows of pages the app still has, when it is told which', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'app-spec.json');
  const GONE = g('90000000', 1);
  const GONE_TOO = g('90000000', 2);
  fs.writeFileSync(file, JSON.stringify({
    app: { uniqueName: APP_UNIQUE },
    pages: [{ key: 'kept', pageId: LOW }, { key: 'kept', pageId: GONE }, { key: 'twice', pageId: GONE }, { key: 'dup', pageId: GONE_TOO }, { key: 'dup', pageId: HIGH }, { key: 'dup', pageId: LOW.toUpperCase() }],
  }));
  // Told nothing, it reads every row: LOW and GONE are each given two keys, and `kept` and `dup` each go to several pages.
  assert.strictEqual(readPreviousPageKeys(file, APP_UNIQUE).conflicts.length, 4);
  // Told the pages the app has (HIGH and LOW, in any case), the rows of the pages it lost are not read at all.
  const live = readPreviousPageKeys(file, APP_UNIQUE, { livePageIds: [HIGH.toUpperCase(), LOW] });
  assert.deepStrictEqual([...live.keys], [], 'LOW holds two keys, `kept` and `dup`; HIGH shares `dup` with it');
  assert.deepStrictEqual(live.conflicts, [{ keys: ['dup', 'kept'], pageIds: [LOW] }, { keys: ['dup'], pageIds: [LOW, HIGH] }]);
  const onlyHigh = readPreviousPageKeys(file, APP_UNIQUE, { livePageIds: [HIGH] });
  assert.deepStrictEqual([[...onlyHigh.keys], onlyHigh.conflicts], [[[HIGH, 'dup']], []], 'the page that shared its key is gone: the key is its own');
  assert.deepStrictEqual(readPreviousPageKeys(file, APP_UNIQUE, { livePageIds: [] }).conflicts, []);
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
