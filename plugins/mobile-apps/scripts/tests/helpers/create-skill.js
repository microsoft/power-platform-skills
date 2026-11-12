'use strict';

const fs = require('node:fs');
const path = require('node:path');

const skillDir = path.resolve(__dirname, '..', '..', '..', 'skills', 'create-mobile-app');
const read = (file) => fs.readFileSync(path.join(skillDir, file), 'utf8').replace(/\r\n?/g, '\n');

// /create-mobile-app is split so the model loads only the build order it runs:
//   SKILL.md                         routing, the creation-state table, Step 0, and the
//                                    build-order choice; loaded for every run
//   references/screens-first.md      screens first, Phase A (Steps 1-8, up to the preview gate)
//   references/make-it-real.md       screens first, Phase B (Step 9.0 onward)
//   references/data-model-first.md   data model first, Steps 1-13 (the original workflow)
// Contract tests that follow a whole run read SKILL.md and that order's files, in run order, so a
// step's position in the combined text is its position in the workflow.
function createSkillEntry() {
  return read('SKILL.md');
}

function createSkillPhaseA() {
  return `${createSkillEntry()}\n${read(path.join('references', 'screens-first.md'))}`;
}

function createSkillPhaseB() {
  return read(path.join('references', 'make-it-real.md'));
}

function createSkillWorkflow() {
  return `${createSkillPhaseA()}\n${createSkillPhaseB()}`;
}

function createSkillDataModelFirst() {
  return `${createSkillEntry()}\n${read(path.join('references', 'data-model-first.md'))}`;
}

// Only the screens-first steps the model executes, in run order. Each flow file opens with
// reference material before its first step (screens-first.md's build-plan protocol,
// make-it-real.md's worked gate example and architecture-gate inputs), and a `step --id` call
// shown there as an example is not a point in the run. SKILL.md's steps start at Step 0;
// the flow files' steps start at their `## Phase A` / `## Phase B` headings.
function createSkillExecution() {
  const entry = createSkillEntry();
  const phaseA = read(path.join('references', 'screens-first.md'));
  const phaseB = createSkillPhaseB();
  const entryStart = entry.indexOf('\n### Step 0');
  const aStart = phaseA.indexOf('\n## Phase A');
  const bStart = phaseB.indexOf('\n## Phase B');
  if (entryStart < 0 || aStart < 0 || bStart < 0) {
    throw new Error('create-mobile-app step boundaries not found');
  }
  return `${entry.slice(entryStart)}\n${phaseA.slice(aStart)}\n${phaseB.slice(bStart)}`;
}

// The same for data model first: SKILL.md's Step 0, then data-model-first.md from its first step
// heading, past its build documentation protocol's worked examples.
function createSkillDataModelFirstExecution() {
  const entry = createSkillEntry();
  const flow = read(path.join('references', 'data-model-first.md'));
  const entryStart = entry.indexOf('\n### Step 0');
  const flowStart = flow.indexOf('\n### Step ');
  if (entryStart < 0 || flowStart < 0) throw new Error('data-model-first step boundaries not found');
  return `${entry.slice(entryStart)}\n${flow.slice(flowStart)}`;
}

module.exports = {
  createSkillDataModelFirst,
  createSkillDataModelFirstExecution,
  createSkillEntry,
  createSkillExecution,
  createSkillPhaseA,
  createSkillPhaseB,
  createSkillWorkflow,
};
