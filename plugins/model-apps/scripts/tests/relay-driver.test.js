// Tests for the relay driver (scripts/relay/driver.js) using a fake Playwright page.
// Run: node --test plugins/model-apps/scripts/tests/relay-driver.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createDriver, lazyDriver } = require(path.join(__dirname, '..', 'relay', 'driver.js'));

function fakePage(resultFor) {
  const calls = [];
  return {
    calls,
    async goto(url, opts) { calls.push({ goto: url, opts }); },
    async evaluate(fn, arg) { calls.push({ fn, arg }); return resultFor ? resultFor(fn, arg, calls) : undefined; },
    async screenshot(opts) { calls.push({ screenshot: opts }); return Buffer.from(''); },
  };
}

test('inject() evaluates the bridge source in the page', async () => {
  const page = fakePage();
  const driver = createDriver(page, '/* BRIDGE SOURCE */');
  await driver.inject();
  assert.strictEqual(page.calls[0].fn, '/* BRIDGE SOURCE */');
});

test('goto() navigates with domcontentloaded', async () => {
  const page = fakePage();
  const driver = createDriver(page, 'SRC');
  await driver.goto('https://example/form');
  assert.strictEqual(page.calls[0].goto, 'https://example/form');
  assert.strictEqual(page.calls[0].opts.waitUntil, 'domcontentloaded');
});

test('call() forwards {method,args} and returns the page result', async () => {
  const page = fakePage(() => ({ ok: true, result: { sections: [] } }));
  const driver = createDriver(page, 'SRC');
  const r = await driver.call('inspect', ['x']);
  assert.deepStrictEqual(r, { ok: true, result: { sections: [] } });
  assert.deepStrictEqual(page.calls[0].arg, { method: 'inspect', args: ['x'] });
  assert.strictEqual(typeof page.calls[0].fn, 'function');
});

test('status() calls the bridge status method', async () => {
  const page = fakePage(() => ({ ok: true, source: 'fiber' }));
  const driver = createDriver(page, 'SRC');
  const r = await driver.status();
  assert.deepStrictEqual(r, { ok: true, source: 'fiber' });
  assert.deepStrictEqual(page.calls[0].arg, { method: 'status', args: [] });
});

test('waitReady() returns immediately when the bridge is ready', async () => {
  const page = fakePage((fn, arg) => (arg && arg.method === 'status' ? { ok: true, source: 'fiber' } : undefined));
  const driver = createDriver(page, 'SRC');
  const st = await driver.waitReady(5, 1);
  assert.strictEqual(st.ok, true);
});

test('waitReady() re-injects and polls until ready', async () => {
  let statusCalls = 0;
  const page = fakePage((fn, arg) => {
    if (arg && arg.method === 'status') { statusCalls++; return { ok: statusCalls >= 2 }; }
    return undefined; // inject
  });
  const driver = createDriver(page, 'SRC');
  const st = await driver.waitReady(5, 1);
  assert.strictEqual(st.ok, true);
  assert.ok(statusCalls >= 2, 'should poll status more than once');
  // an inject (string fn) must have happened between the polls
  assert.ok(page.calls.some((c) => c.fn === 'SRC'), 're-injected the bridge while waiting');
});

test('screenshot() delegates to page.screenshot with a path', async () => {
  const page = fakePage();
  const driver = createDriver(page, 'SRC');
  await driver.screenshot('out.png');
  assert.ok(page.calls.some((c) => c.screenshot && c.screenshot.path === 'out.png'));
});

test('lazyDriver launches the browser only on first real use', async () => {
  let launches = 0;
  const inner = {
    async goto(u) { return 'goto:' + u; },
    async inject() {},
    async call() { return 'c'; },
    async waitReady() { return { ok: true }; },
    async status() { return { ok: true, source: 'fiber' }; },
    async screenshot() {},
  };
  const ld = lazyDriver(async () => { launches++; return inner; });

  // status before launch must NOT launch and reports not-ready
  const s0 = await ld.status();
  assert.strictEqual(s0.ok, false);
  assert.strictEqual(launches, 0);
  assert.strictEqual(ld.launched(), false);

  // a real op launches exactly once, then reuses
  await ld.goto('https://x/form');
  assert.strictEqual(launches, 1);
  await ld.call('inspect', []);
  assert.strictEqual(launches, 1);
  assert.strictEqual(ld.launched(), true);

  // status now delegates to the launched driver
  const s1 = await ld.status();
  assert.strictEqual(s1.ok, true);
});
