'use strict';

// Pure grading for routing evals. No I/O, so every rule here is unit-tested directly.
//
// An eval case:
//   { "id": 1, "tier": "smoke", "prompt": "…", "expect": "genpage" | "app-builder" | null,
//     "accept": ["app-builder"],          ← optional: other outcomes that are also correct
//     "trap": "…" }                       ← optional: the mis-route this case guards against
// `expect: null` means "no skill of the plugin under test" (a negative / bleed-detection case).
//
// A trial (one headless agent run) reports `routedTo` — the first plugin skill invoked, or null.
//
// Model routing is not deterministic, so a case runs N trials and passes when its pass RATE
// reaches the threshold. A trial that errored (spawn failure, plugin not loaded, crash before any
// decision) is EXCLUDED from the rate rather than counted as a fail — a broken harness must read
// as a harness error, never as "the description is bad".

const NONE = 'none';
const THRESHOLD_TOLERANCE = 0.01;

function outcomeLabel(routedTo) {
  return routedTo == null ? NONE : routedTo;
}

/** Acceptable outcome labels for a case (`none` stands for "no plugin skill"). */
function acceptable(evalCase) {
  const list = [evalCase.expect, ...(evalCase.accept || [])];
  return [...new Set(list.map(outcomeLabel))];
}

/**
 * @param {object} evalCase
 * @param {{routedTo: string|null, error?: string, timedOut?: boolean}} trial
 * @returns {{status: 'pass'|'fail'|'error', outcome?: string, reason: string}}
 */
function gradeTrial(evalCase, trial) {
  // A trial that timed out before routing arrives here with `error` set (run-routing.js): an
  // unfinished run has not decided "none", so it is excluded rather than graded.
  if (trial.error) return { status: 'error', reason: trial.error };
  const outcome = outcomeLabel(trial.routedTo);
  const ok = acceptable(evalCase).includes(outcome);
  return {
    status: ok ? 'pass' : 'fail',
    outcome,
    reason: ok ? `routed to ${outcome}` : `routed to ${outcome}, expected ${acceptable(evalCase).join(' | ')}`,
  };
}

/**
 * @param {object} evalCase
 * @param {Array} trials
 * @param {number} threshold - 0..1, minimum pass rate over the non-error trials.
 */
function summarizeCase(evalCase, trials, threshold) {
  const graded = trials.map((t) => gradeTrial(evalCase, t));
  const valid = graded.filter((g) => g.status !== 'error');
  const passes = valid.filter((g) => g.status === 'pass').length;
  const outcomes = {};
  for (const g of valid) outcomes[g.outcome] = (outcomes[g.outcome] || 0) + 1;
  const errors = graded.filter((g) => g.status === 'error').map((g) => g.reason);
  if (!valid.length) {
    return { status: 'error', passes: 0, valid: 0, runs: trials.length, rate: null, outcomes, errors, graded };
  }
  const rate = passes / valid.length;
  return {
    // Thresholds are typed as two-decimal fractions (0.67 for "2 of 3"), and 2/3 = 0.6667 < 0.67,
    // so compare with a 0.01 tolerance — otherwise the default config fails every 2-of-3 case.
    status: rate >= threshold - THRESHOLD_TOLERANCE ? 'pass' : 'fail',
    passes,
    valid: valid.length,
    runs: trials.length,
    rate,
    outcomes,
    errors,
    graded,
  };
}

/** Validate evals.json up front so a typo is a harness error, not a mystery failure. */
function validateEvals(data, pluginSkills) {
  const errs = [];
  if (!data || !Array.isArray(data.evals)) return ['evals.json must have an "evals" array'];
  const ids = new Set();
  const allowed = new Set([...pluginSkills, null]);
  for (const e of data.evals) {
    const where = `eval ${JSON.stringify(e && e.id)}`;
    if (!Number.isInteger(e.id) || e.id < 0) errs.push(`${where}: id must be a non-negative integer`);
    else if (ids.has(e.id)) errs.push(`${where}: duplicate id`);
    ids.add(e.id);
    if (typeof e.prompt !== 'string' || !e.prompt.trim()) errs.push(`${where}: prompt must be a non-empty string`);
    if (!('expect' in e)) errs.push(`${where}: "expect" is required (a skill name, or null for "no plugin skill")`);
    else if (!allowed.has(e.expect)) errs.push(`${where}: expect ${JSON.stringify(e.expect)} is not a plugin skill (${pluginSkills.join(', ')}) or null`);
    for (const a of e.accept || []) {
      if (!allowed.has(a)) errs.push(`${where}: accept ${JSON.stringify(a)} is not a plugin skill or null`);
    }
  }
  return errs;
}

module.exports = { gradeTrial, summarizeCase, validateEvals, acceptable, outcomeLabel, NONE };
