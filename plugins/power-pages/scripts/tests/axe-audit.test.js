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
});

test('auditRoutes bypasses CSP, injects axe on every route, and records navigation failures', async () => {
  const { playwright, calls } = fakePlaywright({ failRoutes: ['/broken'] });
  const results = await axe.auditRoutes({ playwright, channel: 'chrome', url: 'https://contoso.powerappsportals.com', routes: ['/', '/broken'] });

  assert.deepEqual(calls.launch, [{ channel: 'chrome', headless: true }]);
  assert.deepEqual(calls.contexts, [{ bypassCSP: true }]);
  assert.deepEqual(calls.gotos, ['https://contoso.powerappsportals.com/', 'https://contoso.powerappsportals.com/broken']);
  assert.deepEqual(calls.scripts, [{ url: axe.AXE_CDN_URL }]);
  assert.equal(results[0].passes, 12);
  assert.match(results[1].error, /ERR_FAILED/);
  assert.deepEqual(results[1].violations, []);
  assert.equal(calls.closed, true);
});

test('main exits 1 only for critical or serious violations', async () => {
  const run = async (impact) => {
    const { playwright } = fakePlaywright({ violationsFor: (route) => (route === '/about' ? [{ id: 'x', impact, nodes: [] }] : []) });
    let out = '';
    const code = await axe.main(['--url', 'http://localhost:5173', '--routes', '/,/about'], {
      write: (s) => { out += s; },
      writeError: () => {},
      loadPlaywrightFn: () => playwright,
      channel: () => undefined,
    });
    return { code, results: JSON.parse(out) };
  };

  assert.equal((await run('moderate')).code, 0);
  const serious = await run('serious');
  assert.equal(serious.code, 1);
  assert.equal(serious.results[1].violations[0].impact, 'serious');
});

test('main passes --project-root to the Playwright loader and fails when none loads', async () => {
  const roots = [];
  let err = '';
  const code = await axe.main(['--url', 'http://localhost:5173', '--routes', '/'], {
    write: () => {},
    writeError: (s) => { err += s; },
    loadPlaywrightFn: (root) => { roots.push(root); return null; },
  });
  assert.equal(code, 1);
  assert.deepEqual(roots, [undefined]);
  assert.match(err, /pinned @playwright\/mcp/);
});
