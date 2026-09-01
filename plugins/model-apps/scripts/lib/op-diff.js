'use strict';

// Read-only destructive-operation classifier for the app-builder safety gate. Given the spec plus
// READ-ONLY discovered state (collision result, deployed explicit-layout forms, deployed app sitemap)
// and — for teardown — the pure teardown plan, it classifies the ops an apply WOULD perform and
// surfaces the DESTRUCTIVE ones so the caller can fail closed unless --allow-destructive is set. This
// module performs NO I/O and holds NO SDK handle: the caller fetches state read-only and passes it in,
// keeping classification pure and offline-testable. See docs/app-builder-design.md §11
// (safety/autopilot) and §14 (additive commands/dashboards).
//
// It REUSES the existing single sources of truth rather than reimplementing them:
//   - formFieldLogicals (artifact-intent.js) — the exact field-logical set a form places, so a removal
//     here is the same set reconcileForm prunes (sdk-build.js:707-733).
//   - planTeardown (sdk-teardown.js) — the ordered destructive delete plan, reused verbatim as the
//     teardown op set (so the gate and the engine can never disagree about what will be deleted).
const { formFieldLogicals } = require('./artifact-intent.js');
const { planTeardown } = require('./sdk-teardown.js');

// Walk a sitemap CONTAINER ({ areas: [{ groups: [{ subAreas: [...] }] }] }) — the shape both the spec's
// `appShell` and a deployed app's structured `.siteMap` use (built by appDef, sdk-build.js:486-527, and
// fetched+rewritten by the app-shell reconcile, sdk-build.js:999-1010). Return the id-comparable
// navigation targets only: entity subareas as `entity:<logical>` and URL subareas as `url:<url>`.
// Dashboard / generative-page subareas are OMITTED in v1 — they have no stable pre-deploy identity to
// compare read-only, so a spec/deployed diff on them would be noise (design §11 v1 scope).
function sitemapTargets(container) {
  const out = [];
  for (const area of (container && container.areas) || []) {
    for (const group of (area.groups) || []) {
      for (const sub of (group.subAreas) || []) {
        if (sub && sub.entity) out.push(`entity:${String(sub.entity).toLowerCase()}`);
        else if (sub && sub.url) out.push(`url:${sub.url}`);
      }
    }
  }
  return out;
}

// The field logicals an EXPLICIT-layout form would remove from its deployed counterpart. Mirrors the
// reconcileForm prune (sdk-build.js:707-733): only an explicit layout prunes; an auto layout is purely
// additive and never removes, so it can never be destructive. `def` is a compiled form intent
// (compileFormIntent); `deployedForm` is the fetched deployed form. Never counts the primary field
// (reconcile never prunes it). Returns [] for an auto layout or when nothing is removed.
function formRemovals(deployedForm, def) {
  if (!def || !def.__explicitLayout) return [];
  const want = new Set(formFieldLogicals(def));
  const primary = def.__primaryField;
  const removed = [];
  for (const logical of formFieldLogicals(deployedForm || {})) {
    if (primary && logical === primary) continue;
    if (!want.has(logical)) removed.push(logical);
  }
  return removed;
}

// Classify the destructive ops an apply WOULD perform against the discovered state. Returns
// { destructive: [{ kind, label, detail }], hasDestructive }. `kind` is one of:
//   'app-collision'      — an app already exists under our unique name. Reusing it rewrites its sitemap
//                          and components (sdk-build.js:999-1010) — a destructive overwrite the caller
//                          must authorize when unattended (design §11). Solution existence is NORMAL and
//                          never flagged here.
//   'form-field-removal' — an explicit-layout form would prune fields off the deployed form.
//   'sitemap-removal'    — the app sitemap rewrite would drop an entity/URL subarea present today.
//   'teardown'           — a planTeardown delete step (opts.teardown mode only).
// `opts.teardown === true` switches to teardown mode: every planTeardown step is destructive.
function classifyOps(spec, discovered = {}, opts = {}) {
  const destructive = [];

  if (opts.teardown) {
    // Teardown is wholly destructive by construction — reuse the pure plan verbatim.
    for (const step of planTeardown(spec)) {
      destructive.push({ kind: 'teardown', label: step.label, detail: step.phase });
    }
    return { destructive, hasDestructive: destructive.length > 0 };
  }

  const col = discovered.collision;
  if (col && col.appExists) {
    destructive.push({
      kind: 'app-collision',
      label: `app "${col.appUnique || (spec.app && spec.app.name) || ''}" already exists`,
      detail: 'reusing it rewrites its sitemap and app components',
    });
  }

  for (const f of discovered.forms || []) {
    const removed = formRemovals(f.deployedForm, f.def);
    if (removed.length) {
      destructive.push({ kind: 'form-field-removal', label: f.label, detail: `removes field(s): ${removed.join(', ')}` });
    }
  }

  if (discovered.sitemap) {
    const want = new Set(discovered.sitemap.wantTargets || []);
    const dropped = (discovered.sitemap.deployedTargets || []).filter((t) => !want.has(t));
    if (dropped.length) {
      destructive.push({ kind: 'sitemap-removal', label: 'app sitemap', detail: `drops navigation target(s): ${dropped.join(', ')}` });
    }
  }

  return { destructive, hasDestructive: destructive.length > 0 };
}

module.exports = { classifyOps, sitemapTargets, formRemovals };
