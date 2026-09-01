'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { compileScreenBuildPack } = require('../compile-screen-build-pack');
const {
  readColors,
  renderHtml,
  selectPreviewScreens,
} = require('../render-product-experience-preview');
const { bundleFor } = require('./helpers/product-experience-scenarios');
const { cleanup, makeProjectDir, runCli, writeContracts } = require('./helpers/contract-cli');

function prepare(projectRoot, bundle) {
  writeContracts(projectRoot, bundle);
  const compiled = runCli('compile-screen-build-pack.js', ['--project-root', projectRoot]);
  assert.strictEqual(compiled.code, 0);
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
  const result = compileScreenBuildPack(bundle.buildPack, bundle);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  return renderHtml({
    experience: bundle.experience,
    compiled: result.compiled,
    journey: bundle.journey,
    colors: readColors('/path/that/does/not/exist'),
  });
}

test('renderer creates a deterministic three-screen interactive commerce preview', () => {
  const projectRoot = makeProjectDir('experience-preview');
  try {
    prepare(projectRoot, bundleFor('commerce'));

    const first = runCli('render-product-experience-preview.js', ['--project-root', projectRoot]);
    assert.strictEqual(first.code, 0);
    assert.deepStrictEqual(first.json.screenIds, ['discover', 'cart', 'confirmation']);

    const outputPath = path.join(projectRoot, '_plan_preview.html');
    const html = fs.readFileSync(outputPath, 'utf8');
    assert.strictEqual((html.match(/<article class="phone/g) || []).length, 3);
    assert.match(html, /class="preview-grid" style="--screen-count:3"/);
    assert.match(html, /<strong>1\. DISCOVER<\/strong>/);
    assert.match(html, /<strong>3\. CONFIRMATION<\/strong>/);
    assert.strictEqual((html.match(/class="screen-label"/g) || []).length, 3);
    assert.doesNotMatch(html, /\.phone\.extra\{display:none\}/);
    assert.doesNotMatch(html, /phone\.style\.display/);
    assert.match(html, /phone\.classList\.toggle\('focused',phone===target\)/);
    assert.match(html, /target\.scrollIntoView\(\{behavior:'smooth',block:'nearest',inline:'center'\}\)/);
    assert.match(html, /data-state="loading"/);
    assert.match(html, /data-state="empty"/);
    assert.match(html, /data-state="error"/);
    assert.match(html, /SAMPLE PREVIEW/);
    assert.match(html, /--primary:#5b3fd1/);
    assert.match(html, /data:image\/svg\+xml;base64,/);
    assert.strictEqual((html.match(/class="hero-media"/g) || []).length, 3);
    assert.doesNotMatch(html, /data-target="product"|data-target="checkout"/);
    assert.match(html, /Cloud Runner/);
    assert.match(html, /\$196\.00/);
    assert.match(html, /#SKY-20481/);

    const cart = screenHtml(html, 'cart');
    assert.match(cart, /comparison-media/);
    assert.match(cart, /Cobalt running shoe cart item/);
    assert.match(cart, /Sand canvas tote cart item/);

    const confirmation = screenHtml(html, 'confirmation');
    assert.match(confirmation, /record-thumb/);
    assert.match(confirmation, /Packed SkyShop order/);
    assert.doesNotMatch(html, /Sample value|Add details|>Sample<|84%/);

    const second = runCli('render-product-experience-preview.js', ['--project-root', projectRoot]);
    assert.strictEqual(second.code, 0);
    assert.strictEqual(second.json.revision, first.json.revision);
    assert.strictEqual(fs.readFileSync(outputPath, 'utf8'), html);
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
    const html = fs.readFileSync(path.join(projectRoot, '_plan_preview.html'), 'utf8');
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

    const html = fs.readFileSync(path.join(projectRoot, '_plan_preview.html'), 'utf8');
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
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '_plan_preview.html')), false);
  } finally {
    cleanup(projectRoot);
  }
});

test('large journeys select entry, representative core, and outcome', () => {
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
    ['screen-0', 'screen-3', 'screen-6'],
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
    colors: readColors('/path/that/does/not/exist'),
  });

  assert.strictEqual((html.match(/<article class="phone/g) || []).length, 3);
  assert.match(html, /class="preview-grid" style="--screen-count:3"/);
  assert.strictEqual((html.match(/class="screen-label"/g) || []).length, 3);
  assert.doesNotMatch(html, /\.phone\.extra\{display:none\}|phone\.style\.display/);
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
    colors: readColors('/path/that/does/not/exist'),
  });

  const core = screenHtml(html, 'screen-3');
  assert.doesNotMatch(core, /data-target="screen-4"/);
  assert.match(core, /disabled aria-disabled="true"/);
  assert.match(core, /Not shown/);
});
