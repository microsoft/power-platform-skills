'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const plannerPath = path.resolve(__dirname, '../../agents/native-app-planner.md');
const agentRoot = path.resolve(__dirname, '../../agents');

test('native app planner returns documented planning artifacts without side effects', () => {
  const planner = fs.readFileSync(plannerPath, 'utf8');
  const allowedArtifacts = [
    'native-app-plan.md',
    '_dm_section.md',
    '_screens_section.md',
    '.tmp/product-experience-contract.json',
    '.tmp/product-scope-contract.json',
    '.tmp/workflow-journey-contract.json',
    '.tmp/screen-build-pack.json',
    '.tmp/compiled-screen-build-pack.json',
    '.tmp/dataverse-schema-contract.json',
    '.tmp/mobile-plan-status.json',
  ];

  assert.match(planner, /^tools: \[\]$/m);
  for (const artifact of allowedArtifacts) {
    assert.match(planner, new RegExp(`- \`${artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
  }
  assert.match(planner, /foreground validates and atomically materializes accepted content/);
  assert.match(planner, /Return exactly one JSON object/);
  assert.match(planner, /`schemaVersion`, `status`, `agent`, `inputFingerprint`/);
  assert.match(planner, /Never dispatch another agent/);
  assert.doesNotMatch(planner, /^\s+- (?:Read|Write|Edit|Bash|Task|EnterPlanMode|ExitPlanMode|AskUserQuestion)$/m);
  assert.doesNotMatch(planner, /BLOCKED: tool surface missing/);
});

test('mobile leaf agents defer model selection to the host', () => {
  const leafAgents = [
    'data-model-architect.md',
    'screen-planner.md',
    'screen-builder.md',
    'offline-profile-architect.md',
  ];

  for (const fileName of leafAgents) {
    const source = fs.readFileSync(path.join(agentRoot, fileName), 'utf8');
    assert.doesNotMatch(source, /^model:\s*sonnet\s*$/m, fileName);
  }
});
