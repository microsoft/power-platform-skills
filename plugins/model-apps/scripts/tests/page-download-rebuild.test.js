'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDownload } = require('../download-model-app.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { makeGenpageCli } = require('../lib/genpage-cli.js');
const { buildManifest } = require('../lib/page-manifest.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');
const { currentReadSdk } = require('./helpers/app-membership-sdk.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const APP_UNIQUE = 'contoso_roundtrip';
const APP_UNIQUE_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const SITEMAP_ID = 'aaaaaaaa-0000-4000-8000-000000000003';
const SOLUTION_ID = 'aaaaaaaa-0000-4000-8000-000000000004';
const OVERVIEW_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const DETAIL_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

function listing(pages) {
  const width = Math.max(4, ...pages.map((p) => p.name.length));
  const header = 'Page ID'.padEnd(37) + 'Name'.padEnd(width + 1) + 'Published';
  const rows = pages.map((p) => `${p.pageId} ${p.name.padEnd(width)} -`).join('\n');
  return `Connected as maker@contoso.com\nRetrieving generated pages...\nFound ${pages.length} generated page(s):\n\n${header}\n${rows}\n`;
}

test('download-hydrate-rebuild preserves page identity name model and bindings', async () => {
  for (const secondModel of ['has space', undefined]) {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-download-rebuild-'));
    try {
      const canonical = 'export default function Overview() { Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", data: {} }); return null; }\r\n';
      const deployed = canonical.replace('"PAGEREF_detail"', `"${DETAIL_ID}"`);
      const detailCode = 'export default function Detail() { return null; }\r\n';
      const pages = new Map([
        [OVERVIEW_ID, { name: 'Say \\"hi\\"', code: deployed, dataSources: ['contoso_item', 'account'], model: 'gpt-4.1' }],
        [DETAIL_ID, { name: 'Item Detail', code: detailCode, dataSources: ['contoso_item'], ...(secondModel === undefined ? {} : { model: secondModel }) }],
      ]);
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
      sdk.dataverse = { get: async () => ({ status: 200, body: { value: [] } }) };
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

      const calls = [];
      const uploads = [];
      const cli = makeGenpageCli(ENV, {
        run: async (args) => {
          calls.push([...args]);
          const valueOf = (flag) => args[args.indexOf(flag) + 1];
          assert.strictEqual(valueOf('--environment'), ENV);
          if (args[2] === 'list') return { status: 0, stdout: listing([...pages].map(([pageId, p]) => ({ pageId, name: p.name }))), stderr: '' };
          assert.strictEqual(valueOf('--app-id'), APP_ID);
          if (args[2] === 'download') {
            assert.deepStrictEqual(valueOf('--page-id').split(',').sort(), [OVERVIEW_ID, DETAIL_ID].sort());
            for (const [id, p] of pages) {
              const dir = path.join(valueOf('--output-directory'), id);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, 'page.tsx'), p.code, 'utf8');
              fs.writeFileSync(path.join(dir, 'config.json'), '\uFEFF' + JSON.stringify({ dataSources: p.dataSources, ...(p.model === undefined ? {} : { model: p.model }) }), 'utf8');
              assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'config.json')).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
            }
            return { status: 0, stdout: 'Downloaded 2 page(s)', stderr: '' };
          }
          assert.strictEqual(args[2], 'upload', 'only fake list/download/upload operations are permitted');
          assert.ok(args.includes('--page-id'), 'a downloaded page must be updated, never created');
          const id = valueOf('--page-id');
          const content = fs.readFileSync(valueOf('--code-file'), 'utf8');
          uploads.push({ args: [...args], content });
          // Model PAC's stored escaping so a second round-trip catches accumulating backslashes.
          Object.assign(pages.get(id), {
            name: valueOf('--name').replace(/"/g, '\\"'), code: content,
            dataSources: valueOf('--data-sources').split(','),
            model: args.includes('--model') ? valueOf('--model') : '',
          });
          return { status: 0, stdout: `Page ID: ${id}`, stderr: '' };
        },
        request: async () => { throw new Error('unexpected Dataverse request: all page I/O must be fake'); },
        sleep: async () => {},
      });

      for (let round = 0; round < 2; round++) {
        const warnings = [];
        const write = process.stderr.write;
        let downloaded;
        process.stderr.write = (chunk) => { warnings.push(String(chunk)); return true; };
        try {
          downloaded = await runDownload({
            sdk: currentReadSdk(sdk, { appId: APP_ID, layerId: APP_UNIQUE_ID, sitemapXml }),
            genpageCli: cli, outDir: appDir, appId: APP_ID, appUnique: APP_UNIQUE,
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
        const modelWarnings = warnings.filter((w) => /page model id\(s\).*left out/.test(w));
        assert.strictEqual(modelWarnings.length, round === 0 && secondModel ? 1 : 0, warnings.join(''));
        if (modelWarnings.length) {
          assert.match(modelWarnings[0], /WARNING: 1 page model id\(s\) the App Spec cannot hold were left out, so a rebuild stores them empty/);
          assert.ok(modelWarnings[0].includes(`${DETAIL_ID} ("has space")`), modelWarnings[0]);
        }

        const start = uploads.length;
        const rebuilt = await runSdkBuild(spec, { sdk, genpageCli: cli, appDir, env: ENV, apply: true, phases: ['solution', 'data-model', 'app-shell', 'pages'] });
        assert.ok(rebuilt.ok);
        assert.strictEqual(rebuilt.created.app, APP_ID);
        assert.deepStrictEqual(rebuilt.created.pages, { overview: OVERVIEW_ID, detail: DETAIL_ID });
        const updates = uploads.slice(start);
        assert.strictEqual(updates.length, 2, 'exactly one update per page');
        for (const [id, name, model, dataSources, content] of [
          [OVERVIEW_ID, 'Say "hi"', 'gpt-4.1', 'contoso_item,account', deployed],
          [DETAIL_ID, 'Item Detail', undefined, 'contoso_item', detailCode],
        ]) {
          const upload = updates.find((u) => u.args[u.args.indexOf('--page-id') + 1] === id);
          assert.ok(upload, id);
          const { args } = upload;
          assert.strictEqual(args.filter((a) => a === '--name').length, 1);
          assert.strictEqual(args[args.indexOf('--name') + 1], name);
          assert.strictEqual(args[args.indexOf('--data-sources') + 1], dataSources);
          assert.strictEqual(args.includes('--model'), model !== undefined);
          if (model !== undefined) assert.strictEqual(args[args.indexOf('--model') + 1], model);
          assert.strictEqual(upload.content, content);
          for (const flag of ['--connectors', '--actions', '--add-to-sitemap']) assert.ok(!args.includes(flag), flag);
          assert.ok(!fs.existsSync(path.dirname(args[args.indexOf('--prompt-file') + 1])), 'wrapper temp directory cleaned');
        }
        assert.strictEqual(fs.readFileSync(canonicalPath, 'utf8'), canonical, 'rebuild never writes resolved IDs into canonical source');
        const staging = path.join(appDir, '.maker-workspace', '.pageref-deploy');
        assert.ok(!fs.existsSync(staging) || fs.readdirSync(staging).length === 0, 'deployment staging cleaned');
      }
      assert.strictEqual(calls.filter((args) => args[2] === 'upload').length, 4);
      assert.ok(!sdkCalls.some(([name]) => name === 'createTable'), 'downloaded existing tables are reused');
    } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
  }
});
