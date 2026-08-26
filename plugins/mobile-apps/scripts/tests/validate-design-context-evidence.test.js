'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compileDesignContentProjection } = require('../compile-design-content-projection');
const { sha256, validateDesignContextEvidence } = require('../validate-design-context-evidence');
const { prototypeDomainFixture } = require('./helpers/prototype-domain-fixture');

const pluginRoot = path.resolve(__dirname, '..', '..');

function evidenceEntry(scope, relativePath, projectRoot) {
  const root = scope === 'project' ? projectRoot : pluginRoot;
  const bytes = fs.readFileSync(path.join(root, relativePath));
  return { scope, path: relativePath, bytes: bytes.length, sha256: sha256(bytes) };
}

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-context-evidence-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const model = prototypeDomainFixture();
  const artifacts = {
    'prototype-domain-model.json': model,
    'design-content-projection.json': compileDesignContentProjection(model),
    'experience-contract.json': { schemaVersion: 1, primaryJob: 'Complete realistic work.' },
    'experience-foundation-contract.json': { schemaVersion: 1, primitives: [] },
    'experience-screen-contract.json': { schemaVersion: 2, screens: [] },
    'navigation-contract.json': { schemaVersion: 1, model: 'stack' },
  };
  for (const [name, value] of Object.entries(artifacts)) {
    fs.writeFileSync(path.join(root, '.tmp', name), `${JSON.stringify(value, null, 2)}\n`);
  }
  const filesRead = [
    'skills/design-system/reference-ownership.json',
    'skills/design-system/automatic-native.md',
  ].map((relativePath) => evidenceEntry('plugin', relativePath, root));
  for (const relativePath of [
    '.tmp/experience-contract.json',
    '.tmp/experience-foundation-contract.json',
    '.tmp/experience-screen-contract.json',
    '.tmp/navigation-contract.json',
    '.tmp/design-content-projection.json',
  ]) filesRead.push(evidenceEntry('project', relativePath, root));
  return {
    root,
    evidence: { schemaVersion: 1, mode: 'automatic-native', designModelCalls: 1, filesRead },
  };
}

test('accepts exact automatic design reads including fresh representative content', (context) => {
  const value = project(context);
  assert.deepEqual(validateDesignContextEvidence(value.root, value.evidence, { pluginRoot }), { valid: true, errors: [] });
});

test('rejects omitted projection and optional-mode reference loading', (context) => {
  const value = project(context);
  value.evidence.filesRead = value.evidence.filesRead.filter((entry) => entry.path !== '.tmp/design-content-projection.json');
  value.evidence.filesRead.push(evidenceEntry('plugin', 'skills/design-system/optional-modes.md', value.root));
  const errors = validateDesignContextEvidence(value.root, value.evidence, { pluginRoot }).errors.join('\n');
  assert.match(errors, /omits required project:.tmp\/design-content-projection.json/);
  assert.match(errors, /forbidden optional reference/);
});

test('rejects stale bytes and stale representative content', (context) => {
  const value = project(context);
  const experienceEntry = value.evidence.filesRead.find((entry) => entry.path === '.tmp/experience-contract.json');
  experienceEntry.bytes += 1;
  const domainPath = path.join(value.root, '.tmp', 'prototype-domain-model.json');
  const domain = JSON.parse(fs.readFileSync(domainPath, 'utf8'));
  domain.fixtures.WorkItem[0].name = 'Changed after design projection';
  fs.writeFileSync(domainPath, `${JSON.stringify(domain, null, 2)}\n`);
  const errors = validateDesignContextEvidence(value.root, value.evidence, { pluginRoot }).errors.join('\n');
  assert.match(errors, /bytes does not match/);
  assert.match(errors, /design content projection is stale/);
});
