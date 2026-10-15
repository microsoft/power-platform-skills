'use strict';
// Two downloads of the same app must write the same bytes. The server does not promise an order: a query with no
// `$orderby` answers its rows in whatever order the platform holds them, and a directory listing (`fs.readdirSync`) is
// in the file system's order — name order on NTFS, hash order on ext4. A download that wrote pages, the artifacts it
// does not reconstruct, the tables it found beyond the navigation and its membership notes in the order it was handed
// them made two downloads of one app differ only in order, so a diff between them (or between a download and a rebuild's
// download) showed changes nobody made, and a page key minted from a name two pages share went to whichever page came first.
//
// Every download below runs against the same app served in a different order. The three orders are the server's own (as
// built), its reverse, and a rotation; the pages folder is also listed in reverse, as a file system that does not sort would.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  runDownload, parseDownloadedPages, assignPageKeys, readDescriptionInventory, notRoundTrippedSummary, compareText,
} = require('../download-model-app.js');
const { currentReadSdk } = require('./helpers/app-membership-sdk.js');
const { fakeGenpage } = require('./helpers/fake-genpage.js');

const g = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const APP_ID = g('a1b2c3d4', 1);
const LAYER = g('c0ffee00', 1);
const SITEMAP_ID = g('5111e0f2', 1);
const SOLUTION_ID = g('6111e0f2', 1);
const APP_UNIQUE = 'test_order';

// Two pages share a name, and the id order is not the name order, so neither the file system's order nor the server's
// agrees with the order a download must give: by name (case-insensitively), then by id.
const PAGES = [
  { pageId: g('f0000000', 1), name: 'Work Order' },
  { pageId: g('50000000', 1), name: 'Dashboard' },
  { pageId: g('90000000', 1), name: 'archive notes' },
  { pageId: g('10000000', 1), name: 'Work Order' },
];
const SITEMAP_XML = `<SiteMap><Area Id="A"><Group Id="G">${PAGES.map((p, i) => `<SubArea Id="p${i}" GenPageId="${p.pageId}" Title="Title ${i}"/>`).join('')}<SubArea Id="e" Entity="contoso_item"/></Group></Area></SiteMap>`;

// Tables the app holds without showing them in its navigation (appmodulecomponent type 1), and three it names that no
// longer resolve — each of those is a membership note carrying the id it could not read.
const TABLES = ['contoso_delta', 'contoso_alpha', 'contoso_charlie', 'contoso_bravo'].map((logical, i) => ({ logical, id: g('22222222', i + 1) }));
const GONE_TABLES = [3, 1, 2].map((n) => g('23232323', n));

const restricted = (role) => `<form><tabs /><DisplayConditions Order="2" FallbackForm="false"><Role Id="{${role}}" /></DisplayConditions></form>`;
const open = '<form><tabs /><DisplayConditions Order="0" FallbackForm="true"><Everyone /></DisplayConditions></form>';
// `Main` twice on one table: only the id tells them apart. Two forms are restricted to a role, and the warning names them.
const FORMS = [
  { formid: g('33333333', 1), name: 'Quick Create', objecttypecode: 'contoso_item', description: '', formxml: open },
  { formid: g('33333333', 2), name: 'Main', objecttypecode: 'contoso_item', description: '', formxml: restricted('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') },
  { formid: g('33333333', 3), name: 'Card', objecttypecode: 'contoso_bravo', description: '', formxml: restricted('ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee') },
  { formid: g('33333333', 4), name: 'Main', objecttypecode: 'contoso_item', description: '', formxml: open },
  { formid: g('33333333', 5), name: 'Summary', objecttypecode: 'contoso_alpha', description: '', formxml: open },
];
const VIEWS = [
  { savedqueryid: g('44444444', 1), name: 'My Items', returnedtypecode: 'contoso_item', description: '' },
  { savedqueryid: g('44444444', 2), name: 'Active Items', returnedtypecode: 'contoso_item', description: '' },
  { savedqueryid: g('44444444', 3), name: 'All Bravos', returnedtypecode: 'contoso_bravo', description: '' },
  { savedqueryid: g('44444444', 4), name: 'All Alphas', returnedtypecode: 'contoso_alpha', description: '' },
];
const CHARTS = [
  { savedqueryvisualizationid: g('55555555', 1), name: 'By Owner', primaryentitytypecode: 'contoso_item', description: '' },
  { savedqueryvisualizationid: g('55555555', 2), name: 'By Age', primaryentitytypecode: 'contoso_alpha', description: '' },
  { savedqueryvisualizationid: g('55555555', 3), name: 'By Age', primaryentitytypecode: 'contoso_item', description: '' },
];
const RULES = [
  { workflowid: g('66666666', 1), name: 'Require reason', primaryentity: 'contoso_item', description: '', category: 2, type: 1 },
  { workflowid: g('66666666', 2), name: 'Lock closed', primaryentity: 'contoso_alpha', description: '', category: 2, type: 1 },
  { workflowid: g('66666666', 3), name: 'Default owner', primaryentity: 'contoso_item', description: '', category: 2, type: 1 },
];
const CHOICES = [
  { Name: 'contoso_status', MetadataId: g('77777777', 1), IsManaged: false },
  { Name: 'contoso_priority', MetadataId: g('77777777', 2), IsManaged: false },
  { Name: 'contoso_Stage', MetadataId: g('77777777', 3), IsManaged: false },
  { Name: 'unrelated_set', MetadataId: g('77777777', 4), IsManaged: false },
];

const identity = (list) => [...list];
const reversed = (list) => [...list].reverse();
const rotated = (list) => (list.length > 1 ? [...list.slice(1), list[0]] : [...list]);
const ORDERS = [['as the server holds them', identity], ['reversed', reversed], ['rotated by one', rotated]];

// The same app, every list answered through `order`. Reads this download makes that no test below looks at answer an
// empty collection, which is what a table with no relationship, no label to read and no hidden column answers.
function server(order) {
  const ids = (filter) => [...String(filter || '').matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((m) => m[0].toLowerCase());
  const byIds = (rows, key, filter) => { const want = new Set(ids(filter)); return order(rows.filter((r) => want.has(r[key]))); };
  const components = (type) => ({
    1: [...TABLES.map((t) => t.id), ...GONE_TABLES],
    26: VIEWS.map((v) => v.savedqueryid),
    59: CHARTS.map((c) => c.savedqueryvisualizationid),
    60: FORMS.map((f) => f.formid),
    62: [SITEMAP_ID],
  }[type] || []).map((objectid) => ({ objectid, componenttype: type }));
  const sdk = {
    fetchArtifact: async () => ({
      name: 'Order App', description: '',
      siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [
        ...PAGES.map((p, i) => ({ type: 'GenPage', genPageId: p.pageId, title: `Title ${i}` })),
        { type: 'Entity', entity: 'contoso_item' },
      ] }] }] },
    }),
    queryRecords: async (logical, opts) => {
      const filter = (opts && opts.filter) || '';
      switch (logical) {
        case 'appmodule': return [{ appmoduleid: APP_ID, appmoduleidunique: LAYER, uniquename: APP_UNIQUE }];
        case 'appmodulecomponent': return order(components(Number(/componenttype eq (\d+)/.exec(filter)[1])));
        case 'sitemap': return [{ sitemapxml: SITEMAP_XML }];
        case 'systemform': return byIds(FORMS, 'formid', filter);
        case 'savedquery': return byIds(VIEWS, 'savedqueryid', filter);
        case 'savedqueryvisualization': return byIds(CHARTS, 'savedqueryvisualizationid', filter);
        case 'workflow': return byIds(RULES, 'workflowid', filter);
        case 'webresource': return [];
        case 'solutioncomponent':
          if (filter === `objectid eq ${APP_ID}`) return [{ _solutionid_value: SOLUTION_ID }];
          if (/componenttype eq 29/.test(filter)) return order(RULES.map((r) => ({ objectid: r.workflowid, componenttype: 29 })));
          if (/componenttype eq 9/.test(filter)) return order(CHOICES.slice(0, 3).map((c) => ({ objectid: c.MetadataId, componenttype: 9 })));
          return [];
        case 'solution':
          return /solutionid eq/.test(filter)
            ? [{ solutionid: SOLUTION_ID, uniquename: 'ContosoSln', ismanaged: false, description: '' }]
            : [{ solutionid: SOLUTION_ID }];
        default: return [];
      }
    },
    fetchEntityMetadata: async (logical) => ({
      logicalName: logical, schemaName: logical, displayName: logical, primaryNameAttribute: 'contoso_name', attributes: [],
    }),
    dataverse: {
      get: async (url) => {
        const table = /^\/EntityDefinitions\(([0-9a-f-]{36})\)\?\$select=LogicalName,IsCustomEntity$/i.exec(url);
        if (table) {
          const found = TABLES.find((t) => t.id === table[1].toLowerCase());
          return found ? { status: 200, body: { LogicalName: found.logical, IsCustomEntity: true } } : { status: 404, body: null };
        }
        if (/^\/GlobalOptionSetDefinitions\?/.test(url)) return { status: 200, headers: {}, body: { value: order(CHOICES) } };
        return { status: 200, headers: {}, body: { value: [] } };
      },
    },
  };
  return currentReadSdk(sdk, { appId: APP_ID, layerId: LAYER, sitemapXml: SITEMAP_XML });
}

// `fs.readdirSync` of the pages folder answered through `listing`: the order a file system that does not sort gives.
function withDirectoryOrder(listing, fn) {
  const real = fs.readdirSync;
  fs.readdirSync = (target, ...rest) => {
    const names = real(target, ...rest);
    return path.basename(String(target)) === 'pages' && Array.isArray(names) ? listing(names) : names;
  };
  const restore = () => { fs.readdirSync = real; };
  return Promise.resolve().then(fn).then((value) => { restore(); return value; }, (error) => { restore(); throw error; });
}

// Everything a download hands back or writes, as data.
async function download(order, listing = identity) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-order-'));
  const stderr = [];
  const realWrite = process.stderr.write;
  try {
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
    const genpage = fakeGenpage({ pages: order(PAGES.map((p) => ({ ...p, source: `export default function Page() { return '${p.pageId}'; }\n` }))) });
    const res = await withDirectoryOrder(listing, () => runDownload({ sdk: server(order), genpage, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE }));
    assert.ok(res.ok, JSON.stringify(res));
    const tree = {};
    const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else tree[path.relative(out, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8'); } };
    walk(path.join(out, 'pages'));
    return { res, tree, stderr: stderr.join('') };
  } finally {
    process.stderr.write = realWrite;
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test('compareText orders by UTF-16 code units after lower-casing, so it gives the same answer on every machine', () => {
  // Not the host's collation: `localeCompare` answers by the machine's ICU locale (Swedish puts "ä" after "z", German
  // beside "a"), and in the root locale it puts "_" before a digit, where code units put it after. A download is compared
  // between machines, so its order may depend on the strings alone.
  assert.deepStrictEqual(['Zeta', 'alpha', 'Beta'].sort(compareText), ['alpha', 'Beta', 'Zeta'], 'case does not decide the order …');
  assert.deepStrictEqual(['a_1', 'a1', 'A1'].sort(compareText), ['A1', 'a1', 'a_1'], '… the lower-cased text does, then code units (so "A1" < "a1" and a digit < "_")');
  assert.deepStrictEqual(['\u00e4', 'z', 'a'].sort(compareText), ['a', 'z', '\u00e4'], 'a letter outside ASCII follows "z", whatever the locale');
  assert.strictEqual(compareText('x', 'x'), 0);
  assert.strictEqual(compareText(undefined, null), 0, 'a missing value reads as the empty text, not as "undefined"');
  assert.ok(compareText(undefined, 'a') < 0);
  assert.ok(compareText('Page', 'page') < 0 && compareText('page', 'Page') > 0, 'texts that differ only in case still have one fixed order');
});

test('two downloads of one app write the same bytes whatever order the server answers in (pages, artifacts, tables, notes)', async () => {
  const runs = [];
  for (const [label, order] of ORDERS) runs.push({ label, ...await download(order, order) });
  const [first, ...others] = runs;
  for (const other of others) {
    const where = `${other.label} vs ${first.label}`;
    assert.deepStrictEqual(other.res.spec.pages, first.res.spec.pages, `spec.pages (${where})`);
    assert.deepStrictEqual(other.res.spec.entities.map((e) => e.schemaName), first.res.spec.entities.map((e) => e.schemaName), `spec.entities (${where})`);
    assert.deepStrictEqual(other.res.spec.app, first.res.spec.app, `spec.app (${where})`);
    assert.deepStrictEqual(other.res.spec.globalChoices, first.res.spec.globalChoices, `spec.globalChoices (${where})`);
    assert.deepStrictEqual(other.res.spec.descriptionInventory, first.res.spec.descriptionInventory, `spec.descriptionInventory (${where})`);
    assert.deepStrictEqual(other.res.notRoundTripped, first.res.notRoundTripped, `notRoundTripped (${where})`);
    assert.deepStrictEqual(other.tree, first.tree, `the pages folder (${where})`);
    assert.strictEqual(other.stderr, first.stderr, `what the download says on stderr (${where})`);
    assert.strictEqual(JSON.stringify(other.res.spec, null, 2), JSON.stringify(first.res.spec, null, 2), `the app-spec.json bytes (${where})`);
  }
});

test('the order a download gives: pages by name then id, artifacts by table then name then id, hidden tables by name, notes by what they say', async () => {
  const { res, stderr } = await download(reversed, reversed);
  // Pages: case-insensitive name first, then id — so the two "Work Order"s are told apart by id, and the key that is minted
  // from that name goes to the same page every time (the lower id), the -2 to the other.
  assert.deepStrictEqual(res.spec.pages.map((p) => [p.name, p.pageId, p.key]), [
    ['archive notes', g('90000000', 1), 'archive-notes'],
    ['Dashboard', g('50000000', 1), 'dashboard'],
    ['Work Order', g('10000000', 1), 'work-order'],
    ['Work Order', g('f0000000', 1), 'work-order-2'],
  ]);
  assert.deepStrictEqual(res.pages.map((p) => p.pageId), res.spec.pages.map((p) => p.pageId), 'the pages runDownload returns are in the same order');
  // The artifacts the spec keeps in descriptionInventory (see the "NOT lost" note): table, then name, then id.
  const inv = res.spec.descriptionInventory;
  assert.deepStrictEqual(inv.forms.map((f) => [f.entity, f.name, f.id]), [
    ['contoso_alpha', 'Summary', g('33333333', 5)],
    ['contoso_bravo', 'Card', g('33333333', 3)],
    ['contoso_item', 'Main', g('33333333', 2)],
    ['contoso_item', 'Main', g('33333333', 4)],
    ['contoso_item', 'Quick Create', g('33333333', 1)],
  ]);
  assert.deepStrictEqual(inv.views.map((v) => [v.entity, v.name]), [['contoso_alpha', 'All Alphas'], ['contoso_bravo', 'All Bravos'], ['contoso_item', 'Active Items'], ['contoso_item', 'My Items']]);
  assert.deepStrictEqual(inv.charts.map((c) => [c.entity, c.name, c.id]), [
    ['contoso_alpha', 'By Age', g('55555555', 2)], ['contoso_item', 'By Age', g('55555555', 3)], ['contoso_item', 'By Owner', g('55555555', 1)],
  ]);
  assert.deepStrictEqual(inv.businessRules.map((r) => [r.entity, r.name]), [['contoso_alpha', 'Lock closed'], ['contoso_item', 'Default owner'], ['contoso_item', 'Require reason']]);
  assert.deepStrictEqual(inv.globalChoices.map((c) => c.name), ['contoso_priority', 'contoso_Stage', 'contoso_status'], 'organisation-wide: by name');
  // Tables: the navigation's own order first (it is the app's content), then the ones the app holds by name.
  assert.deepStrictEqual(res.spec.entities.map((e) => e.schemaName), ['contoso_item', 'contoso_alpha', 'contoso_bravo', 'contoso_charlie', 'contoso_delta']);
  assert.deepStrictEqual(res.spec.app.tables, ['contoso_alpha', 'contoso_bravo', 'contoso_charlie', 'contoso_delta']);
  // The role-restricted forms are named in the warning in the same order.
  const warning = stderr.split('\n').find((line) => /are restricted to specific security roles/.test(line));
  assert.match(warning, /\(contoso_bravo\.Card, contoso_item\.Main\)/);
  // Membership notes: kind, then table, id, name and what they say — so the three tables that no longer resolve come in id order.
  const notes = res.notRoundTripped.appMembership;
  assert.deepStrictEqual(notes.filter((n) => n.kind === 'tables' && n.id).map((n) => n.id), [...GONE_TABLES].sort());
  const keys = notes.map((n) => [n.kind, n.table || '', n.id || '', n.name || '', n.reason].map((v) => String(v).toLowerCase()).join('\u0000'));
  assert.deepStrictEqual(keys, [...keys].sort(), 'sorted by (kind, table, id, name, reason)');
});

test('the same members, only ordered: nothing a download wrote is dropped or added by the order it now gives', async () => {
  const { res } = await download(identity);
  const inv = res.spec.descriptionInventory;
  assert.deepStrictEqual(inv.forms.map((f) => f.id).sort(), FORMS.map((f) => f.formid).sort());
  assert.deepStrictEqual(inv.views.map((v) => v.id).sort(), VIEWS.map((v) => v.savedqueryid).sort());
  assert.deepStrictEqual(inv.charts.map((c) => c.id).sort(), CHARTS.map((c) => c.savedqueryvisualizationid).sort());
  assert.deepStrictEqual(inv.businessRules.map((r) => r.id).sort(), RULES.map((r) => r.workflowid).sort());
  assert.deepStrictEqual(inv.globalChoices.map((c) => c.name).sort(), CHOICES.slice(0, 3).map((c) => c.Name).sort(), 'the sets the solution owns; the unrelated one stays out');
  assert.deepStrictEqual(res.pages.map((p) => p.pageId).sort(), PAGES.map((p) => p.pageId).sort());
  assert.strictEqual(res.notRoundTripped.total, FORMS.length + VIEWS.length + CHARTS.length + RULES.length + 3);
});

test('what is not reordered: the navigation keeps the sitemap\'s order, and every page folder holds its own page', async () => {
  const { res, tree } = await download(reversed, reversed);
  // `appShell` is the app's own navigation, in the order its sitemap lists it — not the pages' order in `pages[]`.
  const targets = res.spec.appShell.areas[0].groups[0].subAreas.map((s) => s.page || s.entity);
  assert.deepStrictEqual(targets, ['work-order-2', 'dashboard', 'archive-notes', 'work-order', 'contoso_item']);
  // Ordering the list must not cross-wire a page with another's files.
  for (const p of PAGES) {
    assert.strictEqual(tree[`pages/${p.pageId}/page.tsx`], `export default function Page() { return '${p.pageId}'; }\n`, `the source of ${p.name} (${p.pageId})`);
  }
  assert.deepStrictEqual(Object.keys(tree).filter((file) => file.endsWith('/page.tsx')).length, PAGES.length);
  for (const page of res.spec.pages) assert.strictEqual(page.source.codeFile, `pages/${page.pageId}/page.tsx`, 'each spec page points at its own folder');
});

test('parseDownloadedPages gives the same pages, and reports the same unreadable configs, whatever order the directory lists them in', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-order-parse-'));
  try {
    const pagesRoot = path.join(root, 'pages');
    const names = new Map();
    PAGES.forEach((p, i) => {
      fs.mkdirSync(path.join(pagesRoot, p.pageId), { recursive: true });
      fs.writeFileSync(path.join(pagesRoot, p.pageId, 'page.tsx'), `export default () => ${i};\n`);
      // two pages whose config cannot be read, and one with a model the spec cannot hold
      if (i === 0 || i === 3) fs.writeFileSync(path.join(pagesRoot, p.pageId, 'config.json'), '{ not json');
      if (i === 1) fs.writeFileSync(path.join(pagesRoot, p.pageId, 'config.json'), JSON.stringify({ dataSources: [], model: 'has spaces' }));
      names.set(p.pageId, p.name);
    });
    const parse = (listing) => {
      const unreadable = []; const unkept = [];
      const pages = withDirectoryOrderSync(listing, () => parseDownloadedPages(pagesRoot, root, names, unreadable, unkept));
      return { pages, unreadable, unkept };
    };
    const results = ORDERS.map(([, order]) => parse(order));
    for (const r of results.slice(1)) assert.deepStrictEqual(r, results[0]);
    assert.deepStrictEqual(results[0].pages.map((p) => [p.name, p.pageId]), [
      ['archive notes', g('90000000', 1)], ['Dashboard', g('50000000', 1)], ['Work Order', g('10000000', 1)], ['Work Order', g('f0000000', 1)],
    ]);
    assert.deepStrictEqual(results[0].unreadable.map((u) => u.pageId), [g('10000000', 1), g('f0000000', 1)], 'reported in the pages\' order');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function withDirectoryOrderSync(listing, fn) {
  const real = fs.readdirSync;
  fs.readdirSync = (target, ...rest) => {
    const names = real(target, ...rest);
    return path.basename(String(target)) === 'pages' && Array.isArray(names) ? listing(names) : names;
  };
  try { return fn(); } finally { fs.readdirSync = real; }
}

test('assignPageKeys mints the same key for the same page whatever order the pages arrive in', () => {
  const make = () => [
    { pageId: g('f0000000', 1), name: 'Work Order', dataSources: [], codeFile: 'f' },
    { pageId: g('10000000', 1), name: 'Work Order', dataSources: [], codeFile: '1' },
    { pageId: g('50000000', 1), name: 'work order', dataSources: [], codeFile: '5' },
  ];
  const keysFor = (pages) => { assignPageKeys(pages, null, new Map()); return Object.fromEntries(pages.map((p) => [p.pageId, p.key])); };
  const forward = keysFor(make());
  const backward = keysFor(make().reverse());
  assert.deepStrictEqual(backward, forward);
  // "Work Order" sorts before "work order" (same lower-cased text, so the raw text decides: "W" < "w"); the ids then tell the two "Work Order"s apart.
  assert.deepStrictEqual(forward, { [g('10000000', 1)]: 'work-order', [g('f0000000', 1)]: 'work-order-2', [g('50000000', 1)]: 'work-order-3' });
});

test('readDescriptionInventory lists each class in one order, however Dataverse answered', async () => {
  const both = [];
  for (const [, order] of ORDERS) both.push(await readDescriptionInventory(server(order), APP_ID, 'ContosoSln', [], undefined));
  for (const inventory of both.slice(1)) assert.deepStrictEqual(inventory, both[0]);
  assert.deepStrictEqual(both[0].roleRestrictedForms, [{ name: 'Card', entity: 'contoso_bravo' }, { name: 'Main', entity: 'contoso_item' }]);
});

test('notRoundTrippedSummary orders its lists by code units too, and breaks a tie between equal kinds by their reason', () => {
  const summary = notRoundTrippedSummary({
    forms: [{ entity: 'b', name: 'a_1' }, { entity: 'b', name: 'a1' }, { entity: 'B', name: 'x' }, { entity: 'a', name: 'Z' }],
    incomplete: [{ kind: 'views', reason: 'HTTP 503' }, { kind: 'views', reason: 'HTTP 403' }, { kind: 'charts', reason: 'boom' }],
  });
  // entities are lower-cased before they are grouped, so "B" joins "b"
  assert.deepStrictEqual(summary.entities.map((e) => [e.entity, e.forms]), [['a', ['Z']], ['b', ['a1', 'a_1', 'x']]]);
  assert.deepStrictEqual(summary.incomplete.map((i) => `${i.kind}:${i.reason}`), ['charts:boom', 'views:HTTP 403', 'views:HTTP 503']);
});
