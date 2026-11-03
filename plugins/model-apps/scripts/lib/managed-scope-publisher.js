'use strict';
// The build's table publishes over a managed binding store (lib/managed-bindings.js): every publish of a table a committed
// managed group publishes in goes through the managed coverage protocol (managed-feature-contract.js publishManagedScope),
// whoever in the build asked for it — a declared view's or chart's own debt, a reconciled form or view of the same table, the
// default-view enrichment, the publish phase, or the tables published before the app.
//
// WHY. A table publish ships the saved layer of EVERYTHING on the table (PublishXml, entity scope). A managed group on that
// table may have a saved layer its store did not prove — a maker's draft saved since, or a change of this tool whose outcome
// was lost — or a publish of it may already have been sent with no confirmation. A plain publish would put that live, or send
// it a second time. So the build routes such a table (publication-barrier.js `route`): a plain publish of it is refused at
// every path and remembered as wanted, and this publisher sends it once, after publishManagedScope has read every covered group
// with its family's shared reader and shown each one safe, confirming every debt the send pays in one store write.
//
// Which tables are routed: at the store's opening, every table scope a stored unit targets (routeStored); during the run, the
// table of every group a declared view or chart commits (lib/creates-stable-build.js). A build with no store file routes
// nothing, so it sends the requests it always sent.
//
// A refusal stops the build (the caller's halt), and leaves the table as publishManagedScope left it: a scope that is not shown
// safe, or whose send is not confirmed, is blocked for the rest of the run, and its debt stays in the store for the next run.
//
// Every publish is sent with `carry`, so the store journals it whether or not it pays debt: every covered group the send does
// not pay — owed and unpaid, confirmed, or not-needed with or without a desired hash — is marked dispatching under the send's
// token in the same write as any debt, with its published and saved layers read just before the send (carried). A publish
// whose answer is lost therefore fences its table across runs: the next build sends neither a change of a managed group on
// that table nor another publish of it. Only a fresh read that shows a layer the send changed settles it; a publish that
// changed nothing visible (every carried layer was already live) stays blocked until the maker accepts that risk with the
// scope's typed approval. A routed table with no committed group on it has nothing to journal: its pending attempts fence it.

const { publishManagedScope } = require('./managed-feature-contract.js');
const { classifyPersisted } = require('./managed-bindings.js');
const { publishTablesXml } = require('./table-publish.js');

const lc = (s) => String(s == null ? '' : s).toLowerCase();

/**
 * @param {{ store: object, barrier: object, client: object, halt: (phase: string, label: string, code: string, extra: object) => Error }} args
 *   store    the run's managed binding store;
 *   barrier  the run's publication barrier, the same one the build's transport is gated by (gateRequest): the managed publish
 *            passes it under its send permit;
 *   client   the Dataverse client the layers are read and the publish is sent with (`get(path)` / `post(path, body)`
 *            answering { status, body });
 *   halt     the build's halt factory, for a publish the protocol refused;
 *   settle   optional, the pacing of the read-back after each publish (publishManagedScope `settle`); only a test sets it.
 */
function createManagedTablePublisher({ store, barrier, client, halt, settle } = {}) {
  if (!store || !barrier || typeof barrier.route !== 'function' || !client || typeof halt !== 'function') {
    throw new TypeError('createManagedTablePublisher needs the store, the barrier, a client and the halt factory');
  }
  let chain = Promise.resolve();

  /** Route every table scope a stored unit targets: from now on only this publisher puts it live. */
  function routeStored() {
    for (const unit of store.snapshot().units()) {
      const c = classifyPersisted(unit);
      for (const s of (c.targets && c.targets.scopes) || []) {
        if (s && s.type === 'table' && s.table) barrier.route(lc(s.table), `managed ${unit.family} "${unit.key}"`);
      }
    }
  }

  const routed = (table) => barrier.routedTables().includes(lc(table));

  // The committed groups of `table` whose publication is owed and not dispatched: the debt this publish pays.
  function owedOn(table) {
    const out = [];
    for (const unit of store.snapshot().units()) {
      const pub = !unit.invalid && !unit.attempt && unit.group && unit.group.publication;
      if (pub && pub.state === 'owed' && pub.dispatchToken === null && pub.scope && pub.scope.type === 'table' && lc(pub.scope.table) === table) {
        out.push({ family: unit.family, key: unit.key });
      }
    }
    return out;
  }

  // The routed tables some committed group still owes a publish of.
  function owedTables() {
    const out = [];
    for (const t of barrier.routedTables()) if (owedOn(t).length && !out.includes(t)) out.push(t);
    return out;
  }

  /**
   * Publish `tables` (those of them that are routed) through the managed coverage protocol, one at a time and one
   * publish each. Answers { published: [table], withheld: [table] }; throws the halt for a refusal. Serialized: two
   * flushes never interleave, so a table is never published twice in parallel.
   */
  function flush(tables, { phase = 'publish', path = 'managed publication' } = {}) {
    const run = chain.then(async () => {
      const published = [];
      const withheld = [];
      for (const table of [...new Set((tables || []).map(lc))].filter(routed)) {
        const label = `the publish of table ${table}`;
        let out;
        try {
          out = await publishManagedScope({
            store, barrier, client, path, settle,
            scope: { type: 'table', table },
            groups: owedOn(table),
            carry: true,
            publish: async () => {
              // A refused PublishXml is RETURNED (the client answers { status }, publishTablesXml { ok: false }), so it is
              // thrown here: returning normally would let the read-back "confirm" a carried group live before the send.
              // Never `definiteNoStart`: an answer, or the lack of one, is not proof the publish never started.
              const r = await publishTablesXml(client, [table]);
              if (!r.ok) throw Object.assign(new Error(r.reason || `the publish of table ${table} was refused`), { code: 'publish-failed' });
            },
          });
        } catch (err) {
          throw halt(phase, label, (err && err.code) || 'managed-not-settled', { cause: err, findings: [{ key: table, code: (err && err.code) || 'managed-not-settled', message: String((err && err.message) || err) }] });
        }
        if (out.withheld) withheld.push(table);
        else { published.push(table); barrier.routePaid(table); }
      }
      return { published, withheld };
    });
    chain = run.catch(() => undefined);
    return run;
  }

  return { routeStored, routed, flush, owedTables, wanted: () => barrier.routedWanted() };
}

module.exports = { createManagedTablePublisher };
