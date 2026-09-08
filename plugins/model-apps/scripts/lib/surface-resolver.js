// plugins/model-apps/scripts/lib/surface-resolver.js
// PURE: resolve each `personas[].jobs[].surfaces[]` entry to the App Spec artifact that satisfies it.
//
// WHY this exists. `surfaces[]` is the only machine-readable claim in the spec that says *this job is
// satisfied by these screens*. Until now it was documentary — `app-spec.js` validates that each entry
// is a non-empty string and stops, and `spec-lint.js` warns only when the array is EMPTY. So a job
// could name "My Open Work Orders" when no such view existed anywhere in the spec and every gate
// passed. That is a coherence defect the build cannot catch either: the builder never reads
// `surfaces[]`, so nothing downstream fails.
//
// Deliberately a WARNING, not an error. The shape-only validation in `app-spec.js` is loose on
// purpose — its comment says a surface "may legitimately name an artifact this spec doesn't author
// (a stock view)". A spec that names the OOB "Active Accounts" view is correct and must keep
// validating, so an unresolved surface is reported as a design smell for a human to judge, never a
// hard failure.
'use strict';

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// Every artifact kind a surface may legitimately name, with the field(s) a human would write.
// Sitemap subareas are included because an author frequently names the NAV ENTRY ("Work Orders")
// rather than the underlying view — that is a real answer to "what lets them do the job", so
// treating it as unresolved would produce noise instead of signal.
function buildIndex(spec) {
  const index = new Map(); // normalized name -> [{ kind, name, entity? }]
  const add = (name, entry) => {
    const k = norm(name);
    if (!k) return;
    if (!index.has(k)) index.set(k, []);
    // De-dupe identical (kind,name,entity) triples — e.g. a view named the same as its subarea title
    // would otherwise report twice and read like two separate matches.
    const list = index.get(k);
    if (!list.some((e) => e.kind === entry.kind && norm(e.name) === norm(entry.name) && norm(e.entity || '') === norm(entry.entity || ''))) list.push(entry);
  };

  for (const v of spec.views || []) add(v && v.name, { kind: 'view', name: v.name, entity: v.entity });
  for (const f of spec.forms || []) add(f && f.name, { kind: 'form', name: f.name, entity: f.entity });
  for (const d of spec.dashboards || []) add(d && d.name, { kind: 'dashboard', name: d.name });
  for (const p of spec.pages || []) {
    // A page is referenced by stable KEY in schemaVersion 2 and by display name in prose, so accept
    // either — an author writing the plan will reach for whichever they saw last.
    add(p && p.name, { kind: 'page', name: p.name, key: p.key });
    add(p && p.key, { kind: 'page', name: p.name, key: p.key });
  }
  for (const e of spec.entities || []) {
    // A table itself is a surface when the app exposes it as a nav entry (grid + form). Accept the
    // display name and the schema name.
    add(e && e.displayName, { kind: 'entity', name: e.displayName || e.schemaName, entity: e.schemaName });
    add(e && e.schemaName, { kind: 'entity', name: e.displayName || e.schemaName, entity: e.schemaName });
  }
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    for (const g of (a && a.groups) || []) {
      for (const sa of (g && g.subAreas) || []) add(sa && sa.title, { kind: 'subarea', name: sa.title });
    }
  }
  return index;
}

// Flatten every (persona, job, surface) triple the spec declares. Jobs with no `surfaces[]` are NOT
// reported here — `spec-lint.js` already warns about an unmapped job, and duplicating it would
// double-report the same design gap.
function declaredSurfaces(spec) {
  const out = [];
  for (const p of spec.personas || []) {
    for (const j of (p && p.jobs) || []) {
      for (const s of (j && j.surfaces) || []) {
        if (typeof s === 'string' && s.trim()) out.push({ persona: (p.persona || '').trim(), job: (j.name || '').trim(), surface: s.trim() });
      }
    }
  }
  return out;
}

// Resolve every declared surface against the spec's own artifacts.
// Returns { resolved: [{ persona, job, surface, matches:[{kind,...}] }], unresolved: [{ persona, job, surface }] }.
function resolveSurfaces(spec) {
  const resolved = [];
  const unresolved = [];
  if (!spec || typeof spec !== 'object') return { resolved, unresolved };
  const index = buildIndex(spec);
  for (const d of declaredSurfaces(spec)) {
    const matches = index.get(norm(d.surface));
    if (matches && matches.length) resolved.push({ ...d, matches: matches.slice() });
    else unresolved.push({ ...d });
  }
  return { resolved, unresolved };
}

// The lint/verify message for an unresolved surface. Shared so the two gates cannot word the same
// finding differently — a maker who sees it twice should see it identically.
function unresolvedSurfaceMessage(u) {
  return `persona "${u.persona}" job "${u.job}": surface "${u.surface}" does not match any view, form, page, dashboard, table or sitemap entry in this spec — either it names an out-of-the-box artifact (fine) or the job is not actually covered by anything this app builds.`;
}

module.exports = { resolveSurfaces, declaredSurfaces, unresolvedSurfaceMessage };
