'use strict';
// Reconcile an App Spec against a DEPLOYED app: for every declared entity/column/view/chart/form and
// every sitemap subarea (+ icon), check whether it actually exists server-side. Catches silent
// partial builds. Pure/testable: `read` provides the server lookups; `verifySpec` returns
// { ok, checks:[{kind,name,present,detail}], missing:[…] }.

const { odataLit } = require('./odata.js');
const { normalizePageSource, relationshipSchemaName, manyToManySchemaName, SDK_ROLE_MARKER, canonicalPersonaName } = require('./app-spec.js');
const { resolveExistingFormId, resolveRoleBusinessUnit, roleBuClause, appUniqueName } = require('./sdk-build.js');
const { extractNavTargets } = require('./pageref-resolver.js');
const { AI_APP_SETTING, resolveAiFlags, featureWantValue, sameSettingValue, resolveAppModuleId, proveAppOverride } = require('./ai-app-settings.js');

// The PER-APP setting each AI feature writes now lives in ./ai-app-settings.js, together with the
// flag-resolution and override-proof helpers the BUILD uses — see that module for why one source of
// truth matters here. Re-exported below so existing importers of this file keep working.

async function verifySpec(spec, read) {
  const checks = [];
  const add = (kind, name, present, detail) => checks.push({ kind, name, present: !!present, detail: detail || '' });

  // Entities + their declared columns.
  for (const e of spec.entities || []) {
    const logical = e.schemaName.toLowerCase();
    const tbl = await read.findTable(logical);
    add('entity', e.schemaName, tbl);
    if (tbl) {
      const cols = new Set(((await read.findColumns(logical)) || []).map((c) => String(c.logicalName || c).toLowerCase()));
      for (const c of e.columns || []) add('column', `${e.schemaName}.${c.schemaName}`, cols.has(String(c.schemaName).toLowerCase()));
    }
  }

  // Views / charts / forms — by (entity, name) identity.
  for (const v of spec.views || []) {
    const viewName = `${String(v.entity).toLowerCase()}.${v.name}`;
    // Also select layoutxml so a CONTENT check can catch a view whose column set drifted from the spec
    // (reconcileView is additive-union, so a removed/renamed spec column would otherwise silently NOT
    // apply and still pass an existence-only verify). Best-effort: the column check only runs when the
    // deployed row actually carries layoutxml — an existence-only reader (no layoutxml) skips it.
    const rows = await read.queryRecords('savedquery', { select: ['savedqueryid', 'layoutxml'], filter: `returnedtypecode eq '${String(v.entity).toLowerCase()}' and name eq '${odataLit(v.name)}'`, top: 1 });
    const row = rows && rows[0];
    add('view', viewName, row);
    const specCols = (v.columns || []).map((c) => String(c).toLowerCase());
    if (row && row.layoutxml && specCols.length) {
      // Deployed column set from the saved view's layoutxml (<cell name="…"/> per column). We require
      // spec columns ⊆ deployed columns (NOT set-equality): a deployed EXTRA column (default-view
      // enrichment, or a maker's manual add) is fine; a MISSING spec column is the divergence we flag.
      const deployed = new Set(layoutColumnNames(row.layoutxml));
      const missingCols = specCols.filter((c) => !deployed.has(c));
      add('view-columns', viewName, missingCols.length === 0, missingCols.length ? `missing column(s): ${missingCols.join(', ')}` : '');
    }
  }
  for (const ch of spec.charts || []) {
    const rows = await read.queryRecords('savedqueryvisualization', { select: ['savedqueryvisualizationid'], filter: `primaryentitytypecode eq '${String(ch.entity).toLowerCase()}' and name eq '${odataLit(ch.name)}'`, top: 1 });
    add('chart', ch.name, rows && rows[0]);
  }
  for (const f of spec.forms || []) {
    const name = f.name || `${f.entity} form`;
    // Resolve with the SAME identity the build reconcile uses — (entity, name, TYPE) or a validated pinned
    // formId (which checks the row's table/type/name) — so verify can't be fooled by a same-named sibling
    // of another type, a mismatched pin, or a residual (entity,type,name) collision. resolveExistingFormId
    // THROWS on a collision / bad pin → treat as NOT cleanly present (present:false surfaces the problem);
    // a not-yet-created table (MetadataCache 400) resolves to null → correctly reported missing.
    let id = null;
    try {
      id = await resolveExistingFormId(read, { entityLogicalName: String(f.entity).toLowerCase(), name, formType: f.formType, formId: f.formId });
    } catch { id = null; }
    add('form', name, id);
  }

  // Relationships (existence) — currently a build can declare a relationship that silently fails to
  // materialize and still pass verify (relationships weren't checked at all). Best-effort: only when the
  // reader can list a child entity's relationship schema names (`entityRelationships`). Match the same
  // schema name the build/teardown compute (relationshipSchemaName / manyToManySchemaName), so an
  // explicit schemaName or an auto-prefixed system-table relationship is compared correctly.
  if (typeof read.entityRelationships === 'function') {
    const prefix = spec.solution && spec.solution.publisherPrefix;
    const relCache = new Map(); // childLogical -> Set(schemaName lower) — one metadata read per child
    for (const r of spec.relationships || []) {
      const schema = String(r.type === 'ManyToMany' ? manyToManySchemaName(r, prefix) : relationshipSchemaName(r, prefix)).toLowerCase();
      // A 1:N relationship lives on the referencing (child) entity; an N:N is symmetric — check entity1.
      const child = String((r.type === 'ManyToMany' ? (r.entity1 || r.entity2) : r.referencing) || '').toLowerCase();
      if (!child) continue;
      if (!relCache.has(child)) {
        let names = [];
        try { names = (await read.entityRelationships(child)) || []; } catch { names = []; }
        relCache.set(child, new Set(names.map((n) => String(n).toLowerCase())));
      }
      add('relationship', schema, relCache.get(child).has(schema));
    }
  }

  // Commands (existence) — a spec can declare a command bar that didn't build and still pass verify
  // (commands weren't checked). The SDK models one command bar per entity, so verify per entity. Best-
  // effort: only when the reader can resolve a command bar (`commandBar(entity)` -> truthy when present).
  if (typeof read.commandBar === 'function') {
    const cmdEntities = new Set((spec.commands || []).map((c) => String(c.entity).toLowerCase()));
    for (const entity of cmdEntities) {
      let present = false;
      try { present = !!(await read.commandBar(entity)); } catch { present = false; }
      add('command', `${entity} command bar`, present);
    }
  }

  // Sitemap subareas (+ icons). Scope every check to the specific element type (and, for a subarea
  // icon, the owning entity) so an icon/entity value reused elsewhere in the XML can't satisfy an
  // unrelated check (e.g. an Area icon must not make a missing SubArea icon look present).
  const xml = (await read.sitemapXml()) || '';
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    if (a.icon) add('area-icon', a.label || '', hasElement(xml, 'Area', { Icon: a.icon }));
    if (a.vectorIcon) add('area-vectorIcon', a.label || '', hasElement(xml, 'Area', { VectorIcon: a.vectorIcon }));
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.entity) add('subarea', sa.title || sa.entity, hasElement(xml, 'SubArea', { Entity: sa.entity }));
        if (sa.dashboard) {
          // Resolve the declared dashboard (a system dashboard = systemform type 0) by name, then
          // confirm the sitemap points a SubArea at THAT dashboard id — not just that some dashboard
          // subarea exists. Missing/unresolvable dashboard => not present.
          const rows = await read.queryRecords('systemform', { select: ['formid'], filter: `type eq 0 and name eq '${odataLit(sa.dashboard)}'`, top: 1 });
          const dashId = rows && rows[0] && rows[0].formid;
          add('subarea', sa.title || sa.dashboard, dashId ? subareaHasDashboard(xml, dashId) : false);
        }
        if (sa.icon) {
          // Prefer matching the icon on the SubArea that also declares this entity; fall back to any
          // SubArea carrying the icon when the subarea has no entity identity.
          const present = sa.entity ? hasElement(xml, 'SubArea', { Entity: sa.entity, Icon: sa.icon }) : hasElement(xml, 'SubArea', { Icon: sa.icon });
          add('subarea-icon', sa.title || '', present);
        }
        if (sa.vectorIcon) {
          // VectorIcon serializes as its own sitemap attribute, so check it independently from the
          // raster Icon attribute while keeping the same SubArea scoping rules.
          const present = sa.entity ? hasElement(xml, 'SubArea', { Entity: sa.entity, VectorIcon: sa.vectorIcon }) : hasElement(xml, 'SubArea', { VectorIcon: sa.vectorIcon });
          add('subarea-vectorIcon', sa.title || '', present);
        }
      }
    }
  }

  // Pages (design §13.1). Match BY ID against three authorities — IDENTITY (manifest), EXISTENCE
  // (env-wide id set), MEMBERSHIP (app sitemap ids). Reader must supply sitemapPageIds(),
  // existenceIds(), manifest(), and pageCode(id) when any page has nav. Fail-closed (Imp7):
  // reader-incapacity OR an absent/uncorrelatable manifest on a page-bearing spec → unableToRun
  // (NOT "every page missing" — without an id correlation we cannot tell what is there vs. absent).
  const implementedPages = (spec.pages || []).filter((p) => { const s = normalizePageSource(p); return s && s.kind === 'tsx' && s.codeFile; });
  const hasNavPages = implementedPages.some((p) => (p.navigatesTo || []).length > 0);
  // Reader-incapacity: required methods absent → cannot run, distinct from pages being absent in live.
  let unableToRun = !!(implementedPages.length && (
    typeof read.sitemapPageIds !== 'function' ||
    typeof read.existenceIds !== 'function' ||
    typeof read.manifest !== 'function'
  )) || !!(hasNavPages && typeof read.pageCode !== 'function');
  if (implementedPages.length) {
    if (unableToRun) {
      // Reader is missing required page-authority methods — add a sentinel check and skip the loop.
      add('page-verify', 'pages', false, 'the verify reader cannot read existence / membership / manifest (unable to run)');
    } else {
      // ONE cached snapshot of each authority (Imp7 — never re-query per page). Throws from
      // sitemapPageIds/existenceIds propagate out of verifySpec; the build gate's try/catch converts them
      // to a non-zero exit (design §13.1). The caller that constructed the reader bears fail-closed responsibility.
      const sitemapIds = new Set((await read.sitemapPageIds()).map((id) => String(id).toLowerCase()));
      const existenceIds = new Set((await read.existenceIds()).map((id) => String(id).toLowerCase()));
      const man = await read.manifest();
      // Build key→id from the manifest (IDENTITY authority). A spec page's own pageId (edit-snapshot,
      // C3) OUTRANKS the manifest entry for the same key — use idOf() consistently.
      const idByKey = new Map(
        ((man && man.pages) || [])
          .filter((p) => p && p.key && p.pageId)
          .map((p) => [p.key, p.pageId]),
      );
      // idOf: spec pageId first (highest authority), then manifest key→id (C3 outranks C1).
      const idOf = (p) => p.pageId || idByKey.get(p.key || p.name);
      // Imp7: if NO implemented page can be given an id (manifest empty/absent AND no spec pageIds),
      // the verifier cannot correlate spec pages to live ids → unableToRun (page-identity), NOT N misses.
      const resolvable = implementedPages.filter((p) => !!idOf(p));
      if (resolvable.length === 0) {
        unableToRun = true;
        add('page-verify', 'pages', false, 'the page manifest is missing/empty/uncorrelatable — cannot map any spec page to a deployed id (page-identity)');
      } else {
        // specIds tracks which live ids are accounted for by spec pages (for set-equality below).
        const specIds = new Set();
        for (const p of implementedPages) {
          const key = p.key || p.name;
          const id = idOf(p);
          if (!id) {
            // Partially-resolvable manifest: some pages have ids, this one doesn't — emit a specific miss.
            add('page', p.name, false, 'no manifest/spec id for this page (page-identity)');
            continue;
          }
          specIds.add(String(id).toLowerCase());
          // page present ⟺ id ∈ existenceIds (deployed env-wide) AND id ∈ sitemapIds (placed in this app).
          // Both conditions required: existence alone doesn't mean the page belongs to this app.
          const present = existenceIds.has(String(id).toLowerCase()) && sitemapIds.has(String(id).toLowerCase());
          add('page', p.name, present);
          if (!present) continue;
          // page-subarea: verify the sitemap XML specifically carries a GenPageId="<id>" binding.
          // Only emitted when the appShell references this page key (headless pages have no subarea to verify).
          if (appShellReferencesPage(spec, key)) add('page-subarea', p.name, subareaHasGenPage(xml, id));
          const nav = p.navigatesTo || [];
          if (!nav.length) continue;
          let code;
          try {
            // Download THAT page's code by id (not all pages) — the real reader caches per id.
            code = (await read.pageCode(id)) || '';
          } catch (e) {
            // A single page's download blip is a specific verifiable miss, not reader-incapacity.
            add('page-code', p.name, false, String((e && e.message) || e));
            continue;
          }
          // THE SINGLE STRUCTURAL ORACLE: parse the deployed page's real navigateTo call sites.
          // A decoy id in a comment, a stale GUID, or a dynamic pageId all FAIL (C1).
          const targets = extractNavTargets(code);
          // No residual/malformed PAGEREF_ in deployed code means the resolve+upload step ran on this page.
          add('page-no-pageref', p.name, !targets.some((t) => t.kind === 'pageref' || t.kind === 'pageref-malformed'));
          // Every declared nav edge must resolve to the ACTUAL target's deployed id at a REAL call site.
          const navLiteralIds = new Set(targets.filter((t) => t.kind === 'literal').map((t) => String(t.pageId).toLowerCase()));
          for (const edge of nav) {
            // Target id via the same resolution order (spec pageId > manifest) for nav targets.
            const targetPage = (spec.pages || []).find((pp) => (pp.key || pp.name) === edge.targetKey);
            const targetId = targetPage ? idOf(targetPage) : undefined;
            add('page-nav', `${p.name} -> ${edge.targetKey}`, !!targetId && navLiteralIds.has(String(targetId).toLowerCase()));
          }
        }
        // Set-equality (Imp7): a live sitemap page not mapped by any spec page's id → page-extra.
        // The deployed app has a page the spec doesn't declare — surface it rather than silently ignore.
        for (const liveId of sitemapIds) {
          if (!specIds.has(liveId)) add('page-extra', liveId, false, 'a sitemap page not declared in the spec');
        }
      }
    }
  }

  // Persona security roles. Existence + SDK-ownership is a sufficient content oracle here (unlike the
  // additive view/form checks): the SDK applies a role's privileges with ReplacePrivilegesRole, so an
  // existing role the SDK authored necessarily holds exactly its declared (converged) privilege set —
  // there is no additive-drift path where the role exists but a privilege silently failed to apply. We
  // therefore verify the role exists AND carries the SDK ownership marker (a same-name role someone
  // else built would pass a bare existence check but is NOT the role the security phase authored).
  const roleBuCache = {}; // memoize the root-BU lookup across personas in this verify pass
  for (const p of spec.personas || []) {
    const roleName = canonicalPersonaName(p); // trimmed — matches the SDK's created name
    if (!roleName) continue;
    let row;
    try {
      // Roles table (logical `role`); exact-match name literal, scoped to the persona's business unit
      // (explicit, else the org root BU) so a same-named marker role in a DIFFERENT BU can't false-pass
      // the check. FAIL CLOSED if the BU can't be resolved: report the role missing rather than fall back
      // to a name-only match that could pass on the wrong BU's role. Best-effort on a reader without role
      // support (no queryRecords): `row` stays undefined and the check fails loudly as "missing".
      const bu = await resolveRoleBusinessUnit((e, o) => read.queryRecords(e, o), p.businessUnitId, roleBuCache);
      if (bu) {
        const rows = await read.queryRecords('role', { select: ['roleid', 'description', 'ismanaged'], filter: `name eq '${odataLit(roleName)}'${roleBuClause(bu)}`, top: 5 });
        row = (rows || []).find((r) => r.ismanaged !== true && (r.description || '') === SDK_ROLE_MARKER);
      }
    } catch { row = undefined; }
    add('role', roleName, row, row ? '' : 'persona security role not found (or its business unit could not be resolved)');
  }

  // AI app features. The verifier previously had NO awareness of `spec.ai` at all, so a build whose
  // every requested AI feature was skipped (admin gate off) or silently not persisted still reported a
  // clean PASS — a false success signal for automation (ADO 6603383).
  //
  // The oracle is the APP-SCOPE OVERRIDE ROW, not the effective value. `RetrieveSetting(name,
  // { appUniqueName })` FALLS BACK to the environment value when the app has no override, so a
  // matching effective read does NOT prove the build's app-scope write landed: if the environment
  // already holds the requested value, a write the platform silently ignored reads back as a match
  // and verify reports PASS for a feature that was never applied to this app. That is precisely the
  // false-PASS in ADO 6603383, so this proves the override in `appsettings` instead — the same
  // authoritative signal the SDK's own `setAppAiFeatures` uses to decide its `applied` bucket.
  //
  // CRITICAL: the set checked here is `resolveAiFlags(spec)`, the EXACT set the build writes — not
  // `spec.ai.appFeatures`. The build seeds a default for every feature whenever `spec.ai` exists, so
  // reconciling only what a spec DECLARED left a spec with `ai.summaries` and no `ai.appFeatures`
  // with three features written and ZERO verified: a clean PASS for features the platform may never
  // have stored. One resolver, both callers.
  //
  // A feature the org gate SKIPPED therefore fails here, which is intended: the spec asked for it and
  // it is not configured on the app. The effective value is still read, but only as context in the
  // failure message ("in effect as X by environment fallback").
  //
  // Reader-gated like the other content checks: this needs BOTH `retrieveSetting` (context) and
  // `queryRecords` (the proof), so an existence-only reader skips it entirely rather than falling
  // back to the unsound effective-value compare. The shipped CLI reader has both.
  const requestedFeatures = resolveAiFlags(spec);
  if (requestedFeatures && typeof read.retrieveSetting === 'function' && typeof read.queryRecords === 'function') {
    // MUST be the same identity the build wrote under — `appUniqueName(spec)`, which falls back to
    // `<publisherPrefix>_<app.name>` for an authored spec that carries no explicit `app.uniqueName`
    // (neither shipped sample does, and hydrate never emits `ai`, so that is the COMMON case). Reading
    // `spec.app.uniqueName` directly yields undefined there, and the SDK omits the `AppUniqueName` path
    // segment when it is absent — which silently reads the ENVIRONMENT-scoped value instead of the app's.
    const appUnique = appUniqueName(spec);
    // Resolved ONCE for the whole loop (see ai-app-settings.js for why it is never cached longer).
    const app = await resolveAppModuleId(read, appUnique);
    for (const [feature, requested] of Object.entries(requestedFeatures)) {
      const setting = AI_APP_SETTING[feature];
      if (!setting) continue; // unknown key — validation already reports it
      const want = featureWantValue(requested);

      // (1) Authoritative: does an app-scope override row exist, holding `want`?
      const proof = app.error ? { error: app.error } : await proveAppOverride(read, app.appModuleId, setting);

      // (2) Context only: what is currently in force (may be the ENVIRONMENT fallback). This read is
      //     genuinely non-load-bearing — it never participates in the comparison, so a transport
      //     failure here can only cost detail in a message, never flip the verdict.
      let effective;
      try {
        const res = await read.retrieveSetting(setting, { appUniqueName: appUnique });
        effective = res && res.value !== undefined && res.value !== null ? String(res.value).trim() : '';
      } catch { /* informational only */ }

      // Fail-closed: when the proof could not be run we could LOOK and looking failed, so we must not
      // claim PASS on the strength of a value that may simply be the environment default.
      const present = !proof.error && proof.exists && sameSettingValue(proof.value, want);
      const inForce = effective === undefined ? '(unreadable)' : effective === '' ? '(unset)' : effective;
      add('ai-feature', feature, present, present ? '' :
        proof.error
          ? `could not prove the app-scope setting '${setting}' was applied: ${proof.error}`
          : !proof.exists
            ? `requested '${want}' but this app has NO app-scope override for '${setting}' (it is in effect as '${inForce}' only by environment fallback, so the app was never configured)`
            : `requested '${want}' but the app-scope override for '${setting}' holds '${proof.value === '' || proof.value === undefined ? '(empty)' : proof.value}'`);
    }
  }

  const missing2 = checks.filter((c) => !c.present);
  // Keep unableToRun absent (undefined) on the normal path so existing callers and tests are unaffected.
  return { ok: missing2.length === 0 && !unableToRun, checks, missing: missing2, unableToRun: unableToRun || undefined };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Extract the deployed column logical names from a saved view's layoutxml. Shape (Dataverse grid
// layout), e.g.:
//   <grid name='resultset' ...><row ...><cell name='new_name' width='200' /><cell name='new_status' /></row></grid>
// Only <cell name="…"> carries a column; attribute order varies and quotes may be single or double, so
// match the `name` attribute on a `<cell` start-tag specifically (a `name` on <grid>/<row> is not a
// column). Returned lower-cased for case-insensitive comparison with spec column logical names.
function layoutColumnNames(xml) {
  const out = [];
  const re = /<cell\b[^>]*?\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) out.push(String(m[1] != null ? m[1] : m[2]).toLowerCase());
  return out;
}

// True when the sitemap XML contains a `<tag ...>` start-tag whose attributes include every
// name="value" pair in `attrs` (order-independent, scoped to a single element). Used so icon/entity
// checks match on the intended element type rather than anywhere in the document.
function hasElement(xml, tag, attrs) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const pairs = Object.entries(attrs);
  let m;
  while ((m = re.exec(xml)) !== null) {
    const startTag = m[0];
    if (pairs.every(([name, val]) => new RegExp(`\\b${escapeRe(name)}="${escapeRe(String(val))}"`, 'i').test(startTag))) return true;
  }
  return false;
}

// True when some `<SubArea ... DefaultDashboard="...">` in the sitemap points at `dashId`. Dataverse
// may store the GUID with braces and/or upper-cased, so compare normalized (braces stripped, lower).
function subareaHasDashboard(xml, dashId) {
  const norm = (s) => String(s).replace(/[{}]/g, '').toLowerCase();
  const target = norm(dashId);
  const re = /<SubArea\b[^>]*\bDefaultDashboard="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) if (norm(m[1]) === target) return true;
  return false;
}

// True when some sitemap `<SubArea GenPageId="<id>">` in the XML binds this page id. Generative-page
// subareas store the id in the GenPageId attribute SPECIFICALLY (vendor cds-maker-sdk.cjs:50 parses
// /GenPageId="([0-9a-fA-F-]{36})"/), so match THAT attribute only — a decoy id elsewhere on the
// SubArea start-tag (e.g. Url, Id) must NOT satisfy the check. Braces stripped, case-insensitive.
function subareaHasGenPage(xml, genPageId) {
  const norm = (s) => String(s).replace(/[{}]/g, '').toLowerCase();
  const target = norm(genPageId);
  const re = /<SubArea\b[^>]*\bGenPageId="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) if (norm(m[1]) === target) return true;
  return false;
}

// True when any appShell subarea targets this page key (via `s.page === key`), indicating the sitemap
// MUST carry a `<SubArea GenPageId="…">` binding for this page. An unreferenced (headless) page has
// no sitemap entry to verify, so the page-subarea check is only emitted when this returns true.
function appShellReferencesPage(spec, key) {
  for (const a of (spec.appShell && spec.appShell.areas) || [])
    for (const g of a.groups || [])
      for (const s of g.subAreas || []) if (s && s.page === key) return true;
  return false;
}

module.exports = { verifySpec, hasElement, subareaHasDashboard, subareaHasGenPage, appShellReferencesPage, layoutColumnNames };
