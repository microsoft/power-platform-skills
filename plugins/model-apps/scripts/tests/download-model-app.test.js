'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveAppId, collectSitemap, parseDownloadedPages, entityFromMetadata } = require('../download-model-app.js');

test('resolveAppId returns a guid as-is, else resolves by uniquename', async () => {
  const guid = '11111111-2222-3333-4444-555555555555';
  assert.strictEqual(await resolveAppId({}, guid), guid);
  const sdk = { queryRecords: async (l, o) => { assert.match(o.filter, /uniquename eq 'new_app'/); return [{ appmoduleid: 'app-1' }]; } };
  assert.strictEqual(await resolveAppId(sdk, 'new_app'), 'app-1');
});

test('collectSitemap gathers distinct entities + icons from the sitemap', () => {
  const app = { siteMap: { areas: [{ icon: 'a.png', groups: [{ subAreas: [
    { type: 'Entity', entity: 'New_Order', icon: 'i.png' },
    { type: 'GenPage', genPageId: 'gp' },
    { type: 'Entity', entity: 'new_order' },
  ] }] }] } };
  const { entities, icons } = collectSitemap(app);
  assert.deepStrictEqual(entities, ['new_order']);
  assert.deepStrictEqual([...icons].sort(), ['a.png', 'i.png']);
});

test('parseDownloadedPages reads pac page tree (<pageId>/page.tsx + config + prompt) into pages[]', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const pagesRoot = path.join(out, 'pages');
  const pid = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';
  fs.mkdirSync(path.join(pagesRoot, pid), { recursive: true });
  fs.writeFileSync(path.join(pagesRoot, pid, 'page.tsx'), 'x');
  fs.writeFileSync(path.join(pagesRoot, pid, 'config.json'), JSON.stringify({ dataSources: ['new_order'], model: '' }));
  fs.writeFileSync(path.join(pagesRoot, pid, 'prompt.txt'), 'kpis');
  const pages = parseDownloadedPages(pagesRoot, out, new Map([[pid, 'Overview']]));
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(pages[0].name, 'Overview');
  assert.deepStrictEqual(pages[0].dataSources, ['new_order']);
  assert.strictEqual(pages[0].prompt, 'kpis');
  assert.strictEqual(pages[0].codeFile, `pages/${pid}/page.tsx`);
  fs.rmSync(out, { recursive: true, force: true });
});

test('entityFromMetadata builds a minimal (reuse-friendly) entity spec', () => {
  const e = entityFromMetadata({ schemaName: 'new_order', displayName: 'Order', primaryNameAttribute: 'new_name' }, 'new_order');
  assert.strictEqual(e.schemaName, 'new_order');
  assert.strictEqual(e.primaryAttribute.schemaName, 'new_name');
  assert.deepStrictEqual(e.columns, []);
});
