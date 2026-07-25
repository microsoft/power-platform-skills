'use strict';
// Whole-app design preview: render the ENTIRE App Spec as the single approval artifact the user signs
// off at design gate #2 / plan mode (or that autopilot writes to disk). preview-form.js renders ONE
// form; this renders the whole app — a data-model summary, the appShell sitemap tree, views/charts,
// per-form wireframes (reusing form-preview.js), page-INTENTS (purpose/data-sources/navigation), and
// the page design contract. Pure (no I/O); the CLI wrapper is preview-app.js. See design §12.
const { renderFormWireframe } = require('./form-preview.js');

const lc = (s) => String(s || '').toLowerCase();
const h = (title) => `\n=== ${title} ===`;

function dataModelSection(spec) {
  const out = [h('Data model')];
  if (!(spec.entities || []).length) { out.push('  (no tables)'); }
  for (const e of spec.entities || []) {
    out.push(`  • ${e.displayName || e.schemaName} [${lc(e.schemaName)}]${e.hasNotes ? '  (notes/timeline)' : ''}`);
    out.push(`      primary: ${e.primaryAttribute ? e.primaryAttribute.schemaName : '(none)'}`);
    const cols = (e.columns || []).map((c) => `${c.schemaName} (${c.type || 'Text'})`);
    if (cols.length) out.push(`      columns: ${cols.join(', ')}`);
  }
  for (const r of spec.relationships || []) {
    if (r.type === 'OneToMany') out.push(`  ↳ 1:N  ${lc(r.referenced)}  →  ${lc(r.referencing)}  (lookup ${r.lookup && r.lookup.schemaName})`);
    else if (r.type === 'ManyToMany') out.push(`  ↳ N:N  ${lc(r.entity1)}  ↔  ${lc(r.entity2)}`);
  }
  return out;
}

// The target kind of a sitemap subarea. Exactly one of entity/page/dashboard/url is set (lint-enforced,
// app-spec.js:535-537), so label by the one present — this is what the user reviews for nav wiring.
function subAreaTarget(sa) {
  if (sa.entity) return `table:${lc(sa.entity)}`;
  if (sa.page) return `page:${sa.page}`;
  if (sa.dashboard) return `dashboard:${sa.dashboard}`;
  if (sa.url) return `url:${sa.url}`;
  return '(no target)';
}

function sitemapSection(spec) {
  const out = [h('Sitemap (appShell)')];
  const areas = (spec.appShell && spec.appShell.areas) || [];
  if (!areas.length) out.push('  (no sitemap)');
  for (const a of areas) {
    out.push(`  ▸ ${a.label || '(area)'}`);
    for (const g of a.groups || []) {
      out.push(`     ▹ ${g.label || '(group)'}`);
      for (const sa of g.subAreas || []) out.push(`        - ${sa.title || subAreaTarget(sa)}  →  ${subAreaTarget(sa)}`);
    }
  }
  return out;
}

function viewsChartsSection(spec) {
  const out = [h('Views & charts')];
  const views = spec.views || [];
  const charts = spec.charts || [];
  if (!views.length && !charts.length) out.push('  (none)');
  for (const v of views) out.push(`  ▦ view "${v.name}" (${lc(v.entity)}): ${(v.columns || []).join(', ')}`);
  for (const c of charts) out.push(`  ◫ chart "${c.name}" (${c.chartType}) on ${lc(c.entity)} — ${c.measure || 'count'} by ${c.groupBy}`);
  return out;
}

function formsSection(spec) {
  const out = [h('Forms')];
  const forms = spec.forms || [];
  if (!forms.length) { out.push('  (no forms)'); return out; }
  for (const f of forms) out.push(renderFormWireframe(spec, f));
  return out;
}

function pagesSection(spec) {
  const out = [h('Pages (generative)')];
  const pages = spec.pages || [];
  if (!pages.length) { out.push('  (no pages)'); return out; }
  for (const p of pages) {
    const impl = p.source && p.source.kind === 'tsx' ? `implemented (${p.source.codeFile})` : 'intent (design-only)';
    out.push(`  ▪ ${p.name} [${p.key || '(no key)'}] — ${impl}`);
    if (p.purpose) out.push(`      purpose: ${p.purpose}`);
    if ((p.dataSources || []).length) out.push(`      data: ${p.dataSources.join(', ')}`);
    for (const nav of p.navigatesTo || []) out.push(`      → navigates to ${nav.targetKey}${nav.data ? ` (data: ${Object.keys(nav.data).join(', ')})` : ''}`);
  }
  return out;
}

function designSection(spec) {
  if (!spec.design || typeof spec.design !== 'object' || Array.isArray(spec.design)) return [];
  return [h('Design contract'), '  ' + Object.entries(spec.design).map(([k, v]) => `${k}=${v}`).join('  ')];
}

function renderAppPreview(spec) {
  const s = spec || {};
  const lines = [`APP: ${(s.app && s.app.name) || '(unnamed app)'}`];
  if (s.app && s.app.description) lines.push(s.app.description);
  lines.push(...dataModelSection(s), ...sitemapSection(s), ...viewsChartsSection(s), ...formsSection(s), ...pagesSection(s), ...designSection(s));
  return lines.join('\n') + '\n';
}

module.exports = { renderAppPreview };
