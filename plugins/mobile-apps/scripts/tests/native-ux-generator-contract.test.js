'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

test('screen builder inherits the configured model and requires route shell plus canonical data', () => {
  const builder = read('agents/screen-builder.md');
  assert.doesNotMatch(builder, /^model:/m);
  assert.match(builder, /Route shell and header contract are mandatory/);
  assert.match(builder, /<ScreenShell headerMode=/);
  assert.match(builder, /toExperienceRecord/);
  assert.match(builder, /getExperienceAsset/);
  assert.match(builder, /resolveExperienceMedia/);
  assert.match(builder, /Category-to-catalog context is mandatory/);
  assert.match(builder, /remote-cdn-cached/);
  assert.match(builder, /canonical experience data assets are missing/);
});

test('explicit CDN media and category context remain policy-driven planning inputs', () => {
  const patterns = read('scripts/experience-patterns.js');
  const planner = read('agents/screen-planner.md');
  const dataModel = read('agents/data-model-architect.md');
  assert.match(patterns, /remote-cdn-cached/);
  assert.match(patterns, /cachedCdn/);
  assert.match(planner, /categoryId.*categorySlug/);
  assert.match(planner, /initializes its visible filter/);
  assert.match(dataModel, /imageUrl/);
  assert.match(dataModel, /imageCacheKey/);
  assert.match(dataModel, /imageAssetKey/);
});

test('design-system records brand role and source without recoloring product brands', () => {
  const designSystem = read('skills/design-system/SKILL.md');
  const schema = read('skills/design-system/references/design-system-schema.md');
  assert.match(designSystem, /resolve-brand-context\.js/);
  assert.match(designSystem, /product brand sold[\s\S]*cannot recolor the[\s\S]*host app/i);
  assert.match(designSystem, /Brand role: \{\{brand-context\.brandRole\}\}/);
  assert.match(designSystem, /Brand source: \{\{brand-context\.brandSource\}\}/);
  assert.match(designSystem, /protected[-\s]mark/i);
  assert.match(schema, /Brand role: \{\{app-brand \| product-brand \| integration \| unknown\}\}/);
  assert.match(schema, /Brand source: \{\{supplied \| explicit \| inferred \| none\}\}/);
});

test('root scaffold leaves edge ownership to route shells and maps semantic token values correctly', () => {
  const createApp = read('skills/create-mobile-app/SKILL.md');
  const integration = read('skills/design-system/references/tamagui-integration.md');
  assert.doesNotMatch(createApp, /<SafeAreaView edges=\{\['top', 'bottom'\]\} style=\{\{ flex: 1 \}\}>\s*<Slot\s*\/>/);
  assert.doesNotMatch(createApp, /accentSoft:\s*brandTokens\.color\.accent\s*,/);
  assert.match(createApp, /accentSoft:\s*brandTokens\.color\.accentSoft/);
  assert.match(createApp, /mediaSurface:\s*brandTokens\.color\.mediaSurface/);
  assert.doesNotMatch(integration, /accentSoft:\s*brand\.accent\s*\?\?/);
  assert.match(integration, /accentSoft:\s*brand\.accentSoft\s*\?\?/);
  assert.match(integration, /mediaSurface:\s*brand\.mediaSurface\s*\?\?/);
});

test('shared scaffold exposes the route shell and local illustration recipe boundary', () => {
  const components = read('shared/samples/src/components/index.tsx');
  assert.match(components, /export function ScreenShell/);
  assert.match(components, /SafeAreaView edges=\{\['top', 'bottom'\]\}/);
  assert.match(components, /export type LocalIllustrationRecipe/);
  assert.match(components, /assetRecipe\?: LocalIllustrationRecipe/);
  assert.match(components, /media\?: ExperienceMedia/);
  assert.match(components, /from 'expo-image'/);
  assert.match(components, /cachePolicy="memory-disk"/);
  assert.match(components, /recyclingKey=\{media\?\.imageCacheKey \|\| imageUrl\}/);
  assert.match(components, /onError=\{\(\) => setRemoteFailed\(true\)\}/);
  assert.match(components, /bg="\$mediaSurface"/);
});