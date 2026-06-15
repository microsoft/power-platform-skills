'use strict';

// MCP-client smoke for the relay.
//
// Spawns the relay (index.js) and drives it over MCP stdio exactly like an agent
// would — initialize -> tools/list -> designer_open -> form_inspect ->
// form_addField. This exercises the FULL stack (MCP protocol + handlers +
// serializer + driver + bridge + live Edge), with no LLM in the loop. Use it to
// validate option 3 (the agent path) without a session restart.
//
// One-time:  cd plugins/model-apps/scripts/relay && npm install
// Env:
//   MM_EDGE_PROFILE  (required) a signed-in persistent Edge profile dir
//   MM_SMOKE_URL     (required) the form-editor URL to open
//   MM_SMOKE_FIELD   (optional) a field to add to the first section, e.g. accountratingcode
//   MM_HEADLESS=1    (optional) headless Edge
//
// Usage:  MM_EDGE_PROFILE=... MM_SMOKE_URL=... [MM_SMOKE_FIELD=...] node mcp-smoke.js

const { spawn } = require('node:child_process');
const path = require('node:path');

const url = process.env.MM_SMOKE_URL;
if (!url) { console.error('MM_SMOKE_URL is required'); process.exit(2); }
const field = process.env.MM_SMOKE_FIELD;

// stderr: 'inherit' so the relay's own logs stream through to us.
const relay = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

const pending = new Map();
let nextId = 1;
let buf = '';

// MCP stdio framing = newline-delimited JSON-RPC.
relay.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p(msg);
    }
  }
});
relay.on('exit', (code) => { if (code) console.error('relay exited with code', code); });

function rpc(method, params, timeoutMs = 90000) {
  const id = nextId++;
  relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout waiting for ' + method)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  });
}
function notify(method, params) {
  relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
const toolText = (resp) => {
  const c = resp.result && resp.result.content && resp.result.content[0];
  return c ? c.text : JSON.stringify(resp.error || resp.result);
};

async function main() {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0.1.0' },
  });
  console.log('initialize ->', JSON.stringify((init.result && init.result.serverInfo) || init.error));
  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {});
  console.log('tools ->', (tools.result.tools || []).map((t) => t.name).join(', '));

  console.log('designer_open ->', toolText(await rpc('tools/call', { name: 'designer_open', arguments: { url } })));

  const insp = await rpc('tools/call', { name: 'form_inspect', arguments: {} });
  console.log('form_inspect ->', toolText(insp));

  if (field) {
    let sectionId;
    try {
      const parsed = JSON.parse(toolText(insp));
      sectionId = parsed.result && parsed.result.sections && parsed.result.sections[0] && parsed.result.sections[0].id;
    } catch (e) { /* leave undefined */ }
    console.log('form_addField ->', toolText(await rpc('tools/call', {
      name: 'form_addField',
      arguments: { fieldLogicalName: field, targetSectionId: sectionId },
    })));
  }

  relay.kill('SIGINT');
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error('mcp-smoke failed:', e.message);
  relay.kill('SIGINT');
  process.exit(1);
});
