'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveExperienceFromBrief, validateExperienceContract } = require('../experience-patterns');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { validateContextEnrichment } = require('../validate-context-enrichment');

const BENCHMARKS = [
  {
    name: 'flight commerce',
    brief: 'Create a mobile app for flight passengers to shop in-flight for travel accessories, beauty products, and watches.',
    options: { mediaPolicy: 'remote-cdn-cached' },
    expected: {
      audience: 'consumer', primarySurface: 'product-led-discovery', entryMode: 'discovery', navigationModel: 'tabs-stack',
      mediaPolicy: 'remote-cdn-cached', compositionFamily: 'product-led-discovery', contextMode: 'active-journey',
      contextIds: ['flight-number', 'seat-number', 'connectivity', 'fulfilment-mode'],
    },
  },
  {
    name: 'employee workflow',
    brief: 'Help field technicians complete assigned inspection tasks at a site and stay ready offline.',
    expected: {
      audience: 'employee', primarySurface: 'task-led-workflow', entryMode: 'workflow', navigationModel: 'stack',
      mediaPolicy: 'not-applicable', compositionFamily: 'next-action-workflow', contextMode: 'active-assignment',
      contextIds: ['shift', 'assignment', 'site', 'offline-readiness'],
    },
  },
  {
    name: 'booking',
    brief: 'Let patients find and book an available clinic appointment.',
    expected: {
      audience: 'consumer', primarySurface: 'availability-led-discovery', entryMode: 'discovery', navigationModel: 'stack',
      mediaPolicy: 'not-applicable', compositionFamily: 'availability-led-choice', contextMode: 'availability-context',
      contextIds: ['location', 'service', 'date-time', 'availability'],
    },
  },
  {
    name: 'learning',
    brief: 'Help learners continue a course, complete the next lesson, and see progress.',
    expected: {
      audience: 'consumer', primarySurface: 'learning-journey', entryMode: 'workflow', navigationModel: 'stack',
      mediaPolicy: 'remote-cdn-cached', compositionFamily: 'progress-journey', contextMode: 'learning-progress',
      contextIds: ['course', 'current-lesson', 'progress', 'next-milestone'],
    },
  },
  {
    name: 'capture',
    brief: 'Let inspectors capture site photos, record findings, and submit an inspection.',
    expected: {
      audience: 'mixed', primarySurface: 'capture-led-utility', entryMode: 'capture', navigationModel: 'stack',
      mediaPolicy: 'local-first', compositionFamily: 'capture-led-utility', contextMode: 'capture-session',
      contextIds: ['site', 'assignment', 'capture-status', 'sync-state'],
    },
  },
];

test('representative briefs resolve distinct evidence-bound experience, composition, and context contracts', () => {
  const compositionFamilies = new Set();
  const signatures = new Set();
  for (const benchmark of BENCHMARKS) {
    const experience = deriveExperienceFromBrief(benchmark.brief, benchmark.options);
    const context = resolveContextEnrichment(benchmark.brief, experience);
    assert.deepEqual(validateExperienceContract(experience), [], benchmark.name);
    assert.deepEqual(validateContextEnrichment(context, { experienceContract: experience, briefText: benchmark.brief }).errors, [], benchmark.name);
    assert.deepEqual({
      audience: experience.audience,
      primarySurface: experience.primarySurface,
      entryMode: experience.entryMode,
      navigationModel: experience.navigationModel,
      mediaPolicy: experience.assetPolicy.media,
      compositionFamily: experience.visualCompositionIntent.compositionFamily,
      contextMode: context.contextMode,
      contextIds: context.displayContext.map((entry) => entry.id),
    }, benchmark.expected, benchmark.name);
    assert.equal(experience.visualCompositionIntent.signatureComponent.required, true, benchmark.name);
    assert.match(experience.visualCompositionIntent.signatureComponent.testId, /^experience-signature-/, benchmark.name);
    assert.equal(experience.visualCompositionIntent.nextContentVisible, true, benchmark.name);
    assert.ok(experience.visualCompositionIntent.maxFeatureViewportShare <= 0.42, benchmark.name);
    assert.equal(context.ephemeralModel?.persistence, 'prototype-session', benchmark.name);
    assert.equal(context.displayContext.every((entry) => entry.source === 'inferred-prototype-fixture' && entry.assumption.length >= 10), true, benchmark.name);
    compositionFamilies.add(experience.visualCompositionIntent.compositionFamily);
    signatures.add(experience.visualCompositionIntent.signatureComponent.testId);
  }
  assert.equal(compositionFamilies.size, BENCHMARKS.length);
  assert.equal(signatures.size, BENCHMARKS.length);
});

test('flight-commerce benchmark stays product-led and excludes airline-operations invention', () => {
  const benchmark = BENCHMARKS[0];
  const experience = deriveExperienceFromBrief(benchmark.brief, benchmark.options);
  const context = resolveContextEnrichment(benchmark.brief, experience);
  assert.deepEqual(context.displayContext.map((entry) => entry.sampleValue), ['AI 184', '12A', 'Catalog available offline', 'Delivery to your seat']);
  assert.match(context.forbiddenInferences.join('\n'), /Do not claim live airline integration/);
  assert.match(context.forbiddenInferences.join('\n'), /Do not add booking, check-in, seat-management, or payment/);
  assert.equal(experience.forbiddenDefaults.includes('warehouse-operations'), true);
  assert.equal(experience.forbiddenDefaults.includes('airline-operations'), true);
  assert.doesNotMatch(`${experience.primaryJob} ${experience.firstViewport.focalPoint}`, /warehouse|pallet|airline[- ]operations/i);
});