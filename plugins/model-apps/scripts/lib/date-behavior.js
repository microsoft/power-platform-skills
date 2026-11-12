'use strict';
// Date and Time column behaviour on tables the build did not create: the narrow typed read that tells whether a column POST would be
// refused, the explicitly requested repair of a column's behaviour, and the read-back that proves it.
//
// Why a preflight at all. Dataverse stores NO behaviour for a Date and Time column created inside a table's own create by another
// tool, and from then on refuses every new column, lookup or relationship on that table with 400 `0x80048550` ("Failure in
// generation Filtered<table> for attribute <column>"). The bundled SDK diagnoses that refusal after the fact; reading the behaviour
// first lets the build stop before it sends the first column, and lets a spec that declares the column's behaviour repair it.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/behavior-format-date-time-attribute
//
// Why THIS read. `DateTimeBehavior` is a property of the derived DateTimeAttributeMetadata type, so it is not on the base Attributes
// collection the build already reads (findExistingColumns in lib/entity-provision.js, which selects LogicalName and RequiredLevel).
// Adding it there is not possible, and a broad metadata read before a labelled create is what strips every non-base-language label.
// So this is one extra, typed, label-free GET per existing table that is about to receive a column, and nothing else:
//   /EntityDefinitions(LogicalName='new_ticket')/Attributes/Microsoft.Dynamics.CRM.DateTimeAttributeMetadata
//     ?$select=LogicalName,DateTimeBehavior,CanChangeDateTimeBehavior
// which answers, e.g.
//   { "value": [
//       { "LogicalName": "createdon", "DateTimeBehavior": { "Value": "UserLocal" },
//         "CanChangeDateTimeBehavior": { "Value": false, "CanBeChanged": false } },
//       { "LogicalName": "new_due", "DateTimeBehavior": null, "CanChangeDateTimeBehavior": { "Value": true } } ] }
// `null` is a column with no behaviour (the blocker). A row that does not carry the property at all, or carries something that is
// not one of the three values, is UNKNOWN — never null, never safe. An answer without a `value` array, or one that advertises a next
// page (`@odata.nextLink`), is incomplete: the build halts as unverified rather than send a second diagnostic request.

const { odataLit } = require('./odata.js');
const { DATE_TIME_BEHAVIORS, isAuthorized, emptyFeatureResult } = require('./schema-feature-contract.js');

const DATE_SELECT = 'LogicalName,DateTimeBehavior,CanChangeDateTimeBehavior';
const DATETIME_TYPE = 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata';

const lower = (v) => String(v == null ? '' : v).toLowerCase();
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

function dateBehaviorsPath(table) {
  return `/EntityDefinitions(LogicalName='${odataLit(table)}')/Attributes/${DATETIME_TYPE}?$select=${DATE_SELECT}`;
}
function dateBehaviorPath(table, column) {
  return `/EntityDefinitions(LogicalName='${odataLit(table)}')/Attributes(LogicalName='${odataLit(column)}')/${DATETIME_TYPE}?$select=${DATE_SELECT}`;
}

// One attribute row -> { behavior: 'UserLocal'|'DateOnly'|'TimeZoneIndependent'|null, canChange: true|false|undefined }, or null
// when the row does not say what its behaviour is.
function parseDateRow(row) {
  if (!row || typeof row !== 'object' || typeof row.LogicalName !== 'string' || !has(row, 'DateTimeBehavior')) return null;
  const raw = row.DateTimeBehavior;
  let behavior;
  if (raw === null) behavior = null;
  else if (raw && typeof raw === 'object' && DATE_TIME_BEHAVIORS.includes(raw.Value)) behavior = raw.Value;
  else return null;
  const can = row.CanChangeDateTimeBehavior;
  const canChange = can && typeof can === 'object' && typeof can.Value === 'boolean' ? can.Value : undefined;
  return { behavior, canChange };
}

// The answer to dateBehaviorsPath -> evidence `{ complete: true, columns: Map<logical, { behavior, canChange }> }`, or
// `{ complete: false, reason }`. Nothing partial is returned as complete: one unreadable row makes the whole answer unverified,
// because the row that could not be read is exactly the one that might be null.
function parseDateBehaviors(res) {
  if (!res || !(res.status >= 200 && res.status < 300)) return { complete: false, reason: `HTTP ${res && res.status}` };
  const body = res.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.value)) return { complete: false, reason: 'the answer has no attribute list' };
  if (body['@odata.nextLink']) return { complete: false, reason: 'the answer is one page of several' };
  const columns = new Map();
  for (const row of body.value) {
    const parsed = parseDateRow(row);
    if (!parsed) return { complete: false, reason: 'a Date and Time column does not state its behaviour' };
    columns.set(lower(row.LogicalName), parsed);
  }
  return { complete: true, columns };
}

// The typed read for one table, at most once per `cache` (one build attempt). The cache holds the evidence itself so a repair can
// update the entry from its read-back, instead of a second diagnostic GET.
async function readExistingDateBehaviors(provision, table, { cache } = {}) {
  const key = lower(table);
  if (cache && cache.has(key)) return cache.get(key);
  const raw = provision && provision.dataverse;
  let evidence;
  if (!raw || typeof raw.get !== 'function') evidence = { complete: false, reason: 'no metadata reader is available' };
  else {
    try {
      evidence = parseDateBehaviors(await raw.get(dateBehaviorsPath(key)));
    } catch (e) {
      // The reason is said without the transport's own text: it can carry the request URL.
      evidence = { complete: false, reason: `the read failed${e && e.statusCode ? ` (HTTP ${e.statusCode})` : ''}` };
    }
  }
  if (cache) cache.set(key, evidence);
  return evidence;
}

// What the declared behaviours of one existing table's columns need, against the evidence.
//
//   current null -> UserLocal        -> repair, not destructive: UserLocal is how the column's values are already stored (UTC)
//   current = declared               -> nothing
//   current null or UserLocal -> DateOnly/TimeZoneIndependent
//                                    -> change: DESTRUCTIVE (one-way, and values already stored are not converted), so refused
//                                       unless authorized for `dateTimeBehavior:<table>.<column>`
//   current DateOnly/TZI -> other    -> refused: Learn documents both as permanent
//   any change with CanChange not true -> refused: Learn requires CanChangeDateTimeBehavior to be true, a repair included
//
// `missing` lists the null-behaviour columns no planned repair covers: each one blocks a column write on the table.
// `known` (lowercased names) are the columns the caller already knows the table has. One of them the typed read does not list is
// unknown: it is not a Date and Time column there, or the answer left it out — either way it will not be created with its behaviour.
function planDateBehaviorRepairs(entity, evidence, { authorizedDestructive, known } = {}) {
  const operations = [];
  const unknown = [];
  const refused = [];
  const table = lower(entity && entity.schemaName);
  const declared = ((entity && entity.columns) || []).filter((c) => c && c.type === 'DateTime' && c.dateTimeBehavior !== undefined);
  if (!evidence || !evidence.complete) {
    for (const c of declared) unknown.push({ key: `dateTimeBehavior:${table}.${lower(c.schemaName)}`, kind: 'dateTimeBehavior', target: `${table}.${lower(c.schemaName)}`, code: 'DATETIME_BEHAVIOR_UNVERIFIED', reason: (evidence && evidence.reason) || 'not read' });
    return { operations, unknown, refused, missing: [] };
  }
  const repaired = new Set();
  for (const c of declared) {
    const column = lower(c.schemaName);
    const current = evidence.columns.get(column);
    const key = `dateTimeBehavior:${table}.${column}`;
    const target = `${table}.${column}`;
    if (!current) {
      // A column the table does not have yet is created with its behaviour; one it already has cannot be.
      if (known && known.has(column)) unknown.push({ key, kind: 'dateTimeBehavior', target, code: 'DATETIME_BEHAVIOR_UNVERIFIED', reason: 'the table has the column, but the read of its Date and Time columns does not list it' });
      continue;
    }
    const want = c.dateTimeBehavior;
    if (current.behavior === want) continue;
    const refuse = (code, reason) => refused.push({ key, kind: 'dateTimeBehavior', target, code, reason });
    if (current.behavior !== null && current.behavior !== 'UserLocal') {
      refuse('DATETIME_BEHAVIOR_PERMANENT', `the column is ${current.behavior}, which cannot be changed`);
      continue;
    }
    if (current.canChange !== true) {
      refuse('DATETIME_BEHAVIOR_NOT_CHANGEABLE', current.canChange === false ? 'CanChangeDateTimeBehavior is false on the column' : 'CanChangeDateTimeBehavior could not be read');
      continue;
    }
    const destructive = want !== 'UserLocal';
    if (destructive && !isAuthorized(authorizedDestructive, key)) {
      refuse('DESTRUCTIVE_NOT_AUTHORIZED', `changing ${current.behavior === null ? 'a column with no behaviour' : 'UserLocal'} to ${want} is one-way, and values already stored are not converted`);
      continue;
    }
    if (current.behavior === null) repaired.add(column);
    operations.push({ key, kind: 'dateTimeBehavior', target, action: current.behavior === null ? 'repair' : 'update', destructive, publicationScopes: [`table:${table}`], preconditions: ['CanChangeDateTimeBehavior'], table, column, behavior: want });
  }
  const missing = [...evidence.columns.entries()].filter(([name, v]) => v.behavior === null && !repaired.has(name)).map(([name]) => name).sort();
  return { operations, unknown, refused, missing };
}

// Whether a column may be written to the table now: `{ ready: true }`, or `{ ready: false, code, columns?, reason }` for the caller
// to turn into its own typed halt. Run AFTER any planned repair has been applied (its read-back updates the evidence).
function assertSchemaWriteReady(evidence) {
  if (!evidence || !evidence.complete) {
    return { ready: false, code: 'DATETIME_BEHAVIOR_UNVERIFIED', reason: (evidence && evidence.reason) || 'not read' };
  }
  const columns = [...evidence.columns.entries()].filter(([, v]) => v.behavior === null).map(([name]) => name).sort();
  return columns.length ? { ready: false, code: 'DATETIME_BEHAVIOR_MISSING', columns } : { ready: true };
}

// Apply each planned behaviour change through the SDK's updateColumn (which re-checks Learn's rules on the attribute it reads), then
// read the one column back with a typed GET. Only a read-back that states the declared behaviour is `saved`; any other answer is
// `unknown`, and the evidence entry is replaced by what was read so a later readiness check never trusts the old value.
async function applyDateBehaviorRepairs(plan, ctx, { evidence } = {}) {
  const result = emptyFeatureResult();
  for (const r of plan.refused || []) result.refused.push(r);
  for (const u of plan.unknown || []) result.unknown.push(u);
  for (const op of plan.operations || []) {
    await ctx.sdk.updateColumn(op.table, op.column, { dateTimeBehavior: op.behavior });
    let back = null;
    const raw = ctx.provision && ctx.provision.dataverse;
    if (raw && typeof raw.get === 'function') {
      try {
        const res = await raw.get(dateBehaviorPath(op.table, op.column));
        if (res && res.status >= 200 && res.status < 300) back = parseDateRow(res.body);
      } catch (_) { back = null; }
    }
    if (evidence && evidence.complete) {
      if (back) evidence.columns.set(op.column, back);
      else evidence.columns.set(op.column, { behavior: null, canChange: undefined, unconfirmed: true });
    }
    if (back && back.behavior === op.behavior) {
      result.saved.push(op.key);
      for (const scope of op.publicationScopes || []) {
        if (ctx.publication && typeof ctx.publication.queue === 'function') ctx.publication.queue(scope);
      }
      if ((op.publicationScopes || []).length) result.pendingPublish.push(op.key);
    } else {
      result.unknown.push({ key: op.key, kind: op.kind, target: op.target, code: 'DATETIME_BEHAVIOR_UNCONFIRMED', reason: back ? `the column reads ${back.behavior === null ? 'no behaviour' : back.behavior} after the update` : 'the column could not be read back' });
    }
  }
  return result;
}

// One check per declared behaviour on a column the evidence covers.
function verifyDateBehaviors(entity, evidence) {
  const table = lower(entity && entity.schemaName);
  return ((entity && entity.columns) || []).filter((c) => c && c.type === 'DateTime' && c.dateTimeBehavior !== undefined).map((c) => {
    const column = lower(c.schemaName);
    const got = evidence && evidence.complete ? evidence.columns.get(column) : undefined;
    const status = !got ? 'unknown' : (got.behavior === c.dateTimeBehavior ? 'pass' : 'fail');
    return { key: `dateTimeBehavior:${table}.${column}`, kind: 'dateTimeBehavior', target: `${table}.${column}`, status, detail: `declared ${c.dateTimeBehavior}, deployed ${got ? (got.behavior === null ? 'none' : got.behavior) : 'unreadable'}` };
  });
}

module.exports = {
  dateBehaviorsPath,
  dateBehaviorPath,
  parseDateBehaviors,
  readExistingDateBehaviors,
  planDateBehaviorRepairs,
  assertSchemaWriteReady,
  applyDateBehaviorRepairs,
  verifyDateBehaviors,
};
