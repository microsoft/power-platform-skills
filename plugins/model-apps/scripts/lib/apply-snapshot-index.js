'use strict';
// Populate the apply-snapshot `artifacts` map from a completed build (changed-only integration).
//
// After a full apply, the snapshot must record — for every artifact — the LIVE id and the content/
// projection hashes the fast path will later re-resolve and verify against. This is the seam between the
// build engine's `result.created` (whose key conventions are QUIRKY: views keyed by NAME only, Main forms
// keyed by entity-logical, app is a scalar id) and the snapshot's CANONICAL identities (identityOf from
// classify-changes.js, e.g. `entity|name`). Keeping the canonical identity in one place (DRY) means the
// classifier and the snapshot agree on what "the same view" means.
//
// PURE + I/O-free: every id comes from `created`, every hash from the annotated spec or the injected
// `opts` (formProjections / viewProjections / sitemapSha / pageDeployedShas), which the flow computes from
// the definitions it actually deployed. Absent inputs are simply omitted — a partial map is safe (the fast
// path re-resolves live and treats a missing entry as "must full-build that artifact").

const { identityOf } = require('./classify-changes.js');

function low(s) { return String(s == null ? '' : s).toLowerCase(); }

// Build artifacts = { pages, forms, views, app, webResources, entities, charts, commands, dashboards }.
// created = result.created from sdk-build; opts carries the build-time hashes the fast path verifies with.
function indexArtifacts(spec, created, opts = {}) {
  const s = spec || {};
  const c = created || {};
  const out = { pages: {}, forms: {}, views: {}, app: {}, webResources: {}, entities: {}, charts: {}, commands: {}, dashboards: {} };
  const pageDeployedShas = opts.pageDeployedShas || {};
  const formProjections = opts.formProjections || {};
  const viewProjections = opts.viewProjections || {};
  const viewNameCounts = new Map();
  for (const v of Array.isArray(s.views) ? s.views : []) {
    if (!v || typeof v !== 'object') continue;
    const name = String(v.name || '');
    viewNameCounts.set(name, (viewNameCounts.get(name) || 0) + 1);
  }

  // pages — canonical key is the page key; value carries the live pageId, the SOURCE hash (raw .tsx bytes,
  // = the annotated __contentSha) and the DEPLOYED hash (post-nav-resolution bytes, may differ when
  // cross-page nav rewrote the source; defaults to source when the flow didn't stage a distinct deployed).
  for (const p of Array.isArray(s.pages) ? s.pages : []) {
    if (!p || typeof p !== 'object') continue;
    const key = identityOf.page(p);
    const pageId = c.pages && c.pages[key];
    if (!pageId) continue; // an intent page or one that wasn't deployed — nothing to record
    out.pages[key] = {
      pageId,
      sourceSha: p.__contentSha != null ? p.__contentSha : null,
      deployedSha: pageDeployedShas[key] != null ? pageDeployedShas[key] : (p.__contentSha != null ? p.__contentSha : null),
    };
  }

  // views — canonical key `entity|name`; created.views is keyed by NAME only.
  for (const v of Array.isArray(s.views) ? s.views : []) {
    if (!v || typeof v !== 'object') continue;
    // Fail closed on duplicate view names: result.created.views cannot disambiguate same-named
    // views across entities, so recording either id could poison the changed-only snapshot.
    if (viewNameCounts.get(String(v.name || '')) > 1) continue;
    const key = identityOf.view(v);
    const viewId = c.views && c.views[v.name];
    if (!viewId) continue;
    const entry = { viewId };
    if (viewProjections[key] != null) entry.projSha = viewProjections[key];
    out.views[key] = entry;
  }

  // forms — canonical key `entity|formType|name`; created.forms holds Main forms keyed by entity-logical.
  for (const f of Array.isArray(s.forms) ? s.forms : []) {
    if (!f || typeof f !== 'object') continue;
    const key = identityOf.form(f);
    const formId = (f.formType || 'Main') === 'Main' ? c.forms && c.forms[low(f.entity)] : undefined;
    if (!formId) continue; // only Main forms are id-tracked by the engine today
    const entry = { formId };
    if (formProjections[key] != null) entry.projSha = formProjections[key];
    out.forms[key] = entry;
  }

  // app — scalar id + the deployed sitemap projection hash (drift detection for the sitemap fast shape).
  if (c.app) out.app.appId = c.app;
  if (opts.sitemapSha != null) out.app.sitemapSha = opts.sitemapSha;

  // web resources — id + source hash (content edits are additive-skipped, so the hash is how the classifier
  // even SEES a change; the fast path never applies one, but the recorded hash lets it detect divergence).
  for (const w of Array.isArray(s.webResources) ? s.webResources : []) {
    if (!w || typeof w !== 'object') continue;
    const id = c.webResources && c.webResources[w.name];
    if (!id) continue;
    out.webResources[w.name] = { id, sourceSha: w.__contentSha != null ? w.__contentSha : null };
  }

  // entities / charts / commands / dashboards — id-only, for live re-resolution + absence checks. Charts and
  // dashboards are keyed by name, commands + entities by logical, mirroring created's conventions.
  for (const e of Array.isArray(s.entities) ? s.entities : []) {
    if (!e || typeof e !== 'object') continue;
    const id = c.entities && (c.entities[low(e.schemaName)] || c.entities[e.schemaName]);
    if (id) out.entities[low(e.schemaName)] = { id };
  }
  for (const ch of Array.isArray(s.charts) ? s.charts : []) {
    if (!ch || typeof ch !== 'object') continue;
    const id = c.charts && c.charts[ch.name];
    if (id) out.charts[identityOf.chart(ch)] = { id };
  }
  for (const cm of Array.isArray(s.commands) ? s.commands : []) {
    if (!cm || typeof cm !== 'object') continue;
    const id = c.commands && c.commands[low(cm.entity)];
    if (id) out.commands[identityOf.command(cm)] = { id };
  }
  for (const d of Array.isArray(s.dashboards) ? s.dashboards : []) {
    if (!d || typeof d !== 'object') continue;
    const id = c.dashboards && c.dashboards[d.name];
    if (id) out.dashboards[identityOf.dashboard(d)] = { id };
  }

  return out;
}

module.exports = { indexArtifacts };
