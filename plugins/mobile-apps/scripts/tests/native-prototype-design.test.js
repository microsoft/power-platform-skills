'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  compileNativePrototypeDesign,
  stableHash,
  validateRecipe,
} = require('../compile-native-prototype-design');
const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const { applyNavigationShell } = require('../apply-navigation-shell');
const { deriveExperienceFromBrief } = require('../experience-patterns');
const { finalizePrototypePlan } = require('../finalize-prototype-plan');
const { prepareExecutionPreflight } = require('../prepare-mobile-plan-execution-contract');
const { preparePrototypePlannerRequest } = require('../prepare-prototype-planner-request');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { resolveWorkflowJourney } = require('../resolve-workflow-journey');
const { stagePrototypePlannerResponse } = require('../stage-prototype-planner-response');
const { validateScreenBuildPack } = require('../validate-screen-build-pack');
const { validateDesignRuntime } = require('../validate-design-runtime');
const { generateDataLayer } = require('../../skills/create-mobile-prototype/scripts/gen-data-layer');
const { validateNativePrototypeDesign, writeReport } = require('../validate-native-prototype-design');

const pluginRoot = path.resolve(__dirname, '..', '..');
const fixturesRoot = path.join(__dirname, 'fixtures', 'prototype-semantic');
const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'template', 'package.json'), 'utf8'));
const configureRuntime = path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'scripts', 'configure-prototype-runtime.js');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesRoot, name), 'utf8'));
}

function setupProject(context, golden, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-prototype-design-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (options.withTemplate) {
    const templateRoot = path.join(pluginRoot, 'template');
    fs.cpSync(templateRoot, root, { recursive: true, filter: (source) => !source.split(path.sep).includes('node_modules') });
    fs.symlinkSync(path.join(templateRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  } else fs.copyFileSync(path.join(pluginRoot, 'template', 'tamagui.config.ts'), path.join(root, 'tamagui.config.ts'));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const experience = deriveExperienceFromBrief(golden.brief, { mediaPolicy: golden.semanticPlan.domain.mediaPolicy.mode });
  const contextContract = resolveContextEnrichment(golden.brief, experience);
  const journey = resolveWorkflowJourney(golden.brief, experience, contextContract);
  const preflight = prepareExecutionPreflight(golden.brief, experience, packageJson);
  fs.writeFileSync(path.join(root, 'brief.md'), golden.brief);
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const [name, value] of [
    ['experience-contract.json', experience],
    ['context-enrichment-contract.json', contextContract],
    ['workflow-journey-contract.json', journey],
    ['mobile-plan-execution-preflight.json', preflight],
  ]) fs.writeFileSync(path.join(root, '.tmp', name), `${JSON.stringify(value, null, 2)}\n`);
  const request = preparePrototypePlannerRequest(root);
  fs.writeFileSync(path.join(root, '.tmp', 'prototype-planner-request.json'), request.content);
  stagePrototypePlannerResponse(root, Buffer.from(JSON.stringify(golden.semanticPlan)), 1);
  finalizePrototypePlan(root, golden.semanticPlan);
  return root;
}

function outputBytes(root, manifest) {
  return Object.fromEntries(manifest.outputs.map((entry) => [entry.path, fs.readFileSync(path.join(root, entry.path), 'utf8')]));
}

function leafPointers(value, pathPrefix, result = []) {
  if (Array.isArray(value)) {
    if (!value.length) result.push(pathPrefix);
    value.forEach((item, index) => leafPointers(item, `${pathPrefix}/${index}`, result));
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) result.push(pathPrefix);
    entries.forEach(([key, child]) => leafPointers(child, `${pathPrefix}/${key}`, result));
  } else result.push(pathPrefix);
  return result;
}

test('automatic design compilation is byte-stable and preserves every design-intent leaf', (context) => {
  const golden = fixture('flight-shop.json');
  const root = setupProject(context, golden);
  const first = compileNativePrototypeDesign(root);
  const firstBytes = outputBytes(root, first.manifest);
  const second = compileNativePrototypeDesign(root);
  const secondBytes = outputBytes(root, second.manifest);

  assert.deepEqual(secondBytes, firstBytes);
  assert.equal(stableHash(second.recipe), stableHash(first.recipe));
  assert.deepEqual(validateRecipe(second.recipe, require('../compile-native-prototype-design').readInputs(root).inputs), []);
  for (const sourcePath of leafPointers(golden.semanticPlan.designIntent, '/designIntent')) {
    assert.ok(second.recipe.sourceBindings.designIntentPaths[sourcePath], sourcePath);
  }
  assert.equal(second.recipe.navigationChrome.model, 'tabs-stack');
  assert.equal(second.recipe.navigationChrome.tabBar.visible, true);
  assert.equal(second.recipe.mediaStrategy.sourcePolicy.requiresFallback, true);
  assert.match(firstBytes['brand/tokens.ts'], /tokenSourceBindings/);
  assert.match(firstBytes['tamagui.config.ts'], /brandTokens\.typography\.headingFamily/);
  assert.match(firstBytes['tamagui.config.ts'], /Platform\.select/);
  assert.match(firstBytes['src/components/experience/ExperienceFeaturedProductMedia.tsx'], /experience-motif-featured-product-media/);
  assert.match(firstBytes['src/components/experience/ExperienceFeaturedProductMedia.tsx'], /experience-signature-editorial-promotion/);
  const validation = validateNativePrototypeDesign(root);
  assert.deepEqual(validation.errors, []);
  assert.equal(writeReport(root, validation).valid, true);
});

test('commerce and field-work goldens resolve to distinct native systems', (context) => {
  const flight = compileNativePrototypeDesign(setupProject(context, fixture('flight-shop.json'))).recipe;
  const receiving = compileNativePrototypeDesign(setupProject(context, fixture('icrc-receiving.json'))).recipe;

  assert.notEqual(flight.colorBehavior.palette.accent, receiving.colorBehavior.palette.accent);
  assert.notEqual(flight.typography.headingFamily, receiving.typography.headingFamily);
  assert.notDeepEqual(flight.screens.map((screen) => screen.presentation.pattern), receiving.screens.map((screen) => screen.presentation.pattern));
  assert.notDeepEqual(flight.signatureComponents.map((component) => component.componentId), receiving.signatureComponents.map((component) => component.componentId));
  assert.notDeepEqual(flight.navigationChrome.tabBar.nestedVisibility, receiving.navigationChrome.tabBar.nestedVisibility);
  assert.equal(receiving.mediaStrategy.sourcePolicy.mode, 'local-first');
  assert.equal(receiving.signatureComponents.some((component) => component.componentId === 'manual-fallback'), true);
});

test('automatic design compilation fails path-by-path on incomplete protected decisions', (context) => {
  const root = setupProject(context, fixture('flight-shop.json'));
  const semanticPath = path.join(root, '.tmp', 'prototype-semantic-plan.json');
  const baseline = JSON.parse(fs.readFileSync(semanticPath, 'utf8'));
  const cases = [
    ['hierarchy', '/designIntent/informationHierarchy', (plan) => { delete plan.designIntent.informationHierarchy; }],
    ['media', '/designIntent/mediaStrategy', (plan) => { delete plan.designIntent.mediaStrategy; }],
    ['action', '/screens/items/0/primaryAction', (plan) => { delete plan.screens.items[0].primaryAction; }],
    ['state', '/designIntent/stateTreatment', (plan) => { delete plan.designIntent.stateTreatment; }],
    ['signature', '/designIntent/signatureComponents', (plan) => { delete plan.designIntent.signatureComponents; }],
    ['accessibility', '/designIntent/accessibilityIntent', (plan) => { delete plan.designIntent.accessibilityIntent; }],
    ['visual character', '/designIntent/visualCharacter', (plan) => { delete plan.designIntent.visualCharacter; }],
  ];
  for (const [label, expectedPath, mutate] of cases) {
    const semanticPlan = JSON.parse(JSON.stringify(baseline));
    mutate(semanticPlan);
    fs.writeFileSync(semanticPath, `${JSON.stringify(semanticPlan, null, 2)}\n`);
    assert.throws(() => compileNativePrototypeDesign(root), new RegExp(expectedPath.replaceAll('/', '\\/')), label);
    const validation = validateNativePrototypeDesign(root);
    assert.equal(validation.valid, false, label);
    assert.equal(validation.errors[0].path, expectedPath, label);
  }
  assert.equal(fs.existsSync(path.join(root, 'brand', 'design-recipe.json')), false);
});

test('automatic design compilation refuses to overwrite a modified generated component', (context) => {
  const root = setupProject(context, fixture('icrc-receiving.json'));
  const result = compileNativePrototypeDesign(root);
  const componentPath = result.recipe.signatureComponents[0].file;
  fs.appendFileSync(path.join(root, componentPath), '// local edit\n');
  const validation = validateNativePrototypeDesign(root);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.path === `/${componentPath}`));
  assert.throws(() => compileNativePrototypeDesign(root), new RegExp(`modified design output: ${componentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('automatic design compilation refuses an unowned runtime customization', (context) => {
  const root = setupProject(context, fixture('icrc-receiving.json'));
  const configPath = path.join(root, 'tamagui.config.ts');
  const source = fs.readFileSync(configPath, 'utf8').replace('  animations,', "  animations,\n  shouldAddPrefetch: true,");
  fs.writeFileSync(configPath, source);
  assert.throws(() => compileNativePrototypeDesign(root), /refusing to overwrite unowned design output: tamagui\.config\.ts/);
});

test('remote media requires explicit approved-source authorization', (context) => {
  const root = setupProject(context, fixture('flight-shop.json'));
  const semanticPath = path.join(root, '.tmp', 'prototype-semantic-plan.json');
  const semanticPlan = JSON.parse(fs.readFileSync(semanticPath, 'utf8'));
  semanticPlan.designIntent.mediaStrategy.licensingIntent = 'bundled-original';
  fs.writeFileSync(semanticPath, `${JSON.stringify(semanticPlan, null, 2)}\n`);
  assert.throws(() => compileNativePrototypeDesign(root), /\/mediaStrategy\/licensingIntent: remote media requires explicit approved-source authorization/);
});

test('screen build-pack compilation requires a current design validation receipt', (context) => {
  const root = setupProject(context, fixture('flight-shop.json'));
  compileNativePrototypeDesign(root);
  assert.throws(() => compileScreenBuildPack(root), /Native prototype design validation is missing/);

  const validation = validateNativePrototypeDesign(root);
  writeReport(root, validation);
  fs.appendFileSync(path.join(root, 'brand', 'tokens.ts'), '// drift\n');
  assert.throws(() => compileScreenBuildPack(root), /Native prototype design validation is stale or invalid/);
});

test('validated domain and design foundations compile into compact builder authority', (context) => {
  const root = setupProject(context, fixture('flight-shop.json'), { withTemplate: true });
  const readArtifact = (name) => JSON.parse(fs.readFileSync(path.join(root, '.tmp', name), 'utf8'));
  const experience = readArtifact('experience-contract.json');
  const screens = readArtifact('experience-screen-contract.json');
  const domain = readArtifact('prototype-domain-model.json');
  const execution = readArtifact('mobile-plan-execution-contract.json');
  const contextContract = readArtifact('context-enrichment-contract.json');
  const navigation = readArtifact('navigation-contract.json');

  generateDataLayer(root, domain, experience, screens, execution, contextContract);
  applyNavigationShell(root, navigation, screens);
  compileNativePrototypeDesign(root);
  writeReport(root, validateNativePrototypeDesign(root));

  const pack = compileScreenBuildPack(root);
  fs.writeFileSync(path.join(root, '.tmp', 'screen-build-pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  assert.deepEqual(validateScreenBuildPack(root, pack).issues, []);
  assert.deepEqual(validateNativePrototypeDesign(root, { requireBuildPack: true }).errors, []);
  const driftedPack = JSON.parse(JSON.stringify(pack));
  driftedPack.productStructure.launchScreenId = 'bag';
  driftedPack.screens.find((screen) => screen.id === 'discover').productRole = 'capture-surface';
  const driftRules = new Set(validateScreenBuildPack(root, driftedPack).issues.map((issue) => issue.rule));
  assert.ok(driftRules.has('product-structure-drift'));
  assert.ok(driftRules.has('product-role-drift'));
  assert.deepEqual(validateDesignRuntime(root), []);
  assert.equal(pack.design.escapePolicy, 'blocked-until-reviewed');
  assert.equal(pack.design.signatureComponents.length, 5);
  assert.equal(pack.design.registryPath, 'brand/signature-components.json');
  fs.writeFileSync(path.join(root, 'tsconfig.design-test.json'), `${JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: { noEmit: true },
    include: ['brand/tokens.ts', 'src/components/experience/**/*.ts', 'src/components/experience/**/*.tsx', 'tamagui.config.ts', 'power-apps-env.d.ts'],
  }, null, 2)}\n`);
  const typecheck = spawnSync(path.join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.design-test.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(typecheck.status, 0, `${typecheck.stdout}\n${typecheck.stderr}`);
  const runtime = spawnSync(process.execPath, [configureRuntime, root, 'prototype', '/(app)/home'], { encoding: 'utf8' });
  assert.equal(runtime.status, 0, runtime.stderr);
  const fullTypecheck = spawnSync(path.join(root, 'node_modules', '.bin', 'tsc'), ['--noEmit'], { cwd: root, encoding: 'utf8' });
  assert.equal(fullTypecheck.status, 0, `${fullTypecheck.stdout}\n${fullTypecheck.stderr}`);
});