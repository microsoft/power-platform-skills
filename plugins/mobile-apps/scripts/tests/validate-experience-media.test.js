'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateExperienceMedia } = require('../validate-experience-media');
const { createExperiencePng, inspectPngBuffer } = require('../lib/experience-media');

const mediaFields = ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'];

function makeProject(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-experience-media-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

function pack(policy = 'remote-cdn-cached') {
  return JSON.stringify({
    experience: { contentModel: ['products', 'media'] },
    fixtures: {
      adapter: 'mock-repository',
      mediaPolicy: policy,
      mediaManifest: 'assets/experience/manifest.json',
      assetManifest: 'assets/experience/manifest.json',
      mediaAdapter: 'src/data/media.ts',
      mediaFields,
    },
    screens: [
      { role: 'primary', file: 'app/(app)/home.tsx' },
      { role: 'key-flow', file: 'app/(app)/products/[id].tsx' },
    ],
  });
}

function manifest(png, policy = 'remote-cdn-cached') {
  const inspected = inspectPngBuffer(png);
  const assetKey = 'asset://experience/cr_product-1.png';
  return JSON.stringify({
    schemaVersion: 2,
    assetPolicy: policy,
    assets: {
      [assetKey]: {
        key: assetKey,
        kind: 'bundled-raster',
        family: 'watch',
        label: 'Classic travel watch',
        category: 'Watches',
        source: 'generated-local',
        localPath: 'assets/experience/cr_product-1.png',
        mimeType: 'image/png',
        width: inspected.width,
        height: inspected.height,
        byteLength: inspected.byteLength,
        sha256: crypto.createHash('sha256').update(png).digest('hex'),
        materialized: true,
      },
    },
    media: {
      policy,
      approvedHosts: ['images.unsplash.com'],
      coverage: { expectedRecords: 1, resolvedRecords: 1 },
      records: {
        'cr_product:product-1': {
          imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format',
          imageAltText: 'Classic travel watch in Watches',
          imageCacheKey: 'experience:cr_product:1:v1',
          imageAssetKey: assetKey,
          imageLocalPath: 'assets/experience/cr_product-1.png',
        },
      },
    },
  });
}

function mediaAdapter() {
  return [
    'export type DomainMedia = { imageUrl?: string; imageAltText: string; imageCacheKey?: string; imageAssetKey: string; };',
    'const SOURCES: Record<string, unknown> = {};',
    'export function resolveDomainMedia(media: DomainMedia) {',
    '  const fallbackSource = SOURCES[media.imageAssetKey] || null;',
    '  const remoteSource = media.imageUrl ? { uri: media.imageUrl } : null;',
    '  return { ...media, imageSource: remoteSource || fallbackSource, fallbackSource, sourcePriority: remoteSource ? "remote" : "local" };',
    '}',
  ].join('\n');
}

function disconnectedMediaAdapter() {
  return [
    'export type DomainMedia = { imageUrl?: string; imageAltText: string; imageCacheKey?: string; imageAssetKey: string; };',
    'const SOURCES: Record<string, unknown> = {};',
    'export function resolveDomainMedia(media: DomainMedia) {',
    '  return { ...media, imageSource: SOURCES[media.imageAssetKey] || null, sourcePriority: "remote" };',
    '}',
  ].join('\n');
}

function entityImageSource() {
  return [
    "import { Image as ExpoImage } from 'expo-image';",
    'export function EntityImage({ media }: { media: any }) {',
    '  const imageUrl = media?.imageUrl;',
    '  const fallbackSource = media?.fallbackSource;',
    '  const [remoteFailed, setRemoteFailed] = React.useState(false);',
    '  if (imageUrl && !remoteFailed) return <ExpoImage source={{ uri: imageUrl }} cachePolicy="memory-disk" onError={() => setRemoteFailed(true)} />;',
    '  return fallbackSource ? <ExpoImage source={fallbackSource} cachePolicy="memory-disk" /> : null;',
    '}',
  ].join('\n');
}

function fallbackBlindEntityImageSource() {
  return [
    "import { Image } from 'expo-image';",
    'export function EntityImage({ media }: { media: any }) {',
    '  return <Image source={media.imageSource} cachePolicy="memory-disk" />;',
    '}',
  ].join('\n');
}

function routeSource() {
  return "import { EntityImage } from '@/components';\nimport { resolveDomainMedia } from '@/data';\nexport function Screen() { return <EntityImage media={resolveDomainMedia(item.media)} />; }\n";
}

test('accepts cached CDN media rendered through the canonical adapter', (context) => {
  const png = createExperiencePng({ family: 'watch', seed: 'watch-1' });
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': pack(),
    'assets/experience/manifest.json': manifest(png),
    'assets/experience/cr_product-1.png': png,
    'src/data/media.ts': mediaAdapter(),
    'src/components/index.tsx': entityImageSource(),
    'app/(app)/home.tsx': routeSource(),
    'app/(app)/products/[id].tsx': routeSource(),
  });

  assert.deepEqual(validateExperienceMedia(root), []);
});

test('rejects incomplete fixture media and screen-local remote URLs', (context) => {
  const png = createExperiencePng({ family: 'watch', seed: 'watch-1' });
  const invalidManifest = JSON.parse(manifest(png));
  invalidManifest.media.records['cr_product:product-1'].imageAltText = '';
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': pack(),
    'assets/experience/manifest.json': JSON.stringify(invalidManifest),
    'assets/experience/cr_product-1.png': png,
    'src/data/media.ts': mediaAdapter(),
    'src/components/index.tsx': entityImageSource(),
    'app/(app)/home.tsx': `${routeSource()}\nconst bad = 'https://example.invalid/image.png';`,
    'app/(app)/products/[id].tsx': routeSource(),
  });

  const rules = validateExperienceMedia(root).map((issue) => issue.rule);
  assert.ok(rules.includes('incomplete-media-record'));
  assert.ok(rules.includes('hard-coded-screen-media-url'));
});

test('rejects URL metadata disconnected from the rendered source and a fallback-blind image component', (context) => {
  const png = createExperiencePng({ family: 'watch', seed: 'watch-1' });
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': pack(),
    'assets/experience/manifest.json': manifest(png),
    'assets/experience/cr_product-1.png': png,
    'src/data/media.ts': disconnectedMediaAdapter(),
    'src/components/EntityImage.tsx': fallbackBlindEntityImageSource(),
    'app/(app)/home.tsx': routeSource(),
    'app/(app)/products/[id].tsx': routeSource(),
  });

  const rules = validateExperienceMedia(root).map((issue) => issue.rule);
  assert.ok(rules.includes('remote-media-source-disconnected'));
  assert.ok(rules.includes('remote-media-fallback-disconnected'));
  assert.ok(rules.includes('remote-media-fallback-unused'));
});

test('rejects symbolic local-first identities with no materialized file', (context) => {
  const png = createExperiencePng({ family: 'travel', seed: 'travel-1' });
  const symbolicManifest = JSON.parse(manifest(png, 'local-first'));
  symbolicManifest.assets['asset://experience/cr_product-1.png'] = {
    key: 'asset://experience/cr_product-1.png',
    kind: 'local-illustration',
    family: 'travel',
    label: 'Travel organizer',
  };
  delete symbolicManifest.media.records['cr_product:product-1'].imageLocalPath;
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': pack('local-first'),
    'assets/experience/manifest.json': JSON.stringify(symbolicManifest),
    'src/data/media.ts': mediaAdapter(),
    'app/(app)/home.tsx': routeSource(),
    'app/(app)/products/[id].tsx': routeSource(),
  });

  const rules = validateExperienceMedia(root).map((issue) => issue.rule);
  assert.ok(rules.includes('icon-only-critical-media'));
  assert.ok(rules.includes('media-coverage-drift'));
});

test('rejects corrupt bundled media even when manifest metadata claims coverage', (context) => {
  const png = createExperiencePng({ family: 'beauty', seed: 'beauty-1' });
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': pack('local-first'),
    'assets/experience/manifest.json': manifest(png, 'local-first'),
    'assets/experience/cr_product-1.png': Buffer.from('not-an-image'),
    'src/data/media.ts': mediaAdapter(),
    'app/(app)/home.tsx': routeSource(),
    'app/(app)/products/[id].tsx': routeSource(),
  });

  const rules = validateExperienceMedia(root).map((issue) => issue.rule);
  assert.ok(rules.includes('undecodable-media-file'));
  assert.ok(rules.includes('media-coverage-drift'));
});
