'use strict';
// #559 — the live dry-run plan. `runSdkBuild` used to print planFor's static, spec-derived listing
// and exit before any discovery, so the SAME plan appeared for a spec whose artifacts all exist and
// for one that would create everything from nothing.
//
// These drive `annotateLivePlan` directly with a purpose-built reader so each artifact kind and each
// failure mode is exercised on its own. The end-to-end behaviour (states reaching the CLI result) is
// covered in sdk-build.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { annotateLivePlan, planFor } = require(path.join(__dirname, '..', 'lib', 'sdk-build.js'));
const { relationshipSchemaName, manyToManySchemaName } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

// A minimal provision double. `tables` maps logical -> { columns: [], relationships: [] }; `rows`
// maps an entity set to the rows a query should return. Records every read so the tests can assert
// on CACHING as well as on outcomes.
function reader({ tables = {}, rows = {}, failMetadata = false, failQuery = false } = {}) {
  const reads = [];
  const provision = {
    dataverse: {
      get: async (url) => {
        reads.push(url);
        if (failMetadata) throw new Error('metadata service unavailable');
        // Relationship collections: /EntityDefinitions(LogicalName='x')/OneToManyRelationships?$select=SchemaName
        const rel = /EntityDefinitions\(LogicalName='([^']+)'\)\/(OneToMany|ManyToMany)Relationships/.exec(url);
        if (rel) {
          const t = tables[rel[1]];
          if (!t) return { status: 404, body: {} };
          return { status: 200, body: { value: (t.relationships || []).map((s) => ({ SchemaName: s })) } };
        }
        // /EntityDefinitions(LogicalName='x')?$select=... and .../Attributes?$select=...
        const m = /EntityDefinitions\(LogicalName='([^']+)'\)(\/Attributes)?/.exec(url);
        const logical = m && m[1];
        const t = tables[logical];
        if (!t) return { status: 404, body: {} };
        if (m[2]) {
          return { status: 200, body: { value: (t.columns || []).map((c) => ({ LogicalName: c, RequiredLevel: { Value: 'None' } })) } };
        }
        return { status: 200, body: { LogicalName: logical, EntitySetName: `${logical}s` } };
      },
    },
    queryRecords: async (set, o) => {
      reads.push(`${set}:${(o && o.filter) || ''}`);
      if (failQuery) throw new Error('query refused');
      return rows[set] || [];
    },
    fetchEntityMetadata: async (logical) => {
      reads.push(`fetchEntityMetadata:${logical}`);
      const t = tables[logical];
      if (!t) throw new Error('not found');
      return { logicalName: logical, entitySetName: `${logical}s`, attributes: (t.columns || []).map((c) => ({ logicalName: c })), relationships: (t.relationships || []).map((s) => ({ schemaName: s, type: 'OneToMany' })) };
    },
    findTables: async (q) => {
      reads.push(`findTables:${q}`);
      const logical = String(q).toLowerCase();
      return tables[logical] ? [{ logicalName: logical, entitySetName: `${logical}s` }] : [];
    },
  };
  return { provision, reads };
}

const stateOf = (plan, frag) => (plan.find((p) => p.label.includes(frag)) || {}).state;

test('#559 a table reads reuse when present and create when absent', async () => {
  const plan = [
    { phase: 'data-model', label: 'table new_here', key: { kind: 'table', entity: 'new_here' } },
    { phase: 'data-model', label: 'table new_gone', key: { kind: 'table', entity: 'new_gone' } },
  ];
  const { provision } = reader({ tables: { new_here: { columns: [] } } });
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(stateOf(plan, 'new_here'), 'reuse');
  assert.strictEqual(stateOf(plan, 'new_gone'), 'create');
});

test('#559 a column on a MISSING table is create without reading its attributes', async () => {
  const plan = [
    { phase: 'data-model', label: 'table new_gone', key: { kind: 'table', entity: 'new_gone' } },
    { phase: 'data-model', label: 'column new_gone.new_x', key: { kind: 'column', entity: 'new_gone', name: 'new_x' } },
  ];
  const { provision, reads } = reader({ tables: {} });
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(stateOf(plan, 'column new_gone.new_x'), 'create');
  assert.ok(!reads.some((r) => /\/Attributes/.test(r)),
    'asking for the attributes of a table that does not exist only produces a metadata-cache error');
});

test('#559 columns on an existing table resolve individually', async () => {
  const plan = [
    { phase: 'data-model', label: 'column new_t.new_a', key: { kind: 'column', entity: 'new_t', name: 'new_a' } },
    { phase: 'data-model', label: 'column new_t.new_b', key: { kind: 'column', entity: 'new_t', name: 'new_b' } },
  ];
  const { provision } = reader({ tables: { new_t: { columns: ['new_a'] } } });
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(stateOf(plan, 'new_t.new_a'), 'reuse');
  assert.strictEqual(stateOf(plan, 'new_t.new_b'), 'create');
});

// A plan routinely carries dozens of columns per table. Re-reading the table's metadata per column
// would turn a dry run into a slow, rate-limit-prone crawl.
test('#559 table and attribute metadata are read ONCE per entity however many columns are planned', async () => {
  const plan = [{ phase: 'data-model', label: 'table new_t', key: { kind: 'table', entity: 'new_t' } }];
  for (let i = 0; i < 12; i++) plan.push({ phase: 'data-model', label: `column new_t.c${i}`, key: { kind: 'column', entity: 'new_t', name: `c${i}` } });
  const { provision, reads } = reader({ tables: { new_t: { columns: ['c0'] } } });
  await annotateLivePlan(plan, { spec: {}, provision });
  const defs = reads.filter((r) => /EntityDefinitions\(LogicalName='new_t'\)\?/.test(r)).length;
  const attrs = reads.filter((r) => /\/Attributes/.test(r)).length;
  assert.strictEqual(defs, 1, `table metadata read ${defs} times`);
  assert.strictEqual(attrs, 1, `attribute metadata read ${attrs} times`);
});

test('#559 a relationship resolves from the entity metadata', async () => {
  const plan = [
    { phase: 'data-model', label: 'relationship 1:N a->b', key: { kind: 'relationship', entity: 'new_child', name: 'new_a_b', relType: 'OneToMany' } },
    { phase: 'data-model', label: 'relationship 1:N a->c', key: { kind: 'relationship', entity: 'new_child', name: 'new_missing', relType: 'OneToMany' } },
  ];
  const { provision } = reader({ tables: { new_child: { columns: [], relationships: ['new_a_b'] } } });
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(stateOf(plan, 'a->b'), 'reuse');
  assert.strictEqual(stateOf(plan, 'a->c'), 'create');
});

test('#559 views, charts and forms resolve through the identity query the BUILD uses', async () => {
  const plan = [
    { phase: 'views', label: 'view "Open" for new_t', key: { kind: 'view', entity: 'new_t', name: 'Open' } },
    { phase: 'charts', label: 'chart "By Status" for new_t', key: { kind: 'chart', entity: 'new_t', name: 'By Status' } },
    { phase: 'forms', label: 'form for new_t', key: { kind: 'form', entity: 'new_t', name: 'Main', formType: 'Main' } },
  ];
  const { provision, reads } = reader({
    tables: { new_t: { columns: [] } },
    rows: { savedquery: [{ savedqueryid: 'v1' }], savedqueryvisualization: [], systemform: [{ formid: 'f1' }] },
  });
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(stateOf(plan, 'view "Open"'), 'reuse');
  assert.strictEqual(stateOf(plan, 'chart "By Status"'), 'create');
  assert.strictEqual(stateOf(plan, 'form for new_t'), 'reuse');
  // The form query must scope by TYPE, or a same-named Quick View would answer for the Main form.
  assert.ok(reads.some((r) => /^systemform:.*type eq 2/.test(r)), JSON.stringify(reads));
});

test('#559 a view/form/chart on a table that does not exist is create, with no artifact query', async () => {
  const plan = [{ phase: 'views', label: 'view "Open" for new_gone', key: { kind: 'view', entity: 'new_gone', name: 'Open' } }];
  const { provision, reads } = reader({ tables: {} });
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(stateOf(plan, 'view "Open"'), 'create');
  assert.ok(!reads.some((r) => r.startsWith('savedquery:')), 'the filter would 400 on the metadata cache');
});

test('#559 the app module resolves by its deterministic unique name', async () => {
  const present = [{ phase: 'app-shell', label: 'app module "X" + sitemap', key: { kind: 'app', uniqueName: 'new_x' } }];
  const absent = [{ phase: 'app-shell', label: 'app module "Y" + sitemap', key: { kind: 'app', uniqueName: 'new_y' } }];
  await annotateLivePlan(present, { spec: {}, provision: reader({ rows: { appmodule: [{ appmoduleid: 'a1' }] } }).provision });
  await annotateLivePlan(absent, { spec: {}, provision: reader({ rows: {} }).provision });
  assert.strictEqual(present[0].state, 'reuse');
  assert.strictEqual(absent[0].state, 'create');
});

// The three-state contract. Collapsing a failed read into either decision presents a guess as a
// fact: "create" overstates the work, "reuse" understates it.
test('#559 a read that fails on BOTH paths is unknown and carries the reason', async () => {
  const plan = [{ phase: 'data-model', label: 'table new_t', key: { kind: 'table', entity: 'new_t' } }];
  const { provision } = reader({ failMetadata: true });
  // findExistingTable falls back to findTables when the narrow metadata read is inconclusive, so a
  // genuine "cannot read" has to fail that too — otherwise the fallback legitimately answers.
  provision.findTables = async () => { throw new Error('metadata service unavailable'); };
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(plan[0].state, 'unknown');
  assert.match(plan[0].stateWhy, /metadata service unavailable/);
});

// Documents the fallback rather than treating it as a failure: an inconclusive NARROW read followed
// by a conclusive findTables is a real answer, and reporting it as `unknown` would be needlessly
// pessimistic on an environment that answered the question.
test('#559 an inconclusive narrow read still resolves when findTables answers', async () => {
  const plan = [
    { phase: 'data-model', label: 'table new_here', key: { kind: 'table', entity: 'new_here' } },
    { phase: 'data-model', label: 'table new_gone', key: { kind: 'table', entity: 'new_gone' } },
  ];
  const { provision } = reader({ tables: { new_here: { columns: [] } }, failMetadata: true });
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(stateOf(plan, 'new_here'), 'reuse', 'findTables found it');
  assert.strictEqual(stateOf(plan, 'new_gone'), 'create', 'findTables conclusively did not');
});

test('#559 a failed artifact query is unknown, not a silent create', async () => {
  const plan = [{ phase: 'views', label: 'view "Open" for new_t', key: { kind: 'view', entity: 'new_t', name: 'Open' } }];
  const { provision } = reader({ tables: { new_t: { columns: [] } }, failQuery: true });
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(plan[0].state, 'unknown');
  assert.match(plan[0].stateWhy, /query refused/);
});

test('#559 an item with no key is left unprobed rather than guessed', async () => {
  const plan = [{ phase: 'publish', label: 'publish customizations' }];
  const { provision, reads } = reader({});
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(plan[0].state, undefined, 'no state at all — the plan line still prints');
  assert.deepStrictEqual(reads, [], 'and nothing is read for it');
});

// Review finding. `findExistingColumns` is written for the APPLY path, where a failed read safely
// means "assume every column is new" (the create absorbs duplicates). A dry run has nothing to
// absorb anything, so the same `[]` would print `+ create` for columns that exist.
test('#559 a failed ATTRIBUTE read is unknown, not "every column is new"', async () => {
  const plan = [{ phase: 'data-model', label: 'column new_t.new_a', key: { kind: 'column', entity: 'new_t', name: 'new_a' } }];
  const { provision } = reader({ tables: { new_t: { columns: ['new_a'] } } });
  const realGet = provision.dataverse.get;
  provision.dataverse.get = async (url) => (/\/Attributes/.test(url) ? { status: 503, body: {} } : realGet(url));
  provision.findColumns = undefined;
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(plan[0].state, 'unknown');
  assert.match(plan[0].stateWhy, /attributes could not be read/);
});

// Review finding. `relationshipExists` returns null when inconclusive. The apply path treats that as
// absent because its create absorbs the race; a plan must say it does not know.
test('#559 an inconclusive RELATIONSHIP probe is unknown, not create', async () => {
  const plan = [{ phase: 'data-model', label: 'relationship 1:N a->b', key: { kind: 'relationship', entity: 'new_p', name: 'new_a_b', relType: 'OneToMany' } }];
  const { provision } = reader({ tables: { new_p: { columns: [], relationships: [] } } });
  provision.dataverse.get = async () => ({ status: 503, body: {} });
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(plan[0].state, 'unknown');
});

// Review finding. The BROAD `fetchEntityMetadata` fallback inside relationshipExists writes the
// fetched metadata into the on-disk workspace, which a read-only dry run must not do — it would
// change cached state a later apply reads.
test('#559 the relationship probe never takes the workspace-writing fetchEntityMetadata fallback', async () => {
  const plan = [{ phase: 'data-model', label: 'relationship 1:N a->b', key: { kind: 'relationship', entity: 'new_p', name: 'new_a_b', relType: 'OneToMany' } }];
  const { provision, reads } = reader({ tables: { new_p: { columns: [], relationships: ['new_a_b'] } } });
  provision.dataverse.get = async () => ({ status: 503, body: {} }); // force the inconclusive path
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.ok(!reads.some((r) => r.startsWith('fetchEntityMetadata:')), JSON.stringify(reads));
});

// Review finding. A pinned `formId` that is stale/foreign makes the APPLY halt. Reporting that as a
// confident create or reuse hides it; `resolveExistingFormId` raises, and the reason is actionable.
test('#559 a stale pinned formId surfaces as unknown with the resolver\'s own message', async () => {
  const plan = [{ phase: 'forms', label: 'form for new_t', key: { kind: 'form', entity: 'new_t', name: 'Main', formType: 'Main', formId: '11111111-1111-1111-1111-111111111111' } }];
  const { provision } = reader({ tables: { new_t: { columns: [] } }, rows: { systemform: [] } });
  await annotateLivePlan(plan, { spec: {}, provision });
  assert.strictEqual(plan[0].state, 'unknown');
  assert.match(plan[0].stateWhy, /does not exist on this environment/);
});

// planFor must attach the keys the annotator joins on. A key silently dropped from a plan line turns
// that line permanently unprobed — which looks exactly like the bug #559 fixed.
// Review finding, HIGH. The probe identity must match the one the APPLY path uses, or an existing
// relationship is confidently reported as `create`. `provisionDataModel` queries the REFERENCED
// (parent) entity's OneToManyRelationships — the child's collection does not contain it — and builds
// the schema name WITH the publisher prefix. Both were wrong here, and both are invisible for a
// SELF-referencing relationship (referenced === referencing), which is the shape this was first
// tested on: the live run that "verified" it could not have caught either.
test('#559 the relationship key matches the identity the apply path probes', () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'zzz' },
    app: { name: 'A' },
    entities: [
      { schemaName: 'zzz_parent', displayName: 'P', pluralName: 'Ps', primaryAttribute: { schemaName: 'zzz_name', displayName: 'N' }, columns: [] },
      { schemaName: 'zzz_child', displayName: 'C', pluralName: 'Cs', primaryAttribute: { schemaName: 'zzz_name', displayName: 'N' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'zzz_parent', referencing: 'zzz_child', lookup: { schemaName: 'zzz_ParentId', displayName: 'P' } },
      { type: 'ManyToMany', entity1: 'zzz_parent', entity2: 'zzz_child' },
    ],
  };
  const plan = planFor(spec, { sampleData: false, publish: false, phases: undefined });
  const oneToMany = plan.find((p) => p.label.includes('relationship 1:N')).key;
  const manyToMany = plan.find((p) => p.label.includes('relationship N:N')).key;

  assert.strictEqual(oneToMany.entity, 'zzz_parent',
    'the 1:N probe targets the REFERENCED entity — the child holds no OneToManyRelationships entry');
  assert.strictEqual(manyToMany.entity, 'zzz_parent', 'N:N probes entity1, as the apply path does');
  // The schema names must be the prefixed ones the apply path builds, or the probe looks for a name
  // Dataverse never created.
  assert.strictEqual(oneToMany.name, relationshipSchemaName(spec.relationships[0], 'zzz'));
  assert.strictEqual(manyToMany.name, manyToManySchemaName(spec.relationships[1], 'zzz'));
});

test('#559 planFor attaches keys to the probeable artifact classes', () => {
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'App' },
    entities: [{ schemaName: 'new_t', displayName: 'T', pluralName: 'Ts', primaryAttribute: { schemaName: 'new_name', displayName: 'N' }, columns: [{ schemaName: 'new_c', displayName: 'C', type: 'Text' }] }],
    relationships: [],
    views: [{ entity: 'new_t', name: 'Open', columns: ['new_name'] }],
    charts: [{ entity: 'new_t', name: 'By', chartType: 'Column', groupBy: 'new_c', aggregate: 'count' }],
    forms: [{ entity: 'new_t', formType: 'Main' }],
  };
  const plan = planFor(spec, { sampleData: false, publish: false, phases: undefined });
  const kindOf = (frag) => (plan.find((p) => p.label.includes(frag)) || {}).key;
  assert.strictEqual(kindOf('table new_t').kind, 'table');
  assert.strictEqual(kindOf('column new_t.new_c').kind, 'column');
  assert.strictEqual(kindOf('view "Open"').kind, 'view');
  assert.strictEqual(kindOf('chart "By"').kind, 'chart');
  assert.strictEqual(kindOf('form for new_t').kind, 'form');
  assert.strictEqual(kindOf('app module').kind, 'app');
});
