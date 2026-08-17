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
    <article class="entity-card" data-er-entity>
      <h3><span data-er-editable data-er-name>${escapeHtml(name)}</span><button type="button" class="er-icon er-edit-controls" data-er-remove-entity aria-label="Remove entity">×</button></h3>
      <div class="entity-empty"${fields.length ? ' hidden' : ''}>No columns listed</div>
      <table><tbody>${fields.map((field) => `
        <tr data-er-field><td data-er-editable data-er-type>${escapeHtml(field.type)}</td><th data-er-editable data-er-field-name>${escapeHtml(field.name)}</th><td data-er-editable data-er-notes>${escapeHtml(field.notes)}</td><td class="er-edit-controls"><button type="button" class="er-icon" data-er-remove-field aria-label="Remove field">×</button></td></tr>`).join('')}
      </tbody></table>
      <button type="button" class="er-small er-edit-controls" data-er-add-field>+ Add field</button>
    </article>`).join('');
  const relationshipRows = relationships.map((item) =>
    `<div data-er-relationship><strong data-er-editable data-er-from>${escapeHtml(item.from)}</strong> <code data-er-editable data-er-cardinality>${escapeHtml(item.cardinality)}</code> <strong data-er-editable data-er-to>${escapeHtml(item.to)}</strong> — <span data-er-editable data-er-label>${escapeHtml(item.label)}</span><button type="button" class="er-icon er-edit-controls" data-er-remove-relationship aria-label="Remove relationship">×</button></div>`).join('');
  return `<div class="diagram er-diagram">
    <div class="er-toolbar">
      <strong>ER review editor</strong>
      <span>Draft changes here, then copy or download a revision request for Gate 2. This page never mutates the approved plan directly.</span>
      <div>
        <button type="button" class="er-small" data-er-toggle>Edit diagram</button>
        <button type="button" class="er-small er-edit-controls" data-er-add-entity>+ Add entity</button>
        <button type="button" class="er-small er-edit-controls" data-er-copy>Copy revision</button>
        <button type="button" class="er-small er-edit-controls" data-er-download>Download JSON</button>
        <button type="button" class="er-small er-edit-controls" data-er-reset>Reset</button>
      </div>
      <output data-er-status aria-live="polite"></output>
    </div>
    <div class="er-content">
      <div class="entity-grid">${entityCards}</div>
      <div class="relationships"><h3>Relationships</h3><div class="relationship-empty"${relationships.length ? ' hidden' : ''}>No relationships listed</div><div data-er-relationships>${relationshipRows}</div><button type="button" class="er-small er-edit-controls" data-er-add-relationship>+ Add relationship</button></div>
    </div>
  </div>`;
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
  let detailOpen = false;
  const closeDetail = () => {
    if (!detailOpen) return;
    parts.push('</div></details>');
    detailOpen = false;
  };
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
      closeDetail();
      if (level === 4) {
        parts.push(`<details class="plan-subsection"><summary>${inlineMarkdown(heading[2])}</summary><div class="plan-subsection-body">`);
        detailOpen = true;
      } else {
        parts.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      }
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
  closeDetail();
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
      ${/screens/i.test(section.title) ? '<div class="section-tools"><button type="button" data-details-action="open">Expand all screen specs</button><button type="button" data-details-action="close">Collapse all</button></div>' : ''}
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
main{display:grid;gap:18px;min-width:0}section{background:white;border:1px solid #dbe2ef;border-radius:14px;padding:20px;box-shadow:0 4px 18px #0f172a12;scroll-margin-top:110px}
h2{margin:0 0 14px;font-size:18px}h3{margin:22px 0 10px;font-size:16px}h4{margin:18px 0 8px;font-size:14px}p{line-height:1.55;color:#334155}ul{padding-left:22px;color:#334155}.code-block{white-space:pre-wrap;word-break:break-word;margin:12px 0;padding:12px;background:#f8fafc;border-radius:8px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155}
.table-wrap{overflow:auto;margin:12px 0}.plan-table{width:100%;border-collapse:collapse;font-size:13px}.plan-table th{background:#eff6ff;color:#1e3a8a;text-align:left}.plan-table th,.plan-table td{padding:9px 10px;border:1px solid #dbe2ef;vertical-align:top}.status{display:inline-block;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700}.status.success{background:#dcfce7;color:#166534}.status.pending{background:#dbeafe;color:#1e40af}.status.warning{background:#fef3c7;color:#92400e}.status.danger{background:#fee2e2;color:#991b1b}
.concern{border-left:4px solid #dc2626;background:#fef2f2;color:#7f1d1d;padding:10px 12px;border-radius:6px}.verification-note,.concept-note{padding:10px 12px;border-radius:8px;margin-bottom:14px}.verification-note{background:#eff6ff;color:#1e3a8a}.concept-note{background:#fff7ed;color:#9a3412}
.section-tools{position:sticky;top:96px;z-index:1;display:flex;gap:8px;justify-content:flex-end;margin:0 0 12px;padding:8px;background:#ffffffed;border-bottom:1px solid #e2e8f0}.section-tools button{border:1px solid #94a3b8;background:white;color:#1e3a8a;border-radius:7px;padding:7px 10px;font-weight:700;cursor:pointer}
.plan-subsection{border:1px solid #dbe2ef;border-radius:9px;margin:9px 0;overflow:hidden}.plan-subsection summary{cursor:pointer;padding:11px 13px;background:#f8fafc;color:#1e3a8a;font-weight:750}.plan-subsection[open] summary{border-bottom:1px solid #dbe2ef;background:#eff6ff}.plan-subsection-body{padding:2px 14px 12px}
.outcome-list{display:grid;gap:10px}.outcome{border:1px solid #cbd5e1;border-left:5px solid #94a3b8;border-radius:9px;padding:12px}.outcome>div{display:flex;justify-content:space-between;gap:12px}.outcome span{text-transform:capitalize;font-size:12px;font-weight:700}.outcome p{margin:7px 0}.outcome.completed{border-left-color:#16a34a}.outcome.running{border-left-color:#2563eb}.outcome.blocked{border-left-color:#dc2626}.outcome.pending{border-left-color:#94a3b8}
.diagram{overflow:auto;margin:14px 0;padding:16px;background:#f8fafc;border:1px solid #dbe2ef;border-radius:10px}.entity-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.entity-card{background:white;border:1px solid #cbd5e1;border-radius:9px;overflow:hidden}.entity-card h3,.relationships h3{margin:0;padding:10px 12px;background:#dbeafe;color:#1e3a8a;font-size:14px}.entity-card table{width:100%;border-collapse:collapse;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.entity-card td,.entity-card th{padding:7px 9px;border-top:1px solid #e2e8f0;text-align:left}.entity-card td:first-child{color:#475569}.entity-empty{padding:10px;color:#64748b}.relationships{margin-top:14px;background:white;border:1px solid #cbd5e1;border-radius:9px;overflow:hidden}.relationships div{padding:8px 12px;border-top:1px solid #e2e8f0}.relationships code{color:#7c3aed}
.er-toolbar{display:grid;gap:7px;margin:-16px -16px 16px;padding:13px 16px;background:#e0f2fe;color:#0c4a6e}.er-toolbar>span{font-size:12px}.er-toolbar>div{display:flex;gap:7px;flex-wrap:wrap}.er-toolbar output{min-height:16px;font-size:12px;font-weight:700}.er-small,.er-icon{border:1px solid #94a3b8;background:white;color:#1e3a8a;border-radius:7px;cursor:pointer;font-weight:700}.er-small{padding:6px 9px}.er-icon{width:25px;height:25px;margin-left:auto}.entity-card h3{display:flex;align-items:center;gap:8px}.er-edit-controls{display:none}.er-diagram.editing .er-edit-controls{display:inline-block}.er-diagram.editing [data-er-editable]{background:#fff7ed;outline:1px dashed #f59e0b;border-radius:3px;padding:2px}.er-diagram.editing .entity-card,.er-diagram.editing .relationships{border-color:#f59e0b}.relationship-empty{color:#64748b}.relationships [data-er-relationship]{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.notice{font-size:12px;color:#cbd5e1;margin-top:8px}@media(max-width:800px){.summary{grid-template-columns:repeat(2,1fr)}.layout{grid-template-columns:1fr}nav{position:static;display:flex;overflow:auto}}
@media(prefers-color-scheme:dark){:root{background:#0f172a;color:#e2e8f0}section,.summary article{background:#111827;border-color:#334155}p,ul{color:#cbd5e1}nav a{color:#7dd3fc}.diagram{background:#f8fafc}.view-tabs button{background:#111827;color:#e2e8f0}}
</style></head><body><header class="top"><h1>Mobile app plan</h1>
<div class="meta"><span>Phase: ${escapeHtml(status.phase || 'planning')}</span><span>${escapeHtml(status.message || 'Review the approved architecture and experience')}</span><span>${progress}% complete</span></div>
<div class="bar"><span></span></div><div class="notice">Plan preview only — implementation has not started unless the status says otherwise.</div></header>
${banner}<div class="view-tabs"><button class="active" data-filter="architecture">Architecture</button><button data-filter="experience">Experience concept</button><button data-filter="implementation">Implementation status</button><button data-filter="all">All</button></div>
<div class="summary">${metrics.map(([label, value]) => `<article><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`).join('')}</div>
<div class="layout"><nav>${nav}</nav><main>${cards}</main></div>
<script>
document.querySelectorAll('[data-filter]').forEach(function(button){button.addEventListener('click',function(){var filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(function(item){item.classList.toggle('active',item===button)});document.querySelectorAll('section[data-view],nav a[data-view]').forEach(function(item){item.hidden=filter!=='all'&&item.dataset.view!==filter});});});
document.querySelectorAll('[data-details-action]').forEach(function(button){button.addEventListener('click',function(){var section=button.closest('section');var open=button.dataset.detailsAction==='open';section.querySelectorAll('details.plan-subsection').forEach(function(item){item.open=open});});});
document.querySelectorAll('.er-diagram').forEach(function(diagram){
  var content=diagram.querySelector('.er-content');var original=content.innerHTML;var status=diagram.querySelector('[data-er-status]');
  function text(node,selector){var item=node.querySelector(selector);return item?item.textContent.trim():''}
  function refreshEmpty(){diagram.querySelectorAll('[data-er-entity]').forEach(function(entity){var empty=entity.querySelector('.entity-empty');if(empty)empty.hidden=entity.querySelectorAll('[data-er-field]').length>0});var relationEmpty=diagram.querySelector('.relationship-empty');if(relationEmpty)relationEmpty.hidden=diagram.querySelectorAll('[data-er-relationship]').length>0}
  function setEditing(editing){diagram.classList.toggle('editing',editing);diagram.querySelectorAll('[data-er-editable]').forEach(function(item){item.contentEditable=editing?'true':'false'});diagram.querySelector('[data-er-toggle]').textContent=editing?'Finish editing':'Edit diagram';status.textContent=editing?'Editing draft only — export a revision to apply it.':''}
  function model(){return{version:1,kind:'mobile-er-revision',generatedAt:new Date().toISOString(),instruction:'Regenerate Gate 2 data model and dependent screen bindings from this revision; do not mutate Dataverse until Gate 2 and Gate 4 are approved again.',entities:Array.from(diagram.querySelectorAll('[data-er-entity]')).map(function(entity){return{name:text(entity,'[data-er-name]'),fields:Array.from(entity.querySelectorAll('[data-er-field]')).map(function(field){return{type:text(field,'[data-er-type]'),name:text(field,'[data-er-field-name]'),notes:text(field,'[data-er-notes]')}})}}),relationships:Array.from(diagram.querySelectorAll('[data-er-relationship]')).map(function(relation){return{from:text(relation,'[data-er-from]'),cardinality:text(relation,'[data-er-cardinality]'),to:text(relation,'[data-er-to]'),label:text(relation,'[data-er-label]')}})}}
  function copyRevision(){var value=JSON.stringify(model(),null,2);if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(value).then(function(){status.textContent='Revision copied. Paste it into the Gate 2 revision prompt.'}).catch(function(){fallback(value)})}else fallback(value)}
  function fallback(value){var area=document.createElement('textarea');area.value=value;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();status.textContent='Revision copied. Paste it into the Gate 2 revision prompt.'}
  diagram.addEventListener('click',function(event){var target=event.target;
    if(target.closest('[data-er-toggle]')){setEditing(!diagram.classList.contains('editing'));return}
    if(target.closest('[data-er-reset]')){content.innerHTML=original;setEditing(true);refreshEmpty();status.textContent='Draft reset to the rendered plan.';return}
    if(target.closest('[data-er-copy]')){copyRevision();return}
    if(target.closest('[data-er-download]')){var blob=new Blob([JSON.stringify(model(),null,2)],{type:'application/json'});var link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='mobile-er-revision.json';link.click();URL.revokeObjectURL(link.href);status.textContent='Downloaded mobile-er-revision.json.';return}
    if(target.closest('[data-er-add-entity]')){var card=document.createElement('article');card.className='entity-card';card.setAttribute('data-er-entity','');card.innerHTML='<h3><span data-er-editable data-er-name>NEW_ENTITY</span><button type="button" class="er-icon er-edit-controls" data-er-remove-entity aria-label="Remove entity">×</button></h3><div class="entity-empty">No columns listed</div><table><tbody></tbody></table><button type="button" class="er-small er-edit-controls" data-er-add-field>+ Add field</button>';diagram.querySelector('.entity-grid').appendChild(card);setEditing(true);refreshEmpty();return}
    if(target.closest('[data-er-remove-entity]')){target.closest('[data-er-entity]').remove();refreshEmpty();return}
    if(target.closest('[data-er-add-field]')){var row=document.createElement('tr');row.setAttribute('data-er-field','');row.innerHTML='<td data-er-editable data-er-type>string</td><th data-er-editable data-er-field-name>new_field</th><td data-er-editable data-er-notes></td><td class="er-edit-controls"><button type="button" class="er-icon" data-er-remove-field aria-label="Remove field">×</button></td>';target.closest('[data-er-entity]').querySelector('tbody').appendChild(row);setEditing(true);refreshEmpty();return}
    if(target.closest('[data-er-remove-field]')){target.closest('[data-er-field]').remove();refreshEmpty();return}
    if(target.closest('[data-er-add-relationship]')){var row=document.createElement('div');row.setAttribute('data-er-relationship','');row.innerHTML='<strong data-er-editable data-er-from>FROM_ENTITY</strong> <code data-er-editable data-er-cardinality>||--o{</code> <strong data-er-editable data-er-to>TO_ENTITY</strong> — <span data-er-editable data-er-label>relates to</span><button type="button" class="er-icon er-edit-controls" data-er-remove-relationship aria-label="Remove relationship">×</button>';diagram.querySelector('[data-er-relationships]').appendChild(row);setEditing(true);refreshEmpty();return}
    if(target.closest('[data-er-remove-relationship]')){target.closest('[data-er-relationship]').remove();refreshEmpty()}
  });setEditing(false);refreshEmpty();
});
</script>
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
