'use strict';
// Which saved query is which declared view, when two or more declared views (views[].reconcile "declared") share one display
// name on one table under distinct keys (#845). Pure: no SDK, no file system, no XML parsing, no authorization. verify-spec.js
// performs the reads and the content evaluation and hands their results here.
//
// Two kinds of answer are kept strictly apart:
//   - an OWNER: a declaration whose row is known by an id it holds itself — its managed binding, its viewId pin, or the row read
//     at its stable create identity. Exactly one declaration may own a physical row (savedqueryid); two owners of one id is a
//     conflict, whichever sources the two claims came from.
//   - a WITNESS: a one-to-one matching of the declarations nobody can attribute onto distinct, unclaimed rows of that name. It proves
//     that distinct rows COULD satisfy those declarations; it never says which row is whose, so it is never used as an identity —
//     not to edit, adopt, pin, or compare a sub-grid's target against.
//
// SavedQuery's physical identity is its savedqueryid, not its name:
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/savedquery

const { normalizeGuid } = require('./reconcile-common.js');

const lc = (s) => String(s == null ? '' : s).toLowerCase();

/**
 * The groups of declared views that share one table and one display name (both compared case-insensitively, as Dataverse
 * compares them) and so need a distinct row each. `entries` are the spec's views in spec order:
 *   [{ ordinal, declared, table, name, key }]   (`key` the effective declared key: the authored one, else `<table>/<name>`)
 * Answers a Map from each member's ordinal to its group { table, name, members } (members in spec order). Left out, so they keep
 * the route they always had: a name only one declared view uses (legacy views beside it are not declared artifacts and never join),
 * and any group holding a key that two declared views share anywhere in the spec — such a spec is only verified under a
 * compatibility warning, and which occurrence a key means cannot be told.
 */
function declaredViewGroups(entries) {
  const keyCount = new Map();
  for (const e of entries) if (e && e.declared) keyCount.set(e.key, (keyCount.get(e.key) || 0) + 1);
  // table -> name -> members; nested maps, so no separator can make two different (table, name) pairs one bucket.
  const buckets = new Map();
  const order = [];
  for (const e of entries) {
    if (!e || !e.declared) continue;
    const table = lc(e.table);
    const name = lc(e.name);
    if (!buckets.has(table)) buckets.set(table, new Map());
    const byName = buckets.get(table);
    if (!byName.has(name)) { byName.set(name, []); order.push(byName.get(name)); }
    byName.get(name).push(e);
  }
  const out = new Map();
  for (const members of order) {
    if (members.length < 2) continue;
    if (members.some((m) => keyCount.get(m.key) > 1)) continue;
    const group = Object.freeze({ table: lc(members[0].table), name: members[0].name, members: Object.freeze(members.slice()) });
    for (const m of members) out.set(m.ordinal, group);
  }
  return out;
}

/**
 * One owner per physical row. `claim(id, owner)` records that `owner` holds `id`; an owner is
 *   { ordinal, key, source }   a declaration of this spec (`ordinal` its position in views[]), or
 *   { key, source }            a row known to belong to something else (a managed binding the spec no longer declares, a pending
 *                              attempt's root), without an ordinal.
 * The same owner claiming one id again (a second source of the same declaration, or a replan) is not a second owner. Ids are
 * compared normalized (case, braces, surrounding white space); a malformed id is not recorded and `claim` answers ''.
 * `reserve(id)` keeps a row out of every witness without making anyone its owner: the pin of a declaration whose binding it
 * contradicts is that declaration's own failure to correct, not a second claim on whoever else holds the row.
 */
function createOwnerLedger() {
  const owners = new Map();
  const reserved = new Set();
  const same = (a, b) => (a.ordinal !== undefined || b.ordinal !== undefined ? a.ordinal === b.ordinal : a.key === b.key);
  const claim = (rawId, owner) => {
    const id = normalizeGuid(rawId);
    if (!id) return '';
    if (!owners.has(id)) owners.set(id, []);
    const list = owners.get(id);
    if (!list.some((o) => same(o, owner))) list.push(owner);
    return id;
  };
  // Declarations first, in spec order, then the rows owned outside the spec's declarations, by key: one fixed order, so a message
  // that lists them reads the same on every run.
  const rank = (a, b) => {
    if (a.ordinal !== undefined && b.ordinal !== undefined) return a.ordinal - b.ordinal;
    if (a.ordinal !== undefined) return -1;
    if (b.ordinal !== undefined) return 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
  return {
    claim,
    reserve(rawId) {
      const id = normalizeGuid(rawId);
      if (id) reserved.add(id);
      return id;
    },
    /** Whether `id` is owned or reserved: no row a witness may use. */
    has: (rawId) => owners.has(normalizeGuid(rawId)) || reserved.has(normalizeGuid(rawId)),
    ownersOf: (rawId) => (owners.get(normalizeGuid(rawId)) || []).slice().sort(rank),
    /** Every id with two or more owners, at least one of them satisfying `concerns` (all, when omitted). */
    conflicts(concerns = () => true) {
      const out = [];
      for (const [id, list] of owners) {
        if (list.length < 2 || !list.some(concerns)) continue;
        out.push({ id, owners: list.slice().sort(rank) });
      }
      return out.sort((a, b) => rank(a.owners[0], b.owners[0]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}

// Why a candidate read cannot be taken as every row of the name, in the order they are reported.
const INCOMPLETE = Object.freeze({
  more: 'more rows were reported',
  noId: 'some rows had no usable savedqueryid',
  notMember: 'some rows could not be identified as members of this table and name',
  disagree: 'duplicate observations disagreed about table or name',
});
const CONTENT_FIELDS = ['layoutxml', 'fetchxml'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The candidate rows of one name on one table, from a paginated savedquery read, e.g.
 *   [{ savedqueryid: '{6F9619FF-…}', returnedtypecode: 'contoso_item', name: 'Twin', layoutxml: '<grid …', fetchxml: '<fetch …' }, …]
 * `hasMore` is the SDK's non-enumerable report (query-completeness.js hasMoreOf), read by the caller from the array the SDK
 * returned, before any copy: `true` a continuation was named, `false` the read was complete, `undefined` the reader does not say
 * (then the array is taken as it is — the convention every other verify read keeps — and `reported` is false).
 *
 * One physical row is one candidate, however many times and in whatever GUID spelling it was answered (a paginating server can
 * repeat a row on a later page). A row whose id is missing or malformed is no candidate. A row is a candidate only when its own
 * table and name say it belongs to this (table, name); one that does not say, or says otherwise, is none. Two answers of one id
 * that disagree on table or name make that id no candidate; two that disagree on content keep the id, with the disputed content
 * left out (unknown, never whichever copy came first). Answers
 *   { complete, reported, candidates: [{ id, row }] (ascending by id), reasons: [string] }
 * where `complete` is false when anything above leaves rows of the name that were not identified.
 */
function viewCandidates(answer, { table, name, hasMore }) {
  const wantTable = lc(table);
  const wantName = lc(name);
  const flags = new Set();
  if (hasMore === true) flags.add('more');
  const seen = new Map();
  for (const row of Array.isArray(answer) ? answer : []) {
    const id = row && typeof row === 'object' ? normalizeGuid(row.savedqueryid) : '';
    if (!id) { flags.add('noId'); continue; }
    const t = typeof row.returnedtypecode === 'string' ? lc(row.returnedtypecode) : null;
    const n = typeof row.name === 'string' ? lc(row.name) : null;
    const prior = seen.get(id);
    if (!prior) {
      seen.set(id, { t, n, row: { ...row }, disputed: new Set(), disagree: false });
      continue;
    }
    if (prior.t !== t || prior.n !== n) prior.disagree = true;
    for (const f of CONTENT_FIELDS) {
      if (own(prior.row, f) !== own(row, f) || prior.row[f] !== row[f]) prior.disputed.add(f);
    }
  }
  const candidates = [];
  for (const [id, s] of seen) {
    if (s.disagree) { flags.add('disagree'); continue; }
    if (s.t !== wantTable || s.n !== wantName) { flags.add('notMember'); continue; }
    const row = { ...s.row };
    for (const f of s.disputed) delete row[f];
    candidates.push({ id, row });
  }
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const reasons = Object.keys(INCOMPLETE).filter((k) => flags.has(k)).map((k) => INCOMPLETE[k]);
  return { complete: reasons.length === 0, reported: hasMore !== undefined, candidates, reasons };
}

/**
 * A maximum one-to-one matching of `left` declarations (0..leftCount-1) onto right rows, by augmenting paths (Kuhn), O(V·E):
 * deterministic, declarations in order and each one's rows in ascending order. `edges[l]` lists the rows declaration `l` may use.
 * `fixed[l]`, when a number, is a row declaration `l` already holds and keeps: it must be one of its edges and no other fixed
 * declaration's row, and it is no one else's to take.
 *
 * Answers { covered, size, witness, deficient }:
 *   covered    every declaration has a row of its own;
 *   witness    witness[l] the row matched to `l`, or -1 — proof that a cover exists or how far it gets, NOT an assignment of rows to
 *              declarations (any other maximum matching proves the same);
 *   deficient  when not covered: { left, right }, a set of declarations and every row any of them may use, with fewer rows than
 *              declarations (Hall's condition fails for exactly this set) — the group a failure names, rather than one declaration
 *              picked arbitrarily as the loser. Found by alternating reachability from the unmatched declarations.
 */
function matchDistinctRows(leftCount, edges, { fixed = [] } = {}) {
  const witness = new Array(leftCount).fill(-1);
  const adjacency = Array.from({ length: leftCount }, (_, l) => [...new Set(edges[l] || [])].sort((a, b) => a - b));
  const fixedOf = (l) => (Number.isInteger(fixed[l]) ? fixed[l] : null);
  // Fixed rows first: one that is not an edge of its declaration, or that two declarations hold, cannot be kept as it is.
  const holders = new Map();
  const notEdge = [];
  for (let l = 0; l < leftCount; l++) {
    const r = fixedOf(l);
    if (r === null) continue;
    if (!adjacency[l].includes(r)) { notEdge.push(l); continue; }
    if (!holders.has(r)) holders.set(r, []);
    holders.get(r).push(l);
  }
  const shared = [...holders].filter(([, ls]) => ls.length > 1);
  if (notEdge.length || shared.length) {
    const left = [...new Set([...notEdge, ...shared.flatMap(([, ls]) => ls)])].sort((a, b) => a - b);
    const right = shared.map(([r]) => r).sort((a, b) => a - b);
    for (const [r, ls] of holders) if (ls.length === 1) witness[ls[0]] = r;
    return { covered: false, size: holders.size, witness, deficient: { left, right } };
  }
  const taken = new Map();
  for (const [r, ls] of holders) { taken.set(r, ls[0]); witness[ls[0]] = r; }
  const locked = new Set(holders.keys());
  const free = (l) => adjacency[l].filter((r) => !locked.has(r));
  const owner = new Map();
  const augment = (l, visited) => {
    for (const r of free(l)) {
      if (visited.has(r)) continue;
      visited.add(r);
      if (!owner.has(r) || augment(owner.get(r), visited)) { owner.set(r, l); return true; }
    }
    return false;
  };
  for (let l = 0; l < leftCount; l++) if (fixedOf(l) === null) augment(l, new Set());
  for (const [r, l] of owner) witness[l] = r;
  const size = taken.size + owner.size;
  if (size === leftCount) return { covered: true, size, witness, deficient: null };
  // König/Hall: from every unmatched declaration, follow any edge to a row and that row's matching back to its declaration.
  // The declarations reached have, as all their rows, exactly the rows reached — each of them matched — so there is one row fewer
  // than declarations for every unmatched start.
  const reachedLeft = new Set();
  const reachedRight = new Set();
  const queue = [];
  for (let l = 0; l < leftCount; l++) if (witness[l] === -1) { reachedLeft.add(l); queue.push(l); }
  while (queue.length) {
    const l = queue.shift();
    for (const r of free(l)) {
      if (reachedRight.has(r)) continue;
      reachedRight.add(r);
      const next = owner.get(r);
      if (next !== undefined && !reachedLeft.has(next)) { reachedLeft.add(next); queue.push(next); }
    }
  }
  return {
    covered: false,
    size,
    witness,
    deficient: { left: [...reachedLeft].sort((a, b) => a - b), right: [...reachedRight].sort((a, b) => a - b) },
  };
}

module.exports = { declaredViewGroups, createOwnerLedger, viewCandidates, matchDistinctRows, INCOMPLETE };
