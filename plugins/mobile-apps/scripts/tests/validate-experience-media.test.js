'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateExperienceMedia } = require('../validate-experience-media');

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

function pack() {
  return JSON.stringify({
    experience: { contentModel: ['products', 'media'] },
    fixtures: {
      adapter: 'local',
      mediaPolicy: 'remote-cdn-cached',
      mediaManifest: 'assets/experience/manifest.json',
      assetManifest: 'assets/experience/manifest.json',
      viewModel: 'src/generated/experience-view-model.ts',
      mediaFields,
    },
    screens: [
      { role: 'primary', file: 'app/(app)/home.tsx' },
      { role: 'key-flow', file: 'app/(app)/products/[id].tsx' },
    ],
  });
}

function manifest() {
  return JSON.stringify({
    assetPolicy: 'remote-cdn-cached',
    media: {
      policy: 'remote-cdn-cached',
      approvedHosts: ['images.unsplash.com'],
      records: {
        'cr_product:product-1': {
          imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format',
          imageAltText: 'Classic travel watch in Watches',
          imageCacheKey: 'experience:cr_product:1:v1',
          imageAssetKey: 'asset://experience/cr_product-1.png',
        },
      },
    },
  });
}

function viewModel() {
  return [
    'export type ExperienceRecord = { imageUrl: string | null; imageAltText: string; imageCacheKey: string; imageAssetKey: string; };',
    'export function resolveExperienceMedia(record: ExperienceRecord) { return record; }',
  ].join('\n');
}

function routeSource() {
  return "import { EntityImage } from '@/components';\nimport { resolveExperienceMedia } from '@/generated/experience-view-model';\nexport function Screen() { return <EntityImage media={resolveExperienceMedia(item)} />; }\n";
}

test('accepts cached CDN media rendered through the canonical adapter', (context) => {
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': pack(),
    'assets/experience/manifest.json': manifest(),
    'src/generated/experience-view-model.ts': viewModel(),
    'app/(app)/home.tsx': routeSource(),
    'app/(app)/products/[id].tsx': routeSource(),
  });

  assert.deepEqual(validateExperienceMedia(root), []);
});

test('rejects incomplete fixture media and screen-local remote URLs', (context) => {
  const invalidManifest = JSON.parse(manifest());
  invalidManifest.media.records['cr_product:product-1'].imageAltText = '';
  const root = makeProject(context, {
    '.tmp/screen-build-pack.json': pack(),
    'assets/experience/manifest.json': JSON.stringify(invalidManifest),
    'src/generated/experience-view-model.ts': viewModel(),
    'app/(app)/home.tsx': `${routeSource()}\nconst bad = 'https://example.invalid/image.png';`,
    'app/(app)/products/[id].tsx': routeSource(),
  });

  const rules = validateExperienceMedia(root).map((issue) => issue.rule);
  assert.ok(rules.includes('incomplete-cdn-media-record'));
  assert.ok(rules.includes('hard-coded-screen-media-url'));
});