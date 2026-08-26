'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveExperienceFromBrief } = require('../experience-patterns');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { validateContextEnrichment } = require('../validate-context-enrichment');

function resolve(brief) {
  const experience = deriveExperienceFromBrief(brief);
  const context = resolveContextEnrichment(brief, experience);
  return { brief, experience, context };
}

test('in-flight commerce resolves realistic ephemeral journey context', () => {
  const value = resolve('Let flight passengers shop in-flight for travel accessories, beauty products, and watches.');
  assert.equal(value.context.contextMode, 'active-journey');
  assert.deepEqual(value.context.displayContext.map((entry) => entry.id), ['flight-number', 'seat-number', 'connectivity', 'fulfilment-mode']);
  assert.equal(value.context.ephemeralModel.persistence, 'prototype-session');
  assert.match(value.context.forbiddenInferences.join('\n'), /Do not claim live airline integration/);
  assert.deepEqual(validateContextEnrichment(value.context, { experienceContract: value.experience, briefText: value.brief }).errors, []);
});

test('job-based contexts stay generic across representative app families', () => {
  const cases = [
    ['Help learners continue a course and complete the next lesson.', 'learning-progress'],
    ['Let patients book an available appointment at a clinic.', 'availability-context'],
    ['Help technicians complete assigned inspection tasks at a site.', 'active-assignment'],
    ['Help customers understand account balances and monthly spending.', 'financial-period'],
    ['Help support agents reply to messages in their conversation inbox.', 'workspace-presence'],
    ['Let a user scan a receipt, capture its details, and submit the result.', 'capture-session'],
  ];
  for (const [brief, mode] of cases) {
    const value = resolve(brief);
    assert.equal(value.context.contextMode, mode, brief);
    assert.equal(validateContextEnrichment(value.context, { experienceContract: value.experience, briefText: value.brief }).valid, true, brief);
  }
});

test('context validation rejects assumption-free, persistent, or fabricated evidence', () => {
  const value = resolve('Let flight passengers shop in-flight for travel accessories and watches.');
  value.context.displayContext[0].assumption = '';
  value.context.displayContext[1].evidence.text = 'airport';
  value.context.ephemeralModel.persistence = 'dataverse';
  const errors = validateContextEnrichment(value.context, { experienceContract: value.experience, briefText: value.brief }).errors.join('\n');
  assert.match(errors, /assumption is required/);
  assert.match(errors, /evidence does not match the confirmed brief/);
  assert.match(errors, /only use prototype-session persistence/);
  assert.match(errors, /does not match deterministic evidence-bound foreground resolution/);
});

test('context validation rejects conflicting values and unsupported inferred additions', () => {
  const value = resolve('Let flight passengers shop in-flight for travel accessories and watches.');
  value.context.displayContext[0].sampleValue = 'BA 999';
  value.context.displayContext.push({
    ...value.context.displayContext[0],
    id: 'live-payment',
    label: 'Payment',
    sampleValue: 'Card authorized',
  });
  const errors = validateContextEnrichment(value.context, { experienceContract: value.experience, briefText: value.brief }).errors.join('\n');
  assert.match(errors, /does not match deterministic evidence-bound foreground resolution/);
});

test('ambiguous briefs produce no invented context', () => {
  const value = resolve('Create a useful mobile app for people.');
  assert.equal(value.context.contextMode, 'none');
  assert.deepEqual(value.context.displayContext, []);
  assert.equal(value.context.ephemeralModel, null);
  assert.equal(validateContextEnrichment(value.context, { experienceContract: value.experience, briefText: value.brief }).valid, true);
});