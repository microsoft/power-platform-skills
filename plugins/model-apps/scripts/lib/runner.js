// scripts/lib/runner.js — executes the step registry.
const registry = require('../steps/registry.js');
const { countSteps } = require('../steps/_progress.js');
const { readState, writeState, initState } = require('./run-state.js');

// Note: step.when is called as when(opts, spec) — opts first, since gating is opts-driven (e.g. (o) => o.sampleData).
function activeSteps(spec, opts) {
  return registry.filter((s) => (s.when ? s.when(opts, spec) : true));
}

// Back-compat: run every active step in declared order with the fine-grained
// [n/total] emitter. Identical behavior/output to the pre-refactor runAll.
async function runAll(spec, opts, deps, result) {
  const total = countSteps(spec, opts);
  let i = 0;
  const d = Object.assign({}, deps, { step: (label) => deps.log(`[${++i}/${total}] ${label}`) });
  for (const step of activeSteps(spec, opts)) {
    await step.run(spec, opts, d, result);
  }
  return result;
}

// Which created-bucket(s) each step owns (for the state checkpoint + rollback later).
const CREATED_KEYS = {
  'data-model': ['entities', 'relationships'],
  'sample-data': ['records'],
  views: ['views'], charts: ['charts'], forms: ['forms'], 'app-shell': ['app'],
};
function createdFor(stepId, result) {
  const out = {};
  for (const k of CREATED_KEYS[stepId] || []) if (result.created[k] !== undefined) out[k] = result.created[k];
  return out;
}
function emit(deps, event) {
  (deps.emit || ((e) => process.stdout.write(JSON.stringify(e) + '\n')))(event);
}
// Apply --only / --from / --to over the active step list.
function sliceSteps(active, mode) {
  let steps = active;
  if (mode.only) steps = steps.filter((s) => s.id === mode.only);
  if (mode.from) { const i = steps.findIndex((s) => s.id === mode.from); if (i >= 0) steps = steps.slice(i); }
  if (mode.to) { const i = steps.findIndex((s) => s.id === mode.to); if (i >= 0) steps = steps.slice(0, i + 1); }
  return steps;
}

// Temporary stub — real teardown lands in a later task.
async function teardown(spec, buildOpts, d, result, state, statePath) { return result; }

async function runRegistry(spec, buildOpts, deps, result, statePath, mode = {}) {
  const active = activeSteps(spec, buildOpts);
  const total = active.length;
  let fine = 0;
  const fineTotal = countSteps(spec, buildOpts);
  const d = Object.assign({}, deps, { step: (label) => deps.log(`[${++fine}/${fineTotal}] ${label}`) });

  result.created = result.created || {};
  let state = readState(statePath) || initState(mode.runId || 'run', buildOpts.env, mode.specPath || '');
  // Rehydrate created ids from prior steps so resume/rollback see earlier work.
  for (const rec of Object.values(state.steps || {})) {
    if (rec.created) for (const [k, v] of Object.entries(rec.created)) result.created[k] = v;
  }

  if (mode.teardown) return teardown(spec, buildOpts, d, result, state, statePath);

  const slice = sliceSteps(active, mode);
  for (let n = 0; n < slice.length; n++) {
    const step = slice[n];
    const idx = active.indexOf(step) + 1;
    if (mode.resume && state.steps[step.id] && state.steps[step.id].status === 'done') {
      emit(d, { run: state.run, step: step.id, status: 'skipped', n: idx, total, detail: 'already done' });
      continue;
    }
    emit(d, { run: state.run, step: step.id, status: 'start', n: idx, total, detail: step.title });
    try {
      await step.run(spec, buildOpts, d, result);
      if (step.verify) await step.verify(spec, buildOpts, d, result);
      state.steps[step.id] = { status: 'done', created: createdFor(step.id, result) };
      writeState(statePath, state);
      emit(d, { run: state.run, step: step.id, status: 'done', n: idx, total, created: state.steps[step.id].created });
    } catch (err) {
      state.steps[step.id] = { status: 'error', error: String(err && err.message || err), created: createdFor(step.id, result) };
      writeState(statePath, state);
      emit(d, { run: state.run, step: step.id, status: 'error', n: idx, total, detail: String(err && err.message || err) });
      throw err;
    }
    if (mode.interactive) {
      emit(d, { run: state.run, step: step.id, status: 'paused', n: idx, total, detail: 'stop after step (interactive)' });
      break;
    }
  }
  return result;
}

module.exports = { runAll, runRegistry, activeSteps };
