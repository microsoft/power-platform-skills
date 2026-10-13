'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifySpec } = require('../lib/verify-spec.js');
const { readerFor } = require('../verify-model-app.js');
const { membershipSpec, APP, PUBLISHED, CURRENT, FORM_A, FORM_B, DASHBOARD, META } = require('./helpers/app-membership-sdk.js');
const QUICK = '33333333-0000-4000-8000-000000000004';
const UNKNOWN = '33333333-0000-4000-8000-000000000005';

function fixture({ tableIds = [META.contoso_item, META.task], members = [FORM_A], inactiveExtra = false, unclassifiable = false, status = 200 } = {}) {
  const calls = [];
  const catalog = [
    { formid: FORM_A, name: 'Summary', type: 2, objecttypecode: 'contoso_item', formactivationstate: 1 },
    { formid: FORM_B, name: 'Alternate', type: 2, objecttypecode: 'contoso_item', formactivationstate: inactiveExtra ? 0 : 1 },
    { formid: DASHBOARD, name: 'Overview', type: 0, objecttypecode: 'none' },
    { formid: QUICK, name: 'Summary', type: 6, objecttypecode: 'contoso_item' },
  ];
  const sdk = {
    findTables: async () => [],
    findColumns: async () => [],
    queryRecords: async (set, opts = {}) => {
      calls.push({ set, opts });
      if (set === 'appmodule') return [{ appmoduleid: APP, appmoduleidunique: PUBLISHED }];
      if (set === 'appmodulecomponent') {
        if (opts.filter.includes('componenttype eq 1')) return tableIds.map((objectid) => ({ objectid, componenttype: 1 }));
        return [];
      }
      return [];
    },
    dataverse: { get: async (url) => {
      calls.push({ url });
      const logical = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (logical) return META[logical[1]] ? { status: 200, body: { MetadataId: META[logical[1]] } } : { status: 404, body: null };
      if (url.startsWith('/appmodulecomponents')) {
        assert.ok(url.includes(PUBLISHED), 'verification must address the published layer');
        assert.ok(!url.includes(CURRENT));
        return { status, body: { value: members.map((objectid) => ({ objectid, componenttype: 60 })) } };
      }
      if (url.startsWith('/systemforms')) {
        const rows = url.includes("objecttypecode eq 'contoso_item'")
          ? catalog.filter((row) => row.type === 2)
          : catalog.filter((row) => !unclassifiable && url.includes(`formid eq ${row.formid}`));
        return { status, body: { value: rows } };
      }
      assert.fail(`unexpected verification read ${url}`);
    } },
  };
  const read = readerFor(sdk, 'contoso_membership');
  read.sitemapXml = async () => '<SiteMap><Area><Group><SubArea Entity="contoso_item" Title="Items"/></Group></Area></SiteMap>';
  const spec = membershipSpec();
  spec.entities = [];
  return { sdk, read, calls, spec };
}

test('published table membership verifies navigation union app.tables, without duplicates', async () => {
  const { read, spec } = fixture({ tableIds: [META.contoso_item] });
  spec.app.tables = ['task', 'CONTOSO_ITEM'];
  delete spec.app.mainForms;
  const result = await verifySpec(spec, read);
  const tables = result.checks.filter((check) => check.kind === 'app-table-component');
  assert.deepEqual(tables.map((check) => check.name), ['contoso_item', 'task']);
  assert.equal(tables.find((check) => check.name === 'task').present, false);
  assert.equal(result.ok, false);
});

test('hidden-only membership is checked even with no navigation tables', async () => {
  const { read, spec } = fixture();
  spec.appShell.areas = [];
  delete spec.app.mainForms;
  const result = await verifySpec(spec, read);
  assert.ok(result.checks.some((check) => check.kind === 'app-table-component' && check.name === 'task' && check.present));
});

test('an explicitly requested hidden-table check cannot pass with an absent or throwing reader', async () => {
  for (const fail of [false, true]) {
    const { read, spec } = fixture();
    delete spec.app.mainForms;
    if (fail) read.appEntityComponents = async () => { throw new Error('403 forbidden'); };
    else delete read.appEntityComponents;
    const result = await verifySpec(spec, read);
    assert.ok(result.missing.some((check) => check.kind === 'app-table-component' && /unverified|could not be read/.test(check.detail)));
  }
});

test('readerFor plus verifySpec proves an exact published Main-form set', async () => {
  const { read, spec, calls } = fixture();
  const result = await verifySpec(spec, read);
  const check = result.checks.find((entry) => entry.kind === 'app-main-forms');
  assert.ok(check, 'the new membership check must run through the real reader');
  assert.equal(check.name, 'contoso_item');
  assert.equal(check.present, true, check.detail);
  assert.ok(!calls.some((call) => call.url && call.url.includes('RetrieveUnpublishedMultiple')));
  assert.ok(calls.some((call) => call.url && /componenttype eq 60/.test(call.url)));
});

test('Main-form verify names missing members and the rebuild remedy', async () => {
  const { read, spec } = fixture({ members: [] });
  const result = await verifySpec(spec, read);
  const check = result.missing.find((entry) => entry.kind === 'app-main-forms');
  assert.ok(check);
  assert.match(check.detail, /Summary.*missing.*re-run the build/i);
});

test('Main-form verify counts inactive extras and names the Maker removal remedy', async () => {
  const { read, spec } = fixture({ members: [FORM_A, FORM_B], inactiveExtra: true });
  const result = await verifySpec(spec, read);
  const check = result.missing.find((entry) => entry.kind === 'app-main-forms');
  assert.ok(check);
  assert.match(check.detail, /Alternate.*existing app.*Maker.*Forms/);
});

test('Main-form verify excludes dashboards and same-named QuickView components', async () => {
  const { read, spec } = fixture({ members: [FORM_A, DASHBOARD, QUICK] });
  const result = await verifySpec(spec, read);
  const check = result.checks.find((entry) => entry.kind === 'app-main-forms');
  assert.ok(check && check.present, check && check.detail);
});

test('unreadable and unclassifiable Main-form membership are unverified, never passing', async () => {
  for (const opts of [
    { status: 403 }, { members: [FORM_A, UNKNOWN] }, { unclassifiable: true },
    { members: [FORM_A, 'not-a-form-id'] }, { members: [FORM_A, null] },
  ]) {
    const { read, spec } = fixture(opts);
    const result = await verifySpec(spec, read);
    const check = result.checks.find((entry) => entry.kind === 'app-main-forms');
    assert.ok(check);
    assert.equal(check.present, false);
    assert.match(check.detail, /unverified/i);
  }
});

test('an unavailable Main-form reader or a missing table result cannot silently skip a declared list', async () => {
  for (const response of [undefined, { kind: 'read', tables: [] }]) {
    const { read, spec } = fixture();
    if (response === undefined) delete read.appMainForms;
    else read.appMainForms = async () => response;
    const result = await verifySpec(spec, read);
    assert.ok(result.missing.some((check) => check.kind === 'app-main-forms' && /unverified/.test(check.detail)));
  }
});

test('Main-form verify emits no restriction check for an omitted or empty map', async () => {
  for (const directive of [undefined, {}]) {
    const { read, spec } = fixture();
    spec.app.mainForms = directive;
    const result = await verifySpec(spec, read);
    assert.ok(!result.checks.some((check) => check.kind === 'app-main-forms'));
  }
});
