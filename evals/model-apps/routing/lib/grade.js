'use strict';

// Pure grading for routing evals. No I/O, so every rule here is unit-tested directly.
//
// An eval case:
//   { "id": 1, "tier": "smoke", "prompt": "…", "expect": "genpage" | "app-builder" | null,
//     "accept": ["app-builder"],          ← optional: other outcomes that are also correct
//     "trap": "…" }                       ← optional: the mis-route this case guards against
// `expect: null` means "no skill of the plugin under test" (a negative / bleed-detection case).
//
// A trial (one headless agent run) reports `routedTo` — the first plugin skill invoked, or null — and
// `skillCalls`, every skill it asked for, each with the `turn` that asked (lib/transcript.js).
//
// WHEN the skill was chosen matters. The agent runs with a cut-down tool menu (skill + read-only file
// tools: no writes, no shell), so a request that is plainly not for the plugin can go like this: turn 0
// looks at the empty workspace — the agent has decided no skill applies, which is the right answer —
// and turn 1, with nothing to build with, asks for a skill as a stand-in. That second request is not a
// routing decision made from the descriptions, and counting it made such a case read as a description
// that pulls the request in. So a case is graded on the FIRST turn (`initial`, the default) and a skill
// asked for only later is reported beside the grade as a delayed fallback; `eventual` grades the first
// plugin skill whenever it was asked for, which is what the runner did before the split.
//
// Model routing is not deterministic, so a case runs N trials and passes when its pass RATE
// reaches the threshold. A trial that errored (spawn failure, plugin not loaded, crash before any
// decision) is EXCLUDED from the rate rather than counted as a fail — a broken harness must read
// as a harness error, never as "the description is bad".

const NONE = 'none';
// What a case is graded on: the plugin skill chosen in the agent's first turn, or the first one chosen
// at any turn (see the header). The first is the default.
const GRADE_BASES = ['initial', 'eventual'];
// Only absorbs binary floating-point error in `threshold * trials` (0.7 * 10 = 7.000000000000001);
// it never lowers a requirement by a whole trial. The default "2 of 3" is the exact fraction 2/3
// rather than a rounded 0.67, so no tolerance is needed to make it mean what it says.
const FLOAT_EPSILON = 1e-9;

function outcomeLabel(routedTo) {
  return routedTo == null ? NONE : routedTo;
}

/** Acceptable outcome labels for a case (`none` stands for "no plugin skill"). */
function acceptable(evalCase) {
  const list = [evalCase.expect, ...(evalCase.accept || [])];
  return [...new Set(list.map(outcomeLabel))];
}

/**
 * What a trial decided, split by WHEN the plugin skill was asked for (see the header).
 *   initial   the plugin skill asked for in the agent's first turn — chosen from the prompt and the
 *             descriptions alone, before any tool result existed — or null
 *   delayed   the plugin skill asked for only AFTER a first turn that chose none, or null
 *   eventual  the first plugin skill at any turn (`initial`, else `delayed`): the trial's `routedTo`
 *   turn      the 0-based turn that asked for it, or null when none did
 * A trial that carries no per-call turns (a canned trial, a results file from before the split) has
 * only `routedTo`; it is read as a first-turn decision rather than guessed at.
 */
function decisionOf(trial) {
  const eventual = trial.routedTo == null ? null : trial.routedTo;
  if (eventual === null) return { initial: null, delayed: null, eventual: null, turn: null };
  const call = (trial.skillCalls || []).find((c) => c.ofPlugin && c.name === eventual);
  const turn = call && Number.isInteger(call.turn) ? call.turn : 0;
  return turn === 0
    ? { initial: eventual, delayed: null, eventual, turn }
    : { initial: null, delayed: eventual, eventual, turn };
}

/**
 * @param {object} evalCase
 * @param {{routedTo: string|null, skillCalls?: Array, error?: string, timedOut?: boolean}} trial
 * @param {'initial'|'eventual'} basis - which decision is graded (see GRADE_BASES)
 * @returns {{status: 'pass'|'fail'|'error', outcome?: string, delayed?: string|null, reason: string}}
 */
function gradeTrial(evalCase, trial, basis = 'initial') {
  // A trial that timed out before routing arrives here with `error` set (run-routing.js): an
  // unfinished run has not decided "none", so it is excluded rather than graded.
  if (trial.error) return { status: 'error', reason: trial.error };
  const decision = decisionOf(trial);
  const outcome = outcomeLabel(basis === 'eventual' ? decision.eventual : decision.initial);
  const ok = acceptable(evalCase).includes(outcome);
  const later = !decision.delayed ? ''
    : basis === 'eventual' ? ' (asked for only after its first turn)'
      : `, then to ${decision.delayed} after its first turn`;
  return {
    status: ok ? 'pass' : 'fail',
    outcome,
    delayed: decision.delayed,
    reason: ok ? `routed to ${outcome}${later}` : `routed to ${outcome}${later}, expected ${acceptable(evalCase).join(' | ')}`,
  };
}

/**
 * @param {object} evalCase
 * @param {Array} trials
 * @param {number} threshold - 0..1, minimum pass rate over the non-error trials.
 * @param {'initial'|'eventual'} basis - which decision is graded; the later fallbacks are
 *   counted in `delayed` on either basis, so a report can show them beside the grade.
 */
function summarizeCase(evalCase, trials, threshold, basis = 'initial') {
  const graded = trials.map((t) => gradeTrial(evalCase, t, basis));
  const valid = graded.filter((g) => g.status !== 'error');
  const passes = valid.filter((g) => g.status === 'pass').length;
  const outcomes = {};
  const delayed = {};
  for (const g of valid) {
    outcomes[g.outcome] = (outcomes[g.outcome] || 0) + 1;
    if (g.delayed) delayed[g.delayed] = (delayed[g.delayed] || 0) + 1;
  }
  const errors = graded.filter((g) => g.status === 'error').map((g) => g.reason);
  if (!valid.length) {
    return { status: 'error', passes: 0, valid: 0, runs: trials.length, rate: null, outcomes, delayed, errors, graded };
  }
  const rate = passes / valid.length;
  return {
    // Compare successes against the required COUNT, strictly: a threshold of 0.01 still needs one
    // success, and a threshold of 1 needs every valid trial.
    status: passes + FLOAT_EPSILON >= threshold * valid.length ? 'pass' : 'fail',
    passes,
    valid: valid.length,
    runs: trials.length,
    rate,
    outcomes,
    delayed,
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

module.exports = { gradeTrial, summarizeCase, validateEvals, acceptable, outcomeLabel, decisionOf, GRADE_BASES, NONE };
