'use strict';
// The build's side of stable create identities (`createIdentity: "stable-v1"`) for the two kinds this release routes through the
// composite create port: declared views and declared charts. Loaded only when a spec sets the field (sdk-build.js requires it
// lazily), so a spec without it loads nothing of this and sends the requests it always sent.
//
// What it hands the build, for the declared view and chart call sites only:
//   port           the create port: a declared view or chart create (creates-catalog.js) is sent with its derived id through the
//                  composite port; every other request goes to the build's own port unchanged.
//   managed        what the view and chart planners read (reconcile-common.js lookupBinding):
//                    lookup   the committed binding of a protected key, and nothing else. Before it answers, the workspace's copy
//                             at the key's id must be fresh or clean (creates-local.js assertCleanContinuation): a copy with an edit
//                             the server has not seen stops the item before anything fetches over it, reapplies or pushes it;
//                    observe  for a key with no binding: the row at the key's stable id (a pending attempt's root, else the derived
//                             id), or null when the service says it does not exist. An OBSERVATION, never a binding: the planner
//                             reads that row as unbound, so changing it needs the adoption approval and binding an equal row needs
//                             it too (see below).
//   settle         with a store: one declared view or chart, through the managed settlement (managed-feature-contract.js
//                  runManagedFeature) — see SETTLEMENT below.
//   recoverUndeclared  with a store: the pending view and chart attempts whose declaration the spec no longer carries, recovered
//                  against the expectation each recorded (see SETTLEMENT); the build runs it before its views.
//   recordBinding  the settlement's binding hook (reconcile-common.js createFeatureSettlement). With a store, the binding was
//                  committed by `settle`, so this only accepts the binding the store already holds.
//   protects       whether (kind, key) is one of the protected creates.
//
// WHY THE LOOKUP IS BY ID. A create whose answer was lost made the row at the derived id. A rerun — from the same workspace or a
// fresh one — reads that id first and finds the row, so it never creates a second one. A row with the declared name at any other id
// is a namesake: the planner's name lookup finds it, and the existing adoption approval decides, never a create.
//
// WHY AN OBSERVATION IS NOT A BINDING. Nothing about a row at the derived id proves that this build made it or that the maker
// agreed to manage it: an earlier run whose answer was lost, another workspace, or anyone who created a row with that id. So it is
// bound only on a create this store saw acknowledged, or with the typed adoption approval (`--authorize adopt:view:<key>`,
// `adopt:chart:<key>`), or a pinned id. An equal row with neither is left unbound and nothing is written; a row that differs is
// refused as unbound (`view-adoption-not-authorized` / `chart-adoption-not-authorized`).
//
// SETTLEMENT (with a store). Each declared view or chart is one managed group, settled by runManagedFeature in this order:
//   preflight   the workspace copy at the key's id must be fresh or clean, on every path, recoveries included;
//   resolve     plan the view or chart as before (the planner reads; nothing is written);
//   plan        a refusal, an unknown, or nothing to send or bind settles as before, outside the store. A create, an update or a
//               bind becomes an attempt whose COMPLETE expectation is written before anything is sent: the full projection the
//               row must hold afterwards (sentProjectionSha256), the hash of the parts the change keeps as they are
//               (preservationSha256), the committed proof it was planned on, the declaration hash and the table publication;
//   apply       sends the change once, through the store's send observer when the build installed one. A create is
//               pinned at the transport (publication-barrier.js pinCreate): the build serialises the body the local draft it
//               made must produce, and the actual POST at that id is refused unsent (create-local-draft-changed) unless it
//               is exactly that body — another local process editing the draft before the push cannot change what is sent.
//               The build never removes a local draft: one a lost or refused create leaves stays (create-local-draft-kept),
//               its attempt stays pending, and the next build stops at it until the maker removes or refreshes it;
//   prove       a fresh read must hold exactly the expected projection; the saved layer is read with the shared reader
//               (savedquery-published.js), and the group owes its table's publish of exactly that saved layer;
//   membership  the row joins the solution BEFORE the group is committed and the attempt removed, so a run that stops there
//               keeps the attempt, and the next run finishes the membership at the same id;
//   commit      one atomic write; a create no answer acknowledged is bound only with the adoption approval.
// An attempt an earlier run left sending is recovered against the expectation it recorded, before any planning of the current
// spec: continued when its send window proves nothing left, resent as the same create when the row is absent from both layers,
// else proved — never re-baselined from today's declaration. A mismatch stays pending and its table withheld. Once recovered,
// the current spec is planned and settled as usual. An attempt whose declaration was removed is recovered the same way, by its
// recorded expectation alone (recoverUndeclared): proved and committed, or retired when it was only prepared; leaving the
// declaration out never releases its hold.
//
// Without a store (no workspace folder, or a target no store can be kept for) the port and lookup still work by identity alone and
// nothing is persisted: a rerun finds the row by its derived id the same way, and an observed row is unbound the same way.

const { AsyncLocalStorage } = require('node:async_hooks');
const { createCompositePortForSpec, markPreSend } = require('./creates-port.js');
const { createStop } = require('./creates-identity.js');
const { assertCleanContinuation, readLocalCreateState } = require('./creates-local.js');
const viewReconcile = require('./view-reconcile.js');
const chartReconcile = require('./chart-reconcile.js');
const { intentSha256, normalizeGuid, projectionBaseline, isApproved, canonicalJson } = require('./reconcile-common.js');

const SHIPPED_KINDS = Object.freeze(['view', 'chart']);
// The proof schema a view or chart group is committed under: the read-back projection (reconcile-common.js projectionBaseline).
const PROOF_SCHEMA = Object.freeze({ view: 'view-v1', chart: 'chart-v1' });

// How many bytes the commit of one view or chart change may add to the binding store (prepareAttempt `completionBytes`), as an
// upper bound the store reserves before the send. The store's default reservation is a fixed size, but the committed group
// repeats strings the spec controls — the key (a view's explicit `key`, or `<table>/<name>`) is written in the group, its
// root and its record — so a long key could outgrow it and take bytes other attempts hold. The bound is the group serialised
// the way the store writes it (indented JSON, every string escaped as JSON escapes it), with the real key, table and app name
// and every hash and id at full length, its lines indented to a depth deeper than the store nests a group, then doubled for
// the attempt bookkeeping written beside it, plus the store's own base reservation.
const COMPLETION_NESTING = 8;
function completionBytesFor(kind, key, table, appUniqueName, parts) {
  const { COMPLETION_BASE_BYTES } = require('./managed-bindings.js');
  const hex = '0'.repeat(64);
  const guid = '00000000-0000-0000-0000-000000000000';
  const group = {
    family: kind, key, generation: guid, previousGeneration: guid, root: { kind, key, id: guid }, proofSchema: PROOF_SCHEMA[kind],
    records: [{ formatVersion: 1, appUniqueName: String(appUniqueName || ''), environmentFingerprint: hex, kind, key, id: guid, origin: 'adopted', intentSha256: hex, partsSha256: Object.fromEntries(parts.map((p) => [p, hex])) }],
    proof: { savedSha256: hex, semanticSha256: hex, preservationSha256: hex, expectedChildrenSha256: hex },
    consumerState: { baseline: { intentSha256: hex } },
    publication: { scope: { type: 'table', table: String(table || '') }, state: 'not-needed', desiredSha256: hex, dispatchToken: guid, carriedFrom: guid },
  };
  const text = JSON.stringify(group, null, 2);
  return COMPLETION_BASE_BYTES + 2 * (Buffer.byteLength(text, 'utf8') + text.split('\n').length * 2 * COMPLETION_NESTING);
}
// Per family: the planner module, the plan's id field, the Web API collection and id column of the row, and the live projection
// of a row that does not exist yet (what a create's expectation is laid over: no columns, links or sort, an empty description).
const FAMILY = Object.freeze({
  view: { mod: viewReconcile, idOf: (p) => p.viewId, collection: 'savedqueries', idField: 'savedqueryid', emptyLive: () => viewReconcile.liveFull({}) },
  chart: { mod: chartReconcile, idOf: (p) => p.chartId, collection: 'savedqueryvisualizations', idField: 'savedqueryvisualizationid', emptyLive: () => ({ description: '', title: '' }) },
});

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;

/**
 * The JSON body the SDK's push sends to create `artifact` (a view or chart draft as createArtifact answered it) at `id`: the same
 * SDK, made over a throwaway workspace (lib/throwaway-sdk.js) with the same connection and language, is given the draft and pushed,
 * and its first write is captured and never sent. Its reads go to the real connection (a view's push reads its table's metadata
 * for the layout, one GET; a chart's reads nothing), so the body is serialised exactly as the real push serialises it — from the
 * draft held in memory, not from any file a second process could change. Throws when that cannot be shown: no SDK connection,
 * or a first write that is not one POST to the family's collection naming `id`.
 *   POST https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries?$select=savedqueryid
 *   { "name": "Declared Items", "fetchxml": "<fetch …>", "layoutxml": "<grid …>", …, "savedqueryid": "a1d1e2a3-…" }
 */
async function expectedCreateBody(sdk, kind, id, artifact) {
  const fam = FAMILY[kind];
  const conn = sdk && sdk.dataverse;
  if (!conn || typeof conn.instanceUrl !== 'string' || !conn.httpClient || typeof conn.httpClient.get !== 'function') {
    throw new Error('the SDK exposes no connection to serialise the create with');
  }
  const { withThrowawaySdk } = require('./throwaway-sdk.js');
  const DRY = Symbol('dry');
  let captured = null;
  const client = { get: (url, options) => conn.httpClient.get(url, options) };
  for (const m of ['post', 'patch', 'put', 'delete']) {
    client[m] = async (url, body) => {
      if (!captured) captured = { method: m, url: String(url), body };
      throw Object.assign(new Error('not sent: the create body is only being worked out'), { [DRY]: true });
    };
  }
  await withThrowawaySdk({ env: conn.instanceUrl, prefix: 'create-body-', httpClient: client }, async (make) => {
    const dry = make({
      ...(typeof sdk.languageCode === 'number' || typeof sdk.languageCode === 'string' ? { languageCode: sdk.languageCode } : {}),
      ...(typeof conn.solutionUniqueName === 'string' && conn.solutionUniqueName ? { solutionUniqueName: conn.solutionUniqueName } : {}),
    });
    await dry.initWorkspace();
    await dry.createArtifact(kind, artifact);
    try {
      await dry.pushArtifact(kind, id);
    } catch (err) {
      if (!captured) throw err;
    }
  });
  if (!captured) throw new Error('the push sent no create');
  let path = '';
  try { path = new URL(captured.url, conn.instanceUrl).pathname; } catch { /* checked below */ }
  let body = captured.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (captured.method !== 'post' || !path.toLowerCase().endsWith(`/${fam.collection}`) || !body || typeof body !== 'object' || Array.isArray(body)
    || normalizeGuid(body[fam.idField]) !== normalizeGuid(id)) {
    throw new Error(`the push's first write was not one create of ${id}`);
  }
  return body;
}

/**
 * The catalog intents of a spec's declared views and charts (creates-catalog.js shape). An entry without a table or a name is left
 * out: it does not compile, and the planner refuses it before any create.
 */
function stableIntents(spec) {
  const solution = spec && spec.solution && spec.solution.uniqueName;
  const intents = [];
  for (const v of (spec && spec.views) || []) {
    if (!viewReconcile.isDeclaredView(v) || !nonempty(v.entity) || !nonempty(v.name)) continue;
    const key = viewReconcile.declaredViewKey(v);
    const declaration = typeof v.key === 'string' && v.key ? { queryType: 0, key: v.key } : { queryType: 0, name: v.name };
    intents.push({ catalogKind: 'view', key, scope: { kind: 'table', solution, table: lc(v.entity) }, declaration });
  }
  for (const c of (spec && spec.charts) || []) {
    if (!chartReconcile.isDeclaredChart(c) || !nonempty(c.entity) || !nonempty(c.name)) continue;
    intents.push({ catalogKind: 'chart', key: chartReconcile.declaredChartKey(c), scope: { kind: 'table', solution, table: lc(c.entity) }, declaration: { name: c.name.trim() } });
  }
  return intents;
}

const isNotFound = (err) => !!err && (err.statusCode === 404 || err.status === 404);
// The Dataverse "object does not exist" code in an OData error body (an object, or its JSON text); some surfaces capitalize
// the envelope as "Error".
const notFoundCode = (body) => {
  let b = body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return false; } }
  const e = b && (b.error || b.Error);
  return !!e && typeof e.code === 'string' && e.code.toLowerCase() === '0x80040217';
};
const coded = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {});
const committedRecord = (committed, kind, key) => (committed ? committed.records.find((r) => r.kind === kind && r.key === key) || null : null);

/**
 * @param {{ spec: object, sdk: object, store: object|null, barrier?: object|null, basePort: { run: Function }, fallback?: { lookup?: Function, recordApplied?: Function } }} args
 *   sdk       the build's provisioning SDK (listArtifacts, diffArtifact, fetchArtifact and getArtifact are read here);
 *   store     the managed binding store handle (managed-bindings.js openManagedBindings), or null for identity alone;
 *   barrier   the run's publication barrier (publication-barrier.js): an attempt's hold and quarantine, and the route that sends
 *             a committed group's table publish through the managed coverage protocol;
 *   basePort  the build's own create port, which every request that is not a protected create goes to;
 *   fallback  the build's own managed-artifacts port, answered for a key that is not protected.
 * @returns {null | { port, managed: { lookup, observe }, settle?, recoverUndeclared?, recordBinding, protects, identityFor }}
 *   null only when the spec declares no stable view or chart AND the store holds no pending view or chart attempt. Without a
 *   store: an identity-only catalog (port, managed, recordBinding, protects, identityFor), with no `settle` and no
 *   `recoverUndeclared`. With a store: both, so a spec whose last view or chart was removed still gets an adapter whose
 *   `recoverUndeclared` recovers the attempts the store holds.
 */
function createStableCreates({ spec, sdk, store = null, barrier = null, basePort, fallback = null } = {}) {
  if (!basePort || typeof basePort.run !== 'function') throw new TypeError('createStableCreates: basePort must be a create port');
  const intents = stableIntents(spec);
  // A spec that declares no view or chart any more still recovers the store's pending view and chart attempts
  // (recoverUndeclared): dropping the last declaration must not drop the proof its earlier change owes.
  const owesUndeclared = !!store && store.snapshot().envelope.attempts.some((a) => FAMILY[a.family]);
  if (!intents.length && !owesUndeclared) return null;

  // With a store, the attempt was prepared and marked sending (its expectation written) by runManagedFeature before `apply` ran,
  // so the create is sent only under that attempt, at that root id. Anything else is refused before the send.
  async function onAttempt({ kind, key, id }) {
    if (!store) return;
    const { pending } = store.readGroup(kind, key);
    if (!pending || pending.phase !== 'sending' || normalizeGuid(pending.root.id) !== normalizeGuid(id)) {
      throw createStop('create-completion-required', `${kind} ${key}: the create of ${id} has no attempt recorded as sending, so it is not sent`, { create: { kind, key, id } });
    }
  }

  const composite = createCompositePortForSpec(spec, { intents, shippedKinds: SHIPPED_KINDS, onAttempt });
  const protects = (kind, key) => typeof composite.protects === 'function' && composite.protects(kind, key) === true;
  // Creates this run saw acknowledged at their stable id (the composite port's 'created'), by `${kind}\0${key}`.
  const acknowledged = new Set();

  // Each create runs in its own pin scope (createRuns): the pins its `materialised` sets belong to it alone and are released when
  // its own run ends — after its push and every retry the push awaits — whatever another create running alongside does. The
  // build runs creates in parallel (the engine's concurrency, and charts through mapLimit), so a pin shared across creates
  // would let one create's end release another's pin while that one's push was still to dispatch.
  const port = {
    async run(request, execute) {
      const own = { pins: new Map() };
      let out;
      try {
        if (!request || !protects(request.kind, request.key)) return await createRuns.run(own, () => basePort.run(request, execute));
        out = await createRuns.run(own, () => composite.run(request, execute));
      } finally {
        releasePins(own);
      }
      if (out && out.outcome === 'created') acknowledged.add(`${request.kind}\0${request.key}`);
      return out;
    },
    materialised: (args) => materialised(args),
  };

  const idOfKey = (kind, key) => {
    const g = store ? store.readGroup(kind, key) : { committed: null, pending: null };
    const rec = committedRecord(g.committed, kind, key);
    return { g, rec, id: rec ? normalizeGuid(rec.id) : g.pending ? g.pending.root.id : composite.identityFor(kind, key).id };
  };

  // Whether the build may continue from the workspace copy at `id` (creates-local.js assertCleanContinuation): only a copy that is
  // absent or synced with no edit. A local create no answer acknowledged stops too, whoever's it is: a diff cannot tell the draft
  // this build made from one a maker edited since (a name or a description outside the view's projection included), and the proof
  // would fetch the server's copy over it. The build never removes such a draft itself (keptDraft): it is the maker's to settle.
  // While the store holds this artifact's change pending at that id, the stop tells the order that settles it (pendingAdvice).
  async function assertContinuable(kind, key, id) {
    const pending = store ? store.readGroup(kind, key).pending : null;
    const atPending = !!pending && normalizeGuid(pending.root.id) === normalizeGuid(id);
    await assertCleanContinuation(sdk, kind, id, atPending ? { advice: pendingAdvice(kind, key) } : {});
  }

  // What the maker does about a local copy at an artifact whose change the store still holds pending. Order matters: the pending
  // change is proved (or its unsent create finished) only against the declaration it was prepared from — a run with any other
  // declaration stops with create-completion-required ("declared differently since its change was prepared") and keeps the
  // attempt — so the change the maker wants is set aside and applied only after the original declaration has settled. The
  // discard is the SDK's local one: it removes the workspace copy only, never the row on the service and never the binding store.
  const pendingAdvice = (kind, key) => [
    `To go on, in this order: 1. keep the change you want (from the local copy or from the spec) somewhere apart;`,
    `2. keep the spec's declaration of this ${kind} (${key}) exactly as it was when its change was prepared, or put it back;`,
    `3. discard only the local copy of this ${kind} — the maker SDK's local discard (deleteArtifact) or a refresh of the local copy — which removes nothing on the service and leaves the managed binding store as it is;`,
    `4. run the build again with that original declaration (add --authorize adopt:${kind}:${key} if the build asks for it), which proves the change or finishes its create;`,
    `5. only then put your change into the spec and run the build again.`,
    `A changed declaration before step 4 stops at this ${kind} with create-completion-required and keeps the pending change`,
  ].join(' ');

  // What ties a create request to the draft this run made, by `${kind}\0${id}`: the publication barrier's pin (pinCreate) of
  // the row's create, holding the request body the SDK serialises from the draft as createArtifact answered it. Set by
  // `materialised` before the push into the pin scope of the create that made the draft (createRuns), and released by that
  // create's `port.run` once it has run; `draftRefusals` records why a create was not sent (the pin refused it, or it could not
  // be pinned), for `apply` to report as `create-local-draft-changed`. A create's release never touches another's entries.
  const createRuns = new AsyncLocalStorage();
  const draftRefusals = new Map();
  const draftKey = (kind, id) => `${kind}\0${normalizeGuid(id) || String(id)}`;

  // Called by the view and chart reconcilers between `createArtifact` and the push. Two checks, the second the one that holds:
  //   1. the workspace must hold exactly the draft the SDK answered (an early refusal of an edit already made);
  //   2. the create request itself is pinned to that draft, at the transport: the body the SDK would send for the draft as
  //      createArtifact answered it (expectedCreateBody) is what the push's POST must carry, field for field, the name included.
  //      The workspace is a file a second local process can write at any moment (the build's lease does not exclude another
  //      SDK), so no read of it before the push can show what the push will read; the barrier compares the request the push
  //      actually dispatches (publication-barrier.js pinCreate) and refuses anything else before it reaches the transport.
  // A draft that cannot be pinned — no gated transport, no SDK connection to serialise with, a serialisation that does not
  // answer exactly one create of this row — is refused the same way: the build never sends a draft it cannot show is its own.
  // A throw from here is a local refusal (reconcile-common.js createThroughPort); `apply` reports it as create-local-draft-changed.
  async function materialised({ kind, id, artifact }) {
    // Without a store there is no managed attempt to tie the create to, and the request vectors stay as they were.
    if (!store || !FAMILY[kind]) return;
    const k = draftKey(kind, id);
    const refuse = (why) => {
      const err = coded('create-local-draft-changed', `${kind} ${id}: ${why}, so it was not sent; the local copy was kept as it is`);
      draftRefusals.set(k, err);
      throw err;
    };
    const local = await readLocalCreateState(sdk, kind, id);
    if (local.state !== 'pending' || intentSha256(local.draft) !== intentSha256(artifact)) refuse('the local draft is not the one this build just made');
    if (!barrier || typeof barrier.pinCreate !== 'function' || typeof barrier.gatesTransport !== 'function' || !barrier.gatesTransport()) {
      refuse('the create request cannot be tied to the draft this build made (no transport is checked by the publication barrier)');
    }
    let expected;
    try {
      expected = await expectedCreateBody(sdk, kind, id, artifact);
    } catch (err) {
      refuse(`the create request the draft makes could not be worked out (${String((err && err.message) || err).slice(0, 200)})`);
    }
    // The pin belongs to the create running this push (port.run's scope). Outside one there is no lifetime to tie it to, and a
    // pin nobody releases would hold the row for the rest of the run, so the draft is refused instead.
    const own = createRuns.getStore();
    if (!own) refuse('the create request cannot be tied to the draft this build made (it is not pushed under the build\'s create port)');
    const want = canonicalJson(expected);
    own.pins.set(k, barrier.pinCreate({ collection: FAMILY[kind].collection, idField: FAMILY[kind].idField, id, matches: (body) => canonicalJson(body) === want }));
  }

  // Ends the pins `materialised` set in one create's scope, recording a refused one: called by that create's `port.run` once it
  // has run, whatever its outcome. Only `own`'s pins: another create's pins, and its refusals, stay as they are.
  function releasePins(own) {
    for (const [k, pin] of own.pins) {
      pin.release();
      if (pin.refused && !draftRefusals.has(k)) {
        draftRefusals.set(k, coded('create-local-draft-changed', `${k.split('\0')[0]} ${k.split('\0')[1]}: the create request the push dispatched was not the draft this build made (the local draft changed while the build pushed it), so it was not sent; the local copy was kept as it is`));
      }
    }
    own.pins.clear();
  }

  const keptDraft = (kind, key, id) => ({
    key: `${kind}:${id}`,
    code: 'create-local-draft-kept',
    message: `the local draft of the ${kind} ${id} was kept exactly as it is: the build never removes a local draft (the SDK has no discard that holds only while the draft is unchanged, and a second local process may have edited it). Its create may still have reached the server, so its attempt stays pending and nothing is sent for it again in this run; until the local copy is discarded every build stops at this ${kind} with create-completion-required. ${pendingAdvice(kind, key)}`,
  });

  // A create this run made at the stable `id` and never had acknowledged (a refusal, or an answer that was lost) leaves a local
  // draft. It is never removed here — `deleteArtifact` is not conditional, so whatever check came before it, a draft another
  // process edited in between would be erased with it. Answers the `create-local-draft-kept` finding for the halt when a draft
  // is (or may be) there, null when the workspace holds none.
  async function keptOwnDraft(kind, key, id) {
    let local;
    try {
      local = await readLocalCreateState(sdk, kind, id);
    } catch {
      return keptDraft(kind, key, id);
    }
    return local.state === 'pending' ? keptDraft(kind, key, id) : null;
  }

  // A stop the lookup makes is made while planning, before anything is written or sent: it is certified as such (creates-port.js
  // markPreSend), which is what lets the build report it as the item's refusal.
  async function lookup(kind, key) {
    if (!protects(kind, key)) return fallback && typeof fallback.lookup === 'function' ? fallback.lookup(kind, key) : null;
    const { rec, id } = idOfKey(kind, key);
    try {
      await assertContinuable(kind, key, id);
    } catch (err) {
      throw markPreSend(err);
    }
    return rec ? { ...rec } : null;
  }

  async function observe(kind, key) {
    if (!protects(kind, key)) return null;
    const { rec, id } = idOfKey(kind, key);
    if (rec) return null;
    try {
      await sdk.fetchArtifact(kind, id);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    return id;
  }

  // Synchronous, as the build's settlement calls it (reconcile-common.js createFeatureSettlement).
  function recordBinding(b) {
    if (!b || !protects(b.kind, b.key)) {
      if (fallback && typeof fallback.recordApplied === 'function') fallback.recordApplied(b);
      return;
    }
    if (!store) return;
    // `settle` committed the group (or left it as it was): the binding a result carries is accepted only when it is the one the
    // store holds. Anything else would be a binding no proof, membership or adoption check stood behind.
    const g = store.readGroup(b.kind, b.key);
    const rec = committedRecord(g.committed, b.kind, b.key);
    if (!g.pending && rec && normalizeGuid(rec.id) === normalizeGuid(b.id)) return;
    throw coded('managed-not-settled', `${b.kind} ${b.key}: its binding to ${b.id} was not committed by the managed settlement, so it is not recorded`);
  }

  // The proof of one view or chart attempt: a fresh read must hold exactly the projection the attempt expected; then the saved
  // layer is read with the shared reader, and the group owes its table's publish of exactly that layer (managed-scope-publisher.js
  // pays it through publishManagedScope). Shared by `settle` and `recoverUndeclared`, so both prove by the one recorded expectation.
  function proverFor({ kind, key, label, client, scope }) {
    const { CODES, rootCreateAcknowledged } = require('./managed-bindings.js');
    const { readSavedQueryLayers } = require('./savedquery-published.js');
    const fam = FAMILY[kind];
    return async ({ expected, applied: sent }) => {
      const id = normalizeGuid(expected.rootId);
      let fresh;
      try {
        await sdk.fetchArtifact(kind, id, { overwrite: true });
        fresh = await sdk.getArtifact(kind, id);
      } catch (err) {
        throw coded(CODES.completion, `${label}: ${id} could not be read back to prove the change (${String((err && err.message) || err).slice(0, 200)}); it stays pending and its table is not published`, { cause: err });
      }
      const live = fresh ? fam.mod.liveFull(fresh) : null;
      const baseline = live ? projectionBaseline(live) : null;
      if (!baseline || baseline.intentSha256 !== expected.sentProjectionSha256) {
        throw coded(CODES.completion, `${label}: the ${kind} ${id} does not hold what its recorded change expected; it stays pending and its table is not published. Run the build again with the declaration that change was made for (it is then proved and committed), or restore the ${kind} on the service to that content`);
      }
      const layers = await readSavedQueryLayers(kind, client, { root: { id } });
      const g = store.readGroup(kind, key);
      const rec = committedRecord(g.committed, kind, key);
      // Own-create evidence only: this run's acknowledged create, or the attempt's durable create acknowledgement
      // (rootCreateAcknowledged reads the attempt and its saved observation, and never counts an edit's).
      const ack = (sent && sent.created === true) || (!!g.pending && rootCreateAcknowledged(g.pending));
      const env = store.snapshot().envelope;
      return {
        acknowledgedRoot: ack,
        records: [{ formatVersion: 1, appUniqueName: env.appUniqueName, environmentFingerprint: env.environmentFingerprint, kind, key, id, origin: rec ? rec.origin : ack ? 'created' : 'adopted', intentSha256: baseline.intentSha256, partsSha256: { ...baseline.partsSha256 } }],
        proof: { savedSha256: baseline.intentSha256, semanticSha256: baseline.intentSha256, preservationSha256: expected.preservationSha256, expectedChildrenSha256: null },
        consumerState: { baseline: { intentSha256: baseline.intentSha256 } },
        publication: { scope, state: 'owed', desiredSha256: layers.savedSha256, dispatchToken: null },
        proofSchema: PROOF_SCHEMA[kind],
      };
    };
  }

  /**
   * Settle one declared view or chart through runManagedFeature (see SETTLEMENT in the header). The caller hands its own steps:
   *   planOnce()          plan the item (the planner with the workspace-copy refusal), reads only;
   *   applyPlan(plan)     the reconcile helper's apply; answers its result;
   *   onUnsettled(plan, r)  after an apply that did not settle cleanly (the build resets the local copy it did not push);
   *   ensureMember(id, createdNow)  the row's solution membership (an add for a row this run created, else the checked add);
   *   halt                the build's halt factory (managedStop);
   *   client              the Dataverse client the layers and the resumed create are read with;
   *   sendObserver        the build's attempt send observer, when one is installed on its transport;
   *   authorizedAdoption  the build's adoption approvals; pinned: the declaration names the row's id.
   * Answers { plan, r, managed }: `managed` is true when this call committed the group (the result's binding is then the store's),
   * false when the plan settled outside the store (a refusal, an unknown, or nothing to send or bind) and `r` is that plan's result.
   */
  async function settle({ kind, key, phase, label, planOnce, applyPlan, onUnsettled, ensureMember, halt, client, sendObserver = null, authorizedAdoption, pinned = false }) {
    const { runManagedFeature } = require('./managed-feature-contract.js');
    const { CODES } = require('./managed-bindings.js');
    const fam = FAMILY[kind];
    const table = tableOf(intents, kind, key);
    const scope = { type: 'table', table };
    const adoptionApproved = isApproved(authorizedAdoption, kind, key) || pinned === true;
    let stash = null;
    let applied = null;

    const planFor = (source, committed) => {
      stash = null;
      const id = fam.idOf(source);
      const rec = committedRecord(committed, kind, key);
      if (source.refused.length || source.unknown.length || !source.action) { stash = source; return { noop: true }; }
      if (source.action === 'noChange') {
        // Nothing to send: bound only on an approval or a binding (the planner's bindUnchanged), and not again when the store
        // already holds exactly this.
        if (!source.bindUnchanged) { stash = source; return { noop: true }; }
        if (rec && normalizeGuid(rec.id) === normalizeGuid(id) && rec.intentSha256 === source.baseline.intentSha256) { stash = source; return { noop: true }; }
      }
      // The commit's size is bounded before anything is prepared or sent: a completion larger than one attempt may reserve is
      // refused here, so a key too long for the store never gets a send whose commit cannot be written.
      const { COMPLETION_MAX_BYTES } = require('./managed-bindings.js');
      const completionBytes = completionBytesFor(kind, key, table, store.snapshot().envelope.appUniqueName, fam.mod.PARTS);
      if (completionBytes > COMPLETION_MAX_BYTES) {
        throw markPreSend(coded(CODES.storeFull, `${label}: the key of this ${kind} is too long to record: committing its change could need up to ${completionBytes} bytes of the binding store, more than the ${COMPLETION_MAX_BYTES} one change may reserve. Shorten its key${kind === 'view' ? ' (views[].key, or the name it defaults from)' : ' (the chart\'s name)'}; nothing was sent`));
      }
      const create = source.action === 'create';
      const rootId = create ? composite.identityFor(kind, key).id : normalizeGuid(id);
      const desired = create ? fam.mod.desiredFull(source.intent, fam.emptyLive()) : source.desired;
      const changed = create ? fam.mod.PARTS : source.changed;
      const kept = {};
      for (const p of fam.mod.PARTS) if (!changed.includes(p)) kept[p] = desired[p] === undefined ? null : desired[p];
      return {
        root: { kind, key, id: rootId },
        expected: {
          proofVersion: 1,
          proofSchema: PROOF_SCHEMA[kind],
          rootId,
          baseProofSha256: committed && committed.proof ? committed.proof.savedSha256 : null,
          sentProjectionSha256: projectionBaseline(desired).intentSha256,
          preservationSha256: intentSha256(kept),
          // A create of a new root records no base; anything else changes (or binds) a row this run read first, and says so,
          // so no answer to it can be taken for a create (noteSaved refuses the flag, rootCreateAcknowledged ignores it) and
          // it is never resumed as a create (resumableCreate).
          baseObservation: create ? null : { rowVersion: null, savedSha256: typeof source.observedSha256 === 'string' ? source.observedSha256 : null },
          children: [],
        },
        declarationSha256: intentSha256(source.intent),
        publication: { scope, state: 'owed' },
        completionBytes,
        source,
      };
    };

    const prove = proverFor({ kind, key, label, client, scope });

    // The pending create's root by its stable id, in both layers: 'absent' only when each answers 404 with the Dataverse
    // "object does not exist" code, { "error": { "code": "0x80040217", … } } — a 404 an intermediary answers carries no such
    // code and proves nothing. RetrieveUnpublished reads the saved layer; a plain retrieve the published one.
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrieveunpublished
    const resumeCreate = async ({ pending }) => {
      const id = normalizeGuid(pending.root.id);
      const select = `$select=${fam.idField}`;
      const state = async (path) => {
        const res = await client.get(path);
        if (res && res.status === 404 && notFoundCode(res.body)) return 'absent';
        if (res && res.status >= 200 && res.status < 300) return 'present';
        throw coded(CODES.completion, `${label}: whether ${id} exists could not be read (status ${res && res.status})`);
      };
      const saved = await state(`/${fam.collection}(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?${select}`);
      const published = await state(`/${fam.collection}(${id})?${select}`);
      return { root: saved === 'absent' && published === 'absent' ? 'absent' : 'present' };
    };

    const once = () => runManagedFeature({
      phase, family: kind, key, label, store, barrier: barrier || undefined, knownScopes: [scope],
      ...(sendObserver ? { sendObserver } : {}),
      // A publish of the table that may have been sent (a lost answer, journaled with this group as debt or as a carried
      // group) is settled by the store's read-only confirmation with this client (settleEarlierPublication). It runs after the
      // change is planned and before it is prepared or sent (and before a pending attempt is recovered); a noop plan does not
      // run it. Without a client a feature run has no way to confirm it and only refuses.
      client,
      adoptionApproved,
      halt: (ph, lb, code, { cause } = {}) => halt(ph, lb, code, { cause, findings: (cause && cause.findings) || [] }),
      preflight: async ({ committed, pending }) => {
        const rec = committedRecord(committed, kind, key);
        await assertContinuable(kind, key, rec ? normalizeGuid(rec.id) : pending ? pending.root.id : composite.identityFor(kind, key).id);
      },
      resolve: async () => ({ source: await planOnce() }),
      plan: ({ resolution, committed }) => planFor(resolution.source, committed),
      apply: async ({ token, plan: planned }) => {
        const creating = planned.source.action === 'create';
        const id = planned.root.id;
        // A create the barrier refused unsent (its request was not the draft this run made), or one that could not be tied to
        // that draft, stops with create-local-draft-changed: nothing of it reached the transport, so the attempt's send window
        // counts no mutation, and its draft is kept. The halt names it first; the reconciler's own finding follows.
        const changedDraft = () => draftRefusals.get(draftKey(kind, id)) || null;
        const changedFinding = (e) => ({ key: label, code: 'create-local-draft-changed', message: e.message });
        let r;
        try {
          r = await applyPlan(planned.source);
        } catch (err) {
          const changed = creating ? changedDraft() : null;
          const kept = creating ? await keptOwnDraft(kind, key, id) : null;
          if (changed || kept) {
            const was = Array.isArray(err && err.findings) ? err.findings : [{ key: label, code: (err && err.code) || CODES.notSettled, message: (err && err.message) || String(err) }];
            const findings = [...(changed ? [changedFinding(changed)] : []), ...was, ...(kept ? [kept] : [])];
            if (changed) throw coded('create-local-draft-changed', findings.map((f) => `${f.code}: ${f.message}`).join('; '), { findings, cause: err });
            throw Object.assign(err instanceof Error ? err : new Error(String(err)), { findings });
          }
          throw err;
        }
        const created = creating && acknowledged.has(`${kind}\0${key}`);
        applied = { plan: planned.source, r };
        if (r.refused.length || r.unknown.length) {
          // An acknowledged create is recorded as such before the stop, so the next run recovers it as this build's create.
          let kept = null;
          let changed = null;
          if (created) { try { store.noteSaved(token, { acknowledgedRoot: true }); } catch { /* the attempt stays unacknowledged */ } }
          else if (creating) {
            changed = changedDraft();
            kept = await keptOwnDraft(kind, key, id);
          }
          // An unsettled create's local copy is its draft, which stays as it is (keptOwnDraft): only an edit's copy is reset.
          if (!creating && typeof onUnsettled === 'function') await onUnsettled(planned.source, r);
          const findings = [...(changed ? [changedFinding(changed)] : []), ...r.refused, ...r.unknown, ...(kept ? [kept] : [])];
          throw coded((findings[0] && findings[0].code) || CODES.notSettled, findings.map((f) => `${f.code}: ${f.message}`).join('; '), { findings });
        }
        return { created };
      },
      prove,
      ensureMembership: async ({ root, recovering }) => {
        if (stash || !root || !root.id) return;
        await ensureMember(normalizeGuid(root.id), !recovering && !!(applied && applied.plan.action === 'create'));
      },
      resumeCreate,
    });

    let out = await once();
    // A recovered attempt is committed; the current spec is then planned and settled over it.
    if (out.result.recovered) {
      stash = null;
      applied = null;
      out = await once();
    }
    if (out.result.noop) return { plan: stash, r: stash ? await applyPlan(stash) : null, managed: false };
    // The group owes its table's publish: every plain publish of that table now goes through the managed coverage protocol.
    if (barrier && typeof barrier.route === 'function') barrier.route(table, label);
    return { plan: applied.plan, r: applied.r, managed: true };
  }

  /**
   * Recover the store's pending view and chart attempts whose declaration this spec does not carry (removed, renamed, or no longer
   * protected), against the expectation each recorded before its send — today's spec holds nothing for them, so nothing is planned,
   * sent again or re-baselined. Leaving a declaration out never releases its hold. For each such attempt, through runManagedFeature
   * without a send observer or a create resume (so a sent attempt goes straight to its proof):
   *   - one still only prepared (never marked sending) sent nothing: the plan is a no-op, so it is retired and its hold ends;
   *   - one that proves (a fresh read holds exactly its expected projection) joins the solution and is committed: a create no answer
   *     acknowledged only with its adoption approval (`adopt:<family>:<key>`); its table's publish is then owed and routed;
   *   - anything else (a row that differs, a read that fails, an approval not given) stays pending and its table withheld. It is
   *     reported through `warn`, not raised: an artifact the spec no longer declares does not stop the build of the rest.
   * Steps: client (layer and row reads), halt (the build's halt factory, for the message), warn, authorizedAdoption, phase, and
   * ensureMember(kind, id, table) for the row's checked solution membership. Answers the tables whose group it committed.
   */
  async function recoverUndeclared({ phase, client, halt, warn, authorizedAdoption, ensureMember }) {
    if (!store) return [];
    const { runManagedFeature } = require('./managed-feature-contract.js');
    const { CODES } = require('./managed-bindings.js');
    const recovered = [];
    const attempts = store.snapshot().envelope.attempts.filter((a) => FAMILY[a.family] && !protects(a.family, a.key));
    for (const a of attempts) {
      const kind = a.family;
      const key = a.key;
      const declared = (a.publication && a.publication.scope) || (a.knownScopes || []).find((s) => s && s.type === 'table') || null;
      const table = declared && declared.type === 'table' ? String(declared.table || '') : '';
      const scope = { type: 'table', table };
      const label = `${kind} ${key} (no longer declared)`;
      const stopped = Symbol('stopped');
      try {
        const out = await runManagedFeature({
          phase, family: kind, key, label, store, barrier: barrier || undefined, knownScopes: table ? [scope] : [], client,
          adoptionApproved: isApproved(authorizedAdoption, kind, key),
          halt: (ph, lb, code, { cause } = {}) => {
            const made = halt(ph, lb, code, { cause, findings: (cause && cause.findings) || [] });
            return Object.assign(made instanceof Error ? made : new Error(`${lb}: ${code}`), { [stopped]: true, recoveryCode: code, recoveryCause: cause });
          },
          preflight: async ({ pending }) => { if (pending) await assertContinuable(kind, key, pending.root.id); },
          resolve: async () => ({ source: null }),
          // Nothing is planned for an undeclared key: a prepared attempt is retired, a sent one is proved (never resent).
          plan: () => ({ noop: true }),
          apply: async () => { throw coded(CODES.notSettled, `${label}: nothing is sent for an artifact the spec does not declare`); },
          prove: proverFor({ kind, key, label, client, scope }),
          ensureMembership: async ({ root, recovering }) => {
            if (recovering && root && root.id) await ensureMember(kind, normalizeGuid(root.id), table);
          },
        });
        if (out && out.result && out.result.committed && table) {
          if (barrier && typeof barrier.route === 'function') barrier.route(table, label);
          if (!recovered.includes(table)) recovered.push(table);
        }
      } catch (err) {
        if (!err || !err[stopped]) throw err;
        const cause = err.recoveryCause;
        const why = String((cause && cause.message) || err.recoveryCode || err.message).replace(/\s+/g, ' ').slice(0, 400);
        if (typeof warn === 'function') warn(`${label}: ${err.recoveryCode} — ${why}. Its earlier change stays pending and table ${table || '(unknown)'} stays unpublished; restore its declaration and build again (or give the adoption approval it names).`);
      }
    }
    return recovered;
  }

  return {
    port,
    managed: { lookup, observe },
    ...(store ? { settle, recoverUndeclared } : {}),
    recordBinding,
    protects,
    identityFor: (kind, key) => (protects(kind, key) ? composite.identityFor(kind, key) : null),
  };
}

function tableOf(intents, kind, key) {
  const i = intents.find((x) => x.catalogKind === kind && x.key === key);
  return i ? i.scope.table : '';
}

module.exports = { createStableCreates, stableIntents, SHIPPED_KINDS, PROOF_SCHEMA };
