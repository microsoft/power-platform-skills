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
function stageClass(stage, index) {
  if (stage.type === 'source' || stage.label.toLowerCase() === 'dev') return 'dev';
  // Last stage gets production color; intermediate stages get staging color
  const targets = (data.stages || []).filter(s => s.type !== 'source');
  const targetIndex = targets.indexOf(stage);
  if (targetIndex === targets.length - 1 && targets.length > 1) return 'production';
  return 'staging';
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
  ? 'This solution contains environment variables. You will be prompted to provide per-stage values during each deployment run. Ensure you have the correct values ready for each target environment before executing.'
  : 'No environment variable overrides are required for this solution.';
const envVarClass = data.HAS_ENV_VARS ? 'warning' : 'neutral';

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
  GIT_NOTE: gitNote,
  GIT_CLASS: gitClass,
  CHECKLIST_HTML: checklistHtml,
  RISKS_HTML: risksHtml,
  APPROVED_BY: data.APPROVED_BY || '',
  APPROVAL_DATE: data.APPROVAL_DATE || '',
  PLAN_STATUS: data.PLAN_STATUS || 'Draft',
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
