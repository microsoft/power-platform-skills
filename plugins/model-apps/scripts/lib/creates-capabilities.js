'use strict';
// The closed registry of what the build creates, and what a stable identity can and cannot do for each kind.
//
// Every create site the build has is classified against ONE descriptor here. A descriptor says, for its kind:
//   class      C  the SDK takes a caller-supplied id for the row, so the create can be sent with its stable identity (creates-identity.js);
//              U  the platform enforces a unique key (a logical, schema or unique name), which already identifies the row — no id is
//                 injected, and recovery is the key's own exact match;
//              N  neither: the SDK takes no id and no unique key applies, so a lost answer stays a documented residual;
//              P  a package or job protocol (solution import) whose own ids and proofs are kept unchanged.
//   semantic   a U kind that is a setter, not a row factory (appTheme): executed once, it answers what happened to its row by its
//              key, never a row id, receipt or deletion authority.
//   aggregate  the create writes more than one thing (a parent and children, a row and its state, membership or publication) — a
//              parent being present never proves the rest is.
//   rootKind / keyParts / children   for C kinds, the identity literal and how its canonical key parts come from a VALIDATED
//              declaration (never by splitting a locator string), and the slot rule of each child kind.
//   idCarrier  where the id travels in the SDK's create (the artifact's own id field).
//   reader     the saved-id reader that answers present / absent / unreadable for that id (the kind's own reconcile helper).
//   native     the SDK's own exact-create recovery (`createRecovery: 'adoptExact'`) applies — views and Main forms only.
//   gate       why the kind is NOT yet allocated ids, for a C kind whose safety still needs a live or SDK proof, or whose create also
//              writes child rows that no binding or adoption contract of their own covers. The port refuses a gated kind with
//              create-identity-unsupported rather than guessing.
//   residual   what stays unprotected, in plain words.
// It holds no state: it is data plus pure functions, and nothing in it reads the network or the disk.

const {
  createStop, identifierPart, nameKeyPart, stableKeyPart, subtypePart, entityOrEmptyPart, ROOT_KINDS, CHILD_KINDS,
} = require('./creates-identity.js');

// An explicit stable key where the declaration has one, else the shared Dataverse name key of its display name.
const keyOrName = (d) => (d && d.key !== undefined ? stableKeyPart(d.key, 'key') : nameKeyPart(d && d.name, 'name'));

const freezeDeep = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) freezeDeep(v);
  return Object.freeze(o);
};

const DESCRIPTORS = freezeDeep({
  // ---- C: caller-supplied id, protected by a stable identity ----
  view: {
    class: 'C', aggregate: false, rootKind: 'view', scope: 'table', idCarrier: 'savedqueryid (the artifact id)', reader: 'view', native: true,
    keyParts: (d) => [subtypePart(d.queryType, 'queryType'), keyOrName(d)],
    residual: 'A row created without protection keeps the name-based lookup.',
  },
  chart: {
    class: 'C', aggregate: false, rootKind: 'chart', scope: 'table', idCarrier: 'savedqueryvisualizationid (the artifact id)', reader: 'chart', native: false,
    keyParts: (d) => [keyOrName(d)],
    residual: 'No native exact recovery: a present chart is matched by its saved (unpublished) row, or the build stops.',
  },
  form: {
    class: 'C', aggregate: false, rootKind: 'form', scope: 'table', idCarrier: 'formid (a create option of the form artifact, not a new wire member)', reader: 'form', native: 'main-only',
    keyParts: (d) => [subtypePart(d.formType, 'formType'), keyOrName(d)],
    // A form has no binding the build records across runs (only a formId the spec author pins), and no complete read-only adopter:
    // its saved FormXML is a layout the SDK regenerates, which no content comparison can certify. So the run after a protected create
    // would find its own form unbound at the derived id, which is not ownership, and stop every time.
    gate: 'A form has no recorded binding across runs and no complete read-only adoption contract, so a rebuild could not take its own form back by id; forms keep the existing create path.',
    residual: 'Quick Create, Quick View and other form types have no native exact recovery: a present unbound row stops.',
  },
  dashboard: {
    class: 'C', aggregate: false, rootKind: 'dashboard', scope: 'solution', idCarrier: 'formid (the artifact id)', reader: 'dashboard', native: false,
    keyParts: (d) => [subtypePart(d.scopeType, 'scopeType'), entityOrEmptyPart(d.entity), keyOrName(d)],
    // The dashboard creation record (dashboard-creation-records.js) binds a dashboard only until it is seen in the solution, and the
    // existing name reuse is not a complete content proof: the same rebuild problem as forms.
    gate: 'A dashboard is bound only until it joins the solution and has no complete read-only adoption contract, so a rebuild could not take its own dashboard back by id; dashboards keep the existing create path.',
    residual: 'A retained earlier dashboard id wins; layout ids are regenerated by the SDK, so an exact recovery may stop.',
  },
  fieldSecurityProfile: {
    class: 'C', aggregate: true, rootKind: 'fieldSecurityProfile', scope: 'solution', idCarrier: 'fieldsecurityprofileid (deep insert)', reader: 'fieldSecurityProfile', native: false,
    keyParts: (d) => [stableKeyPart(d.key, 'profile key')],
    children: { fieldPermission: (c) => [identifierPart(c.table, 'table'), identifierPart(c.column, 'column')] },
    gate: 'A profile is created with its field permission rows, and a bound profile does not prove who created a permission at its derived id, so a protected rerun could overwrite one a maker made and report it created; profiles keep the existing create path.',
    residual: 'Permissions and assignments are proven separately; a present profile is not completion.',
  },
  environmentVariable: {
    class: 'C', aggregate: true, rootKind: 'environmentVariable', scope: 'solution', idCarrier: 'environmentvariabledefinitionid', reader: 'environmentVariable', native: false,
    keyParts: (d) => [identifierPart(d.schemaName, 'schema name')],
    children: { environmentVariableValue: () => ['value'] },
    gate: 'A definition is written with its value row, and a bound definition does not prove who created a value at its derived id, so a protected rerun could overwrite one a maker set and report it created; environment variables keep the existing create path.',
    residual: 'A definition alone does not complete its value; a masked or secret value cannot be proven and stops exact recovery.',
  },
  connectionReference: {
    class: 'C', aggregate: false, rootKind: 'connectionReference', scope: 'solution', idCarrier: 'connectionreferenceid', reader: 'connectionReference', native: false,
    keyParts: (d) => [identifierPart(d.logicalName, 'logical name')],
    residual: 'The connection itself is not created or owned by this create.',
  },
  customApi: {
    class: 'C', aggregate: true, rootKind: 'customApi', scope: 'solution', idCarrier: 'customapiid', reader: 'customApi', native: false,
    keyParts: (d) => [identifierPart(d.uniqueName, 'unique name')],
    children: {
      customApiRequestParameter: (c) => [identifierPart(c.uniqueName, 'request parameter')],
      customApiResponseProperty: (c) => [identifierPart(c.uniqueName, 'response property')],
    },
    gate: 'A custom API is written with its request parameter and response property rows, and a bound API does not prove who created one at its derived id, so a protected rerun could overwrite one a maker made and report it created; custom APIs keep the existing create path.',
    residual: 'No business execution is attempted; every child is proven by a complete read.',
  },
  duplicateRule: {
    class: 'C', aggregate: true, rootKind: 'duplicateRule', scope: 'solution', idCarrier: 'duplicateruleid (deep insert)', reader: 'duplicateRule', native: false,
    keyParts: (d) => [stableKeyPart(d.key, 'rule key')],
    // The validator's condition key, byte for byte: editing a condition's criteria keeps its row id. Never attribute/operator/index.
    children: { duplicateRuleCondition: (c) => [stableKeyPart(c.key, 'condition key')] },
    gate: 'A rule is written with its condition rows, and a bound rule does not prove who created a condition at its derived id, so a protected rerun could overwrite one a maker made and report it created; duplicate detection rules keep the existing create path.',
    residual: 'Publication is a separate job; a present rule is not published.',
  },
  // ---- C, gated: identity is frozen here, but no id is allocated until the named proof exists ----
  app: {
    class: 'C', aggregate: true, rootKind: 'app', scope: 'app', idCarrier: 'appmoduleid', reader: null, native: false,
    keyParts: () => [],
    children: { sitemap: () => [] },
    gate: 'The sitemap row is reported not valid for create with a caller id; the platform must be shown to honor the supplied sitemap id, and an app root does not prove its sitemap, components, security or publication.',
    residual: 'App creates keep their unique-name lookup and existing recovery.',
  },
  appaction: {
    class: 'C', aggregate: true, rootKind: 'appaction', scope: 'table', idCarrier: 'appactionid of each actual row (the command artifact id is the table)', reader: null, native: false,
    keyParts: (d) => [subtypePart(d.context, 'context'), subtypePart(d.location, 'location'), ...(d.ancestorKeys || []).map((k) => stableKeyPart(k, 'ancestor key')), stableKeyPart(d.controlKey, 'control key')],
    gate: 'Every actual command row must carry its id through the SDK, with bagged ids preserved; unkeyed rows stay unprotected.',
    residual: 'Command rows without a stable key keep their existing behavior.',
  },
  businessRule: {
    class: 'C', aggregate: true, rootKind: 'businessRule', scope: 'table', idCarrier: 'workflowid', reader: null, native: false,
    keyParts: (d) => [keyOrName(d)],
    gate: 'The SDK rolls a failed rule back with an unconditional delete, which can remove a later same-id lifetime; a guarded rollback must be proven first.',
    residual: 'Business rules keep their existing consumer gate.',
  },
  bpf: {
    class: 'C', aggregate: true, rootKind: 'bpf', scope: 'table', idCarrier: 'workflowid', reader: null, native: false,
    keyParts: (d) => [keyOrName(d)],
    children: { bpfStage: (c) => [stableKeyPart(c.stageKey, 'stage key')], bpfStep: (c) => [stableKeyPart(c.stageKey, 'stage key'), stableKeyPart(c.stepKey, 'step key')] },
    gate: 'Activation, the backing table and the token-guarded rollback must be proven with the supplied workflow and stage ids.',
    residual: 'Process stages the platform creates on activation are not plugin creates.',
  },
  genPage: {
    class: 'C', aggregate: true, rootKind: 'genPage', scope: 'app', idCarrier: 'pageId', reader: null, native: false,
    keyParts: (d) => [stableKeyPart(d.key, 'page key')],
    gate: 'A pending or recorded page id wins; the page protocol (files, turns, checkpoints) must be proven unchanged with a supplied page id.',
    residual: 'A standalone page without a stable key keeps its documented limit.',
  },
  // ---- U (semantic): a setter keyed by the app and its setting definition ----
  appTheme: {
    class: 'U', semantic: true, aggregate: false, key: 'app + setting definition', rootKind: null, scope: null, idCarrier: null, reader: null, native: false,
    // What an applied theme result may say. The ids the SDK's result carries (the app's, the web resource's) are NOT projected:
    // an applied setting is not a creation receipt and grants no deletion authority.
    resultFields: ['outcome', 'published', 'resolved', 'rowState', 'pendingPublish', 'pendingReasons', 'superseded', 'solutionComponentsAdded', 'warnings'],
    // What the SDK's SetAppThemeResult.outcome may be (types/appTheme.ts): exactly these say what happened to the setting row; any
    // other answer does not, and is an unknown outcome.
    outcomes: ['created', 'updated', 'removed', 'unchanged'],
    residual: 'An unknown setter outcome stops (create-outcome-unknown) and is never sent again automatically.',
  },
  // ---- U: an enforced unique key identifies the row; no id is injected ----
  publisher: { class: 'U', aggregate: false, key: 'unique name', residual: 'A shared publisher is not newly owned.' },
  solution: { class: 'U', aggregate: false, key: 'unique name', residual: 'A prefix lookup is not creation proof.' },
  table: { class: 'U', aggregate: true, key: 'schema / logical name', residual: 'Platform-created default forms and views are not plugin creates.' },
  column: { class: 'U', aggregate: true, key: 'table + logical name', residual: 'An incomplete batch answer is not completion.' },
  customerLookup: { class: 'U', aggregate: true, key: 'lookup schema name and each generated relationship schema name', residual: 'Every generated relationship is verified.' },
  relationship: { class: 'U', aggregate: false, key: 'schema name', residual: 'Incompatible endpoints stop.' },
  globalChoice: { class: 'U', aggregate: false, key: 'choice name', residual: 'Option values are reconciled as before.' },
  alternateKey: { class: 'U', aggregate: true, key: 'table + key schema name', residual: 'Asynchronous activation keeps its polling.' },
  optionValue: { class: 'U', aggregate: false, key: 'table/attribute + explicit integer value', residual: 'An option inserted without a value would be N; the build always pins the value.' },
  columnVisualization: { class: 'U', aggregate: false, key: 'msdyn_<table>_<column>_customrenderers', residual: 'No new deletion authority.' },
  webResource: { class: 'U', aggregate: false, key: 'case-insensitive name', residual: 'Name, type, content and ownership checks as before; no id injection.' },
  appSetting: { class: 'U', aggregate: false, key: 'app + setting definition', residual: 'Existing upsert and ownership policy.' },
  aiAppSetting: { class: 'U', aggregate: false, key: 'scope + setting name', residual: 'Existing keyed operation.' },
  aiSkillConfig: { class: 'U', aggregate: true, key: 'skill unique name + model binding', residual: 'Existing skip and completion policy.' },
  // ---- N: neither a caller id nor an enforced key ----
  securityRole: { class: 'N', aggregate: true, residual: 'The SDK takes no role id and role names are not unique; a lost answer stays a documented limit.' },
  sampleRows: { class: 'N', aggregate: true, residual: 'Primary names are not unique; reading before writing cannot exclude a late commit.' },
  aiModel: { class: 'N', aggregate: true, residual: 'The SDK mints the model and run configuration ids; other effects of a lost answer are not provable.' },
  // ---- P: package/job protocol ----
  importMaterialized: { class: 'P', aggregate: true, residual: 'Package ids and job proofs are kept; an import job id is not an artifact id.' },
  // ---- page child rows the SDK derives from the actual page id (not plugin factories) ----
  pageFile: { class: 'P', aggregate: false, residual: 'The SDK derives page file ids from the actual page id and role.' },
  pageTurn: { class: 'P', aggregate: false, residual: 'A caller turn id per intended edit; equal edits can be distinct turns.' },
  // ---- not artifact factories: membership, assignment, privileges, publication ----
  membership: { class: 'P', aggregate: true, residual: 'Existing ownership and state proofs; an idempotent attach is not adoption authority.' },
});

// Things that look like creates in the source but are not separate rows this build creates — each with the reason. A future DIRECT
// row create of any of them needs its own descriptor; this list is not an escape for one.
const NON_ROW_EXCEPTIONS = freezeDeep({
  formCell: 'A form or dashboard cell is part of the saved form document (formxml), not a database row.',
  timelineNotesControl: 'The timeline control (notescontrol) is a fixed control inside the form document, not a row.',
  wfomNode: 'A business-rule graph node is part of the rule definition the SDK serialises; it is not persisted as its own row.',
  serializerWrapper: 'A serialiser-private wrapper is document structure the SDK writes, not a row.',
  processStage: 'Process stage rows are created by the platform when a business process flow is activated, not by a plugin POST.',
});

// The kind names call sites already send that are not descriptor names: each maps to the descriptor or non-row exception it is.
// Closed: a stable port refuses any kind that is not a descriptor, a declared child kind, a non-row exception or one of these, so
// a misspelt kind ('chrat') can never pass as an unprotected create. Every target here allocates no id (pinned by a test), so an
// alias can never send a protected kind around its protection.
const KIND_ALIASES = freezeDeep({
  command: 'appaction',
  'business-process-flow': 'bpf',
  'business-process-flow-children': 'bpf',
  'business-rule': 'businessRule',
  'business-rule-node': 'wfomNode',
  'web-resource': 'webResource',
  'form-layout': 'formCell',
  'form-layout-child': 'formCell',
  'dashboard-tile': 'formCell',
  formPageEmbed: 'formCell',
});

const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

// The descriptor or non-row exception a consumer's own kind name stands for; null when the name is not an alias.
function kindAliasOf(kind) {
  return own(KIND_ALIASES, kind) ? KIND_ALIASES[kind] : null;
}

// Whether `kind` names something this registry knows: a descriptor, a child kind a descriptor declares, a non-row exception or an
// alias. Own properties only, so 'toString' or '__proto__' are not kinds.
function isKnownCreateKind(kind) {
  if (own(DESCRIPTORS, kind) || own(NON_ROW_EXCEPTIONS, kind) || own(KIND_ALIASES, kind)) return true;
  return Object.values(DESCRIPTORS).some((d) => d.children && own(d.children, kind));
}

function capabilityFor(kind) {
  if (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(DESCRIPTORS, kind)) return DESCRIPTORS[kind];
  throw createStop('create-identity-unsupported', `creates: '${kind}' is not a kind this build knows how to create`);
}

// Whether a kind is sent with a stable identity in this release: a C descriptor with no open gate, whose create writes exactly one
// row. A create that also writes child rows (aggregate, or with declared children) is never allocated, even without a gate: the
// parent's binding is not authority over a row at a child's derived id, and nothing yet binds or adopts each child on its own.
function allocates(kind) {
  const d = capabilityFor(kind);
  return d.class === 'C' && !d.gate && !d.aggregate && !d.children;
}

// One validated create intent: the catalog entry the port allocates from. `key` is the plan's locator for the create (what the call
// site passes as `creates.run({ key })`); it is looked up, never parsed. `children` maps each child locator to its child kind and its
// own validated declaration — the same entry supplies a composite create and any later create of that child.
function intentFor(kind, { key, scope, declaration, children = [], boundId } = {}) {
  const d = capabilityFor(kind);
  if (d.class !== 'C') throw createStop('create-identity-unsupported', `creates: ${kind} is not created with a caller-supplied id`);
  if (typeof key !== 'string' || !key) throw createStop('create-identity-invalid', `creates: ${kind} needs a plan key`);
  if (!scope || scope.kind !== d.scope && !(kind === 'appaction' && ROOT_KINDS.appaction.scopes.includes(scope.kind))) {
    throw createStop('create-identity-invalid', `creates: ${kind} '${key}' needs a ${d.scope} scope`);
  }
  const keyParts = d.keyParts(declaration || {});
  const childRules = d.children || {};
  const slots = {};
  for (const c of children) {
    if (!c || typeof c.locator !== 'string' || !c.locator) throw createStop('create-identity-invalid', `creates: a child of ${kind} '${key}' has no locator`);
    if (Object.prototype.hasOwnProperty.call(slots, c.locator)) throw createStop('create-identity-invalid', `creates: ${kind} '${key}' names the child '${c.locator}' twice`);
    const rule = Object.prototype.hasOwnProperty.call(childRules, c.childKind) ? childRules[c.childKind] : undefined;
    if (!rule || !CHILD_KINDS[c.childKind]) throw createStop('create-identity-unsupported', `creates: ${kind} has no child kind '${c.childKind}'`);
    slots[c.locator] = { childKind: c.childKind, keyParts: rule(c.declaration || {}) };
  }
  return { kind, key, scope: { ...scope }, keyParts, children: slots, ...(boundId !== undefined ? { boundId } : {}) };
}

module.exports = { DESCRIPTORS, NON_ROW_EXCEPTIONS, KIND_ALIASES, capabilityFor, allocates, intentFor, kindAliasOf, isKnownCreateKind };
