'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const agentRoot = path.join(pluginRoot, 'agents');
const convertedAgents = [
  'native-app-planner.md',
  'data-model-architect.md',
  'screen-planner.md',
  'screen-builder.md',
  'offline-profile-architect.md',
];
const forbiddenTool = '(?:Read|Write|Edit|Bash|Task|EnterPlanMode|ExitPlanMode|AskUserQuestion|Grep|Glob)';

function source(fileName) {
  return fs.readFileSync(path.join(agentRoot, fileName), 'utf8');
}

test('all converted child agents explicitly declare an empty tool list', () => {
  for (const fileName of convertedAgents) {
    const value = source(fileName);
    assert.equal(
      (value.match(/^tools:\s*\[\]\s*$/gm) || []).length,
      1,
      `${fileName} must declare tools: [] exactly once`,
    );
    assert.doesNotMatch(
      value,
      new RegExp(`^\\s+- ${forbiddenTool}\\s*$`, 'm'),
      fileName,
    );
  }
});

test('converted child agents require the common return-only envelope', () => {
  const requiredFields = [
    'schemaVersion',
    'status',
    'agent',
    'inputFingerprint',
    'artifacts',
    'concerns',
    'clarification',
  ];
  const requiredStatuses = [
    'ready',
    'ready_with_concerns',
    'needs_context',
    'needs_clarification',
    'blocked',
  ];
  for (const fileName of convertedAgents) {
    const value = source(fileName);
    assert.match(value, /Return exactly one JSON object/, fileName);
    assert.match(value, /Make no tool calls/, fileName);
    assert.match(value, /never\s+dispatch\s+another agent/i, fileName);
    assert.match(value, /UTF-8[\s\S]*JSON\s+string/, fileName);
    assert.match(value, /`needs_context` and `blocked` have `artifacts: \[\]`/, fileName);
    assert.match(value, /Never return partial/, fileName);
    for (const field of requiredFields) assert.match(value, new RegExp(`\\b${field}\\b`), fileName);
    for (const status of requiredStatuses) assert.match(value, new RegExp(`\\b${status}\\b`), fileName);
  }
});

test('converted child agents contain no direct command or nested-dispatch workflow', () => {
  for (const fileName of convertedAgents) {
    const value = source(fileName);
    assert.doesNotMatch(value, /```(?:bash|sh|shell|zsh)/i, fileName);
    assert.doesNotMatch(value, new RegExp(`^\\s*(?:Spawn|Invoke|Call)\\s+.*${forbiddenTool}`, 'im'), fileName);
    assert.doesNotMatch(value, /^\s*(?:node|npx|npm|curl|az)\s+/im, fileName);
    assert.doesNotMatch(value, /BLOCKED: tool surface missing/i, fileName);
    assert.doesNotMatch(value, /Literal first line/i, fileName);
    assert.doesNotMatch(value, /mobile-app:[a-z-]+/i, fileName);
  }
});

test('screen builder returns one complete TSX artifact and does not own writes', () => {
  const builder = source('screen-builder.md');
  assert.match(builder, /exactly one complete TSX artifact/);
  assert.match(builder, /foreground\s+owns file validation/i);
  assert.match(builder, /materialization[\s\S]*belong to the foreground/i);
  assert.doesNotMatch(builder, /Write only `target_file`/);
});

test('screen planner preserves the existing Screens section boundary', () => {
  const planner = source('screen-planner.md');
  assert.match(planner, /Markdown artifact content beginning with exactly\s+`## Screens`/);
  assert.match(planner, /specs-phase Markdown artifact also begins with exactly `## Screens`/);
});

test('native and connector decisions constrain Data Model architecture first', () => {
  const planner = source('native-app-planner.md');
  const architect = source('data-model-architect.md');
  const architectureIndex = planner.indexOf('## Step 2 — Native capabilities, connectors, and persistence');
  const dataModelIndex = planner.indexOf('## Step 3 — Data Model handoff');

  assert.ok(architectureIndex >= 0, 'planner must resolve architecture inputs');
  assert.ok(dataModelIndex > architectureIndex, 'Data Model handoff must follow architecture inputs');
  assert.match(planner, /one persistence owner for every record\/evidence concept/);
  assert.match(planner, /adds no\s+question or approval/);
  assert.match(architect, /resolved native-capability decisions/);
  assert.match(architect, /resolved connector decisions/);
  assert.match(architect, /complete persistence boundary/);
  assert.match(architect, /Do not create a Dataverse duplicate of a connector-owned entity/);
  assert.match(architect, /resolved-architecture-inputs:/);
});

test('tested plugin manifests preserve both registered agent roots', () => {
  for (const relative of ['.plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, relative), 'utf8'));
    assert.deepEqual(manifest.agents, ['agents/', 'com.github.copilot/agents/'], relative);
  }
  const smoke = fs.readFileSync(
    path.join(pluginRoot, 'scripts/tests/fixtures/agents/planner-smoke-test.md'),
    'utf8',
  );
  assert.match(smoke, /^tools: \[\]$/m);
  assert.equal(
    fs.readdirSync(path.join(pluginRoot, 'com.github.copilot/agents'))
      .filter((entry) => entry.endsWith('.md')).length,
    0,
  );
});