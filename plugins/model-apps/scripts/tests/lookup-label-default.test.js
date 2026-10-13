'use strict';
// ADO 6691205 — a 1:N lookup column whose spec omits `lookup.displayName` must be labelled with the
// REFERENCED (parent) table's display name, as the maker portal does, instead of a logical name.
//
// The gap, reproduced from the code: entity-provision.js handed `lookupDisplayName: undefined` to the
// SDK, and the SDK's own fallback is the referenced table's LOGICAL name (`label(opts.lookupDisplayName
// ?? opts.referencedEntity, lcid)`), so the column — and every form cell, whose label the SDK derives
// from the column's DisplayName at push — read "new_project" where a maker expects "Project".
//
// Three layers are covered, because a mock would keep passing against a bundle that ignored the option:
//   1. the pure helper (app-spec.js) every surface shares;
//   2. the data-model phase, against the engine's own call sequence;
//   3. the REAL vendored bundle, asserting the request body the SDK actually serializes.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const {
  lookupLabelFor,
  lookupParentNeedsEnvironment,
  lookupColumnsFor,
  humanizeTableName,
  isOldLookupColumnLabel,
  isOldLookupFieldLabel,
  relationshipSchemaName,
} = require('../lib/app-spec.js');
const { makeRunner, provisionDataModel, relationshipsInCreateOrder } = require('../lib/entity-provision.js');
const { compileFormIntent } = require('../lib/artifact-intent.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

const project = (extra) => ({ schemaName: 'contoso_Project', displayName: 'Project', primaryAttribute: { schemaName: 'contoso_name' }, columns: [], ...extra });
const task = (extra) => ({ schemaName: 'contoso_Task', displayName: 'Task', primaryAttribute: { schemaName: 'contoso_name' }, columns: [], ...extra });
const oneToMany = (referenced, lookup) => ({ type: 'OneToMany', referenced, referencing: 'contoso_task', lookup });
const specOf = (entities, relationships, extra) => ({
  solution: { uniqueName: 'S', publisherPrefix: 'contoso' },
  entities,
  relationships,
  ...extra,
});

// ── 1. the shared helper ────────────────────────────────────────────────────────────────────────

test('ADO 6691205: an omitted lookup.displayName defaults to the declared parent table\'s displayName', () => {
  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  assert.deepStrictEqual(lookupLabelFor(spec, spec.relationships[0]), { label: 'Project', source: 'table' });
});

test('ADO 6691205: a LOCALIZED parent displayName is kept as the map, not flattened', () => {
  const map = { 1033: 'Project', 3082: 'Proyecto' };
  const spec = specOf([project({ displayName: map, pluralName: { 1033: 'Projects', 3082: 'Proyectos' } }), task()],
    [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })], { languageCode: 3082 });
  const got = lookupLabelFor(spec, spec.relationships[0]);
  assert.deepStrictEqual(got.label, map);
  assert.strictEqual(got.source, 'table');
});

test('ADO 6691205: an explicit lookup.displayName wins — a string or a map', () => {
  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId', displayName: 'Owning project' })]);
  assert.deepStrictEqual(lookupLabelFor(spec, spec.relationships[0]), { label: 'Owning project', source: 'explicit' });
  const map = { 1033: 'Owning project', 3082: 'Proyecto propietario' };
  spec.relationships[0].lookup.displayName = map;
  assert.deepStrictEqual(lookupLabelFor(spec, spec.relationships[0]), { label: map, source: 'explicit' });
});

test('ADO 6691205: a blank explicit label is treated as omitted, as every create site already does', () => {
  // The runtime falls back with `x.displayName || x.schemaName`, so "" and undefined reach Dataverse
  // identically; the default must not distinguish them either.
  for (const blank of ['', '   ', null]) {
    const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId', displayName: blank })]);
    assert.strictEqual(lookupLabelFor(spec, spec.relationships[0]).label, 'Project', `blank ${JSON.stringify(blank)}`);
  }
});

test('ADO 6691205: the declared parent is matched case-insensitively, like every other table reference', () => {
  const spec = specOf([project(), task()], [oneToMany('CONTOSO_PROJECT', { schemaName: 'contoso_ProjectId' })]);
  assert.strictEqual(lookupLabelFor(spec, spec.relationships[0]).label, 'Project');
});

test('ADO 6691205: a table the spec does not declare takes the label the environment reports', () => {
  // `account` / `contact` / `systemuser` are never in entities[]; the build reads their DisplayName.
  const spec = specOf([task()], [oneToMany('account', { schemaName: 'contoso_AccountId' })]);
  assert.deepStrictEqual(lookupLabelFor(spec, spec.relationships[0], { liveReferencedLabel: 'Account' }), { label: 'Account', source: 'environment' });
  assert.deepStrictEqual(lookupLabelFor(spec, spec.relationships[0], { liveReferencedLabel: '   ' }),
    { label: 'Account', source: 'derived' }, 'a blank environment label is not a label');
});

test('ADO 6691205: with nothing else available the label is a humanized table name, never the logical name', () => {
  const spec = specOf([task()], [oneToMany('account', { schemaName: 'contoso_AccountId' }), oneToMany('contoso_budgetline', { schemaName: 'contoso_LineId' })]);
  assert.deepStrictEqual(lookupLabelFor(spec, spec.relationships[0]), { label: 'Account', source: 'derived' });
  assert.deepStrictEqual(lookupLabelFor(spec, spec.relationships[1]), { label: 'Budgetline', source: 'derived' });
});

test('ADO 6691205: a declared parent with no displayName is humanized from its (cased) schema name', () => {
  const spec = specOf([project({ schemaName: 'contoso_ProjectPhase', displayName: undefined }), task()], [oneToMany('contoso_projectphase', { schemaName: 'contoso_PhaseId' })]);
  assert.deepStrictEqual(lookupLabelFor(spec, spec.relationships[0]), { label: 'Project Phase', source: 'derived' });
});

test('ADO 6691205: humanizeTableName strips the publisher prefix and title-cases the rest', () => {
  assert.strictEqual(humanizeTableName('new_project'), 'Project');
  assert.strictEqual(humanizeTableName('contoso_ProjectPhase'), 'Project Phase');
  assert.strictEqual(humanizeTableName('contoso_work_item'), 'Work Item');
  assert.strictEqual(humanizeTableName('account'), 'Account');
  assert.strictEqual(humanizeTableName('contoso_SLA'), 'SLA');
  assert.strictEqual(humanizeTableName(''), '');
  assert.strictEqual(humanizeTableName(undefined), '');
});

test('ADO 6691205: lookupColumnsFor reports the effective label, not the lookup schema name', () => {
  const spec = specOf([project(), task()], [
    oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' }),
    oneToMany('account', { schemaName: 'contoso_AccountId', displayName: 'Customer' }),
  ]);
  assert.deepStrictEqual(lookupColumnsFor(spec, 'contoso_task').map((l) => [l.logical, l.displayName]),
    [['contoso_projectid', 'Project'], ['contoso_accountid', 'Customer']]);
});

test('ADO 6691205: lookupColumnsFor resolves a localized default in the spec\'s language', () => {
  const spec = specOf([project({ displayName: { 1033: 'Project', 3082: 'Proyecto' }, pluralName: { 1033: 'Projects', 3082: 'Proyectos' } }), task()],
    [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })], { languageCode: 3082 });
  assert.strictEqual(lookupColumnsFor(spec, 'contoso_task')[0].displayName, 'Proyecto');
});

test('ADO 6691205: only EXACTLY what a build wrote on a COLUMN counts as its old default — the parent\'s lower-case logical name, and nothing else', () => {
  const rel = oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' });
  // What the vendored SDK actually sent as the COLUMN's label: the referenced table's LOWER-CASE logical name.
  assert.strictEqual(isOldLookupColumnLabel(rel, 'contoso_project'), true);
  // The lookup's own lower-case name is what the SDK leaves on a form FIELD it cannot resolve — never on a column,
  // so a column carrying it was labelled by a person.
  assert.strictEqual(isOldLookupColumnLabel(rel, 'contoso_projectid'), false);
  // The capitalised schema name is how the spec spells the lookup, not a string any build wrote.
  assert.strictEqual(isOldLookupColumnLabel(rel, 'contoso_ProjectId'), false);
  // Not the same strings, so not the old default: a case variant, or space around it, is somebody's label.
  assert.strictEqual(isOldLookupColumnLabel(rel, 'Contoso_Project'), false);
  assert.strictEqual(isOldLookupColumnLabel(rel, 'CONTOSO_PROJECT'), false);
  assert.strictEqual(isOldLookupColumnLabel(rel, ' contoso_project '), false);
  // A correct label is never the old default — least of all when the table's name IS its label, like contact.
  assert.strictEqual(isOldLookupColumnLabel(oneToMany('contact', { schemaName: 'contoso_ContactId' }), 'Contact'), false);
  assert.strictEqual(isOldLookupColumnLabel(oneToMany('contact', { schemaName: 'contoso_ContactId' }), 'contact'), true);
  // The names are lower-cased, as they are on their way to the SDK, wherever the spec capitalises them.
  assert.strictEqual(isOldLookupColumnLabel(oneToMany('Contoso_Project', { schemaName: 'contoso_ProjectId' }), 'contoso_project'), true);
  // A label a person wrote is never "the default".
  assert.strictEqual(isOldLookupColumnLabel(rel, 'Project'), false);
  assert.strictEqual(isOldLookupColumnLabel(rel, 'Owning project'), false);
  assert.strictEqual(isOldLookupColumnLabel(rel, ''), false);
  assert.strictEqual(isOldLookupColumnLabel(rel, undefined), false);
  assert.strictEqual(isOldLookupColumnLabel(rel, { 1033: 'contoso_project' }), false, 'a map is never the single-language default');
  assert.strictEqual(isOldLookupColumnLabel({ lookup: { schemaName: 'contoso_ProjectId' } }, ''), false, 'a relationship with no parent has no default to match');
});

test('ADO 6691205: a form FIELD\'s old default is the parent\'s lower-case logical name or the lookup\'s own — exactly', () => {
  const rel = oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' });
  // Inherited from the column…
  assert.strictEqual(isOldLookupFieldLabel(rel, 'contoso_project'), true);
  // …or, when the SDK cannot resolve the column at push, its control normalization defaults `label` to
  // `fieldName`: the lookup's own LOWER-CASE logical name, not the schema name the spec spells with capitals.
  assert.strictEqual(isOldLookupFieldLabel(rel, 'contoso_projectid'), true);
  for (const typed of ['contoso_ProjectId', 'CONTOSO_PROJECTID', 'Contoso_Project', ' contoso_projectid ', 'Project', '', undefined, { 1033: 'contoso_projectid' }]) {
    assert.strictEqual(isOldLookupFieldLabel(rel, typed), false, JSON.stringify(typed));
  }
  // Another relationship's names are somebody's label here.
  const other = oneToMany('contoso_account', { schemaName: 'contoso_AccountId' });
  assert.strictEqual(isOldLookupFieldLabel(other, 'contoso_project'), false);
  assert.strictEqual(isOldLookupFieldLabel(other, 'contoso_projectid'), false);
});

// ── 2. the data-model phase ─────────────────────────────────────────────────────────────────────

function engine({ existingTables = [], dataverse } = {}) {
  const calls = [];
  const sdk = {
    createTable: async (o) => { calls.push(['createTable', o]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: 't' }; },
    createColumn: async (l, o) => { calls.push(['createColumn', o]); return { logicalName: o.schemaName.toLowerCase(), metadataId: 'c' }; },
    updateColumn: async (l, c, o) => { calls.push(['updateColumn', l, c, o]); return {}; },
    updateTable: async () => ({}),
    createGlobalOptionSet: async () => ({ metadataId: 'g' }),
    insertStatusValue: async () => 100000000,
    createAlternateKey: async () => ({}),
    createRelationship: async (o) => { calls.push(['createRelationship', o]); return { schemaName: o.schemaName, metadataId: 'r', lookupLogicalName: String(o.lookupSchemaName).toLowerCase() }; },
  };
  const provision = {
    findTables: async (s) => (existingTables.includes(s.toLowerCase()) ? [{ logicalName: s.toLowerCase(), entitySetName: `${s.toLowerCase()}s` }] : []),
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => { calls.push(['fetchEntityMetadata', l]); return { logicalName: l, displayName: l, entitySetName: `${l}s`, relationships: [] }; },
    queryRecords: async () => [],
    ...(dataverse ? { dataverse } : {}),
  };
  return { calls, sdk, provision };
}

// A raw metadata client: every path it is asked for is recorded, and `handler` answers it. `post` records each write
// (the publish the label pass sends) and answers it with `publish` (204 by default).
function metadataClient(handler, { publish = () => ({ status: 204, headers: {}, body: {} }) } = {}) {
  const paths = [];
  const posts = [];
  return {
    paths, posts,
    get: async (p) => { paths.push(p); return handler(p); },
    post: async (p, body) => { posts.push([p, body]); return publish(p, body); },
  };
}

const label = (pairs, user) => ({
  LocalizedLabels: pairs.map(([LanguageCode, Label]) => ({ Label, LanguageCode })),
  UserLocalizedLabel: user ? { Label: user[1], LanguageCode: user[0] } : { Label: pairs[0][1], LanguageCode: pairs[0][0] },
});

async function build(spec, { existingTables, dataverse, warn, languageCode = 1033 } = {}) {
  const m = engine({ existingTables, dataverse });
  const warnings = [];
  const events = [];
  const runner = makeRunner({ emit: (e) => events.push(e), total: 30 });
  const dm = await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, preResolvedLanguageCode: languageCode, warn: warn || ((w) => warnings.push(w)) });
  return { ...m, dm, warnings, events, created: m.calls.filter((c) => c[0] === 'createRelationship').map((c) => c[1]) };
}

test('ADO 6691205: createRelationship carries the declared parent\'s display name when the spec omits one', async () => {
  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  const { created } = await build(spec);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].lookupDisplayName, 'Project',
    'the SDK falls back to the LOGICAL name when this is undefined, which is the reported bug');
});

test('ADO 6691205: a localized parent name reaches the SDK as the full LCID map', async () => {
  const map = { 1033: 'Project', 3082: 'Proyecto' };
  const spec = specOf([project({ displayName: map, pluralName: { 1033: 'Projects', 3082: 'Proyectos' } }), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  const { created } = await build(spec, { languageCode: 1033, existingTables: ['contoso_project', 'contoso_task'] });
  assert.deepStrictEqual(created[0].lookupDisplayName, map);
});

test('ADO 6691205: an explicit lookup.displayName is sent unchanged', async () => {
  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId', displayName: 'Owning project' })]);
  const { created } = await build(spec);
  assert.strictEqual(created[0].lookupDisplayName, 'Owning project');
});

test('ADO 6691205: a parent the spec does not declare is labelled from the environment, in the authoring language', async () => {
  const spec = specOf([task()], [oneToMany('account', { schemaName: 'contoso_AccountId' })]);
  const dataverse = metadataClient((p) => {
    if (p === "/EntityDefinitions(LogicalName='account')?$select=LogicalName,DisplayName") {
      // The caller's UI language (French) differs from the build's authoring language (English): the
      // label must come from the language the build stamps, not from whoever happens to be signed in.
      return { status: 200, body: { LogicalName: 'account', DisplayName: label([[1033, 'Account'], [1036, 'Compte']], [1036, 'Compte']) } };
    }
    return { status: 200, body: { value: [] } };
  });
  const { created, warnings } = await build(spec, { existingTables: ['contoso_task'], dataverse, languageCode: 1033 });
  assert.strictEqual(created[0].lookupDisplayName, 'Account');
  assert.deepStrictEqual(warnings, []);
});

test('ADO 6691205: the environment is asked for a parent\'s label once, however many lookups point at it', async () => {
  const spec = specOf([task()], [
    oneToMany('account', { schemaName: 'contoso_AccountId' }),
    { type: 'OneToMany', referenced: 'account', referencing: 'contoso_task', schemaName: 'contoso_account_task_second', lookup: { schemaName: 'contoso_SecondAccountId' } },
  ]);
  const dataverse = metadataClient((p) => (p.includes('$select=LogicalName,DisplayName')
    ? { status: 200, body: { LogicalName: 'account', DisplayName: label([[1033, 'Account']]) } }
    : { status: 200, body: { value: [] } }));
  const { created } = await build(spec, { existingTables: ['contoso_task'], dataverse });
  assert.deepStrictEqual(created.map((c) => c.lookupDisplayName), ['Account', 'Account']);
  assert.strictEqual(dataverse.paths.filter((p) => p.includes('$select=LogicalName,DisplayName')).length, 1);
});

test('ADO 6691205: a declared parent needs no environment read at all', async () => {
  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  const dataverse = metadataClient(() => ({ status: 200, body: { value: [] } }));
  await build(spec, { existingTables: ['contoso_project', 'contoso_task'], dataverse });
  assert.deepStrictEqual(dataverse.paths.filter((p) => p.includes('DisplayName')), [],
    'a label-bearing read before a create is the hazard documented on relationshipExists; it is not paid for a table the spec already names');
});

test('ADO 6691205: an unreadable parent label falls back to a humanized name and says so', async () => {
  const spec = specOf([task()], [oneToMany('systemuser', { schemaName: 'contoso_OwnerId' })]);
  const dataverse = metadataClient((p) => (p.includes('$select=LogicalName,DisplayName')
    ? { status: 503, body: {} }
    : { status: 200, body: { value: [] } }));
  const { created, warnings } = await build(spec, { existingTables: ['contoso_task'], dataverse });
  assert.strictEqual(created[0].lookupDisplayName, 'Systemuser');
  assert.ok(warnings.some((w) => /systemuser/.test(w) && /503/.test(w) && /lookup\.displayName/.test(w)), JSON.stringify(warnings));
});

test('ADO 6691205: with no raw client (a test double) the humanized fallback applies without a warning', async () => {
  const spec = specOf([task()], [oneToMany('account', { schemaName: 'contoso_AccountId' })]);
  const { created, warnings } = await build(spec, { existingTables: ['contoso_task'] });
  assert.strictEqual(created[0].lookupDisplayName, 'Account');
  assert.deepStrictEqual(warnings, []);
});

test('ADO 6691205: the parent label is read after the existence probe and immediately before the plain-label create', async () => {
  // The documented hazard (relationshipExists): a label-bearing metadata read makes Dataverse keep
  // only the base-language label of the create that FOLLOWS it. The label read here belongs to a
  // plain single-language create, so nothing can be stripped — but it must not drift away from it
  // and into the middle of a localized one.
  const spec = specOf([task()], [oneToMany('account', { schemaName: 'contoso_AccountId' })]);
  const order = [];
  const dataverse = metadataClient((p) => {
    order.push(p.includes('$select=LogicalName,DisplayName') ? 'label-read' : 'probe');
    return p.includes('$select=LogicalName,DisplayName')
      ? { status: 200, body: { LogicalName: 'account', DisplayName: label([[1033, 'Account']]) } }
      : { status: 200, body: { value: [] } };
  });
  const m = engine({ existingTables: ['contoso_task'], dataverse });
  const origCreate = m.sdk.createRelationship;
  m.sdk.createRelationship = async (o) => { order.push('create'); return origCreate(o); };
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner: makeRunner({ emit: () => {}, total: 20 }), spec, apply: true, preResolvedLanguageCode: 1033 });
  const first = (what) => order.indexOf(what);
  assert.ok(first('probe') >= 0 && first('probe') < first('label-read'), JSON.stringify(order));
  assert.strictEqual(order[order.indexOf('create') - 1], 'label-read', JSON.stringify(order));
});

test('ADO 6691205: an inherited LOCALIZED label keeps the narrow-probe rule — no broad metadata read before the create', async () => {
  // `hasLocalizedLabels` used to read only the AUTHORED lookup label. With the default, a localized
  // parent name makes the lookup label localized too, so the poisoning broad-read fallback must stay
  // off exactly as it is for an explicitly localized one.
  const map = { 1033: 'Project', 3082: 'Proyecto' };
  const spec = specOf([project({ displayName: map, pluralName: { 1033: 'Projects', 3082: 'Proyectos' } }), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  // Only the relationship probe is inconclusive; the tables still answer, so the build reaches it.
  const inconclusive = metadataClient((p) => {
    if (/OneToManyRelationships/.test(p)) return { status: 503, headers: {}, body: {} };
    if (/\?\$select=LogicalName,EntitySetName/.test(p)) return { status: 200, headers: {}, body: { LogicalName: p.match(/LogicalName='([^']+)'/)[1], EntitySetName: 'x' } };
    return { status: 200, headers: {}, body: { value: [] } };
  });
  const m = engine({ existingTables: ['contoso_project', 'contoso_task'], dataverse: inconclusive });
  const broad = [];
  m.provision.fetchEntityMetadata = async (l) => { broad.push(l); return { logicalName: l, entitySetName: `${l}s`, relationships: [] }; };
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner: makeRunner({ emit: () => {}, total: 20 }), spec, apply: true, preResolvedLanguageCode: 1033 });
  assert.deepStrictEqual(broad, [], 'the broad read is what strips every non-base language');
  assert.ok(m.calls.some((c) => c[0] === 'createRelationship'));
});

// ── 2b. a parent the spec declares WITHOUT a displayName ──────────────────────────────────────────
//
// `entities[]` lists the tables the app uses, including ones that already exist: { "schemaName": "incident",
// "existing": true } is how a spec reuses the stock Case table, and such an entry has no displayName because
// nothing here creates it. Its name is the environment's ("Case"), exactly as for a table the spec never lists.

const incident = (extra) => ({ schemaName: 'incident', existing: true, primaryAttribute: { schemaName: 'title' }, columns: [], ...extra });
const DISPLAY_NAME_READ = /\(LogicalName='[^']+'\)\?\$select=LogicalName,DisplayName$/;

// An environment whose tables answer the keyed DisplayName read with `labels` ({ logical: [[lcid, text], …] }).
const labelledTables = (labels) => metadataClient((p) => {
  const m = /\(LogicalName='([^']+)'\)\?\$select=LogicalName,DisplayName$/.exec(p);
  return m && labels[m[1]]
    ? { status: 200, body: { LogicalName: m[1], DisplayName: label(labels[m[1]]) } }
    : { status: 200, body: { value: [] } };
});
const displayNameReads = (dataverse) => dataverse.paths.filter((p) => DISPLAY_NAME_READ.test(p));

test('ADO 6691205: a parent declared `existing: true` with no displayName is labelled with the ENVIRONMENT\'s name — "Case", "User" — not a humanized one', async () => {
  const spec = specOf([task(), incident(), { schemaName: 'systemuser', existing: true, primaryAttribute: { schemaName: 'fullname' }, columns: [] }], [
    oneToMany('incident', { schemaName: 'contoso_CaseId' }),
    oneToMany('systemuser', { schemaName: 'contoso_OwnerId' }),
  ]);
  const dataverse = labelledTables({ incident: [[1033, 'Case'], [1036, 'Requête']], systemuser: [[1033, 'User'], [1036, 'Utilisateur']] });
  const { created, warnings } = await build(spec, { existingTables: ['contoso_task', 'incident', 'systemuser'], dataverse });
  assert.deepStrictEqual(created.map((c) => c.lookupDisplayName), ['Case', 'User'], 'the label the maker portal gives, in the build\'s language');
  assert.strictEqual(displayNameReads(dataverse).length, 2, 'one read per parent');
  assert.deepStrictEqual(warnings, []);
});

test('ADO 6691205: a declared `existing: true` CUSTOM table with no displayName is read the same way', async () => {
  const spec = specOf([project({ displayName: undefined, existing: true }), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  const dataverse = labelledTables({ contoso_project: [[1033, 'Project Portfolio']] });
  const { created } = await build(spec, { existingTables: ['contoso_project', 'contoso_task'], dataverse });
  assert.strictEqual(created[0].lookupDisplayName, 'Project Portfolio');
});

test('ADO 6691205: a declared parent with no displayName that the data-model phase finds ALREADY THERE is read, flagged or not', async () => {
  const spec = specOf([project({ displayName: undefined }), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  const dataverse = labelledTables({ contoso_project: [[1033, 'Project Portfolio']] });
  const { created } = await build(spec, { existingTables: ['contoso_project', 'contoso_task'], dataverse });
  assert.strictEqual(created[0].lookupDisplayName, 'Project Portfolio');
});

test('ADO 6691205: a declared parent with no displayName that THIS build creates is not read — it is labelled with its schema name, so the humanized name is the better one', async () => {
  const spec = specOf([project({ displayName: undefined }), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  const dataverse = labelledTables({ contoso_project: [[1033, 'contoso_Project']] });
  const { created, calls } = await build(spec, { existingTables: ['contoso_task'], dataverse });
  assert.ok(calls.some((c) => c[0] === 'createTable' && c[1].schemaName === 'contoso_Project'));
  assert.strictEqual(created[0].lookupDisplayName, 'Project');
  assert.deepStrictEqual(displayNameReads(dataverse), []);
});

test('ADO 6691205: a flagged parent the build had to create is not named by the identifier it was created under', async () => {
  // `existing` records ownership, not presence. Read back, the table this build just created reads
  // "contoso_Project" — its schema name — which is no more a name than the logical one the bug put there.
  const spec = specOf([project({ displayName: undefined, existing: true }), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  const dataverse = labelledTables({ contoso_project: [[1033, 'contoso_Project']] });
  const { created } = await build(spec, { existingTables: ['contoso_task'], dataverse });
  assert.strictEqual(created[0].lookupDisplayName, 'Project');
});

test('ADO 6691205: a displayName the spec sets on a declared parent wins over the environment, flagged or not — and costs no read', async () => {
  const spec = specOf([incident({ displayName: 'Support case' }), task()], [oneToMany('incident', { schemaName: 'contoso_CaseId' })]);
  const dataverse = labelledTables({ incident: [[1033, 'Case']] });
  const { created } = await build(spec, { existingTables: ['contoso_task', 'incident'], dataverse });
  assert.strictEqual(created[0].lookupDisplayName, 'Support case');
  assert.deepStrictEqual(displayNameReads(dataverse), []);
});

test('ADO 6691205: lookupLabelFor takes the environment\'s name for a declared parent that sets none, and ignores one that is only its identifier', () => {
  const spec = specOf([incident(), task()], [oneToMany('incident', { schemaName: 'contoso_CaseId' })]);
  const rel = spec.relationships[0];
  assert.deepStrictEqual(lookupLabelFor(spec, rel, { liveReferencedLabel: 'Case' }), { label: 'Case', source: 'environment' });
  assert.deepStrictEqual(lookupLabelFor(spec, rel), { label: 'Incident', source: 'derived' }, 'offline surfaces still have only the humanized name');
  for (const identifier of ['incident', '  ']) {
    assert.strictEqual(lookupLabelFor(spec, rel, { liveReferencedLabel: identifier }).source, 'derived', JSON.stringify(identifier));
  }
  const cased = specOf([project({ displayName: undefined }), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  assert.strictEqual(lookupLabelFor(cased, cased.relationships[0], { liveReferencedLabel: 'contoso_Project' }).source, 'derived', 'the schema name as written');
  assert.strictEqual(lookupLabelFor(cased, cased.relationships[0], { liveReferencedLabel: 'contoso_project' }).source, 'derived', 'the logical name');
  // A name that merely looks like the table's, in another case, is a name: "Contact" is the display name of `contact`.
  const contact = specOf([task()], [oneToMany('contact', { schemaName: 'contoso_ContactId' })]);
  assert.deepStrictEqual(lookupLabelFor(contact, contact.relationships[0], { liveReferencedLabel: 'Contact' }), { label: 'Contact', source: 'environment' });
  // A displayName the spec sets is not overridden by anything the environment says.
  const named = specOf([incident({ displayName: 'Support case' }), task()], [oneToMany('incident', { schemaName: 'contoso_CaseId' })]);
  assert.deepStrictEqual(lookupLabelFor(named, named.relationships[0], { liveReferencedLabel: 'Case' }), { label: 'Support case', source: 'table' });
});

test('ADO 6691205: lookupParentNeedsEnvironment — who must ask the environment for a parent\'s name', () => {
  const rel = (referenced) => oneToMany(referenced, { schemaName: 'contoso_ParentId' });
  const spec = specOf([
    project({ displayName: undefined }),
    { ...project({ displayName: undefined }), schemaName: 'contoso_Flagged', existing: true },
    { ...project({ displayName: 'Named' }), schemaName: 'contoso_NamedFlagged', existing: true },
    task(),
  ], []);
  assert.strictEqual(lookupParentNeedsEnvironment(spec, rel('account')), true, 'not declared');
  assert.strictEqual(lookupParentNeedsEnvironment(spec, rel('contoso_flagged')), true, 'declared, no displayName, `existing: true`');
  assert.strictEqual(lookupParentNeedsEnvironment(spec, rel('contoso_namedflagged')), false, 'the spec names it');
  assert.strictEqual(lookupParentNeedsEnvironment(spec, rel('contoso_project')), false, 'declared, no displayName, not known to be there: the build creates it');
  assert.strictEqual(lookupParentNeedsEnvironment(spec, rel('contoso_project'), { reused: new Set(['contoso_project']) }), true, '…unless the data-model phase found it already there');
  assert.strictEqual(lookupParentNeedsEnvironment(spec, rel('CONTOSO_FLAGGED')), true, 'matched case-insensitively');
});

// ── 2c. the order relationships are created in ──────────────────────────────────────────────────────
//
// A parent-label read carries labels, so it is the read the localization notes warn about: ahead of a create it can
// leave Dataverse with only the base-language label of a multi-language one. Each read sits right before its own
// plain create — but a LOCALIZED lookup created later in the same loop would still have a label-bearing read earlier
// in the phase. So the relationships with a localized label are created first.

// Builds `spec` against tables that exist, noting every `create:<lookup>` and every parent-label `read:<table>` in
// the one order they happen.
async function traceRelationships(spec, existing = ['contoso_task', 'contoso_project', 'contoso_other']) {
  const order = [];
  const dataverse = metadataClient((p) => {
    const probe = /\(LogicalName='([^']+)'\)\?\$select=LogicalName,EntitySetName$/.exec(p);
    if (probe) return existing.includes(probe[1]) ? { status: 200, body: { LogicalName: probe[1], EntitySetName: `${probe[1]}s` } } : { status: 404, body: {} };
    const read = /\(LogicalName='([^']+)'\)\?\$select=LogicalName,DisplayName$/.exec(p);
    if (read) {
      order.push(`read:${read[1]}`);
      return { status: 200, body: { LogicalName: read[1], DisplayName: label([[1033, read[1].charAt(0).toUpperCase() + read[1].slice(1)]]) } };
    }
    return { status: 200, body: { value: [] } };
  });
  const m = engine({ existingTables: existing, dataverse });
  const create = m.sdk.createRelationship;
  m.sdk.createRelationship = async (o) => { order.push(`create:${o.lookupSchemaName}`); return create(o); };
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner: makeRunner({ emit: () => {}, total: 40 }), spec, apply: true, preResolvedLanguageCode: 1033 });
  return order;
}

const NAMES = { 1033: 'Project', 3082: 'Proyecto' };
// Two lookups whose label is localized — one inherited from a localized parent table, one authored — and two plain
// ones, of which both need the environment's name for their parent.
const mixedRelationships = () => ({
  plainAccount: oneToMany('account', { schemaName: 'contoso_AccountId' }),
  plainUser: oneToMany('systemuser', { schemaName: 'contoso_OwnerId' }),
  inherited: oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' }),
  authored: oneToMany('contoso_other', { schemaName: 'contoso_OtherId', displayName: { 1033: 'Other', 3082: 'Otro' } }),
});
const mixedSpec = (order) => {
  const r = mixedRelationships();
  return specOf([project({ displayName: NAMES, pluralName: { 1033: 'Projects', 3082: 'Proyectos' } }), { ...project(), schemaName: 'contoso_Other', displayName: 'Other' }, task()], order.map((k) => r[k]));
};

function* permutations(items) {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i += 1) {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
  }
}

test('ADO 6691205: relationships with a LOCALIZED lookup label are created before any read of a parent\'s label', async () => {
  // Declared plain-first, the order that used to put a label-bearing read ahead of a multi-language create:
  // read the account label, create its lookup, then create the lookup labelled in two languages.
  const order = await traceRelationships(mixedSpec(['plainAccount', 'inherited', 'plainUser', 'authored']));
  assert.deepStrictEqual(order, [
    'create:contoso_ProjectId', 'create:contoso_OtherId', // the localized ones, in declared order
    'read:account', 'create:contoso_AccountId', 'read:systemuser', 'create:contoso_OwnerId', // then the plain ones, each read beside its own create
  ]);
});

test('ADO 6691205: whatever order the spec declares them in, no localized create follows a read of a parent\'s label', async () => {
  const keys = ['plainAccount', 'inherited', 'plainUser', 'authored'];
  const localizedLookups = new Set(['create:contoso_ProjectId', 'create:contoso_OtherId']);
  let seen = 0;
  for (const declared of permutations(keys)) {
    const order = await traceRelationships(mixedSpec(declared));
    const firstRead = order.findIndex((step) => step.startsWith('read:'));
    assert.ok(firstRead >= 0, `a parent label was read (${declared.join(', ')})`);
    assert.ok(order.slice(firstRead).every((step) => !localizedLookups.has(step)), `${declared.join(' > ')}: ${JSON.stringify(order)}`);
    assert.strictEqual(order.filter((step) => step.startsWith('create:')).length, 4, 'every relationship is still created');
    seen += 1;
  }
  assert.strictEqual(seen, 24);
});

test('ADO 6691205: each group keeps the spec\'s own order, and N:N relationships — which carry no label — follow the localized ones', async () => {
  const r = mixedRelationships();
  const spec = specOf([project({ displayName: NAMES, pluralName: { 1033: 'Projects', 3082: 'Proyectos' } }), { ...project(), schemaName: 'contoso_Other', displayName: 'Other' }, task()], [
    r.plainUser, { type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_task' }, r.authored, r.plainAccount, r.inherited,
  ]);
  assert.deepStrictEqual(relationshipsInCreateOrder(spec).map((x) => x.lookup ? x.lookup.schemaName : x.type),
    ['contoso_OtherId', 'contoso_ProjectId', 'contoso_OwnerId', 'ManyToMany', 'contoso_AccountId']);
});

test('ADO 6691205: the plan lists the relationships in the order the build creates them', () => {
  const spec = mixedSpec(['plainAccount', 'inherited', 'plainUser', 'authored']);
  const planned = planFor(spec, { phases: ['data-model'] });
  assert.deepStrictEqual(planned.filter((i) => /^relationship /.test(i.label)).map((i) => i.label), [
    'relationship 1:N contoso_project->contoso_task',
    'relationship 1:N contoso_other->contoso_task',
    'relationship 1:N account->contoso_task',
    'relationship 1:N systemuser->contoso_task',
  ]);
});

// ── 3. the REAL vendored bundle ─────────────────────────────────────────────────────────────────

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A real SDK over a stub transport. `routes` answers reads by URL; every write is captured.
async function realSdk(routes) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-label-'));
  dirs.push(dir);
  const writes = [];
  const reads = [];
  const created = { 'odata-entityid': 'https://contoso.crm.dynamics.com/api/data/v9.2/RelationshipDefinitions(11111111-1111-1111-1111-111111111111)' };
  const httpClient = {
    get: async (url) => {
      const u = decodeURIComponent(url);
      reads.push(u);
      for (const [re, answer] of routes) if (re.test(u)) return typeof answer === 'function' ? answer(u) : answer;
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => { writes.push({ verb: 'POST', url: decodeURIComponent(url), body }); return { status: 204, headers: created, body: {} }; },
    put: async (url, body, opts) => { writes.push({ verb: 'PUT', url: decodeURIComponent(url), body, headers: opts && opts.headers }); return { status: 204, headers: {}, body: {} }; },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, writes, reads };
}

const labelsOf = (write) => (write.body.Lookup.DisplayName.LocalizedLabels || []).map((l) => [l.LanguageCode, l.Label]);
const exists = (logical) => [new RegExp(`EntityDefinitions\\(LogicalName='${logical}'\\)\\?\\$select=LogicalName,EntitySetName`), { status: 200, headers: {}, body: { LogicalName: logical, EntitySetName: `${logical}s` } }];

test('REAL BUNDLE (ADO 6691205): the createRelationship body carries the parent\'s label at the authoring LCID', async () => {
  const { sdk, writes } = await realSdk([exists('contoso_project'), exists('contoso_task')]);
  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: () => {}, total: 20 }), spec, apply: true, preResolvedLanguageCode: 1031 });
  const post = writes.find((w) => /\/RelationshipDefinitions$/.test(w.url));
  assert.ok(post, JSON.stringify(writes.map((w) => w.url)));
  assert.deepStrictEqual(labelsOf(post), [[1031, 'Project']]);
});

test('REAL BUNDLE (ADO 6691205): a localized parent name serializes as one LocalizedLabel per language', async () => {
  const { sdk, writes } = await realSdk([exists('contoso_project'), exists('contoso_task')]);
  const spec = specOf([project({ displayName: { 1033: 'Project', 3082: 'Proyecto' }, pluralName: { 1033: 'Projects', 3082: 'Proyectos' } }), task()],
    [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: () => {}, total: 20 }), spec, apply: true, preResolvedLanguageCode: 1033 });
  const post = writes.find((w) => /\/RelationshipDefinitions$/.test(w.url));
  assert.deepStrictEqual(labelsOf(post), [[1033, 'Project'], [3082, 'Proyecto']]);
});

test('REAL BUNDLE (ADO 6691205): a system parent is labelled from the keyed DisplayName read the SDK client sends', async () => {
  // Drives the REAL client (`sdk.dataverse`) rather than an injected stub, so the request path and the
  // response parsing are the ones a live build uses.
  const { sdk, writes, reads } = await realSdk([
    exists('contoso_task'),
    [/EntityDefinitions\(LogicalName='account'\)\?\$select=LogicalName,DisplayName/, { status: 200, headers: {}, body: { LogicalName: 'account', DisplayName: label([[1033, 'Account'], [1036, 'Compte']], [1036, 'Compte']) } }],
  ]);
  const spec = specOf([task()], [oneToMany('account', { schemaName: 'contoso_AccountId' })]);
  await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: () => {}, total: 20 }), spec, apply: true, preResolvedLanguageCode: 1033 });
  assert.ok(reads.some((r) => /EntityDefinitions\(LogicalName='account'\)\?\$select=LogicalName,DisplayName$/.test(r)), JSON.stringify(reads));
  const post = writes.find((w) => /\/RelationshipDefinitions$/.test(w.url));
  assert.deepStrictEqual(labelsOf(post), [[1033, 'Account']]);
});

test('REAL BUNDLE (ADO 6691205): the old default really was the referenced table\'s logical name', async () => {
  // Pins the premise of the whole fix and of the repair rule's "buggy default": with no label the
  // bundle sends the referenced entity's LOGICAL name. If a re-vendor changes that, the repair rule
  // must be revisited, so this fails loudly instead of the rule silently going stale.
  const { sdk, writes } = await realSdk([]);
  await sdk.createRelationship({ type: 'OneToMany', schemaName: 'contoso_project_contoso_task', referencedEntity: 'contoso_project', referencingEntity: 'contoso_task', lookupSchemaName: 'contoso_ProjectId', languageCode: 1033 });
  assert.deepStrictEqual(labelsOf(writes.find((w) => /\/RelationshipDefinitions$/.test(w.url))), [[1033, 'contoso_project']]);
});

test('REAL BUNDLE (ADO 6691205): a fresh build\'s auto-layout form labels the lookup cell with the parent\'s name', async () => {
  // The symptom as a maker sees it, end to end. The environment is stateful: it keeps the DisplayName the
  // createRelationship POST carried and answers the SDK's push-time attribute read with it, which is how
  // the SDK labels a cell the compiled form leaves unlabelled. Before the fix that label was "contoso_project".
  const { sdk, writes } = await realSdk([
    exists('contoso_project'), exists('contoso_task'),
    [/EntityDefinitions\(LogicalName='contoso_task'\)\/Attributes\?/, (u) => {
      const created = writes.find((w) => /\/RelationshipDefinitions$/.test(w.url));
      const asked = [...u.matchAll(/LogicalName eq '([^']+)'/g)].map((m) => m[1]);
      const attributes = [
        { LogicalName: 'contoso_name', AttributeType: 'String', DisplayName: label([[1033, 'Name']]) },
        { LogicalName: 'contoso_projectid', AttributeType: 'Lookup', DisplayName: label(created.body.Lookup.DisplayName.LocalizedLabels.map((l) => [l.LanguageCode, l.Label])) },
      ];
      return { status: 200, headers: {}, body: { value: attributes.filter((a) => !asked.length || asked.includes(a.LogicalName)) } };
    }],
  ]);
  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })], { forms: [{ entity: 'contoso_task', name: 'Task', layout: 'auto' }] });
  await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: () => {}, total: 20 }), spec, apply: true, preResolvedLanguageCode: 1033 });

  const intent = compileFormIntent(spec, spec.forms[0], {});
  const lookupCell = intent.tabs[0].columns[0].sections[0].rows.flatMap((r) => r.cells).find((c) => c.control && c.control.fieldName === 'contoso_projectid');
  assert.ok(lookupCell, 'the auto layout places the parent lookup');
  assert.strictEqual(lookupCell.control.label, undefined, 'the cell carries no label of its own, so the column\'s decides');

  const art = await sdk.createArtifact('form', { name: intent.name, entityLogicalName: intent.entityLogicalName, formType: intent.formType, status: intent.status });
  for (const tab of intent.tabs) await sdk.addElement('form', art.id, '/tabs', tab);
  await sdk.removeElement('form', art.id, '/tabs/0');
  await sdk.pushArtifact('form', art.id);
  const xml = String(writes.map((w) => w.body && w.body.formxml).find(Boolean));
  const cell = xml.split('<cell').find((c) => /datafieldname="contoso_projectid"/.test(c));
  assert.ok(cell, 'the lookup cell is in the pushed form');
  assert.match(cell, /<label description="Project" languagecode="1033" \/>/);
  assert.doesNotMatch(cell, /description="contoso_project"/);
});

// ── 4. a REBUILD repairs the old default — and only the old default ───────────────────────────────

const REL = 'contoso_project_contoso_task';
// The collection read the repair makes, once per child table:
//   GET …/EntityDefinitions(LogicalName='contoso_task')/Attributes?$select=LogicalName,DisplayName&$filter=LogicalName eq '…' or …
const COLUMN_LABEL = /\/Attributes\?\$select=LogicalName,DisplayName&\$filter=/;

// An environment in which the relationship (and so the lookup column) already exists, with the lookup
// column labelled `labels` ([[lcid, text], ...]) — or answering `columnStatus` instead. `columns` adds the
// labels of further columns of the child table ({ logical: [[lcid, text], ...] }) and `relationships` the
// rows of further existing relationships; the label read answers for whichever of them it is asked about.
function rebuildEnv({ labels, columnStatus = 200, parentLabel, parentLabels = {}, relationship = REL, referenced = 'contoso_project', lookup = 'contoso_projectid', columns = {}, relationships, publish } = {}) {
  const known = { ...(labels ? { [lookup]: labels } : {}), ...columns };
  const parents = { ...(parentLabel ? { [referenced]: parentLabel } : {}), ...parentLabels };
  return metadataClient((p) => {
    if (/OneToManyRelationships/.test(p)) {
      return { status: 200, headers: {}, body: { value: relationships || [{ SchemaName: relationship, ReferencingEntity: 'contoso_task', ReferencingAttribute: lookup }] } };
    }
    if (/\?\$select=LogicalName,EntitySetName/.test(p)) return { status: 200, headers: {}, body: { LogicalName: p.match(/LogicalName='([^']+)'/)[1], EntitySetName: 'x' } };
    if (COLUMN_LABEL.test(p)) {
      if (columnStatus !== 200) return { status: columnStatus, headers: {}, body: {} };
      const asked = [...p.matchAll(/LogicalName eq '([^']+)'/g)].map((m) => m[1]);
      return { status: 200, headers: {}, body: { value: asked.filter((name) => known[name]).map((name) => ({ LogicalName: name, DisplayName: label(known[name]) })) } };
    }
    const parent = /LogicalName='([^']+)'\)\?\$select=LogicalName,DisplayName$/.exec(p);
    if (parent && parents[parent[1]]) {
      return { status: 200, headers: {}, body: { LogicalName: parent[1], DisplayName: label(parents[parent[1]]) } };
    }
    return { status: 200, headers: {}, body: { value: [] } };
  }, publish ? { publish } : {});
}

async function rebuild(spec, env, extra = {}, existingTables = ['contoso_project', 'contoso_task']) {
  const m = engine({ existingTables, dataverse: env });
  const events = [];
  const warnings = [];
  const dm = await provisionDataModel({
    sdk: m.sdk, provision: m.provision, runner: makeRunner({ emit: (e) => events.push(e), total: 40 }), spec, apply: true,
    preResolvedLanguageCode: 1033, reconcileLookupLabels: true, warn: (w) => warnings.push(w), ...extra,
  });
  const updates = m.calls.filter((c) => c[0] === 'updateColumn');
  const labelEvents = events.filter((e) => /^lookup label /.test(e.label) && e.status !== 'start');
  return { ...m, dm, events, warnings, updates, labelEvents };
}

const omitted = () => specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);

test('ADO 6691205 rebuild: a lookup labelled with the SDK\'s old default (the parent\'s logical name) is relabelled', async () => {
  const r = await rebuild(omitted(), rebuildEnv({ labels: [[1033, 'contoso_project']] }));
  assert.deepStrictEqual(r.updates, [['updateColumn', 'contoso_task', 'contoso_projectid', { displayName: 'Project', languageCode: 1033 }]]);
  assert.strictEqual(r.labelEvents.length, 1);
  assert.strictEqual(r.labelEvents[0].status, 'ok');
  assert.match(r.labelEvents[0].label, /lookup label contoso_task\.contoso_ProjectId: "contoso_project" -> "Project"/);
  assert.deepStrictEqual(r.dm.lookupLabels['contoso_task|contoso_projectid'], { label: 'Project' });
});

test('ADO 6691205 rebuild: the lookup\'s own lower-case logical name is NOT a column\'s old default — only a form field was ever left with it', async () => {
  // The SDK's fallback for a form FIELD it cannot resolve at push is the field's own lower-case logical name; the label
  // it gives the COLUMN is the referenced table's. So a column carrying `contoso_projectid` was labelled by a person
  // (or a tool that is not this build) and a rebuild leaves it alone, like any other label that is not the old default.
  for (const typed of ['contoso_projectid', 'contoso_ProjectId', 'CONTOSO_PROJECTID']) {
    const r = await rebuild(omitted(), rebuildEnv({ labels: [[1033, typed]] }));
    assert.deepStrictEqual(r.updates, [], `${typed}: not what any build wrote on a column`);
    assert.match(r.labelEvents[0].label, new RegExp(`labelled "${typed}" — left as it is`));
    assert.deepStrictEqual(r.dm.lookupLabels['contoso_task|contoso_projectid'], { label: typed }, 'the form phase then follows the column');
  }
});

test('ADO 6691205 rebuild: a label a maker chose is left alone', async () => {
  const r = await rebuild(omitted(), rebuildEnv({ labels: [[1033, 'Parent project']] }));
  assert.deepStrictEqual(r.updates, []);
  assert.strictEqual(r.labelEvents.length, 1);
  assert.strictEqual(r.labelEvents[0].status, 'skip');
  assert.match(r.labelEvents[0].label, /labelled "Parent project" — left as it is/);
  // The forms phase aligns an old cell label with what the column says NOW.
  assert.deepStrictEqual(r.dm.lookupLabels['contoso_task|contoso_projectid'], { label: 'Parent project' });
});

test('ADO 6691205 rebuild: a label that is not the old default is left alone, even when it equals the new default', async () => {
  const r = await rebuild(omitted(), rebuildEnv({ labels: [[1033, 'Project']] }));
  assert.deepStrictEqual(r.updates, []);
  assert.match(r.labelEvents[0].label, /labelled "Project" — left as it is/);
});

test('ADO 6691205 rebuild: a label carrying several languages was edited since, so it is left alone', async () => {
  const r = await rebuild(omitted(), rebuildEnv({ labels: [[1033, 'contoso_project'], [3082, 'proyecto']] }));
  assert.deepStrictEqual(r.updates, []);
  assert.match(r.labelEvents[0].label, /several languages/);
});

test('ADO 6691205 rebuild: an explicit lookup.displayName is never reapplied, even over the old default', async () => {
  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId', displayName: 'Owning project' })]);
  const env = rebuildEnv({ labels: [[1033, 'contoso_project']] });
  const r = await rebuild(spec, env);
  assert.deepStrictEqual(r.updates, []);
  assert.deepStrictEqual(r.labelEvents, [], 'the author owns this label: no step, and no read of the column');
  assert.ok(!env.paths.some((p) => COLUMN_LABEL.test(p)), JSON.stringify(env.paths));
});

test('ADO 6691205 rebuild: a column the build just created is neither read nor repaired', async () => {
  const env = metadataClient(() => ({ status: 200, headers: {}, body: { value: [] } }));
  const r = await rebuild(omitted(), env);
  assert.ok(r.calls.some((c) => c[0] === 'createRelationship'));
  assert.deepStrictEqual(r.updates, []);
  assert.match(r.labelEvents[0].label, /set when the relationship was created/);
  assert.ok(!env.paths.some((p) => COLUMN_LABEL.test(p)), 'the label just written is not read back');
});

test('ADO 6691205 rebuild: an unreadable column is skipped with a warning, never repaired blind', async () => {
  const r = await rebuild(omitted(), rebuildEnv({ columnStatus: 503 }));
  assert.deepStrictEqual(r.updates, []);
  assert.match(r.labelEvents[0].label, /could not be read — left as it is/);
  assert.ok(r.warnings.some((w) => /contoso_projectid/.test(w) && /503/.test(w)), JSON.stringify(r.warnings));
});

test('ADO 6691205 rebuild: a column the environment does not have is skipped quietly', async () => {
  const r = await rebuild(omitted(), rebuildEnv({ columnStatus: 404 }));
  assert.deepStrictEqual(r.updates, []);
  assert.match(r.labelEvents[0].label, /column not found/);
  assert.deepStrictEqual(r.warnings, []);
});

test('ADO 6691205 rebuild: a lookup to a system table is repaired to the label the environment reports for it', async () => {
  const spec = specOf([task()], [{ type: 'OneToMany', referenced: 'account', referencing: 'contoso_task', lookup: { schemaName: 'contoso_AccountId' } }]);
  const env = rebuildEnv({ labels: [[1033, 'account']], relationship: 'contoso_account_task', referenced: 'account', lookup: 'contoso_accountid', parentLabel: [[1033, 'Account']] });
  const r = await rebuild(spec, env);
  assert.deepStrictEqual(r.updates, [['updateColumn', 'contoso_task', 'contoso_accountid', { displayName: 'Account', languageCode: 1033 }]]);
});

test('ADO 6691205 rebuild: a localized parent name is written in the authoring language only, never as a multi-language update', async () => {
  // An UPDATE preceded by a label-bearing read is the shape the documented base-language hazard strips;
  // one language cannot be stripped to less than itself.
  const spec = specOf([project({ displayName: { 1033: 'Project', 3082: 'Proyecto' }, pluralName: { 1033: 'Projects', 3082: 'Proyectos' } }), task()],
    [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  const r = await rebuild(spec, rebuildEnv({ labels: [[3082, 'contoso_project']] }), { preResolvedLanguageCode: 3082 });
  assert.deepStrictEqual(r.updates, [['updateColumn', 'contoso_task', 'contoso_projectid', { displayName: 'Proyecto', languageCode: 3082 }]]);
});

test('ADO 6691205 rebuild: a failed relabel is a warning, not a halt — it is cosmetic', async () => {
  const m = engine({ existingTables: ['contoso_project', 'contoso_task'], dataverse: rebuildEnv({ labels: [[1033, 'contoso_project']] }) });
  m.sdk.updateColumn = async () => { throw new Error('PUT refused'); };
  const warnings = [];
  const dm = await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner: makeRunner({ emit: () => {}, total: 40 }), spec: omitted(), apply: true,
    preResolvedLanguageCode: 1033, reconcileLookupLabels: true, warn: (w) => warnings.push(w) });
  assert.ok(dm);
  assert.ok(warnings.some((w) => /could not relabel lookup 'contoso_task\.contoso_projectid'/.test(w) && /PUT refused/.test(w) && /"contoso_project"/.test(w) && /"Project"/.test(w)), JSON.stringify(warnings));
});

test('ADO 6691205 rebuild: without the opt-in (the genpage entity builder) nothing is read or repaired', async () => {
  const env = rebuildEnv({ labels: [[1033, 'contoso_project']] });
  const r = await rebuild(omitted(), env, { reconcileLookupLabels: false });
  assert.deepStrictEqual(r.updates, []);
  assert.deepStrictEqual(r.labelEvents, []);
  assert.ok(!env.paths.some((p) => COLUMN_LABEL.test(p)));
});

// A rebuild of a table with several lookups, every one of them still on its old default.
const threeLookups = () => specOf([project(), task()], [
  oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' }),
  oneToMany('account', { schemaName: 'contoso_AccountId' }),
  oneToMany('contact', { schemaName: 'contoso_ContactId' }),
]);
const LOOKUPS = ['contoso_projectid', 'contoso_accountid', 'contoso_contactid'];
const threeLookupsEnv = (extra) => rebuildEnv({
  columns: { contoso_projectid: [[1033, 'contoso_project']], contoso_accountid: [[1033, 'account']], contoso_contactid: [[1033, 'contact']] },
  relationships: [
    { SchemaName: REL, ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' },
    { SchemaName: 'contoso_account_task', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_accountid' },
    { SchemaName: 'contoso_contact_task', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_contactid' },
  ],
  parentLabels: { account: [[1033, 'Account']], contact: [[1033, 'Contact']] },
  ...extra,
});
const labelReadsOf = (env) => env.paths.filter((p) => COLUMN_LABEL.test(p));

test('ADO 6691205 rebuild: the labels of ALL of a table\'s lookups are read in ONE request, not one per lookup', async () => {
  const env = threeLookupsEnv();
  const r = await rebuild(threeLookups(), env);
  const reads = labelReadsOf(env);
  assert.strictEqual(reads.length, 1, JSON.stringify(reads));
  assert.match(reads[0], /EntityDefinitions\(LogicalName='contoso_task'\)\/Attributes\?\$select=LogicalName,DisplayName&\$filter=/);
  for (const name of LOOKUPS) assert.ok(reads[0].includes(`LogicalName eq '${name}'`), reads[0]);
  assert.deepStrictEqual(r.updates.map((u) => [u[2], u[3].displayName]), [['contoso_projectid', 'Project'], ['contoso_accountid', 'Account'], ['contoso_contactid', 'Contact']]);
  assert.strictEqual(r.labelEvents.length, 3, 'still one step per lookup, which is what the plan budgets');
});

// A column's label is part of its table's definition, which goes live only once the table is published, and nothing
// else in the build is sure to publish a relabelled lookup's child table (a downloaded spec, for one, gives it no form,
// view, chart or icon, and no enriched default views). So the pass publishes every table it relabelled itself: in one
// request, each table once, before anything else.
const publishesOf = (env) => env.posts.filter(([p]) => p === '/PublishXml').map(([, body]) => body.ParameterXml);

test('ADO 6691205 rebuild: the table whose lookups were relabelled is published at once, in one request, named once', async () => {
  const env = threeLookupsEnv();
  const r = await rebuild(threeLookups(), env);
  assert.strictEqual(r.updates.length, 3);
  assert.deepStrictEqual(publishesOf(env), ['<importexportxml><entities><entity>contoso_task</entity></entities></importexportxml>']);
  assert.deepStrictEqual(r.warnings, []);
});

test('ADO 6691205 rebuild: lookups relabelled on two tables publish both tables, in the same one request', async () => {
  const step = { schemaName: 'contoso_Step', displayName: 'Step', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] };
  const spec = specOf([project(), task(), step], [
    oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' }),
    { type: 'OneToMany', referenced: 'contoso_project', referencing: 'contoso_step', lookup: { schemaName: 'contoso_ProjectId' } },
  ]);
  const env = rebuildEnv({ labels: [[1033, 'contoso_project']], relationships: [
    { SchemaName: REL, ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' },
    { SchemaName: 'contoso_project_contoso_step', ReferencingEntity: 'contoso_step', ReferencingAttribute: 'contoso_projectid' },
  ] });
  const r = await rebuild(spec, env, {}, ['contoso_project', 'contoso_task', 'contoso_step']);
  assert.deepStrictEqual(r.updates.map((u) => u[1]).sort(), ['contoso_step', 'contoso_task'], JSON.stringify(r.updates));
  const published = publishesOf(env);
  assert.strictEqual(published.length, 1, JSON.stringify(published));
  assert.match(published[0], /<entity>contoso_task<\/entity>/);
  assert.match(published[0], /<entity>contoso_step<\/entity>/);
});

test('ADO 6691205 rebuild: nothing is published when no lookup is relabelled', async () => {
  const env = rebuildEnv({ labels: [[1033, 'Project']] });
  const r = await rebuild(omitted(), env);
  assert.deepStrictEqual(r.updates, []);
  assert.deepStrictEqual(publishesOf(env), []);
});

test('ADO 6691205 rebuild: a publish of the relabelled table that fails is a warning naming the table, and the build goes on', async () => {
  const env = rebuildEnv({ labels: [[1033, 'contoso_project']], publish: () => ({ status: 503, headers: {}, body: {} }) });
  const r = await rebuild(omitted(), env);
  assert.strictEqual(r.updates.length, 1);
  assert.strictEqual(publishesOf(env).length, 1);
  assert.ok(r.warnings.some((w) => /table contoso_task are saved but not published \(PublishXml answered HTTP 503\).*publish that table in Power Apps/.test(w)), r.warnings.join(' | '));
  assert.deepStrictEqual(r.dm.lookupLabels['contoso_task|contoso_projectid'], { label: 'Project' }, 'the saved label still labels the form cells');
});

test('ADO 6691205 rebuild: only the lookups this run did not just create are read for', async () => {
  // The relationship rows the environment holds omit the account lookup, so this build CREATES it and must
  // neither read nor repair what it has just labelled.
  const env = threeLookupsEnv({ relationships: [
    { SchemaName: REL, ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' },
    { SchemaName: 'contoso_contact_task', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_contactid' },
  ] });
  const r = await rebuild(threeLookups(), env);
  assert.deepStrictEqual(r.calls.filter((c) => c[0] === 'createRelationship').map((c) => c[1].lookupSchemaName), ['contoso_AccountId']);
  const [read] = labelReadsOf(env);
  assert.ok(read.includes("'contoso_projectid'") && read.includes("'contoso_contactid'") && !read.includes('contoso_accountid'), read);
  assert.deepStrictEqual(r.updates.map((u) => u[2]), ['contoso_projectid', 'contoso_contactid']);
});

test('ADO 6691205 rebuild: a table whose labels cannot be read is warned about ONCE, and every lookup of it is skipped', async () => {
  const r = await rebuild(threeLookups(), threeLookupsEnv({ columnStatus: 503 }));
  assert.deepStrictEqual(r.updates, []);
  assert.strictEqual(r.labelEvents.length, 3);
  assert.ok(r.labelEvents.every((e) => /could not be read — left as it is/.test(e.label)), JSON.stringify(r.labelEvents.map((e) => e.label)));
  const warned = r.warnings.filter((w) => /503/.test(w));
  assert.strictEqual(warned.length, 1, JSON.stringify(r.warnings));
  for (const name of LOOKUPS) assert.match(warned[0], new RegExp(name));
});

test('ADO 6691205 rebuild: a table that answers without the lookup column says "column not found", and is not an error', async () => {
  const r = await rebuild(omitted(), rebuildEnv({}));
  assert.deepStrictEqual(r.updates, []);
  assert.match(r.labelEvents[0].label, /column not found/);
  assert.deepStrictEqual(r.warnings, []);
});

const contactLookup = () => specOf([task()], [oneToMany('contact', { schemaName: 'contoso_ContactId' })]);
const contactEnv = (labels, parentLabel) => rebuildEnv({ labels, relationship: 'contoso_contact_task', referenced: 'contact', lookup: 'contoso_contactid', parentLabel });
const PARENT_READ = /\(LogicalName='contact'\)\?\$select=LogicalName,DisplayName$/;

test('ADO 6691205 rebuild: a correct "Contact" is not the old default — nothing is repaired, and the table\'s name is not even read', async () => {
  // The old default is the lower-case logical name "contact". "Contact" is the table's display name, i.e. the
  // right answer; matching it too would cost a read of the table on EVERY rebuild just to learn that.
  const env = contactEnv([[1033, 'Contact']], [[1033, 'Contact']]);
  const r = await rebuild(contactLookup(), env);
  assert.deepStrictEqual(r.updates, []);
  assert.match(r.labelEvents[0].label, /labelled "Contact" — left as it is/);
  assert.deepStrictEqual(env.paths.filter((p) => PARENT_READ.test(p)), []);
});

test('ADO 6691205 rebuild: a "Contact" a maker typed on a table the organization has since renamed is left alone', async () => {
  const r = await rebuild(contactLookup(), contactEnv([[1033, 'Contact']], [[1033, 'Person']]));
  assert.deepStrictEqual(r.updates, []);
  assert.deepStrictEqual(r.dm.lookupLabels['contoso_task|contoso_contactid'], { label: 'Contact' });
});

test('ADO 6691205 rebuild: the lower-case logical name is still repaired, to the capitalised display name', async () => {
  const r = await rebuild(contactLookup(), contactEnv([[1033, 'contact']], [[1033, 'Contact']]));
  assert.deepStrictEqual(r.updates, [['updateColumn', 'contoso_task', 'contoso_contactid', { displayName: 'Contact', languageCode: 1033 }]]);
});

test('ADO 6691205 rebuild: an old default in a language other than the build\'s is left alone — a write in the build\'s language would leave two', async () => {
  // The old default was written at 1033; this build writes French. "Projet" at 1036 beside "contoso_project"
  // at 1033 would report success, leave the identifier on show for every English user, and make every later
  // rebuild skip the column, because it then carries two languages.
  const r = await rebuild(omitted(), rebuildEnv({ labels: [[1033, 'contoso_project']] }), { preResolvedLanguageCode: 1036 });
  assert.deepStrictEqual(r.updates, []);
  assert.match(r.labelEvents[0].label, /the old default "contoso_project" is in language 1033, not the build's 1036 — left as it is/);
  assert.ok(r.warnings.some((w) => /contoso_projectid/.test(w) && /1033/.test(w) && /1036/.test(w) && /two languages/.test(w) && /Rename the column in Maker/.test(w) && !/Set lookup\.displayName/.test(w)), JSON.stringify(r.warnings));
  assert.deepStrictEqual(r.dm.lookupLabels['contoso_task|contoso_projectid'], { label: 'contoso_project' }, 'what the column carries, which the form cell is aligned to');
});

test('ADO 6691205 rebuild: an old default in the build\'s own language is repaired whatever that language is', async () => {
  const r = await rebuild(omitted(), rebuildEnv({ labels: [[1036, 'contoso_project']] }), { preResolvedLanguageCode: 1036 });
  assert.deepStrictEqual(r.updates, [['updateColumn', 'contoso_task', 'contoso_projectid', { displayName: 'Project', languageCode: 1036 }]]);
});

test('ADO 6691205 rebuild: a lookup to a declared `existing: true` system table is repaired to the ENVIRONMENT\'s name — "Case", not a humanized "Incident"', async () => {
  const spec = specOf([task(), incident()], [oneToMany('incident', { schemaName: 'contoso_CaseId' })]);
  const env = rebuildEnv({ labels: [[1033, 'incident']], relationship: relationshipSchemaName(spec.relationships[0], 'contoso'), referenced: 'incident', lookup: 'contoso_caseid', parentLabel: [[1033, 'Case']] });
  const r = await rebuild(spec, env);
  assert.deepStrictEqual(r.updates, [['updateColumn', 'contoso_task', 'contoso_caseid', { displayName: 'Case', languageCode: 1033 }]]);
  assert.deepStrictEqual(r.dm.lookupLabels['contoso_task|contoso_caseid'], { label: 'Case' }, 'and so is the form cell');
});

test('ADO 6691205 rebuild: a lookup to a declared `existing: true` custom table converges to the name the environment holds for it', async () => {
  const spec = specOf([project({ displayName: undefined, existing: true }), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  const r = await rebuild(spec, rebuildEnv({ labels: [[1033, 'contoso_project']], parentLabel: [[1033, 'Project Portfolio']] }));
  assert.deepStrictEqual(r.updates, [['updateColumn', 'contoso_task', 'contoso_projectid', { displayName: 'Project Portfolio', languageCode: 1033 }]]);
});

test('REAL BUNDLE (ADO 6691205 rebuild): the relabel is a MergeLabels PUT of the typed lookup definition at the authoring LCID', async () => {
  // Proves the SDK path the repair relies on — `updateColumn` on a LOOKUP — serializes what the repair
  // means: the label replaced at one language, every other property of the definition round-tripped,
  // and the header that keeps any other language a maker added.
  const id = '22222222-2222-2222-2222-222222222222';
  const { sdk, writes, reads } = await realSdk([
    exists('contoso_project'), exists('contoso_task'),
    [/OneToManyRelationships/, { status: 200, headers: {}, body: { value: [{ SchemaName: REL, ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' }] } }],
    [COLUMN_LABEL, { status: 200, headers: {}, body: { value: [{ LogicalName: 'contoso_projectid', DisplayName: label([[1031, 'contoso_project']]) }] } }],
    [/Attributes\(LogicalName='contoso_projectid'\)\?\$select=MetadataId,AttributeType/, { status: 200, headers: {}, body: { MetadataId: id, AttributeType: 'Lookup' } }],
    [new RegExp(`Attributes\\(${id}\\)/Microsoft.Dynamics.CRM.LookupAttributeMetadata`), {
      status: 200,
      headers: {},
      body: {
        '@odata.context': 'x', LogicalName: 'contoso_projectid', SchemaName: 'contoso_ProjectId', AttributeType: 'Lookup', Targets: ['contoso_project'],
        DisplayName: label([[1031, 'contoso_project']]), RequiredLevel: { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
      },
    }],
  ]);
  await provisionDataModel({ sdk, provision: sdk, runner: makeRunner({ emit: () => {}, total: 40 }), spec: omitted(), apply: true, preResolvedLanguageCode: 1031, reconcileLookupLabels: true });
  const put = writes.find((w) => w.verb === 'PUT');
  assert.ok(put, JSON.stringify(writes.map((w) => `${w.verb} ${w.url}`)));
  assert.match(put.url, new RegExp(`Attributes\\(${id}\\)$`));
  assert.deepStrictEqual((put.body.DisplayName.LocalizedLabels || []).map((l) => [l.LanguageCode, l.Label]), [[1031, 'Project']]);
  assert.strictEqual(put.body.SchemaName, 'contoso_ProjectId', 'the rest of the definition is carried back unchanged');
  assert.deepStrictEqual(put.body.Targets, ['contoso_project']);
  assert.strictEqual(put.headers['MSCRM.MergeLabels'], 'true');
  assert.ok(!writes.some((w) => w.verb === 'POST' && /RelationshipDefinitions/.test(w.url)), 'the relationship itself is not recreated');
  // The label read the real client sent: ONE collection request for the child table's lookups, filtered by logical name.
  const labelReads = reads.filter((r) => /\/Attributes\?\$select=LogicalName,DisplayName&\$filter=/.test(r));
  assert.strictEqual(labelReads.length, 1, JSON.stringify(labelReads));
  assert.match(labelReads[0], /\/EntityDefinitions\(LogicalName='contoso_task'\)\/Attributes\?\$select=LogicalName,DisplayName&\$filter=LogicalName eq 'contoso_projectid'$/);
});

// ── 5. the plan budgets exactly the steps the phase emits ─────────────────────────────────────────

const { planFor } = require('../lib/sdk-build.js');

test('ADO 6691205 plan: one step per lookup the build labels, none for an explicit label — and the phase emits exactly those', async () => {
  // The runner's total is fixed from the plan, so a step the phase emits and the plan does not budget
  // overruns it ([37/36]); one the plan budgets and the phase never emits leaves it short.
  const spec = specOf([project(), task()], [
    oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' }),
    oneToMany('account', { schemaName: 'contoso_AccountId' }),
    oneToMany('contact', { schemaName: 'contoso_ContactId', displayName: 'Primary contact' }),
    { type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_task' },
  ]);
  const planned = planFor(spec, { phases: ['data-model'] }).filter((i) => /^lookup label /.test(i.label));
  assert.deepStrictEqual(planned.map((i) => i.label), [
    'lookup label contoso_task.contoso_ProjectId (default "Project")',
    'lookup label contoso_task.contoso_AccountId (default the display name of account)',
  ]);
  assert.ok(planned.every((i) => i.phase === 'data-model' && !i.key), 'unkeyed, so the live plan leaves them unprobed');
  const r = await rebuild(spec, rebuildEnv({ labels: [[1033, 'contoso_project']] }));
  assert.strictEqual(r.labelEvents.length, planned.length, JSON.stringify(r.labelEvents.map((e) => e.label)));
});

test('ADO 6691205 plan: a spec that labels every lookup itself plans no label step at all', () => {
  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId', displayName: 'Project' })]);
  assert.deepStrictEqual(planFor(spec, { phases: ['data-model'] }).filter((i) => /^lookup label /.test(i.label)), []);
});

test('ADO 6691205 plan: a declared `existing: true` parent with no displayName is planned as the environment\'s name, like an undeclared one', () => {
  const spec = specOf([task(), incident(), project()], [
    oneToMany('incident', { schemaName: 'contoso_CaseId' }),
    oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' }),
  ]);
  assert.deepStrictEqual(planFor(spec, { phases: ['data-model'] }).filter((i) => /^lookup label /.test(i.label)).map((i) => i.label), [
    'lookup label contoso_task.contoso_CaseId (default the display name of incident)',
    'lookup label contoso_task.contoso_ProjectId (default "Project")',
  ]);
});

test('ADO 6691205 plan: a declared parent with no displayName that the build may find already there says its label can come from the environment', () => {
  // Not flagged, so the build creates the table — unless it is already there, in which case the lookup takes the label
  // the environment holds. The plan cannot know which, so it says both rather than only the humanized name.
  const spec = specOf([project({ displayName: undefined }), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })]);
  assert.deepStrictEqual(planFor(spec, { phases: ['data-model'] }).filter((i) => /^lookup label /.test(i.label)).map((i) => i.label),
    ['lookup label contoso_task.contoso_ProjectId (default "Project", or the label from the environment if contoso_project is already there)']);
  // A parent that names itself, and one that is not declared, are planned as before.
  const named = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' }), oneToMany('account', { schemaName: 'contoso_AccountId' })]);
  assert.deepStrictEqual(planFor(named, { phases: ['data-model'] }).filter((i) => /^lookup label /.test(i.label)).map((i) => i.label), [
    'lookup label contoso_task.contoso_ProjectId (default "Project")',
    'lookup label contoso_task.contoso_AccountId (default the display name of account)',
  ]);
});

// ── 6. an existing FORM's lookup cell (REAL bundle) ───────────────────────────────────────────────

const { repairLookupCellLabels } = require('../lib/lookup-cell-labels.js');

// A real form carrying the lookup's cell, labelled `cellLabel`, beside an ordinary field cell.
async function formWithLookupCell(cellLabel, lookupField = 'contoso_projectid') {
  const real = await realSdk([]);
  const art = await real.sdk.createArtifact('form', { entityLogicalName: 'contoso_task', name: 'Task', formType: 'Main', status: 'Active' });
  await real.sdk.addElement('form', art.id, '/tabs', {
    name: 'tab_general', label: 'General', expanded: true, visible: true,
    columns: [{ width: '100%', sections: [{ name: 'section_general', label: 'General', visible: true, showLabel: false, columns: 1, rows: [
      { cells: [{ control: { fieldName: 'contoso_name', label: 'Name', isRequired: true } }] },
      { cells: [{ control: { fieldName: lookupField, label: cellLabel, isRequired: true } }] },
    ] }] }],
  });
  await real.sdk.removeElement('form', art.id, '/tabs/0');
  return { ...real, formId: art.id };
}

const lookupControl = async (sdk, formId) => {
  const form = await sdk.getArtifact('form', formId);
  const cells = form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections.flatMap((s) => s.rows.flatMap((r) => r.cells))));
  return cells.map((c) => c.control).find((c) => c && c.fieldName === 'contoso_projectid');
};

const repairArgs = (extra) => ({
  entityLogical: 'contoso_task',
  spec: omitted(),
  lookupLabels: { 'contoso_task|contoso_projectid': { label: 'Project' } },
  ...extra,
});

test('REAL BUNDLE (ADO 6691205 rebuild): a form field the SDK labelled with its OWN logical name — it could not resolve the column at push — is relabelled too', async () => {
  // The lookup's own lower-case logical name is the second old default (see the premise test below). It is what a
  // build that could not read the column's metadata left on the field; the column's label was never that.
  const { sdk, formId, writes } = await formWithLookupCell('contoso_projectid');
  const repaired = await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs() });
  assert.deepStrictEqual(repaired, ['contoso_projectid']);
  const after = await lookupControl(sdk, formId);
  assert.strictEqual(after.label, 'Project');
  assert.strictEqual(after.isRequired, true);
  await sdk.pushArtifact('form', formId);
  const xml = writes.map((w) => w.body && w.body.formxml).find(Boolean);
  assert.match(xml, /<label description="Project" languagecode="1033" \/>/);
  assert.doesNotMatch(xml, /description="contoso_projectid"/);
});

test('REAL BUNDLE (ADO 6691205 rebuild): the capitalised schema name a spec spells is not a label any build wrote, so a field carrying it is left alone', async () => {
  const { sdk, formId } = await formWithLookupCell('contoso_ProjectId');
  assert.deepStrictEqual(await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs() }), []);
  assert.strictEqual((await lookupControl(sdk, formId)).label, 'contoso_ProjectId');
});

test('REAL BUNDLE (ADO 6691205): the SDK labels a form field it cannot resolve a column for with the field\'s lower-case logical name', async () => {
  // Pins the premise of the second old default. With no label on the cell and no column metadata to take one from,
  // the bundle writes control.fieldName — `contoso_projectid`, not the `contoso_ProjectId` the spec spells.
  const { sdk, writes } = await realSdk([]);
  const art = await sdk.createArtifact('form', { name: 'Task', entityLogicalName: 'contoso_task', formType: 'Main', status: 'Active' });
  await sdk.addElement('form', art.id, '/tabs', {
    name: 'tab_general', label: 'General', expanded: true, visible: true,
    columns: [{ width: '100%', sections: [{ name: 'section_general', label: 'General', visible: true, showLabel: false, columns: 1, rows: [
      { cells: [{ control: { fieldName: 'contoso_projectid' } }] },
    ] }] }],
  });
  await sdk.removeElement('form', art.id, '/tabs/0');
  await sdk.pushArtifact('form', art.id);
  const xml = String(writes.map((w) => w.body && w.body.formxml).find(Boolean));
  const cell = xml.split('<cell').find((c) => /datafieldname="contoso_projectid"/.test(c));
  assert.ok(cell, 'the lookup cell is in the pushed form');
  assert.match(cell, /<label description="contoso_projectid" languagecode="1033" \/>/);
});

test('REAL BUNDLE (ADO 6691205 rebuild): a form cell still labelled with the old default is relabelled, and the rest of its control survives', async () => {
  const { sdk, formId, writes } = await formWithLookupCell('contoso_project');
  const before = await lookupControl(sdk, formId);
  const repaired = await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs() });
  assert.deepStrictEqual(repaired, ['contoso_projectid']);
  const after = await lookupControl(sdk, formId);
  assert.strictEqual(after.label, 'Project');
  assert.strictEqual(after.isRequired, true, 'updateElement merged the patch instead of replacing the control');
  assert.strictEqual(after.id, before.id);
  assert.strictEqual(after.classId, before.classId);
  // ...and it is what the SDK would push.
  await sdk.pushArtifact('form', formId);
  const xml = writes.map((w) => w.body && w.body.formxml).find(Boolean);
  assert.match(xml, /<label description="Project" languagecode="1033" \/>/);
  assert.doesNotMatch(xml, /description="contoso_project"/);
});

test('REAL BUNDLE (ADO 6691205 rebuild): a form cell a maker relabelled is left alone', async () => {
  const { sdk, formId } = await formWithLookupCell('Parent project');
  assert.deepStrictEqual(await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs() }), []);
  assert.strictEqual((await lookupControl(sdk, formId)).label, 'Parent project');
});

test('REAL BUNDLE (ADO 6691205 rebuild): a cell is aligned to the label the COLUMN carries now, even a maker\'s', async () => {
  const { sdk, formId } = await formWithLookupCell('contoso_project');
  await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs({ lookupLabels: { 'contoso_task|contoso_projectid': { label: 'Parent project' } } }) });
  assert.strictEqual((await lookupControl(sdk, formId)).label, 'Parent project');
});

test('REAL BUNDLE (ADO 6691205 rebuild): with no record of the column\'s label the cell is left as it is', async () => {
  const { sdk, formId } = await formWithLookupCell('contoso_project');
  assert.deepStrictEqual(await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs({ lookupLabels: {} }) }), []);
  assert.deepStrictEqual(await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs({ lookupLabels: undefined }) }), []);
  assert.strictEqual((await lookupControl(sdk, formId)).label, 'contoso_project');
});

test('REAL BUNDLE (ADO 6691205 rebuild): an explicit lookup.displayName in the spec is never reapplied to a cell', async () => {
  const { sdk, formId } = await formWithLookupCell('contoso_project');
  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId', displayName: 'Owning project' })]);
  assert.deepStrictEqual(await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs({ spec }) }), []);
  assert.strictEqual((await lookupControl(sdk, formId)).label, 'contoso_project');
});

test('REAL BUNDLE (ADO 6691205 rebuild): a form that does not carry the lookup\'s cell is untouched', async () => {
  const { sdk, formId } = await formWithLookupCell('contoso_project', 'contoso_ownerid');
  const repaired = await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs() });
  assert.deepStrictEqual(repaired, []);
  const form = await sdk.getArtifact('form', formId);
  const labels = form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections.flatMap((s) => s.rows.flatMap((r) => r.cells.map((cell) => cell.control.label)))));
  assert.deepStrictEqual(labels, ['Name', 'contoso_project']);
});

// A real form carrying the lookup's field TWICE, as a maker can place it: once in the first section and once in a
// second one, each cell with a label of its own.
async function formWithLookupCellTwice(firstLabel, secondLabel) {
  const real = await realSdk([]);
  const art = await real.sdk.createArtifact('form', { entityLogicalName: 'contoso_task', name: 'Task', formType: 'Main', status: 'Active' });
  await real.sdk.addElement('form', art.id, '/tabs', {
    name: 'tab_general', label: 'General', expanded: true, visible: true,
    columns: [{ width: '100%', sections: [
      { name: 'section_general', label: 'General', visible: true, showLabel: false, columns: 1, rows: [
        { cells: [{ control: { fieldName: 'contoso_name', label: 'Name', isRequired: true } }] },
        { cells: [{ control: { fieldName: 'contoso_projectid', label: firstLabel, isRequired: true } }] },
      ] },
      { name: 'section_more', label: 'More', visible: true, showLabel: false, columns: 1, rows: [
        { cells: [{ control: { fieldName: 'contoso_projectid', label: secondLabel } }] },
      ] },
    ] }],
  });
  await real.sdk.removeElement('form', art.id, '/tabs/0');
  return { ...real, formId: art.id };
}

const lookupControls = async (sdk, formId) => {
  const form = await sdk.getArtifact('form', formId);
  const cells = form.tabs.flatMap((t) => t.columns.flatMap((c) => c.sections.flatMap((s) => s.rows.flatMap((r) => r.cells))));
  return cells.map((c) => c.control).filter((c) => c && c.fieldName === 'contoso_projectid');
};

// The labels of the lookup's cells in what the SDK would push, in form order.
const pushedLookupLabels = async (sdk, formId, writes) => {
  await sdk.pushArtifact('form', formId);
  const xml = String(writes.map((w) => w.body && w.body.formxml).filter(Boolean).pop());
  return xml.split('<cell').filter((c) => /datafieldname="contoso_projectid"/.test(c)).map((c) => (/<label description="([^"]*)"/.exec(c) || [])[1]);
};

test('REAL BUNDLE (ADO 6691205 rebuild): a lookup the form holds twice has its SECOND cell relabelled when the first is already right', async () => {
  const { sdk, formId, writes } = await formWithLookupCellTwice('Project', 'contoso_project');
  assert.strictEqual((await lookupControls(sdk, formId)).length, 2, 'the bundle keeps both cells of the field');
  const before = await lookupControls(sdk, formId);
  assert.deepStrictEqual(await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs() }), ['contoso_projectid'], 'the lookup is named once');
  const after = await lookupControls(sdk, formId);
  assert.deepStrictEqual(after.map((c) => c.label), ['Project', 'Project']);
  assert.deepStrictEqual(after.map((c) => c.id), before.map((c) => c.id), 'each cell keeps its control');
  assert.deepStrictEqual(await pushedLookupLabels(sdk, formId, writes), ['Project', 'Project']);
});

test('REAL BUNDLE (ADO 6691205 rebuild): a lookup the form holds twice keeps a maker\'s label on one cell and has the old default on the other relabelled', async () => {
  const { sdk, formId, writes } = await formWithLookupCellTwice('Parent project', 'contoso_project');
  assert.deepStrictEqual(await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs() }), ['contoso_projectid']);
  assert.deepStrictEqual((await lookupControls(sdk, formId)).map((c) => c.label), ['Parent project', 'Project']);
  assert.deepStrictEqual(await pushedLookupLabels(sdk, formId, writes), ['Parent project', 'Project']);
});

test('REAL BUNDLE (ADO 6691205 rebuild): both cells of a lookup the form holds twice, each with an old default, are relabelled', async () => {
  const { sdk, formId } = await formWithLookupCellTwice('contoso_project', 'contoso_projectid');
  assert.deepStrictEqual(await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs() }), ['contoso_projectid']);
  const after = await lookupControls(sdk, formId);
  assert.deepStrictEqual(after.map((c) => c.label), ['Project', 'Project']);
  assert.deepStrictEqual(after.map((c) => c.isRequired), [true, undefined], 'each cell keeps the rest of its own control');
});

test('REAL BUNDLE (ADO 6691205 rebuild): a lookup the form holds twice with no old default on either cell is untouched', async () => {
  const { sdk, formId } = await formWithLookupCellTwice('Project', 'Parent project');
  assert.deepStrictEqual(await repairLookupCellLabels({ provision: sdk, formId, ...repairArgs() }), []);
  assert.deepStrictEqual((await lookupControls(sdk, formId)).map((c) => c.label), ['Project', 'Parent project']);
});

// ── 7. the whole engine: data-model repair, then the existing form ────────────────────────────────

const { runSdkBuild } = require('../lib/sdk-build.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');

// An existing app whose `contoso_task` form carries the lookup's cell, labelled `cellLabel`, rebuilt by the whole
// engine against a column the environment labels `columnLabel`.
async function engineRebuild({ columnLabel, cellLabel }) {
  // Wiring: reconcileLookupLabels is switched on by the app build, and the forms phase reads what the
  // data-model phase recorded (`dataModel.lookupLabels`) — neither is visible to a unit test of one half.
  const { sdk, calls } = makeSimpleMockSdk();
  sdk.queryRecords = async (set) => (set === 'solution' ? [] : set === 'systemform' ? [{ formid: 'form-1' }] : set === 'organization' ? [{ languagecode: 1033 }] : [{ publisherid: 'pub-1' }]);
  sdk.dataverse = rebuildEnv({ labels: [[1033, columnLabel]] });
  sdk.updateColumn = async (...args) => { calls.push(['updateColumn', ...args]); };
  // The simple mock REPLACES on updateElement; the real SDK merges an object patch, which the repair relies on.
  sdk.updateElement = async (type, id, pointer, patch) => {
    const art = await sdk.getArtifact(type, id);
    const tokens = pointer.split('/').slice(1);
    const last = tokens.pop();
    const holder = tokens.reduce((cur, token) => cur[token], art);
    const merge = holder[last] && typeof holder[last] === 'object' && patch && typeof patch === 'object' && !Array.isArray(patch);
    holder[last] = merge ? { ...holder[last], ...patch } : JSON.parse(JSON.stringify(patch));
    return art;
  };
  await sdk.fetchArtifact('form', 'form-1');
  await sdk.addElement('form', 'form-1', '/tabs/0/columns/0/sections/0/rows', { cells: [{ control: { fieldName: 'contoso_name', label: 'Name' } }] });
  await sdk.addElement('form', 'form-1', '/tabs/0/columns/0/sections/0/rows', { cells: [{ control: { fieldName: 'contoso_projectid', label: cellLabel, isRequired: true } }] });

  const spec = specOf([project(), task()], [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })], {
    app: { name: 'Tasks' },
    forms: [{ entity: 'contoso_task', name: 'Task', layout: 'auto' }],
  });
  const events = [];
  await runSdkBuild(spec, { sdk, apply: true, emit: (e) => events.push(e), phases: ['solution', 'data-model', 'forms'], preResolvedLanguageCode: 1033 });
  const cell = (await sdk.getArtifact('form', 'form-1')).tabs[0].columns[0].sections[0].rows.map((r) => r.cells[0].control).find((c) => c.fieldName === 'contoso_projectid');
  return { updates: calls.filter((c) => c[0] === 'updateColumn').map((c) => c.slice(1)), cell, events };
}

test('ADO 6691205 rebuild: the engine relabels the column in the data-model phase and then the cell on the existing form', async () => {
  const { updates, cell, events } = await engineRebuild({ columnLabel: 'contoso_project', cellLabel: 'contoso_project' });
  assert.deepStrictEqual(updates, [['contoso_task', 'contoso_projectid', { displayName: 'Project', languageCode: 1033 }]]);
  assert.strictEqual(cell.label, 'Project', 'the cell follows the column');
  assert.strictEqual(cell.isRequired, true);
  const terminal = events.filter((e) => e.status !== 'start');
  assert.ok(terminal.every((e) => e.n <= e.total), `a step overran the plan: ${JSON.stringify(terminal.filter((e) => e.n > e.total))}`);
});

test('ADO 6691205 rebuild: a label a maker set on the column survives the engine, and a cell still holding the old default follows it', async () => {
  // Measured on a live environment: a lookup relabelled "Owning Project" through the SDK kept that label across
  // the rebuild, and the form cell that still held the old default then showed "Owning Project", not the
  // build's own default and not the identifier.
  const { updates, cell } = await engineRebuild({ columnLabel: 'Owning Project', cellLabel: 'contoso_project' });
  assert.deepStrictEqual(updates, [], 'the maker\'s label is not overwritten');
  assert.strictEqual(cell.label, 'Owning Project', 'the cell follows the column\'s current label');
  assert.strictEqual(cell.isRequired, true, 'and nothing else about it changes');
});

test('ADO 6691205 rebuild: a cell a maker relabelled differently from its column is left alone', async () => {
  const { cell } = await engineRebuild({ columnLabel: 'Owning Project', cellLabel: 'Parent' });
  assert.strictEqual(cell.label, 'Parent');
});

// ── 8. every surface that SHOWS a lookup label goes through the same rule ─────────────────────────

const { schemaFacts } = require('../lib/schema-facts.js');
const { renderFormWireframe } = require('../lib/form-preview.js');
const { renderAppPreview } = require('../lib/app-preview.js');
const { renderAppSpecDoc } = require('../lib/app-spec-doc.js');

const shown = () => specOf([project(), task()], [
  oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' }),
  oneToMany('account', { schemaName: 'contoso_AccountId' }),
  oneToMany('contact', { schemaName: 'contoso_ContactId', displayName: 'Primary contact' }),
]);

test('ADO 6691205 surfaces: the eval data facts carry the label the build will write', () => {
  const facts = schemaFacts(shown()).relationships.map((r) => [r.lookup.logicalName, r.lookup.displayName]);
  assert.deepStrictEqual(facts, [['contoso_accountid', 'Account'], ['contoso_contactid', 'Primary contact'], ['contoso_projectid', 'Project']]);
});

test('ADO 6691205 surfaces: a form wireframe labels a lookup field with its label, not its logical name', () => {
  const spec = shown();
  spec.forms = [{ entity: 'contoso_task', name: 'Task', formType: 'Main', tabs: [{ label: 'General', sections: [{ label: 'Details', fields: ['contoso_name', 'contoso_projectid', 'contoso_contactid'] }] }] }];
  const wire = renderFormWireframe(spec, spec.forms[0]);
  assert.match(wire, /Project\b.*\[lookup\]/);
  assert.match(wire, /Primary contact\b.*\[lookup\]/);
  assert.doesNotMatch(wire, /contoso_projectid|contoso_contactid/);
});

test('ADO 6691205 surfaces: the auto-layout wireframe shows the lookup it will place, by label', () => {
  const spec = shown();
  spec.forms = [{ entity: 'contoso_task', name: 'Task', formType: 'Main', layout: 'auto' }];
  const wire = renderFormWireframe(spec, spec.forms[0]);
  assert.match(wire, /Project\b.*\[lookup\]/);
  assert.doesNotMatch(wire, /contoso_projectid/);
});

test('ADO 6691205 surfaces: the app preview names each lookup\'s label', () => {
  const out = renderAppPreview(shown());
  assert.match(out, /1:N {2}contoso_project {2}→ {2}contoso_task {2}\(lookup contoso_ProjectId — "Project"\)/);
  assert.match(out, /\(lookup contoso_ContactId — "Primary contact"\)/);
});

test('ADO 6691205 surfaces: the design document lists the label beside the lookup', () => {
  const doc = renderAppSpecDoc(shown());
  assert.match(doc, /\| Kind \| From \| To \| Lookup \| Label \|/);
  assert.match(doc, /\| 1:N \| contoso_project \| contoso_task \| contoso_ProjectId \| Project \|/);
  assert.match(doc, /\| 1:N \| contact \| contoso_task \| contoso_ContactId \| Primary contact \|/);
});

test('ADO 6691205 surfaces: a localized default is shown in the spec\'s language', () => {
  const spec = specOf([project({ displayName: { 1033: 'Project', 3082: 'Proyecto' }, pluralName: { 1033: 'Projects', 3082: 'Proyectos' } }), task()],
    [oneToMany('contoso_project', { schemaName: 'contoso_ProjectId' })], { languageCode: 3082 });
  assert.strictEqual(schemaFacts(spec).relationships[0].lookup.displayName, 'Proyecto');
  assert.match(renderAppPreview(spec), /\(lookup contoso_ProjectId — "Proyecto"\)/);
  assert.doesNotMatch(renderAppSpecDoc(spec), /\[object Object\]/);
});


