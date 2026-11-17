'use strict';
// The catalog of declared creates that the composite create port (creates-port.js createCompositeCreatesPort) protects: views and
// charts under `createIdentity: "stable-v1"`, and forms, dashboards, business rules and process flows that a spec declares with
// `reconcile: "declared"`.
//
// Why a second catalog beside creates-port.js createIntentCatalog: the old aggregate (creates-capabilities.js allocates) keeps
// refusing form, dashboard, businessRule and bpf, because nothing on that path records a binding or proves a child. Those four,
// plus view and chart, enter ONLY through compositeCapability below, and only for the exact declarations a spec names:
//   - a catalogued intent is protected; a sibling of the same kind that the spec does not declare is NOT (routeIntent answers
//     'legacy' for it and the port sends it through the plain pass-through), so declaring one form never refuses another form;
//   - a kind name that is an alias in creates-capabilities.js (formPageEmbed, form-layout, web-resource, ...) is never translated
//     into a protected lookup: compositeCapability refuses it;
//   - children are reserved under the ACTUAL root id (a committed, pending or imported id wins over the derived one), and the whole
//     child graph is derived before any local SDK edit, by reserveChildren, which has no execute callback.
// Ids come from creates-identity.js only (stableCreateIdV1 / stableChildIdV1): the same spec gives the same ids in every process.
// The one exception is a key whose root the binding store retired: the store's incarnation for that key (a fresh random id,
// createIntentCatalog's `incarnations` option) replaces its derived root id, so a re-declaration is a new row, never the retired
// one; its children are still derived by stableChildIdV1, under that id.
//
// Pure: data and functions, no network, no disk, no state outside the frozen catalogs it returns.

const {
  createStop, identifierPart, stableKeyPart, stableCreateIdV1, stableChildIdV1, CHILD_KINDS, GUID_RE,
} = require('./creates-identity.js');
const { DESCRIPTORS } = require('./creates-capabilities.js');

const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const lowerGuid = (v) => (typeof v === 'string' ? v.replace(/^\{|\}$/g, '').toLowerCase() : '');

// The six kinds the composite port may protect. `family` is the managed-bindings.js family a feature settles under and
// `bindingKind` the kind its root binding record carries (managed-bindings.js ROOT_KIND: the rule family binds its root as
// `business-rule`); `helper` names the reconcile helper that owns the kind; `sdkRow` is the Dataverse table that helper already
// reads the row from. `childKinds` is the closed set of children a kind may reserve.
const COMPOSITE = Object.freeze({
  form: Object.freeze({ family: 'form', bindingKind: 'form', helper: 'form-layout', sdkRow: 'systemform', childKinds: Object.freeze(['formTab', 'formSection', 'formCell', 'formControl', 'formHostSection', 'formHostCell', 'formHostControl', 'formSpacer']) }),
  dashboard: Object.freeze({ family: 'dashboard', bindingKind: 'dashboard', helper: 'dashboard', sdkRow: 'systemform', childKinds: Object.freeze(['dashboardSeedTab', 'dashboardSeedSection', 'dashboardCell', 'dashboardControl']) }),
  // A business rule has no child ids: the SDK's parser does not keep a supplied node id, so a node child kind would promise
  // something the saved rule does not hold.
  businessRule: Object.freeze({ family: 'rule', bindingKind: 'business-rule', helper: 'business-rule', sdkRow: 'workflow', childKinds: Object.freeze([]) }),
  bpf: Object.freeze({ family: 'bpf', bindingKind: 'bpf', helper: 'business-process-flow', sdkRow: 'workflow', childKinds: Object.freeze(['bpfStage', 'bpfStep']) }),
  view: Object.freeze({ family: 'view', bindingKind: 'view', helper: 'view-reconcile', sdkRow: 'savedquery', childKinds: Object.freeze([]) }),
  chart: Object.freeze({ family: 'chart', bindingKind: 'chart', helper: 'chart-reconcile', sdkRow: 'savedqueryvisualization', childKinds: Object.freeze([]) }),
});

/**
 * What the composite port may do for `catalogKind`. Anything outside the six kinds above, an alias included, is
 * create-identity-unsupported: the composite port never protects a kind it was not built for.
 * @returns {{ catalogKind, family, bindingKind, helper, sdkRow, rootKind, scope, native, childKinds }}
 */
function compositeCapability(catalogKind) {
  if (!own(COMPOSITE, catalogKind)) throw createStop('create-identity-unsupported', `creates: '${catalogKind}' is not a kind the composite create port protects`);
  const c = COMPOSITE[catalogKind];
  const d = DESCRIPTORS[catalogKind];
  return Object.freeze({ catalogKind, family: c.family, bindingKind: c.bindingKind, helper: c.helper, sdkRow: c.sdkRow, rootKind: d.rootKind, scope: d.scope, native: d.native, childKinds: c.childKinds });
}

// ---- children ------------------------------------------------------------------------------------------------------------------

// The form hosts and the id slots each one keeps (a host the serializer would otherwise give fresh ids). A quick view sits in an
// existing section, so it has no section slot; a timeline keeps the platform's fixed control id `notescontrol`, so it has no
// control slot. A slot outside this table is refused before anything is derived.
const HOST_SLOTS = Object.freeze({
  subgrid: Object.freeze(['formHostSection', 'formHostCell', 'formHostControl']),
  quickView: Object.freeze(['formHostCell', 'formHostControl']),
  timeline: Object.freeze(['formHostSection', 'formHostCell']),
});

const literal = (expected, what) => (value) => {
  if (value !== expected) throw createStop('create-identity-invalid', `create identity: ${what} must be '${expected}'; got ${JSON.stringify(value)}`);
  return value;
};

function hostParts(childKind) {
  return ([hostClass, hostKey]) => {
    if (!own(HOST_SLOTS, hostClass)) throw createStop('create-identity-unsupported', `create identity: '${hostClass}' is not a form host this build keeps ids for`);
    if (!HOST_SLOTS[hostClass].includes(childKind)) throw createStop('create-identity-unsupported', `create identity: a ${hostClass} host has no ${childKind} slot`);
    // A sub-grid is keyed by its relationship schema name and a quick view by its lookup column, both ASCII-lowercased as the
    // form helper keys their bindings (`cell:subgrid:<rel>`); a timeline has one per form, keyed by the literal.
    const key = hostClass === 'timeline' ? literal('timeline', 'a timeline host key')(hostKey) : identifierPart(hostKey, `${hostClass} host key`);
    return [hostClass, key];
  };
}

// Each child kind's canonical key parts. An authored key (tab, section, spacer, tile, stage, step) is the validator's output byte
// for byte (stableKeyPart); a logical name is ASCII-lowercased (identifierPart); a fixed slot is its literal. No position and no
// content is ever a part, so reordering or renaming a child keeps its id.
const CHILD_RULES = Object.freeze({
  formTab: ([tabKey]) => [stableKeyPart(tabKey, 'tab key')],
  formSection: ([tabKey, sectionKey]) => [stableKeyPart(tabKey, 'tab key'), stableKeyPart(sectionKey, 'section key')],
  formCell: ([formKey, field]) => [stableKeyPart(formKey, 'form key'), identifierPart(field, 'field')],
  formControl: ([formKey, field]) => [stableKeyPart(formKey, 'form key'), identifierPart(field, 'field')],
  formHostSection: hostParts('formHostSection'),
  formHostCell: hostParts('formHostCell'),
  formHostControl: hostParts('formHostControl'),
  formSpacer: ([slot]) => [stableKeyPart(slot, 'spacer slot')],
  dashboardSeedTab: ([slot]) => [literal('seed-tab', 'the dashboard seed tab key')(slot)],
  dashboardSeedSection: ([slot]) => [literal('seed-section', 'the dashboard seed section key')(slot)],
  dashboardCell: ([tileKey, slot]) => [stableKeyPart(tileKey, 'tile key'), literal('cell', 'a dashboard cell slot')(slot)],
  dashboardControl: ([tileKey, slot]) => [stableKeyPart(tileKey, 'tile key'), literal('control', 'a dashboard control slot')(slot)],
  bpfStage: ([stageKey]) => [stableKeyPart(stageKey, 'stage key')],
  bpfStep: ([stageKey, stepKey]) => [stableKeyPart(stageKey, 'stage key'), stableKeyPart(stepKey, 'step key')],
});

// Arity before anything else, in the identity module's own words ("expected 2"), so a one-part bpfStep is refused as the wrong
// shape rather than reaching a part canonicaliser with a missing value.
function checkArity(childKind, parts) {
  const rule = CHILD_KINDS[childKind];
  if (!Array.isArray(parts)) throw createStop('create-identity-invalid', `create identity: the key of ${childKind} must be an array`);
  if (parts.length < rule.min || parts.length > rule.max) {
    throw createStop('create-identity-invalid', `create identity: the key of ${childKind} has ${parts.length} part(s); expected ${rule.min === rule.max ? rule.min : `${rule.min}-${rule.max}`}`);
  }
}

// ---- the catalog ---------------------------------------------------------------------------------------------------------------

// Brands: an entry or a catalog is recognised by identity, never by shape, so a hand-built look-alike is not routed to the port.
const ENTRIES = new WeakSet();
const CATALOGS = new WeakMap(); // catalog -> Map(slot -> entry)
const slotOf = (kind, key) => `${kind}\u0000${key}`;

function normalizeIntent(intent, incarnation) {
  if (!intent || typeof intent !== 'object') throw createStop('create-identity-invalid', 'creates: a catalog intent must be an object');
  const cap = compositeCapability(intent.catalogKind);
  const { key } = intent;
  if (typeof key !== 'string' || !key) throw createStop('create-identity-invalid', `creates: ${intent.catalogKind} needs a plan key`);
  const scope = intent.scope;
  if (!scope || scope.kind !== cap.scope) throw createStop('create-identity-invalid', `creates: ${intent.catalogKind} '${key}' needs a ${cap.scope} scope`);
  const keyParts = DESCRIPTORS[intent.catalogKind].keyParts(intent.declaration || {});
  const stableId = stableCreateIdV1({ scope, kind: cap.rootKind, keyParts });
  const reborn = incarnation(cap.family, key, stableId);
  const entry = Object.freeze({
    catalogKind: intent.catalogKind,
    key,
    bindingKind: cap.bindingKind,
    scope: Object.freeze({ ...scope }),
    keyParts: Object.freeze(keyParts.slice()),
    // The id a create of this key uses: its incarnation once its root was retired, its stable id otherwise.
    derivedId: reborn ? reborn.rootId : stableId,
    stableId,
    // The plan's incarnation token, handed to the managed binding store's prepareAttempt (`incarnation`): the store
    // selects again under the lease by the same rule and refuses a plan whose epoch or root is not the current one.
    incarnation: Object.freeze({ identity: stableId, epoch: reborn ? reborn.epoch : 0, rootId: reborn ? reborn.rootId : null }),
  });
  ENTRIES.add(entry);
  return entry;
}

// The `incarnations` option of createIntentCatalog: [{ family, key, identity, rootId, epoch }], as the managed binding
// store answers them (managed-bindings.js incarnations()). Checked whole before any intent is read; one entry per
// (family, key) and one per (family, identity). A declaration selects its own key's entry first, else the entry whose
// identity is its stable id: the stable id is the catalog's canonical identity (descriptor key parts, a name folded as
// Dataverse compares it, an explicit stable key byte for byte), so a spelling the identity algorithm treats as the same
// artifact (a case-only rename of a rule or flow, an accent in a form name) takes the incarnation of the root it
// retired, never that retired stable id. managed-bindings.js incarnationOf selects by the same rule under the lease.
function incarnationIndex(incarnations) {
  if (incarnations === undefined || incarnations === null) return () => null;
  if (!Array.isArray(incarnations)) throw createStop('create-identity-invalid', 'creates: the incarnations must be an array');
  const byKey = new Map();
  const byIdentity = new Map();
  for (const x of incarnations) {
    if (!x || typeof x !== 'object' || typeof x.family !== 'string' || typeof x.key !== 'string' || !x.key) {
      throw createStop('create-identity-invalid', 'creates: an incarnation needs a family and a key');
    }
    const rootId = lowerGuid(x.rootId);
    const identity = lowerGuid(x.identity);
    if (!GUID_RE.test(rootId) || !GUID_RE.test(identity)) throw createStop('create-identity-invalid', `creates: the incarnation of ${x.family} '${x.key}' has no GUID root id and identity`);
    if (!Number.isSafeInteger(x.epoch) || x.epoch < 1) throw createStop('create-identity-invalid', `creates: the incarnation of ${x.family} '${x.key}' has no epoch`);
    const slot = slotOf(x.family, x.key);
    const ident = slotOf(x.family, identity);
    if (byKey.has(slot)) throw createStop('create-identity-invalid', `creates: ${x.family} '${x.key}' has two incarnations`);
    if (byIdentity.has(ident)) throw createStop('create-identity-invalid', `creates: two incarnations of ${x.family} share the identity ${identity}`);
    const entry = Object.freeze({ rootId, epoch: x.epoch });
    byKey.set(slot, entry);
    byIdentity.set(ident, entry);
  }
  return (family, key, stableId) => byKey.get(slotOf(family, key)) || byIdentity.get(slotOf(family, stableId)) || null;
}

/**
 * The validated catalog of one plan's declared creates. Each intent is
 *   { catalogKind, key, scope: { kind, solution, table? }, declaration }
 * where `key` is the locator the call site passes as creates.run({ kind, key }) and `declaration` feeds the kind's own key parts
 * (creates-capabilities.js DESCRIPTORS[kind].keyParts). The same (kind, key) twice, or two intents that derive one id (two names
 * Dataverse treats as one artifact), are refused here with create-identity-invalid, before any create is sent.
 * `incarnations`: the managed binding store's [{ family, key, identity, rootId, epoch }] (managed-bindings.js
 * incarnations()). A declaration whose key, or whose stable id (as `identity`), has an incarnation takes its `rootId` as
 * its `derivedId`, so it is created again as a new row under a new id, never under the stable id that was retired; its
 * children are derived under that id too. Its `stableId` stays the spec's own. Every entry carries `incarnation:
 * { identity, epoch, rootId }` (epoch 0 and rootId null with none), the token prepareAttempt checks under the lease.
 */
function createIntentCatalog(intents = [], { incarnations } = {}) {
  if (!Array.isArray(intents)) throw createStop('create-identity-invalid', 'creates: the catalog intents must be an array');
  const incarnation = incarnationIndex(incarnations);
  const bySlot = new Map();
  const byId = new Map();
  for (const intent of intents) {
    const entry = normalizeIntent(intent, incarnation);
    const slot = slotOf(entry.catalogKind, entry.key);
    if (bySlot.has(slot)) throw createStop('create-identity-invalid', `creates: ${entry.catalogKind} '${entry.key}' is declared twice`);
    // Two declarations are one artifact when their stable ids match, whichever of them was reborn; and no two may create
    // under one id.
    for (const id of new Set([entry.stableId, entry.derivedId])) {
      const other = byId.get(id);
      if (other) throw createStop('create-identity-invalid', `creates: ${entry.catalogKind} '${entry.key}' and ${other.catalogKind} '${other.key}' are one artifact (identity ${id}); give them distinct keys`);
    }
    bySlot.set(slot, entry);
    byId.set(entry.stableId, entry);
    byId.set(entry.derivedId, entry);
  }
  const catalog = {
    size: bySlot.size,
    has: (kind, key) => bySlot.has(slotOf(kind, key)),
    get: (kind, key) => bySlot.get(slotOf(kind, key)) || null,
    entries: () => [...bySlot.values()],
    identityFor: (kind, key, opts = {}) => identityFor(kind, key, { ...opts, catalog }),
    // The plan's incarnation token of a declared key (the entry's `incarnation`), for runManagedFeature `incarnation`;
    // undefined for a key the plan does not declare, which the feature's own resolve stops.
    incarnationOf: (kind, key) => {
      const entry = bySlot.get(slotOf(kind, key));
      return entry ? entry.incarnation : undefined;
    },
    reserveChildren: (kind, key, opts = {}) => reserveChildren(kind, key, { ...opts, catalog }),
    routeIntent: (intent) => routeIntent(intent, { catalog }),
  };
  CATALOGS.set(catalog, bySlot);
  return Object.freeze(catalog);
}

const isIntentCatalog = (c) => !!c && typeof c === 'object' && CATALOGS.has(c);

function entryOf(catalogKind, keyOrEntry, catalog) {
  compositeCapability(catalogKind);
  if (keyOrEntry && typeof keyOrEntry === 'object' && ENTRIES.has(keyOrEntry)) {
    if (keyOrEntry.catalogKind !== catalogKind) throw createStop('create-identity-invalid', `creates: the entry is a ${keyOrEntry.catalogKind}, not a ${catalogKind}`);
    return keyOrEntry;
  }
  if (!isIntentCatalog(catalog)) throw createStop('create-identity-invalid', `creates: ${catalogKind} '${keyOrEntry}' needs its catalog`);
  const entry = CATALOGS.get(catalog).get(slotOf(catalogKind, keyOrEntry));
  if (!entry) throw createStop('create-identity-invalid', `creates: ${catalogKind} '${keyOrEntry}' is not declared in the plan`, { create: { kind: catalogKind, key: keyOrEntry } });
  return entry;
}

/**
 * The root id a declared create uses. `actualRootId` (a committed binding, a pending attempt, or an imported row) wins over the
 * derived id; without it the derived id is used. `keyOrEntry` is the plan key with `opts.catalog`, or a catalog entry.
 * @returns {{ id, source: 'actual'|'derived', derivedId, bindingKind }}
 */
function identityFor(catalogKind, keyOrEntry, { actualRootId, catalog } = {}) {
  const entry = entryOf(catalogKind, keyOrEntry, catalog);
  if (actualRootId !== undefined && actualRootId !== null) {
    const actual = lowerGuid(actualRootId);
    if (!GUID_RE.test(actual)) throw createStop('create-identity-invalid', `creates: the actual id of ${catalogKind} '${entry.key}' is not a GUID`);
    return Object.freeze({ id: actual, source: 'actual', derivedId: entry.derivedId, bindingKind: entry.bindingKind });
  }
  return Object.freeze({ id: entry.derivedId, source: 'derived', derivedId: entry.derivedId, bindingKind: entry.bindingKind });
}

/**
 * Every child id of one declared create, derived before any local SDK edit or wire call. Each child is
 *   { locator, childKind, keyParts, parentLocator?, actualParentId? }
 * A child is derived under the actual root id, except a bpfStep, which is derived under its stage: the stage this same
 * reservation derives (`parentLocator`), or an already-proved stage of an imported or adopted flow (`actualParentId`). A step's
 * keyParts keep its stage key although its namespace is the stage id. A child kind the root kind does not own, a host slot that
 * host does not have, the wrong arity, a duplicate locator or two children with one id are refused before anything is derived
 * for use, so a caller can never start a write with part of a graph.
 * @returns {{ rootId, childIds: { [locator]: id } }}
 */
function reserveChildren(catalogKind, keyOrEntry, { actualRootId, children = [], catalog } = {}) {
  const cap = compositeCapability(catalogKind);
  const { id: rootId } = identityFor(catalogKind, keyOrEntry, { actualRootId, catalog });
  if (!Array.isArray(children)) throw createStop('create-identity-invalid', `creates: the children of ${catalogKind} must be an array`);
  const shaped = [];
  const locators = new Set();
  for (const c of children) {
    if (!c || typeof c !== 'object' || typeof c.locator !== 'string' || !c.locator) throw createStop('create-identity-invalid', `creates: a child of ${catalogKind} has no locator`);
    if (locators.has(c.locator)) throw createStop('create-identity-invalid', `creates: ${catalogKind} names the child '${c.locator}' twice`);
    locators.add(c.locator);
    if (!cap.childKinds.includes(c.childKind)) throw createStop('create-identity-unsupported', `creates: ${catalogKind} has no child kind '${c.childKind}'`);
    checkArity(c.childKind, c.keyParts);
    const parts = CHILD_RULES[c.childKind](c.keyParts);
    const hasLocatorParent = c.parentLocator !== undefined;
    const hasActualParent = c.actualParentId !== undefined;
    if (c.childKind === 'bpfStep') {
      if (hasLocatorParent === hasActualParent) throw createStop('create-identity-invalid', `creates: the step '${c.locator}' needs exactly one parent: a stage it reserves with (parentLocator) or an actual stage id (actualParentId)`);
    } else if (hasLocatorParent || hasActualParent) {
      throw createStop('create-identity-invalid', `creates: a ${c.childKind} is derived under the ${catalogKind} itself and takes no other parent`);
    }
    shaped.push({ ...c, parts });
  }
  const childIds = {};
  const seen = new Map();
  const keep = (locator, id) => {
    if (seen.has(id)) throw createStop('create-identity-invalid', `creates: ${catalogKind} has two children that are one row ('${seen.get(id)}' and '${locator}')`);
    seen.set(id, locator);
    childIds[locator] = id;
  };
  // Stages first, so a step may name its stage in any order of the list.
  for (const c of shaped) if (c.childKind !== 'bpfStep') keep(c.locator, stableChildIdV1(rootId, c.childKind, c.parts));
  const byLocator = new Map(shaped.map((c) => [c.locator, c]));
  for (const c of shaped) {
    if (c.childKind !== 'bpfStep') continue;
    let parentId;
    if (c.parentLocator !== undefined) {
      const stage = byLocator.get(c.parentLocator);
      if (!stage || stage.childKind !== 'bpfStage') throw createStop('create-identity-invalid', `creates: the step '${c.locator}' names '${c.parentLocator}', which is not a stage of this flow`);
      if (stage.parts[0] !== c.parts[0]) throw createStop('create-identity-invalid', `creates: the step '${c.locator}' carries the stage key '${c.parts[0]}' but sits under the stage '${stage.parts[0]}'`);
      parentId = childIds[c.parentLocator];
    } else {
      parentId = lowerGuid(c.actualParentId);
      if (!GUID_RE.test(parentId)) throw createStop('create-identity-invalid', `creates: the actual stage id of the step '${c.locator}' is not a GUID`);
    }
    keep(c.locator, stableChildIdV1(parentId, 'bpfStep', c.parts));
  }
  return Object.freeze({ rootId, childIds: Object.freeze(childIds) });
}

/**
 * 'composite' when `intent` is a declared create of the catalog — a catalog entry, or a { catalogKind | kind, key } the catalog
 * holds — and 'legacy' for everything else, including a sibling of a declared kind that the spec did not declare. Never throws: a
 * route question about a malformed request answers 'legacy', and the legacy path validates the request as it always did.
 */
function routeIntent(intent, { catalog } = {}) {
  try {
    if (!intent || typeof intent !== 'object') return 'legacy';
    if (ENTRIES.has(intent)) {
      if (catalog === undefined) return 'composite';
      return isIntentCatalog(catalog) && CATALOGS.get(catalog).get(slotOf(intent.catalogKind, intent.key)) === intent ? 'composite' : 'legacy';
    }
    if (!isIntentCatalog(catalog)) return 'legacy';
    const kind = intent.catalogKind !== undefined ? intent.catalogKind : intent.kind;
    if (typeof kind !== 'string' || typeof intent.key !== 'string') return 'legacy';
    return CATALOGS.get(catalog).has(slotOf(kind, intent.key)) ? 'composite' : 'legacy';
  } catch {
    return 'legacy';
  }
}

module.exports = {
  createIntentCatalog,
  identityFor,
  reserveChildren,
  compositeCapability,
  routeIntent,
  isIntentCatalog,
  COMPOSITE_KINDS: Object.freeze(Object.keys(COMPOSITE)),
  HOST_SLOTS,
};
