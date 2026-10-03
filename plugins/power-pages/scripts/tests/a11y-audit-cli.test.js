const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');

const { UnsafeRetireError, retireGuardedPage, slugForRoute } = require('../a11y-audit');

const SCRIPT = path.join(__dirname, '..', 'a11y-audit.js');

function runSync(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: false,
  });
}

test('no arguments is a usage error (exit 2), not a violation', () => {
  const r = runSync([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--url is required/);
  assert.match(r.stderr, /Exit codes/);
});

test('--help prints usage and exits 0', () => {
  const r = runSync(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node a11y-audit\.js/);
});

test('a missing --auth-state file is a usage error', () => {
  const r = runSync(['--url', 'http://localhost:1', '--auth-state', path.join(os.tmpdir(), 'pp-a11y-does-not-exist.json')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--auth-state file not found/);
});

test('an invalid states file is a usage error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-cli-'));
  try {
    const file = path.join(dir, 'states.json');
    fs.writeFileSync(file, JSON.stringify({ states: [{ route: 'nope', label: 'x', steps: [{ action: 'wait', ms: 1 }] }] }));
    const r = runSync(['--url', 'http://localhost:1', '--states', file]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /route must start/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a state pinned to an unselected viewport is a usage error, not a silent skip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-cli-'));
  try {
    const file = path.join(dir, 'states.json');
    fs.writeFileSync(file, JSON.stringify({ states: [{ route: '/', label: 'Desktop menu', viewport: 'desktop', steps: [{ action: 'wait', ms: 1 }] }] }));
    const r = runSync(['--url', 'http://localhost:1', '--viewports', 'mobile', '--states', file]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /"Desktop menu" \(desktop\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing dependencies exit 4 with an install hint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-nodeps-'));
  try {
    const r = runSync(['--url', 'http://localhost:1', '--deps-dir', dir], { POWER_PAGES_A11Y_DEPS_DIR: dir });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /install-a11y-deps\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('slugForRoute makes stable, safe snapshot file names', () => {
  assert.equal(slugForRoute('/', 0), '01-home');
  assert.equal(slugForRoute('/Products/Item?id=3#x', 11), '12-products-item');
  assert.equal(slugForRoute('/../../etc', 2), '03-etc');
});

// A fake page that crashes (or not) when the CDP session sends Page.crash.
function fakeRetirePage(name, { crashes, log }) {
  const handlers = {};
  let closed = false;
  return {
    name,
    isClosed: () => closed,
    once: (event, fn) => { handlers[event] = fn; },
    close: async () => { closed = true; log.push(`close ${name}`); },
    setDefaultTimeout: () => {},
    crash: () => { if (crashes && handlers.crash) handlers.crash(); },
  };
}

function fakeRetireContext(pages, log) {
  return {
    pages: () => pages,
    newCDPSession: async (page) => ({ send: async () => { log.push(`crash ${page.name}`); page.crash(); } }),
    newPage: async () => { log.push('new page'); return fakeRetirePage('fresh', { crashes: true, log }); },
  };
}

test('retireGuardedPage crashes every page before closing any, then opens a fresh page', async () => {
  const log = [];
  const main = fakeRetirePage('main', { crashes: true, log });
  const popup = fakeRetirePage('popup', { crashes: true, log });
  const fresh = await retireGuardedPage(fakeRetireContext([main, popup], log), main, { timeoutMs: 1000 });
  assert.equal(fresh.name, 'fresh');
  assert.deepEqual(log, ['crash main', 'crash popup', 'close main', 'close popup', 'new page']);
});

test('retireGuardedPage fails closed: a page that will not crash is never closed', async () => {
  const log = [];
  const main = fakeRetirePage('main', { crashes: true, log });
  const stuck = fakeRetirePage('popup', { crashes: false, log });
  await assert.rejects(
    retireGuardedPage(fakeRetireContext([main, stuck], log), main, { timeoutMs: 1000 }, { confirmMs: 50 }),
    (err) => err instanceof UnsafeRetireError && /couldn't stop 1 page/.test(err.message),
  );
  assert.ok(!log.some((l) => l.startsWith('close')), `closing would run unload handlers: ${log.join(', ')}`);
  assert.ok(!log.includes('new page'));
});

// Real-browser test. CI has no browser and no audit dependencies, so this runs only
// when explicitly enabled after `node scripts/install-a11y-deps.js`:
//   POWER_PAGES_A11Y_LIVE=1 node --test plugins/power-pages/scripts/tests/a11y-audit-cli.test.js
const LIVE = process.env.POWER_PAGES_A11Y_LIVE === '1';

const FIXTURE = {
  '/': `<!doctype html><html lang="en"><head><title>Contoso</title>
<style>.spin{width:20px;height:20px;background:#333;animation:spin 2s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
button.nofocus:focus{outline:none}.low{color:#aaa;background:#fff}</style></head><body><main><h1>Home</h1>
<a href="/about">About</a> <a href="/trap">Trap</a> <a href="/private">Private</a> <a href="/Account/Login/LogOff">Sign out</a>
<img src="/x.png"><p class="low">Low contrast</p><div class="spin"></div><button class="nofocus">Do nothing</button>
<button id="menu" aria-expanded="false">Menu</button><ul id="m" hidden><li><img src="/y.png"></li></ul>
<script>menu.onclick=function(){m.hidden=!m.hidden;menu.setAttribute('aria-expanded',String(!m.hidden))}</script>
</main></body></html>`,
  '/about': `<!doctype html><html lang="en"><head><title>Contoso</title><style>.wide{width:800px}.clip{height:20px;overflow:hidden;width:200px}</style></head>
<body><main><h1>About</h1><div class="wide">Wide</div><div class="clip">Text in a fixed height box that will be clipped when text size doubles.</div></main></body></html>`,
  '/trap': `<!doctype html><html lang="en"><head><title>Trap</title></head><body><main><h1>Trap</h1><a href="/">Home</a>
<input id="t" aria-label="Trap field"><script>t.addEventListener('keydown',function(e){if(e.key==='Tab')e.preventDefault()})</script></main></body></html>`,
  '/SignIn': '<!doctype html><html lang="en"><head><title>Sign in</title></head><body><main><h1>Sign in</h1></main></body></html>',
  // Not linked from "/", so the crawl test never visits it. "Save draft" is a plain
  // button (not submit-like) whose click POSTs from script: only the network guard
  // can stop that write. The signed image URL checks snippet sanitization.
  '/draft': `<!doctype html><html lang="en"><head><title>Draft</title></head><body><main><h1>Draft</h1>
<button type="button" id="save">Save draft</button><p id="done" hidden><img src="/z.png?sig=SECRET456">Saved</p>
<script>save.onclick=function(){fetch('/api/save',{method:'POST',body:'x'}).catch(function(){});done.hidden=false}</script>
</main></body></html>`,
  // Not linked from "/". Autosaves on blur, which the keyboard walk triggers: the
  // page-check guard must stop that write even though no state is involved.
  '/autosave': `<!doctype html><html lang="en"><head><title>Autosave</title></head><body><main><h1>Autosave</h1>
<label for="n">Name</label> <input id="n"> <a href="/">Home</a>
<script>n.addEventListener('blur',function(){fetch('/api/autosave',{method:'POST',body:'x'}).catch(function(){})})</script>
</main></body></html>`,
  // Not linked from "/". Defers its writes past the checks: blur schedules a POST for
  // later, and leaving the page sends one. Both must still meet the guard.
  '/deferred': `<!doctype html><html lang="en"><head><title>Deferred</title></head><body><main><h1>Deferred</h1>
<label for="n">Name</label> <input id="n"> <a href="/">Home</a>
<script>n.addEventListener('blur',function(){setTimeout(function(){fetch('/api/later',{method:'POST',body:'x'}).catch(function(){})},1500)});
addEventListener('pagehide',function(){fetch('/api/unload',{method:'POST',body:'x',keepalive:true}).catch(function(){})})</script>
</main></body></html>`,
  // Not linked from "/". Writes as soon as it loads, before any check runs; a
  // read-only list-grid POST on the same origin must still go through.
  '/onload': `<!doctype html><html lang="en"><head><title>On load</title></head><body><main><h1>On load</h1><a href="/">Home</a>
<script>fetch('/api/visit',{method:'POST',body:'x'}).catch(function(){});fetch('/_services/entity-grid-data.json/abc',{method:'POST',body:'{}'}).catch(function(){})</script>
</main></body></html>`,
  // Not linked from "/". The page fits at 320px, but one wrapper scrolls plain text
  // sideways; the other scrolls a data table, which 1.4.10 exempts.
  '/scroller': `<!doctype html><html lang="en"><head><title>Scroller</title><style>.s{overflow-x:auto;max-width:100%}.nw{white-space:nowrap}</style></head>
<body><main><h1>Scroller</h1><div class="s" id="text"><p class="nw">This sentence never wraps, so at 320 pixels wide it needs a sideways scroll to read.</p></div>
<div class="s" id="data"><table><tr><th>Region</th><th>Q1 revenue</th><th>Q2 revenue</th><th>Q3 revenue</th><th>Q4 revenue</th><th>Total revenue</th></tr></table></div></main></body></html>`,
  // Not linked from "/". The page ships its own window.axe that reports nothing, and a
  // RequireJS-style define() that throws on anonymous modules. The audit must still run
  // the pinned axe and find the missing alt text.
  '/amd': `<!doctype html><html lang="en"><head><title>AMD</title>
<script>window.axe={run:function(){return Promise.resolve({violations:[],incomplete:[],testEngine:{version:'page'}})}};
window.define=function(){throw new Error('Mismatched anonymous define() module')};window.define.amd={}</script></head>
<body><main><h1>AMD</h1><img src="/x.png"></main></body></html>`,
};

function startFixture() {
  const posts = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') posts.push(`${req.method} ${u.pathname}`);
    if (u.pathname === '/private') {
      res.writeHead(302, { Location: '/SignIn?returnUrl=%2Fprivate' });
      res.end();
      return;
    }
    const html = FIXTURE[u.pathname];
    // A CSP that forbids every script: axe must still run because the audit
    // context bypasses CSP and injects the local copy inline.
    res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'none'" });
    res.end(html || '<!doctype html><title>Not found</title>');
  });
  server.posts = posts;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function runAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('live: audits a crawled fixture site end to end', { skip: !LIVE && 'set POWER_PAGES_A11Y_LIVE=1 to run' }, async () => {
  const server = await startFixture();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await runAsync(['--url', base, '--crawl']);
    assert.equal(r.status, 3, `private page should count as not audited\n${r.stderr}`);
    const report = JSON.parse(r.stdout);
    const ids = new Set(report.violations.map((v) => v.id));
    for (const id of ['image-alt', 'color-contrast', 'pp-keyboard-trap', 'pp-focus-not-visible', 'pp-reflow-horizontal-scroll',
      'pp-text-clipped-at-200', 'pp-motion-ignores-reduced-motion', 'pp-page-title-duplicate']) {
      assert.ok(ids.has(id), `expected ${id} in ${[...ids].join(', ')}`);
    }
    assert.ok(report.pages.some((p) => p.route === '/private' && /sign-in page/.test(p.error)));
    assert.ok(report.crawl.excluded.some((e) => e.reason === 'sign-out'));
    assert.equal(report.tool.axeVersion, '4.13.0');
  } finally {
    server.close();
  }
});

test('live: the pinned axe runs even when the page has its own window.axe and an AMD loader', { skip: !LIVE && 'set POWER_PAGES_A11Y_LIVE=1 to run' }, async () => {
  const server = await startFixture();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await runAsync(['--url', base, '--routes', '/amd', '--checks', 'axe', '--viewports', 'desktop']);
    assert.equal(r.status, 1, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.ok(report.violations.some((v) => v.id === 'image-alt'));
    assert.equal(report.tool.axeVersion, '4.13.0');
  } finally {
    server.close();
  }
});

test('live: discover proposes states and a states file audits hidden content', { skip: !LIVE && 'set POWER_PAGES_A11Y_LIVE=1 to run' }, async () => {
  const server = await startFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-live-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const disc = await runAsync(['--url', base, '--mode', 'discover', '--snapshot-dir', dir]);
    assert.equal(disc.status, 0, disc.stderr);
    const discovered = JSON.parse(disc.stdout);
    assert.deepEqual(discovered.viewports, ['desktop', 'mobile']);
    const page = discovered.pages[0];
    assert.equal(page.viewport, 'desktop');
    const candidate = page.stateCandidates.find((c) => c.label === 'disclosure: Menu');
    assert.ok(candidate);
    assert.equal(candidate.viewport, 'desktop');
    assert.ok(fs.existsSync(page.snapshotFile));
    assert.match(path.basename(page.snapshotFile), /\.desktop\.aria\.yml$/);
    const mobile = discovered.pages.find((p) => p.route === page.route && p.viewport === 'mobile');
    assert.ok(mobile, 'every viewport is explored, so mobile-only controls can be proposed');
    assert.ok(mobile.stateCandidates.every((c) => c.viewport === 'mobile'));
    assert.notEqual(mobile.snapshotFile, page.snapshotFile);

    const statesFile = path.join(dir, 'states.json');
    fs.writeFileSync(statesFile, JSON.stringify({ states: [{ route: '/', label: 'Menu open', steps: candidate.steps }] }));
    const r = await runAsync(['--url', base, '--viewports', 'desktop', '--checks', 'axe', '--states', statesFile]);
    assert.equal(r.status, 1, r.stderr);
    const alt = JSON.parse(r.stdout).violations.find((v) => v.id === 'image-alt');
    assert.ok(alt.nodes.some((n) => n.occurrences.some((o) => o.state === 'Menu open')), 'hidden image found only in the open-menu state');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live: state replay blocks script writes, runs keyboard, and sanitizes snippets', { skip: !LIVE && 'set POWER_PAGES_A11Y_LIVE=1 to run' }, async () => {
  const server = await startFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-live-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const statesFile = path.join(dir, 'states.json');
    fs.writeFileSync(statesFile, JSON.stringify({ states: [{ route: '/draft', label: 'Saved', steps: [{ action: 'click', role: 'button', name: 'Save draft' }] }] }));
    const r = await runAsync(['--url', base, '--routes', '/draft', '--viewports', 'desktop', '--checks', 'axe,keyboard', '--states', statesFile]);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(server.posts, [], 'the POST never reached the site');
    const report = JSON.parse(r.stdout);
    assert.equal(report.summary.blockedRequests, 1);
    assert.deepEqual(report.states[0].blockedRequests.requests, [{ method: 'POST', url: `${base}/api/save` }]);
    assert.equal(report.summary.checkErrors, 0);
    const alt = report.violations.find((v) => v.id === 'image-alt');
    assert.ok(alt.nodes.some((n) => n.occurrences.some((o) => o.state === 'Saved')));
    assert.ok(!r.stdout.includes('SECRET456'), 'signed query string is redacted');
    assert.ok(alt.nodes.some((n) => n.html.includes('/z.png?[redacted]')));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live: page checks are guarded, so a blur handler cannot write', { skip: !LIVE && 'set POWER_PAGES_A11Y_LIVE=1 to run' }, async () => {
  const server = await startFixture();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await runAsync(['--url', base, '--routes', '/autosave', '--viewports', 'desktop', '--checks', 'axe,keyboard']);
    assert.ok([0, 1].includes(r.status), r.stderr);
    assert.deepEqual(server.posts, [], 'the autosave POST never reached the site');
    const report = JSON.parse(r.stdout);
    // The keyboard walk can blur the field more than once (tab past, then shift+tab back).
    const blocked = report.pages[0].blockedRequests;
    assert.ok(blocked.count >= 1, 'the autosave POST was blocked and reported');
    for (const req of blocked.requests) assert.deepEqual(req, { method: 'POST', url: `${base}/api/autosave` });
    assert.equal(report.summary.blockedRequests, blocked.count);
  } finally {
    server.close();
  }
});

test('live: writes a page defers past its checks (timer or unload) are still blocked', { skip: !LIVE && 'set POWER_PAGES_A11Y_LIVE=1 to run' }, async () => {
  const server = await startFixture();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // A second route makes the audit navigate away, which fires the first page's unload
    // handler; the pause lets a timer scheduled during the checks come due.
    const r = await runAsync(['--url', base, '--routes', '/deferred,/about', '--viewports', 'desktop', '--checks', 'keyboard']);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.ok([0, 1].includes(r.status), r.stderr);
    assert.deepEqual(server.posts, [], 'no deferred write reached the site');
  } finally {
    server.close();
  }
});

test('live: a write sent while the page loads is blocked in audit, state, and discover runs', { skip: !LIVE && 'set POWER_PAGES_A11Y_LIVE=1 to run' }, async () => {
  const server = await startFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-live-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const grid = 'POST /_services/entity-grid-data.json/abc';
    const statesFile = path.join(dir, 'states.json');
    fs.writeFileSync(statesFile, JSON.stringify({ states: [{ route: '/onload', label: 'Loaded', steps: [{ action: 'wait', ms: 100 }] }] }));
    const r = await runAsync(['--url', base, '--routes', '/onload', '--viewports', 'desktop', '--checks', 'axe', '--states', statesFile]);
    assert.ok([0, 1].includes(r.status), r.stderr);
    assert.deepEqual(server.posts, [grid, grid], 'only the read-only grid POST reached the site, once per load');
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.pages[0].blockedRequests.requests, [{ method: 'POST', url: `${base}/api/visit` }]);
    assert.equal(report.states[0].blockedRequests.count, 1);

    server.posts.length = 0;
    const disc = await runAsync(['--url', base, '--routes', '/onload', '--viewports', 'desktop', '--mode', 'discover']);
    assert.equal(disc.status, 0, disc.stderr);
    assert.deepEqual(server.posts, [grid]);
    assert.equal(JSON.parse(disc.stdout).pages[0].blockedRequests.count, 1);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live: reflow flags a scroll container of plain text but not a data table', { skip: !LIVE && 'set POWER_PAGES_A11Y_LIVE=1 to run' }, async () => {
  const server = await startFixture();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await runAsync(['--url', base, '--routes', '/scroller', '--viewports', 'desktop', '--checks', 'reflow']);
    assert.equal(r.status, 0, `a heuristic finding never fails the run\n${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.ok(!report.violations.some((v) => v.id === 'pp-reflow-horizontal-scroll'), 'the page itself fits');
    const found = report.violations.find((v) => v.id === 'pp-reflow-scroll-container');
    assert.ok(found, 'the text wrapper is reported');
    assert.deepEqual(found.nodes.map((n) => n.target), ['div#text']);
  } finally {
    server.close();
  }
});

test('live: --allow-form-submit lifts the guard only for states that opt in', { skip: !LIVE && 'set POWER_PAGES_A11Y_LIVE=1 to run' }, async () => {
  const server = await startFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-a11y-live-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const statesFile = path.join(dir, 'states.json');
    const step = [{ action: 'click', role: 'button', name: 'Save draft' }];
    fs.writeFileSync(statesFile, JSON.stringify({ states: [
      { route: '/draft', label: 'Guarded', steps: step },
      { route: '/draft', label: 'Consented', allowFormSubmit: true, steps: step },
    ] }));
    const r = await runAsync(['--url', base, '--routes', '/draft', '--viewports', 'desktop', '--checks', 'axe', '--states', statesFile, '--allow-form-submit']);
    const report = JSON.parse(r.stdout);
    const byLabel = Object.fromEntries(report.states.map((s) => [s.label, s]));
    assert.equal(byLabel.Guarded.formSubmitAllowed, false);
    assert.equal(byLabel.Guarded.blockedRequests.count, 1);
    assert.equal(byLabel.Consented.formSubmitAllowed, true);
    assert.deepEqual(server.posts, ['POST /api/save'], 'only the consented state reached the site');

    // The flag alone (no state opted in) keeps every state guarded and warns.
    const flagOnly = path.join(dir, 'flag-only.json');
    fs.writeFileSync(flagOnly, JSON.stringify({ states: [{ route: '/draft', label: 'Guarded', steps: step }] }));
    server.posts.length = 0;
    const r2 = await runAsync(['--url', base, '--routes', '/draft', '--viewports', 'desktop', '--checks', 'axe', '--states', flagOnly, '--allow-form-submit']);
    assert.deepEqual(server.posts, []);
    assert.match(r2.stderr, /allowFormSubmit/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
