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
  const focalMarkup = (screen, index) => {
    const content = escapeHtml(screen.firstViewport.focalContent);
    const attrs = `data-product-component="screen-focal-${index}" data-focal-point="${screen.screenId}"`;
    if (index === 1) return `<ol ${attrs}><li><strong>${content}</strong></li></ol>`;
    if (index === 2) return `<figure ${attrs}><figcaption>${content}</figcaption></figure>`;
    return `<section ${attrs}><strong>${content}</strong></section>`;
  };
  const frames = contract.screens.map((screen, index) => `
    <article id="preview-screen-${screen.screenId}" data-preview-screen-id="${screen.screenId}" data-pack-revision="${screen.packRevision}">
      <section data-mobile-frame="${screen.screenId}">
        <div data-first-viewport="${screen.screenId}">
          <header data-viewport-region="context"><span>Current journey</span><h2>${escapeHtml(screen.title)}</h2></header>
          <div data-viewport-region="focal-content">
            ${focalMarkup(screen, index)}
            <aside data-product-component="screen-signature-${index}" data-signature-component="${screen.screenId}">${escapeHtml(screen.signatureIntent.name)}</aside>
            <div data-product-component="decision-evidence-${index}">${screen.scenarioEvidence.slice(0, 4).map((evidence) => (
    `<span data-scenario-evidence-id="${evidence.id}">${escapeHtml(evidence.value)}</span>`
  )).join('')}</div>
            ${screen.media.map((asset) => (
    `<figure data-media-asset-key="${asset.key}">${escapeHtml(asset.fallback)}</figure>`
  )).join('')}
              </div>
              <div data-viewport-region="primary-action">${screen.primaryActions.map((action, actionIndex) => (
            `<button data-primary-action="${action.markerId}"${actionIndex === 0 ? ` data-primary-emphasis="${action.markerId}"` : ''}${action.targetScreenId ? ` data-target-screen-id="${action.targetScreenId}"` : ''}>${escapeHtml(action.label)}</button>`
  )).join('')}</div>
        </div>
      </section>
    </article>`).join('');
  const allScreens = contract.allScreenIds.map(
    (screenId) => `<span data-all-screen-id="${screenId}">${screenId}</span>`,
  ).join('');
  const supporting = contract.screens.map((screen) => `<section class="review-screen">
    <h3>${escapeHtml(screen.title)}</h3>
    <div data-signature-intent="${screen.screenId}"><strong>${escapeHtml(screen.signatureIntent.name)}</strong><p>${escapeHtml(screen.signatureIntent.description)}</p></div>
    ${screen.states.map((state) => `<div data-preview-state="${screen.screenId}:${state.name}">${escapeHtml(state.copy)}</div>`).join('')}
    ${screen.scenarioEvidence.slice(4).map((evidence) => `<span data-scenario-evidence-id="${evidence.id}">${escapeHtml(evidence.value)}</span>`).join('')}
  </section>`).join('');
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
  <style>
    *{box-sizing:border-box}body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-heading-family),sans-serif}
    #preview-navigation{display:flex;justify-content:center;gap:.5rem;padding:1rem;background:var(--color-primary)}
    [data-navigation-destination]{padding:.6rem .9rem;border:1px solid var(--color-border);color:var(--color-surface);text-decoration:none}
    #preview-storyboard{display:grid;grid-template-columns:repeat(3,minmax(0,390px));justify-content:center;gap:1rem;padding:1rem}
    [data-mobile-frame]{width:min(100%,390px);height:780px;overflow:auto;padding:1rem;background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px}
    [data-first-viewport]{height:740px;display:flex;flex-direction:column;gap:1rem}
    [data-viewport-region="focal-content"]{display:grid;gap:.75rem;min-height:0;overflow:auto;flex:1}
    [data-viewport-region="primary-action"]{margin-top:auto}
    [data-product-component]{display:grid;gap:.4rem;padding:.75rem;border:1px solid var(--color-border);background:var(--color-bg)}
    [data-primary-action]{width:100%;min-height:48px;background:var(--color-primary);color:var(--color-surface);border:0}
    [data-screen-index]{display:flex;gap:.5rem;padding:.75rem;border:1px solid var(--color-border);background:var(--color-bg)}
    #preview-all-screens{padding:1rem}.review-screen,.requirement-index{padding:1rem;border-top:1px solid var(--color-border)}
    @media(max-width:900px){#preview-storyboard{grid-template-columns:minmax(0,390px)}}
  </style>
</head>
<body data-preview-mode="final" data-preview-authorship="design-system-model" data-preview-contract-revision="${contract.contractRevision}">
  <nav id="preview-navigation">${navigation}</nav>
  <main id="preview-storyboard">${frames}</main>
  <section id="preview-all-screens"><details><summary>Review complete experience</summary><div data-screen-index>${allScreens}</div>${supporting}<section class="requirement-index">${requirements}</section></details></section>
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
    assert.ok(prepared.json.fixtureIsolation.productionPromptFilesScanned > 0);
    assert.ok(prepared.json.fixtureIsolation.productionSourceFilesScanned > 0);
    assert.deepStrictEqual({
      forbiddenReferenceCount: prepared.json.fixtureIsolation.forbiddenReferenceCount,
      productionTestImportCount: prepared.json.fixtureIsolation.productionTestImportCount,
      forbiddenImportCount: prepared.json.fixtureIsolation.forbiddenImportCount,
    }, {
      forbiddenReferenceCount: 0,
      productionTestImportCount: 0,
      forbiddenImportCount: 0,
    });

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
    assert.strictEqual(result.json.fixtureIsolation.fixtureMarkerCount, 0);
    assert.deepStrictEqual(result.json.quality.semantic, { passed: true });
    assert.strictEqual(result.json.quality.structural.passed, true);
    assert.ok(['passed', 'skipped'].includes(result.json.quality.renderedLayout.status));
    if (result.json.quality.renderedLayout.status === 'skipped') {
      assert.ok(result.json.warnings.some(
        (warning) => warning.code === 'layout-validation-skipped',
      ));
    }
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
      {
        name: 'missing bounded mobile frame',
        html: valid.replace('data-mobile-frame="', 'data-stale-mobile-frame="'),
        code: 'preview-mobile-frame-missing',
      },
      {
        name: 'expanded contract review',
        html: valid.replace('<details>', '<details open>'),
        code: 'preview-review-not-collapsed',
      },
      {
        name: 'unstyled navigation',
        html: valid.replace('#preview-navigation{', '#stale-navigation{'),
        code: 'preview-navigation-unstyled',
      },
      {
        name: 'missing first-viewport action region',
        html: valid.replace(
          '<div data-viewport-region="primary-action">',
          '<div data-viewport-region="secondary-action">',
        ),
        code: 'preview-primary-action-hierarchy-invalid',
      },
      {
        name: 'missing primary action emphasis',
        html: valid.replace('data-primary-emphasis="', 'data-stale-primary-emphasis="'),
        code: 'preview-primary-action-emphasis-invalid',
      },
      {
        name: 'ineffective page styling',
        html: valid.replace('body{', '.unused-body{'),
        code: 'preview-stylesheet-ineffective',
      },
      {
        name: 'excessive visible evidence',
        html: valid.replace(
          '<div data-product-component="decision-evidence-0">',
          `<div data-product-component="decision-evidence-0">${Array.from(
            { length: 9 },
            (_, index) => `<span data-scenario-evidence-id="extra-${index}">Excess evidence ${index}</span>`,
          ).join('')}`,
        ),
        code: 'preview-visible-evidence-excessive',
      },
      {
        name: 'repeated screen shell',
        html: valid
          .replace(
            /<ol data-product-component="screen-focal-1"([^>]*)>([\s\S]*?)<\/ol>/,
            '<section data-product-component="screen-focal-1"$1>$2</section>',
          )
          .replace(
            /<figure data-product-component="screen-focal-2"([^>]*)>([\s\S]*?)<\/figure>/,
            '<section data-product-component="screen-focal-2"$1>$2</section>',
          ),
        code: 'preview-repeated-screen-shell',
      },
      {
        name: 'visible contract dump vocabulary',
        html: valid.replace('Current journey', 'durable-destination contract'),
        code: 'preview-contract-dump-visible',
      },
      {
        name: 'invented offline runtime UI',
        html: valid.replace('Current journey', 'Offline - retry synchronization'),
        code: 'preview-invented-offline-ui',
      },
      {
        name: 'fixture-only composition marker',
        html: valid.replace(
          '<body ',
          '<body data-composition-id="equipment-command-surface" ',
        ),
        code: 'preview-fixture-marker-leaked',
      },
    ];
    for (const candidate of cases) {
      fs.writeFileSync(previewPath, candidate.html);
      const result = runCli('validate-product-experience-preview.js', [
        '--project-root', projectRoot,
      ], { env: { POWER_PLATFORM_SKILLS_PREVIEW_BROWSER_LAYOUT: '0' } });
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
      ok: true,
      ready: true,
      revision: 'd'.repeat(64),
      colors: {},
      typography: { family: 'Test', size: 22, weight: 700, lineHeight: 1.2, tracking: 0 },
    },
    signatureComponentsSource: 'export interface TestSignatureProps { ready: boolean; }\n',
  });
  assert.deepStrictEqual(contract.requirements.map((item) => item.requirementId), [
    'current-work',
  ]);
});