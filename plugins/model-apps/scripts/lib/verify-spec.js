'use strict';
// Reconcile an App Spec against a DEPLOYED app: for every declared entity/column/view/chart/form and
// every sitemap subarea (+ icon), check whether it actually exists server-side. Catches silent
// partial builds. Pure/testable: `read` provides the server lookups; `verifySpec` returns
// { ok, checks:[{kind,name,present,detail}], missing:[…] }.

const { odataLit } = require('./odata.js');
const { normalizePageSource } = require('./app-spec.js');
const { extractNavTargets } = require('./pageref-resolver.js');

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
    const rows = await read.queryRecords('savedquery', { select: ['savedqueryid'], filter: `returnedtypecode eq '${String(v.entity).toLowerCase()}' and name eq '${odataLit(v.name)}'`, top: 1 });
    add('view', v.name, rows && rows[0]);
  }
  for (const ch of spec.charts || []) {
    const rows = await read.queryRecords('savedqueryvisualization', { select: ['savedqueryvisualizationid'], filter: `primaryentitytypecode eq '${String(ch.entity).toLowerCase()}' and name eq '${odataLit(ch.name)}'`, top: 1 });
    add('chart', ch.name, rows && rows[0]);
  }
  for (const f of spec.forms || []) {
    const name = f.name || `${f.entity} form`;
    const rows = await read.queryRecords('systemform', { select: ['formid'], filter: `objecttypecode eq '${String(f.entity).toLowerCase()}' and name eq '${odataLit(name)}'`, top: 1 });
    add('form', name, rows && rows[0]);
  }

  // Sitemap subareas (+ icons). Scope every check to the specific element type (and, for a subarea
  // icon, the owning entity) so an icon/entity value reused elsewhere in the XML can't satisfy an
  // unrelated check (e.g. an Area icon must not make a missing SubArea icon look present).
  const xml = (await read.sitemapXml()) || '';
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    if (a.icon) add('area-icon', a.label || '', hasElement(xml, 'Area', { Icon: a.icon }));
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

  const missing2 = checks.filter((c) => !c.present);
  // Keep unableToRun absent (undefined) on the normal path so existing callers and tests are unaffected.
  return { ok: missing2.length === 0 && !unableToRun, checks, missing: missing2, unableToRun: unableToRun || undefined };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

module.exports = { verifySpec, hasElement, subareaHasDashboard, subareaHasGenPage, appShellReferencesPage };
