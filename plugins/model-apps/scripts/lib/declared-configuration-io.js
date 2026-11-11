'use strict';
// The explicit managed download's restore of protected configuration (configurationIdentity "stable-v1"): each item a committed
// configuration group of the build's binding store holds is written back into its App Spec list as a declaration that rebuilds as
// no change, and every other is named. Nothing here writes, binds or publishes.
//
// Why this is not a copy of what the build was given. A configuration group keeps no declaration (the binding store records the
// rows, their ids and the projections the build proved), so the declaration is rebuilt from the rows as they are now, and it is
// accepted only when the build's own read-only oracle says a rebuild of it changes nothing (configuration-protected.js
// restoreProofOf): the same exact location, plan and judgment as a build's preflight, and every bound row still reading as the
// projection the build committed for it. A row changed outside the plugin since is left out rather than downloaded as if the
// build had made it so.
//
// Privacy. These rows can hold values a download must never write: a variable's current value, its default and value schema (they
// can carry a URL, a key or a tenant's data), a connection reference's connection. They are read here IN MEMORY only, through the
// exact-id reader (configuration-create-bindings.js readConfigurationRow), never through the SDK's file-backed fetch (which caches
// the whole row into the workspace). A declaration names only the public fields; a part it leaves out is reported by name
// (`fields`), never by value, and is never written as a mask, an empty string or a null either: an omitted field is left as it is
// by a rebuild, while a written null would clear it.
const { normalizeGuid } = require('./reconcile-common.js');
const { readManagedFormFile } = require('./declared-form-io.js');
const B = require('./configuration-create-bindings.js');
const P = require('./configuration-protected.js');
const { omission } = require('./managed-restore-report.js');
const { compareVersions, isPluginVersion } = require('./app-spec.js');

const IDENTITY = 'stable-v1';
// The plugin floor of a restored protected item: exact ids, adopted children and the bound-value rules a no-settings rebuild relies
// on are the ones 2.25.0 ships; an older plugin would plan the same declaration differently.
const CONFIGURATION_RESTORE_MIN_VERSION = '2.25.0';
const floorOf = (current) => (isPluginVersion(current) && compareVersions(current, CONFIGURATION_RESTORE_MIN_VERSION) > 0 ? current : CONFIGURATION_RESTORE_MIN_VERSION);
const lc = (v) => String(v == null ? '' : v).toLowerCase();

// Each restored kind: its App Spec list and the field its store key is made from.
const LISTS = Object.freeze({
  environmentVariable: ['environmentVariables', 'schemaName'],
});

class Left extends Error {
  constructor(code, fields) {
    super(code);
    this.omitCode = code;
    if (fields) this.fields = fields;
  }
}
const leave = (code) => { throw new Left(code); };

/**
 * The store file's configuration groups, read once per restore, as { units: { <kind>: committedUnits }, manifest } — `manifest` in
 * the shape configuration-protected.js manifestStore reads, holding every configuration kind (a variable's parent is located through
 * its own group). The file must be this environment's, app's and solution's store (readManagedFormFile); anything else throws
 * `managed-manifest-unusable`.
 */
function readConfigurationStore(args) {
  const units = {};
  const manifest = { groups: [], pending: [], invalid: [] };
  for (const kind of ['environmentVariable', 'connectionReference', 'customApi', 'duplicateRule']) {
    const u = readManagedFormFile(args, kind);
    units[kind] = u;
    for (const [key, g] of u.groups) manifest.groups.push({ family: kind, key, records: g.records, generation: g.generation });
    for (const p of u.pending) manifest.pending.push({ family: kind, key: p.key });
    for (const p of u.invalid) manifest.invalid.push({ family: kind, key: p.key });
  }
  return { units, manifest };
}

// One exact-id read, in memory: present, or the omission its answer is.
async function readRow(dataverse, kind, id) {
  const got = await B.readConfigurationRow(dataverse, kind, id);
  if (got.state === 'absent') leave('missing');
  if (got.state !== 'present') leave('unread');
  return got;
}

// The environment variable's declaration from its definition row: schema name, type, labels and required flag, and for a data
// source its connector, parameter and the parent the store proves. Its default, value schema and value are never written.
async function declareVariable({ root, key, parentOf }) {
  const f = root.decoded.fields;
  if (f.type === 'secret') leave('secret-withheld');
  if (lc(f.schemaName) !== key) leave('changed');
  const declaration = { schemaName: f.schemaName, type: f.type };
  if (f.name != null) declaration.name = f.name;
  if (f.description != null) declaration.description = f.description;
  declaration.isRequired = f.isRequired === true;
  if (f.type === 'dataSource') {
    if (f.connectorId != null) declaration.connectorId = f.connectorId;
    if (f.parameterKey != null) declaration.parameterKey = f.parameterKey;
  }
  if (f.parentDefinitionId != null) {
    // Only a data source has a parent an App Spec can name, and only by a variable this download restores at exactly that row.
    if (f.type !== 'dataSource') leave('unsupported');
    const parent = await parentOf(f.parentDefinitionId);
    if (!parent) leave('parent-unproven');
    declaration.parentSchemaName = parent;
  }
  const fields = [];
  if (f.defaultValue != null) fields.push('defaultValue');
  if (f.valueSchema != null) fields.push('valueSchema');
  return { declaration, fields };
}

// A required variable with neither a default nor a value stops a rebuild as incomplete (configuration-artifacts.js
// runConfigurationStep, ENVIRONMENT_VARIABLE_VALUE_MISSING), so its declaration would not rebuild as no change; a download never fills
// one in to force a pass. The test is the build's own (observe): a default or a current value that is neither null nor ''.
function acceptVariable({ root, declaration, proof }) {
  const d = root.decoded.fields.defaultValue;
  if (declaration.isRequired && (d == null || d === '') && !proof.valueFilled) leave('required-value-missing');
}

const FAMILIES = Object.freeze({
  environmentVariable: { label: 'environment variable', declare: declareVariable, accept: acceptVariable },
});

/**
 * Restore one committed group: read its root (and, for a family with children, every child its binding holds) in memory, rebuild
 * the declaration, and accept it only when the protected oracle proves it (restoreProofOf) and the downloaded spec still validates
 * with it. Throws Left with the omission code otherwise. Answers { declaration, fields }.
 */
async function restoreItem(ctx, kind, key, group, extra = {}) {
  const [list, field] = LISTS[kind];
  const records = Array.isArray(group.records) ? group.records : [];
  const rootRecord = records.find((r) => r && r.kind === kind && r.key === key);
  const id = rootRecord ? normalizeGuid(rootRecord.id) : '';
  const consumer = group.consumerState;
  if (!id || !consumer || consumer.version !== 1 || !Array.isArray(consumer.rows)) leave('invalid');
  const root = await readRow(ctx.dataverse, kind, id);
  ctx.names.set(`${kind}\u0000${key}`, typeof root.decoded.fields.name === 'string' ? root.decoded.fields.name : undefined);
  const children = [];
  for (const r of records) {
    if (r === rootRecord) continue;
    const slot = P.slotOf(r);
    if (slot === null || !r || normalizeGuid(r.id) === '') leave('invalid');
    // A variable's value row holds nothing a declaration says; restoreProofOf accounts for it without its content.
    if (r.kind === 'environmentVariableValue') continue;
    children.push({ slot, record: r, read: await readRow(ctx.dataverse, r.kind, normalizeGuid(r.id)) });
  }
  const { declaration, fields } = await FAMILIES[kind].declare({ root, key, children, group, ...extra });
  const spec = ctx.spec;
  const candidate = {
    ...spec,
    [list]: [...(Array.isArray(spec[list]) ? spec[list] : []), declaration],
    configurationIdentity: IDENTITY,
    minimumPluginVersion: floorOf(spec.minimumPluginVersion),
  };
  const proof = await P.restoreProofOf({
    spec: candidate, manifest: ctx.manifest, dataverse: ctx.dataverse, solution: ctx.solutionUniqueName, kind, key: declaration[field], consumerRows: consumer.rows,
  });
  if (!proof.ok) leave(proof.code);
  if (FAMILIES[kind].accept) FAMILIES[kind].accept({ root, declaration, proof });
  const check = ctx.validate(candidate);
  if (!check || !check.ok) leave('invalid-in-spec');
  spec[list] = candidate[list];
  spec.configurationIdentity = candidate.configurationIdentity;
  spec.minimumPluginVersion = candidate.minimumPluginVersion;
  return { id, declaration, fields: [...fields, ...(proof.values ? ['value'] : [])] };
}

/**
 * The restore of one configuration kind into `ctx.spec` (mutated), every committed group in key order (a data-source variable after
 * the parent it names). Answers { restored: [{ key, id }], omitted: [omission], withheld: [omission] }: `withheld` names an item that
 * WAS restored without some of its parts (`fields`, never their values); it is not an omitted item.
 */
async function restoreKind(ctx, kind) {
  const { groups, pending, invalid } = ctx.units[kind];
  const label = FAMILIES[kind].label;
  const restored = [];
  const omitted = [
    ...pending.map((p) => omission({ kind: label, key: p.key, code: 'pending' })),
    ...invalid.map((p) => omission({ kind: label, key: p.key, code: 'invalid' })),
  ];
  const withheld = [];
  const done = new Map();
  const rootIdOf = (g) => {
    const r = (g.records || []).find((x) => x && x.kind === kind);
    return r ? normalizeGuid(r.id) : '';
  };
  const keyByRootId = new Map([...groups].map(([k, g]) => [rootIdOf(g), k]));
  // Depth-first so a parent variable is restored (and validated) before the child that names it. A key met again while its own
  // restore is still running is a parent cycle: neither end is proved.
  const visit = async (key) => {
    if (done.has(key)) return done.get(key);
    done.set(key, null);
    const group = groups.get(key);
    const parentOf = async (parentId) => {
      const parentKey = keyByRootId.get(normalizeGuid(parentId));
      return parentKey ? visit(parentKey) : null;
    };
    let result = null;
    try {
      const got = await restoreItem(ctx, kind, key, group, { parentOf });
      restored.push({ key, id: got.id });
      if (got.fields.length) withheld.push(omission({ kind: label, id: got.id, key, name: ctx.names.get(`${kind}\u0000${key}`), fields: got.fields, code: 'fields-withheld' }));
      result = got.declaration[LISTS[kind][1]];
    } catch (e) {
      if (!(e instanceof Left)) throw e;
      omitted.push(omission({ kind: label, id: rootIdOf(group), key, name: ctx.names.get(`${kind}\u0000${key}`), code: e.omitCode }));
    }
    done.set(key, result);
    return result;
  };
  for (const key of [...groups.keys()].sort()) await visit(key);
  return { restored, omitted, withheld };
}

/**
 * The explicit managed download's restore of protected configuration (--include-managed --managed-manifest <file>): environment
 * variables. A restored item also sets the spec's `configurationIdentity: "stable-v1"` (only a protected build keeps these groups, so
 * the store itself is the proof of the regime) with its plugin floor. Answers { environmentVariables } (restoreKind's shape); a store
 * file that cannot be used throws `managed-manifest-unusable` (readManagedFormFile).
 */
async function restoreManagedConfiguration({ sdk, spec, file, environment, appUniqueName, solutionUniqueName, validate }) {
  const { units, manifest } = readConfigurationStore({ file, environment, appUniqueName, solutionUniqueName });
  const ctx = { spec, units, manifest, dataverse: sdk.dataverse, solutionUniqueName, validate, names: new Map() };
  return {
    environmentVariables: await restoreKind(ctx, 'environmentVariable'),
  };
}

module.exports = { restoreManagedConfiguration, CONFIGURATION_RESTORE_MIN_VERSION };
