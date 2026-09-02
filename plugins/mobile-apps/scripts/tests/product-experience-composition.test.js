'use strict';

// Tests for validate-workflow-journey.js and compile-screen-build-pack.js.
// Run with: node --test plugins/mobile-apps/scripts/tests/
//
// These cover the composition gate: the approved journey must survive into the build packs,
// the packs must bind to the exact contracts they were compiled from, and a set of packs that
// is one composition repeated per record type must be rejected before anything is generated.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { validateJourneyContract } = require('../validate-workflow-journey');
const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const {
  canonicalJson,
  contractRevision,
  sha256Hex,
} = require('../lib/product-experience-contracts');
const { buildBuildPack, buildJourney, clone } = require('./helpers/product-experience-fixtures');
const { bundleFor } = require('./helpers/product-experience-scenarios');
const { cleanup, codes, makeProjectDir, runCli, writeContracts } = require('./helpers/contract-cli');

const ALL_SCENARIOS = ['commerce', 'inspection', 'scheduling', 'finance', 'learning', 'community', 'analytics', 'logistics', 'niche'];

function compile(bundle) {
  return compileScreenBuildPack(bundle.buildPack, bundle);
}

// ── Journeys across unrelated domains ────────────────────────────────────────

test('every scenario journey validates against its own scope and experience', () => {
  for (const key of ALL_SCENARIOS) {
    const bundle = bundleFor(key);
    const result = validateJourneyContract(bundle.journey, bundle);
    assert.deepStrictEqual(result.errors, [], `${key} journey produced errors`);
    assert.strictEqual(result.summary.journeyCount, 1);
  }
});

test('the commerce journey survives as five ordered steps, not as list/detail/form routes', () => {
  const bundle = bundleFor('commerce');
  const result = validateJourneyContract(bundle.journey, bundle);
  assert.deepStrictEqual(result.errors, []);

  const [journey] = bundle.journey.journeys;
  assert.deepStrictEqual(
    journey.steps.map((step) => step.surface.screenId),
    ['discover', 'product', 'cart', 'checkout', 'confirmation'],
  );
  assert.deepStrictEqual(journey.steps.map((step) => step.order), [1, 2, 3, 4, 5]);

  // The compiled screen order follows the journey, and the compositions are not the generic
  // record family repeated five times.
  const compiled = compile(bundle).compiled;
  assert.deepStrictEqual(
    compiled.screens.map((entry) => entry.screenId),
    ['discover', 'product', 'cart', 'checkout', 'confirmation'],
  );
  assert.strictEqual(new Set(compiled.screens.map((entry) => entry.pack.composition.kind)).size, 5);
});

test('a journey that skips a critical step of its job is rejected', () => {
  const bundle = bundleFor('commerce');
  const journey = clone(bundle.journey);
  // Drop the cart step: the shopper can no longer review what they are buying.
  journey.journeys[0].steps = journey.journeys[0].steps
    .filter((step) => step.id !== 'review-cart')
    .map((step, index) => ({ ...step, order: index + 1 }));

  const result = validateJourneyContract(journey, bundle);
  assert.strictEqual(result.ok, false);
  const missing = result.errors.find((entry) => entry.code === 'missing-critical-journey-step');
  assert.ok(missing, 'expected the dropped step to be reported');
  assert.ok(missing.message.includes('review-cart'));
});

test('a core job with no journey at all is rejected', () => {
  const bundle = bundleFor('finance');
  // Add a second critical job served by a section of an existing screen, then leave it out of
  // the journey contract entirely.
  const scope = clone(bundle.scope);
  scope.coreJobs.push({
    id: 'reconcile-disputes',
    statement: 'As an approver I want to reconcile a disputed claim against the original evidence',
    actor: 'Approving manager',
    outcome: 'The dispute is resolved with a recorded reason',
    criticality: 'critical',
    surface: { kind: 'section', screenId: 'claim', detail: 'A dispute section within the claim surface' },
    criticalSteps: ['open-dispute', 'resolve-dispute'],
  });
  const journey = buildJourney(bundle.experience, scope, { journeys: clone(bundle.journey.journeys) });

  const result = validateJourneyContract(journey, { experience: bundle.experience, scope });
  assert.strictEqual(result.ok, false);
  const missing = result.errors.find((entry) => entry.code === 'missing-critical-journey');
  assert.ok(missing);
  assert.ok(missing.message.includes('reconcile-disputes'));
});

test('journey steps must be contiguous and must land on screens that exist', () => {
  const bundle = bundleFor('scheduling');

  const misordered = clone(bundle.journey);
  misordered.journeys[0].steps[2].order = 9;
  assert.ok(codes(validateJourneyContract(misordered, bundle)).includes('journey-step-order'));

  const nowhere = clone(bundle.journey);
  nowhere.journeys[0].steps[1].surface.screenId = 'ghost-screen';
  assert.ok(codes(validateJourneyContract(nowhere, bundle)).includes('journey-step-unknown-screen'));
});

test('a journey step may be hosted on a sheet or a section instead of its own screen', () => {
  const bundle = bundleFor('community');
  const journey = clone(bundle.journey);
  journey.journeys[0].steps[1].surface = { kind: 'sheet', screenId: 'feed', detail: 'Opened as a sheet over the feed' };
  const result = validateJourneyContract(journey, bundle);
  assert.deepStrictEqual(result.errors, []);
});

test('writing data classified as sample or unapproved is rejected in a journey step', () => {
  const bundle = bundleFor('logistics');
  const journey = clone(bundle.journey);
  journey.journeys[0].steps[2].dataOperation = {
    kind: 'create',
    entity: 'Delivery stop',
    classification: 'proposed-requires-approval',
  };
  const result = validateJourneyContract(journey, bundle);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('unsupported-production-assumption'));
});

test('reading or externally calling unapproved data is also rejected', () => {
  for (const kind of ['read', 'external-call']) {
    const bundle = bundleFor('logistics');
    const journey = clone(bundle.journey);
    journey.journeys[0].steps[0].dataOperation = {
      kind,
      entity: 'Unapproved source',
      classification: 'proposed-requires-approval',
    };
    const result = validateJourneyContract(journey, { experience: bundle.experience, scope: bundle.scope });
    assert.strictEqual(result.ok, false, `${kind} unexpectedly accepted unapproved data`);
    assert.ok(codes(result).includes('unsupported-production-assumption'));
  }
});

test('the journey binds to the experience and scope revisions it was derived from', () => {
  const bundle = bundleFor('niche');
  const journey = clone(bundle.journey);
  journey.scopeRevision = 'a'.repeat(64);
  const result = validateJourneyContract(journey, bundle);
  assert.ok(codes(result).includes('stale-contract-binding'));
});

// ── Build packs and compilation ──────────────────────────────────────────────

test('every scenario compiles to a deterministic artifact bound to all three upstream contracts', () => {
  for (const key of ALL_SCENARIOS) {
    const bundle = bundleFor(key);
    const result = compile(bundle);
    assert.deepStrictEqual(result.errors, [], `${key} build packs produced errors`);

    const compiled = result.compiled;
    assert.strictEqual(compiled.experienceRevision, contractRevision(bundle.experience));
    assert.strictEqual(compiled.scopeRevision, contractRevision(bundle.scope));
    assert.strictEqual(compiled.journeyRevision, contractRevision(bundle.journey));
    assert.match(compiled.compiledRevision, /^[0-9a-f]{64}$/);

    // Compilation is pure: no timestamps, no environment, no ordering drift.
    const again = compile(bundleFor(key)).compiled;
    assert.strictEqual(again.compiledRevision, compiled.compiledRevision, `${key} compilation is not deterministic`);
  }
});

test('compiled revision matches the persisted JSON when an optional route is absent', () => {
  const bundle = bundleFor('community');
  const screenId = bundle.scope.screens[0].id;
  delete bundle.scope.screens[0].route;
  const pack = bundle.buildPack.packs.find((candidate) => candidate.screenId === screenId);
  delete pack.route;
  bundle.journey.scopeRevision = contractRevision(bundle.scope);
  bundle.buildPack.scopeRevision = contractRevision(bundle.scope);
  bundle.buildPack.journeyRevision = contractRevision(bundle.journey);

  const compiled = compile(bundle).compiled;
  const persisted = JSON.parse(JSON.stringify(compiled));
  const revision = persisted.compiledRevision;
  delete persisted.compiledRevision;

  assert.strictEqual(
    revision,
    sha256Hex(canonicalJson(persisted)),
    'compiledRevision must hash the same JSON shape that is written to disk',
  );
});

test('compiled output carries the journey steps that each screen hosts', () => {
  const compiled = compile(bundleFor('inspection')).compiled;
  const defect = compiled.screens.find((entry) => entry.screenId === 'defect');
  assert.strictEqual(defect.journeySteps.length, 1);
  assert.strictEqual(defect.journeySteps[0].stepId, 'capture-defect');
  assert.deepStrictEqual(defect.journeySteps[0].satisfies, ['capture-defect']);
});

test('compiled output carries canonical screen classification and navigation shell', () => {
  const bundle = bundleFor('inspection');
  const compiled = compile(bundle).compiled;
  for (const entry of compiled.screens) {
    const scoped = bundle.scope.screens.find((screen) => screen.id === entry.screenId);
    assert.strictEqual(entry.classification, scoped.classification);
    assert.strictEqual(entry.parentScreenId, scoped.parentScreenId || null);
    assert.strictEqual(entry.navigationShell.pattern, bundle.scope.navigation.pattern);
    assert.strictEqual(entry.navigationShell.headerMode,
      scoped.classification === 'durable-destination' ? 'root' : 'back');
    assert.strictEqual(entry.navigationShell.safeAreaBottomRole,
      entry.navigationShell.tabVisible ? 'tab-bar' : 'screen');
    assert.equal(entry.implementationContract.testIds.screen, `screen-${entry.screenId}`);
    assert.equal(
      entry.implementationContract.primaryActionLabel,
      entry.pack.firstViewport.primaryAction,
    );
    assert.deepEqual(
      entry.implementationContract.routeParams,
      [...String(entry.route || '').matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]),
    );
  }
});

test('compiled output preserves human-first identity, chrome, and media realization', () => {
  const bundle = bundleFor('commerce');
  const compiled = compile(bundle).compiled;
  for (const entry of compiled.screens) {
    assert.equal(entry.pack.identityHierarchy.primary, entry.pack.hierarchy.dominant);
    assert.ok(['root', 'back', 'modal', 'immersive'].includes(entry.pack.chrome.role));
    assert.ok(entry.pack.chrome.navigationTitle);
    if (entry.pack.media.role !== 'none') {
      assert.match(entry.pack.media.assetKeyOrFieldBinding, /^(asset|field):/);
      assert.ok(entry.pack.media.aspectRatio > 0);
      assert.ok(['cover', 'contain'].includes(entry.pack.media.fit));
      assert.ok(['center', 'top', 'subject-defined'].includes(entry.pack.media.focalPoint));
      assert.equal(typeof entry.pack.media.firstViewport, 'boolean');
    }
  }
});

test('screen packs reject missing identity and incomplete media realization', () => {
  const bundle = bundleFor('commerce');
  const noIdentity = clone(bundle.buildPack);
  delete noIdentity.packs[0].identityHierarchy;
  assert.ok(codes(compileScreenBuildPack(noIdentity, bundle)).includes('schema'));

  const incompleteMedia = clone(bundle.buildPack);
  delete incompleteMedia.packs[0].media.assetKeyOrFieldBinding;
  assert.ok(codes(compileScreenBuildPack(incompleteMedia, bundle)).includes('media-realization-incomplete'));
});

test('a user-facing screen with no build pack is rejected', () => {
  const bundle = bundleFor('learning');
  const buildPack = clone(bundle.buildPack);
  buildPack.packs = buildPack.packs.filter((pack) => pack.screenId !== 'check');
  const result = compileScreenBuildPack(buildPack, bundle);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('missing-build-pack'));
  assert.ok(codes(result).includes('missing-journey-step-build-pack'));
  assert.strictEqual(result.compiled, null);
});

test('a build pack for a screen outside the approved scope is rejected', () => {
  const bundle = bundleFor('learning');
  const buildPack = clone(bundle.buildPack);
  buildPack.packs.push({ ...clone(buildPack.packs[0]), screenId: 'not-in-scope' });
  assert.ok(codes(compileScreenBuildPack(buildPack, bundle)).includes('unknown-screen'));
});

test('a first viewport without a primary action or focal content is rejected', () => {
  const bundle = bundleFor('scheduling');

  const noAction = clone(bundle.buildPack);
  noAction.packs[0].firstViewport.regionOrder = ['context', 'focal-content', 'supporting-content'];
  assert.ok(codes(compileScreenBuildPack(noAction, bundle)).includes('build-pack-without-primary-action'));

  const noFocus = clone(bundle.buildPack);
  noFocus.packs[0].firstViewport.regionOrder = ['context', 'primary-action', 'supporting-content'];
  assert.ok(codes(compileScreenBuildPack(noFocus, bundle)).includes('build-pack-without-focal-content'));
});

test('a visual experience whose core screens declare no media is rejected', () => {
  const bundle = bundleFor('commerce');
  assert.strictEqual(bundle.experience.mediaStrategy.necessity, 'essential');

  const buildPack = clone(bundle.buildPack);
  buildPack.packs[1].media = { role: 'none' };
  const result = compileScreenBuildPack(buildPack, bundle);
  assert.strictEqual(result.ok, false);
  const failure = result.errors.find((entry) => entry.code === 'visual-experience-without-media');
  assert.ok(failure);
  assert.ok(failure.message.includes('product'));
});

test('a non-visual experience is not forced to invent media', () => {
  const bundle = bundleFor('analytics');
  assert.strictEqual(bundle.experience.mediaStrategy.necessity, 'none');
  assert.ok(bundle.buildPack.packs.every((pack) => pack.media.role === 'none'));
  assert.deepStrictEqual(compile(bundle).errors, []);
});

test('screen packs cannot own package-provided offline runtime states', () => {
  const bundle = bundleFor('analytics');
  assert.strictEqual(bundle.experience.operatingContext.connectivity, 'always-online');
  const buildPack = clone(bundle.buildPack);
  buildPack.packs[0].states.offline = 'Show the last synchronized metrics';
  assert.ok(codes(compileScreenBuildPack(buildPack, bundle)).includes('screen-owned-offline-state'));
});

test('declared media without a fallback or a source is rejected', () => {
  const bundle = bundleFor('community');
  const noFallback = clone(bundle.buildPack);
  delete noFallback.packs[0].media.fallback;
  assert.ok(codes(compileScreenBuildPack(noFallback, bundle)).includes('media-without-fallback'));

  const noSource = clone(bundle.buildPack);
  noSource.packs[0].media.source = 'none';
  assert.ok(codes(compileScreenBuildPack(noSource, bundle)).includes('media-without-source'));
});

test('thin or canned preview content is rejected before HTML rendering', () => {
  const bundle = bundleFor('scheduling');
  const thin = clone(bundle.buildPack);
  thin.packs[0].previewContent.metrics = [];
  thin.packs[0].previewContent.records = [];
  thin.packs[0].previewContent.fields = [];
  thin.packs[0].previewContent.summaryRows = [];
  assert.ok(codes(compileScreenBuildPack(thin, bundle)).includes('preview-content-too-thin'));

  const canned = clone(bundle.buildPack);
  canned.packs[0].previewContent.fields[0].value = 'Sample value';
  assert.ok(codes(compileScreenBuildPack(canned, bundle)).includes('generic-preview-placeholder'));
});

test('media-bearing previews require deterministic hero or record media labels', () => {
  const bundle = bundleFor('community');
  const buildPack = clone(bundle.buildPack);
  delete buildPack.packs[0].previewContent.heroMediaLabel;
  for (const record of buildPack.packs[0].previewContent.records) delete record.mediaLabel;
  assert.ok(codes(compileScreenBuildPack(buildPack, bundle)).includes('preview-media-missing'));
});

test('a high-risk decision surface with no trust signal or decision support is rejected', () => {
  const bundle = bundleFor('finance');
  assert.strictEqual(bundle.experience.decisionRisk.level, 'critical');
  const buildPack = clone(bundle.buildPack);
  buildPack.packs[1].trustSignals = [];
  buildPack.packs[1].decisionSupport = [];
  assert.ok(codes(compileScreenBuildPack(buildPack, bundle)).includes('high-risk-without-decision-support'));
});

test('sample-only evidence cannot satisfy a high-risk production decision surface', () => {
  const bundle = bundleFor('finance');
  const buildPack = clone(bundle.buildPack);
  buildPack.packs[1].trustSignals = [{
    label: 'Sample approval confidence',
    classification: 'sample',
  }];
  buildPack.packs[1].decisionSupport = [{
    label: 'Proposed risk score',
    classification: 'proposed-requires-approval',
  }];
  assert.ok(codes(compileScreenBuildPack(buildPack, bundle)).includes('high-risk-without-decision-support'));
});

test('every screen sharing one composition signature is rejected', () => {
  const bundle = bundleFor('scheduling');
  const buildPack = clone(bundle.buildPack);
  const template = buildPack.packs[0];
  buildPack.packs = buildPack.packs.map((pack) => ({
    ...pack,
    firstViewport: { ...clone(template.firstViewport) },
    hierarchy: clone(template.hierarchy),
    composition: { kind: 'list', rationale: 'Rendered as a record list like every other screen.' },
  }));
  const result = compileScreenBuildPack(buildPack, bundle);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('uniform-generic-composition'));
  assert.strictEqual(result.summary.distinctCompositions, 1);
});

test('screens built only from generic record compositions are rejected', () => {
  const bundle = bundleFor('scheduling');
  const buildPack = clone(bundle.buildPack);
  const kinds = ['list', 'detail', 'list', 'detail'];
  buildPack.packs = buildPack.packs.map((pack, index) => ({
    ...pack,
    composition: { kind: kinds[index], rationale: 'Standard record composition applied to this entity.' },
  }));
  const result = compileScreenBuildPack(buildPack, bundle);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('uniform-generic-composition'));
});

test('a deliberate repeat of one composition is allowed when every pack justifies it', () => {
  const bundle = bundleFor('scheduling');
  const buildPack = clone(bundle.buildPack);
  const template = buildPack.packs[0];
  bundle.scope.screens = bundle.scope.screens.map((screen) => ({
    ...screen,
    pattern: 'schedule',
  }));
  buildPack.scopeRevision = contractRevision(bundle.scope);
  buildPack.packs = buildPack.packs.map((pack) => ({
    ...pack,
    firstViewport: {
      ...clone(template.firstViewport),
      primaryAction: pack.primaryActions[0].label,
    },
    hierarchy: clone(template.hierarchy),
    composition: {
      kind: 'schedule',
      rationale: 'Each surface answers the same temporal question at a different range.',
      repeatJustification: 'The day, week, and month views are intentionally one composition at three zoom levels.',
    },
  }));
  assert.deepStrictEqual(compileScreenBuildPack(buildPack, bundle).errors, []);
});

test('production behavior resting on sample or unapproved data is rejected until approved', () => {
  const bundle = bundleFor('niche');

  const unapproved = clone(bundle.buildPack);
  unapproved.packs[1].dataAssumptions = [{
    statement: 'Take rate is computed from a comparison table that does not exist yet',
    classification: 'proposed-requires-approval',
    productionCritical: true,
  }];
  const rejected = compileScreenBuildPack(unapproved, bundle);
  assert.strictEqual(rejected.ok, false);
  assert.ok(codes(rejected).includes('unsupported-production-assumption'));

  const approved = clone(unapproved);
  approved.packs[1].dataAssumptions[0].approved = true;
  assert.deepStrictEqual(compileScreenBuildPack(approved, bundle).errors, []);

  const presentational = clone(bundle.buildPack);
  presentational.packs[1].dataAssumptions = [{
    statement: 'Placeholder cell photographs are shown in the preview only',
    classification: 'sample',
    productionCritical: false,
  }];
  assert.deepStrictEqual(compileScreenBuildPack(presentational, bundle).errors, []);
});

test('build packs must bind to the exact experience, scope, and journey revisions', () => {
  const bundle = bundleFor('logistics');
  for (const field of ['experienceRevision', 'scopeRevision', 'journeyRevision']) {
    const buildPack = clone(bundle.buildPack);
    buildPack[field] = 'b'.repeat(64);
    const result = compileScreenBuildPack(buildPack, bundle);
    assert.strictEqual(result.ok, false, `${field} drift was not detected`);
    assert.ok(result.errors.some((entry) => entry.code === 'stale-contract-binding' && entry.message.includes(field)));
  }
});

test('an action pointing at a screen outside the scope is rejected', () => {
  const bundle = bundleFor('community');
  const buildPack = clone(bundle.buildPack);
  buildPack.packs[0].primaryActions[0].targetScreenId = 'archive';
  assert.ok(codes(compileScreenBuildPack(buildPack, bundle)).includes('unknown-navigation-target'));
});

test('build-pack route, composition, and first-viewport action must match approved contracts', () => {
  const bundle = bundleFor('commerce');

  const wrongRoute = clone(bundle.buildPack);
  wrongRoute.packs[0].route = '/wrong-route';
  assert.ok(codes(compileScreenBuildPack(wrongRoute, bundle)).includes('build-pack-route-mismatch'));

  const wrongComposition = clone(bundle.buildPack);
  wrongComposition.packs[0].composition.kind = 'list';
  assert.ok(codes(compileScreenBuildPack(wrongComposition, bundle)).includes('build-pack-composition-mismatch'));

  const wrongAction = clone(bundle.buildPack);
  wrongAction.packs[0].firstViewport.primaryAction = 'Different action';
  assert.ok(codes(compileScreenBuildPack(wrongAction, bundle)).includes('first-viewport-primary-action-mismatch'));
});

test('the compiler carries no domain-specific expectations into an unfamiliar product', () => {
  // The niche scenario is a practice with no conventional mobile pattern language. It must
  // produce exactly the same shape of compiled artifact as the familiar scenarios.
  const niche = compile(bundleFor('niche')).compiled;
  const familiar = compile(bundleFor('commerce')).compiled;
  assert.deepStrictEqual(Object.keys(niche).sort(), Object.keys(familiar).sort());
  assert.deepStrictEqual(
    Object.keys(niche.screens[0]).sort(),
    Object.keys(familiar.screens[0]).sort(),
  );
  assert.strictEqual(niche.screens.length, 4);
  assert.notStrictEqual(niche.experienceSignature, familiar.experienceSignature);
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test('the journey CLI validates against the contracts beside it', () => {
  const projectRoot = makeProjectDir('journey-cli');
  try {
    const bundle = bundleFor('inspection');
    writeContracts(projectRoot, bundle);
    const result = runCli('validate-workflow-journey.js', ['--project-root', projectRoot]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.json.ok, true);
    assert.strictEqual(result.json.summary.stepCount, 4);
  } finally {
    cleanup(projectRoot);
  }
});

test('the compile CLI writes the compiled artifact and refuses to write a rejected one', () => {
  const projectRoot = makeProjectDir('compile-cli');
  try {
    const bundle = bundleFor('commerce');
    writeContracts(projectRoot, bundle);

    const ok = runCli('compile-screen-build-pack.js', ['--project-root', projectRoot]);
    assert.strictEqual(ok.code, 0);
    const outputPath = path.join(projectRoot, '.tmp', 'compiled-screen-build-pack.json');
    assert.strictEqual(ok.json.outputPath, outputPath);
    const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.strictEqual(written.compiledRevision, ok.json.compiled.compiledRevision);
    assert.strictEqual(written.screens.length, 5);

    fs.rmSync(outputPath);
    const broken = clone(bundle.buildPack);
    broken.packs[0].media = { role: 'none' };
    writeContracts(projectRoot, { ...bundle, buildPack: broken });
    const rejected = runCli('compile-screen-build-pack.js', ['--project-root', projectRoot]);
    assert.strictEqual(rejected.code, 1);
    assert.strictEqual(fs.existsSync(outputPath), false, 'a rejected contract must not be compiled to disk');
  } finally {
    cleanup(projectRoot);
  }
});

test('the compile CLI --check validates without writing, and exits 2 when a contract is missing', () => {
  const projectRoot = makeProjectDir('compile-cli-check');
  try {
    const bundle = bundleFor('analytics');
    writeContracts(projectRoot, bundle);

    const checked = runCli('compile-screen-build-pack.js', ['--project-root', projectRoot, '--check']);
    assert.strictEqual(checked.code, 0);
    assert.strictEqual(checked.json.outputPath, undefined);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.tmp', 'compiled-screen-build-pack.json')), false);

    fs.rmSync(path.join(projectRoot, '.tmp', 'workflow-journey-contract.json'));
    const missing = runCli('compile-screen-build-pack.js', ['--project-root', projectRoot]);
    assert.strictEqual(missing.code, 2);
    assert.ok(missing.json.errors[0].message.includes('workflow journey contract'));
  } finally {
    cleanup(projectRoot);
  }
});

test('the compile CLI --check rejects an existing stale compiled artifact', () => {
  const projectRoot = makeProjectDir('compile-cli-stale-check');
  try {
    const bundle = bundleFor('analytics');
    writeContracts(projectRoot, bundle);

    const compiled = runCli('compile-screen-build-pack.js', ['--project-root', projectRoot]);
    assert.strictEqual(compiled.code, 0);

    const outputPath = path.join(projectRoot, '.tmp', 'compiled-screen-build-pack.json');
    const stale = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    stale.screens[0].pack.firstViewport.focalContent = 'Stale focal content';
    fs.writeFileSync(outputPath, `${JSON.stringify(stale, null, 2)}\n`);

    const checked = runCli('compile-screen-build-pack.js', ['--project-root', projectRoot, '--check']);
    assert.strictEqual(checked.code, 1);
    assert.ok(codes(checked.json).includes('stale-compiled-artifact'));
  } finally {
    cleanup(projectRoot);
  }
});

test('compiled revisions do not depend on the host locale', () => {
  const projectRoot = makeProjectDir('compile-cli-locale');
  try {
    const bundle = bundleFor('commerce');
    const secondJourney = clone(bundle.journey.journeys[0]);
    secondJourney.id = 'za';
    bundle.journey.journeys[0].id = 'aa';
    bundle.journey.journeys.push(secondJourney);
    bundle.buildPack.journeyRevision = contractRevision(bundle.journey);
    writeContracts(projectRoot, bundle);

    const english = runCli(
      'compile-screen-build-pack.js',
      ['--project-root', projectRoot, '--output', '.tmp/compiled-en.json'],
      { env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } },
    );
    const danish = runCli(
      'compile-screen-build-pack.js',
      ['--project-root', projectRoot, '--output', '.tmp/compiled-da.json'],
      { env: { LANG: 'da_DK.UTF-8', LC_ALL: 'da_DK.UTF-8' } },
    );

    assert.strictEqual(english.code, 0);
    assert.strictEqual(danish.code, 0);
    assert.strictEqual(english.json.compiled.compiledRevision, danish.json.compiled.compiledRevision);
    assert.deepStrictEqual(english.json.compiled.screens, danish.json.compiled.screens);
  } finally {
    cleanup(projectRoot);
  }
});
