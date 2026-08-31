'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const agentRoot = path.join(pluginRoot, 'agents');
const skillRoot = path.join(pluginRoot, 'skills');
const removedPlanningAgents = [
  'native-app-planner',
  'data-model-architect',
  'screen-planner',
  'offline-profile-architect',
];

function markdownFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(target);
    return entry.name.endsWith('.md') ? [target] : [];
  });
}

test('screen builder is the only runtime agent', () => {
  assert.deepStrictEqual(
    fs.readdirSync(agentRoot).filter((entry) => entry.endsWith('.md')).sort(),
    ['screen-builder.md'],
  );
});

test('screen builder defers model selection to the host', () => {
  const source = fs.readFileSync(path.join(agentRoot, 'screen-builder.md'), 'utf8');
  assert.doesNotMatch(source, /^model:\s*sonnet\s*$/m);
  assert.match(source, /channel: direct-write \| return-only/);
  assert.match(source, /The channel changes transport only/);
  assert.match(source, /Make no tool calls/);
  assert.match(source, /Write only `target_file`/);
  assert.match(source, /sealed `tokenInterfaces`/);
  assert.match(source, /Every string in sealed `testIds` must appear literally/);
  assert.doesNotMatch(source, /\bAskUserQuestion\b|\bEnterPlanMode\b|\bExitPlanMode\b|nested `Task`/);
});

test('mobile guidance contains no runtime planning-agent dependency', () => {
  const findings = [];
  for (const file of markdownFiles(pluginRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const agent of removedPlanningAgents) {
      if (source.includes(agent)) {
        findings.push(`${path.relative(pluginRoot, file)} references ${agent}`);
      }
    }
  }
  assert.deepStrictEqual(findings, []);
});

test('setup-datamodel owns foreground plan-only decisions', () => {
  const setup = fs.readFileSync(path.join(skillRoot, 'setup-datamodel', 'SKILL.md'), 'utf8');
  const add = fs.readFileSync(path.join(skillRoot, 'add-dataverse', 'SKILL.md'), 'utf8');
  assert.match(setup, /`--plan-only` is the foreground planning API/);
  assert.match(setup, /Never replace a column in place/);
  assert.match(setup, /validate-dataverse-planning-decisions\.js/);
  assert.match(add, /\/setup-datamodel` with `--plan-only`/);
  for (const source of [setup, add]) {
    assert.doesNotMatch(source, /mobile-app:(?:native-app-planner|data-model-architect)/);
    assert.doesNotMatch(source, /Spawn (?:the )?`?data-model-architect/i);
  }
});

test('setup-offline-profile owns architecture and never dispatches a planner', () => {
  const source = fs.readFileSync(path.join(skillRoot, 'setup-offline-profile', 'SKILL.md'), 'utf8');
  assert.match(source, /Design the profile in foreground/);
  assert.match(source, /deterministic row-scope cascade/);
  assert.match(source, /Register relationship associations on the parent/);
  assert.match(source, /Do not infer offline from mobile usage/);
  assert.doesNotMatch(source, /mobile-app:offline-profile-architect/);
});

test('create planning is one foreground path over the existing contracts', () => {
  const phase = fs.readFileSync(
    path.join(skillRoot, 'create-mobile-app', 'references', 'phase-3-planning.md'),
    'utf8',
  );
  assert.match(phase, /Planning uses one path on every host/);
  assert.match(phase, /\/setup-datamodel` in the foreground/);
  for (const tool of [
    'validate-product-experience.js',
    'validate-product-scope.js',
    'validate-workflow-journey.js',
    'compile-screen-build-pack.js',
    'mobile-pipeline-state.json',
  ]) {
    assert.match(phase, new RegExp(tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(phase, /All questions and approvals use foreground/);
  assert.doesNotMatch(phase, /\bTask\b/);
  assert.doesNotMatch(phase, /mobile-app:(?:native-app-planner|data-model-architect|screen-planner)/);
});

test('edit-app keeps planning foreground and uses the sealed screen-builder channels', () => {
  const source = fs.readFileSync(path.join(skillRoot, 'edit-app', 'SKILL.md'), 'utf8');
  assert.match(source, /Planning is always foreground/);
  assert.match(source, /only child-agent boundary remains\s+screen implementation/);
  assert.match(source, /\/setup-datamodel --plan-only/);
  for (const artifact of [
    'product-experience-contract.json',
    'product-scope-contract.json',
    'workflow-journey-contract.json',
    'compiled-screen-build-pack.json',
  ]) {
    assert.match(source, new RegExp(artifact.replaceAll('.', '\\.')));
  }
  assert.match(source, /Direct-write:/);
  assert.match(source, /Return-only:/);
  assert.match(source, /then `4`; reject values outside `1\.\.6`/);
  assert.match(source, /second failure moves only that screen to foreground/);
});

test('automatic design mode preserves experience quality without another pause', () => {
  const design = fs.readFileSync(path.join(skillRoot, 'design-system', 'SKILL.md'), 'utf8');
  const scaffold = fs.readFileSync(
    path.join(skillRoot, 'create-mobile-app', 'references', 'phase-4-scaffold.md'),
    'utf8',
  );
  assert.match(design, /`--auto-experience`/);
  assert.match(design, /skip this sub-step without prompting/);
  assert.match(design, /brand\/signature-components\.ts/);
  assert.match(design, /at least three\s+representative screens/);
  assert.match(scaffold, /pass `--auto-experience`/);
  assert.doesNotMatch(design, /^allowed-tools:.*\bTask\b/m);
});
