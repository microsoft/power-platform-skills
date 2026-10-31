'use strict';
// What a `pages-locked` halt means for a FULL build, and what the build skill tells the maker about it. A standalone page edit (genpage.js add-to-app /
// remove-from-app, genpage-upload.js --app-id) takes the app's pages lease before it reads or writes anything, so its refusal wrote nothing. A build takes
// that lease only when it reaches its pages phase: the solution, tables, forms and app shell phases before it may already have saved their changes. The
// skill must therefore not promise the maker that a build halted `pages-locked` wrote nothing — the halt proves only that no page was written.
require('./helpers/own-temp-folder.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild, appUniqueName } = require('../lib/sdk-build.js');
const { acquireAppPagesLease, applyWorkspaceOf } = require('../lib/app-operation-lease.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');
const { withPageType } = require('./helpers/page-component-type.js');

const SKILL = path.join(__dirname, '..', '..', 'skills', 'app-builder', 'SKILL.md');
const folders = [];
test.after(() => { for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true }); });

const spec = () => ({
  schemaVersion: 2,
  solution: { uniqueName: 'Locked', displayName: 'Locked', publisherPrefix: 'contoso' },
  app: { name: 'Locked App' },
  entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
  forms: [{ entity: 'contoso_item', name: 'Item', tabs: [{ name: 'tab_general', sections: [{ name: 'section_general', fields: ['contoso_name'] }] }] }],
  pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: 'Overview' }, { entity: 'contoso_item', title: 'Items' }] }] }] },
});

// The simple mock SDK, answering the reads a full build of spec() makes; `calls` records every SDK call in order.
function world() {
  const { sdk, calls } = makeSimpleMockSdk();
  const query = sdk.queryRecords;
  sdk.queryRecords = async (entity, o) => {
    const filter = (o && o.filter) || '';
    if (entity === 'appmodule') { const m = filter.match(/uniquename eq '([^']+)'/); return [{ appmoduleid: 'a0000000-0000-4000-8000-000000000001', appmoduleidunique: 'c0ffee00-0000-4000-8000-00000000dddd', uniquename: m ? m[1] : 'x' }]; }
    if (entity === 'appmodulecomponent') return [{ objectid: '5111e0f2-0000-4000-8000-0000000000aa', componenttype: 62 }];
    if (entity === 'sitemap') return /sitemapnameunique eq/.test(filter) ? [{ sitemapid: 'sm-1' }] : [{ sitemapxml: '<SiteMap><Area><Group></Group></Area></SiteMap>' }];
    if (entity === 'webresource' || entity === 'uxagentproject' || entity === 'systemform') return [];
    if (entity === 'savedquery') return [{ savedqueryid: 'defview-x', isdefault: true }];
    return query(entity, o);
  };
  sdk.updateWebResource = async () => ({});
  sdk.dataverse = { get: withPageType(async (url) => (url.startsWith('/appmodules/') || url.startsWith('/sitemaps/') ? { status: 200, body: { value: [] } } : { status: 404, body: null })) };
  const uploads = [];
  const genpage = {
    enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
    create: async (o) => { uploads.push(o.name); return { pageId: '11111111-0000-4000-8000-000000000001', name: o.name, publish: { kind: 'verified', detail: '' }, warnings: [] }; },
    update: async (id, o) => { uploads.push(o.name); return { pageId: id, name: o.name, publish: { kind: 'verified', detail: '' }, warnings: [] }; },
    placeInApp: async () => ({ added: [], alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: false }),
  };
  return { sdk, calls, genpage, uploads };
}

// The skill's bullet for the `pages-locked` build halt (the build-halt list), up to the next halt code.
function pagesLockedBullet() {
  const text = fs.readFileSync(SKILL, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('  - `pages-locked` —');
  assert.ok(start >= 0, 'the build skill lists the pages-locked halt');
  const next = text.indexOf('\n  - `', start + 1);
  return text.slice(start, next < 0 ? undefined : next).replace(/\s+/g, ' ');
}

test('a full build halted pages-locked may already have written its earlier phases, and wrote no page — the build skill says exactly that', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-locked-halt-'));
  folders.push(appDir);
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function Overview() { return null; }\n');
  const s = spec();
  const { sdk, calls, genpage, uploads } = world();
  const held = acquireAppPagesLease(applyWorkspaceOf({ appDir }), appUniqueName(s));
  let error;
  try {
    await runSdkBuild(s, { sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir, genpage, phases: ['solution', 'data-model', 'forms', 'app-shell', 'pages'], warn: () => {} });
  } catch (e) { error = e; } finally { held.release(); }
  assert.strictEqual(error && error.code, 'pages-locked', String(error && error.stack));
  assert.strictEqual(error.phase, 'pages');
  assert.deepStrictEqual(uploads, [], 'no page was written under another holder\'s lease');
  const earlier = calls.map((c) => (Array.isArray(c) ? c[0] : c && c.name)).filter((name) => /^(create|push|update|add)/i.test(String(name)));
  assert.ok(earlier.length > 0, 'the phases before pages wrote before the lease was asked for — which is why the skill cannot promise "nothing was written"');

  const bullet = pagesLockedBullet();
  assert.doesNotMatch(bullet, /Nothing was written: wait/, 'the build skill must not say a pages-locked build halt wrote nothing');
  assert.match(bullet, /earlier (build )?phases[^.]*may already have saved/i, 'it says the earlier phases of the build may already have saved their changes');
  assert.match(bullet, /no page was (written|uploaded)/i, 'it says what the halt does prove: no page was written');
  assert.match(bullet, /run (the build )?again/i, 'it says to wait for the holder and run the build again, which reconciles what was saved');
});
