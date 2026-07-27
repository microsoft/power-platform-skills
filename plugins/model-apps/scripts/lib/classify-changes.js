'use strict';
// Change classifier for `--changed-only` (changed-only design, deliverable #5 decision core, PURE).
//
// Given the CURRENT spec and the LAST-APPLIED spec — BOTH annotated with on-disk content hashes by
// content-hash.js (so .tsx/contentPath byte edits are visible) — decide whether the diff can be applied
// via the fast path, and if not, WHY (and what debt to record). FAIL-CLOSED: a change is fast-eligible
// ONLY if it is PROVABLY one of the four convergent shapes; anything else forces a full build. The build
// engine is ADDITIVE, not convergent (existing chart/command/dashboard defs and web-resource CONTENT are
// SKIPPED on rebuild; views only UNION columns; forms reconcile fields but not placement), so an edit to
// such an artifact does not converge even under a FULL build — those edits record sticky DEBT that blocks
// snapshot eligibility until a proven-fresh recreation clears it (design §"Eligibility state machine").
//
// The four convergent shapes (the ONLY fast-path edits in v1):
//   #1 page     — .tsx byte change to an EXISTING page, key→pageId map + name/nav/semantics unchanged.
//   #2 form     — explicit-layout field-set add/remove, placement-exact. NOT decided here: form placement
//                 convergence can only be proven against the DEPLOYED form projection (the spec's
//                 layout:'auto' forms don't even carry placement), so form edits are conservatively
//                 full-build + debt-candidate; the build-time verifier clears the debt iff it converged.
//   #3 view     — pure APPEND of columns (prior columns are a prefix of current; nothing else changed).
//   #4 app-shell— structural sitemap change only (app.name/description/icon unchanged).
//
// PURE + I/O-free. Consumes the ANNOTATED specs (caller runs annotateContentHashes first).

const { diffPhases, stableStringify } = require('./phase-diff.js');

// Phases that, when changed, always force a full build. data-model ripples into everything; solution/
// sample-data/ai have no convergent fast shape. A full build applies them correctly, so NO debt.
const FULL_BUILD_PHASES = new Set(['data-model', 'solution', 'sample-data', 'ai-features']);

// Stable identity keys per artifact type, used to align current vs prior entries (added / edited / removed).
const identityOf = {
  view: (v) => `${low(v.entity)}|${v.name}`,
  chart: (c) => `${low(c.entity)}|${c.name}`,
  command: (c) => `${low(c.entity)}|${c.name || c.label || ''}`,
  dashboard: (d) => `${d.name}`,
  form: (f) => `${low(f.entity)}|${f.formType || 'Main'}|${f.name || ''}`,
  page: (p) => `${p.key || p.name}`,
  webResource: (w) => `${w.name}`,
};

function low(s) { return String(s == null ? '' : s).toLowerCase(); }

// Compare two objects for structural equality IGNORING the listed keys (order-independent via
// stableStringify). Used to ask "is everything EXCEPT columns / __contentSha identical?".
function equalExcept(a, b, ignoreKeys) {
  const strip = (o) => {
    const c = { ...(o || {}) };
    for (const k of ignoreKeys) delete c[k];
    return c;
  };
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

// Is `prefix` an exact leading prefix of `full` (deep per-element equality, prefix.length <= full.length)?
function isColumnPrefix(prefix, full) {
  const p = prefix || [];
  const f = full || [];
  if (p.length > f.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (stableStringify(p[i]) !== stableStringify(f[i])) return false;
  }
  return true;
}

// Index an array by identity, returning a Map(identity -> entry). Non-array -> empty map.
function indexBy(arr, keyFn) {
  const m = new Map();
  for (const item of Array.isArray(arr) ? arr : []) {
    if (item && typeof item === 'object') m.set(keyFn(item), item);
  }
  return m;
}

// Split current vs prior artifact arrays into added / removed / common(edited-or-same) by identity.
function alignByIdentity(curArr, priorArr, keyFn) {
  const cur = indexBy(curArr, keyFn);
  const prior = indexBy(priorArr, keyFn);
  const added = [], removed = [], common = [];
  for (const [k, v] of cur) { if (!prior.has(k)) added.push({ id: k, cur: v }); else common.push({ id: k, cur: v, prior: prior.get(k) }); }
  for (const [k, v] of prior) { if (!cur.has(k)) removed.push({ id: k, prior: v }); }
  return { added, removed, common };
}

// ---- per-phase detectors. Each returns { fast:[shapes], full:[reasons], debt:[entries] }. ----

// #1 pages: every changed page must be CONTENT-ONLY (same key, same pageId, same name/nav/semantics; only
// __contentSha differs). An added page (full build creates it — no debt), a removed page (removal
// convergence unproven — debt), or a structural page edit (name/nav/pageId changed → possibly a sitemap
// change) forces a full build.
function classifyPages(cur, prior) {
  const out = { fast: [], full: [], debt: [] };
  const { added, removed, common } = alignByIdentity(cur.pages, prior.pages, identityOf.page);
  if (added.length) out.full.push(`pages: ${added.length} new page(s) added (${added.map((a) => a.id).join(', ')}) — a new artifact needs a full build`);
  for (const r of removed) {
    out.full.push(`pages: page '${r.id}' removed — removal is not a convergent fast shape`);
    out.debt.push({ artifactType: 'page', identity: r.id, reason: 'page-removed' });
  }
  for (const c of common) {
    const structuralSame = equalExcept(c.cur, c.prior, ['__contentSha']);
    const contentDiffers = (c.cur.__contentSha || null) !== (c.prior.__contentSha || null);
    if (structuralSame && contentDiffers) {
      out.fast.push({ shape: 'page', phase: 'pages', identity: c.id, detail: 'tsx content changed (re-upload only)' });
    } else if (!structuralSame) {
      // name / navigatesTo / pageId / semantics changed — not a pure content re-upload.
      out.full.push(`pages: page '${c.id}' changed structurally (name/nav/pageId/semantics) — not a content-only re-upload`);
    }
    // structuralSame && !contentDiffers => in the diff for another reason (or a hash tie) → ignore.
  }
  return out;
}

// #3 views: every changed view must be a PURE COLUMN APPEND (prior columns are an exact prefix of current;
// everything else identical). A removed/reordered/edited column set does NOT converge (the engine only
// UNIONS columns and never removes/reorders) → full build + debt. A new view → full build creates it.
function classifyViews(cur, prior) {
  const out = { fast: [], full: [], debt: [] };
  const { added, removed, common } = alignByIdentity(cur.views, prior.views, identityOf.view);
  if (added.length) out.full.push(`views: ${added.length} new view(s) added — a new artifact needs a full build`);
  for (const r of removed) { out.full.push(`views: view '${r.id}' removed`); out.debt.push({ artifactType: 'view', identity: r.id, reason: 'view-removed' }); }
  for (const c of common) {
    const restSame = equalExcept(c.cur, c.prior, ['columns']);
    const colsSame = stableStringify(c.cur.columns || []) === stableStringify(c.prior.columns || []);
    if (restSame && colsSame) continue; // some other slice noise — nothing to do for this view
    if (restSame && isColumnPrefix(c.prior.columns, c.cur.columns) && (c.cur.columns || []).length > (c.prior.columns || []).length) {
      out.fast.push({ shape: 'view', phase: 'views', identity: c.id, detail: `append ${(c.cur.columns || []).length - (c.prior.columns || []).length} column(s)` });
    } else {
      // width/order/filter/sort change, a non-append column edit, or a removal/reorder — the additive
      // engine only unions columns, so this cannot be converged incrementally.
      out.full.push(`views: view '${c.id}' changed beyond a pure column-append (reorder/remove/width/filter/sort) — not convergent`);
      out.debt.push({ artifactType: 'view', identity: c.id, reason: 'view-nonappend-edit' });
    }
  }
  return out;
}

// #4 app-shell: fast ONLY when the SITEMAP structure (appShell) changed but the app object (name /
// description / icon) is byte-identical. An app-icon/description/name change is not a sitemap-only edit.
function classifyAppShell(cur, prior) {
  const out = { fast: [], full: [], debt: [] };
  const appSame = stableStringify(cur.app || null) === stableStringify(prior.app || null);
  const shellSame = stableStringify(cur.appShell || null) === stableStringify(prior.appShell || null);
  if (appSame && !shellSame) {
    out.fast.push({ shape: 'app-shell', phase: 'app-shell', identity: 'sitemap', detail: 'sitemap structure changed (app icon/description unchanged)' });
  } else if (!appSame) {
    out.full.push('app-shell: the app object (name/description/icon) changed — not a sitemap-only edit');
  }
  return out;
}

// Additive-skipped artifacts (charts/commands/dashboards) + web-resources: an ADDED one is created by a
// full build (no debt); an EDITED existing one is SKIPPED by the additive engine (debt); a REMOVED one's
// deletion is unproven (debt). Always full build (never a fast shape in v1).
function classifyAdditive(cur, prior, phase, type, arrKey) {
  const out = { fast: [], full: [], debt: [] };
  const { added, removed, common } = alignByIdentity(cur[arrKey], prior[arrKey], identityOf[type]);
  if (added.length) out.full.push(`${phase}: ${added.length} new ${type}(s) added — full build`);
  for (const r of removed) { out.full.push(`${phase}: ${type} '${r.id}' removed`); out.debt.push({ artifactType: type, identity: r.id, reason: `${type}-removed` }); }
  for (const c of common) {
    if (stableStringify(c.cur) !== stableStringify(c.prior)) {
      out.full.push(`${phase}: ${type} '${c.id}' edited — the additive build engine skips edits to an existing ${type}`);
      out.debt.push({ artifactType: type, identity: c.id, reason: `${type}-edit-not-convergent` });
    }
  }
  return out;
}

// forms: conservatively full build. An ADDED form is created by a full build (no debt). An EDITED existing
// form records a debt-candidate: a pure field-ADD converges (engine appends to the first section) but a
// placement/subgrid/event/quickView edit does NOT — which is which can only be proven at build time
// against the deployed form projection, so the classifier records the debt and the build-time verifier
// clears it iff convergence is proven (design §"Eligibility state machine", Sol build-time note).
function classifyForms(cur, prior) {
  const out = { fast: [], full: [], debt: [] };
  const { added, removed, common } = alignByIdentity(cur.forms, prior.forms, identityOf.form);
  if (added.length) out.full.push(`forms: ${added.length} new form(s) added — full build`);
  for (const r of removed) { out.full.push(`forms: form '${r.id}' removed`); out.debt.push({ artifactType: 'form', identity: r.id, reason: 'form-removed' }); }
  for (const c of common) {
    if (stableStringify(c.cur) !== stableStringify(c.prior)) {
      out.full.push(`forms: form '${c.id}' edited — full build (placement convergence verified at build time)`);
      out.debt.push({ artifactType: 'form', identity: c.id, reason: 'form-edit-verify-at-build' });
    }
  }
  return out;
}

// THE classifier. `current` / `prior` are ANNOTATED specs. Returns:
//   { verdict:'noop'|'fast'|'full', changedPhases, fastChanges, fullReasons, debt }
// verdict 'fast' ⇒ every changed phase yielded a convergent shape (fastChanges) and there are no
// fullReasons; the caller may take the fast path (after the snapshot-eligibility + live drift gates).
function classifyChanges(current, prior) {
  const cur = current || {};
  if (!prior) {
    return { verdict: 'full', changedPhases: diffPhases(cur, null), fastChanges: [], fullReasons: ['no prior snapshot — a first/foreign build is always full'], debt: [] };
  }
  const changedPhases = diffPhases(cur, prior);
  if (changedPhases.length === 0) {
    return { verdict: 'noop', changedPhases: [], fastChanges: [], fullReasons: [], debt: [] };
  }
  const fastChanges = [], fullReasons = [], debt = [];
  const merge = (r) => { fastChanges.push(...r.fast); fullReasons.push(...r.full); debt.push(...r.debt); };

  for (const phase of changedPhases) {
    if (FULL_BUILD_PHASES.has(phase)) {
      fullReasons.push(`${phase}: changed — always a full build`);
      continue;
    }
    switch (phase) {
      case 'pages': merge(classifyPages(cur, prior)); break;
      case 'views': merge(classifyViews(cur, prior)); break;
      case 'app-shell': merge(classifyAppShell(cur, prior)); break;
      case 'forms': merge(classifyForms(cur, prior)); break;
      case 'charts': merge(classifyAdditive(cur, prior, 'charts', 'chart', 'charts')); break;
      case 'commands': merge(classifyAdditive(cur, prior, 'commands', 'command', 'commands')); break;
      case 'dashboards': merge(classifyAdditive(cur, prior, 'dashboards', 'dashboard', 'dashboards')); break;
      case 'web-resources': merge(classifyAdditive(cur, prior, 'web-resources', 'webResource', 'webResources')); break;
      default:
        // An unrecognized changed phase must never silently pass as fast (fail-closed).
        fullReasons.push(`${phase}: changed — no fast-path shape recognized`);
    }
  }

  // Dedup debt (a phase can push the same identity twice across detectors is unlikely, but be safe).
  const debtKey = (d) => `${d.artifactType}\u0000${d.identity}\u0000${d.reason}`;
  const dedupDebt = [...new Map(debt.map((d) => [debtKey(d), d])).values()];

  const verdict = fullReasons.length === 0 && fastChanges.length > 0 ? 'fast' : 'full';
  // Fail-closed: if a phase reported changed but no detector produced a shape OR a reason (a hash tie or
  // annotation artifact), fall to a full build with an explicit reason rather than a silent pass.
  if (verdict === 'full' && fullReasons.length === 0 && fastChanges.length === 0) {
    fullReasons.push('changed phase(s) produced no recognized fast shape — full build (fail-closed)');
  }
  return { verdict, changedPhases, fastChanges, fullReasons, debt: dedupDebt };
}

module.exports = {
  classifyChanges,
  // exported for focused unit tests
  classifyPages,
  classifyViews,
  classifyAppShell,
  classifyForms,
  classifyAdditive,
  isColumnPrefix,
  equalExcept,
  alignByIdentity,
  identityOf,
};
