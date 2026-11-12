'use strict';

// Closed, flat create units for the default (non-protected) configuration path (#807).
//
// A default build used to hand every new environment variable, connection reference, Custom API and duplicate detection
// rule to the SDK as one deep insert with fresh random ids. When the answer to that insert was lost, a rerun could not tell
// whether the rows existed, so it either created them a second time or went on past an unknown outcome. This module turns
// each such create into a fixed set of single-row POST bodies at stable ids, built in memory before anything is sent, and
// answers the public (never private) description of them that a durable receipt can hold and a later GET can prove. It
// sends nothing and keeps no state on disk.
//
//   CONFIGURATION_CREATE_KIND_TABLE                    the closed per-row-kind table (fields, types, set, id column, binds)
//   CONFIGURATION_CREATE_RECEIPT_KIND_TABLE            its receipt view: { root, parentKinds, publicFields, privateFields }
//   validatePublicRow(kind, row)                       one public projection against its kind: closed keys, scalar types
//   publicIntentSha256(unit) / publicPlanSha256(unit)  the two public hashes of a unit (no private value, no dispatch state)
//   classifyConfigurationMutation(op, opts)            one planned root operation -> create unit, additions, existing route
//                                                      or a refusal naming its stop code
//   deriveConfigurationCreateIds(spec, opts)           the root's id (stable, or the existing row's) and its children's ids
//   captureConfigurationBaseline(dv, opts, ports)      the complete public baseline of an existing root (GET only)
//   compileConfigurationCreateUnit(spec, opts)         the unit: an opaque handle to the frozen bodies + its public rows
//   compiledRowRequest(handle, rowId) / compiledPublicationRequest(handle) / compiledUnitOf(handle)
//                                                      what the writer sends for a handle, and nothing else
//   publicProjectionFromPost(handle, rowId)            the public projection of the exact bytes a row is sent with
//   publicProjectionFromObserved(kind, observed)       the public projection of a row read back
//   validateRecordedCreateUnit(recorded, opts)         a stored unit's plan content, and whether the current one still matches
//
// Why the rows are built here and not by the SDK: the SDK's create planner allocates its own ids and nests children into
// their root's request, which is exactly the deep insert that cannot be recovered. Each constructor below builds a fresh,
// allowlisted object from the normalized artifact configuration-artifacts.js buildArtifact prepares (the input the SDK was
// handed before), with the same effective defaults the SDK's encoder fills; tests/configuration-create-plan.test.js holds
// every body to the bundled SDK's own payloads, with only the nesting split removed.
//
// This module may require configuration-artifacts.js and configuration-create-bindings.js at top level; neither of them
// may ever require this one (configuration-create-bindings.js requires configuration-artifacts.js at top level, so a
// require back into this module from there would see a half-built exports object).

const crypto = require('crypto');
const { canonicalJson, normalizeGuid } = require('./reconcile-common.js');
const { intentFor: defaultIntentFor } = require('./creates-capabilities.js');
const { createIntentCatalog } = require('./creates-port.js');
const A = require('./configuration-artifacts.js');
const B = require('./configuration-create-bindings.js');

// The stop codes a classification or a check names. This module only names them: the halts that carry them (retry: never,
// the bounded next step) are raised by the receipt and recovery modules.
const CODES = Object.freeze({
  mixedEdit: 'configuration-create-mixed-edit',
  intentChanged: 'configuration-create-intent-changed',
  shapeRefused: 'configuration-create-shape-refused',
  graphUnreadable: 'configuration-create-graph-unreadable',
  rowMissing: 'configuration-create-row-missing',
  stateInvalid: 'configuration-create-state-invalid',
});

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const lower = (v) => String(v).toLowerCase();
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const sha = (value) => crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const SHA256 = /^[0-9a-f]{64}$/;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------
// The kind table

// Public field types. 'guid' is a canonical lower-case GUID without braces (reconcile-common.js normalizeGuid); the
// nullable forms also admit null. 'nullable-integer' is a non-negative integer or null (a condition's character count).
const TYPES = new Set(['string', 'nullable-string', 'integer', 'nullable-integer', 'boolean', 'guid', 'nullable-guid']);

const LABELS = { name: 'nullable-string', displayName: 'nullable-string', description: 'nullable-string' };
const set = (bindingKind) => B.KINDS[bindingKind].set;
const pk = (bindingKind) => B.KINDS[bindingKind].pk;

// Keyed by the receipt's row-kind tags; the four roots are among them. Each entry:
//   root, parentKinds, childKinds          the containment a receipt allows
//   publicFields                           the closed public projection: field -> type (TYPES)
//   privateFields                          the fixed private classification of the kind. It names fields, never values,
//                                          and does not change with whether a value is set this run. A secret-typed
//                                          variable's Key Vault reference lives in the definition's default or the value
//                                          row's value, so both carry the `secretReference` class whatever the type.
//   bindingKind                            the kind's name in configuration-create-bindings.js KINDS (and the identity kinds)
//   entitySet, idColumn                    where a row is POSTed and its supplied id column
//   parentBind                             { key, set } of the @odata.bind a child row names its parent with, or null
//   solutionHeader                         whether the POST carries MSCRM.SolutionUniqueName. A value row never does: it is
//                                          per-environment data, and in a solution it would export this environment's value.
// The value bind and the Custom API child bind are the existing ones (configuration-create-bindings.js KINDS); a condition
// names its rule through `regardingobjectid`, the condition's lookup to the rule.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/duplicaterulecondition#BKMK_RegardingObjectId
const CONFIGURATION_CREATE_KIND_TABLE = deepFreeze({
  'env-definition': {
    root: true, parentKinds: [], childKinds: ['env-value'],
    publicFields: {
      schemaName: 'string', name: 'nullable-string', description: 'nullable-string', type: 'string', isRequired: 'boolean',
      connectorId: 'nullable-string', parameterKey: 'nullable-string', parentDefinitionId: 'nullable-guid', secretStore: 'nullable-string',
    },
    privateFields: ['defaultValue', 'valueSchema', 'secretReference'],
    bindingKind: 'environmentVariable', entitySet: set('environmentVariable'), idColumn: pk('environmentVariable'), parentBind: null, solutionHeader: true,
  },
  'env-value': {
    root: false, parentKinds: ['env-definition'], childKinds: [],
    publicFields: { parentId: 'guid' },
    privateFields: ['value', 'secretReference'],
    bindingKind: 'environmentVariableValue', entitySet: set('environmentVariableValue'), idColumn: pk('environmentVariableValue'),
    parentBind: { key: B.KINDS.environmentVariableValue.parentBind, set: B.KINDS.environmentVariableValue.parentSet }, solutionHeader: false,
  },
  'connection-reference': {
    root: true, parentKinds: [], childKinds: [],
    publicFields: { logicalName: 'string', name: 'nullable-string', description: 'nullable-string', connectorId: 'string', customConnectorId: 'nullable-guid' },
    privateFields: ['connectionId'],
    bindingKind: 'connectionReference', entitySet: set('connectionReference'), idColumn: pk('connectionReference'), parentBind: null, solutionHeader: true,
  },
  'custom-api': {
    root: true, parentKinds: [], childKinds: ['api-request', 'api-response'],
    publicFields: {
      uniqueName: 'string', ...LABELS, binding: 'string', boundEntityLogicalName: 'nullable-string', isFunction: 'boolean', isPrivate: 'boolean',
      allowedProcessingSteps: 'string', enabledForWorkflow: 'boolean', executePrivilegeName: 'nullable-string',
    },
    privateFields: [],
    bindingKind: 'customApi', entitySet: set('customApi'), idColumn: pk('customApi'), parentBind: null, solutionHeader: true,
  },
  'api-request': {
    root: false, parentKinds: ['custom-api'], childKinds: [],
    publicFields: { parentId: 'guid', uniqueName: 'string', ...LABELS, type: 'string', entityLogicalName: 'nullable-string', isOptional: 'boolean' },
    privateFields: [],
    bindingKind: 'customApiRequestParameter', entitySet: set('customApiRequestParameter'), idColumn: pk('customApiRequestParameter'),
    parentBind: { key: B.KINDS.customApiRequestParameter.parentBind, set: B.KINDS.customApiRequestParameter.parentSet }, solutionHeader: true,
  },
  'api-response': {
    root: false, parentKinds: ['custom-api'], childKinds: [],
    publicFields: { parentId: 'guid', uniqueName: 'string', ...LABELS, type: 'string', entityLogicalName: 'nullable-string' },
    privateFields: [],
    bindingKind: 'customApiResponseProperty', entitySet: set('customApiResponseProperty'), idColumn: pk('customApiResponseProperty'),
    parentBind: { key: B.KINDS.customApiResponseProperty.parentBind, set: B.KINDS.customApiResponseProperty.parentSet }, solutionHeader: true,
  },
  'duplicate-rule': {
    root: true, parentKinds: [], childKinds: ['rule-condition'],
    publicFields: {
      name: 'string', description: 'nullable-string', entityLogicalName: 'string', matchingEntityLogicalName: 'string',
      caseSensitive: 'boolean', excludeInactiveRecords: 'boolean',
    },
    privateFields: [],
    bindingKind: 'duplicateRule', entitySet: set('duplicateRule'), idColumn: pk('duplicateRule'), parentBind: null, solutionHeader: true,
  },
  'rule-condition': {
    root: false, parentKinds: ['duplicate-rule'], childKinds: [],
    publicFields: {
      parentId: 'guid', column: 'string', matchingColumn: 'string', match: 'string', characters: 'nullable-integer', ignoreBlankValues: 'boolean',
    },
    privateFields: [],
    bindingKind: 'duplicateRuleCondition', entitySet: set('duplicateRuleCondition'), idColumn: pk('duplicateRuleCondition'),
    parentBind: { key: 'regardingobjectid', set: B.KINDS.duplicateRuleCondition.parentSet }, solutionHeader: true,
  },
});

// The receipt's view of the kind table: per kind exactly { root, parentKinds, publicFields, privateFields }, the closed
// shape the receipt module validates a kind table against. Derived here, once, so the two can never drift apart.
const CONFIGURATION_CREATE_RECEIPT_KIND_TABLE = deepFreeze(Object.fromEntries(Object.entries(CONFIGURATION_CREATE_KIND_TABLE).map(([tag, k]) => [tag, {
  root: k.root, parentKinds: [...k.parentKinds], publicFields: { ...k.publicFields }, privateFields: [...k.privateFields],
}])));

const TAG_OF = Object.freeze(Object.fromEntries(Object.entries(CONFIGURATION_CREATE_KIND_TABLE).map(([tag, k]) => [k.bindingKind, tag])));
// A kind is named by its receipt tag or by its configuration kind ('environmentVariable', ...); both answer the tag.
function tagOf(kind) {
  if (typeof kind === 'string' && has(CONFIGURATION_CREATE_KIND_TABLE, kind)) return kind;
  if (typeof kind === 'string' && has(TAG_OF, kind)) return TAG_OF[kind];
  return null;
}
const ROOT_KEY_FIELD = Object.freeze({ environmentVariable: 'schemaName', connectionReference: 'logicalName', customApi: 'uniqueName', duplicateRule: 'key' });
// A child slot as the create port names it (configuration-artifacts.js configurationCreateIntents): 'value', 'request:<name>',
// 'response:<name>', or a condition's own key.
function childTagOf(rootTag, slot) {
  if (rootTag === 'env-definition') return 'env-value';
  if (rootTag === 'custom-api') return slot.startsWith('request:') ? 'api-request' : 'api-response';
  return 'rule-condition';
}

function typeOk(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'nullable-string': return v === null || typeof v === 'string';
    case 'integer': return Number.isSafeInteger(v);
    case 'nullable-integer': return v === null || (Number.isSafeInteger(v) && v >= 0);
    case 'boolean': return typeof v === 'boolean';
    case 'guid': return typeof v === 'string' && normalizeGuid(v) === v;
    case 'nullable-guid': return v === null || (typeof v === 'string' && normalizeGuid(v) === v);
    default: return false;
  }
}

/** One public projection against its kind: exactly the kind's fields, each of its type. Answers { ok: true } or { ok: false, reason }. */
function validatePublicRow(kind, row) {
  const tag = tagOf(kind);
  if (!tag) return { ok: false, reason: 'unknown row kind' };
  if (!isPlain(row) || Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null) return { ok: false, reason: 'not a plain object' };
  const fields = CONFIGURATION_CREATE_KIND_TABLE[tag].publicFields;
  for (const key of Object.keys(row)) if (!has(fields, key)) return { ok: false, reason: `unknown field ${key}` };
  for (const [field, type] of Object.entries(fields)) {
    if (!has(row, field)) return { ok: false, reason: `missing field ${field}` };
    if (!typeOk(type, row[field])) return { ok: false, reason: `field ${field} is not ${type}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Public hashes

const publicationRequiredOf = (unit) => (has(unit, 'publicationRequired') ? unit.publicationRequired === true : unit.publication != null);
const byKindKey = (a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const withoutParent = (pub) => Object.fromEntries(Object.entries(pub).filter(([f]) => f !== 'parentId'));

/**
 * The hash of what a unit is meant to create, independent of where: the root's identity, each new row's kind, key and
 * public projection without its containment parent id, and whether a new rule must be published. No id, no preserved row,
 * no dispatch state, no private value or anything derived from one. A unit is the compiled one (`unit` of
 * compileConfigurationCreateUnit) or a stored one of the same shape (`publication` stands for `publicationRequired`).
 * Row order and object key order do not change it (canonical JSON, rows sorted by kind and key).
 */
function publicIntentSha256(unit) {
  const rows = unit.rows.filter((r) => r.role === 'create').map((r) => ({ kind: r.kind, key: r.key, public: withoutParent(r.public) })).sort(byKindKey);
  return sha({ hash: 'configuration-create-intent/1', root: { kind: unit.root.kind, key: unit.root.key }, rows, publicationRequired: publicationRequiredOf(unit) });
}

/**
 * The hash of the whole public plan: the root, every row (preserved and new) with its id, key, parent and public
 * projection, and whether a new rule must be published. The mutable dispatch states (a row's `dispatch`, the publication's)
 * and the fixed private classifications are left out, so sealing or verifying a row never changes it.
 */
function publicPlanSha256(unit) {
  const rows = unit.rows.map((r) => ({ kind: r.kind, key: r.key, id: r.id, parentId: r.parentId, role: r.role, public: r.public })).sort(byKindKey);
  return sha({ hash: 'configuration-create-plan/1', root: { kind: unit.root.kind, key: unit.root.key, id: unit.root.id }, rows, publicationRequired: publicationRequiredOf(unit) });
}

// ---------------------------------------------------------------------------------------------
// Projections

// The public projection of one decoded row (configuration-create-bindings.js decode): its semantic fields (semanticOf:
// a condition's comparable form, a Key Vault secret store read as empty), picked by the kind's closed field list. Anything
// semanticOf adds that is not a public field — a connection reference's `connected`, derived from its private connection —
// is never picked. Answers null when a field is missing or of the wrong type.
function publicOf(tag, decoded, mode, parentId) {
  const k = CONFIGURATION_CREATE_KIND_TABLE[tag];
  const semantic = B.semanticOf(k.bindingKind, decoded, mode);
  const out = {};
  for (const field of Object.keys(k.publicFields)) {
    if (field === 'parentId') { out.parentId = parentId === undefined ? null : parentId; continue; }
    if (!has(semantic, field)) return null;
    out[field] = semantic[field];
  }
  return validatePublicRow(tag, out).ok ? out : null;
}

const RULE_BIND = /^\/duplicaterules\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/;

// A row read back may hold public state outside the closed projection: an environment variable's `hint`, `learnmoreurl` or
// `inputcontrolconfig`, a connection reference's `connectionparametersconfig` or `connectionparametersetconfig` (UNMODELLED:
// any value), or its `promptingbehavior` (defaulted: any value but the platform's 0). The decoder reports them
// (decoded.unmodelled, decoded.preserved); dropping them would make a customized row project equal to the create that
// never wrote them, and a baseline would lose them. So such a row cannot be represented and is refused, by column name
// only (never its value). The one exception is a Custom API's implementation lookup (`_plugintypeid_value`): the create
// never writes, plans or proves it, the default reader does not select it, and a caller's wider read may carry it.
// Answers the first such column, or null.
const NOT_PROJECTED = new Set(['_plugintypeid_value']);
function unrepresentableColumnOf(decoded) {
  const unmodelled = Array.isArray(decoded.unmodelled) ? decoded.unmodelled : [];
  if (unmodelled.length) return unmodelled[0];
  const preserved = isPlain(decoded.preserved) ? Object.keys(decoded.preserved).filter((col) => !NOT_PROJECTED.has(col)) : [];
  return preserved.length ? preserved[0] : null;
}

// The public projection of a POST body this module built, e.g. a condition:
//   { "duplicateruleconditionid": "<id>", "baseattributename": "EmailAddress1", "matchingattributename": "EmailAddress1",
//     "operatorcode": 0, "ignoreblankvalues": false, "regardingobjectid@odata.bind": "/duplicaterules(<rule id>)" }
// decoded in 'create' mode, so an omitted column reads as its create default. The bindings' map binds a value and a Custom
// API child to their parent; a condition's map has no body bind (the protected path only ever deep-inserts conditions), so
// its rule bind is taken off and read here.
function projectBody(tag, body) {
  const k = CONFIGURATION_CREATE_KIND_TABLE[tag];
  let raw = body;
  let parentId;
  if (tag === 'rule-condition') {
    const m = RULE_BIND.exec(body['regardingobjectid@odata.bind']);
    if (!m) return null;
    parentId = m[1];
    raw = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'regardingobjectid@odata.bind'));
  }
  const decoded = B.decodeConfigurationRow(k.bindingKind, raw, 'create');
  if (!decoded || decoded.unmodelled.length) return null;
  return publicOf(tag, decoded, 'create', parentId !== undefined ? parentId : decoded.parentId);
}

/**
 * The public projection of a row read back, by its tag or configuration kind. `observed` is a present answer of
 * readDefaultConfigurationRow ({ state: 'present', decoded, parentId }) or one raw row of a collection read that selected the
 * kind's default columns (configuration-create-bindings.js DEFAULT_READ_COLUMNS, a private column may be left out):
 *   { "customapirequestparameterid": "<id>", "uniquename": "A", ..., "_customapiid_value": "<api id>" }
 * Answers { ok: true, public, ruleState } (`ruleState` 'unpublished' | 'published' | null for a rule in flight, rules only:
 * a rule's state is proved apart from its content) or { ok: false, code: 'configuration-create-graph-unreadable', reason }.
 * A row holding public state the projection cannot represent (unrepresentableColumnOf) is unreadable too, never projected
 * without it.
 */
function publicProjectionFromObserved(kind, observed) {
  const tag = tagOf(kind);
  if (!tag) throw new TypeError(`publicProjectionFromObserved: ${kind} is not a configuration create kind`);
  const k = CONFIGURATION_CREATE_KIND_TABLE[tag];
  let decoded;
  let parentId;
  if (isPlain(observed) && observed.state === 'present' && isPlain(observed.decoded)) {
    decoded = observed.decoded;
    parentId = observed.parentId;
  } else {
    decoded = B.decodeSelectedRow(k.bindingKind, observed, B.DEFAULT_READ_COLUMNS[k.bindingKind]);
    if (decoded.unreadable) return { ok: false, code: CODES.graphUnreadable, reason: decoded.unreadable };
    parentId = decoded.parentId;
  }
  if (!k.root && !normalizeGuid(parentId)) return { ok: false, code: CODES.graphUnreadable, reason: 'the row names no parent' };
  const unrepresentable = unrepresentableColumnOf(decoded);
  if (unrepresentable) return { ok: false, code: CODES.graphUnreadable, reason: `the ${unrepresentable} column holds a value the public projection cannot represent` };
  const pub = publicOf(tag, decoded, 'read', k.root ? undefined : normalizeGuid(parentId));
  if (!pub) return { ok: false, code: CODES.graphUnreadable, reason: 'a public field cannot be read' };
  const out = { ok: true, public: pub };
  if (tag === 'duplicate-rule') out.ruleState = B.ruleStateOf(decoded.state.statecode, decoded.state.statuscode) || null;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Ids

/**
 * The ids of one root and its declared children, through the existing create identity (creates-port.js
 * createIntentCatalog over configuration-artifacts.js configurationCreateIntents): no other id scheme exists.
 *   deriveConfigurationCreateIds(spec, { kind, key, bindings?, solution?, rootId?, boundIdOf?, intentFor? })
 * `rootId` is the id of a root that already exists (found under a stable or an older random id): it keeps that id and its
 * children derive under it. `boundIdOf(kind, portKey)` does the same for other roots (a data-source variable's parent).
 * `solution` is the run's solution, else the spec's, else Default — the same scope the protected plan derives from.
 * Answers { kind: <root tag>, key: <port key>, id, childIds: { <slot>: <id> }, parentDefinitionId }.
 */
function deriveConfigurationCreateIds(spec, { kind, key, bindings, solution, rootId, boundIdOf, intentFor = defaultIntentFor } = {}) {
  const tag = tagOf(kind);
  if (!tag || !CONFIGURATION_CREATE_KIND_TABLE[tag].root) throw new TypeError(`deriveConfigurationCreateIds: ${kind} is not a configuration root kind`);
  const bindingKind = CONFIGURATION_CREATE_KIND_TABLE[tag].bindingKind;
  const entry = A.configurationIntentOf(spec, bindingKind, key);
  const portKey = A.portKeyOf(bindingKind, entry[ROOT_KEY_FIELD[bindingKind]]);
  const existing = rootId === undefined || rootId === null ? null : normalizeGuid(rootId);
  if (rootId !== undefined && rootId !== null && !existing) throw new TypeError(`deriveConfigurationCreateIds: the existing id of ${bindingKind} "${portKey}" is not a GUID`);
  const boundOf = (k, pkey) => {
    if (existing && k === bindingKind && pkey === portKey) return existing;
    return typeof boundIdOf === 'function' ? boundIdOf(k, pkey) : undefined;
  };
  const sol = nonEmpty(solution) ? solution : isPlain(spec && spec.solution) && nonEmpty(spec.solution.uniqueName) ? spec.solution.uniqueName : 'Default';
  const binds = bindings || { environmentVariables: new Map(), connectionReferences: new Map() };
  const catalog = createIntentCatalog(A.configurationCreateIntents(spec, { intentFor, bindings: binds, boundIdOf: boundOf, solution: sol }));
  const got = catalog.get(bindingKind, portKey);
  if (!got) throw new TypeError(`deriveConfigurationCreateIds: no create identity for ${bindingKind} "${portKey}"`);
  let parentDefinitionId = null;
  if (bindingKind === 'environmentVariable' && entry.type === 'dataSource' && nonEmpty(entry.parentSchemaName)) {
    const parent = catalog.get('environmentVariable', lower(entry.parentSchemaName));
    if (!parent) throw new TypeError(`deriveConfigurationCreateIds: the parent definition "${entry.parentSchemaName}" of "${portKey}" is not declared`);
    parentDefinitionId = normalizeGuid(parent.id);
  }
  const childIds = Object.fromEntries(Object.entries(got.childIds).map(([slot, id]) => [slot, normalizeGuid(id)]));
  return { kind: tag, key: portKey, id: normalizeGuid(got.id), childIds, parentDefinitionId, solution: sol };
}

// ---------------------------------------------------------------------------------------------
// Baseline

/**
 * The complete public baseline of a root that already exists, before rows are added under it. GET only:
 *   GET /<root set>(<id>)?$select=<default columns>                       (readDefaultConfigurationRow)
 *   GET /<child set>?$select=<id>,<parent lookup>,<public columns>&$filter=<parent lookup> eq <id>   every page (readAllPages)
 *   captureConfigurationBaseline(dataverse, { kind, rootId }, { readRow?, readAllPages? })
 * Every child collection of the root's kind is read to its last page; a child the declaration does not name is kept too
 * (the plan preserves it). Answers { ok: true, root: { kind, id, public, ruleState? }, children: [{ kind, id, parentId,
 * public }] } or { ok: false, code, reason }: the root read absent is configuration-create-row-missing; a failed or
 * incomplete page, a row without an id or under another parent, an id listed twice, a missing column, an unknown option
 * value or a column holding public state the projection cannot represent (a hint, a non-default prompting behavior) is
 * configuration-create-graph-unreadable — never an empty collection, never a baseline without it. A private column is not
 * selected.
 */
async function captureConfigurationBaseline(dataverse, { kind, rootId } = {}, { readRow = B.readDefaultConfigurationRow, readAllPages = B.readAllPages } = {}) {
  const tag = tagOf(kind);
  if (!tag || !CONFIGURATION_CREATE_KIND_TABLE[tag].root) throw new TypeError(`captureConfigurationBaseline: ${kind} is not a configuration root kind`);
  const id = normalizeGuid(rootId);
  if (!id) throw new TypeError('captureConfigurationBaseline: the root id is not a GUID');
  const rootKind = CONFIGURATION_CREATE_KIND_TABLE[tag];
  const unreadable = (reason) => ({ ok: false, code: CODES.graphUnreadable, reason });
  const read = await readRow(dataverse, rootKind.bindingKind, id);
  if (!isPlain(read) || read.state === 'unknown') return unreadable((read && read.reason) || 'the root could not be read');
  if (read.state === 'absent') return { ok: false, code: CODES.rowMissing, reason: 'the root is absent' };
  if (read.state !== 'present' || normalizeGuid(read.id) !== id) return unreadable('the root read answered another row');
  const root = publicProjectionFromObserved(tag, read);
  if (!root.ok) return root;
  const children = [];
  const seen = new Set([id]);
  for (const childTag of rootKind.childKinds) {
    const k = B.KINDS[CONFIGURATION_CREATE_KIND_TABLE[childTag].bindingKind];
    const columns = B.DEFAULT_READ_COLUMNS[CONFIGURATION_CREATE_KIND_TABLE[childTag].bindingKind].filter((col) => col !== k.privateColumn);
    const page = await readAllPages(dataverse, `/${k.set}?$select=${[k.pk, ...columns].join(',')}&$filter=${k.parentColumn} eq ${id}`);
    if (!isPlain(page) || page.complete !== true || !Array.isArray(page.rows)) return unreadable((page && page.reason) || `the ${childTag} rows could not be read completely`);
    for (const row of page.rows) {
      const childId = isPlain(row) && typeof row[k.pk] === 'string' ? normalizeGuid(row[k.pk]) : '';
      if (!childId || seen.has(childId)) return unreadable(`a ${childTag} row has no id or is listed twice`);
      seen.add(childId);
      const projected = publicProjectionFromObserved(childTag, row);
      if (!projected.ok) return projected;
      if (projected.public.parentId !== id) return unreadable(`a ${childTag} row names another parent`);
      children.push({ kind: childTag, id: childId, parentId: id, public: projected.public });
    }
  }
  children.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    ok: true,
    root: { kind: tag, id, public: root.public, ...(tag === 'duplicate-rule' ? { ruleState: root.ruleState } : {}) },
    children,
  };
}

// ---------------------------------------------------------------------------------------------
// Classification

const CHILD_LISTS = new Set(['/requestParameters', '/responseProperties', '/conditions']);
const LABEL_FIELDS = ['name', 'displayName', 'description'];
const sameLabel = (a, b) => (a === undefined ? null : a) === (b === undefined ? null : b);
// A child's contract columns are create-only: the planner refuses a change to them (CUSTOM_API_PARAMETER_IMMUTABLE), and
// the platform answers a PATCH of a request parameter's isoptional with 204 while changing nothing. So a merged existing
// child that differs in one is never an addition beside the new rows: it is an edit, and an edit is never reported applied.
const sameContract = (a, b) => a.type === b.type && (a.isOptional === true) === (b.isOptional === true)
  && sameLabel(a.entityLogicalName == null ? null : lower(a.entityLogicalName), b.entityLogicalName == null ? null : lower(b.entityLogicalName));

/**
 * Which route one planned root operation (configuration-artifacts.js planConfiguration: { kind, key, id?, action, detail,
 * authorize? }) takes, before any configuration write:
 *   { route: 'create-unit', kind, key }                      a new root, with its new children: one closed unit
 *   { route: 'additions', kind, key, rootId, additions }     an existing root that only gains children: `additions` are
 *                                                            their slots; the rest of the root is preserved, not rewritten
 *   { route: 'existing' }                                    no new row (an edit, a removal, unchanged, a refusal, or a
 *                                                            kind this module does not create): the existing route
 *   { route: 'refused', code, reason }                       additions mixed with an edit, a removal or a status change of
 *                                                            existing rows, or conditions added to a rule not observed
 *                                                            unpublished: configuration-create-mixed-edit. A change this
 *                                                            module cannot read: configuration-create-shape-refused.
 * `ruleState` is a fresh observation of an existing rule's state; without it the planner's read of the rule decides.
 * Plain values only: the halt that carries a code is raised by the caller.
 */
function classifyConfigurationMutation(op, { ruleState } = {}) {
  const tag = isPlain(op) ? tagOf(op.kind) : null;
  if (!tag || !CONFIGURATION_CREATE_KIND_TABLE[tag].root) return { route: 'existing' };
  if (op.action === 'create') return { route: 'create-unit', kind: tag, key: op.key };
  if (op.action !== 'update') return { route: 'existing' };
  const refused = (code, reason) => ({ route: 'refused', code, reason });
  const detail = op.detail;
  if (!isPlain(detail) || !Array.isArray(detail.changes) || !isPlain(detail.remote)) return refused(CODES.shapeRefused, 'the planned change cannot be read');
  const additions = [];
  const edits = [];
  for (const change of detail.changes) {
    if (!isPlain(change) || typeof change.pointer !== 'string') return refused(CODES.shapeRefused, 'the planned change cannot be read');
    const created = Array.isArray(change.created) ? change.created : [];
    if (CHILD_LISTS.has(change.pointer)) {
      if (Array.isArray(change.removed) && change.removed.length) edits.push(`${change.pointer} removes a row`);
      for (const c of created) {
        if (!isPlain(c) || typeof c.slot !== 'string') return refused(CODES.shapeRefused, 'a new child names no slot');
        additions.push(c.slot);
      }
      // A merged Custom API child list carries every existing child too, with any authored label laid over it: an
      // existing child whose labels changed is an edit. (A changed existing condition always needs authorization, below.)
      if (change.pointer !== '/conditions' && Array.isArray(change.value)) {
        const createdAt = new Set(created.map((c) => c.index));
        const remote = new Map((detail.remote[change.pointer.slice(1)] || []).map((c) => [lower(c.uniqueName), c]));
        change.value.forEach((child, i) => {
          if (createdAt.has(i)) return;
          if (!isPlain(child)) { edits.push(`${change.pointer} cannot be read`); return; }
          const before = remote.get(lower(child.uniqueName));
          if (!before || !sameContract(child, before) || LABEL_FIELDS.some((f) => !sameLabel(child[f], before[f]))) edits.push(`${change.pointer} edits an existing row`);
        });
      }
      continue;
    }
    if (change.pointer === '/currentValue' && created.length) {
      for (const c of created) additions.push(c.slot);
      continue;
    }
    edits.push(change.pointer === '/status' ? 'the rule status changes' : `${change.pointer} changes`);
  }
  if (Array.isArray(op.authorize) && op.authorize.length) edits.push('an existing row is replaced or removed');
  if (!additions.length) return { route: 'existing' };
  if (edits.length) return refused(CODES.mixedEdit, `new rows are planned together with changes to existing ones (${[...new Set(edits)].join('; ')})`);
  if (tag === 'duplicate-rule') {
    // A condition POSTed under a published rule is accepted (204) and silently unpublishes the rule, so an append to a
    // rule not observed unpublished changes its state too: a mixed edit, never a plain addition.
    const state = ruleState !== undefined ? ruleState : detail.remote.status;
    if (state !== 'unpublished') return refused(CODES.mixedEdit, 'conditions are added to a rule that is not unpublished');
  }
  const rootId = normalizeGuid(op.id);
  if (!rootId) return refused(CODES.shapeRefused, 'the existing root has no id');
  return { route: 'additions', kind: tag, key: op.key, rootId, additions: [...new Set(additions)] };
}

// ---------------------------------------------------------------------------------------------
// The eight row constructors. Each builds a fresh, allowlisted, flat object from validated scalars; none spreads its input.
// `a` is the normalized artifact (or one of its children) configuration-artifacts.js buildArtifact prepared. The effective
// defaults are the SDK encoder's, so a body says exactly what the deep insert said for the same row:
//   environment variable definition, connection reference, duplicate rule: a null optional column is left out;
//   Custom API root and children: every column is sent, labels already pinned (configuration-create-bindings.js pinApiLabels);
//   condition: the matching column defaults to the column, the character count only where the match counts characters.

class ShapeError extends Error {}
const shape = (ok, what) => { if (!ok) throw new ShapeError(what); };
const str = (v, what) => { shape(typeof v === 'string' && v !== '', what); return v; };
const optStr = (v, what) => { shape(v === null || v === undefined || typeof v === 'string', what); return v === undefined ? null : v; };
const flag = (v) => v === true;
const codeOf = (table, v, what) => { shape(typeof v === 'string' && has(table, v), what); return table[v]; };
const idOf = (v, what) => { const g = normalizeGuid(v); shape(!!g && typeof v === 'string', what); return g; };
const putIf = (body, column, v) => { if (v !== null && v !== undefined) body[column] = v; };

function definitionBody(a, id) {
  const body = {
    environmentvariabledefinitionid: id,
    schemaname: str(a.schemaName, 'schemaName'),
    type: codeOf(B.EV_TYPES, a.type, 'type'),
    displayname: optStr(a.name, 'name'),
    isrequired: flag(a.isRequired),
  };
  if (body.displayname === null) delete body.displayname;
  putIf(body, 'description', optStr(a.description, 'description'));
  putIf(body, 'defaultvalue', optStr(a.defaultValue, 'defaultValue'));
  putIf(body, 'valueschema', optStr(a.valueSchema, 'valueSchema'));
  putIf(body, 'apiid', optStr(a.connectorId, 'connectorId'));
  putIf(body, 'parameterkey', optStr(a.parameterKey, 'parameterKey'));
  if (a.parentId != null) body['ParentDefinitionId@odata.bind'] = `/environmentvariabledefinitions(${idOf(a.parentId, 'parentId')})`;
  return body;
}

function valueBody(value, id, definitionId) {
  shape(typeof value === 'string', 'value');
  const k = CONFIGURATION_CREATE_KIND_TABLE['env-value'];
  return { environmentvariablevalueid: id, value, [`${k.parentBind.key}@odata.bind`]: `/${k.parentBind.set}(${definitionId})` };
}

function referenceBody(a, id) {
  const body = {
    connectionreferenceid: id,
    connectionreferencelogicalname: str(a.logicalName, 'logicalName'),
    connectorid: str(a.connectorId, 'connectorId'),
  };
  putIf(body, 'connectionreferencedisplayname', optStr(a.name, 'name'));
  putIf(body, 'description', optStr(a.description, 'description'));
  putIf(body, 'connectionid', optStr(a.connectionId, 'connectionId'));
  if (a.customConnectorId != null) body['CustomConnectorId@odata.bind'] = `/connectors(${idOf(a.customConnectorId, 'customConnectorId')})`;
  return body;
}

// The platform refuses a Custom API root POSTed without a description (400 0x80040200 "Attribute 'description'
// cannot be NULL"), while a child may omit one. Pinning always fills the root's (description = displayName), so a root
// that reaches here without one is a shape this module cannot send, refused before anything is sent.
function apiBody(a, id) {
  return {
    customapiid: id,
    uniquename: str(a.uniqueName, 'uniqueName'),
    name: optStr(a.name, 'name'),
    displayname: optStr(a.displayName, 'displayName'),
    description: str(a.description, 'description'),
    bindingtype: codeOf(B.API_BINDINGS, a.binding, 'binding'),
    boundentitylogicalname: optStr(a.boundEntityLogicalName, 'boundEntityLogicalName'),
    isfunction: flag(a.isFunction),
    isprivate: flag(a.isPrivate),
    allowedcustomprocessingsteptype: codeOf(B.API_STEPS, a.allowedProcessingSteps, 'allowedProcessingSteps'),
    workflowsdkstepenabled: flag(a.enabledForWorkflow),
    executeprivilegename: optStr(a.executePrivilegeName, 'executePrivilegeName'),
  };
}

function apiChildBody(tag, c, id, apiId) {
  const k = CONFIGURATION_CREATE_KIND_TABLE[tag];
  const body = {
    [k.idColumn]: id,
    uniquename: str(c.uniqueName, 'uniqueName'),
    name: optStr(c.name, 'name'),
    displayname: optStr(c.displayName, 'displayName'),
    description: optStr(c.description, 'description'),
    type: codeOf(B.PARAM_TYPES, c.type, 'type'),
    logicalentityname: optStr(c.entityLogicalName, 'entityLogicalName'),
  };
  if (tag === 'api-request') body.isoptional = flag(c.isOptional);
  body[`${k.parentBind.key}@odata.bind`] = `/${k.parentBind.set}(${apiId})`;
  return body;
}

const requestBody = (c, id, apiId) => apiChildBody('api-request', c, id, apiId);
const responseBody = (c, id, apiId) => apiChildBody('api-response', c, id, apiId);

function ruleBody(a, id) {
  const base = str(a.entityLogicalName, 'entityLogicalName');
  const body = {
    duplicateruleid: id,
    name: str(a.name, 'name'),
    baseentityname: base,
    matchingentityname: a.matchingEntityLogicalName == null ? base : str(a.matchingEntityLogicalName, 'matchingEntityLogicalName'),
    iscasesensitive: flag(a.caseSensitive),
    excludeinactiverecords: flag(a.excludeInactiveRecords),
  };
  putIf(body, 'description', optStr(a.description, 'description'));
  return body;
}

function conditionBody(c, id, ruleId) {
  const column = str(c.column, 'column');
  const body = {
    duplicateruleconditionid: id,
    baseattributename: column,
    matchingattributename: c.matchingColumn == null ? column : str(c.matchingColumn, 'matchingColumn'),
    operatorcode: codeOf(B.MATCH_CODES, c.match, 'match'),
    ignoreblankvalues: flag(c.ignoreBlankValues),
  };
  if (c.characters !== null && c.characters !== undefined) {
    shape(Number.isSafeInteger(c.characters) && c.characters >= 0, 'characters');
    body.operatorparam = c.characters;
  }
  const k = CONFIGURATION_CREATE_KIND_TABLE['rule-condition'];
  body[`${k.parentBind.key}@odata.bind`] = `/${k.parentBind.set}(${ruleId})`;
  return body;
}

// The fields buildArtifact may answer per kind. A field outside them is a declaration these constructors cannot represent
// (a newer App Spec field, a changed artifact): the unit is refused before anything is sent, never sent without it.
const ARTIFACT_FIELDS = Object.freeze({
  environmentVariable: new Set(['id', 'schemaName', 'type', 'name', 'description', 'defaultValue', 'isRequired', 'valueSchema', 'connectorId', 'parameterKey', 'parentId', 'currentValue']),
  connectionReference: new Set(['id', 'logicalName', 'name', 'description', 'connectorId', 'connectionId', 'customConnectorId']),
  customApi: new Set(['id', 'uniqueName', 'name', 'displayName', 'description', 'binding', 'boundEntityLogicalName', 'isFunction', 'isPrivate', 'allowedProcessingSteps', 'enabledForWorkflow', 'executePrivilegeName', 'requestParameters', 'responseProperties']),
  apiRequest: new Set(['id', 'uniqueName', 'name', 'displayName', 'description', 'type', 'entityLogicalName', 'isOptional']),
  apiResponse: new Set(['id', 'uniqueName', 'name', 'displayName', 'description', 'type', 'entityLogicalName']),
  duplicateRule: new Set(['id', 'name', 'description', 'entityLogicalName', 'matchingEntityLogicalName', 'caseSensitive', 'excludeInactiveRecords', 'status', 'conditions']),
  condition: new Set(['id', 'column', 'match', 'matchingColumn', 'characters', 'ignoreBlankValues']),
  currentValue: new Set(['id', 'value']),
});
const closed = (o, fields, what) => {
  shape(isPlain(o), what);
  for (const key of Object.keys(o)) shape(fields.has(key), `${what}.${key}`);
};

// ---------------------------------------------------------------------------------------------
// Compile

// handle -> { unit, rows: Map(row id -> frozen request), publication }. A row is addressed by its id, the one thing unique across
// kinds: a rule and one of its conditions may share an authored key. Module-private: only this module's accessors read it,
// so a writer can send nothing but what a handle this compiler issued holds.
const COMPILED = new WeakMap();

function compiledOf(handle) {
  const c = handle && typeof handle === 'object' ? COMPILED.get(handle) : undefined;
  if (!c) throw new TypeError('not a compiled configuration create unit');
  return c;
}

/**
 * Compile one root operation into a closed unit, before any row is sent:
 *   compileConfigurationCreateUnit(spec, { kind, key, bindings?, solution?, boundIdOf?, intentFor?, baseline?, additions? })
 * Without `baseline` the root is new: the unit creates the root and every declared child. With `baseline` (a successful
 * captureConfigurationBaseline of the existing root) and `additions` (the slots classifyConfigurationMutation named), the
 * unit creates only those children, under the root's actual id, and preserves the root and every child the baseline holds.
 * Answers { ok: true, handle, unit } or { ok: false, code: 'configuration-create-shape-refused' | 'configuration-create-mixed-edit', reason }.
 *   unit = { root: { kind, key, id }, solution, publicationRequired, rows: [{ kind, key, id, parentId, role, public, privateFields }],
 *            publicIntentSha256, publicPlanSha256 }       frozen; holds no private value
 *   handle                                                an opaque frozen token for compiledRowRequest / compiledPublicationRequest
 * The bodies are built from the spec once, serialized and frozen: changing the spec, the bindings or anything they hold
 * afterwards changes nothing that is sent.
 */
function compileConfigurationCreateUnit(spec, { kind, key, bindings, solution, boundIdOf, intentFor = defaultIntentFor, baseline, additions } = {}) {
  const tag = tagOf(kind);
  if (!tag || !CONFIGURATION_CREATE_KIND_TABLE[tag].root) throw new TypeError(`compileConfigurationCreateUnit: ${kind} is not a configuration root kind`);
  const refuse = (code, reason) => ({ ok: false, code, reason });
  const bindingKind = CONFIGURATION_CREATE_KIND_TABLE[tag].bindingKind;
  const adding = baseline !== undefined && baseline !== null;
  if (adding && (!isPlain(baseline) || baseline.ok !== true || !isPlain(baseline.root) || baseline.root.kind !== tag || !Array.isArray(baseline.children))) {
    throw new TypeError('compileConfigurationCreateUnit: the baseline is not a complete capture of this root');
  }
  if (adding && (!Array.isArray(additions) || !additions.length)) throw new TypeError('compileConfigurationCreateUnit: an existing root needs the slots it gains');
  let entry;
  try { entry = A.configurationIntentOf(spec, bindingKind, key); } catch { return refuse(CODES.shapeRefused, 'the declaration cannot be found once'); }
  const binds = bindings || { environmentVariables: new Map(), connectionReferences: new Map() };
  const ids = deriveConfigurationCreateIds(spec, { kind: tag, key, bindings: binds, solution, rootId: adding ? baseline.root.id : undefined, boundIdOf, intentFor });
  const artifact = A.buildArtifact({ kind: bindingKind, key: ids.key, detail: { entry } }, ids.id, { ...ids.childIds }, { bindings: binds }, ids.parentDefinitionId);
  const createSlots = adding ? [...new Set(additions)] : Object.keys(ids.childIds);
  for (const slot of createSlots) if (!has(ids.childIds, slot)) return refuse(CODES.shapeRefused, `the declaration has no child ${slot}`);
  if (adding && tag === 'duplicate-rule' && baseline.root.ruleState !== 'unpublished') return refuse(CODES.mixedEdit, 'conditions are added to a rule that is not unpublished');
  if (tag === 'custom-api') {
    // A child's default name is '<api unique name>.<child unique name>'. Under an existing API that is the API's own unique
    // name (the row the SDK's update would have read), which may differ in case from the declaration's.
    if (adding) artifact.uniqueName = baseline.root.public.uniqueName;
    B.pinApiLabels(artifact, 'create', new Map(Object.keys(ids.childIds).map((s) => [s, 'create'])), undefined);
  }
  const requests = [];
  try {
    if (bindingKind === 'environmentVariable') closed(artifact, ARTIFACT_FIELDS.environmentVariable, 'environmentVariable');
    if (bindingKind === 'connectionReference') closed(artifact, ARTIFACT_FIELDS.connectionReference, 'connectionReference');
    if (bindingKind === 'customApi') {
      closed(artifact, ARTIFACT_FIELDS.customApi, 'customApi');
      for (const c of artifact.requestParameters) closed(c, ARTIFACT_FIELDS.apiRequest, 'requestParameter');
      for (const c of artifact.responseProperties) closed(c, ARTIFACT_FIELDS.apiResponse, 'responseProperty');
    }
    if (bindingKind === 'duplicateRule') {
      closed(artifact, ARTIFACT_FIELDS.duplicateRule, 'duplicateRule');
      for (const c of artifact.conditions) closed(c, ARTIFACT_FIELDS.condition, 'condition');
    }
    const rootId = ids.id;
    if (!adding) {
      const body = bindingKind === 'environmentVariable' ? definitionBody(artifact, rootId)
        : bindingKind === 'connectionReference' ? referenceBody(artifact, rootId)
          : bindingKind === 'customApi' ? apiBody(artifact, rootId) : ruleBody(artifact, rootId);
      requests.push({ kind: tag, key: ids.key, id: rootId, parentId: null, body });
    }
    for (const slot of createSlots) {
      const childTag = childTagOf(tag, slot);
      const childId = ids.childIds[slot];
      let body;
      if (childTag === 'env-value') {
        closed(artifact.currentValue, ARTIFACT_FIELDS.currentValue, 'currentValue');
        shape(artifact.currentValue.id === childId, 'value id');
        body = valueBody(artifact.currentValue.value, childId, rootId);
      } else {
        const list = childTag === 'api-request' ? artifact.requestParameters : childTag === 'api-response' ? artifact.responseProperties : artifact.conditions;
        const child = list.find((c) => normalizeGuid(c.id) === childId);
        shape(!!child, `child ${slot}`);
        body = childTag === 'api-request' ? requestBody(child, childId, rootId)
          : childTag === 'api-response' ? responseBody(child, childId, rootId) : conditionBody(child, childId, rootId);
      }
      requests.push({ kind: childTag, key: slot, id: childId, parentId: rootId, body });
    }
  } catch (error) {
    if (error instanceof ShapeError) return refuse(CODES.shapeRefused, `the declaration cannot be sent as closed rows (${error.message})`);
    throw error;
  }
  const rows = [];
  const frozenRows = new Map();
  for (const r of requests) {
    const k = CONFIGURATION_CREATE_KIND_TABLE[r.kind];
    const json = JSON.stringify(r.body);
    const pub = projectBody(r.kind, JSON.parse(json));
    if (!pub) return refuse(CODES.shapeRefused, `the ${r.kind} row cannot be projected`);
    rows.push({ kind: r.kind, key: r.key, id: r.id, parentId: r.parentId, role: 'create', public: pub, privateFields: [...k.privateFields] });
    frozenRows.set(r.id, Object.freeze({ kind: r.kind, key: r.key, id: r.id, parentId: r.parentId, method: 'POST', path: `/${k.entitySet}`, body: json, solutionHeader: k.solutionHeader }));
  }
  if (adding) {
    const preserved = [{ kind: tag, key: ids.key, id: baseline.root.id, parentId: null, public: baseline.root.public }];
    for (const c of baseline.children) {
      const childKey = c.kind === 'api-request' ? `request:${lower(c.public.uniqueName)}` : c.kind === 'api-response' ? `response:${lower(c.public.uniqueName)}` : `@${c.id}`;
      preserved.push({ kind: c.kind, key: childKey, id: c.id, parentId: c.parentId, public: c.public });
    }
    for (const p of preserved) {
      if (!validatePublicRow(p.kind, p.public).ok) return refuse(CODES.shapeRefused, `the preserved ${p.kind} row cannot be represented`);
      rows.push({ kind: p.kind, key: p.key, id: p.id, parentId: p.parentId, role: 'preserved', public: { ...p.public }, privateFields: [...CONFIGURATION_CREATE_KIND_TABLE[p.kind].privateFields] });
    }
  }
  const keys = new Set();
  const rowIds = new Set();
  for (const r of rows) {
    const slot = `${r.kind}\u0000${r.key}`;
    if (keys.has(slot) || rowIds.has(r.id)) return refuse(CODES.shapeRefused, `two rows of the unit are one (${r.kind} ${r.key})`);
    keys.add(slot);
    rowIds.add(r.id);
  }
  const publicationRequired = !adding && tag === 'duplicate-rule' && artifact.status === 'published';
  const unit = { root: { kind: tag, key: ids.key, id: ids.id }, solution: ids.solution, publicationRequired, rows };
  unit.publicIntentSha256 = publicIntentSha256(unit);
  unit.publicPlanSha256 = publicPlanSha256(unit);
  deepFreeze(unit);
  const publication = publicationRequired
    ? Object.freeze({ method: 'POST', path: `/${CONFIGURATION_CREATE_KIND_TABLE['duplicate-rule'].entitySet}(${ids.id})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, body: '{}', solutionHeader: false })
    : null;
  const handle = Object.freeze(Object.create(null));
  COMPILED.set(handle, { unit, rows: frozenRows, publication });
  return { ok: true, handle, unit };
}

/**
 * What the writer sends for one new row of a compiled unit, by the row's id (a `role: 'create'` row of the unit):
 *   { kind, key, id, parentId, method: 'POST', path: '/<entity set>', body: '<serialized JSON>', solutionHeader }
 * `body` is the frozen serialization (it may hold a private input: send it, never store or log it). `solutionHeader` says
 * whether the request carries MSCRM.SolutionUniqueName (the unit's `solution`); a value row never does.
 * See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-entity-web-api
 */
function compiledRowRequest(handle, rowId) {
  const c = compiledOf(handle);
  const id = typeof rowId === 'string' ? normalizeGuid(rowId) : '';
  const row = id ? c.rows.get(id) : undefined;
  if (!row) throw new TypeError(`compiledRowRequest: the unit creates no row ${rowId}`);
  return row;
}

/**
 * The one publication a new published rule needs after its content, or null: the bound action with an empty body and no
 * solution header.
 *   POST /duplicaterules(<id>)/Microsoft.Dynamics.CRM.PublishDuplicateRule   {}
 * See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/publishduplicaterule
 */
function compiledPublicationRequest(handle) {
  return compiledOf(handle).publication;
}

/** The frozen public unit a handle was compiled with (compileConfigurationCreateUnit's `unit`). */
function compiledUnitOf(handle) {
  return compiledOf(handle).unit;
}

/** The public projection of the exact bytes a new row (by its id) is sent with: { ok: true, public } (never the private input). */
function publicProjectionFromPost(handle, rowId) {
  const row = compiledRowRequest(handle, rowId);
  const pub = projectBody(row.kind, JSON.parse(row.body));
  return pub ? { ok: true, public: pub } : { ok: false, code: CODES.shapeRefused, reason: 'the row cannot be projected' };
}

// ---------------------------------------------------------------------------------------------
// A stored unit

const UNIT_KEYS = new Set(['unitId', 'attemptId', 'state', 'root', 'solution', 'publicIntentSha256', 'publicPlanSha256', 'rows', 'publication', 'publicationRequired', 'offer']);
const ROW_KEYS = new Set(['kind', 'key', 'id', 'parentId', 'role', 'dispatch', 'public', 'privateFields']);

/**
 * Check a stored unit's plan content against the kind table, and optionally against the unit compiled now:
 *   validateRecordedCreateUnit(recorded, { current? })
 * The record keeps the receipt's own fields (unit and attempt ids, states, offers: the receipt module checks those); this
 * checks what this module defines: one root row at the root's id, every other row a child of the root of an allowed kind,
 * unique ids and keys, closed public rows, the fixed private classifications, a publication slot only for a new rule, and
 * both hashes recomputed. Answers { ok: true, samePlan? } or { ok: false, code, reason }:
 *   configuration-create-state-invalid     the record is not a unit this module could have compiled;
 *   configuration-create-intent-changed    `current` (a compiled unit) does not describe the recorded attempt: another
 *                                          root, or another public intent. `samePlan` says whether the whole public plan
 *                                          (ids and preserved rows included) is still the same.
 */
function validateRecordedCreateUnit(recorded, { current } = {}) {
  const invalid = (reason) => ({ ok: false, code: CODES.stateInvalid, reason });
  if (!isPlain(recorded)) return invalid('the unit is not an object');
  for (const key of Object.keys(recorded)) if (!UNIT_KEYS.has(key)) return invalid(`unknown unit field ${key}`);
  const root = recorded.root;
  if (!isPlain(root) || Object.keys(root).sort().join() !== 'id,key,kind') return invalid('the root is not { kind, key, id }');
  const rootTag = tagOf(root.kind);
  if (rootTag !== root.kind || !CONFIGURATION_CREATE_KIND_TABLE[rootTag].root) return invalid('the root kind is not a root tag');
  if (typeof root.key !== 'string' || !root.key || !typeOk('guid', root.id)) return invalid('the root key or id is malformed');
  if (!Array.isArray(recorded.rows) || !recorded.rows.length) return invalid('the unit has no rows');
  const ids = new Set();
  const keys = new Set();
  let rootRows = 0;
  let creates = 0;
  for (const row of recorded.rows) {
    if (!isPlain(row)) return invalid('a row is not an object');
    for (const key of Object.keys(row)) if (!ROW_KEYS.has(key)) return invalid(`unknown row field ${key}`);
    const tag = tagOf(row.kind);
    if (tag !== row.kind) return invalid('a row kind is not a row tag');
    const k = CONFIGURATION_CREATE_KIND_TABLE[tag];
    if (typeof row.key !== 'string' || !row.key || !typeOk('guid', row.id)) return invalid('a row key or id is malformed');
    if (row.role !== 'preserved' && row.role !== 'create') return invalid('a row role is unknown');
    if (row.role === 'create') creates += 1;
    if (ids.has(row.id) || keys.has(`${row.kind}\u0000${row.key}`)) return invalid('two rows are one');
    ids.add(row.id);
    keys.add(`${row.kind}\u0000${row.key}`);
    const checked = validatePublicRow(tag, row.public);
    if (!checked.ok) return invalid(`a ${tag} row's public projection is invalid (${checked.reason})`);
    if (!Array.isArray(row.privateFields) || row.privateFields.join('\u0000') !== k.privateFields.join('\u0000')) return invalid(`a ${tag} row's private classification is not the kind's`);
    if (k.root) {
      if (tag !== rootTag || row.id !== root.id || row.key !== root.key || row.parentId !== null) return invalid('a root row is not the unit root');
      rootRows += 1;
    } else {
      if (!k.parentKinds.includes(rootTag) || row.parentId !== root.id || row.public.parentId !== row.parentId) return invalid(`a ${tag} row is not a child of the unit root`);
    }
  }
  if (rootRows !== 1) return invalid('the unit has no single root row');
  if (!creates) return invalid('the unit creates nothing');
  const rootRow = recorded.rows.find((r) => r.id === root.id);
  if (has(recorded, 'publicationRequired') && typeof recorded.publicationRequired !== 'boolean') return invalid('publicationRequired is not a boolean');
  // A compiled unit says `publicationRequired`; a stored one may hold the publication slot instead (null when none). When
  // both are present they must agree, or the hashes (which read one of them) would hide the other.
  if (has(recorded, 'publicationRequired') && has(recorded, 'publication') && recorded.publicationRequired !== (recorded.publication != null)) {
    return invalid('the publication slot contradicts publicationRequired');
  }
  const publicationRequired = publicationRequiredOf(recorded);
  const newRule = rootTag === 'duplicate-rule' && rootRow.role === 'create';
  if ((publicationRequired || (has(recorded, 'publication') && recorded.publication != null)) && !newRule) return invalid('only a new rule can require publication');
  for (const field of ['publicIntentSha256', 'publicPlanSha256']) if (typeof recorded[field] !== 'string' || !SHA256.test(recorded[field])) return invalid(`${field} is not a SHA-256`);
  if (publicIntentSha256(recorded) !== recorded.publicIntentSha256) return invalid('the public intent hash does not match the rows');
  if (publicPlanSha256(recorded) !== recorded.publicPlanSha256) return invalid('the public plan hash does not match the rows');
  if (current === undefined) return { ok: true };
  if (!isPlain(current) || !isPlain(current.root)) throw new TypeError('validateRecordedCreateUnit: current is not a compiled unit');
  if (current.root.kind !== root.kind || current.root.key !== root.key || current.publicIntentSha256 !== recorded.publicIntentSha256) {
    return { ok: false, code: CODES.intentChanged, reason: 'the current declaration does not describe the recorded attempt' };
  }
  return { ok: true, samePlan: current.publicPlanSha256 === recorded.publicPlanSha256 };
}

module.exports = {
  CODES,
  CONFIGURATION_CREATE_KIND_TABLE,
  CONFIGURATION_CREATE_RECEIPT_KIND_TABLE,
  validatePublicRow,
  publicIntentSha256,
  publicPlanSha256,
  classifyConfigurationMutation,
  deriveConfigurationCreateIds,
  captureConfigurationBaseline,
  compileConfigurationCreateUnit,
  compiledRowRequest,
  compiledPublicationRequest,
  compiledUnitOf,
  publicProjectionFromPost,
  publicProjectionFromObserved,
  validateRecordedCreateUnit,
};
