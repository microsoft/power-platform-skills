'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, appUniqueName } = require('./helpers/lifecycle-harness.js');
const { validateAppSpec } = require('../lib/app-spec.js');

// Current-layer and sitemap-component proofs add four GETs and replace one name lookup.
// Pin their request shape too, so an unrelated fallback cannot hide inside the total.
// Component type 62 is Site Map:
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodulecomponent
// The command-bar inventory adds two: the `appaction` entity-set lookup and one `appactions` read for up to 20 of the app's tables.
const DOWNLOAD_READS = 85;

const reason = { label: 'Review', state: 'Active', value: 100000042, color: '#336699' };
const key = { schemaName: 'contoso_emailkey', displayName: 'Email Key', columns: ['contoso_email'] };
const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoDetail', displayName: 'Portable Detail', publisherPrefix: 'contoso' },
  app: { name: 'Portable Detail', tables: ['contoso_hidden'] },
  entities: [
    {
      schemaName: 'contoso_item', displayName: 'Item',
      primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name', maxLength: 100 },
      columns: [
        { schemaName: 'contoso_email', displayName: 'Email', type: 'Text', format: 'Email', maxLength: 160 },
        { schemaName: 'contoso_cost', displayName: 'Cost', type: 'Money', minValue: 5, maxValue: 900, precision: 3 },
      ],
      statusReasons: [reason], alternateKeys: [key],
    },
    {
      schemaName: 'contoso_hidden', displayName: 'Hidden',
      primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name', maxLength: 100 },
      columns: [{ schemaName: 'contoso_count', displayName: 'Count', type: 'Integer', minValue: 0, maxValue: 17, integerFormat: 'Duration' }],
    },
  ],
  appShell: { areas: [{ label: 'Work', groups: [{ label: 'Items', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
};

function ran(stage, what) {
  if (stage.error) throw stage.error;
  assert.deepEqual(stage.unexpected, [], `every request ${what} sent is modelled by the strict transport`);
  return stage;
}

async function environment() {
  const org = createLifecycleOrg({ baseLanguage: 1033, provisionedLanguages: [1033, 1036] });
  const root = makeTempDir('portable-detail-');
  const edits = [];
  // Fault only a successfully validated response. The strict fake still checks every requested
  // property and expansion before an optional metadata property is removed or malformed.
  const request = async (req) => {
    const res = await org.request(req);
    if (req.method !== 'GET' || res.statusCode < 200 || res.statusCode >= 300) return res;
    const url = new URL(req.url);
    const body = JSON.parse(res.body);
    for (const edit of edits) edit(url, body);
    return { ...res, body: JSON.stringify(body) };
  };
  const harness = createLifecycleHarness({ ...org, request }, root);
  const built = ran(await harness.measure(() => harness.build(spec)), 'the source build');
  assert.equal(built.value.result.ok, true, JSON.stringify(built.value.result));
  return { org, root, harness, edits };
}

async function download(env, options = {}, name = 'download') {
  const stage = ran(await env.harness.measure(() =>
    env.harness.download(appUniqueName(spec), path.join(env.root, name), options)), 'the download');
  assert.equal(stage.value.emitted.ok, true, JSON.stringify(stage.value.emitted));
  assert.deepEqual(stage.writes, {}, 'download is read-only even when optional detail is unavailable');
  const reads = env.org.requests.slice(stage.mark, stage.end).filter((r) => r.method === 'GET')
    .map((r) => new URL(r.path, env.org.origin));
  assert.equal(reads.filter((url) => url.pathname === '/appmodulecomponents'
    && url.searchParams.get('$select') === 'objectid'
    && (url.searchParams.get('$filter') || '').endsWith(' and componenttype eq 62')).length, 2, 'sitemap identity uses actual components');
  assert.equal(reads.filter((url) => url.pathname === '/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()'
    && url.searchParams.get('$select') === 'appmoduleid,appmoduleidunique,componentstate'
    && (url.searchParams.get('$filter') || '').startsWith('appmoduleid eq ')).length, 3, 'app identity uses the current layer');
  assert.equal(reads.filter((url) => url.pathname === '/sitemaps'
    && (url.searchParams.get('$filter') || '').startsWith('sitemapnameunique eq ')).length, 0, 'a matching name is not sitemap identity');
  assert.deepEqual(validateAppSpec(stage.value.spec, { profile: 'plan', reconstructed: true }).errors, []);
  return stage;
}

function moneyDefinition(org) {
  const column = org.metadata.tables.get('contoso_item').Attributes.get('contoso_cost');
  return Object.fromEntries(['MinValue', 'MaxValue', 'Precision', 'PrecisionSource'].map((k) => [k, column[k]]));
}

for (const [name, source] of [
  ['column precision', 0], ['organization pricing precision', 1], ['transaction currency precision', 2],
  ['missing source', undefined], ['null source', null], ['string source', '2'],
  ['unknown source', 3], ['object source', {}],
]) {
  test(`Money download classifies ${name} without losing the typed column`, async (t) => {
    const env = await environment();
    const raw = env.org.metadata.tables.get('contoso_item').Attributes.get('contoso_cost');
    if (source !== undefined) raw.PrecisionSource = source;
    else env.edits.push((url, body) => {
      if (url.pathname.endsWith('/Microsoft.Dynamics.CRM.MoneyAttributeMetadata')) {
        for (const row of body.value) delete row.PrecisionSource;
      }
    });
    const got = await download(env);
    assert.equal(got.reads, DOWNLOAD_READS, 'classifying Money adds a selected property, not another request');
    const money = got.value.spec.entities.find((e) => e.schemaName === 'contoso_item').columns.find((c) => c.schemaName === 'contoso_cost');
    assert.equal(money.type, 'Money');
    assert.equal(money.minValue, 5);
    assert.equal(money.maxValue, 900);
    if (source === 2) {
      assert.equal(money.precision, 3, 'numeric metadata is retained only for the source the SDK can create');
      assert.doesNotMatch(got.value.stderr, /PrecisionSource.*(?:unsupported|unknown|missing|malformed)/i);
    } else {
      assert.equal(money.precision, undefined, 'a numeric Precision must not masquerade as unsupported source semantics');
      assert.match(got.value.stderr, /Money contoso_cost:.*PrecisionSource/);
      assert.match(got.value.stderr, /build.*(?:always|only).*PrecisionSource 2/i);
      if (source === 0 || source === 1) assert.match(got.value.stderr, new RegExp(`PrecisionSource ${source}`));
      else assert.match(got.value.stderr, /PrecisionSource.*(?:unknown|missing|malformed)/i);
    }
    // Inspect the actual source AND target source selector, not numeric Precision alone.
    if ([0, 1, 2].includes(source)) {
      const original = moneyDefinition(env.org);
      const dir = path.join(env.root, 'download');
      const rebuilt = ran(await env.harness.measure(() => env.harness.build(got.value.spec, {
        appFolder: dir, workspace: path.join(dir, '.maker-workspace'),
      })), 'the source rebuild');
      assert.equal(rebuilt.value.result.ok, true, JSON.stringify(rebuilt.value.result));
      assert.equal(rebuilt.writes['PUT EntityDefinitions/Attributes'] || 0, 0);
      assert.deepEqual(moneyDefinition(env.org), original, 'a rebuild keeps an existing Money column and its precision source');
      const fresh = createLifecycleOrg();
      const target = createLifecycleHarness(fresh, path.join(env.root, 'fresh'));
      const created = ran(await target.measure(() => target.build(got.value.spec)), 'the fresh build');
      assert.equal(created.value.result.ok, true, JSON.stringify(created.value.result));
      const recreated = moneyDefinition(fresh);
      assert.equal(original.PrecisionSource, source);
      assert.equal(recreated.PrecisionSource, 2, 'the real SDK always creates a currency-controlled Money column');
      if (source === 2) assert.deepEqual(recreated, original);
      else assert.notDeepEqual(recreated, original, 'an unsupported source is a diagnosed gap, never exact reconstruction');
    }
    t.diagnostic(`Money ${name}: ${got.reads} GETs, zero writes`);
  });
}

function statusLabels(org, texts, userLanguage) {
  const option = org.metadata.tables.get('contoso_item').Attributes.get('statuscode').OptionSet.Options.find((o) => o.Value === reason.value);
  option.Label = org.metadata.label({ LocalizedLabels: Object.entries(texts).map(([lcid, Label]) => ({ LanguageCode: Number(lcid), Label })) });
  // A user's UI language need not be the build/base language. Keep the raw Dataverse label shape,
  // including its explicit caller projection, while the strict fake serves both translations.
  option.Label.UserLocalizedLabel = structuredClone(option.Label.LocalizedLabels.find((l) => l.LanguageCode === userLanguage));
}

for (const [name, options, pinned, userLanguage, expected] of [
  ['environment base language', {}, undefined, 1036, 'Review'],
  ['explicit --language-code', { languageCode: 1036 }, undefined, 1033, 'Revue'],
  ['authored language pin', {}, 1036, 1033, 'Revue'],
]) {
  test(`status download uses the ${name}, not the caller UI language`, async (t) => {
    const env = await environment();
    statusLabels(env.org, { 1033: 'Review', 1036: 'Revue' }, userLanguage);
    const dir = path.join(env.root, 'download');
    if (pinned) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify({ languageCode: pinned }));
    }
    const got = await download(env, options);
    assert.equal(got.reads, pinned || options.languageCode ? DOWNLOAD_READS - 1 : DOWNLOAD_READS, 'an explicit or pinned LCID reuses the existing no-org-read path');
    const entity = got.value.spec.entities.find((e) => e.schemaName === 'contoso_item');
    assert.deepEqual(entity.statusReasons, [{ ...reason, label: expected }], 'the requested translation, non-default value and color survive');
    const languageCode = options.languageCode || pinned || 1033;
    const rebuilt = ran(await env.harness.measure(() => env.harness.build(got.value.spec, {
      appFolder: dir, workspace: path.join(dir, '.maker-workspace'), languageCode,
    })), 'the unchanged rebuild');
    assert.equal(rebuilt.value.result.ok, true, JSON.stringify(rebuilt.value.result));
    assert.equal(rebuilt.writes['POST InsertStatusValue'] || 0, 0, 'an unchanged valid round trip sends zero status inserts');
    t.diagnostic(`${name}: ${got.reads} download GETs, ${rebuilt.reads} rebuild GETs, zero status inserts`);
  });
}

for (const [name, options, texts, userLanguage, wanted] of [
  ['default translation', {}, { 1036: 'Revue' }, 1036, 1033],
  ['explicit translation', { languageCode: 1036 }, { 1033: 'Review' }, 1033, 1036],
]) {
  test(`status download diagnoses a missing ${name} instead of substituting another LCID`, async () => {
    const env = await environment();
    statusLabels(env.org, texts, userLanguage);
    const got = await download(env, options);
    assert.equal(got.reads, options.languageCode ? DOWNLOAD_READS - 1 : DOWNLOAD_READS, 'a missing translation does not trigger a fallback read');
    assert.equal(got.value.spec.entities.find((e) => e.schemaName === 'contoso_item').statusReasons, undefined);
    assert.match(got.value.stderr, new RegExp(`status reason ${reason.value}:.*label.*${wanted}`));
    assert.doesNotMatch(got.value.stderr, /primary-name column.*could not/);
  });
}

function assertIndependentTableMetadata(got) {
  const entities = got.value.spec.entities;
  assert.deepEqual(entities.map((e) => e.schemaName), ['contoso_item', 'contoso_hidden']);
  for (const e of entities) {
    assert.deepEqual(e.primaryAttribute, { schemaName: 'contoso_name', displayName: 'Name', maxLength: 100 });
    assert.equal(e.existing, true, 'optional key failures do not change teardown ownership');
  }
  assert.deepEqual(entities[0].columns, [
    spec.entities[0].columns[1], spec.entities[0].columns[0],
  ]);
  assert.deepEqual(entities[1].columns, spec.entities[1].columns);
  assert.deepEqual(entities[0].statusReasons, [reason]);
  assert.deepEqual(got.value.spec.app.tables, ['contoso_hidden']);
  assert.deepEqual(got.value.spec.appShell.areas[0].groups[0].subAreas, [{ entity: 'contoso_item', title: 'Items' }]);
  assert.doesNotMatch(got.value.stderr, /primary-name column|table\(s\) were DROPPED|app component table\(s\) were omitted/);
}

for (const [name, keys] of [['object', {}], ['number', 7], ['null', null], ['missing', undefined]]) {
  test(`an unavailable ${name} Keys collection preserves sitemap and component-only table metadata`, async (t) => {
    const env = await environment();
    env.edits.push((url, body) => {
      if (url.searchParams.get('$select') === 'LogicalName,Description,DisplayName,DisplayCollectionName,IconVectorName') {
        if (keys === undefined) delete body.Keys;
        else body.Keys = keys;
      }
    });
    const got = await download(env);
    assert.equal(got.reads, DOWNLOAD_READS, 'an unavailable Keys collection does not add fallback requests');
    assertIndependentTableMetadata(got);
    assert.ok(got.value.spec.entities.every((e) => e.alternateKeys === undefined));
    for (const name of ['contoso_item', 'contoso_hidden']) {
      assert.match(got.value.stderr, new RegExp(`${name}.*alternate keys: the response carried no Keys\\[\\] array`));
    }
    t.diagnostic(`${name} Keys: ${got.reads} GETs, both tables and navigation retained`);
  });
}

for (const malformed of [false, true]) {
  test(`${malformed ? 'a malformed row beside a valid' : 'a valid'} Keys array keeps its independent valid key`, async () => {
    const env = await environment();
    if (malformed) env.edits.push((url, body) => {
      if (url.searchParams.get('$select') === 'LogicalName,Description,DisplayName,DisplayCollectionName,IconVectorName'
        && decodeURIComponent(url.pathname).includes("LogicalName='contoso_item'")) {
        body.Keys.push(null, { SchemaName: 'contoso_broken', KeyAttributes: [] });
      }
    });
    const got = await download(env);
    assertIndependentTableMetadata(got);
    assert.deepEqual(got.value.spec.entities[0].alternateKeys, [key]);
    if (malformed) assert.match(got.value.stderr, /alternate key contoso_broken:.*name or columns could not be read/);
    else assert.doesNotMatch(got.value.stderr, /alternate key/);
  });
}
