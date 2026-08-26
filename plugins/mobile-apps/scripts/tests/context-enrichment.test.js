'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveExperienceFromBrief } = require('../experience-patterns');
const { fixtureDataRevision } = require('../lib/prototype-domain-model');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { validateContextEnrichment } = require('../validate-context-enrichment');

function resolve(brief) {
  const experience = deriveExperienceFromBrief(brief);
  const context = resolveContextEnrichment(brief, experience);
  return { brief, experience, context };
}

function selectedContext(value, entries, mode = 'model-selected') {
  const assumptions = [...new Set(entries.map((entry) => entry.assumption))];
  return {
    ...value.context,
    decisionOwner: 'model',
    contextMode: mode,
    displayContext: entries,
    ephemeralModel: entries.length ? {
      key: 'SessionContext',
      persistence: 'prototype-session',
      fields: entries.map((entry) => entry.id.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())),
    } : null,
    assumptions,
    opportunities: value.context.opportunities.map((opportunity) => ({
      ...opportunity,
      confidence: entries.some((entry) => entry.evidence.signal === opportunity.kind) ? 'selected' : 'rejected',
    })),
  };
}

function entry(brief, id, label, sampleValue, signal, evidenceText, source = 'illustrative-session') {
  const start = brief.toLowerCase().indexOf(evidenceText.toLowerCase());
  return {
    id,
    label,
    sampleValue,
    valueType: 'text',
    source,
    placementIntent: 'primary-screen-context-rail',
    evidence: { signal, text: brief.slice(start, start + evidenceText.length), start, end: start + evidenceText.length },
    assumption: 'Illustrative prototype-session context; no live external integration is claimed.',
  };
}

test('in-flight commerce exposes opportunities but does not hardcode flight context', () => {
  const value = resolve('Let flight passengers shop in-flight for travel accessories, beauty products, and watches.');
  assert.equal(value.context.contextMode, 'none');
  assert.equal(value.context.decisionOwner, 'deterministic-hint');
  assert.deepEqual(value.context.displayContext, []);
  assert.ok(value.context.opportunities.some((opportunity) => opportunity.kind === 'journey'));
  assert.ok(value.context.opportunities.some((opportunity) => opportunity.kind === 'identity'));
  assert.doesNotMatch(JSON.stringify(value.context), /AI 184|12A|Delivery to your seat/);
  assert.deepEqual(validateContextEnrichment(value.context, { experienceContract: value.experience, briefText: value.brief }).errors, []);
});

test('context opportunities stay generic across representative app families', () => {
  const cases = [
    ['Help learners continue a course and complete the next lesson.', 'progress'],
    ['Let patients book an available appointment at a clinic.', 'time'],
    ['Help technicians complete assigned inspection tasks at a site.', 'place'],
    ['Help customers understand account balances and monthly spending.', 'identity'],
    ['Help support agents reply to messages in their conversation inbox.', 'scope'],
    ['Let a user scan a receipt, capture its details, and submit the result.', 'progress'],
  ];
  for (const [brief, opportunityKind] of cases) {
    const value = resolve(brief);
    assert.equal(value.context.contextMode, 'none', brief);
    assert.ok(value.context.opportunities.some((opportunity) => opportunity.kind === opportunityKind), brief);
    assert.equal(validateContextEnrichment(value.context, { experienceContract: value.experience, briefText: value.brief }).valid, true, brief);
  }
});

test('model-selected flight context validates without shared-code field names', () => {
  const value = resolve('Let flight passengers shop in-flight for travel accessories and watches.');
  const context = selectedContext(value, [
    entry(value.brief, 'journey-reference', 'Flight', 'SK 421', 'journey', 'in-flight'),
    entry(value.brief, 'traveler-position', 'Seat', '18C', 'identity', 'passengers'),
  ], 'active-journey');
  assert.equal(validateContextEnrichment(context, { experienceContract: value.experience, briefText: value.brief }).valid, true);
});

test('domain-fixture context must resolve to the exact bounded fixture value', () => {
  const value = resolve('Let flight passengers shop in-flight for travel accessories and watches.');
  const domainModel = {
    entities: [{ key: 'Session', fields: [{ key: 'id', type: 'id' }, { key: 'reference', type: 'text' }] }],
    relationships: [], choices: [], fixtureScenarios: [],
    fixtures: { Session: [{ id: 'session-current', reference: 'SK 421' }] },
  };
  const fixtureEntry = {
    ...entry(value.brief, 'journey-reference', 'Flight', 'SK 421', 'journey', 'in-flight', 'domain-fixture'),
    sourceBinding: '#/fixtures/Session/0/reference',
  };
  const context = {
    ...selectedContext(value, [fixtureEntry], 'active-journey'),
    fixtureDataSha256: fixtureDataRevision(domainModel),
  };
  assert.equal(validateContextEnrichment(context, { experienceContract: value.experience, briefText: value.brief, domainModel }).valid, true);
  context.displayContext[0].sampleValue = 'AI 184';
  assert.match(validateContextEnrichment(context, { experienceContract: value.experience, briefText: value.brief, domainModel }).errors.join('\n'), /sampleValue does not match its fixture binding/);
});

test('context validation rejects assumption-free, persistent, or fabricated model context', () => {
  const value = resolve('Let flight passengers shop in-flight for travel accessories and watches.');
  const context = selectedContext(value, [entry(value.brief, 'journey-reference', 'Flight', 'SK 421', 'journey', 'in-flight')]);
  context.displayContext[0].assumption = '';
  context.displayContext[0].evidence.text = 'airport';
  context.ephemeralModel.persistence = 'dataverse';
  const errors = validateContextEnrichment(context, { experienceContract: value.experience, briefText: value.brief }).errors.join('\n');
  assert.match(errors, /assumption is required/);
  assert.match(errors, /evidence does not match the confirmed brief/);
  assert.match(errors, /only use prototype-session persistence/);
});

test('ambiguous briefs produce no invented context', () => {
  const value = resolve('Create a useful mobile app for people.');
  assert.equal(value.context.contextMode, 'none');
  assert.deepEqual(value.context.displayContext, []);
  assert.equal(value.context.ephemeralModel, null);
  assert.equal(validateContextEnrichment(value.context, { experienceContract: value.experience, briefText: value.brief }).valid, true);
});