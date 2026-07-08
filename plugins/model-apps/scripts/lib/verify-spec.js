'use strict';
// Reconcile an App Spec against a DEPLOYED app: for every declared entity/column/view/chart/form and
// every sitemap subarea (+ icon), check whether it actually exists server-side. Catches silent
// partial builds. Pure/testable: `read` provides the server lookups; `verifySpec` returns
// { ok, checks:[{kind,name,present,detail}], missing:[…] }.

const { odataLit } = require('./odata.js');

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

  const missing = checks.filter((c) => !c.present);
  return { ok: missing.length === 0, checks, missing };
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

module.exports = { verifySpec, hasElement, subareaHasDashboard };
