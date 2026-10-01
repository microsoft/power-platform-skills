'use strict';

const { pageStructureProblems } = require('../../../../plugins/model-apps/scripts/lib/page-structure.js');
const { workflowCalls, isUpload, resultObject } = require('./workflow-evidence.js');
const { artifactText, commandInfo, fileName } = require('./evidence-utils.js');

function workerProblems(fixture) {
  const targets = fixture.manifest?.worker?.targets;
  if (!Array.isArray(targets) || !targets.length) return ['worker evidence omits its target files'];
  const states = new Map(targets.map((target) => [target, { stamp: false, written: null, accepted: null, attempts: 0, uploaded: false }]));
  const problems = [];
  for (const call of workflowCalls(fixture)) {
    const { flags } = commandInfo(call);
    const gate = /\bgenpage-worker-output\.js\b/.test(call.command);
    const writing = /^Write\s+/.test(call.command);
    if (!gate && !writing && !isUpload(call.command)) continue;
    const target = gate ? fileName(flags.file) : writing ? fileName(call.command.slice(6)) : fileName(flags['code-file']);
    const state = states.get(target);
    if (!state) { problems.push(`worker command names an undeclared target ${target}`); continue; }
    const result = resultObject(call);
    if (gate && flags.stamp) {
      if (result?.ok !== true || result.action !== 'stamp') problems.push(`${target}: dispatch stamp failed or is missing`);
      state.stamp = result?.ok === true;
      state.written = null;
      state.accepted = null;
    } else if (writing) {
      if (!state.stamp) problems.push(`${target}: regeneration was not freshly stamped`);
      state.written = artifactText(fixture, call.artifact);
      state.accepted = null;
    } else if (gate) {
      state.attempts += 1;
      if (!state.stamp || state.written === null) problems.push(`${target}: worker did not write since dispatch`);
      const snapshot = artifactText(fixture, call.artifact);
      if (snapshot !== state.written) problems.push(`${target}: completeness gate checked different bytes from the worker write`);
      const actual = pageStructureProblems(snapshot);
      if (result?.ok !== (actual.length === 0) || JSON.stringify(result?.problems) !== JSON.stringify(actual)) {
        problems.push(`${target}: recorded gate result disagrees with the production completeness gate`);
      }
      state.accepted = result?.ok === true && !actual.length ? snapshot : null;
      state.stamp = false;
      if (state.attempts > 2) problems.push(`${target}: failed worker was regenerated more than once`);
    } else {
      if (state.accepted === null) problems.push(`${target}: rejected worker output reached upload before a successful regeneration gate`);
      if (artifactText(fixture, target) !== state.accepted) problems.push(`${target}: uploaded TSX is not the complete accepted artifact`);
      if (result?.ok !== true) problems.push(`${target}: regenerated page upload did not succeed`);
      state.uploaded = true;
    }
  }
  for (const [target, state] of states) if (!state.uploaded) problems.push(`${target}: no upload of the accepted regeneration`);
  return problems;
}

module.exports = { workerProblems };
