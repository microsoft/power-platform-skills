'use strict';

const fs = require('node:fs');
const path = require('node:path');

const skillDir = path.resolve(__dirname, '..', '..', '..', 'skills', 'create-mobile-app');
const read = (file) => fs.readFileSync(path.join(skillDir, file), 'utf8').replace(/\r\n?/g, '\n');

// /create-mobile-app is split so the model loads only what it needs before the preview:
// SKILL.md holds Phase A (Steps 0-8, up to the preview gate) and references/make-it-real.md
// holds Phase B (Step 9.0 onward), which SKILL.md tells the model to read after the gate.
// Contract tests that follow the whole run read both, in run order, so a step's position
// in the combined text is its position in the workflow.
function createSkillPhaseA() {
  return read('SKILL.md');
}

function createSkillPhaseB() {
  return read(path.join('references', 'make-it-real.md'));
}

function createSkillWorkflow() {
  return `${createSkillPhaseA()}\n${createSkillPhaseB()}`;
}

// Only the steps the model executes, in run order. Both files open with reference material
// before their first step (SKILL.md's build-plan protocol, make-it-real.md's worked gate
// example and architecture-gate inputs), and a `step --id` call shown there as an example is
// not a point in the run. Phase B's steps start at its `## Phase B` heading.
function createSkillExecution() {
  const phaseA = createSkillPhaseA();
  const phaseB = createSkillPhaseB();
  const aStart = phaseA.indexOf('\n### Step ');
  const bStart = phaseB.indexOf('\n## Phase B');
  if (aStart < 0 || bStart < 0) throw new Error('create-mobile-app step boundaries not found');
  return `${phaseA.slice(aStart)}\n${phaseB.slice(bStart)}`;
}

module.exports = { createSkillExecution, createSkillPhaseA, createSkillPhaseB, createSkillWorkflow };
