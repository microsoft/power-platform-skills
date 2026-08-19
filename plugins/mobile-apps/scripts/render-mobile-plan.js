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

function safeColor(value, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : fallback;
}

function renderStructuralScreen(screen, contract) {
  const viewport = contract.firstViewport || {};
  const isHome = Boolean(screen.isHome);
  const share = isHome && Number.isFinite(viewport.viewportShare) ? viewport.viewportShare : 0.34;
  const signatureHeight = Math.max(128, Math.min(260, Math.round(430 * share)));
  const media = isHome ? String(viewport.media || '').toLowerCase() : '';
  const mediaBlock = media && media !== 'forbidden'
    ? `<div class="preview-media"><span>${escapeHtml(media === 'required' ? 'Required media' : 'Optional media')}</span><strong>${escapeHtml(contract.media?.source || 'Approved source')}</strong></div>`
    : '';
  const action = screen.action || (isHome ? viewport.primaryAction : '') || 'No primary action declared';
  const workflow = screen.workflow ? `<div class="preview-flow"><span>Workflow</span>${escapeHtml(screen.workflow)}</div>` : '';
  const states = screen.states ? `<div class="preview-state"><span>State contract</span>${escapeHtml(screen.states)}</div>` : '';
  return `<article class="preview-device-card">
    <header><div><strong>${escapeHtml(screen.name)}</strong><span>${escapeHtml(screen.archetype || 'Screen')}</span></div><code>${escapeHtml(screen.route)}</code></header>
    <div class="preview-device">
      <div class="preview-system-bar"><i></i><i></i><i></i></div>
      <div class="preview-screen">
        <div class="preview-signature" style="min-height:${signatureHeight}px">
          <span class="preview-region-label">${isHome ? `Signature region · ${Math.round(share * 100)}% viewport` : 'Dominant region'}</span>
          ${mediaBlock}
          <h4>${escapeHtml(screen.dominant || screen.purpose || 'Approved dominant content')}</h4>
          <p>${escapeHtml(screen.layout || screen.purpose || '')}</p>
          <div class="preview-action"><span>Primary action owner</span><strong>${escapeHtml(action)}</strong></div>
        </div>
        ${workflow}
        <div class="preview-next"><span>${isHome && String(viewport.nextSectionVisible).toLowerCase() === 'yes' ? 'Next section visible at fold' : 'Supporting content'}</span><p>${escapeHtml(screen.purpose || screen.layout || '')}</p></div>
        ${states}
      </div>
      <div class="preview-home-indicator"></div>
    </div>
    <footer>${isHome ? `Minimum ${escapeHtml(viewport.minimumHeight)}dp · headline ${escapeHtml(viewport.headlineMinimum)}sp+ · max ${escapeHtml(viewport.supportingMetricsMaximum)} metrics` : 'Hierarchy and action ownership from the approved screen specification'}</footer>
  </article>`;
}

function renderStructuralPreview(contract) {
  if (!contract || contract.schemaVersion !== 1) return '';
  const routes = new Set(contract.representativeScreens || []);
  const screens = (contract.screens || []).filter((screen) => routes.has(screen.route));
  if (!screens.length) return '';
  const colors = contract.design?.colors || {};
  const accent = safeColor(colors.accent, '#0f766e');
  const background = safeColor(colors.background, '#f7f8f6');
  const text = safeColor(colors.text, '#17201d');
  const silhouettes = (contract.navigation?.silhouettes || []).map((item) =>
    `<li><strong>${escapeHtml(item.screen)}</strong><span>${escapeHtml(item.description)}</span></li>`).join('');
  const reference = contract.reference?.fidelity && String(contract.reference.fidelity).toLowerCase() !== 'none'
    ? `<div class="preview-reference"><div><span>Reference fidelity</span><strong>${escapeHtml(contract.reference.fidelity)}</strong></div><p><b>Required hierarchy:</b> ${escapeHtml(contract.reference.hierarchy)}</p><p><b>Required motifs:</b> ${escapeHtml(contract.reference.motifs)}</p><p><b>Forbidden drift:</b> ${escapeHtml(contract.reference.forbiddenDrift)}</p></div>`
    : '';
  const paletteNote = colors.inferredFallback
    ? ' Preview chrome uses a neutral annotation palette because Gate 3 did not declare concrete color tokens.'
    : ' Preview chrome reflects the draft colors declared at Gate 3.';
  return `<section id="gate3-structural-preview" class="gate3-preview" style="--preview-accent:${accent};--preview-bg:${background};--preview-text:${text}">
    <div class="preview-heading"><div><span class="preview-kicker">Gate 3 structural design preview</span><h2>Experience before implementation</h2><p>Approve hierarchy, geometry, media intent, and action ownership. Native rendering is validated after implementation.${escapeHtml(paletteNote)}</p></div><div class="preview-contract-version">Contract v${escapeHtml(contract.schemaVersion)}</div></div>
    <div class="preview-summary">
      <div><span>Product structure</span><strong>${escapeHtml(contract.product?.structure)}</strong></div>
      <div><span>Visual character</span><strong>${escapeHtml(contract.product?.visualCharacter)}</strong></div>
      <div><span>Home composition</span><strong>${escapeHtml(contract.product?.homeComposition)}</strong></div>
      <div><span>Operating context</span><strong>${escapeHtml(contract.product?.operatingContext)}</strong></div>
    </div>
    <div class="preview-phones">${screens.map((screen) => renderStructuralScreen(screen, contract)).join('')}</div>
    <div class="preview-lower">
      <div><h3>Cross-tab silhouettes</h3>${silhouettes ? `<ul class="preview-silhouettes">${silhouettes}</ul>` : '<p>No tab-root silhouettes required for this navigation pattern.</p>'}</div>
      <div><h3>Draft visual system</h3><p><b>Palette:</b> ${escapeHtml(contract.design?.palette || 'Resolved during design materialization')}</p><p><b>Typography:</b> ${escapeHtml(contract.design?.typography || 'Approved project typography')}</p><p><b>Surface:</b> ${escapeHtml(contract.design?.surface || 'Plan-defined grouping and separation')}</p><p><b>Memorable quality:</b> ${escapeHtml(contract.design?.memorable || 'Derived from the approved product experience')}</p></div>
    </div>
    ${reference}
  </section>`;
}

function renderPlan(markdown, status = {}, previewContract = null) {
  const sections = splitSections(markdown);
  const previewPanel = renderStructuralPreview(previewContract);
  const previewNav = previewPanel ? '<a href="#gate3-structural-preview">Structural preview</a>' : '';
  const nav = previewNav + sections.map((section, index) =>
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
:root{color-scheme:light dark;font-family:Aptos,"Segoe UI Variable",ui-sans-serif,system-ui,sans-serif;background:#edf1ee;color:#17201d}
*{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}body{margin:0}.top{position:sticky;top:0;z-index:2;background:#14271f;color:white;padding:18px 24px}
.top h1{margin:0 0 8px;font-size:20px}.meta{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:#d7eee4}
.bar{height:7px;background:#365247;border-radius:999px;margin-top:12px;overflow:hidden}.bar span{display:block;height:100%;background:#62b796;width:${progress}%}
.input-banner{background:#fef3c7;color:#78350f;border-bottom:1px solid #f59e0b;padding:14px 24px;font-weight:700}
.layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:22px;max-width:1400px;margin:auto;padding:22px;min-width:0}
nav{position:sticky;top:130px;align-self:start;display:grid;gap:7px}nav a{color:#176b57;text-decoration:none;padding:8px;border-radius:6px}nav a:hover{background:#dceae4}
main{display:grid;gap:18px;min-width:0}section{background:white;border:1px solid #d5dfda;border-radius:6px;padding:20px;box-shadow:0 4px 18px #1020190d;min-width:0}
h2{margin:0 0 14px;font-size:18px}.markdown{color:#33443d;font:14px/1.55 Aptos,"Segoe UI Variable",ui-sans-serif,system-ui,sans-serif}.markdown p{margin:8px 0}.markdown h2,.markdown h3,.markdown h4,.markdown h5{margin:20px 0 8px;color:#17201d}.markdown ul,.markdown ol{margin:8px 0;padding-left:22px}.markdown li{margin:4px 0}.markdown code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#e9f1ed;padding:2px 4px;border-radius:4px}.code{white-space:pre-wrap;word-break:break-word;background:#f7faf8;border:1px solid #dce5e1;padding:12px;border-radius:6px}.table-wrap{overflow:auto;margin:12px 0}table{border-collapse:collapse;width:100%;min-width:520px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #dce5e1;padding:8px 10px}th{background:#f4f8f6;color:#17201d;font-size:12px}blockquote{border-left:3px solid #23846b;margin:12px 0;padding:6px 12px;background:#edf7f2}.experience{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;max-width:1400px;margin:16px auto 0;padding:0 22px}.experience div{background:#ffffff14;border:1px solid #ffffff26;padding:10px;border-radius:6px}.experience span{display:block;color:#bfe5d5;font-size:11px}.experience strong{display:block;margin-top:3px}.experience p{grid-column:1/-1;margin:0;color:#d7eee4;font-size:12px}
.gate3-preview{color:var(--preview-text);background:linear-gradient(145deg,var(--preview-bg),#fff);border-color:#cfd9d4;overflow:hidden}.preview-heading{display:flex;justify-content:space-between;gap:20px;align-items:start;border-bottom:1px solid #dce5e1;padding-bottom:16px;min-width:0}.preview-heading>div{min-width:0}.preview-heading h2{font-size:24px;margin:4px 0 6px;letter-spacing:0;overflow-wrap:anywhere}.preview-heading p{max-width:720px;margin:0;color:#52615b;overflow-wrap:anywhere}.preview-kicker{color:var(--preview-accent);font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0}.preview-contract-version{white-space:nowrap;border:1px solid #c7d6d0;border-radius:6px;padding:7px 10px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.preview-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:16px 0}.preview-summary>div{background:#ffffffb8;border:1px solid #dbe4e0;border-radius:6px;padding:11px;min-width:0}.preview-summary span,.preview-action span,.preview-flow span,.preview-state span,.preview-next>span,.preview-region-label,.preview-reference span{display:block;color:#66746e;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0}.preview-summary strong{display:block;margin-top:4px;font-size:13px;line-height:1.35;overflow-wrap:anywhere}.preview-phones{display:grid;grid-template-columns:repeat(3,minmax(230px,1fr));gap:18px;align-items:start}.preview-device-card{min-width:0}.preview-device-card>header{display:flex;justify-content:space-between;align-items:end;gap:8px;margin-bottom:8px}.preview-device-card>header div span{display:block;color:#66746e;font-size:11px}.preview-device-card>header code{max-width:48%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.preview-device{width:min(100%,310px);height:520px;margin:auto;background:#111713;border:7px solid #111713;border-radius:34px;box-shadow:0 12px 28px #10201922;overflow:hidden}.preview-system-bar{height:24px;background:#111713;display:flex;justify-content:center;gap:4px;padding-top:8px}.preview-system-bar i{display:block;width:4px;height:4px;border-radius:50%;background:#91a29a}.preview-screen{height:465px;background:var(--preview-bg);overflow:hidden;padding:12px;display:flex;flex-direction:column;gap:10px}.preview-signature{background:#fff;border:1px solid #d9e4df;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:8px}.preview-signature h4{font-size:18px;line-height:1.18;margin:0;color:var(--preview-text);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.preview-signature p,.preview-next p,.preview-flow,.preview-state{font-size:11px;line-height:1.35;color:#52615b;margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.preview-media{min-height:58px;border-radius:5px;background:color-mix(in srgb,var(--preview-accent) 13%,#eef4f1);padding:9px;display:flex;flex-direction:column;justify-content:end}.preview-media span{font-size:9px;text-transform:uppercase;color:#66746e;font-weight:800}.preview-media strong{font-size:11px;margin-top:2px}.preview-action{margin-top:auto;border-left:3px solid var(--preview-accent);padding:7px 9px;background:color-mix(in srgb,var(--preview-accent) 8%,#fff)}.preview-action strong{font-size:11px;display:block;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.preview-flow,.preview-state,.preview-next{background:#ffffffa8;border:1px solid #dce5e1;border-radius:6px;padding:10px}.preview-next{min-height:58px}.preview-home-indicator{height:24px;background:#111713;position:relative}.preview-home-indicator:after{content:"";position:absolute;width:86px;height:3px;background:#91a29a;border-radius:999px;left:50%;top:10px;transform:translateX(-50%)}.preview-device-card>footer{margin-top:7px;color:#66746e;font-size:10px;text-align:center;line-height:1.4}.preview-lower{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px}.preview-lower>div,.preview-reference{background:#ffffffb8;border:1px solid #dbe4e0;border-radius:7px;padding:14px}.preview-lower h3{font-size:14px;margin:0 0 9px}.preview-lower p,.preview-reference p{font-size:12px;color:#52615b;margin:6px 0}.preview-silhouettes{list-style:none;margin:0;padding:0;display:grid;gap:8px}.preview-silhouettes li{display:grid;grid-template-columns:minmax(80px,.35fr) 1fr;gap:8px;border-top:1px solid #e1e9e5;padding-top:8px}.preview-silhouettes li:first-child{border-top:0;padding-top:0}.preview-silhouettes strong{font-size:12px}.preview-silhouettes span{font-size:11px;color:#52615b}.preview-reference{margin-top:18px;border-left:4px solid var(--preview-accent)}
.notice{font-size:12px;color:#bfd6cc;margin-top:8px}@media(max-width:800px){.layout{grid-template-columns:1fr;padding:14px}nav{position:static;display:flex;flex-wrap:wrap;overflow:visible}nav a{padding:6px 8px}}
@media(max-width:1100px){.preview-phones{grid-template-columns:1fr}.preview-summary{grid-template-columns:1fr 1fr}.preview-lower{grid-template-columns:1fr}.preview-device{width:310px}}
@media(max-width:600px){.top{padding:16px}.gate3-preview{padding:14px}.preview-heading{display:grid;gap:10px}.preview-contract-version{justify-self:start}.preview-summary{grid-template-columns:1fr}.preview-device{width:min(100%,286px)}.preview-silhouettes li{grid-template-columns:1fr}.preview-lower>div,.preview-reference{padding:12px}}
@media(prefers-color-scheme:dark){:root{background:#0f172a;color:#e2e8f0}section{background:#111827;border-color:#334155}pre{color:#cbd5e1}nav a{color:#7dd3fc}}
</style></head><body><header class="top"><h1>Mobile app plan</h1>
<div class="meta"><span>Phase: ${escapeHtml(status.phase || 'planning')}</span><span>${escapeHtml(status.message || 'Review the approved architecture and experience')}</span><span>${progress}% complete</span></div>
<div class="bar"><span></span></div><div class="notice">Plan preview only — static structure is not native visual QA.</div></header>${experiencePanel}
${banner}<div class="layout"><nav>${nav}</nav><main>${previewPanel}${cards}</main></div></body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.plan || !args.output) {
    process.stderr.write('Usage: node render-mobile-plan.js --plan <native-app-plan.md> --output <mobile-app-plan.html> [--status <mobile-app-status.json>] [--preview-contract <gate3-preview-contract.json>]\n');
    process.exit(1);
  }
  const markdown = fs.readFileSync(path.resolve(args.plan), 'utf8');
  const status = args.status && fs.existsSync(path.resolve(args.status))
    ? JSON.parse(fs.readFileSync(path.resolve(args.status), 'utf8'))
    : {};
  const previewContract = args['preview-contract'] && fs.existsSync(path.resolve(args['preview-contract']))
    ? JSON.parse(fs.readFileSync(path.resolve(args['preview-contract']), 'utf8'))
    : null;
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temp, renderPlan(markdown, status, previewContract), 'utf8');
  fs.renameSync(temp, output);
  console.log(JSON.stringify({ status: 'ok', output }));
}

if (require.main === module) main();

module.exports = { escapeHtml, inlineMarkdown, renderMarkdown, renderPlan, renderStructuralPreview, splitSections };
