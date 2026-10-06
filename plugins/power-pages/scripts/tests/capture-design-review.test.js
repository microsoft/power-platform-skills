const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const review = require('../../skills/create-site/scripts/capture-design-review');
const { loadProjectPlaywright } = require('../lib/load-project-playwright');
const { createPrivateTempDir, isOwnTempDir, sweepStaleTempDirs } = require('../lib/private-temp-dir');

// A stand-in for the Playwright API surface the capture uses. In-page functions are
// recognized by identity, so the fake answers exactly what the real browser would be asked.
function fakePlaywright({ pageHeight = 3000, overflowRoutes = [], failRoutes = [], events = {} } = {}) {
  const calls = { launch: [], contexts: [], screenshots: [], sheets: [], gotos: [] };
  const makePage = (viewport) => {
    const page = new EventEmitter();
    let current = '';
    page.goto = async (url) => {
      calls.gotos.push(url);
      current = url;
      if (failRoutes.some((r) => url.endsWith(r))) throw new Error(`net::ERR_FAILED ${url}`);
      for (const [name, payloads] of Object.entries(events)) {
        for (const payload of payloads(url)) page.emit(name, payload);
      }
    };
    page.waitForTimeout = async () => {};
    page.screenshot = async (options = {}) => {
      calls.screenshots.push({ viewport, ...options });
      if (options.path) fs.writeFileSync(options.path, 'png');
      return Buffer.from('png-bytes');
    };
    page.evaluate = async (fn) => {
      if (fn === review.scrollThrough) return undefined;
      if (fn === review.loadedFonts) return ['Public Sans', 'Schibsted Grotesk'];
      if (fn === review.pageHeight) return pageHeight;
      if (fn === review.measureOverflow) {
        return overflowRoutes.some((r) => current.endsWith(r) && viewport.width === 390)
          ? { overflow: true, scrollWidth: 398, clientWidth: 390, culprits: [] }
          : { overflow: false };
      }
      throw new Error('unexpected evaluate');
    };
    page.setContent = async (html) => calls.sheets.push({ viewport, html });
    page.close = async () => {};
    return page;
  };
  const browser = {
    pages: [],
    newContext: async ({ viewport }) => {
      calls.contexts.push(viewport);
      return {
        newPage: async () => {
          const page = makePage(viewport);
          browser.pages.push(page);
          return page;
        },
        close: async () => {},
      };
    },
    newPage: async ({ viewport }) => makePage(viewport),
    close: async () => { calls.browserClosed = true; },
  };
  return {
    calls,
    browser,
    playwright: { chromium: { launch: async (options) => { calls.launch.push(options); return browser; } } },
  };
}

const consoleMessage = (type, text) => ({ type: () => type, text: () => text });
const response = (status, url) => ({ status: () => status, url: () => url });

test('parseArgs reads a capture request and trims the base URL and route list', () => {
  assert.deepEqual(
    review.parseArgs(['--url', 'http://localhost:5173/', '--routes', '/, /about ,', '--project-root', '/p', '--checks-only']),
    { checksOnly: true, url: 'http://localhost:5173', routes: ['/', '/about'], projectRoot: '/p' },
  );
  assert.equal(review.parseArgs(['--cleanup', '/tmp/x']).cleanup, '/tmp/x');
  assert.match(review.parseArgs(['--url', 'http://localhost:5173']).error, /Usage/);
  assert.match(review.parseArgs(['--url', 'u', '--routes', ',', '--project-root', '/p']).error, /Usage/);
});

test('slugForRoute names screenshot files after the route', () => {
  assert.equal(review.slugForRoute('/'), 'home');
  assert.equal(review.slugForRoute('/about'), 'about');
  assert.equal(review.slugForRoute('/help/Moving-Home/'), 'help-moving-home');
});

test('buildMobileSheet lays a long mobile page out in columns two screens tall', () => {
  const segment = review.SHEET_SEGMENT_HEIGHT;
  const short = review.buildMobileSheet('AAAA', 1200);
  assert.equal(short.columns, 1);
  assert.equal(short.width, 390);
  assert.equal(short.height, 1200);

  const long = review.buildMobileSheet('AAAA', segment * 2 + 10);
  assert.equal(long.columns, 3);
  assert.equal(long.width, 3 * 390 + 2 * 16);
  assert.equal(long.height, segment);
  assert.match(long.html, new RegExp(`background-position:0 -${segment * 2}px`));
  assert.match(long.html, /\.fold\{[^}]*top:844px/);
  assert.equal(long.truncated, false);

  const huge = review.buildMobileSheet('AAAA', segment * 10);
  assert.equal(huge.columns, 6);
  assert.equal(huge.truncated, true);
});

test('captureDesignReview captures every route at both widths into the output directory', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
  try {
    const fake = fakePlaywright({ overflowRoutes: ['/venue'] });
    const result = await review.captureDesignReview({
      playwright: fake.playwright, channel: 'chrome', url: 'http://localhost:5173', routes: ['/', '/venue'], outputDir, checksOnly: false,
    });

    assert.deepEqual(fake.calls.launch, [{ channel: 'chrome', headless: true }]);
    assert.deepEqual(fake.calls.contexts, [review.VIEWPORTS.desktop, review.VIEWPORTS.mobile]);
    assert.equal(fake.calls.browserClosed, true);
    assert.deepEqual(result.routes.map((r) => r.route), ['/', '/venue']);

    const home = result.routes[0];
    assert.equal(home.desktop.viewport, path.join(outputDir, 'home-desktop.png'));
    assert.equal(home.desktop.fullPage, path.join(outputDir, 'home-desktop-full.png'));
    assert.equal(home.mobile.viewport, path.join(outputDir, 'home-mobile.png'));
    assert.equal(home.mobile.sheet, path.join(outputDir, 'home-mobile-sheet.png'));
    assert.deepEqual(home.desktop.fonts, ['Public Sans', 'Schibsted Grotesk']);
    for (const image of result.summary.images) {
      assert.equal(fs.existsSync(image), true, `${image} should be written`);
    }
    assert.equal(result.summary.images.length, 8);

    // The first screen is captured at load, before the page is scrolled through.
    const desktopShots = fake.calls.screenshots.filter((s) => s.viewport.width === 1440);
    assert.equal(desktopShots[0].fullPage, undefined);
    assert.equal(desktopShots[1].fullPage, true);
    assert.equal(fake.calls.sheets.length, 2, 'one mobile sheet per route');

    assert.deepEqual(result.routes[1].mobile.overflow, { overflow: true, scrollWidth: 398, clientWidth: 390, culprits: [] });
    assert.deepEqual(result.summary.overflow, ['/venue @ mobile']);
    assert.equal(result.outputDir, outputDir);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('captureDesignReview records page errors with URLs and skips favicon and duplicate resource noise', async () => {
  const fake = fakePlaywright({
    events: {
      pageerror: (url) => (url.endsWith('/') ? [new Error('boom')] : []),
      console: () => [consoleMessage('error', 'Failed to load resource: the server responded with a status of 404'), consoleMessage('warning', 'ignored'), consoleMessage('error', 'Uncaught TypeError')],
      response: () => [response(404, 'http://localhost:5173/missing.png'), response(404, 'http://localhost:5173/favicon.ico'), response(200, 'http://localhost:5173/ok.js')],
    },
  });
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'http://localhost:5173', routes: ['/', '/about'], outputDir: null, checksOnly: true,
  });

  assert.deepEqual(result.routes[0].desktop.pageErrors, ['boom', 'Uncaught TypeError', 'HTTP 404 http://localhost:5173/missing.png']);
  assert.deepEqual(result.routes[1].desktop.pageErrors, ['Uncaught TypeError', 'HTTP 404 http://localhost:5173/missing.png']);
  for (const page of fake.browser.pages) {
    for (const event of ['pageerror', 'console', 'response']) {
      assert.equal(page.listenerCount(event), 0, `${event} listeners must not accumulate across routes`);
    }
  }
});

test('captureDesignReview in checks-only mode takes no screenshots', async () => {
  const fake = fakePlaywright();
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: undefined, url: 'http://localhost:5173', routes: ['/'], outputDir: null, checksOnly: true,
  });

  assert.equal(fake.calls.screenshots.length, 0);
  assert.equal(result.outputDir, null);
  assert.deepEqual(result.summary.images, []);
  assert.deepEqual(result.routes[0].mobile.overflow, { overflow: false });
});

test('captureDesignReview records a route that fails to load and still captures the rest', async () => {
  const fake = fakePlaywright({ failRoutes: ['/broken'] });
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'http://localhost:5173', routes: ['/broken', '/'], outputDir: null, checksOnly: true,
  });

  assert.match(result.routes[0].desktop.captureError, /ERR_FAILED/);
  assert.deepEqual(result.routes[1].desktop.fonts, ['Public Sans', 'Schibsted Grotesk']);
  assert.equal(result.summary.captureErrors.length, 2);
});

test('main refuses to clean up anything but its own temp directories', async () => {
  let stderr = '';
  const writeError = (s) => { stderr += s; };
  assert.equal(await review.main(['--cleanup', os.homedir()], { write() {}, writeError }), 1);
  assert.match(stderr, /Refusing to remove/);

  const own = createPrivateTempDir(review.OUTPUT_DIR_PREFIX);
  let stdout = '';
  assert.equal(await review.main(['--cleanup', own], { write: (s) => { stdout += s; }, writeError }), 0);
  assert.equal(fs.existsSync(own), false);
  assert.deepEqual(JSON.parse(stdout), { removed: own });
});

test('main reports a missing playwright install and usage errors', async () => {
  let stderr = '';
  const writeError = (s) => { stderr += s; };
  const args = ['--url', 'http://localhost:5173', '--routes', '/', '--project-root', '/nowhere'];
  assert.equal(await review.main(args, { write() {}, writeError, loadPlaywright: () => null }), 1);
  assert.match(stderr, /npm install --save-dev playwright/);
  assert.equal(await review.main([], { write() {}, writeError }), 1);
  assert.match(stderr, /Usage/);
});

test('main prints the capture as JSON and creates no directory in checks-only mode', async () => {
  const fake = fakePlaywright();
  let stdout = '';
  const code = await review.main(
    ['--url', 'http://localhost:5173', '--routes', '/', '--project-root', '/p', '--checks-only'],
    { write: (s) => { stdout += s; }, writeError() {}, loadPlaywright: () => fake.playwright, channel: () => 'msedge' },
  );

  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.outputDir, null);
  assert.deepEqual(fake.calls.launch, [{ channel: 'msedge', headless: true }]);
});

test('loadProjectPlaywright tries a global install, then the project, then playwright-core', () => {
  const tried = [];
  const found = loadProjectPlaywright('/site', {
    requireFn(id) {
      tried.push(id);
      if (id === path.join('/site', 'node_modules', 'playwright')) return { chromium: 'project' };
      throw new Error('MODULE_NOT_FOUND');
    },
  });
  assert.deepEqual(found, { chromium: 'project' });
  assert.deepEqual(tried, ['playwright', path.join('/site', 'node_modules', 'playwright')]);
  assert.equal(loadProjectPlaywright('/site', { requireFn() { throw new Error('missing'); } }), null);
});

test('loadProjectPlaywright resolves a relative project root against the working directory', () => {
  const tried = [];
  loadProjectPlaywright('My Site', {
    requireFn(id) {
      tried.push(id);
      throw new Error('MODULE_NOT_FOUND');
    },
  });
  assert.equal(tried[1], path.join(process.cwd(), 'My Site', 'node_modules', 'playwright'));
});

test('isOwnTempDir accepts only prefixed direct children of the temp directory', () => {
  const tmp = os.tmpdir();
  assert.equal(isOwnTempDir(path.join(tmp, `${review.OUTPUT_DIR_PREFIX}abc`), review.OUTPUT_DIR_PREFIX), true);
  assert.equal(isOwnTempDir(path.join(tmp, 'other-abc'), review.OUTPUT_DIR_PREFIX), false);
  assert.equal(isOwnTempDir(path.join(tmp, 'nested', `${review.OUTPUT_DIR_PREFIX}abc`), review.OUTPUT_DIR_PREFIX), false);
  assert.equal(isOwnTempDir(path.join(tmp, `${review.OUTPUT_DIR_PREFIX}abc`, '..', '..'), review.OUTPUT_DIR_PREFIX), false);
  assert.equal(isOwnTempDir('', review.OUTPUT_DIR_PREFIX), false);
});

test('sweepStaleTempDirs only touches directories with the given prefix', () => {
  const removed = [];
  sweepStaleTempDirs(review.OUTPUT_DIR_PREFIX, {
    tmpdir: () => '/t',
    readdirSync: () => [`${review.OUTPUT_DIR_PREFIX}old`, 'power-pages-playwright-mcp-old'],
    lstatSync: () => ({ isDirectory: () => true, mtimeMs: 0, uid: 1 }),
    rmSync: (dir) => removed.push(dir),
    now: () => Date.now(),
    uid: 1,
  });
  assert.deepEqual(removed, [path.join('/t', `${review.OUTPUT_DIR_PREFIX}old`)]);
});
