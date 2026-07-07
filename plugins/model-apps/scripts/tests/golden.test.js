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

test('sitemap-XML golden: area + subarea icons', () => {
  const { AppAdapter } = require('../vendor/cds-maker-sdk.cjs');
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
  const adapter = new AppAdapter();
  const art = { id: 'app-golden', name: spec.app.name, uniqueName: 'new_goldenapp', description: '', siteMap: def.siteMap, components: def.components };
  const xml = adapter.toApiPayload(art).sitemapxml;
  assertGolden('sitemap.icons.xml', xml + '\n');
});
