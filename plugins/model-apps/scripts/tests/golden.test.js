'use strict';
// Golden snapshot regression tests: lock today's correct deterministic output so future changes
// can't silently drift it. Regenerate intentionally with `UPDATE_GOLDENS=1 node --test …golden.test.js`
// (review the diff before committing the updated golden).
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { planFor, PHASES, appDef } = require('../lib/sdk-build.js');
const { assertGolden } = require('./helpers/golden.js');

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
  const httpClient = {
    get: async () => ({ status: 200, headers: {}, body: {} }),
    post: async (url, body) => { if (/\/sitemaps\b/.test(url) && body && body.sitemapxml) xml = String(body.sitemapxml); return { status: 204, headers: { 'odata-entityid': 'https://x/y(11111111-1111-1111-1111-111111111111)' }, body: {} }; },
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: ws, instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  const art = sdk.createArtifact('app', { name: spec.app.name, uniqueName: 'new_goldenapp', description: '', siteMap: def.siteMap, components: def.components });
  await sdk.pushArtifact('app', art.id);
  fs.rmSync(ws, { recursive: true, force: true });
  assertGolden('sitemap.icons.xml', xml + '\n');
});
