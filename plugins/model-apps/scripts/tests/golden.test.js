'use strict';
// Golden snapshot regression tests: lock today's correct deterministic output so future changes
// can't silently drift it. Regenerate intentionally with `UPDATE_GOLDENS=1 node --test …golden.test.js`
// (review the diff before committing the updated golden).
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { planFor, PHASES, appDef } = require('../lib/sdk-build.js');
const { assertGolden } = require('./helpers/golden.js');
// Every app the PLUGIN creates carries an icon: `ensureAppIcon` (sdk-build.js) resolves the author's
// `spec.app.icon` or generates an SVG web resource, and `appDef` passes its id as
// `iconWebResourceId`. These tests drive the SDK directly, so they must supply one too or they are
// exercising a path production never takes.
//
// The SDK now REQUIRES it: `appmodule.webresourceid` is a required attribute, and when no explicit id
// is given it auto-resolves an IMAGE web resource (PNG/JPG/GIF/ICO/SVG) and throws
// `APP_ICON_UNRESOLVED` if the environment has none. Previously it fell back to ANY unmanaged web
// resource — which on an org whose images are all managed returned a JAVASCRIPT file, and the platform
// rejected the create with an opaque "dependent component WebResource does not exist". Failing fast
// with a clear message is the better behaviour; these tests just have to stop relying on the old
// silent fallback. A synthetic id is right here — the mock transport never dereferences it.
const APP_ICON_ID = '11111111-2222-3333-4444-555555555555';

const sample = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', `app-spec.${n}.json`), 'utf8'));

for (const name of ['project-tracker', 'support-desk']) {
  test(`build-plan golden: ${name}`, () => {
    const labels = planFor(sample(name), { sampleData: true, publish: true, phases: PHASES })
      .map((p) => `${p.phase}\t${p.label}`)
      .join('\n');
    assertGolden(`plan.${name}.txt`, labels + '\n');
  });
}

test('sitemap-XML golden: area + subarea icons', async () => {
  const { createMakerSdk } = require('../vendor/cds-maker-sdk.cjs');
  const os = require('node:os');
  const spec = {
    solution: { uniqueName: 'GoldA', publisherPrefix: 'new' },
    app: { name: 'Golden App', description: 'golden' },
    entities: [{ schemaName: 'new_gorder', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    appShell: {
      areas: [
        {
          label: 'Main',
          icon: 'new_areaicon.png',
          vectorIcon: 'Home',
          groups: [{ label: 'Records', subAreas: [{ entity: 'new_gorder', title: 'Orders', icon: 'new_subicon.png', vectorIcon: 'Grid' }] }],
        },
      ],
    },
  };
  const def = appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: {} });
  // Drive the PUBLIC surface (the AppAdapter class is no longer a bundle export): create the app and
  // capture the sitemapxml the push serializes.
  let xml = '';
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-sitemap-'));
  // A table's MetadataId is also the `objectid` its app component carries, so one constant keeps
  // the resolve and the read-back verification consistent.
  const TABLE_METADATA_ID = '22222222-2222-2222-2222-222222222222';
  const httpClient = {
    // The SDK now pins each sitemap table as an OData REFERENCE (`<EntitySetName>(<MetadataId>)`),
    // then READS THE COMPONENTS BACK and asserts each declared table landed. Both steps fail closed,
    // so this fake has to answer three reads that a bare `{}` used to satisfy:
    //   GET /EntityDefinitions(LogicalName='new_gorder')?$select=MetadataId,EntitySetName
    //   GET /appmodules(<id>) (unpublished-aware)   -> must carry `appmoduleidunique`
    //   GET /appmodulecomponents?$filter=_appmoduleidunique_value eq <guid> and componenttype eq 1
    get: async (url) => {
      const m = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (m) return { status: 200, headers: {}, body: { LogicalName: m[1], MetadataId: TABLE_METADATA_ID, EntitySetName: `${m[1]}s` } };
      if (/\/appmodulecomponents/.test(url)) {
        return { status: 200, headers: {}, body: { value: [{ objectid: TABLE_METADATA_ID, componenttype: 1 }] } };
      }
      if (/\/appmodules/.test(url)) {
        const row = { appmoduleid: '11111111-1111-1111-1111-111111111111', appmoduleidunique: '33333333-3333-3333-3333-333333333333' };
        // The unpublished-aware read returns a result set; a by-id retrieve returns the row.
        return { status: 200, headers: {}, body: /RetrieveUnpublishedMultiple/i.test(url) ? { value: [row] } : row };
      }
      return { status: 200, headers: {}, body: {} };
    },
    post: async (url, body) => { if (/\/sitemaps\b/.test(url) && body && body.sitemapxml) xml = String(body.sitemapxml); return { status: 204, headers: { 'odata-entityid': 'https://x/y(11111111-1111-1111-1111-111111111111)' }, body: {} }; },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: ws, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  const art = sdk.createArtifact('app', { name: spec.app.name, uniqueName: 'new_goldenapp', description: '', siteMap: def.siteMap, components: def.components, iconWebResourceId: APP_ICON_ID });
  await sdk.pushArtifact('app', art.id);
  fs.rmSync(ws, { recursive: true, force: true });
  assertGolden('sitemap.icons.xml', xml + '\n');
});
