'use strict';
// Two performance options of the vendored SDK that this plugin deliberately leaves off, and the facts each
// decision rests on. Neither is an oversight, and each would be easy to switch on later without noticing what
// it breaks — so what keeps them off is pinned here, against the real bundle where the SDK is the subject.
//
//   readConcurrency  overlaps the file downloads of a generative page that the SDK reads, and the per-component
//                    reads of fetchSolution. The plugin makes neither read: its pages go through
//                    `pac model genpage`, and no script fetches a solution. The option would change nothing, so
//                    it is not passed. A script that starts to make one of those reads is where it belongs.
//   published:false  creates an app as a never-published draft that a later publish covers, saving a publish
//                    round trip per create. A draft is not in the PUBLISHED projection that every app-existence
//                    probe in the plugin reads (a by-id read answers 404, a by-name query finds nothing), so
//                    the plugin creates its apps published.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appDef } = require('../lib/sdk-build.js');
const { scriptsMatching } = require('./helpers/production-scripts.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ENV = 'https://contoso.crm.dynamics.com';
const ICON_ID = '11111111-2222-3333-4444-555555555555';
const TABLE_METADATA_ID = '22222222-2222-2222-2222-222222222222';
const ROLE_ID = '66666666-6666-6666-6666-666666666666';

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

// --- readConcurrency --------------------------------------------------------------------------------

test('readConcurrency is passed exactly when some script makes a read it overlaps', () => {
  // The two loops the option overlaps are a generative page's file downloads (reached by naming the SDK's
  // 'genPage' artifact type) and fetchSolution's component reads.
  const readers = scriptsMatching(/\bfetchSolution\b|['"`]genPage['"`]/);
  const passers = scriptsMatching(/\breadConcurrency\b/);
  assert.strictEqual(
    readers.length > 0,
    passers.length > 0,
    readers.length
      ? `${readers.join(', ')} read(s) a generative page or a solution through the SDK, so that SDK instance should be created with `
        + '`readConcurrency` (4, through one shared constant), after measuring that the overlap helps. The window is 1-8 and defaults to 1.'
      : `${passers.join(', ')} pass(es) readConcurrency, but no script reads a generative page or a solution through the SDK, so it overlaps nothing. `
        + 'Drop it, or add the read it is for.'
  );
});

// --- published:false ---------------------------------------------------------------------------------

const spec = () => ({
  solution: { uniqueName: 'probe', publisherPrefix: 'new' },
  app: { name: 'Probe', description: 'Tickets' },
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [{ entity: 'new_torder', label: 'Orders' }] }] }] },
});
const appDefinition = () => appDef(spec(), { forms: {}, views: {}, charts: {} }, { iconWebResourceId: ICON_ID });

// A Dataverse that holds the one app a create writes. An appmodule is a DRAFT until a PublishXml names it: a
// by-id read answers 404 and a plain query finds nothing — only the RetrieveUnpublished* reads see it. That is the
// platform's published projection, which the SDK's own lookups and every probe in the plugin go through.
function fakeOrg() {
  const state = { app: null, sitemap: null, published: false, requests: [] };
  const appRow = () => ({
    appmoduleid: state.app.appmoduleid,
    appmoduleidunique: '99999999-9999-9999-9999-999999999999',
    name: state.app.name,
    uniquename: state.app.uniquename,
    componentstate: state.published ? 0 : 1,
    '@odata.etag': 'W/"1001"',
  });
  const answer = (value) => ({ status: 200, headers: {}, body: { value } });
  const httpClient = {
    get: async (url) => {
      const where = decodeURIComponent(url);
      state.requests.push({ verb: 'GET', url: where });
      const table = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(where);
      if (table) return { status: 200, headers: {}, body: { LogicalName: table[1], MetadataId: TABLE_METADATA_ID, EntitySetName: `${table[1]}s` } };
      if (/\/appmodulecomponents/.test(where)) {
        const wantsSitemap = /componenttype eq 62/.test(where);
        return answer(wantsSitemap ? [{ objectid: state.sitemap && state.sitemap.sitemapid, componenttype: 62 }] : [{ objectid: TABLE_METADATA_ID, componenttype: 1 }]);
      }
      if (/\/sitemaps/.test(where)) {
        const rows = state.sitemap ? [{ ...state.sitemap, '@odata.etag': 'W/"2001"' }] : [];
        const collection = /RetrieveUnpublishedMultiple/.test(where) || /\/sitemaps\?/.test(where);
        return { status: 200, headers: { etag: 'W/"2001"' }, body: collection ? { value: rows } : (rows[0] || {}) };
      }
      if (/\/appmodules\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple/.test(where)) return answer(state.app ? [appRow()] : []);
      if (/\/appmodules\(/.test(where)) {
        if (!state.published) return { status: 404, headers: {}, body: { error: { code: '0x80040217', message: 'Entity appmodule With Id Does Not Exist' } } };
        return { status: 200, headers: { etag: 'W/"1001"' }, body: appRow() };
      }
      if (/\/appmodules/.test(where)) return answer(state.app && state.published ? [appRow()] : []);
      if (/\/roles/.test(where)) return answer([{ roleid: ROLE_ID }]);
      return answer([]);
    },
    post: async (url, body) => {
      const where = decodeURIComponent(url);
      state.requests.push({ verb: 'POST', url: where, body: JSON.stringify(body) });
      if (/\/appmodules(\?|$)/.test(where)) {
        state.app = { appmoduleid: body.appmoduleid, name: body.name, uniquename: body.uniquename };
        return { status: 204, headers: { 'odata-entityid': `${ENV}/api/data/v9.0/appmodules(${body.appmoduleid})` }, body: undefined };
      }
      if (/\/sitemaps(\?|$)/.test(where)) {
        state.sitemap = { sitemapid: body.sitemapid, sitemapnameunique: body.sitemapnameunique, sitemapxml: body.sitemapxml };
        return { status: 201, headers: { etag: 'W/"2001"' }, body: { sitemapid: body.sitemapid, '@odata.etag': 'W/"2001"' } };
      }
      if (/PublishXml/.test(where) && state.app && JSON.stringify(body).includes(state.app.appmoduleid)) state.published = true;
      return { status: 204, headers: {}, body: undefined };
    },
    patch: async () => ({ status: 204, headers: {}, body: undefined }),
    delete: async () => ({ status: 204, headers: {}, body: undefined }),
    put: async () => ({ status: 204, headers: {}, body: undefined }),
  };
  return { state, httpClient };
}

async function freshSdk() {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-ins-'));
  tempDirs.push(dir);
  const { state, httpClient } = fakeOrg();
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ENV, httpClient });
  await sdk.initWorkspace();
  return { sdk, state };
}

const publishRequests = (state) => state.requests.filter((r) => r.verb === 'POST' && /PublishXml/.test(r.url));

test('an app created without `published` is published by the same push, and the by-name lookup then finds it', async () => {
  const { sdk, state } = await freshSdk();
  const def = appDefinition();
  const created = await sdk.createArtifact('app', def);
  const pushed = await sdk.pushArtifact('app', created.id);
  assert.strictEqual(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  assert.strictEqual(pushed.publish.kind, 'submitted');
  const publishes = publishRequests(state);
  assert.strictEqual(publishes.length, 1, 'one publish, issued by the create');
  assert.ok(publishes[0].body.includes(created.id), 'and it names the new app');
  assert.strictEqual(await sdk.findArtifact('app', { uniqueName: def.uniqueName }), created.id);
});

test('`published: false` leaves a never-published draft that the by-name lookup does not see', async () => {
  const { sdk, state } = await freshSdk();
  const def = appDefinition();
  const created = await sdk.createArtifact('app', { ...def, published: false });
  const pushed = await sdk.pushArtifact('app', created.id);
  assert.strictEqual(pushed.saved, true, JSON.stringify(pushed.error && pushed.error.message));
  assert.strictEqual(pushed.publish.kind, 'notRequested', 'nothing publishes the app: a build without --publish would leave it a draft');
  assert.deepStrictEqual(publishRequests(state), []);
  // findArtifact is what the build's app-existence probe uses. If it ever sees a draft, every other probe still
  // has to be draft-aware (collision gate, sitemap and navigation reads, verify, download) before the option is
  // worth turning on — see "Vendored SDK" in plugins/model-apps/AGENTS.md.
  assert.strictEqual(await sdk.findArtifact('app', { uniqueName: def.uniqueName }), null, 'the draft is invisible to the by-name lookup');
  const listed = await sdk.resolveArtifact('app', { uniqueName: def.uniqueName });
  assert.deepStrictEqual(listed.map((app) => app.id), [created.id], 'only the draft-aware listing finds it, which is what teardown uses');
});

test('the plugin creates every app published: its app definition leaves `published` unset and no script sets it to false', () => {
  assert.ok(!('published' in appDefinition()), 'appDef must not carry `published`');
  assert.deepStrictEqual(scriptsMatching(/\bpublished\s*:\s*false\b/), [], 'a script creates a draft app, which its own probes cannot see');
});
