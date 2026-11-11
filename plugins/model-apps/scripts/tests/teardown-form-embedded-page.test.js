'use strict';

// Teardown refuses to delete a generative page a form still embeds.
// A form embeds a page through the MscrmControls.UxAgentControl control, whose static `RefId` parameter holds the page's id:
//   <customControl formFactor="0" name="MscrmControls.UxAgentControl"><parameters>
//     <RefId type="SingleLine.Text" static="true">11111111-1111-4111-8111-111111111111</RefId></parameters></customControl>
// Dataverse records no dependency for that value (measured: the page reported zero dependents and its delete answered 204), so the
// platform never refuses the delete. Before the page step deletes anything, teardown reads every form of every table in both layers
// (page-reference-guard.js) and refuses the step when one embeds a page: the page, its manifest and the solution are kept for a re-run,
// and the error names the form so the maker can take the page off it first.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTeardown } = require('../lib/sdk-teardown.js');
const { appUniqueName } = require('../lib/sdk-build.js');

const ENV = 'https://contoso.crm.dynamics.com';
const PAGE = '11111111-1111-4111-8111-111111111111';
const FORM = '22222222-2222-4222-8222-222222222222';

// A main form of `account` with the page on it, as the form designer saves it (one customControl per form factor).
const EMBEDDING_FORM = '<form><tabs><tab name="general"><columns><column width="100%"><sections><section name="page"><rows><row><cell id="{c0a8f1e2-0000-4000-8000-000000000001}">'
  + '<control id="genpage_host" classid="{F9A8A302-114E-466A-B582-6771B2AE0D92}" /></cell></row></rows></section></sections></column></columns></tab></tabs>'
  + '<controlDescriptions><controlDescription forControl="{F9A8A302-114E-466A-B582-6771B2AE0D92}">'
  + `<customControl formFactor="0" name="MscrmControls.UxAgentControl"><parameters><RefId type="SingleLine.Text" static="true">${PAGE}</RefId></parameters></customControl>`
  + `<customControl formFactor="2" name="MscrmControls.UxAgentControl"><parameters><RefId type="SingleLine.Text" static="true">${PAGE}</RefId></parameters></customControl>`
  + '</controlDescription></controlDescriptions></form>';

// An app (its sitemap names the page, which proves the page this app's), the page in its saved layer, the page manifest, one table the
// app reuses (`existing: true`, kept with its forms) and one it created, and the `account` form above. A read of the forms is recorded and
// answered with what the environment holds, so a teardown that looked would find the page on the form.
function environment() {
  const spec = {
    solution: { uniqueName: 'PgSln', publisherPrefix: 'new' },
    app: { name: 'Pages App' },
    entities: [
      { schemaName: 'account', existing: true, displayName: 'Account', primaryAttribute: { schemaName: 'name', displayName: 'Name' } },
      { schemaName: 'new_Ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' } },
    ],
  };
  const manifestName = `${appUniqueName(spec)}_pagemanifest`;
  const state = {
    app: true,
    pages: new Set([PAGE]),
    tables: new Set(['account', 'new_ticket']),
    forms: [{ table: 'account', formid: FORM, name: 'Account Main', formxml: EMBEDDING_FORM }],
    resources: new Map([[manifestName.toLowerCase(), 'wr-manifest'], [`${appUniqueName(spec)}_icon`.toLowerCase(), 'wr-icon']]),
    solution: true,
    deletes: [],
    formReads: [],
  };
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: PAGE }] }), 'utf8').toString('base64');
  const sdk = {
    resolveArtifact: async (kind, identity) => {
      if (kind === 'app') return state.app ? [{ id: 'app-1', name: 'Pages App', appModuleIdUnique: 'app-u-1' }] : [];
      if (kind === 'webResource') {
        const id = state.resources.get(String(identity.name).toLowerCase());
        return id ? [{ id, name: identity.name }] : [];
      }
      if (kind === 'solution') return state.solution ? [{ id: 'sol-1', name: 'PgSln' }] : [];
      return [];
    },
    deleteAppCascade: async () => { state.deletes.push('app'); state.app = false; return { success: true, deleted: [], failures: [] }; },
    queryRecords: async (entity) => {
      if (entity === 'webresource') return state.resources.has(manifestName.toLowerCase()) ? [{ content: manifest }] : [];
      if (entity === 'appmodule') return state.app ? [{ appmoduleid: 'app-1', appmoduleidunique: 'app-u-1' }] : [];
      if (entity === 'appmodulecomponent') return [{ objectid: 'sitemap-1', componenttype: 62 }];
      if (entity === 'sitemap') return state.app ? [{ sitemapxml: `<SiteMap><Area><Group><SubArea GenPageId="${PAGE}" /></Group></Area></SiteMap>` }] : [];
      if (entity === 'systemform') {
        state.formReads.push('systemform');
        return state.forms.map((f) => ({ formid: f.formid, name: f.name, formxml: f.formxml, objecttypecode: f.table }));
      }
      return [];
    },
    findTables: async (logical) => [...state.tables].filter((t) => t.includes(String(logical).toLowerCase())).map((t) => ({ logicalName: t, isCustom: t !== 'account' })),
    dataverse: {
      get: async (url) => {
        if (url.startsWith('/uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) {
          return { status: 200, body: { value: [...state.pages].map((id) => ({ uxagentprojectid: id, name: 'Overview', componentstate: 0 })) } };
        }
        if (url.startsWith('/systemforms')) {
          state.formReads.push(url);
          const table = (/objecttypecode eq '([^']+)'/.exec(decodeURIComponent(url)) || [])[1];
          return { status: 200, body: { value: state.forms.filter((f) => !table || f.table === table).map((f) => ({ formid: f.formid, name: f.name, formxml: f.formxml, objecttypecode: f.table })) } };
        }
        throw new Error(`unexpected read ${url}`);
      },
    },
    deleteRemoteArtifact: async (type, id) => {
      assert.strictEqual(type, 'genPage');
      state.deletes.push(`page:${id}`);
      state.pages.delete(id);
    },
    deleteTable: async (logical) => {
      state.deletes.push(`table:${logical}`);
      state.tables.delete(logical);
      state.forms = state.forms.filter((f) => f.table !== logical);
    },
    deleteWebResource: async (id) => {
      state.deletes.push(id);
      for (const [name, rid] of state.resources) if (rid === id) state.resources.delete(name);
    },
    deleteSolution: async () => { state.deletes.push('solution'); state.solution = false; },
  };
  return { spec, sdk, state };
}

test('a page a form still embeds is kept: teardown reads the forms before it deletes anything, and keeps the app, the page, the manifest and the solution for a re-run', async () => {
  const env = environment();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-form-embedded-page-'));
  try {
    const result = await runTeardown(env.spec, { env: ENV, apply: true, workspaceDir: dir }, { sdk: env.sdk });
    assert.strictEqual(result.ok, false);
    const pageError = result.errors.find((e) => e.step === 'generative pages proven for this app');
    assert.ok(pageError && pageError.message.includes(`page ${PAGE} is embedded in "Account Main" (form ${FORM}`), JSON.stringify(result.errors));
    assert.strictEqual(result.deleted.genpage, undefined);
    assert.deepStrictEqual(env.state.deletes, [], 'nothing is deleted: not the app (its navigation is the page\'s proof), the page, the manifest or the solution');
    assert.ok(result.skipped.some((s) => s.includes('not attempted - a form embeds a page of this app')), JSON.stringify(result.skipped));
    // Both layers of every form, once for the whole teardown: the published one, then the saved one.
    assert.deepStrictEqual(env.state.formReads.map((url) => url.split('?')[0]), ['/systemforms', '/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()']);
    assert.ok(env.state.pages.has(PAGE));

    // Once the page is off the form, a re-run deletes the app, the page, then the manifest and the solution it kept.
    env.state.forms = [];
    const again = await runTeardown(env.spec, { env: ENV, apply: true, workspaceDir: dir }, { sdk: env.sdk });
    assert.strictEqual(again.ok, true, JSON.stringify(again.errors));
    assert.deepStrictEqual(again.deleted.genpage, [PAGE]);
    assert.ok(!env.state.pages.has(PAGE));
    // (The table step is not what this test pins: this fake answers a table read by substring, so a re-run sends its delete again.)
    assert.deepStrictEqual(env.state.deletes.filter((d) => !d.startsWith('table:')), ['app', `page:${PAGE}`, 'wr-icon', 'wr-manifest', 'solution']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The dry run names what would stop the apply. It runs the apply's form scan on the pages it would delete, so it never says it
// would delete a page the apply then keeps; it reads only when there is such a page; and it is a preview — the apply scans again.
const dryRun = (env) => runTeardown(env.spec, { env: ENV, apply: false }, { sdk: env.sdk });
const pageLines = (result) => result.plan.filter((l) => l.startsWith('generative pages proven for this app'));
const formLayers = (env) => env.state.formReads.map((url) => url.split('?')[0]);
const BOTH_LAYERS = ['/systemforms', '/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()'];

test('dry run: a page a form embeds is said to be kept, with the form named, and the dry run is not ok — reading both form layers once, deleting nothing', async () => {
  const env = environment();
  const result = await dryRun(env);
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.deepStrictEqual(pageLines(result), [`generative pages proven for this app: ${PAGE} "Overview" (kept — embedded in "Account Main" (form ${FORM} of table account, published layer), "Account Main" (form ${FORM} of table account, saved layer))`]);
  const blocker = result.errors.find((e) => e.step === 'generative pages proven for this app');
  assert.ok(blocker && blocker.message.includes(`page ${PAGE} is embedded in "Account Main"`) && blocker.message.includes('the apply would keep every page, and the app'), JSON.stringify(result.errors));
  assert.deepStrictEqual(formLayers(env), BOTH_LAYERS);
  assert.deepStrictEqual(env.state.deletes, []);
});

test('dry run: with no form embedding the page it says it would delete it — and the apply scans again, so a form that embeds it since then still stops the apply', async () => {
  const env = environment();
  const forms = env.state.forms;
  env.state.forms = [];
  const result = await dryRun(env);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(pageLines(result), [`generative pages proven for this app: ${PAGE} "Overview" (would delete)`]);
  assert.deepStrictEqual(formLayers(env), BOTH_LAYERS);
  env.state.forms = forms;
  env.state.formReads = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-form-embedded-page-'));
  try {
    const applied = await runTeardown(env.spec, { env: ENV, apply: true, workspaceDir: dir }, { sdk: env.sdk });
    assert.strictEqual(applied.ok, false);
    assert.deepStrictEqual(env.state.deletes, []);
    assert.deepStrictEqual(formLayers(env), BOTH_LAYERS, 'the apply read the forms itself');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dry run: forms that cannot all be read keep the page — said as such, not "would delete"', async () => {
  const env = environment();
  const get = env.sdk.dataverse.get;
  env.sdk.dataverse.get = async (url) => (url.startsWith('/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()') ? { status: 503, body: null } : get(url));
  const result = await dryRun(env);
  assert.strictEqual(result.ok, false);
  const [line] = pageLines(result);
  assert.match(line, /\(kept — the forms could not all be read: /);
  assert.ok(result.errors.some((e) => /the forms could not all be read, so the pages would be kept/.test(e.message)), JSON.stringify(result.errors));
});

test('dry run: a continuation page of a form layer is read to the end, one read per page — a form on the second page still stops it', async () => {
  const env = environment();
  const get = env.sdk.dataverse.get;
  const forms = env.state.forms;
  env.sdk.dataverse.get = async (url) => {
    if (url.endsWith('/systemforms?page=2')) { env.state.formReads.push(url); return { status: 200, body: { value: forms.map((f) => ({ formid: f.formid, name: f.name, formxml: f.formxml })) } }; }
    if (url.startsWith('/systemforms?')) { env.state.formReads.push(url); return { status: 200, body: { value: [], '@odata.nextLink': `${ENV}/api/data/v9.2/systemforms?page=2` } }; }
    if (url.startsWith('/systemforms/')) { env.state.formReads.push(url); return { status: 200, body: { value: [] } }; }
    return get(url);
  };
  const result = await dryRun(env);
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.match(pageLines(result)[0], /kept — embedded in "Account Main" \(form [^)]+, published layer\)/);
  assert.deepStrictEqual(env.state.formReads.map((url) => url.replace(ENV, '').split('?')[0]), ['/systemforms', '/api/data/v9.2/systemforms', '/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()']);
});

test('dry run: no page to delete, no form read — a plan without pages, or whose pages are all gone, reads no form', async () => {
  const gone = environment();
  gone.state.pages.clear();
  const result = await dryRun(gone);
  assert.ok(pageLines(result).every((l) => !l.includes('would delete')), JSON.stringify(result.plan));
  assert.deepStrictEqual(gone.state.formReads, []);
  const noManifest = environment();
  noManifest.state.resources.clear();
  await dryRun(noManifest);
  assert.deepStrictEqual(noManifest.state.formReads, []);
});
