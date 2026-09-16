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
  assert.strictEqual(relationships[0].schemaName, undefined, 'a foreign-prefix name would fail the publisher-prefix lint');
  // It IS carried into the spec, just under the generated name — so reporting it as skipped made the
  // summary say it was "absent from the rebuildable spec", the opposite of what happens.
  assert.deepStrictEqual(skipped, [], 'an emitted relationship must not be counted as skipped');
  assert.ok(warnings.some((w) => /publisher prefix/i.test(w) && /generated name/i.test(w)), `the rename must still be reported; got ${JSON.stringify(warnings)}`);
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
  assert.deepStrictEqual(relationships, [{ type: 'ManyToMany', entity1: 'new_ticket', entity2: 'new_tag' }]);
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
  assert.deepStrictEqual(relationships, [{ type: 'ManyToMany', entity1: 'new_ticket', entity2: 'new_tag' }]);
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
