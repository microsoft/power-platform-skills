'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { contractHash, deriveExperienceFromBrief } = require('../experience-patterns');
const { finalizeContextFromDomain } = require('../finalize-context-from-domain');
const { fixtureDataRevision } = require('../lib/prototype-domain-model');
const { contextEnrichmentRevision, resolveContextEnrichment } = require('../resolve-context-enrichment');
const { prototypeDomainFixture } = require('./helpers/prototype-domain-fixture');

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-finalization-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const brief = 'Help operators review current work at a facility.';
  const experience = deriveExperienceFromBrief(brief);
  const candidate = resolveContextEnrichment(brief, experience);
  const evidenceStart = brief.indexOf('facility');
  const assumption = 'The selected current work record is a bounded local prototype fixture.';
  const finalContext = {
    ...candidate,
    decisionOwner: 'model',
    contextMode: 'current-work',
    displayContext: [{
      id: 'current-work',
      label: 'Current work',
      sampleValue: 'North facility readiness review',
      valueType: 'text',
      source: 'domain-fixture',
      sourceBinding: '#/fixtures/WorkItem/0/name',
      placementIntent: 'primary-screen-context-rail',
      evidence: { signal: 'place', text: 'facility', start: evidenceStart, end: evidenceStart + 'facility'.length },
      assumption,
    }],
    ephemeralModel: { key: 'CurrentWorkContext', persistence: 'prototype-session', fields: ['currentWork'] },
    assumptions: [assumption],
    opportunities: candidate.opportunities.map((opportunity) => ({
      ...opportunity,
      confidence: opportunity.kind === 'place' ? 'selected' : 'rejected',
    })),
  };
  const domain = prototypeDomainFixture();
  domain.experienceContractSha256 = contractHash(experience);
  domain.contextEnrichmentSha256 = contextEnrichmentRevision(candidate);
  fs.writeFileSync(path.join(root, 'brief.md'), `${brief}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), `${JSON.stringify(experience, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'context-enrichment-contract.json'), `${JSON.stringify(finalContext, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-domain-model.json'), `${JSON.stringify(domain, null, 2)}\n`);
  return { root, domain };
}

test('finalizes model Context against fixtures and restamps only Domain context metadata', (context) => {
  const value = project(context);
  const result = finalizeContextFromDomain(value.root);
  const finalContext = JSON.parse(fs.readFileSync(path.join(value.root, '.tmp', 'context-enrichment-contract.json'), 'utf8'));
  const finalDomain = JSON.parse(fs.readFileSync(path.join(value.root, '.tmp', 'prototype-domain-model.json'), 'utf8'));
  assert.equal(result.fixtureBindingCount, 1);
  assert.equal(finalContext.fixtureDataSha256, fixtureDataRevision(value.domain));
  assert.equal(finalDomain.contextEnrichmentSha256, contextEnrichmentRevision(finalContext));
  assert.deepEqual(finalDomain.fixtures, value.domain.fixtures);
  assert.deepEqual(finalDomain.entities, value.domain.entities);
  const contextBytes = fs.readFileSync(path.join(value.root, '.tmp', 'context-enrichment-contract.json'));
  const domainBytes = fs.readFileSync(path.join(value.root, '.tmp', 'prototype-domain-model.json'));
  assert.deepEqual(finalizeContextFromDomain(value.root), result);
  assert.deepEqual(fs.readFileSync(path.join(value.root, '.tmp', 'context-enrichment-contract.json')), contextBytes);
  assert.deepEqual(fs.readFileSync(path.join(value.root, '.tmp', 'prototype-domain-model.json')), domainBytes);
});

test('invalid model binding leaves Context and Domain bytes unchanged', (context) => {
  const value = project(context);
  const contextPath = path.join(value.root, '.tmp', 'context-enrichment-contract.json');
  const domainPath = path.join(value.root, '.tmp', 'prototype-domain-model.json');
  const invalid = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  invalid.displayContext[0].sampleValue = 'Invented work';
  fs.writeFileSync(contextPath, `${JSON.stringify(invalid, null, 2)}\n`);
  const beforeContext = fs.readFileSync(contextPath);
  const beforeDomain = fs.readFileSync(domainPath);
  assert.throws(() => finalizeContextFromDomain(value.root), /sampleValue does not match its fixture binding/);
  assert.deepEqual(fs.readFileSync(contextPath), beforeContext);
  assert.deepEqual(fs.readFileSync(domainPath), beforeDomain);
});

test('stale Domain Experience provenance is rejected rather than restamped', (context) => {
  const value = project(context);
  const domainPath = path.join(value.root, '.tmp', 'prototype-domain-model.json');
  const stale = JSON.parse(fs.readFileSync(domainPath, 'utf8'));
  stale.experienceContractSha256 = 'f'.repeat(64);
  fs.writeFileSync(domainPath, `${JSON.stringify(stale, null, 2)}\n`);
  const before = fs.readFileSync(domainPath);
  assert.throws(() => finalizeContextFromDomain(value.root), /does not match the Experience Contract/);
  assert.deepEqual(fs.readFileSync(domainPath), before);
});
