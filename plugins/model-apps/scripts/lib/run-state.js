// scripts/lib/run-state.js — the checkpoint file (per-step status + created ids).
const fs = require('node:fs');

function initState(runId, env, specPath) {
  return { run: runId, env, spec: specPath, steps: {} };
}
function readState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}
function writeState(statePath, state) {
  if (statePath) fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
module.exports = { initState, readState, writeState };
