'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { indexArtifacts } = require('../lib/apply-snapshot-index.js');

function spec() {
  return {
    entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' } }],
    views: [{ entity: 'new_x', name: 'Active X', columns: ['new_name'] }],
    forms: [
      { entity: 'new_x', name: 'Main', formType: 'Main', layout: 'auto' },
      { entity: 'new_x', name: 'Quick', formType: 'QuickCreate', layout: 'auto' },
    ],
    charts: [{ entity: 'new_x', name: 'By Status' }],
    commands: [{ entity: 'new_x', name: 'Approve' }],
    dashboards: [{ name: 'Ops' }],
    webResources: [{ name: 'wr_a', __contentSha: 'wsha1' }],
    pages: [
      { key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'o.tsx' }, __contentSha: 'psha1' },
      { key: 'intent', name: 'Intent', source: { kind: 'intent' } },
    ],
  };
}

// result.created uses the engine's key conventions (views by `entity|name`, Main forms by entity-logical).
function created() {
  return {
    entities: { new_x: 'ent-1' },
    views: { 'new_x|Active X': 'view-1' },
    forms: { new_x: 'form-1' }, // Main only, keyed by entity logical
    charts: { 'By Status': 'chart-1' },
    commands: { new_x: 'cmd-1' },
    dashboards: { Ops: 'dash-1' },
    webResources: { wr_a: 'wr-1' },
    app: 'app-1',
    pages: { overview: 'page-1' }, // intent page not deployed
  };
}

test('indexArtifacts maps every artifact to its live id under canonical identities', () => {
  const a = indexArtifacts(spec(), created());
  assert.deepStrictEqual(a.pages.overview, { pageId: 'page-1', sourceSha: 'psha1', deployedSha: 'psha1' });
  assert.deepStrictEqual(a.views['new_x|Active X'], { viewId: 'view-1' });
  assert.deepStrictEqual(a.forms['new_x|Main|Main'], { formId: 'form-1' });
  assert.strictEqual(a.app.appId, 'app-1');
  assert.deepStrictEqual(a.webResources.wr_a, { id: 'wr-1', sourceSha: 'wsha1' });
  assert.deepStrictEqual(a.entities.new_x, { id: 'ent-1' });
  assert.deepStrictEqual(a.charts['new_x|By Status'], { id: 'chart-1' });
  assert.deepStrictEqual(a.commands['new_x|Approve'], { id: 'cmd-1' });
  assert.deepStrictEqual(a.dashboards.Ops, { id: 'dash-1' });
});

test('an intent page (no created id) is omitted', () => {
  const a = indexArtifacts(spec(), created());
  assert.ok(!('intent' in a.pages));
});

test('a non-Main form is omitted (only Main forms are id-tracked by the engine)', () => {
  const a = indexArtifacts(spec(), created());
  assert.ok(!('new_x|QuickCreate|Quick' in a.forms));
});

test('deployedSha defaults to sourceSha, but a distinct staged deployed hash overrides it', () => {
  const def = indexArtifacts(spec(), created());
  assert.strictEqual(def.pages.overview.deployedSha, 'psha1');
  const staged = indexArtifacts(spec(), created(), { pageDeployedShas: { overview: 'deployed-sha' } });
  assert.strictEqual(staged.pages.overview.deployedSha, 'deployed-sha');
  assert.strictEqual(staged.pages.overview.sourceSha, 'psha1', 'source hash is unchanged');
});

test('optional projection hashes + sitemap hash are recorded when provided', () => {
  const a = indexArtifacts(spec(), created(), {
    formProjections: { 'new_x|Main|Main': 'fproj' },
    viewProjections: { 'new_x|Active X': 'vproj' },
    sitemapSha: 'smap',
  });
  assert.strictEqual(a.forms['new_x|Main|Main'].projSha, 'fproj');
  assert.strictEqual(a.views['new_x|Active X'].projSha, 'vproj');
  assert.strictEqual(a.app.sitemapSha, 'smap');
});

test('missing/empty created maps are defensive (no throw, empty submaps)', () => {
  const a = indexArtifacts(spec(), {});
  assert.deepStrictEqual(a.pages, {});
  assert.deepStrictEqual(a.views, {});
  assert.deepStrictEqual(a.app, {});
  const b = indexArtifacts({}, {});
  assert.deepStrictEqual(b.pages, {});
});

test('a page with no content hash records sourceSha:null (still id-tracked)', () => {
  const s = spec();
  delete s.pages[0].__contentSha;
  const a = indexArtifacts(s, created());
  assert.deepStrictEqual(a.pages.overview, { pageId: 'page-1', sourceSha: null, deployedSha: null });
});
