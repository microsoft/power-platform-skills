'use strict';
// Shared entity-provisioning core: solution + data-model + sample-data phase logic
// extracted from sdk-build.js for reuse by /genpage and /app-builder.
//
// makeRunner() owns the emit/counter/BuildHalt machinery so both consumers produce
// identical { phase, status, label, n, total } event streams.

const {
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  relationshipSchemaName,
  manyToManySchemaName,
  quickCreateEnabledFor,
} = require('./app-spec.js');
const { topoOrderEntities, entityByLogical } = require('./_graph.js');
// OData string-literal escaping for spec-controlled values interpolated into $filter (a solution
// uniquename / publisher prefix with a `'` would otherwise break the query or inject a clause).
const { odataLit } = require('./odata.js');

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
function columnOptions(c, globalChoiceIds, globalChoices) {
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
      if (c.globalChoice && globalChoiceIds[c.globalChoice]) { o.globalChoiceMetadataId = globalChoiceIds[c.globalChoice]; }
      // Defensive fallback: the global choice exists but its metadataId wasn't captured. With the now
      // IDEMPOTENT createGlobalOptionSet (probe-then-reuse returns the existing id), the primary branch
      // above normally fires on both a fresh build AND a re-run — a real create failure halts the phase
      // before we get here. This branch is a belt-and-suspenders guard (e.g. a success that somehow
      // returned no id): a globalChoice column carries no inline options of its own, so fall back to the
      // global choice's DECLARED options (same values the engine assigns) so the column still builds.
      else if (c.globalChoice) { const gc = (globalChoices || []).find((g) => g.name === c.globalChoice); o.options = choiceOptions(gc ? { options: gc.options } : c); }
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
  // "already exist" (no trailing 's') also catches the plural table-create message
  // "Entities already exist: <name>" that Dataverse returns on a transient-retry duplicate.
  return /already exist|duplicate|with the (?:specified|same) name|a key with/.test(msg);
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

// Route every artifact push (form/view/chart/app/command/dashboard) through this. The SDK's
// pushArtifact RESOLVES (it does NOT throw) with { success:false, error:VersionConflictError } on a
// 412 — the artifact changed in Maker since our last fetch. The engine previously ignored push
// results, so a conflict silently reported success while DROPPING the edit. Halt loudly and require
// a fresh download instead of auto refetch-and-overlay (which would clobber a concurrent Maker edit
// and violates the SDK's rebuild-from-model tenet, architecture-spec T6). A 412 is the only failure
// pushArtifact signals by return value; every other failure still throws. See MakerSdk.pushArtifact.
function requireSuccessfulPush(result, what) {
  if (result && result.success === false) {
    const detail = (result.error && result.error.message) || 'version conflict (412)';
    throw new BuildHalt(
      `push ${what || (result && result.type) || 'artifact'} failed: ${detail} — the artifact changed in Maker since it was fetched; re-download the app and rebuild (never overwrite a concurrent edit)`,
      { phase: 'push', code: 'version-conflict', recoverable: true, cause: result && result.error }
    );
  }
  return result;
}

// Discover-then-create the solution + publisher (idempotent). No-op emit-wise if present.
async function provisionSolution({ sdk, provision, runner, solution }) {
  await runner.run('solution', `solution ${solution.uniqueName}`, async () => {
    const existing = await provision.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${odataLit(solution.uniqueName)}'`, top: 1 });
    if (existing && existing[0]) return;
    let publisherId;
    const pubs = await provision.queryRecords('publisher', { select: ['publisherid'], filter: `customizationprefix eq '${odataLit(solution.publisherPrefix)}'`, top: 1 });
    if (pubs && pubs[0] && pubs[0].publisherid) publisherId = pubs[0].publisherid;
    else publisherId = (await provision.createPublisher({ uniqueName: `${solution.publisherPrefix}publisher`, friendlyName: `${solution.publisherPrefix} publisher`, prefix: solution.publisherPrefix })).id;
    await provision.createSolution({ uniqueName: solution.uniqueName, friendlyName: solution.displayName || solution.uniqueName, publisherId });
  }, { recoverable: true });
}

// Discover-then-create global choices, tables, columns, status reasons, alternate keys,
// and relationships (idempotent). Returns captured maps used by sample data + later phases.
async function provisionDataModel({ sdk, provision, runner, spec, apply }) {
  const result = { entities: {}, globalChoiceIds: {}, statusReasonValues: {}, columns: {}, relationships: [] };
  
  const globalChoiceIds = result.globalChoiceIds;
  const statusReasonValues = result.statusReasonValues;
  
  // 2a. Global option sets (shared choices) — built before columns that bind to them. The SDK's
  // createGlobalOptionSet is now IDEMPOTENT: it probes by Name and REUSES an existing set (returning
  // its MetadataId) instead of failing a duplicate-Name POST. So a rerun captures the existing set's
  // id here — fixing the old bug where the catch swallowed "already exists" and left the id undefined,
  // which forced every column on a rebuild to fall back to inline options (roadmap: global-choice
  // find-by-name). A GENUINE failure (400 validation / auth) now surfaces as a clean phase failure via
  // runner.run instead of being silently swallowed.
  for (const gc of spec.globalChoices || []) {
    await runner.run('data-model', `global choice ${gc.name}`, async () => {
      const r = await sdk.createGlobalOptionSet({ name: gc.name, displayName: gc.displayName || gc.name, options: (gc.options || []).map((label, i) => ({ value: 100000000 + i, label })) });
      globalChoiceIds[gc.name] = r.metadataId;
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
        try {
          const t = await sdk.createTable(createOpts);
          result.entities[e.schemaName] = { logicalName: (t.logicalName || logical), entitySetName: t.entitySetName, metadataId: t.metadataId };
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
          // First POST likely succeeded server-side; a transient-network retry hit "already exists".
          // Rediscover to capture entitySetName (required by later phases).
          const rehits = await provision.findTables(e.schemaName, { top: 50 });
          const found = (rehits || []).find((x) => x.logicalName === logical);
          if (!found) throw err;
          result.entities[e.schemaName] = { logicalName: logical, entitySetName: found.entitySetName };
        }
      }, { recoverable: true });
    }
    // Enable "Allow quick create" on the table when the spec opts in (explicit `entities[].quickCreate`
    // OR an authored `formType: 'QuickCreate'` form — see quickCreateEnabledFor). Runs for BOTH a fresh
    // and an existing table and is idempotent: `IsQuickCreateEnabled` is a plain Edm.Boolean flag, so
    // re-PUTting the same value is a Dataverse no-op. The flag alone does NOT author a form — a table
    // with a Quick Create form (the build authors those via formType) needs this flag for the inline
    // "+ New" (from a lookup / sub-grid) to surface that form instead of coming up empty.
    if (quickCreateEnabledFor(spec, e)) {
      await runner.run('data-model', `enable quick create on ${logical}`, async () => {
        await sdk.updateTable(logical, { quickCreateEnabled: true });
      });
    }
    // columns: every buildable column (all scalar types + Customer; Lookup comes from a
    // relationship). Existing ones emit a skip; missing ones are created SERIALLY: Dataverse
    // takes a per-entity exclusive [EntityCustomization] lock, so two Attribute POSTs on the
    // same table collide with HTTP 429 ("Cannot start another [EntityCustomization]..."). The
    // outer entity loop is already sequential, so serial columns here means one metadata
    // customization is in flight per entity at a time — the only order Dataverse permits.
    const buildable = (e.columns || []).filter((c) => SDK_COLUMN_TYPE[c.type || 'Text'] || c.type === 'Customer');
    for (const c of buildable) if (existingCols.has(c.schemaName.toLowerCase())) runner.skip('data-model', `column ${e.schemaName}.${c.schemaName} (exists)`);
    const toCreate = buildable.filter((c) => !existingCols.has(c.schemaName.toLowerCase()));
    const colResults = await runner.mapLimit(toCreate, 1, (c) => runner.run('data-model', `column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`,
      () => c.type === 'Customer'
        ? sdk.createCustomerColumn(logical, { schemaName: c.schemaName, displayName: c.displayName || c.schemaName, required: REQUIRED(c) })
        : sdk.createColumn(logical, columnOptions(c, globalChoiceIds, spec.globalChoices)),
      { skipIf: isAlreadyExists }));
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
  
  // 2c. Relationships — 1:N and N:N; skip those already present. The publisher prefix is threaded
  //     into the schema-name defaulting so a relationship to a standard/system table gets a valid,
  //     prefixed name Dataverse accepts (see prefixedRelationshipName).
  const publisherPrefix = spec.solution && spec.solution.publisherPrefix;
  for (const rel of spec.relationships || []) {
    if (rel.type === 'OneToMany') {
      const schema = relationshipSchemaName(rel, publisherPrefix);
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
      }, { skipIf: isAlreadyExists });
    } else if (rel.type === 'ManyToMany') {
      const schema = manyToManySchemaName(rel, publisherPrefix);
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
      }, { skipIf: isAlreadyExists });
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

// Case-insensitive key/value match of a parent sample record against a $parent.match criteria.
function matchesRecord(rec, match) {
  return Object.entries(match).every(([k, val]) => {
    const rk = Object.keys(rec).find((x) => x.toLowerCase() === k.toLowerCase());
    return rk !== undefined && rec[rk] === val;
  });
}

// Translate an entity's author-friendly sample records into a seedRecordGraph group: resolve
// choice labels to option ints (resolveSampleRecords), strip the $parent/$parents/statusReason
// sentinels from the body, translate each $parent/$parents.match into a parentIndex bind on the
// relationship's lookup nav property, and resolve a custom statusReason into statuscode/statecode
// (halting if its option value wasn't captured during the data-model phase). The SDK's
// seedRecordGraph owns the @odata.bind URL formation and resolve-by-name idempotency.
// Choose the seedRecordGraph idempotency key (matchOn) for an entity's sample rows. The SDK dedups /
// reuses an existing row ONLY when matchOn is supplied, and it NEVER falls back to the primary
// display name — Dataverse permits duplicate names, so name-based resolve is a silent-wrong-id bug
// (see types/recordGraph.ts `SeedEntityGroup.matchOn`). To keep the old resolve-by-name idempotency
// WITHOUT regressing correctness:
//   1. prefer a single-column ALTERNATE KEY (Dataverse enforces its uniqueness — a safe key);
//   2. else fall back to the primary NAME column (the key the retired `primaryAttribute` used), which
//      carries the documented duplicate-name risk but preserves prior behavior;
// and in BOTH cases only when EVERY seeded record has a non-empty value for the chosen key — otherwise
// omit matchOn (insert every record, no dedup) rather than resolve on a partially-empty key, which
// would collapse or mis-bind rows. `body` values are the resolved Web-API values the SDK will filter on.
function chooseMatchOn(e, seedRecords) {
  const hasNonEmpty = (attr) =>
    seedRecords.length > 0 &&
    seedRecords.every((r) => { const v = r.body[attr]; return v !== undefined && v !== null && v !== ''; });
  for (const k of e.alternateKeys || []) {
    const cols = (k.columns || []).map((c) => String(c).toLowerCase());
    if (cols.length === 1 && hasNonEmpty(cols[0])) return cols[0];
  }
  const primary = e.primaryAttribute.schemaName.toLowerCase();
  if (hasNonEmpty(primary)) return primary;
  return undefined;
}

function buildSeedGroup({ spec, e, records, statusReasonValues }) {
  const resolved = resolveSampleRecords(e, records, spec);
  const seedRecords = [];
  for (let i = 0; i < resolved.length; i++) {
    const raw = records[i];
    const body = Object.assign({}, resolved[i]);
    delete body.$parent; delete body.$parents; delete body.statusReason;
    // Parent lookups — one (`$parent`) or many (`$parents`, e.g. a junction row binding both
    // sides). Each resolves to the parent's index within its own sample-record list; the SDK maps
    // that index to the created id and emits `<lookup>@odata.bind`.
    const binds = [];
    const parents = [].concat(raw && raw.$parent ? [raw.$parent] : [], (raw && raw.$parents) || []);
    for (const parent of parents) {
      if (!parent || !parent.entity || !parent.match) continue;
      const rel = relationshipFor(spec, parent.entity, e.schemaName);
      const parentEntity = entityByLogical(spec, parent.entity);
      // #1: fail loud on a bind that can't be formed instead of silently dropping it (which created
      // the child with the lookup UNSET and still reported success). validateAppSpec catches these at
      // lint time; this is the runtime backstop for a build that skipped validation. runner.run (the
      // caller) turns the throw into a clean sample-data phase failure.
      if (!rel || !parentEntity) {
        throw new Error(`sample data for '${e.schemaName}' declares a parent on '${parent.entity}' with no OneToMany relationship to it — fix the spec's $parent/$parents`);
      }
      const parentIndex = sampleRecordsFor(spec, parentEntity).findIndex((pr) => matchesRecord(pr, parent.match));
      if (parentIndex < 0) {
        throw new Error(`sample data for '${e.schemaName}': parent match ${JSON.stringify(parent.match)} found no '${String(parent.entity).toLowerCase()}' sample record — the '${rel.lookup.schemaName}' lookup would be left unset`);
      }
      binds.push({ navProperty: rel.lookup.schemaName, parentEntity: parent.entity.toLowerCase(), parentIndex });
    }
    // Custom status reason -> statecode + the captured statuscode option value. The value is
    // captured during the data-model phase (insertStatusValue); if that phase was skipped this run
    // the value is unknown — halt loudly instead of silently inserting a default status.
    if (raw && raw.statusReason) {
      const sv = (statusReasonValues[e.schemaName.toLowerCase()] || {})[raw.statusReason];
      if (!sv) throw new Error(`record sets statusReason '${raw.statusReason}' on ${e.schemaName}, but its status value wasn't captured — include the data-model phase (don't --skip data-model) so the custom status reason is created and its option value captured`);
      body.statuscode = sv.value; body.statecode = sv.stateCode;
    }
    seedRecords.push({ body, binds });
  }
  // matchOn (opt-in) replaces the retired `primaryAttribute`; see chooseMatchOn for the key policy.
  const matchOn = chooseMatchOn(e, seedRecords);
  return { entityLogical: e.schemaName.toLowerCase(), ...(matchOn ? { matchOn } : {}), records: seedRecords };
}

// Create sample rows topologically via the SDK's record-graph seeder. The plugin owns the App
// Spec translation (buildSeedGroup); the SDK owns @odata.bind formation and resolve-by-name
// idempotency. Groups are seeded one entity at a time (preserving the per-entity progress emit),
// with the accumulated createdIds threaded through so a child can bind to an already-seeded parent.
async function provisionSampleData({ sdk, provision, runner, spec, dataModel }) {
  const result = { records: {} };
  const entities = dataModel.entities;
  const statusReasonValues = dataModel.statusReasonValues;

  // entity-set resolver: fresh tables cached above; existing ones via fetchEntityMetadata.
  const entitySetFor = makeEntitySetResolver({ spec, entities, provision });

  const createdIds = {}; // logical -> ids (accumulator across entities for parent-bind resolution)
  for (const e of topoOrderEntities(spec)) {
    const records = sampleRecordsFor(spec, e);
    if (!records.length) continue;
    await runner.run('sample-data', `${records.length} record(s) -> ${e.schemaName}`, async () => {
      const group = buildSeedGroup({ spec, e, records, statusReasonValues });
      // F9: seeding is idempotent ONLY when a matchOn key is chosen (chooseMatchOn). Without one the SDK
      // inserts every row, so a re-run — or a POST retried after a commit — DUPLICATES the sample data,
      // violating the build's "full rerun is safe" contract. A fresh build is fine; warn (non-fatal, to
      // stderr — same pattern as download-model-app) so the maker can add a single-column alternate key or
      // unique <primary> values before relying on re-runs. This is additive: it does NOT change the seed
      // group, the create call, or the error/halt path — only emits a warning line for a keyless group.
      if (!group.matchOn && group.records.length > 0) {
        process.stderr.write(`WARNING: sample rows for ${e.schemaName} have no idempotency key (no single-column alternate key, and not every row has a non-empty ${e.primaryAttribute.schemaName}) — a re-run or a retried insert will DUPLICATE these ${group.records.length} row(s). Add a single-column alternate key or give every row a unique ${e.primaryAttribute.schemaName} value.\n`);
      }
      const { createdIds: made } = await sdk.seedRecordGraph([group], { entitySetFor, createdIds });
      Object.assign(createdIds, made);
      result.records[e.schemaName] = made[e.schemaName.toLowerCase()];
    });
  }

  // Return entitySetFor closure so later phases can resolve entity-set names
  return { records: result.records, entitySetFor };
}

module.exports = { makeRunner, requireSuccessfulPush, makeEntitySetResolver, provisionSolution, provisionDataModel, provisionSampleData, buildSeedGroup, BuildHalt, SDK_COLUMN_TYPE };
