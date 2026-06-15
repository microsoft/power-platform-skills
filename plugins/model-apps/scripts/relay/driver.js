'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, 'bridge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBridgeSource() {
  return fs.readFileSync(BRIDGE_PATH, 'utf8');
}

// Wrap a Playwright Page with the bridge command surface. Pure with respect to
// Playwright: `page` only needs async `evaluate`, `goto`, and `screenshot`, so
// unit tests pass a fake page.
function createDriver(page, bridgeSource) {
  const source = bridgeSource != null ? bridgeSource : readBridgeSource();

  // Navigate to a form-editor URL.
  async function goto(url) {
    return page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  // Inject bridge.js into the page; defines window.__mmBridge.
  async function inject() {
    await page.evaluate(source);
  }

  // Invoke a bridge method in the page and return its (awaited) result. addField
  // returns a promise in-page, so the page-side wrapper awaits it.
  async function call(method, args) {
    return page.evaluate(
      async (payload) => {
        const bridge = typeof window !== 'undefined' && window.__mmBridge;
        if (!bridge || typeof bridge[payload.method] !== 'function') {
          return { ok: false, error: { code: 'no-bridge', message: 'bridge method "' + payload.method + '" unavailable (designer not injected?)' } };
        }
        return await bridge[payload.method].apply(bridge, payload.args || []);
      },
      { method, args: args || [] }
    );
  }

  async function status() {
    return call('status', []);
  }

  // Poll until the bridge reports the designer is ready (the FormDesignerService
  // loads async), re-injecting in case the SPA re-rendered. Returns the status.
  async function waitReady(tries = 20, delayMs = 800) {
    let st = await status().catch(() => ({ ok: false }));
    for (let i = 0; i < tries && !(st && st.ok); i++) {
      await sleep(delayMs);
      await inject().catch(() => {});
      st = await status().catch(() => ({ ok: false }));
    }
    return st;
  }

  async function screenshot(file) {
    if (typeof page.screenshot !== 'function') return null;
    return page.screenshot({ path: file });
  }

  return { goto, inject, call, status, waitReady, screenshot };
}

// Launch system Edge (persistent profile so auth survives) and navigate to a
// start URL. Lazy-imports playwright-core so unit tests need no install and no
// browser download (we use the system Edge channel).
async function launchEdge({ url, userDataDir, channel = 'msedge', headless = false }) {
  const { chromium } = await import('playwright-core');
  const ctx = await chromium.launchPersistentContext(userDataDir, { channel, headless });
  const page = ctx.pages()[0] || (await ctx.newPage());
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

// A driver whose underlying browser launches on first use. Keeps the relay's
// MCP server cheap to start (no Edge window) until an actual designer tool is
// called. `launch()` returns a real driver (e.g. createDriver(page)).
function lazyDriver(launch) {
  let real = null;
  async function ensure() {
    if (!real) real = await launch();
    return real;
  }
  return {
    async goto(url) { return (await ensure()).goto(url); },
    async inject() { return (await ensure()).inject(); },
    async call(method, args) { return (await ensure()).call(method, args); },
    async waitReady(tries, delayMs) { return (await ensure()).waitReady(tries, delayMs); },
    async screenshot(file) { return (await ensure()).screenshot(file); },
    // Cheap and non-launching: before the browser exists, the designer is not ready.
    async status() { return real ? real.status() : { ok: false, source: null, capability: null }; },
    launched() { return !!real; },
  };
}

module.exports = { createDriver, launchEdge, lazyDriver, readBridgeSource, BRIDGE_PATH };
