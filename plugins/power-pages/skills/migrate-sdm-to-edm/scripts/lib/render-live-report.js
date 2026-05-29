/**
 * render-live-report.js
 *
 * Pure render function: migration-state.json -> HTML string.
 *
 * The output structure mirrors the three committed reference samples in
 * `scripts/sample-reports/live-report-samples/`. Any structural change here
 * should be cross-checked against those samples.
 */

const {
  PHASE_STATUS,
  SUB_STEP_STATUS,
  APPROVAL_KIND,
  PROMPT_STATUS,
} = require('./migration-state-schema');

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Allow a small set of inline HTML in sub-step output / banner body so callers can
// pass <code>, <strong>, <br>, <em>. Anything else is escaped. Implemented as a
// tag whitelist on top of escapeHtml.
function escapeHtmlAllowingInline(s) {
  if (s == null) return '';
  const escaped = escapeHtml(s);
  return escaped
    .replace(/&lt;(\/?(?:code|strong|em|br))&gt;/g, '<$1>')
    .replace(/&lt;br\s*\/&gt;/g, '<br/>');
}

function formatElapsed(fromIso, toIso) {
  if (!fromIso) return '0m 00s';
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso || new Date().toISOString()).getTime();
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function countCompleted(state) {
  let n = 0;
  for (const p of state.phases) {
    for (const s of p.subSteps) {
      if (s.status === SUB_STEP_STATUS.COMPLETED) n += 1;
    }
  }
  return n;
}

// Total varies by track (A = 13, B = 16), so derive from the chosen track's
// phase blueprint at render time rather than treating it as a constant.
function totalSubSteps(state) {
  return state.phases.reduce((n, p) => n + p.subSteps.length, 0);
}

function overallPercent(state) {
  const total = totalSubSteps(state);
  if (total === 0) return 0;
  return Math.round((countCompleted(state) / total) * 100);
}

function statusPillFor(state) {
  // An in-progress phase always wins the pill — the banner separately reflects any
  // mid-phase approval gate. Phase-start gates only matter when no phase is yet
  // running, since they describe the *next* phase, not a current one.
  const inProgress = state.phases.find((p) => p.status === PHASE_STATUS.IN_PROGRESS);
  if (inProgress) {
    return `🔵 In Progress · Phase ${inProgress.id} of ${state.phases.length}`;
  }
  const gate = state.approvalGate;
  if (gate && gate.kind === APPROVAL_KIND.PHASE_START) {
    return `⏸️ Awaiting Approval to start Phase ${gate.phaseId}`;
  }
  const allDone = state.phases.every((p) => p.status === PHASE_STATUS.COMPLETED);
  if (allDone) return '✅ Migration Complete';
  return '⏸️ Awaiting Approval to start Phase 1';
}

function subtitleFor(state) {
  const inProgress = state.phases.find((p) => p.status === PHASE_STATUS.IN_PROGRESS);
  if (inProgress) {
    const suffix = state.currentActivity ? ` · ${state.currentActivity}` : '';
    return `${inProgress.title} in progress${suffix}`;
  }
  const gate = state.approvalGate;
  if (gate && gate.kind === APPROVAL_KIND.PHASE_START) {
    const phaseTitle = state.phases.find((p) => p.id === gate.phaseId)?.title || '';
    if (gate.phaseId === 1) return 'Skill initialized. Approve to begin Phase 1 (Site Discovery & Pre-checks).';
    return `Phase ${gate.phaseId - 1} complete. Approve to begin Phase ${gate.phaseId} (${phaseTitle}).`;
  }
  const allDone = state.phases.every((p) => p.status === PHASE_STATUS.COMPLETED);
  if (allDone) return 'All phases complete. See summary below.';
  return 'Skill running.';
}

function siteRow(label, value, knownClass = '') {
  const v = value == null || value === '' ? null : value;
  if (v == null) {
    return `      <tr><td>${escapeHtml(label)}</td><td><em style="color:#9ca3af;">(not yet captured)</em></td></tr>`;
  }
  return `      <tr><td>${escapeHtml(label)}</td><td${knownClass ? ` class="${knownClass}"` : ''}>${escapeHtmlAllowingInline(v)}</td></tr>`;
}

function renderSiteCard(state) {
  const s = state.site;
  return `  <div class="card site-card">
    <div class="card-title">Site &amp; Migration Details</div>
    <table>
${siteRow('Site name', s.name)}
${siteRow('Website Id', s.webSiteId, 'known')}
${siteRow('Portal Id', s.portalId)}
${siteRow('URL slug', s.slug)}
${siteRow('Current data model', s.currentDataModel)}
${siteRow('Template', s.template)}
${siteRow('Environment', s.environment)}
${siteRow('Migration mode', s.migrationMode)}
${siteRow('Site root', s.siteRoot)}
${siteRow('Output directory', s.outputDir, 'known')}
      <tr><td>Skill started</td><td class="known">${escapeHtml(formatTimestamp(state.skillStartedAt))}</td></tr>
    </table>
  </div>
`;
}

function phaseStatusLabel(status) {
  switch (status) {
    case PHASE_STATUS.COMPLETED:
      return { cls: 'label-done', text: 'Completed' };
    case PHASE_STATUS.IN_PROGRESS:
      return { cls: 'label-progress', text: 'In Progress' };
    case PHASE_STATUS.PENDING_APPROVAL:
      return { cls: 'label-blocked', text: 'Pending Approval' };
    case PHASE_STATUS.BLOCKED:
      return { cls: 'label-blocked', text: 'Blocked' };
    default:
      return { cls: 'label-pending', text: 'Pending' };
  }
}

function phaseIcon(status, id) {
  switch (status) {
    case PHASE_STATUS.COMPLETED:
      return { cls: 'status-done', glyph: '✓' };
    case PHASE_STATUS.IN_PROGRESS:
      return { cls: 'status-progress', glyph: '⏳' };
    case PHASE_STATUS.PENDING_APPROVAL:
      return { cls: 'status-pending', glyph: String(id) };
    case PHASE_STATUS.BLOCKED:
      return { cls: 'status-blocked', glyph: '!' };
    default:
      return { cls: 'status-pending', glyph: String(id) };
  }
}

function subStepIcon(status) {
  switch (status) {
    case SUB_STEP_STATUS.COMPLETED:
      return { cls: '', glyph: '✓' };
    case SUB_STEP_STATUS.IN_PROGRESS:
      return { cls: 'progress', glyph: '●' };
    case SUB_STEP_STATUS.BLOCKED:
      return { cls: 'blocked', glyph: '⏸' };
    default:
      return { cls: 'pending', glyph: '○' };
  }
}

function renderSubStep(sub) {
  const icon = subStepIcon(sub.status);
  const labelCls = sub.status === SUB_STEP_STATUS.PENDING ? ' pending' : '';
  const output = sub.output
    ? `\n          <div class="sub-step-output">${escapeHtmlAllowingInline(sub.output)}</div>`
    : '';
  return `      <div class="sub-step">
        <div class="sub-step-icon${icon.cls ? ' ' + icon.cls : ''}">${icon.glyph}</div>
        <div class="sub-step-text">
          <div class="sub-step-label${labelCls}">${escapeHtml(sub.id)} ${escapeHtml(sub.label)}</div>${output}
        </div>
      </div>`;
}

function renderPhaseCard(phase, { collapse }) {
  const icon = phaseIcon(phase.status, phase.id);
  const label = phaseStatusLabel(phase.status);
  const subStepsCount = phase.subSteps.length;

  const noun = subStepsCount === 1 ? 'sub-step' : 'sub-steps';
  let meta;
  if (phase.status === PHASE_STATUS.COMPLETED && phase.startedAt && phase.completedAt) {
    meta = `${subStepsCount} ${noun} · completed in ${formatElapsed(phase.startedAt, phase.completedAt)}`;
  } else if (phase.status === PHASE_STATUS.IN_PROGRESS) {
    const done = phase.subSteps.filter((s) => s.status === SUB_STEP_STATUS.COMPLETED).length;
    meta = `${done} of ${subStepsCount} ${noun} complete${phase.startedAt ? ` · started ${formatElapsed(phase.startedAt, null)} ago` : ''}`;
  } else if (phase.status === PHASE_STATUS.PENDING_APPROVAL) {
    meta = `${subStepsCount} ${noun} · awaiting your approval to start`;
  } else {
    meta = `${subStepsCount} ${noun}`;
  }

  const subStepsHtml = phase.subSteps.map(renderSubStep).join('\n');
  const subStepsBlock = collapse
    ? `      <details>
        <summary>Show ${subStepsCount} completed sub-steps</summary>
${subStepsHtml}
      </details>`
    : subStepsHtml;

  return `  <div class="phase-card">
    <div class="phase-header">
      <div class="phase-status-icon ${icon.cls}">${icon.glyph}</div>
      <div class="phase-title">
        <h3>Phase ${phase.id}: ${escapeHtml(phase.title)}</h3>
        <div class="phase-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="phase-status-label ${label.cls}">${escapeHtml(label.text)}</div>
    </div>
    <div class="sub-steps">
${subStepsBlock}
    </div>
  </div>
`;
}

// Approval-banner copy. Keyed by `<phaseId>:<kind>` or `<phaseId>:<kind>:<track>`.
// Track-aware keys take precedence; the bare key is the fallback when no track
// is set or no track-specific copy exists.
const APPROVAL_COPY = {
  '1:phase-start': {
    heading: '👀 Approve to start Phase 1: Site Discovery & Pre-checks',
    body: [
      'Phase 1 is mostly read-only context-gathering: PAC version check, auth profile, site discovery, dependency verification, migration mode selection.',
      '<strong>The one potential write</strong> is in step 1.6 — if your site\'s template needs a V2 EDM solution that isn\'t installed, the skill will ask for your explicit consent before running <code>pac application install</code>. This installs a Microsoft-published solution to your environment (not to your site source or data).',
    ],
    approve: '› Yes, start Phase 1',
    cancel: '› Cancel — stop the skill',
  },
  '2:phase-start:A': {
    heading: '👀 Approve to start Phase 2: Configuration Migration & Customization Remediation',
    body: [
      'Phase 1 captured site context, dependencies, and the chosen mode (<code>configurationData</code> or <code>all</code>).',
      'In <strong>Phase 2</strong>, the skill will: run <code>pac pages migrate-datamodel --mode &lt;mode&gt;</code> (which moves metadata into EDM tables and auto-generates a customization report), locate that report, and — if any <code>adx_*</code> customizations are flagged — download the site, run FetchXML/Liquid rewriters, generate augmented prompts (plugin + DME), and ask for your explicit approval before <code>pac pages upload</code>.',
    ],
    approve: '› Yes, proceed with Phase 2',
    cancel: '› Cancel — I want to review more first',
  },
  '2:phase-start:B': {
    heading: '👀 Approve to start Phase 2: Setting Up Metadata',
    body: [
      'Phase 1 captured site context, dependencies, and confirmed mode <code>configurationDataReferences</code> — which assumes configuration metadata is already in EDM (typically via ALM solution import).',
      'In <strong>Phase 2</strong>, the skill will: list sites in the target environment to verify yours is present, and — if metadata is missing — offer three import paths (ALM skill / Solution Import / PAC CLI). No data is migrated until you confirm metadata is ready.',
    ],
    approve: '› Yes, proceed with Phase 2',
    cancel: '› Cancel — I want to review more first',
  },
  '3:phase-start:A': {
    heading: '👀 Approve to start Phase 3: Migration & Activation',
    body: [
      'Phase 2 has finished: metadata migrated to EDM tables, customizations remediated and uploaded.',
      '<strong>Phase 3</strong> has 3 sub-steps: migrate transactional references via <code>pac pages migrate-datamodel --mode configurationDataReferences</code> (auto-skipped if you chose <code>--mode all</code> in Phase 2), activate EDM via <code>--updateDataModelVersion</code>, then prompt you to restart the site. Customization handling is already done — no re-check needed.',
    ],
    approve: '› Yes, start Phase 3',
    cancel: '› Cancel — stop before activation',
  },
  '3:phase-start:B': {
    heading: '👀 Approve to start Phase 3: Migration, Remediation & Activation',
    body: [
      'Phase 2 confirmed configuration metadata is present in the target environment.',
      '<strong>Phase 3</strong> has 5 sub-steps: migrate transactional references via <code>pac pages migrate-datamodel --mode configurationDataReferences</code> (auto-emits a customization report), locate that report, remediate any customizations that surface (with a stronger warning — Prod findings usually indicate an ALM gap), activate EDM via <code>--updateDataModelVersion</code>, then prompt you to restart the site.',
    ],
    approve: '› Yes, start Phase 3',
    cancel: '› Cancel — stop before migration',
  },
  '4:phase-start': {
    heading: '👀 Approve to start Phase 4: Post-Migration Validation',
    body: [
      'Migration execution is complete. The site is now on Enhanced Data Model.',
      '<strong>Phase 4</strong> re-downloads the site as EDM, diffs against the SDM snapshot to confirm every record migrated, suggests <code>/test-site</code> for runtime smoke testing, and offers an optional rollback if validation surfaces problems.',
    ],
    approve: '› Yes, start validation',
    cancel: '› Cancel — I\'ll validate manually',
  },
  '2:in-phase': {
    heading: '👀 Approve upload to continue Phase 2',
    body: [
      'Auto-rewriters have finished modifying FetchXML and Liquid in your site source. Before <code>pac pages upload</code> writes changes back to Dataverse, please review the diff and rewritten files.',
      'See the augmented prompts section below for plugin and DME work that must run in fresh Claude sessions before Phase 3.',
    ],
    approve: '› Approve upload',
    cancel: '› Cancel — stop before upload',
  },
};

function renderApprovalBanner(state) {
  const gate = state.approvalGate;
  if (!gate) return '';
  // Try track-specific copy first, fall back to bare key.
  const track = state.track;
  const key = track ? `${gate.phaseId}:${gate.kind}:${track}` : null;
  const fallbackKey = `${gate.phaseId}:${gate.kind}`;
  const copy = (key && APPROVAL_COPY[key]) || APPROVAL_COPY[fallbackKey] || {
    heading: gate.title || `👀 Approval required`,
    body: [gate.body || 'Respond in your Claude Code chat to continue.'],
    approve: '› Yes, proceed',
    cancel: '› Cancel',
  };
  const bodyHtml = copy.body
    .map((p) => `    <p>${escapeHtmlAllowingInline(p)}</p>`)
    .join('\n');
  return `  <div class="approval-banner">
    <h3>${escapeHtml(copy.heading)}</h3>
${bodyHtml}
    <p style="margin-top: 16px;"><strong>To approve and continue</strong>, respond in your Claude Code chat with:</p>
    <div class="action-cmd">${escapeHtml(copy.approve)}</div>
    <p style="margin-top: 12px;"><strong>To cancel</strong>:</p>
    <div class="action-cmd">${escapeHtml(copy.cancel)}</div>
    <p style="margin-top: 16px; font-size: 13px; color: #92400e;">This file (<code>skill-execution-report.html</code>) will be updated automatically as each phase progresses. Refresh this page in your browser anytime to see live status.</p>
  </div>
`;
}

function renderPromptCard(kind, prompt) {
  const titleMap = {
    plugin: { icon: '🔌', label: 'Plugin Remediation Prompt' },
    dme: { icon: '🗂️', label: 'Data Model Extension Remediation Prompt' },
  };
  const t = titleMap[kind];
  if (!prompt) {
    const pendingDesc =
      kind === 'plugin'
        ? 'Not yet generated. Will appear after step 2.1 (Generate Customization Report) if any custom plugins are detected on adx_* entities.'
        : 'Not yet generated. Will appear after step 2.1 if any custom columns are detected on adx_* tables.';
    return `    <div class="prompt-card pending">
      <h4>${t.icon} ${escapeHtml(t.label)}</h4>
      <div class="prompt-state">${escapeHtml(pendingDesc)}</div>
    </div>`;
  }
  if (prompt.status !== PROMPT_STATUS.READY) {
    return `    <div class="prompt-card pending">
      <h4>${t.icon} ${escapeHtml(t.label)}</h4>
      <div class="prompt-state">${escapeHtmlAllowingInline(prompt.summary || 'Pending.')}</div>
    </div>`;
  }
  const link = prompt.path
    ? `<div class="links"><a href="${escapeHtml(prompt.path)}">📄 ${escapeHtml(prompt.path.replace(/^.*[\\/]/, ''))}</a></div>`
    : '';
  return `    <div class="prompt-card ready">
      <h4>${t.icon} ${escapeHtml(t.label)}</h4>
      <p>${escapeHtmlAllowingInline(prompt.summary || '')}</p>
      ${link}
    </div>`;
}

function renderPromptsSection(state) {
  const p = state.augmentedPrompts || {};
  const anyReady =
    (p.plugin && p.plugin.status === PROMPT_STATUS.READY) ||
    (p.dme && p.dme.status === PROMPT_STATUS.READY);
  const blurb = anyReady
    ? 'Generated by step 2.1. The skill does not modify customer-owned plugin source or Dataverse schema directly — paste these prompts into fresh Claude Code sessions to drive that work.'
    : 'The skill does not modify customer-owned plugin source or Dataverse schema directly. Instead, after step 2.1 has scanned your site for customizations, paste-ready prompts will appear here for you to take to fresh Claude Code sessions.';
  return `  <div class="card prompts-section">
    <h2>Augmented Prompts for Customer-Owned Code</h2>
    <p>${escapeHtml(blurb)}</p>
${renderPromptCard('plugin', p.plugin)}
${renderPromptCard('dme', p.dme)}
  </div>
`;
}

const CSS = `:root {
    --bg:#faf9f8; --surface:#ffffff; --surface2:#f3f2f1; --surface3:#edebe9;
    --border:#e1dfdd; --border-light:#c8c6c4;
    --text:#323130; --text-dim:#605e5c; --text-bright:#201f1e;
    --accent:#0078d4; --accent-bg:#0078d40a; --accent-border:#0078d425;
    --critical:#d13438; --critical-bg:#d134380a; --critical-border:#d1343825;
    --warning:#ca5010; --warning-bg:#ca50100a; --warning-border:#ca501025;
    --pass:#107c10; --pass-bg:#107c100a; --pass-border:#107c1025;
    --info:#0078d4; --info-bg:#0078d40a; --info-border:#0078d425;
    --purple:#8764b8; --purple-bg:#8764b80a; --purple-border:#8764b825;
    --mono:'Cascadia Code','Consolas',monospace;
    --sans:'Segoe UI','Segoe UI Web (West European)',-apple-system,system-ui,sans-serif;
    --radius:8px; --radius-sm:4px;
    --shadow-4:0 1.6px 3.6px 0 rgba(0,0,0,0.132),0 0.3px 0.9px 0 rgba(0,0,0,0.108);
    --shadow-8:0 3.2px 7.2px 0 rgba(0,0,0,0.132),0 0.6px 1.8px 0 rgba(0,0,0,0.108);
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body { font-family:var(--sans); background:var(--bg); color:var(--text); font-size:14px; line-height:1.6; }

  /* Topbar — white surface, small shadow, dark text (Fluent) */
  .topbar { background:var(--surface); box-shadow:var(--shadow-4); padding:14px 28px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; position:sticky; top:0; z-index:100; }
  .topbar-left { display:flex; align-items:center; gap:14px; }
  .topbar-title { font-size:16px; font-weight:700; color:var(--text-bright); }
  .topbar-sub { font-size:11px; color:var(--text-dim); margin-top:1px; }
  .topbar-right { display:flex; align-items:center; gap:14px; font-size:12px; color:var(--text-dim); }
  .topbar-right strong { color:var(--text-bright); font-family:var(--mono); }

  /* Page header — title + status */
  .page-header { background:var(--surface); border-bottom:1px solid var(--border); padding:24px 40px 20px; }
  .page-header h1 { font-size:24px; font-weight:800; color:var(--text-bright); letter-spacing:-0.3px; margin-bottom:6px; }
  .page-header .subtitle { font-size:13px; color:var(--text-dim); }

  /* Status badge — top-right of page header */
  .status-pill { display:inline-block; font-size:11px; font-weight:700; padding:3px 10px; border-radius:3px; font-family:var(--mono); text-transform:uppercase; letter-spacing:0.5px; vertical-align:middle; margin-left:8px; }
  .status-pill.in-progress { color:var(--info); background:var(--info-bg); border:1px solid var(--info-border); }
  .status-pill.pending { color:var(--warning); background:var(--warning-bg); border:1px solid var(--warning-border); }
  .status-pill.done { color:var(--pass); background:var(--pass-bg); border:1px solid var(--pass-border); }

  /* Stats grid */
  .stats-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-top:18px; }
  .stat-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px; text-align:center; box-shadow:var(--shadow-4); position:relative; overflow:hidden; }
  .stat-card::after { content:''; position:absolute; top:0; left:50%; transform:translateX(-50%); width:40px; height:2px; background:var(--accent); border-radius:0 0 2px 2px; }
  .stat-num { font-size:22px; font-weight:800; font-family:var(--mono); line-height:1; color:var(--text-bright); }
  .stat-label { font-size:10px; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px; margin-top:6px; }

  /* Progress bar (in header) */
  .progress-bar { background:var(--surface2); height:6px; border-radius:3px; margin:14px 0 0; overflow:hidden; }
  .progress-bar-fill { background:var(--accent); height:100%; transition:width 0.3s; }

  /* Main container */
  .content { padding:24px 40px 40px; max-width:1100px; }

  /* Cards (generic) */
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:18px 20px; margin-bottom:16px; box-shadow:var(--shadow-4); }
  .card-title { font-size:15px; font-weight:700; color:var(--text-bright); margin-bottom:12px; display:flex; align-items:center; gap:8px; }

  /* Site card (key/value table) */
  .site-card table { width:100%; border-collapse:collapse; font-size:13px; }
  .site-card td { padding:7px 0; border-bottom:1px solid var(--surface2); }
  .site-card tr:last-child td { border-bottom:none; }
  .site-card td:first-child { color:var(--text-dim); width:180px; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:0.3px; }
  .site-card td:last-child { color:var(--text-bright); font-family:var(--mono); font-size:12.5px; }
  .site-card td:last-child em { color:var(--text-dim); font-style:italic; font-family:var(--sans); font-size:12.5px; }

  /* Phase cards */
  .phase-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); margin-bottom:12px; overflow:hidden; box-shadow:var(--shadow-4); transition:box-shadow 0.2s; }
  .phase-card:hover { box-shadow:var(--shadow-8); }
  .phase-header { padding:16px 22px; display:flex; align-items:center; gap:14px; }
  .phase-status-icon { width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700; flex-shrink:0; font-family:var(--mono); }
  .status-done { background:var(--pass-bg); color:var(--pass); border:1px solid var(--pass-border); }
  .status-progress { background:var(--info-bg); color:var(--info); border:1px solid var(--info-border); animation:pulse 2s infinite; }
  .status-pending { background:var(--surface2); color:var(--text-dim); border:1px solid var(--border); }
  .status-blocked { background:var(--warning-bg); color:var(--warning); border:1px solid var(--warning-border); }
  @keyframes pulse { 0%, 100% { opacity:1; } 50% { opacity:0.55; } }
  .phase-title { flex:1; }
  .phase-title h3 { margin:0; font-size:14px; font-weight:700; color:var(--text-bright); }
  .phase-title .phase-meta { font-size:12px; color:var(--text-dim); margin-top:2px; }
  .phase-status-label { font-size:10px; font-weight:700; padding:3px 8px; border-radius:3px; font-family:var(--mono); text-transform:uppercase; letter-spacing:0.5px; }
  .label-done { color:var(--pass); background:var(--pass-bg); border:1px solid var(--pass-border); }
  .label-progress { color:var(--info); background:var(--info-bg); border:1px solid var(--info-border); }
  .label-pending { color:var(--text-dim); background:var(--surface2); border:1px solid var(--border); }
  .label-blocked { color:var(--warning); background:var(--warning-bg); border:1px solid var(--warning-border); }
  .sub-steps { padding:4px 22px 14px 66px; font-size:13px; border-top:1px solid var(--surface2); }
  .sub-step { padding:8px 0; display:flex; align-items:flex-start; gap:10px; border-bottom:1px dashed var(--surface2); }
  .sub-step:last-child { border-bottom:none; }
  .sub-step-icon { color:var(--pass); font-size:13px; font-weight:700; min-width:14px; font-family:var(--mono); }
  .sub-step-icon.pending { color:var(--text-dim); }
  .sub-step-icon.progress { color:var(--info); animation:pulse 2s infinite; }
  .sub-step-icon.blocked { color:var(--warning); }
  .sub-step-text { flex:1; }
  .sub-step-label { color:var(--text-bright); font-weight:600; }
  .sub-step-label.pending { color:var(--text-dim); font-weight:500; }
  .sub-step-output { color:var(--text); font-size:12.5px; margin-top:3px; font-family:var(--mono); background:var(--surface2); padding:6px 10px; border-radius:var(--radius-sm); border-left:2px solid var(--accent); }

  /* Approval banner */
  .approval-banner { background:var(--warning-bg); border:1px solid var(--warning-border); border-left:4px solid var(--warning); border-radius:var(--radius); padding:20px 24px; margin-top:20px; box-shadow:var(--shadow-4); }
  .approval-banner h3 { margin:0 0 10px; color:var(--warning); font-size:15px; font-weight:700; }
  .approval-banner p { margin:8px 0; color:var(--text); font-size:13px; line-height:1.65; }
  .approval-banner .action-cmd { background:var(--text-bright); color:#f9f8f7; padding:10px 14px; border-radius:var(--radius-sm); font-family:var(--mono); font-size:12.5px; margin-top:10px; }

  /* Augmented prompts section */
  .prompts-section h2 { font-size:15px; font-weight:700; color:var(--text-bright); margin-bottom:10px; }
  .prompts-section > p { font-size:13px; color:var(--text-dim); margin-bottom:14px; }
  .prompt-card { padding:14px 16px; background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius); margin-top:10px; border-left:3px solid var(--border-light); }
  .prompt-card.pending { opacity:0.7; }
  .prompt-card.ready { border-left-color:var(--accent); background:var(--accent-bg); }
  .prompt-card h4 { margin:0 0 5px; font-size:13px; font-weight:700; color:var(--text-bright); }
  .prompt-card p { margin:5px 0; font-size:12.5px; color:var(--text); }
  .prompt-card .prompt-state { font-size:12px; color:var(--text-dim); }
  .prompt-card .links { margin-top:6px; font-size:12px; font-family:var(--mono); }
  .prompt-card .links a { color:var(--accent); text-decoration:underline; display:block; padding:2px 0; }

  /* Footer */
  .footer-note { color:var(--text-dim); font-size:12px; text-align:center; margin-top:28px; padding:18px; border-top:1px solid var(--border); }

  /* Collapsible details (completed phase sub-steps) */
  details > summary { cursor:pointer; color:var(--accent); font-size:12px; padding:4px 0; font-weight:600; }
  details[open] > summary { margin-bottom:6px; }`;

/**
 * Render the full HTML report from a migration-state.json object.
 */
function renderLiveReport(state) {
  const pct = overallPercent(state);
  const completed = countCompleted(state);
  const elapsed = formatElapsed(state.skillStartedAt, state.lastUpdatedAt);
  const clock = formatClock(state.lastUpdatedAt);
  const pill = statusPillFor(state);
  const subtitle = subtitleFor(state);

  // Collapse a completed phase's sub-steps if any later phase is already in-progress
  // or completed — keeps the focus on what's happening now without losing history.
  const hasLaterActive = (idx) =>
    state.phases.slice(idx + 1).some(
      (p) => p.status === PHASE_STATUS.IN_PROGRESS || p.status === PHASE_STATUS.COMPLETED,
    );
  const phaseCards = state.phases
    .map((p, i) =>
      renderPhaseCard(p, {
        collapse: p.status === PHASE_STATUS.COMPLETED && hasLaterActive(i),
      }),
    )
    .join('\n');

  // Classify the status pill into a Fluent severity color (in-progress/pending/done)
  const pillClass = pillSeverityClass(state);
  const total = totalSubSteps(state);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>SDM→EDM Migration — ${escapeHtml(pill)}</title>
<style>
${CSS}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-left">
    <div>
      <div class="topbar-title">SDM → EDM Migration</div>
      <div class="topbar-sub">Power Pages site data-model migration</div>
    </div>
  </div>
  <div class="topbar-right">
    <span>Track <strong>${escapeHtml(state.track || 'A')}</strong></span>
    <span>Last updated <strong>${escapeHtml(clock)}</strong></span>
  </div>
</div>

<div class="page-header">
  <h1>Execution Report <span class="status-pill ${pillClass}">${escapeHtml(pill)}</span></h1>
  <div class="subtitle">${escapeHtml(subtitle)}</div>
  <div class="progress-bar"><div class="progress-bar-fill" style="width: ${pct}%;"></div></div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-num">${pct}%</div><div class="stat-label">Overall</div></div>
    <div class="stat-card"><div class="stat-num">${completed} / ${total}</div><div class="stat-label">Sub-steps</div></div>
    <div class="stat-card"><div class="stat-num">${escapeHtml(elapsed)}</div><div class="stat-label">Elapsed</div></div>
    <div class="stat-card"><div class="stat-num">${state.phases.filter((p) => p.status === PHASE_STATUS.COMPLETED).length} / ${state.phases.length}</div><div class="stat-label">Phases done</div></div>
  </div>
</div>

<div class="content">

${renderSiteCard(state)}
${phaseCards}
${renderApprovalBanner(state)}
${renderPromptsSection(state)}
  <div class="footer-note">
    Generated by <strong>migrate-sdm-to-edm</strong> skill · Last updated ${escapeHtml(formatTimestamp(state.lastUpdatedAt))} · Refresh this page in your browser as the migration progresses
  </div>

</div>
</body>
</html>
`;
}

function pillSeverityClass(state) {
  const inProgress = state.phases.find((p) => p.status === PHASE_STATUS.IN_PROGRESS);
  if (inProgress) return 'in-progress';
  const allDone = state.phases.every((p) => p.status === PHASE_STATUS.COMPLETED);
  if (allDone) return 'done';
  return 'pending';
}

module.exports = {
  renderLiveReport,
  // exposed for unit-test reuse
  _internals: {
    escapeHtml,
    escapeHtmlAllowingInline,
    countCompleted,
    overallPercent,
    formatElapsed,
  },
};
