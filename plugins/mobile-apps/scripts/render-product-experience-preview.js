#!/usr/bin/env node
'use strict';

// Deterministically renders the approved Product Experience into a self-contained HTML file.
// It consumes only validated local contracts and generated tokens: no browser, network, package,
// prompt, or industry classifier participates, so the same inputs produce byte-identical HTML.

const fs = require('node:fs');
const path = require('node:path');

const { compileScreenBuildPack } = require('./compile-screen-build-pack');
const {
  CONTRACT_ARTIFACTS,
  canonicalJson,
  emitResult,
  fatal,
  finding,
  parseArgs,
  readJsonFile,
  resolveContractPath,
  sha256Hex,
} = require('./lib/product-experience-contracts');

const TOOL = 'render-product-experience-preview';
const USAGE = 'Usage: node render-product-experience-preview.js [--project-root <dir>] [--compiled <path>] [--tokens <path>] [--output <path>]';
const ARG_SPEC = {
  '--project-root': 'projectRoot',
  '--compiled': 'compiled',
  '--tokens': 'tokens',
  '--output': 'output',
};

const DEFAULT_COLORS = {
  bg: '#f4f6f8',
  surface: '#ffffff',
  primary: '#2457d6',
  accent: '#dce6ff',
  text: '#18202a',
  textMuted: '#65717f',
  border: '#dfe4ea',
  statusSuccess: '#2f7d4a',
  statusWarning: '#a56513',
  statusDanger: '#b43a3a',
  statusInfo: '#315ea8',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readColors(tokensPath) {
  const colors = { ...DEFAULT_COLORS };
  if (!fs.existsSync(tokensPath)) return colors;
  const source = fs.readFileSync(tokensPath, 'utf8');
  for (const key of Object.keys(colors)) {
    const match = source.match(new RegExp(`\\b${key}\\s*:\\s*['"](#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))['"]`));
    if (match) colors[key] = match[1];
  }
  return colors;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ''))];
}

function selectPreviewScreens(compiled, journey) {
  const byId = new Map((compiled.screens || []).map((screen) => [screen.screenId, screen]));
  const primary = journey.journeys?.[0];
  const journeyIds = unique(
    [...(primary?.steps || [])]
      .sort((left, right) => left.order - right.order)
      .map((step) => step.surface?.screenId),
  );

  let selectedIds;
  if (journeyIds.length <= 3) {
    selectedIds = journeyIds;
  } else {
    // Three frames keep Gate 3 review focused: the journey entry, its representative
    // core/signature step, and the final outcome. Loading, empty, error, and offline
    // conditions remain interactive states on those frames rather than extra screens.
    const indexes = [0, Math.floor((journeyIds.length - 1) / 2), journeyIds.length - 1];
    selectedIds = indexes.map((index) => journeyIds[index]);
  }

  for (const screen of compiled.screens || []) {
    if (selectedIds.length >= Math.min(3, compiled.screens.length)) break;
    if (!selectedIds.includes(screen.screenId)) selectedIds.push(screen.screenId);
  }

  return selectedIds.map((id) => byId.get(id)).filter(Boolean);
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function imageDataUri(label, index, colors) {
  const hash = sha256Hex(`${label}:${index}`);
  const x = 90 + (parseInt(hash.slice(0, 2), 16) % 180);
  const y = 70 + (parseInt(hash.slice(2, 4), 16) % 100);
  const rotation = -18 + (parseInt(hash.slice(4, 6), 16) % 37);
  const shortLabel = String(label).split(/\s+/).slice(0, 4).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="620" viewBox="0 0 900 620">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${escapeXml(colors.accent)}"/>
      <stop offset="0.55" stop-color="${escapeXml(colors.surface)}"/>
      <stop offset="1" stop-color="${escapeXml(colors.primary)}" stop-opacity="0.55"/>
    </linearGradient>
    <filter id="shadow"><feDropShadow dx="0" dy="24" stdDeviation="24" flood-color="${escapeXml(colors.text)}" flood-opacity="0.18"/></filter>
  </defs>
  <rect width="900" height="620" rx="48" fill="url(#g)"/>
  <circle cx="${x}" cy="${y}" r="150" fill="${escapeXml(colors.surface)}" opacity="0.5"/>
  <circle cx="790" cy="95" r="210" fill="${escapeXml(colors.primary)}" opacity="0.09"/>
  <g transform="translate(450 300) rotate(${rotation})" filter="url(#shadow)">
    <rect x="-245" y="-118" width="490" height="236" rx="118" fill="${escapeXml(colors.surface)}"/>
    <path d="M-182 18 C-72-92 66-94 184-12 C130 68 22 108-118 86 Z" fill="${escapeXml(colors.primary)}" opacity="0.92"/>
    <path d="M-132 37 C-40-15 50-15 132 16" fill="none" stroke="${escapeXml(colors.accent)}" stroke-width="24" stroke-linecap="round"/>
    <circle cx="154" cy="-20" r="24" fill="${escapeXml(colors.statusWarning)}"/>
  </g>
  <rect x="42" y="502" width="816" height="76" rx="24" fill="${escapeXml(colors.text)}" opacity="0.88"/>
  <text x="76" y="550" fill="${escapeXml(colors.surface)}" font-family="Arial, sans-serif" font-size="30" font-weight="700">${escapeXml(shortLabel)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function sampleImage(label, index, colors, className = '') {
  return `<img class="${escapeHtml(className)}" src="${imageDataUri(label, index, colors)}" alt="${escapeHtml(label)}">`;
}

function previewRecords(pack) {
  return pack.previewContent?.records || [];
}

function listItems(pack, colors, limit = 6) {
  return previewRecords(pack).slice(0, limit).map((record, index) => `
    <div class="record-row">
      ${record.mediaLabel
    ? sampleImage(record.mediaLabel, index, colors, 'record-thumb')
    : `<span class="record-index">${index + 1}</span>`}
      <span class="record-copy"><strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(record.subtitle)}</small>
        ${record.badge ? `<em>${escapeHtml(record.badge)}</em>` : ''}</span>
      <span class="record-meta">${escapeHtml(record.meta || '›')}</span>
    </div>`).join('');
}

function tileItems(pack, colors, limit = 6) {
  return previewRecords(pack).slice(0, limit).map((record, index) => `
    <article class="tile-card">
      ${record.mediaLabel
    ? sampleImage(record.mediaLabel, index, colors, 'tile-media')
    : `<div class="tile-media media-fallback">${index + 1}</div>`}
      <div class="tile-copy">${record.badge ? `<span class="choice-tag">${escapeHtml(record.badge)}</span>` : ''}
        <strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(record.subtitle)}</small>
        ${record.meta ? `<b>${escapeHtml(record.meta)}</b>` : ''}</div>
    </article>`).join('');
}

function trustBlock(pack) {
  const signals = [...(pack.trustSignals || []), ...(pack.decisionSupport || [])].slice(0, 6);
  if (!signals.length) return '';
  return `<div class="trust-grid">${signals.map((item) => `
    <div class="trust-item"><span>✓</span><strong>${escapeHtml(item.label)}</strong></div>`).join('')}</div>`;
}

function mediaBlock(pack, colors, label = pack.previewContent?.heroMediaLabel) {
  if (!pack.media || pack.media.role === 'none') return '';
  const mediaLabel = label || pack.media.fallback;
  return `<figure class="media-block media-${escapeHtml(pack.media.role)}"
    data-treatment="${escapeHtml(pack.media.treatment || '')}">
    ${sampleImage(mediaLabel, 0, colors, 'hero-media')}
    <figcaption>${escapeHtml(mediaLabel)}</figcaption>
  </figure>`;
}

function formFields(pack) {
  return (pack.previewContent?.fields || []).slice(0, 8).map((field) => `
    <label class="field"><span>${escapeHtml(field.label)}</span>
      <span class="fake-input"><strong>${escapeHtml(field.value)}</strong>
        ${field.hint ? `<small>${escapeHtml(field.hint)}</small>` : ''}</span>
    </label>`).join('');
}

function metricsBlock(pack) {
  const metrics = pack.previewContent?.metrics || [];
  if (!metrics.length) return '';
  return `<div class="metric-grid">${metrics.slice(0, 6).map((metric) => `
    <div><span>${escapeHtml(metric.value)}</span><small>${escapeHtml(metric.label)}</small></div>`).join('')}</div>`;
}

function summaryBlock(pack) {
  const rows = pack.previewContent?.summaryRows || [];
  if (!rows.length) return '';
  return `<div class="summary-card">${rows.slice(0, 8).map((row, index) => `
    <div class="${index === rows.length - 1 ? 'summary-total' : ''}">
      <span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.value)}</strong>
    </div>`).join('')}</div>`;
}

function screenIntro(pack) {
  const content = pack.previewContent;
  return `<section class="screen-intro">${content.eyebrow ? `<span class="step-label">${escapeHtml(content.eyebrow)}</span>` : ''}
    <h3>${escapeHtml(content.headline)}</h3><p>${escapeHtml(content.supportingText)}</p></section>`;
}

function renderComposition(pack, colors) {
  const kind = pack.composition?.kind;
  const records = previewRecords(pack);
  const supporting = pack.hierarchy?.supporting || [];
  const media = mediaBlock(pack, colors);

  if (kind === 'confirmation') {
    return `<div class="confirmation"><div class="checkmark">✓</div>
      ${media}<div class="record-list">${listItems(pack, colors)}</div></div>`;
  }
  if (kind === 'conversation') {
    return `${media}<div class="conversation">${records.slice(0, 4).map((record, index) => `
      <div class="bubble ${index % 2 ? 'outgoing' : 'incoming'}"><strong>${escapeHtml(record.title)}</strong>
        <small>${escapeHtml(record.subtitle)}</small></div>`).join('')}
      <div class="composer">Write a reply… <span>↑</span></div></div>`;
  }
  if (kind === 'schedule') {
    return `<div class="calendar"><div class="calendar-head"><strong>${escapeHtml(pack.firstViewport?.focalContent)}</strong><span>‹ &nbsp; ›</span></div>
      <div class="calendar-grid">${['M','T','W','T','F','S','S',1,2,3,4,5,6,7,8,9,10,11,12,13,14].map((day) => `<span>${day}</span>`).join('')}</div>
      ${media}<div class="record-list">${listItems(pack, colors)}</div></div>`;
  }
  if (kind === 'map') {
    return `<div class="map-block"><div class="map-line one"></div><div class="map-line two"></div>
      <span class="pin p1">1</span><span class="pin p2">2</span><span class="pin p3">3</span>
      <strong>${escapeHtml(pack.firstViewport?.focalContent)}</strong></div>${media}
      <div class="record-list">${listItems(pack, colors)}</div>`;
  }
  if (kind === 'comparison') {
    return `${media}<div class="comparison">${records.slice(0, 4).map((record, index) => `
      <article>${record.mediaLabel ? sampleImage(record.mediaLabel, index, colors, 'comparison-media') : ''}
        <span class="choice-tag">${escapeHtml(record.badge || (index === 0 ? 'Recommended' : 'Option'))}</span>
        <strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(record.subtitle)}</small>
        ${record.meta ? `<b>${escapeHtml(record.meta)}</b>` : ''}</article>`).join('')}</div>
      ${formFields(pack) ? `<div class="form-stack compact">${formFields(pack)}</div>` : ''}`;
  }
  if (['create', 'edit', 'form'].includes(kind)) {
    return `${media}<div class="form-stack">${formFields(pack)}</div>`;
  }
  if (['workflow-step', 'capture'].includes(kind)) {
    return `<div class="progress-track"><span></span></div>${media}
      ${formFields(pack) ? `<div class="form-stack">${formFields(pack)}</div>` : ''}
      <div class="check-list">${records.length
    ? records.slice(0, 6).map((record) => `<div><span>○</span><span><strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(record.subtitle)}</small></span></div>`).join('')
    : supporting.slice(0, 6).map((item) => `<div><span>○</span>${escapeHtml(item)}</div>`).join('')}</div>`;
  }
  if (kind === 'overview') {
    return `${media}<div class="record-list">${listItems(pack, colors)}</div>`;
  }
  if (kind === 'discovery') {
    return `<div class="search">⌕ &nbsp; ${escapeHtml(pack.userQuestion)}</div>${media}
      <div class="tile-grid">${tileItems(pack, colors)}</div>`;
  }
  if (kind === 'detail') {
    return `${media}
      ${records.length ? `<div class="tile-grid horizontal">${tileItems(pack, colors, 4)}</div>` : ''}
      ${formFields(pack) ? `<div class="form-stack compact">${formFields(pack)}</div>` : ''}`;
  }
  if (kind === 'settings') {
    return `${media}<div class="settings-list">${records.slice(0, 8).map((record) => `
      <div><span><strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(record.subtitle)}</small></span><span>›</span></div>`).join('')}</div>`;
  }
  return `${media}<div class="record-list">${listItems(pack, colors)}</div>`;
}

function navigationBlock(pack) {
  const incoming = (pack.navigation?.incoming || []).map((screenId) => `From ${screenId}`);
  const outgoing = (pack.navigation?.outgoing || []).map((screenId) => `Next: ${screenId}`);
  const labels = [...incoming, ...outgoing];
  if (!labels.length) return '<div class="navigation-context">Current journey step</div>';
  return `<div class="navigation-context">${labels.map((label) => `<span>${escapeHtml(label)}</span>`).join('')}</div>`;
}

function actionBlock(pack, previewScreenIds) {
  const actions = [...(pack.primaryActions || []), ...(pack.secondaryActions || [])];
  return `<div class="action-stack">${actions.map((action, index) => {
    const targetAvailable = !action.targetScreenId || previewScreenIds.has(action.targetScreenId);
    return `<button class="${index === 0 ? 'primary-button' : 'secondary-button'}"
      ${action.targetScreenId && targetAvailable ? `data-target="${escapeHtml(action.targetScreenId)}"` : ''}
      ${targetAvailable ? '' : 'disabled aria-disabled="true" title="Destination is outside this representative preview"'}>
      ${escapeHtml(action.label)}${targetAvailable ? '' : ' · Not shown'}
    </button>`;
  }).join('')}</div>`;
}

function renderOrderedRegions(pack, colors, previewScreenIds) {
  const regions = {
    context: screenIntro(pack),
    status: metricsBlock(pack),
    'focal-content': renderComposition(pack, colors),
    'primary-action': actionBlock(pack, previewScreenIds),
    'supporting-content': summaryBlock(pack),
    navigation: navigationBlock(pack),
    alerts: trustBlock(pack),
  };
  const declaredOrder = pack.firstViewport?.regionOrder || [];
  const rendered = new Set();
  const html = [];

  for (const region of declaredOrder) {
    if (!regions[region]) continue;
    rendered.add(region);
    html.push(`<section class="preview-region" data-region="${region}">${regions[region]}</section>`);
  }
  for (const region of ['status', 'alerts', 'supporting-content', 'navigation']) {
    if (rendered.has(region) || !regions[region]) continue;
    html.push(`<section class="preview-region below-fold" data-region="${region}">${regions[region]}</section>`);
  }
  return html.join('');
}

function renderState(name, text) {
  if (name === 'loading') {
    return `<div class="state-view" data-state-view="loading"><div class="skeleton hero"></div>
      <div class="skeleton"></div><div class="skeleton short"></div><div class="skeleton"></div></div>`;
  }
  const icon = name === 'error' ? '!' : name === 'empty' ? '◇' : '✓';
  return `<div class="state-view" data-state-view="${name}"><div class="state-icon">${icon}</div>
    <strong>${escapeHtml(name[0].toUpperCase() + name.slice(1))}</strong><p>${escapeHtml(text)}</p>
    ${name === 'error' ? '<button class="secondary-button">Try again</button>' : ''}</div>`;
}

function renderPhone(screen, index, colors, previewScreenIds) {
  const pack = screen.pack;
  const title = screen.title || pack.purpose;
  return `<article class="phone" data-screen="${escapeHtml(screen.screenId)}" data-index="${index}">
    <div class="screen-label"><strong>${index + 1}. ${escapeHtml(String(title).toUpperCase())}</strong>
      <span>${escapeHtml(pack.userQuestion)}</span></div>
    <div class="phone-shell">
      <div class="statusbar"><span>9:41</span><span>● ● ●</span></div>
      <header><small>${escapeHtml(pack.context?.vocabulary?.slice(0, 2).join(' · ') || 'Primary journey')}</small>
        <h2>${escapeHtml(title)}</h2><span class="sample-badge">SAMPLE PREVIEW</span></header>
      <main>
        <div class="state-view active" data-state-view="populated">${renderOrderedRegions(pack, colors, previewScreenIds)}</div>
        ${renderState('loading', pack.states.loading)}
        ${renderState('empty', pack.states.empty)}
        ${renderState('error', pack.states.error)}
      </main>
    </div>
    <p class="phone-caption"><strong>${escapeHtml(pack.signatureInteraction.name)}</strong>
      ${escapeHtml(pack.signatureInteraction.description)}</p>
  </article>`;
}

function renderHtml({ experience, compiled, journey, colors }) {
  const screens = selectPreviewScreens(compiled, journey);
  const previewScreenIds = new Set(screens.map((screen) => screen.screenId));
  const productName = escapeHtml(experience.productName);
  const stateButtons = ['populated', 'loading', 'empty', 'error'];
  const screenTabs = screens.map((screen, index) =>
    `<button data-screen-tab="${escapeHtml(screen.screenId)}" class="${index === 0 ? 'active' : ''}">${escapeHtml(screen.title || screen.screenId)}</button>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<title>${productName} — Product Experience Preview</title>
<style>
:root{--bg:${colors.bg};--surface:${colors.surface};--primary:${colors.primary};--accent:${colors.accent};--text:${colors.text};--muted:${colors.textMuted};--border:${colors.border};--success:${colors.statusSuccess};--warning:${colors.statusWarning};--danger:${colors.statusDanger};font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--bg)}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,var(--bg),color-mix(in srgb,var(--accent) 28%,var(--bg)));min-height:100vh}
.page-head{padding:32px clamp(20px,5vw,72px) 18px;display:flex;gap:24px;align-items:end;justify-content:space-between;flex-wrap:wrap}.eyebrow,.step-label{font-size:11px;font-weight:800;letter-spacing:.14em;color:var(--primary)}h1{font-size:clamp(28px,4vw,48px);margin:6px 0}.page-head p{color:var(--muted);max-width:720px;margin:0;line-height:1.55}.controls{padding:0 clamp(20px,5vw,72px) 24px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.tabs,.states{display:flex;gap:8px;flex-wrap:wrap}.tabs button,.states button{border:1px solid var(--border);background:color-mix(in srgb,var(--surface) 85%,transparent);color:var(--text);border-radius:999px;padding:9px 14px;font-weight:700;cursor:pointer}.tabs button.active,.states button.active{background:var(--text);color:var(--surface);border-color:var(--text)}
.preview-grid{display:grid;grid-template-columns:repeat(3,minmax(280px,370px));gap:28px;padding:0 clamp(20px,5vw,72px) 56px;align-items:start;overflow-x:auto}.phone-shell{height:760px;border:10px solid #101419;border-radius:42px;background:var(--surface);box-shadow:0 24px 70px rgba(18,25,32,.18);overflow:hidden;display:grid;grid-template-rows:auto auto 1fr}.statusbar{background:#101419;color:white;padding:8px 18px 5px;font-size:10px;display:flex;justify-content:space-between}.phone header{padding:18px 20px 14px;position:relative;background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 38%,var(--surface)),var(--surface))}.phone header small{color:var(--muted);font-weight:700}.phone h2{font-size:25px;margin:3px 0 0;line-height:1.1}.sample-badge{position:absolute;right:18px;top:18px;font-size:8px;font-weight:900;letter-spacing:.09em;background:var(--accent);color:var(--primary);padding:5px 7px;border-radius:6px}.phone main{overflow:auto;padding:4px 20px 24px}
.phone h3{font-size:21px;line-height:1.2;margin:14px 0 8px}.phone p{color:var(--muted);line-height:1.45}.primary-button,.secondary-button{border:0;border-radius:14px;min-height:46px;padding:0 16px;font-weight:800;cursor:pointer}.primary-button{background:var(--primary);color:white}.secondary-button{background:var(--accent);color:var(--primary)}.primary-button:disabled,.secondary-button:disabled{cursor:not-allowed;filter:grayscale(.4);opacity:.62}.preview-region{position:relative}.preview-region[data-region="primary-action"]{position:sticky;bottom:-25px;z-index:4;margin:16px -20px -24px;padding:12px 20px 20px;border-top:1px solid var(--border);background:color-mix(in srgb,var(--surface) 96%,transparent);backdrop-filter:blur(12px)}.action-stack{display:grid;gap:8px}.below-fold{margin-top:14px}.navigation-context{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.navigation-context span,.navigation-context{font-size:9px;color:var(--muted)}.navigation-context span{padding:5px 7px;border-radius:8px;background:var(--bg)}.phone-caption{font-size:13px;line-height:1.5;color:var(--muted);padding:0 8px}.phone-caption strong{display:block;color:var(--text);margin:14px 0 2px}
.media-block{border-radius:22px;background:var(--bg);position:relative;display:block;padding:0;margin:12px 0 18px;font-weight:800;overflow:hidden;box-shadow:0 12px 30px color-mix(in srgb,var(--text) 10%,transparent)}.media-essential{height:220px}.media-supportive{height:150px}.media-incidental{height:92px}.hero-media{width:100%;height:100%;display:block;object-fit:cover}.media-block figcaption{position:absolute;left:12px;bottom:12px;max-width:82%;padding:7px 10px;border-radius:10px;background:color-mix(in srgb,var(--text) 78%,transparent);color:var(--surface);font-size:11px}.search,.fake-input,.composer{border:1px solid var(--border);background:var(--bg);border-radius:13px;padding:13px;color:var(--muted)}.search{margin:4px 0 12px;font-weight:700}.screen-intro{margin:12px 0 14px}.screen-intro h3{margin:5px 0 7px}.screen-intro p{margin:0;font-size:13px}.tile-grid,.metric-grid,.comparison,.trust-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.tile-grid.horizontal{display:flex;overflow:auto;padding-bottom:5px}.tile-grid.horizontal .tile-card{min-width:150px}.tile-card,.metric-grid>div,.comparison>article,.trust-item{background:var(--bg);border-radius:16px;overflow:hidden}.tile-card{display:grid;grid-template-rows:105px auto;border:1px solid color-mix(in srgb,var(--border) 80%,transparent)}.tile-media,.comparison-media{width:100%;height:100%;object-fit:cover;display:block}.media-fallback{display:grid;place-items:center;background:var(--accent);color:var(--primary);font-weight:900}.tile-copy{padding:11px;display:grid;gap:3px}.tile-copy strong{font-size:13px}.tile-copy small{font-size:10px;line-height:1.35}.tile-copy b{font-size:11px;color:var(--primary);margin-top:5px}.metric-grid>div{padding:13px;border:1px solid color-mix(in srgb,var(--border) 75%,transparent)}.metric-grid span{display:block;font-size:17px;line-height:1.15;font-weight:900;color:var(--primary)}small{display:block;color:var(--muted);margin-top:3px}.trust-item{display:flex;gap:8px;align-items:flex-start;font-size:11px;padding:11px;border:1px solid color-mix(in srgb,var(--success) 20%,var(--border))}.trust-item span{color:var(--success)}.record-list{margin:10px 0}.record-row,.settings-list>div{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:11px;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)}.record-thumb{width:54px;height:54px;object-fit:cover;border-radius:14px;background:var(--accent)}.record-index{width:42px;height:42px;display:grid;place-items:center;border-radius:12px;background:var(--accent);color:var(--primary);font-weight:900}.record-copy{min-width:0}.record-copy strong{font-size:13px}.record-copy small{font-size:10px;white-space:normal}.record-copy em{display:inline-block;margin-top:5px;padding:3px 6px;border-radius:6px;background:var(--accent);color:var(--primary);font-size:8px;font-style:normal;font-weight:900}.record-meta{font-size:10px;font-weight:800;color:var(--text);max-width:82px;text-align:right}.form-stack{display:grid;gap:10px;margin:13px 0}.form-stack.compact{grid-template-columns:1fr 1fr}.field{display:grid;gap:5px}.field>span:first-child{font-size:11px;font-weight:800}.fake-input{padding:11px;color:var(--text);min-height:49px}.fake-input strong{display:block;font-size:12px}.fake-input small{font-size:9px}.summary-card{margin:14px 0;padding:5px 14px;border:1px solid var(--border);border-radius:16px;background:color-mix(in srgb,var(--surface) 70%,var(--bg))}.summary-card>div{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid var(--border);font-size:11px}.summary-card>div:last-child{border-bottom:0}.summary-card .summary-total{font-size:13px;color:var(--primary)}.progress-track{height:7px;background:var(--bg);border-radius:99px;margin:8px 0 18px}.progress-track span{display:block;width:58%;height:100%;background:var(--primary);border-radius:99px}.check-list{display:grid;gap:9px;margin-top:14px}.check-list>div{display:flex;gap:10px;padding:11px;border-radius:13px;background:var(--bg)}.check-list strong{font-size:12px}.check-list small{font-size:10px}.confirmation{text-align:left;padding-top:20px}.confirmation>.checkmark{margin-left:auto;margin-right:auto}.confirmation>.screen-intro{text-align:center}.checkmark,.state-icon{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;margin:0 auto 16px;background:color-mix(in srgb,var(--success) 16%,var(--surface));color:var(--success);font-size:30px;font-weight:900}.comparison{grid-template-columns:1fr 1fr}.comparison>article{padding:11px;border:1px solid var(--border)}.comparison-media{height:105px;border-radius:11px;margin-bottom:10px}.comparison article strong{display:block;font-size:12px}.comparison article b{display:block;color:var(--primary);font-size:11px;margin-top:7px}.bubble{max-width:86%;padding:12px;border-radius:17px;margin:10px 0}.bubble strong{font-size:12px}.bubble small{font-size:10px}.incoming{background:var(--bg)}.outgoing{background:var(--accent);margin-left:auto}.composer{margin-top:24px;display:flex;justify-content:space-between}.calendar-head{display:flex;justify-content:space-between;padding:8px 0}.calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin:8px 0 15px}.calendar-grid span{display:grid;place-items:center;aspect-ratio:1;border-radius:8px;font-size:11px}.calendar-grid span:nth-child(11){background:var(--primary);color:white}.map-block{height:210px;border-radius:20px;background:repeating-linear-gradient(35deg,var(--bg),var(--bg) 18px,var(--border) 19px,var(--bg) 20px);position:relative;overflow:hidden;padding:16px}.map-line{position:absolute;height:5px;background:var(--primary);border-radius:99px;transform:rotate(-18deg)}.map-line.one{width:240px;left:15px;top:92px}.map-line.two{width:160px;left:85px;top:128px;transform:rotate(24deg)}.pin{position:absolute;width:28px;height:28px;border-radius:50% 50% 50% 0;background:var(--danger);color:white;display:grid;place-items:center;transform:rotate(-45deg);font-size:11px;font-weight:900}.pin::first-letter{transform:rotate(45deg)}.p1{left:38px;top:61px}.p2{left:132px;top:98px}.p3{right:30px;bottom:35px}.choice-tag{font-size:9px;font-weight:900;color:var(--primary);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em}.state-view{display:none;text-align:left}.state-view.active{display:block}.state-view[data-state-view="loading"],.state-view[data-state-view="empty"],.state-view[data-state-view="error"]{padding-top:50px;text-align:center}.skeleton{height:48px;border-radius:12px;background:linear-gradient(90deg,var(--bg),var(--border),var(--bg));margin:12px 0}.skeleton.hero{height:180px}.skeleton.short{width:65%}
body{background:#fff}.page-head,.controls{max-width:1800px;margin-left:auto;margin-right:auto}.preview-grid{grid-template-columns:repeat(var(--screen-count),minmax(300px,1fr));gap:18px;width:calc(100% - 48px);max-width:1800px;margin:0 auto 56px;padding:30px 28px 40px;overflow-x:auto;background:linear-gradient(180deg,#f8fafc,#f2f5f9);border:1px solid #e5e9ef;border-radius:24px}.phone,.phone.extra{display:block;min-width:300px}.screen-label{min-height:62px;padding:0 8px 12px;text-align:center}.screen-label strong{display:block;font-size:12px;letter-spacing:.035em;color:#111827}.screen-label span{display:block;max-width:240px;margin:5px auto 0;color:#667085;font-size:10px;line-height:1.35}.phone-shell{height:720px;border:1px solid #dfe4ea;border-radius:34px;background:var(--surface);box-shadow:0 16px 34px rgba(32,45,63,.12);overflow:hidden;display:grid;grid-template-rows:auto auto 1fr}.statusbar{background:var(--surface);color:var(--text);padding:10px 18px 5px}.phone header{padding:15px 18px 12px}.phone h2{font-size:22px}.sample-badge{right:16px;top:15px}.phone main{padding:4px 18px 24px}.phone-caption{display:none}.media-essential{height:205px}.tile-card{grid-template-rows:96px auto}.record-thumb{width:50px;height:50px}.phone.focused .phone-shell{outline:3px solid color-mix(in srgb,var(--primary) 35%,transparent);box-shadow:0 20px 46px color-mix(in srgb,var(--primary) 22%,transparent)}
@media(max-width:980px){.preview-grid{grid-template-columns:repeat(var(--screen-count),300px);justify-content:start}}@media(max-width:600px){.page-head{padding-top:22px}.preview-grid{width:calc(100% - 24px);grid-template-columns:repeat(var(--screen-count),286px);gap:16px;padding:24px 16px 32px}.phone{min-width:286px}.phone-shell{height:680px}}
</style>
</head>
<body>
<section class="page-head"><div><div class="eyebrow">GATE 3 · PRODUCT EXPERIENCE</div>
<h1>${productName}</h1><p>${escapeHtml(experience.primaryGoal)} · ${escapeHtml(experience.signatureExperience.description)}</p></div>
<div class="eyebrow">${escapeHtml(compiled.productComplexity)} scope · ${screens.length} preview screens</div></section>
<section class="controls"><nav class="tabs" aria-label="Preview screens">${screenTabs}</nav>
<div class="states" aria-label="Preview state">${stateButtons.map((state, index) =>
  `<button data-state="${state}" class="${index === 0 ? 'active' : ''}">${state[0].toUpperCase() + state.slice(1)}</button>`).join('')}</div></section>
<section class="preview-grid" style="--screen-count:${screens.length}">${screens.map((screen, index) => renderPhone(screen, index, colors, previewScreenIds)).join('')}</section>
<script>
document.querySelectorAll('[data-state]').forEach(function(button){
  button.addEventListener('click',function(){
    document.querySelectorAll('[data-state]').forEach(function(item){item.classList.remove('active')});
    button.classList.add('active');
    document.querySelectorAll('[data-state-view]').forEach(function(view){
      view.classList.toggle('active',view.getAttribute('data-state-view')===button.getAttribute('data-state'));
    });
  });
});
function focusScreen(id){
  var target=document.querySelector('[data-screen="'+id+'"]');
  if(!target)return;
  document.querySelectorAll('.phone').forEach(function(phone){
    phone.classList.toggle('focused',phone===target);
  });
  document.querySelectorAll('[data-screen-tab]').forEach(function(tab){
    tab.classList.toggle('active',tab.getAttribute('data-screen-tab')===id);
  });
  target.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
}
document.querySelectorAll('[data-screen-tab]').forEach(function(tab){
  tab.addEventListener('click',function(){focusScreen(tab.getAttribute('data-screen-tab'))});
});
document.querySelectorAll('[data-target]').forEach(function(button){
  button.addEventListener('click',function(){focusScreen(button.getAttribute('data-target'))});
});
</script>
</body>
</html>
`;
}

function renderProductExperiencePreview({ experience, scope, journey, buildPack, compiled, colors }) {
  const expected = compileScreenBuildPack(buildPack, { experience, scope, journey });
  if (!expected.ok) return expected;
  if (canonicalJson(compiled) !== canonicalJson(expected.compiled)) {
    return {
      ok: false,
      tool: TOOL,
      errors: [finding('stale-compiled-artifact', 'compiled screen build pack does not match the current contracts')],
      warnings: [],
    };
  }
  const screens = selectPreviewScreens(compiled, journey);
  if (screens.length < Math.min(3, compiled.screens.length)) {
    return {
      ok: false,
      tool: TOOL,
      errors: [finding('insufficient-preview-screens', 'preview must contain at least three user-facing screens when available')],
      warnings: [],
    };
  }
  const html = renderHtml({ experience, compiled, journey, colors });
  return {
    ok: true,
    tool: TOOL,
    screenIds: screens.map((screen) => screen.screenId),
    html,
    revision: sha256Hex(html),
    errors: [],
    warnings: [],
  };
}

function main(argv) {
  const args = parseArgs(argv, ARG_SPEC);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if ((args.unknown || []).length) return fatal(TOOL, `unknown argument(s): ${args.unknown.join(', ')}. ${USAGE}`);

  const projectRoot = args.projectRoot ? path.resolve(args.projectRoot) : process.cwd();
  const paths = {
    experience: resolveContractPath(projectRoot, null, CONTRACT_ARTIFACTS['product-experience']),
    scope: resolveContractPath(projectRoot, null, CONTRACT_ARTIFACTS['product-scope']),
    journey: resolveContractPath(projectRoot, null, CONTRACT_ARTIFACTS['workflow-journey']),
    buildPack: resolveContractPath(projectRoot, null, CONTRACT_ARTIFACTS['screen-build-pack']),
    compiled: resolveContractPath(projectRoot, args.compiled, CONTRACT_ARTIFACTS['compiled-screen-build-pack']),
    tokens: resolveContractPath(projectRoot, args.tokens, 'brand/tokens.ts'),
    output: resolveContractPath(projectRoot, args.output, '_plan_preview.html'),
  };

  let contracts;
  try {
    for (const [label, filePath] of Object.entries(paths)) {
      if (['tokens', 'output'].includes(label)) continue;
      if (!fs.existsSync(filePath)) return fatal(TOOL, `missing ${label}: ${filePath}`);
    }
    contracts = {
      experience: readJsonFile(paths.experience),
      scope: readJsonFile(paths.scope),
      journey: readJsonFile(paths.journey),
      buildPack: readJsonFile(paths.buildPack),
      compiled: readJsonFile(paths.compiled),
      colors: readColors(paths.tokens),
    };
  } catch (error) {
    return fatal(TOOL, error.message);
  }

  const result = renderProductExperiencePreview(contracts);
  if (result.ok) {
    try {
      fs.writeFileSync(paths.output, result.html);
    } catch (error) {
      return fatal(TOOL, `cannot write ${paths.output}: ${error.message}`);
    }
    result.outputPath = paths.output;
    delete result.html;
  }
  return emitResult(result);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  escapeHtml,
  readColors,
  renderHtml,
  renderProductExperiencePreview,
  selectPreviewScreens,
};
