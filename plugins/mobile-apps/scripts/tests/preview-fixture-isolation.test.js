'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  previewStructureSignature,
  validateGeneratedSourceIsolation,
  validatePreviewOutputIsolation,
  validateProductionAuthoringIsolation,
  validateProductionSourceIsolation,
} = require('../lib/final-preview-isolation');
const { canonicalJson, sha256Hex } = require('../lib/product-experience-contracts');
const { buildFinalPreviewContract } = require('../validate-product-experience-preview');
const {
  CANONICAL_ARTIFACTS,
  materializeWorkspace,
} = require('./helpers/materialize-final-preview-acceptance');
const { runVariant } = require('./helpers/run-live-build-plan-acceptance');
const { flightPreview } = require('./fixtures/final-preview-model-outputs');

const pluginRoot = path.resolve(__dirname, '../..');

test('production authoring surfaces cannot reference test or snapshot inputs', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-authoring-isolation-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'skills', 'design-system'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'skills', 'design-system', 'SKILL.md'),
    'Read scripts/tests/fixtures/final-preview-model-outputs.js before authoring.\n',
  );
  const rejected = validateProductionAuthoringIsolation(root);
  assert.ok(rejected.errors.some((error) => error.code === 'preview-production-prompt-fixture-reference'));
  assert.deepEqual(validateProductionAuthoringIsolation(pluginRoot).errors, []);
});

test('generated code cannot import fixture modules while isolated tests still can', () => {
  const source = "import { flightPreview } from '../scripts/tests/fixtures/final-preview-model-outputs';\n";
  assert.ok(validateGeneratedSourceIsolation(source, 'app/home.tsx').errors.some(
    (error) => error.code === 'preview-generated-test-import',
  ));
  assert.deepEqual(
    validateGeneratedSourceIsolation(source, 'scripts/tests/fixture-runner.test.js').errors,
    [],
  );
});

test('non-test production modules cannot import the test tree', () => {
  assert.deepEqual(validateProductionSourceIsolation(pluginRoot).errors, []);
});

test('fresh acceptance workspaces expose only canonical run inputs', (context) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-live-workspaces-'));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const canonicalFiles = Object.keys(CANONICAL_ARTIFACTS).sort();

  for (const scenario of ['flight', 'gym', 'icrc']) {
    const root = path.join(parent, scenario);
    const { manifest } = materializeWorkspace(scenario, root, pluginRoot);
    assert.equal(manifest.prohibitedInputCount, 0, scenario);
    assert.equal(manifest.previewPresentBeforeRun, false, scenario);
    assert.deepEqual(
      fs.readdirSync(path.join(root, '.tmp')).sort(),
      [...canonicalFiles, 'live-preview-acceptance-inputs.json'].sort(),
      scenario,
    );
    assert.equal(manifest.authoringInputs[0], 'native-app-plan.md', scenario);
    assert.deepEqual(
      manifest.authoringInputs.slice(1).sort(),
      canonicalFiles.map((name) => `.tmp/${name}`),
      scenario,
    );
    assert.equal(fs.existsSync(path.join(root, '_plan_preview.html')), false, scenario);
    assert.equal(fs.existsSync(path.join(root, 'scripts', 'tests')), false, scenario);
    assert.equal(fs.existsSync(path.join(root, 'tests')), false, scenario);
    assert.equal(fs.existsSync(path.join(root, 'fixtures')), false, scenario);
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, 'native-app-plan.md'), 'utf8'),
      /\b(?:offline|sync(?:ing|ed)?|synchronization)\b/i,
      scenario,
    );
  }
});

test('fixture-only preview composition IDs are rejected', () => {
  for (const marker of [
    'editorial-merchandise-runway',
    'equipment-command-surface',
    'dense-receiving-ledger',
    'repaired-editorial-merchandise-runway',
    'repaired-equipment-command-surface',
  ]) {
    const result = validatePreviewOutputIsolation(
      `<!doctype html><body data-composition-id="${marker}"></body>`,
    );
    assert.ok(result.errors.some(
      (error) => error.code === 'preview-fixture-marker-leaked',
    ), marker);
  }
});

test('marker-stripped fixture structure is still rejected without production fixture reads', () => {
  const run = runVariant({ id: 'fixture-flight', scenario: 'flightCommerce', mode: 'connector-only' });
  const token = {
    colors: {
      bg: '#f4f7f6', surface: '#ffffff', primary: '#075d66', accent: '#d9efed',
      text: '#142523', textMuted: '#5d706d', border: '#cfdedb',
      statusSuccess: '#187a50', statusWarning: '#9a650d', statusDanger: '#b4232f', statusInfo: '#176b87',
    },
    typography: { family: 'Georgia', size: 24, weight: 700, lineHeight: 1.18, tracking: 0 },
  };
  const contract = buildFinalPreviewContract({
    experience: run.artifacts.bundle.experience,
    scope: run.artifacts.bundle.scope,
    journey: run.artifacts.bundle.journey,
    compiled: run.artifacts.compiled,
    scenario: run.artifacts.scenario,
    navigation: run.artifacts.navigation,
    tokenContract: {
      ok: true,
      ready: true,
      revision: sha256Hex(canonicalJson(token)),
      ...token,
    },
    signatureComponentsSource: `export interface ${run.domain}SignatureProps { state: 'ready' | 'busy'; }\n`,
  });
  const copied = flightPreview(contract).replace(/\sdata-composition-id="[^"]+"/, '');
  assert.match(previewStructureSignature(copied), /^[a-f0-9]{64}$/);
  const result = validatePreviewOutputIsolation(copied);
  assert.ok(result.errors.some(
    (error) => error.code === 'preview-fixture-structure-identical',
  ));
});