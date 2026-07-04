'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  slugifyComponentName, normalizeForMatch, buildSourceFilePath,
  buildPathFromComponentPath, resolveWebFileLeaf, resolveSourceFilePath, siteRoot, TYPE_LAYOUT, BINARY_TYPES,
} = require('../lib/map-component-to-git-path');

// Fake fs + posix path for deterministic, cross-platform resolveWebFileLeaf tests.
// tree: { '<abs posix path>': 'file' | <string[] dir entries> }
function fakeFs(tree) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/');
  return {
    statSync(p) {
      const t = tree[norm(p)];
      if (t == null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      const isDir = Array.isArray(t);
      return { isFile: () => !isDir, isDirectory: () => isDir };
    },
    readdirSync(p) {
      const t = tree[norm(p)];
      if (Array.isArray(t)) return t.slice();
      const e = new Error('ENOTDIR'); e.code = 'ENOTDIR'; throw e;
    },
  };
}
const posixPath = { join: (...a) => a.join('/').replace(/\/+/g, '/'), sep: '/' };

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
test('buildPathFromComponentPath: missing componentPath → supported:false; type-3 with valid path resolves as webfile', () => {
  assert.equal(buildPathFromComponentPath({ type: 8, rootFolder: 'solutions', gitFolder: 'RetailOS' }).supported, false);
  // type 3 with a valid componentPath now resolves to a webfile path (not supported:false)
  const r3 = buildPathFromComponentPath({ componentPath: '/powerpagesites/RetailOS/web-files/theme.css', type: 3, rootFolder: 'solutions', gitFolder: 'RetailOS' });
  assert.equal(r3.kind, 'webfile');
  assert.equal(r3.field, null);
  assert.match(r3.path, /web-files\/theme\.css$/);
  // type 3 with no componentPath still returns supported:false
  assert.equal(buildPathFromComponentPath({ type: 3, rootFolder: 'solutions', gitFolder: 'RetailOS' }).supported, false);
});

// ---- A1: string type names behave IDENTICALLY to numeric types ----
test('A1 buildPathFromComponentPath: string type "webtemplate" === numeric 8', () => {
  const args = { componentPath: '/powerpagesites/RetailOS/web-templates/Search-Results', rootFolder: 'solutions', gitFolder: 'RetailOS' };
  const byNum = buildPathFromComponentPath({ ...args, type: 8 });
  const byName = buildPathFromComponentPath({ ...args, type: 'webtemplate' });
  const byLabel = buildPathFromComponentPath({ ...args, type: 'Web Template' });
  assert.equal(byName.path, byNum.path);
  assert.equal(byLabel.path, byNum.path);
  assert.equal(byName.field, 'source');
});
test('A1 buildPathFromComponentPath: string type "webpage" === numeric 2 (with subfolder)', () => {
  const args = { componentPath: '/powerpagesites/RetailOS/web-pages/Home', rootFolder: 'solutions', gitFolder: 'RetailOS' };
  assert.equal(
    buildPathFromComponentPath({ ...args, type: 'webpage' }).path,
    buildPathFromComponentPath({ ...args, type: 2 }).path,
  );
});
test('A1 buildSourceFilePath: string type "contentsnippet" === numeric 7', () => {
  const args = { name: 'Footer', rootFolder: 'solutions', gitFolder: 'RetailOS', siteName: 'RetailOS' };
  assert.equal(
    buildSourceFilePath({ ...args, type: 'contentsnippet' }).path,
    buildSourceFilePath({ ...args, type: 7 }).path,
  );
});
test('A1: numeric STRING "8" also normalizes to web template', () => {
  const r = buildPathFromComponentPath({ componentPath: '/powerpagesites/RetailOS/web-templates/Search-Results', type: '8', rootFolder: 'solutions', gitFolder: 'RetailOS' });
  assert.equal(r.field, 'source');
  assert.match(r.path, /Search-Results\.webtemplate\.source\.html$/);
});
test('buildSourceFilePath: web file (3) resolves as webfile path; site setting (9) is flat-yml selective-merge', () => {
  const wf = buildSourceFilePath({ type: 3, name: 'theme.css', ...COORDS });
  assert.equal(wf.kind, 'webfile');
  assert.equal(wf.field, null);
  assert.match(wf.path, /\/web-files\/theme\.css$/);
  assert.equal(wf.resolvedVia, 'computed');
  const ss = buildSourceFilePath({ type: 9, name: 'Auth/Foo', ...COORDS });
  assert.match(ss.path, /\/site-settings\/Auth-Foo\.sitesetting\.yml$/);
  assert.equal(ss.field, 'value');
  assert.equal(ss.format, 'flat-yml');
  // BINARY_TYPES is now empty — type 3 is classified 'webfile', type 9 was already removed
  assert.ok(!BINARY_TYPES[3] && !BINARY_TYPES[9]);
});
test('buildPathFromComponentPath: flat-yml site setting (9) — full-file OR slug-folder componentpath', () => {
  // (a) componentpath is the full file (website.yml style)
  const a = buildPathFromComponentPath({ componentPath: '/powerpagesites/RetailOS/site-settings/HTTP-X-Frame-Options.sitesetting.yml', type: 9, rootFolder: 'solutions', gitFolder: 'RetailOS' });
  assert.equal(a.field, 'value');
  assert.equal(a.format, 'flat-yml');
  assert.equal(a.path, '/solutions/RetailOS/powerpagesites/RetailOS/site-settings/HTTP-X-Frame-Options.sitesetting.yml');
  // (b) componentpath is the slug folder (no suffix) → suffix appended
  const b = buildPathFromComponentPath({ componentPath: '/powerpagesites/RetailOS/site-settings/HTTP-X-Frame-Options', type: 9, rootFolder: 'solutions', gitFolder: 'RetailOS' });
  assert.equal(b.path, '/solutions/RetailOS/powerpagesites/RetailOS/site-settings/HTTP-X-Frame-Options.sitesetting.yml');
  assert.equal(b.slug, 'HTTP-X-Frame-Options');
});
test('buildPathFromComponentPath: web file (3) from componentPath resolves to webfile path', () => {
  const r = buildPathFromComponentPath({
    componentPath: '/powerpagesites/RetailOS/web-files/theme.css', type: 3,
    rootFolder: 'solutions', gitFolder: 'RetailOS',
  });
  assert.equal(r.path, '/solutions/RetailOS/powerpagesites/RetailOS/web-files/theme.css');
  assert.equal(r.kind, 'webfile');
  assert.equal(r.field, null);
  assert.equal(r.resolvedVia, 'componentpath');
});
test('buildPathFromComponentPath: web file (3) string type "webfile" normalizes identically', () => {
  const byNum = buildPathFromComponentPath({
    componentPath: '/powerpagesites/RetailOS/web-files/logo.png', type: 3,
    rootFolder: 'solutions', gitFolder: 'RetailOS',
  });
  const byName = buildPathFromComponentPath({
    componentPath: '/powerpagesites/RetailOS/web-files/logo.png', type: 'webfile',
    rootFolder: 'solutions', gitFolder: 'RetailOS',
  });
  assert.equal(byName.path, byNum.path);
  assert.equal(byName.kind, 'webfile');
});

// ---- Bug 2: code-site source files resolve to their plain repo path ----
test('buildPathFromComponentPath: code-site source file resolves to /<root>/<git> + componentPath', () => {
  const r = buildPathFromComponentPath({
    componentPath: '/powerpagescodesites/QuickFix/src/pages/Home.tsx', type: 'sourcefile',
    rootFolder: 'solutions', gitFolder: 'QuickFix',
  });
  assert.equal(r.path, '/solutions/QuickFix/powerpagescodesites/QuickFix/src/pages/Home.tsx');
  assert.equal(r.kind, 'sourcefile');
  assert.equal(r.field, null);
  assert.equal(r.resolvedVia, 'componentpath');
});

test('buildPathFromComponentPath: source file detected from .sourcefile component NAME via type sentinel', () => {
  // The resolver passes the enriched ppcType ('sourcefile'); the path comes from the row.
  const r = buildPathFromComponentPath({
    componentPath: '/powerpagescodesites/QuickFix/src/styles/app.css', type: 'sourcefile',
    rootFolder: 'solutions', gitFolder: 'QuickFix',
  });
  assert.equal(r.path, '/solutions/QuickFix/powerpagescodesites/QuickFix/src/styles/app.css');
  assert.equal(r.kind, 'sourcefile');
});

test('buildPathFromComponentPath: source file with no componentPath → unsupported (fail closed)', () => {
  const r = buildPathFromComponentPath({ type: 'sourcefile', rootFolder: 'solutions', gitFolder: 'QuickFix' });
  assert.equal(r.supported, false);
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
  // Web Role (type 11) is unsupported — returns supported:false without any ADO call.
  const r = await resolveSourceFilePath({
    type: 11, name: 'Authenticated', ...COORDS,
    branch: 'b', organization: 'o', project: 'p', repository: 'r', pat: 'P', baseUrl: 'http://127.0.0.1:1',
  });
  assert.equal(r.supported, false);
});

test('resolveSourceFilePath: web file (3) resolves as webfile without any ADO call', async () => {
  // baseUrl points to an unreachable port — if any ADO call were made, the test would fail.
  const r = await resolveSourceFilePath({
    type: 3, name: 'theme.css', ...COORDS,
    branch: 'b', organization: 'o', project: 'p', repository: 'r', pat: 'P', baseUrl: 'http://127.0.0.1:1',
  });
  assert.equal(r.kind, 'webfile');
  assert.equal(r.field, null);
  assert.match(r.path, /\/web-files\/theme\.css$/);
  assert.equal(r.resolvedVia, 'computed');
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

// ---- resolveWebFileLeaf: containerized web-file layout (EISDIR fix) ----
test('resolveWebFileLeaf: container folder → inner same-name leaf (pac layout)', () => {
  const tree = {
    '/repo/solutions/RetailOS/web-files/theme.css': ['theme.css', 'theme.css.webfile.yml'],
    '/repo/solutions/RetailOS/web-files/theme.css/theme.css': 'file',
  };
  const leaf = resolveWebFileLeaf({
    repoDir: '/repo', webFilePath: '/solutions/RetailOS/web-files/theme.css',
    fsImpl: fakeFs(tree), pathImpl: posixPath,
  });
  assert.equal(leaf, '/solutions/RetailOS/web-files/theme.css/theme.css');
});
test('resolveWebFileLeaf: legacy flat layout (path is already a file) is unchanged', () => {
  const tree = { '/repo/solutions/RetailOS/web-files/old.css': 'file' };
  const leaf = resolveWebFileLeaf({
    repoDir: '/repo', webFilePath: '/solutions/RetailOS/web-files/old.css',
    fsImpl: fakeFs(tree), pathImpl: posixPath,
  });
  assert.equal(leaf, '/solutions/RetailOS/web-files/old.css');
});
test('resolveWebFileLeaf: renamed inner leaf → the lone non-sidecar file', () => {
  const tree = {
    '/repo/x/web-files/foo': ['actual-bytes.bin', 'foo.webfile.yml'],
    // note: NO same-name 'foo' leaf — statSync(.../foo/foo) throws ENOENT
  };
  const leaf = resolveWebFileLeaf({
    repoDir: '/repo', webFilePath: '/x/web-files/foo',
    fsImpl: fakeFs(tree), pathImpl: posixPath,
  });
  assert.equal(leaf, '/x/web-files/foo/actual-bytes.bin');
});
test('resolveWebFileLeaf: path not present (add/add) → deterministic container leaf', () => {
  const leaf = resolveWebFileLeaf({
    repoDir: '/repo', webFilePath: '/x/web-files/new.css',
    fsImpl: fakeFs({}), pathImpl: posixPath,
  });
  assert.equal(leaf, '/x/web-files/new.css/new.css');
});
test('resolveWebFileLeaf: no repoDir → returns input unchanged', () => {
  assert.equal(resolveWebFileLeaf({ webFilePath: '/x/web-files/a.css' }), '/x/web-files/a.css');
  assert.equal(resolveWebFileLeaf({ repoDir: '/repo' }), undefined);
});
test('resolveWebFileLeaf: preserves no-leading-slash style', () => {
  const tree = {
    '/repo/x/web-files/a.css': ['a.css'],
    '/repo/x/web-files/a.css/a.css': 'file',
  };
  const leaf = resolveWebFileLeaf({
    repoDir: '/repo', webFilePath: 'x/web-files/a.css', fsImpl: fakeFs(tree), pathImpl: posixPath,
  });
  assert.equal(leaf, 'x/web-files/a.css/a.css'); // no leading slash, matching input
});
