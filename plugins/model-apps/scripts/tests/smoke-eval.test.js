'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSmokeSpec, runSmokeAssertions } = require('../smoke-eval.js');
const { validateAppSpec } = require('../lib/app-spec.js');

test('buildSmokeSpec produces a valid spec that exercises icons + default-view enrichment', () => {
  const spec = buildSmokeSpec('t');
  const r = validateAppSpec(spec);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(spec.entities[0].columns.length, 2, 'has extra columns so default views enrich');
  assert.ok(spec.appShell.areas[0].groups[0].subAreas[0].icon, 'subarea has a raster icon');
  assert.strictEqual(spec.appShell.areas[0].groups[0].subAreas[0].vectorIcon, 'Grid');
});

test('runSmokeAssertions passes when the deployed app is correct', async () => {
  const spec = buildSmokeSpec('t');
  const read = {
    queryRecords: async () => [{ name: 'Active t Orders', layoutxml: '<grid><row><cell name="new_name"/><cell name="new_status"/></row></grid>' }],
    sitemapXml: async () => '<SiteMap><SubArea Icon="new_ticon.png" VectorIcon="Grid"/></SiteMap>',
  };
  const results = await runSmokeAssertions(spec, 'app-1', read);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
});

test('runSmokeAssertions fails when enrichment or icons are missing', async () => {
  const spec = buildSmokeSpec('t');
  const read = {
    queryRecords: async () => [{ name: 'Active t Orders', layoutxml: '<grid><row><cell name="new_name"/></row></grid>' }],
    sitemapXml: async () => '<SiteMap><SubArea/></SiteMap>',
  };
  const results = await runSmokeAssertions(spec, 'app-1', read);
  assert.ok(results.some((r) => !r.ok && /enriched/.test(r.name)), 'enrichment assertion should fail');
  assert.ok(results.some((r) => !r.ok && /Icon/.test(r.name)), 'icon assertion should fail');
});
