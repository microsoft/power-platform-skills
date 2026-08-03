'use strict';
// App Spec -> `model-app-plan.md`: the readable design document a human reviews before the build and
// keeps alongside the app afterwards.
//
// WHY this is a script and not a prose instruction: `model-app-plan.md` used to be written freehand
// ("write a short human-readable summary… include: tables, relationships, artifact COUNTS"). Testers
// reported the result was an abbreviated plan with no durable, reviewable detail — and a freehand doc
// drifts from the spec the moment either changes. Rendering it from `app-spec.json` makes the document
// (a) complete, (b) always in sync, and (c) regenerable at any time:
//     node scripts/write-app-spec-doc.js --spec @<dir>/app-spec.json
//
// This is NOT app-preview.js. That renders an ASCII console preview for the in-conversation approval
// gate (form wireframes included); this renders durable Markdown for review and archival. They share
// the spec but not the audience, so they intentionally differ in shape.
//
// PURE: no I/O. The CLI wrapper (scripts/write-app-spec-doc.js) owns writing the file.

const lc = (s) => String(s || '').toLowerCase();

// Table cells: a spec string (app description, job name, page purpose) may contain a `|` or a line
// break, either of which silently breaks a Markdown table row. Flatten and escape for cells only —
// prose lines elsewhere keep their original text.
function cell(value, fallback = '—') {
  const s = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return s || fallback;
}

const text = (value, fallback = '') => {
  const s = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || fallback;
};

function overview(spec) {
  const app = spec.app || {};
  const out = [`# ${text(app.name, 'Model-driven app')} — design`, ''];
  if (app.description) out.push(text(app.description), '');
  out.push(
    'Generated from `app-spec.json` by `scripts/write-app-spec-doc.js`. **Regenerate rather than',
    'hand-edit** — `app-spec.json` is the source of truth, so a manual edit here is lost on the next',
    'run and silently disagrees with what actually builds.',
    ''
  );
  return out;
}

function environment(spec, opts) {
  const out = ['## Environment', ''];
  const rows = [
    ['Environment', opts.envUrl],
    ['Solution', spec.solution && (spec.solution.uniqueName || spec.solution.name)],
    ['Publisher prefix', spec.solution && spec.solution.prefix],
    ['App unique name', spec.app && spec.app.uniqueName],
  ].filter(([, v]) => v);
  if (!rows.length) return [];
  out.push('| Setting | Value |', '|---|---|');
  for (const [k, v] of rows) out.push(`| ${cell(k)} | ${cell(v)} |`);
  out.push('');
  return out;
}

// Personas -> jobs-to-be-done. This section leads the document on purpose: the jobs are what the app
// EXISTS to do, so a reviewer should read them before the tables. Testers found that enumerating jobs
// explicitly is what makes the design complete — without it, surfaces get missed.
function jobsSection(spec) {
  const personas = spec.personas || [];
  const out = ['## Jobs to be done', ''];
  if (!personas.length) {
    out.push(
      '> ⚠ No `personas[]` were captured, so this app has no recorded jobs-to-be-done and no security',
      '> roles — it will open only for system administrators. Capture who uses the app and what each',
      "> of them needs to get done, then regenerate this document.",
      ''
    );
    return out;
  }
  out.push('| Persona | Job to be done | Surfaces that satisfy it |', '|---|---|---|');
  for (const p of personas) {
    for (const j of p.jobs || []) {
      const covering = (j.surfaces || []).map((s) => cell(s)).join(', ');
      out.push(`| ${cell(p.persona)} | ${cell(j.name)}${j.description ? ` — ${cell(j.description, '')}` : ''} | ${covering || '_not mapped_'} |`);
    }
  }
  out.push('');
  const unmapped = personas.flatMap((p) => (p.jobs || []).filter((j) => !(j.surfaces || []).length).map((j) => `${p.persona} → ${j.name}`));
  if (unmapped.length) {
    out.push(
      `> ⚠ ${unmapped.length} job(s) are not mapped to a surface, so nothing in this app demonstrably`,
      '> lets that persona do the job. Either add the surface, or record which existing one covers it.',
      ''
    );
  }
  return out;
}

function dataModel(spec) {
  const out = ['## Data model', ''];
  const entities = spec.entities || [];
  if (!entities.length) { out.push('_No tables._', ''); return out; }
  for (const e of entities) {
    const reused = e.existing ? ' _(existing table — reused, not created)_' : '';
    out.push(`### ${text(e.displayName, e.schemaName)} \`${lc(e.schemaName)}\`${reused}`, '');
    if (e.description) out.push(text(e.description), '');
    out.push('| Column | Type | Notes |', '|---|---|---|');
    const pa = e.primaryAttribute;
    if (pa) out.push(`| ${cell(pa.displayName || pa.schemaName)} | ${cell(pa.type, 'Text')} | primary name${pa.autoNumberFormat ? `, auto-number \`${cell(pa.autoNumberFormat)}\`` : ''} |`);
    for (const c of e.columns || []) {
      const notes = [];
      if (c.required) notes.push('required');
      if (c.options) notes.push(`choices: ${(c.options || []).map((o) => cell(o.label || o)).join(', ')}`);
      if (c.globalChoice) notes.push(`global choice \`${cell(c.globalChoice)}\``);
      out.push(`| ${cell(c.displayName || c.schemaName)} | ${cell(c.type, 'Text')} | ${notes.join('; ') || '—'} |`);
    }
    out.push('');
    if (e.hasNotes) out.push('Notes/timeline enabled.', '');
  }
  const rels = spec.relationships || [];
  if (rels.length) {
    out.push('### Relationships', '', '| Kind | From | To | Lookup |', '|---|---|---|---|');
    for (const r of rels) {
      if (r.type === 'ManyToMany') out.push(`| N:N | ${cell(lc(r.entity1))} | ${cell(lc(r.entity2))} | — |`);
      else out.push(`| 1:N | ${cell(lc(r.referenced))} | ${cell(lc(r.referencing))} | ${cell(r.lookup && r.lookup.schemaName)} |`);
    }
    out.push('');
  }
  return out;
}

// Every user-facing surface, grouped by kind, so a reviewer can see what the app actually presents —
// and, critically, whether generative pages were considered at all (the genpage-first policy makes
// them the default for any non-record surface, and testers found they were being skipped silently).
function surfaces(spec) {
  const out = ['## Surfaces', ''];
  const pages = spec.pages || [];
  const forms = spec.forms || [];
  const views = spec.views || [];
  const charts = spec.charts || [];
  const dashboards = spec.dashboards || [];

  out.push('### Generative pages', '');
  if (!pages.length) {
    out.push(
      '> ⚠ No generative pages. Per the genpage-first policy, any non-record surface — an overview or',
      '> landing page, a dashboard, an analytics view, a guided/wizard flow — should be a generative',
      "> page rather than a classic dashboard. If this app genuinely has only record CRUD, that's",
      '> fine; otherwise a surface is missing.',
      ''
    );
  } else {
    out.push('| Page | Key | Purpose | Reads | Navigates to | State |', '|---|---|---|---|---|---|');
    for (const p of pages) {
      const state = p.source && p.source.kind === 'tsx' ? `built (\`${cell(p.source.codeFile)}\`)` : 'intent (code not yet generated)';
      const nav = (p.navigatesTo || []).map((n) => cell(n.targetKey)).join(', ');
      out.push(`| ${cell(p.name)} | \`${cell(p.key)}\` | ${cell(p.purpose)} | ${cell((p.dataSources || []).map(lc).join(', '))} | ${nav || '—'} | ${state} |`);
    }
    out.push('');
  }

  out.push('### Forms', '');
  if (!forms.length) out.push('_No forms._', '');
  else {
    out.push('| Form | Table | Type | Layout | Sub-grids |', '|---|---|---|---|---|');
    for (const f of forms) {
      const sg = (f.subgrids || []).map((s) => cell(lc(s.childEntity))).join(', ');
      out.push(`| ${cell(f.name)} | ${cell(lc(f.entity))} | ${cell(f.type, 'main')} | ${cell(f.layout, 'auto')} | ${sg || '—'} |`);
    }
    out.push('');
  }

  out.push('### Views', '');
  if (!views.length) out.push('_No views._', '');
  else {
    out.push('| View | Table | Columns |', '|---|---|---|');
    for (const v of views) out.push(`| ${cell(v.name)} | ${cell(lc(v.entity))} | ${cell((v.columns || []).join(', '))} |`);
    out.push('');
  }

  if (charts.length) {
    out.push('### Charts', '', '| Chart | Table | Type | Measure | Grouped by |', '|---|---|---|---|---|');
    for (const c of charts) out.push(`| ${cell(c.name)} | ${cell(lc(c.entity))} | ${cell(c.chartType)} | ${cell(c.measure, 'count')} | ${cell(c.groupBy)} |`);
    out.push('');
  }
  if (dashboards.length) {
    out.push('### Classic dashboards', '', '| Dashboard | Tiles |', '|---|---|');
    for (const d of dashboards) out.push(`| ${cell(d.name)} | ${(d.tiles || []).length} |`);
    out.push('');
  }
  return out;
}

function navigation(spec) {
  const areas = (spec.appShell && spec.appShell.areas) || [];
  if (!areas.length) return [];
  const out = ['## Navigation', ''];
  for (const a of areas) {
    out.push(`- **${text(a.label, '(area)')}**`);
    for (const g of a.groups || []) {
      out.push(`  - ${text(g.label, '(group)')}`);
      for (const sa of g.subAreas || []) {
        const target = sa.entity ? `table \`${lc(sa.entity)}\`` : sa.page ? `page \`${sa.page}\`` : sa.dashboard ? `dashboard \`${sa.dashboard}\`` : sa.url ? `URL ${sa.url}` : '(no target)';
        out.push(`    - ${text(sa.title, target)} → ${target}`);
      }
    }
  }
  out.push('');
  return out;
}

// The access model, rendered as what each persona's role can actually DO. A reviewer cannot approve
// an access model they cannot see, and this is the durable copy of it.
function security(spec) {
  const personas = spec.personas || [];
  if (!personas.length) return [];
  const out = ['## Security', ''];
  for (const p of personas) {
    out.push(`### Role: ${text(p.persona)}`, '');
    out.push(p.appAccess === false ? '_Data-only — the app is **not** granted to this role._' : 'The app is granted to this role, so it opens for this persona.', '');
    // One row per entity+access is what the SDK actually applies (jobs are unioned, max scope wins),
    // so show the union rather than per-job duplicates a reviewer would have to merge mentally.
    const union = new Map();
    const add = (pr) => {
      const key = lc(pr.entity);
      const cur = union.get(key) || { access: new Set(), scope: pr.scope || 'user' };
      for (const a of pr.access || []) cur.access.add(a);
      const order = ['user', 'businessUnit', 'parentChild', 'organization'];
      if (order.indexOf(pr.scope || 'user') > order.indexOf(cur.scope)) cur.scope = pr.scope || 'user';
      union.set(key, cur);
    };
    for (const j of p.jobs || []) for (const pr of j.privileges || []) add(pr);
    for (const pr of p.additionalPrivileges || []) add(pr);
    if (union.size) {
      out.push('| Table | Access | Scope |', '|---|---|---|');
      for (const [entity, v] of union) out.push(`| ${cell(entity)} | ${cell([...v.access].join(', '))} | ${cell(v.scope)} |`);
      out.push('');
    } else {
      out.push('_No privileges declared._', '');
    }
  }
  return out;
}

function sampleData(spec) {
  const sd = spec.sampleData;
  if (!sd || typeof sd !== 'object') return [];
  const rows = Object.entries(sd).filter(([, v]) => Array.isArray(v));
  if (!rows.length) return [];
  const out = ['## Sample data', '', '| Table | Records |', '|---|---|'];
  for (const [entity, records] of rows) out.push(`| ${cell(entity)} | ${records.length} |`);
  out.push('');
  return out;
}

function designContract(spec) {
  const d = spec.design;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [];
  const entries = Object.entries(d).filter(([, v]) => v != null && String(v).trim());
  if (!entries.length) return [];
  const out = ['## Design contract', '', '| Token | Value |', '|---|---|'];
  for (const [k, v] of entries) out.push(`| ${cell(k)} | ${cell(v)} |`);
  out.push('', 'These tokens are threaded to every generative page so the app looks consistent.', '');
  return out;
}

function aiFeatures(spec) {
  const ai = spec.ai;
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) return [];
  const on = Object.entries(ai).filter(([, v]) => v && v !== 'off');
  if (!on.length) return [];
  const out = ['## AI features', '', '| Feature | Setting |', '|---|---|'];
  for (const [k, v] of on) out.push(`| ${cell(k)} | ${cell(typeof v === 'object' ? JSON.stringify(v) : v)} |`);
  out.push('', '_All AI features are admin-gated; the build preflights and skips anything not enabled._', '');
  return out;
}

/**
 * Render an App Spec as a readable Markdown design document.
 * @param {object} spec migrated App Spec
 * @param {object} [opts] { envUrl }
 * @returns {string} markdown
 */
function renderAppSpecDoc(spec, opts = {}) {
  const s = spec || {};
  const lines = [
    ...overview(s),
    ...environment(s, opts),
    ...jobsSection(s),
    ...dataModel(s),
    ...surfaces(s),
    ...navigation(s),
    ...security(s),
    ...sampleData(s),
    ...designContract(s),
    ...aiFeatures(s),
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

module.exports = { renderAppSpecDoc };
