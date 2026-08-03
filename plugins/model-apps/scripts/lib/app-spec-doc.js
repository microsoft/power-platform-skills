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

// Every collection read below goes through these. The renderer runs against WORK-IN-PROGRESS specs
// during authoring — a half-typed `jobs: "x"`, a null entry left by an edit, a `dataSources` written
// as a bare string — and a crash here kills the authoring flow. Shape errors are validateAppSpec's
// job to report; this module's job is to render whatever it is given without throwing.
const arr = (v) => (Array.isArray(v) ? v : []);
const objs = (v) => arr(v).filter((x) => x && typeof x === 'object' && !Array.isArray(x));

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
  const sol = spec.solution && typeof spec.solution === 'object' ? spec.solution : {};
  const rows = [
    ['Environment', opts.envUrl],
    ['Solution', sol.uniqueName || sol.displayName],
    ['Publisher prefix', sol.publisherPrefix],
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
  const personas = objs(spec.personas);
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
    for (const j of objs(p.jobs)) {
      const covering = arr(j.surfaces).map((s) => cell(s)).join(', ');
      out.push(`| ${cell(p.persona)} | ${cell(j.name)}${j.description ? ` — ${cell(j.description, '')}` : ''} | ${covering || '_not mapped_'} |`);
    }
  }
  out.push('');
  const unmapped = personas.flatMap((p) => objs(p.jobs).filter((j) => !arr(j.surfaces).length).map((j) => `${p.persona} → ${j.name}`));
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
  const entities = objs(spec.entities);
  if (!entities.length) { out.push('_No tables._', ''); return out; }
  for (const e of entities) {
    const reused = e.existing ? ' _(existing table — reused, not created)_' : '';
    out.push(`### ${text(e.displayName, e.schemaName)} \`${lc(e.schemaName)}\`${reused}`, '');
    if (e.description) out.push(text(e.description), '');
    // The nav icon is something the user APPROVES, and at plan time the SVG may not exist yet — so
    // show what the glyph will DEPICT, not the web-resource name (which tells a reviewer nothing).
    if (e.iconDescription || e.vectorIcon || e.icon) {
      const depicts = e.iconDescription ? text(e.iconDescription) : '_no description — the user cannot approve an icon they cannot picture_';
      out.push(`**Nav icon:** ${depicts}`, '');
    }
    out.push('| Column | Type | Notes |', '|---|---|---|');
    const pa = e.primaryAttribute && typeof e.primaryAttribute === 'object' ? e.primaryAttribute : null;
    if (pa) out.push(`| ${cell(pa.displayName || pa.schemaName)} | ${cell(pa.type, 'Text')} | primary name${pa.autoNumberFormat ? `, auto-number \`${cell(pa.autoNumberFormat)}\`` : ''} |`);
    for (const c of objs(e.columns)) {
      const notes = [];
      if (c.required) notes.push('required');
      if (c.options) notes.push(`choices: ${arr(c.options).map((o) => cell(o && typeof o === 'object' ? o.label : o)).join(', ')}`);
      if (c.globalChoice) notes.push(`global choice \`${cell(c.globalChoice)}\``);
      out.push(`| ${cell(c.displayName || c.schemaName)} | ${cell(c.type, 'Text')} | ${notes.join('; ') || '—'} |`);
    }
    out.push('');
    if (e.hasNotes) out.push('Notes/timeline enabled.', '');
  }
  const rels = objs(spec.relationships);
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
  const pages = objs(spec.pages);
  const forms = objs(spec.forms);
  const views = objs(spec.views);
  const charts = objs(spec.charts);
  const dashboards = objs(spec.dashboards);

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
      const nav = objs(p.navigatesTo).map((n) => cell(n.targetKey)).join(', ');
      out.push(`| ${cell(p.name)} | \`${cell(p.key)}\` | ${cell(p.purpose)} | ${cell(arr(p.dataSources).map(lc).join(', '))} | ${nav || '—'} | ${state} |`);
    }
    out.push('');
  }

  out.push('### Forms', '');
  if (!forms.length) out.push('_No forms._', '');
  else {
    out.push('| Form | Table | Type | Layout | Sub-grids |', '|---|---|---|---|---|');
    for (const f of forms) {
      const sg = objs(f.subgrids).map((s) => cell(lc(s.childEntity))).join(', ');
      // `formType` is the canonical field (Main / QuickCreate / QuickView), defaulting to Main —
      // NOT `type`. Reading the wrong one rendered every QuickCreate/QuickView form as "main",
      // hiding a real difference in what the form does.
      const kind = f.formType === undefined ? 'Main' : f.formType;
      // An authored `tabs[]` IS the layout — reporting "auto" for it misstates the design, and the
      // build treats an explicit layout differently (it prunes fields the author dropped).
      const tabs = objs(f.tabs);
      const layout = tabs.length ? `explicit (${tabs.length} tab${tabs.length === 1 ? '' : 's'})` : (f.layout || 'auto');
      out.push(`| ${cell(f.name)} | ${cell(lc(f.entity))} | ${cell(kind)} | ${cell(layout)} | ${sg || '—'} |`);
    }
    out.push('');
    const withQv = forms.filter((f) => objs(f.quickViews).length);
    if (withQv.length) {
      out.push('Quick-view cards embedded on a form:', '');
      for (const f of withQv) {
        for (const qv of objs(f.quickViews)) out.push(`- **${cell(f.name)}** shows \`${cell(qv.form)}\` via lookup \`${cell(qv.lookup)}\``);
      }
      out.push('');
    }
    const withEvents = forms.filter((f) => objs(f.events).length);
    if (withEvents.length) {
      out.push('Form scripts:', '');
      for (const f of withEvents) {
        for (const ev of objs(f.events)) out.push(`- **${cell(f.name)}** — \`${cell(ev.event)}\`${ev.attribute ? ` on \`${cell(ev.attribute)}\`` : ''} → \`${cell(ev.function)}\` (\`${cell(ev.library)}\`)`);
      }
      out.push('');
    }
  }

  out.push('### Views', '');
  if (!views.length) out.push('_No views._', '');
  else {
    // Filters and sort decide what a user actually sees in a view ("my open tickets, newest first"),
    // so a doc that lists only columns lets two materially different views read identically.
    // Canonical shapes (references/app-spec-schema.md → views[]): sort is `{attr, dir}` and a filter
    // is `{attr, op, value?|values?}` — NOT `{column, descending}` / `{column, operator}`.
    out.push('| View | Table | Columns | Filters | Sort |', '|---|---|---|---|---|');
    for (const v of views) {
      const filters = objs(v.filters).map((f) => {
        const val = f.values !== undefined ? arr(f.values).join('/') : f.value;
        return `${cell(f.attr)} ${cell(f.op, '=')}${val === undefined || val === '' ? '' : ` ${cell(val)}`}`;
      }).join('; ');
      const sort = objs(v.sort).map((s) => `${cell(s.attr)} ${cell(s.dir, 'asc')}`).join(', ');
      const scope = v.activeOnly === false ? 'all records' : '';
      out.push(`| ${cell(v.name)} | ${cell(lc(v.entity))} | ${cell(arr(v.columns).join(', '))} | ${[filters, scope].filter(Boolean).join('; ') || '—'} | ${sort || '—'} |`);
    }
    out.push('');
  }

  if (charts.length) {
    out.push('### Charts', '', '| Chart | Table | Type | Measure | Grouped by |', '|---|---|---|---|---|');
    for (const c of charts) out.push(`| ${cell(c.name)} | ${cell(lc(c.entity))} | ${cell(c.chartType)} | ${cell(c.measure, 'count')} | ${cell(c.groupBy)} |`);
    out.push('');
  }
  if (dashboards.length) {
    out.push('### Classic dashboards', '', '| Dashboard | Tiles |', '|---|---|');
    for (const d of dashboards) out.push(`| ${cell(d.name)} | ${arr(d.tiles).length} |`);
    out.push('');
  }

  // Commands are actions a user can take — omitting them let two specs differing by an "Escalate"
  // button render identically, which is exactly the kind of behaviour a reviewer signs off on.
  const commands = objs(spec.commands);
  if (commands.length) {
    out.push('### Command-bar buttons', '', '| Button | Table | Kind | Runs |', '|---|---|---|---|');
    for (const c of commands) {
      const kind = c.type || 'Button';
      const runs = c.function ? `\`${cell(c.function)}\`${c.library ? ` (\`${cell(c.library)}\`)` : ''}` : (objs(c.children).length ? `${objs(c.children).length} child button(s)` : '—');
      out.push(`| ${cell(c.label || c.name)} | ${cell(lc(c.entity))} | ${cell(kind)} | ${runs} |`);
      for (const ch of objs(c.children)) {
        out.push(`| ↳ ${cell(ch.label || ch.name)} | ${cell(lc(c.entity))} | child | ${ch.function ? `\`${cell(ch.function)}\`` : '—'} |`);
      }
    }
    out.push('');
  }
  return out;
}

function navigation(spec) {
  const areas = objs(spec.appShell && spec.appShell.areas);
  if (!areas.length) return [];
  // A sitemap icon is chrome the user approves, so show its depiction inline. An `entity` subarea's
  // nav glyph comes from the TABLE's own icon, not the subarea — so point at the table rather than
  // repeating a description that would not be the one actually rendered.
  const depiction = (o) => (o && o.iconDescription ? ` — icon: ${text(o.iconDescription)}` : (o && (o.icon || o.vectorIcon) ? ' — icon: _not described_' : ''));
  const out = ['## Navigation', ''];
  for (const a of areas) {
    out.push(`- **${text(a.label, '(area)')}**${depiction(a)}`);
    for (const g of objs(a.groups)) {
      out.push(`  - ${text(g.label, '(group)')}${depiction(g)}`);
      for (const sa of objs(g.subAreas)) {
        const target = sa.entity ? `table \`${lc(sa.entity)}\`` : sa.page ? `page \`${sa.page}\`` : sa.dashboard ? `dashboard \`${sa.dashboard}\`` : sa.url ? `URL ${sa.url}` : '(no target)';
        const icon = sa.entity ? ' — icon: the table\'s own' : depiction(sa);
        out.push(`    - ${text(sa.title, target)} → ${target}${icon}`);
      }
    }
  }
  out.push('');
  return out;
}

// The access model, rendered as what each persona's role can actually DO. A reviewer cannot approve
// an access model they cannot see, and this is the durable copy of it.
//
// Scope is unioned PER (entity, ACCESS), never per entity. That mirrors how the SDK actually applies
// a role (see evals/model-apps/app-builder/lib/facts.js `unionPrivileges`): collapsing to one scope
// per table would render `read@organization` + `write@user` as "read, write @ organization" and
// OVERSTATE write access. A document that misreports the access model is worse than no document.
const SCOPE_RANK = { user: 0, businessunit: 1, parentchild: 2, organization: 3 };
const scopeRank = (s) => {
  const r = SCOPE_RANK[String(s || 'user').toLowerCase()];
  return r === undefined ? 0 : r;
};

function security(spec) {
  const personas = Array.isArray(spec.personas) ? spec.personas.filter((p) => p && typeof p === 'object') : [];
  if (!personas.length) return [];
  const out = ['## Security', ''];
  for (const p of personas) {
    out.push(`### Role: ${text(p.persona)}`, '');
    out.push(p.appAccess === false ? '_Data-only — the app is **not** granted to this role._' : 'The app is granted to this role, so it opens for this persona.', '');

    // entity -> access -> most permissive declared scope
    const byEntity = new Map();
    const add = (pr) => {
      if (!pr || typeof pr !== 'object') return;
      const entity = lc(pr.entity);
      if (!entity) return;
      let byAccess = byEntity.get(entity);
      if (!byAccess) { byAccess = new Map(); byEntity.set(entity, byAccess); }
      const scope = String(pr.scope || 'user');
      for (const a of Array.isArray(pr.access) ? pr.access : []) {
        const prev = byAccess.get(a);
        if (prev === undefined || scopeRank(scope) > scopeRank(prev)) byAccess.set(a, scope);
      }
    };
    for (const j of Array.isArray(p.jobs) ? p.jobs : []) {
      if (j && typeof j === 'object') for (const pr of Array.isArray(j.privileges) ? j.privileges : []) add(pr);
    }
    for (const pr of Array.isArray(p.additionalPrivileges) ? p.additionalPrivileges : []) add(pr);

    if (byEntity.size) {
      out.push('| Table | Access | Scope |', '|---|---|---|');
      for (const [entity, byAccess] of byEntity) {
        // Group the accesses that share a scope so the common case stays one row, while a genuine
        // split (read@organization + write@user) renders as two — visibly different access levels.
        const byScope = new Map();
        for (const [access, scope] of byAccess) {
          if (!byScope.has(scope)) byScope.set(scope, []);
          byScope.get(scope).push(access);
        }
        const scopes = [...byScope.keys()].sort((a, b) => scopeRank(b) - scopeRank(a));
        for (const scope of scopes) out.push(`| ${cell(entity)} | ${cell(byScope.get(scope).join(', '))} | ${cell(scope)} |`);
      }
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
