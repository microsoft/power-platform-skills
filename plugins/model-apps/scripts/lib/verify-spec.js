'use strict';
// Reconcile an App Spec against a DEPLOYED app: for every declared entity/column/view/chart/form and
// every sitemap subarea (+ icon), check whether it actually exists server-side. Catches silent
// partial builds. Pure/testable: `read` provides the server lookups; `verifySpec` returns
// { ok, checks:[{kind,name,present,detail}], missing:[…] }.

const odataLit = (v) => String(v == null ? '' : v).replace(/'/g, "''");

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

  // Sitemap subareas (+ icons).
  const xml = (await read.sitemapXml()) || '';
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    if (a.icon) add('area-icon', a.label || '', new RegExp(`Icon="${escapeRe(String(a.icon))}"`, 'i').test(xml));
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.entity) add('subarea', sa.title || sa.entity, new RegExp(`Entity="${escapeRe(String(sa.entity))}"`, 'i').test(xml));
        if (sa.dashboard) add('subarea', sa.title || sa.dashboard, /DefaultDashboard=/.test(xml));
        if (sa.icon) add('subarea-icon', sa.title || '', new RegExp(`Icon="${escapeRe(String(sa.icon))}"`, 'i').test(xml));
      }
    }
  }

  const missing = checks.filter((c) => !c.present);
  return { ok: missing.length === 0, checks, missing };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { verifySpec };
