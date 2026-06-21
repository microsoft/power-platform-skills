#!/usr/bin/env node

// Bulk / batched conflict resolution (Wave 3 #3).
//
// For sites with many conflicts (e.g. hashed-bundle churn), resolving one-by-one
// is painful. This applies keep-current / accept-incoming across MANY conflicts in
// one pass, driven by a POLICY so it also works non-interactively in CI:
//
//   policy = {
//     default: 'accept-incoming' | 'keep-current' | 'skip',
//     rules: [ { match: { type?, pathIncludes?, nameIncludes? }, decision }, ... ],
//   }
//
// decideForConflict() picks the first matching rule, else the default. The bulk
// resolver routes each decision through resolve-git-conflict-useraction.js (the
// HAR-confirmed useraction PATCH) with bounded concurrency, and returns a summary.
// Nothing here is auto-applied without the caller's consent — the caller decides
// when to run it.
//
// Usage (programmatic): resolveConflictsBulk({ conflicts, policy, envUrl, solutionId, dvToken })

'use strict';

const DEFAULT_CONCURRENCY = 4;

/** Decide keep/accept/skip for one conflict from a policy. First matching rule wins. */
function decideForConflict(conflict, policy = {}) {
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  for (const rule of rules) {
    const m = rule.match || {};
    if (m.type != null && String(conflict.componentType) !== String(m.type)) continue;
    if (m.pathIncludes && !(conflict.componentPath || '').includes(m.pathIncludes)) continue;
    if (m.nameIncludes && !(conflict.componentName || '').includes(m.nameIncludes)) continue;
    return rule.decision;
  }
  return policy.default || 'skip';
}

/** Map items through an async fn with bounded concurrency, preserving order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Resolve many conflicts in bulk.
 * @param {object} args
 * @param {Array}  args.conflicts   from list-conflicts (each { componentId, componentPath, componentType, componentName, conflictId })
 * @param {object} [args.policy]    blanket/rule-based decisions (non-interactive)
 * @param {function} [args.decide]  (conflict) => 'accept-incoming'|'keep-current'|'skip' (overrides policy)
 * @param {string} args.envUrl
 * @param {string} args.solutionId
 * @param {string} [args.dvToken]
 * @param {number} [args.concurrency]
 * @param {object} [args.deps]      { resolveGitConflictUserAction } DI for tests
 * @returns {Promise<{ total, resolved, skipped, failed, results: object[] }>}
 */
async function resolveConflictsBulk({
  conflicts, policy, decide, envUrl, solutionId, dvToken,
  concurrency = DEFAULT_CONCURRENCY, deps = {},
} = {}) {
  if (!Array.isArray(conflicts)) throw new Error('conflicts must be an array');
  if (!envUrl) throw new Error('envUrl is required');
  if (!solutionId) throw new Error('solutionId is required');
  const resolveUA = deps.resolveGitConflictUserAction || require('./resolve-git-conflict-useraction').resolveGitConflictUserAction;

  const decider = typeof decide === 'function' ? decide : (c) => decideForConflict(c, policy || {});

  const results = await mapWithConcurrency(conflicts, concurrency, async (c) => {
    const decision = decider(c);
    if (decision === 'skip' || !decision) {
      return { conflictId: c.conflictId || null, name: c.componentName || null, decision: 'skip', result: 'skipped' };
    }
    if (!c.componentId) {
      return { conflictId: c.conflictId || null, name: c.componentName || null, decision, result: 'failed', error: 'missing componentId' };
    }
    const r = await resolveUA({ envUrl, token: dvToken, solutionId, componentId: c.componentId, decision });
    if (r && r.ok) return { conflictId: c.conflictId || null, name: c.componentName || null, decision, result: 'resolved', useraction: r.useraction };
    if (r && r.notFound) return { conflictId: c.conflictId || null, name: c.componentName || null, decision, result: 'not-found' };
    return { conflictId: c.conflictId || null, name: c.componentName || null, decision, result: 'failed', error: (r && r.error) || 'unknown' };
  });

  return {
    total: results.length,
    resolved: results.filter((r) => r.result === 'resolved').length,
    skipped: results.filter((r) => r.result === 'skipped').length,
    failed: results.filter((r) => r.result === 'failed' || r.result === 'not-found').length,
    results,
  };
}

module.exports = { resolveConflictsBulk, decideForConflict };
