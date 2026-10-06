const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const review = require('../capture-design-review');
const { findPinnedNodeModules, loadPinnedPlaywright, loadPlaywright, loadProjectPlaywright } = require('../lib/load-playwright');
const { createPrivateTempDir, isOwnTempDir, sweepStaleTempDirs } = require('../lib/private-temp-dir');

// A stand-in for the Playwright API surface the capture uses. In-page functions are
// recognized by identity, so the fake answers exactly what the real browser would be asked.
function fakePlaywright({ pageHeight = 3000, overflowRoutes = [], failRoutes = [], events = {}, synthetic = [], discovered = [], redirects = {} } = {}) {
  const calls = { launch: [], contexts: [], screenshots: [], sheets: [], gotos: [] };
  const makePage = (viewport) => {
    const page = new EventEmitter();
    let current = '';
    page.goto = async (url) => {
      calls.gotos.push(url);
      // `redirects` maps a requested path to where the server sends the browser instead.
      current = redirects[new URL(url).pathname] || url;
      if (failRoutes.some((r) => url.endsWith(r))) throw new Error(`net::ERR_FAILED ${url}`);
      for (const [name, payloads] of Object.entries(events)) {
        for (const payload of payloads(url)) page.emit(name, payload);
      }
    };
    page.url = () => current;
    page.waitForTimeout = async () => {};
    page.waitForLoadState = async () => {};
    page.screenshot = async (options = {}) => {
      calls.screenshots.push({ viewport, ...options });
      if (options.path) fs.writeFileSync(options.path, 'png');
      return Buffer.from('png-bytes');
    };
    page.evaluate = async (fn) => {
      if (fn === review.scrollThrough) return undefined;
      if (fn === review.loadedFonts) return ['Public Sans', 'Schibsted Grotesk'];
      if (fn === review.pageHeight) return pageHeight;
      if (fn === review.findSyntheticWeights) return synthetic;
      if (fn === review.discoverLinks) return discovered;
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
const failedRequest = (url, errorText) => ({ url: () => url, failure: () => (errorText ? { errorText } : null) });

test('parseArgs reads a capture request and trims the base URL and route list', () => {
  assert.deepEqual(
    review.parseArgs(['--url', 'http://localhost:5173/', '--routes', '/, /about ,', '--project-root', '/p', '--checks-only']),
    { checksOnly: true, url: 'http://localhost:5173', routes: ['/', '/about'], projectRoot: '/p' },
  );
  assert.equal(review.parseArgs(['--cleanup', '/tmp/x']).cleanup, '/tmp/x');
  assert.match(review.parseArgs(['--url', 'http://localhost:5173']).error, /Usage/);
  assert.match(review.parseArgs(['--url', 'u', '--routes', ',', '--project-root', '/p']).error, /Usage/);
});

test('parseArgs anchors routes given without a leading slash', () => {
  assert.deepEqual(review.parseArgs(['--url', 'http://localhost:5173', '--routes', 'about, /faq']).routes, ['/about', '/faq']);
});

test('parseArgs takes either routes or a discover limit, and the project root is optional', () => {
  assert.deepEqual(review.parseArgs(['--url', 'https://contoso.example', '--discover', '6']), { checksOnly: false, url: 'https://contoso.example', discover: 6 });
  assert.deepEqual(review.parseArgs(['--url', 'http://localhost:5173', '--routes', '/']).routes, ['/']);
  assert.match(review.parseArgs(['--url', 'u', '--routes', '/', '--discover', '3']).error, /Usage/);
  assert.match(review.parseArgs(['--url', 'u', '--discover', '0']).error, /Usage/);
});

test('slugForRoute names screenshot files after the route', () => {
  assert.equal(review.slugForRoute('/'), 'home');
  assert.equal(review.slugForRoute('/about'), 'about');
  assert.equal(review.slugForRoute('/help/Moving-Home/'), 'help-moving-home');
});

test('planMobileSheets slices a page into columns two screens tall, six to a sheet', () => {
  const segment = review.SHEET_SEGMENT_HEIGHT;
  const short = review.planMobileSheets(1200);
  assert.deepEqual(short.sheets, [[{ x: 0, y: 0, width: 390, height: 1200 }]]);
  assert.equal(short.truncated, false);

  const long = review.planMobileSheets(segment * 10 + 100);
  assert.deepEqual(long.sheets.map((sheet) => sheet.length), [6, 5]);
  assert.deepEqual(long.sheets[1][0], { x: 0, y: segment * 6, width: 390, height: segment });
  assert.deepEqual(long.sheets[1][4], { x: 0, y: segment * 10, width: 390, height: 100 }, 'the last slice ends at the page end');
  assert.equal(long.truncated, false, 'the end of a 17,000 px page is still shown');

  const endless = review.planMobileSheets(segment * 40);
  assert.equal(endless.sheets.length, review.SHEET_MAX_SHEETS);
  assert.equal(endless.truncated, true);
});

test('buildMobileSheet places column images side by side with the fold only on the first sheet', () => {
  const segment = review.SHEET_SEGMENT_HEIGHT;
  const columns = [{ base64: 'AAAA', height: segment }, { base64: 'BBBB', height: segment }, { base64: 'CCCC', height: 300 }];
  const first = review.buildMobileSheet(columns);
  assert.equal(first.width, 3 * 390 + 2 * 16);
  assert.equal(first.height, segment);
  assert.match(first.html, /left:812px;height:300px" src="data:image\/png;base64,CCCC"/);
  assert.match(first.html, /\.fold\{[^}]*top:844px/);
  assert.match(first.html, /class="fold"/);

  const later = review.buildMobileSheet([{ base64: 'DDDD', height: 500 }], { fold: false });
  assert.equal(later.width, 390);
  assert.equal(later.height, 500);
  assert.doesNotMatch(later.html, /class="fold"/);
});

test('captureDesignReview writes every mobile sheet and reports a truncated page', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
  try {
    const segment = review.SHEET_SEGMENT_HEIGHT;
    const long = fakePlaywright({ pageHeight: segment * 10 });
    const result = await review.captureDesignReview({
      playwright: long.playwright, channel: 'chrome', url: 'http://localhost:5173', routes: ['/'], outputDir, checksOnly: false,
    });
    assert.deepEqual(result.routes[0].mobile.sheets, [
      path.join(outputDir, 'home-mobile-sheet.png'),
      path.join(outputDir, 'home-mobile-sheet-2.png'),
    ]);
    // Each column is its own clipped capture, so the last one is taken at the page's end.
    const clipShots = long.calls.screenshots.filter((shot) => shot.clip);
    assert.deepEqual(clipShots.map((shot) => shot.clip.y), Array.from({ length: 10 }, (_, i) => i * segment));
    assert.ok(clipShots.every((shot) => shot.fullPage === true), 'a clip below the first screen needs fullPage to be document-relative');
    assert.ok(result.summary.images.includes(path.join(outputDir, 'home-mobile-sheet-2.png')));
    assert.deepEqual(result.summary.truncated, []);

    const endless = fakePlaywright({ pageHeight: segment * 40 });
    const feed = await review.captureDesignReview({
      playwright: endless.playwright, channel: 'chrome', url: 'http://localhost:5173', routes: ['/feed'], outputDir, checksOnly: false,
    });
    assert.equal(feed.routes[0].mobile.sheets.length, review.SHEET_MAX_SHEETS);
    assert.deepEqual(feed.summary.truncated, ['/feed @ mobile']);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('findSyntheticWeights checks every heading level against the loaded faces', () => {
  // Stands in for the browser globals the in-page function reads.
  const headings = [
    { tagName: 'H1', style: { fontFamily: '"Instrument Serif", serif', fontWeight: '400' } },
    { tagName: 'H2', style: { fontFamily: 'Fraunces, serif', fontWeight: '800' } },
    { tagName: 'H5', style: { fontFamily: '"Instrument Serif", serif', fontWeight: '700' } },
    { tagName: 'H6', style: { fontFamily: 'system-ui', fontWeight: 'bold' } },
  ];
  const saved = { document: global.document, getComputedStyle: global.getComputedStyle };
  global.document = {
    fonts: [
      { family: '"Instrument Serif"', weight: '400', status: 'loaded' },
      { family: 'Fraunces', weight: '100 900', status: 'loaded' },
    ],
    querySelectorAll: (selector) => {
      const tags = selector.split(',').map((tag) => tag.trim().toUpperCase());
      return headings.filter((h) => tags.includes(h.tagName));
    },
  };
  global.getComputedStyle = (el) => el.style;
  try {
    // h6 uses a family the page never loaded (a system font), so there is nothing to compare.
    assert.deepEqual(review.findSyntheticWeights(), ['h5: Instrument Serif 700']);
  } finally {
    global.document = saved.document;
    global.getComputedStyle = saved.getComputedStyle;
  }
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
    assert.deepEqual(home.mobile.sheets, [path.join(outputDir, 'home-mobile-sheet.png')]);
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
      response: () => [response(404, 'http://localhost:5173/missing.png?sig=SECRET#frag'), response(404, 'http://localhost:5173/favicon.ico'), response(200, 'http://localhost:5173/ok.js')],
      requestfailed: () => [
        failedRequest('https://cdn.example/font.woff2?token=SECRET', 'net::ERR_NAME_NOT_RESOLVED'),
        failedRequest('https://images.example/lazy.jpg', 'net::ERR_ABORTED'),
        failedRequest('http://localhost:5173/favicon.ico', 'net::ERR_CONNECTION_REFUSED'),
      ],
    },
  });
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'http://localhost:5173', routes: ['/', '/about'], outputDir: null, checksOnly: true,
  });

  const failed = 'FAILED https://cdn.example/font.woff2 (net::ERR_NAME_NOT_RESOLVED)';
  assert.deepEqual(result.routes[0].desktop.pageErrors, ['boom', 'Uncaught TypeError', 'HTTP 404 http://localhost:5173/missing.png', failed]);
  assert.deepEqual(result.routes[1].desktop.pageErrors, ['Uncaught TypeError', 'HTTP 404 http://localhost:5173/missing.png', failed]);
  assert.equal(JSON.stringify(result).includes('SECRET'), false, 'query strings and fragments are dropped from reported URLs');
  for (const page of fake.browser.pages) {
    for (const event of ['pageerror', 'console', 'response', 'requestfailed']) {
      assert.equal(page.listenerCount(event), 0, `${event} listeners must not accumulate across routes`);
    }
  }
});

test('captureDesignReview reports headings drawn in a synthesized weight', async () => {
  const fake = fakePlaywright({ synthetic: ['h1: Instrument Serif 700'] });
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'http://localhost:5173', routes: ['/', '/about'], outputDir: null, checksOnly: true,
  });

  assert.deepEqual(result.routes[0].desktop.syntheticWeights, ['h1: Instrument Serif 700']);
  assert.deepEqual(result.summary.syntheticWeights, ['h1: Instrument Serif 700'], 'listed once across routes and widths');
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

test('main --cleanup fails and names the directory when it cannot be removed', async () => {
  const own = createPrivateTempDir(review.OUTPUT_DIR_PREFIX);
  try {
    let stdout = '';
    let stderr = '';
    // Stands in for a deletion that silently fails, e.g. a file locked by an image viewer.
    const code = await review.main(['--cleanup', own], {
      write: (s) => { stdout += s; }, writeError: (s) => { stderr += s; }, removeDirFn() {},
    });
    assert.equal(code, 1);
    assert.equal(stdout, '', 'no success report');
    assert.ok(stderr.includes(`Could not remove ${own}`), stderr);
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
});

test('uniqueSlugs keeps readable names and separates routes that share a slug', () => {
  const slugs = review.uniqueSlugs(['/', '/help/Moving-Home/', '/help-moving-home', '/About', '/about']);
  assert.equal(slugs[0], 'home');
  assert.equal(slugs[1], 'help-moving-home');
  assert.match(slugs[2], /^help-moving-home-[0-9a-f]{8}$/);
  assert.equal(slugs[3], 'about');
  assert.match(slugs[4], /^about-[0-9a-f]{8}$/);
  assert.equal(new Set(slugs).size, slugs.length);
  // The suffix depends only on the route text, so it is the same in every capture.
  assert.equal(review.uniqueSlugs(['/x', '/help/Moving-Home/', '/help-moving-home'])[2], slugs[2]);
});

test('captureDesignReview gives colliding routes separate screenshot files', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
  try {
    const fake = fakePlaywright();
    const result = await review.captureDesignReview({
      playwright: fake.playwright, channel: 'chrome', url: 'http://localhost:5173', routes: ['/help/Moving-Home/', '/help-moving-home'], outputDir, checksOnly: false,
    });
    const [first, second] = result.routes;
    assert.equal(first.desktop.viewport, path.join(outputDir, 'help-moving-home-desktop.png'));
    assert.notEqual(first.desktop.viewport, second.desktop.viewport);
    assert.notEqual(first.mobile.sheets[0], second.mobile.sheets[0]);
    assert.equal(new Set(result.summary.images).size, result.summary.images.length, 'no image path is shared');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('main reports a missing playwright install and usage errors', async () => {
  let stderr = '';
  const writeError = (s) => { stderr += s; };
  const args = ['--url', 'http://localhost:5173', '--routes', '/', '--project-root', '/nowhere'];
  assert.equal(await review.main(args, { write() {}, writeError, loadPlaywrightFn: () => null }), 1);
  assert.match(stderr, /could not be loaded/);
  assert.equal(await review.main([], { write() {}, writeError }), 1);
  assert.match(stderr, /Usage/);
});

test('main prints the capture as JSON and creates no directory in checks-only mode', async () => {
  const fake = fakePlaywright();
  let stdout = '';
  const code = await review.main(
    ['--url', 'http://localhost:5173', '--routes', '/', '--project-root', '/p', '--checks-only'],
    { write: (s) => { stdout += s; }, writeError() {}, loadPlaywrightFn: () => fake.playwright, channel: () => 'msedge' },
  );

  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.outputDir, null);
  assert.deepEqual(fake.calls.launch, [{ channel: 'msedge', headless: true }]);
});

test('captureDesignReview discovers pages from the start URL and captures them against its origin', async () => {
  const fake = fakePlaywright({ discovered: ['/en-US', '/en-US/services', '/en-US/contact'] });
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'https://contoso.example/en-US/', discover: 3, outputDir: null, checksOnly: true,
  });

  assert.deepEqual(result.routes.map((r) => r.route), ['/en-US', '/en-US/services', '/en-US/contact']);
  assert.equal(result.baseUrl, 'https://contoso.example', 'discovered routes are paths from the origin');
  assert.equal(fake.calls.gotos[0], 'https://contoso.example/en-US/', 'discovery starts at the given URL');
  assert.deepEqual(fake.calls.gotos.slice(1, 4), [
    'https://contoso.example/en-US', 'https://contoso.example/en-US/services', 'https://contoso.example/en-US/contact',
  ]);
});

test('loadProjectPlaywright tries a global install, then the project, then playwright-core', () => {
  // The root is resolved to an absolute path, which on Windows gains a drive letter.
  const projectPlaywright = path.join(path.resolve('/site'), 'node_modules', 'playwright');
  const tried = [];
  const found = loadProjectPlaywright('/site', {
    requireFn(id) {
      tried.push(id);
      if (id === projectPlaywright) return { chromium: 'project' };
      throw new Error('MODULE_NOT_FOUND');
    },
  });
  assert.deepEqual(found, { chromium: 'project' });
  assert.deepEqual(tried, ['playwright', projectPlaywright]);
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

test('findPinnedNodeModules reads the pinned npx install directory from PATH', () => {
  const calls = [];
  const posix = findPinnedNodeModules({
    resolveNpxCliFn: () => '/node/lib/node_modules/npm/bin/npx-cli.js',
    delimiter: ':',
    spawnSyncFn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: '/home/me/.npm/_npx/a5b920f00216d246/node_modules/.bin:/usr/local/bin:/usr/bin\n' };
    },
  });
  assert.equal(posix, '/home/me/.npm/_npx/a5b920f00216d246/node_modules');
  assert.equal(calls[0].command, process.execPath, 'npm runs on the current Node, never a PATH lookup');
  assert.deepEqual(calls[0].args, ['/node/lib/node_modules/npm/bin/npx-cli.js', '--yes', '--ignore-scripts', '--package=@playwright/mcp@0.0.78', '-c', 'node -p process.env.PATH']);
  assert.equal(calls[0].options.shell, false);

  const windows = findPinnedNodeModules({
    resolveNpxCliFn: () => 'C:\\npx-cli.js',
    delimiter: ';',
    spawnSyncFn: () => ({ status: 0, stdout: 'C:\\Users\\Power User\\AppData\\Local\\npm-cache\\_npx\\a5b9\\node_modules\\.bin;C:\\Windows' }),
  });
  assert.equal(windows, 'C:\\Users\\Power User\\AppData\\Local\\npm-cache\\_npx\\a5b9\\node_modules');

  assert.equal(findPinnedNodeModules({ resolveNpxCliFn: () => 'x', spawnSyncFn: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(findPinnedNodeModules({ resolveNpxCliFn: () => 'x', delimiter: ':', spawnSyncFn: () => ({ status: 0, stdout: '/usr/bin:/bin' }) }), null);
});

test('loadPlaywright prefers the project and falls back to the pinned package', () => {
  const pinnedRun = { status: 0, stdout: `/c/_npx/abc/node_modules/.bin${path.delimiter}/usr/bin` };
  const fromProject = loadPlaywright('/site', {
    requireFn(id) {
      if (id === path.join(path.resolve('/site'), 'node_modules', 'playwright')) return 'project';
      throw new Error('missing');
    },
    spawnSyncFn() {
      assert.fail('the pinned package is not needed when the project has Playwright');
    },
  });
  assert.equal(fromProject, 'project');

  const pinned = loadPlaywright(undefined, {
    resolveNpxCliFn: () => 'npx-cli.js',
    spawnSyncFn: () => pinnedRun,
    requireFn(id) {
      if (id === path.join('/c/_npx/abc/node_modules', 'playwright')) return 'pinned';
      throw new Error('missing');
    },
  });
  assert.equal(pinned, 'pinned');

  assert.equal(loadPinnedPlaywright({ resolveNpxCliFn() { throw new Error('no npm'); } }), null);
});

test('captureDesignReview reports a sign-in redirect and discovers nothing from the login page', async () => {
  const login = 'https://login.microsoftonline.com/common/oauth2/authorize';
  const fake = fakePlaywright({ discovered: ['/common/oauth2/authorize', '/help'], redirects: { '/': login } });
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'https://contoso.example', discover: 6, outputDir: null, checksOnly: true,
  });

  assert.deepEqual(result.routes.map((r) => r.route), ['/']);
  assert.equal(result.routes[0].desktop.redirectedTo, login);
  assert.deepEqual(result.summary.redirects, [`/ @ desktop -> ${login}`, `/ @ mobile -> ${login}`]);
});

test('captureDesignReview follows a canonical redirect and discovers from the landed origin', async () => {
  const fake = fakePlaywright({
    discovered: ['/', '/services'],
    redirects: { '/': 'https://www.contoso.example/', '/services': 'https://www.contoso.example/services' },
  });
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'http://contoso.example', discover: 6, outputDir: null, checksOnly: true,
  });

  assert.equal(result.baseUrl, 'https://www.contoso.example');
  assert.deepEqual(result.routes.map((r) => r.route), ['/', '/services']);
  assert.equal(fake.calls.gotos[1], 'https://www.contoso.example/', 'captures use the canonical origin');
  assert.deepEqual(result.summary.redirects, []);
});

test('classifyLanding tells canonical redirects from sign-in redirects', () => {
  assert.equal(review.classifyLanding('http://contoso.example/', 'https://contoso.example/'), 'same-site');
  assert.equal(review.classifyLanding('https://contoso.example/about', 'https://www.contoso.example/about'), 'same-site');
  assert.equal(review.classifyLanding('https://www.contoso.example/', 'https://contoso.example/en-US/'), 'same-site');
  assert.equal(review.classifyLanding('https://contoso.example/', 'https://login.microsoftonline.com/common/oauth2/authorize?state=x'), 'left-site');
  assert.equal(review.classifyLanding('https://contoso.example/', 'https://contoso.b2clogin.com/contoso.onmicrosoft.com/oauth2'), 'left-site');
  assert.equal(review.classifyLanding('https://contoso.example/profile', 'https://contoso.example/SignIn?returnUrl=%2Fprofile'), 'sign-in');
  assert.equal(review.classifyLanding('https://contoso.example/signin', 'https://contoso.example/signin'), 'same-site', 'a requested sign-in page is the page itself');
  assert.equal(review.classifyLanding('http://localhost:5173/', 'http://localhost:4200/'), 'left-site', 'another port is another site');
});

test('captureDesignReview records no redirect when the page stays on the site', async () => {
  const fake = fakePlaywright();
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'http://localhost:5173', routes: ['/'], outputDir: null, checksOnly: true,
  });
  assert.equal(result.routes[0].desktop.redirectedTo, undefined);
  assert.deepEqual(result.summary.redirects, []);
});

test('redactUrl keeps origin and path and drops credentials, query, and fragment', () => {
  assert.equal(review.redactUrl('https://contoso.blob.core.windows.net/media/hero.jpg?sv=2024&sig=abc#x'), 'https://contoso.blob.core.windows.net/media/hero.jpg');
  assert.equal(review.redactUrl('https://user:pass@contoso.example/a'), 'https://contoso.example/a');
  assert.equal(review.redactUrl('data:image/png;base64,AAAA'), 'data:');
  assert.equal(review.redactUrl('not a url'), 'not a url');
  assert.equal(
    review.redactUrlsInText("Access to fetch at 'https://api.contoso.example/x?token=abc' from origin 'http://localhost:5173' has been blocked"),
    "Access to fetch at 'https://api.contoso.example/x' from origin 'http://localhost:5173/' has been blocked",
    'a bare origin is normalized with a trailing slash',
  );
});

test('parseArgs reads a JSON request from stdin and keeps shell characters as data', () => {
  // Characters a shell would act on, inside values a user or a page supplied.
  const request = {
    url: 'https://contoso.example/search?q=a&lang=en;x=$(echo hi)',
    routes: ['/a;b', 'c&d', '/$HOME', "/it's"],
    projectRoot: 'C:\\Sites\\Contoso & Co',
    axe: true,
  };
  const parsed = review.parseArgs(['--input', '-'], { readStdin: () => JSON.stringify(request) });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.url, request.url);
  assert.deepEqual(parsed.routes, ['/a;b', '/c&d', '/$HOME', "/it's"]);
  assert.equal(parsed.projectRoot, request.projectRoot);
  assert.equal(parsed.axe, true);

  const discover = review.parseArgs(['--input', '-', '--axe'], { readStdin: () => '{"url":"https://contoso.example/","discover":6}' });
  assert.deepEqual(discover, { checksOnly: false, axe: true, url: 'https://contoso.example', discover: 6 });
});

test('parseArgs fails closed on a malformed stdin request or an unsafe URL', () => {
  const parse = (text) => review.parseArgs(['--input', '-'], { readStdin: () => text });
  assert.match(parse('not json').error, /not valid JSON/);
  assert.match(parse('["https://contoso.example"]').error, /must be a JSON object/);
  assert.match(parse('{"url":"https://contoso.example","discover":6,"command":"x"}').error, /Unknown field.*command/);
  assert.match(parse('{"url":"https://contoso.example","routes":"/a"}').error, /routes.*wrong type/);
  assert.match(parse('{"url":"javascript:alert(1)","discover":6}').error, /http and https/);
  assert.match(parse('{"url":"file:///etc/hosts","discover":6}').error, /http and https/);
  assert.match(parse('{"url":"https://maker:pw@contoso.example","discover":6}').error, /user name and password/);
  assert.match(review.parseArgs(['--url', 'ftp://contoso.example', '--discover', '3']).error, /http and https/);
});

test('captureDesignReview --axe audits the routes it captured, skipping sign-in redirects', async () => {
  const login = 'https://login.microsoftonline.com/common/oauth2/authorize';
  const fake = fakePlaywright({ redirects: { '/account': login } });
  const audits = [];
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'https://contoso.example', routes: ['/', '/contact', '/account'], outputDir: null, checksOnly: true,
    axe: true,
    loadAxeSourceFn: async () => 'VERIFIED_AXE',
    auditFn: async (args) => {
      audits.push(args);
      return [
        { route: '/', violations: [{ id: 'region', impact: 'moderate', nodes: [{}] }], passes: 9, incomplete: 0 },
        { route: '/contact', violations: [{ id: 'label', impact: 'critical', nodes: [{}, {}] }], passes: 9, incomplete: 0 },
      ];
    },
  });

  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0].routes, ['/', '/contact'], 'the sign-in route is not audited');
  assert.equal(audits[0].url, 'https://contoso.example');
  assert.equal(audits[0].axeSource, 'VERIFIED_AXE');
  assert.equal(result.accessibility.length, 2);
  assert.deepEqual(result.summary.accessibility, {
    violations: ['/contact: label (critical, 2 elements)', '/: region (moderate, 1 element)'],
    unaudited: [],
  });
});

test('captureDesignReview --axe reports an axe-core that fails verification instead of failing the capture', async () => {
  const fake = fakePlaywright();
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'http://localhost:5173', routes: ['/'], outputDir: null, checksOnly: true,
    axe: true,
    loadAxeSourceFn: async () => { throw new Error('does not match its pinned sha512 hash'); },
    auditFn: async () => { throw new Error('must not run'); },
  });
  assert.deepEqual(result.accessibility, []);
  assert.match(result.summary.accessibility.error, /pinned sha512 hash/);
  assert.deepEqual(result.summary.accessibility.unaudited, ['/']);
  assert.ok(result.routes[0].desktop, 'the capture itself still completes');
});

test('captureDesignReview redacts URL queries from navigation errors', async () => {
  const fake = fakePlaywright({ failRoutes: ['/preview?sig=SECRET'] });
  const result = await review.captureDesignReview({
    playwright: fake.playwright, channel: 'chrome', url: 'https://contoso.example', routes: ['/preview?sig=SECRET'], outputDir: null, checksOnly: true,
  });
  assert.match(result.routes[0].desktop.captureError, /ERR_FAILED https:\/\/contoso\.example\/preview$/);
  assert.match(result.routes[0].mobile.captureError, /ERR_FAILED https:\/\/contoso\.example\/preview$/);
});

test('main redacts URL queries from a fatal capture error', async () => {
  let stderr = '';
  const playwright = { chromium: { launch: async () => { throw new Error('page.goto: net::ERR_ABORTED at https://contoso.example/?sig=SECRET'); } } };
  const code = await review.main(['--url', 'https://contoso.example', '--discover', '3', '--checks-only'], {
    write() {}, writeError: (s) => { stderr += s; }, loadPlaywrightFn: () => playwright, channel: () => undefined,
  });
  assert.equal(code, 1);
  assert.match(stderr, /Design review capture failed: .*https:\/\/contoso\.example\//);
  assert.equal(stderr.includes('SECRET'), false);
});

test('parseArgs takes a cleanup path from the stdin request and ignores everything else', () => {
  const dir = 'C:\\Users\\First $Last\\AppData\\Local\\Temp\\power-pages-design-review-abc';
  assert.deepEqual(review.parseArgs(['--input', '-'], { readStdin: () => JSON.stringify({ cleanup: dir }) }), { cleanup: dir });
  assert.match(review.parseArgs(['--input', '-'], { readStdin: () => '{"toString":"x"}' }).error, /Unknown field.*toString/);
});

