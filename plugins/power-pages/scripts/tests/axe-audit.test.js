const assert = require('node:assert/strict');
const test = require('node:test');

const axe = require('../axe-audit');

// A stand-in for the Playwright API surface the audit uses. `violationsFor` maps a route to
// the violations axe would report there; `failRoutes` make navigation throw.
function fakePlaywright({ violationsFor = () => [], failRoutes = [] } = {}) {
  const calls = { launch: [], contexts: [], gotos: [], scripts: [], closed: false };
  let current = '';
  const page = {
    goto: async (url) => {
      calls.gotos.push(url);
      current = url;
      if (failRoutes.some((r) => url.endsWith(r))) throw new Error(`net::ERR_FAILED ${url}`);
    },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    addScriptTag: async (options) => calls.scripts.push(options),
    waitForFunction: async () => {},
    evaluate: async (fn, tags) => {
      assert.equal(fn, axe.runAxe);
      assert.deepEqual(tags, axe.WCAG_TAGS);
      return { violations: violationsFor(new URL(current).pathname), passes: 12, incomplete: 1 };
    },
  };
  const playwright = {
    chromium: {
      launch: async (options) => {
        calls.launch.push(options);
        return {
          newContext: async (options) => {
            calls.contexts.push(options);
            return { newPage: async () => page };
          },
          close: async () => { calls.closed = true; },
        };
      },
    },
  };
  return { playwright, calls };
}

test('parseArgs requires a URL and routes, and reduces the URL to origin and path', () => {
  assert.ok(axe.parseArgs([]).error);
  assert.ok(axe.parseArgs(['--url', 'http://localhost:5173']).error);
  assert.deepEqual(axe.parseArgs(['--url', 'https://contoso.powerappsportals.com/', '--routes', '/, /about']), {
    url: 'https://contoso.powerappsportals.com',
    routes: ['/', '/about'],
  });
  assert.equal(axe.parseArgs(['--url', 'https://contoso.example/en-US/?sig=abc#top', '--routes', '/']).url, 'https://contoso.example/en-US');
  assert.equal(axe.parseArgs(['--url', 'http://x', '--routes', '/', '--project-root', 'site']).projectRoot, undefined, 'a project folder is never used');
  assert.deepEqual(axe.parseArgs(['--url', 'http://x', '--routes', 'about,/faq']).routes, ['/about', '/faq']);
  assert.match(axe.parseArgs(['--url', 'file:///etc/hosts', '--routes', '/']).error, /http and https/);
});

test('auditRoutes bypasses CSP, injects axe on every route, and records navigation failures', async () => {
  const { playwright, calls } = fakePlaywright({ failRoutes: ['/broken'] });
  const results = await axe.auditRoutes({ playwright, channel: 'chrome', url: 'https://contoso.powerappsportals.com', routes: ['/', '/broken'], axeSource: 'VERIFIED_AXE' });

  assert.deepEqual(calls.launch, [{ channel: 'chrome', headless: true }]);
  assert.deepEqual(calls.contexts, [{ bypassCSP: true }]);
  assert.deepEqual(calls.gotos, ['https://contoso.powerappsportals.com/', 'https://contoso.powerappsportals.com/broken']);
  // The verified source is injected inline; the page never fetches axe from the CDN itself.
  assert.deepEqual(calls.scripts, [{ content: 'VERIFIED_AXE' }]);
  assert.equal(results[0].passes, 12);
  assert.match(results[1].error, /ERR_FAILED/);
  assert.deepEqual(results[1].violations, []);
  assert.equal(calls.closed, true);
});

test('main exits 1 for critical or serious violations and for routes it could not audit', async () => {
  const run = async (impact, failRoutes = []) => {
    const { playwright } = fakePlaywright({ failRoutes, violationsFor: (route) => (route === '/about' ? [{ id: 'x', impact, nodes: [] }] : []) });
    let out = '';
    const code = await axe.main(['--url', 'http://localhost:5173', '--routes', '/,/about'], {
      write: (s) => { out += s; },
      writeError: () => {},
      loadPlaywrightFn: () => playwright,
      loadAxeSourceFn: async () => 'VERIFIED_AXE',
      channel: () => undefined,
    });
    return { code, results: JSON.parse(out) };
  };

  assert.equal((await run('moderate')).code, 0);
  const serious = await run('serious');
  assert.equal(serious.code, 1);
  assert.equal(serious.results[1].violations[0].impact, 'serious');

  const unaudited = await run('minor', ['/about']);
  assert.equal(unaudited.code, 1, 'a route that never loaded must not read as a pass');
  assert.match(unaudited.results[1].error, /ERR_FAILED/);
});

test('main loads Playwright without any project path and fails when the pinned package is unavailable', async () => {
  const calls = [];
  let err = '';
  const code = await axe.main(['--url', 'http://localhost:5173', '--routes', '/', '--project-root', '/site'], {
    write: () => {},
    writeError: (s) => { err += s; },
    loadPlaywrightFn: (...args) => { calls.push(args); return null; },
    loadAxeSourceFn: async () => 'VERIFIED_AXE',
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, [[]], 'a --project-root argument is ignored, never passed to the loader');
  assert.match(err, /pinned @playwright\/mcp/);
});

test('main refuses to audit when axe-core does not match its pinned hash', async () => {
  let err = '';
  let launched = false;
  const code = await axe.main(['--url', 'http://localhost:5173', '--routes', '/'], {
    write: () => {},
    writeError: (s) => { err += s; },
    loadPlaywrightFn: () => { launched = true; return null; },
    loadAxeSourceFn: async () => { throw new Error('does not match its pinned sha512 hash; refusing to run it.'); },
  });
  assert.equal(code, 1);
  assert.equal(launched, false, 'no browser starts without a verified axe');
  assert.match(err, /axe-core could not be loaded: .*pinned sha512 hash/);
});

test('loadAxeSource downloads the pinned axe-core script and returns its text', async () => {
  const requested = [];
  const source = await axe.loadAxeSource({ download: async (spec) => { requested.push(spec); return Buffer.from('/*! axe */'); } });
  assert.equal(source, '/*! axe */');
  assert.deepEqual(requested, [axe.AXE_SCRIPT]);
  assert.match(axe.AXE_SCRIPT.url, /^https:\/\/.*axe-core\/4\.10\.3\/axe\.min\.js$/);
  assert.match(axe.AXE_SCRIPT.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
});

test('auditRoutes redacts URL queries in the violations it reports', async () => {
  const { playwright } = fakePlaywright({
    violationsFor: () => [{
      id: 'image-alt',
      impact: 'critical',
      nodes: [{
        html: '<div style="background-image:url(https://cdn.example/a.jpg?sig=SECRET)" data-url="/files/r.pdf?token=SECRET"><img src="/hero.jpg?sig=SECRET"></div>',
        target: ['img[src="/hero.jpg?sig=SECRET"]'],
        failureSummary: 'Fix any of the following: image at https://cdn.example/a.jpg?sig=SECRET has no alt',
      }],
    }],
  });
  const results = await axe.auditRoutes({ playwright, channel: 'chrome', url: 'https://contoso.example', routes: ['/'], axeSource: 'VERIFIED_AXE' });
  assert.equal(JSON.stringify(results).includes('SECRET'), false);
  assert.equal(
    results[0].violations[0].nodes[0].html,
    '<div style="background-image:url(https://cdn.example/a.jpg)" data-url="/files/r.pdf"><img src="/hero.jpg"></div>',
  );
  assert.deepEqual(results[0].violations[0].nodes[0].target, ['img[src="/hero.jpg"]']);
});

test('parseArgs reads a JSON request from stdin and keeps shell characters as data', () => {
  const request = { url: 'http://localhost:5173', routes: ['/a;b', 'c&d', '/$(id)'] };
  const parsed = axe.parseArgs(['--input', '-'], { readStdin: () => JSON.stringify(request) });
  assert.deepEqual(parsed, { url: 'http://localhost:5173', routes: ['/a;b', '/c&d', '/$(id)'] });
  assert.match(axe.parseArgs(['--input', '-'], { readStdin: () => '{"url":"http://x","routes":["/"],"projectRoot":"/p"}' }).error, /Unknown field.*projectRoot/);
  assert.match(axe.parseArgs(['--input', '-'], { readStdin: () => '{"url":"http://x","routes":["/"],"discover":3}' }).error, /Unknown field.*discover/);
  assert.match(axe.parseArgs(['--input', '-'], { readStdin: () => '{"url":"http://x","routes":"/"}' }).error, /routes.*wrong type/);
});

test('auditRoutes and main redact URL queries from errors', async () => {
  const { playwright } = fakePlaywright({ failRoutes: ['/preview?sig=SECRET'] });
  const results = await axe.auditRoutes({ playwright, channel: 'chrome', url: 'https://contoso.example', routes: ['/preview?sig=SECRET'], axeSource: 'VERIFIED_AXE' });
  assert.equal(results[0].url, 'https://contoso.example/preview');
  assert.match(results[0].error, /ERR_FAILED https:\/\/contoso\.example\/preview$/);

  let stderr = '';
  const failing = { chromium: { launch: async () => { throw new Error('launch failed at https://contoso.example/?sig=SECRET'); } } };
  const code = await axe.main(['--url', 'https://contoso.example', '--routes', '/'], {
    write() {}, writeError: (s) => { stderr += s; }, loadPlaywrightFn: () => failing, loadAxeSourceFn: async () => 'VERIFIED_AXE', channel: () => undefined,
  });
  assert.equal(code, 1);
  assert.equal(stderr.includes('SECRET'), false);
  assert.match(stderr, /https:\/\/contoso\.example\//);
});
