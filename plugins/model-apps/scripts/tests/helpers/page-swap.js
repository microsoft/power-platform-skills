'use strict';
// The app and the download the page-tree tests run (download-model-app.test.js, and the child process its crash tests stop part-way):
// an app whose navigation names generative pages, served through the stand-in SDK the other runDownload tests use, and a pages/ folder
// a maker has worked in.
const fs = require('node:fs');
const path = require('node:path');
const { runDownload } = require('../../download-model-app.js');
const { currentReadSdk } = require('./app-membership-sdk.js');
const { fakeGenpage } = require('./fake-genpage.js');

// An app with the given pages in its navigation, served through the stand-in SDK the other runDownload tests use.
function pagesApp(pageIds) {
  const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
  const LAYER = 'c0ffee00-0000-4000-8000-00000000dddd';
  const xml = `<SiteMap><Area><Group>${pageIds.map((id, i) => `<SubArea GenPageId="${id}" Title="Title ${i}"/>`).join('')}<SubArea Entity="contoso_item"/></Group></Area></SiteMap>`;
  const sdk = {
    fetchArtifact: async () => ({
      name: 'Pages App', description: '',
      siteMap: { areas: [{ title: 'M', groups: [{ title: 'G', subAreas: [
        ...pageIds.map((id, i) => ({ type: 'GenPage', genPageId: id, title: `Title ${i}` })),
        { type: 'Entity', entity: 'contoso_item' },
      ] }] }] },
    }),
    queryRecords: async (logical, opts) => {
      const filter = (opts && opts.filter) || '';
      if (logical === 'appmodule') {
        const m = filter.match(/uniquename eq '([^']+)'/);
        if (m) return m[1] === 'test_pages' ? [{ appmoduleid: APP_ID, appmoduleidunique: LAYER }] : [];
        return [{ appmoduleid: APP_ID, appmoduleidunique: LAYER, uniquename: 'test_pages' }];
      }
      if (logical === 'appmodulecomponent') return [{ objectid: '5111e0f2-0000-4000-8000-0000000000aa', componenttype: 62 }];
      if (logical === 'sitemap') return [{ sitemapxml: xml }];
      return [];
    },
    fetchEntityMetadata: async (logical) => ({ schemaName: logical, displayName: 'Item', primaryNameAttribute: `${String(logical).split('_')[0]}_name` }),
  };
  return { sdk: currentReadSdk(sdk, { appId: APP_ID, layerId: LAYER, sitemapXml: xml }), appId: APP_ID, appUnique: 'test_pages' };
}

const SWAP_A = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const SWAP_B = '5c0a4889-45fd-46ea-91a8-ff876914d644';
const MAKER_ONLY = '77777777-7777-4777-8777-777777777777';
const DOWNLOADED_A = 'export default () => "downloaded";\n';

// A pages/ the maker has worked in: a page the app still has, edited, and a page only the maker has.
function seedEditedPages(out) {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.writeFileSync(path.join(out, rel), text);
  };
  write(`pages/${SWAP_A}/page.tsx`, 'export default () => "edited by the maker";\n');
  write(`pages/${SWAP_A}/config.json`, '{"dataSources":["contoso_item"]}');
  write(`pages/${MAKER_ONLY}/page.tsx`, 'export default () => "not uploaded yet";\n');
}

// Every file under `dir` as { 'relative/path': hex bytes }, so two trees compare byte for byte.
function treeBytes(dir) {
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('hex');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files;
}

const swapGenpage = () => fakeGenpage({ pages: [{ pageId: SWAP_A, name: 'Alpha', source: DOWNLOADED_A }, { pageId: SWAP_B, name: 'Beta' }] });

// Downloads the two-page app into `out`, as a direct download (pages/ written by the download itself) or as the managed download does
// (`managed`: the tree is staged, then checked and published).
async function swapDownload(out, managed) {
  const result = await runDownload({ ...pagesApp([SWAP_A, SWAP_B]), genpage: swapGenpage(), outDir: out, ...(managed ? { stagePages: true } : {}) });
  if (!result.ok) throw new Error(`download failed: ${JSON.stringify(result)}`);
  if (managed) {
    result.stagedPages.check();
    result.stagedPages.publish();
  }
  return result;
}

module.exports = { pagesApp, SWAP_A, SWAP_B, MAKER_ONLY, DOWNLOADED_A, seedEditedPages, treeBytes, swapGenpage, swapDownload };
