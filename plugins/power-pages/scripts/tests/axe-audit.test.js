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

test('parseArgs requires a URL and routes, and makes --project-root optional', () => {
  assert.ok(axe.parseArgs([]).error);
  assert.ok(axe.parseArgs(['--url', 'http://localhost:5173']).error);
  assert.deepEqual(axe.parseArgs(['--url', 'https://contoso.powerappsportals.com/', '--routes', '/, /about']), {
    url: 'https://contoso.powerappsportals.com',
    routes: ['/', '/about'],
  });
  assert.equal(axe.parseArgs(['--url', 'http://x', '--routes', '/', '--project-root', 'site']).projectRoot, 'site');
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

test('main passes --project-root to the Playwright loader and fails when none loads', async () => {
  const roots = [];
  let err = '';
  const code = await axe.main(['--url', 'http://localhost:5173', '--routes', '/'], {
    write: () => {},
    writeError: (s) => { err += s; },
    loadPlaywrightFn: (root) => { roots.push(root); return null; },
    loadAxeSourceFn: async () => 'VERIFIED_AXE',
  });
  assert.equal(code, 1);
  assert.deepEqual(roots, [undefined]);
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

test('stripUrlQueries drops query strings and fragments from URL attributes in axe snippets', () => {
  assert.equal(
    axe.stripUrlQueries('<img src="https://contoso.blob.core.windows.net/a.jpg?sv=2024&amp;sig=abc" alt="" class="hero">'),
    '<img src="https://contoso.blob.core.windows.net/a.jpg" alt="" class="hero">',
  );
  assert.equal(
    axe.stripUrlQueries("<img srcset='/a.jpg?w=1 1x, /b.jpg?token=x 2x'>"),
    "<img srcset='/a.jpg 1x, /b.jpg 2x'>",
  );
  assert.equal(axe.stripUrlQueries('a[href="/files/report.pdf?token=abc#p2"]'), 'a[href="/files/report.pdf"]');
  assert.equal(axe.stripUrlQueries('<p title="Why? Because.">Ask us?</p>'), '<p title="Why? Because.">Ask us?</p>', 'non-URL text is untouched');
});

test('auditRoutes redacts URL queries in the violations it reports', async () => {
  const { playwright } = fakePlaywright({
    violationsFor: () => [{ id: 'image-alt', impact: 'critical', nodes: [{ html: '<img src="/hero.jpg?sig=SECRET">', target: ['img[src="/hero.jpg?sig=SECRET"]'] }] }],
  });
  const results = await axe.auditRoutes({ playwright, channel: 'chrome', url: 'https://contoso.example', routes: ['/'], axeSource: 'VERIFIED_AXE' });
  assert.equal(JSON.stringify(results).includes('SECRET'), false);
  assert.equal(results[0].violations[0].nodes[0].html, '<img src="/hero.jpg">');
});
