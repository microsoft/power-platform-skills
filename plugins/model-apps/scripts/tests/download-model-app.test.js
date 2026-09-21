'use strict';
// Also guards https://github.com/microsoft/power-platform-skills/issues/494 — download did not read
// artifact descriptions back, so a downloaded spec silently lost every description on rebuild.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { untypedColumnNames, collectGlobalChoices, finalizeGlobalChoices, resolveAppId, collectSitemap, parseDownloadedPages, entityFromMetadata, readEntityWithDescriptions, readDescriptionInventory, iconWebResources, readDashboards, droppedSubareaCount, preserveAuthoredLanguageCode } = require('../download-model-app.js');

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

  // The $select also carries the DISPLAY labels now, so a table/column labelled in more than one
  // language round-trips (AB#6686428). The SDK's flattened `displayName` keeps only one.
  assert.ok(gets.some((u) => /^\/EntityDefinitions\(LogicalName='new_order'\)\?\$select=LogicalName,Description,DisplayName,DisplayCollectionName$/.test(u)), `table read URL wrong: ${gets.join(' | ')}`);
  assert.ok(gets.some((u) => /^\/EntityDefinitions\(LogicalName='new_order'\)\/Attributes\?\$select=LogicalName,Description,DisplayName,IsLogical,AttributeOf,AttributeTypeName$/.test(u)), `attribute read URL wrong: ${gets.join(' | ')}`);
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
  // "column contoso_status: Choice needs options[] or a globalChoice reference".
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
  // The opt-in must remain reachable: judging "this reused table really is mine" is exactly the call
  // an author can make and this code cannot, and the gate ran BEFORE the flag check at first.
  const optedIn = { ...spec.entities[0], enrichDefaultViews: true };
  assert.strictEqual(enrichesDefaultViews({ ...spec, entities: [optedIn] }, optedIn), true,
    'an explicit enrichDefaultViews:true must override the existing:true skip');
  const optedOut = { ...spec.entities[0], existing: false, enrichDefaultViews: false };
  assert.strictEqual(enrichesDefaultViews({ ...spec, entities: [optedOut] }, optedOut), false, 'the opt-out still works');
});

test('untypedColumnNames names every column whose type could not be substantiated', () => {
  // These are the columns a rebuild into a FRESH org would create as Text, because the data-model
  // phase falls back to `SDK_COLUMN_TYPE[c.type || 'Text']`. Rebuilding into an org that already has
  // the table reuses them and this is inert — which is why the loss has to be announced by name
  // rather than left for someone to discover after a cross-environment rebuild.
  assert.deepStrictEqual(untypedColumnNames([
    { schemaName: 'new_ticket', columns: [
      { schemaName: 'new_status' },                 // Choice — options not read, so no type
      { schemaName: 'new_notes', type: 'Memo' },
      { schemaName: 'new_choices' },                // MultiChoice
    ] },
    { schemaName: 'new_order', columns: [{ schemaName: 'new_total', type: 'Money' }] },
  ]), ['new_ticket.new_status', 'new_ticket.new_choices']);
  assert.deepStrictEqual(untypedColumnNames([]), []);
  assert.deepStrictEqual(untypedColumnNames(undefined), []);
});

test('a downloaded Choice column is reported as untyped, so the Text downgrade is never silent', () => {
  const meta = {
    logicalName: 'new_ticket', schemaName: 'new_ticket', displayName: 'Ticket', primaryNameAttribute: 'new_name',
    attributes: [
      { logicalName: 'new_status', displayName: 'Status', attributeType: 'Picklist', isCustomAttribute: true },
      { logicalName: 'new_notes', displayName: 'Notes', attributeType: 'Memo', isCustomAttribute: true },
    ],
  };
  assert.deepStrictEqual(untypedColumnNames([entityFromMetadata(meta, 'new_ticket')]), ['new_ticket.new_status']);
});

// ---------------------------------------------------------------------------
// #564 — Choice / MultiChoice column TYPES survive a download.
// ---------------------------------------------------------------------------

// A picklist attribute row exactly as Dataverse returns it through the cast + $expand. LIVE-MEASURED
// against a stock org on `account.accountcategorycode`:
//   { "LogicalName": "accountcategorycode",
//     "OptionSet": { "Name": "account_accountcategorycode", "IsGlobal": false,
//                    "Options": [ { "Value": 1, "Label": { "LocalizedLabels": [ { Label, LanguageCode } ],
//                                                          "UserLocalizedLabel": { "Label": "Preferred Customer" } } } ] },
//     "GlobalOptionSet": { "Name": "account_accountcategorycode", "MetadataId": "..." } }
// Note GlobalOptionSet is populated even though IsGlobal is FALSE — the trap pinned below.
function picklistRow(logicalName, { name, isGlobal, options, globalEcho = true }) {
  const label = (l) => (typeof l === 'string'
    ? { LocalizedLabels: [{ Label: l, LanguageCode: 1033 }], UserLocalizedLabel: { Label: l, LanguageCode: 1033 } }
    : { LocalizedLabels: Object.entries(l).map(([lcid, text]) => ({ Label: text, LanguageCode: Number(lcid) })), UserLocalizedLabel: { Label: l['1033'], LanguageCode: 1033 } });
  return {
    LogicalName: logicalName,
    OptionSet: { Name: name, IsGlobal: isGlobal, Options: options.map(([value, l]) => ({ Value: value, Label: label(l) })) },
    ...(globalEcho ? { GlobalOptionSet: { Name: name, MetadataId: 'aaaaaaaa-0000-0000-0000-000000000001' } } : {}),
  };
}

// An sdk whose RAW client answers the description reads AND the two picklist cast reads.
function sdkWithOptionSets({ attributes, picklist = [], multiSelect = [], optionSetStatus = 200, urls = [], throwOnOptionSets = false }) {
  return {
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, schemaName: 'new_ticket', displayName: 'Ticket', primaryNameAttribute: 'new_name', attributes }),
    queryRecords: async (set) => { throw new Error("queryRecords must not be used for metadata paths (got '" + set + "')"); },
    dataverse: {
      get: async (url) => {
        urls.push(url);
        if (/AttributeMetadata/.test(url)) {
          if (throwOnOptionSets) throw new Error('metadata read blew up');
          const rows = /MultiSelectPicklistAttributeMetadata/.test(url) ? multiSelect : picklist;
          return { status: optionSetStatus, headers: {}, body: { value: rows } };
        }
        if (/\/Attributes\?/.test(url)) return { status: 200, headers: {}, body: { value: [] } };
        return { status: 200, headers: {}, body: {} };
      },
    },
  };
}

const CHOICE_ATTRS = [
  { logicalName: 'new_status', displayName: 'Status', attributeType: 'Picklist', isCustomAttribute: true },
  { logicalName: 'new_notes', displayName: 'Notes', attributeType: 'Memo', isCustomAttribute: true },
];

test('#564 a LOCAL option set downloads as a real Choice with inline options[], not an untyped column', async () => {
  const urls = [];
  const sdk = sdkWithOptionSets({
    attributes: CHOICE_ATTRS,
    picklist: [picklistRow('new_status', { name: 'new_ticket_new_status', isGlobal: false, options: [[100000000, 'Open'], [100000001, 'Closed']] })],
    urls,
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'new_ticket'), 'new_ticket');
  const status = e.columns.find((c) => c.schemaName === 'new_status');
  assert.strictEqual(status.type, 'Choice');
  // Plain label strings, in the order Dataverse returned them — the App Spec assigns
  // value = 100000000 + index, so the ARRAY ORDER is semantics, not presentation.
  assert.deepStrictEqual(status.options, ['Open', 'Closed']);
  assert.strictEqual(status.globalChoice, undefined, 'a local set must not emit a globalChoice reference');
  // The column is no longer reported as untyped — that warning exists for columns we cannot type.
  assert.deepStrictEqual(untypedColumnNames([e]), []);
  // The cast segment is required: Attributes is a heterogeneous collection, so OptionSet can only be
  // expanded through it. Pin the exact URL so a silent shape change is caught here, not live.
  assert.ok(
    urls.some((u) => u === "/EntityDefinitions(LogicalName='new_ticket')/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Name,IsGlobal,Options)"),
    'picklist read URL wrong: ' + urls.join(' | ')
  );
});

test('#564 GlobalOptionSet being present does NOT make a local set global (live-measured trap)', async () => {
  // Measured on a live org: a LOCAL set (IsGlobal:false) still returns a populated GlobalOptionSet
  // echoing its own name. Keying off GlobalOptionSet would emit a globalChoice reference to a shared
  // set that does not exist, and the rebuild would bind the column to nothing.
  const sdk = sdkWithOptionSets({
    attributes: CHOICE_ATTRS,
    picklist: [picklistRow('new_status', { name: 'new_ticket_new_status', isGlobal: false, options: [[1, 'Open']], globalEcho: true })],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'new_ticket'), 'new_ticket');
  const status = e.columns.find((c) => c.schemaName === 'new_status');
  assert.strictEqual(status.globalChoice, undefined);
  assert.deepStrictEqual(status.options, ['Open']);
});

test('#564 a GLOBAL-bound picklist emits a globalChoice reference instead of inline options', async () => {
  const sdk = sdkWithOptionSets({
    attributes: CHOICE_ATTRS,
    picklist: [picklistRow('new_status', { name: 'shared_stage', isGlobal: true, options: [[1, 'Draft'], [2, 'Final']] })],
  });
  const meta = await readEntityWithDescriptions(sdk, 'new_ticket');
  const e = entityFromMetadata(meta, 'new_ticket');
  const status = e.columns.find((c) => c.schemaName === 'new_status');
  assert.strictEqual(status.type, 'Choice');
  assert.strictEqual(status.globalChoice, 'shared_stage');
  assert.strictEqual(status.options, undefined, 'a global-bound column must not ALSO carry inline options');
  // The shared set itself has to be declared, or a fresh-environment rebuild has nothing to bind to.
  const decls = new Map();
  collectGlobalChoices(meta, decls);
  assert.deepStrictEqual([...decls.values()], [{ name: 'shared_stage', options: ['Draft', 'Final'] }]);
});

test('#564 a MultiSelect picklist downloads as MultiChoice', async () => {
  const sdk = sdkWithOptionSets({
    attributes: [{ logicalName: 'new_tags', displayName: 'Tags', attributeType: 'MultiSelectPicklist', isCustomAttribute: true }],
    multiSelect: [picklistRow('new_tags', { name: 'new_ticket_new_tags', isGlobal: false, options: [[1, 'Urgent'], [2, 'Billable']] })],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'new_ticket'), 'new_ticket');
  const tags = e.columns.find((c) => c.schemaName === 'new_tags');
  assert.strictEqual(tags.type, 'MultiChoice');
  assert.deepStrictEqual(tags.options, ['Urgent', 'Billable']);
});

test('#564 inline options keep their localizations, but a global declaration is flattened', async () => {
  // Inline columns[].options[] localizes correctly; globalChoices[] options are REJECTED by
  // validateAppSpec when localized, because Dataverse stores only the base language for a shared set.
  // So the same Label object must be emitted two different ways depending on where it lands.
  const localized = { 1033: 'Open', 3082: 'Abierto' };
  const sdk = sdkWithOptionSets({
    attributes: [
      { logicalName: 'new_status', displayName: 'Status', attributeType: 'Picklist', isCustomAttribute: true },
      { logicalName: 'new_stage', displayName: 'Stage', attributeType: 'Picklist', isCustomAttribute: true },
    ],
    picklist: [
      picklistRow('new_status', { name: 'new_ticket_new_status', isGlobal: false, options: [[1, localized]] }),
      picklistRow('new_stage', { name: 'shared_stage', isGlobal: true, options: [[1, localized]] }),
    ],
  });
  const meta = await readEntityWithDescriptions(sdk, 'new_ticket');
  const e = entityFromMetadata(meta, 'new_ticket');
  assert.deepStrictEqual(e.columns.find((c) => c.schemaName === 'new_status').options, [{ 1033: 'Open', 3082: 'Abierto' }]);
  const decls = new Map();
  collectGlobalChoices(meta, decls);
  assert.deepStrictEqual([...decls.values()], [{ name: 'shared_stage', options: ['Open'] }]);
});

test('#564 one global set bound by two columns is declared exactly once', async () => {
  const sdk = sdkWithOptionSets({
    attributes: [
      { logicalName: 'new_a', displayName: 'A', attributeType: 'Picklist', isCustomAttribute: true },
      { logicalName: 'new_b', displayName: 'B', attributeType: 'Picklist', isCustomAttribute: true },
    ],
    picklist: [
      picklistRow('new_a', { name: 'shared_stage', isGlobal: true, options: [[1, 'Draft']] }),
      picklistRow('new_b', { name: 'shared_stage', isGlobal: true, options: [[1, 'Draft']] }),
    ],
  });
  const decls = new Map();
  collectGlobalChoices(await readEntityWithDescriptions(sdk, 'new_ticket'), decls);
  assert.strictEqual(decls.size, 1);
});

test('#564 a FAILED option-set read leaves the column untyped rather than guessing a type', async () => {
  // Fail-safe, and the reason the untyped warning survives this change: emitting type "Choice" with
  // no options[] produces a spec that fails its OWN validation, and guessing options invents data.
  // A non-2xx and a throw must land on the same untyped outcome.
  for (const variant of [{ optionSetStatus: 403 }, { throwOnOptionSets: true }]) {
    const sdk = sdkWithOptionSets({ attributes: CHOICE_ATTRS, ...variant });
    const meta = await readEntityWithDescriptions(sdk, 'new_ticket');
    const e = entityFromMetadata(meta, 'new_ticket');
    assert.strictEqual(e.columns.find((c) => c.schemaName === 'new_status').type, undefined, JSON.stringify(variant));
    assert.deepStrictEqual(untypedColumnNames([e]), ['new_ticket.new_status'], JSON.stringify(variant));
    // The failure is RECORDED, not swallowed — a silent degrade here is the bug being fixed.
    assert.ok(meta.optionSetReadFailed, 'the read failure was not recorded for ' + JSON.stringify(variant));
  }
});

test('#564 a picklist the option-set read did not cover stays untyped', async () => {
  // A 200 that simply omits the attribute is NOT evidence of "no options" — it is evidence we did
  // not see them. Typing it anyway would emit an invalid spec.
  const sdk = sdkWithOptionSets({ attributes: CHOICE_ATTRS, picklist: [] });
  const meta = await readEntityWithDescriptions(sdk, 'new_ticket');
  const e = entityFromMetadata(meta, 'new_ticket');
  assert.strictEqual(e.columns.find((c) => c.schemaName === 'new_status').type, undefined);
  assert.deepStrictEqual(untypedColumnNames([e]), ['new_ticket.new_status']);
});

test('#564 an option set with no usable labels is not emitted as an empty Choice', async () => {
  // An option whose Label carries no usable text would emit options: [undefined], which fails
  // validateAppSpec ("options[0] must be a non-empty string"). Refuse to type it instead.
  const sdk = sdkWithOptionSets({
    attributes: CHOICE_ATTRS,
    picklist: [{ LogicalName: 'new_status', OptionSet: { Name: 'new_ticket_new_status', IsGlobal: false, Options: [{ Value: 1, Label: { LocalizedLabels: [], UserLocalizedLabel: null } }] } }],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'new_ticket'), 'new_ticket');
  assert.strictEqual(e.columns.find((c) => c.schemaName === 'new_status').type, undefined);
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

// A chart tile renders a visualization OVER a view. A deployed component that carries a ViewId but no
// VisualizationId therefore has nothing to plot, and emitting it anyway hands back a spec that fails
// its own lint ("id-based chart tile with viewId also needs visualizationId") — the exact #572 defect
// class this download path exists to prevent.
test('readDashboards omits a chart tile with no VisualizationId (and says so) rather than emitting a half-tile', async () => {
  const warnings = [];
  const sdk = {
    fetchArtifact: async () => ({ components: [
      { type: 'chart', name: 'Plotless', parameters: { TargetEntityType: 'account', ViewId: '{11111111-0000-4000-8000-000000000001}' } },
      { type: 'list', name: 'Open', parameters: { TargetEntityType: 'account', ViewId: '{33333333-0000-4000-8000-000000000003}' } },
    ] }),
    queryRecords: async () => [{ name: 'Operations', description: null }],
  };
  const dashboards = await readDashboards(sdk, {
    siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'DashBoard', dashboardId: 'dash-1', title: 'Operations' }] }] }] },
  }, (m) => warnings.push(m));

  assert.deepStrictEqual(dashboards[0].tiles, [
    { type: 'list', name: 'Open', entity: 'account', viewId: '33333333-0000-4000-8000-000000000003' },
  ], 'the plotless chart tile must not be emitted');
  assert.ok(warnings.some((w) => /VisualizationId/.test(w)), `the omission must be reported; got ${JSON.stringify(warnings)}`);
});

// `entity` is required by BOTH spec gates for any id-passthrough tile, so a component with no
// TargetEntityType produces `entity: undefined` — which JSON drops — and the downloaded spec then
// fails its own lint. Same class as the missing-VisualizationId case above.
test('readDashboards omits an id-passthrough tile with no TargetEntityType (and says so)', async () => {
  const warnings = [];
  const sdk = {
    fetchArtifact: async () => ({ components: [
      { type: 'chart', name: 'NoEntity', parameters: { ViewId: '{11111111-0000-4000-8000-000000000001}', VisualizationId: '{22222222-0000-4000-8000-000000000002}' } },
      { type: 'list', name: 'AlsoNoEntity', parameters: { ViewId: '{33333333-0000-4000-8000-000000000003}' } },
      { type: 'list', name: 'Good', parameters: { TargetEntityType: 'account', ViewId: '{44444444-0000-4000-8000-000000000004}' } },
    ] }),
    queryRecords: async () => [{ name: 'Operations', description: null }],
  };
  const dashboards = await readDashboards(sdk, {
    siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'DashBoard', dashboardId: 'dash-1', title: 'Operations' }] }] }] },
  }, (m) => warnings.push(m));

  assert.deepStrictEqual(dashboards[0].tiles, [
    { type: 'list', name: 'Good', entity: 'account', viewId: '44444444-0000-4000-8000-000000000004' },
  ], 'only the tile carrying an entity may be emitted');
  assert.strictEqual(warnings.filter((w) => /TargetEntityType/.test(w)).length, 2, `both omissions must be reported; got ${JSON.stringify(warnings)}`);
});

// The silent-drop hole the two tests above did NOT cover. `chart`/`list` used to be matched with an
// `&& viewId` guard, so a component of a supported type carrying no ViewId matched no branch at all
// and vanished with nothing said — and the dashboard-level "no recognizable tiles" warning cannot
// catch it, because that only fires when EVERY tile fails. Same untraceability as #572, reached from
// the one direction the omission warnings missed.
test('readDashboards reports a supported tile dropped for a missing ViewId instead of dropping it silently', async () => {
  const warnings = [];
  const sdk = {
    fetchArtifact: async () => ({ components: [
      { type: 'chart', name: 'NoView', parameters: { TargetEntityType: 'account', VisualizationId: '{22222222-0000-4000-8000-000000000002}' } },
      { type: 'list', name: 'AlsoNoView', parameters: { TargetEntityType: 'account' } },
      { type: 'list', name: 'Good', parameters: { TargetEntityType: 'account', ViewId: '{44444444-0000-4000-8000-000000000004}' } },
    ] }),
    queryRecords: async () => [{ name: 'Operations', description: null }],
  };
  const dashboards = await readDashboards(sdk, {
    siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'DashBoard', dashboardId: 'dash-1', title: 'Operations' }] }] }] },
  }, (m) => warnings.push(m));

  assert.deepStrictEqual(dashboards[0].tiles, [
    { type: 'list', name: 'Good', entity: 'account', viewId: '44444444-0000-4000-8000-000000000004' },
  ], 'only the tile carrying a ViewId may be emitted');
  assert.ok(/NoView/.test(warnings.join('\n')) && /AlsoNoView/.test(warnings.join('\n')),
    `both ViewId-less tiles must be named; got ${JSON.stringify(warnings)}`);
  assert.strictEqual(warnings.filter((w) => /ViewId/.test(w)).length, 2, `both omissions must cite ViewId; got ${JSON.stringify(warnings)}`);
});

// A component missing SEVERAL required parameters must say so once, naming each — reporting only the
// first would send a maker back for a second round trip to discover the rest.
test('readDashboards names every missing parameter on one tile in a single warning', async () => {
  const warnings = [];
  const sdk = {
    fetchArtifact: async () => ({ components: [{ type: 'chart', name: 'Empty', parameters: {} }] }),
    queryRecords: async () => [{ name: 'Operations', description: null }],
  };
  await readDashboards(sdk, {
    siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'DashBoard', dashboardId: 'dash-1', title: 'Operations' }] }] }] },
  }, (m) => warnings.push(m));

  const tileWarning = warnings.find((w) => /Empty/.test(w));
  assert.ok(tileWarning, `the tile omission must be reported; got ${JSON.stringify(warnings)}`);
  for (const param of ['TargetEntityType', 'ViewId', 'VisualizationId']) {
    assert.ok(tileWarning.includes(param), `'${param}' must be named in "${tileWarning}"`);
  }
});

// An unsupported component type is a silent drop too, for the same reason: a dashboard with one good
// tile never reaches the dashboard-level catch-all.
test('readDashboards reports a tile type the App Spec cannot express', async () => {
  const warnings = [];
  const sdk = {
    fetchArtifact: async () => ({ components: [
      { type: 'organizationinsights', name: 'Insights', parameters: {} },
      { type: 'iframe', name: 'NoUrl', parameters: {} },
      { type: 'list', name: 'Good', parameters: { TargetEntityType: 'account', ViewId: '{44444444-0000-4000-8000-000000000004}' } },
    ] }),
    queryRecords: async () => [{ name: 'Operations', description: null }],
  };
  const dashboards = await readDashboards(sdk, {
    siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'DashBoard', dashboardId: 'dash-1', title: 'Operations' }] }] }] },
  }, (m) => warnings.push(m));

  assert.strictEqual(dashboards[0].tiles.length, 1, 'only the rebuildable tile may be emitted');
  assert.ok(warnings.some((w) => /Insights/.test(w) && /organizationinsights/.test(w)),
    `the unsupported type must be named; got ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((w) => /NoUrl/.test(w) && /Url/.test(w)),
    `the iframe missing its Url must be reported; got ${JSON.stringify(warnings)}`);
});

test('readDashboards omits a null dashboard description instead of emitting a blank string', async () => {  const sdk = {
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
  const FORM_ID_RESTRICTED = '5111e0f2-0000-4000-8000-000000000007';
  const RULE_COPY_ID = '5111e0f2-0000-4000-8000-000000000008';
  const CLASSIC_ID = '5111e0f2-0000-4000-8000-000000000009';
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
      if (set === 'appmodulecomponent' && /componenttype eq 60/.test(filter)) return [{ objectid: FORM_ID }, { objectid: FORM_ID_RESTRICTED }];
      if (set === 'savedquery') return [{ savedqueryid: VIEW_ID, name: 'Active Orders', returnedtypecode: 'new_order', description: 'Work queue.' }];
      if (set === 'savedqueryvisualization') return [{ savedqueryvisualizationid: CHART_ID, name: 'Orders by Status', primaryentitytypecode: 'new_order', description: null }];
      if (set === 'systemform') {
        return [
          { formid: FORM_ID, name: 'Main', objecttypecode: 'new_order', description: 'Primary form.' },
          // A form RESTRICTED to a security role. `formxml` is pulled purely to detect this, and the
          // detection is what feeds the download's access-widening warning.
          { formid: FORM_ID_RESTRICTED, name: 'Dispatcher', objecttypecode: 'new_order', description: 'Restricted.',
            formxml: '<form><tabs /><DisplayConditions Order="2" FallbackForm="false"><Role Id="{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}" /></DisplayConditions></form>' },
        ];
      }
      if (set === 'solution') return [{ solutionid: SOL_ID }];
      if (set === 'solutioncomponent') return [{ objectid: RULE_ID, componenttype: 29 }];
      if (set === 'workflow') {
        return [
          // A real business rule: category 2 (Business Rule), type 1 (the definition).
          { workflowid: RULE_ID, name: 'Lock Closed', primaryentity: 'new_order', description: 'Closed rows are read-only.', category: 2, type: 1 },
          // The platform's activated COPY of that same rule. Counting it would list every active
          // rule twice.
          { workflowid: RULE_COPY_ID, name: 'Lock Closed', primaryentity: 'new_order', description: 'Closed rows are read-only.', category: 2, type: 2 },
          // A CLASSIC WORKFLOW. Solution component type 29 is every process kind, so without the
          // category filter this would be mislabelled as a business rule in the inventory.
          { workflowid: CLASSIC_ID, name: 'Nightly Recalc', primaryentity: 'new_order', description: 'A classic workflow.', category: 0, type: 1 },
        ];
      }
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
  // The role-restriction flag must NOT ride on the form entries: sanitizeDescriptionInventory spreads
  // those into `app-spec.json`, and a diagnostic has no business in the user-facing spec.
  assert.strictEqual('roleRestricted' in inv.forms[1], false,
    'the flag belongs on the sibling key, not on each form entry');
  // BEHAVIOURAL: only the restricted form is recorded, and it is recorded by (entity, name) so the
  // warning can name it. A source regex could not catch dropping `formxml` from the $select —
  // isRoleRestrictedFormXml(undefined) is false, so the list would be silently empty forever.
  assert.deepStrictEqual(inv.roleRestrictedForms, [{ name: 'Dispatcher', entity: 'new_order' }],
    'exactly the role-restricted form, and not the unrestricted one');
  assert.ok(calls.some((c) => c.set === 'systemform' && c.opts.select.includes('formxml')),
    'the form read must select formxml — without it the restriction can never be detected');
  assert.deepStrictEqual(inv.businessRules[0], { id: RULE_ID, name: 'Lock Closed', entity: 'new_order', description: 'Closed rows are read-only.' });
  // Solution component type 29 is EVERY process kind, so the rows must be narrowed after the fetch.
  // A classic workflow listed as a business rule is misleading to any tool that reads the inventory,
  // and the activated type-2 copy would list every active rule twice.
  assert.strictEqual(inv.businessRules.length, 1,
    `only the type-1 category-2 definition may be listed; got ${JSON.stringify(inv.businessRules.map((r) => r.name))}`);
  assert.ok(calls.some((c) => c.set === 'workflow' && c.opts.select.includes('category') && c.opts.select.includes('type')),
    'category and type must be REQUESTED, or the filter decides on undefined');
  assert.deepStrictEqual(inv.globalChoices[0], { name: 'new_priority', description: 'Shared priority choices.' });
  assert.ok(calls.some((c) => c.set === 'savedquery' && c.opts.select.includes('description')), 'view read selects description');
  assert.ok(calls.some((c) => c.set === 'savedqueryvisualization' && c.opts.select.includes('description')), 'chart read selects description');
  assert.ok(calls.some((c) => c.set === 'systemform' && c.opts.select.includes('description')), 'form read selects description');
  assert.ok(calls.some((c) => c.set === 'workflow' && c.opts.select.includes('description')), 'business-rule read selects description');
  assert.ok(calls.some((c) => c.get === '/GlobalOptionSetDefinitions?$select=Name,Description,IsManaged'),
    `global choices must be read through the RAW client (queryRecords cannot take a metadata path), selecting IsManaged so managed sets can be excluded; calls: ${JSON.stringify(calls.map((c) => c.get || c.set))}`);
});

test('the global-choice inventory excludes MANAGED option sets but keeps an unknown flag', async () => {
  // A managed global choice ships with its solution and exists in any environment that has that
  // solution, so naming it as "not round-tripped" is false — there is nothing for a rebuild to
  // recreate. Measured live on a stock environment: 149 option sets, exactly 1 unmanaged, so
  // reporting all of them buried the real findings under 148 unactionable lines.
  //
  // `$filter` cannot do this server-side: GlobalOptionSetDefinitions answers HTTP 405
  // (0x80060888) for `?$filter=IsManaged eq false`, which is why the filter is client-side.
  const sdk = {
    queryRecords: async () => [],
    dataverse: {
      get: async (url) => {
        if (/^\/GlobalOptionSetDefinitions\?/.test(url)) {
          return {
            status: 200,
            headers: {},
            body: {
              value: [
                { Name: 'new_priority', IsManaged: false },
                { Name: 'msdyn_solutionhealthruleseverity', IsManaged: true },
                { Name: 'legacy_noflag' }, // IsManaged absent — must be KEPT, not silently dropped
              ],
            },
          };
        }
        return { status: 404, headers: {}, body: {} };
      },
    },
  };

  const inv = await readDescriptionInventory(sdk, 'app-1', 'ContosoSolution');
  const names = (inv.globalChoices || []).map((c) => c.name);
  assert.ok(names.includes('new_priority'), 'an unmanaged choice is genuinely not round-tripped');
  assert.ok(!names.includes('msdyn_solutionhealthruleseverity'), 'a managed choice must not be reported');
  assert.ok(
    names.includes('legacy_noflag'),
    'an ABSENT IsManaged must keep the row — this inventory must not assert an absence it cannot substantiate'
  );
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
  assert.strictEqual(publisherQueried, false, 'no publisher lookup — the prefix is NOT sourced from an arbitrary solution membership');
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

// --- a form restricted to security roles must not be lost SILENTLY ------------------------------
//
// Every other download gap loses a customization. This one WIDENS ACCESS: form security roles live
// inside formxml as `<DisplayConditions>`, `forms[]` is not reconstructed by this download, and a
// form with no DisplayConditions is offered to EVERY role. So a restricted form, downloaded and
// rebuilt into a fresh environment, comes back visible to everyone.
//
// The fixtures below are the exact SHAPES measured on a live environment after a build — attribute
// order, casing and the platform's own default block. The role GUID is synthetic: this repo is
// public, and the test asserts nothing about the id's value.
const { isRoleRestrictedFormXml } = require('../download-model-app.js');

const XML_RESTRICTED = '<form><tabs /><DisplayConditions Order="2" FallbackForm="false"><Role Id="{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}" /></DisplayConditions></form>';
const XML_EVERYONE = '<form><tabs /><DisplayConditions Order="0" FallbackForm="true"><Everyone /></DisplayConditions></form>';
const XML_NONE = '<form><tabs /></form>';

test('a role-restricted form is detected', () => {
  assert.strictEqual(isRoleRestrictedFormXml(XML_RESTRICTED), true);
});

test('the DEFAULT shapes are NOT reported as restricted', () => {
  // Both of these mean "every role can see it". Warning on them would make the warning noise, and a
  // warning that fires on every form is a warning nobody reads.
  assert.strictEqual(isRoleRestrictedFormXml(XML_EVERYONE), false,
    '<Everyone /> is the unrestricted default, not a restriction');
  assert.strictEqual(isRoleRestrictedFormXml(XML_NONE), false,
    'a form with no DisplayConditions at all is visible to every role');
});

test('detection does not depend on attribute order or element casing', () => {
  // Platform-authored and SDK-authored formxml differ in both, so matching either exactly would make
  // this fire on one source and not the other.
  assert.strictEqual(isRoleRestrictedFormXml('<form><displayconditions fallbackform="false" order="2"><role id="{A}" /></displayconditions></form>'), true);
  assert.strictEqual(isRoleRestrictedFormXml('<form><DisplayConditions><Role  Id = "{A}" /></DisplayConditions></form>'), true);
});

test('a <Role> OUTSIDE DisplayConditions does not count', () => {
  // Scoped to the block deliberately: the word Role appears elsewhere in formxml (control names,
  // labels), and matching it loosely would report every such form as restricted.
  assert.strictEqual(isRoleRestrictedFormXml('<form><tabs><cell><control id="Role" /></cell></tabs></form>'), false);
  assert.strictEqual(isRoleRestrictedFormXml('<form><labels><label description="Role" /></labels></form>'), false);
});

test('missing or malformed formxml is not a restriction', () => {
  // Fail OPEN here, not closed: an unreadable form must not produce a spurious security warning that
  // sends someone hunting for a restriction that does not exist.
  for (const bad of [undefined, null, '', '<form', 123, {}]) {
    assert.strictEqual(isRoleRestrictedFormXml(bad), false, `${JSON.stringify(bad)} must not read as restricted`);
  }
});

test('runDownload WARNS on stderr about a role-restricted form, naming it', async () => {
  // BEHAVIOURAL. The two source-regex guards this replaces both stayed green under two realistic
  // edits — dropping `formxml` from the systemform $select, and collapsing the capturing
  // descriptionInventory accessor — either of which silences the warning completely.
  //
  // This is the single guard against a silent access WIDENING: `forms[]` is not reconstructed by the
  // download, so a restricted form rebuilt into another environment comes back visible to every role.
  const APP_ID = '6222e0f2-0000-4000-8000-000000000001';
  const APP_UNIQUE = 'new_rolewarn';
  const FORM_OPEN = '6222e0f2-0000-4000-8000-000000000002';
  const FORM_LOCKED = '6222e0f2-0000-4000-8000-000000000003';
  const SM_ID = '6222e0f2-0000-4000-8000-000000000004';
  const SM_XML = '<SiteMap><Area Id="A"><Group Id="G"><SubArea Id="S" Entity="new_order" /></Group></Area></SiteMap>';
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-rolewarn-'));

  const sdk = {
    fetchArtifact: async () => ({
      id: APP_ID, name: 'Role Warn', uniquename: APP_UNIQUE, description: '',
      siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'Entity', entity: 'new_order' }] }] }] },
    }),
    queryRecords: async (logical, opts) => {
      const filter = (opts && opts.filter) || '';
      if (logical === 'appmodule') return [{ appmoduleid: APP_ID, appmoduleidunique: APP_ID, uniquename: APP_UNIQUE }];
      if (logical === 'appmodulecomponent') {
        if (/componenttype eq 60/.test(filter)) return [{ objectid: FORM_OPEN, componenttype: 60 }, { objectid: FORM_LOCKED, componenttype: 60 }];
        if (/componenttype eq 62/.test(filter)) return [{ objectid: SM_ID, componenttype: 62 }];
        return [];
      }
      if (logical === 'sitemap') return [{ sitemapxml: SM_XML }];
      if (logical === 'systemform') {
        return [
          { formid: FORM_OPEN, name: 'Everyone Form', objecttypecode: 'new_order', description: '',
            formxml: '<form><tabs /><DisplayConditions Order="0" FallbackForm="true"><Everyone /></DisplayConditions></form>' },
          { formid: FORM_LOCKED, name: 'Dispatcher Form', objecttypecode: 'new_order', description: '',
            formxml: '<form><tabs /><DisplayConditions Order="2" FallbackForm="false"><Role Id="{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}" /></DisplayConditions></form>' },
        ];
      }
      return [];
    },
    fetchEntityMetadata: async (logical) => ({
      logicalName: logical, schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_name',
      attributes: [{ logicalName: 'new_name', displayName: 'Name', attributeType: 'String', isCustomAttribute: true }],
      relationships: [],
    }),
    dataverse: { get: async () => ({ status: 404, headers: {}, body: {} }) },
  };
  const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), download: async () => true };

  // The warning goes to stderr (non-fatal), the pattern used elsewhere in this suite.
  const origWrite = process.stderr.write.bind(process.stderr);
  const written = [];
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return origWrite(chunk, ...rest); };
  let res;
  try {
    res = await runDownload({ sdk, genpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE });
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(out, { recursive: true, force: true });
  }

  assert.strictEqual(res.ok, true, `the download itself must succeed; got ${res.error || ''}`);
  const text = written.join('');
  // Scoped to the RESTRICTION warning's own line. The download also emits a separate
  // not-round-tripped note (AB#6686423) that lists every deployed form by name — including the
  // unrestricted one — so scanning all of stderr would now assert the wrong thing. The intent of
  // this check has always been "the restriction warning must not name an unrestricted form".
  const restrictionLine = text.split('\n').find((l) => /are restricted to specific security roles/.test(l)) || '';
  assert.ok(restrictionLine, 'the warning must fire');
  assert.match(restrictionLine, /new_order\.Dispatcher Form/, 'and must NAME the restricted form');
  assert.doesNotMatch(restrictionLine, /Everyone Form/,
    'the <Everyone /> form is the unrestricted DEFAULT — warning on it would make the warning noise');
  assert.match(restrictionLine, /forms\[\]\.securityRoles/, 'and must say how to carry the restriction forward');

  // AB#6686423 — BEHAVIOURAL: the same run must also report the artifact classes it did not
  // reconstruct, and carry that report in the RESULT so `--json` consumers see it too. The unit
  // tests in download-not-round-tripped.test.js pin the wording; this pins that it is actually
  // reached from a real download, which a source-shape assertion could not.
  //
  // This app has only forms, and the sentence now names only the classes actually reported — it used
  // to read "forms[], views[] or charts[]" regardless, telling the operator two things were missing
  // that were never there.
  assert.match(text, /NOTE: this download does not reconstruct forms\[\] —/);
  assert.doesNotMatch(text, /does not reconstruct[^\n]*views\[\]/, 'no views were found, so none may be claimed');
  assert.ok(res.notRoundTripped, 'the summary must ride on the runDownload result, not only on stderr');
  assert.strictEqual(res.notRoundTripped.total, 2, JSON.stringify(res.notRoundTripped));
  // SORTED, not in the order the mock returned them. `notRoundTripped` is compared between runs, so
  // it sorts at every level; `descriptionInventory` below is the raw read and keeps Dataverse's
  // order, which is why the two lists differ here.
  assert.deepStrictEqual(res.notRoundTripped.entities, [{ entity: 'new_order', forms: ['Dispatcher Form', 'Everyone Form'], views: [], charts: [], businessRules: [] }]);
  // The spec on disk still carries them under descriptionInventory — the note's claim must be true.
  assert.deepStrictEqual((res.spec.descriptionInventory.forms || []).map((f) => f.name), ['Everyone Form', 'Dispatcher Form']);
});

test('runDownload stays SILENT when no form is role-restricted', async () => {
  // A warning that fires on every download is a warning nobody reads.
  const APP_ID = '6333e0f2-0000-4000-8000-000000000001';
  const SM_ID = '6333e0f2-0000-4000-8000-000000000002';
  const FORM_ID = '6333e0f2-0000-4000-8000-000000000003';
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-nowarn-'));
  const sdk = {
    fetchArtifact: async () => ({
      id: APP_ID, name: 'No Warn', uniquename: 'new_nowarn', description: '',
      siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'Entity', entity: 'new_order' }] }] }] },
    }),
    queryRecords: async (logical, opts) => {
      const filter = (opts && opts.filter) || '';
      if (logical === 'appmodule') return [{ appmoduleid: APP_ID, appmoduleidunique: APP_ID, uniquename: 'new_nowarn' }];
      if (logical === 'appmodulecomponent') {
        if (/componenttype eq 60/.test(filter)) return [{ objectid: FORM_ID, componenttype: 60 }];
        if (/componenttype eq 62/.test(filter)) return [{ objectid: SM_ID, componenttype: 62 }];
        return [];
      }
      if (logical === 'sitemap') return [{ sitemapxml: '<SiteMap><Area Id="A"><Group Id="G"><SubArea Id="S" Entity="new_order" /></Group></Area></SiteMap>' }];
      if (logical === 'systemform') return [{ formid: FORM_ID, name: 'Main', objecttypecode: 'new_order', description: '', formxml: '<form><tabs /></form>' }];
      return [];
    },
    fetchEntityMetadata: async (logical) => ({
      logicalName: logical, schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_name',
      attributes: [{ logicalName: 'new_name', displayName: 'Name', attributeType: 'String', isCustomAttribute: true }],
      relationships: [],
    }),
    dataverse: { get: async () => ({ status: 404, headers: {}, body: {} }) },
  };
  const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), download: async () => true };
  const origWrite = process.stderr.write.bind(process.stderr);
  const written = [];
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return origWrite(chunk, ...rest); };
  try {
    await runDownload({ sdk, genpageCli, outDir: out, appId: APP_ID, appUnique: 'new_nowarn' });
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(out, { recursive: true, force: true });
  }
  assert.doesNotMatch(written.join(''), /restricted to specific security roles/);
});


// Minimal hydrateSpec input: only the app block varies across the #514 tests, so everything else is
// a fixed stub. Keeps each assertion about the one field it is testing.
const makeRead = (over = {}) => ({
  // hydrateSpec walks app.siteMap.areas, so the stub has to carry a (minimal) sitemap.
  app: async () => ({ siteMap: { areas: [] }, ...(over.app || { name: 'A', description: '', uniquename: 'p_a' }) }),
  pages: async () => [],
  entities: async () => [],
  webResources: async () => [],
  solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
});
// --- #514: the app-shell settings the build writes but the download used to drop ------------------
// A live app had NewLookAlwaysOn=true and HeaderAndNavigationRefresh=2 (the only app in its org with
// either) and the downloaded spec carried neither. Rebuilding it into a FRESH environment would have
// produced a classic-shell app with nothing reporting the loss.
//
// Plugin gap, not an SDK one: the SDK already exposes getAppSettings/retrieveSetting; the download
// called neither.
test('#514: hydrateSpec round-trips newLook and headerNavigationRefresh when the app overrides them', async () => {
  const { hydrateSpec } = require('../lib/hydrate-spec.js');
  const spec = await hydrateSpec(makeRead({
    app: { name: 'A', description: '', uniquename: 'p_a', newLook: true, headerNavigationRefresh: true },
  }));
  assert.strictEqual(spec.app.newLook, true);
  assert.strictEqual(spec.app.headerNavigationRefresh, true);
});

test('#514: an app with NO override omits them, so the rebuild keeps inheriting', async () => {
  // Omitting is the faithful representation: the build leaves an omitted field alone, so emitting a
  // value for an inherited setting would invent an override the app never had.
  const { hydrateSpec } = require('../lib/hydrate-spec.js');
  const spec = await hydrateSpec(makeRead({ app: { name: 'A', description: '', uniquename: 'p_a' } }));
  assert.ok(!('newLook' in spec.app), 'no newLook key when the app has no override');
  assert.ok(!('headerNavigationRefresh' in spec.app), 'no headerNavigationRefresh key either');
});

test('#514: an explicit OFF round-trips as false, not as absent', async () => {
  // false and absent mean different things: false is an explicit override, absent is inheritance.
  const { hydrateSpec } = require('../lib/hydrate-spec.js');
  const spec = await hydrateSpec(makeRead({
    app: { name: 'A', description: '', uniquename: 'p_a', newLook: false, headerNavigationRefresh: false },
  }));
  assert.strictEqual(spec.app.newLook, false);
  assert.strictEqual(spec.app.headerNavigationRefresh, false);
});

test('#514: readAppShellSettings decodes the header tri-state, where 1 means DISABLED', async () => {
  // THE trap. HeaderAndNavigationRefresh is a Number tri-state: 2 = on, 1 = OFF, 0 = platform
  // default. A truthy read reports 1 as enabled, which is the same class of mistake that made
  // `ai.appFeatures: false` silently disable a live app's features.
  const { readAppShellSettings } = require('../download-model-app.js');
  const sdk = (headerValue, newLookValue) => ({
    queryRecords: async (entity) => {
      if (entity === 'settingdefinition') {
        return [
          { settingdefinitionid: 'd1', uniquename: 'NewLookAlwaysOn' },
          { settingdefinitionid: 'd2', uniquename: 'HeaderAndNavigationRefresh' },
        ];
      }
      return [
        { _settingdefinitionid_value: 'd1', value: newLookValue },
        { _settingdefinitionid_value: 'd2', value: headerValue },
      ];
    },
  });

  assert.deepStrictEqual(await readAppShellSettings(sdk('2', 'true'), 'app-1'), { newLook: true, headerNavigationRefresh: true }, '2 = on');
  assert.deepStrictEqual(await readAppShellSettings(sdk('1', 'false'), 'app-1'), { newLook: false, headerNavigationRefresh: false }, '1 = DISABLED, not enabled');
  // 0 is "platform default", which is not an override at all — it must not be emitted either way.
  assert.deepStrictEqual(await readAppShellSettings(sdk('0', 'false'), 'app-1'), { newLook: false }, '0 = platform default, so no header key');
});

test('#514: the appsetting read is bound by setting DEFINITION, so $top cannot decide the answer', async () => {
  // `$top` is a hard cap in Dataverse and no `@odata.nextLink` is returned, so a row-limited read can
  // come back partial. Here a partial page is not a visible truncation but a WRONG ANSWER: an absent
  // row means "inherits the environment", so a shell override pushed off the page round-trips as
  // inheritance and the rebuilt app silently reverts to the classic shell — the exact loss #514 fixed.
  // Bounding the query by the two definitions makes the result at most one row each, whatever the cap.
  const { readAppShellSettings } = require('../download-model-app.js');
  let appsettingOpts = null;
  const sdk = {
    queryRecords: async (entity, opts) => {
      if (entity === 'settingdefinition') {
        return [
          { settingdefinitionid: 'D1', uniquename: 'NewLookAlwaysOn' },
          { settingdefinitionid: 'D2', uniquename: 'HeaderAndNavigationRefresh' },
        ];
      }
      appsettingOpts = opts;
      return [{ _settingdefinitionid_value: 'd1', value: 'true' }];
    },
  };
  assert.deepStrictEqual(await readAppShellSettings(sdk, 'app-1'), { newLook: true });
  assert.match(appsettingOpts.filter, /_parentappmoduleid_value eq app-1/);
  assert.match(appsettingOpts.filter, /_settingdefinitionid_value eq d1/, 'the read must name the NewLookAlwaysOn definition');
  assert.match(appsettingOpts.filter, /_settingdefinitionid_value eq d2/, 'and the HeaderAndNavigationRefresh one');
});

test('#514: a brace-wrapped id on either side of the join still resolves the setting', async () => {
  // The join is FAIL-QUIET — an unrecognized id just `continue`s and the setting disappears from the
  // spec with no error — so both sides are normalized. Measured live, Dataverse returns these ids
  // bare, so this guards the caller-supplied `appId` and any future formatting drift, not an observed
  // mismatch.
  const { readAppShellSettings } = require('../download-model-app.js');
  let appsettingOpts = null;
  const sdk = {
    queryRecords: async (entity, opts) => {
      if (entity === 'settingdefinition') return [{ settingdefinitionid: '{D1}', uniquename: 'NewLookAlwaysOn' }];
      appsettingOpts = opts;
      return [{ _settingdefinitionid_value: '{d1}', value: 'true' }];
    },
  };
  assert.deepStrictEqual(await readAppShellSettings(sdk, '{app-1}'), { newLook: true });
  assert.ok(!/[{}]/.test(appsettingOpts.filter), `no braces reach the OData filter: ${appsettingOpts.filter}`);
});

test('#514: a tenant without the setting definitions still downloads cleanly', async () => {
  // Best-effort: losing an optional shell setting must never fail a download.
  const { readAppShellSettings } = require('../download-model-app.js');
  const noDefs = { queryRecords: async () => [] };
  assert.deepStrictEqual(await readAppShellSettings(noDefs, 'app-1'), {});
  const throws = { queryRecords: async () => { throw new Error('no access to appsettings'); } };
  assert.deepStrictEqual(await readAppShellSettings(throws, 'app-1'), {});
});

// ---------------------------------------------------------------------------
// #564 — the emitted spec must be valid, and the reports must stay truthful.
// ---------------------------------------------------------------------------

test('#564 a downloaded spec carrying Choice/MultiChoice types still passes validateAppSpec', async () => {
  // The companion rule is the whole reason the type used to be dropped: declaring type "Choice"
  // obliges the column to carry options[] or a globalChoice, and a spec that fails its own gate is
  // useless. This is the positive counterpart to the long-standing "must not claim a type it cannot
  // substantiate" test — now that we CAN substantiate it, the result still has to validate.
  const { validateAppSpec: validate } = require('../lib/app-spec.js');
  const sdk = sdkWithOptionSets({
    attributes: [
      { logicalName: 'new_status', displayName: 'Status', attributeType: 'Picklist', isCustomAttribute: true },
      { logicalName: 'new_tags', displayName: 'Tags', attributeType: 'MultiSelectPicklist', isCustomAttribute: true },
      { logicalName: 'new_stage', displayName: 'Stage', attributeType: 'Picklist', isCustomAttribute: true },
    ],
    picklist: [
      picklistRow('new_status', { name: 'new_ticket_new_status', isGlobal: false, options: [[1, 'Open'], [2, 'Closed']] }),
      picklistRow('new_stage', { name: 'shared_stage', isGlobal: true, options: [[1, 'Draft'], [2, 'Final']] }),
    ],
    multiSelect: [picklistRow('new_tags', { name: 'new_ticket_new_tags', isGlobal: false, options: [[1, 'Urgent']] })],
  });
  const meta = await readEntityWithDescriptions(sdk, 'new_ticket');
  const decls = new Map();
  collectGlobalChoices(meta, decls);
  const res = validate({
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [entityFromMetadata(meta, 'new_ticket')],
    globalChoices: [...decls.values()],
    appShell: { areas: [] },
  }, { profile: 'deploy' });
  assert.deepStrictEqual(res.errors, [], res.errors.join(' | '));
});

test('#564 roundTrippedAware stops the report claiming a DECLARED global choice was left behind', () => {
  const { roundTrippedAware: aware } = require('../download-model-app.js');
  const inventory = { globalChoices: [{ name: 'shared_stage' }, { name: 'untouched_set' }], forms: [{ name: 'F', entity: 'new_ticket' }] };
  const decls = new Map([['shared_stage', { name: 'shared_stage', options: ['Draft'] }]]);
  // The set the spec now declares IS carried forward, so reporting it as lost would be false. Every
  // other set in the environment stays listed — the app does not bind it, so a rebuild will not
  // recreate it, and that claim is still true.
  assert.deepStrictEqual(aware(inventory, decls).globalChoices, [{ name: 'untouched_set' }]);
  assert.deepStrictEqual(aware(inventory, decls).forms, [{ name: 'F', entity: 'new_ticket' }], 'unrelated classes must be untouched');
  // Nothing left -> the KEY goes, not an empty array: notRoundTrippedSummary skips an empty class,
  // and `globalChoices: []` would be indistinguishable from "the read returned no rows".
  const allDeclared = aware({ globalChoices: [{ name: 'shared_stage' }] }, decls);
  assert.ok(!('globalChoices' in allDeclared), 'an emptied class must be dropped, not left as []');
  // Case-insensitive: Dataverse does not guarantee the casing of a returned option-set Name.
  assert.ok(!('globalChoices' in aware({ globalChoices: [{ name: 'SHARED_STAGE' }] }, decls)));
  // No declarations -> the inventory is returned untouched (identity, not a rebuilt copy).
  assert.strictEqual(aware(inventory, new Map()), inventory);
});

test('#564 hydrateSpec emits globalChoices ONLY when the app actually binds one', async () => {
  const { hydrateSpec: hydrate } = require('../lib/hydrate-spec.js');
  const base = {
    app: async () => ({ name: 'A', description: '', siteMap: { areas: [] } }),
    pages: async () => [],
    entities: async () => [],
    webResources: async () => [],
    solution: async () => ({ uniqueName: 'S', publisherPrefix: 'new' }),
  };
  const withNone = await hydrate(base);
  // An empty `globalChoices: []` on every download would read as a positive claim that the app binds
  // no shared choices — which a download whose option-set read failed cannot substantiate.
  assert.ok(!('globalChoices' in withNone), 'an app binding no shared choice must not emit the key');
  const withSome = await hydrate({ ...base, globalChoices: async () => [{ name: 'shared_stage', options: ['Draft'] }] });
  assert.deepStrictEqual(withSome.globalChoices, [{ name: 'shared_stage', options: ['Draft'] }]);
  // A legacy `read` with no globalChoices accessor must still hydrate (back-compat).
  assert.ok(!('globalChoices' in (await hydrate({ ...base, globalChoices: undefined }))));
});
test('#564 option ORDER is Dataverse display order, not Value order', async () => {
  // Dataverse returns options in their DISPLAY order, and the App Spec assigns
  // value = 100000000 + index — so the array order is what a rebuild reproduces in the picker.
  // Sorting by Value here would silently reorder any set whose author arranged it by hand. Values
  // are deliberately DESCENDING so a sort would be visible.
  //
  // Driven through readEntityWithDescriptions ON PURPOSE: the ordering decision lives in the READ
  // (optionSetFromRow), so a test that pre-attaches `optionSet` to the metadata proves nothing — an
  // earlier version of this test did exactly that and a value-sort mutation survived it.
  const sdk = sdkWithOptionSets({
    attributes: [{ logicalName: 'new_status', displayName: 'Status', attributeType: 'Picklist', isCustomAttribute: true }],
    picklist: [picklistRow('new_status', { name: 'new_ticket_new_status', isGlobal: false, options: [[9, 'Last'], [3, 'Middle'], [1, 'First']] })],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'new_ticket'), 'new_ticket');
  assert.deepStrictEqual(e.columns.find((c) => c.schemaName === 'new_status').options, ['Last', 'Middle', 'First']);
});
test('#564 a MultiChoice column is NOT dropped even though Dataverse types it as "Virtual"', async () => {
  // LIVE-MEASURED on a real table. A MultiSelectPicklist attribute reports:
  //   { "LogicalName": "pp_tags",     "AttributeType": "Virtual", "AttributeTypeName": "MultiSelectPicklistType" }
  // while its synthetic formatted-value shadow reports:
  //   { "LogicalName": "pp_tagsname", "AttributeType": "Virtual", "AttributeTypeName": "VirtualType" }
  // The SDK projection carries only `attributeType`, so BOTH looked like "Virtual" — a type the App
  // Spec cannot declare — and the real MultiChoice column was filtered out of columns[] ENTIRELY.
  // That is worse than the untyped degrade #564 describes: the column vanished from the spec, so a
  // rebuild did not create it at all. The MultiSelect CAST read is the discriminator: only a genuine
  // multi-select comes back from it, so an attribute it returned is a MultiChoice whatever
  // `attributeType` claims. The `*name` shadow is absent from every cast read and stays filtered.
  const sdk = sdkWithOptionSets({
    attributes: [
      { logicalName: 'pp_tags', displayName: 'Tags', attributeType: 'Virtual', isCustomAttribute: true },
      { logicalName: 'pp_tagsname', displayName: 'Tags Name', attributeType: 'Virtual', isCustomAttribute: true },
      { logicalName: 'pp_stagename', displayName: 'Stage Name', attributeType: 'Virtual', isCustomAttribute: true },
    ],
    multiSelect: [picklistRow('pp_tags', { name: 'pp_item_pp_tags', isGlobal: false, options: [[1, 'Urgent'], [2, 'Billable']] })],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_item'), 'pp_item');
  const tags = e.columns.find((c) => c.schemaName === 'pp_tags');
  assert.ok(tags, 'the MultiChoice column was dropped from columns[]');
  assert.strictEqual(tags.type, 'MultiChoice');
  assert.deepStrictEqual(tags.options, ['Urgent', 'Billable']);
  // The synthetic shadows must STILL be filtered out: emitting them would feed defaultViewColumns
  // and rewrite the table's default views with junk.
  assert.deepStrictEqual(e.columns.map((c) => c.schemaName), ['pp_tags']);
});

test('#564 a Virtual attribute with NO option set is still filtered out', async () => {
  // The relaxation above must be driven by the presence of companion data, not by the type name —
  // otherwise every platform Virtual attribute would start appearing in columns[].
  const sdk = sdkWithOptionSets({
    attributes: [{ logicalName: 'pp_shadow', displayName: 'Shadow', attributeType: 'Virtual', isCustomAttribute: true }],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_item'), 'pp_item');
  assert.deepStrictEqual(e.columns, []);
});
test('#564 the CAST type outranks the attributeType map (defensive precedence)', async () => {
  // Today this precedence is not observable: the only disagreement measured in the wild is a
  // MultiSelectPicklist reporting `Virtual`, which the map does not contain at all — so either order
  // produces MultiChoice, and a mutation that swaps them survives the other tests. It is pinned
  // anyway because the ordering is a deliberate contract, not an accident: the cast segment is
  // direct evidence of what the attribute IS, while `attributeType` has already been observed to
  // misreport it once. A future cleanup that "simplifies" the order should fail here.
  const sdk = sdkWithOptionSets({
    attributes: [{ logicalName: 'pp_odd', displayName: 'Odd', attributeType: 'Picklist', isCustomAttribute: true }],
    multiSelect: [picklistRow('pp_odd', { name: 'pp_item_pp_odd', isGlobal: false, options: [[1, 'A']] })],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_item'), 'pp_item');
  assert.strictEqual(e.columns.find((c) => c.schemaName === 'pp_odd').type, 'MultiChoice',
    'the map said Choice and the multi-select cast said MultiChoice — the cast must win');
});
test('#564 a lookup name SHADOW is filtered out, but a logical CHOICE column is kept', async () => {
  // LIVE-MEASURED. Creating a lookup `pp_parentorgid` also creates a synthetic formatted-name
  // attribute `pp_parentorgidname`:
  //   { AttributeType: "String", AttributeTypeName: "StringType", IsCustomAttribute: true, IsLogical: true }
  // It reports IsCustomAttribute TRUE, so the custom-only filter let it through, and its String type
  // maps cleanly to Text — so a downloaded spec declared a REAL Text column named after a lookup's
  // shadow. Measured consequence on a fresh-environment rebuild: the build happily created
  // `pp563_org2.pp563_parentorgidname (Text)`, an invented column that also collides with the name
  // the real lookup's shadow needs. It is IsLogical (not stored on this table), which is what makes
  // it distinguishable.
  //
  // The rule is deliberately "logical AND no option set", NOT plain "logical": on `account`, 6 REAL
  // choice columns (address1_addresstypecode, address1_freighttermscode, address1_shippingmethodcode
  // and their address2_ twins) are themselves IsLogical, because they live on the address entity and
  // surface logically here. Dropping every logical attribute would delete real Choice columns from
  // the spec — reintroducing exactly the silent column-loss this change exists to end.
  const sdk = {
    fetchEntityMetadata: async () => ({
      logicalName: 'pp_org', schemaName: 'pp_org', displayName: 'Org', primaryNameAttribute: 'pp_name',
      attributes: [
        { logicalName: 'pp_parentorgidname', displayName: 'Parent Org Name', attributeType: 'String', isCustomAttribute: true },
        { logicalName: 'pp_real', displayName: 'Real', attributeType: 'String', isCustomAttribute: true },
        { logicalName: 'pp_addrtype', displayName: 'Address Type', attributeType: 'Picklist', isCustomAttribute: true },
      ],
    }),
    dataverse: {
      get: async (url) => {
        if (/MultiSelectPicklistAttributeMetadata/.test(url)) return { status: 200, headers: {}, body: { value: [] } };
        if (/PicklistAttributeMetadata/.test(url)) {
          return { status: 200, headers: {}, body: { value: [picklistRow('pp_addrtype', { name: 'pp_addrtype_set', isGlobal: false, options: [[1, 'Bill To'], [2, 'Ship To']] })] } };
        }
        if (/\/Attributes\?/.test(url)) {
          return { status: 200, headers: {}, body: { value: [
            { LogicalName: 'pp_parentorgidname', IsLogical: true },
            { LogicalName: 'pp_real', IsLogical: false },
            // A REAL choice column that is nonetheless logical — must survive.
            { LogicalName: 'pp_addrtype', IsLogical: true },
          ] } };
        }
        return { status: 200, headers: {}, body: {} };
      },
    },
  };
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_org'), 'pp_org');
  const names = e.columns.map((c) => c.schemaName);
  assert.ok(!names.includes('pp_parentorgidname'), 'the lookup name shadow must not be emitted as a real Text column');
  assert.ok(names.includes('pp_real'), 'a normal custom column must survive');
  assert.ok(names.includes('pp_addrtype'), 'a LOGICAL column that carries an option set is a real Choice and must survive');
  assert.strictEqual(e.columns.find((c) => c.schemaName === 'pp_addrtype').type, 'Choice');
});

test('#564 an attribute whose IsLogical could not be read is KEPT, not dropped', async () => {
  // Fail-safe: an absent flag means "we could not look", and dropping a real column on that basis is
  // the more destructive error. Same reasoning as the existing isCustomAttribute handling, which
  // drops only on an explicit `false`.
  const sdk = sdkWithOptionSets({
    attributes: [{ logicalName: 'pp_real', displayName: 'Real', attributeType: 'String', isCustomAttribute: true }],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_org'), 'pp_org');
  assert.deepStrictEqual(e.columns.map((c) => c.schemaName), ['pp_real']);
});
// ---------------------------------------------------------------------------
// Review round: findings from the adversarial review of the #564 work.
// ---------------------------------------------------------------------------

// Builds the `/Attributes?$select=...` row the label/shape read returns.
const attrRow = (logicalName, { isLogical = false, typeName = undefined } = {}) => ({
  LogicalName: logicalName,
  ...(isLogical !== undefined ? { IsLogical: isLogical } : {}),
  ...(typeName ? { AttributeTypeName: { Value: typeName } } : {}),
});

// An sdk with FULL control of both reads: the attribute shape read and the two casts.
function sdkFull({ attributes, attrRows = [], picklist = [], multiSelect = [], picklistStatus = 200, multiSelectStatus = 200, attrStatus = 200 }) {
  return {
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, schemaName: logical, displayName: 'T', primaryNameAttribute: 'pp_name', attributes }),
    dataverse: {
      get: async (url) => {
        if (/MultiSelectPicklistAttributeMetadata/.test(url)) return { status: multiSelectStatus, headers: {}, body: { value: multiSelect } };
        if (/PicklistAttributeMetadata/.test(url)) return { status: picklistStatus, headers: {}, body: { value: picklist } };
        if (/\/Attributes\?/.test(url)) return { status: attrStatus, headers: {}, body: { value: attrRows } };
        return { status: 200, headers: {}, body: {} };
      },
    },
  };
}

test('REVIEW-A a cross-language AMBIGUOUS option set leaves the column untyped instead of aborting the whole download', async () => {
  // Reported by adversarial review, proven reachable. Option labels need not be unique across
  // options OR languages in Dataverse, so this set is legal:
  //   options[0] = "Open"                       (English only)
  //   options[1] = { 1033: "Closed", 3082: "Open" }
  // "Open" then names BOTH options. `ambiguousChoiceAliases` treats that as an ERROR (not a warning)
  // when either side is localized, because the collision is invisible on the page. Emitting it made
  // `validateAppSpec` fail, and runDownload returns BEFORE writing the spec — so ONE colliding pair
  // anywhere aborted the download of the ENTIRE app, and --allow-lossy-download does not bypass that
  // gate. Pre-#564 these columns carried no options[], so the rule returned early and the download
  // succeeded. Refusing to type just this column restores that, and is the same fail-safe already
  // used for an unreadable label.
  const localized = { 1033: 'Closed', 3082: 'Open' };
  const sdk = sdkFull({
    attributes: [{ logicalName: 'pp_status', displayName: 'Status', attributeType: 'Picklist', isCustomAttribute: true }],
    attrRows: [attrRow('pp_status', { typeName: 'PicklistType' })],
    picklist: [picklistRow('pp_status', { name: 'pp_t_pp_status', isGlobal: false, options: [[1, 'Open'], [2, localized]] })],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_t'), 'pp_t');
  const col = e.columns.find((c) => c.schemaName === 'pp_status');
  assert.ok(col, 'the column must still be emitted');
  assert.strictEqual(col.type, undefined, 'an ambiguous option set must not be typed');
  assert.strictEqual(col.options, undefined, 'and must not carry the invalid options[]');
  assert.deepStrictEqual(untypedColumnNames([e]), ['pp_t.pp_status'], 'it is named in the untyped warning instead');
  // The whole point: the emitted spec must still validate.
  const { validateAppSpec: validate } = require('../lib/app-spec.js');
  const res = validate({ solution: { uniqueName: 'S', publisherPrefix: 'pp' }, app: { name: 'A' }, entities: [e], appShell: { areas: [] } }, { profile: 'plan', reconstructed: true });
  assert.deepStrictEqual(res.errors, [], res.errors.join(' | '));
});

test('REVIEW-A duplicate PLAIN labels are still typed (they are a warning, not an error)', async () => {
  // Only the localized/hidden collision is an error. Two identical plain strings provisioned fine
  // before this rule existed, so refusing to type them would reject specs that still work.
  const sdk = sdkFull({
    attributes: [{ logicalName: 'pp_status', displayName: 'Status', attributeType: 'Picklist', isCustomAttribute: true }],
    attrRows: [attrRow('pp_status', { typeName: 'PicklistType' })],
    picklist: [picklistRow('pp_status', { name: 'pp_t_pp_status', isGlobal: false, options: [[1, 'Open'], [2, 'Open']] })],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_t'), 'pp_t');
  assert.strictEqual(e.columns.find((c) => c.schemaName === 'pp_status').type, 'Choice');
});

test('REVIEW-B a MultiChoice survives an unusable option label - untyped and NAMED, never dropped', async () => {
  // Reported by adversarial review. A MultiSelectPicklist is `Virtual`, so before this the ONLY
  // thing keeping it in columns[] was a successfully PARSED option set. An unusable label made
  // optionSetFromRow return null, the cast membership was discarded, and the column vanished from
  // the spec entirely while the warning claimed it was "captured WITHOUT a type".
  const sdk = sdkFull({
    attributes: [{ logicalName: 'pp_tags', displayName: 'Tags', attributeType: 'Virtual', isCustomAttribute: true }],
    attrRows: [attrRow('pp_tags', { typeName: 'MultiSelectPicklistType' })],
    multiSelect: [{ LogicalName: 'pp_tags', OptionSet: { Name: 'pp_t_pp_tags', IsGlobal: false, Options: [{ Value: 1, Label: { LocalizedLabels: [], UserLocalizedLabel: null } }] } }],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_t'), 'pp_t');
  assert.ok(e.columns.find((c) => c.schemaName === 'pp_tags'), 'the MultiChoice column must not vanish');
  assert.strictEqual(e.columns.find((c) => c.schemaName === 'pp_tags').type, undefined);
  assert.deepStrictEqual(untypedColumnNames([e]), ['pp_t.pp_tags'], 'and it must be NAMED, so the loss is never silent');
});

test('REVIEW-B/D a MultiChoice survives a FAILED or EMPTY option-set read, identified by AttributeTypeName', async () => {
  // Two shapes, same requirement. The cast can fail (503) or answer 200 with an empty value[] — the
  // second does not even throw, so nothing was recorded and the column disappeared with ZERO
  // operator signal. `AttributeTypeName` identifies a multi-select INDEPENDENTLY of the cast, so
  // membership is no longer the only thing standing between a real column and silent deletion.
  for (const variant of [{ multiSelectStatus: 503 }, { multiSelect: [] }]) {
    const sdk = sdkFull({
      attributes: [{ logicalName: 'pp_tags', displayName: 'Tags', attributeType: 'Virtual', isCustomAttribute: true }],
      attrRows: [attrRow('pp_tags', { typeName: 'MultiSelectPicklistType' })],
      ...variant,
    });
    const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_t'), 'pp_t');
    const label = JSON.stringify(variant);
    assert.ok(e.columns.find((c) => c.schemaName === 'pp_tags'), 'MultiChoice vanished for ' + label);
    assert.deepStrictEqual(untypedColumnNames([e]), ['pp_t.pp_tags'], 'not named for ' + label);
  }
});

test('REVIEW-C a LOGICAL choice column is not dropped when the option-set read fails', async () => {
  // The isLogical shadow filter keyed off `optionSet === undefined`, so a genuine logical Choice
  // whose option read failed was DROPPED rather than left untyped — and the warning then promised a
  // Text column that a rebuild would never create. Positive type evidence (AttributeTypeName) now
  // protects it; the shadow, which has none, is still dropped.
  const sdk = sdkFull({
    attributes: [
      { logicalName: 'pp_logchoice', displayName: 'Logical Choice', attributeType: 'Picklist', isCustomAttribute: true },
      { logicalName: 'pp_parentidname', displayName: 'Parent Name', attributeType: 'String', isCustomAttribute: true },
    ],
    attrRows: [
      attrRow('pp_logchoice', { isLogical: true, typeName: 'PicklistType' }),
      attrRow('pp_parentidname', { isLogical: true, typeName: 'StringType' }),
    ],
    picklistStatus: 503,
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_t'), 'pp_t');
  const names = e.columns.map((c) => c.schemaName);
  assert.ok(names.includes('pp_logchoice'), 'a real logical Choice must survive a failed option read');
  assert.ok(!names.includes('pp_parentidname'), 'the lookup shadow must still be dropped');
  assert.deepStrictEqual(untypedColumnNames([e]), ['pp_t.pp_logchoice']);
});

test('REVIEW-B a failing SECOND cast does not discard the successful first one', async () => {
  // readOptionSets threw on the first non-2xx, so a 503 on the multi-select cast threw away an
  // already-valid Picklist map and every Choice on the table lost its type.
  const sdk = sdkFull({
    attributes: [{ logicalName: 'pp_status', displayName: 'Status', attributeType: 'Picklist', isCustomAttribute: true }],
    attrRows: [attrRow('pp_status', { typeName: 'PicklistType' })],
    picklist: [picklistRow('pp_status', { name: 'pp_t_pp_status', isGlobal: false, options: [[1, 'Open']] })],
    multiSelectStatus: 503,
  });
  const meta = await readEntityWithDescriptions(sdk, 'pp_t');
  const e = entityFromMetadata(meta, 'pp_t');
  assert.strictEqual(e.columns.find((c) => c.schemaName === 'pp_status').type, 'Choice', 'the successful cast must survive the other one failing');
  assert.ok(meta.optionSetReadFailed, 'the partial failure is still recorded');
});

test('REVIEW-C globalChoices declares only sets an EMITTED column actually references', async () => {
  // collectGlobalChoices scanned raw metadata, so a set bound only by a SYSTEM attribute (filtered
  // out of columns[]) or by a table later dropped for having no primary name still produced a
  // declaration — and the build then creates or reuses every declaration in the target environment.
  const sdk = sdkFull({
    attributes: [
      { logicalName: 'pp_mine', displayName: 'Mine', attributeType: 'Picklist', isCustomAttribute: true },
      { logicalName: 'sys_theirs', displayName: 'Theirs', attributeType: 'Picklist', isCustomAttribute: false },
    ],
    attrRows: [attrRow('pp_mine', { typeName: 'PicklistType' }), attrRow('sys_theirs', { typeName: 'PicklistType' })],
    picklist: [
      picklistRow('pp_mine', { name: 'bound_set', isGlobal: true, options: [[1, 'A']] }),
      picklistRow('sys_theirs', { name: 'orphan_set', isGlobal: true, options: [[1, 'B']] }),
    ],
  });
  const meta = await readEntityWithDescriptions(sdk, 'pp_t');
  const e = entityFromMetadata(meta, 'pp_t');
  const candidates = collectGlobalChoices(meta, new Map());
  const decls = finalizeGlobalChoices([e], candidates);
  assert.deepStrictEqual(decls.map((g) => g.name), ['bound_set'], 'the orphan set must not be declared');
});

test('REVIEW-D a global-choice reference is canonicalized to the declaration casing', async () => {
  // Declarations dedupe case-insensitively but each column kept its own raw casing, and
  // entity-provision looks up `globalChoiceIds[c.globalChoice]` CASE-SENSITIVELY — so a second
  // casing left that column unbound and it fell back to an empty inline option list.
  const e = {
    schemaName: 'pp_t',
    columns: [
      { schemaName: 'a', type: 'Choice', globalChoice: 'Shared_Set' },
      { schemaName: 'b', type: 'Choice', globalChoice: 'shared_set' },
    ],
  };
  const candidates = new Map([['shared_set', { name: 'Shared_Set', options: ['A'] }]]);
  const decls = finalizeGlobalChoices([e], candidates);
  assert.deepStrictEqual(decls.map((g) => g.name), ['Shared_Set']);
  assert.deepStrictEqual(e.columns.map((c) => c.globalChoice), ['Shared_Set', 'Shared_Set'], 'every reference must match the declaration exactly');
});
test('REVIEW-C runDownload emits ONLY referenced globalChoices (drives the real wiring, not the helper)', async () => {
  // Deliberately driven through runDownload. An earlier version of this test called
  // finalizeGlobalChoices directly, and a mutation that reverted the ACCESSOR to
  // `[...globalChoiceDecls.values()]` survived it — the helper was right while the wiring was not.
  const APP_ID = 'a1b2c3d4-0000-4000-8000-0000000000c1';
  const APP_UNIQUE = 'test_gcwiring';
  const SM_ID = '5111e0f2-0000-4000-8000-0000000000c2';
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-gc-'));
  try {
    const sdk = {
      fetchArtifact: async () => ({ name: 'GC App', description: '', siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [{ type: 'Entity', entity: 'contoso_item' }] }] }] } }),
      queryRecords: async (logical, opts) => {
        const filter = (opts && opts.filter) || '';
        if (logical === 'appmodule') {
          const m = filter.match(/uniquename eq '([^']+)'/);
          if (m) return m[1] === APP_UNIQUE ? [{ appmoduleid: APP_ID, appmoduleidunique: 'c0ffee00-0000-4000-8000-0000000000c3' }] : [];
          return [{ appmoduleid: APP_ID, appmoduleidunique: 'c0ffee00-0000-4000-8000-0000000000c3', uniquename: APP_UNIQUE }];
        }
        if (logical === 'appmodulecomponent') return [{ objectid: SM_ID, componenttype: 62 }];
        if (logical === 'sitemap') return [{ sitemapxml: '<SiteMap><Area><Group><SubArea Entity="contoso_item"/></Group></Area></SiteMap>' }];
        return [];
      },
      fetchEntityMetadata: async (logical) => ({
        schemaName: logical, displayName: 'Item', primaryNameAttribute: 'contoso_name',
        attributes: [
          { logicalName: 'contoso_mine', displayName: 'Mine', attributeType: 'Picklist', isCustomAttribute: true },
          // SYSTEM attribute: filtered out of columns[], so the set it binds must NOT be declared.
          { logicalName: 'sys_theirs', displayName: 'Theirs', attributeType: 'Picklist', isCustomAttribute: false },
        ],
      }),
      dataverse: {
        get: async (url) => {
          if (/MultiSelectPicklistAttributeMetadata/.test(url)) return { status: 200, headers: {}, body: { value: [] } };
          if (/PicklistAttributeMetadata/.test(url)) {
            return { status: 200, headers: {}, body: { value: [
              picklistRow('contoso_mine', { name: 'bound_set', isGlobal: true, options: [[1, 'A']] }),
              picklistRow('sys_theirs', { name: 'orphan_set', isGlobal: true, options: [[1, 'B']] }),
            ] } };
          }
          if (/\/Attributes\?/.test(url)) {
            return { status: 200, headers: {}, body: { value: [
              { LogicalName: 'contoso_mine', AttributeTypeName: { Value: 'PicklistType' } },
              { LogicalName: 'sys_theirs', AttributeTypeName: { Value: 'PicklistType' } },
            ] } };
          }
          if (/GlobalOptionSetDefinitions/.test(url)) return { status: 200, headers: {}, body: { value: [] } };
          return { status: 200, headers: {}, body: {} };
        },
      },
    };
    const genpageCli = { enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }), download: async () => true };
    const res = await runDownload({ sdk, genpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepStrictEqual((res.spec.globalChoices || []).map((g) => g.name), ['bound_set'],
      'a set bound only by a filtered SYSTEM attribute must not be declared — the build writes every declaration into the target org');
    const col = res.spec.entities[0].columns.find((c) => c.schemaName === 'contoso_mine');
    assert.strictEqual(col.globalChoice, 'bound_set');
    // And the emitted spec must still validate.
    assert.deepStrictEqual(validateAppSpec(res.spec, { profile: 'plan' }).errors, []);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('REVIEW-B cast membership still keeps a column when the ATTRIBUTE read also failed', async () => {
  // The combination neither guard covers alone: no AttributeTypeName (attribute read 403) AND an
  // unparseable option label. Cast MEMBERSHIP is then the only evidence the column exists, so the
  // entry must be recorded even when its options cannot be parsed.
  const sdk = sdkFull({
    attributes: [{ logicalName: 'pp_tags', displayName: 'Tags', attributeType: 'Virtual', isCustomAttribute: true }],
    attrStatus: 403,
    multiSelect: [{ LogicalName: 'pp_tags', OptionSet: { Name: 'pp_t_pp_tags', IsGlobal: false, Options: [{ Value: 1, Label: { LocalizedLabels: [], UserLocalizedLabel: null } }] } }],
  });
  const e = entityFromMetadata(await readEntityWithDescriptions(sdk, 'pp_t'), 'pp_t');
  assert.ok(e.columns.find((c) => c.schemaName === 'pp_tags'), 'cast membership must keep the column when nothing else can');
  assert.deepStrictEqual(untypedColumnNames([e]), ['pp_t.pp_tags']);
});

test('#574 a POLYMORPHIC lookup shadow is filtered out via AttributeOf, even though IsLogical is false', async () => {
  // LIVE-MEASURED on a Customer-type lookup `cfo_billto` targeting account + contact. Dataverse
  // creates THREE shadows for it, and unlike a single-target lookup they are physically stored:
  //   cfo_billtoname      AttributeOf=cfo_billto  IsLogical=FALSE  AttributeType=String
  //   cfo_billtoyominame  AttributeOf=cfo_billto  IsLogical=FALSE  AttributeType=String
  //   cfo_billtoidtype    AttributeOf=cfo_billto  IsLogical=FALSE  AttributeType=EntityName
  // vs a single-target lookup, whose shadow IS logical:
  //   cfo_customeridname  AttributeOf=cfo_customerid  IsLogical=TRUE
  // So the IsLogical rule cannot see the polymorphic ones: they were emitted as real Text columns
  // and a fresh-environment rebuild invented two text fields where a lookup used to be.
  const e = entityFromMetadata({
    schemaName: 'cfo_workorder', displayName: 'Work Order', primaryNameAttribute: 'cfo_name',
    attributes: [
      { logicalName: 'cfo_name', attributeType: 'String', IsCustomAttribute: true },
      { logicalName: 'cfo_intakeref', attributeType: 'String', IsCustomAttribute: true },
      { logicalName: 'cfo_billtoname', attributeType: 'String', IsCustomAttribute: true, IsLogical: false, AttributeOf: 'cfo_billto' },
      { logicalName: 'cfo_billtoyominame', attributeType: 'String', IsCustomAttribute: true, IsLogical: false, AttributeOf: 'cfo_billto' },
      { logicalName: 'cfo_customeridname', attributeType: 'String', IsCustomAttribute: true, IsLogical: true, AttributeOf: 'cfo_customerid' },
    ],
  }, 'cfo_workorder');
  assert.deepStrictEqual(e.columns.map((c) => c.schemaName), ['cfo_intakeref'],
    `only the authored column survives; got ${JSON.stringify(e.columns.map((c) => c.schemaName))}`);
});

test('#574 a REAL column is never dropped by the AttributeOf rule (AttributeOf is null on authored columns)', async () => {
  // The lookup itself, and every ordinary column, report AttributeOf: null -- so nothing authored
  // is at risk. Guards the rule against becoming a silent column deletion.
  const e = entityFromMetadata({
    schemaName: 'cfo_workorder', displayName: 'Work Order', primaryNameAttribute: 'cfo_name',
    attributes: [
      { logicalName: 'cfo_intakeref', attributeType: 'String', IsCustomAttribute: true, AttributeOf: null },
      { logicalName: 'cfo_resolution', attributeType: 'Memo', IsCustomAttribute: true, AttributeOf: null },
      { logicalName: 'cfo_onsiteduration', attributeType: 'Integer', IsCustomAttribute: true },
    ],
  }, 'cfo_workorder');
  assert.deepStrictEqual(e.columns.map((c) => c.schemaName), ['cfo_intakeref', 'cfo_resolution', 'cfo_onsiteduration']);
});

test('#574 an attribute whose AttributeOf could not be read is KEPT, not dropped', async () => {
  // When the label read fails NO attribute carries AttributeOf. Dropping on absent would empty the
  // table\u0027s columns[] entirely -- the same direction every other rule here takes: "we could not
  // look" must never become a deletion.
  const e = entityFromMetadata({
    schemaName: 'cfo_workorder', displayName: 'Work Order', primaryNameAttribute: 'cfo_name',
    attributes: [{ logicalName: 'cfo_intakeref', attributeType: 'String', IsCustomAttribute: true }],
  }, 'cfo_workorder');
  assert.deepStrictEqual(e.columns.map((c) => c.schemaName), ['cfo_intakeref']);
});

test('#574 AttributeOf survives the description merge, so the shadow is dropped through the REAL read path', async () => {
  // The unit tests above hand AttributeOf straight to entityFromMetadata. This one drives the
  // integration seam: the SDK metadata has NO AttributeOf (it is not in its projection), so the
  // value only reaches the filter if readEntityWithDescriptions merges it off the label read.
  // Dropping that one field from the merge silently re-enables the leak.
  const sdk = {
    fetchEntityMetadata: async (logical) => ({
      logicalName: logical, schemaName: 'cfo_workorder', displayName: 'Work Order', primaryNameAttribute: 'cfo_name',
      attributes: [
        { logicalName: 'cfo_intakeref', attributeType: 'String', IsCustomAttribute: true },
        { logicalName: 'cfo_billtoname', attributeType: 'String', IsCustomAttribute: true },
        { logicalName: 'cfo_billtoyominame', attributeType: 'String', IsCustomAttribute: true },
      ],
    }),
    queryRecords: async (set) => { throw new Error(`queryRecords must not be used for metadata paths (got \u0027${set}\u0027)`); },
    dataverse: {
      get: async (url) => {
        if (/\/Attributes\?/.test(url)) {
          // Exactly the live shape: polymorphic shadows are NOT logical, so only AttributeOf marks them.
          return { status: 200, headers: {}, body: { value: [
            { LogicalName: 'cfo_intakeref', IsLogical: false, AttributeOf: null },
            { LogicalName: 'cfo_billtoname', IsLogical: false, AttributeOf: 'cfo_billto' },
            { LogicalName: 'cfo_billtoyominame', IsLogical: false, AttributeOf: 'cfo_billto' },
          ] } };
        }
        return { status: 200, headers: {}, body: {} };
      },
    },
  };
  const meta574 = await readEntityWithDescriptions(sdk, 'cfo_workorder');
  const e574 = entityFromMetadata(meta574, 'cfo_workorder');
  assert.deepStrictEqual(e574.columns.map((c) => c.schemaName), ['cfo_intakeref'],
    `the polymorphic shadows must not survive the real read path; got ${JSON.stringify(e574.columns.map((c) => c.schemaName))}`);
});

// A platform-generated companion that carries NO AttributeOf, is not logical, and reports
// IsCustomAttribute true slips past every rule above. `<money>_base` is the canonical case.
test('#574 follow-up: the base-currency twin is dropped via IsBaseCurrency, and the real Money column is kept', async () => {
  // LIVE-MEASURED on stock `opportunity`:
  //   estimatedvalue       IsBaseCurrency=false IsValidForCreate=true
  //   estimatedvalue_base  IsBaseCurrency=TRUE  IsValidForCreate=false
  const e = entityFromMetadata({
    primaryNameAttribute: 'cfo_name',
    attributes: [
      { SchemaName: 'cfo_name', LogicalName: 'cfo_name', AttributeType: 'String', IsCustomAttribute: true, IsLogical: false, AttributeOf: null },
      { SchemaName: 'cfo_budget', LogicalName: 'cfo_budget', AttributeType: 'Money', IsCustomAttribute: true, IsLogical: false, AttributeOf: null },
      { SchemaName: 'cfo_budget_base', LogicalName: 'cfo_budget_base', AttributeType: 'Money', IsCustomAttribute: true, IsLogical: false, AttributeOf: null, IsBaseCurrency: true },
    ],
  }, 'cfo_rtproject');
  assert.deepStrictEqual(e.columns.map((c) => c.schemaName), ['cfo_budget'],
    `the base-currency twin must not be emitted as an authored column; got ${JSON.stringify(e.columns.map((c) => c.schemaName))}`);
});

// The capability flag is NOT a substitute for IsBaseCurrency. This spec deliberately supports
// authored columns with `isValidForCreate: false` (app-spec-schema.md), so filtering on it turns a
// round-trip into a DELETION of a legitimately read-only column. Live-measured counter-example:
// stock `opportunity.totalamount` has IsValidForCreate=false and IsBaseCurrency=false.
test('#574 follow-up: a real column that is merely NOT CREATABLE is kept, not mistaken for a generated twin', async () => {
  const e = entityFromMetadata({
    primaryNameAttribute: 'cfo_name',
    attributes: [
      { SchemaName: 'cfo_name', LogicalName: 'cfo_name', AttributeType: 'String', IsCustomAttribute: true },
      { SchemaName: 'cfo_rollup', LogicalName: 'cfo_rollup', AttributeType: 'Money', IsCustomAttribute: true, IsValidForCreate: false, IsBaseCurrency: false },
    ],
  }, 'cfo_rtproject');
  assert.deepStrictEqual(e.columns.map((c) => c.schemaName), ['cfo_rollup'],
    'a read-only authored column must survive a download');
});

test('#574 follow-up: an attribute whose IsBaseCurrency could not be read is KEPT, not dropped', async () => {
  // Same fail-open direction as every other rule: when the Money cast read fails, no attribute
  // carries IsBaseCurrency, and "we could not look" must never become a column deletion.
  const e = entityFromMetadata({
    primaryNameAttribute: 'cfo_name',
    attributes: [
      { SchemaName: 'cfo_name', LogicalName: 'cfo_name', AttributeType: 'String', IsCustomAttribute: true },
      { SchemaName: 'cfo_budget', LogicalName: 'cfo_budget', AttributeType: 'Money', IsCustomAttribute: true },
    ],
  }, 'cfo_rtproject');
  assert.deepStrictEqual(e.columns.map((c) => c.schemaName), ['cfo_budget']);
});

test('#574 follow-up: IsBaseCurrency is read through the Money CAST and drops the twin on the REAL read path', async () => {
  // IsBaseCurrency lives on MoneyAttributeMetadata, not the base attribute type, so it needs its own
  // cast read. Dropping that read silently re-enables the leak.
  let castRequested = false;
  const sdk = {
    fetchEntityMetadata: async (logical) => ({
      logicalName: logical, schemaName: 'cfo_rtproject', displayName: 'RT Project', primaryNameAttribute: 'cfo_name',
      attributes: [
        { logicalName: 'cfo_budget', attributeType: 'Money', IsCustomAttribute: true },
        { logicalName: 'cfo_budget_base', attributeType: 'Money', IsCustomAttribute: true },
      ],
    }),
    queryRecords: async (set) => { throw new Error(`queryRecords must not be used for metadata paths (got \u0027${set}\u0027)`); },
    dataverse: {
      get: async (url) => {
        if (/MoneyAttributeMetadata/.test(url)) {
          castRequested = true;
          return { status: 200, headers: {}, body: { value: [
            { LogicalName: 'cfo_budget', IsBaseCurrency: false },
            { LogicalName: 'cfo_budget_base', IsBaseCurrency: true },
          ] } };
        }
        if (/\/Attributes\?/.test(url)) {
          return { status: 200, headers: {}, body: { value: [
            { LogicalName: 'cfo_budget', IsLogical: false, AttributeOf: null },
            { LogicalName: 'cfo_budget_base', IsLogical: false, AttributeOf: null },
          ] } };
        }
        return { status: 200, headers: {}, body: {} };
      },
    },
  };
  const meta = await readEntityWithDescriptions(sdk, 'cfo_rtproject');
  assert.ok(castRequested, 'the Money cast read must be issued');
  const e = entityFromMetadata(meta, 'cfo_rtproject');
  assert.deepStrictEqual(e.columns.map((c) => c.schemaName), ['cfo_budget'],
    `the base-currency twin must not survive the real read path; got ${JSON.stringify(e.columns.map((c) => c.schemaName))}`);
});
