'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  bindContracts,
  run,
} = require('../bind-return-only-contracts');
const {
  contractRevision,
} = require('../lib/product-experience-contracts');
const { bundleFor } = require('./helpers/product-experience-scenarios');

test('foreground binds Product Scope to canonical Product Experience revision', () => {
  const { experience, scope: sourceScope } = bundleFor('commerce');
  const scope = { ...sourceScope, experienceRevision: '0'.repeat(64) };
  const bound = bindContracts({ experience, scope });
  assert.equal(bound.scope.experienceRevision, contractRevision(experience));
});

test('foreground binds journey and build pack through the complete revision chain', () => {
  const {
    experience,
    scope: sourceScope,
    journey: sourceJourney,
    buildPack: sourceBuildPack,
  } = bundleFor('commerce');
  const bound = bindContracts({
    experience,
    scope: { ...sourceScope, experienceRevision: '0'.repeat(64) },
    journey: {
      ...sourceJourney,
      experienceRevision: '0'.repeat(64),
      scopeRevision: '0'.repeat(64),
    },
    buildPack: {
      ...sourceBuildPack,
      experienceRevision: '0'.repeat(64),
      scopeRevision: '0'.repeat(64),
      journeyRevision: '0'.repeat(64),
    },
  });
  assert.equal(bound.scope.experienceRevision, contractRevision(experience));
  assert.equal(bound.journey.experienceRevision, contractRevision(experience));
  assert.equal(bound.journey.scopeRevision, contractRevision(bound.scope));
  assert.equal(bound.buildPack.experienceRevision, contractRevision(experience));
  assert.equal(bound.buildPack.scopeRevision, contractRevision(bound.scope));
  assert.equal(bound.buildPack.journeyRevision, contractRevision(bound.journey));
});

test('binding changes only deterministic revision fields', () => {
  const { experience, scope } = bundleFor('commerce');
  const wrong = { ...scope, experienceRevision: 'f'.repeat(64) };
  const bound = bindContracts({ experience, scope: wrong }).scope;
  const withoutRevision = (value) => {
    const copy = structuredClone(value);
    delete copy.experienceRevision;
    return copy;
  };
  assert.deepEqual(withoutRevision(bound), withoutRevision(wrong));
});

test('mechanical binding rejects missing semantic content instead of creating it', () => {
  const { experience, scope } = bundleFor('commerce');
  const incomplete = structuredClone(scope);
  delete incomplete.coreJobs;
  assert.throws(
    () => bindContracts({ experience, scope: incomplete }),
    /semantic shape is invalid before binding/,
  );
  assert.equal(Object.hasOwn(incomplete, 'coreJobs'), false);
});

test('journey binding does not rewrite read-only upstream contract inputs', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'return-bind-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { experience, scope, journey } = bundleFor('commerce');
  const experiencePath = path.join(root, 'experience.json');
  const scopePath = path.join(root, 'scope.json');
  const journeyPath = path.join(root, 'journey.json');
  fs.writeFileSync(experiencePath, `${JSON.stringify(experience, null, 2)}\n`);
  fs.writeFileSync(scopePath, `${JSON.stringify(scope, null, 2)}\n`);
  fs.writeFileSync(journeyPath, `${JSON.stringify({
    ...journey,
    experienceRevision: '0'.repeat(64),
    scopeRevision: '0'.repeat(64),
  }, null, 2)}\n`);
  const before = fs.readFileSync(scopePath, 'utf8');
  run({
    projectRoot: root,
    experience: experiencePath,
    scopeInput: scopePath,
    journey: journeyPath,
  });
  assert.equal(fs.readFileSync(scopePath, 'utf8'), before);
  const boundJourney = JSON.parse(fs.readFileSync(journeyPath, 'utf8'));
  assert.equal(boundJourney.scopeRevision, contractRevision(scope));
});