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

function renderErDiagram(source) {
  const entities = new Map();
  const relationships = [];
  let currentEntity = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === 'erDiagram') continue;
    const entityStart = /^([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(line);
    if (entityStart) {
      currentEntity = entityStart[1];
      if (!entities.has(currentEntity)) entities.set(currentEntity, []);
      continue;
    }
    if (line === '}') {
      currentEntity = null;
      continue;
    }
    if (currentEntity) {
      const field = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (field) entities.get(currentEntity).push({
        type: field[1],
        name: field[2],
        notes: field[3] || '',
      });
      continue;
    }
    const relationship = /^(\S+)\s+([|o}{.-]+)\s+(\S+)\s*:\s*(.+)$/.exec(line);
    if (relationship) {
      relationships.push({
        from: relationship[1],
        cardinality: relationship[2],
        to: relationship[3],
        label: relationship[4],
      });
      if (!entities.has(relationship[1])) entities.set(relationship[1], []);
      if (!entities.has(relationship[3])) entities.set(relationship[3], []);
    }
  }

  if (entities.size === 0) {
    return `<pre class="diagram-source">${escapeHtml(source)}</pre>`;
  }

  const entityCards = [...entities.entries()].map(([name, fields]) => `
    <article class="entity-card">
      <h3>${escapeHtml(name)}</h3>
      ${fields.length === 0 ? '<div class="entity-empty">No columns listed</div>' : `
      <table><tbody>${fields.map((field) => `
        <tr><td>${escapeHtml(field.type)}</td><th>${escapeHtml(field.name)}</th><td>${escapeHtml(field.notes)}</td></tr>`).join('')}
      </tbody></table>`}
    </article>`).join('');
  const relationshipRows = relationships.length === 0
    ? ''
    : `<div class="relationships"><h3>Relationships</h3>${relationships.map((item) =>
      `<div><strong>${escapeHtml(item.from)}</strong> <code>${escapeHtml(item.cardinality)}</code> <strong>${escapeHtml(item.to)}</strong> — ${escapeHtml(item.label)}</div>`).join('')}</div>`;
  return `<div class="diagram er-diagram"><div class="entity-grid">${entityCards}</div>${relationshipRows}</div>`;
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function statusBadge(value) {
  const normalized = String(value).trim().toLowerCase();
  const match = normalized.match(/\b(verified|bound|approved|complete|planned|pending|deferred|blocked|unverified|authentication required|auth required)\b/);
  if (!match) return inlineMarkdown(value);
  const label = match[1];
  const tone = /verified|bound|approved|complete/.test(label)
    ? 'success'
    : /blocked|unverified|auth/.test(label)
      ? 'danger'
      : /deferred/.test(label)
        ? 'warning'
        : 'pending';
  return `<span class="status ${tone}">${inlineMarkdown(value)}</span>`;
}

function renderMarkdownTable(lines) {
  const rows = lines.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
  const headers = rows[0];
  return `<div class="table-wrap"><table class="plan-table"><thead><tr>${headers.map((cell) =>
    `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map((row) =>
    `<tr>${headers.map((_, index) => `<td>${statusBadge(row[index] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderSectionBody(body) {
  const lines = body.split(/\r?\n/);
  const parts = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = /^```(\w*)/.exec(line.trim());
    if (fence) {
      const language = fence[1].toLowerCase();
      const source = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) source.push(lines[index++]);
      index += 1;
      parts.push(language === 'mermaid'
        ? renderErDiagram(source.join('\n').trim())
        : `<pre class="code-block">${escapeHtml(source.join('\n'))}</pre>`);
      continue;
    }
    const heading = /^(#{3,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      parts.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (line.trim().startsWith('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|/.test(lines[index + 1])) {
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) tableLines.push(lines[index++]);
      parts.push(renderMarkdownTable(tableLines));
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index++].replace(/^\s*[-*]\s+/, ''));
      }
      parts.push(`<ul>${items.map((item) =>
        `<li${/\b(blocked|deferred|risk|unverified)\b/i.test(item) ? ' class="concern"' : ''}>${statusBadge(item)}</li>`).join('')}</ul>`);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length
      && lines[index].trim()
      && !/^(#{3,4})\s+|^```|^\s*[-*]\s+/.test(lines[index])
      && !lines[index].trim().startsWith('|')
    ) paragraph.push(lines[index++].trim());
    const text = paragraph.join(' ');
    const concern = /\b(blocked|deferred|risk|unverified)\b/i.test(text);
    parts.push(`<p${concern ? ' class="concern"' : ''}>${statusBadge(text)}</p>`);
  }
  return parts.join('');
}

function sectionView(title) {
  if (/screens|design|experience/i.test(title)) return 'experience';
  if (/approval|implementation|sample data|deployment|readiness/i.test(title)) return 'implementation';
  return 'architecture';
}

function countFirstTableRows(body) {
  const lines = body.split(/\r?\n/);
  let rows = [];
  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      rows.push(line);
    } else if (rows.length) {
      break;
    }
  }
  return Math.max(0, rows.length - 2);
}

function subsectionBody(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^###\s+/.test(line) && heading.test(line));
  if (start < 0) return body;
  const endOffset = lines.slice(start + 1).findIndex((line) => /^#{1,3}\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n');
}

function countDataModelTables(body) {
  const decisions = [...body.matchAll(/^\s*-\s*(?:Reuse|Extend|Create):\s*(\d+)/gim)];
  if (decisions.length) {
    return decisions.reduce((total, match) => total + Number(match[1]), 0);
  }
  return countFirstTableRows(subsectionBody(body, /Target Reconciliation/i));
}

function outcomeSummary(status) {
  const outcomes = Array.isArray(status.outcomes) ? status.outcomes : [];
  const completed = outcomes.filter((outcome) => outcome.state === 'completed').length;
  const total = Math.max(outcomes.length, Number(status.outcomeTotal || 0));
  return {
    outcomes,
    completed,
    total,
    percent: total ? Math.round((completed / total) * 100) : null,
  };
}

function renderOutcomes(status) {
  const { outcomes } = outcomeSummary(status);
  if (!outcomes.length) return '';
  const items = outcomes.map((outcome) => {
    const state = ['pending', 'running', 'completed', 'blocked'].includes(outcome.state)
      ? outcome.state
      : 'pending';
    const detail = outcome.detail ? `<p>${escapeHtml(outcome.detail)}</p>` : '';
    const artifact = outcome.artifact ? `<code>${escapeHtml(outcome.artifact)}</code>` : '';
    return `<article class="outcome ${state}"><div><strong>${escapeHtml(outcome.label || outcome.id)}</strong><span>${escapeHtml(state)}</span></div>${detail}${artifact}</article>`;
  }).join('');
  return `<section id="delivery-outcomes" data-view="implementation"><h2>Delivery outcomes</h2><div class="outcome-list">${items}</div></section>`;
}

function renderPlan(markdown, status = {}) {
  const sections = splitSections(markdown);
  const connectorSection = sections.find((section) => /connectors/i.test(section.title));
  const screenSection = sections.find((section) => /screens/i.test(section.title));
  const dataSection = sections.find((section) => /data model/i.test(section.title));
  const outcomes = outcomeSummary(status);
  const metrics = [
    ['Dataverse tables', dataSection ? countDataModelTables(dataSection.body) : 0],
    ['Planned connectors', connectorSection && !/\bnone\b/i.test(connectorSection.body) ? countFirstTableRows(connectorSection.body) : 0],
    ['Planned screens', screenSection ? countFirstTableRows(subsectionBody(screenSection.body, /Screen Map/i)) : 0],
    outcomes.total
      ? ['Outcomes delivered', `${outcomes.completed}/${outcomes.total}`]
      : ['Planning approvals', `${Math.min(100, Math.round(Number(status.completed || 0) / Math.max(1, Number(status.total || 1)) * 100))}%`],
  ];
  const outcomeNav = outcomes.total ? '<a data-view="implementation" href="#delivery-outcomes">Delivery outcomes</a>' : '';
  const nav = outcomeNav + sections.map((section, index) =>
    `<a data-view="${sectionView(section.title)}" href="#section-${index}">${escapeHtml(section.title)}</a>`).join('');
  const cards = renderOutcomes(status) + sections.map((section, index) => `
    <section id="section-${index}" data-view="${sectionView(section.title)}">
      <h2>${escapeHtml(section.title)}</h2>
      ${/connectors/i.test(section.title) ? '<div class="verification-note">Connector status is explicit: planned does not mean authenticated, verified, or bound.</div>' : ''}
      ${/screens|design/i.test(section.title) ? '<div class="concept-note"><strong>Concept review:</strong> planned structure and visual direction only. Generated TSX and the live device are authoritative.</div>' : ''}
      ${renderSectionBody(section.body)}
    </section>`).join('');
  const progress = outcomes.percent === null
    ? (status.total ? Math.min(100, Math.round((Number(status.completed || 0) / Number(status.total)) * 100)) : 0)
    : outcomes.percent;
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
.view-tabs{display:flex;gap:8px;max-width:1400px;margin:18px auto 0;padding:0 22px}.view-tabs button{border:1px solid #94a3b8;background:white;color:#1e293b;border-radius:999px;padding:9px 14px;font-weight:700;cursor:pointer}.view-tabs button.active{background:#1d4ed8;color:white;border-color:#1d4ed8}
.summary{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px;max-width:1400px;margin:14px auto 0;padding:0 22px}.summary article{background:white;border:1px solid #dbe2ef;border-radius:12px;padding:14px}.summary strong{display:block;font-size:24px;color:#1d4ed8}.summary span{font-size:12px;color:#64748b}
.layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:22px;max-width:1400px;margin:auto;padding:22px}
nav{position:sticky;top:130px;align-self:start;display:grid;gap:7px}nav a{color:#1d4ed8;text-decoration:none;padding:8px;border-radius:8px}nav a:hover{background:#dbeafe}
main{display:grid;gap:18px}section{background:white;border:1px solid #dbe2ef;border-radius:14px;padding:20px;box-shadow:0 4px 18px #0f172a12}
h2{margin:0 0 14px;font-size:18px}h3{margin:22px 0 10px;font-size:16px}h4{margin:18px 0 8px;font-size:14px}p{line-height:1.55;color:#334155}ul{padding-left:22px;color:#334155}.code-block{white-space:pre-wrap;word-break:break-word;margin:12px 0;padding:12px;background:#f8fafc;border-radius:8px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155}
.table-wrap{overflow:auto;margin:12px 0}.plan-table{width:100%;border-collapse:collapse;font-size:13px}.plan-table th{background:#eff6ff;color:#1e3a8a;text-align:left}.plan-table th,.plan-table td{padding:9px 10px;border:1px solid #dbe2ef;vertical-align:top}.status{display:inline-block;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700}.status.success{background:#dcfce7;color:#166534}.status.pending{background:#dbeafe;color:#1e40af}.status.warning{background:#fef3c7;color:#92400e}.status.danger{background:#fee2e2;color:#991b1b}
.concern{border-left:4px solid #dc2626;background:#fef2f2;color:#7f1d1d;padding:10px 12px;border-radius:6px}.verification-note,.concept-note{padding:10px 12px;border-radius:8px;margin-bottom:14px}.verification-note{background:#eff6ff;color:#1e3a8a}.concept-note{background:#fff7ed;color:#9a3412}
.outcome-list{display:grid;gap:10px}.outcome{border:1px solid #cbd5e1;border-left:5px solid #94a3b8;border-radius:9px;padding:12px}.outcome>div{display:flex;justify-content:space-between;gap:12px}.outcome span{text-transform:capitalize;font-size:12px;font-weight:700}.outcome p{margin:7px 0}.outcome.completed{border-left-color:#16a34a}.outcome.running{border-left-color:#2563eb}.outcome.blocked{border-left-color:#dc2626}.outcome.pending{border-left-color:#94a3b8}
.diagram{overflow:auto;margin:14px 0;padding:16px;background:#f8fafc;border:1px solid #dbe2ef;border-radius:10px}.entity-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.entity-card{background:white;border:1px solid #cbd5e1;border-radius:9px;overflow:hidden}.entity-card h3,.relationships h3{margin:0;padding:10px 12px;background:#dbeafe;color:#1e3a8a;font-size:14px}.entity-card table{width:100%;border-collapse:collapse;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.entity-card td,.entity-card th{padding:7px 9px;border-top:1px solid #e2e8f0;text-align:left}.entity-card td:first-child{color:#475569}.entity-empty{padding:10px;color:#64748b}.relationships{margin-top:14px;background:white;border:1px solid #cbd5e1;border-radius:9px;overflow:hidden}.relationships div{padding:8px 12px;border-top:1px solid #e2e8f0}.relationships code{color:#7c3aed}
.notice{font-size:12px;color:#cbd5e1;margin-top:8px}@media(max-width:800px){.summary{grid-template-columns:repeat(2,1fr)}.layout{grid-template-columns:1fr}nav{position:static;display:flex;overflow:auto}}
@media(prefers-color-scheme:dark){:root{background:#0f172a;color:#e2e8f0}section,.summary article{background:#111827;border-color:#334155}p,ul{color:#cbd5e1}nav a{color:#7dd3fc}.diagram{background:#f8fafc}.view-tabs button{background:#111827;color:#e2e8f0}}
</style></head><body><header class="top"><h1>Mobile app plan</h1>
<div class="meta"><span>Phase: ${escapeHtml(status.phase || 'planning')}</span><span>${escapeHtml(status.message || 'Review the approved architecture and experience')}</span><span>${progress}% complete</span></div>
<div class="bar"><span></span></div><div class="notice">Plan preview only — implementation has not started unless the status says otherwise.</div></header>
${banner}<div class="view-tabs"><button class="active" data-filter="architecture">Architecture</button><button data-filter="experience">Experience concept</button><button data-filter="implementation">Implementation status</button><button data-filter="all">All</button></div>
<div class="summary">${metrics.map(([label, value]) => `<article><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`).join('')}</div>
<div class="layout"><nav>${nav}</nav><main>${cards}</main></div>
<script>document.querySelectorAll('[data-filter]').forEach(function(button){button.addEventListener('click',function(){var filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(function(item){item.classList.toggle('active',item===button)});document.querySelectorAll('section[data-view],nav a[data-view]').forEach(function(item){item.hidden=filter!=='all'&&item.dataset.view!==filter});});});</script>
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

module.exports = { escapeHtml, renderErDiagram, renderPlan, renderSectionBody, splitSections };
