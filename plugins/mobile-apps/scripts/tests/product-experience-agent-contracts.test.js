'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const plannerPath = path.resolve(__dirname, '../../agents/native-app-planner.md');

test('native app planner may write only the documented planning artifacts', () => {
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

  assert.match(planner, /You have `Write` only for these planning artifacts/);
  for (const artifact of allowedArtifacts) {
    assert.match(planner, new RegExp(`- \`${artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
  }
  assert.match(planner, /MUST NOT write application source, generated services, configuration/);
  assert.doesNotMatch(planner, /Write` only for `native-app-plan\.md`/);
});
