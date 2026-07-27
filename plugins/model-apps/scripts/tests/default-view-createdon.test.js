'use strict';
// #7 (2026-07-15 review): enriched default views must ship WITHOUT the stock "Created On" column.
// This is a REAL-BUNDLE integration test — it drives the vendored cds-maker-sdk exactly as
// enrichDefaultViews does (fetch the live default view -> updateElement('/columns', ourCols) ->
// push) and asserts the serialized wire payload drops createdon from BOTH the fetchxml and the
// layoutxml. It locks the "replace + reconcile" behavior the finding asked for (not a union), so a
// future re-vendor that regressed to a union would fail here rather than only on a live deploy.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const { defaultViewColumns } = require('../lib/sdk-build.js');

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

// The Dataverse-shipped "Active <Entity>" default view: primary + the stock Created On column, in
// both the query (fetchxml) and the grid (layoutxml). This is what enrichDefaultViews fetches live.
const STOCK_VIEW = {
  savedqueryid: '00000000-0000-0000-0000-0000000000aa',
  name: 'Active New Tasks',
  description: '',
  returnedtypecode: 'new_task',
  querytype: 0,
  isdefault: true,
  fetchxml:
    '<fetch version="1.0" mapping="logical"><entity name="new_task">' +
    '<attribute name="new_name"/><attribute name="createdon"/>' +
    '<order attribute="new_name" descending="false"/></entity></fetch>',
  layoutxml:
    '<grid name="resultset" object="1" jump="new_name" select="1" icon="1" preview="1"><row name="result" id="new_taskid">' +
    '<cell name="new_name" width="300"/><cell name="createdon" width="150"/></row></grid>',
};

function freshSdk(capture) {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'view7-'));
  tempDirs.push(dir);
  const httpClient = {
    get: async (url) => {
      // Single default-view read (fetchArtifact('view', id) -> GET /savedqueries(<id>)?$select=...).
      if (/\/savedqueries\([^)]+\)/.test(url)) return { status: 200, headers: {}, body: STOCK_VIEW };
      // Attribute-metadata lookups during layout normalization resolve to an empty attribute set here.
      return { status: 200, headers: {}, body: {} };
    },
    post: async (u, body) => { if (capture) capture.push({ url: u, body }); return { status: 204, headers: { 'odata-entityid': 'https://x/y(11111111-1111-1111-1111-111111111111)' }, body: {} }; },
    patch: async (u, body) => { if (capture) capture.push({ url: u, body }); return { status: 204, headers: {}, body: {} }; },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return sdk;
}

test('#7 enriching a default view REPLACES the stock createdon column (dropped from fetch + layout)', async () => {
  const spec = {
    solution: { publisherPrefix: 'new' },
    entities: [
      { schemaName: 'new_task', primaryAttribute: { schemaName: 'new_name' }, columns: [
        { schemaName: 'new_status', type: 'Text' },
      ] },
    ],
  };
  const cols = defaultViewColumns(spec, spec.entities[0]).map((c) => c.name);
  assert.ok(!cols.includes('createdon'), 'our column set never contains createdon');

  const capture = [];
  const sdk = freshSdk(capture);
  const id = STOCK_VIEW.savedqueryid;
  // Exactly what provision.enrichDefaultViews does: fetch the live view, replace /columns, push.
  await sdk.fetchArtifact('view', id);
  sdk.updateElement('view', id, '/columns', defaultViewColumns(spec, spec.entities[0]));
  await sdk.pushArtifact('view', id);

  const patch = capture.find((c) => /\/savedqueries\(/.test(c.url) && c.body && (c.body.fetchxml || c.body.layoutxml));
  assert.ok(patch, 'the enriched view was PATCHed to the wire');
  assert.ok(!/name="createdon"/.test(patch.body.fetchxml || ''), 'createdon is removed from the fetchxml');
  assert.ok(!/name="createdon"/.test(patch.body.layoutxml || ''), 'createdon is removed from the layoutxml');
  assert.ok(/name="new_name"/.test(patch.body.layoutxml || ''), 'the primary column is retained');
  assert.ok(/name="new_status"/.test(patch.body.layoutxml || ''), 'the declared scalar column is added');
});
