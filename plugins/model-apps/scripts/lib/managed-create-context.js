'use strict';
// The shared lifecycle of a protected create set: prepare -> send in scope -> prove -> receipts -> commit, and the
// read-only recovery of an attempt an earlier run left pending (classifyRecovery: its recovery table).
//
// It is GENERIC over the row families of lib/managed-bindings.js (`rowProtocol` attempts). A driver (configuration
// rows, keyed commands) supplies what only it knows:
//   - the plan of each group: its rows (ids already reserved), each row's expected semantic hash, completion members,
//     rule state and effects (buildRowPlan turns that into the store's prepare plan and the expected proof);
//   - the classifier of its requests (lib/managed-create-transport.js runWithManagedCreateSet `classify`);
//   - a FRESH read of every prepared row, member and rule state (the observation, below), from an isolated reader —
//     never the SDK's retained local copy;
//   - the code a bound row found absent halts with (`notFoundCode`), and, if its approval tokens differ from the
//     default spelling, `approvalTokenOf`.
// This module never sends a request and never reads the service. It decides, from the persisted attempt, the
// in-memory answers of this process, and the driver's observation, what may be committed, and commits it.
//
// The observation of one attempt (all ids as GUIDs):
//   {
//     rows:    [{ kind, key, id, state: 'present' | 'absent' | 'unknown', parentId, projectionSha256,
//                 privateState?: 'match' | 'mismatch' | 'masked' | 'unknown' }],
//     members: [{ id, state: 'present' | 'absent' | 'unknown' }],
//     ruleState: 'published' | 'unpublished' | 'unknown' | null,
//   }
// `projectionSha256` is the driver's semantic projection of the row as read, comparable to the plan's
// `expectedSha256`; it never covers a private value. `privateState` is required only for a `sensitiveInput` row: whether
// the readable private value matches what the declaration asks for today (the value itself never reaches this module).
// A row of the protocol the observation does not list is an unknown read.

const crypto = require('node:crypto');
const { canonicalJson, normalizeGuid } = require('./reconcile-common.js');
const { ROW_PROOF_SCHEMA, ROOT_KIND, CODES: STORE_CODES, attemptProvenUnsent, readOnlyCapture } = require('./managed-bindings.js');
const { runWithManagedCreateSet } = require('./managed-create-transport.js');

const CODES = Object.freeze({
  intentChanged: 'managed-pending-intent-changed',
  unverified: 'create-identity-unverified',
  conflict: 'create-identity-conflict',
  completion: 'create-completion-required',
  ownership: 'create-ownership-required',
});

const sha = (value) => crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const rowKey = (kind, key) => `${kind}\u0000${key}`;
const idKey = (id) => normalizeGuid(id) || String(id).toLowerCase();

/**
 * The approval token of one row, by default:
 *   root   adopt:<family>:<rootKey>
 *   child  adopt:<childKind>:<encodeURIComponent(rootKey)>/<encodeURIComponent(slot)>
 * where a child's binding key is the JSON tuple [rootKey, slot] (e.g. '["contoso_api","request:p"]'). Both parts are
 * percent-encoded, so a '/' or ':' in a key or slot can never make two rows share a token. A child key that is not such
 * a tuple has no default token: the driver must pass its own `approvalTokenOf`.
 */
function defaultApprovalToken(family, rootKey, row) {
  if (row.parentId === null) return `adopt:${family}:${rootKey}`;
  let tuple;
  try { tuple = JSON.parse(row.key); } catch { tuple = null; }
  if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[0] !== rootKey || typeof tuple[1] !== 'string' || !tuple[1]) {
    throw new TypeError(`the ${row.kind} key ${row.key} is not a [rootKey, slot] tuple; the driver must name its approval token`);
  }
  return `adopt:${row.kind}:${encodeURIComponent(rootKey)}/${encodeURIComponent(tuple[1])}`;
}

/**
 * The expected proof an attempt is marked sending with, derived only from its row protocol (and the base observation of
 * an edit), so a run that resumes a prepared attempt computes exactly the same proof again:
 *   sentProjectionSha256  the planned rows (kind, key, id, parent, mode, expected semantic hash), sorted;
 *   preservationSha256    the rows the protocol preserves (none for configuration);
 *   children              every non-root row, with its parent as namespace and a hash of its (kind, key, id, parent).
 */
function expectedOf(root, rowProtocol, baseObservation = null) {
  const planned = rowProtocol.rows
    .map((r) => ({ kind: r.kind, key: r.key, id: r.id, parentId: r.parentId, mode: r.mode, expectedSha256: r.expectedSha256 }))
    .sort((a, b) => (rowKey(a.kind, a.key) < rowKey(b.kind, b.key) ? -1 : 1));
  return {
    proofVersion: 1, proofSchema: ROW_PROOF_SCHEMA, rootId: root.id, baseProofSha256: null,
    sentProjectionSha256: sha(planned), preservationSha256: sha({ preserved: rowProtocol.preserved }), baseObservation,
    children: rowProtocol.rows.filter((r) => r.parentId !== null).map((r) => ({
      kind: r.kind, key: r.key, namespaceParentId: r.parentId, id: r.id,
      associationSha256: sha({ kind: r.kind, key: r.key, id: r.id, parentId: r.parentId }),
    })),
  };
}

/**
 * A driver's plan of one group -> { prepare, expected }: `prepare` is what managed-bindings.js prepareAttemptSet takes,
 * `expected` the proof markAttemptSetSending takes. plan = {
 *   family, key, baseGeneration?, revision?, declarationSha256, completionBytes?,
 *   rows: [{ kind, key, id, parentId, mode: 'create' | 'update', expectedSha256, sensitiveInput? }],  root first or not;
 *         the root is the row of the family's root kind with no parent;
 *   members?: [{ kind, id, componentType }], ruleState?: 'published' | 'unpublished' | null,
 *   effects?: [{ kind: 'membership' | 'rule-state', id }],
 *   baseObservation?: { rowVersion, savedSha256 } | null    (an edit of a bound root records what it read)
 * }
 */
function buildRowPlan(plan) {
  if (!plan || !Array.isArray(plan.rows) || plan.rows.length === 0) throw new TypeError('a create-set plan names its rows');
  const rows = plan.rows.map((r) => ({
    kind: r.kind, key: r.key, id: normalizeGuid(r.id), parentId: r.parentId === null || r.parentId === undefined ? null : normalizeGuid(r.parentId),
    mode: r.mode, expectedSha256: r.expectedSha256, sensitiveInput: r.sensitiveInput === true, sentFields: null, sentSha256: null, dispatched: false,
  }));
  const rootRow = rows.find((r) => r.parentId === null && r.kind === ROOT_KIND[plan.family]);
  if (!rootRow) throw new TypeError(`the plan of the managed ${plan.family} "${plan.key}" has no root row`);
  const root = { kind: rootRow.kind, key: rootRow.key, id: rootRow.id };
  const rowProtocol = {
    version: 1, rows, preserved: [],
    completion: { ruleState: plan.ruleState === undefined ? null : plan.ruleState, members: (plan.members || []).map((m) => ({ kind: m.kind, id: normalizeGuid(m.id), componentType: m.componentType })) },
    effects: (plan.effects || []).map((e) => ({ kind: e.kind, id: normalizeGuid(e.id), dispatched: false })),
    cohort: null,
  };
  const prepare = {
    family: plan.family, key: plan.key, baseGeneration: plan.baseGeneration === undefined ? null : plan.baseGeneration, root,
    declarationSha256: plan.declarationSha256, rowProtocol,
    ...(plan.revision !== undefined ? { revision: plan.revision } : {}), ...(plan.completionBytes !== undefined ? { completionBytes: plan.completionBytes } : {}),
  };
  return { prepare, expected: expectedOf(root, rowProtocol, plan.baseObservation === undefined ? null : plan.baseObservation) };
}

function halt(code, message, rows = [], extra = {}) {
  return { action: 'halt', code, message, rows, ...extra };
}

/**
 * Decide one pending attempt, read-only, by this recovery table; the first row that applies wins:
 *   1. the declaration it was prepared for differs from today's        -> halt managed-pending-intent-changed
 *   2. prepared, or sending and provably nothing it sent was applied   -> resume ('first' / 'continue'), same ids
 *   3. any row, member or rule state could not be read                 -> halt create-identity-unverified
 *   4. a row the group already binds is absent                         -> halt `notFoundCode`
 *   5. a present row differs from the original expectation or parent,
 *      or an answer of this process named another id                   -> halt create-identity-conflict
 *   6. a planned row absent, a member missing, the rule state not the
 *      original plan's, or a private input not proved                  -> halt create-completion-required
 *   7. a row with no ownership (no acknowledgement, receipt, existing
 *      binding or exact approval)                                       -> halt create-ownership-required, with tokens
 *   8. otherwise                                                        -> commit, with each row's origin
 * opts = { declarationSha256, approvals: Set, boundRecords, facts, notFoundCode, approvalTokenOf, effects }.
 * `facts` are this process's in-memory answers for the attempt (runWithManagedCreateSet); an earlier process's are gone,
 * and only the persisted acknowledgement and receipts stand for them.
 */
function classifyRecovery(attempt, observation, opts) {
  const { declarationSha256, approvals = new Set(), boundRecords = [], facts = [], notFoundCode, approvalTokenOf = defaultApprovalToken, effects = [] } = opts || {};
  if (typeof notFoundCode !== 'string' || !notFoundCode) throw new TypeError('classifyRecovery needs the driver\'s notFoundCode');
  const name = `the managed ${attempt.family} "${attempt.key}"`;
  if (declarationSha256 !== attempt.declarationSha256) {
    return halt(CODES.intentChanged, `${name} has a pending attempt prepared for another declaration; restore the original declaration and run again`);
  }
  if (attempt.phase === 'prepared') return { action: 'resume', claim: 'first' };
  if (attemptProvenUnsent(attempt, effects)) return { action: 'resume', claim: 'continue' };
  return judgeRows(attempt, observation, { approvals, boundRecords, facts, notFoundCode, approvalTokenOf });
}

/**
 * Rows 3-8 of the recovery table (classifyRecovery), for an attempt rows 1-2 did not settle — or, `readOnly: true`, for
 * a plan of existing rows a read-only acceptance (acceptReadOnly) never sent: then no answer or receipt counts, so every
 * row is either already bound (its origin kept) or adopted under its own exact approval.
 */
function judgeRows(attempt, observation, { approvals = new Set(), boundRecords = [], facts = [], notFoundCode, approvalTokenOf = defaultApprovalToken, readOnly = false } = {}) {
  const name = `the managed ${attempt.family} "${attempt.key}"`;
  const p = attempt.rowProtocol;
  const obsRows = new Map(((observation && observation.rows) || []).map((r) => [rowKey(r.kind, r.key), r]));
  const bound = new Map(boundRecords.map((r) => [rowKey(r.kind, r.key), r]));
  const rows = p.rows.map((r) => ({ row: r, seen: obsRows.get(rowKey(r.kind, r.key)) || { state: 'unknown' }, rec: bound.get(rowKey(r.kind, r.key)) || null }));
  const ids = (list) => list.map(({ row }) => ({ kind: row.kind, key: row.key, id: row.id }));
  const members = new Map(((observation && observation.members) || []).map((m) => [normalizeGuid(m.id), m.state]));
  const ruleState = observation ? observation.ruleState : undefined;

  // 3. Unknown reads first: a failed read never proves absence or a difference.
  const unknownRows = rows.filter(({ seen }) => seen.state !== 'present' && seen.state !== 'absent');
  const unknownMembers = p.completion.members.filter((m) => { const s = members.get(m.id); return s !== 'present' && s !== 'absent'; });
  const unknownRule = p.completion.ruleState !== null && ruleState !== 'published' && ruleState !== 'unpublished';
  if (unknownRows.length || unknownMembers.length || unknownRule) {
    return halt(CODES.unverified, `${name} could not be read completely; nothing is created or bound`, ids(unknownRows));
  }
  // 4. A bound row gone: no replacement, no namesake.
  const lost = rows.filter(({ seen, rec }) => rec && seen.state === 'absent');
  if (lost.length) return halt(notFoundCode, `${name} binds a row that no longer exists; it is not replaced`, ids(lost));
  // 5. Wrong content, wrong parent, or an answer that named another id.
  const conflictFacts = new Set(facts.filter((f) => f.type === 'row' && f.outcome === 'conflict').map((f) => rowKey(f.kind, f.key)));
  const differs = rows.filter(({ row, seen }) => conflictFacts.has(rowKey(row.kind, row.key)) || (seen.state === 'present'
    && (normalizeGuid(seen.id) !== row.id || (seen.parentId ? normalizeGuid(seen.parentId) : null) !== row.parentId || seen.projectionSha256 !== row.expectedSha256)));
  if (differs.length) return halt(CODES.conflict, `${name} has a row that is not the one its attempt prepared; it is neither overwritten nor adopted`, ids(differs));
  // 6. Anything not complete after a possible write: never replayed automatically.
  const absent = rows.filter(({ seen }) => seen.state === 'absent');
  const missingMembers = p.completion.members.filter((m) => members.get(m.id) !== 'present');
  const wrongRule = p.completion.ruleState !== null && ruleState !== p.completion.ruleState;
  const ackFact = (row) => facts.some((f) => f.type === 'row' && f.kind === row.kind && f.key === row.key && f.outcome === 'acknowledged');
  // A private input is proved only by this process's own acknowledged send plus a matching fresh read, or, across
  // processes, by the maker's exact approval of a value that is readable and matches today (approval below). A masked,
  // unreadable or different value is never certified, approval or not.
  const privateOpen = rows.filter(({ row, seen }) => row.sensitiveInput && seen.privateState !== 'match');
  if (absent.length || missingMembers.length || wrongRule || privateOpen.length) {
    return halt(CODES.completion, `${name} is not complete (missing rows, solution membership, rule state or a private input); complete it under the same ids, then run again`,
      ids([...absent, ...privateOpen]), { phase: missingMembers.length ? 'membership-pending' : wrongRule ? 'state-pending' : 'saved' });
  }
  // 7. Ownership, row by row: a parent's acknowledgement or approval never stands in for a child.
  const createEdit = attempt.expected && attempt.expected.baseObservation === null;
  const receipt = attempt.acknowledgedChildCreates || [];
  const decided = [];
  const missing = [];
  const rootKey = attempt.root.key;
  for (const { row, rec } of rows) {
    const token = approvalTokenOf(attempt.family, rootKey, row);
    const approved = approvals.has(token);
    const isRoot = row.parentId === null;
    const freshAck = !readOnly && row.mode === 'create' && ackFact(row) && (!isRoot || createEdit);
    const persistedAck = !readOnly && (isRoot ? attempt.acknowledgedRoot === true : receipt.some((c) => c.kind === row.kind && c.key === row.key && normalizeGuid(c.id) === row.id));
    // A private input this process saw saved (a create or an edit) is proved by that answer plus the matching fresh read.
    // Across processes the answer is gone: only the maker's exact approval accepts today's readable, matching value as
    // the new baseline (never a claim to have confirmed the old send).
    const privateNeedsApproval = row.sensitiveInput && !ackFact(row);
    if (rec) {
      if (privateNeedsApproval && !approved) { missing.push({ row, token }); continue; }
      decided.push({ row, origin: rec.origin, bound: true, receipt: false });
    } else if ((freshAck || persistedAck) && (!privateNeedsApproval || approved)) {
      decided.push({ row, origin: 'created', bound: false, receipt: freshAck && !persistedAck });
    } else if (approved) {
      decided.push({ row, origin: 'adopted', bound: false, receipt: false });
    } else {
      missing.push({ row, token });
    }
  }
  if (missing.length) {
    return halt(CODES.ownership, `${name} matches its attempt exactly, but ${missing.length} row(s) were never acknowledged as created by it; approve each exact token to manage them`,
      ids(missing), { approvals: missing.map((m) => m.token) });
  }
  return { action: 'commit', rows: decided };
}

/**
 * The context of one invocation over one store:
 *   createManagedCreateContext({ store, approvals, notFoundCode, approvalTokenOf?, recordOf? })
 * `approvals` is the invocation's set (or list) of typed authorization tokens; `recordOf(row, origin, attempt, header)`
 * may replace the default binding record (a driver whose rows nest deeper than root -> child).
 */
function createManagedCreateContext({ store, approvals = [], notFoundCode, approvalTokenOf = defaultApprovalToken, recordOf } = {}) {
  if (!store || typeof store.prepareAttemptSet !== 'function') throw new TypeError('createManagedCreateContext needs the managed binding store');
  if (typeof notFoundCode !== 'string' || !notFoundCode) throw new TypeError('createManagedCreateContext needs the driver\'s notFoundCode');
  const approved = approvals instanceof Set ? approvals : new Set(approvals);
  const facts = new Map();
  const begun = new Set();
  // The receipt-store failure that stopped this context (run): nothing more is sent under it.
  let stopped = null;
  // #847: token -> { epoch } of an original two-row variable create whose run was NOT checked (its value request failed)
  // but whose own definition POST this process saw acknowledged, kept in memory only (never a body, an error or a private
  // input) until receiptPartialVariableRoot proves that root by a fresh exact read. A later process has no candidate:
  // a matching read alone never makes a root this attempt's creation (judgeRows reads acknowledgedRoot as ownership).
  const partialRoots = new Map();
  // Tokens claimValue claimed in this process: one value claim per attempt per process.
  const valueClaims = new Set();

  const accepts = (check, value) => {
    try { return check(value) === true; } catch { return false; }
  };
  // The root receipt of a checked run (run): for each attempt of the run whose root THIS run created — a create of a
  // new root (no base observation), not already receipted, its root row's own fact acknowledged under the root's id —
  // one noteSaved at the epoch the run was sent under. The store re-checks the epoch, the root and its create mode.
  function receiptRoots(attempts, rowFacts) {
    store.refresh();
    const env = snapshot();
    for (const { token, epoch } of attempts) {
      const a = env.attempts.find((x) => x.token === token);
      if (!a || !a.rowProtocol || a.acknowledgedRoot || !a.expected || a.expected.baseObservation !== null) continue;
      const root = a.rowProtocol.rows.find((r) => r.parentId === null && r.kind === a.root.kind && r.key === a.root.key);
      if (!root || root.mode !== 'create' || idKey(root.id) !== idKey(a.root.id)) continue;
      const fact = rowFacts.find((f) => f.token === token && f.kind === root.kind && f.key === root.key);
      if (!fact || fact.outcome !== 'acknowledged' || fact.mode !== 'create' || idKey(fact.id) !== idKey(root.id)) continue;
      store.noteSaved(token, { proof: null, acknowledgedRoot: true, phase: 'sending', epoch });
    }
  }

  // #847: remember, for an UNCHECKED run, each attempt that is an original create of a two-row environment variable (a
  // definition and its value, no base) whose root fact is this run's own acknowledged create at the root id, with no
  // conflicting fact and no local failure. Only the epoch is kept; receiptPartialVariableRoot does the proving.
  function notePartialRoots(attempts, rowFacts, localError) {
    if (localError) return;
    store.refresh();
    const env = snapshot();
    for (const { token, epoch } of attempts) {
      const a = env.attempts.find((x) => x.token === token);
      if (!a || a.family !== 'environmentVariable' || !a.rowProtocol || a.acknowledgedRoot || !a.expected || a.expected.baseObservation !== null) continue;
      const rows = a.rowProtocol.rows;
      const root = rows.find((r) => r.parentId === null);
      if (rows.length !== 2 || !root || root.mode !== 'create' || root.kind !== a.root.kind || root.key !== a.root.key || idKey(root.id) !== idKey(a.root.id)) continue;
      const mine = rowFacts.filter((f) => f.token === token);
      if (mine.some((f) => f.outcome === 'conflict')) continue;
      const fact = mine.find((f) => f.kind === root.kind && f.key === root.key);
      if (!fact || fact.outcome !== 'acknowledged' || fact.mode !== 'create' || idKey(fact.id) !== idKey(root.id)) continue;
      partialRoots.set(token, { epoch });
    }
  }

  const snapshot = () => store.snapshot().envelope;
  const attemptOf = (env, token) => {
    const a = env.attempts.find((x) => x.token === token);
    if (!a) throw Object.assign(new Error('the create set names an attempt the store does not hold'), { code: 'managed-not-settled' });
    return a;
  };

  function defaultRecord(row, origin, attempt, header) {
    return {
      formatVersion: 1, appUniqueName: header.appUniqueName, environmentFingerprint: header.environmentFingerprint,
      kind: row.kind, key: row.key, id: row.id, intentSha256: row.expectedSha256, origin,
      ...(row.parentId !== null ? { parentKey: attempt.root.key } : {}),
    };
  }

  function proposalOf(attempt, observation, decided, env) {
    const header = { appUniqueName: env.appUniqueName, environmentFingerprint: env.environmentFingerprint };
    const group = env.groups.find((g) => g.family === attempt.family && g.key === attempt.key) || null;
    const seen = new Map(observation.rows.map((r) => [rowKey(r.kind, r.key), r]));
    const records = decided.map(({ row, origin, bound }) => {
      if (!bound) return (recordOf || defaultRecord)(row, origin, attempt, header);
      // A bound row is recorded again with the intent this attempt proved (an edit changes what the row should be), but
      // never under another identity or origin: the row it binds and how it was first bound are history, not intent.
      const old = group.records.find((r) => r.kind === row.kind && r.key === row.key);
      const next = (recordOf || defaultRecord)(row, old.origin, attempt, header);
      if (!next || next.kind !== old.kind || next.key !== old.key || idKey(next.id) !== idKey(old.id) || next.origin !== old.origin) {
        throw new TypeError(`the record of the bound ${row.kind} "${row.key}" must keep its kind, key, id and origin`);
      }
      return next;
    });
    const observed = attempt.rowProtocol.rows.map((r) => {
      const s = seen.get(rowKey(r.kind, r.key));
      return { kind: r.kind, key: r.key, id: r.id, parentId: r.parentId, projectionSha256: s.projectionSha256, sensitiveInput: r.sensitiveInput };
    });
    const children = attempt.expected.children;
    // The consumer state is the last confirmed baseline of every row the group binds, and the store keeps every record
    // an attempt does not name. A row this attempt omitted (an update of the root alone) was not observed now, so it
    // keeps the baseline it was last confirmed with, unchanged under its retained identity, and is never restamped
    // as freshly observed. The saved proof stays over the rows this attempt observed.
    const fresh = new Set(observed.map((r) => rowKey(r.kind, r.key)));
    const prior = group && group.consumerState && Array.isArray(group.consumerState.rows) ? group.consumerState.rows : [];
    const carried = prior.filter((r) => !fresh.has(rowKey(r.kind, r.key))).map((r) => ({ ...r }));
    return {
      token: attempt.token, baseGeneration: attempt.baseGeneration, proofSchema: ROW_PROOF_SCHEMA, records,
      proof: {
        savedSha256: sha(observed.map(({ kind, key, id, parentId, projectionSha256 }) => ({ kind, key, id, parentId, projectionSha256 }))),
        semanticSha256: sha({ rows: attempt.rowProtocol.rows.map((r) => ({ kind: r.kind, key: r.key, expectedSha256: r.expectedSha256 })), completion: attempt.rowProtocol.completion }),
        preservationSha256: attempt.expected.preservationSha256,
        expectedChildrenSha256: children.length ? sha(children) : null,
      },
      consumerState: { version: 1, rows: [...observed, ...carried] },
      adoptionApproved: decided.some(({ row, origin, bound }) => !bound && row.parentId === null && origin === 'adopted'),
      adoptionApprovedChildren: decided.filter(({ row, origin, bound }) => !bound && row.parentId !== null && origin === 'adopted').map(({ row }) => ({ kind: row.kind, key: row.key, id: row.id })),
    };
  }

  return {
    /** Prepare every plan (buildRowPlan input) in ONE write, then mark them sending in ONE write: [{ family, key, token, epoch, expected }]. */
    begin(plans) {
      const built = plans.map(buildRowPlan);
      const tokens = store.prepareAttemptSet(built.map((b) => b.prepare));
      const marked = store.markAttemptSetSending(tokens.map((token, i) => ({ token, expected: built[i].expected })), { claim: 'first', observed: true });
      return marked.map(({ token, epoch }, i) => { begun.add(token); return { family: built[i].prepare.family, key: built[i].prepare.key, token, epoch, expected: built[i].expected }; });
    },
    /**
     * Claim attempts classifyRecovery answered `resume` for, under the same ids and a new fenced epoch: entries
     * [{ token, claim: 'first' | 'continue', baseObservation? }]. A sent attempt keeps the proof it was sent with; a
     * prepared one's is recomputed from its persisted protocol (with the edit's fresh `baseObservation`, if any).
     */
    resume(entries) {
      store.refresh();
      const env = snapshot();
      const out = [];
      for (const claim of ['first', 'continue']) {
        const these = entries.filter((e) => e.claim === claim);
        if (!these.length) continue;
        const marks = these.map(({ token, baseObservation = null }) => {
          const a = attemptOf(env, token);
          return { token, expected: a.expected || expectedOf(a.root, a.rowProtocol, baseObservation) };
        });
        for (const m of store.markAttemptSetSending(marks, { claim, observed: true })) {
          begun.add(m.token);
          const a = attemptOf(env, m.token);
          out.push({ family: a.family, key: a.key, token: m.token, epoch: m.epoch, expected: marks.find((x) => x.token === m.token).expected });
        }
      }
      return out;
    },
    /**
     * Claim the one completion effect `{ kind, id }` of the attempt `token` that its record proves was never dispatched
     * (store.claimUnsentRowEffect: a saved rule create's initial publication), under a new fenced epoch. Answers the
     * entry `run` takes: { family, key, token, epoch, expected }.
     */
    claimEffect(token, { kind, id }) {
      const { epoch } = store.claimUnsentRowEffect({ token, kind, id });
      store.refresh();
      const a = attemptOf(snapshot(), token);
      begun.add(token);
      return { family: a.family, key: a.key, token, epoch, expected: a.expected };
    },
    /**
     * #847: whether this process holds a partial-root candidate for `token` at `epoch` (run kept one: an unchecked original
     * variable create whose own definition answer was acknowledged, no conflicting fact, no local failure). Read only; a
     * caller asks before spending a fresh read on receiptPartialVariableRoot.
     */
    hasPartialRoot(token, epoch) {
      const cand = partialRoots.get(token);
      return !!cand && cand.epoch === epoch;
    },
    /**
     * #847: receipt the root of an original two-row variable create whose run was NOT checked (its value request failed)
     * when this process saw that root's own create acknowledged (run kept it as a candidate at `epoch`) AND the fresh
     * read `observation` (taken after that run) shows the root exactly as prepared: present at its id, no parent, its
     * planned projection over a complete child graph. The attempt must still be the one prepared for `declarationSha256`.
     * Writes only the root receipt (noteSaved phase `sending`, at `epoch`, which the store re-checks), never a child
     * receipt or a saved observation; the run's own facts stay unchecked. Answers true when the root is receipted (now or
     * earlier), false when the proof is incomplete (nothing written); a store failure throws typed.
     */
    receiptPartialVariableRoot({ token, epoch, observation, declarationSha256 } = {}) {
      const cand = partialRoots.get(token);
      if (!cand || cand.epoch !== epoch) return false;
      store.refresh();
      const a = attemptOf(snapshot(), token);
      if (a.declarationSha256 !== declarationSha256 || a.family !== 'environmentVariable' || !a.rowProtocol || a.rowProtocol.rows.length !== 2) return false;
      if (a.acknowledgedRoot === true) return true;
      const root = a.rowProtocol.rows.find((r) => r.parentId === null);
      const seen = root && observation && Array.isArray(observation.rows) ? observation.rows.find((r) => r.kind === root.kind && r.key === root.key) : null;
      if (!seen || seen.state !== 'present' || normalizeGuid(seen.id) !== root.id || (seen.parentId ? normalizeGuid(seen.parentId) : null) !== null
        || seen.projectionSha256 !== root.expectedSha256) return false;
      store.noteSaved(token, { proof: null, acknowledgedRoot: true, phase: 'sending', epoch });
      partialRoots.delete(token);
      return true;
    },
    /**
     * #847: claim the ONE never-dispatched value row of an unfinished variable create (store.claimUnsentValueRow) under a
     * new fenced epoch: `{ id, parentId }` the value row and its definition, `capture` from captureReadOnly taken before
     * the caller's fresh read, `declarationSha256` today's digest over the attempt's own rows. A root this attempt's own
     * answer never acknowledged needs the maker's exact root approval (the adoption token of the definition). Refused for
     * an attempt this process already began, resumed or claimed. Answers the entry `run` takes:
     * { family, key, token, epoch, expected }.
     */
    claimValue(token, { id, parentId, capture, declarationSha256 } = {}) {
      store.refresh();
      const a = attemptOf(snapshot(), token);
      if (begun.has(token) || valueClaims.has(token)) {
        throw Object.assign(new Error(`the managed ${a.family} "${a.key}" attempt was already sent or claimed by this run; its value is not claimed again`), { code: STORE_CODES.pending });
      }
      const root = a.rowProtocol ? a.rowProtocol.rows.find((r) => r.parentId === null) : null;
      const rootApproved = !!root && approved.has(approvalTokenOf(a.family, a.root.key, root));
      valueClaims.add(token);
      const { epoch } = store.claimUnsentValueRow({ token, id, parentId, capture, declarationSha256, rootApproved });
      begun.add(token);
      return { family: a.family, key: a.key, token, epoch, expected: a.expected };
    },
    /**
     * Run `fn` in the request scope of `attempts` (what begin/resume answered); keeps the answers per attempt.
     * `acceptResult(value)` is the driver's check of what `fn` answered (acceptSaved for an SDK push): the run is CHECKED
     * only when it answers exactly `true` (a throw is false), `fn` threw nothing, the scope latched no local failure and
     * every row request it sent was acknowledged (none unknown, unanswered or naming another row). No `acceptResult`
     * means no checked run. Only a checked run's acknowledgements are kept as such: in any other run each one is kept as
     * `unchecked` — a 2xx for one request of an operation that failed, or whose result nobody checked, proves no create —
     * while a conflict or an unknown answer is kept exactly as it was.
     * Right after a checked run, before any read-back or membership request, every root it created is receipted in the
     * store (noteSaved, the attempt staying sending): a root create this run saw acknowledged and checked, of an attempt
     * still at the epoch it was sent under. A receipt the store cannot write is this run's `localError` (typed, never a
     * network retry), its acknowledgements are kept unchecked, and every later run of this context is refused unsent.
     * Answers runWithManagedCreateSet's { value, error, localError, facts } and `checked`. `batch` is passed to it as given
     * (the one Custom API change set a set may send, see runWithManagedCreateSet); an API PATCH in it is an update, so
     * it never receipts a root.
     */
    async run({ attempts, classify, deleteCode, label, acceptResult, batch }, fn) {
      if (stopped) return { value: undefined, error: null, localError: stopped, facts: [], checked: false };
      const outcome = await runWithManagedCreateSet({ store, entries: attempts.map(({ token, epoch }) => ({ token, epoch })), classify, deleteCode, label, batch }, fn);
      const rowFacts = outcome.facts.filter((f) => f.type === 'row');
      let localError = outcome.localError;
      let checked = typeof acceptResult === 'function' && outcome.error === null && localError === null
        && rowFacts.every((f) => f.outcome === 'acknowledged') && accepts(acceptResult, outcome.value);
      if (checked) {
        try {
          receiptRoots(attempts, rowFacts);
        } catch (e) {
          stopped = e;
          localError = e;
          checked = false;
        }
      }
      if (!checked) {
        // Only a hint for a later proof: a store that cannot be read here leaves no candidate, never a failure.
        try { notePartialRoots(attempts, rowFacts, localError); } catch { /* no candidate */ }
      }
      for (const f of outcome.facts) {
        if (!facts.has(f.token)) facts.set(f.token, []);
        facts.get(f.token).push(!checked && f.type === 'row' && f.outcome === 'acknowledged' ? { ...f, outcome: 'unchecked' } : f);
      }
      return { ...outcome, localError, checked };
    },
    /**
     * The invocation's approval tokens, as given (a copy). A driver whose tokens carry more than the default spelling (an
     * adoption of a row made at another id, configuration-protected.js) reads here which ones the maker gave before it
     * plans anything.
     */
    approvals() {
      return [...approved];
    },
    /** This process's in-memory answers for one attempt. */
    facts(token) {
      return (facts.get(token) || []).slice();
    },
    /**
     * Release `attempt` (what begin/resume answered) after its run stopped before anything left — the operation was refused
     * before its first request — so it does not hold its group for a declaration that is never sent (store
     * retireProvenUnsentAttempt: only at the epoch this run holds, and only while the attempt's own record proves nothing
     * it may have sent can land). Best effort: answers true when it was released, false when the store kept it (it may
     * have been sent, another run claimed it, or the store could not be written), so it stays on its recovery path and
     * the caller's own stop stands.
     */
    release(attempt) {
      try {
        store.retireProvenUnsentAttempt({ token: attempt.token, epoch: attempt.epoch });
        begun.delete(attempt.token);
        facts.delete(attempt.token);
        return true;
      } catch {
        return false;
      }
    },
    /** classifyRecovery for the persisted attempt `token`, with this context's approvals, answers and bindings. */
    classify(token, observation, { declarationSha256 } = {}) {
      store.refresh();
      const env = snapshot();
      const a = attemptOf(env, token);
      const group = env.groups.find((g) => g.family === a.family && g.key === a.key) || null;
      return classifyRecovery(a, observation, {
        declarationSha256: declarationSha256 === undefined && begun.has(token) ? a.declarationSha256 : declarationSha256,
        approvals: approved, boundRecords: group ? group.records : [], facts: facts.get(token) || [], notFoundCode, approvalTokenOf,
        effects: env.workflowEffects,
      });
    },
    /**
     * Settle each item { token, observation, declarationSha256? } on its own, in order: record the child receipts this
     * process proved (noteSaved: a child create a checked run saw acknowledged and the fresh read found exact; a root's
     * receipt was already written by that run), then commit the item when it is
     * complete. One item's halt never stops an earlier or later item's commit (configuration groups are independent);
     * a store failure (busy, full, write failed) throws, typed. Answers [{ family, key, token, verdict, group? }].
     */
    settle(items) {
      const results = [];
      for (const { token, observation, declarationSha256 } of items) {
        let verdict = this.classify(token, observation, { declarationSha256 });
        let env = snapshot();
        let a = attemptOf(env, token);
        // Receipts are what THIS process saw acknowledged and a fresh read then found exactly as prepared; they are kept
        // with the attempt, so a later run (or this item's ownership halt) still has them.
        const exact = (row) => {
          const s = observation && observation.rows.find((r) => r.kind === row.kind && r.key === row.key);
          return s && s.state === 'present' && normalizeGuid(s.id) === row.id && (s.parentId ? normalizeGuid(s.parentId) : null) === row.parentId && s.projectionSha256 === row.expectedSha256;
        };
        const mine = facts.get(token) || [];
        const acked = (row) => row.mode === 'create' && mine.some((f) => f.type === 'row' && f.kind === row.kind && f.key === row.key && f.outcome === 'acknowledged')
          && !mine.some((f) => f.type === 'row' && f.kind === row.kind && f.key === row.key && f.outcome === 'conflict');
        // A root create is receipted by the checked run itself (run); only children wait for this fresh exact read.
        const have = a.acknowledgedChildCreates || [];
        const childReceipts = a.rowProtocol.rows.filter((r) => r.parentId !== null && acked(r) && exact(r) && !have.some((c) => c.kind === r.kind && c.key === r.key))
          .map((r) => ({ kind: r.kind, key: r.key, id: r.id }));
        if (verdict.action !== 'resume' && verdict.code !== CODES.intentChanged && childReceipts.length) {
          store.noteSaved(token, { proof: { savedSha256: sha((observation.rows || []).map(({ kind, key, id, projectionSha256 }) => ({ kind, key, id, projectionSha256: projectionSha256 || null }))) }, acknowledgedChildCreates: childReceipts, phase: verdict.phase || 'saved' });
          verdict = this.classify(token, observation, { declarationSha256 });
          env = snapshot();
          a = attemptOf(env, token);
        }
        const result = { family: a.family, key: a.key, token, verdict };
        if (verdict.action === 'commit') {
          const [group] = store.commitGroupSet([proposalOf(a, observation, verdict.rows, env)]);
          result.group = group;
        }
        results.push(result);
      }
      return results;
    },
    /**
     * What a read-only acceptance (acceptReadOnly) is later checked against, taken BEFORE the fresh read that proves its
     * rows: one capture per token (managed-bindings.js readOnlyCapture), from a fresh read of the store.
     */
    captureReadOnly(tokens) {
      store.refresh();
      const env = snapshot();
      return tokens.map((token) => {
        attemptOf(env, token);
        return readOnlyCapture(env, token);
      });
    },
    /**
     * Accept, WITHOUT sending anything, attempts deliberately planned over existing rows only (every row `update`, the
     * expected proof carrying the base observation it read) and never sent: items [{ token, observation, capture,
     * declarationSha256?, approvalTokenOf? }], `capture` from captureReadOnly before `observation` was read; an item's own
     * `approvalTokenOf` spells its rows' tokens in place of the context's (an adoption names each row's id). Each item must be the
     * declaration it was prepared for, show nothing dispatched, and read back exactly — rows, parents, content, members,
     * rule state, and a private input readable and matching — with every row the group does not bind approved by its
     * own exact token (rows 3-8 of the recovery table, with no answer or receipt counted). This is not the generic
     * recovery of an unsent attempt (classifyRecovery resumes those), and an attempt that may have sent anything is
     * never accepted here. The items are ONE acceptance: unless every one of them can commit, none is committed and
     * every attempt stays held; otherwise all commit in one store write (commitReadOnlyGroupSet), which re-checks each
     * capture and the zero dispatch under its lease, adopts each new record and keeps each bound record's origin.
     * Answers [{ family, key, token, verdict, group? }].
     */
    acceptReadOnly(items) {
      store.refresh();
      const env = snapshot();
      const results = [];
      const proposals = [];
      for (const { token, observation, capture, declarationSha256, approvalTokenOf: itemTokenOf } of items) {
        const { a, verdict } = readOnlyVerdict(env, { token, observation, declarationSha256, itemTokenOf });
        if (!capture || capture.token !== token) throw new TypeError(`the managed ${a.family} "${a.key}" has no capture taken before its fresh read (captureReadOnly)`);
        results.push({ family: a.family, key: a.key, token, verdict });
        if (verdict.action === 'commit') proposals.push({ ...proposalOf(a, observation, verdict.rows, env), capture });
      }
      if (proposals.length !== items.length) return results;
      const groups = store.commitReadOnlyGroupSet(proposals);
      results.forEach((r, i) => { r.group = groups[i]; });
      return results;
    },
    /**
     * The verdict acceptReadOnly would give each item [{ token, observation, declarationSha256?, approvalTokenOf? }], judged exactly as it
     * judges (the declaration, the zero dispatch, then rows 3-8 with no answer or receipt counted), WITHOUT committing
     * anything: a read-only preflight names the halt before the build sends anything, and a commit here is only a
     * forecast — the acceptance itself re-reads, re-captures and re-judges. Answers [{ family, key, token, verdict }].
     */
    judgeReadOnly(items) {
      store.refresh();
      const env = snapshot();
      return items.map(({ token, observation, declarationSha256, approvalTokenOf: itemTokenOf }) => {
        const { a, verdict } = readOnlyVerdict(env, { token, observation, declarationSha256, itemTokenOf });
        return { family: a.family, key: a.key, token, verdict };
      });
    },
  };

  // One item of a read-only acceptance, judged (acceptReadOnly, judgeReadOnly). Throws when the attempt is not a plan of
  // existing rows with a base observation: only such a plan is ever accepted without a send.
  function readOnlyVerdict(env, { token, observation, declarationSha256, itemTokenOf }) {
    const a = attemptOf(env, token);
    const name = `the managed ${a.family} "${a.key}"`;
    if (!a.rowProtocol || !a.expected || !a.expected.baseObservation || a.rowProtocol.rows.some((r) => r.mode !== 'update')) {
      throw new TypeError(`${name} is not a plan of existing rows with a base observation; only such a plan is accepted without a send`);
    }
    const declared = declarationSha256 === undefined && begun.has(token) ? a.declarationSha256 : declarationSha256;
    const group = env.groups.find((g) => g.family === a.family && g.key === a.key) || null;
    let verdict;
    if (declared !== a.declarationSha256) {
      verdict = halt(CODES.intentChanged, `${name} has a pending attempt prepared for another declaration; restore the original declaration and run again`);
    } else if (!attemptProvenUnsent(a, env.workflowEffects)) {
      verdict = halt(STORE_CODES.pending, `${name} attempt may have sent something; it is recovered from its original expectation, never accepted read-only`);
    } else {
      verdict = judgeRows(a, observation, { approvals: approved, boundRecords: group ? group.records : [], notFoundCode, approvalTokenOf: typeof itemTokenOf === 'function' ? itemTokenOf : approvalTokenOf, readOnly: true });
    }
    return { a, verdict };
  }
}

/**
 * The `acceptResult` of a run (createManagedCreateContext run) for the SDK's pushArtifact: the result proves a checked
 * save only when it says `saved: true` for exactly the artifact the run pushed — the expected `type` and `id` (a GUID in
 * any spelling; a command bar's id is its table name, compared exactly) — and carries no error. A refused
 * ({ saved: false, error }), adopted-existing, no-op, malformed or missing result proves nothing.
 *   { type, id, saved: true, shipped, publish, ... }                         a save: accepted
 *   { type, id, saved: false, adoptedExisting: true, ... }                   an existing artifact taken over: not a create
 *   { type, id, saved: false, shipped: false, publish, error: { code } }     a refusal (ALREADY_EXISTS, VERSION_CONFLICT, ...)
 */
function acceptSaved({ type, id } = {}) {
  if (typeof type !== 'string' || !type || typeof id !== 'string' || !id) throw new TypeError('acceptSaved needs the artifact type and id the run pushes');
  const want = normalizeGuid(id) || id;
  return (result) => !!result && typeof result === 'object' && !Array.isArray(result)
    && result.saved === true && result.adoptedExisting !== true && (result.error === undefined || result.error === null)
    && result.type === type && typeof result.id === 'string' && (normalizeGuid(result.id) || result.id) === want;
}

module.exports = {
  CODES,
  createManagedCreateContext,
  classifyRecovery,
  acceptSaved,
  buildRowPlan,
  expectedOf,
  defaultApprovalToken,
};
