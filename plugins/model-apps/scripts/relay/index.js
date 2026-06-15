'use strict';

// model-maker relay — entry point.
//
// A local MCP (stdio) server that owns a Playwright-controlled Edge browser,
// injects bridge.js into the open form designer, and drives it via
// page.evaluate round-trips (CSP-safe; no in-page socket). Registered in
// .mcp.json as the "designer-relay" server.
//
// The MCP server starts immediately and cheaply; Edge launches lazily on the
// first designer_open (so registering this server does not pop a browser for
// users who never touch the designer tools).
//
// stdout is the MCP JSON-RPC channel — ALL diagnostics go to stderr.
//
// Env (all optional):
//   MM_EDGE_PROFILE - persistent Edge user-data-dir so auth survives runs
//                     (default: <tmp>/mm-edge-profile)
//   MM_START_URL    - URL the browser opens to on first launch (default about:blank);
//                     the agent then calls designer_open with the form URL.
//   MM_HEADLESS=1   - run Edge headless (the designer needs a real browser; default headed)

const os = require('node:os');
const path = require('node:path');
const { createDriver, launchEdge, lazyDriver } = require('./driver.js');
const { makeHandlers } = require('./handlers.js');
const { Serializer } = require('./serialize.js');

const log = (...a) => process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

async function main() {
  const userDataDir = process.env.MM_EDGE_PROFILE || path.join(os.tmpdir(), 'mm-edge-profile');
  const startUrl = process.env.MM_START_URL || 'about:blank';
  const headless = process.env.MM_HEADLESS === '1';

  let ctx = null;
  const driver = lazyDriver(async () => {
    log('launching Edge (profile:', userDataDir + ')');
    const res = await launchEdge({ url: startUrl, userDataDir, headless });
    ctx = res.ctx;
    return createDriver(res.page);
  });

  const handlers = makeHandlers(driver, new Serializer());

  // @modelcontextprotocol/sdk is ESM-only; load it via dynamic import from CJS.
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { registerTools } = require('./tools.js');

  const server = new McpServer({ name: 'designer-relay', version: '0.1.0' });
  registerTools(server, handlers);
  await server.connect(new StdioServerTransport());
  log('designer-relay MCP server connected (stdio); Edge launches on first designer_open');

  const shutdown = async () => {
    try { if (ctx) await ctx.close(); } catch (e) { /* ignore */ }
    try { await server.close(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log('relay fatal:', (e && e.stack) || String(e));
  process.exit(1);
});
