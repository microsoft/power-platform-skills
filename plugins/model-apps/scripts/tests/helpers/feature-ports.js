'use strict';
// Test doubles for the ports the declared-reconciliation helpers are given by the build:
//   ctx.creates — the creation port: `run({kind, key, identity, childKeys}, execute)`;
//   ctx.managed — the managed-binding port: `lookup(kind, key)` answers the stored binding.
// The build supplies both; the helpers are proven against these doubles.
//
// passThroughCreates is the creation port as this release wires it: a plain pass-through that
// allocates the ids a request asks for, calls execute once and keeps nothing between calls (no
// journal, no adoption, no re-send). After an interrupted or unknown create, a later run can create
// a duplicate.
//
// fakeCreates is a stricter double: it models a durable implementation that may later plug in
// behind the same call shape, so the helpers' handling of its extra outcomes (pending, adopted,
// recovery needed) stays exercised. Its observable contract:
//   - a request is validated (kind /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, a non-empty key, distinct non-empty
//     child keys, a function) and a bad one throws CREATE_PORT_INVALID;
//   - ids are allocated and recorded per (kind, key) BEFORE execute; `execute({id, childIds})` (the root
//     id is `id`, not `rootId`); a later run of the same key sends under the SAME ids, a new child slot
//     gets a new id and a slot no longer asked for is kept;
//   - the verdict: a throw or a result is classified as acknowledged / refused / unknown by
//     verdictOfFailure / verdictOfResult below; `{outcome: 'created'|'refused'|'unknown'}` is
//     returned (with `id`, `childIds`, `ids`, `entryKey`, `result`); a failure is rethrown after it is
//     recorded; an unknown poisons the port, after which every run throws `create-outcome-unknown`;
//   - a key whose earlier send is pending (unknown) throws CREATION_PENDING_UNKNOWN, unless a maker
//     decision adopts it: then execute is NOT called and `{outcome: 'adopted', result: undefined}`;
//   - a changed identity after an unknown send throws `create-recovery-needed`.

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
};
const labelOf = (key) => (typeof key === 'string' ? key : JSON.stringify(canonical(key)));

function portError(code, message, extra = {}) {
  const err = code === 'CREATE_PORT_INVALID' ? new TypeError(message) : new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// How a durable port would classify a send: a throw (verdictOfFailure) or an answer (verdictOfResult).
function verdictOfFailure(err) {
  const chain = [];
  for (let e = err, i = 0; e && typeof e === 'object' && i < 8; e = e.cause, i++) chain.push(e);
  if (chain.some((e) => e.outcome === 'unknown' || e.code === 'CREATE_OUTCOME_UNKNOWN' || e.code === 'create-outcome-unknown')) return 'unknown';
  if (chain.some((e) => e.outcome === 'nothing' || e.outcome === 'refused' || e.outcome === 'not-sent')) return 'refused';
  const status = chain.map((e) => e.statusCode ?? e.status).find((s) => Number.isSafeInteger(s));
  if (status >= 400 && status < 500 && status !== 408) return 'refused';
  return 'unknown';
}
function verdictOfResult(result) {
  if (!result || typeof result !== 'object') return 'acknowledged';
  if (result.outcome === 'unknown') return 'unknown';
  if (result.outcome === 'refused' || result.outcome === 'nothing') return 'refused';
  const failed = result.success === false || (result.saved === false && result.adoptedExisting !== true);
  if (!failed) return 'acknowledged';
  const errs = Array.isArray(result.errors) ? result.errors : result.error ? [result.error] : [];
  return errs.length && errs.every((e) => verdictOfFailure(e) === 'refused') ? 'refused' : 'unknown';
}

/**
 * @param {{ pendingUnknown?: string[], adopt?: Object<string, {id: string, childIds?: object}>, poisoned?: boolean, idPrefix?: string }} [opts]
 *   pendingUnknown — keys (label form) whose earlier send is pending with an unknown outcome;
 *   adopt          — for such a key, the maker's adopt decision: the rows that become its ids;
 *   poisoned       — an earlier create in this run already lost its answer.
 */
function fakeCreates(opts = {}) {
  const calls = [];
  const records = new Map();
  let poisoned = opts.poisoned === true;
  let n = 0;
  const mint = () => {
    n += 1;
    return `${opts.idPrefix || 'c0c0c0c0'}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  };
  for (const label of opts.pendingUnknown || []) records.set(`pending:${label}`, true);

  async function run(request, execute) {
    if (!request || typeof request !== 'object') throw portError('CREATE_PORT_INVALID', 'creates.run: a request is required');
    const { kind, key, childKeys = [] } = request;
    if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(kind)) throw portError('CREATE_PORT_INVALID', `creates.run: '${kind}' is not a kind`);
    const keyOk = (typeof key === 'string' && key.length > 0) || (Array.isArray(key) && key.length > 0) || (key && typeof key === 'object');
    if (!keyOk) throw portError('CREATE_PORT_INVALID', `creates.run: the ${kind} create has no key`);
    if (!Array.isArray(childKeys) || childKeys.some((c) => typeof c !== 'string' || !c) || new Set(childKeys).size !== childKeys.length) {
      throw portError('CREATE_PORT_INVALID', `creates.run: the ${kind} child keys must be distinct non-empty strings`);
    }
    if (typeof execute !== 'function') throw portError('CREATE_PORT_INVALID', 'creates.run: execute must be a function');
    if (poisoned) throw portError('create-outcome-unknown', 'an earlier create in this run lost its answer', { outcome: 'not-sent' });
    const label = labelOf(key);
    const entryKey = `${kind}\u0000${label}`;
    const identity = JSON.stringify(canonical(request.identity === undefined ? null : request.identity));
    let rec = records.get(entryKey);
    if (!rec && records.get(`pending:${label}`)) {
      rec = { id: mint(), children: {}, state: 'unknown', identity, unknownSeen: true };
      records.set(entryKey, rec);
    }
    if (rec && (rec.state === 'unknown' || rec.state === 'sending')) {
      const decision = opts.adopt && opts.adopt[label];
      if (!decision) throw portError('CREATION_PENDING_UNKNOWN', `an earlier create of ${kind} '${label}' has an unknown outcome`, { outcome: 'unknown', designCode: 'create-recovery-needed' });
      rec.id = decision.id;
      for (const [slot, id] of Object.entries(decision.childIds || {})) rec.children[slot] = id;
      rec.state = 'complete';
      const childIds = {};
      for (const slot of childKeys) if (rec.children[slot]) childIds[slot] = rec.children[slot];
      const ids = { id: rec.id, childIds };
      calls.push({ op: request, ids, executed: false, outcome: 'adopted' });
      return { outcome: 'adopted', ...ids, ids, entryKey, result: undefined };
    }
    if (!rec) {
      rec = { id: mint(), children: {}, state: 'reserved', identity };
      records.set(entryKey, rec);
    } else if (rec.identity !== identity && rec.unknownSeen) {
      throw portError('create-recovery-needed', `the ${kind} '${label}' would be created from another request than the one whose answer was lost`, { outcome: 'intent-changed' });
    }
    rec.identity = identity;
    for (const slot of childKeys) if (!rec.children[slot]) rec.children[slot] = mint();
    rec.state = 'sending';
    const ids = { id: rec.id, childIds: Object.fromEntries(childKeys.map((s) => [s, rec.children[s]])) };
    const record = { op: request, ids, executed: false };
    calls.push(record);
    let result;
    let failure;
    try {
      result = await execute({ id: ids.id, childIds: { ...ids.childIds } });
      record.executed = true;
    } catch (e) {
      failure = e;
    }
    const verdict = failure ? verdictOfFailure(failure) : verdictOfResult(result);
    record.verdict = verdict;
    if (verdict === 'acknowledged') rec.state = 'complete';
    else if (verdict === 'refused') rec.state = 'refused';
    else { rec.state = 'unknown'; rec.unknownSeen = true; poisoned = true; }
    if (failure) throw failure;
    const outcome = verdict === 'acknowledged' ? 'created' : verdict;
    return { outcome, ...ids, ids, entryKey, result };
  }

  return { calls, run, records, isPoisoned: () => poisoned };
}

/**
 * The creation port as this release wires it (see the header): fresh ids for every call, execute
 * called exactly once, the checked answer ({ outcome: 'saved'|'refused'|'unknown' }) mapped to
 * created / refused / unknown.
 */
function passThroughCreates() {
  const calls = [];
  let n = 0;
  const mint = () => {
    n += 1;
    return `d0d0d0d0-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  };
  async function run(request, execute) {
    const ids = { id: mint(), childIds: Object.fromEntries((request.childKeys || []).map((k) => [k, mint()])) };
    const result = await execute({ id: ids.id, childIds: { ...ids.childIds } });
    calls.push({ op: request, ids, result });
    const outcome = result && result.outcome === 'saved' ? 'created' : result && result.outcome === 'refused' ? 'refused' : 'unknown';
    return { outcome, ...ids, result };
  }
  return { calls, run };
}

/** A managed-binding store: `lookup` answers what `seed`/`persist` put in. */
function fakeManaged(seed = []) {
  const byKey = new Map();
  const put = (b) => byKey.set(`${b.kind}\u0000${b.key}`, b);
  for (const b of seed) put(b);
  return {
    lookup: (kind, key) => byKey.get(`${kind}\u0000${key}`) || null,
    persist(bindings) { for (const b of bindings || []) put(b); },
    all: () => [...byKey.values()],
  };
}

/** A publication port that records what was queued. */
function fakePublication() {
  const queued = [];
  return { queued, queue: (scope) => { queued.push(scope); } };
}

/**
 * The build's own publication queues, as the integration maps a queued scope onto them: a chart
 * scope becomes `chartsToPublish.set(table, id)` (one chart per table, published at the end), a view
 * scope one publish of that view. `drain(sdk)` publishes what is queued through the real bundle's
 * publishArtifact, so a test counts the PublishXml requests that actually reach the service.
 */
function buildPublicationQueues() {
  const chartsToPublish = new Map();
  const views = [];
  return {
    chartsToPublish,
    views,
    queue(scope) {
      if (scope.type === 'chart') chartsToPublish.set(scope.table, scope.id);
      else if (scope.type === 'view') views.push(scope.id);
    },
    async drain(sdk) {
      for (const id of chartsToPublish.values()) await sdk.publishArtifact('chart', id);
      for (const id of views) await sdk.publishArtifact('view', id);
    },
  };
}

/**
 * The build's publication paths a declared view, chart or Quick Find list can reach, each guarded by
 * the run-wide publication barrier (lib/publication-barrier.js) at the same point the integration
 * guards it. Everything is published through the real bundle (`sdk`) or the raw client (`client`), so a
 * test counts the PublishXml requests on the wire. `publish` is the publish phase in the run
 * (`has('publish') && publish`). `barrier: null` is the build as it was before the barrier, for
 * comparing request trails.
 *   settle(label, result)  settlement + drain: a result that is not clean notes the barrier; a clean
 *                          one's scopes go to the chart map (charts) or the view publisher (views)
 *   publishReconciled      the reconcile publisher: immediate without the publish phase, else owed
 *   oweTablePublish        a table publish owed to the publish phase (the default-view enrichment's)
 *   createdView            a view the views phase created (result.created.views)
 *   beforeApp(held)        the tables published before the app: one envelope with --publish, else the
 *                          owed reconciled tables through the SDK
 *   publishPhase()         the publish phase: one target per table from created views, charts, owed
 *   halt(warn)             the settle of a halted build over what is still owed (settleOwedPublishes)
 */
function buildPublishPaths({ sdk, client, publish, barrier = null }) {
  const { preAppTables, publishTablesXml } = require('../../lib/table-publish.js');
  const { settleOwedPublishes } = require('../../lib/sdk-build.js');
  const { settledPublications } = require('../../lib/reconcile-common.js');
  const allow = (table, path) => !barrier || barrier.allow(table, path);
  const owed = new Map();
  const reconciled = new Set();
  const charts = new Map();
  const createdViews = [];
  const oweTablePublish = (table, type, id, name) => {
    if (!allow(table, name)) return;
    if (barrier) barrier.noteTarget(table, [type, id]);
    const target = owed.get(table);
    if (!target) owed.set(table, [type, id, [name]]);
    else if (!target[2].includes(name)) target[2].push(name);
  };
  const publishReconciled = async (type, id, entity, label) => {
    const table = String(entity || '').toLowerCase();
    if (table && !allow(table, label)) return;
    if (publish && table) {
      oweTablePublish(table, type, id, label);
      reconciled.add(table);
      return;
    }
    await sdk.publishArtifact(type, id);
  };
  const publishReconciledTables = async () => {
    const targets = [...reconciled].filter((t) => allow(t, 'tables published before the app')).map((t) => owed.get(t)).filter(Boolean);
    reconciled.clear();
    for (const [type, id] of targets) await sdk.publishArtifact(type, id);
  };
  return {
    owed,
    reconciled,
    charts,
    createdViews,
    oweTablePublish,
    publishReconciled,
    createdView(table, id) {
      createdViews.push([String(table).toLowerCase(), id]);
    },
    async settle(label, result) {
      const ok = !result.refused.length && !result.unknown.length;
      if (!ok) {
        if (barrier) barrier.noteResult(result, label);
        return { ok };
      }
      for (const scope of settledPublications(result)) {
        const table = String(scope.table || '').toLowerCase();
        if (!allow(table, label)) continue;
        if (scope.type === 'chart') charts.set(table, scope.id);
        else if (scope.type === 'view') await publishReconciled('view', scope.id, table, label);
      }
      return { ok };
    },
    async beforeApp(held = []) {
      if (!publish) return publishReconciledTables();
      const wanted = preAppTables({ reconciled, charted: [...charts.keys()], added: [], held: new Set(held) });
      await publishTablesXml(client, barrier ? barrier.allowTables(wanted, 'tables published before the app') : wanted);
      reconciled.clear();
      return undefined;
    },
    async publishPhase() {
      if (!publish) return;
      const seen = new Set(barrier ? barrier.blockedTables() : []);
      const perTable = [];
      const take = (table, target) => {
        if (!seen.has(table)) {
          seen.add(table);
          perTable.push(target);
        }
      };
      for (const [table, id] of createdViews) take(table, ['view', id]);
      for (const [table, id] of charts) take(table, ['chart', id]);
      for (const [table, target] of owed) take(table, target);
      for (const [type, id] of perTable) await sdk.publishArtifact(type, id);
      owed.clear();
    },
    async halt(warn = () => {}) {
      const targets = [...owed].filter(([table]) => allow(table, 'settle after a halt')).map(([, target]) => target);
      await settleOwedPublishes(sdk, targets, warn);
    },
  };
}

module.exports = { fakeCreates, passThroughCreates, fakeManaged, fakePublication, buildPublicationQueues, buildPublishPaths };
