'use strict';
// The build's side of stable create identities (`createIdentity: "stable-v1"`) for the two kinds this release routes through the
// composite create port: declared views and declared charts. Loaded only when a spec sets the field (sdk-build.js requires it
// lazily), so a spec without it loads nothing of this and sends the requests it always sent.
//
// What it hands the build, for the declared view and chart call sites only:
//   port           the create port: a declared view or chart create (creates-catalog.js) is sent with its derived id through the
//                  composite port; every other request goes to the build's own port unchanged.
//   managed        the binding lookup the view and chart planners read (reconcile-common.js lookupBinding). For a protected key it
//                  answers by id, never by name: the committed record's id, else a pending attempt's, else the derived id. Before any
//                  read, the workspace's copy at that id must be fresh or clean (creates-local.js assertCleanContinuation): a copy
//                  with an edit the server has not seen stops the item before anything fetches over it, reapplies or pushes it.
//   recordBinding  records a settled view or chart in the managed binding store (managed-bindings.js), as one group per key.
//   protects       whether (kind, key) is one of the protected creates.
//
// WHY THE LOOKUP IS BY ID. A create whose answer was lost made the row at the derived id. A rerun — from the same workspace or a
// fresh one — reads that id first and finds the row, so it binds it instead of creating a second one. A row with the declared name at
// any other id is a namesake: the planner's name lookup finds it, and the existing adoption approval decides, never a create.
//
// A row found at the derived id with no committed record is answered as an ADOPTED binding with no recorded hashes. That is the
// conservative reading: nothing proves this build made the row, so a row that already equals the spec is bound with no write, and a
// row that differs is drift that needs the overwrite approval rather than a silent rewrite.
//
// Without a store (no workspace folder, or a target no store can be kept for) the port and lookup still work by identity alone and
// nothing is persisted: a rerun finds the row by its derived id the same way.

const { createCompositePortForSpec } = require('./creates-port.js');
const { createStop } = require('./creates-identity.js');
const { assertCleanContinuation } = require('./creates-local.js');
const { isDeclaredView, declaredViewKey } = require('./view-reconcile.js');
const { isDeclaredChart, declaredChartKey } = require('./chart-reconcile.js');
const { canonicalJson, intentSha256, normalizeGuid } = require('./reconcile-common.js');

const SHIPPED_KINDS = Object.freeze(['view', 'chart']);
// The proof schema a view or chart group is committed under: the read-back baseline (reconcile-common.js projectionBaseline) is the proof.
const PROOF_SCHEMA = Object.freeze({ view: 'view-v1', chart: 'chart-v1' });

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;

/**
 * The catalog intents of a spec's declared views and charts (creates-catalog.js shape). An entry without a table or a name is left
 * out: it does not compile, and the planner refuses it before any create.
 */
function stableIntents(spec) {
  const solution = spec && spec.solution && spec.solution.uniqueName;
  const intents = [];
  for (const v of (spec && spec.views) || []) {
    if (!isDeclaredView(v) || !nonempty(v.entity) || !nonempty(v.name)) continue;
    const key = declaredViewKey(v);
    const declaration = typeof v.key === 'string' && v.key ? { queryType: 0, key: v.key } : { queryType: 0, name: v.name };
    intents.push({ catalogKind: 'view', key, scope: { kind: 'table', solution, table: lc(v.entity) }, declaration });
  }
  for (const c of (spec && spec.charts) || []) {
    if (!isDeclaredChart(c) || !nonempty(c.entity) || !nonempty(c.name)) continue;
    intents.push({ catalogKind: 'chart', key: declaredChartKey(c), scope: { kind: 'table', solution, table: lc(c.entity) }, declaration: { name: c.name.trim() } });
  }
  return intents;
}

// What a view or chart create is expected to leave, written before the create is sent (managed-bindings.js markSending). A view's and a
// chart's content is proved by the read-back baseline when the binding is recorded, so the expectation names the identity it was sent
// under: the same (kind, key, id) gives the same expectation, which is what lets a rerun continue an attempt that was sent.
function expectedFor(kind, key, id) {
  const identity = intentSha256({ kind, key, id });
  return {
    proofVersion: 1,
    proofSchema: PROOF_SCHEMA[kind],
    rootId: id,
    baseProofSha256: null,
    sentProjectionSha256: identity,
    preservationSha256: identity,
    baseObservation: null,
    children: [],
  };
}

const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404);

/**
 * @param {{ spec: object, sdk: object, store: object|null, barrier?: object|null, basePort: { run: Function }, fallback?: { lookup?: Function, recordApplied?: Function } }} args
 *   sdk       the build's provisioning SDK (listArtifacts, diffArtifact and fetchArtifact are read here);
 *   store     the managed binding store handle (managed-bindings.js openManagedBindings), or null for identity alone;
 *   barrier   the run's publication barrier (publication-barrier.js), which the store's opener (openManagedContext) gave the hold of an
 *             attempt an earlier run left pending; the commit that proves that attempt releases its hold, and only that one;
 *   basePort  the build's own create port, which every request that is not a protected create goes to;
 *   fallback  the build's own managed-artifacts port, answered for a key that is not protected.
 * @returns {null | { port, managed: { lookup }, recordBinding, protects, identityFor }} null when the spec declares no view or chart.
 */
function createStableCreates({ spec, sdk, store = null, barrier = null, basePort, fallback = null } = {}) {
  if (!basePort || typeof basePort.run !== 'function') throw new TypeError('createStableCreates: basePort must be a create port');
  const intents = stableIntents(spec);
  if (!intents.length) return null;
  // An attempt names its table as the scope it may leave saved and unproved: an attempt an earlier run left pending holds that
  // table's publish (openManagedContext) until this build proves and commits it, so a view whose create lost its answer is never
  // published by its table's publish before the build has seen it.
  const scopesOf = (kind, key) => { const table = tableOf(intents, kind, key); return table ? [{ type: 'table', table }] : []; };

  async function onAttempt({ kind, key, id }) {
    if (!store) return;
    const g = store.readGroup(kind, key);
    const expected = expectedFor(kind, key, id);
    if (g.pending) {
      if (g.pending.root.id !== id) throw createStop('create-completion-required', `${kind} ${key}: an earlier create was sent as ${g.pending.root.id}, not ${id}; it must be completed before another is sent`, { create: { kind, key, id } });
      store.markSending(g.pending.token, expected);
      return;
    }
    if (g.committed) throw createStop('create-completion-required', `${kind} ${key}: it is already bound to ${g.committed.root.id}; a second create is not sent`, { create: { kind, key, id } });
    store.prepareAttempt({ family: kind, key, baseGeneration: null, root: { kind, key, id }, expected, knownScopes: scopesOf(kind, key), declarationSha256: intentSha256({ kind, key }) });
  }

  const composite = createCompositePortForSpec(spec, { intents, shippedKinds: SHIPPED_KINDS, onAttempt });
  const protects = (kind, key) => typeof composite.protects === 'function' && composite.protects(kind, key) === true;

  const port = {
    async run(request, execute) {
      if (!request || !protects(request.kind, request.key)) return basePort.run(request, execute);
      const out = await composite.run(request, execute);
      // The create was acknowledged at the id it was sent with: the attempt's root may be recorded as created.
      if (store && out && out.outcome === 'created') {
        const g = store.readGroup(request.kind, request.key);
        if (g.pending && g.pending.root.id === out.id) store.noteSaved(g.pending.token, { acknowledgedRoot: true });
      }
      return out;
    },
  };

  async function lookup(kind, key) {
    if (!protects(kind, key)) return fallback && typeof fallback.lookup === 'function' ? fallback.lookup(kind, key) : null;
    const g = store ? store.readGroup(kind, key) : { committed: null, pending: null };
    const committedRoot = g.committed ? g.committed.records.find((r) => r.kind === kind && r.key === key) : null;
    const id = committedRoot ? normalizeGuid(committedRoot.id) : g.pending ? g.pending.root.id : composite.identityFor(kind, key).id;
    await assertCleanContinuation(sdk, kind, id);
    if (committedRoot) return { ...committedRoot };
    try {
      await sdk.fetchArtifact(kind, id);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const envelope = store ? store.snapshot().envelope : null;
    return {
      formatVersion: 1,
      appUniqueName: envelope ? envelope.appUniqueName : '',
      environmentFingerprint: envelope ? envelope.environmentFingerprint : '',
      kind,
      key,
      id,
      origin: 'adopted',
    };
  }

  // Synchronous, as the build's settlement calls it (reconcile-common.js createFeatureSettlement): every store change is one atomic write.
  function recordBinding(b) {
    if (!b || !protects(b.kind, b.key)) {
      if (fallback && typeof fallback.recordApplied === 'function') fallback.recordApplied(b);
      return;
    }
    if (!store) return;
    const { kind, key } = b;
    const envelope = store.snapshot().envelope;
    const id = normalizeGuid(b.id);
    if (!id) throw createStop('create-identity-unverified', `${kind} ${key}: the bound id ${b.id} is not a GUID`, { create: { kind, key } });
    const g = store.readGroup(kind, key);
    const committedRoot = g.committed ? g.committed.records.find((r) => r.kind === kind && r.key === key) : null;
    const rec = {
      formatVersion: 1,
      appUniqueName: envelope.appUniqueName,
      environmentFingerprint: envelope.environmentFingerprint,
      kind,
      key,
      id,
      intentSha256: b.intentSha256,
      // A new record claims `created` only on a create this store saw acknowledged; a row found at the derived id (a lost answer, a
      // native match) is adopted. A record the group already holds keeps the origin it has (managed-bindings.js commitGroup).
      origin: committedRoot ? b.origin : g.pending && g.pending.acknowledgedRoot && b.origin === 'created' ? 'created' : 'adopted',
      ...(b.partsSha256 && typeof b.partsSha256 === 'object' ? { partsSha256: { ...b.partsSha256 } } : {}),
    };
    const same = (r) => !!r && normalizeGuid(r.id) === id && r.intentSha256 === rec.intentSha256 && canonicalJson(r.partsSha256 || null) === canonicalJson(rec.partsSha256 || null);
    if (!g.pending && same(committedRoot)) return;
    const baseGeneration = g.pending ? g.pending.baseGeneration : g.committed ? g.committed.generation : null;
    const token = g.pending
      ? g.pending.token
      : store.prepareAttempt({ family: kind, key, baseGeneration, root: { kind, key, id: g.committed ? g.committed.root.id : id }, expected: expectedFor(kind, key, g.committed ? g.committed.root.id : id), knownScopes: scopesOf(kind, key), declarationSha256: intentSha256({ kind, key }) });
    store.commitGroup({
      token,
      baseGeneration,
      records: [rec],
      proof: { savedSha256: rec.intentSha256, semanticSha256: rec.intentSha256, preservationSha256: rec.intentSha256, expectedChildrenSha256: null },
      consumerState: { baseline: { intentSha256: rec.intentSha256 } },
      // A view's or chart's publication is the build's own (its table's publish); the group owes none of its own.
      publication: { scope: { type: 'table', table: tableOf(intents, kind, key) }, state: 'not-needed', desiredSha256: null, dispatchToken: null },
      proofSchema: PROOF_SCHEMA[kind],
    });
    // The attempt is proved and committed: its own hold (if an earlier run left it pending) ends; any other hold or block stays.
    if (g.pending && barrier && typeof barrier.release === 'function') barrier.release(token);
  }

  return {
    port,
    managed: { lookup },
    recordBinding,
    protects,
    identityFor: (kind, key) => (protects(kind, key) ? composite.identityFor(kind, key) : null),
  };
}

function tableOf(intents, kind, key) {
  const i = intents.find((x) => x.catalogKind === kind && x.key === key);
  return i ? i.scope.table : '';
}

module.exports = { createStableCreates, stableIntents, SHIPPED_KINDS };
