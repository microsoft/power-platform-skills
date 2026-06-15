#!/usr/bin/env node
/**
 * render-inner-loop-plan.js — Renders the inner-loop status HTML.
 *
 * Usage:
 *   node render-inner-loop-plan.js --output <path> --data <json-file>
 *
 * Required top-level keys in the JSON data file:
 *   siteName     — string (defaults to "Power Pages site")
 *   generatedAt  — ISO timestamp string
 *   state        — one of: Disconnected | Clean | Dirty | Stale | Mixed |
 *                          Conflicted | Broken
 *   binding      — { bound, bindingType, organization, project, repository,
 *                    branch, folder, solutionUniqueName, envUrl }
 *   changes      — { count: int, items: [...] }      // from list-pending-changes
 *   updates      — { count: int, items: [...] }      // from list-incoming-updates
 *   conflicts    — { count: int, items: [...] }      // from list-conflicts
 *   prereqs      — { pacCli, azCli, managedEnv, repoInitialized }   // each a string|bool
 *   flags        — { refreshError?, partialData?, ...string flags ... }
 *   mixedStrategy — null | 'pull-first' | 'commit-first'
 */

'use strict';

const path = require('path');
const fs = require('fs');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { output: null, data: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) out.output = args[++i];
    else if (args[i] === '--data' && args[i + 1]) out.data = args[++i];
  }
  return out;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATE_LABEL = {
  Disconnected: { title: 'Not bound to Git',                 desc: 'This environment is not bound to any ADO repo. Run git-configure to bind.' },
  Clean:        { title: 'Everything is in sync',            desc: 'No pending changes, no incoming updates, no conflicts. Nothing to do right now.' },
  Dirty:        { title: 'You have local changes to commit', desc: 'There are pending Changes in this environment that have not been committed to Git yet.' },
  Stale:        { title: 'Incoming updates available',       desc: 'Teammate commits in the bound branch have not been pulled into this environment yet.' },
  Mixed:        { title: 'Mixed state — both directions',    desc: 'You have BOTH pending Changes AND incoming Updates. Order matters — either pull first or commit first.' },
  Conflicted:   { title: 'Conflicts blocking sync',          desc: 'One or more per-object conflicts must be resolved before the next pull can complete.' },
  Broken:       { title: 'Broken state',                     desc: 'Drift between Dataverse and the local manifest, OR repeated platform API failures. Run diagnose-git-integration.' },
};

const NEXT_STEP = {
  Disconnected: {
    cmd: '/power-pages:git-configure',
    desc: 'Bind this environment to an Azure DevOps repo + branch + folder.',
    alts: ['/power-pages:git-configure --binding=solution'],
  },
  Clean: {
    cmd: '(no action required)',
    desc: 'Your environment is fully in sync with the bound branch. Continue developing in the maker portal, and re-run this skill whenever you want a status check.',
    alts: ['/power-pages:git-configure --mode=switch-branch', '/power-pages:open-pr'],
  },
  Dirty: {
    cmd: '/power-pages:commit-to-git --dry-run',
    desc: 'Run pre-flight validators on the pending Changes (dry run), then commit via /power-pages:commit-to-git.',
    alts: ['/power-pages:commit-to-git', '/power-pages:revert-workspace'],
  },
  Stale: {
    cmd: '/power-pages:sync-from-git',
    desc: 'Pull the incoming Updates from the bound branch into this environment.',
    alts: [],
  },
  Mixed: {
    cmd: '/power-pages:sync-from-git  THEN  /power-pages:commit-to-git',
    desc: 'Recommended order: pull updates first (produces one merged commit), then commit your local changes on top.',
    alts: ['/power-pages:commit-to-git first, then /power-pages:sync-from-git'],
  },
  Conflicted: {
    cmd: '/power-pages:resolve-conflicts',
    desc: 'Walk through each conflict and choose Keep environment OR Accept incoming. Sync can resume after all conflicts are resolved.',
    alts: ['/power-pages:revert-workspace', '/power-pages:sync-from-git (after conflicts resolve)'],
  },
  Broken: {
    cmd: '/power-pages:diagnose-git-integration',
    desc: 'Diagnostic skill collects API errors, manifest drift, and configuration issues into a single report.',
    alts: [],
  },
};

function renderBinding(binding) {
  if (!binding || binding.bound === false) {
    return '<div class="empty">No binding detected.</div>';
  }
  const rows = [];
  function row(label, value, mono) {
    if (!value) return;
    rows.push(`<dt>${escapeHtml(label)}</dt><dd${mono ? ' class="mono"' : ''}>${escapeHtml(value)}</dd>`);
  }
  row('Binding type',   binding.bindingType);
  row('Organization',   binding.organization);
  row('Project',        binding.project);
  row('Repository',     binding.repository);
  row('Branch',         binding.branch, true);
  row('Folder',         binding.folder, true);
  row('Solution',       binding.solutionUniqueName, true);
  row('Environment',    binding.envUrl);
  return `<dl class="kv">${rows.join('')}</dl>`;
}

function changeTypeBadge(t) {
  if (t === 'Add')    return '<span class="badge add">add</span>';
  if (t === 'Modify') return '<span class="badge mod">mod</span>';
  if (t === 'Delete') return '<span class="badge del">del</span>';
  return `<span class="badge other">${escapeHtml(t || '?')}</span>`;
}

function renderItemsSection(title, icon, payload, opts) {
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) return '';
  const cap = opts?.cap || 25;
  const shown = payload.items.slice(0, cap);
  const overflow = payload.items.length - shown.length;
  const rows = shown.map((it) => {
    const cells = [
      `<td>${changeTypeBadge(it.changeType)}</td>`,
      `<td><strong>${escapeHtml(it.componentName || '(unnamed)')}</strong></td>`,
      `<td><code>${escapeHtml(it.componentType || '')}</code></td>`,
      `<td>${escapeHtml(it.filePath || '')}</td>`,
    ];
    return `<tr>${cells.join('')}</tr>`;
  }).join('');
  const overflowRow = overflow > 0
    ? `<tr><td colspan="4" class="empty">+ ${overflow} more (full list in inner-loop-plan.json)</td></tr>`
    : '';
  return `
  <div class="section">
    <div class="section-h"><span class="icon">${icon}</span> ${escapeHtml(title)} (${payload.items.length})</div>
    <table class="items">
      <thead><tr><th>Type</th><th>Name</th><th>Component type</th><th>Path</th></tr></thead>
      <tbody>${rows}${overflowRow}</tbody>
    </table>
  </div>`;
}

function renderConflictsSection(payload) {
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) return '';
  const cap = 25;
  const shown = payload.items.slice(0, cap);
  const overflow = payload.items.length - shown.length;
  const rows = shown.map((it) => {
    return `<tr>
      <td><strong>${escapeHtml(it.componentName || '(unnamed)')}</strong></td>
      <td><code>${escapeHtml(it.componentType || '')}</code></td>
      <td>${escapeHtml(it.conflictReason || it.reason || 'concurrent edit')}</td>
    </tr>`;
  }).join('');
  const overflowRow = overflow > 0
    ? `<tr><td colspan="3" class="empty">+ ${overflow} more</td></tr>`
    : '';
  return `
  <div class="section">
    <div class="section-h"><span class="icon">⚠</span> Conflicts (${payload.items.length})</div>
    <table class="items">
      <thead><tr><th>Name</th><th>Component type</th><th>Reason</th></tr></thead>
      <tbody>${rows}${overflowRow}</tbody>
    </table>
  </div>`;
}

function renderPrereqs(prereqs) {
  if (!prereqs || typeof prereqs !== 'object') {
    return '<div class="empty">Prerequisite data not collected.</div>';
  }
  const rows = [];
  function row(label, value) {
    let display;
    if (value === true)  display = '<span style="color:var(--pass)">✓ OK</span>';
    else if (value === false) display = '<span style="color:var(--critical)">✗ Missing</span>';
    else if (value === null || value === undefined) display = '<span style="color:var(--text-dim)">—</span>';
    else display = escapeHtml(String(value));
    rows.push(`<dt>${escapeHtml(label)}</dt><dd>${display}</dd>`);
  }
  row('PAC CLI',           prereqs.pacCli);
  row('Azure CLI token',   prereqs.azCli);
  row('Managed Env',       prereqs.managedEnv);
  row('Repo initialized',  prereqs.repoInitialized);
  return `<dl class="kv">${rows.join('')}</dl>`;
}

function renderFlags(flags) {
  if (!flags || typeof flags !== 'object') return '';
  const entries = Object.entries(flags).filter(([_, v]) => v);
  if (entries.length === 0) return '';
  const pills = entries.map(([k, v]) => {
    const label = typeof v === 'string' ? `${k}: ${v}` : k;
    return `<span class="flag">${escapeHtml(label)}</span>`;
  }).join('');
  return `<div class="flags">${pills}</div>`;
}

function renderAlternatives(alts) {
  if (!Array.isArray(alts) || alts.length === 0) return '';
  const pills = alts.map((a) => `<code>${escapeHtml(a)}</code>`).join(' · ');
  return `Alternatives: ${pills}`;
}

function classForCount(count, mode) {
  if (!Number.isFinite(count) || count <= 0) return 'ok';
  if (mode === 'crit') return 'crit';
  return 'warn';
}

function envHost(envUrl) {
  if (!envUrl) return '';
  try { return new URL(envUrl).host; }
  catch { return envUrl; }
}

/**
 * Render the HTML from a template + data blob. Exported for tests.
 */
function render(template, data) {
  if (!data || typeof data !== 'object') {
    throw new Error('render: data must be an object');
  }
  const state = data.state || 'Disconnected';
  const stateMeta = STATE_LABEL[state] || STATE_LABEL.Broken;
  const nextStep = NEXT_STEP[state] || NEXT_STEP.Broken;

  const changes   = data.changes   || { count: 0, items: [] };
  const updates   = data.updates   || { count: 0, items: [] };
  const conflicts = data.conflicts || { count: 0, items: [] };

  const envDisplay = envHost(data.binding?.envUrl) || (data.envDisplay || 'environment unknown');

  const substitutions = {
    SITE_NAME:          escapeHtml(data.siteName || 'Power Pages site'),
    GENERATED_AT:       escapeHtml(data.generatedAt || new Date().toISOString()),
    ENV_DISPLAY:        escapeHtml(envDisplay),
    STATE:              escapeHtml(state),
    STATE_CLASS:        state.toLowerCase(),
    BANNER_TITLE:       escapeHtml(stateMeta.title),
    BANNER_DESC:        escapeHtml(stateMeta.desc),
    FLAGS_HTML:         renderFlags(data.flags),
    CHANGES_COUNT:      String(changes.count || 0),
    CHANGES_CLASS:      classForCount(changes.count || 0, 'warn'),
    UPDATES_COUNT:      String(updates.count || 0),
    UPDATES_CLASS:      classForCount(updates.count || 0, 'warn'),
    CONFLICTS_COUNT:    String(conflicts.count || 0),
    CONFLICTS_CLASS:    classForCount(conflicts.count || 0, 'crit'),
    RECOMMENDED_CMD:    escapeHtml(nextStep.cmd),
    RECOMMENDED_DESC:   escapeHtml(nextStep.desc),
    ALTERNATIVES_HTML:  renderAlternatives(nextStep.alts),
    BINDING_HTML:       renderBinding(data.binding),
    CHANGES_SECTION:    renderItemsSection('Pending changes', '✎', changes),
    UPDATES_SECTION:    renderItemsSection('Incoming updates', '↓', updates),
    CONFLICTS_SECTION:  renderConflictsSection(conflicts),
    PREREQS_HTML:       renderPrereqs(data.prereqs),
  };

  let html = template;
  for (const [k, v] of Object.entries(substitutions)) {
    html = html.split('__' + k + '__').join(v == null ? '' : String(v));
  }
  return html;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (!args.output || !args.data) {
    process.stderr.write('Usage: node render-inner-loop-plan.js --output <path> --data <json-file>\n');
    process.exit(1);
  }
  const templatePath = path.join(__dirname, '..', 'assets', 'inner-loop-plan-template.html');
  const outputPath = path.resolve(args.output);
  const dataPath = path.resolve(args.data);

  if (!fs.existsSync(templatePath)) {
    process.stderr.write(`Template not found: ${templatePath}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(dataPath)) {
    process.stderr.write(`Data file not found: ${dataPath}\n`);
    process.exit(1);
  }
  let template, data;
  try { template = fs.readFileSync(templatePath, 'utf8'); }
  catch (e) { process.stderr.write(`Failed to read template: ${e.message}\n`); process.exit(1); }
  try { data = JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
  catch (e) { process.stderr.write(`Failed to parse data file: ${e.message}\n`); process.exit(1); }

  const html = render(template, data);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
  process.stdout.write(`Wrote ${outputPath} (${html.length} bytes)\n`);
}

module.exports = {
  render,
  escapeHtml,
  STATE_LABEL,
  NEXT_STEP,
};
