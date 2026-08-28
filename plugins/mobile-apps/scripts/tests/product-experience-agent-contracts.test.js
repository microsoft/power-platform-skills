'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const plannerPath = path.resolve(__dirname, '../../agents/native-app-planner.md');
const agentRoot = path.resolve(__dirname, '../../agents');

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

test('data-model contracts require writable media capabilities and omit primary-ID writes', () => {
  const dataArchitect = fs.readFileSync(
    path.join(agentRoot, 'data-model-architect.md'),
    'utf8',
  );
  const planner = fs.readFileSync(plannerPath, 'utf8');
  assert.match(dataArchitect, /canStoreFullImage: true\|false/);
  assert.match(dataArchitect, /maxSizeInKB.*1 through\s+30720/s);
  assert.match(dataArchitect, /maxHeight.*maxWidth.*fixed 144-pixel thumbnail/s);
  assert.match(
    dataArchitect,
    /server-owned primary ID column as `create`, `extend`,\s+or `adapt`/s,
  );
  assert.match(planner, /Image mutations must include explicit `canStoreFullImage`/);
  assert.match(planner, /Never declare a server-owned primary ID/);
});

test('planner agents consume bounded evidence without eagerly loading shards', () => {
  const dataArchitect = fs.readFileSync(
    path.join(agentRoot, 'data-model-architect.md'),
    'utf8',
  );
  const planner = fs.readFileSync(plannerPath, 'utf8');
  assert.match(dataArchitect, /schemaVersion: 2/);
  assert.match(dataArchitect, /Never preload every shard/);
  assert.match(dataArchitect, /shard contains only compact identities/);
  assert.match(planner, /Architect evidence schema v2/);
  assert.match(planner, /Do not read all shards or the full snapshot/);
});

test('hidden collision adaptation is journal-bound and approval-limited', () => {
  const dataArchitect = fs.readFileSync(
    path.join(agentRoot, 'data-model-architect.md'),
    'utf8',
  );
  const planner = fs.readFileSync(plannerPath, 'utf8');
  const addDataverse = fs.readFileSync(path.resolve(
    __dirname,
    '../../skills/add-dataverse/SKILL.md',
  ), 'utf8');
  assert.match(dataArchitect, /adaptationKind:\s*hidden-name-collision/);
  assert.match(dataArchitect, /Never invent this evidence/);
  assert.match(planner, /"adaptationPolicy"/);
  assert.match(planner, /semanticChangesRequireApproval/);
  assert.match(addDataverse, /journal inFlight operationId/);
  assert.match(addDataverse, /404 exact-name probe means candidate\s+metadata is absent/s);
  assert.match(addDataverse, /return `NEEDS_APPROVAL`/);
});
