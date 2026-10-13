'use strict';
// Relationship reconstruction on download (#567). The shapes asserted here were LIVE-MEASURED
// against a Dataverse organization; see the comment on `readRelationships` for the raw payloads.
const { test } = require('node:test');
const assert = require('node:assert');
const { readRelationships, relationshipsSkippedWarning } = require('../download-model-app.js');

const label = (s) => ({ LocalizedLabels: [{ Label: s, LanguageCode: 1033 }] });

// Routes the four metadata reads `readRelationships` performs. Anything not supplied answers with
// an empty collection, so a test only declares the reads it cares about.
function makeSdk({ m2o = {}, m2m = {}, lookups = {}, custom = {}, fail = {} } = {}) {
  const ofEntity = (p) => (p.match(/LogicalName='([^']+)'/) || [])[1];
  return {
    dataverse: {
      get: async (p) => {
        const e = ofEntity(p);
        if (fail[e] && (!fail.only || p.includes(fail.only))) throw new Error(fail[e]);
        if (/\/ManyToOneRelationships/.test(p)) return { status: 200, body: { value: m2o[e] || [] } };
        if (/\/ManyToManyRelationships/.test(p)) return { status: 200, body: { value: m2m[e] || [] } };
        if (/LookupAttributeMetadata/.test(p)) return { status: 200, body: { value: lookups[e] || [] } };
        if (/\?\$select=IsCustomEntity/.test(p)) return { status: 200, body: { IsCustomEntity: custom[e] !== false } };
        return { status: 404, body: null };
      },
    },
  };
}

const rel = (o) => ({ IsCustomRelationship: true, ...o });

test('reconstructs a 1:N between two app tables with the properly-cased lookup name (#567)', async () => {
  const sdk = makeSdk({
    m2o: { new_ticket: [rel({ SchemaName: 'new_customer_new_ticket', ReferencedEntity: 'new_customer', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_customerid' })] },
    lookups: { new_ticket: [{ LogicalName: 'new_customerid', SchemaName: 'new_CustomerId', DisplayName: label('Customer'), Targets: ['new_customer'] }] },
  });
  const { relationships, skipped } = await readRelationships(sdk, ['new_customer', 'new_ticket'], 'new');
  assert.deepStrictEqual(skipped, []);
  assert.deepStrictEqual(relationships, [{
    type: 'OneToMany',
    referenced: 'new_customer',
    referencing: 'new_ticket',
    // Cased as deployed — the SDK's own projection lowercases this to `new_customerid`.
    lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' },
    // Ownership is unprovable from a download, so teardown must retain it like the tables (#587 item 6).
    existing: true,
  }]);
});

test('drops platform relationships rather than declaring them as app relationships (#567)', async () => {
  // LIVE-MEASURED: a 3-table app carried 20 of 22 entries per table as platform plumbing.
  const sdk = makeSdk({
    m2o: {
      new_ticket: [
        { IsCustomRelationship: false, SchemaName: 'new_ticket_SyncErrors', ReferencedEntity: 'syncerror', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'regardingobjectid' },
        { IsCustomRelationship: false, SchemaName: 'new_ticket_AsyncOperations', ReferencedEntity: 'asyncoperation', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'regardingobjectid' },
      ],
    },
  });
  const { relationships, skipped } = await readRelationships(sdk, ['new_ticket'], 'new');
  assert.deepStrictEqual(relationships, []);
  assert.deepStrictEqual(skipped, []); // not app relationships at all, so nothing to report as lost
});

test('skips AND reports a polymorphic lookup, which relationships[] cannot express (#567)', async () => {
  // LIVE-MEASURED: `cfo_billto` targeting account+contact produced TWO relationships sharing ONE
  // ReferencingAttribute. Emitting both would declare the same lookup schema name twice.
  const sdk = makeSdk({
    m2o: {
      new_ticket: [
        rel({ SchemaName: 'new_new_ticket_account', ReferencedEntity: 'account', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_billto' }),
        rel({ SchemaName: 'new_new_ticket_contact', ReferencedEntity: 'contact', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_billto' }),
      ],
    },
  });
  const { relationships, skipped } = await readRelationships(sdk, ['new_ticket'], 'new');
  assert.deepStrictEqual(relationships, []);
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, /polymorphic/i);
  assert.match(skipped[0].reason, /account, contact/);
});

test('keeps a bridge to a standard table but drops a custom parent outside the app (#567)', async () => {
  const sdk = makeSdk({
    m2o: {
      new_ticket: [
        rel({ SchemaName: 'new_systemuser_new_ticket', ReferencedEntity: 'systemuser', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_agentid' }),
        rel({ SchemaName: 'new_other_new_ticket', ReferencedEntity: 'new_other', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_otherid' }),
      ],
    },
    // A rebuild target always has systemuser; it would NOT have a custom table this app excludes.
    custom: { systemuser: false, new_other: true },
  });
  const { relationships, skipped } = await readRelationships(sdk, ['new_ticket'], 'new');
  assert.strictEqual(relationships.length, 1);
  assert.strictEqual(relationships[0].referenced, 'systemuser');
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].name, 'new_other_new_ticket');
  assert.match(skipped[0].reason, /custom table this app does not include/i);
});

test('emits an explicit schemaName only when it diverges from the generated default (#567)', async () => {
  const mk = (deployed) => makeSdk({
    m2o: { new_ticket: [rel({ SchemaName: deployed, ReferencedEntity: 'new_customer', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_customerid' })] },
  });
  // Matches `prefixedRelationshipName('new_customer','new_ticket','new')` — omitted, so the build
  // regenerates the same name.
  const same = await readRelationships(mk('new_customer_new_ticket'), ['new_customer', 'new_ticket'], 'new');
  assert.strictEqual(same.relationships[0].schemaName, undefined);
  // Divergent: must be carried, or a rebuild into THIS environment creates a second relationship
  // beside the existing one instead of matching it.
  const diff = await readRelationships(mk('new_CustomerTicketLink'), ['new_customer', 'new_ticket'], 'new');
  assert.strictEqual(diff.relationships[0].schemaName, 'new_CustomerTicketLink');
  // With the publisher prefix UNKNOWN (the spec carries a placeholder), a name equal to the generated default
  // is carried too: omitted, a rebuild under the placeholder generated another name and created it twice. A
  // foreign-prefix name is carried as it is, not renamed.
  for (const deployed of ['new_customer_new_ticket', 'zzz_CustomerTicketLink']) {
    const unknown = await readRelationships(mk(deployed), ['new_customer', 'new_ticket'], 'new', undefined, { prefixUnknown: true });
    assert.strictEqual(unknown.relationships[0].schemaName, deployed, deployed);
  }
});

// An unreadable parent and a confirmed-custom parent are different facts. Collapsing them made a
// transient 403/503 report the confident (and possibly wrong) diagnosis "is a custom table this app
// does not include", sending the author to fix a modelling problem that may not exist.
test('an unreadable parent table is reported as undetermined, not as a confirmed custom table (#567)', async () => {
  const sdk = makeSdk({
    m2o: { new_ticket: [rel({ SchemaName: 'new_foo_new_ticket', ReferencedEntity: 'foo_parent', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_fooid' })] },
  });
  // Make the IsCustomEntity probe fail the way a throttled or forbidden metadata read does.
  const inner = sdk.dataverse.get;
  sdk.dataverse.get = async (url) => (/IsCustomEntity/.test(url) ? { status: 503, body: null } : inner(url));

  const { relationships, skipped } = await readRelationships(sdk, ['new_customer', 'new_ticket'], 'new');
  assert.strictEqual(relationships.length, 0, 'an undetermined parent is still not declared');
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, /could not be read/i);
  assert.doesNotMatch(skipped[0].reason, /is a custom table/i, 'a read failure must not be stated as a fact about the table');
});

test('a divergent schemaName under a foreign prefix is reported as a RENAME, not as a loss (#567)', async () => {
  const sdk = makeSdk({
    m2o: { new_ticket: [rel({ SchemaName: 'zzz_LegacyLink', ReferencedEntity: 'new_customer', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_customerid' })] },
  });
  const warnings = [];
  const { relationships, skipped } = await readRelationships(sdk, ['new_customer', 'new_ticket'], 'new', (m) => warnings.push(m));
  assert.strictEqual(relationships.length, 1);
  assert.strictEqual(relationships[0].schemaName, 'zzz_LegacyLink', 'the deployed name is what a same-environment rebuild must reuse');
  assert.strictEqual(relationships[0].existing, true);
  assert.deepStrictEqual(skipped, [], 'an emitted relationship must not be counted as skipped');
  assert.ok(warnings.some((w) => /zzz_LegacyLink/.test(w) && /new environment/i.test(w) && /cannot create/i.test(w)), JSON.stringify(warnings));
  assert.ok(!warnings.some((w) => /generated name/i.test(w)), 'renaming onto the generated name is what made the rebuild halt');
});

test('reconstructs N:N only when both ends are in the app, and reports the rest (#567)', async () => {
  const sdk = makeSdk({
    m2m: {
      new_ticket: [
        rel({ SchemaName: 'new_ticket_new_tag', Entity1LogicalName: 'new_ticket', Entity2LogicalName: 'new_tag' }),
        rel({ SchemaName: 'new_ticket_new_absent', Entity1LogicalName: 'new_ticket', Entity2LogicalName: 'new_absent' }),
      ],
    },
  });
  const { relationships, skipped } = await readRelationships(sdk, ['new_ticket', 'new_tag'], 'new');
  // `schemaName` is carried because the deployed name diverges from the generated default:
  // `manyToManySchemaName` SORTS the pair, so it would compose `new_tag_new_ticket`. Without the
  // deployed name a rebuild into this environment creates a SECOND intersect relationship instead of
  // matching the existing one.
  assert.deepStrictEqual(relationships, [{ type: 'ManyToMany', entity1: 'new_ticket', entity2: 'new_tag', schemaName: 'new_ticket_new_tag', existing: true }]);
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, /does not include both tables/i);
});

test('a relationship reachable from both ends is emitted exactly once (#567)', async () => {
  const r = rel({ SchemaName: 'new_customer_new_ticket', ReferencedEntity: 'new_customer', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_customerid' });
  const sdk = makeSdk({ m2o: { new_ticket: [r], new_customer: [r] } });
  const { relationships } = await readRelationships(sdk, ['new_customer', 'new_ticket'], 'new');
  assert.strictEqual(relationships.length, 1);
});

test('an N:N is emitted once even though it appears on BOTH tables metadata (#567)', async () => {
  // Dataverse reports a ManyToMany from each participating table, so without a cross-end dedupe the
  // same link is declared twice and the rebuild tries to create the intersect table a second time.
  const r = rel({ SchemaName: 'new_ticket_new_tag', Entity1LogicalName: 'new_ticket', Entity2LogicalName: 'new_tag' });
  const sdk = makeSdk({ m2m: { new_ticket: [r], new_tag: [r] } });
  const { relationships } = await readRelationships(sdk, ['new_ticket', 'new_tag'], 'new');
  assert.deepStrictEqual(relationships, [{ type: 'ManyToMany', entity1: 'new_ticket', entity2: 'new_tag', schemaName: 'new_ticket_new_tag', existing: true }]);
});

test('a failed relationship read is REPORTED, not silently read as "this table has none" (#567)', async () => {
  const sdk = makeSdk({ fail: { new_ticket: 'network down' } });
  const { relationships, skipped } = await readRelationships(sdk, ['new_ticket'], 'new');
  assert.deepStrictEqual(relationships, []);
  assert.ok(skipped.some((s) => /could not be read/i.test(s.reason)), JSON.stringify(skipped));
});

test('a non-2xx status is treated as a failure, not as an empty collection (#567)', async () => {
  // `dataverse.get` RESOLVES on a non-2xx rather than throwing, so a bare try/catch would turn a
  // 403 into "this table has no relationships" — the exact silent absence #567 was filed about.
  // Both the 1:N and the N:N read are asserted SEPARATELY and by name: asserting only that some
  // entry mentions "HTTP 403" passed even with one of the two status checks removed, because the
  // other read's failure satisfied it.
  const sdk = { dataverse: { get: async () => ({ status: 403, body: null }) } };
  const { relationships, skipped } = await readRelationships(sdk, ['new_ticket'], 'new');
  assert.deepStrictEqual(relationships, []);
  const byName = Object.fromEntries(skipped.map((s) => [s.name, s.reason]));
  assert.match(byName['(all)'] || '', /HTTP 403/, `1:N read not reported: ${JSON.stringify(skipped)}`);
  assert.match(byName['(many-to-many)'] || '', /HTTP 403/, `N:N read not reported: ${JSON.stringify(skipped)}`);
});

test('the skipped-relationship warning names each one and its reason (#567)', () => {
  assert.strictEqual(relationshipsSkippedWarning([]), '');
  const out = relationshipsSkippedWarning([{ name: 'new_a_new_b', entity: 'new_b', reason: 'because' }]);
  assert.match(out, /1 relationship\(s\) could not be expressed/);
  assert.match(out, /new_b: new_a_new_b — because/);
  // It must NOT repeat notRoundTrippedSummary's claim that everything omitted is recorded under
  // descriptionInventory — skipped relationships are not.
  assert.ok(!/descriptionInventory/.test(out));
});


const { validateAppSpec } = require('../lib/app-spec.js');

function downloadedSpec(relationships) {
  return {
    solution: { uniqueName: 'Contoso', publisherPrefix: 'contoso' },
    app: { name: 'Projects' },
    entities: [
      { schemaName: 'contoso_project', displayName: 'Project', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' } },
      { schemaName: 'contoso_task', displayName: 'Task', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' } },
    ],
    relationships,
  };
}

test('known prefix: two foreign 1:N on one pair keep both deployed names', async () => {
  // Omitting either name would derive contoso_project_contoso_task for both, and the collision
  // gate would refuse the download. The deployed names are distinct and must round-trip.
  const sdk = makeSdk({
    m2o: {
      contoso_task: [
        rel({ SchemaName: 'zzz_ProjectLink', ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' }),
        rel({ SchemaName: 'yyy_ProjectOwner', ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_ownerid' }),
      ],
    },
  });
  const { relationships, skipped } = await readRelationships(sdk, ['contoso_project', 'contoso_task'], 'contoso');
  assert.deepStrictEqual(skipped, []);
  assert.deepStrictEqual(relationships.map((r) => r.schemaName).sort(), ['yyy_ProjectOwner', 'zzz_ProjectLink']);
  const v = validateAppSpec(downloadedSpec(relationships), { profile: 'plan', reconstructed: true });
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
});

test('known prefix: a foreign 1:N and N:N on one pair keep both deployed names', async () => {
  const sdk = makeSdk({
    m2o: { contoso_task: [rel({ SchemaName: 'zzz_ProjectTask', ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' })] },
    m2m: { contoso_project: [rel({ SchemaName: 'yyy_ProjectTaskNN', Entity1LogicalName: 'contoso_project', Entity2LogicalName: 'contoso_task' })] },
  });
  const { relationships, skipped } = await readRelationships(sdk, ['contoso_project', 'contoso_task'], 'contoso');
  assert.deepStrictEqual(skipped, []);
  const byType = Object.fromEntries(relationships.map((r) => [r.type, r.schemaName]));
  assert.strictEqual(byType.OneToMany, 'zzz_ProjectTask');
  assert.strictEqual(byType.ManyToMany, 'yyy_ProjectTaskNN');
  const v = validateAppSpec(downloadedSpec(relationships), { profile: 'plan', reconstructed: true });
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
});

const { lintAppSpec } = require('../lib/spec-lint.js');

test('a colliding foreign-prefix download lints with warnings only', async () => {
  const sdk = makeSdk({
    m2o: {
      contoso_task: [
        rel({ SchemaName: 'zzz_ProjectLink', ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' }),
        rel({ SchemaName: 'yyy_ProjectOwner', ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_ownerid' }),
      ],
    },
    m2m: { contoso_project: [rel({ SchemaName: 'qqq_ProjectTaskNN', Entity1LogicalName: 'contoso_project', Entity2LogicalName: 'contoso_task' })] },
  });
  const { relationships } = await readRelationships(sdk, ['contoso_project', 'contoso_task'], 'contoso');
  const lint = lintAppSpec(downloadedSpec(relationships));
  assert.strictEqual(lint.ok, true, JSON.stringify(lint.errors));
  for (const name of ['zzz_ProjectLink', 'yyy_ProjectOwner', 'qqq_ProjectTaskNN']) {
    assert.ok(lint.warnings.some((w) => w.includes(name) && /publisher prefix/.test(w)), JSON.stringify(lint.warnings));
  }
});

test('a single foreign 1:N keeps its deployed name and a same-environment rebuild reuses it', async () => {
  const sdk = makeSdk({
    m2o: { contoso_task: [rel({ SchemaName: 'legacy_ProjectTask', ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' })] },
  });
  const warnings = [];
  const { relationships, skipped } = await readRelationships(sdk, ['contoso_project', 'contoso_task'], 'contoso', (m) => warnings.push(m));
  assert.deepStrictEqual(skipped, []);
  assert.strictEqual(relationships[0].schemaName, 'legacy_ProjectTask');
  assert.strictEqual(relationships[0].lookup.schemaName, 'contoso_projectid');
  const spec = downloadedSpec(relationships);
  const lint = lintAppSpec(spec);
  assert.strictEqual(lint.ok, true, JSON.stringify(lint.errors));
  assert.ok(warnings.some((w) => /legacy_ProjectTask/.test(w) && /new environment/i.test(w)), JSON.stringify(warnings));

  const { provisionDataModel, makeRunner } = require('../lib/entity-provision.js');
  let created = 0;
  const buildSdk = {
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: o.schemaName.toLowerCase() + 's', metadataId: 't' }),
    createColumn: async () => ({ logicalName: 'x', metadataId: 'c' }),
    createRelationship: async () => { created += 1; throw new Error('must not create'); },
  };
  const provision = {
    findTables: async () => [],
    findColumns: async () => [],
    dataverse: {
      get: async (p) => {
        if (p.includes("/EntityDefinitions(LogicalName='contoso_project')/OneToManyRelationships")) {
          return { status: 200, body: { value: [{ SchemaName: 'legacy_ProjectTask', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' }] } };
        }
        return { status: 200, body: { value: [] } };
      },
    },
  };
  const built = {
    ...spec,
    entities: spec.entities.map((e) => ({ ...e, columns: [] })),
  };
  const events = [];
  await provisionDataModel({
    sdk: buildSdk, provision, runner: makeRunner({ emit: (e) => events.push(e), total: 8 }),
    spec: built, apply: true, sleep: async () => {},
  });
  assert.strictEqual(created, 0);
  assert.ok(events.some((e) => e.status === 'skip' && /legacy_ProjectTask/.test(e.label) && /\(exists\)/.test(e.label)), JSON.stringify(events));
});
