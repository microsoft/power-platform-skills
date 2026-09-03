'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { compileNavigationManifest } = require('../compile-navigation-manifest');
const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const {
  renderHtml,
  selectPreviewScreens,
} = require('../render-product-experience-preview');
const { bundleFor } = require('./helpers/product-experience-scenarios');
const { cleanup, makeProjectDir, runCli, writeContracts } = require('./helpers/contract-cli');
const { scenarioFactsForBundle } = require('./helpers/scenario-facts-fixtures');

const VECTOR_PACKAGE = { dependencies: { '@expo/vector-icons': '15.1.1' } };

function navigationForBundle(bundle) {
  return compileNavigationManifest(bundle.scope, VECTOR_PACKAGE);
}

function prepare(projectRoot, bundle) {
  writeContracts(projectRoot, bundle);
  const compiled = runCli('compile-screen-build-pack.js', ['--project-root', projectRoot]);
  assert.strictEqual(compiled.code, 0);
  const navigation = navigationForBundle(bundle);
  fs.writeFileSync(
    path.join(projectRoot, '.tmp', 'navigation-manifest.json'),
    `${JSON.stringify(navigation, null, 2)}\n`,
  );
  const { scenario } = scenarioFactsForBundle(bundle, { navigation });
  fs.writeFileSync(
    path.join(projectRoot, '.tmp', 'scenario-facts.json'),
    `${JSON.stringify(scenario, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(projectRoot, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'brand', 'tokens.ts'), `
export const tokens = {
  color: {
    bg: '#f8f4ed',
    surface: '#ffffff',
    primary: '#5b3fd1',
    accent: '#ece7ff',
    text: '#1c1727',
    textMuted: '#706a7c',
    border: '#ddd6eb',
    statusSuccess: '#2f7d4a',
    statusWarning: '#9a6518',
    statusDanger: '#b23b45',
    statusInfo: '#315ea8',
  },
  typography: {
    heading: { family: 'Avenir Next', size: 23, weight: '700', lineHeight: 1.2, tracking: 0 },
  },
};
`);
}

function screenHtml(html, screenId) {
  const start = html.indexOf(`data-screen="${screenId}"`);
  assert.notStrictEqual(start, -1, `missing ${screenId} preview`);
  const end = html.indexOf('<article class="phone', start + 1);
  return html.slice(start, end === -1 ? html.length : end);
}

function renderBundle(bundle) {
  const navigation = navigationForBundle(bundle);
  const { compiled, scenario } = scenarioFactsForBundle(bundle, { navigation });
  return renderHtml({
    experience: bundle.experience,
    compiled,
    journey: bundle.journey,
    scenario,
    navigation,
  });
}

test('renderer creates a deterministic neutral three-screen commerce storyboard', () => {
  const projectRoot = makeProjectDir('experience-preview');
  try {
    prepare(projectRoot, bundleFor('commerce'));

    const first = runCli('render-product-experience-preview.js', ['--project-root', projectRoot]);
    assert.strictEqual(first.code, 0);
    assert.deepStrictEqual(first.json.screenIds, ['discover', 'product', 'checkout']);
    assert.strictEqual(first.json.previewMode, 'structural');
    assert.strictEqual(first.json.designTokensReady, false);
    assert.strictEqual(first.json.tokenSource, 'neutral-structural');
    assert.strictEqual(first.json.tokenRevision, null);
    assert.strictEqual(first.json.warnings[0].code, 'neutral-structural-preview');

    const outputPath = path.join(projectRoot, '_plan_preview.structural.html');
    const html = fs.readFileSync(outputPath, 'utf8');
    assert.strictEqual((html.match(/<article class="phone/g) || []).length, 3);
    assert.match(html, /class="preview-grid" style="--screen-count:3"/);
    assert.match(html, /<strong>1\. DISCOVER<\/strong>/);
    assert.match(html, /<strong>3\. CHECKOUT<\/strong>/);
    assert.strictEqual((html.match(/class="screen-label"/g) || []).length, 3);
    assert.match(html, /<details class="all-screens">/);
    assert.strictEqual((html.match(/data-graph-screen=/g) || []).length, 5);
    assert.match(html, /data-graph-screen="product"/);
    assert.match(html, /data-graph-screen="checkout"/);
    assert.match(html, /data-run-id="[^"]+"/);
    assert.match(html, /data-contract-fingerprint="[a-f0-9]{64}"/);
    assert.match(html, /data-target-viewport="390x844"/);
    assert.match(html, /class="frame-provenance"/);
    assert.match(html, /data-tone="editorial"/);
    assert.match(html, /data-preview-mode="structural"/);
    assert.match(html, /Neutral structural preview/);
    assert.match(html, /not final visual intent/i);
    assert.match(html, /data-density="sparse"/);
    assert.match(html, /data-navigation-source="manifest"/);
    assert.match(html, /class="stack-return" data-navigation-pattern="stack-only"/);
    assert.match(html, /data-identity-primary=/);
    assert.match(html, /data-chrome-role=/);
    assert.match(html, /data-signature-interaction=/);
    assert.match(html, /href="_build_plan\.html#plan"/);
    assert.match(html, /href="_build_plan\.html#data"/);
    assert.match(html, /href="_build_plan\.html#architecture"/);
    assert.match(html, /href="_build_plan\.html#screens"/);
    assert.doesNotMatch(html, /\.phone\.extra\{display:none\}/);
    assert.doesNotMatch(html, /phone\.style\.display/);
    assert.match(html, /phone\.classList\.toggle\('focused',phone===target\)/);
    assert.match(html, /target\.scrollIntoView\(\{behavior:'smooth',block:'nearest',inline:'center'\}\)/);
    assert.match(html, /data-state="loading"/);
    assert.match(html, /data-state="empty"/);
    assert.match(html, /data-state="error"/);
    assert.match(html, /SAMPLE PREVIEW/);
    assert.match(html, /--primary:#4d514f/);
    assert.doesNotMatch(html, /#5b3fd1/);
    assert.match(html, /data:image\/svg\+xml;base64,/);
    assert.strictEqual((html.match(/class="hero-media"/g) || []).length, 3);
    assert.match(html, /data-target="product"/);
    assert.match(html, /Cloud Runner/);
    assert.match(html, /\$196\.00/);

    const product = screenHtml(html, 'product');
    assert.match(product, /Sticky buy bar/);
    assert.match(product, /data-region="primary-action"/);

    const checkout = screenHtml(html, 'checkout');
    assert.match(checkout, /Place order/);
    assert.match(checkout, /data-region="primary-action"/);
    assert.doesNotMatch(html, /Sample value|Add details|>Sample<|84%/);

    const second = runCli('render-product-experience-preview.js', ['--project-root', projectRoot]);
    assert.strictEqual(second.code, 0);
    assert.strictEqual(second.json.revision, first.json.revision);
    assert.deepStrictEqual(second.json.allScreenIds, [
      'discover',
      'product',
      'cart',
      'checkout',
      'confirmation',
    ]);
    assert.match(second.json.contractFingerprint, /^[a-f0-9]{64}$/);
    assert.strictEqual(second.json.targetViewport, '390x844');
    assert.strictEqual(fs.readFileSync(outputPath, 'utf8'), html);
  } finally {
    cleanup(projectRoot);
  }
});

test('resolved scenario CDN media renders directly and retains its stable asset key', () => {
  const bundle = bundleFor('commerce');
  const navigation = navigationForBundle(bundle);
  const { compiled, scenario } = scenarioFactsForBundle(bundle, { navigation });
  const selectedScreen = selectPreviewScreens(compiled, bundle.journey, navigation)[0];
  const binding = scenario.screenBindings.find(
    (item) => item.screenId === selectedScreen.screenId && item.mediaAssetKeys.length > 0,
  );
  assert.ok(binding);
  const asset = scenario.mediaAssets.find((item) => item.key === binding.mediaAssetKeys[0]);
  asset.source = {
    kind: 'cdn',
    value: 'https://images.example.test/catalog/cloud-runner.jpg',
  };
  const html = renderHtml({
    experience: bundle.experience,
    compiled,
    journey: bundle.journey,
    scenario,
    navigation,
  });
  assert.match(html, /https:\/\/images\.example\.test\/catalog\/cloud-runner\.jpg/);
  assert.match(html, new RegExp(`data-asset-key="${asset.key}"`));
});

test('structural renderer ignores brand tokens and cannot overwrite the final preview', () => {
  const projectRoot = makeProjectDir('experience-preview-structural-boundary');
  try {
    prepare(projectRoot, bundleFor('inspection'));
    const finalPath = path.join(projectRoot, '_plan_preview.html');
    fs.writeFileSync(finalPath, '<!doctype html><title>AI-authored final</title>');

    const structuralResult = runCli('render-product-experience-preview.js', [
      '--project-root', projectRoot,
    ]);
    assert.strictEqual(structuralResult.code, 0);
    assert.strictEqual(structuralResult.json.previewMode, 'structural');
    assert.strictEqual(structuralResult.json.designTokensReady, false);
    assert.strictEqual(structuralResult.json.tokenSource, 'neutral-structural');
    assert.strictEqual(structuralResult.json.warnings[0].code, 'neutral-structural-preview');
    assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), '<!doctype html><title>AI-authored final</title>');
    const structuralPath = path.join(projectRoot, '_plan_preview.structural.html');
    const html = fs.readFileSync(structuralPath, 'utf8');
    assert.match(html, /Neutral structural preview/);
    assert.match(html, /data-preview-mode="structural"/);
    assert.match(html, /--primary:#4d514f/);
    assert.doesNotMatch(html, /#123456|#5b3fd1|Final approved intent preview/);

    const finalModeResult = runCli('render-product-experience-preview.js', [
      '--project-root', projectRoot,
      '--mode', 'final',
    ]);
    assert.strictEqual(finalModeResult.code, 2);
    assert.match(finalModeResult.json.errors[0].message, /unknown argument/);
    assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), '<!doctype html><title>AI-authored final</title>');
  } finally {
    cleanup(projectRoot);
  }
});

test('renderer escapes contract content before placing it in HTML', () => {
  const projectRoot = makeProjectDir('experience-preview-escape');
  try {
    const bundle = bundleFor('community');
    bundle.buildPack.packs[0].previewContent.records[0].subtitle = '<img src=x onerror="alert(1)">';
    prepare(projectRoot, bundle);

    const result = runCli('render-product-experience-preview.js', ['--project-root', projectRoot]);
    assert.strictEqual(result.code, 0);
    const html = fs.readFileSync(path.join(projectRoot, '_plan_preview.structural.html'), 'utf8');
    assert.doesNotMatch(html, /<img src=x onerror="alert\(1\)">/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  } finally {
    cleanup(projectRoot);
  }
});

test('renderer preserves product-specific richness for an unfamiliar domain', () => {
  const projectRoot = makeProjectDir('experience-preview-niche');
  try {
    prepare(projectRoot, bundleFor('niche'));
    const result = runCli('render-product-experience-preview.js', ['--project-root', projectRoot]);
    assert.strictEqual(result.code, 0);

    const html = fs.readFileSync(path.join(projectRoot, '_plan_preview.structural.html'), 'utf8');
    assert.match(html, /GraftRound/);
    assert.match(html, /Rounds due today/);
    assert.match(html, /data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(html, /Sample value|Add details|>Sample<|84%/);
  } finally {
    cleanup(projectRoot);
  }
});

test('first-viewport region order changes the rendered hierarchy', () => {
  const original = bundleFor('commerce');
  const originalHtml = renderBundle(original);

  const reordered = JSON.parse(JSON.stringify(original));
  reordered.buildPack.packs[0].firstViewport.regionOrder = [
    'focal-content',
    'context',
    'primary-action',
  ];
  const reorderedHtml = renderBundle(reordered);

  const originalScreen = screenHtml(originalHtml, 'discover');
  const reorderedScreen = screenHtml(reorderedHtml, 'discover');
  assert.ok(originalScreen.indexOf('data-region="context"') < originalScreen.indexOf('data-region="focal-content"'));
  assert.ok(reorderedScreen.indexOf('data-region="focal-content"') < reorderedScreen.indexOf('data-region="context"'));
  assert.notStrictEqual(originalHtml, reorderedHtml);
});

test('renderer rejects a stale compiled build pack', () => {
  const projectRoot = makeProjectDir('experience-preview-stale');
  try {
    prepare(projectRoot, bundleFor('finance'));
    const compiledPath = path.join(projectRoot, '.tmp', 'compiled-screen-build-pack.json');
    const compiled = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));
    compiled.screens[0].pack.purpose = 'Stale preview purpose that no longer matches';
    fs.writeFileSync(compiledPath, `${JSON.stringify(compiled, null, 2)}\n`);

    const result = runCli('render-product-experience-preview.js', ['--project-root', projectRoot]);
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.json.errors[0].code, 'stale-compiled-artifact');
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '_plan_preview.structural.html')), false);
  } finally {
    cleanup(projectRoot);
  }
});

test('large journeys select primary destination, key-flow entry, and strongest action', () => {
  const screens = Array.from({ length: 7 }, (_, index) => ({
    screenId: `screen-${index}`,
    pack: {},
  }));
  const compiled = { screens };
  const journey = {
    journeys: [{
      steps: screens.map((screen, index) => ({
        order: index + 1,
        surface: { screenId: screen.screenId },
      })),
    }],
  };

  assert.deepStrictEqual(
    selectPreviewScreens(compiled, journey).map((screen) => screen.screenId),
    ['screen-0', 'screen-1', 'screen-6'],
  );
});

test('three-screen journeys use the same visible presentation board', () => {
  const bundle = bundleFor('commerce');
  const result = compileScreenBuildPack(bundle.buildPack, bundle);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  const screens = result.compiled.screens.slice(0, 3);
  const journey = {
    journeys: [{
      steps: bundle.journey.journeys[0].steps.slice(0, 3),
    }],
  };
  const html = renderHtml({
    experience: bundle.experience,
    compiled: { ...result.compiled, screens },
    journey,
  });

  assert.strictEqual((html.match(/<article class="phone/g) || []).length, 3);
  assert.match(html, /class="preview-grid" style="--screen-count:3"/);
  assert.strictEqual((html.match(/class="screen-label"/g) || []).length, 3);
  assert.doesNotMatch(html, /\.phone\.extra\{display:none\}|phone\.style\.display/);
});

test('one- and two-screen primary journeys are not padded with unrelated screens', () => {
  const screens = Array.from({ length: 4 }, (_, index) => ({
    screenId: `screen-${index}`,
    pack: {},
  }));
  const compiled = { screens };
  const journeyFor = (count) => ({
    journeys: [{
      steps: screens.slice(0, count).map((screen, index) => ({
        order: index + 1,
        surface: { screenId: screen.screenId },
      })),
    }],
  });

  assert.deepStrictEqual(
    selectPreviewScreens(compiled, journeyFor(1)).map((screen) => screen.screenId),
    ['screen-0'],
  );
  assert.deepStrictEqual(
    selectPreviewScreens(compiled, journeyFor(2)).map((screen) => screen.screenId),
    ['screen-0', 'screen-1'],
  );
});

test('large-journey actions to omitted screens are visibly disabled', () => {
  const bundle = bundleFor('commerce');
  const basePack = bundle.buildPack.packs[0];
  const screens = Array.from({ length: 7 }, (_, index) => {
    const pack = JSON.parse(JSON.stringify(basePack));
    pack.screenId = `screen-${index}`;
    pack.primaryActions[0].targetScreenId = index < 6 ? `screen-${index + 1}` : undefined;
    return {
      screenId: pack.screenId,
      title: `Screen ${index}`,
      pack,
    };
  });
  const journey = {
    journeys: [{
      steps: screens.map((screen, index) => ({
        order: index + 1,
        surface: { screenId: screen.screenId },
      })),
    }],
  };
  const html = renderHtml({
    experience: bundle.experience,
    compiled: { productComplexity: 'standard', screens },
    journey,
  });

  const flowEntry = screenHtml(html, 'screen-1');
  assert.doesNotMatch(flowEntry, /data-target="screen-2"/);
  assert.match(flowEntry, /disabled aria-disabled="true"/);
  assert.match(flowEntry, /Not shown/);
});
