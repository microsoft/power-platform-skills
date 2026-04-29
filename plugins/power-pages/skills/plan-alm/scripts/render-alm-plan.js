#!/usr/bin/env node
/**
 * render-alm-plan.js — Renders the ALM plan HTML from a JSON data file.
 *
 * Usage:
 *   node render-alm-plan.js --output <path> --data <json-file>
 *
 * Required top-level keys in the JSON data file:
 *   SITE_NAME, GENERATED_AT, STRATEGY, PLAN_STATUS, APPROVED_BY, APPROVAL_DATE,
 *   stages, steps, risks
 *
 * Optional v2 keys (added for split-solutions support):
 *   sizeAnalysis, assetAdvisory, proposedSolutions, appliedStrategies,
 *   recommendations, envVars, breakdown, estimationMethod, estimationAccuracyPct
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

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const tierColor = { green: 'var(--pass)', yellow: 'var(--high)', red: 'var(--critical)', unknown: 'var(--text-dim)' };

const strategyLabel = data.STRATEGY === 'pp-pipelines' ? 'Power Platform Pipelines' : 'Manual Export / Import';
const proposedSolutions = Array.isArray(data.proposedSolutions) ? data.proposedSolutions : [];
const envVars = Array.isArray(data.envVars) ? data.envVars : [];
const sizeAnalysis = data.sizeAnalysis || null;
const assetAdvisory = data.assetAdvisory || { enabled: false, candidates: [], recommendation: null };
const breakdown = data.breakdown || {};

const totalSizeMB = Number(sizeAnalysis?.totalSizeMB?.value ?? 0);
// Three-number semantics when the estimator ran with --solutionId:
//   componentCountSiteTotal      — RAW Dataverse rows on the site. What the
//                                  Maker UI would show if the entire site
//                                  were adopted into a solution.
//   componentCountInSolution     — solutioncomponents rows for the target
//                                  solution. Matches the Maker "Objects" count.
//   orphansOnSite                — ppcs on the site that aren't in the solution,
//                                  excluding stale bundle chunks.
// For the headline "X components" we prefer inSolution when present (that's
// what the pipeline ships). Fall back to siteTotal or the legacy
// sizeAnalysis.componentCount value when the estimator ran without a solution
// context.
const fallbackComponentCount = Number(sizeAnalysis?.componentCount?.value ?? 0);
const componentCountSiteTotal = Number(data.componentCountSiteTotal ?? fallbackComponentCount);
const componentCountInSolution = (data.componentCountInSolution == null) ? null : Number(data.componentCountInSolution);
const orphansOnSite = (data.orphansOnSite == null) ? null : Number(data.orphansOnSite);
const hasSolutionMembershipBreakout = componentCountInSolution !== null;
const componentCount = hasSolutionMembershipBreakout ? componentCountInSolution : componentCountSiteTotal;
const SIZE_LIMIT_MB = 95;
const exceedsSize = totalSizeMB > SIZE_LIMIT_MB;
const sizeTier = sizeAnalysis?.totalSizeMB?.tier || 'unknown';
const sizeColor = tierColor[sizeTier];

const sizeBadge = proposedSolutions.length > 1 ? 'SPLIT' : (exceedsSize ? 'SPLIT' : 'OK');
const sizeBadgeClass = (proposedSolutions.length > 1 || exceedsSize) ? 'nav-badge-warn' : 'nav-badge-ok';

function buildOverviewSummary() {
  const solCount = proposedSolutions.length || 1;
  const strat = Array.isArray(data.appliedStrategies) && data.appliedStrategies.length > 0
    ? data.appliedStrategies.join(' + ')
    : data.splitStrategy || 'single';

  let msg = `<strong>${escapeHtml(data.SITE_NAME)}</strong> &mdash; `;
  msg += `estimated at <strong>${totalSizeMB.toFixed(1)} MB</strong> with <strong>${componentCount.toLocaleString()}</strong> components. `;
  if (solCount > 1) {
    msg += `Recommendation: <strong>${solCount} solutions</strong> (${strat}). Each solution gets its own pipeline.`;
  } else {
    msg += 'Recommendation: <strong>single solution</strong>. Within thresholds across all signals.';
  }
  if (assetAdvisory.candidates?.length > 0) {
    msg += `<br/><br/>Asset advisory flagged <strong>${assetAdvisory.candidates.length} file(s)</strong> for externalization to Azure Blob.`;
  }
  return msg;
}

function buildStagesHtml() {
  return (data.stages || []).map((stage) => {
    const activeClass = stage.type === 'source' ? 'stage-active' : '';
    const url = stage.envUrl ? `<div class="stage-env">${escapeHtml(stage.envUrl)}</div>` : '';
    return `<div class="pipeline-stage ${activeClass}">
  <div class="stage-name">${escapeHtml(stage.label || '')}</div>
  ${url}
</div>`;
  }).join('\n');
}

function buildRisksHtml() {
  const risks = Array.isArray(data.risks) ? data.risks : [];
  const recs = Array.isArray(data.recommendations) ? data.recommendations : [];
  const all = [...risks, ...recs];
  if (all.length === 0) {
    return '<div class="note-box neutral">No risks or recommendations identified for this plan.</div>';
  }
  const iconMap = { warning: '&#9888;', info: '&#9432;', error: '&#9940;' };
  return all.map((r) => {
    const t = String(r.type || 'info').toLowerCase();
    return `<div class="risk-item type-${t}"><span class="risk-icon">${iconMap[t] || '&#9432;'}</span><span>${escapeHtml(r.message || '')}</span></div>`;
  }).join('\n');
}

function buildStrategyRationale() {
  const strat = data.splitStrategy || 'single';
  const map = {
    'single': 'All components packaged in a single managed solution. Estimated size is within the recommended 95 MB cap and component count is within tested bounds. One pipeline, one approval chain.',
    'strategy-1-layer': 'Components split into <strong>Core</strong> (schema, security, integrations, config) and <strong>WebAssets</strong> (web files). Core imports first; WebAssets can redeploy independently when frontend-only changes land.',
    'strategy-2-change-frequency': 'Four solutions ordered by change frequency: <strong>Foundation</strong> &rarr; <strong>Integration</strong> &rarr; <strong>Config</strong> &rarr; <strong>Content</strong>. Each solution has its own pipeline so low-churn layers don\'t re-import when content changes.',
    'strategy-3-schema-segmentation': 'Tables split by domain into per-domain solutions. A separate <strong>Site</strong> solution imports last. <strong>Warning: schema-heavy imports can take 10+ hours per stage</strong> &mdash; test in staging and avoid peak hours.',
    'strategy-4-config-isolation': 'Environment variable definitions isolated into their own solution so value changes don\'t require re-importing everything else.',
  };
  let rationale = map[strat] || map.single;
  if (data.appliedStrategies?.includes('strategy-4-config-isolation') && strat !== 'strategy-4-config-isolation') {
    rationale += ' Additionally, env var definitions are isolated into a dedicated EnvVars solution (additive Strategy 4).';
  }
  return rationale;
}

function buildSizeAlert() {
  if (proposedSolutions.length > 1) {
    return `<div class="warning-box">
  <span style="font-size:18px;">&#9888;</span>
  <div><strong>${proposedSolutions.length} solutions recommended.</strong> See the Solutions tab for the split layout and Pipelines for per-solution deployment order.</div>
</div>`;
  }
  if (exceedsSize) {
    return `<div class="critical-box">
  <span style="font-size:18px;">&#128680;</span>
  <div><strong>Estimated size ${totalSizeMB.toFixed(1)} MB exceeds the recommended ${SIZE_LIMIT_MB} MB cap.</strong></div>
</div>`;
  }
  return `<div class="pass-box">
  <span style="font-size:18px;">&#9989;</span>
  <div><strong>Within recommended limits.</strong> No split is required.</div>
</div>`;
}

function buildSizeGauge() {
  const maxDisplay = Math.max(totalSizeMB, SIZE_LIMIT_MB) * 1.3;
  const fillPct = Math.min((totalSizeMB / maxDisplay) * 100, 100);
  const threshPct = (SIZE_LIMIT_MB / maxDisplay) * 100;
  const fillColor = exceedsSize
    ? 'linear-gradient(90deg, #ca5010 0%, #d13438 100%)'
    : 'linear-gradient(90deg, #107c10 0%, #0078d4 100%)';
  // When the fill is narrow (small solutions, e.g. 4.9 MB / 95 MB ≈ 4%), the
  // inline "4.9 MB" label overflows the pill and renders as a floating chip
  // that reads like a different number. Drop the inline label below ~15% —
  // the headline size-gauge-value already shows the exact MB value on the
  // right, so this isn't a loss of information, just less visual noise.
  const showInlineLabel = fillPct >= 15;
  const inlineLabel = showInlineLabel
    ? `<span class="size-gauge-fill-label">${totalSizeMB.toFixed(1)} MB</span>`
    : '';
  return `<div class="size-gauge-container">
  <div class="size-gauge-header">
    <div>
      <div class="size-gauge-title">Total Estimated Size</div>
      <div class="size-gauge-limit">Recommended limit: ${SIZE_LIMIT_MB} MB</div>
    </div>
    <div style="text-align:right;">
      <div class="size-gauge-value" style="color:${sizeColor};">${totalSizeMB.toFixed(1)}<span style="font-size:14px;color:var(--text-dim);font-weight:500;"> MB</span></div>
      <div style="font-size:11px;color:var(--text-dim);">${exceedsSize ? (totalSizeMB - SIZE_LIMIT_MB).toFixed(1) + ' MB over limit' : (SIZE_LIMIT_MB - totalSizeMB).toFixed(1) + ' MB under limit'}</div>
    </div>
  </div>
  <div class="size-gauge-track">
    <div class="size-gauge-fill" style="width:${fillPct}%;background:${fillColor};">
      ${inlineLabel}
    </div>
    <div class="size-gauge-threshold" style="left:${threshPct}%;background:var(--text-bright);">
      <div class="size-gauge-threshold-label">${SIZE_LIMIT_MB} MB limit</div>
    </div>
  </div>
</div>`;
}

function buildSignalCards() {
  if (!sizeAnalysis) return '<div class="note-box neutral">Size analysis unavailable.</div>';
  const signals = [
    { key: 'totalSizeMB', label: 'Size (MB)', fmt: (v) => Number(v).toFixed(1), threshold: '&lt; 95 MB' },
    { key: 'componentCount', label: 'Components', fmt: (v) => Number(v).toLocaleString(), threshold: '&lt; 6,000' },
    { key: 'schemaAttrCount', label: 'Schema Attrs', fmt: (v) => Number(v).toLocaleString(), threshold: '&lt; 15,000' },
    { key: 'tableCount', label: 'Tables', fmt: (v) => Number(v).toLocaleString(), threshold: '&lt; 20' },
    { key: 'webFilesAggregateMB', label: 'Web Files (MB)', fmt: (v) => Number(v).toFixed(1), threshold: '&lt; 40 MB' },
    { key: 'envVarCount', label: 'Env Vars', fmt: (v) => Number(v).toLocaleString(), threshold: '&lt; 500' },
  ];
  return signals.map((s) => {
    const a = sizeAnalysis[s.key];
    if (!a) return '';
    const tier = a.tier || 'unknown';
    const color = tierColor[tier];
    return `<div class="signal-card">
  <div class="signal-name">${s.label}</div>
  <div class="signal-value" style="color:${color};">${s.fmt(a.value || 0)}</div>
  <div class="signal-footer">
    <span class="tier tier-${tier}">${tier}</span>
    <span>${s.threshold}</span>
  </div>
</div>`;
  }).join('\n');
}

function buildSizeBreakdown() {
  const entries = [
    { label: 'Tables &amp; Columns', key: 'tables', color: '#0078d4' },
    { label: 'Web Files', key: 'webFiles', color: '#ca5010' },
    { label: 'Cloud Flows', key: 'cloudFlows', color: '#5c2d91' },
    { label: 'Site Settings', key: 'siteSettings', color: '#8764b8' },
    { label: 'Web Roles &amp; Permissions', key: 'webRolesAndPermissions', color: '#107c10' },
    { label: 'Environment Variables', key: 'envVars', color: '#038387' },
    { label: 'Other Metadata', key: 'otherMetadata', color: '#8890a4' },
  ].map((e) => ({ ...e, sizeMB: Number(breakdown[e.key] || 0) }))
   .filter((e) => e.sizeMB > 0)
   .sort((a, b) => b.sizeMB - a.sizeMB);

  if (entries.length === 0) return '<div style="font-size:12px;color:var(--text-dim);">Breakdown not available.</div>';
  const max = Math.max(...entries.map((e) => e.sizeMB));
  const total = entries.reduce((s, e) => s + e.sizeMB, 0);
  return entries.map((e) => {
    const barPct = Math.max((e.sizeMB / max) * 100, 2);
    const pctOfTotal = ((e.sizeMB / total) * 100).toFixed(1);
    return `<div class="size-bar-row">
  <div class="size-bar-label">${e.label}</div>
  <div class="size-bar-track">
    <div class="size-bar-fill" style="width:${barPct}%;background:${e.color};">
      ${barPct > 15 ? `<span class="size-bar-fill-label">${pctOfTotal}%</span>` : ''}
    </div>
  </div>
  <div class="size-bar-value">${e.sizeMB.toFixed(1)} MB</div>
</div>`;
  }).join('\n');
}

function buildAdvisoryHtml() {
  if (!assetAdvisory.enabled) {
    return '<div class="note-box neutral">Asset advisory is disabled in <code>.alm-config.json</code>.</div>';
  }
  const candidates = assetAdvisory.candidates || [];
  if (candidates.length === 0) {
    return '<div class="pass-box"><span style="font-size:18px;">&#9989;</span><div><strong>No assets flagged for externalization.</strong> All web files are under the individual-file threshold (2 MB) or excluded by patterns.</div></div>';
  }
  let html = '';
  if (assetAdvisory.recommendation === 'externalize-media') {
    html += `<div class="warning-box"><span style="font-size:18px;">&#9888;</span>
    <div><strong>Bulk externalization recommended.</strong> Aggregate web file size and media ratio indicate the bundle is dominated by images/fonts. Moving these to Azure Blob (or CDN) will reduce solution size meaningfully and can avoid the need for a split.</div></div>`;
  }
  html += candidates.map((c) => `<div class="advisory-item">
  <div class="advisory-item-size">${Number(c.sizeMB || 0).toFixed(1)} MB</div>
  <div class="advisory-item-body">
    <div class="advisory-item-name">${escapeHtml(c.name)}</div>
    <div class="advisory-item-rationale">${escapeHtml(c.rationale || '')}</div>
    <div style="font-size:11px;color:var(--text-dim);margin-top:4px;font-family:var(--mono);">&rarr; ${escapeHtml(c.suggestedUrlFormat || '')}</div>
  </div>
  <span class="advisory-item-tag ${c.recommendation || 'azure-blob'}">${c.recommendation === 'cdn' ? 'CDN' : 'Azure Blob'}</span>
</div>`).join('\n');
  return html;
}

function buildEnvVarsHtml() {
  if (envVars.length === 0) {
    return '<div class="note-box neutral">No environment variable definitions detected. If environment-specific values are needed (URLs, client IDs, endpoints), they can be added during Setup Solution.</div>';
  }
  const envNames = Object.keys(envVars[0]?.values || {});
  const tableHeader = envNames.length > 0
    ? `<thead><tr><th>Schema Name</th><th>Type</th><th>Bound Setting</th>${envNames.map((e) => `<th>${escapeHtml(e)}</th>`).join('')}</tr></thead>`
    : `<thead><tr><th>Schema Name</th><th>Type</th><th>Bound Setting</th><th>Default</th></tr></thead>`;
  const rows = envVars.map((ev) => {
    const valueCells = envNames.length > 0
      ? envNames.map((e) => `<td class="env-val">${escapeHtml(ev.values?.[e] || '')}</td>`).join('')
      : `<td class="env-val">${escapeHtml(ev.defaultValue || '')}</td>`;
    return `<tr>
  <td class="env-name">${escapeHtml(ev.schemaName)}</td>
  <td>${escapeHtml(ev.type || 'String')}</td>
  <td><code>${escapeHtml(ev.siteSetting || '—')}</code></td>
  ${valueCells}
</tr>`;
  }).join('\n');
  return `<div class="card" style="padding:0;overflow-x:auto;">
  <table class="env-table">${tableHeader}<tbody>${rows}</tbody></table>
</div>`;
}

function buildSolutionsTabTitle() { return proposedSolutions.length > 1 ? `Solutions (${proposedSolutions.length})` : 'Solution'; }
function buildSolutionsTabDesc() {
  return proposedSolutions.length > 1
    ? `Split into ${proposedSolutions.length} managed solutions per the decision tree. Deploy in order shown below.`
    : 'All components packaged in a single managed solution.';
}

function buildAssetAdvisoryCallout() {
  // Surface the advisory on the Solutions tab when the primary recommendation
  // is to move assets out of the solution. Without this pointer, users only
  // see "N proposed solutions" and miss the fact that a CDN/Blob move would
  // likely avoid the split altogether.
  if (!assetAdvisory.enabled) return '';
  if (assetAdvisory.recommendation !== 'externalize-media') return '';
  const candidateCount = Array.isArray(assetAdvisory.candidates) ? assetAdvisory.candidates.length : 0;
  const candidateMB = Array.isArray(assetAdvisory.candidates)
    ? assetAdvisory.candidates.reduce((s, c) => s + Number(c.sizeMB || 0), 0).toFixed(1)
    : '0.0';
  return `<div class="warning-box" style="margin-bottom:16px;">
  <span style="font-size:18px;">&#9888;</span>
  <div>
    <strong>A split may not be necessary.</strong>
    ${escapeHtml(String(candidateCount))} large asset(s) totalling ${escapeHtml(candidateMB)} MB could be moved to Azure Blob or a CDN instead of packaged into solutions.
    Externalizing them typically lets the site stay in a single solution — review the full list on the
    <a href="#" class="solutions-to-advisory" onclick="const b=document.querySelector('.nav-btn[data-tab=&quot;advisory&quot;]');if(b){b.click();window.scrollTo(0,0);}return false;">Asset Advisory tab</a>
    before committing to the split below.
  </div>
</div>`;
}

function buildSolutionMembershipBanner() {
  // When the estimator had a --solutionId context, show the site-vs-solution
  // split so reviewers can reconcile what they see in the Maker UI with what
  // ships. Numbers are all raw row counts — bundle chunks included — so they
  // match the "Objects" page in Power Platform's solution explorer.
  if (!hasSolutionMembershipBreakout) return '';
  const orphansClass = (orphansOnSite && orphansOnSite > 0) ? 'warn' : 'pass';
  const orphansNote = (orphansOnSite && orphansOnSite > 0)
    ? ` · ${orphansOnSite.toLocaleString()} actionable orphan(s) on the site are NOT in this solution — run <code>/power-pages:setup-solution</code> in sync mode to adopt them. (Stale bundle-chunk orphans are excluded from this count.)`
    : ` · solution is fully in sync with the site (no actionable orphans).`;
  return `<div class="note-box ${orphansClass}" style="margin-bottom:16px;">
  <strong>Solution membership vs. site inventory.</strong>
  The site holds <strong>${componentCountSiteTotal.toLocaleString()}</strong> raw rows in Dataverse; the target solution owns <strong>${componentCountInSolution.toLocaleString()}</strong> components.${orphansNote}
</div>`;
}

function buildSolutionsHtml() {
  if (proposedSolutions.length === 0) {
    return '<div class="note-box neutral">Solution structure will be determined during Setup Solution.</div>';
  }
  const membershipHtml = buildSolutionMembershipBanner();
  const calloutHtml = buildAssetAdvisoryCallout();
  const colors = ['#0078d4', '#ca5010', '#107c10', '#8764b8', '#038387', '#5c2d91'];
  const cards = proposedSolutions.map((sol, i) => {
    const color = colors[i % colors.length];
    const overLimit = sol.sizeMB > SIZE_LIMIT_MB;
    const sColor = overLimit ? 'var(--high)' : 'var(--pass)';
    const componentTypes = Array.isArray(sol.componentTypes) ? sol.componentTypes.join(', ') : '';
    const tables = Array.isArray(sol.tableLogicalNames) && sol.tableLogicalNames.length > 0
      ? `<h4>Tables in this solution</h4><div>${sol.tableLogicalNames.map((t) => `<span class="table-chip">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';
    return `<div class="split-solution-card ${i === 0 ? 'open' : ''}">
  <div class="split-solution-header">
    <div class="split-solution-num" style="background:${color};">${sol.order || i + 1}</div>
    <div>
      <div class="split-solution-title">${escapeHtml(sol.displayName || sol.uniqueName)}</div>
      <div class="split-solution-subtitle"><code>${escapeHtml(sol.uniqueName)}</code></div>
    </div>
    <div class="split-solution-size">
      <span class="split-solution-size-val" style="color:${sColor};">${Number(sol.sizeMB || 0).toFixed(1)}</span>
      <span class="split-solution-size-unit">MB</span>
    </div>
    <span class="split-solution-chevron">&#9660;</span>
  </div>
  <div class="split-solution-body">
    <div style="font-size:13px;color:var(--text);margin:14px 0;line-height:1.7;">${escapeHtml(sol.description || '')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:12px;">
      <div><h4>Component types</h4><div style="color:var(--text);">${escapeHtml(componentTypes)}</div></div>
      <div><h4>Component count (est.)</h4><div style="font-family:var(--mono);font-size:15px;font-weight:700;">${(sol.componentCount || 0).toLocaleString()}</div></div>
    </div>
    ${tables}
  </div>
</div>`;
  }).join('\n');
  return `${membershipHtml}${calloutHtml}${cards}`;
}

function buildPipelinesTabTitle() {
  // We always provision a single pipeline now, even in multi-solution plans —
  // multi-solution is expressed via deploymentOrder against the same pipeline.
  return 'Deployment Pipeline';
}
function buildPipelinesTabDesc() {
  const nDeployable = proposedSolutions.filter((s) => !s.isFutureBuffer).length;
  return proposedSolutions.length > 1
    ? `One Power Platform Pipeline runs ${nDeployable} solution${nDeployable === 1 ? '' : 's'} in dependency order against each target environment. The empty Future solution is created but skipped during deployment until it has content.`
    : `Power Platform Pipelines configuration for promoting ${escapeHtml(data.SITE_NAME)} across environments.`;
}

function buildPipelineActiveAnnotations(meta, color) {
  // Renders the chips/notes that mark a pipeline as the one currently being
  // used to move configurations — only emitted when planData has a
  // pipelineMeta block (i.e. .last-pipeline.json exists for this project).
  if (!meta || !meta.isActive) return { chip: '', wiringNote: '', lastRunFooter: '' };

  const chip = `<span style="display:inline-block;font-size:9px;font-weight:700;padding:2px 8px;margin-left:8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;font-family:var(--mono);background:${color}1a;border:1px solid ${color}55;color:${color};">ACTIVE</span>`;

  let wiringNote = '';
  if (meta.reusedByWiring && typeof meta.reusedByWiring === 'object') {
    const orig = escapeHtml(meta.reusedByWiring.originalName || '');
    const req = escapeHtml(meta.reusedByWiring.requestedName || '');
    wiringNote = `<div style="margin-top:6px;font-size:11px;color:var(--text-dim);line-height:1.5;">
  <strong style="color:var(--high);">Reused</strong> &mdash; matched on source+target wiring. Original pipeline name: <code>${orig}</code>${req ? ` (requested name was <code>${req}</code>)` : ''}.
</div>`;
  }

  let lastRunFooter = '';
  const ld = meta.lastDeploy;
  if (ld && typeof ld === 'object') {
    const status = String(ld.status || '');
    const sLow = status.toLowerCase();
    const statusColor = sLow === 'succeeded' ? 'var(--pass)' : (sLow === 'failed' ? 'var(--critical)' : 'var(--high)');
    const parts = [];
    if (ld.artifactVersion) parts.push(`<code>v${escapeHtml(ld.artifactVersion)}</code>`);
    parts.push(`<span style="color:${statusColor};font-weight:600;">${escapeHtml(status || 'unknown')}</span>`);
    if (ld.stageName) parts.push(escapeHtml(ld.stageName));
    if (ld.deployedAt) parts.push(`<span style="font-family:var(--mono);">${escapeHtml(ld.deployedAt)}</span>`);
    if (ld.componentCount != null) parts.push(`${Number(ld.componentCount)} components`);
    lastRunFooter = `<div style="margin-top:6px;font-size:11px;color:var(--text-dim);">
  Last run: ${parts.join(' &middot; ')}
</div>`;
  }
  return { chip, wiringNote, lastRunFooter };
}

function buildPipelinesHtml() {
  const colors = ['#0078d4', '#ca5010', '#107c10', '#8764b8', '#038387'];
  const stages = Array.isArray(data.stages) ? data.stages : [];
  const stagesHtml = stages.map((st) => `<div class="pipeline-stage ${st.type === 'source' ? 'stage-active' : ''}">
    <div class="stage-name">${escapeHtml(st.label || '')}</div>
    <div class="stage-env">${escapeHtml(st.envUrl || '')}</div>
  </div>`).join('');

  const meta = data.pipelineMeta && typeof data.pipelineMeta === 'object' ? data.pipelineMeta : null;
  const activeColor = colors[0];
  const ann = buildPipelineActiveAnnotations(meta, activeColor);

  // Pipeline name: prefer the actual provisioned name when known.
  const synthesizedName = `${escapeHtml(data.SITE_NAME || 'Site')}-Pipeline`;
  const pipelineName = meta && meta.pipelineName
    ? escapeHtml(meta.pipelineName)
    : synthesizedName;

  if (proposedSolutions.length > 1) {
    const nDeployable = proposedSolutions.filter((s) => !s.isFutureBuffer).length;
    const header = `<div class="pipeline-solution-label">
  <span class="pipeline-solution-dot" style="background:${activeColor};"></span>
  <span class="pipeline-solution-name">${pipelineName}</span>${ann.chip}
  <span style="margin-left:auto;font-size:11px;color:var(--text-dim);">1 pipeline &middot; ${nDeployable} run${nDeployable === 1 ? '' : 's'}</span>
</div>${ann.wiringNote}${ann.lastRunFooter}
<div class="pipeline-container">${stagesHtml}</div>`;

    // Deployment order list — each solution is a stage run. Future buffer shown
    // distinctly so reviewers understand it's created but not deployed yet.
    const orderRows = proposedSolutions.map((sol, i) => {
      const color = colors[i % colors.length];
      const isFuture = !!sol.isFutureBuffer;
      const label = isFuture ? 'Skipped (empty)' : `Run ${sol.order || i + 1}`;
      const labelColor = isFuture ? 'var(--text-dim)' : color;
      return `<div class="pipeline-solution-label" style="margin-top:8px;">
  <span class="pipeline-solution-dot" style="background:${labelColor};"></span>
  <span class="pipeline-solution-name">${escapeHtml(sol.uniqueName)}</span>
  <span style="margin-left:auto;font-size:11px;color:${isFuture ? 'var(--text-dim)' : 'var(--text-dim)'};">${label}</span>
</div>`;
    }).join('');

    return `${header}
<div style="margin-top:16px;">
  <h4 style="margin:0 0 8px 0;font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em;">Deployment order</h4>
  ${orderRows}
</div>`;
  }

  // Single-solution path. Show a header with the pipeline name + ACTIVE chip
  // when meta is present; otherwise just the stage flow (preserves prior look
  // for fresh/unconfigured plans).
  if (meta) {
    return `<div class="pipeline-solution-label">
  <span class="pipeline-solution-dot" style="background:${activeColor};"></span>
  <span class="pipeline-solution-name">${pipelineName}</span>${ann.chip}
</div>${ann.wiringNote}${ann.lastRunFooter}
<div class="pipeline-container">${stagesHtml}</div>`;
  }
  return `<div class="pipeline-container">${stagesHtml}</div>`;
}

function buildValidationTab(d) {
  // Renders the full "Site Validation" tab body. One sub-tab per target stage.
  // Each sub-tab shows a summary grid + per-category test cards.
  //
  // Data shape (from plan-alm Phase 7 Step C, ingesting test-site's .last-test-site.json):
  //   data.validationRuns = {
  //     "<stageName>": null | {
  //       url, runAt, durationSec, runOutcome,
  //       summary: { critical, high, medium, low, total, automated, manual,
  //                  passed, failed, skipped },
  //       categories: [
  //         { id, name, icon, tests: [
  //             { id, name, severity, type, status, description, steps[],
  //               expected, actual, validates }
  //         ]}
  //       ]
  //     }
  //   }
  //
  // For stages in data.stages with type === 'target' that have no entry (or null),
  // an empty-state pane is rendered so reviewers see the stage but understand
  // testing hasn't run yet.

  const targetStages = (Array.isArray(d.stages) ? d.stages : [])
    .filter((s) => s && s.type === 'target' && s.label)
    .map((s) => s.label);
  const runs = (d.validationRuns && typeof d.validationRuns === 'object') ? d.validationRuns : {};

  // Stage list = union of target stages + any stage names already captured.
  // Preserve target-stage order; append unknown stages last (rare, but possible
  // if stages were renamed mid-run).
  const allStages = [...targetStages];
  for (const stageName of Object.keys(runs)) {
    if (!allStages.includes(stageName)) allStages.push(stageName);
  }

  if (allStages.length === 0) {
    return `<div class="card site-validation-card">
  <div class="note-box neutral">No target stages defined &mdash; nothing to validate. Validation runs after each stage's deployment + activation.</div>
</div>`;
  }

  const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_');

  function statusBadgeForStage(run) {
    if (!run) {
      return `<span class="subtab-status subtab-status-pending">Not run</span>`;
    }
    const o = String(run.runOutcome || '').toLowerCase();
    if (o === 'failed') return `<span class="subtab-status subtab-status-fail">Failed</span>`;
    if (o === 'passed-with-warnings') return `<span class="subtab-status subtab-status-warn">Warnings</span>`;
    return `<span class="subtab-status subtab-status-pass">Passed</span>`;
  }

  // Sub-tab bar
  const subtabBar = allStages.map((stageName, i) => {
    const run = runs[stageName] || null;
    const id = safeId(stageName);
    return `<button class="subtab-btn${i === 0 ? ' active' : ''}" data-vstage="${id}">
  <span class="subtab-name">${escapeHtml(stageName)}</span>
  ${statusBadgeForStage(run)}
</button>`;
  }).join('');

  // Per-stage panes
  const panes = allStages.map((stageName, i) => {
    const run = runs[stageName] || null;
    const id = safeId(stageName);
    const paneClass = `vstage-pane${i === 0 ? ' active' : ''}`;
    return `<div class="${paneClass}" id="vstage-${id}">${buildValidationStagePane(stageName, run)}</div>`;
  }).join('');

  return `<div class="card site-validation-card">
  <div style="font-size:12px;color:var(--text-dim);margin-bottom:14px;line-height:1.6;">
    Migration validation tests run after each target stage's deployment and activation. Each tab below corresponds to one target environment. Tests are categorized and grouped by severity &mdash; <strong>Critical</strong> failures should be addressed before promoting to the next stage; lower-severity findings are diagnostic only.
  </div>
  <div class="subtab-bar" role="tablist">${subtabBar}</div>
  <div class="vstage-panes">${panes}</div>
</div>`;
}

function buildValidationStagePane(stageName, run) {
  if (!run) {
    return `<div class="note-box neutral" style="margin-top:14px;">Not yet tested. <code>/power-pages:test-site</code> runs automatically after this stage's deployment and activation.</div>`;
  }

  const url = run.url ? `<code>${escapeHtml(run.url)}</code>` : '<span style="color:var(--text-dim);">&mdash;</span>';
  const dur = (run.durationSec != null) ? `${Number(run.durationSec).toFixed(0)}s` : '&mdash;';
  const runAt = run.runAt ? `<span style="font-family:var(--mono);">${escapeHtml(run.runAt)}</span>` : '&mdash;';

  const summary = run.summary || {};
  const cardClass = (n) => Number(n || 0) > 0 ? 'has-value' : 'zero-value';
  const summaryGrid = `<div class="test-summary-grid">
  <div class="test-summary-card ${cardClass(summary.critical)}">
    <div class="test-summary-num critical">${Number(summary.critical || 0)}</div>
    <div class="test-summary-label">Critical</div>
  </div>
  <div class="test-summary-card ${cardClass(summary.high)}">
    <div class="test-summary-num high">${Number(summary.high || 0)}</div>
    <div class="test-summary-label">High</div>
  </div>
  <div class="test-summary-card ${cardClass((summary.medium || 0) + (summary.low || 0))}">
    <div class="test-summary-num medium">${Number((summary.medium || 0) + (summary.low || 0))}</div>
    <div class="test-summary-label">Medium / Low</div>
  </div>
  <div class="test-summary-card has-value">
    <div class="test-summary-num">${Number(summary.total || 0)}</div>
    <div class="test-summary-label">Total Tests</div>
  </div>
</div>`;

  // Run header (URL, runAt, duration, outcome)
  const outcomeKlass = (() => {
    const o = String(run.runOutcome || '').toLowerCase();
    if (o === 'failed') return 'critical';
    if (o === 'passed-with-warnings') return 'high';
    return 'pass';
  })();
  const outcomeLabel = (() => {
    const o = String(run.runOutcome || '').toLowerCase();
    if (o === 'failed') return 'FAILED';
    if (o === 'passed-with-warnings') return 'WARNINGS';
    return 'PASSED';
  })();
  const runHeader = `<div class="vstage-header">
  <div class="vstage-header-row">
    <span class="vstage-header-label">URL</span>
    <span class="vstage-header-value">${url}</span>
  </div>
  <div class="vstage-header-row">
    <span class="vstage-header-label">Run at</span>
    <span class="vstage-header-value">${runAt}</span>
  </div>
  <div class="vstage-header-row">
    <span class="vstage-header-label">Duration</span>
    <span class="vstage-header-value">${dur}</span>
  </div>
  <div class="vstage-header-row">
    <span class="vstage-header-label">Outcome</span>
    <span class="test-result-badge test-result-${outcomeKlass === 'pass' ? 'pass' : (outcomeKlass === 'high' ? 'warning' : 'fail')}">${outcomeLabel}</span>
  </div>
</div>`;

  // Categories
  const categories = Array.isArray(run.categories) ? run.categories : [];
  const categoryHtml = categories.length === 0
    ? `<div class="note-box neutral" style="margin-top:14px;">Run completed but produced no categorized findings.</div>`
    : categories.map((cat) => buildValidationCategory(cat)).join('');

  return `${runHeader}
${summaryGrid}
${categoryHtml}`;
}

function buildValidationCategory(cat) {
  if (!cat || !Array.isArray(cat.tests) || cat.tests.length === 0) return '';
  const tests = cat.tests;

  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  tests.forEach((t) => {
    const s = String(t.severity || '').toLowerCase();
    if (sevCounts.hasOwnProperty(s)) sevCounts[s]++;
  });

  const sevPills = ['critical', 'high', 'medium', 'low']
    .filter((s) => sevCounts[s] > 0)
    .map((s) => `<span class="severity-badge severity-${s}">${sevCounts[s]} ${s}</span>`)
    .join(' ');

  const cards = tests.map((t) => buildValidationTestCard(t)).join('');

  return `<div class="test-category">
  <div class="test-category-header">
    <span class="test-category-icon">${cat.icon || ''}</span>
    <span class="test-category-title">${escapeHtml(cat.name || cat.id || '')}</span>
    <span class="test-category-count">${tests.length} test${tests.length === 1 ? '' : 's'}</span>
    <span style="margin-left:auto;display:flex;gap:4px;">${sevPills}</span>
  </div>
  ${cards}
</div>`;
}

function buildValidationTestCard(t) {
  const sev = String(t.severity || 'low').toLowerCase();
  const type = String(t.type || 'automated').toLowerCase();
  const status = String(t.status || '').toLowerCase();
  const statusBadge = (() => {
    if (status === 'passed') return `<span class="test-status-badge test-status-pass">PASS</span>`;
    if (status === 'failed') return `<span class="test-status-badge test-status-fail">FAIL</span>`;
    if (status === 'skipped') return `<span class="test-status-badge test-status-skip">SKIP</span>`;
    return '';
  })();
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const stepsHtml = steps.length > 0
    ? `<div class="field-label" style="margin-top:14px;margin-bottom:4px;">Steps</div>
  <ol class="test-steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
    : '';
  const expectedHtml = t.expected
    ? `<div class="test-expected"><strong>Expected Result:</strong> ${escapeHtml(t.expected)}</div>`
    : '';
  const actualHtml = t.actual
    ? `<div class="test-actual ${status === 'failed' ? 'is-failed' : ''}"><strong>Actual:</strong> ${escapeHtml(t.actual)}</div>`
    : '';
  const validatesHtml = t.validates
    ? `<div style="grid-column:span 2"><div class="field-label">Validates</div><span style="font-size:12px;color:var(--text);line-height:1.6;">${escapeHtml(t.validates)}</span></div>`
    : '';
  const descHtml = t.description
    ? `<div style="font-size:12px;color:var(--text);margin:12px 0;line-height:1.7;">${escapeHtml(t.description)}</div>`
    : '';

  return `<div class="test-card test-card-${status || 'unknown'}" id="test-${escapeHtml(t.id || '')}">
  <div class="test-card-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span class="severity-badge severity-${sev}">${sev}</span>
    <span class="test-type-badge test-type-${type === 'manual' ? 'manual' : 'automated'}">${type}</span>
    ${statusBadge}
    <span class="test-card-name">${escapeHtml(t.name || t.id || '')}</span>
    <span class="test-card-chevron">&#9654;</span>
  </div>
  <div class="test-card-body">
    ${descHtml}
    <div class="test-detail-grid">
      <div>
        <div class="field-label">Severity</div>
        <span class="severity-badge severity-${sev}" style="font-size:10px;">${sev.toUpperCase()}</span>
      </div>
      <div>
        <div class="field-label">Type</div>
        <span class="test-type-badge test-type-${type === 'manual' ? 'manual' : 'automated'}" style="font-size:10px;">${type === 'automated' ? 'Automated (scriptable)' : 'Manual (browser)'}</span>
      </div>
      ${validatesHtml}
    </div>
    ${stepsHtml}
    ${expectedHtml}
    ${actualHtml}
  </div>
</div>`;
}

// Sidebar nav button for the Validation tab — badge shows total failure count
// (critical + high + failed status), or "OK" when everything passed.
function buildValidationNavBadge() {
  const runs = (data.validationRuns && typeof data.validationRuns === 'object') ? data.validationRuns : null;
  if (!runs) return { text: '', cls: '' };
  let totalFailures = 0;
  let totalRuns = 0;
  for (const v of Object.values(runs)) {
    if (!v || typeof v !== 'object') continue;
    totalRuns++;
    const s = v.summary || {};
    totalFailures += Number(s.critical || 0) + Number(s.high || 0);
  }
  if (totalRuns === 0) return { text: '', cls: '' };
  if (totalFailures > 0) return { text: String(totalFailures), cls: 'nav-badge-warn' };
  return { text: 'OK', cls: 'nav-badge-ok' };
}

function buildHostCardHtml(d) {
  // Renders the "Pipelines Host" card on the Pipeline tab. Three modes:
  //   - host-card-ok      → AvailableUsing* statuses (host already established)
  //   - host-card-pending → AvailableUnboundCustomHost / MultipleUnboundCustomHosts /
  //                         PlatformHostExistsUnbound / NoHost (will be ensured by setup-pipeline)
  //   - host-card-blocked → CannotRedirect (defensive — Phase 2 Q4 normally blocks plan generation)
  // Returns '' when no hostResolution block is present (Manual path or pre-update plans).
  const hr = d && d.hostResolution;
  if (!hr || !hr.status) return '';
  const status = String(hr.status);
  if (status.startsWith('AvailableUsing')) {
    const url = hr.hostEnvUrl || '';
    const meta = [];
    if (hr.hostType) meta.push(escapeHtml(hr.hostType));
    if (hr.pipelinesSolutionVersion) meta.push('Pipelines v' + escapeHtml(hr.pipelinesSolutionVersion));
    meta.push('&#10003; Reachable');
    return `<div class="card host-card host-card-ok">
  <div class="card-label">Pipelines Host</div>
  <div class="card-value">${escapeHtml(url)}</div>
  <div class="card-meta">${meta.join(' &middot; ')}</div>
</div>`;
  }
  if (hr.willEnsureDuringExecution === true) {
    let note = '';
    if (status === 'AvailableUnboundCustomHost') {
      note = 'Will reuse existing Custom Host' + (hr.hostEnvUrl ? ' <code>' + escapeHtml(hr.hostEnvUrl) + '</code>' : '') + ' (in tenant, not yet bound to dev env).';
    } else if (status === 'MultipleUnboundCustomHosts') {
      note = 'Will pick from ' + Number(hr.candidatesCount || 0) + ' existing Custom Hosts at execution time.';
    } else if (status === 'PlatformHostExistsUnbound') {
      note = 'Will use existing Platform Host (free, no admin role required).';
    } else if (status === 'NoHost') {
      note = 'Will provision new Custom Host with <code>D365_ProjectHost</code> template (~5&ndash;10 min, requires Power Platform admin).';
    } else {
      note = 'Will be resolved during setup-pipeline (' + escapeHtml(status) + ').';
    }
    return `<div class="card host-card host-card-pending">
  <div class="card-label">Pipelines Host</div>
  <div class="card-value">Will be ensured during setup-pipeline</div>
  <div class="card-meta">${note}</div>
</div>`;
  }
  if (status === 'CannotRedirect') {
    // Defensive: plan-alm Phase 2 Q4 normally blocks plan generation in this state.
    // If we get here, surface the error visibly so reviewers understand the plan is unsafe.
    return `<div class="card host-card host-card-blocked">
  <div class="card-label">Pipelines Host</div>
  <div class="card-value">Blocked &mdash; CannotRedirect</div>
  <div class="card-meta">Source env <code>ProjectHostEnvironmentId</code> points at Platform Host but tenant default custom host is set elsewhere. Resolution requires Power Platform admin.</div>
</div>`;
  }
  // Other terminal states (OrgSettingStale / PermissionDenied / DetectionFailed) fall through with no card.
  return '';
}

function buildHostChecklistSubBullet(d) {
  // Renders a sub-bullet under the "Setup pipeline" checklist item when setup-pipeline
  // will delegate to ensure-pipelines-host at execution time. Display-only — no separate
  // status tracking; the parent "Setup pipeline" status covers it. The <li> is wrapped
  // in a <ul> so it is valid HTML when slotted directly into the template.
  if (!d || !d.hostResolution || d.hostResolution.willEnsureDuringExecution !== true) return '';
  return `<ul class="checklist-substep-list"><li class="checklist-substep" id="check-ensure-host">&#8627; Ensure Pipelines host <span class="substep-note">(delegated by setup-pipeline)</span></li></ul>`;
}

function buildChecklistHtml() {
  const statusIcon = { pending: '&#9675;', 'in-progress': '&#9679;', completed: '&#10003;', skipped: '&mdash;', warning: '&#9888;' };
  const steps = Array.isArray(data.steps) ? data.steps : [];
  if (steps.length === 0) return '<div class="note-box neutral">Execution steps will be populated after approval.</div>';
  const runs = (data.validationRuns && typeof data.validationRuns === 'object') ? data.validationRuns : {};

  // Match "Test site in {stageName}" entries to their captured validationRun.
  // Also enrich every "<verb> in {stageName}" step with a stage-env subline so
  // reviewers can see the target env URL inline.
  const targetStageByLabel = {};
  for (const st of (Array.isArray(data.stages) ? data.stages : [])) {
    if (st && st.label) targetStageByLabel[st.label] = st;
  }

  return steps.map((step) => {
    let s = String(step.status || 'pending').toLowerCase().replace(/_/g, '-');
    const skip = step.skip ? ' <em style="opacity:0.6;font-size:12px;">(will skip)</em>' : '';
    const name = String(step.name || '');

    // Detect "<verb> in <stageName>" pattern. The same parser handles
    // "Deploy to Staging", "Activate site in Staging", and "Test site in Staging".
    const stageMatch = name.match(/(?:to|in)\s+(.+)$/i);
    const stageName = stageMatch ? stageMatch[1].trim() : null;
    const stageInfo = stageName && targetStageByLabel[stageName] ? targetStageByLabel[stageName] : null;

    // Test-site step: surface the validation run summary if we have one.
    const isTestStep = /^test\s+site\s+in\s+/i.test(name);
    let validationLine = '';
    if (isTestStep && stageName) {
      const run = runs[stageName] || null;
      if (run && typeof run === 'object') {
        const o = String(run.runOutcome || '').toLowerCase();
        const badgeKlass =
          o === 'failed' ? 'test-result-fail' :
          o === 'passed-with-warnings' ? 'test-result-warning' :
          'test-result-pass';
        const badgeLabel =
          o === 'failed' ? 'FAILED' :
          o === 'passed-with-warnings' ? 'WARNINGS' :
          'PASSED';
        const sm = run.summary || {};
        const counts = [];
        if (Number(sm.passed || 0) > 0) counts.push(`${Number(sm.passed)} pass`);
        if (Number(sm.failed || 0) > 0) counts.push(`${Number(sm.failed)} fail`);
        if (Number(sm.skipped || 0) > 0) counts.push(`${Number(sm.skipped)} skip`);
        const countsStr = counts.length ? ` &middot; ${counts.join(' / ')}` : '';
        validationLine = `<div class="checklist-substep-list" style="margin-top:4px;">
  <li class="checklist-substep" style="display:flex;align-items:center;gap:8px;">
    <span class="test-result-badge ${badgeKlass}">${badgeLabel}</span>
    <span style="font-size:11px;">${run.url ? `<code>${escapeHtml(run.url)}</code>` : '&mdash;'}${countsStr}</span>
    <a href="#tab-validation" onclick="document.querySelector('[data-tab=\\'validation\\']').click(); return false;" style="margin-left:auto;font-size:11px;color:var(--accent);text-decoration:none;">View details &rarr;</a>
  </li>
</div>`;
        // Promote step status to "warning" yellow when the test failed/warned —
        // makes the failure visible at a glance from the Execution tab.
        if (s === 'completed' && o === 'failed') s = 'warning';
      } else if (s === 'completed' || s === 'pending' || s === 'in-progress') {
        // Step exists but no run captured — show a small note.
        validationLine = `<div class="checklist-substep-list" style="margin-top:4px;">
  <li class="checklist-substep" style="font-size:11px;">No test-site run captured for <strong>${escapeHtml(stageName)}</strong> yet.</li>
</div>`;
      }
    }

    // Env-name subline: for any stage-bound step (Deploy / Activate / Test),
    // show the target env URL beneath the step name. Plays well with the
    // existing checklist-substep-list styling.
    let envLine = '';
    if (stageInfo && stageInfo.envUrl && !isTestStep) {
      envLine = `<div class="checklist-substep-list" style="margin-top:2px;">
  <li class="checklist-substep" style="font-size:11px;color:var(--text-dim);">Target: <code>${escapeHtml(stageInfo.envUrl)}</code></li>
</div>`;
    }

    return `<div class="checklist-item status-${s}">
  <span class="checklist-icon">${statusIcon[s] || '&#9675;'}</span>
  <span class="checklist-name">${escapeHtml(name)}${skip}</span>
  <span class="status-badge ${s}">${s.replace('-', ' ')}</span>
</div>${envLine}${validationLine}`;
  }).join('\n');
}

const planStatusClass = String(data.PLAN_STATUS || 'Draft').toLowerCase().replace(/[^a-z]+/g, '-').replace(/-+$/, '');

const replacements = {
  SITE_NAME: escapeHtml(data.SITE_NAME),
  GENERATED_AT: escapeHtml(data.GENERATED_AT),
  STRATEGY_LABEL: strategyLabel,
  PLAN_STATUS: escapeHtml(data.PLAN_STATUS || 'Draft'),
  APPROVED_BY: escapeHtml(data.APPROVED_BY || ''),
  APPROVAL_DATE: escapeHtml(data.APPROVAL_DATE || ''),
  OVERVIEW_SUMMARY: buildOverviewSummary(),
  STAT_COMPONENTS: (componentCount || 0).toLocaleString(),
  STAT_ENVVARS: String(envVars.length || 0),
  STAT_SIZE: totalSizeMB.toFixed(1),
  STAT_SIZE_COLOR: sizeColor,
  STAT_SOLUTIONS: String(proposedSolutions.length || 1),
  STAGES_HTML: buildStagesHtml(),
  RISKS_HTML: buildRisksHtml(),
  STRATEGY_RATIONALE: buildStrategyRationale(),
  SIZE_ALERT: buildSizeAlert(),
  SIZE_GAUGE: buildSizeGauge(),
  SIGNAL_CARDS: buildSignalCards(),
  SIZE_BREAKDOWN: buildSizeBreakdown(),
  SIZE_BADGE: sizeBadge,
  SIZE_BADGE_CLASS: sizeBadgeClass,
  ADVISORY_HTML: buildAdvisoryHtml(),
  ENVVARS_HTML: buildEnvVarsHtml(),
  SOLUTIONS_TAB_TITLE: buildSolutionsTabTitle(),
  SOLUTIONS_TAB_DESC: buildSolutionsTabDesc(),
  SOLUTIONS_HTML: buildSolutionsHtml(),
  PIPELINES_TAB_TITLE: buildPipelinesTabTitle(),
  PIPELINES_TAB_DESC: buildPipelinesTabDesc(),
  PIPELINES_HOST_CARD: buildHostCardHtml(data),
  PIPELINES_HTML: buildPipelinesHtml(),
  VALIDATION_TAB: buildValidationTab(data),
  VALIDATION_NAV_BADGE: buildValidationNavBadge().text,
  VALIDATION_NAV_BADGE_CLASS: buildValidationNavBadge().cls,
  CHECKLIST_HTML: buildChecklistHtml(),
  HOST_CHECKLIST_SUBSTEP: buildHostChecklistSubBullet(data),
  ESTIMATION_METHOD: escapeHtml(data.estimationMethod || 'metadata-based'),
  ESTIMATION_ACCURACY: String(data.estimationAccuracyPct || 15),
};

let result = template;
for (const [key, value] of Object.entries(replacements)) {
  result = result.split(`__${key}__`).join(value);
}

// The template contains exactly one `<span class="plan-status">` in the topbar —
// we inject the status-specific modifier class onto it. If a future template revision
// adds a second occurrence, switch to a `replace_all`-style loop.
result = result.replace(/(<span class="plan-status)"/, `$1 ${planStatusClass}"`);

const remaining = result.match(/__[A-Z][A-Z0-9_]+__/g);
if (remaining) {
  const unique = [...new Set(remaining)];
  console.error(`Warning: unreplaced placeholders: ${unique.join(', ')}`);
}

const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, result, 'utf8');
console.log(JSON.stringify({ status: 'ok', output: outputPath }));
