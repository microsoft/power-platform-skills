'use strict';
// A view's filter can hold a `<link-entity>`: a condition on RELATED rows ("accounts with a contact that has an email address",
// `link-type="any"`). The SDK keeps such a filter — the conditions beside the link-entity in the same `<filter>` included —
// only in its own copy of the view's FetchXML, so the typed `filters` of a fetched view are EMPTY for it.
//
// Nothing the plugin does reads a view's filters through that typed tree, and these tests pin why it loses nothing:
//   - the build changes an existing view's columns and description and nothing else of its query, and the SDK writes the
//     filter back as it was (rebuild-writes-real-bundle.test.js drives that through a whole rebuild);
//   - a download carries no view at all — `views[]` is emitted empty and each deployed view is only named in the report of
//     what the spec leaves out — so a filter the typed tree cannot show is never half-emitted.
// If a later bundle fills the typed tree, or a later download reads a view's query, these are the tests to look at again.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { readDescriptionInventory, notRoundTrippedSummary, notRoundTrippedWarning } = require('../download-model-app.js');
const { hydrateSpec } = require('../lib/hydrate-spec.js');
const { currentReadSdk, APP, CURRENT } = require('./helpers/app-membership-sdk.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const VIEW_ID = '00000000-0000-4000-8000-0000000000bb';
const VIEW_NAME = 'Accounts with a reachable contact';

// The related-rows filter, as FetchXML writes it: the `<link-entity>` is a child of the `<filter>`, beside a plain condition.
const RELATED_FILTER = '<filter type="and"><condition attribute="statecode" operator="eq" value="0" />'
  + '<link-entity name="contact" from="parentcustomerid" to="accountid" link-type="any">'
  + '<filter type="and"><condition attribute="emailaddress1" operator="not-null" /></filter></link-entity></filter>';
const VIEW_FETCH = `<fetch version="1.0" mapping="logical"><entity name="account"><attribute name="name" /><attribute name="accountid" /><order attribute="name" descending="false" />${RELATED_FILTER}</entity></fetch>`;
const VIEW_LAYOUT = '<grid name="resultset" object="1" jump="name" select="1" icon="1" preview="1"><row name="result" id="accountid"><cell name="name" width="300" /></row></grid>';

const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

test('REAL BUNDLE: a view whose filter holds a related-rows link-entity has no typed filters — the whole filter lives in the SDK\u2019s copy of the query, which a column edit writes back', async () => {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'view-related-'));
  dirs.push(dir);
  const patches = [];
  const row = { '@odata.etag': 'W/"4180012"', savedqueryid: VIEW_ID, name: VIEW_NAME, description: '', returnedtypecode: 'account', querytype: 0, isdefault: false, fetchxml: VIEW_FETCH, layoutxml: VIEW_LAYOUT };
  const httpClient = {
    get: async (url) => (/\/savedqueries\([^)]+\)/.test(url) ? { status: 200, headers: {}, body: row } : { status: 200, headers: {}, body: {} }),
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async (url, body) => { patches.push(body); return { status: 204, headers: {}, body: {} }; },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  await sdk.fetchArtifact('view', VIEW_ID);
  const view = await sdk.getArtifact('view', VIEW_ID);

  // The typed tree is empty — the plain `statecode` condition beside the link-entity is not in it either — and the filter is in the bag.
  assert.deepStrictEqual(view.filters, { type: 'and', conditions: [], groups: [] });
  assert.strictEqual(view.linkEntities, undefined);
  const bag = JSON.stringify(view.fetchBag);
  assert.ok(bag.includes('"link-entity"') && bag.includes('"any"') && bag.includes('emailaddress1'), 'the related-rows condition is kept in the bag');

  // A column edit, as a rebuild makes it, writes the filter back whole: both conditions and the link-entity with its own.
  await sdk.updateElement('view', VIEW_ID, '/columns', [...view.columns, { name: 'telephone1', width: 100, order: view.columns.length }]);
  const pushed = await sdk.pushArtifact('view', VIEW_ID);
  assert.notStrictEqual(pushed.saved, false, JSON.stringify(pushed.error && pushed.error.message));
  assert.strictEqual(patches.length, 1);
  const spaced = (xml) => xml.replace(/\s*\/>/g, ' />');
  assert.ok(spaced(patches[0].fetchxml).includes(spaced(RELATED_FILTER)), `the filter is written back as it was:\n${patches[0].fetchxml}`);
  assert.match(patches[0].fetchxml, /<attribute name="telephone1"/, 'and the new column is fetched');
});

test('a download carries no view — its query is never read, so a filter the typed tree cannot show is named with the view and never partly emitted', async () => {
  const selects = [];
  const sdk = {
    queryRecords: async (set, opts) => {
      const filter = (opts && opts.filter) || '';
      if (set === 'appmodule') return [{ appmoduleidunique: CURRENT }];
      if (set === 'appmodulecomponent' && /componenttype eq 26/.test(filter)) return [{ objectid: VIEW_ID }];
      if (set === 'savedquery') {
        selects.push(opts.select);
        return [{ savedqueryid: VIEW_ID, name: VIEW_NAME, returnedtypecode: 'account', description: 'Accounts a salesperson can ring.' }];
      }
      if (set === 'solution') return [{ solutionid: '00000000-0000-4000-8000-0000000000ee' }];
      return [];
    },
    dataverse: { get: async () => ({ status: 200, headers: {}, body: { value: [] } }) },
  };

  const inventory = await readDescriptionInventory(currentReadSdk(sdk, { appId: APP, layerId: CURRENT }), APP, 'ContosoSolution');
  assert.deepStrictEqual(inventory.views, [{ id: VIEW_ID, name: VIEW_NAME, entity: 'account', description: 'Accounts a salesperson can ring.' }]);
  assert.ok(selects.length > 0, 'the view row was read');
  assert.ok(selects.flat().every((column) => !/^(fetchxml|layoutxml)$/i.test(column)), `no column of the view\u2019s query is selected: ${JSON.stringify(selects)}`);

  // The spec holds no view, and the view is reported by name as something the spec leaves out.
  const spec = await hydrateSpec({
    app: async () => ({ name: 'Sales', description: '', uniquename: 'new_sales', siteMap: { areas: [] } }),
    pages: async () => [], entities: async () => [], webResources: async () => [],
    solution: async () => ({ uniqueName: 'Sales', publisherPrefix: 'new' }),
  });
  assert.deepStrictEqual(spec.views, []);
  const warning = notRoundTrippedWarning(notRoundTrippedSummary(inventory));
  assert.match(warning, new RegExp(`views: ${VIEW_NAME}`));
  assert.match(warning, /THIS environment leaves them untouched/);
});
