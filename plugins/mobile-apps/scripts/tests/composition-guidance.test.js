'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { COMPOSITION_PROFILES, deriveCompositionGuidance } = require('../compile-screen-build-pack');
const { deriveExperienceFromBrief } = require('../experience-patterns');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { resolveWorkflowJourney } = require('../resolve-workflow-journey');

const exactPrompts = {
  flight: 'Create a mobile app for showcasing inventory items to flight passengers. This app will be used in flight for selling travel accessories, beauty products and watches. The app should have clean aesthetics, should be accessible and easy to use.',
  gym: 'Create an app for maintining and auditing equipment at gym user should be able to get maintence records of equipment by scanning a qr code, the company owns multiple gyms, the app should support tracking issues, on going repairs, upcoming maintennce and warranty for equipments',
};

function contracts(brief) {
  const experience = deriveExperienceFromBrief(brief);
  const context = resolveContextEnrichment(brief, experience);
  const journey = resolveWorkflowJourney(brief, experience, context);
  return { experience, journey };
}

function screen(overrides = {}) {
  return {
    id: 'Home',
    role: 'primary',
    navigation: { role: 'durable-destination' },
    presentation: { pattern: 'guided-flow', density: 'balanced' },
    ...overrides,
  };
}

test('exact flight and gym prompts select different domain-neutral composition profiles', () => {
  const flight = contracts(exactPrompts.flight);
  const gym = contracts(exactPrompts.gym);
  const flightGuidance = deriveCompositionGuidance(screen(), flight.experience, flight.journey);
  const gymGuidance = deriveCompositionGuidance(screen(), gym.experience, gym.journey);
  assert.equal(flightGuidance.profile, 'discovery-merchandising');
  assert.deepEqual(flightGuidance.recommendedRecipes, ['FeatureCard', 'CategoryTile', 'ProductCard']);
  assert.equal(gymGuidance.profile, 'priority-workspace');
  assert.deepEqual(gymGuidance.recommendedRecipes, ['StatusSummary', 'FeatureCard', 'RecordRow']);
  assert.notDeepEqual(flightGuidance.structuralRoles, gymGuidance.structuralRoles);
});

test('supporting screens derive queue, work-step, and confirmation structure without domain keywords', () => {
  const experience = deriveExperienceFromBrief('Staff complete ordered work, review it, and confirm the result.');
  const journey = {
    stages: [
      { id: 'start', label: 'Start', order: 1, screenIds: ['Queue'] },
      { id: 'work', label: 'Work', order: 2, screenIds: ['WorkStep'] },
      { id: 'finish', label: 'Finish', order: 3, screenIds: ['Confirmation'] },
    ],
  };
  const queue = deriveCompositionGuidance(screen({
    id: 'Queue', role: 'supporting', navigation: { role: 'durable-destination' }, presentation: { pattern: 'compact-list', density: 'dense' },
  }), experience, { stages: [] });
  const work = deriveCompositionGuidance(screen({
    id: 'WorkStep', role: 'key-flow', navigation: { role: 'bounded-flow-step' }, presentation: { pattern: 'form', density: 'balanced' },
  }), experience, journey);
  const confirmation = deriveCompositionGuidance(screen({
    id: 'Confirmation', role: 'supporting', navigation: { role: 'bounded-flow-step' }, presentation: { pattern: 'form', density: 'balanced' },
  }), experience, journey);
  assert.equal(queue.profile, 'operational-queue');
  assert.deepEqual(queue.structuralRoles, ['queue-context', 'filter-controls', 'grouped-record-collection', 'record-status-metadata']);
  assert.equal(work.profile, 'guided-work-step');
  assert.deepEqual(work.interactionPatterns, ['grouped-work-inputs', 'exception-callout', 'persistent-actions']);
  assert.equal(confirmation.profile, 'review-confirmation');
  assert.deepEqual(confirmation.interactionPatterns, ['segmented-decision', 'evidence-section', 'confirmation-summary']);
});

test('unseen product surfaces select distinct profiles with deterministic output', () => {
  const cases = [
    ['Let patients find an available appointment and choose a suitable time slot.', 'availability-discovery'],
    ['Help learners continue a course, finish the next lesson, and see meaningful progress.', 'learning-continuation'],
    ['Help support staff handle the customer conversation requiring attention in their inbox.', 'conversation-attention'],
    ['Let creators publish updates and help readers discover fresh media content.', 'content-feed'],
    ['Help a person understand balances, recent spending, and the next financial decision.', 'attention-led-overview'],
    ['Let a user scan a receipt, capture its details, and submit the result.', 'focused-capture'],
  ];
  for (const [brief, expectedProfile] of cases) {
    const { experience, journey } = contracts(brief);
    const first = deriveCompositionGuidance(screen(), experience, journey);
    const second = deriveCompositionGuidance(screen(), structuredClone(experience), structuredClone(journey));
    assert.equal(first.profile, expectedProfile, brief);
    assert.deepEqual(first, second, brief);
  }
});

test('composition policy contains no benchmark-domain vocabulary and remains advisory', () => {
  const serialized = JSON.stringify(COMPOSITION_PROFILES).toLowerCase();
  for (const forbidden of ['airline', 'airplane', 'flight', 'gym', 'warehouse', 'receiving', 'shipment', 'equipment']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
  for (const profile of Object.values(COMPOSITION_PROFILES)) {
    assert.ok(profile.structuralRoles.length >= 2);
    assert.ok(profile.interactionPatterns.length >= 1);
  }
  const { experience, journey } = contracts('Build a simple guided app that helps a person take the next useful step.');
  const guidance = deriveCompositionGuidance(screen(), experience, journey);
  assert.equal(guidance.enforcement, 'advisory-with-structural-baseline');
  assert.equal(guidance.equivalentImplementationsAllowed, true);
  assert.equal(guidance.absencePolicy, 'fall-back-to-screen-contract-and-domain-layout-decisions');
});
