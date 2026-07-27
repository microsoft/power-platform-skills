'use strict';
// Projection/verifier framework for safe `--changed-only` (design v7, deliverable #1).
//
// PURE + I/O-free. Produces canonical, id-free, normalized PROJECTIONS of the artifacts on the
// `--changed-only` fast path, so a spec-side projection and a deployed-side projection can be compared
// EXACTLY (a mis-placed field add, a stale page, or an out-of-band sitemap edit all produce a different
// projection hash). Static classification alone is NOT trusted — these projections are the post-apply
// EXACT verifiers (Sol design review, High #4).
//
// Three projections, one per convergent shape that has structure worth verifying:
//   · formProjection  — placement-exact: tab/section/row/cell + binding + isRequired + subgrid, NO ids.
//   · sitemapProjection — normalized structural sitemap (GUID casing/braces + env-url noise removed).
//   · page hashing     — source vs deployed bytes are hashed SEPARATELY (cross-page-nav rewrites the
//                        bytes at upload, so the deployed hash ≠ the canonical source hash).

const crypto = require('node:crypto');
const { stableStringify } = require('./phase-diff.js');

// Dataverse control class ids that occupy a cell but are NOT bound form fields (a quick-view even
// carries a fieldName). Kept in sync with artifact-intent.js NON_FIELD_CONTROL_CLASS_IDS.
const NON_FIELD_CONTROL_CLASS_IDS = new Set([
  '5C5600E0-1D6E-4205-A272-BE80DA87FD42', // QuickView
  'E7A81278-8635-4D9E-8D4D-59480B391C5B', // Subgrid / Grid
  '06375649-C143-495E-A496-C962E5B4488E', // Notes / Timeline
]);

function sha256(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Normalize a GUID for comparison: drop braces, lowercase. Non-guid strings pass through lowercased-trim.
function normId(s) {
  return String(s == null ? '' : s).replace(/[{}]/g, '').trim().toLowerCase();
}

function normClassId(id) {
  return String(id || '').replace(/[{}]/g, '').toUpperCase();
}

function isNonFieldControl(ctrl) {
  return !!(ctrl && ctrl.classId && NON_FIELD_CONTROL_CLASS_IDS.has(normClassId(ctrl.classId)));
}

// One cell's projection: a bound field (name + required), a sub-grid (relationship/target/view/label,
// id-normalized), a notes/quick-view control (class + label), or empty. NO layout ids.
function cellProjection(cell) {
  const ctrl = (cell && cell.control) || {};
  if (ctrl.fieldName && !isNonFieldControl(ctrl)) {
    return { field: normId(ctrl.fieldName), required: ctrl.isRequired === true };
  }
  if (ctrl.parameters && ctrl.parameters.RelationshipName) {
    return {
      subgrid: {
        rel: normId(ctrl.parameters.RelationshipName),
        target: normId(ctrl.parameters.TargetEntityType),
        view: normId(ctrl.parameters.ViewId),
        label: String(ctrl.label || ''),
      },
    };
  }
  if (isNonFieldControl(ctrl) && ctrl.fieldName) {
    // quick-view: bound to a lookup but rendered as a card
    return { control: normClassId(ctrl.classId), field: normId(ctrl.fieldName), label: String(ctrl.label || '') };
  }
  if (ctrl.classId) return { control: normClassId(ctrl.classId), label: String(ctrl.label || '') };
  return {};
}

// Placement-EXACT form projection over the NEW topology tabs → columns → sections → rows → cells.
// Captures ORDER + placement + binding + isRequired + subgrid, and NO ids/widths that the adapter
// defaults — so two forms with identical field NAMES but different tab/section/cell/requiredness/subgrid
// produce DIFFERENT projections (Sol adversarial test #1). Works for a compiled intent OR a fetched form.
function formProjection(form) {
  const tabs = (form && form.tabs ? form.tabs : []).map((t) => ({
    label: String(t.label || ''),
    columns: (t.columns || []).map((col) => ({
      sections: (col.sections || []).map((s) => ({
        label: String(s.label || ''),
        cols: s.columns || 1,
        rows: (s.rows || []).map((r) => ({ cells: (r.cells || []).map(cellProjection) })),
      })),
    })),
  }));
  return { entity: normId(form && (form.entityLogicalName || form.entity)), formType: String((form && form.formType) || 'Main'), tabs };
}

function formProjectionHash(form) {
  return sha256(stableStringify(formProjection(form)));
}

// Normalized structural sitemap projection: ordered areas → groups → subareas as {type, ref}, with every
// id normId'd. GUID casing/brace + env-url noise are removed (compare EQUAL), while a reordered / renamed
// / retargeted subarea compares UNEQUAL (Sol adversarial test #3). Accepts the SDK siteMap object shape
// { areas:[{ title/label, groups:[{ title/label, subAreas:[{ type, entity|genPageId|dashboardId|url }] }] }] }.
function sitemapProjection(siteMap) {
  const areas = (siteMap && siteMap.areas ? siteMap.areas : []).map((a) => ({
    label: String(a.title || a.label || ''),
    groups: (a.groups || []).map((g) => ({
      label: String(g.title || g.label || ''),
      subAreas: (g.subAreas || []).map((sa) => subAreaRef(sa)),
    })),
  }));
  return { areas };
}

// A subarea's {type, ref} — env-url + guid noise removed so a $webresource/env-qualified url compares by
// its stable tail, and a genpage/dashboard id compares case/brace-insensitively.
function subAreaRef(sa) {
  if (!sa || typeof sa !== 'object') return { type: 'unknown', ref: '' };
  if (sa.entity) return { type: 'entity', ref: normId(sa.entity) };
  if (sa.genPageId || sa.page) return { type: 'genpage', ref: normId(sa.genPageId || sa.page) };
  if (sa.dashboardId || sa.dashboard) return { type: 'dashboard', ref: normId(sa.dashboardId || sa.dashboard) };
  if (sa.url) return { type: 'url', ref: String(sa.url).replace(/^https?:\/\/[^/]+/i, '').toLowerCase() };
  return { type: 'unknown', ref: '' };
}

function sitemapProjectionHash(siteMap) {
  return sha256(stableStringify(sitemapProjection(siteMap)));
}

module.exports = {
  sha256,
  normId,
  formProjection,
  formProjectionHash,
  sitemapProjection,
  sitemapProjectionHash,
  cellProjection,
};
