// scripts/lib/runner.js — executes the step registry.
const registry = require('../steps/registry.js');
const { countSteps } = require('../steps/_progress.js');

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

module.exports = { runAll, activeSteps };
