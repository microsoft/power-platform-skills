'use strict';

// Canonical ordered list of the engine's 13 build phases. This is the SINGLE source of truth —
// sdk-build.js imports it from here so the stage layer and the engine can never drift. Order is
// load-bearing: phases run top-to-bottom, and downstream phases depend on earlier ones (e.g. the
// app phase consumes forms/views/charts built earlier). See docs/app-builder-staged-flow-design.md §6.
const PHASES = ['solution', 'data-model', 'sample-data', 'web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards', 'app-shell', 'pages', 'ai-features', 'publish'];

// User-facing stages, each a contiguous range of engine phases. Stages are the vocabulary the
// orchestrator narrates, gates consent on, and evals assert against — they do NOT rename or merge
// phases. `data`, `ui`, `app`, `publish` tile PHASES exactly (no gaps/overlaps); the design-only
// `author`, the code-gen `generate-pages`, and `verify` are orchestrator stages with no phase range
// and are intentionally absent from this map. See the design doc §5–§6.
const STAGES = {
  data: ['solution', 'data-model', 'sample-data'],
  ui: ['web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards'],
  app: ['app-shell', 'pages', 'ai-features'],
  publish: ['publish'],
};

// Resolve a stage name to its engine-phase range. Throws (rather than silently returning nothing)
// so a typo'd `--stage` fails loudly instead of running an empty/surprising build.
function phasesForStage(stage) {
  if (!Object.prototype.hasOwnProperty.call(STAGES, stage)) {
    throw new Error(`unknown stage '${stage}' (valid: ${Object.keys(STAGES).join(', ')})`);
  }
  return STAGES[stage].slice();
}

// Single entry point for the CLI: `--stage` selects a whole stage range and is mutually exclusive
// with the fine-grained `--only/--skip/--from/--to` selectors (mixing them is ambiguous, so reject
// it). Without `--stage`, delegate to the engine's resolvePhases (which now rejects unknown phases).
function stagePhasesOrResolve({ stage, only, skip, from, to } = {}) {
  if (stage) {
    if (only || skip || from || to) {
      throw new Error('--stage cannot be combined with --only/--skip/--from/--to');
    }
    return phasesForStage(stage);
  }
  // Lazy require to avoid a load-order cycle (sdk-build.js requires this module for PHASES).
  const { resolvePhases } = require('./sdk-build.js');
  return resolvePhases({ only, skip, from, to });
}

module.exports = { PHASES, STAGES, phasesForStage, stagePhasesOrResolve };
