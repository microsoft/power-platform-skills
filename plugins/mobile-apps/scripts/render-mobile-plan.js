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

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderTable(lines) {
  const rows = lines.map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  if (rows.length < 2) return '';
  const header = rows[0];
  const body = rows.slice(2);
  return `<div class="table-wrap"><table><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderMarkdown(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const output = [];
  let index = 0;
  let inCode = false;
  let code = [];
  let listType = null;

  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (/^```/.test(line)) {
      closeList();
      if (inCode) {
        output.push(`<pre class="code"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
      index += 1;
      continue;
    }
    if (inCode) {
      code.push(line);
      index += 1;
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|[-:|\s]+\|\s*$/.test(lines[index + 1] || '')) {
      closeList();
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && /^\s*\|/.test(lines[index])) tableLines.push(lines[index++]);
      output.push(renderTable(tableLines));
      continue;
    }
    const heading = /^(#{3,6})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(5, heading[1].length - 1);
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      const desired = bullet ? 'ul' : 'ol';
      if (listType !== desired) {
        closeList();
        output.push(`<${desired}>`);
        listType = desired;
      }
      output.push(`<li>${inlineMarkdown((bullet || numbered)[1])}</li>`);
      index += 1;
      continue;
    }
    closeList();
    if (/^>\s?/.test(line)) output.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`);
    else if (line.trim()) output.push(`<p>${inlineMarkdown(line)}</p>`);
    index += 1;
  }
  closeList();
  if (inCode && code.length) output.push(`<pre class="code"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return output.join('');
}

function renderPlan(markdown, status = {}) {
  const sections = splitSections(markdown);
  const nav = sections.map((section, index) =>
    `<a href="#section-${index}">${escapeHtml(section.title)}</a>`).join('');
  const cards = sections.map((section, index) => `
    <section id="section-${index}">
      <h2>${escapeHtml(section.title)}</h2>
      <div class="markdown">${renderMarkdown(section.body)}</div>
    </section>`).join('');
  const progress = status.total ? Math.min(100, Math.round((Number(status.completed || 0) / Number(status.total)) * 100)) : 0;
  const banner = status.awaitingInput
    ? `<div class="input-banner">Input required — ${escapeHtml(status.inputPrompt || 'return to the terminal to continue.')}</div>`
    : '';
  const experience = [
    ['Archetype', status.productArchetype],
    ['Personality', status.visualPersonality],
    ['Home', status.homeComposition],
    ['Reference', status.referenceFidelity],
    ['Visual QA', status.visualQaState],
  ].filter(([, value]) => value);
  const experiencePanel = experience.length ? `<div class="experience">${experience.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}${status.visualQaCoverage ? `<p>${escapeHtml(status.visualQaCoverage)}</p>` : ''}${status.visualQaReport ? `<p>Report: ${escapeHtml(status.visualQaReport)}</p>` : ''}</div>` : '';
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
main{display:grid;gap:18px}section{background:white;border:1px solid #dbe2ef;border-radius:8px;padding:20px;box-shadow:0 4px 18px #0f172a12}
h2{margin:0 0 14px;font-size:18px}.markdown{color:#334155;font:14px/1.55 Inter,ui-sans-serif,system-ui,sans-serif}.markdown p{margin:8px 0}.markdown h2,.markdown h3,.markdown h4,.markdown h5{margin:20px 0 8px;color:#172033}.markdown ul,.markdown ol{margin:8px 0;padding-left:22px}.markdown li{margin:4px 0}.markdown code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef2ff;padding:2px 4px;border-radius:4px}.code{white-space:pre-wrap;word-break:break-word;background:#f8fafc;border:1px solid #e2e8f0;padding:12px;border-radius:6px}.table-wrap{overflow:auto;margin:12px 0}table{border-collapse:collapse;width:100%;min-width:520px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e2e8f0;padding:8px 10px}th{background:#f8fafc;color:#172033;font-size:12px}blockquote{border-left:3px solid #38bdf8;margin:12px 0;padding:6px 12px;background:#f0f9ff}.experience{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;max-width:1400px;margin:16px auto 0;padding:0 22px}.experience div{background:#ffffff14;border:1px solid #ffffff26;padding:10px;border-radius:6px}.experience span{display:block;color:#bfdbfe;font-size:11px}.experience strong{display:block;margin-top:3px}.experience p{grid-column:1/-1;margin:0;color:#dbeafe;font-size:12px}
.notice{font-size:12px;color:#64748b;margin-top:8px}@media(max-width:800px){.layout{grid-template-columns:1fr}nav{position:static;display:flex;overflow:auto}}
@media(prefers-color-scheme:dark){:root{background:#0f172a;color:#e2e8f0}section{background:#111827;border-color:#334155}pre{color:#cbd5e1}nav a{color:#7dd3fc}}
</style></head><body><header class="top"><h1>Mobile app plan</h1>
<div class="meta"><span>Phase: ${escapeHtml(status.phase || 'planning')}</span><span>${escapeHtml(status.message || 'Review the approved architecture and experience')}</span><span>${progress}% complete</span></div>
<div class="bar"><span></span></div><div class="notice">Plan preview only — static structure is not native visual QA.</div></header>${experiencePanel}
${banner}<div class="layout"><nav>${nav}</nav><main>${cards}</main></div></body></html>`;
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

module.exports = { escapeHtml, inlineMarkdown, renderMarkdown, renderPlan, splitSections };
