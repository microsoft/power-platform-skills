#!/usr/bin/env node
/**
 * render-alm-plan.js — Renders the ALM plan HTML from a JSON data file.
 *
 * Usage:
 *   node render-alm-plan.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   SITE_NAME, GENERATED_AT, STRATEGY, EXPORT_TYPE, APPROVAL_MODE,
 *   GIT_STATUS, HAS_ENV_VARS, SOLUTION_DONE, PIPELINE_DONE,
 *   PLAN_STATUS, APPROVED_BY, APPROVAL_DATE, stages, steps, risks
 */

const path = require('path');
const fs = require('fs');
const { parseArgs } = require('../../../scripts/lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || !args.data) {
  console.error('Usage: node render-alm-plan.js --output <path> --data <json-file>');
  process.exit(1);
}

const templatePath = path.join(__dirname, '..', 'assets', 'alm-plan-template.html');
const outputPath = path.resolve(args.output);
const dataPath = path.resolve(args.data);

if (!fs.existsSync(templatePath)) {
  console.error(`Template not found: ${templatePath}`);
  process.exit(1);
}
if (!fs.existsSync(dataPath)) {
  console.error(`Data file not found: ${dataPath}`);
  process.exit(1);
}

let template = fs.readFileSync(templatePath, 'utf8');
let data;
try {
  data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
} catch (e) {
  console.error(`Failed to parse data file: ${e.message}`);
  process.exit(1);
}

// ── Validate required keys ────────────────────────────────────────────────────
const requiredKeys = [
  'SITE_NAME', 'GENERATED_AT', 'STRATEGY', 'EXPORT_TYPE', 'APPROVAL_MODE',
  'GIT_STATUS', 'HAS_ENV_VARS', 'PLAN_STATUS', 'APPROVED_BY', 'APPROVAL_DATE',
  'stages', 'steps', 'risks',
];
const missing = requiredKeys.filter(k => !(k in data));
if (missing.length > 0) {
  console.error(`Missing required keys in data file: ${missing.join(', ')}`);
  process.exit(1);
}

// ── Derived display values ─────────────────────────────────────────────────────
const strategyLabel = data.STRATEGY === 'pp-pipelines'
  ? 'Power Platform Pipelines'
  : 'Manual Export / Import';

const stageCount = Array.isArray(data.stages) ? data.stages.length : 0;

const approvalLabel = (() => {
  const m = String(data.APPROVAL_MODE || '').toLowerCase();
  if (m.includes('required') || m.includes('before each') || m === '1') return 'Required';
  if (m.includes('staging auto') || m === '2') return 'Partial';
  if (m.includes('no approval') || m.includes('auto') || m === '3') return 'None';
  return data.APPROVAL_MODE || 'Not set';
})();

// ── Build __STAGES_HTML__ ─────────────────────────────────────────────────────
function stageClass(stage) {
  // Explicit deployment status takes priority
  const ds = String(stage.deployStatus || '').toLowerCase();
  if (ds === 'deployed')     return 'stage-deployed';
  if (ds === 'failed')       return 'stage-failed';
  if (ds === 'not-deployed') return 'stage-pending';
  // Source stage is always blue (not a deployment target)
  if (stage.type === 'source') return 'stage-not-started';
  // Target stages with no status yet → not-started (blue)
  return 'stage-not-started';
}

const stagesHtml = (data.stages || []).map((stage, i) => {
  const cls = stageClass(stage, i);
  const urlDisplay = stage.envUrl
    ? `<span class="env-url">${escapeHtml(stage.envUrl)}</span>`
    : '';
  const approvalBadge = (stage.approval)
    ? `<div><span class="approval-badge">Approval gate</span></div>`
    : '';
  const stageBox = `<div class="stage-box ${cls}">
  <span class="stage-label">${escapeHtml(stage.label)}</span>
  ${urlDisplay}
  ${approvalBadge}
</div>`;
  const arrow = (i < (data.stages || []).length - 1)
    ? `<div class="stage-arrow">→</div>`
    : '';
  return stageBox + arrow;
}).join('\n');

// ── Build __ENVIRONMENTS_TABLE__ ──────────────────────────────────────────────
const envRows = (data.stages || []).map(stage => {
  const roleLabel = stage.type === 'source' ? 'Source (Dev)' : 'Target';
  const url = stage.envUrl || '—';
  return `<tr>
  <td>${escapeHtml(stage.label)}</td>
  <td>${escapeHtml(roleLabel)}</td>
  <td><code>${escapeHtml(url)}</code></td>
  <td>${escapeHtml(data.EXPORT_TYPE === 'managed' ? 'Managed' : 'Unmanaged')}</td>
</tr>`;
}).join('\n');

// ── Build __ENV_VAR_NOTE__ and __ENV_VAR_CLASS__ ───────────────────────────────
const envVarNote = data.HAS_ENV_VARS
  ? 'This solution has environment variables defined. Per-stage values will be captured or confirmed during the Setup Solution step, then stored in <code>deployment-settings.json</code>. Have the correct values ready for each target environment before executing.'
  : 'No environment variables have been detected in this solution yet. If environment-specific configuration is needed (API endpoints, feature flags, site URLs), variables can be added during the Setup Solution step and will flow through the pipeline automatically.';
const envVarClass = data.HAS_ENV_VARS ? 'warning' : 'neutral';

// ── Build __ENVVAR_FRONTLOAD_NOTICE__ ──────────────────────────────────────────
const envVarFrontloadNotice = data.HAS_ENV_VARS
  ? `<div class="note-box warning" style="margin-bottom:28px;">
  <strong>Environment variables detected.</strong> This solution contains environment-specific configuration.
  Variable names, types, and per-stage values will be defined during the <strong>Setup Solution</strong> step.
  Per-stage overrides are then stored in <code>deployment-settings.json</code> and applied automatically during deployment.
  See <a href="#env-vars" style="color:inherit;">Environment Variable Strategy</a> below for details.
</div>`
  : `<div class="note-box neutral" style="margin-bottom:28px;">
  <strong>Environment Variables:</strong> Any environment-specific configuration (API endpoints, feature flags, site URLs)
  can be added as environment variables during the <strong>Setup Solution</strong> step.
  Each stage (Staging, Production) will then use its own values — no code changes needed between environments.
</div>`;

// ── Build __GIT_NOTE__ and __GIT_CLASS__ ──────────────────────────────────────
const gitNotes = {
  yes: 'Source control is enabled for this project. Changes will be tracked in Git before each deployment.',
  no: 'Source control is not currently enabled. Consider setting up Git to track changes and enable rollback.',
  'not-yet': 'Source control has not been set up yet. It is recommended to enable Git before deploying to production.',
};
const gitNote = gitNotes[String(data.GIT_STATUS).toLowerCase()] || 'Source control status unknown.';
const gitClass = data.GIT_STATUS === 'yes' ? 'info' : 'warning';

// ── Build __CHECKLIST_HTML__ ──────────────────────────────────────────────────
const statusIcon = { pending: '○', 'in-progress': '●', completed: '✓', skipped: '—' };
const checklistHtml = (data.steps || []).map(step => {
  const s = String(step.status || 'pending').toLowerCase().replace(/_/g, '-');
  const icon = statusIcon[s] || '○';
  const skip = step.skip ? ' <em style="opacity:0.6;font-size:12px;">(will skip)</em>' : '';
  return `<div class="checklist-item status-${s}">
  <span class="checklist-icon">${icon}</span>
  <span class="checklist-name">${escapeHtml(step.name)}${skip}</span>
  <span class="status-badge ${s}">${s.replace('-', ' ')}</span>
</div>`;
}).join('\n');

// ── Build __RISKS_HTML__ ──────────────────────────────────────────────────────
const riskIcon = { warning: '⚠', info: 'ℹ', error: '✗' };
const risksHtml = (data.risks || []).length > 0
  ? (data.risks || []).map(risk => {
      const t = String(risk.type || 'info').toLowerCase();
      const icon = riskIcon[t] || 'ℹ';
      return `<div class="risk-item type-${t}">
  <span class="risk-icon">${icon}</span>
  <span class="risk-message">${escapeHtml(risk.message)}</span>
</div>`;
    }).join('\n')
  : '<div class="note-box neutral">No risks or recommendations identified for this plan.</div>';

// ── Build __SOLUTION_CONTENTS__ ───────────────────────────────────────────────
const sc = data.solutionContents;
let solutionContentsHtml = '';

if (!sc) {
  solutionContentsHtml =
    '<div class="note-box neutral">Solution contents will be discovered and added to the solution during the <strong>Setup Solution</strong> step.</div>';
} else {
  // Tables
  const tables = Array.isArray(sc.tables) ? sc.tables : [];
  const tablesHtml = tables.length > 0
    ? tables.map(t => `<span class="table-chip">${escapeHtml(t)}</span>`).join('')
    : '<em style="color:var(--text-dim);font-size:12px;">Will be discovered during Setup Solution</em>';

  // Bot components
  const bots = Array.isArray(sc.botComponents) ? sc.botComponents : [];
  const botsHtml = bots.length > 0
    ? bots.map(b => escapeHtml(b.name || String(b))).join(', ')
    : '<em style="color:var(--text-dim);font-size:12px;">None detected</em>';

  // Site settings
  const ss = sc.siteSettings || null;
  let settingsSummaryHtml = '';
  let promoteTableHtml = '';
  let excludedNoteHtml = '';

  if (ss) {
    const keepList = Array.isArray(ss.keepAsIs) ? ss.keepAsIs : [];
    const authNoValueList = Array.isArray(ss.authNoValue) ? ss.authNoValue : [];
    const promoteList = Array.isArray(ss.promoteToEnvVar) ? ss.promoteToEnvVar : [];
    const excludedList = Array.isArray(ss.excluded) ? ss.excluded : [];
    const total = keepList.length + authNoValueList.length + promoteList.length + excludedList.length;

    settingsSummaryHtml = `<div class="note-box info" style="margin-bottom:14px;">
  <strong>Site Settings:</strong> ${total} detected &mdash;
  <span style="color:var(--text-dim);">${keepList.length} regular settings</span> (included as-is),
  <span style="color:var(--warning);">${promoteList.length} auth settings with values</span> (review for env var promotion),
  ${authNoValueList.length > 0 ? `<span style="color:var(--accent);">${authNoValueList.length} auth settings without dev values</span> (will be included with note),` : ''}
  <span style="color:var(--text-dim);">${excludedList.length} credential secrets excluded</span> (never added to solution).
</div>`;

    if (promoteList.length > 0) {
      const rows = promoteList.map(s => {
        const displayVal = String(s.value || '');
        const truncated = displayVal.length > 60 ? displayVal.substring(0, 60) + '…' : displayVal;
        return `<tr>
  <td><code>${escapeHtml(s.name)}</code></td>
  <td style="font-family:var(--mono);font-size:11px;max-width:220px;word-break:break-all;">${escapeHtml(truncated)}</td>
  <td><span class="env-var-badge promote">Review</span></td>
</tr>`;
      }).join('\n');
      promoteTableHtml = `<h3>Site Settings with Values &mdash; Review for Env Var Promotion</h3>
<p style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">If a setting's value should differ per environment (e.g. a feature flag, API endpoint, or site URL), promote it to an environment variable during Setup Solution. If the value is the same everywhere, include it as a plain site setting.</p>
<div class="card" style="padding:0;overflow:hidden;margin-top:0;">
<table>
  <thead><tr><th>Setting Name</th><th>Current Value (dev)</th><th>Action</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>`;
    }

    if (excludedList.length > 0) {
      excludedNoteHtml = `<div class="note-box neutral" style="margin-top:12px;font-size:12px;">
  <strong>${excludedList.length} credential secret(s) excluded:</strong> OAuth/identity credentials (ConsumerKey, ClientSecret, AppSecret, etc.) are never added to the solution — they must be configured manually in each target environment after deployment.
</div>`;
    }

    if (authNoValueList.length > 0) {
      const authNoValueRows = authNoValueList.map(name =>
        `<tr><td><code>${escapeHtml(name)}</code></td><td style="color:var(--text-dim);font-size:12px;">No value configured in dev — will be included in the solution as-is. Verify or set the correct value in each target environment after deployment.</td></tr>`
      ).join('\n');
      excludedNoteHtml += `<div class="note-box warning" style="margin-top:12px;">
  <strong>Auth settings included without a dev value (${authNoValueList.length}):</strong> These are authentication configuration settings that have no value set in your dev environment. They will be added to the solution with no value. After deploying to each target environment, confirm the correct value is configured there.
  <div class="card" style="padding:0;overflow:hidden;margin-top:8px;">
  <table><thead><tr><th>Setting Name</th><th>Note</th></tr></thead>
  <tbody>${authNoValueRows}</tbody></table></div>
</div>`;
    }
  } else {
    settingsSummaryHtml =
      '<div class="note-box neutral" style="margin-bottom:14px;">Site settings could not be queried. They will be discovered during Setup Solution.</div>';
  }

  const contentsGrid = `<div class="contents-grid">
  <div class="contents-card">
    <div class="contents-card-label">Dataverse Tables</div>
    <div style="line-height:2;">${tablesHtml}</div>
  </div>
  <div class="contents-card">
    <div class="contents-card-label">Bot Components</div>
    <div style="font-size:13px;">${botsHtml}</div>
  </div>
</div>`;

  solutionContentsHtml = contentsGrid + settingsSummaryHtml + promoteTableHtml + excludedNoteHtml;
}

// ── Build plan-status CSS class ───────────────────────────────────────────────
const planStatusClass = String(data.PLAN_STATUS || 'Draft')
  .toLowerCase()
  .replace(/[^a-z]+/g, '-')
  .replace(/-+$/, '');

// ── Replace simple string tokens ──────────────────────────────────────────────
const replacements = {
  SITE_NAME: data.SITE_NAME,
  GENERATED_AT: data.GENERATED_AT,
  STRATEGY_LABEL: strategyLabel,
  STAGE_COUNT: String(stageCount),
  APPROVAL_LABEL: approvalLabel,
  STAGES_HTML: stagesHtml,
  ENVIRONMENTS_TABLE: envRows,
  ENV_VAR_NOTE: envVarNote,
  ENV_VAR_CLASS: envVarClass,
  ENVVAR_FRONTLOAD_NOTICE: envVarFrontloadNotice,
  GIT_NOTE: gitNote,
  GIT_CLASS: gitClass,
  CHECKLIST_HTML: checklistHtml,
  RISKS_HTML: risksHtml,
  APPROVED_BY: data.APPROVED_BY || '',
  APPROVAL_DATE: data.APPROVAL_DATE || '',
  PLAN_STATUS: data.PLAN_STATUS || 'Draft',
  SOLUTION_CONTENTS: solutionContentsHtml,
};

let result = template;
for (const [key, value] of Object.entries(replacements)) {
  result = result.split(`__${key}__`).join(value);
}

// Inject plan-status CSS class onto the span
result = result.replace(
  /(<span class="plan-status"[^>]*>)/,
  `<span class="plan-status ${planStatusClass}">`
);

// Warn about unreplaced tokens
const remaining = result.match(/__[A-Z][A-Z0-9_]+__/g);
if (remaining) {
  const unique = [...new Set(remaining)];
  console.error(`Warning: unreplaced placeholders: ${unique.join(', ')}`);
}

// Ensure output directory exists
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(outputPath, result, 'utf8');
console.log(JSON.stringify({ status: 'ok', output: outputPath }));

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
