'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { verifySpec } = require('../lib/verify-spec.js');
const { sitemapXmlFor } = require('../verify-model-app.js');

const idFor = (set) => ({ savedquery: 'savedqueryid', savedqueryvisualization: 'savedqueryvisualizationid', systemform: 'formid' }[set] || 'id');

test('verifySpec: everything present -> ok', async () => {
  const spec = {
    entities: [{ schemaName: 'new_o', columns: [{ schemaName: 'new_s' }] }],
    views: [{ entity: 'new_o', name: 'V' }],
    charts: [{ entity: 'new_o', name: 'C' }],
    forms: [{ entity: 'new_o', name: 'F' }],
    appShell: { areas: [{ label: 'Main', icon: 'a.png', groups: [{ subAreas: [{ entity: 'new_o', title: 'O', icon: 'ic.png' }] }] }] },
  };
  const read = {
    findTable: async () => ({ logicalName: 'new_o' }),
    findColumns: async () => [{ logicalName: 'new_s' }],
    queryRecords: async (set) => [{ [idFor(set)]: 'id-1' }],
    sitemapXml: async () => '<SiteMap><Area Icon="a.png"><SubArea Entity="new_o" Icon="ic.png"/></Area></SiteMap>',
  };
  const r = await verifySpec(spec, read);
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.ok(r.checks.some((c) => c.kind === 'subarea-icon' && c.present));
});

test('verifySpec: flags a missing column, view, and subarea icon', async () => {
  const spec = {
    entities: [{ schemaName: 'new_o', columns: [{ schemaName: 'new_s' }] }],
    views: [{ entity: 'new_o', name: 'V' }],
    forms: [],
    charts: [],
    appShell: { areas: [{ groups: [{ subAreas: [{ entity: 'new_o', title: 'O', icon: 'ic.png' }] }] }] },
  };
  const read = {
    findTable: async () => ({ logicalName: 'new_o' }),
    findColumns: async () => [], // column missing
    queryRecords: async () => [], // view missing
    sitemapXml: async () => '<SiteMap><SubArea Entity="new_o"/></SiteMap>', // icon missing (subarea present)
  };
  const r = await verifySpec(spec, read);
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.some((m) => m.kind === 'column'));
  assert.ok(r.missing.some((m) => m.kind === 'view'));
  assert.ok(r.missing.some((m) => m.kind === 'subarea-icon'));
  assert.ok(r.checks.some((c) => c.kind === 'subarea' && c.present), 'the subarea itself is present');
});

test('verifySpec: a missing entity skips its column checks', async () => {
  const spec = { entities: [{ schemaName: 'new_o', columns: [{ schemaName: 'new_s' }] }], appShell: { areas: [] } };
  const read = { findTable: async () => null, findColumns: async () => [], queryRecords: async () => [], sitemapXml: async () => '' };
  const r = await verifySpec(spec, read);
  assert.ok(r.missing.some((m) => m.kind === 'entity'));
  assert.ok(!r.checks.some((c) => c.kind === 'column'), 'no column checks when the entity is absent');
});

test('sitemapXmlFor resolves appmodule -> component 62 -> sitemap', async () => {
  const sdk = {
    queryRecords: async (set) => {
      if (set === 'appmodule') return [{ appmoduleid: 'a', appmoduleidunique: 'u-1' }];
      if (set === 'appmodulecomponent') return [{ objectid: 'sm-1', componenttype: 62 }];
      if (set === 'sitemap') return [{ sitemapxml: '<SiteMap/>' }];
      return [];
    },
  };
  assert.strictEqual(await sitemapXmlFor(sdk, 'new_app'), '<SiteMap/>');
});

test('sitemapXmlFor returns empty when the app is not found', async () => {
  const sdk = { queryRecords: async () => [] };
  assert.strictEqual(await sitemapXmlFor(sdk, 'new_missing'), '');
});
