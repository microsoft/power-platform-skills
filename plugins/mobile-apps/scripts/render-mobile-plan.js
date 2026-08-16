#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1]) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function splitSections(markdown) {
  const sections = [];
  let current = { title: 'Plan', body: [] };
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      if (current.body.length > 0) sections.push({ ...current, body: current.body.join('\n').trim() });
      current = { title: match[1], body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length > 0) sections.push({ ...current, body: current.body.join('\n').trim() });
  return sections;
}

function renderSectionBody(body) {
  const parts = [];
  const mermaidFence = /```mermaid[^\S\r\n]*\r?\n([\s\S]*?)```/gi;
  let cursor = 0;
  let match;
  while ((match = mermaidFence.exec(body)) !== null) {
    const before = body.slice(cursor, match.index).trim();
    if (before) parts.push(`<pre>${escapeHtml(before)}</pre>`);
    parts.push(`<div class="diagram"><div class="mermaid">${escapeHtml(match[1].trim())}</div></div>`);
    cursor = mermaidFence.lastIndex;
  }
  const after = body.slice(cursor).trim();
  if (after) parts.push(`<pre>${escapeHtml(after)}</pre>`);
  return parts.join('');
}

function renderPlan(markdown, status = {}) {
  const sections = splitSections(markdown);
  const nav = sections.map((section, index) =>
    `<a href="#section-${index}">${escapeHtml(section.title)}</a>`).join('');
  const cards = sections.map((section, index) => `
    <section id="section-${index}">
      <h2>${escapeHtml(section.title)}</h2>
      ${renderSectionBody(section.body)}
    </section>`).join('');
  const progress = status.total ? Math.min(100, Math.round((Number(status.completed || 0) / Number(status.total)) * 100)) : 0;
  const banner = status.awaitingInput
    ? `<div class="input-banner">Input required — ${escapeHtml(status.inputPrompt || 'return to the terminal to continue.')}</div>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mobile app plan</title><style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f4f6fb;color:#172033}
*{box-sizing:border-box}body{margin:0}.top{position:sticky;top:0;z-index:2;background:#172554;color:white;padding:18px 24px}
.top h1{margin:0 0 8px;font-size:20px}.meta{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:#dbeafe}
.bar{height:7px;background:#334155;border-radius:999px;margin-top:12px;overflow:hidden}.bar span{display:block;height:100%;background:#38bdf8;width:${progress}%}
.input-banner{background:#fef3c7;color:#78350f;border-bottom:1px solid #f59e0b;padding:14px 24px;font-weight:700}
.layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:22px;max-width:1400px;margin:auto;padding:22px}
nav{position:sticky;top:130px;align-self:start;display:grid;gap:7px}nav a{color:#1d4ed8;text-decoration:none;padding:8px;border-radius:8px}nav a:hover{background:#dbeafe}
main{display:grid;gap:18px}section{background:white;border:1px solid #dbe2ef;border-radius:14px;padding:20px;box-shadow:0 4px 18px #0f172a12}
h2{margin:0 0 14px;font-size:18px}pre{white-space:pre-wrap;word-break:break-word;margin:0;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155}
.diagram{overflow:auto;margin:14px 0;padding:16px;background:#f8fafc;border:1px solid #dbe2ef;border-radius:10px}.mermaid{min-width:640px;text-align:center}
.notice{font-size:12px;color:#64748b;margin-top:8px}@media(max-width:800px){.layout{grid-template-columns:1fr}nav{position:static;display:flex;overflow:auto}}
@media(prefers-color-scheme:dark){:root{background:#0f172a;color:#e2e8f0}section{background:#111827;border-color:#334155}pre{color:#cbd5e1}nav a{color:#7dd3fc}.diagram{background:#f8fafc}}
</style></head><body><header class="top"><h1>Mobile app plan</h1>
<div class="meta"><span>Phase: ${escapeHtml(status.phase || 'planning')}</span><span>${escapeHtml(status.message || 'Review the approved architecture and experience')}</span><span>${progress}% complete</span></div>
<div class="bar"><span></span></div><div class="notice">Plan preview only — implementation has not started unless the status says otherwise.</div></header>
${banner}<div class="layout"><nav>${nav}</nav><main>${cards}</main></div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>if(window.mermaid){window.mermaid.initialize({startOnLoad:true,securityLevel:'strict',theme:'neutral'});}</script>
</body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.plan || !args.output) {
    process.stderr.write('Usage: node render-mobile-plan.js --plan <native-app-plan.md> --output <mobile-app-plan.html> [--status <mobile-app-status.json>]\n');
    process.exit(1);
  }
  const markdown = fs.readFileSync(path.resolve(args.plan), 'utf8');
  const status = args.status && fs.existsSync(path.resolve(args.status))
    ? JSON.parse(fs.readFileSync(path.resolve(args.status), 'utf8'))
    : {};
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temp, renderPlan(markdown, status), 'utf8');
  fs.renameSync(temp, output);
  console.log(JSON.stringify({ status: 'ok', output }));
}

if (require.main === module) main();

module.exports = { escapeHtml, renderPlan, renderSectionBody, splitSections };
