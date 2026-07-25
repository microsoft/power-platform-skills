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

  // Pages (design §13.1). When the spec declares implemented pages the reader MUST be able to read them:
  // if it lacks a page enumeration, verification CANNOT run and must FAIL (fail-closed, C6), not silently
  // pass. read.pages()/read.pageCode() themselves throw on an enumeration/download failure — the mandatory
  // build gate turns that into a non-zero exit.
  const implementedPages = (spec.pages || []).filter((p) => { const s = normalizePageSource(p); return s && s.kind === 'tsx' && s.codeFile; });
  // Reader-incapacity: the verifier simply cannot enumerate or fetch page code. This is distinct from
  // an ordinary failed check (page absent from live). unableToRun:true signals the build gate (C6).
  const unableToRun = !!(implementedPages.length && typeof read.pages !== 'function') ||
    !!(implementedPages.some((p) => (p.navigatesTo || []).length > 0) && typeof read.pageCode !== 'function');
  if (implementedPages.length) {
    if (unableToRun) {
      // Reader is incapable of verifying pages — add a sentinel check and skip the per-page loop.
      add('page-verify', 'pages', false, 'the verify reader cannot enumerate pages (unable to run)');
    } else {
      // read.pages() is left UNWRAPPED so a throw (enumeration failure) propagates out of verifySpec.
      // The mandatory build gate's try/catch turns it into an unableToRun result (design §13.1).
      const live = (await read.pages()) || [];
      const liveByName = new Map(live.filter((p) => p.name && p.pageId).map((p) => [p.name, p.pageId]));
      // Resolve the live GenPageId for a declared page key: look up the page by key/name and map its
      // name → live id. Used for nav-edge checks.
      const idForKey = (key) => { const pg = (spec.pages || []).find((p) => (p.key || p.name) === key); return pg ? liveByName.get(pg.name) : undefined; };
      for (const p of implementedPages) {
        const key = p.key || p.name;
        const pageId = liveByName.get(p.name);
        add('page', p.name, !!pageId);
        if (!pageId) continue;
        // Only emit a page-subarea check when the appShell actually references this page by key —
        // an unreferenced (headless) page has no sitemap entry to verify.
        if (appShellReferencesPage(spec, key)) add('page-subarea', p.name, subareaHasGenPage(xml, pageId));
        const nav = p.navigatesTo || [];
        if (!nav.length) continue;
        let code;
        try {
          code = (await read.pageCode(pageId)) || '';
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
        // Every declared nav edge must resolve to the ACTUAL target's live GenPageId at a REAL call site.
        const navLiteralIds = new Set(targets.filter((t) => t.kind === 'literal').map((t) => String(t.pageId).toLowerCase()));
        for (const edge of nav) {
          const targetId = idForKey(edge.targetKey);
          add('page-nav', `${p.name} -> ${edge.targetKey}`, !!targetId && navLiteralIds.has(String(targetId).toLowerCase()));
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
