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
  return `  <div class="site-card">
    <h2>Site &amp; Migration Details</h2>
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
    heading: '👀 Approve to start Phase 3: Activation',
    body: [
      'Phase 2 has finished: metadata migrated, customization findings handled, source synced back to Dataverse.',
      '<strong>Phase 3</strong> activates EDM: it runs <code>--updateDataModelVersion</code> to flip the site\'s data model to Enhanced, then prompts you to restart the site manually in Power Platform admin center. The site goes live on EDM after restart.',
    ],
    approve: '› Yes, start activation',
    cancel: '› Cancel — stop before activation',
  },
  '3:phase-start:B': {
    heading: '👀 Approve to start Phase 3: Runtime Data Migration & Activation',
    body: [
      'Phase 2 confirmed configuration metadata is present in the target environment.',
      '<strong>Phase 3</strong> runs <code>pac pages migrate-datamodel --mode configurationDataReferences</code> to move transactional references, locates the auto-generated customization report, remediates customizations if any appear (with a stronger warning — Prod findings usually indicate an ALM gap), activates EDM via <code>--updateDataModelVersion</code>, and prompts you to restart the site.',
    ],
    approve: '› Yes, start the migration',
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
  return `  <div class="prompts-section">
    <h2>📋 Augmented Prompts for Customer-Owned Code</h2>
    <p style="font-size: 14px; color: #6b7280; margin: 0 0 16px 0;">
      ${escapeHtml(blurb)}
    </p>
${renderPromptCard('plugin', p.plugin)}
${renderPromptCard('dme', p.dme)}
  </div>
`;
}

const CSS = `body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #f5f7fa; color: #1f2937; line-height: 1.5; }
  .header { background: linear-gradient(135deg, #60a5fa 0%, #2563eb 100%); color: white; padding: 32px 48px; }
  .header h1 { margin: 0 0 8px 0; font-size: 28px; font-weight: 600; }
  .header .status-pill { display: inline-block; background: rgba(255,255,255,0.25); padding: 4px 14px; border-radius: 12px; font-size: 13px; font-weight: 500; margin-bottom: 12px; }
  .header .subtitle { font-size: 15px; opacity: 0.95; }
  .container { max-width: 1100px; margin: 0 auto; padding: 32px 48px; }
  .site-card { background: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 24px; }
  .site-card h2 { margin: 0 0 16px 0; font-size: 18px; color: #111827; }
  .site-card table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .site-card td { padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
  .site-card td:first-child { color: #6b7280; width: 200px; font-weight: 500; }
  .site-card td:last-child { color: #111827; font-family: 'Cascadia Code', Consolas, monospace; font-size: 13px; }
  .site-card td:last-child em { color: #9ca3af; font-style: italic; font-family: inherit; }
  .phase-card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 16px; overflow: hidden; }
  .phase-header { padding: 18px 24px; display: flex; align-items: center; gap: 16px; border-bottom: 1px solid #f3f4f6; }
  .phase-status-icon { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 600; flex-shrink: 0; }
  .status-done { background: #d1fae5; color: #065f46; }
  .status-progress { background: #dbeafe; color: #1e40af; animation: pulse 2s infinite; }
  .status-pending { background: #f3f4f6; color: #9ca3af; }
  .status-blocked { background: #fef3c7; color: #92400e; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
  .phase-title { flex: 1; }
  .phase-title h3 { margin: 0; font-size: 16px; color: #111827; }
  .phase-title .phase-meta { font-size: 13px; color: #6b7280; margin-top: 2px; }
  .phase-status-label { padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 500; }
  .label-done { background: #d1fae5; color: #065f46; }
  .label-progress { background: #dbeafe; color: #1e40af; }
  .label-pending { background: #f3f4f6; color: #6b7280; }
  .label-blocked { background: #fef3c7; color: #92400e; }
  .sub-steps { padding: 8px 24px 16px 72px; font-size: 14px; }
  .sub-step { padding: 8px 0; display: flex; align-items: flex-start; gap: 10px; border-bottom: 1px dashed #f3f4f6; }
  .sub-step:last-child { border-bottom: none; }
  .sub-step-icon { color: #10b981; font-size: 14px; font-weight: 600; min-width: 14px; }
  .sub-step-icon.pending { color: #9ca3af; }
  .sub-step-icon.progress { color: #2563eb; animation: pulse 2s infinite; }
  .sub-step-icon.blocked { color: #d97706; }
  .sub-step-text { flex: 1; }
  .sub-step-label { color: #111827; font-weight: 500; }
  .sub-step-label.pending { color: #6b7280; }
  .sub-step-output { color: #4b5563; font-size: 13px; margin-top: 2px; font-family: 'Cascadia Code', Consolas, monospace; }
  .approval-banner { background: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 24px; margin-top: 24px; }
  .approval-banner h3 { margin: 0 0 12px 0; color: #92400e; font-size: 18px; }
  .approval-banner p { margin: 8px 0; color: #78350f; }
  .approval-banner .action-cmd { background: #1f2937; color: #f9fafb; padding: 12px 16px; border-radius: 6px; font-family: 'Cascadia Code', Consolas, monospace; font-size: 13px; margin-top: 12px; }
  .prompts-section { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-top: 24px; padding: 24px; }
  .prompts-section h2 { margin: 0 0 16px 0; font-size: 18px; color: #111827; }
  .prompt-card { padding: 16px; background: #f9fafb; border-radius: 6px; margin-top: 12px; border-left: 4px solid #d1d5db; }
  .prompt-card.pending { opacity: 0.7; }
  .prompt-card.ready { border-left-color: #2563eb; }
  .prompt-card h4 { margin: 0 0 6px 0; font-size: 15px; color: #111827; }
  .prompt-card p { margin: 6px 0; font-size: 14px; color: #374151; }
  .prompt-card .prompt-state { font-size: 13px; color: #6b7280; }
  .prompt-card .links { margin-top: 8px; font-size: 13px; font-family: 'Cascadia Code', Consolas, monospace; }
  .prompt-card .links a { color: #2563eb; text-decoration: underline; display: block; padding: 2px 0; }
  .footer-note { color: #6b7280; font-size: 13px; text-align: center; margin-top: 32px; padding: 16px; border-top: 1px solid #e5e7eb; }
  .progress-bar { background: rgba(255,255,255,0.2); height: 8px; border-radius: 4px; margin: 16px 0; overflow: hidden; }
  .progress-bar-fill { background: white; height: 100%; transition: width 0.3s; }
  .summary-mini { display: flex; gap: 24px; margin: 16px 0 0 0; font-size: 13px; }
  .summary-mini .stat { color: rgba(255,255,255,0.85); }
  .summary-mini .stat strong { color: white; font-size: 15px; font-weight: 600; }
  details > summary { cursor: pointer; color: #2563eb; font-size: 13px; padding: 4px 0; }
  details[open] > summary { margin-bottom: 8px; }`;

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>SDM→EDM Migration — ${escapeHtml(pill)}</title>
<style>
${CSS}
</style>
</head>
<body>

<div class="header">
  <div class="status-pill">${escapeHtml(pill)}</div>
  <h1>SDM → EDM Migration</h1>
  <div class="subtitle">${escapeHtml(subtitle)}</div>
  <div class="progress-bar"><div class="progress-bar-fill" style="width: ${pct}%;"></div></div>
  <div class="summary-mini">
    <span class="stat">Overall: <strong>${pct}%</strong></span>
    <span class="stat">Sub-steps complete: <strong>${completed} of ${totalSubSteps(state)}</strong></span>
    <span class="stat">Elapsed: <strong>${escapeHtml(elapsed)}</strong></span>
    <span class="stat">Last updated: <strong>${escapeHtml(clock)}</strong></span>
  </div>
</div>

<div class="container">

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
