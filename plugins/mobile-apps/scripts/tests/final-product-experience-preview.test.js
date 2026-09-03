'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { compileNavigationManifest } = require('../compile-navigation-manifest');
const { buildFinalPreviewContract } = require('../validate-product-experience-preview');
const { bundleFor } = require('./helpers/product-experience-scenarios');
const { cleanup, makeProjectDir, runCli, writeContracts } = require('./helpers/contract-cli');
const { scenarioFactsForBundle } = require('./helpers/scenario-facts-fixtures');

const VECTOR_PACKAGE = { dependencies: { '@expo/vector-icons': '15.1.1' } };

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function prepare(projectRoot) {
  const bundle = bundleFor('commerce');
  writeContracts(projectRoot, bundle);
  assert.strictEqual(runCli('compile-screen-build-pack.js', ['--project-root', projectRoot]).code, 0);
  const navigation = compileNavigationManifest(bundle.scope, VECTOR_PACKAGE);
  const { scenario } = scenarioFactsForBundle(bundle, { navigation });
  fs.writeFileSync(
    path.join(projectRoot, '.tmp', 'navigation-manifest.json'),
    `${JSON.stringify(navigation, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(projectRoot, '.tmp', 'scenario-facts.json'),
    `${JSON.stringify(scenario, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(projectRoot, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'brand', 'tokens.ts'), `
export const tokens = {
  color: {
    bg: '#f8f4ed', surface: '#ffffff', primary: '#5b3fd1', accent: '#ece7ff',
    text: '#1c1727', textMuted: '#706a7c', border: '#ddd6eb',
    statusSuccess: '#2f7d4a', statusWarning: '#9a6518',
    statusDanger: '#b23b45', statusInfo: '#315ea8',
  },
  typography: {
    heading: { family: 'Avenir Next', size: 23, weight: '700', lineHeight: 1.2, tracking: 0 },
  },
} as const;
`);
  fs.writeFileSync(
    path.join(projectRoot, 'brand', 'signature-components.ts'),
    'export interface ProductSignatureProps { state: "ready" | "busy"; }\n',
  );
}

function finalHtml(contract) {
  const navigation = contract.navigation.durableDestinations.map((destination) => (
    `<a data-navigation-destination="${destination.destinationId}" data-navigation-target-path="${destination.targetPath}">${escapeHtml(destination.label)}</a>`
  )).join('');
  const screens = contract.screens.map((screen) => `
    <article id="preview-screen-${screen.screenId}" data-preview-screen-id="${screen.screenId}" data-pack-revision="${screen.packRevision}">
      <header><h2>${escapeHtml(screen.title)}</h2></header>
      <section data-signature-intent="${screen.screenId}">
        <strong>${escapeHtml(screen.signatureIntent.name)}</strong>
        <p>${escapeHtml(screen.signatureIntent.description)}</p>
      </section>
      ${screen.primaryActions.map((action) => (
    `<button data-primary-action="${action.markerId}"${action.targetScreenId ? ` data-target-screen-id="${action.targetScreenId}"` : ''}>${escapeHtml(action.label)}</button>`
  )).join('')}
      ${screen.states.map((state) => (
    `<section data-preview-state="${screen.screenId}:${state.name}">${escapeHtml(state.copy)}</section>`
  )).join('')}
      ${screen.media.map((asset) => (
    `<figure data-media-asset-key="${asset.key}">${escapeHtml(asset.fallback)}</figure>`
  )).join('')}
      ${screen.scenarioEvidence.map((evidence) => (
    `<span data-scenario-evidence-id="${evidence.id}">${escapeHtml(evidence.value)}</span>`
  )).join('')}
    </article>`).join('');
  const allScreens = contract.allScreenIds.map(
    (screenId) => `<span data-all-screen-id="${screenId}">${screenId}</span>`,
  ).join('');
  const requirements = contract.requirements.map((requirement) => (
    `<p data-requirement-id="${requirement.requirementId}">${escapeHtml(requirement.statement)}</p>`
  )).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Final product experience</title>
  <style id="product-experience-token-contract">${contract.designTokens.css}</style>
</head>
<body data-preview-mode="final" data-preview-authorship="design-system-model" data-preview-contract-revision="${contract.contractRevision}">
  <nav id="preview-navigation">${navigation}</nav>
  <main id="preview-storyboard">${screens}</main>
  <section id="preview-all-screens">${allScreens}${requirements}</section>
</body>
</html>\n`;
}

test('validator prepares and accepts a canonical AI-authored final preview', () => {
  const projectRoot = makeProjectDir('final-experience-preview');
  try {
    prepare(projectRoot);
    const contractPath = path.join(projectRoot, '.tmp', 'final-preview-contract.json');
    const prepared = runCli('validate-product-experience-preview.js', [
      '--project-root', projectRoot,
      '--contract-output', contractPath,
    ]);
    assert.strictEqual(prepared.code, 0, prepared.stderr);
    assert.strictEqual(prepared.json.mode, 'contract-preparation');
    assert.deepStrictEqual(prepared.json.selectedScreenIds, ['discover', 'product', 'checkout']);

    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const previewPath = path.join(projectRoot, '_plan_preview.html');
    const html = finalHtml(contract);
    assert.strictEqual(contract.contractRevision, prepared.json.contractRevision);
    assert.match(html, new RegExp(`data-preview-contract-revision="${contract.contractRevision}"`));
    assert.doesNotMatch(html, /application\/json|product-experience-preview-contract/);
    fs.writeFileSync(previewPath, html);
    const result = runCli('validate-product-experience-preview.js', [
      '--project-root', projectRoot,
    ]);
    assert.strictEqual(result.code, 0, JSON.stringify(result.json?.errors));
    assert.strictEqual(result.json.ok, true);
    assert.deepStrictEqual(result.json.selectedScreenIds, ['discover', 'product', 'checkout']);
    assert.strictEqual(result.json.previewContractRevision, prepared.json.contractRevision);
    assert.match(result.json.previewRevision, /^[a-f0-9]{64}$/);
  } finally {
    cleanup(projectRoot);
  }
});

test('validator rejects drift, hidden evidence, placeholders, and structural substitution', () => {
  const projectRoot = makeProjectDir('final-experience-preview-rejections');
  try {
    prepare(projectRoot);
    const contractPath = path.join(projectRoot, '.tmp', 'final-preview-contract.json');
    assert.strictEqual(runCli('validate-product-experience-preview.js', [
      '--project-root', projectRoot,
      '--contract-output', contractPath,
    ]).code, 0);
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const previewPath = path.join(projectRoot, '_plan_preview.html');
    const valid = finalHtml(contract);

    const cases = [
      {
        name: 'token drift',
        html: valid.replace('--color-primary: #5b3fd1;', '--color-primary: #000000;'),
        code: 'preview-token-css-mismatch',
      },
      {
        name: 'hidden scenario evidence',
        html: valid.replace('data-scenario-evidence-id="', 'hidden data-scenario-evidence-id="'),
        code: 'preview-scenario-evidence-missing',
      },
      {
        name: 'placeholder copy',
        html: valid.replace('</main>', '<p>Lorem ipsum</p></main>'),
        code: 'placeholder-copy',
      },
      {
        name: 'structural renderer substitution',
        html: valid.replace('data-preview-mode="final"', 'data-preview-mode="structural"'),
        code: 'preview-authorship-invalid',
      },
      {
        name: 'screen selection drift',
        html: valid.replace('data-preview-screen-id="discover"', 'data-preview-screen-id="cart"'),
        code: 'preview-screen-selection-mismatch',
      },
      {
        name: 'contract revision drift',
        html: valid.replace(
          `data-preview-contract-revision="${contract.contractRevision}"`,
          'data-preview-contract-revision="stale"',
        ),
        code: 'preview-contract-revision-mismatch',
      },
      {
        name: 'navigation drift',
        html: valid.replace('data-navigation-destination="', 'data-stale-navigation-destination="'),
        code: 'preview-navigation-mismatch',
      },
      {
        name: 'primary action missing',
        html: valid.replace('data-primary-action="', 'data-stale-primary-action="'),
        code: 'preview-primary-action-missing',
      },
      {
        name: 'primary action target drift',
        html: valid.replace('data-target-screen-id="product"', 'data-target-screen-id="checkout"'),
        code: 'preview-primary-action-target-mismatch',
      },
      {
        name: 'signature intent missing',
        html: valid.replace('data-signature-intent="', 'data-stale-signature-intent="'),
        code: 'preview-signature-intent-missing',
      },
      {
        name: 'storyboard landmark missing',
        html: valid.replace('id="preview-storyboard"', 'id="stale-storyboard"'),
        code: 'preview-landmark-invalid',
      },
      {
        name: 'pack revision drift',
        html: valid.replace('data-pack-revision="', 'data-pack-revision="stale-'),
        code: 'preview-pack-revision-mismatch',
      },
      {
        name: 'navigation target drift',
        html: valid.replace('data-navigation-target-path="', 'data-navigation-target-path="/stale'),
        code: 'preview-navigation-target-mismatch',
      },
      {
        name: 'approved requirement missing',
        html: valid.replace('data-requirement-id="', 'data-stale-requirement-id="'),
        code: 'preview-requirement-missing',
      },
      {
        name: 'external stylesheet',
        html: valid.replace('</head>', '<link rel="stylesheet" href="https://example.test/theme.css"></head>'),
        code: 'preview-external-stylesheet-forbidden',
      },
      {
        name: 'stylesheet-hidden storyboard',
        html: valid.replace(
          '</head>',
          '<style>#preview-storyboard { display: none !important; }</style></head>',
        ),
        code: 'preview-required-content-css-hidden',
      },
    ];
    for (const candidate of cases) {
      fs.writeFileSync(previewPath, candidate.html);
      const result = runCli('validate-product-experience-preview.js', [
        '--project-root', projectRoot,
      ]);
      assert.strictEqual(result.code, 1, candidate.name);
      assert.ok(result.json.errors.some((error) => error.code === candidate.code), candidate.name);
    }
  } finally {
    cleanup(projectRoot);
  }
});

test('validator reports missing and incomplete generated token contracts', () => {
  const projectRoot = makeProjectDir('final-experience-preview-token-readiness');
  try {
    prepare(projectRoot);
    const tokenPath = path.join(projectRoot, 'brand', 'tokens.ts');
    fs.rmSync(tokenPath);
    const missing = runCli('validate-product-experience-preview.js', [
      '--project-root', projectRoot,
      '--contract-output', path.join(projectRoot, '.tmp', 'preview-contract.json'),
    ]);
    assert.strictEqual(missing.code, 1);
    assert.ok(missing.json.errors.some((error) => error.code === 'design-tokens-not-ready'));

    fs.writeFileSync(tokenPath, "export const tokens = { color: { primary: '#123456' } } as const;\n");
    const incomplete = runCli('validate-product-experience-preview.js', [
      '--project-root', projectRoot,
      '--contract-output', path.join(projectRoot, '.tmp', 'preview-contract.json'),
    ]);
    assert.strictEqual(incomplete.code, 1);
    assert.ok(incomplete.json.errors.some((error) => error.code === 'design-tokens-incomplete'));
  } finally {
    cleanup(projectRoot);
  }
});

test('final preview contract excludes explicitly deferred requirements', () => {
  const contract = buildFinalPreviewContract({
    experience: {},
    scope: {
      requirements: [
        {
          id: 'current-work',
          statement: 'Complete the current work',
          disposition: 'shipping',
          jobId: 'current-job',
        },
        {
          id: 'future-export',
          statement: 'Export all historical records in a future release',
          disposition: 'deferred',
          jobId: 'future-export-job',
        },
      ],
    },
    journey: { journeys: [] },
    compiled: { compiledRevision: 'a'.repeat(64), experienceDirective: {}, screens: [] },
    scenario: { scenarioRevision: 'b'.repeat(64), screenBindings: [], mediaAssets: [] },
    navigation: {
      manifestRevision: 'c'.repeat(64),
      pattern: 'stack-only',
      visibleTabs: [],
      durableDestinations: [],
      returnHomeMechanism: 'Return home',
    },
    tokenContract: {
      revision: 'd'.repeat(64),
      colors: {},
      typography: { family: 'Test', size: 22, weight: 700, lineHeight: 1.2, tracking: 0 },
    },
    signatureComponentsRevision: 'e'.repeat(64),
  });
  assert.deepStrictEqual(contract.requirements.map((item) => item.requirementId), [
    'current-work',
  ]);
});