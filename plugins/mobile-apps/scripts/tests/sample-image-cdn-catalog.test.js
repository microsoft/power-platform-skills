'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const catalogPath = path.join(PLUGIN_ROOT, 'shared', 'references', 'sample-image-cdn-catalog.json');
const skillPath = path.join(PLUGIN_ROOT, 'skills', 'add-sample-data', 'SKILL.md');

test('sample image CDN catalog contains fixed, allowlisted, attributable URLs', () => {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.strictEqual(catalog.rules.allowedHost, 'images.unsplash.com');
  assert.strictEqual(catalog.rules.fixedPhotoIdsOnly, true);
  assert.strictEqual(catalog.rules.allowRandomEndpoints, false);
  assert.ok(catalog.images.length >= 10);

  const ids = new Set();
  const urls = new Set();
  for (const image of catalog.images) {
    assert.ok(!ids.has(image.id), `duplicate catalog id ${image.id}`);
    assert.ok(!urls.has(image.cdnUrl), `duplicate catalog URL ${image.cdnUrl}`);
    ids.add(image.id);
    urls.add(image.cdnUrl);

    const url = new URL(image.cdnUrl);
    assert.strictEqual(url.protocol, 'https:');
    assert.strictEqual(url.hostname, catalog.rules.allowedHost);
    assert.match(url.pathname, /^\/photo-[a-z0-9-]+$/);
    assert.strictEqual(url.searchParams.get('fit'), 'crop');
    assert.strictEqual(url.searchParams.get('w'), String(catalog.rules.defaultWidth));
    assert.strictEqual(url.searchParams.get('h'), String(catalog.rules.defaultHeight));
    assert.ok(image.tags.length >= 3);
    const source = new URL(image.source);
    assert.strictEqual(source.protocol, 'https:');
    assert.strictEqual(source.hostname, catalog.rules.allowedHost);
    assert.strictEqual(source.pathname, url.pathname);
    assert.strictEqual(source.search, '');
  }
});

test('sample data skill requires CDN coverage only for explicit URL text columns', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');
  assert.match(skill, /Remote record imagery is the default for explicit image-URL text columns/);
  assert.match(skill, /min\(3, seeded record count\)/);
  assert.match(skill, /Do not put CDN URLs into File\/Image columns/);
  assert.match(skill, /sample-image-cdn-catalog\.json/);
  assert.match(skill, /do not construct an Unsplash search\/source URL or use a random placeholder service/i);
});
