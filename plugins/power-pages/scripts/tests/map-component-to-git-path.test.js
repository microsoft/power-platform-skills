'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  slugifyComponentName, normalizeForMatch, buildSourceFilePath,
  buildPathFromComponentPath, resolveSourceFilePath, siteRoot, TYPE_LAYOUT, BINARY_TYPES,
} = require('../lib/map-component-to-git-path');

function createQueuedServer(responses) {
  const queue = [...responses];
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url });
      const next = queue.shift() || { status: 500, body: '' };
      res.writeHead(next.status, next.headers || { 'Content-Type': 'application/json' });
      res.end(next.body || '');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received })));
}
const serverUrl = (s) => `http://127.0.0.1:${s.port}`;
const closeAll = (...ss) => Promise.all(ss.map(s => new Promise(r => s.server.close(r))));

// ---- slugify ----
test('slugifyComponentName: spaces and slashes become hyphens', () => {
  assert.equal(slugifyComponentName('Access Denied'), 'Access-Denied');
  assert.equal(slugifyComponentName('Header/Search/ToolTip'), 'Header-Search-ToolTip');
  assert.equal(slugifyComponentName('Default studio template'), 'Default-studio-template');
  assert.equal(slugifyComponentName('  Trim Me  '), 'Trim-Me');
  assert.equal(slugifyComponentName('a//b   c'), 'a-b-c');
});

test('normalizeForMatch: folds case and non-alphanumerics', () => {
  assert.equal(normalizeForMatch('Header-Search-ToolTip'), 'headersearchtooltip');
  assert.equal(normalizeForMatch('Header/Search/ToolTip'), 'headersearchtooltip');
});

test('siteRoot: builds the powerpagesites path', () => {
  assert.equal(siteRoot({ rootFolder: 'solutions', gitFolder: 'RetailOS', siteName: 'RetailOS' }),
    '/solutions/RetailOS/powerpagesites/RetailOS');
});

// ---- buildSourceFilePath ----
const COORDS = { rootFolder: 'solutions', gitFolder: 'RetailOS', siteName: 'RetailOS' };

test('buildSourceFilePath: web template (8)', () => {
  const r = buildSourceFilePath({ type: 8, name: 'Search', ...COORDS });
  assert.equal(r.path, '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Search/Search.webtemplate.source.html');
  assert.equal(r.field, 'source');
});
test('buildSourceFilePath: content snippet (7)', () => {
  const r = buildSourceFilePath({ type: 7, name: 'Footer', ...COORDS });
  assert.equal(r.path, '/solutions/RetailOS/powerpagesites/RetailOS/content-snippets/Footer/Footer.contentsnippet.value.html');
});
test('buildSourceFilePath: web page (2) copy uses content-pages subfolder', () => {
  const r = buildSourceFilePath({ type: 2, name: 'Access Denied', ...COORDS });
  assert.equal(r.path, '/solutions/RetailOS/powerpagesites/RetailOS/web-pages/Access-Denied/content-pages/Access-Denied.webpage.copy.html');
  assert.equal(r.field, 'copy');
});
test('buildSourceFilePath: web page summary field', () => {
  const r = buildSourceFilePath({ type: 2, name: 'Home', field: 'summary', ...COORDS });
  assert.match(r.path, /Home\.webpage\.summary\.html$/);
});

// ---- buildPathFromComponentPath (W2#4 — deterministic from the conflict row) ----
test('buildPathFromComponentPath: web template (8) from componentpath matches the live ADO path', () => {
  const r = buildPathFromComponentPath({
    componentPath: '/powerpagesites/RetailOS/web-templates/Search-Results', type: 8,
    rootFolder: 'solutions', gitFolder: 'RetailOS',
  });
  assert.equal(r.path, '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Search-Results/Search-Results.webtemplate.source.html');
  assert.equal(r.field, 'source');
  assert.equal(r.slug, 'Search-Results');
  assert.equal(r.resolvedVia, 'componentpath');
});
test('buildPathFromComponentPath: content snippet (7) value', () => {
  const r = buildPathFromComponentPath({
    componentPath: '/powerpagesites/RetailOS/content-snippets/Footer', type: 7,
    rootFolder: 'solutions', gitFolder: 'RetailOS',
  });
  assert.equal(r.path, '/solutions/RetailOS/powerpagesites/RetailOS/content-snippets/Footer/Footer.contentsnippet.value.html');
});
test('buildPathFromComponentPath: web page (2) copy injects content-pages subfolder', () => {
  const r = buildPathFromComponentPath({
    componentPath: '/powerpagesites/RetailOS/web-pages/Home', type: 2,
    rootFolder: 'solutions', gitFolder: 'RetailOS',
  });
  assert.equal(r.path, '/solutions/RetailOS/powerpagesites/RetailOS/web-pages/Home/content-pages/Home.webpage.copy.html');
  assert.equal(r.field, 'copy');
});

test('buildPathFromComponentPath: web page (2) componentpath that ALREADY ends with content-pages (live conflict-row shape)', () => {
  // Live regression (2026-06-19, sri-alm-dev-1): the conflict row for a web page
  // copy carries componentpath `.../web-pages/Access-Denied/content-pages` — the
  // subfolder is already the LAST segment, so the slug is the segment BEFORE it
  // ("Access-Denied") and the subfolder must NOT be appended again. The old code
  // used the last segment as the slug AND re-appended the subfolder, producing
  // `.../content-pages/content-pages.webpage.copy.html` (404 → mis-flagged
  // deleted-in-git).
  const r = buildPathFromComponentPath({
    componentPath: '/powerpagesites/RetailOS/web-pages/Access-Denied/content-pages', type: 2,
    field: 'copy', rootFolder: 'solutions', gitFolder: 'RetailOS',
  });
  assert.equal(r.path, '/solutions/RetailOS/powerpagesites/RetailOS/web-pages/Access-Denied/content-pages/Access-Denied.webpage.copy.html');
  assert.equal(r.slug, 'Access-Denied');
  assert.equal(r.field, 'copy');
  assert.equal(r.resolvedVia, 'componentpath');
});

test('buildPathFromComponentPath: web page (2) summary when componentpath ends with content-pages', () => {
  const r = buildPathFromComponentPath({
    componentPath: '/powerpagesites/RetailOS/web-pages/Access-Denied/content-pages', type: 2,
    field: 'summary', rootFolder: 'solutions', gitFolder: 'RetailOS',
  });
  assert.equal(r.path, '/solutions/RetailOS/powerpagesites/RetailOS/web-pages/Access-Denied/content-pages/Access-Denied.webpage.summary.html');
});
test('buildPathFromComponentPath: tolerates trailing/leading slashes on componentpath', () => {
  const r = buildPathFromComponentPath({
    componentPath: 'powerpagesites/RetailOS/web-templates/Search-Results/', type: 8,
    rootFolder: 'solutions', gitFolder: 'RetailOS',
  });
  assert.equal(r.path, '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Search-Results/Search-Results.webtemplate.source.html');
});
test('buildPathFromComponentPath: missing componentPath or unsupported type → supported:false', () => {
  assert.equal(buildPathFromComponentPath({ type: 8, rootFolder: 'solutions', gitFolder: 'RetailOS' }).supported, false);
  assert.equal(buildPathFromComponentPath({ componentPath: '/x/y', type: 3, rootFolder: 'solutions', gitFolder: 'RetailOS' }).supported, false);
});
test('buildSourceFilePath: web file (3) and site setting (9) are unsupported (binary in v1)', () => {
  assert.equal(buildSourceFilePath({ type: 3, name: 'x.css', ...COORDS }).supported, false);
  assert.equal(buildSourceFilePath({ type: 9, name: 'Auth/Foo', ...COORDS }).supported, false);
  assert.ok(BINARY_TYPES[3] && BINARY_TYPES[9]);
});
test('buildSourceFilePath: unknown type unsupported', () => {
  const r = buildSourceFilePath({ type: 999, name: 'x', ...COORDS });
  assert.equal(r.supported, false);
});
test('buildSourceFilePath: unknown field on a supported type is unsupported', () => {
  const r = buildSourceFilePath({ type: 8, name: 'Search', field: 'bogus', ...COORDS });
  assert.equal(r.supported, false);
});

// ---- resolveSourceFilePath ----
test('resolveSourceFilePath: no ADO coords → computed path', async () => {
  const r = await resolveSourceFilePath({ type: 8, name: 'Search', ...COORDS });
  assert.equal(r.resolvedVia, 'computed');
  assert.match(r.path, /Search\.webtemplate\.source\.html$/);
});

test('resolveSourceFilePath: listing match (normalized) wins over computed', async () => {
  // ADO used a different slug ("Search-Box") than our slugify ("SearchBox") — normalized match still hits.
  const listing = { value: [
    { isFolder: false, path: '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Search-Box/Search-Box.webtemplate.source.html', objectId: 'abc' },
    { isFolder: false, path: '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Footer/Footer.webtemplate.source.html', objectId: 'def' },
  ] };
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify(listing) }]);
  const r = await resolveSourceFilePath({
    type: 8, name: 'Search Box', ...COORDS,
    branch: 'feature/dev-a', organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, true);
  assert.equal(r.resolvedVia, 'listing');
  assert.match(r.path, /Search-Box\.webtemplate\.source\.html$/);
  assert.equal(r.objectId, 'abc');
});

test('resolveSourceFilePath: no match → computed fallback with candidates', async () => {
  const listing = { value: [
    { isFolder: false, path: '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Footer/Footer.webtemplate.source.html' },
  ] };
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify(listing) }]);
  const r = await resolveSourceFilePath({
    type: 8, name: 'Nonexistent', ...COORDS,
    branch: 'b', organization: 'o', project: 'p', repository: 'r', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, false);
  assert.equal(r.resolvedVia, 'computed');
  assert.ok(Array.isArray(r.candidates));
});

test('resolveSourceFilePath: 404 type folder → computed fallback', async () => {
  const s = await createQueuedServer([{ status: 404, body: JSON.stringify({ message: 'not found' }) }]);
  const r = await resolveSourceFilePath({
    type: 7, name: 'Footer', ...COORDS,
    branch: 'b', organization: 'o', project: 'p', repository: 'r', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, false);
  assert.equal(r.resolvedVia, 'computed');
});

test('resolveSourceFilePath: unsupported type short-circuits before any ADO call', async () => {
  const r = await resolveSourceFilePath({
    type: 3, name: 'x.css', ...COORDS,
    branch: 'b', organization: 'o', project: 'p', repository: 'r', pat: 'P', baseUrl: 'http://127.0.0.1:1',
  });
  assert.equal(r.supported, false);
});

// ---- fix #5: slug-collision safety ----
test('resolveSourceFilePath: exact slug match preferred over a normalized collision', async () => {
  const listing = { value: [
    { isFolder: false, path: '/x/web-templates/Header-Nav/Header-Nav.webtemplate.source.html', objectId: 'exact' },
    { isFolder: false, path: '/x/web-templates/HeaderNav/HeaderNav.webtemplate.source.html', objectId: 'norm' },
  ] };
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify(listing) }]);
  const r = await resolveSourceFilePath({
    type: 8, name: 'Header Nav', ...COORDS, // slug → Header-Nav (exact)
    branch: 'b', organization: 'o', project: 'p', repository: 'r', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, true);
  assert.equal(r.objectId, 'exact'); // must NOT pick the normalized HeaderNav
});

test('resolveSourceFilePath: ambiguous normalized matches (no exact) → found:false, never silently wrong-file', async () => {
  const listing = { value: [
    { isFolder: false, path: '/x/web-templates/Header-Nav/Header-Nav.webtemplate.source.html' },
    { isFolder: false, path: '/x/web-templates/HeaderNav/HeaderNav.webtemplate.source.html' },
  ] };
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify(listing) }]);
  // "Header.Nav" slugifies to "Header.Nav" (dot preserved) → no exact match, but both
  // files normalize to "headernav" → ambiguous.
  const r = await resolveSourceFilePath({
    type: 8, name: 'Header.Nav', ...COORDS,
    branch: 'b', organization: 'o', project: 'p', repository: 'r', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, false);
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates.length, 2);
});
