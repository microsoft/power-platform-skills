'use strict';

// KNOWN LIMIT, pinned: teardown deletes a generative page it proved this app's even when a form still embeds it.
// A form embeds a page through the MscrmControls.UxAgentControl control, whose static `RefId` parameter holds the page's id:
//   <customControl formFactor="0" name="MscrmControls.UxAgentControl"><parameters>
//     <RefId type="SingleLine.Text" static="true">11111111-1111-4111-8111-111111111111</RefId></parameters></customControl>
// Dataverse records no dependency for that value (measured: the page reported zero dependents and its delete answered 204), so the
// platform never refuses the delete, and teardown reads no form: the page goes, and the form is left showing a page that is gone.
// AGENTS.md (the teardown entry), references/app-spec-schema.md ("Teardown page scope") and the app-builder skill tell the maker to take
// the page off such forms before tearing the app down. Teardown does not look for those forms itself: a forms read alone cannot prove that
// no form names the page. This test holds the delete set to exactly what teardown has always deleted for such an app, and fails if
// teardown starts reading forms or keeping the page — so the documents of the limit change with it.

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
          return { status: 200, body: { value: state.forms.filter((f) => !table || f.table === table).map((f) => ({ formid: f.formid, name: f.name, formxml: f.formxml })) } };
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

test('a page a form of the app\'s tables still embeds is deleted like any proven page — no form is read, and the delete set is what teardown has always deleted (a known limit)', async () => {
  const env = environment();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-form-embedded-page-'));
  try {
    const dry = await runTeardown(env.spec, { env: ENV, apply: false }, { sdk: env.sdk });
    assert.ok(dry.plan.includes(`generative pages proven for this app: ${PAGE} "Overview" (would delete)`), JSON.stringify(dry.plan));

    const result = await runTeardown(env.spec, { env: ENV, apply: true, workspaceDir: dir }, { sdk: env.sdk });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(result.deleted.genpage, [PAGE]);
    assert.deepStrictEqual(env.state.deletes, ['app', `page:${PAGE}`, 'table:new_ticket', 'wr-icon', 'wr-manifest', 'solution']);
    assert.deepStrictEqual(env.state.formReads, [], 'teardown reads no form before it deletes a page');
    // The form of the table teardown keeps still names a page that is gone: the dangling reference the documents tell the maker to remove first.
    assert.ok(!env.state.pages.has(PAGE));
    assert.ok(env.state.forms.some((f) => f.table === 'account' && f.formxml.includes(PAGE)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
