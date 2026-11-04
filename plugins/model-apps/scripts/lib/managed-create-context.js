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
const { ROW_PROOF_SCHEMA, ROOT_KIND, attemptProvenUnsent } = require('./managed-bindings.js');
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
    const freshAck = row.mode === 'create' && ackFact(row) && (!isRoot || createEdit);
    const persistedAck = isRoot ? attempt.acknowledgedRoot === true : receipt.some((c) => c.kind === row.kind && c.key === row.key && normalizeGuid(c.id) === row.id);
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
    const records = decided.map(({ row, origin, bound }) => (bound
      ? group.records.find((r) => r.kind === row.kind && r.key === row.key)
      : (recordOf || defaultRecord)(row, origin, attempt, header)));
    const observed = attempt.rowProtocol.rows.map((r) => {
      const s = seen.get(rowKey(r.kind, r.key));
      return { kind: r.kind, key: r.key, id: r.id, parentId: r.parentId, projectionSha256: s.projectionSha256, sensitiveInput: r.sensitiveInput };
    });
    const children = attempt.expected.children;
    return {
      token: attempt.token, baseGeneration: attempt.baseGeneration, proofSchema: ROW_PROOF_SCHEMA, records,
      proof: {
        savedSha256: sha(observed.map(({ kind, key, id, parentId, projectionSha256 }) => ({ kind, key, id, parentId, projectionSha256 }))),
        semanticSha256: sha({ rows: attempt.rowProtocol.rows.map((r) => ({ kind: r.kind, key: r.key, expectedSha256: r.expectedSha256 })), completion: attempt.rowProtocol.completion }),
        preservationSha256: attempt.expected.preservationSha256,
        expectedChildrenSha256: children.length ? sha(children) : null,
      },
      consumerState: { version: 1, rows: observed },
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
    /** Run `fn` in the request scope of `attempts` (what begin/resume answered); keeps the answers per attempt. */
    async run({ attempts, classify, deleteCode, label }, fn) {
      const outcome = await runWithManagedCreateSet({ store, entries: attempts.map(({ token, epoch }) => ({ token, epoch })), classify, deleteCode, label }, fn);
      for (const f of outcome.facts) {
        if (!facts.has(f.token)) facts.set(f.token, []);
        facts.get(f.token).push(f);
      }
      return outcome;
    },
    /** This process's in-memory answers for one attempt. */
    facts(token) {
      return (facts.get(token) || []).slice();
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
     * Settle each item { token, observation, declarationSha256? } on its own, in order: record the receipts this
     * process proved (noteSaved: an acknowledged create the fresh read found exact), then commit the item when it is
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
        const rootRow = a.rowProtocol.rows.find((r) => r.parentId === null);
        const ackRoot = !a.acknowledgedRoot && a.expected && a.expected.baseObservation === null && acked(rootRow) && exact(rootRow);
        const have = a.acknowledgedChildCreates || [];
        const childReceipts = a.rowProtocol.rows.filter((r) => r.parentId !== null && acked(r) && exact(r) && !have.some((c) => c.kind === r.kind && c.key === r.key))
          .map((r) => ({ kind: r.kind, key: r.key, id: r.id }));
        if (verdict.action !== 'resume' && verdict.code !== CODES.intentChanged && (ackRoot || childReceipts.length)) {
          store.noteSaved(token, { proof: { savedSha256: sha((observation.rows || []).map(({ kind, key, id, projectionSha256 }) => ({ kind, key, id, projectionSha256: projectionSha256 || null }))) }, acknowledgedRoot: ackRoot, acknowledgedChildCreates: childReceipts, phase: verdict.phase || 'saved' });
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
  };
}

module.exports = {
  CODES,
  createManagedCreateContext,
  classifyRecovery,
  buildRowPlan,
  expectedOf,
  defaultApprovalToken,
};
