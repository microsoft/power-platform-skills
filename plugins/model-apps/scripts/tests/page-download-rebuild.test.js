'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDownload } = require('../download-model-app.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { buildManifest } = require('../lib/page-manifest.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');
const { currentReadSdk } = require('./helpers/app-membership-sdk.js');
const { fakeGenpage } = require('./helpers/fake-genpage.js');
const { withPageType } = require('./helpers/page-component-type.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const APP_UNIQUE = 'contoso_roundtrip';
const APP_UNIQUE_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const SITEMAP_ID = 'aaaaaaaa-0000-4000-8000-000000000003';
const SOLUTION_ID = 'aaaaaaaa-0000-4000-8000-000000000004';
const OVERVIEW_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const DETAIL_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

// A page made by an earlier release holds its name with every `"` stored as `\"` (pac's doing); the SDK stores a name exactly. The round trip
// reads that name back as the name it was given, and the rebuild writes it exactly — repairing the stored one — so it never gains a backslash.
test('download-hydrate-rebuild preserves page identity name model and bindings', async () => {
  for (const secondModel of ['has space', undefined]) {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-download-rebuild-'));
    try {
      const canonical = 'export default function Overview() { Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", data: {} }); return null; }\r\n';
      const deployed = canonical.replace('"PAGEREF_detail"', `"${DETAIL_ID}"`);
      const detailCode = 'export default function Detail() { return null; }\r\n';
      const app = {
        name: 'Roundtrip App', uniquename: APP_UNIQUE, description: '',
        siteMap: { areas: [{ title: 'Main', groups: [{ title: 'Pages', subAreas: [
          { type: 'GenPage', genPageId: OVERVIEW_ID, title: 'Overview navigation' },
          { type: 'GenPage', genPageId: DETAIL_ID, title: 'Detail navigation' },
          { type: 'Entity', entity: 'contoso_item' },
        ] }] }] },
      };
      const sitemapXml = `<SiteMap><Area><Group><SubArea GenPageId="${OVERVIEW_ID}" Title="Overview navigation"/><SubArea GenPageId="${DETAIL_ID}" Title="Detail navigation"/><SubArea Entity="contoso_item"/></Group></Area></SiteMap>`;
      const manifest = buildManifest({ pages: [
        { key: 'overview', name: 'Old overview name', navigatesTo: [{ targetKey: 'detail' }] },
        { key: 'detail', name: 'Old detail name' },
      ] }, new Map([['overview', OVERVIEW_ID], ['detail', DETAIL_ID]]));
      let manifestContent = Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
      const { sdk, calls: sdkCalls } = makeSimpleMockSdk();
      const fetchArtifact = sdk.fetchArtifact;
      sdk.fetchArtifact = async (kind, id) => {
        const artifact = await fetchArtifact(kind, id);
        return kind === 'app' ? Object.assign(artifact, JSON.parse(JSON.stringify(app))) : artifact;
      };
      sdk.findArtifact = async (kind) => kind === 'app' ? APP_ID : null;
      sdk.listArtifacts = async (kind) => kind === 'app' ? [{ id: APP_ID, isDirty: false }] : [];
      sdk.findTables = async () => [{ logicalName: 'contoso_item', entitySetName: 'contoso_items' }];
      sdk.fetchEntityMetadata = async (logical) => ({
        logicalName: logical, schemaName: logical, displayName: 'Item',
        primaryNameAttribute: 'contoso_name', entitySetName: 'contoso_items', attributes: [], relationships: [],
      });
      // The rebuild's pages join the app's solution, so the page table's component type is read first (lib/page-solution.js).
      sdk.dataverse = { get: withPageType(async () => ({ status: 200, body: { value: [] } })) };
      sdk.queryRecords = async (logical, opts = {}) => {
        if (logical === 'appmodule') return [{ appmoduleid: APP_ID, appmoduleidunique: APP_UNIQUE_ID, uniquename: APP_UNIQUE }];
        if (logical === 'appmodulecomponent') return /componenttype eq 62/.test(opts.filter || '') ? [{ objectid: SITEMAP_ID, componenttype: 62 }] : [];
        if (logical === 'sitemap') return [{ sitemapid: SITEMAP_ID, sitemapxml: sitemapXml }];
        if (logical === 'webresource') return /_pagemanifest'/.test(opts.filter || '') ? [{ webresourceid: 'manifest', content: manifestContent }] : [];
        if (logical === 'solutioncomponent') return [{ _solutionid_value: SOLUTION_ID }];
        if (logical === 'solution') return [{ solutionid: SOLUTION_ID, uniquename: 'ContosoRoundtrip', ismanaged: false }];
        return [];
      };
      sdk.updateWebResource = async (id, value) => {
        assert.strictEqual(id, 'manifest');
        manifestContent = Buffer.from(value.content, 'utf8').toString('base64');
      };

      // The environment's pages, as an earlier release left them: the first page's name carries pac's `\"`.
      const genpage = fakeGenpage({ pages: [
        { pageId: OVERVIEW_ID, name: 'Say \\"hi\\"', source: deployed, dataSources: ['contoso_item', 'account'], model: 'gpt-4.1' },
        { pageId: DETAIL_ID, name: 'Item Detail', source: detailCode, dataSources: ['contoso_item'], ...(secondModel === undefined ? {} : { model: secondModel }) },
      ] });

      for (let round = 0; round < 2; round++) {
        const warnings = [];
        const write = process.stderr.write;
        let downloaded;
        process.stderr.write = (chunk) => { warnings.push(String(chunk)); return true; };
        try {
          downloaded = await runDownload({
            sdk: currentReadSdk(sdk, { appId: APP_ID, layerId: APP_UNIQUE_ID, sitemapXml }),
            genpage, outDir: appDir, appId: APP_ID, appUnique: APP_UNIQUE,
          });
        } finally { process.stderr.write = write; }
        assert.ok(downloaded.ok, JSON.stringify(downloaded));
        // Persisted JSON drops transient diagnostics, just as the download CLI's app-spec.json does.
        const spec = JSON.parse(JSON.stringify(downloaded.spec));
        const validation = validateAppSpec(spec);
        assert.ok(validation.ok, validation.errors.join('; '));
        const overview = spec.pages.find((p) => p.key === 'overview');
        const detail = spec.pages.find((p) => p.key === 'detail');
        assert.deepStrictEqual([overview.pageId, overview.name, overview.model, overview.dataSources],
          [OVERVIEW_ID, 'Say "hi"', 'gpt-4.1', ['contoso_item', 'account']]);
        assert.deepStrictEqual([detail.pageId, detail.name, detail.model, detail.dataSources],
          [DETAIL_ID, 'Item Detail', undefined, ['contoso_item']]);
        assert.deepStrictEqual(overview.navigatesTo, [{ targetKey: 'detail' }]);
        assert.deepStrictEqual(spec.appShell.areas[0].groups[0].subAreas.slice(0, 2),
          [{ page: 'overview', title: 'Overview navigation' }, { page: 'detail', title: 'Detail navigation' }]);
        const canonicalPath = path.join(appDir, overview.source.codeFile);
        assert.strictEqual(fs.readFileSync(canonicalPath, 'utf8'), canonical);
        // The model a spec cannot hold is reported both rounds: the page keeps it, so the next download meets it again.
        const modelWarnings = warnings.filter((w) => /page model id\(s\).*left out/.test(w));
        assert.strictEqual(modelWarnings.length, secondModel ? 1 : 0, warnings.join(''));
        if (modelWarnings.length) {
          assert.match(modelWarnings[0], /WARNING: 1 page model id\(s\) the App Spec cannot hold were left out, so a rebuild keeps the model of a page that exists as it is and stores none on a page it creates/);
          assert.ok(modelWarnings[0].includes(`${DETAIL_ID} ("has space")`), modelWarnings[0]);
        }

        const start = genpage.of('update').length;
        const rebuilt = await runSdkBuild(spec, { sdk, genpage, appDir, env: ENV, apply: true, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
        assert.ok(rebuilt.ok);
        assert.strictEqual(rebuilt.created.app, APP_ID);
        // `created.pages` is a null-prototype map (lib/own-keys.js: a page's key can be `constructor`), so its entries are compared.
        assert.deepStrictEqual({ ...rebuilt.created.pages }, { overview: OVERVIEW_ID, detail: DETAIL_ID });
        const updates = genpage.of('update').slice(start);
        assert.strictEqual(updates.length, 2, 'exactly one update per page');
        assert.strictEqual(genpage.of('create').length, 0, 'a downloaded page must be updated, never created');
        for (const [id, name, model, dataSources, content] of [
          [OVERVIEW_ID, 'Say "hi"', 'gpt-4.1', ['contoso_item', 'account'], deployed],
          [DETAIL_ID, 'Item Detail', undefined, ['contoso_item'], detailCode],
        ]) {
          const update = updates.find((u) => u.args[0] === id);
          assert.ok(update, id);
          const [, sent] = update.args;
          assert.strictEqual(sent.name, name);
          assert.deepStrictEqual(sent.dataSources, dataSources);
          assert.strictEqual(sent.model, model);
          assert.strictEqual(sent.source, content, 'the resolved text the build checked — navigation ids in place of PAGEREF_ tokens');
          assert.strictEqual(sent.caller, 'build');
          for (const key of ['connectorBindings', 'actionBindings']) assert.ok(!(key in sent), `${key} is not sent: the page keeps its own`);
        }
        // The environment now holds the names exactly as given — the escaped one repaired, not escaped again — and every model it had.
        assert.strictEqual(genpage.pages.get(OVERVIEW_ID).name, 'Say "hi"');
        assert.strictEqual(genpage.pages.get(DETAIL_ID).name, 'Item Detail');
        assert.strictEqual(genpage.pages.get(OVERVIEW_ID).model, 'gpt-4.1');
        assert.strictEqual(genpage.pages.get(DETAIL_ID).model, secondModel, 'a model the spec could not hold is left on the page, not wiped');
        assert.strictEqual(fs.readFileSync(canonicalPath, 'utf8'), canonical, 'rebuild never writes resolved IDs into canonical source');
        const staging = path.join(appDir, '.maker-workspace', '.pageref-deploy');
        assert.ok(!fs.existsSync(staging), 'no deployment staging folder exists: the text is sent, not a copy of the file');
      }
      assert.strictEqual(genpage.of('update').length, 4);
      assert.ok(!sdkCalls.some(([name]) => name === 'createTable'), 'downloaded existing tables are reused');
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});
