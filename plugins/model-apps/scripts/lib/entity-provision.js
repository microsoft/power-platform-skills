'use strict';
// Shared entity-provisioning core: solution + data-model + sample-data phase logic
// extracted from sdk-build.js for reuse by /genpage and /model-app-maker.
//
// makeRunner() owns the emit/counter/BuildHalt machinery so both consumers produce
// identical { phase, status, label, n, total } event streams.

const {
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  relationshipSchemaName,
} = require('./app-spec.js');
const { topoOrderEntities, entityByLogical } = require('./_graph.js');

// App Spec column type -> SDK ColumnType. Lookup is omitted (side effect of a OneToMany
// relationship); Customer is handled specially (createCustomerColumn).
const SDK_COLUMN_TYPE = {
  Text: 'string', Memo: 'memo', Choice: 'choice', MultiChoice: 'multiChoice',
  Boolean: 'boolean', Money: 'money', DateTime: 'dateTime',
  Integer: 'integer', BigInt: 'bigint', Decimal: 'decimal', Double: 'double',
  File: 'file', Image: 'image', AutoNumber: 'autonumber',
};
const REQUIRED = (c) => (c.required === true ? 'ApplicationRequired' : c.required === 'recommended' ? 'Recommended' : 'None');

// Map an App Spec column to SDK CreateColumnOptions. `globalChoiceIds` maps a global-choice
// name -> its metadataId (so a column can bind to a shared option set).
function columnOptions(c, globalChoiceIds) {
  const o = { schemaName: c.schemaName, displayName: c.displayName || c.schemaName, type: SDK_COLUMN_TYPE[c.type || 'Text'], required: REQUIRED(c) };
  switch (c.type) {
    case 'Text': if (c.maxLength) o.maxLength = c.maxLength; if (c.format) o.stringFormat = c.format; break;
    case 'Memo': if (c.maxLength) o.maxLength = c.maxLength; break;
    case 'Integer': case 'BigInt': case 'Decimal': case 'Double': case 'Money':
      if (c.minValue !== undefined) o.minValue = c.minValue;
      if (c.maxValue !== undefined) o.maxValue = c.maxValue;
      if (c.precision !== undefined) o.precision = c.precision; break;
    case 'DateTime': if (c.dateFormat) o.dateFormat = c.dateFormat; break;
    case 'Boolean': if (c.trueLabel) o.trueLabel = c.trueLabel; if (c.falseLabel) o.falseLabel = c.falseLabel; break;
    case 'Choice': case 'MultiChoice':
      if (c.globalChoice && globalChoiceIds[c.globalChoice]) o.globalChoiceMetadataId = globalChoiceIds[c.globalChoice];
      else o.options = choiceOptions(c); break;
    case 'File': case 'Image': if (c.maxSizeKb) o.maxSizeKb = c.maxSizeKb; if (c.type === 'Image' && c.isPrimaryImage) o.isPrimaryImage = true; break;
    case 'AutoNumber': if (c.autoNumberFormat) o.autoNumberFormat = c.autoNumberFormat; break;
  }
  if (c.source === 'Calculated' || c.source === 'Rollup') { o.sourceType = c.source; if (c.formula) o.formulaDefinition = c.formula; }
  return o;
}

function choiceOptions(col) {
  return (col.options || []).map((label, i) => ({ value: 100000000 + i, label }));
}

const STATE_CODE = { Active: 0, Inactive: 1 };

class BuildHalt extends Error {
  constructor(message, { phase, code, recoverable = false, cause } = {}) {
    super(message);
    this.name = 'BuildHalt';
    this.phase = phase;
    this.code = code;
    this.recoverable = recoverable;
    this.cause = cause;
  }
}

// A metadata create that fails because the component already exists (the classic re-run
// case). Dataverse answers 409, or 400 with a duplicate-name message. Used to make
// otherwise non-idempotent creates (e.g. alternate keys — the SDK has no key lister) safe
// to re-run: the build skips instead of halting. Kept deliberately narrow so a genuine
// failure (bad key attribute, etc.) still surfaces.
function isAlreadyExists(err) {
  if (!err) return false;
  const status = err.statusCode || err.status || (err.cause && (err.cause.statusCode || err.cause.status));
  if (status === 409) return true;
  const msg = String((err && err.message) || '').toLowerCase();
  return /already exists|duplicate|with the (?:specified|same) name|a key with/.test(msg);
}

// Bounded-concurrency map — parallelize independent ops without flooding Dataverse (which
// raises SQL-deadlock risk). Preserves input order in the result.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// A Runner owns the emit/counter/BuildHalt machinery so both consumers produce the
// identical { phase, status, label, n, total } event stream. `total` is supplied by the
// consumer (each computes its own plan length), so counting stays consumer-scoped.
function makeRunner({ emit, total }) {
  let n = 0;
  const run = async (phase, label, fn, { recoverable = false, skipIf } = {}) => {
    const myN = (n += 1);
    emit({ phase, status: 'start', label, n: myN, total });
    try {
      const out = await fn();
      emit({ phase, status: 'ok', label, n: myN, total });
      return out;
    } catch (err) {
      // Idempotency escape hatch: a create that fails only because the component already
      // exists is a skip, not a halt (used where the SDK offers no check-first lister).
      if (skipIf && skipIf(err)) { emit({ phase, status: 'skip', label: `${label} (exists)`, n: myN, total }); return undefined; }
      emit({ phase, status: 'error', label, n: myN, total, detail: String((err && err.message) || err) });
      throw new BuildHalt(`${phase} failed: ${(err && err.message) || err}`, { phase, code: (err && err.code) || 'sdk-error', recoverable, cause: err });
    }
  };
  const skip = (phase, label) => { emit({ phase, status: 'skip', label, n: (n += 1), total }); };
  return { run, mapLimit, skip, emit, total };
}

// Discover-then-create the solution + publisher (idempotent). No-op emit-wise if present.
async function provisionSolution({ sdk, provision, runner, solution }) {
  await runner.run('solution', `solution ${solution.uniqueName}`, async () => {
    const existing = await provision.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${solution.uniqueName}'`, top: 1 });
    if (existing && existing[0]) return;
    let publisherId;
    const pubs = await provision.queryRecords('publisher', { select: ['publisherid'], filter: `customizationprefix eq '${solution.publisherPrefix}'`, top: 1 });
    if (pubs && pubs[0] && pubs[0].publisherid) publisherId = pubs[0].publisherid;
    else publisherId = (await provision.createPublisher({ uniqueName: `${solution.publisherPrefix}publisher`, friendlyName: `${solution.publisherPrefix} publisher`, prefix: solution.publisherPrefix })).id;
    await provision.createSolution({ uniqueName: solution.uniqueName, friendlyName: solution.displayName || solution.uniqueName, publisherId });
  }, { recoverable: true });
}

// Discover-then-create global choices, tables, columns, status reasons, alternate keys,
// and relationships (idempotent). Returns captured maps used by sample data + later phases.
async function provisionDataModel({ sdk, provision, runner, spec, apply, concurrency }) {
  const result = { entities: {}, globalChoiceIds: {}, statusReasonValues: {}, columns: {}, relationships: [] };
  
  const globalChoiceIds = result.globalChoiceIds;
  const statusReasonValues = result.statusReasonValues;
  
  // 2a. Global option sets (shared choices) — built before columns that bind to them.
  for (const gc of spec.globalChoices || []) {
    await runner.run('data-model', `global choice ${gc.name}`, async () => {
      try {
        const r = await sdk.createGlobalOptionSet({ name: gc.name, displayName: gc.displayName || gc.name, options: (gc.options || []).map((label, i) => ({ value: 100000000 + i, label })) });
        globalChoiceIds[gc.name] = r.metadataId;
      } catch (e) { /* already exists — a fresh column binding falls back to inline options (idempotent global-choice lookup is a follow-up SDK method) */ }
    });
  }
  
  // 2b. Tables -> columns (all types + customer) -> status reasons -> alternate keys.
  for (const e of spec.entities) {
    const logical = e.schemaName.toLowerCase();
    const hits = await provision.findTables(e.schemaName, { top: 50 });
    const existingTable = (hits || []).find((t) => t.logicalName === logical);
    let existingCols = new Set();
    if (existingTable) {
      runner.skip('data-model', `table ${e.schemaName} (exists — reuse)`);
      result.entities[e.schemaName] = { logicalName: logical, entitySetName: existingTable.entitySetName };
      existingCols = new Set(((await provision.findColumns(logical)) || []).map((c) => c.logicalName));
    } else {
      await runner.run('data-model', `table ${e.schemaName}`, async () => {
        const createOpts = { schemaName: e.schemaName, displayName: e.displayName, pluralName: e.pluralName || `${e.displayName}s`,
          primaryColumnSchemaName: e.primaryAttribute.schemaName, primaryColumnDisplayName: e.primaryAttribute.displayName || 'Name', hasNotes: e.hasNotes === true };
        // AutoNumber the primary/title column when requested (the order number IS the identity).
        if (e.primaryAttribute.autoNumberFormat) createOpts.primaryColumnAutoNumberFormat = e.primaryAttribute.autoNumberFormat;
        const t = await sdk.createTable(createOpts);
        result.entities[e.schemaName] = { logicalName: (t.logicalName || logical), entitySetName: t.entitySetName, metadataId: t.metadataId };
      }, { recoverable: true });
    }
    // columns: every buildable column (all scalar types + Customer; Lookup comes from a
    // relationship). Existing ones emit a skip; missing ones are created (parallel, bounded).
    const buildable = (e.columns || []).filter((c) => SDK_COLUMN_TYPE[c.type || 'Text'] || c.type === 'Customer');
    for (const c of buildable) if (existingCols.has(c.schemaName.toLowerCase())) runner.skip('data-model', `column ${e.schemaName}.${c.schemaName} (exists)`);
    const toCreate = buildable.filter((c) => !existingCols.has(c.schemaName.toLowerCase()));
    const colResults = await runner.mapLimit(toCreate, concurrency, (c) => runner.run('data-model', `column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`,
      () => c.type === 'Customer'
        ? sdk.createCustomerColumn(logical, { schemaName: c.schemaName, displayName: c.displayName || c.schemaName, required: REQUIRED(c) })
        : sdk.createColumn(logical, columnOptions(c, globalChoiceIds))));
    // Capture real column results (logicalName + metadataId)
    toCreate.forEach((c, i) => {
      const res = colResults[i];
      if (res) {
        (result.columns[e.schemaName] = result.columns[e.schemaName] || []).push({
          schemaName: c.schemaName,
          logicalName: res.logicalName || c.schemaName.toLowerCase(),
          metadataId: res.metadataId
        });
      }
    });
    // custom status reasons — capture the option value so sample data can set them. IDEMPOTENT:
    // insertStatusValue itself is not (with no explicit Value, Dataverse auto-assigns a NEW value
    // every call, duplicating the reason on a data-model re-run). So we PIN a deterministic value
    // (publisher range 100000000+i, matching how the engine assigns choice/global option values;
    // authors may override via sr.value) and pass it explicitly: a re-run then hits an already-exists
    // error that skipIf turns into a skip (no duplicate), while the value stays captured for sample
    // data. On a fresh insert we overwrite with the server-returned value (authoritative).
    let srIdx = 0;
    for (const sr of e.statusReasons || []) {
      const stateCode = STATE_CODE[sr.state] !== undefined ? STATE_CODE[sr.state] : 0;
      const pinned = typeof sr.value === 'number' ? sr.value : 100000000 + srIdx;
      srIdx += 1;
      (statusReasonValues[logical] = statusReasonValues[logical] || {})[sr.label] = { value: pinned, stateCode };
      await runner.run('data-model', `status reason ${e.schemaName}: ${sr.label}`, async () => {
        const v = await sdk.insertStatusValue(logical, { label: sr.label, stateCode, color: sr.color, value: pinned });
        statusReasonValues[logical][sr.label] = { value: typeof v === 'number' ? v : pinned, stateCode };
      }, { recoverable: true, skipIf: isAlreadyExists });
    }
    // alternate keys — idempotent: the SDK has no key lister, so a re-run that hits an
    // already-exists error is treated as a skip (not a halt) via skipIf.
    for (const k of e.alternateKeys || []) {
      await runner.run('data-model', `alt key ${e.schemaName}.${k.schemaName}`,
        () => sdk.createAlternateKey(logical, { schemaName: k.schemaName, displayName: k.displayName || k.schemaName, keyAttributes: (k.columns || []).map((x) => x.toLowerCase()) }),
        { recoverable: true, skipIf: isAlreadyExists });
    }
  }
  
  // 2c. Relationships — 1:N and N:N; skip those already present.
  for (const rel of spec.relationships || []) {
    if (rel.type === 'OneToMany') {
      const schema = relationshipSchemaName(rel);
      let exists = false;
      try { exists = ((await provision.fetchEntityMetadata(rel.referenced.toLowerCase())).relationships || []).some((r) => r.schemaName.toLowerCase() === schema.toLowerCase()); } catch { /* just created */ }
      if (exists) { runner.skip('data-model', `relationship ${schema} (exists)`); continue; }
      await runner.run('data-model', `relationship 1:N ${rel.referenced}->${rel.referencing}`, async () => {
        const res = await sdk.createRelationship({ type: 'OneToMany', schemaName: schema, referencedEntity: rel.referenced.toLowerCase(), referencingEntity: rel.referencing.toLowerCase(), lookupSchemaName: rel.lookup.schemaName, lookupDisplayName: rel.lookup.displayName });
        result.relationships.push({
          schemaName: res.schemaName || schema,
          metadataId: res.metadataId,
          kind: '1n',
          lookupLogicalName: res.lookupLogicalName
        });
      });
    } else if (rel.type === 'ManyToMany') {
      const schema = rel.schemaName || `${rel.entity1.toLowerCase()}_${rel.entity2.toLowerCase()}`;
      let exists = false;
      try { exists = ((await provision.fetchEntityMetadata(rel.entity1.toLowerCase())).relationships || []).some((r) => r.schemaName.toLowerCase() === schema.toLowerCase()); } catch { /* just created */ }
      if (exists) { runner.skip('data-model', `relationship ${schema} (exists)`); continue; }
      await runner.run('data-model', `relationship N:N ${rel.entity1}<->${rel.entity2}`, async () => {
        const res = await sdk.createRelationship({ type: 'ManyToMany', schemaName: schema, entity1: rel.entity1.toLowerCase(), entity2: rel.entity2.toLowerCase(), intersectEntityName: rel.intersectEntityName });
        result.relationships.push({
          schemaName: res.schemaName || schema,
          metadataId: res.metadataId,
          kind: 'nn'
        });
      });
    }
  }
  
  return result;
}

// Factory for entity-set resolver: fresh tables cached in `entities` (from data-model
// phase); existing ones via fetchEntityMetadata. Returns async (logical) => entitySetName.
function makeEntitySetResolver({ spec, entities, provision }) {
  const entitySetCache = {};
  return async (logical) => {
    const ent = entityByLogical(spec, logical);
    const cached = ent && entities[ent.schemaName] && entities[ent.schemaName].entitySetName;
    if (cached) return cached;
    if (!entitySetCache[logical]) entitySetCache[logical] = (await provision.fetchEntityMetadata(logical)).entitySetName;
    return entitySetCache[logical];
  };
}

// Create sample rows topologically, binding $parent/$parents via @odata.bind. Needs the
// captured maps from provisionDataModel.
async function provisionSampleData({ sdk, provision, runner, spec, dataModel }) {
  const result = { records: {} };
  const entities = dataModel.entities;
  const statusReasonValues = dataModel.statusReasonValues;
  
  // entity-set resolver: fresh tables cached above; existing ones via fetchEntityMetadata.
  const entitySetFor = makeEntitySetResolver({ spec, entities, provision });
  
  const createdByEntity = {};
  for (const e of topoOrderEntities(spec)) {
    const records = sampleRecordsFor(spec, e);
    if (!records.length) continue;
    await runner.run('sample-data', `${records.length} record(s) -> ${e.schemaName}`, async () => {
      const entityLogical = e.schemaName.toLowerCase();
      const resolved = resolveSampleRecords(e, records, spec);
      const bodies = [];
      const matchHit = (parentLogical, match) => (createdByEntity[parentLogical] || []).find((h) => Object.entries(match).every(([k, val]) => { const rk = Object.keys(h.raw).find((x) => x.toLowerCase() === k.toLowerCase()); return rk !== undefined && h.raw[rk] === val; }));
      for (let i = 0; i < resolved.length; i++) {
        const raw = records[i];
        const body = Object.assign({}, resolved[i]);
        delete body.$parent; delete body.$parents; delete body.statusReason;
        // Parent lookups — one (`$parent`) or many (`$parents`, e.g. a junction row binding
        // both sides). Each is bound to its relationship's lookup nav property via @odata.bind.
        const parents = [].concat(raw && raw.$parent ? [raw.$parent] : [], (raw && raw.$parents) || []);
        for (const parent of parents) {
          if (!parent || !parent.entity || !parent.match) continue;
          const parentLogical = parent.entity.toLowerCase();
          const hit = matchHit(parentLogical, parent.match);
          const rel = relationshipFor(spec, parent.entity, e.schemaName);
          if (hit && hit.id && rel) body[`${rel.lookup.schemaName}@odata.bind`] = `/${await entitySetFor(parentLogical)}(${hit.id})`;
        }
        // Custom status reason -> statecode + the captured statuscode option value. The
        // value is captured during the data-model phase (insertStatusValue); if that phase
        // was skipped this run, the value is unknown — halt loudly instead of silently
        // inserting the record with a default status (the live foot-gun behind this guard).
        if (raw && raw.statusReason) {
          const sv = (statusReasonValues[e.schemaName.toLowerCase()] || {})[raw.statusReason];
          if (!sv) throw new Error(`record sets statusReason '${raw.statusReason}' on ${e.schemaName}, but its status value wasn't captured — include the data-model phase (don't --skip data-model) so the custom status reason is created and its option value captured`);
          body.statuscode = sv.value; body.statecode = sv.stateCode;
        }
        bodies.push(body);
      }
      const ids = await sdk.createRecordsBulk(entityLogical, bodies);
      result.records[e.schemaName] = ids;
      createdByEntity[entityLogical] = records.map((raw, i) => ({ raw, id: ids[i] })).filter((p) => p.id != null);
    });
  }
  
  // Return entitySetFor closure so later phases can resolve entity-set names
  return { records: result.records, entitySetFor };
}

module.exports = { makeRunner, makeEntitySetResolver, provisionSolution, provisionDataModel, provisionSampleData, BuildHalt, SDK_COLUMN_TYPE };
