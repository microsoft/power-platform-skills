/**
 * render-live-report.js
 *
 * Pure render function: migration-state.json (+ optional snapshots) -> HTML string.
 *
 * The output is a sidebar+sections layout modelled on create-site/assets/create-site-plan.html,
 * with five sections reachable from the sidebar:
 *
 *   - Overview          summary, site card, confidence stat, current status
 *   - Plan              env type + chosen mode + 4-phase flow + approval gates
 *   - SDM Components    counts and sample records from sdm-snapshot.json
 *   - EDM Components    same shape as SDM, with side-by-side tally
 *   - Migration & Review per-phase sub-step list, approvals, augmented prompts
 *
 * Callers can pass `sdmSnapshot` and `edmSnapshot` (parsed JSON objects) — if absent,
 * those sections render empty states.
 */

const {
  PHASE_STATUS,
  SUB_STEP_STATUS,
  APPROVAL_KIND,
  PROMPT_STATUS,
} = require('./migration-state-schema');

// ── HTML escaping ──────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAllowingInline(s) {
  if (s == null) return '';
  const escaped = escapeHtml(s);
  return escaped
    .replace(/&lt;(\/?(?:code|strong|em|br))&gt;/g, '<$1>')
    .replace(/&lt;br\s*\/&gt;/g, '<br/>');
}

// ── Formatting helpers ─────────────────────────────────────────────────────

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

function totalSubSteps(state) {
  return state.phases.reduce((n, p) => n + p.subSteps.length, 0);
}

function overallPercent(state) {
  const total = totalSubSteps(state);
  if (total === 0) return 0;
  return Math.round((countCompleted(state) / total) * 100);
}

function statusPillFor(state) {
  const inProgress = state.phases.find((p) => p.status === PHASE_STATUS.IN_PROGRESS);
  if (inProgress) return `In Progress · Phase ${inProgress.id} of ${state.phases.length}`;
  const gate = state.approvalGate;
  if (gate && gate.kind === APPROVAL_KIND.PHASE_START) {
    return `Awaiting Approval — Phase ${gate.phaseId}`;
  }
  const allDone = state.phases.every((p) => p.status === PHASE_STATUS.COMPLETED);
  if (allDone) return 'Migration Complete';
  return 'Awaiting Approval — Phase 1';
}

function pillSeverityClass(state) {
  const inProgress = state.phases.find((p) => p.status === PHASE_STATUS.IN_PROGRESS);
  if (inProgress) return 'in-progress';
  const allDone = state.phases.every((p) => p.status === PHASE_STATUS.COMPLETED);
  if (allDone) return 'done';
  return 'pending';
}

// ── Approval-banner copy (track-aware) ─────────────────────────────────────

const APPROVAL_COPY = {
  '1:phase-start': {
    heading: 'Approve to start Phase 1: Site Discovery & Pre-checks',
    body: [
      'Phase 1 is mostly read-only context-gathering: PAC version check, auth profile, site discovery, dependency verification, migration mode selection.',
      '<strong>The one potential write</strong> is in step 1.6 — if your site\'s template needs a V2 EDM solution that isn\'t installed, the skill will ask for your explicit consent before running <code>pac application install</code>.',
    ],
    approve: '› Yes, start Phase 1',
    cancel: '› Cancel — stop the skill',
  },
  '2:phase-start:A': {
    heading: 'Approve to start Phase 2: Configuration Migration & Customization Remediation',
    body: [
      'Phase 1 captured site context, dependencies, and the chosen mode (<code>configurationData</code> or <code>all</code>).',
      'In <strong>Phase 2</strong>, the skill will run <code>pac pages migrate-datamodel</code> to move metadata into EDM tables, locate the auto-emitted customization report, and — if any <code>adx_*</code> customizations are flagged — download the site, run FetchXML/Liquid rewriters, generate augmented prompts, and ask for your explicit approval before <code>pac pages upload</code>.',
    ],
    approve: '› Yes, proceed with Phase 2',
    cancel: '› Cancel — I want to review more first',
  },
  '2:phase-start:B': {
    heading: 'Approve to start Phase 2: Setting Up Metadata',
    body: [
      'Phase 1 captured site context and confirmed mode <code>configurationDataReferences</code> — which assumes configuration metadata is already in EDM (typically via ALM solution import).',
      'In <strong>Phase 2</strong>, the skill will list sites in the target environment to verify yours is present, and — if metadata is missing — offer three import paths (ALM skill / Solution Import / PAC CLI). No data is migrated until you confirm metadata is ready.',
    ],
    approve: '› Yes, proceed with Phase 2',
    cancel: '› Cancel — I want to review more first',
  },
  '3:phase-start:A': {
    heading: 'Approve to start Phase 3: Migration Execution',
    body: [
      'Phase 2 has finished: metadata migrated to EDM tables, customizations remediated and uploaded.',
      '<strong>Phase 3</strong> migrates transactional references via <code>pac pages migrate-datamodel --mode configurationDataReferences</code> (auto-skipped if you chose <code>--mode all</code> in Phase 2), then activates EDM via <code>--updateDataModelVersion</code>, then prompts you to restart the site.',
    ],
    approve: '› Yes, start migration execution',
    cancel: '› Cancel — stop before migration',
  },
  '3:phase-start:B': {
    heading: 'Approve to start Phase 3: Migration Execution',
    body: [
      'Phase 2 confirmed configuration metadata is present in the target environment.',
      '<strong>Phase 3</strong> migrates transactional references, locates the auto-generated customization report, remediates any customizations that surface (stronger warning — Prod findings usually indicate an ALM gap), activates EDM, then prompts you to restart the site.',
    ],
    approve: '› Yes, start migration execution',
    cancel: '› Cancel — stop before migration',
  },
  '4:phase-start': {
    heading: 'Approve to start Phase 4: Post-Migration Validation',
    body: [
      'Migration execution is complete. The site is now on Enhanced Data Model.',
      '<strong>Phase 4</strong> re-downloads the site as EDM, diffs against the SDM snapshot to confirm every record migrated, recommends <code>/test-site</code> for runtime smoke testing, and offers an optional rollback if validation surfaces problems.',
    ],
    approve: '› Yes, start validation',
    cancel: '› Cancel — I\'ll validate manually',
  },
  '2:in-phase': {
    heading: 'Approve upload to continue Phase 2',
    body: [
      'Auto-rewriters have finished modifying FetchXML and Liquid in your site source. Before <code>pac pages upload</code> writes changes back to Dataverse, please review the diff and rewritten files.',
      'See the augmented prompts in the Migration & Review section for plugin and DME work that must run in fresh Claude sessions before Phase 3.',
    ],
    approve: '› Approve upload',
    cancel: '› Cancel — stop before upload',
  },
};

// ── Per-section renderers ──────────────────────────────────────────────────

function renderSiteRow(label, value, isKnown = false) {
  const isPlaceholder = value == null || value === '';
  const displayValue = isPlaceholder
    ? `<em>(not yet captured)</em>`
    : escapeHtmlAllowingInline(value);
  const cls = isPlaceholder ? '' : (isKnown ? ' class="known"' : '');
  return `      <tr><td>${escapeHtml(label)}</td><td${cls}>${displayValue}</td></tr>`;
}

function renderSiteCard(state) {
  const s = state.site;
  return `<div class="card site-card">
  <div class="card-title">Site &amp; Migration Details</div>
  <table>
${renderSiteRow('Site name', s.name)}
${renderSiteRow('Website Id', s.webSiteId, true)}
${renderSiteRow('Portal Id', s.portalId)}
${renderSiteRow('URL slug', s.slug)}
${renderSiteRow('Current data model', s.currentDataModel)}
${renderSiteRow('Template', s.template)}
${renderSiteRow('Environment', s.environment)}
${renderSiteRow('Migration mode', s.migrationMode)}
${renderSiteRow('Site root', s.siteRoot)}
${renderSiteRow('Output directory', s.outputDir, true)}
    <tr><td>Skill started</td><td class="known">${escapeHtml(formatTimestamp(state.skillStartedAt))}</td></tr>
  </table>
</div>`;
}

function renderConfidenceStat(sdmSnapshot, edmSnapshot) {
  if (!sdmSnapshot) {
    return `<div class="card confidence-card empty">
  <div class="card-title">Migration totals</div>
  <div class="empty-note">This card appears once the SDM snapshot is captured during configuration setup (after <code>pac pages download --modelVersion 1</code>). After Phase 4.1 runs, it shows <code>SDM total → EDM total</code> with a check mark when every record migrated. Per-category breakdown lives in the Pages &amp; Components tab.</div>
</div>`;
  }

  const sdmTotal = Object.values(sdmSnapshot.counts || {}).reduce((a, b) => a + b, 0);

  if (!edmSnapshot) {
    return `<div class="card confidence-card waiting">
  <div class="card-title">Migration totals</div>
  <div class="confidence-numbers">
    <div class="confidence-num">${sdmTotal}</div>
    <div class="confidence-arrow">→</div>
    <div class="confidence-num pending">?</div>
  </div>
  <div class="confidence-label">SDM components captured. EDM count appears after Phase 4.1. For the per-category view, open the Pages &amp; Components tab.</div>
</div>`;
  }

  const edmTotal = Object.values(edmSnapshot.counts || {}).reduce((a, b) => a + b, 0);
  const diff = sdmTotal - edmTotal;
  const isMatch = diff === 0;
  const statusIcon = isMatch ? '✓' : '⚠';
  const statusClass = isMatch ? 'match' : 'mismatch';
  return `<div class="card confidence-card ${statusClass}">
  <div class="card-title">Migration totals</div>
  <div class="confidence-numbers">
    <div class="confidence-num">${sdmTotal}</div>
    <div class="confidence-arrow">→</div>
    <div class="confidence-num">${edmTotal}</div>
    <div class="confidence-icon">${statusIcon}</div>
  </div>
  <div class="confidence-label">${
    isMatch
      ? 'All ' + sdmTotal + ' components migrated from SDM to EDM. Open Pages &amp; Components for the per-category breakdown.'
      : Math.abs(diff) + ' component difference — open Pages &amp; Components for the per-category breakdown.'
  }</div>
</div>`;
}

function renderOverviewSection(state, snapshots) {
  const pct = overallPercent(state);
  const completed = countCompleted(state);
  const total = totalSubSteps(state);
  const phasesDone = state.phases.filter((p) => p.status === PHASE_STATUS.COMPLETED).length;
  const elapsed = formatElapsed(state.skillStartedAt, state.lastUpdatedAt);

  return `<div class="section active" id="tab-overview">
  <h2>Overview</h2>
  <p class="section-desc">SDM → EDM migration for <code>${escapeHtml(state.site.name || state.site.webSiteId)}</code>. Open this report alongside the skill to track progress as each sub-step completes.</p>

  <div class="summary-box">
    This skill migrates a Power Pages site from the <strong>Standard Data Model (SDM)</strong> to the <strong>Enhanced Data Model (EDM)</strong>. It runs in four phases (Pre-checks → Configuration Setup → Migration Execution → Post-Migration Validation), captures a verifiable record of every SDM and EDM component for an end-of-run data diff, and produces augmented prompts for plugin and Data Model Extension remediation that the user takes to fresh Claude sessions.
  </div>

  <div class="stats-grid">
    <div class="stat-card"><div class="stat-num">${pct}%</div><div class="stat-label">Overall</div></div>
    <div class="stat-card"><div class="stat-num">${completed} / ${total}</div><div class="stat-label">Sub-steps</div></div>
    <div class="stat-card"><div class="stat-num">${escapeHtml(elapsed)}</div><div class="stat-label">Elapsed</div></div>
    <div class="stat-card"><div class="stat-num">${phasesDone} / ${state.phases.length}</div><div class="stat-label">Phases done</div></div>
  </div>

${renderSiteCard(state)}

${renderConfidenceStat(snapshots.sdmSnapshot, snapshots.edmSnapshot)}

${renderApprovalBanner(state)}
</div>`;
}

function renderPlanSection(state) {
  const track = state.track;
  const mode = state.site.migrationMode;
  const env = state.site.environment;

  let approachDescription;
  if (!track || !mode) {
    approachDescription = `<em>Will be determined in step 1.7 once env type and migration mode are confirmed.</em>`;
  } else if (track === 'A') {
    approachDescription = `<strong>Local-migration approach.</strong> Used for Dev / Test/UAT / Single environments. The skill runs <code>pac pages migrate-datamodel --mode ${escapeHtml(mode)}</code> locally to move metadata into EDM tables, then handles customization remediation in Phase 2 itself. Phase 3 migrates transactional references and activates EDM.`;
  } else {
    approachDescription = `<strong>ALM-aware approach.</strong> Used for Prod (configuration metadata is assumed to be pre-imported via solution). Phase 2 verifies metadata is present without re-migrating it. Phase 3 runs the transactional reference migration with <code>--mode configurationDataReferences</code>, handles any customization findings (which would indicate an ALM gap), then activates EDM.`;
  }

  const phaseRows = state.phases.map((p) => {
    const labelClass = p.status === PHASE_STATUS.COMPLETED ? 'completed' : (p.status === PHASE_STATUS.IN_PROGRESS ? 'in-progress' : 'pending');
    return `      <div class="plan-phase-row">
        <div class="plan-phase-num">Phase ${p.id}</div>
        <div class="plan-phase-body">
          <div class="plan-phase-title">${escapeHtml(p.title)}</div>
          <div class="plan-phase-meta">${p.subSteps.length} sub-step${p.subSteps.length === 1 ? '' : 's'}</div>
        </div>
        <div class="plan-phase-status ${labelClass}">${escapeHtml(p.status)}</div>
      </div>`;
  }).join('\n');

  const approvalGates = [
    'Before Phase 1 (skill startup — light read-only checks)',
    'Before Phase 2 (after env type + migration mode are confirmed in step 1.7)',
    'In-phase Phase 2 (review FetchXML/Liquid rewrites before pac pages upload)',
    'Before Phase 3 (after Phase 2 readiness gate)',
    'Before Phase 4 (after site is live on EDM)',
    'Phase 4 internal gates (diff decision, runtime check status, final validation status, optional rollback)',
  ];

  return `<div class="section" id="tab-plan">
  <h2>Plan</h2>
  <p class="section-desc">Migration approach, sub-step shape, and approval gates derived from your env type and migration mode.</p>

  <h3>Migration approach</h3>
  <div class="summary-box">${approachDescription}</div>

  <div class="kv-grid">
    <div class="kv-item"><div class="kv-label">Environment type</div><div class="kv-value">${escapeHtml(env || '(set in step 1.7)')}</div></div>
    <div class="kv-item"><div class="kv-label">Migration mode</div><div class="kv-value">${escapeHtml(mode || '(set in step 1.7)')}</div></div>
    <div class="kv-item"><div class="kv-label">Total sub-steps</div><div class="kv-value">${totalSubSteps(state)}</div></div>
  </div>

  <h3>Phase flow</h3>
  <div class="plan-phase-list">
${phaseRows}
  </div>

  <h3>Approval gates</h3>
  <ul class="bullet-list">
${approvalGates.map((g) => `    <li>${escapeHtml(g)}</li>`).join('\n')}
  </ul>

  <h3>Expected outcomes</h3>
  <ul class="bullet-list">
    <li>Site flipped to EDM in Dataverse, with the SDM record deactivated</li>
    <li>Customization remediation diff and augmented prompts produced (if findings)</li>
    <li>SDM and EDM snapshots captured for verifiable post-migration data diff</li>
    <li>Optional rollback path available via Portal Id + <code>--revertToStandardDataModel</code></li>
    <li>Runtime smoke test recommended via separate <code>/test-site &lt;URL&gt;</code> invocation</li>
  </ul>
</div>`;
}

/**
 * Render the merged Pages & Components tab — single comparison view of SDM vs EDM.
 * Three states:
 *   - No SDM yet → empty card with guidance.
 *   - SDM present, no EDM yet → "EDM pending" banner + per-row `SDM → ?` placeholder.
 *   - Both present → "X of Y matched" header + per-row `SDM → EDM ✓/⚠/✗` pills.
 *
 * Each row expands to a two-column records preview (SDM | EDM) showing the first
 * 5 records per side.
 */
function renderPagesComponentsSection({ sdmSnapshot, edmSnapshot }) {
  if (!sdmSnapshot) {
    return `<div class="section" id="tab-pages">
  <h2>Pages &amp; Components</h2>
  <p class="section-desc">Side-by-side inventory of your site's components — captured before migration (SDM) and after (EDM) so you can verify every record made it across.</p>
  <div class="card empty-card">
    <div class="empty-icon">○</div>
    <div class="empty-title">SDM snapshot not yet captured</div>
    <div class="empty-body">This section populates after the SDM snapshot is captured during configuration setup (right after <code>pac pages download --modelVersion 1</code>). Each Power Pages component category then appears as a row with its SDM count and a placeholder for the EDM count that fills in after Phase 4.1.</div>
  </div>
</div>`;
  }

  const sdmCounts = sdmSnapshot.counts || {};
  const edmCounts = (edmSnapshot && edmSnapshot.counts) || {};
  const sdmInventory = sdmSnapshot.inventory || {};
  const edmInventory = (edmSnapshot && edmSnapshot.inventory) || {};

  // Union of categories from both sides — covers SDM-only (tags, websiteBindings)
  // and any new categories on EDM.
  const allCats = new Set();
  for (const k of Object.keys(sdmCounts)) if (sdmCounts[k] > 0) allCats.add(k);
  for (const k of Object.keys(edmCounts)) if (edmCounts[k] > 0) allCats.add(k);
  const categories = [...allCats].sort();

  const isPending = !edmSnapshot;
  const sdmTotal = Object.values(sdmCounts).reduce((a, b) => a + b, 0);
  const edmTotal = Object.values(edmCounts).reduce((a, b) => a + b, 0);

  let matchedCount = 0;
  const categoryRows = categories.map((cat) => {
    const sdmN = sdmCounts[cat] || 0;
    const edmN = edmCounts[cat] || 0;
    const isSdmOnlyExpected = ['tags', 'websiteBindings'].includes(cat) && edmN === 0 && sdmN > 0;

    let pillCls, icon, meta;
    if (isPending) {
      pillCls = 'pending';
      icon = '';
      meta = '';
    } else if (isSdmOnlyExpected) {
      pillCls = 'warn';
      icon = '⚠';
      meta = 'SDM-only';
      matchedCount++; // expected difference — counts as matched
    } else if (sdmN === edmN) {
      pillCls = 'match';
      icon = '✓';
      meta = '';
      matchedCount++;
    } else {
      pillCls = 'mismatch';
      icon = '✗';
      const delta = edmN - sdmN;
      meta = (delta > 0 ? '+' : '') + delta;
    }

    const pillRight = isPending
      ? `<span class="comp-num placeholder">?</span>`
      : `<span class="comp-num edm">${edmN}</span><span class="comp-icon">${icon}</span>${meta ? `<span class="comp-meta">${escapeHtml(meta)}</span>` : ''}`;

    const pill = `<div class="comp-pill ${pillCls}">
        <span class="comp-num sdm">${sdmN}</span>
        <span class="comp-arrow">→</span>
        ${pillRight}
      </div>`;

    // Two-column records preview (SDM | EDM), first 5 of each side.
    const sdmRecords = (sdmInventory[cat] || []).slice(0, 5);
    const edmRecords = (edmInventory[cat] || []).slice(0, 5);
    const hasRecords = sdmRecords.length > 0 || edmRecords.length > 0;
    const renderColUl = (records, kind) => {
      if (isPending && kind === 'edm') {
        return '<li class="record-empty">— pending Phase 4.1 —</li>';
      }
      if (records.length === 0) {
        return '<li class="record-empty">— no records —</li>';
      }
      return records.map((r) => `<li>${escapeHtml(describeRecord(r, cat))}</li>`).join('');
    };
    const recordsBlock = hasRecords
      ? `
      <details class="cat-records">
        <summary>Show records (first 5 of each side)</summary>
        <div class="records-two-col">
          <div class="records-col">
            <div class="records-col-label">SDM</div>
            <ul class="cat-record-list">${renderColUl(sdmRecords, 'sdm')}</ul>
          </div>
          <div class="records-col">
            <div class="records-col-label">EDM</div>
            <ul class="cat-record-list">${renderColUl(edmRecords, 'edm')}</ul>
          </div>
        </div>
      </details>`
      : '';

    const desc = categoryDescription(cat);
    const descHtml = desc ? `<div class="cat-desc">${escapeHtml(desc)}</div>` : '';
    return `    <div class="cat-row">
      <div class="cat-head">
        <div class="cat-meta">
          <div class="cat-name">${escapeHtml(formatCategoryName(cat))}</div>
          ${descHtml}
        </div>
        ${pill}
      </div>${recordsBlock}
    </div>`;
  }).join('\n');

  // Summary banner — pending vs final state.
  const totalCats = categories.length;
  let summary;
  if (isPending) {
    summary = `<div class="comp-summary pending">
    <strong>EDM snapshot pending — appears after Phase 4.1.</strong> Showing your site's SDM inventory now (${totalCats} ${totalCats === 1 ? 'category' : 'categories'}, ${sdmTotal} total ${sdmTotal === 1 ? 'record' : 'records'}). Each row fills in its EDM count after the migration completes and step 4.1 captures the EDM snapshot.
  </div>`;
  } else {
    const allMatched = matchedCount === totalCats;
    const unmatched = totalCats - matchedCount;
    summary = `<div class="comp-summary ${allMatched ? 'match' : 'partial'}">
    <strong>${matchedCount} of ${totalCats} categories matched ${allMatched ? '✓' : '⚠'}</strong>
    ${allMatched
      ? '— every Power Pages component migrated cleanly from SDM to EDM.'
      : `— ${unmatched} ${unmatched === 1 ? 'category needs' : 'categories need'} attention. Mismatches are flagged <span class="status-x">✗</span> with the count delta; SDM-only categories (tags, websiteBindings) are <em>expected</em> to differ and are flagged <span class="status-warn">⚠ SDM-only</span>.`}
  </div>`;
  }

  const sdmCap = formatTimestamp(sdmSnapshot.capturedAt);
  const edmCap = edmSnapshot ? formatTimestamp(edmSnapshot.capturedAt) : '— pending —';
  const totalEdmDisplay = edmSnapshot ? edmTotal : '?';

  return `<div class="section" id="tab-pages">
  <h2>Pages &amp; Components</h2>
  <p class="section-desc">Side-by-side inventory of your site's components — captured before migration (SDM) and after (EDM) so you can verify every record made it across.</p>

  ${summary}

  <div class="snapshot-meta">
    <div class="kv-item"><div class="kv-label">SDM captured</div><div class="kv-value">${escapeHtml(sdmCap)}</div></div>
    <div class="kv-item"><div class="kv-label">EDM captured</div><div class="kv-value">${escapeHtml(edmCap)}</div></div>
    <div class="kv-item"><div class="kv-label">SDM total</div><div class="kv-value">${sdmTotal}</div></div>
    <div class="kv-item"><div class="kv-label">EDM total</div><div class="kv-value">${totalEdmDisplay}</div></div>
  </div>

  <div class="cat-list">
${categoryRows}
  </div>
</div>`;
}

function formatCategoryName(cat) {
  // Convert camelCase to readable: "webPages" → "Web Pages"
  return cat
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

// Short, customer-facing descriptions for the Power Pages component categories
// that surface in SDM/EDM site snapshots. Used as the cat-desc subtitle.
const CATEGORY_DESC = {
  webPages: 'Site pages — each one is a route in your portal with a parent template, language, and partial URL.',
  webTemplates: 'Liquid templates that pages and components reuse to render dynamic content.',
  webFiles: 'Static assets uploaded into the site — images, CSS, JS, PDFs surfaced via notes attachments.',
  webLinkSets: 'Named navigation menus referenced from Liquid (header, footer, sidebar links).',
  webRoles: 'Authorization roles used by Web Page Access Rules and Table Permissions.',
  webpageRules: 'Web Page Access Rules — who can read/edit each page based on Web Roles.',
  websiteAccesses: 'Website-level access permissions controlling preview-mode and admin operations.',
  websiteLanguages: 'Languages enabled on the site, each with its own published localized content.',
  websiteBindings: 'Custom hostname / portal bindings — represented differently in EDM, so a 0 count here is expected.',
  pageTemplates: 'Page layout definitions that webPages select from when rendering.',
  contentSnippets: 'Reusable inline text blobs referenced by Liquid as {{ snippets["name"] }}.',
  basicForms: 'Entity Forms — single-record create/edit/read forms backed by a Dataverse table.',
  siteSettings: 'Key/value configuration toggles for the site (cache, authentication, telemetry, etc.).',
  siteMarkers: 'Named anchors used by Liquid to reference specific pages by purpose (e.g. "Home", "404").',
  publishingStates: 'Editorial states (Draft, Published, Inactive) attached to webPages and webFiles.',
  tags: 'Editorial tags used to classify webPages — surfaced via SDM YAML only.',
  ads: 'Banner ad records that surface via ad placements.',
  adPlacements: 'Page slots where ads can render.',
  polls: 'Inline poll/voting widgets surfaced on webPages.',
  tablePermissions: 'Row-level table permissions controlling Dataverse access from the portal.',
  urlHistory: 'Tracked URL renames so old URLs continue to 301 redirect to new ones.',
  // Less-common but possible
  redirects: 'Configured URL redirects (source URL → destination URL).',
  shortcuts: 'Page shortcuts — alternate URLs that resolve to an existing webPage.',
  forums: 'Community forums (D365 Customer / Community / Partner portal feature).',
  blogs: 'Blog containers and posts (D365 Customer / Partner portal feature).',
  ideas: 'Idea/forum submission containers (D365 Customer portal feature).',
};

function categoryDescription(cat) {
  return CATEGORY_DESC[cat] || '';
}

function describeRecord(rec, category) {
  // Pick a sensible label per category. Use the most identifying field available.
  if (category === 'webPages') {
    const parts = [rec.name, rec.partialUrl ? `url=${rec.partialUrl}` : null, rec.language ? `lang=${rec.language}` : null, rec.kind ? `(${rec.kind})` : null].filter(Boolean);
    return parts.join(' · ');
  }
  if (rec.name && rec.language) return `${rec.name} · lang=${rec.language}`;
  if (rec.name && rec.partialUrl) return `${rec.name} · url=${rec.partialUrl}`;
  if (rec.name) return rec.name;
  if (rec.slug) return rec.slug;
  return JSON.stringify(rec).slice(0, 120);
}

function renderMigrationReviewSection(state, snapshots) {
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

  return `<div class="section" id="tab-review">
  <h2>Migration &amp; Review</h2>
  <p class="section-desc">Per-phase sub-step progress, approval gates, and augmented prompts. This is the live view of what's happening.</p>

${renderRemediationDiffCard(snapshots && snapshots.remediationDiff)}

${phaseCards}

${renderPromptsSection(state)}
</div>`;
}

// ── Remediation Diff card ──────────────────────────────────────────────────

function renderDiffLine(line) {
  const t = line.type;
  const oldNum = line.oldLine != null ? String(line.oldLine).padStart(4, ' ') : '    ';
  const newNum = line.newLine != null ? String(line.newLine).padStart(4, ' ') : '    ';
  const sym = t === 'added' ? '+' : t === 'removed' ? '-' : ' ';
  return `<div class="diff-line ${t}"><span class="diff-gutter">${oldNum}</span><span class="diff-gutter">${newNum}</span><span class="diff-sym">${sym}</span><span class="diff-text">${escapeHtml(line.text || '')}</span></div>`;
}

function renderDiffHunk(hunk) {
  const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
  const lines = (hunk.lines || []).map(renderDiffLine).join('');
  return `<div class="diff-hunk"><div class="diff-hunk-header">${escapeHtml(header)}</div>${lines}</div>`;
}

function kindBadge(kind) {
  if (kind === 'fetchxml+liquid') return '<span class="kind-badge fetchxml">FetchXML</span><span class="kind-badge liquid">Liquid</span>';
  if (kind === 'fetchxml') return '<span class="kind-badge fetchxml">FetchXML</span>';
  if (kind === 'liquid') return '<span class="kind-badge liquid">Liquid</span>';
  return '';
}

function renderRemediationFileRow(entry, idx) {
  const id = `rem-file-${idx}`;
  const hunks = (entry.hunks || []).map(renderDiffHunk).join('');
  const summary = (entry.changeSummary && entry.changeSummary.length > 0)
    ? `<ul class="rem-summary">${entry.changeSummary.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
    : '';
  const stagedHref = entry.stagedPath
    ? `vscode://file/${escapeHtml(entry.stagedPath.replace(/\\/g, '/'))}`
    : null;
  const diffCmd = entry.livePath && entry.stagedPath
    ? `code --diff "${entry.livePath}" "${entry.stagedPath}"`
    : null;
  const vscodeLink = stagedHref
    ? `<a class="rem-vscode-link" href="${stagedHref}" title="Open staged file in your local VSCode desktop app">Open staged file in VSCode</a>`
    : '';
  // The diff command goes inside the expanded details body (a small copy-able snippet
  // for users who want the actual side-by-side editor — vscode://file/<path> only
  // opens the file by itself, not a diff view).
  const diffCmdBlock = diffCmd
    ? `<div class="rem-cli">
      <div class="rem-cli-label">For a side-by-side diff editor, run from a terminal:</div>
      <code class="rem-cli-cmd">${escapeHtml(diffCmd)}</code>
    </div>`
    : '';
  return `<details class="rem-file" id="${id}">
  <summary>
    <span class="rem-file-path">${escapeHtml(entry.relativePath)}</span>
    ${kindBadge(entry.kind)}
    <span class="rem-stats"><span class="rem-added">+${entry.linesAdded || 0}</span> <span class="rem-removed">−${entry.linesRemoved || 0}</span></span>
    ${vscodeLink}
  </summary>
  ${summary}
  ${diffCmdBlock}
  <div class="diff-body">${hunks}</div>
</details>`;
}

function renderRemediationDiffCard(diff) {
  if (!diff || !diff.files || diff.files.length === 0) return '';

  const files = diff.files;
  const fxCount = files.filter((f) => f.kind === 'fetchxml' || f.kind === 'fetchxml+liquid').length;
  const lqCount = files.filter((f) => f.kind === 'liquid' || f.kind === 'fetchxml+liquid').length;
  const totalAdded = files.reduce((a, f) => a + (f.linesAdded || 0), 0);
  const totalRemoved = files.reduce((a, f) => a + (f.linesRemoved || 0), 0);
  const fileRows = files.map(renderRemediationFileRow).join('\n');

  const generatedAt = diff.generatedAt ? formatTimestamp(diff.generatedAt) : '';

  // PP-VSCode import deep-link. Requires the extension's URI handler to support
  // the /metadataDiffImport route (added in PP-VSCode in 2026; for older builds
  // the link silently no-ops and the user falls back to the per-file snippets).
  const ppvLink = diff.manifestPath
    ? `vscode://microsoft-IsvExpTools.powerplatform-vscode/metadataDiffImport?filePath=${encodeURIComponent(diff.manifestPath)}`
    : null;
  const ppvButton = ppvLink
    ? `<a class="rem-import-btn" href="${escapeHtml(ppvLink)}">
      <span class="rem-import-icon">▣</span>
      <span class="rem-import-text">
        <span class="rem-import-title">Import in Power Pages Actions</span>
        <span class="rem-import-sub">Opens this diff in the Power Pages VSCode extension</span>
      </span>
    </a>`
    : '';
  const ppvGuide = ppvLink
    ? `<div class="rem-guide">
      <div class="rem-guide-title">What happens when you click "Import in Power Pages Actions":</div>
      <ol class="rem-guide-steps">
        <li>VSCode pulls focus (if installed and the Power Platform extension is enabled).</li>
        <li>The diff is imported into the <strong>Site Comparison</strong> section of the Power Pages Actions sidebar — look for an entry named after this site.</li>
        <li><strong>Click each file in the imported tree</strong> to open VSCode's side-by-side diff editor. Imported diffs don't auto-open the editor; you have to expand the tree and click each row.</li>
      </ol>
      <div class="rem-guide-fallback">If the Power Platform extension isn't installed, or you'd rather skip the tree view, use the per-file links and <code>code --diff</code> commands inside each row below — they open the same VSCode diff editor directly.</div>
    </div>`
    : '';

  return `<div class="card remediation-card">
  <div class="card-title">Remediation Diff <span class="rem-card-subtitle">— review before approving upload</span></div>
  <p class="rem-blurb">Auto-rewriters proposed changes to <strong>${files.length} file${files.length === 1 ? '' : 's'}</strong> (${fxCount} FetchXML${lqCount ? ` · ${lqCount} Liquid` : ''}, <span class="rem-added">+${totalAdded}</span> <span class="rem-removed">−${totalRemoved}</span> lines). Files are written to <code>remediation-staged/</code> — your live site source is untouched until you approve.</p>
  <div class="rem-meta">Staged at ${escapeHtml(generatedAt)}</div>

  ${ppvButton}
  ${ppvGuide}

  <h4 class="rem-files-heading">Per-file inline preview</h4>
  <div class="rem-file-list">
${fileRows}
  </div>
</div>`;
}

// ── Phase card / sub-step rendering ────────────────────────────────────────

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
    ? `\n        <div class="sub-step-output">${escapeHtmlAllowingInline(sub.output)}</div>`
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
        <summary>Show ${subStepsCount} completed ${noun}</summary>
${subStepsHtml}
      </details>`
    : subStepsHtml;

  return `<div class="phase-card">
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
  </div>`;
}

// ── Approval banner ────────────────────────────────────────────────────────

function renderApprovalBanner(state) {
  const gate = state.approvalGate;
  if (!gate) return '';
  const track = state.track;
  const key = track ? `${gate.phaseId}:${gate.kind}:${track}` : null;
  const fallbackKey = `${gate.phaseId}:${gate.kind}`;
  const copy = (key && APPROVAL_COPY[key]) || APPROVAL_COPY[fallbackKey] || {
    heading: gate.title || `Approval required`,
    body: [gate.body || 'Respond in your Claude Code chat to continue.'],
    approve: '› Yes, proceed',
    cancel: '› Cancel',
  };
  const bodyHtml = copy.body
    .map((p) => `  <p>${escapeHtmlAllowingInline(p)}</p>`)
    .join('\n');
  return `<div class="approval-banner">
  <h3>${escapeHtml(copy.heading)}</h3>
${bodyHtml}
  <p class="approval-instr"><strong>To approve and continue</strong>, respond in your Claude Code chat with:</p>
  <div class="action-cmd">${escapeHtml(copy.approve)}</div>
  <p class="approval-instr"><strong>To cancel</strong>:</p>
  <div class="action-cmd">${escapeHtml(copy.cancel)}</div>
</div>`;
}

// ── Augmented prompts ──────────────────────────────────────────────────────

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
    return `<div class="prompt-card pending">
    <h4>${t.icon} ${escapeHtml(t.label)}</h4>
    <div class="prompt-state">${escapeHtml(pendingDesc)}</div>
  </div>`;
  }
  if (prompt.status !== PROMPT_STATUS.READY) {
    return `<div class="prompt-card pending">
    <h4>${t.icon} ${escapeHtml(t.label)}</h4>
    <div class="prompt-state">${escapeHtmlAllowingInline(prompt.summary || 'Pending.')}</div>
  </div>`;
  }
  const link = prompt.path
    ? `<div class="links"><a href="${escapeHtml(prompt.path)}">📄 ${escapeHtml(prompt.path.replace(/^.*[\\/]/, ''))}</a></div>`
    : '';
  return `<div class="prompt-card ready">
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
  return `<div class="card prompts-section">
  <h3>Augmented Prompts for Customer-Owned Code</h3>
  <p class="prompts-blurb">${escapeHtml(blurb)}</p>
${renderPromptCard('plugin', p.plugin)}
${renderPromptCard('dme', p.dme)}
</div>`;
}

// ── CSS ────────────────────────────────────────────────────────────────────

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

/* Topbar */
.topbar { z-index:100; background:var(--surface); box-shadow:var(--shadow-4); padding:14px 28px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; position:sticky; top:0; }
.topbar-left { display:flex; align-items:center; gap:14px; }
.topbar-title { font-size:16px; font-weight:700; color:var(--text-bright); }
.topbar-sub { font-size:11px; color:var(--text-dim); margin-top:1px; }
.topbar-right { display:flex; align-items:center; gap:14px; font-size:12px; color:var(--text-dim); flex-wrap:wrap; }
.context-item { display:flex; align-items:center; gap:6px; }
.context-label { color:var(--text-dim); }
.context-value { color:var(--text-bright); font-weight:600; font-family:var(--mono); font-size:12px; }
.status-pill { display:inline-block; font-size:11px; font-weight:700; padding:3px 10px; border-radius:3px; font-family:var(--mono); text-transform:uppercase; letter-spacing:0.5px; }
.status-pill.in-progress { color:var(--info); background:var(--info-bg); border:1px solid var(--info-border); }
.status-pill.pending { color:var(--warning); background:var(--warning-bg); border:1px solid var(--warning-border); }
.status-pill.done { color:var(--pass); background:var(--pass-bg); border:1px solid var(--pass-border); }

/* Layout */
.layout { display:flex; min-height:calc(100vh - 65px); }
.sidebar { width:240px; background:var(--surface); border-right:1px solid var(--border); padding:20px 0; flex-shrink:0; position:sticky; top:65px; align-self:flex-start; max-height:calc(100vh - 65px); overflow-y:auto; }
.nav-group-label { font-size:10px; font-weight:700; color:var(--text-dim); text-transform:uppercase; letter-spacing:1.2px; padding:16px 22px 6px; }
.nav-btn { display:flex; align-items:center; gap:10px; width:100%; padding:11px 22px; background:none; border:none; border-left:2px solid transparent; color:var(--text-dim); font-size:13px; font-weight:500; cursor:pointer; font-family:var(--sans); text-align:left; transition:all 0.15s; }
.nav-btn:hover { color:var(--text); background:var(--surface2); }
.nav-btn.active { color:var(--accent); font-weight:600; border-left-color:var(--accent); background:var(--accent-bg); }
.nav-btn .nav-icon { font-size:15px; opacity:0.5; width:18px; text-align:center; flex-shrink:0; }
.nav-btn.active .nav-icon { opacity:0.9; }
.nav-btn .nav-label { display:flex; flex-direction:column; line-height:1.25; }
.nav-btn .nav-sub { font-size:10.5px; font-weight:500; color:var(--text-dim); margin-top:1px; letter-spacing:0.2px; }
.nav-btn.active .nav-sub { color:var(--accent); opacity:0.85; }
.content { flex:1; padding:32px 40px 72px; max-width:1100px; }
.section { display:none; }
.section.active { display:block; animation:fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
@keyframes pulse { 0%, 100% { opacity:1; } 50% { opacity:0.55; } }

/* Headings */
h2 { font-size:22px; font-weight:800; color:var(--text-bright); letter-spacing:-0.3px; margin-bottom:6px; }
.section-desc { font-size:13px; color:var(--text-dim); margin-bottom:22px; }
.section-desc code { color:var(--accent); background:var(--accent-bg); padding:1px 6px; border-radius:3px; font-family:var(--mono); font-size:12px; }
h3 { font-size:15px; font-weight:700; color:var(--text-bright); margin-top:24px; margin-bottom:12px; }

/* Summary / cards */
.summary-box { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:20px 22px; margin-bottom:22px; font-size:14px; color:var(--text); line-height:1.7; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:18px 20px; margin-bottom:16px; box-shadow:var(--shadow-4); }
.card-title { font-size:14px; font-weight:700; color:var(--text-bright); margin-bottom:12px; }

/* Stats grid */
.stats-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:20px; }
.stat-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px; text-align:center; box-shadow:var(--shadow-4); position:relative; overflow:hidden; }
.stat-card::after { content:''; position:absolute; top:0; left:50%; transform:translateX(-50%); width:40px; height:2px; background:var(--accent); border-radius:0 0 2px 2px; }
.stat-num { font-size:22px; font-weight:800; font-family:var(--mono); line-height:1; color:var(--text-bright); }
.stat-label { font-size:10px; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px; margin-top:6px; }

/* Site card */
.site-card table { width:100%; border-collapse:collapse; font-size:13px; }
.site-card td { padding:7px 0; border-bottom:1px solid var(--surface2); }
.site-card tr:last-child td { border-bottom:none; }
.site-card td:first-child { color:var(--text-dim); width:200px; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:0.3px; }
.site-card td:last-child { color:var(--text-bright); font-family:var(--mono); font-size:12.5px; }
.site-card td:last-child em { color:var(--text-dim); font-style:italic; font-family:var(--sans); font-size:12.5px; }
.site-card td.known { color:var(--text-bright); font-family:var(--mono); }

/* Confidence card */
.confidence-card .confidence-numbers { display:flex; align-items:center; gap:14px; padding:8px 0; }
.confidence-num { font-size:32px; font-weight:800; font-family:var(--mono); color:var(--text-bright); line-height:1; }
.confidence-num.pending { color:var(--text-dim); }
.confidence-arrow { font-size:20px; color:var(--text-dim); }
.confidence-icon { font-size:24px; font-weight:700; margin-left:8px; }
.confidence-card.match .confidence-icon { color:var(--pass); }
.confidence-card.mismatch .confidence-icon { color:var(--warning); }
.confidence-label { font-size:12px; color:var(--text-dim); line-height:1.55; margin-top:6px; }
.confidence-card.empty .empty-note { font-size:13px; color:var(--text-dim); line-height:1.65; }
.confidence-card.empty .empty-note code { color:var(--accent); background:var(--accent-bg); padding:1px 6px; border-radius:3px; font-family:var(--mono); font-size:12px; }

/* Plan section */
.kv-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:10px; margin-bottom:12px; }
.kv-item { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:10px 14px; }
.kv-label { font-size:10px; font-weight:600; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:3px; }
.kv-value { font-size:13px; color:var(--text-bright); font-family:var(--mono); }
.plan-phase-list { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); }
.plan-phase-row { display:flex; align-items:center; gap:18px; padding:14px 20px; border-bottom:1px solid var(--surface2); }
.plan-phase-row:last-child { border-bottom:none; }
.plan-phase-num { font-size:11px; font-weight:700; color:var(--accent); background:var(--accent-bg); padding:4px 10px; border-radius:3px; font-family:var(--mono); flex-shrink:0; }
.plan-phase-body { flex:1; }
.plan-phase-title { font-size:14px; font-weight:600; color:var(--text-bright); }
.plan-phase-meta { font-size:12px; color:var(--text-dim); margin-top:2px; }
.plan-phase-status { font-size:11px; font-weight:700; padding:3px 10px; border-radius:3px; font-family:var(--mono); text-transform:uppercase; letter-spacing:0.5px; }
.plan-phase-status.completed { color:var(--pass); background:var(--pass-bg); border:1px solid var(--pass-border); }
.plan-phase-status.in-progress { color:var(--info); background:var(--info-bg); border:1px solid var(--info-border); }
.plan-phase-status.pending { color:var(--text-dim); background:var(--surface2); border:1px solid var(--border); }
.bullet-list { list-style:none; padding:0; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); }
.bullet-list li { padding:11px 18px 11px 36px; position:relative; font-size:13px; color:var(--text); border-bottom:1px solid var(--surface2); }
.bullet-list li:last-child { border-bottom:none; }
.bullet-list li::before { content:''; position:absolute; left:18px; top:18px; width:6px; height:6px; border-radius:50%; background:var(--accent); }

/* Components sections */
.snapshot-meta { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:18px; }
.cat-list { display:flex; flex-direction:column; gap:8px; }
.cat-row { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:14px 20px; box-shadow:var(--shadow-4); }
.cat-head { display:flex; align-items:flex-start; gap:16px; }
.cat-meta { flex:1; min-width:0; }
.cat-name { font-size:14px; font-weight:700; color:var(--text-bright); }
.cat-desc { font-size:12.5px; color:var(--text-dim); margin-top:4px; line-height:1.55; }

/* Comparison pill — SDM → EDM with status icon */
.comp-pill { display:flex; align-items:center; gap:8px; padding:7px 12px; border-radius:var(--radius-sm); border:1px solid var(--border); font-family:var(--mono); font-weight:700; white-space:nowrap; flex-shrink:0; }
.comp-pill.match { background:var(--pass-bg); border-color:var(--pass-border); }
.comp-pill.warn { background:var(--warning-bg); border-color:var(--warning-border); }
.comp-pill.mismatch { background:var(--critical-bg); border-color:var(--critical-border); }
.comp-pill.pending { background:var(--surface2); border-color:var(--border); }
.comp-num { font-size:15px; color:var(--text-bright); min-width:28px; text-align:right; }
.comp-num.sdm, .comp-num.edm { font-family:var(--mono); }
.comp-num.placeholder { color:var(--text-dim); }
.comp-arrow { color:var(--text-dim); font-size:13px; font-weight:400; }
.comp-icon { font-size:14px; }
.comp-pill.match .comp-icon { color:var(--pass); }
.comp-pill.warn .comp-icon { color:var(--warning); }
.comp-pill.mismatch .comp-icon { color:var(--critical); }
.comp-meta { font-size:11px; font-weight:600; padding-left:6px; margin-left:2px; color:var(--text-dim); border-left:1px solid var(--border); }
.comp-pill.warn .comp-meta { color:var(--warning); border-left-color:var(--warning-border); }
.comp-pill.mismatch .comp-meta { color:var(--critical); border-left-color:var(--critical-border); }

/* Pages & Components summary banner */
.comp-summary { padding:14px 18px; border-radius:var(--radius); margin-bottom:18px; font-size:13px; line-height:1.65; border:1px solid var(--border); }
.comp-summary.match { background:var(--pass-bg); border-color:var(--pass-border); color:var(--text); }
.comp-summary.partial { background:var(--warning-bg); border-color:var(--warning-border); color:var(--text); }
.comp-summary.pending { background:var(--info-bg); border-color:var(--info-border); color:var(--text); }
.comp-summary strong { color:var(--text-bright); }
.comp-summary .status-x { color:var(--critical); font-weight:700; font-family:var(--mono); }
.comp-summary .status-warn { color:var(--warning); font-weight:700; font-family:var(--mono); }

/* Two-column records preview (SDM | EDM) */
.cat-records { margin-top:12px; padding-top:10px; border-top:1px solid var(--surface2); }
.cat-records > summary { color:var(--accent); font-size:12px; font-weight:600; cursor:pointer; padding:2px 0; }
.cat-records > summary::-webkit-details-marker { color:var(--text-dim); }
.cat-records[open] > summary { margin-bottom:8px; }
.records-two-col { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.records-col-label { font-size:10px; font-weight:700; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; }
.cat-record-list { list-style:none; padding:6px 10px; background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius-sm); margin:0; }
.cat-record-list li { font-size:12px; font-family:var(--mono); color:var(--text); padding:3px 0; border-bottom:1px dashed var(--border); }
.cat-record-list li.record-empty { color:var(--text-dim); font-style:italic; font-family:var(--sans); }
.cat-record-list li:last-child { border-bottom:none; }
@media (max-width:700px) {
  .records-two-col { grid-template-columns:1fr; }
}
.cat-record-list li:last-child { border-bottom:none; }

/* Empty state */
.empty-card { text-align:center; padding:36px 32px; }
.empty-icon { font-size:38px; color:var(--text-dim); margin-bottom:10px; }
.empty-title { font-size:15px; font-weight:700; color:var(--text-bright); margin-bottom:8px; }
.empty-body { font-size:13px; color:var(--text-dim); line-height:1.65; max-width:680px; margin:0 auto; }
.empty-body code { color:var(--accent); background:var(--accent-bg); padding:1px 6px; border-radius:3px; font-family:var(--mono); font-size:12px; }

/* Phase cards */
.phase-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); margin-bottom:12px; overflow:hidden; box-shadow:var(--shadow-4); transition:box-shadow 0.2s; }
.phase-card:hover { box-shadow:var(--shadow-8); }
.phase-header { padding:16px 22px; display:flex; align-items:center; gap:14px; }
.phase-status-icon { width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700; flex-shrink:0; font-family:var(--mono); }
.status-done { background:var(--pass-bg); color:var(--pass); border:1px solid var(--pass-border); }
.status-progress { background:var(--info-bg); color:var(--info); border:1px solid var(--info-border); animation:pulse 2s infinite; }
.status-pending { background:var(--surface2); color:var(--text-dim); border:1px solid var(--border); }
.status-blocked { background:var(--warning-bg); color:var(--warning); border:1px solid var(--warning-border); }
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
details > summary { cursor:pointer; color:var(--accent); font-size:12px; padding:4px 0; font-weight:600; }
details[open] > summary { margin-bottom:6px; }

/* Approval banner */
.approval-banner { background:var(--warning-bg); border:1px solid var(--warning-border); border-left:4px solid var(--warning); border-radius:var(--radius); padding:20px 24px; margin-top:20px; box-shadow:var(--shadow-4); }
.approval-banner h3 { margin:0 0 10px; color:var(--warning); font-size:15px; font-weight:700; }
.approval-banner p { margin:8px 0; color:var(--text); font-size:13px; line-height:1.65; }
.approval-banner .approval-instr { margin-top:14px; }
.approval-banner .action-cmd { background:var(--text-bright); color:#f9f8f7; padding:10px 14px; border-radius:var(--radius-sm); font-family:var(--mono); font-size:12.5px; margin-top:6px; }

/* Augmented prompts */
.prompts-section h3 { margin-top:0; }
.prompts-blurb { font-size:13px; color:var(--text-dim); margin-bottom:14px; }
.prompt-card { padding:14px 16px; background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius); margin-top:10px; border-left:3px solid var(--border-light); }
.prompt-card.pending { opacity:0.7; }
.prompt-card.ready { border-left-color:var(--accent); background:var(--accent-bg); }
.prompt-card h4 { margin:0 0 5px; font-size:13px; font-weight:700; color:var(--text-bright); }
.prompt-card p { margin:5px 0; font-size:12.5px; color:var(--text); }
.prompt-card .prompt-state { font-size:12px; color:var(--text-dim); }
.prompt-card .links { margin-top:6px; font-size:12px; font-family:var(--mono); }
.prompt-card .links a { color:var(--accent); text-decoration:underline; display:block; padding:2px 0; }

/* Remediation diff card */
.remediation-card { border-left:3px solid var(--warning); }
.remediation-card .card-title { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
.rem-card-subtitle { font-size:12px; font-weight:500; color:var(--text-dim); }
.rem-blurb { font-size:13px; color:var(--text); line-height:1.65; margin-bottom:8px; }
.rem-blurb code { font-family:var(--mono); font-size:12px; background:var(--surface2); padding:1px 6px; border-radius:3px; color:var(--text-bright); }
.rem-blurb strong { color:var(--text-bright); }
.rem-meta { font-size:11px; color:var(--text-dim); font-family:var(--mono); margin-bottom:14px; }
.rem-added { color:var(--pass); font-weight:700; font-family:var(--mono); }
.rem-removed { color:var(--critical); font-weight:700; font-family:var(--mono); }
.rem-file-list { display:flex; flex-direction:column; gap:6px; }
.rem-file { background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius-sm); overflow:hidden; }
.rem-file > summary { cursor:pointer; padding:10px 14px; display:flex; align-items:center; gap:10px; font-size:12.5px; flex-wrap:wrap; list-style:none; user-select:none; }
.rem-file > summary::-webkit-details-marker { display:none; }
.rem-file > summary:hover { background:var(--surface3); }
.rem-file[open] > summary { border-bottom:1px solid var(--border); }
.rem-file-path { flex:1; font-family:var(--mono); font-weight:600; color:var(--text-bright); min-width:0; word-break:break-all; }
.kind-badge { font-size:10px; font-weight:700; padding:2px 7px; border-radius:3px; font-family:var(--mono); text-transform:uppercase; letter-spacing:0.5px; }
.kind-badge.fetchxml { color:var(--info); background:var(--info-bg); border:1px solid var(--info-border); }
.kind-badge.liquid { color:var(--purple); background:var(--purple-bg); border:1px solid var(--purple-border); }
.rem-stats { font-family:var(--mono); font-size:12px; padding:0 4px; }
.rem-vscode-link { color:var(--accent); font-size:12px; text-decoration:underline; }
.rem-vscode-link:hover { color:var(--text-bright); }
.rem-summary { margin:8px 14px; padding-left:18px; font-size:12px; color:var(--text-dim); line-height:1.6; }
.rem-summary li { margin-bottom:2px; }
.rem-import-btn { display:inline-flex; align-items:center; gap:12px; padding:12px 18px; margin-top:6px; background:var(--accent); color:#ffffff; text-decoration:none; border-radius:var(--radius-sm); box-shadow:var(--shadow-4); transition:background 0.15s; }
.rem-import-btn:hover { background:#106ebe; box-shadow:var(--shadow-8); }
.rem-import-icon { font-size:22px; line-height:1; opacity:0.95; }
.rem-import-text { display:flex; flex-direction:column; }
.rem-import-title { font-size:13.5px; font-weight:700; }
.rem-import-sub { font-size:11px; opacity:0.85; margin-top:2px; }
.rem-guide { margin-top:12px; padding:14px 16px; background:var(--info-bg); border:1px solid var(--info-border); border-radius:var(--radius-sm); font-size:12.5px; line-height:1.65; }
.rem-guide-title { font-weight:700; color:var(--text-bright); margin-bottom:6px; font-size:12px; }
.rem-guide-steps { margin:6px 0 8px 22px; padding:0; color:var(--text); }
.rem-guide-steps li { margin-bottom:4px; }
.rem-guide-steps strong { color:var(--text-bright); }
.rem-guide-fallback { color:var(--text-dim); padding-top:8px; border-top:1px solid var(--info-border); margin-top:6px; }
.rem-guide-fallback code { font-family:var(--mono); background:var(--surface); padding:1px 5px; border-radius:3px; color:var(--text-bright); }
.rem-files-heading { font-size:12px; font-weight:700; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px; margin:18px 0 8px; }
.rem-cli { margin:8px 14px 4px; padding:8px 12px; background:var(--surface); border:1px dashed var(--border); border-radius:var(--radius-sm); }
.rem-cli-label { font-size:11px; color:var(--text-dim); margin-bottom:4px; }
.rem-cli-cmd { display:block; font-family:var(--mono); font-size:11.5px; color:var(--text-bright); background:var(--surface3); padding:6px 10px; border-radius:3px; user-select:all; cursor:text; word-break:break-all; }
.diff-body { background:var(--surface); padding:10px 0; max-height:420px; overflow-y:auto; border-top:1px solid var(--border); font-family:var(--mono); font-size:11.5px; }
.diff-hunk { margin-bottom:8px; }
.diff-hunk-header { color:var(--text-dim); background:var(--surface2); padding:3px 14px; font-size:11px; }
.diff-line { display:flex; gap:6px; padding:1px 12px; line-height:1.45; white-space:pre; }
.diff-line.added { background:var(--pass-bg); }
.diff-line.removed { background:var(--critical-bg); }
.diff-gutter { color:var(--text-dim); min-width:34px; text-align:right; font-size:10.5px; user-select:none; flex-shrink:0; }
.diff-sym { width:12px; flex-shrink:0; color:var(--text-dim); }
.diff-line.added .diff-sym { color:var(--pass); }
.diff-line.removed .diff-sym { color:var(--critical); }
.diff-text { flex:1; color:var(--text-bright); white-space:pre-wrap; word-break:break-all; }

/* Footer */
.footer { position:fixed; bottom:0; left:0; right:0; text-align:center; padding:10px; font-size:11px; color:var(--text-dim); border-top:1px solid var(--border); background:var(--surface); z-index:50; }

/* Responsive */
@media (max-width:900px) {
  .layout { flex-direction:column; }
  .sidebar { width:100%; border-right:none; border-bottom:1px solid var(--border); display:flex; flex-wrap:wrap; padding:8px; position:relative; top:0; max-height:none; }
  .nav-group-label { width:100%; }
  .nav-btn { width:auto; border-left:none; border-bottom:2px solid transparent; padding:10px 14px; }
  .nav-btn.active { border-left:none; border-bottom-color:var(--accent); }
  .content { padding:20px; }
  .stats-grid { grid-template-columns:repeat(2,1fr); }
  .snapshot-meta { grid-template-columns:1fr; }
}`;

// ── JS for tab switching ───────────────────────────────────────────────────

const TAB_JS = `document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});`;

// ── Topbar ─────────────────────────────────────────────────────────────────

function renderTopbar(state) {
  const site = state.site;
  const pill = statusPillFor(state);
  const pillClass = pillSeverityClass(state);

  // Build context items: site name, env, mode (or placeholders).
  const contextItems = [];
  if (site.name) contextItems.push({ label: 'Site', value: site.name });
  if (site.environment) contextItems.push({ label: 'Env', value: site.environment });
  if (site.migrationMode) contextItems.push({ label: 'Mode', value: site.migrationMode });

  const contextHtml = contextItems.map((c) =>
    `<span class="context-item"><span class="context-label">${escapeHtml(c.label)}:</span> <span class="context-value">${escapeHtml(c.value)}</span></span>`,
  ).join('');

  return `<div class="topbar">
  <div class="topbar-left">
    <div>
      <div class="topbar-title">SDM → EDM Migration</div>
      <div class="topbar-sub">Power Pages site data-model migration</div>
    </div>
  </div>
  <div class="topbar-right">
    ${contextHtml}
    <span class="status-pill ${pillClass}">${escapeHtml(pill)}</span>
  </div>
</div>`;
}

// ── Sidebar ────────────────────────────────────────────────────────────────

function renderSidebar() {
  return `<div class="sidebar">
  <div class="nav-group-label">Report</div>
  <button class="nav-btn active" data-tab="overview"><span class="nav-icon">◉</span><span class="nav-label">Overview</span></button>
  <button class="nav-btn" data-tab="plan"><span class="nav-icon">☰</span><span class="nav-label">Plan</span></button>
  <button class="nav-btn" data-tab="pages"><span class="nav-icon">▤</span><span class="nav-label">Pages &amp; Components</span></button>
  <button class="nav-btn" data-tab="review"><span class="nav-icon">✓</span><span class="nav-label">Migration &amp; Review</span></button>
</div>`;
}

// ── Main render entry ──────────────────────────────────────────────────────

/**
 * Render the full HTML report from migration state and optional snapshots.
 *
 * @param {object} state - Parsed migration-state.json
 * @param {object} [opts]
 * @param {object|null} [opts.sdmSnapshot] - Parsed sdm-snapshot.json if present
 * @param {object|null} [opts.edmSnapshot] - Parsed edm-snapshot.json if present
 */
function renderLiveReport(state, opts = {}) {
  const sdmSnapshot = opts.sdmSnapshot || null;
  const edmSnapshot = opts.edmSnapshot || null;
  const remediationDiff = opts.remediationDiff || null;
  const snapshots = { sdmSnapshot, edmSnapshot, remediationDiff };
  const pill = statusPillFor(state);

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

${renderTopbar(state)}

<div class="layout">
  ${renderSidebar()}

  <div class="content">
${renderOverviewSection(state, snapshots)}

${renderPlanSection(state)}

${renderPagesComponentsSection({ sdmSnapshot, edmSnapshot })}

${renderMigrationReviewSection(state, snapshots)}
  </div>
</div>

<div class="footer">
  Generated by <strong>migrate-sdm-to-edm</strong> skill · Last updated ${escapeHtml(formatTimestamp(state.lastUpdatedAt))} · Refresh in browser to see live updates
</div>

<script>
${TAB_JS}
</script>
</body>
</html>
`;
}

module.exports = {
  renderLiveReport,
  _internals: {
    escapeHtml,
    escapeHtmlAllowingInline,
    countCompleted,
    overallPercent,
    formatElapsed,
  },
};
