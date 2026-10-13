'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runTeardown: engineTeardown, KIND_HANDLERS } = require('../lib/sdk-teardown.js');

const runTeardown = (spec, opts, deps) => engineTeardown(spec, { env: 'https://contoso.crm.dynamics.com', ...opts }, deps);
const PARTIAL_ENRICHMENT = Symbol.for('cds-maker-sdk.partialDefaultViewEnrichment');
const bundleWorkspaces = [];

test.after(() => {
  for (const dir of bundleWorkspaces) fs.rmSync(dir, { recursive: true, force: true });
});

function teardownSpec(resetCount) {
  const entities = [{
    schemaName: 'cnt_parent',
    primaryAttribute: { schemaName: 'cnt_name' },
    columns: [{ schemaName: 'cnt_code', type: 'Text' }],
  }];
  const relationships = [];
  for (let i = 1; i <= resetCount; i += 1) {
    entities.push({
      schemaName: `cnt_child${i}`,
      primaryAttribute: { schemaName: 'cnt_name' },
      columns: [{ schemaName: `cnt_code${i}`, type: 'Text' }],
    });
    relationships.push({
      type: 'OneToMany',
      referenced: 'cnt_parent',
      referencing: `cnt_child${i}`,
      lookup: { schemaName: `cnt_ParentId${i}` },
    });
  }
  return {
    solution: { uniqueName: 'ContosoTeardown', publisherPrefix: 'cnt' },
    entities,
    relationships,
  };
}

function makeTeardownSdk({
  envelope,
  envelopeThrows,
  publishOne,
  partialFailure,
  withBatch = true,
} = {}) {
  const calls = [];
  const publishByTable = new Map();
  const sdk = {
    resolveArtifact: async (kind, identity) => {
      calls.push({ method: 'resolveArtifact', kind, identity });
      return kind === 'solution' ? [{ id: 'sol-1', name: identity.uniqueName }] : [];
    },
    enrichDefaultViews: async (logical, cols, opts) => {
      calls.push({ method: 'enrichDefaultViews', logical, cols, opts });
      const publishTarget = { type: 'view', id: `view-${logical}` };
      publishByTable.set(logical, publishTarget);
      const pendingPublish = [{ scope: { envelope: 'entity', entityLogicalName: logical }, artifacts: [publishTarget] }];
      if (partialFailure && partialFailure[logical]) {
        const inner = new Error(`partial save for ${logical}`);
        inner[PARTIAL_ENRICHMENT] = { updated: [publishTarget.id], results: [], pendingPublish };
        throw new Error(`wrapped ${logical}`, { cause: inner });
      }
      if (opts && opts.publish === false) return { updated: [publishTarget.id], results: [], pendingPublish };
      return { updated: [publishTarget.id] };
    },
    publishArtifact: async (type, id) => {
      calls.push({ method: 'publishArtifact', type, id });
      if (typeof publishOne === 'function') return publishOne(type, id);
      return { type, id, shipped: true, publish: { kind: 'verified' } };
    },
    deleteRelationship: async (schemaName) => {
      calls.push({ method: 'deleteRelationship', schemaName });
    },
    deleteTable: async (logical) => {
      calls.push({ method: 'deleteTable', logical });
    },
    deleteSolution: async (id) => {
      calls.push({ method: 'deleteSolution', id });
    },
  };
  if (withBatch) {
    sdk.publishArtifacts = async (targets) => {
      calls.push({ method: 'publishArtifacts', targets });
      if (typeof envelopeThrows === 'function') throw envelopeThrows(targets);
      if (envelopeThrows) throw envelopeThrows;
      if (typeof envelope === 'function') return envelope(targets);
      return targets.map(({ type, id }) => ({ type, id, shipped: true, publish: { kind: 'verified' } }));
    };
  }
  return { sdk, calls, publishByTable };
}

function callNames(calls) {
  return calls.map((call) => call.method);
}

function lastIndex(calls, method) {
  return calls.map((call) => call.method).lastIndexOf(method);
}

function count(calls, method) {
  return calls.filter((call) => call.method === method).length;
}

function guid(seed) {
  return `${seed}${seed}${seed}${seed}${seed}${seed}${seed}${seed}-0000-4000-8000-00000000000${seed}`;
}

function generatedFetch(entity, statecode) {
  return (
    `<fetch version="1.0" mapping="logical"><entity name="${entity}"><attribute name="${entity}id" />` +
    `<filter type="and"><condition attribute="statecode" operator="eq" value="${statecode}" /></filter>` +
    `</entity></fetch>`
  );
}

function bundleHarness(entities) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-publish-once-'));
  bundleWorkspaces.push(workspace);
  const GENERATED_AT = '2026-09-30T10:00:00Z';
  const rows = {};
  const byEntity = {};
  const posts = [];
  entities.forEach((entity, index) => {
    const active = guid(String(index + 1));
    const inactive = guid(String(index + 4));
    byEntity[entity] = [active, inactive];
    rows[active] = {
      savedqueryid: active,
      name: `Active ${entity}`,
      description: '',
      returnedtypecode: entity,
      querytype: 0,
      isdefault: true,
      fetchxml: generatedFetch(entity, 0),
      layoutxml: `<grid name="resultset" object="1" jump="${entity}_name" select="1" icon="1" preview="1"><row name="result" id="${entity}id"><cell name="${entity}_name" width="300" /></row></grid>`,
    };
    rows[inactive] = {
      savedqueryid: inactive,
      name: `Inactive ${entity}`,
      description: '',
      returnedtypecode: entity,
      querytype: 0,
      isdefault: false,
      fetchxml: generatedFetch(entity, 1),
      layoutxml: `<grid name="resultset" object="1" jump="${entity}_name" select="1" icon="1" preview="1"><row name="result" id="${entity}id"><cell name="${entity}_name" width="300" /></row></grid>`,
    };
  });
  const rowFor = (decodedUrl) => {
    const match = decodedUrl.match(/\/savedqueries\(([^)]+)\)/);
    return match ? rows[match[1]] : null;
  };
  const httpClient = {
    get: async (url) => {
      const decoded = decodeURIComponent(url);
      if (decoded.includes('/savedqueries?') && decoded.includes('querytype eq 0')) {
        const entity = (decoded.match(/returnedtypecode eq '([^']+)'/) || [])[1];
        const ids = byEntity[entity] || [];
        return {
          status: 200,
          headers: {},
          body: {
            value: ids.map((id, i) => ({
              savedqueryid: id,
              name: `${i === 0 ? 'Active' : 'Inactive'} ${entity}`,
              isdefault: i === 0,
              canbedeleted: { Value: false },
              fetchxml: generatedFetch(entity, i),
              createdon: GENERATED_AT,
            })),
          },
        };
      }
      const row = rowFor(decoded);
      if (row) return { status: 200, headers: { etag: 'W/"1"' }, body: row };
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => {
      posts.push({ url: decodeURIComponent(url), body });
      return {
        status: 204,
        headers: { 'odata-entityid': 'https://example.crm.dynamics.com/api/data/v9.0/any(11111111-1111-1111-1111-111111111111)' },
        body: {},
      };
    },
    patch: async (url, body) => {
      const row = rowFor(decodeURIComponent(url));
      Object.assign(row, body);
      return { status: 204, headers: {}, body: {} };
    },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(workspace),
    instanceUrl: 'https://example.crm.dynamics.com',
    httpClient,
  });
  return { sdk, posts };
}

function realBundleTeardownSpec(entities) {
  return {
    entities: [
      {
        schemaName: 'p5_parent',
        existing: true,
        enrichDefaultViews: false,
        primaryAttribute: { schemaName: 'p5_name' },
        columns: [{ schemaName: 'p5_code', type: 'Text' }],
      },
      ...entities.map((entity, index) => ({
        schemaName: entity,
        existing: true,
        enrichDefaultViews: true,
        primaryAttribute: { schemaName: `${entity}_name` },
        columns: [{ schemaName: `${entity}_code`, type: 'Text' }],
      })),
    ],
    relationships: entities.map((entity, index) => ({
      type: 'OneToMany',
      referenced: 'p5_parent',
      referencing: entity,
      lookup: { schemaName: `p5_ParentId${index + 1}` },
    })),
  };
}

test('batches K=3, keeps K=1 as one publish, and leaves the legacy immediate path unchanged', async () => {
  const batched = makeTeardownSdk();
  const result = await runTeardown(teardownSpec(3), { apply: true }, { sdk: batched.sdk, emit: () => {} });
  assert.equal(result.ok, true);
  assert.equal(count(batched.calls, 'publishArtifacts'), 1, callNames(batched.calls).join(' -> '));
  assert.equal(count(batched.calls, 'publishArtifact'), 0);
  assert.deepEqual(
    batched.calls.find((call) => call.method === 'publishArtifacts').targets,
    [
      { type: 'view', id: 'view-cnt_child1' },
      { type: 'view', id: 'view-cnt_child2' },
      { type: 'view', id: 'view-cnt_child3' },
    ],
  );
  batched.calls
    .filter((call) => call.method === 'enrichDefaultViews')
    .forEach((call) => assert.equal(call.opts.publish, false, `${call.logical} should defer the publish`));

  const single = makeTeardownSdk();
  await runTeardown(teardownSpec(1), { apply: true }, { sdk: single.sdk, emit: () => {} });
  assert.equal(count(single.calls, 'publishArtifacts'), 0);
  assert.equal(count(single.calls, 'publishArtifact'), 1);
  assert.deepEqual(single.calls.find((call) => call.method === 'publishArtifact'), { method: 'publishArtifact', type: 'view', id: 'view-cnt_child1' });

  const legacyCalls = [];
  await KIND_HANDLERS.resetDefaultViews.del({
    enrichDefaultViews: async (...args) => { legacyCalls.push(args); return { updated: ['view-cnt_child1'] }; },
  }, { id: 'cnt_child1', cols: [{ name: 'cnt_name' }] });
  assert.deepEqual(legacyCalls, [['cnt_child1', [{ name: 'cnt_name' }]]], 'the direct two-argument call keeps the old immediate SDK contract');

  const legacy = makeTeardownSdk({ withBatch: false });
  await runTeardown(teardownSpec(1), { apply: true }, { sdk: legacy.sdk, emit: () => {} });
  assert.equal(count(legacy.calls, 'publishArtifacts'), 0);
  assert.equal(count(legacy.calls, 'publishArtifact'), 0);
  assert.deepEqual(legacy.calls.find((call) => call.method === 'enrichDefaultViews').opts, undefined, 'a legacy SDK shape keeps the old enrich-and-publish call');
});

test('publishes after the last reset and before the first relationship delete without moving other teardown order', async () => {
  const { sdk, calls } = makeTeardownSdk();
  await runTeardown(teardownSpec(3), { apply: true }, { sdk, emit: () => {} });
  const publishIndex = calls.findIndex((call) => call.method === 'publishArtifacts');
  assert.ok(lastIndex(calls, 'enrichDefaultViews') < publishIndex, callNames(calls).join(' -> '));
  assert.ok(publishIndex < calls.findIndex((call) => call.method === 'deleteRelationship'), callNames(calls).join(' -> '));
  assert.ok(lastIndex(calls, 'deleteRelationship') < calls.findIndex((call) => call.method === 'deleteTable'), callNames(calls).join(' -> '));
  assert.ok(lastIndex(calls, 'deleteTable') < calls.findIndex((call) => call.method === 'deleteSolution'), callNames(calls).join(' -> '));
});

test('envelope failure falls back per target, names only the unpublished table, and a partial reset still gets published', async () => {
  const warnings = [];
  const { sdk, calls } = makeTeardownSdk({
    partialFailure: { cnt_child2: true },
    envelope: (targets) => targets.map(({ type, id }) => ({
      type,
      id,
      shipped: false,
      publish: { kind: 'failed', error: new Error('envelope failed') },
    })),
    publishOne: async (type, id) => {
      if (id === 'view-cnt_child3') return { type, id, shipped: false, publish: { kind: 'failed', error: new Error('single publish failed') } };
      return { type, id, shipped: true, publish: { kind: 'verified' } };
    },
  });
  const result = await runTeardown(teardownSpec(3), { apply: true }, { sdk, emit: () => {}, warn: (message) => warnings.push(message) });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(count(calls, 'publishArtifacts'), 1);
  assert.deepEqual(
    calls.filter((call) => call.method === 'publishArtifact').map((call) => call.id),
    ['view-cnt_child1', 'view-cnt_child2', 'view-cnt_child3'],
  );
  assert.equal(count(calls, 'deleteRelationship'), 3, 'relationship teardown still runs');
  assert.deepEqual(warnings, result.warnings);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /cnt_child3/);
  assert.doesNotMatch(warnings[0], /cnt_child1|cnt_child2/);
  assert.match(warnings[0], /saved but may still be unpublished/i);
  assert.match(warnings[0], /lookup as still referenced/i);
});

test('a thrown publishArtifacts preflight still falls back, and a later emit failure settles the owed publish exactly once', async () => {
  const refused = makeTeardownSdk({
    partialFailure: { cnt_child2: true },
    envelopeThrows: new Error('target not in workspace'),
  });
  const result = await runTeardown(teardownSpec(2), { apply: true }, { sdk: refused.sdk, emit: () => {} });
  assert.equal(result.ok, true);
  assert.equal(count(refused.calls, 'publishArtifacts'), 1);
  assert.deepEqual(
    refused.calls.filter((call) => call.method === 'publishArtifact').map((call) => call.id),
    ['view-cnt_child1', 'view-cnt_child2'],
  );

  const thrown = makeTeardownSdk();
  await assert.rejects(
    runTeardown(teardownSpec(2), { apply: true }, {
      sdk: thrown.sdk,
      emit: (event) => {
        if (event.phase === 'relationships' && event.status === 'start') throw new Error('emit boom');
      },
    }),
    /emit boom/,
  );
  assert.equal(count(thrown.calls, 'publishArtifacts'), 1, callNames(thrown.calls).join(' -> '));
  assert.equal(count(thrown.calls, 'publishArtifact'), 0);
  assert.equal(count(thrown.calls, 'deleteRelationship'), 0, 'the throw stops the relationship step after the publish barrier is settled');
});

test('the real vendored bundle turns three per-table PublishXml requests into one deferred envelope', async () => {
  const entities = ['p5_alpha', 'p5_beta', 'p5_gamma'];

  const before = bundleHarness(entities);
  await before.sdk.initWorkspace();
  for (const entity of entities) {
    await before.sdk.enrichDefaultViews(entity, [{ name: `${entity}_name` }, { name: 'createdon' }]);
  }
  const beforePublishes = before.posts.filter((call) => call.url.endsWith('/PublishXml'));
  assert.equal(beforePublishes.length, 3, JSON.stringify(beforePublishes.map((call) => call.body)));

  const after = bundleHarness(entities);
  await after.sdk.initWorkspace();
  after.sdk.deleteRelationship = async () => {};
  await runTeardown(realBundleTeardownSpec(entities), { apply: true }, { sdk: after.sdk, emit: () => {} });
  const afterPublishes = after.posts.filter((call) => call.url.endsWith('/PublishXml'));
  assert.equal(afterPublishes.length, 1, JSON.stringify(afterPublishes.map((call) => call.body)));
  assert.match(afterPublishes[0].body.ParameterXml, /<entity>p5_alpha<\/entity>.*<entity>p5_beta<\/entity>.*<entity>p5_gamma<\/entity>/);
});
