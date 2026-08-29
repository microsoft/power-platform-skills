'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveAppId, collectSitemap, parseDownloadedPages, entityFromMetadata, readEntityWithDescriptions, readDescriptionInventory, iconWebResources, readDashboards, droppedSubareaCount, preserveAuthoredLanguageCode } = require('../download-model-app.js');

test('resolveAppId returns a guid as-is, else resolves by uniquename', async () => {
  const guid = '11111111-2222-3333-4444-555555555555';
  assert.deepStrictEqual(await resolveAppId({}, guid), { appId: guid });
  const sdk = { queryRecords: async (l, o) => { assert.match(o.filter, /uniquename eq 'new_app'/); return [{ appmoduleid: 'app-1' }]; } };
  assert.deepStrictEqual(await resolveAppId(sdk, 'new_app'), { appId: 'app-1', matchedBy: 'uniqueName' });
});

test('resolveAppId escapes apostrophes and reports an actionable error for a missing app', async () => {
  const calls = [];
  const sdk = { queryRecords: async (logical, opts) => { calls.push({ logical, opts }); return []; } };
  const r = await resolveAppId(sdk, "new_bob's_app");
  assert.match(r.error, /not found/);
  // The dead-end "app 'x' not found" gave an operator holding a display name nowhere to go.
  assert.match(r.error, /unique name/);
  assert.strictEqual(r.appId, undefined);
  assert.strictEqual(calls[0].logical, 'appmodule');
  assert.match(calls[0].opts.filter, /uniquename eq 'new_bob''s_app'/);
  // The display-name fallback must escape the apostrophe the same way, or it is an OData syntax error.
  assert.match(calls[1].opts.filter, /name eq 'new_bob''s_app'/);
});

// A live tester hit this: the maker portal shows a DISPLAY name, but --app only accepted the unique
// name, so the obvious input failed with a dead-end error.
test('resolveAppId falls back to an unambiguous display name and reports the unique name', async () => {
  const sdk = {
    queryRecords: async (_l, o) => (/uniquename eq/.test(o.filter) ? [] : [{ appmoduleid: 'app-9', uniquename: 'new_smokeapp', name: 'Smoke App' }]),
  };
  assert.deepStrictEqual(await resolveAppId(sdk, 'Smoke App'), { appId: 'app-9', matchedBy: 'displayName', uniqueName: 'new_smokeapp' });
});

// Display names are mutable AND non-unique, so guessing could download a different app than the
// operator meant — refuse and hand back the unique names instead.
test('resolveAppId fails closed when a display name matches more than one app', async () => {
  const sdk = {
    queryRecords: async (_l, o) => (/uniquename eq/.test(o.filter) ? [] : [
      { appmoduleid: 'app-1', uniquename: 'new_sales', name: 'Sales' },
      { appmoduleid: 'app-2', uniquename: 'contoso_sales', name: 'Sales' },
    ]),
  };
  const r = await resolveAppId(sdk, 'Sales');
  assert.strictEqual(r.appId, undefined, 'must not pick one of the ambiguous matches');
  assert.match(r.error, /shared by 2 apps/);
  assert.match(r.error, /new_sales, contoso_sales/);
});

// A GUID is authoritative: resolving it must not cost a query, and must never reach the
// display-name fallback (an app DISPLAY-named like a GUID could otherwise shadow a real id).
test('resolveAppId issues no query for a GUID', async () => {
  let queried = false;
  const sdk = { queryRecords: async () => { queried = true; return []; } };
  const r = await resolveAppId(sdk, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.strictEqual(r.appId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.strictEqual(queried, false);
});

test('collectSitemap gathers distinct entities + icons from the sitemap', () => {
  const app = { siteMap: { areas: [{ icon: 'a.png', groups: [{ subAreas: [
    { type: 'Entity', entity: 'New_Order', icon: 'i.png' },
    { type: 'GenPage', genPageId: 'gp' },
    { type: 'Entity', entity: 'new_order' },
  ] }] }] } };
  const { entities, icons } = collectSitemap(app);
  assert.deepStrictEqual(entities, ['new_order']);
  assert.deepStrictEqual([...icons].sort(), ['a.png', 'i.png']);
});

test('collectSitemap separates BARE-NAME icons from platform-path customRefs (both icon + vectorIcon, areas + subareas)', () => {
  const app = { siteMap: { areas: [{ icon: '/WebResources/crba3_area.svg', groups: [{ subAreas: [
    { type: 'Entity', entity: 'zava_javavendor', icon: '/WebResources/msdyn_OmnichannelBase/_imgs/SitemapIcon/CDSEntity', vectorIcon: '/WebResources/crba3_/icons/approval.svg' },
    { type: 'Entity', entity: 'new_thing', icon: 'new_declared.png' }, // a bare name → icons (fetched + re-declared)
  ] }] }] } };
  const { icons, customRefs } = collectSitemap(app);
  assert.deepStrictEqual([...icons], ['new_declared.png'], 'only the bare-name icon goes to icons');
  // Platform paths → customRefs, with the WR NAME extracted (leading /WebResources/ stripped); OOB + custom alike.
  assert.deepStrictEqual([...customRefs].sort(), [
    'crba3_/icons/approval.svg', 'crba3_area.svg', 'msdyn_OmnichannelBase/_imgs/SitemapIcon/CDSEntity',
  ].sort(), 'icon + vectorIcon platform paths are gathered as customRefs (name-extracted)');
});

test('iconWebResources re-declares an OWN-PREFIX CUSTOM (unmanaged) image WR as external:true; SKIPS managed/OOB + foreign-prefix; tracks unresolved own-prefix refs', async () => {
  const sdk = { queryRecords: async (e, o) => {
    const name = (o.filter.match(/name eq '([^']*)'/) || [])[1];
    if (name === 'crba3_navicon.svg') return [{ name, webresourcetype: 11, content: 'PHN2Zz4=', ismanaged: false }]; // own custom unmanaged SVG
    if (name === 'msdyn_x/CDSEntity') return [{ name, webresourcetype: 11, content: 'x', ismanaged: true }];          // managed OOB
    if (name === 'isv_foreign.svg') return [{ name, webresourcetype: 11, content: 'y', ismanaged: false }];           // foreign unmanaged (another publisher)
    if (name === 'crba3_bare.png') return [{ name, webresourcetype: 5, content: 'aW1n', ismanaged: false }];          // bare-name author icon
    if (name === 'crba3_gone.svg') return [];                                                                         // own-prefix but absent on source → unresolved
    return [];
  } };
  const { webResources, unresolved } = await iconWebResources(
    sdk, ['crba3_bare.png'], ['crba3_navicon.svg', 'msdyn_x/CDSEntity', 'isv_foreign.svg', 'crba3_gone.svg'], 'crba3', true);
  const byName = Object.fromEntries(webResources.map((w) => [w.name, w]));
  assert.ok(byName['crba3_navicon.svg'], 'an OWN-prefix custom unmanaged path-referenced WR is re-declared');
  assert.strictEqual(byName['crba3_navicon.svg'].external, true, 'a re-declared path-referenced icon is flagged external (teardown skips it)');
  assert.ok(byName['crba3_bare.png'], 'a bare-name author icon is re-declared as before');
  assert.notStrictEqual(byName['crba3_bare.png'].external, true, 'a bare-name author icon is NOT external (teardown owns it, as before)');
  assert.ok(!byName['msdyn_x/CDSEntity'], 'a managed/OOB path-referenced WR is NOT re-declared');
  assert.ok(!byName['isv_foreign.svg'], 'a FOREIGN-prefix WR is NOT re-declared (would BuildHalt under an unregistered prefix on a fresh env)');
  assert.deepStrictEqual(unresolved, ['crba3_gone.svg'], 'an own-prefix ref absent on the source env is reported unresolved (surface, do not silently drop)');
});

test('iconWebResources reports an own-prefix icon read FAILURE as unresolved (not a silent skip)', async () => {
  const sdk = { queryRecords: async (e, o) => {
    const name = (o.filter.match(/name eq '([^']*)'/) || [])[1];
    if (name === 'crba3_flaky.svg') throw new Error('429 throttled');
    return [];
  } };
  const { webResources, unresolved } = await iconWebResources(sdk, [], ['crba3_flaky.svg'], 'crba3', true);
  assert.strictEqual(webResources.length, 0);
  assert.deepStrictEqual(unresolved, ['crba3_flaky.svg'], 'a transient read failure on an own-prefix icon is surfaced');
});

test('iconWebResources with an UNVERIFIED prefix (publisher read failed) surfaces a genuine own custom icon as unresolved instead of silently dropping it; a managed/OOB ref stays silent', async () => {
  // prefixResolved=false + a fallback prefix ('new') that does NOT match the app's real 'crba3' icons.
  // Without the guard, crba3_nav.svg fails startsWith('new_') and is silently skipped with no warning
  // (Opus/Sol finding). It must instead be surfaced as unresolved; the OOB CDSEntity ref must stay silent.
  const sdk = { queryRecords: async (e, o) => {
    const name = (o.filter.match(/name eq '([^']*)'/) || [])[1];
    if (name === 'crba3_nav.svg') return [{ name, webresourcetype: 11, content: 'PHN2Zz4=', ismanaged: false }]; // genuine own custom svg
    if (name === 'msdyn_x/CDSEntity') return [{ name, webresourcetype: 11, content: 'x', ismanaged: true }];      // managed OOB (exists everywhere)
    return [];
  } };
  const { webResources, unresolved } = await iconWebResources(
    sdk, [], ['crba3_nav.svg', 'msdyn_x/CDSEntity'], 'new', false);
  assert.strictEqual(webResources.length, 0, 'never re-declares under an unverified prefix (would BuildHalt on a fresh env)');
  assert.deepStrictEqual(unresolved, ['crba3_nav.svg'], 'the genuine custom icon is surfaced; the managed OOB ref stays silent (no false alarm)');
});

test('iconWebResources: a WR referenced BOTH by a bare name AND a platform path inherits external:true (overlap keeps teardown protection)', async () => {
  // Sol finding: if the bare pass emitted the WR without external and `seen` then suppressed the path
  // classification, teardown would delete a shared nav icon. The path pass runs first / the bare entry
  // inherits external when it is also a customRef.
  const sdk = { queryRecords: async (e, o) => {
    const name = (o.filter.match(/name eq '([^']*)'/) || [])[1];
    if (name === 'crba3_shared.svg') return [{ name, webresourcetype: 11, content: 'PHN2Zz4=', ismanaged: false }];
    return [];
  } };
  const { webResources } = await iconWebResources(
    sdk, ['crba3_shared.svg'], ['crba3_shared.svg'], 'crba3', true);
  assert.strictEqual(webResources.length, 1, 'the overlapping WR is re-declared exactly once (deduped)');
  assert.strictEqual(webResources[0].external, true, 'an overlapping bare+path WR is external (teardown must not delete a shared nav icon)');
});

test('parseDownloadedPages reads pac page tree (<pageId>/page.tsx + config + prompt) into pages[]', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const pagesRoot = path.join(out, 'pages');
  const pid = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';
  fs.mkdirSync(path.join(pagesRoot, pid), { recursive: true });
  fs.writeFileSync(path.join(pagesRoot, pid, 'page.tsx'), 'x');
  fs.writeFileSync(path.join(pagesRoot, pid, 'config.json'), JSON.stringify({ dataSources: ['new_order'], model: '' }));
  fs.writeFileSync(path.join(pagesRoot, pid, 'prompt.txt'), 'kpis');
  const pages = parseDownloadedPages(pagesRoot, out, new Map([[pid, 'Overview']]));
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(pages[0].name, 'Overview');
  assert.deepStrictEqual(pages[0].dataSources, ['new_order']);
  assert.strictEqual(pages[0].prompt, 'kpis');
  assert.strictEqual(pages[0].codeFile, `pages/${pid}/page.tsx`);
  fs.rmSync(out, { recursive: true, force: true });
});

test('entityFromMetadata builds a minimal (reuse-friendly) entity spec', () => {
  const e = entityFromMetadata({ schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_name' }, 'new_order');
  assert.strictEqual(e.schemaName, 'new_order');
  assert.strictEqual(e.primaryAttribute.schemaName, 'new_name');
  assert.deepStrictEqual(e.columns, []);
  // A downloaded table is flagged existing:true so a teardown of THIS downloaded spec never deletes a
  // table (+ its data) we cannot prove this build created — download can't distinguish app-created from
  // merely-referenced tables, and deleting customer data is unrecoverable.
  assert.strictEqual(e.existing, true, 'downloaded tables must be flagged existing:true (teardown data-loss guard)');
});

test('entityFromMetadata carries table and column descriptions, unwrapping Dataverse Labels', () => {
  const e = entityFromMetadata({
    schemaName: 'new_order',
    displayName: 'Order',
    primaryNameAttribute: 'new_name',
    Description: {
      UserLocalizedLabel: { Label: 'Tracks orders through fulfillment.', LanguageCode: 1033 },
      LocalizedLabels: [{ Label: 'fallback table text', LanguageCode: 1033 }],
    },
    attributes: [
      {
        LogicalName: 'new_status',
        Description: {
          LocalizedLabels: [{ Label: 'Current fulfillment state.', LanguageCode: 1033 }],
        },
      },
      { LogicalName: 'new_internal', Description: null },
    ],
  }, 'new_order');

  assert.strictEqual(e.description, 'Tracks orders through fulfillment.');
  assert.strictEqual(e.columns[0].schemaName, 'new_status');
  assert.strictEqual(e.columns[0].description, 'Current fulfillment state.');
  assert.strictEqual('description' in e.columns[1], false, 'null Label descriptions must be omitted, not emitted as ""');
  assert.strictEqual(validateAppSpec({
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [e],
    appShell: { areas: [] },
  }).ok, true);
});

test('readEntityWithDescriptions reads descriptions through the RAW dataverse client, not queryRecords', async () => {
  // `sdk.queryRecords` cannot serve a metadata path: it first resolves its argument to an entity SET
  // name via `EntityDefinitions(LogicalName='<arg>')?$select=EntitySetName`, so a metadata path
  // becomes a nested nonsense URL that 404s. This mock FAILS any queryRecords attempt so the test
  // proves the raw client is used, rather than passing against a mock that models the wrong contract.
  const gets = [];
  const sdk = {
    fetchEntityMetadata: async (logical) => ({
      logicalName: logical,
      schemaName: 'new_order',
      displayName: 'Order',
      primaryNameAttribute: 'new_name',
      // The SDK supplies these; the description merge must PRESERVE them.
      attributes: [
        { logicalName: 'new_status', displayName: 'Status', attributeType: 'Picklist' },
        { logicalName: 'new_owner', displayName: 'Owner', attributeType: 'Lookup', targets: ['systemuser'] },
      ],
    }),
    queryRecords: async (set) => { throw new Error(`queryRecords must not be used for metadata paths (got '${set}')`); },
    dataverse: {
      get: async (url) => {
        gets.push(url);
        if (/\/Attributes\?/.test(url)) {
          return { status: 200, headers: {}, body: { value: [
            { LogicalName: 'new_status', Description: { LocalizedLabels: [{ Label: 'State shown to dispatchers.', LanguageCode: 1033 }] } },
          ] } };
        }
        return { status: 200, headers: {}, body: { Description: { UserLocalizedLabel: { Label: 'Order table purpose.', LanguageCode: 1033 }, LocalizedLabels: [] } } };
      },
    },
  };

  const meta = await readEntityWithDescriptions(sdk, 'new_order');
  const e = entityFromMetadata(meta, 'new_order');

  assert.ok(gets.some((u) => /^\/EntityDefinitions\(LogicalName='new_order'\)\?\$select=LogicalName,Description$/.test(u)), `table read URL wrong: ${gets.join(' | ')}`);
  assert.ok(gets.some((u) => /^\/EntityDefinitions\(LogicalName='new_order'\)\/Attributes\?\$select=LogicalName,Description$/.test(u)), `attribute read URL wrong: ${gets.join(' | ')}`);
  assert.strictEqual(e.description, 'Order table purpose.');
  const status = e.columns.find((c) => c.schemaName === 'new_status');
  assert.strictEqual(status.description, 'State shown to dispatchers.');
  // The merge must not discard SDK-only attribute facts (a replace would drop `targets`, breaking
  // lookup handling elsewhere) nor drop attributes the description read did not return.
  const owner = meta.attributes.find((a) => a.logicalName === 'new_owner');
  assert.ok(owner, 'an attribute with no description was dropped by the merge');
  assert.deepStrictEqual(owner.targets, ['systemuser'], 'the merge clobbered SDK-only attribute fields');
});

test('readEntityWithDescriptions treats a non-2xx from the raw client as "no description", not a crash', async () => {
  // dataverse.get RESOLVES with { status } on a 404 instead of throwing, so a bare try/catch would
  // let the error body through. The body here deliberately CARRIES a `Description` key: dropping the
  // status check must not be survivable just because a real 404 body usually lacks one.
  const sdk = {
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_name', attributes: [{ logicalName: 'new_status' }] }),
    dataverse: {
      get: async () => ({
        status: 404,
        headers: {},
        body: { error: { code: '0x80060888', message: 'Resource not found' }, Description: { UserLocalizedLabel: { Label: 'GARBAGE FROM AN ERROR BODY', LanguageCode: 1033 } } },
      }),
    },
  };
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'new_order'), 'new_order');
  assert.ok(!('description' in e), `a 404 body must never supply a description (got ${JSON.stringify(e.description)})`);
  assert.ok(!('description' in e.columns[0]));
});

test('readEntityWithDescriptions survives a raw client that throws', async () => {
  const sdk = {
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_name', attributes: [] }),
    dataverse: { get: async () => { throw new Error('network down'); } },
  };
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'new_order'), 'new_order');
  assert.strictEqual(e.schemaName, 'new_order', 'a description read failure must not sink the download');
  assert.ok(!('description' in e));
});

test('entityFromMetadata emits ONLY custom columns — a downloaded spec must not rewrite the org default views', async () => {
  // `fetchEntityMetadata` returns the FULL attribute list. Emitting system attributes as spec
  // columns is not merely noisy: `columns[]` feeds `defaultViewColumns`, and `enrichDefaultViews`
  // REPLACES the Active/Inactive views' column set — so a `download -> rebuild` round trip would
  // rewrite a customer's default views to Created On / Import Sequence Number, undoing fix #7.
  const meta = {
    logicalName: 'new_ticket', schemaName: 'new_ticket', displayName: 'Ticket', primaryNameAttribute: 'new_name',
    attributes: [
      { logicalName: 'new_name', displayName: 'Name', attributeType: 'String', isCustomAttribute: true },
      { logicalName: 'new_status', displayName: 'Status', attributeType: 'Picklist', isCustomAttribute: true },
      { logicalName: 'new_notes', displayName: 'Notes', attributeType: 'Memo', isCustomAttribute: true },
      { logicalName: 'new_owner', displayName: 'Owner', attributeType: 'Lookup', isCustomAttribute: true, targets: ['systemuser'] },
      { logicalName: 'createdon', displayName: 'Created On', attributeType: 'DateTime', isCustomAttribute: false },
      { logicalName: 'versionnumber', displayName: 'Version Number', attributeType: 'BigInt', isCustomAttribute: false },
      { logicalName: 'importsequencenumber', displayName: 'Import Sequence Number', attributeType: 'Integer', isCustomAttribute: false },
      { logicalName: 'owningbusinessunit', displayName: 'Owning Business Unit', attributeType: 'Lookup', isCustomAttribute: false },
    ],
  };
  const e = entityFromMetadata(meta, 'new_ticket');
  const names = e.columns.map((c) => c.schemaName);
  for (const sys of ['createdon', 'versionnumber', 'importsequencenumber', 'owningbusinessunit']) {
    assert.ok(!names.includes(sys), `system attribute '${sys}' leaked into columns[]: ${names.join(', ')}`);
  }
  // The primary name column is declared as `primaryAttribute`; it must not ALSO be a column.
  assert.ok(!names.includes('new_name'), 'the primary column must not be duplicated into columns[]');
  // A custom Lookup comes from relationships[], not columns[] — it has no App Spec column type.
  assert.ok(!names.includes('new_owner'), 'a Lookup is not an authorable spec column');
  assert.deepStrictEqual(names, ['new_status', 'new_notes']);
  // The SDK projects `attributeType`, not `type`. Reading the wrong key made every column type-less,
  // which silently disabled DEFAULT_VIEW_SKIP_TYPES and the auto-form-layout type filter.
  assert.strictEqual(e.columns.find((c) => c.schemaName === 'new_notes').type, 'Memo');
  // A Choice column is emitted WITHOUT a type: declaring `type: "Choice"` obliges the spec to carry
  // `options[]` or a `globalChoice`, which this hydrator cannot read, and the resulting spec fails
  // its own validation. Live-caught — the download errored with
  // "column ffo_status: Choice needs options[] or a globalChoice reference".
  assert.ok(!('type' in e.columns.find((c) => c.schemaName === 'new_status')),
    'a Choice column must not claim a type it cannot substantiate');
});

test('a hydrated entity always survives validateAppSpec — a downloaded spec that cannot be validated is useless', () => {
  const meta = {
    logicalName: 'new_ticket', schemaName: 'new_ticket', displayName: 'Ticket', primaryNameAttribute: 'new_name',
    attributes: [
      { logicalName: 'new_status', displayName: 'Status', attributeType: 'Picklist', isCustomAttribute: true },
      { logicalName: 'new_choices', displayName: 'Choices', attributeType: 'MultiSelectPicklist', isCustomAttribute: true },
      { logicalName: 'new_notes', displayName: 'Notes', attributeType: 'Memo', isCustomAttribute: true },
      { logicalName: 'new_big', displayName: 'Big', attributeType: 'BigInt', isCustomAttribute: true },
    ],
  };
  const res = validateAppSpec({
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [entityFromMetadata(meta, 'new_ticket')],
    appShell: { areas: [] },
  }, { profile: 'deploy' });
  assert.deepStrictEqual(res.errors, [], res.errors.join(' | '));
});

test('enrichesDefaultViews is FALSE for an existing:true table (download flags every recovered table that way)', () => {
  const spec = {
    entities: [{
      schemaName: 'new_ticket', primaryAttribute: { schemaName: 'new_name' }, existing: true,
      columns: [{ schemaName: 'new_status', type: 'Choice' }, { schemaName: 'new_tier', type: 'Choice' }],
    }],
    relationships: [],
  };
  // Enrichment REPLACES a view's column set, and `existing` means this build cannot prove it owns
  // the table — the same reasoning that stops teardown from deleting it.
  assert.strictEqual(enrichesDefaultViews(spec, spec.entities[0]), false);
  const owned = { ...spec.entities[0], existing: false };
  assert.strictEqual(enrichesDefaultViews({ ...spec, entities: [owned] }, owned), true, 'a table this build owns still enriches');
});

test('iconWebResources looks up web resources by NAME (not id) and maps type from webresourcetype', async () => {
  const calls = [];
  const sdk = {
    queryRecords: async (logical, opts) => {
      calls.push({ logical, filter: opts.filter });
      // svg web resource (webresourcetype 11) with base64 content
      if (/new_rgicon\.svg/.test(opts.filter)) return [{ name: 'new_rgicon.svg', webresourcetype: 11, content: 'BASE64SVG' }];
      return []; // an icon with no matching web resource
    },
  };
  const { webResources: out } = await iconWebResources(sdk, ['new_rgicon.svg', 'missing.png']);
  assert.strictEqual(calls[0].logical, 'webresource', 'queries the webresource logical name');
  assert.match(calls[0].filter, /name eq 'new_rgicon\.svg'/, 'filters by name, not id');
  assert.deepStrictEqual(out, [{ name: 'new_rgicon.svg', type: 'svg', contentBase64: 'BASE64SVG' }]);
});

test('iconWebResources skips a web resource it cannot read (no throw)', async () => {
  const sdk = { queryRecords: async () => { throw new Error('boom'); } };
  const { webResources } = await iconWebResources(sdk, ['x.png']);
  assert.deepStrictEqual(webResources, []);
});

test('droppedSubareaCount counts subareas the spec could not round-trip (e.g. dashboards)', () => {
  const app = { siteMap: { areas: [{ groups: [{ subAreas: [{}, {}, {}, {}] }] }] } }; // 4 deployed
  const spec = { appShell: { areas: [{ groups: [{ subAreas: [{}, {}, {}] }] }] } };    // 3 hydrated
  assert.strictEqual(droppedSubareaCount(app, spec), 1);
  const same = { appShell: { areas: [{ groups: [{ subAreas: [{}, {}, {}, {}] }] }] } };
  assert.strictEqual(droppedSubareaCount(app, same), 0);
});

test('readDashboards reconstructs supported tile shapes and skips unreadable dashboards', async () => {
  const DASH = '{AAAAAAAA-0000-4000-8000-000000000001}';
  const SKIP = '{BBBBBBBB-0000-4000-8000-000000000002}';
  const app = { siteMap: { areas: [{ groups: [{ subAreas: [
    { type: 'DashBoard', dashboardId: DASH, title: 'Sitemap title' },
    { type: 'DashBoard', dashboardId: SKIP, title: 'Broken dashboard' },
  ] }] }] } };
  const sdk = {
    fetchArtifact: async (type, id) => {
      if (String(id).toLowerCase() === SKIP.toLowerCase()) throw new Error('dashboard deleted while downloading');
      return {
        components: [
          { type: 'chart', name: 'Revenue', parameters: { TargetEntityType: 'account', ViewId: '{11111111-0000-4000-8000-000000000001}', VisualizationId: '{22222222-0000-4000-8000-000000000002}' } },
          { type: 'list', name: 'Open Accounts', parameters: { TargetEntityType: 'account', ViewId: '{33333333-0000-4000-8000-000000000003}' } },
          { type: 'iframe', name: 'Portal', parameters: { Url: 'https://contoso.example' } },
          { type: 'webresource', name: 'Help', parameters: { WebResourceName: 'new_help.htm' } },
          { type: 'chart', name: 'Incomplete chart', parameters: { TargetEntityType: 'account' } },
        ],
      };
    },
    queryRecords: async () => [{ name: 'Executive Dashboard', description: 'Leader view of revenue and work.' }],
  };

  const dashboards = await readDashboards(sdk, app);

  assert.strictEqual(dashboards.length, 1);
  assert.strictEqual(dashboards[0].name, 'Executive Dashboard');
  assert.strictEqual(dashboards[0].description, 'Leader view of revenue and work.');
  assert.deepStrictEqual(dashboards[0].tiles, [
    { type: 'chart', name: 'Revenue', entity: 'account', viewId: '11111111-0000-4000-8000-000000000001', visualizationId: '22222222-0000-4000-8000-000000000002' },
    { type: 'list', name: 'Open Accounts', entity: 'account', viewId: '33333333-0000-4000-8000-000000000003' },
    { type: 'iframe', name: 'Portal', url: 'https://contoso.example' },
    { type: 'webresource', name: 'Help', webResource: 'new_help.htm' },
  ]);
});

test('readDashboards omits a null dashboard description instead of emitting a blank string', async () => {
  const sdk = {
    fetchArtifact: async () => ({ components: [{ type: 'iframe', name: 'Portal', parameters: { Url: 'https://contoso.example' } }] }),
    queryRecords: async (_set, opts) => {
      assert.ok(opts.select.includes('description'), 'dashboard name lookup also requests description');
      return [{ name: 'Operations', description: null }];
    },
  };
  const dashboards = await readDashboards(sdk, {
    siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'DashBoard', dashboardId: 'dash-1', title: 'Operations' }] }] }] },
  });
  assert.strictEqual('description' in dashboards[0], false, 'null descriptions are absent, not empty strings');
});

test('readDescriptionInventory captures view, chart, form, business-rule, and global-choice descriptions', async () => {
  const APP_UNIQ_VALUE = '5111e0f2-0000-4000-8000-000000000001';
  const VIEW_ID = '5111e0f2-0000-4000-8000-000000000002';
  const CHART_ID = '5111e0f2-0000-4000-8000-000000000003';
  const FORM_ID = '5111e0f2-0000-4000-8000-000000000004';
  const RULE_ID = '5111e0f2-0000-4000-8000-000000000005';
  const SOL_ID = '5111e0f2-0000-4000-8000-000000000006';
  const calls = [];
  const sdk = {
    // A real table logical name is the ONLY thing queryRecords can take: it resolves its argument
    // via `EntityDefinitions(LogicalName='<arg>')?$select=EntitySetName`. Anything else 404s. Fail
    // loudly on a metadata collection so this mock cannot certify a call the real SDK rejects —
    // which is exactly how the `GlobalOptionSetDefinitions` read passed review while always
    // returning empty in production.
    queryRecords: async (set, opts) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(String(set))) {
        throw new Error(`queryRecords resolves an entity SET name and cannot take the metadata path '${set}' — use sdk.dataverse.get`);
      }
      calls.push({ set, opts });
      const filter = (opts && opts.filter) || '';
      if (set === 'appmodule') return [{ appmoduleidunique: APP_UNIQ_VALUE }];
      if (set === 'appmodulecomponent' && /componenttype eq 26/.test(filter)) return [{ objectid: VIEW_ID }];
      if (set === 'appmodulecomponent' && /componenttype eq 59/.test(filter)) return [{ objectid: CHART_ID }];
      if (set === 'appmodulecomponent' && /componenttype eq 60/.test(filter)) return [{ objectid: FORM_ID }];
      if (set === 'savedquery') return [{ savedqueryid: VIEW_ID, name: 'Active Orders', returnedtypecode: 'new_order', description: 'Work queue.' }];
      if (set === 'savedqueryvisualization') return [{ savedqueryvisualizationid: CHART_ID, name: 'Orders by Status', primaryentitytypecode: 'new_order', description: null }];
      if (set === 'systemform') return [{ formid: FORM_ID, name: 'Main', objecttypecode: 'new_order', description: 'Primary form.' }];
      if (set === 'solution') return [{ solutionid: SOL_ID }];
      if (set === 'solutioncomponent') return [{ objectid: RULE_ID, componenttype: 29 }];
      if (set === 'workflow') return [{ workflowid: RULE_ID, name: 'Lock Closed', primaryentity: 'new_order', description: 'Closed rows are read-only.' }];
      return [];
    },
    dataverse: {
      get: async (url) => {
        calls.push({ get: url });
        if (/^\/GlobalOptionSetDefinitions\?/.test(url)) {
          return { status: 200, headers: {}, body: { value: [{ Name: 'new_priority', Description: { LocalizedLabels: [{ Label: 'Shared priority choices.', LanguageCode: 1033 }] } }] } };
        }
        return { status: 404, headers: {}, body: {} };
      },
    },
  };

  const inv = await readDescriptionInventory(sdk, 'app-1', 'ContosoSolution');

  assert.deepStrictEqual(inv.views[0], { id: VIEW_ID, name: 'Active Orders', entity: 'new_order', description: 'Work queue.' });
  assert.strictEqual('description' in inv.charts[0], false, 'null chart descriptions are omitted');
  assert.deepStrictEqual(inv.forms[0], { id: FORM_ID, name: 'Main', entity: 'new_order', description: 'Primary form.' });
  assert.deepStrictEqual(inv.businessRules[0], { id: RULE_ID, name: 'Lock Closed', entity: 'new_order', description: 'Closed rows are read-only.' });
  assert.deepStrictEqual(inv.globalChoices[0], { name: 'new_priority', description: 'Shared priority choices.' });
  assert.ok(calls.some((c) => c.set === 'savedquery' && c.opts.select.includes('description')), 'view read selects description');
  assert.ok(calls.some((c) => c.set === 'savedqueryvisualization' && c.opts.select.includes('description')), 'chart read selects description');
  assert.ok(calls.some((c) => c.set === 'systemform' && c.opts.select.includes('description')), 'form read selects description');
  assert.ok(calls.some((c) => c.set === 'workflow' && c.opts.select.includes('description')), 'business-rule read selects description');
  assert.ok(calls.some((c) => c.get === '/GlobalOptionSetDefinitions?$select=Name,Description'),
    `global choices must be read through the RAW client (queryRecords cannot take a metadata path); calls: ${JSON.stringify(calls.map((c) => c.get || c.set))}`);
});

test('readDashboards keeps the sitemap title when the dashboard name lookup fails', async () => {
  const sdk = {
    fetchArtifact: async () => ({ components: [{ type: 'iframe', name: 'Portal', parameters: { Url: 'https://contoso.example' } }] }),
    queryRecords: async () => { throw new Error('systemform read throttled'); },
  };
  const dashboards = await readDashboards(sdk, {
    siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'DashBoard', dashboardId: 'dash-1', title: 'Operations' }] }] }] },
  });
  assert.strictEqual(dashboards[0].name, 'Operations');
});

// ── Task 11: assignPageKeys + missingDownloads + full round-trip ──────────────
const { assignPageKeys, missingDownloads, runDownload, recoverAppSolution, appComponentEntities } = require('../download-model-app.js');
const { reconcilePageIds, buildManifest } = require('../lib/page-manifest.js');
const { hydrateSpec } = require('../lib/hydrate-spec.js');
const { validateAppSpec } = require('../lib/app-spec.js');
// `enrichesDefaultViews` gates the destructive default-view rewrite; a DOWNLOADED table is flagged
// `existing: true` because ownership is unprovable, so it must never trigger that rewrite.
const { enrichesDefaultViews } = require('../lib/sdk-build.js');
const { appUniqueName } = require('../lib/sdk-build.js');
const { resolvePageRefs, reverseResolveNavIds } = require('../lib/pageref-resolver.js');

test('runDownload translates a fail-closed app read into a graceful error, not a raw SDK throw', async () => {
  // `fetchArtifact('app')` fails closed (`APP_SITEMAP_UNRESOLVED`) rather than hand back an app whose
  // navigation is untrustworthy. The sitemap IS this function's membership oracle, so that is a
  // LOGICAL failure of the class its contract says it RETURNS rather than throws — otherwise the CLI
  // surfaces an opaque SDK error for the very ordinary case of an unpublished app.
  for (const code of ['APP_SITEMAP_UNRESOLVED', 'APP_UPDATE_NO_ETAG']) {
    const err = new Error('app sitemap could not be resolved');
    err.code = code;
    const sdk = { fetchArtifact: async () => { throw err; } };
    const genpageCli = { enumerateEnv: async () => ({ ok: true, pages: [] }), download: async () => true };
    const res = await runDownload({ sdk, genpageCli, outDir: __dirname, appId: 'app-1', appUnique: 'new_app' });
    assert.strictEqual(res.ok, false, `${code} must return ok:false`);
    assert.match(res.error, /cannot read app app-1/, `${code} error names the app`);
    assert.match(res.error, /sitemap could not be resolved/, `${code} keeps the underlying reason`);
  }
});

test('runDownload still propagates a genuinely unexpected error (no blanket swallow)', async () => {
  // Only the two fail-closed read codes are translated. An unexpected I/O error must keep propagating
  // to main().catch, or a real defect would be reported as an ordinary "download failed".
  const err = new Error('EACCES: permission denied');
  err.code = 'EACCES';
  const sdk = { fetchArtifact: async () => { throw err; } };
  const genpageCli = { enumerateEnv: async () => ({ ok: true, pages: [] }), download: async () => true };
  await assert.rejects(
    runDownload({ sdk, genpageCli, outDir: __dirname, appId: 'app-1', appUnique: 'new_app' }),
    (caught) => caught && caught.code === 'EACCES'
  );
});

test('assignPageKeys: reuses the manifest key + v2 semantics for a reconcile-bound page, mints fresh keys otherwise (I3/§7.3)', () => {
  const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_X = '9f2b1a3c-77de-4a10-8b6e-2c4d5e6f7a8b';
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O, purpose: 'Home', navigatesTo: [{ targetKey: 'detail' }], pageInput: { data: {} } }] };
  const downloaded = [
    { pageId: GP_O, name: 'Overview', dataSources: [], codeFile: `p/${GP_O}/page.tsx` },
    { pageId: GP_X, name: 'Some Legacy Page', dataSources: [], codeFile: `p/${GP_X}/page.tsx` },
  ];
  // 4-arg reconcilePageIds: both existence and sitemap are the downloaded page ids (download path)
  const { keyToId } = reconcilePageIds(manifest.pages, manifest, [GP_O, GP_X], [GP_O, GP_X]);
  const idToKey = assignPageKeys(downloaded, manifest, keyToId);
  assert.strictEqual(downloaded[0].key, 'overview');
  assert.deepStrictEqual(downloaded[0].navigatesTo, [{ targetKey: 'detail' }]);
  assert.strictEqual(downloaded[0].purpose, 'Home');
  assert.strictEqual(downloaded[1].key, 'some-legacy-page', 'a page with no manifest binding gets a fresh slug key, not the old name');
  assert.strictEqual(idToKey.get(GP_O), 'overview');
  assert.strictEqual(idToKey.get(GP_X), 'some-legacy-page');
});

test('assignPageKeys: mints unique keys (no manifest) with -N de-dup on slug collision', () => {
  const downloaded = [{ pageId: 'a', name: 'Work Order', dataSources: [], codeFile: 'a' }, { pageId: 'b', name: 'Work Order', dataSources: [], codeFile: 'b' }];
  assignPageKeys(downloaded, null, new Map());
  assert.deepStrictEqual(downloaded.map((p) => p.key), ['work-order', 'work-order-2']);
});

test('missingDownloads flags a gap in EITHER direction (I3 exact enumerated<->downloaded equality)', () => {
  const enumPages = [{ pageId: 'gp-o', name: 'Overview' }, { pageId: 'gp-d', name: 'Detail' }];
  const downloaded = [{ pageId: 'gp-o', name: 'Overview' }];
  assert.deepStrictEqual(missingDownloads(enumPages, downloaded).map((p) => p.pageId), ['gp-d'], 'enumerated-but-not-downloaded');
  assert.deepStrictEqual(missingDownloads(downloaded, enumPages), [], 'downloaded-and-enumerated → no extra');
  assert.deepStrictEqual(missingDownloads(enumPages, enumPages), []);
});

test('ROUND-TRIP: manifest → download → reverse → hydrate → validate → resolve reproduces the deployed ids (Critical 2/I3)', async () => {
  const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_D = '5c0a4889-45fd-46ea-91a8-ff876914d644';
  const manifest = buildManifest({ pages: [{ key: 'overview', name: 'Overview', navigatesTo: [{ targetKey: 'detail' }] }, { key: 'detail', name: 'Detail' }] }, new Map([['overview', GP_O], ['detail', GP_D]]));
  const deployedOverview = `Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "${GP_D}", data: {} });`;
  const downloaded = [
    { pageId: GP_O, name: 'Overview', dataSources: [], codeFile: 'overview.tsx', _code: deployedOverview },
    { pageId: GP_D, name: 'Detail', dataSources: [], codeFile: 'detail.tsx', _code: 'export default function D(){ return null; }' },
  ];
  // 4-arg reconcilePageIds: sitemap ids are both existence and membership for the download path
  const { keyToId, conflicts } = reconcilePageIds(manifest.pages, manifest, [GP_O, GP_D], [GP_O, GP_D]);
  assert.deepStrictEqual(conflicts, []);
  const idToKey = assignPageKeys(downloaded, manifest, keyToId);
  for (const p of downloaded) p._reversed = reverseResolveNavIds(p._code, idToKey);
  assert.ok(downloaded[0]._reversed.includes('"PAGEREF_detail"'), 'overview nav reversed back to the symbolic key');
  const spec = await hydrateSpec({
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'GenPage', genPageId: GP_O, title: 'Overview' }, { type: 'GenPage', genPageId: GP_D, title: 'Detail' }] }] }] } }),
    pages: async () => downloaded,
    entities: async () => [{ schemaName: 'contoso_item', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    webResources: async () => [], solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
    design: async () => manifest.design,
  });
  const v = validateAppSpec(spec, { profile: 'plan' });
  assert.ok(v.ok, v.errors.join('; '));
  assert.strictEqual(spec.pages.find((p) => p.key === 'overview').navigatesTo[0].targetKey, 'detail');
  assert.strictEqual(spec.appShell.areas[0].groups[0].subAreas[0].page, 'overview', 'GenPage subarea resolved by KEY');
  const resolved = resolvePageRefs(new Map([['overview', { code: downloaded[0]._reversed }]]), keyToId).deployment.get('overview');
  assert.ok(resolved.includes(`pageId: "${GP_D}"`) && !/PAGEREF_/.test(resolved), 'reverse∘resolve returns the deployed id — the loop is closed');
});

// ── Task 6: sitemap-membership + download-by-id + keep pageId + env-wide names + injectable seam ─

test('Task-6: Maker-added page (sitemap, not in manifest) gets a minted key, keeps pageId (C3)', () => {
  const GP_O = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_MAKER = '9f2b1a3c-77de-4a10-8b6e-2c4d5e6f7a8b';
  // manifest knows only GP_O; GP_MAKER was added in Maker and is only in the sitemap
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_O }] };
  const pages = [
    { pageId: GP_O,    name: 'Overview',   dataSources: [], codeFile: `pages/${GP_O}/page.tsx` },
    { pageId: GP_MAKER, name: 'Maker Page', dataSources: [], codeFile: `pages/${GP_MAKER}/page.tsx` },
  ];
  const sitemapIds = [GP_O, GP_MAKER];
  const { keyToId, conflicts } = reconcilePageIds(manifest.pages, manifest, sitemapIds, sitemapIds);
  assert.deepStrictEqual(conflicts, []);
  const idToKey = assignPageKeys(pages, manifest, keyToId);
  // Manifest-bound page reuses its key
  assert.strictEqual(pages[0].key, 'overview', 'manifest-bound page reuses its key');
  assert.strictEqual(pages[0].pageId, GP_O, 'pageId preserved (C3)');
  // Maker-added page gets a fresh key and keeps its pageId
  assert.ok(pages[1].key, 'Maker-added page has a minted key');
  assert.strictEqual(pages[1].pageId, GP_MAKER, 'Maker-added page pageId preserved for edit-snapshot adoption (C3)');
  // Both ids are in idToKey so nav reverse-resolve covers all pages
  assert.strictEqual(idToKey.get(GP_O), 'overview');
  assert.ok(idToKey.has(GP_MAKER), 'Maker-added page id is in idToKey (nav reverse-resolve works)');
});

test('Task-6: sitemap id not downloaded → missingDownloads catches it → download aborts (I3)', () => {
  const GP_A = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_B = '5c0a4889-45fd-46ea-91a8-ff876914d644';
  // Both GP_A and GP_B are in the sitemap, but only GP_A was downloaded
  const smPages = [{ pageId: GP_A, title: 'Overview' }, { pageId: GP_B, title: 'Detail' }];
  const downloaded = [{ pageId: GP_A, name: 'Overview' }];
  const missing = missingDownloads(smPages, downloaded);
  assert.strictEqual(missing.length, 1, 'one page flagged as missing (sitemap id not downloaded)');
  assert.strictEqual(missing[0].pageId, GP_B, 'GP_B is the missing page');
  // Reverse: no extra (downloaded is a strict subset of sitemap)
  assert.deepStrictEqual(missingDownloads(downloaded, smPages), []);
});

test('Task-6: env-wide id→name used as the page name; sitemap title is fallback only', () => {
  const GP = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-nm-'));
  try {
    fs.mkdirSync(path.join(out, 'pages', GP), { recursive: true });
    fs.writeFileSync(path.join(out, 'pages', GP, 'page.tsx'), '');
    // sitemap title is 'Sitemap Overview'; env-wide name is 'Order Overview' (different)
    // Simulate the nameById built in runDownload: env-wide primary, sitemap title fallback
    const envNameById = new Map([[GP.toLowerCase(), 'Order Overview']]);
    const sitemapTitle = 'Sitemap Overview';
    const nameById = new Map([[GP.toLowerCase(), envNameById.get(GP.toLowerCase()) || sitemapTitle]]);
    const pages = parseDownloadedPages(path.join(out, 'pages'), out, nameById);
    assert.strictEqual(pages[0].name, 'Order Overview', 'env-wide name takes precedence over sitemap title');
    assert.strictEqual(pages[0].pageId, GP, 'pageId preserved');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('Task-6: full round-trip via runDownload → hydrateSpec → validateAppSpec ok, pages carry pageId (injectable seam)', async () => {
  const GP_A = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const GP_B = '5c0a4889-45fd-46ea-91a8-ff876914d644';
  const APP_ID   = 'a1b2c3d4-0000-4000-8000-000000000001';
  const APP_UNIQ_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd'; // appmoduleidunique lookup GUID
  const SM_ID    = '5111e0f2-0000-4000-8000-0000000000aa';
  const APP_UNIQUE = 'test_roundtrip';
  const SM_XML = `<SiteMap><Area><Group><SubArea GenPageId="${GP_A}" Title="Sitemap A"/><SubArea GenPageId="${GP_B}" Title="Sitemap B"/></Group></Area></SiteMap>`;

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-rt-'));
  try {
    const mockSdk = {
      fetchArtifact: async () => ({
        name: 'Test App', description: '',
        siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [
          { type: 'GenPage', genPageId: GP_A, title: 'Sitemap A' },
          { type: 'GenPage', genPageId: GP_B, title: 'Sitemap B' },
          { type: 'Entity', entity: 'contoso_item' },  // at least one entity required by plan profile
        ] }] }] },
      }),
      queryRecords: async (logical, opts) => {
        const filter = (opts && opts.filter) || '';
        if (logical === 'appmodule') {
          // fetchSitemap calls this with uniquename filter; un-filtered call returns all apps
          const m = filter.match(/uniquename eq '([^']+)'/);
          if (m) return m[1] === APP_UNIQUE ? [{ appmoduleid: APP_ID, appmoduleidunique: APP_UNIQ_VALUE }] : [];
          return [{ appmoduleid: APP_ID, appmoduleidunique: APP_UNIQ_VALUE, uniquename: APP_UNIQUE }];
        }
        if (logical === 'appmodulecomponent') return [{ objectid: SM_ID, componenttype: 62 }];
        if (logical === 'sitemap') return [{ sitemapxml: SM_XML }];
        if (logical === 'webresource') return []; // no manifest → fresh keys
        // The app belongs to a real unmanaged solution — recoverAppSolution returns its uniquename, but the
        // publisher PREFIX must still come from the app uniquename ('test'), NOT this solution (Sol F2).
        if (logical === 'solutioncomponent') return [{ _solutionid_value: 'sol-x' }];
        if (logical === 'solution') return [{ solutionid: 'sol-x', uniquename: 'ContosoSln', ismanaged: false, description: 'The Contoso field-operations solution.' }];
        return [];
      },
      fetchEntityMetadata: async (logical) => ({
        schemaName: logical, displayName: 'Item', primaryNameAttribute: `${String(logical).split('_')[0]}_name`,
      }),
    };
    const mockGenpageCli = {
      // Env-wide names differ from sitemap titles (the core addenda new-1 distinction)
      enumerateEnv: async () => ({
        ok: true,
        ids: [GP_A.toLowerCase(), GP_B.toLowerCase()],
        pages: [{ pageId: GP_A, name: 'Env Name A' }, { pageId: GP_B, name: 'Env Name B' }],
      }),
      download: async ({ outputDir, pageIds }) => {
        // Write minimal page files so parseDownloadedPages can read them
        for (const pid of (pageIds || [])) {
          fs.mkdirSync(path.join(outputDir, pid), { recursive: true });
          fs.writeFileSync(path.join(outputDir, pid, 'page.tsx'), 'export default function P() { return null; }');
        }
        return true;
      },
    };

    const result = await runDownload({ sdk: mockSdk, genpageCli: mockGenpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE });
    assert.ok(result.ok, JSON.stringify(result));
    const { spec } = result;
    // Full spec validates (profile:'plan' enforces every page is a sitemap subarea)
    const v = validateAppSpec(spec, { profile: 'plan' });
    assert.ok(v.ok, v.errors.join('; '));
    // Every page carries its pageId (C3 edit-snapshot self-description)
    assert.ok(spec.pages.every((p) => p.pageId !== undefined), 'every page in the spec carries its pageId');
    assert.strictEqual(spec.pages.length, 2, 'recovered spec has every sitemap page (no drop)');
    // Env-wide names used (not sitemap titles) — the core addenda new-1 assertion
    const pageA = spec.pages.find((p) => p.pageId === GP_A);
    assert.strictEqual(pageA.name, 'Env Name A', 'env-wide name used as page name (not sitemap title "Sitemap A")');
    // App identity round-trips: the REAL immutable uniquename is captured (so a rebuild resolves the
    // existing app even after a display-name rename) and the publisher prefix is derived FROM it.
    assert.strictEqual(spec.app.uniqueName, APP_UNIQUE, 'the app real uniquename round-trips into spec.app.uniqueName');
    assert.strictEqual(spec.solution.uniqueName, 'ContosoSln', 'the real unmanaged solution uniquename is recovered for teardown');
    // `solution` is assembled field-by-field in runDownload (not spread from recoverAppSolution, so an
    // unrecovered solution still gets its required defaults). That makes every field an explicit copy,
    // and a field that is read but not copied is silently dropped — which is what happened here.
    assert.strictEqual(spec.solution.description, 'The Contoso field-operations solution.',
      'the recovered solution description must be carried into the spec, not dropped by the field-by-field copy');
    assert.strictEqual(spec.solution.publisherPrefix, 'test', 'this mock SDK exposes no getSolution, so the prefix falls back to the app uniquename (test_roundtrip → test); when getSolution IS available the solution publisher wins — see the recoverAppSolution tests');
    assert.strictEqual(appUniqueName(spec), APP_UNIQUE, 'appUniqueName resolves the REAL uniquename (identity lookup finds the existing app, no duplicate) even though the display name is "Test App"');
    assert.ok(!('prefixResolved' in spec.solution), 'the transient prefixResolved flag is stripped from the persisted spec');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ── recoverAppSolution: recover an app's REAL unmanaged solution (fixes the download→teardown
// round-trip). An app module is a solutioncomponent of EVERY solution it belongs to — the built-in
// system solutions (Active/Default/Basic) AND the real one it was created in. The old code took
// top:1 with no ordering and often got 'Default' (also ismanaged=false), so hydrate defaulted the
// spec's solution to the restricted Default and a downloaded spec could never tear down its own
// solution (teardown 400s on Default, orphaning the real one). ──────────────────────────────
test('recoverAppSolution enumerates ALL memberships and returns the real unmanaged solution uniquename (does NOT recover a prefix — that comes from the app uniquename)', async () => {
  const APP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let publisherQueried = false;
  const sdk = {
    queryRecords: async (logical, opts) => {
      if (logical === 'solutioncomponent') {
        assert.match(opts.filter, new RegExp(`objectid eq ${APP}`), 'filters components by the app id');
        assert.notStrictEqual(opts.top, 1, 'must NOT cap at top:1 — an app belongs to multiple solutions');
        return [
          { _solutionid_value: 'sol-default' },
          { _solutionid_value: 'sol-active' },
          { _solutionid_value: 'sol-real' },
        ];
      }
      if (logical === 'solution') {
        return [
          { solutionid: 'sol-default', uniquename: 'Default', ismanaged: false },
          { solutionid: 'sol-active', uniquename: 'Active', ismanaged: false },
          { solutionid: 'sol-real', uniquename: 'NucleoLive2', ismanaged: false },
        ];
      }
      if (logical === 'publisher') { publisherQueried = true; return [{ customizationprefix: 'crba3' }]; }
      return [];
    },
  };
  const sol = await recoverAppSolution(sdk, APP);
  assert.deepStrictEqual(sol, { uniqueName: 'NucleoLive2' }, 'returns ONLY the real solution uniquename');
  assert.strictEqual(publisherQueried, false, 'no publisher lookup — the prefix is NOT sourced from an arbitrary solution membership (Sol review)');
});

test('recoverAppSolution ignores managed solutions and returns null when only system/managed remain', async () => {
  const sdk = {
    queryRecords: async (logical) => {
      if (logical === 'solutioncomponent') return [{ _solutionid_value: 'sol-default' }, { _solutionid_value: 'sol-mgd' }];
      if (logical === 'solution') {
        return [
          { solutionid: 'sol-default', uniquename: 'Default', ismanaged: false },
          { solutionid: 'sol-mgd', uniquename: 'SomeManagedPack', ismanaged: true },
        ];
      }
      return [];
    },
  };
  assert.strictEqual(await recoverAppSolution(sdk, 'app'), null);
});

test('recoverAppSolution returns null when the app has no solution components (caller keeps its default)', async () => {
  const sdk = { queryRecords: async () => [] };
  assert.strictEqual(await recoverAppSolution(sdk, 'app'), null);
});

test('recoverAppSolution never throws — a query error resolves to null (best-effort)', async () => {
  const sdk = { queryRecords: async () => { throw new Error('boom'); } };
  assert.strictEqual(await recoverAppSolution(sdk, 'app'), null);
});

// ── OOB-table round-trip fixes (ADO 6603392 / 6603390 / 6603388) ───────────────────────────────
// All three surfaced on an app built from STANDARD Dataverse tables. Each was masked on custom
// tables, which is why they survived earlier testing.

test('entityFromMetadata uses the REAL primary-name attribute for OOB tables (no <entity>_name guess)', () => {
  // The old fallback produced `account_name` / `contact_name`, neither of which exists. It looked
  // plausible on a custom table (`co_ticket` -> `co_name`), which is exactly why it went unnoticed.
  const account = entityFromMetadata({ logicalName: 'account', schemaName: 'Account', displayName: 'Account', primaryNameAttribute: 'name' }, 'account');
  assert.strictEqual(account.primaryAttribute.schemaName, 'name');
  const contact = entityFromMetadata({ logicalName: 'contact', schemaName: 'Contact', displayName: 'Contact', primaryNameAttribute: 'fullname' }, 'contact');
  assert.strictEqual(contact.primaryAttribute.schemaName, 'fullname');
});

test('entityFromMetadata reports a NULL primaryAttribute rather than synthesizing one', () => {
  // Emitting a fabricated attribute name yields a spec that references a column Dataverse does not
  // have. Omitting the field entirely is no better — `primaryAttribute` is REQUIRED by App Spec
  // validation, so the spec would simply fail to validate later with a confusing error. Signalling
  // null lets runDownload fail the download loudly, naming the table.
  const e = entityFromMetadata({ logicalName: 'account', displayName: 'Account' }, 'account');
  assert.strictEqual(e.primaryAttribute, null, 'must not invent a primary attribute');
  assert.strictEqual(e.existing, true, 'still flagged pre-existing (teardown protection)');
});

test('a downloaded entity WITH real metadata validates as an App Spec entity', () => {
  // Guards the regression the null-signalling above could otherwise introduce: the normal path must
  // still produce a spec that actually validates and can be rebuilt.
  const { validateAppSpec } = require('../lib/app-spec.js');
  const account = entityFromMetadata({ logicalName: 'account', schemaName: 'Account', displayName: 'Account', primaryNameAttribute: 'name' }, 'account');
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'co' },
    app: { name: 'Customer Management', uniqueName: 'contoso_customermanagement' },
    entities: [account],
    views: [], charts: [], forms: [], commands: [], dashboards: [], pages: [],
    webResources: [], appShell: { areas: [] },
  };
  const r = validateAppSpec(spec);
  assert.ok(r.ok, JSON.stringify(r.errors));
});

test('recoverAppSolution recovers the publisher prefix from the SOLUTION, not the app name', async () => {
  const sdk = {
    queryRecords: async (set) => {
      if (set === 'solutioncomponent') return [{ _solutionid_value: 'sol-1' }];
      if (set === 'solution') return [{ solutionid: 'sol-1', uniquename: 'ContosoCustomerManagement', ismanaged: false, description: 'Customer management assets.' }];
      return [];
    },
    getSolution: async (uniqueName) => ({ uniqueName, publisherPrefix: 'contoso' }),
  };
  assert.deepStrictEqual(await recoverAppSolution(sdk, 'app-1'), { uniqueName: 'ContosoCustomerManagement', description: 'Customer management assets.', publisherPrefix: 'contoso' });
});

test('recoverAppSolution degrades to uniqueName-only when the prefix cannot be recovered', async () => {
  const base = {
    queryRecords: async (set) => {
      if (set === 'solutioncomponent') return [{ _solutionid_value: 'sol-1' }];
      if (set === 'solution') return [{ solutionid: 'sol-1', uniquename: 'ContosoCustomerManagement', ismanaged: false }];
      return [];
    },
  };
  // (a) an older vendored bundle with no getSolution at all
  assert.deepStrictEqual(await recoverAppSolution(base, 'app-1'), { uniqueName: 'ContosoCustomerManagement' });
  // (b) getSolution throws
  assert.deepStrictEqual(await recoverAppSolution({ ...base, getSolution: async () => { throw new Error('boom'); } }, 'app-1'), { uniqueName: 'ContosoCustomerManagement' });
  // (c) a first-party publisher with no customization prefix -> not usable, so not reported
  assert.deepStrictEqual(await recoverAppSolution({ ...base, getSolution: async () => ({ publisherPrefix: '' }) }, 'app-1'), { uniqueName: 'ContosoCustomerManagement' });
});

// The nine entities from the filed repro: an app on account/contact also carries activity, user and
// note tables that have no sitemap entry of their own. Their membership is recovered from the app's
// VIEW/CHART/FORM components — componenttype 1 (Entities) is unusable because every such row carries
// the same objectid (the `entity` metadata table's own id), LIVE-verified.
const NINE = ['account', 'contact', 'task', 'email', 'appointment', 'phonecall', 'systemuser', 'team', 'annotation'];
const componentSdk = (opts = {}) => {
  const entities = opts.entities || NINE;
  // Give every entity one view, one chart and one form component, with a distinguishable row id.
  const viewId = (n) => `1000${NINE.indexOf(n)}000-0000-4000-8000-000000000001`;
  const chartId = (n) => `2000${NINE.indexOf(n)}000-0000-4000-8000-000000000002`;
  const formId = (n) => `3000${NINE.indexOf(n)}000-0000-4000-8000-000000000003`;
  return {
    queryRecords: async (set, o) => {
      const filter = (o && o.filter) || '';
      if (set === 'appmodule') return [{ appmoduleidunique: 'appuniq-1' }];
      if (set === 'appmodulecomponent') {
        assert.match(filter, /_appmoduleidunique_value eq appuniq-1/);
        if (/componenttype eq 26/.test(filter)) return entities.map((n) => ({ objectid: viewId(n), componenttype: 26 }));
        if (/componenttype eq 59/.test(filter)) return entities.map((n) => ({ objectid: chartId(n), componenttype: 59 }));
        if (/componenttype eq 60/.test(filter)) return entities.map((n) => ({ objectid: formId(n), componenttype: 60 }));
        // componenttype 1 must NOT be consulted — it cannot identify a table.
        assert.fail(`unexpected componenttype filter: ${filter}`);
      }
      // Resolve each component id back to its owning entity via that table's own entity field.
      if (set === 'savedquery') return entities.filter((n) => filter.includes(viewId(n))).map((n) => ({ savedqueryid: viewId(n), returnedtypecode: n }));
      if (set === 'savedqueryvisualization') return entities.filter((n) => filter.includes(chartId(n))).map((n) => ({ savedqueryvisualizationid: chartId(n), primaryentitytypecode: n }));
      if (set === 'systemform') return entities.filter((n) => filter.includes(formId(n))).map((n) => ({ formid: formId(n), objecttypecode: n }));
      return [];
    },
  };
};

test('appComponentEntities recovers ALL app entity components, not just sitemap-visible ones', async () => {
  const got = await appComponentEntities(componentSdk(), 'app-1');
  assert.deepStrictEqual(got.slice().sort(), NINE.slice().sort());
});

test('appComponentEntities is best-effort — every failure path yields [] so download still works', async () => {
  assert.deepStrictEqual(await appComponentEntities(componentSdk(), null), []);
  assert.deepStrictEqual(await appComponentEntities({ queryRecords: async () => { throw new Error('x'); } }, 'app-1'), []);
  // An app whose components resolve to nothing.
  assert.deepStrictEqual(await appComponentEntities(componentSdk({ entities: [] }), 'app-1'), []);
  // An app row without appmoduleidunique (the lookup parent) cannot be queried.
  assert.deepStrictEqual(await appComponentEntities({ queryRecords: async () => [{}] }, 'app-1'), []);
});

test('runDownload: a sitemap table with no primary name HARD-FAILS naming it; a component-only one is dropped', async () => {
  // The riskiest new behaviour (hard-failing a previously-working download) had no executable
  // coverage — the old test only called entityFromMetadata directly, so the branch it named
  // (`sitemapSet.has(logical) ? noPrimaryName : droppedComponents`) would have passed inverted.
  const APP_ID = '5111e0f2-0000-4000-8000-00000000000a';
  const APP_UNIQ_VALUE = '5111e0f2-0000-4000-8000-00000000000b';
  const APP_UNIQUE = 'test_roundtrip';
  const VIEW_ID = '5111e0f2-0000-4000-8000-00000000000c';
  const SM_ID = '5111e0f2-0000-4000-8000-00000000000d';
  const SM_XML = '<SiteMap><Area><Group><SubArea Entity="account" Title="Accounts"/></Group></Area></SiteMap>';
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-pn-'));
  // `account` is in the sitemap; `annotation` is reachable ONLY as a view component. Neither has a
  // primary name, so they must take different branches.
  const mkSdk = () => ({
    fetchArtifact: async () => ({
      name: 'PN App', description: '',
      siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'Entity', entity: 'account' }] }] }] },
    }),
    queryRecords: async (logical, opts) => {
      const filter = (opts && opts.filter) || '';
      if (logical === 'appmodule') {
        const m = filter.match(/uniquename eq '([^']+)'/);
        if (m) return m[1] === APP_UNIQUE ? [{ appmoduleid: APP_ID, appmoduleidunique: APP_UNIQ_VALUE }] : [];
        return [{ appmoduleid: APP_ID, appmoduleidunique: APP_UNIQ_VALUE, uniquename: APP_UNIQUE }];
      }
      if (logical === 'appmodulecomponent') {
        if (/componenttype eq 26/.test(filter)) return [{ objectid: VIEW_ID, componenttype: 26 }];
        if (/componenttype eq 62/.test(filter)) return [{ objectid: SM_ID, componenttype: 62 }];
        return [{ objectid: SM_ID, componenttype: 62 }];
      }
      if (logical === 'sitemap') return [{ sitemapxml: SM_XML }];
      if (logical === 'savedquery') return [{ savedqueryid: VIEW_ID, returnedtypecode: 'annotation' }];
      if (logical === 'webresource') return [];
      return [];
    },
    // Both report an EMPTY PrimaryNameAttribute (the shape the SDK really returns).
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, schemaName: logical, displayName: logical, primaryNameAttribute: '' }),
  });
  const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), download: async () => true };
  try {
    const failed = await runDownload({ sdk: mkSdk(), genpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE });
    assert.strictEqual(failed.ok, false, 'a sitemap table with no primary name must abort the download');
    assert.match(failed.error, /account/, 'the failure names the offending sitemap table');
    assert.ok(!/annotation/.test(failed.error), 'a component-only table must NOT be named as a hard failure');
    assert.match(failed.error, /--allow-lossy-download/, 'the hard failure advertises its override');
    // ...and with the override it degrades to a warning instead of producing nothing at all.
    const lossy = await runDownload({ sdk: mkSdk(), genpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE, allowLossy: true });
    assert.strictEqual(lossy.ok, true, `--allow-lossy-download must let the download complete: ${JSON.stringify(lossy)}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a COMPONENT-only table with no primary name is dropped with a warning, not a hard download failure', async () => {
  // appComponentEntities is best-effort by contract, so its output must not be able to abort the whole
  // download. A hidden component table (never in the sitemap, so it did not appear in the spec at all
  // before this change) that Dataverse reports with no PrimaryNameAttribute would otherwise regress a
  // previously-working download — and there is no --allow-lossy override for it.
  const sitemapOnly = new Set(['account']);
  const metaFor = (logical) => (sitemapOnly.has(logical)
    ? { logicalName: logical, schemaName: 'Account', displayName: 'Account', primaryNameAttribute: 'name' }
    // The SDK returns '' (not undefined) when PrimaryNameAttribute is absent.
    : { logicalName: logical, schemaName: logical, displayName: logical, primaryNameAttribute: '' });
  const good = entityFromMetadata(metaFor('account'), 'account');
  const bad = entityFromMetadata(metaFor('annotation'), 'annotation');
  assert.strictEqual(good.primaryAttribute.schemaName, 'name');
  assert.strictEqual(bad.primaryAttribute, null, 'an empty PrimaryNameAttribute must not become a guessed name');
});

test('collectSitemap collects the web resource a URL subarea TARGETS, so its content is fetched (#430)', () => {
  // The Site Map Designer's "custom page backed by an HTML web resource" writes a token into a URL
  // subarea. Without collecting it, a rebuild would emit a nav entry pointing at a resource the spec
  // never recreates -- a dangling link in the target environment.
  const app = {
    siteMap: {
      areas: [{
        title: 'Main',
        groups: [{
          title: 'G',
          subAreas: [
            { type: 'URL', url: '$webresource:new_homepage.html', title: 'Home' },
            { type: 'URL', url: '/WebResources/new_second.html', title: 'Second' },
            { type: 'URL', url: 'https://contoso.example/help', title: 'Help' },
          ],
        }],
      }],
    },
  };
  const { customRefs, navRefs } = collectSitemap(app);
  assert.ok(navRefs.includes('new_homepage.html'), '$webresource: token must be collected as a NAV ref');
  assert.ok(navRefs.includes('new_second.html'), '/WebResources/ form must be collected as a NAV ref');
  assert.strictEqual(
    navRefs.some((r) => /contoso\.example|https/.test(r)), false,
    'a real http(s) link is not a web resource and must NOT be collected',
  );
});

test('iconWebResources re-declares a NON-IMAGE web resource a URL subarea targets (#430)', async () => {
  // The icon path gates on IMAGE_WR_TYPES by design, and a "custom page backed by an HTML web
  // resource" is html (type 1). Without a separate nav-ref policy the page is never re-declared, so a
  // rebuild's nav entry points at a resource the spec cannot recreate -- the fix would look complete
  // and still be broken.
  const sdk = { queryRecords: async (_set, o) => {
    const name = (/name eq '([^']+)'/.exec(o.filter) || [])[1];
    if (name === 'crba3_homepage.html') return [{ name, webresourcetype: 1, content: 'PGh0bWw+', ismanaged: false }];
    if (name === 'crba3_nav.svg') return [{ name, webresourcetype: 11, content: 'c3Zn', ismanaged: false }];
    return [];
  } };
  const { webResources } = await iconWebResources(sdk, [], ['crba3_nav.svg'], 'crba3', true, ['crba3_homepage.html']);
  const byName = Object.fromEntries(webResources.map((w) => [w.name, w]));
  assert.ok(byName['crba3_homepage.html'], 'the html nav page must be re-declared');
  assert.strictEqual(byName['crba3_homepage.html'].type, 'html');
  assert.strictEqual(byName['crba3_homepage.html'].external, true, 'external:true so teardown never deletes it');
  assert.ok(byName['crba3_nav.svg'], 'the icon path must still work');
});

test('a MANAGED nav web resource is left as a bare reference, not re-declared (#430)', async () => {
  // It exists in every environment; re-creating it would be wrong, and failing the download over it
  // is what issue #430 was.
  const sdk = { queryRecords: async (_set, o) => {
    const name = (/name eq '([^']+)'/.exec(o.filter) || [])[1];
    if (name === 'crba3_managed.html') return [{ name, webresourcetype: 1, content: 'eA==', ismanaged: true }];
    return [];
  } };
  const { webResources } = await iconWebResources(sdk, [], [], 'crba3', true, ['crba3_managed.html']);
  assert.strictEqual(webResources.length, 0, 'a managed nav resource must not be re-declared');
});

test('a FOREIGN-prefix nav web resource is left as a bare reference, not re-declared (#430)', async () => {
  // Together with the managed case above, this pins why nav refs go through PASS 1 rather than being
  // added to `icons`. PASS 2 (the bare-name path) applies NEITHER an `ismanaged` check NOR an
  // own-prefix check, so routing nav targets there would re-declare a resource owned by another
  // publisher's managed solution -- and re-creating a foreign prefix on a fresh environment
  // hard-fails the build. PASS 1 declines both.
  const sdk = { queryRecords: async (_set, o) => {
    const name = (/name eq '([^']+)'/.exec(o.filter) || [])[1];
    if (name === 'isv_page.html') return [{ name, webresourcetype: 1, content: 'PGh0bWw+', ismanaged: false }];
    return [];
  } };
  const { webResources } = await iconWebResources(sdk, [], [], 'crba3', true, ['isv_page.html']);
  assert.strictEqual(webResources.length, 0, 'a foreign-prefix nav resource must not be re-declared');
});

// #456: download does NOT read languageCode from Dataverse, and that is deliberate — an LCID copied
// out of the source org would be re-applied verbatim when the spec is rebuilt elsewhere, which is how
// a spec starts failing in an org that lacks that language (#447). But dropping a value the AUTHOR
// wrote is its own bug, and a silent one: the next build resolves the org default, so new columns get
// one language while the pinned ones keep another. Mixed-language app, no error.
test('a hand-pinned languageCode survives a download (#456)', () => {
  const spec = { app: { name: 'A' }, entities: [] };
  const prior = JSON.stringify({ app: { name: 'A' }, languageCode: 1031 });
  const deps = { existsSync: () => true, readFileSync: () => prior };
  preserveAuthoredLanguageCode(spec, 'app-spec.json', deps);
  assert.strictEqual(spec.languageCode, 1031, 'the author-pinned LCID is restored');
});

test('the preserved value is CANONICAL, not the author\'s raw formatting', () => {
  // A downloaded spec is a generated artifact. `"1031"` and `" 1031 "` both validate, but writing
  // the string form back out makes the file's diff noisy and its type inconsistent with every other
  // numeric field the download emits.
  for (const raw of ['1031', ' 1031 ', '01031']) {
    const spec = { app: { name: 'A' } };
    preserveAuthoredLanguageCode(spec, 'app-spec.json', {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ languageCode: raw }),
    });
    assert.strictEqual(spec.languageCode, 1031, `${JSON.stringify(raw)} must normalize to the number 1031`);
    assert.strictEqual(typeof spec.languageCode, 'number');
  }
});

test('preserving never invents a languageCode where the author had none', () => {
  const spec = { app: { name: 'A' }, entities: [] };
  const deps = { existsSync: () => true, readFileSync: () => JSON.stringify({ app: { name: 'A' } }) };
  preserveAuthoredLanguageCode(spec, 'app-spec.json', deps);
  assert.strictEqual(spec.languageCode, undefined, 'no previous value means the field stays absent');

  // A first-ever download has no previous spec at all.
  const fresh = { app: { name: 'A' }, entities: [] };
  preserveAuthoredLanguageCode(fresh, 'app-spec.json', { existsSync: () => false, readFileSync: () => { throw new Error('nope'); } });
  assert.strictEqual(fresh.languageCode, undefined);
});

test('a downloaded languageCode is never overwritten by the previous file', () => {
  // Defensive: if a future download ever DOES emit one, the live value wins over the stale file.
  const spec = { app: { name: 'A' }, languageCode: 1036 };
  const deps = { existsSync: () => true, readFileSync: () => JSON.stringify({ languageCode: 1031 }) };
  preserveAuthoredLanguageCode(spec, 'app-spec.json', deps);
  assert.strictEqual(spec.languageCode, 1036);
});

test('a corrupt or invalid previous spec is ignored rather than failing the download', () => {
  for (const prior of ['{ not json', JSON.stringify({ languageCode: 'de-DE' }), JSON.stringify({ languageCode: true }), JSON.stringify({ languageCode: 0 }), JSON.stringify({ languageCode: 99999 })]) {
    const spec = { app: { name: 'A' } };
    preserveAuthoredLanguageCode(spec, 'app-spec.json', { existsSync: () => true, readFileSync: () => prior });
    assert.strictEqual(spec.languageCode, undefined, 'must not carry forward ' + prior.slice(0, 30));
  }
  // A read that throws must not escape either.
  const spec = { app: { name: 'A' } };
  assert.doesNotThrow(() => preserveAuthoredLanguageCode(spec, 'x', { existsSync: () => true, readFileSync: () => { throw new Error('EACCES'); } }));
  assert.strictEqual(spec.languageCode, undefined);
});
