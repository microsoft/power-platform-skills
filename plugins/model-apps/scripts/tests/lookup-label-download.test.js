'use strict';
// ADO 6691205 (download half): a lookup whose live label is exactly what a rebuild would write when the
// spec omits `lookup.displayName` is downloaded WITHOUT one, so downloaded specs stay minimal; a label
// that differs is written as before. See lookupLabelFor (app-spec.js) for the rule the comparison uses.
const { test } = require('node:test');
const assert = require('node:assert');
const { readRelationships } = require('../download-model-app.js');
const { lookupColumnsFor, validateAppSpec } = require('../lib/app-spec.js');

const label = (...pairs) => ({ LocalizedLabels: pairs.map(([LanguageCode, Label]) => ({ Label, LanguageCode })) });
const rel = (o) => ({ IsCustomRelationship: true, ...o });

// The reads `readRelationships` performs. `parents` answers the stock-parent probe
// (`?$select=IsCustomEntity,DisplayName`) with the table's label.
function makeSdk({ m2o = {}, lookups = {}, parents = {} } = {}) {
  const ofEntity = (p) => (p.match(/LogicalName='([^']+)'/) || [])[1];
  return {
    dataverse: {
      get: async (p) => {
        const e = ofEntity(p);
        if (/\/ManyToOneRelationships/.test(p)) return { status: 200, body: { value: m2o[e] || [] } };
        if (/\/ManyToManyRelationships/.test(p)) return { status: 200, body: { value: [] } };
        if (/LookupAttributeMetadata/.test(p)) return { status: 200, body: { value: lookups[e] || [] } };
        if (/\?\$select=IsCustomEntity/.test(p)) return { status: 200, body: { IsCustomEntity: false, ...(parents[e] ? { DisplayName: parents[e] } : {}) } };
        return { status: 404, body: null };
      },
    },
  };
}

const ticketToCustomer = (displayName) => ({
  m2o: { new_ticket: [rel({ SchemaName: 'new_customer_new_ticket', ReferencedEntity: 'new_customer', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_customerid' })] },
  lookups: { new_ticket: [{ LogicalName: 'new_customerid', SchemaName: 'new_CustomerId', DisplayName: displayName, Targets: ['new_customer'] }] },
});
const customer = (displayName) => ({ schemaName: 'new_customer', displayName });
const ticket = () => ({ schemaName: 'new_ticket', displayName: 'Ticket' });
const read = (sdk, entities) => readRelationships(sdk, ['new_customer', 'new_ticket'], 'new', undefined, { entities });

test('ADO 6691205 download: a lookup labelled like its in-app parent omits displayName', async () => {
  const { relationships } = await read(makeSdk(ticketToCustomer(label([1033, 'Customer']))), [customer('Customer'), ticket()]);
  assert.deepStrictEqual(relationships[0].lookup, { schemaName: 'new_CustomerId' });
});

test('ADO 6691205 download: a lookup whose label differs from its parent keeps displayName, exactly as before', async () => {
  const { relationships } = await read(makeSdk(ticketToCustomer(label([1033, 'Account holder']))), [customer('Customer'), ticket()]);
  assert.deepStrictEqual(relationships[0].lookup, { schemaName: 'new_CustomerId', displayName: 'Account holder' });
});

test('ADO 6691205 download: a label that still holds the old default (the parent\'s logical name) is left out, so a rebuild repairs it', async () => {
  // An explicit label is never repaired on a rebuild, so writing the identifier out would carry the defect through
  // download -> edit -> rebuild for good; leaving it out is what hands the label to the rebuild's repair.
  const { relationships } = await read(makeSdk(ticketToCustomer(label([1033, 'new_customer']))), [customer('Customer'), ticket()]);
  assert.deepStrictEqual(relationships[0].lookup, { schemaName: 'new_CustomerId' });
});

test('ADO 6691205 download: only the parent\'s logical name is the old default of a COLUMN — the lookup\'s own name is somebody\'s label, and is carried', async () => {
  // The SDK labels a column with the referenced table's logical name. The lookup's own lower-case name is what it
  // leaves on a form FIELD it could not resolve; no build wrote it on a column, so a column carrying it was labelled
  // by a person, which a rebuild must keep — as it must a schema name with capitals or a case variant.
  for (const typed of ['new_customerid', 'new_CustomerId', 'NEW_Customer']) {
    const carried = await read(makeSdk(ticketToCustomer(label([1033, typed]))), [customer('Customer'), ticket()]);
    assert.strictEqual(carried.relationships[0].lookup.displayName, typed, typed);
  }
});

test('ADO 6691205 download: an old default on a lookup to a stock table is left out as well, with no stock label to compare', async () => {
  const sdk = makeSdk({
    m2o: { new_ticket: [rel({ SchemaName: 'new_systemuser_new_ticket', ReferencedEntity: 'systemuser', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_agentid' })] },
    lookups: { new_ticket: [{ LogicalName: 'new_agentid', SchemaName: 'new_AgentId', DisplayName: label([1033, 'systemuser']), Targets: ['systemuser'] }] },
  });
  const { relationships } = await read(sdk, [ticket()]);
  assert.deepStrictEqual(relationships[0].lookup, { schemaName: 'new_AgentId' });
});

test('ADO 6691205 download: a correct label that merely reads like the table\'s name is carried, not mistaken for the old default', async () => {
  // "Contact" is the display name of `contact`; the old default is the lower-case logical name.
  const sdk = makeSdk({
    m2o: { new_ticket: [rel({ SchemaName: 'new_contact_new_ticket', ReferencedEntity: 'contact', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_contactid' })] },
    lookups: { new_ticket: [{ LogicalName: 'new_contactid', SchemaName: 'new_ContactId', DisplayName: label([1033, 'Contact']), Targets: ['contact'] }] },
  });
  const { relationships } = await read(sdk, [ticket()]);
  assert.strictEqual(relationships[0].lookup.displayName, 'Contact', 'no stock label was read to prove it is the default, so nothing is assumed');
});

test('ADO 6691205 download: a localized lookup label equal to a localized parent name omits displayName', async () => {
  const map = { 1033: 'Customer', 3082: 'Cliente' };
  const { relationships } = await read(makeSdk(ticketToCustomer(label([1033, 'Customer'], [3082, 'Cliente']))), [customer(map), ticket()]);
  assert.deepStrictEqual(relationships[0].lookup, { schemaName: 'new_CustomerId' });
});

test('ADO 6691205 download: a single-language lookup label is not "the default" of a localized parent', async () => {
  // A rebuild writes the parent's whole map; this lookup carries one language, so they are not the same
  // label and the one it has is kept.
  const map = { 1033: 'Customer', 3082: 'Cliente' };
  const { relationships } = await read(makeSdk(ticketToCustomer(label([1033, 'Customer']))), [customer(map), ticket()]);
  assert.strictEqual(relationships[0].lookup.displayName, 'Customer');
});

test('ADO 6691205 download: a lookup to a stock table compares with the label the environment reports for it', async () => {
  const stock = (lookupLabel) => makeSdk({
    m2o: { new_ticket: [rel({ SchemaName: 'new_systemuser_new_ticket', ReferencedEntity: 'systemuser', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_agentid' })] },
    lookups: { new_ticket: [{ LogicalName: 'new_agentid', SchemaName: 'new_AgentId', DisplayName: lookupLabel, Targets: ['systemuser'] }] },
    parents: { systemuser: label([1033, 'User'], [1036, 'Utilisateur']) },
  });
  const same = await read(stock(label([1033, 'User'])), [ticket()]);
  assert.deepStrictEqual(same.relationships[0].lookup, { schemaName: 'new_AgentId' }, 'equal at the lookup\'s own language');
  const french = await read(stock(label([1036, 'Utilisateur'])), [ticket()]);
  assert.deepStrictEqual(french.relationships[0].lookup, { schemaName: 'new_AgentId' }, 'the comparison is made in the language the lookup was written in');
  const other = await read(stock(label([1033, 'Assigned agent'])), [ticket()]);
  assert.strictEqual(other.relationships[0].lookup.displayName, 'Assigned agent');
});

test('ADO 6691205 download: a stock parent whose label could not be read keeps the lookup\'s label', async () => {
  const sdk = makeSdk({
    m2o: { new_ticket: [rel({ SchemaName: 'new_systemuser_new_ticket', ReferencedEntity: 'systemuser', ReferencingEntity: 'new_ticket', ReferencingAttribute: 'new_agentid' })] },
    lookups: { new_ticket: [{ LogicalName: 'new_agentid', SchemaName: 'new_AgentId', DisplayName: label([1033, 'User']), Targets: ['systemuser'] }] },
  });
  const { relationships } = await read(sdk, [ticket()]);
  assert.strictEqual(relationships[0].lookup.displayName, 'User', 'no label to compare with, so nothing is assumed');
});

test('ADO 6691205 download: without the downloaded tables to compare against, every label is written as before', async () => {
  const { relationships } = await readRelationships(makeSdk(ticketToCustomer(label([1033, 'Customer']))), ['new_customer', 'new_ticket'], 'new');
  assert.strictEqual(relationships[0].lookup.displayName, 'Customer');
});

test('ADO 6691205 download: a minimal downloaded relationship validates and rebuilds with the same label', async () => {
  const { relationships } = await read(makeSdk(ticketToCustomer(label([1033, 'Customer']))), [customer('Customer'), ticket()]);
  const spec = {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [
      { schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
      { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
    ],
    relationships,
  };
  const checked = validateAppSpec(spec, { profile: 'structural' });
  assert.deepStrictEqual(checked.errors.filter((e) => /lookup|relationship/i.test(e)), []);
  assert.strictEqual(lookupColumnsFor(spec, 'new_ticket')[0].displayName, 'Customer');
});
