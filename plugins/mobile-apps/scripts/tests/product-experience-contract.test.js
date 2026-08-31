'use strict';

// Tests for validate-product-experience.js — the UX DNA contract.
// Run with: node --test plugins/mobile-apps/scripts/tests/
//
// Two properties matter beyond the field-level rules:
//   1. The validator never maps a domain word to a design decision.
//   2. The validator never supplies a default visual direction for a product with no brand
//      input; whatever personality the approved contract declares is what comes out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { validateExperienceContract } = require('../validate-product-experience');
const {
  EXPERIENCE_DIMENSIONS,
  contractRevision,
  experienceSignature,
} = require('../lib/product-experience-contracts');
const { buildExperience, evidence } = require('./helpers/product-experience-fixtures');
const { bundleFor } = require('./helpers/product-experience-scenarios');
const { SCRIPTS_DIR, cleanup, codes, makeProjectDir, runCli, writeContracts } = require('./helpers/contract-cli');

// ── Shape and revision ───────────────────────────────────────────────────────

test('a complete contract validates and yields a 64-character revision', () => {
  const result = validateExperienceContract(buildExperience());
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
  assert.match(result.revision, /^[0-9a-f]{64}$/);
  assert.match(result.experienceSignature, /^[0-9a-f]{64}$/);
});

test('the revision ignores key insertion order', () => {
  const contract = buildExperience();
  const reordered = Object.fromEntries(Object.entries(contract).reverse());
  assert.strictEqual(contractRevision(reordered), contractRevision(contract));
});

test('the revision changes when any contract value changes', () => {
  const base = buildExperience();
  const changed = buildExperience({ informationDensity: 'dense' });
  assert.notStrictEqual(contractRevision(changed), contractRevision(base));
});

test('an unknown property is rejected by the schema', () => {
  const result = validateExperienceContract(buildExperience({ industryPreset: 'anything' }));
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.message.includes('unknown property')));
  assert.strictEqual(result.revision, null);
});

test('a missing required dimension is rejected', () => {
  const result = validateExperienceContract(buildExperience({ interactionTempo: undefined }));
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.message.includes('/interactionTempo: is required')));
});

// ── Evidence and confidence ──────────────────────────────────────────────────

test('a dimension with neither prompt evidence nor an assumption is rejected', () => {
  const contract = buildExperience();
  delete contract.promptEvidence.operatingContext;
  const result = validateExperienceContract(contract);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('unevidenced-dimension'));
});

test('a recorded assumption substitutes for prompt evidence', () => {
  const contract = buildExperience({
    assumptions: [{
      dimension: 'operatingContext',
      statement: 'Assumed indoor use because the brief never described where the work happens',
      classification: 'proposed-requires-approval',
    }],
  });
  delete contract.promptEvidence.operatingContext;
  const result = validateExperienceContract(contract);
  assert.deepStrictEqual(result.errors, []);
});

test('offline behavior requires explicit evidence or an approved assumption', () => {
  const unsupported = buildExperience({
    operatingContext: { environment: 'indoor-mobile', connectivity: 'intermittent', interruptionLevel: 'moderate' },
  });
  unsupported.promptEvidence.operatingContext = evidence('the user moves between rooms during the task');
  assert.ok(codes(validateExperienceContract(unsupported)).includes('offline-without-evidence'));

  const approved = buildExperience({
    operatingContext: { environment: 'indoor-mobile', connectivity: 'offline-first', interruptionLevel: 'moderate' },
    sessionPattern: { frequency: 'daily', duration: 'one-to-three-minutes', resumability: 'must-resume' },
    assumptions: [{
      dimension: 'connectivity',
      statement: 'Assume offline-first operation until environment testing confirms network availability',
      classification: 'proposed-requires-approval',
      approved: true,
    }],
  });
  approved.promptEvidence.operatingContext = evidence('the user moves between rooms during the task');
  assert.deepStrictEqual(validateExperienceContract(approved).errors, []);
});

test('a low-confidence dimension without an assumption is rejected', () => {
  const result = validateExperienceContract(buildExperience({
    confidence: { overall: 'medium', byDimension: { collaborationMode: 'low' } },
  }));
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('low-confidence-without-assumption'));
});

test('evidence or confidence keyed to something that is not a dimension is rejected', () => {
  const withBadEvidence = buildExperience();
  withBadEvidence.promptEvidence.industry = evidence('a shop');
  assert.ok(codes(validateExperienceContract(withBadEvidence)).includes('unknown-evidence-dimension'));

  const withBadConfidence = buildExperience({
    confidence: { overall: 'high', byDimension: { vertical: 'high' } },
  });
  assert.ok(codes(validateExperienceContract(withBadConfidence)).includes('unknown-confidence-dimension'));
});

// ── Internal consistency ─────────────────────────────────────────────────────

test('essential media with no types or no capture path is rejected', () => {
  const noTypes = validateExperienceContract(buildExperience({
    mediaStrategy: { necessity: 'essential', types: [], capture: 'sourced', fallback: 'Typographic block' },
  }));
  assert.ok(codes(noTypes).includes('essential-media-without-types'));

  const noSource = validateExperienceContract(buildExperience({
    mediaStrategy: { necessity: 'essential', types: ['photo'], capture: 'none', fallback: 'Typographic block' },
  }));
  assert.ok(codes(noSource).includes('essential-media-without-source'));
});

test('media types declared while media is unnecessary are rejected', () => {
  const result = validateExperienceContract(buildExperience({
    mediaStrategy: { necessity: 'none', types: ['photo'], capture: 'none', fallback: 'No media is shown' },
  }));
  assert.ok(codes(result).includes('media-types-without-necessity'));
});

test('a first viewport without a primary action or focal content is rejected', () => {
  const noAction = validateExperienceContract(buildExperience({
    firstViewport: {
      focalQuestion: 'What is going on?',
      regionOrder: ['context', 'focal-content', 'supporting-content'],
      primaryAction: 'Continue',
    },
  }));
  assert.ok(codes(noAction).includes('first-viewport-without-primary-action'));

  const noFocus = validateExperienceContract(buildExperience({
    firstViewport: {
      focalQuestion: 'What is going on?',
      regionOrder: ['context', 'navigation', 'primary-action'],
      primaryAction: 'Continue',
    },
  }));
  assert.ok(codes(noFocus).includes('first-viewport-without-focal-content'));
});

test('a visual rationale that only restates a domain word is rejected', () => {
  const result = validateExperienceContract(buildExperience({
    domainVocabulary: ['veterinary practice management'],
    visualPersonality: {
      tone: 'warm',
      expressiveness: 'moderate',
      rationale: 'Veterinary practice management',
    },
  }));
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('domain-label-as-design-rationale'));
});

test('a signature experience that does not explain itself is rejected', () => {
  const result = validateExperienceContract(buildExperience({
    domainVocabulary: ['dispatch board and rota'],
    signatureExperience: {
      name: 'Dispatch board',
      description: 'A board of the things that are currently dispatched to someone on the team.',
      whyNotGeneric: 'Dispatch board and rota',
    },
  }));
  assert.ok(codes(result).includes('signature-experience-not-justified'));
});

test('reference-derived contracts must declare their reference', () => {
  const missingDetail = validateExperienceContract(buildExperience({ source: 'reference-override' }));
  assert.ok(codes(missingDetail).includes('reference-override-without-detail'));

  const undeclared = validateExperienceContract(buildExperience({
    referenceOverride: { fidelity: 'high', preservationIntent: ['Keep the two-column rhythm'] },
  }));
  assert.ok(codes(undeclared).includes('reference-detail-without-source'));
});

test('a demanding operating context without matching accessibility is a warning, not a rejection', () => {
  const result = validateExperienceContract(buildExperience({
    operatingContext: { environment: 'field-outdoor', connectivity: 'intermittent', interruptionLevel: 'high' },
    accessibilityPriorities: ['screen-reader-first'],
  }));
  assert.strictEqual(result.ok, true);
  assert.ok(result.warnings.some((entry) => entry.code === 'context-accessibility-gap'));
});

// ── No industry-to-design mapping ────────────────────────────────────────────

test('two products from unrelated domains with the same dimensions share one experience signature', () => {
  // Same semantic experience, completely different vocabulary and free text. If any rule keyed
  // design off the domain, these two would diverge.
  const dimensions = {
    primaryIntent: 'capture',
    workflowShape: 'queue-driven',
    informationDensity: 'dense',
    interactionTempo: 'rapid',
    contentEmphasis: { primary: 'status-signals', secondary: [] },
  };
  const first = buildExperience({
    productName: 'Storefront Restock',
    domainVocabulary: ['shelf', 'restock', 'store'],
    primaryGoal: 'Keep every shelf stocked before the morning rush begins',
    ...dimensions,
  });
  const second = buildExperience({
    productName: 'GraftRound',
    domainVocabulary: ['graft', 'cell bar', 'apiary'],
    primaryGoal: 'Keep every grafting round checked before the cells are capped',
    ...dimensions,
  });

  assert.strictEqual(validateExperienceContract(first).ok, true);
  assert.strictEqual(validateExperienceContract(second).ok, true);
  assert.strictEqual(experienceSignature(first), experienceSignature(second));
  assert.notStrictEqual(contractRevision(first), contractRevision(second));
});

test('a change to a semantic dimension does change the experience signature', () => {
  const base = buildExperience();
  assert.notStrictEqual(experienceSignature(buildExperience({ informationDensity: 'dense' })), experienceSignature(base));
  assert.notStrictEqual(
    experienceSignature(buildExperience({ visualPersonality: { tone: 'playful', expressiveness: 'expressive', rationale: 'The audience is casual and the stakes are low, so the surface can be loud.' } })),
    experienceSignature(base),
  );
});

test('nine unrelated domains are treated identically: each validates on its own declared dimensions', () => {
  const keys = ['commerce', 'inspection', 'scheduling', 'finance', 'learning', 'community', 'analytics', 'logistics', 'niche'];
  const signatures = new Map();
  for (const key of keys) {
    const { experience } = bundleFor(key);
    const result = validateExperienceContract(experience);
    assert.deepStrictEqual(result.errors, [], `${key} produced errors`);
    // The directive is a projection of what the contract declared — nothing more.
    assert.strictEqual(result.experienceDirective.tone, experience.visualPersonality.tone);
    assert.strictEqual(result.experienceDirective.density, experience.informationDensity);
    assert.strictEqual(result.experienceDirective.emphasis, experience.contentEmphasis.primary);
    signatures.set(key, result.experienceSignature);
  }
  // Nine genuinely different products must not collapse onto one treatment.
  assert.strictEqual(new Set(signatures.values()).size, keys.length);
});

test('a brief-only product with no brand input receives no default visual direction', () => {
  const { experience } = bundleFor('community');
  assert.strictEqual(experience.source, 'brief');
  const result = validateExperienceContract(experience);
  assert.strictEqual(result.ok, true);

  // No preset, no direction file, no styling default is invented anywhere in the output.
  const serialized = JSON.stringify(result).toLowerCase();
  for (const forbidden of ['polished', 'direction-', 'designdirection', 'preset', 'theme:', 'palette']) {
    assert.ok(!serialized.includes(forbidden), `validator output leaked a design default: ${forbidden}`);
  }
  assert.strictEqual(result.experienceDirective.tone, 'playful');
  assert.strictEqual(result.experienceDirective.expressiveness, 'expressive');
});

test('the compiler sources contain no industry keyword table and no styling default', () => {
  const sources = [
    'lib/json-schema-lite.js',
    'lib/product-experience-contracts.js',
    'lib/product-experience-rules.js',
    'lib/product-scope-rules.js',
    'lib/product-composition-rules.js',
    'validate-product-experience.js',
    'validate-product-scope.js',
    'validate-workflow-journey.js',
    'compile-screen-build-pack.js',
    'schema-product-experience-contract.json',
    'schema-product-scope-contract.json',
    'schema-workflow-journey-contract.json',
    'schema-screen-build-pack.json',
  ];
  // Words that would only appear if a rule were keyed on what the product sells rather than on
  // how it is used, plus the names of the pre-existing design directions.
  const industryWords = /\b(retail|shopping|ecommerce|e-commerce|healthcare|patient|clinic|banking|invoice|logistics|courier|hospitality|restaurant|classroom|manufactur\w*|realestate|insurance)\b/i;
  const stylingDefaults = /\b(polished|direction-\w+|defaultdirection|fallbackpalette)\b/i;

  for (const relative of sources) {
    const contents = fs.readFileSync(path.join(SCRIPTS_DIR, relative), 'utf8');
    assert.strictEqual(industryWords.test(contents), false, `${relative} references an industry vertical`);
    assert.strictEqual(stylingDefaults.test(contents), false, `${relative} carries a styling default`);
  }
});

test('every declared dimension is covered by the dimension list the rules use', () => {
  const contract = buildExperience();
  for (const dimension of EXPERIENCE_DIMENSIONS) {
    assert.ok(Object.prototype.hasOwnProperty.call(contract, dimension), `${dimension} missing from a valid contract`);
  }
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test('CLI exits 0 with JSON for a valid contract and 1 for a rejected one', () => {
  const projectRoot = makeProjectDir('experience-cli');
  try {
    const { experience } = bundleFor('scheduling');
    writeContracts(projectRoot, { experience });

    const ok = runCli('validate-product-experience.js', ['--project-root', projectRoot]);
    assert.strictEqual(ok.code, 0);
    assert.strictEqual(ok.json.ok, true);
    assert.match(ok.json.revision, /^[0-9a-f]{64}$/);

    const broken = { ...experience, informationDensity: 'extremely-dense' };
    writeContracts(projectRoot, { experience: broken });
    const rejected = runCli('validate-product-experience.js', ['--project-root', projectRoot]);
    assert.strictEqual(rejected.code, 1);
    assert.strictEqual(rejected.json.ok, false);
    assert.strictEqual(rejected.json.revision, null);
  } finally {
    cleanup(projectRoot);
  }
});

test('CLI exits 2 with JSON for a missing file or an unknown flag', () => {
  const projectRoot = makeProjectDir('experience-cli-fatal');
  try {
    const missing = runCli('validate-product-experience.js', ['--project-root', projectRoot]);
    assert.strictEqual(missing.code, 2);
    assert.strictEqual(missing.json.fatal, true);

    const badFlag = runCli('validate-product-experience.js', ['--project-root', projectRoot, '--verbose']);
    assert.strictEqual(badFlag.code, 2);
    assert.ok(badFlag.json.errors[0].message.includes('unknown argument'));
  } finally {
    cleanup(projectRoot);
  }
});

test('CLI accepts an explicit contract path', () => {
  const projectRoot = makeProjectDir('experience-cli-path');
  try {
    const { experience } = bundleFor('niche');
    const files = writeContracts(projectRoot, { experience });
    const result = runCli('validate-product-experience.js', ['--contract', files.experience]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.json.contractPath, files.experience);
  } finally {
    cleanup(projectRoot);
  }
});
