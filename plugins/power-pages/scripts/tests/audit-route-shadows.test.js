const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  auditRouteShadows,
  readWebpageYaml,
  collectSpaRoutes,
  normalizeUrl,
} = require('../audit-route-shadows');

function makeProjectRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'route-shadow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

// normalizeUrl ----------------------------------------------------------------

test('normalizeUrl strips leading and trailing slashes', () => {
  assert.equal(normalizeUrl('/profile/'), 'profile');
  assert.equal(normalizeUrl('profile'), 'profile');
  assert.equal(normalizeUrl('///profile///'), 'profile');
});

test('normalizeUrl lowercases', () => {
  assert.equal(normalizeUrl('/Profile'), 'profile');
});

test('normalizeUrl handles empty input', () => {
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl(null), '');
});

// readWebpageYaml -------------------------------------------------------------

test('readWebpageYaml extracts adx_partialurl, adx_pagetemplateid, and adx_name from a top-level YAML', (t) => {
  const root = makeProjectRoot(t);
  write(
    root,
    'page.yml',
    [
      'adx_name: Profile',
      'adx_partialurl: profile',
      'adx_pagetemplateid: 11111111-1111-1111-1111-111111111111',
      '',
    ].join('\n'),
  );
  const parsed = readWebpageYaml(path.join(root, 'page.yml'));
  assert.equal(parsed.name, 'Profile');
  assert.equal(parsed.partialUrl, 'profile');
  assert.equal(parsed.pageTemplate, '11111111-1111-1111-1111-111111111111');
});

test('readWebpageYaml ignores indented (nested-record) adx_partialurl entries', (t) => {
  const root = makeProjectRoot(t);
  // A nested adx_partialurl under a child record must not be returned as the
  // page's URL. The page's own value is what shadows the SPA route.
  write(
    root,
    'page.yml',
    [
      'adx_name: Top',
      'adx_partialurl: top-url',
      'children:',
      '  - adx_partialurl: child-url',
      '',
    ].join('\n'),
  );
  const parsed = readWebpageYaml(path.join(root, 'page.yml'));
  assert.equal(parsed.partialUrl, 'top-url');
});

// collectSpaRoutes ------------------------------------------------------------

test('collectSpaRoutes pulls from canonical routes[]', () => {
  const map = collectSpaRoutes({
    routes: [{ route: '/profile' }, { route: '/about' }],
  });
  assert.ok(map.has('profile'));
  assert.ok(map.has('about'));
  assert.equal(map.get('profile').route, '/profile');
});

test('collectSpaRoutes also accepts componentMapping[] as a fallback shape', () => {
  const map = collectSpaRoutes({
    componentMapping: [{ route: '/article-list' }],
  });
  assert.ok(map.has('article-list'));
});

test('collectSpaRoutes prefers routes[] over componentMapping[] when both name the same URL', () => {
  const map = collectSpaRoutes({
    routes: [{ route: '/dup' }],
    componentMapping: [{ route: '/dup' }],
  });
  // Map.set on a duplicate key in routes[] (which we visit first) wins; the
  // later componentMapping[] visit must not overwrite. plannedSource reflects this.
  assert.equal(map.get('dup').source, 'routes[]');
});

// auditRouteShadows — class 1 (deployed-webpage-shadow) -----------------------

test('auditRouteShadows flags a deployed webpage whose partialurl matches a SPA route', (t) => {
  // The exact bug from the migration retrospective: hydrated .powerpages-site/web-pages/
  // included a Profile.webpage.yml from the source EDM (adx_partialurl: profile), and
  // the migrated SPA's /profile route was shadowed by it at runtime.
  const root = makeProjectRoot(t);
  write(
    root,
    '.powerpages-site/web-pages/profile/Profile.webpage.yml',
    'adx_name: Profile\nadx_partialurl: profile\nadx_pagetemplateid: 22222222-2222-2222-2222-222222222222\n',
  );
  const findings = auditRouteShadows({
    projectRoot: root,
    canonicalModel: { routes: [{ route: '/profile' }] },
  });
  // Two findings expected for /profile: the deployed-webpage-shadow AND the
  // server-rendered-route (Profile is in SERVER_RENDERED_ROUTE_SHADOWS).
  const shadow = findings.find((f) => f.kind === 'deployed-webpage-shadow');
  assert.ok(shadow);
  assert.equal(shadow.severity, 'blocker');
  assert.equal(shadow.url, '/profile');
  assert.match(shadow.webpageYaml, /Profile\.webpage\.yml$/);
});

test('auditRouteShadows returns empty findings when no webpages collide with the SPA routes', (t) => {
  const root = makeProjectRoot(t);
  write(
    root,
    '.powerpages-site/web-pages/articles/Articles.webpage.yml',
    'adx_name: Articles\nadx_partialurl: articles\n',
  );
  const findings = auditRouteShadows({
    projectRoot: root,
    canonicalModel: { routes: [{ route: '/about' }] }, // no /articles route in the plan
  });
  assert.deepEqual(findings, []);
});

test('auditRouteShadows is case- and slash-insensitive when matching', (t) => {
  const root = makeProjectRoot(t);
  write(
    root,
    '.powerpages-site/web-pages/about/About.webpage.yml',
    'adx_name: About\nadx_partialurl: /About/\n', // odd casing + slashes
  );
  const findings = auditRouteShadows({
    projectRoot: root,
    canonicalModel: { routes: [{ route: 'about' }] }, // no slashes
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].url, '/about');
});

// auditRouteShadows — class 2 (server-rendered-route) -------------------------

test('auditRouteShadows flags a SPA /profile route as a server-rendered-route (Power Pages always rewrites it)', (t) => {
  const root = makeProjectRoot(t);
  const findings = auditRouteShadows({
    projectRoot: root,
    canonicalModel: { routes: [{ route: '/profile' }] },
  });
  const sr = findings.find((f) => f.kind === 'server-rendered-route');
  assert.ok(sr);
  assert.equal(sr.severity, 'blocker');
  assert.equal(sr.knownTemplate, 'Profile');
});

test('auditRouteShadows flags a SPA /sign-in route as a server-rendered-route', (t) => {
  const root = makeProjectRoot(t);
  const findings = auditRouteShadows({
    projectRoot: root,
    canonicalModel: { routes: [{ route: '/sign-in' }] },
  });
  const sr = findings.find((f) => f.kind === 'server-rendered-route');
  assert.ok(sr);
  assert.equal(sr.knownTemplate, 'Sign-In');
});

test('auditRouteShadows does not flag routes that are neither server-rendered nor shadowed by a deployed webpage', (t) => {
  const root = makeProjectRoot(t);
  const findings = auditRouteShadows({
    projectRoot: root,
    canonicalModel: { routes: [{ route: '/articles' }, { route: '/contact' }] },
  });
  assert.deepEqual(findings, []);
});

// auditRouteShadows — robustness ----------------------------------------------

test('auditRouteShadows tolerates a missing .powerpages-site directory', (t) => {
  // Common state: pre-deploy. The audit should still run for class-2 findings
  // (server-rendered-route) and emit class-1 as empty rather than throwing.
  const root = makeProjectRoot(t);
  const findings = auditRouteShadows({
    projectRoot: root,
    canonicalModel: { routes: [{ route: '/profile' }, { route: '/articles' }] },
  });
  // /profile is server-rendered → 1 finding. /articles is clean.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'server-rendered-route');
});
