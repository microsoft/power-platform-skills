'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Reach the plugin's pure primitives (4 levels up from evals/model-apps/app-builder/lib/ → repo root,
// same depth genpage/lib uses to reach references/verified-icons.txt). These are offline-only modules
// with no SDK handle or network access. Download/content helpers read fixture files only.
function pluginLib(name) { return require(path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'scripts', 'lib', name)); }
// Same, for a top-level script rather than a lib module. download-model-app.js exports its pure
// helpers and performs no I/O at require time, so it is safe to load from the offline harness.
function pluginLib2(name) { return require(path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'scripts', name)); }

const { migrateAppSpec, validateAppSpec, lookupColumnsFor, normalizePageSource, SDK_ROLE_MARKER, FORM_TYPE_CODE } = pluginLib('app-spec.js');
const { lintAppSpec } = pluginLib('spec-lint.js');
const { planFor, PHASES, appDef, viewDef, chartDef, compileFormIntent, formFieldLogicals, defaultViewColumns, enrichesDefaultViews, subgridLabel, personaRoleSpecFor, businessRuleDef, bpfDef } = pluginLib('sdk-build.js');
const { subgridSectionIntent, isNonFieldControl } = pluginLib('artifact-intent.js');
const { decodeXmlEntities } = pluginLib('sitemap-pages.js');
const { schemaFacts } = pluginLib('schema-facts.js');
const { verifySpec } = pluginLib('verify-spec.js');
const { isMainForm, plannedMainFormSequence } = pluginLib('form-order.js');
// Round-trip (edit/download) + teardown oracles: both plugin primitives are PURE — planTeardown does
// no I/O, and hydrateSpec takes an injected `read`, so we can grade the compared hydration subset
// and the reverse-of-build teardown plan offline. This does not execute a rebuild. See EVAL_GUIDE.md.
const { planTeardown } = pluginLib('sdk-teardown.js');
const { hydrateSpec } = pluginLib('hydrate-spec.js');
// entityFromMetadata is the PURE metadata->spec projection the downloader uses for a table's
// `columns[]`. Grading it here (rather than only in the plugin's unit tests) puts the download
// side of the round-trip under the same fixture corpus as the build side.
const { entityFromMetadata, parseDownloadedPages, assignPageKeys } = pluginLib2('download-model-app.js');
const { unescapePacName } = pluginLib('genpage-cli.js');
const { classifyChanges } = pluginLib('classify-changes.js');
const { annotateContentHashes, pageSourceFileErrors } = pluginLib('content-hash.js');
const { makeEnvelope, markEligible, parseEnvelope, serializeEnvelope, isFastPathEligible } = pluginLib('apply-snapshot.js');

// Retain the legacy optional resolver path for older plugin checkouts. The current verifier also
// requires this module, so its absence is already a required-plugin load error on current versions.
let pagerefResolver = null;
try { pagerefResolver = pluginLib('pageref-resolver.js'); } catch { pagerefResolver = null; }

const lc = (s) => String(s || '').toLowerCase();

// Scope permissiveness ranking (least -> most): user(Basic) < businessUnit(Local) < parentChild(Deep)
// < organization(Global). Matches the personas[] scope table in references/app-spec-schema.md. A
// privilege that omits scope defaults to `user` — the SDK's default depth (personaRoleSpecFor omits
// scope only when the author did, and createPersonaRole treats a missing depth as Basic/user).
const SCOPE_RANK = { user: 0, businessunit: 1, parentchild: 2, organization: 3 };
const scopeRank = (s) => (SCOPE_RANK[lc(s || 'user')] !== undefined ? SCOPE_RANK[lc(s || 'user')] : 0);

// Union a flat privilege list into entity -> (access -> maxScope), mirroring the SDK's documented union
// rule ("max scope wins per entity+ACCESS"): a persona's ONE role carries the union of every job's +
// additionalPrivileges' declared access. Scope is tracked PER (entity, access) — collapsing to one scope
// per entity would hide a legitimate read@organization + write@user split AND mask a later write-scope
// inflation. Both the DECLARED (author) and GRANTED (mapper) sides are reduced through this so the
// least-privilege / coverage evals compare like with like.
function unionPrivileges(privs) {
  const out = new Map();
  for (const pr of privs || []) {
    const ent = lc(pr.entity);
    const scope = lc(pr.scope || 'user');
    let byAccess = out.get(ent);
    if (!byAccess) { byAccess = new Map(); out.set(ent, byAccess); }
    for (const a of pr.access || []) {
      const acc = lc(a);
      const prev = byAccess.get(acc);
      if (prev === undefined || scopeRank(scope) > scopeRank(prev)) byAccess.set(acc, scope);
    }
  }
  return out;
}

// The DECLARED privileges of a persona-shaped object: jobs[].privileges + additionalPrivileges. From the
// raw spec this is what the AUTHOR asked for (the injected appmodule read is deliberately absent — it is
// an engine addition, not an author declaration); from personaRoleSpecFor's output it is what the role
// will GRANT (appmodule read included). Reused for both sides so the two unions are built identically.
function flattenPrivileges(personaLike) {
  const privs = [];
  for (const j of personaLike.jobs || []) for (const pr of j.privileges || []) privs.push(pr);
  for (const pr of personaLike.additionalPrivileges || []) privs.push(pr);
  return privs;
}

// author: design-profile validation + lint. The harness runs in autopilot/design mode — pages are
// intents, so 'plan' is the right profile (design §7.1 — deploy profile would reject intent pages).
function authorFacts(spec, approvedPageNames) {
  const validate = validateAppSpec(spec, { profile: 'plan' });
  const lint = lintAppSpec(spec);
  // Artifact identity is authored input, independent of the linter's grouping. Otherwise a linter
  // that regressed to global name scope would supply both the wrong warning and its own expectation.
  const artifactNames = ['form', 'view', 'chart'].flatMap((kind) => (spec[`${kind}s`] || []).filter((a) => a && a.name).map((a) => ({
    kind, entity: lc(a.entity), name: a.name, formType: kind === 'form' ? (a.formType || 'Main') : null,
  })));
  const groups = new Map();
  for (const record of artifactNames) {
    const key = [record.kind, record.entity, lc(record.formType), lc(record.name)].join('|');
    const prior = groups.get(key);
    groups.set(key, { ...record, count: prior ? prior.count + 1 : 1 });
  }
  return {
    validate, lint, artifactNames, approvedPageNames,
    artifactNameCollisions: [...groups.values()].filter((g) => g.count > 1),
    pageNames: (spec.pages || []).map((p) => ({ key: p.key || p.name, name: p.name })),
  };
}

// plan: the deterministic phase-grouped plan (planFor is pure for a fixed spec/opts — design §13.2).
function planFacts(spec) {
  const items = planFor(spec, { phases: PHASES, sampleData: true, publish: true });
  const byPhase = {};
  for (const it of items) byPhase[it.phase] = (byPhase[it.phase] || 0) + 1;
  return { byPhase, phases: Object.keys(byPhase), labels: items.map((i) => `${i.phase}\t${i.label}`) };
}

// ui: normalized view/chart/form facts from the pure def builders — the pre-serialization equivalents
// of wire-facts.js (viewFacts/chartFacts/formFacts), deterministic with no live env or bundle round-trip.
function wireFacts(spec) {
  return {
    views: (spec.views || []).map((v) => { const d = viewDef(spec, v); return { entity: d.entityLogicalName, name: d.name, columns: d.columns.map((c) => c.name) }; }),
    charts: (spec.charts || []).map((c) => { const d = chartDef(spec, c); return { entity: d.entityLogicalName, name: d.name, measure: d.series[0].aggregate, groupBy: d.categories[0].attribute }; }),
    forms: (spec.forms || []).map((f) => {
      const authoredShape = authoredFormShape(f);
      const authoredPlacements = authoredFormPlacements(f);
      const intent = compileFormIntent(spec, f, {});
      return {
        entity: intent.entityLogicalName,
        name: intent.name,
        fields: formFieldLogicals(intent),
        explicit: !!intent.__explicitLayout,
        authoredShape,
        compiledShape: compiledFormShape(intent),
        authoredPlacements,
        placements: formPlacements(intent),
      };
    }),
    defaultViews: defaultViewFacts(spec),
    subgrids: subgridFacts(spec),
  };
}

// #2 / #7: the column set defaultViewColumns produces for each ENRICHABLE entity (the set the SDK
// reconciles the deployed Active/Inactive default views to). Per entity we expose whether EVERY 1:N
// parent lookup is kept (#2 — a lookup-heavy table must not truncate its parent links) and whether the
// set leaked `createdon` (#7 — enriched default views must drop the stock Created On). Only entities
// that actually get enriched (>= 2 columns) are included; others keep the untouched stock view.
function defaultViewFacts(spec) {
  const out = {};
  for (const e of spec.entities || []) {
    if (!enrichesDefaultViews(spec, e)) continue;
    const cols = defaultViewColumns(spec, e).map((c) => c.name);
    const lookups = lookupColumnsFor(spec, lc(e.schemaName)).map((l) => l.logical);
    out[lc(e.schemaName)] = {
      columns: cols,
      lookupsPresent: lookups.every((l) => cols.includes(l)),
      hasCreatedon: cols.includes('createdon'),
    };
  }
  return out;
}

// #5: for each authored sub-grid, the section it lands in (own full-width 1-column section) and its
// resolved display title — derived from the SAME pure primitives the engine uses (subgridSectionIntent
// for the section shape, subgridLabel for the title), so the eval grades exactly what ships.
function subgridFacts(spec) {
  const out = [];
  for (const f of spec.forms || []) {
    for (const sg of f.subgrids || []) {
      const label = subgridLabel(spec, sg);
      // classId/relationshipName/viewId don't affect the section topology or title being graded.
      const section = subgridSectionIntent({ subgridClassId: 'x', targetEntity: lc(sg.childEntity), relationshipName: 'r', viewId: 'v', label });
      out.push({ form: f.name || lc(f.entity), childEntity: lc(sg.childEntity), sectionColumns: section.columns, label });
    }
  }
  return out;
}

// --- form layout (#575) ------------------------------------------------------------------------
// An explicit `tabs` layout used to be FLATTENED at build time: every field was pushed into the
// deployed form's first section and no tab / form-column / section was ever created or resized, so a
// two-column form an author wrote was deployed as one long single-column list. Nothing in this corpus
// caught it, because no fixture used an explicit layout and no fact projected a form's SHAPE — only
// its flat field list.
//
// So the shape is projected TWICE, from two independent code paths, which is what makes comparing
// them an oracle rather than a restatement:
//   · `authored` reads the raw spec, normalising the `sections` shorthand and the multi-column
//     `columns[]` form itself rather than borrowing the plugin's helper — a reader that opens
//     `tab.sections` directly silently skips every multi-column tab.
//   · `compiled` reads compileFormIntent's output, which is what the engine actually deploys.
// Flattening collapses `compiled` while `authored` is unchanged, so the two diverge.
//
// Both keep sections GROUPED BY FORM-COLUMN. An earlier version flattened both sides, which made the
// oracle blind to a section moved between columns with its order and fields intact — the one thing a
// multi-column topology assertion most needs to see.
const cellsOfSection = (s) => ((s && s.rows) || []).flatMap((r) => (r && r.cells) || []);
// A sub-grid cell carries a RelationshipName parameter instead of a plain field control. The engine
// appends sub-grid sections on EVERY layout (auto included), so a shape comparison must ignore them
// or an authored-vs-compiled diff would report a section the author never wrote.
const isSubgridCell = (c) => !!(c && c.control && c.control.parameters && c.control.parameters.RelationshipName);
const labelOf = (x) => (x && x.label !== undefined ? x.label : null);

function authoredFormShape(f) {
  if (!f || !Array.isArray(f.tabs)) return null; // `auto` — the author declared no shape to honour
  // The `sections` shorthand IS one full-width form-column, so both shapes normalise to columns[].
  // Normalised HERE rather than through the plugin's own helper, so the oracle states the structure
  // independently of the code it grades.
  const columnsOf = (t) => (Array.isArray(t.columns) ? t.columns : [{ width: null, sections: t.sections || [] }]);
  return f.tabs.map((t, ti) => ({
    name: t.name || `tab_${ti}`,
    label: labelOf(t),
    expanded: t.expanded !== false,
    visible: t.visible !== false,
    columnCount: Array.isArray(t.columns) ? t.columns.length : 1,
    // Keep authored overrides distinct from the independently stated default-split contract below.
    declaredWidths: Array.isArray(t.columns) ? t.columns.map((c) => (c && c.width) || null) : [null],
    // State the percentage-split contract from authored input, not compileFormIntent's output.
    // In particular, two omitted widths must still mean 50/50, never 100/100 or "not checked".
    expectedWidths: columnsOf(t).map((c, ci, cols) => (c && c.width) || `${Math.floor(100 / cols.length) + (ci === 0 ? 100 % cols.length : 0)}%`),
    // Grouped BY FORM-COLUMN, not flattened. A flat list cannot see a section that moved from column
    // 0 to column 1 with its order and fields intact — which is precisely the topology this fixture
    // exists to prove, so flattening let the oracle pass a form it should have failed.
    sectionsByColumn: columnsOf(t).map((c, ci) => ((c && c.sections) || []).map((s, si) => ({
      name: s.name || `section_${ti}${ci > 0 ? `_${ci}` : ''}_${si}`,
      label: labelOf(s),
      visible: s.visible !== false,
      showLabel: s.showLabel !== false,
      columns: s.columns === undefined ? 1 : s.columns,
      fields: (s.fields || []).map((x) => lc(typeof x === 'string' ? x : x && x.name)),
    }))),
  }));
}

function compiledFormShape(intent) {
  return (intent.tabs || []).map((t) => ({
    name: t.name,
    label: labelOf(t),
    expanded: t.expanded !== false,
    visible: t.visible !== false,
    columnCount: (t.columns || []).length,
    declaredWidths: (t.columns || []).map((c) => (c && c.width) || null),
    sectionsByColumn: (t.columns || []).map((c) => ((c && c.sections) || [])
      .filter((s) => !cellsOfSection(s).some(isSubgridCell))
      .map((s) => ({
        name: s.name,
        label: labelOf(s),
        visible: s.visible !== false,
        showLabel: s.showLabel !== false,
        columns: s.columns === undefined ? 1 : s.columns,
        fields: cellsOfSection(s).map((cell) => lc(cell.control && cell.control.fieldName)),
      }))),
  }));
}

function authoredFormPlacements(form) {
  const out = [];
  const defaults = Object.fromEntries(Object.entries(form.fieldOptions || {}).map(([key, value]) => [lc(key), value]));
  for (const [ti, tab] of (form.tabs || []).entries()) {
    const cols = Array.isArray(tab.columns) ? tab.columns : [{ sections: tab.sections || [] }];
    for (const [ci, col] of cols.entries()) for (const [si, section] of (col.sections || []).entries()) {
      for (const entry of section.fields || []) {
        const field = lc(typeof entry === 'string' ? entry : entry.name);
        const inline = typeof entry === 'string' ? {} : entry;
        const base = defaults[field] || {};
        out.push({
          tab: tab.name || `tab_${ti}`,
          section: section.name || `section_${ti}${ci > 0 ? `_${ci}` : ''}_${si}`,
          field,
          hidden: inline.hidden === true || base.hidden === true,
          readOnly: inline.readOnly === true || base.readOnly === true,
        });
      }
    }
  }
  return out;
}

// Every placed control, flattened. Feeds the two invariants that hold on EVERY layout: a field is
// placed exactly ONCE (the reconcile MOVES a misplaced control between sections — it must never
// duplicate one), and the placed set is exactly the set the form intends to carry.
function formPlacements(intent) {
  const out = [];
  for (const t of intent.tabs || []) {
    for (const c of t.columns || []) {
      for (const s of (c && c.sections) || []) {
        for (const cell of cellsOfSection(s)) {
          if (isSubgridCell(cell) || isNonFieldControl(cell.control)) continue;
          out.push({
            tab: t.name,
            section: s.name,
            field: lc(cell.control && cell.control.fieldName),
            colspan: cell.colspan === undefined ? 1 : cell.colspan,
            rowspan: cell.rowspan === undefined ? 1 : cell.rowspan,
            hidden: cell.visible === false,
            readOnly: !!(cell.control && cell.control.isReadOnly === true),
          });
        }
      }
    }
  }
  return out;
}

// --- download column projection (#574) ----------------------------------------------------------
// Dataverse materialises SHADOW attributes beside every lookup: `<lookup>name`, `<lookup>yominame`,
// and for a polymorphic (Customer / multi-target) lookup also `<lookup>idtype`. None was ever
// authored, and a download that emits them invents Text columns which a fresh-environment rebuild
// then really creates — replacing a lookup with two text fields.
//
// The two shadow shapes differ in the one field that used to be the whole filter. A single-target
// lookup's shadow is logical (`IsLogical: true`); a POLYMORPHIC lookup's shadow is physically stored,
// so `IsLogical` is false and that rule could not see it (#574). `AttributeOf` names the attribute a
// shadow projects and is the fact that covers both. Feeding both shapes through the real projection
// means a regression in EITHER rule surfaces here as an invented column.
//
// Dataverse's own AttributeType spelling per spec type — deliberately written out here rather than
// imported, because this models what the PLATFORM returns, not what the plugin believes.
const DATAVERSE_ATTRIBUTE_TYPE = {
  Text: 'String', Memo: 'Memo', Choice: 'Picklist', MultiChoice: 'Virtual', Boolean: 'Boolean',
  Money: 'Money', DateTime: 'DateTime', Integer: 'Integer', BigInt: 'BigInt', Decimal: 'Decimal',
  Double: 'Double', File: 'File', Image: 'Image', AutoNumber: 'String', Customer: 'Customer',
  Lookup: 'Lookup',
};

function downloadFacts(spec) {
  const out = [];
  for (const e of spec.entities || []) {
    if (!e || e.existing || !e.primaryAttribute) continue;
    const logical = lc(e.schemaName);
    const primary = lc(e.primaryAttribute.schemaName);
    const attrs = [];
    const shadows = [];
    const attr = (o) => attrs.push(Object.assign({ IsCustomAttribute: true, IsLogical: false, AttributeOf: null }, o));
    attr({ SchemaName: e.primaryAttribute.schemaName, LogicalName: primary, AttributeType: 'String' });

    // `polymorphic` picks the IsLogical value Dataverse reports, and gates the third shadow: only a
    // multi-target lookup needs an `idtype` discriminator.
    const addShadows = (lookupLogical, polymorphic) => {
      const isLogical = !polymorphic;
      for (const suffix of ['name', 'yominame']) {
        const n = `${lookupLogical}${suffix}`;
        attr({ SchemaName: n, LogicalName: n, AttributeType: 'String', AttributeOf: lookupLogical, IsLogical: isLogical });
        shadows.push(n);
      }
      if (polymorphic) {
        const n = `${lookupLogical}idtype`;
        attr({ SchemaName: n, LogicalName: n, AttributeType: 'EntityName', AttributeOf: lookupLogical, IsLogical: false });
        shadows.push(n);
      }
    };

    for (const col of e.columns || []) {
      if (!col || !col.schemaName) continue;
      const type = String(col.type || 'Text');
      attr({ SchemaName: col.schemaName, LogicalName: lc(col.schemaName), AttributeType: DATAVERSE_ATTRIBUTE_TYPE[type] || 'String' });
      if (type === 'Customer' || type === 'Lookup') addShadows(lc(col.schemaName), type === 'Customer');
      // A Money column gets a base-currency twin, and it is the awkward case: no `AttributeOf`, not
      // logical, and `IsCustomAttribute: true`, so every shadow rule is blind to it. `IsBaseCurrency`
      // is the only unambiguous signal — deliberately NOT the write-capability flag, which this spec
      // supports on authored read-only columns and which would turn a round-trip into a deletion.
      if (type === 'Money') {
        const twin = `${lc(col.schemaName)}_base`;
        attr({ SchemaName: twin, LogicalName: twin, AttributeType: 'Money', IsBaseCurrency: true });
        shadows.push(twin);
      }
    }
    // A relationship's lookup lands on the REFERENCING table and is single-target, so its shadow is
    // the logical variant. lookupColumnsFor is the same resolver the build side uses.
    for (const l of lookupColumnsFor(spec, logical) || []) {
      if (!l || !l.logical) continue;
      attr({ SchemaName: l.logical, LogicalName: l.logical, AttributeType: 'Lookup' });
      addShadows(l.logical, false);
    }
    // One stock attribute, so the custom-only rule stays under test alongside the shadow rules.
    attr({ SchemaName: 'CreatedOn', LogicalName: 'createdon', AttributeType: 'DateTime', IsCustomAttribute: false });

    const recovered = entityFromMetadata({ primaryNameAttribute: primary, attributes: attrs }, logical);
    out.push({
      entity: logical,
      authoredColumns: (e.columns || []).map((c) => lc(c && c.schemaName)).sort(),
      recoveredColumns: (((recovered && recovered.columns) || []).map((c) => lc(c && c.schemaName))).sort(),
      shadowNames: shadows.sort(),
      systemAttributes: ['createdon'],
    });
  }
  return out;
}

// app: sitemap subarea target facts + navigation-graph validity. appDef resolves page/dashboard
// subareas from a result map; synthesize deterministic ids offline (no build) so the shape is stable.
//
// Page lookup: v2 subareas use stable keys; legacy subareas may use display names. Preserve both
// aliases in this synthetic result map without forcing the key and display name to be identical.
function appFacts(spec) {
  const result = { forms: {}, views: {}, charts: {}, dashboards: {}, pages: {} };
  for (const d of spec.dashboards || []) result.dashboards[d.name] = `dash-${d.name}`;
  for (const p of spec.pages || []) {
    const k = p.key || p.name;
    result.pages[k] = `gp-${k}`;
    // Also retain the display-name alias for legacy references.
    if (p.name && p.name !== k) result.pages[p.name] = `gp-${k}`;
  }
  const def = appDef(spec, result);
  const areas = (def.siteMap.areas || []).map((a) => ({
    groups: (a.groups || []).map((g) => ({
      subAreas: (g.subAreas || []).map((s) => ({
        type: s.type,
        ref: s.entity || s.genPageId || s.dashboardId || s.url || null,
      })),
    })),
  }));

  // Navigation graph: collect every declared nav edge and flag ones whose targetKey has no
  // matching page declaration. These are dangling links that would silently fail at runtime.
  const keys = new Set((spec.pages || []).map((p) => p.key || p.name));
  const danglingNav = [];
  for (const p of spec.pages || []) {
    for (const nav of p.navigatesTo || []) {
      if (!keys.has(nav.targetKey)) danglingNav.push(`${p.key || p.name}→${nav.targetKey}`);
    }
  }
  return { areas, danglingNav };
}

// A synthesized reader that reports every artifact the spec declares as present, so verifySpec's
// reconcile (verify-spec.js) returns ok:true offline — proving the spec is internally verifiable.
// queryRecords always returns a single-element array (rows[0] truthy) so view/chart/form lookups
// all pass. Entity/column lookups are derived from the spec. Sitemap XML is built from appShell
// so entity-subarea checks pass. No pages()/pageCode() needed for intent-only specs.
// Render a spec form's AUTHORED explicit layout as FormXML, so the all-present reader can answer
// the layout oracle too. Without it the reader claims every artifact is present while exposing no
// `formTopology`, and verify now (correctly) reports an explicit layout as UNVERIFIED — a gap in
// the fixture, not a finding about the spec.
//
// Rendered from the COMPILER's own output (compileFormIntent) rather than re-derived, because every
// attribute below is one verify compares: tab and section display flags, the form-column widths the
// compiler fills in (an equal split where the author gave none), its row packing, and each cell's spans
// and read-only / hidden state. A second derivation here drifted from it — an undeclared width rendered
// as 100% in every form-column, and no display flag at all. `columns` is emitted as the width RATIO
// string FormXML actually uses ("11" = two equal columns), not as a count.
function formXmlForAuthoredLayout(spec, form) {
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const labels = (text) => `<labels><label description="${esc(text)}" languagecode="1033"/></labels>`;
  const cellXml = (cell) => {
    const control = cell.control || {};
    const classId = control.classId && control.classId !== 'undefined' ? String(control.classId).replace(/[{}]/g, '') : '';
    return `<cell colspan="${cell.colspan || 1}" rowspan="${cell.rowspan || 1}"${cell.visible === false ? ' visible="false"' : ''}>`
      + `<control${control.fieldName ? ` datafieldname="${esc(control.fieldName)}"` : ''}${classId ? ` classid="{${esc(classId)}}"` : ''}`
      + `${control.isReadOnly ? ' disabled="true"' : ''} /></cell>`;
  };
  const tabsXml = (compileFormIntent(spec, form).tabs || []).map((t) => {
    const colsXml = (t.columns || []).map((col) => {
      const secsXml = (col.sections || []).map((sec) => {
        const width = Math.max(1, Math.min(4, Number(sec.columns) || 1));
        const rowsXml = (sec.rows || []).map((r) => `<row>${(r.cells || []).map(cellXml).join('')}</row>`).join('');
        return `<section name="${esc(sec.name)}" columns="${'1'.repeat(width)}" visible="${sec.visible !== false}" showlabel="${sec.showLabel !== false}">`
          + `${labels(sec.label)}<rows>${rowsXml}</rows></section>`;
      }).join('');
      return `<column width="${esc(col.width)}"><sections>${secsXml}</sections></column>`;
    }).join('');
    return `<tab name="${esc(t.name)}" expanded="${t.expanded !== false}" visible="${t.visible !== false}">${labels(t.label)}<columns>${colsXml}</columns></tab>`;
  }).join('');
  return `<form><tabs>${tabsXml}</tabs></form>`;
}

function makeAllPresentReader(spec, formEvidence = null) {
  const entities = new Set((spec.entities || []).map((e) => lc(e.schemaName)));
  const columnsByEntity = {};
  for (const e of spec.entities || []) {
    columnsByEntity[lc(e.schemaName)] = (e.columns || []).map((c) => ({ logicalName: lc(c.schemaName) }));
  }
  const implementedPages = (spec.pages || []).filter((p) => {
    const source = normalizePageSource(p);
    return source && source.kind === 'tsx' && source.codeFile;
  });
  const idOfPage = (p) => p.pageId || `gp-${p.key || p.name}`;
  const pageByKey = new Map((spec.pages || []).map((p) => [p.key || p.name, p]));

  // Build a sitemap XML fragment covering the entity subareas declared in appShell. The page/icon
  // checks in verifySpec only fire for implemented pages (source.kind==='tsx') — intent-only specs
  // skip them — so omitting GenPage XML is safe for our offline-only fixtures. Nested the way Dataverse
  // stores a sitemap: verifySpec reads nav entries only as a SubArea directly under SiteMap/Area/Group.
  const areasXml = [];
  for (const a of (spec.appShell && spec.appShell.areas) || []) {
    const groupsXml = [];
    for (const g of a.groups || []) {
      const tags = [];
      for (const sa of g.subAreas || []) {
        const attrs = [];
        if (sa.entity) attrs.push(`Entity="${lc(sa.entity)}"`);
        if (sa.page) attrs.push(`Type="GenPage" GenPageId="${pageByKey.has(sa.page) ? idOfPage(pageByKey.get(sa.page)) : `gp-${sa.page}`}"`);
        // Dashboard subarea: verifySpec resolves the dashboard id via queryRecords (which returns
        // formid 'x' below) and then confirms a SubArea points at THAT id via DefaultDashboard — and
        // carries the dashboard launcher Url, as every dashboard entry the build writes does.
        if (sa.dashboard) attrs.push(`Type="Dashboard" DefaultDashboard="x" Url="/workplace/home_dashboards.aspx"`);
        if (sa.icon) attrs.push(`Icon="${lc(sa.icon)}"`);
        tags.push(`<SubArea ${attrs.join(' ')}/>`);
      }
      groupsXml.push(`<Group>${tags.join('')}</Group>`);
    }
    areasXml.push(`<Area${a.icon ? ` Icon="${lc(a.icon)}"` : ''}>${groupsXml.join('')}</Area>`);
  }
  const xml = `<SiteMap>${areasXml.join('')}</SiteMap>`;

  // Business rules and BPFs are both `workflows` rows, and verifySpec reads them with a raw OData
  // filter rather than by name — so an "all present" reader has to answer that query specifically.
  // Returning the generic one-row stub is not enough: the row carries no `statecode`, and verify
  // compares the deployed state against the spec's declared `status`, so every Active rule read as
  // Draft and the fixture failed on an artifact that is, by construction, present.
  //
  // The filters are built by `businessRuleFilter` / `bpfFilter` and differ only by category:
  //   category eq 2 and type eq 1 and name eq 'Lock the summary' and primaryentity eq 'new_case'
  //   category eq 4 and type eq 1 and businessprocesstype eq 0 and name eq '...' and primaryentity eq '...'
  // `odataLit` doubles a literal apostrophe, so undo that when matching the name back.
  const workflowRow = (filter) => {
    const f = String(filter || '');
    const nameMatch = /name eq '((?:[^']|'')*)'/.exec(f);
    if (!nameMatch) return [];
    const wanted = nameMatch[1].replace(/''/g, "'");
    const declared = /category eq 4/.test(f) ? (spec.businessProcessFlows || []) : (spec.businessRules || []);
    const hit = declared.find((x) => x && x.name === wanted);
    if (!hit) return [];
    // Exactly ONE row: verify treats two rows sharing a name as duplicates, which is a real failure
    // and must stay detectable rather than be papered over by a reader that always says "fine".
    return [{ workflowid: `wf-${wanted}`, statecode: (hit.status || 'Active') === 'Active' ? 1 : 0 }];
  };

  // A table's Main form order is part of the spec too (AB#6736948), so each Main form resolves to its
  // OWN id (`form:<name>`) and its formxml carries the <DisplayConditions Order> the build writes, in
  // the build's order (lib/form-order.js). Every other lookup keeps the shared 'x' — dashboards resolve
  // through it in the sitemap above. A Main form is named as verify names it: its `name`, else
  // "<entity> form".
  const mainFormName = (f) => f.name || `${f.entity} form`;
  const withOrder = (xml, entityLogical, form) => {
    const at = (plannedMainFormSequence(spec, entityLogical) || []).indexOf(form);
    return xml.replace(/<\/form>$/, `<DisplayConditions Order="${at < 0 ? 0 : at}" FallbackForm="true"><Everyone /></DisplayConditions></form>`);
  };

  return {
    findTable: async (logical) => (entities.has(logical) ? { logicalName: logical } : null),
    findColumns: async (logical) => columnsByEntity[logical] || [],
    // All view/chart/form/dashboard existence checks pass — the reader always reports present. A
    // `role` query (verifySpec's persona-role check) returns an SDK-authored (marker) role, and a
    // `businessunit` query returns a root BU so the BU-scoped, fail-closed role check resolves offline.
    queryRecords: async (set, opts) => {
      const filter = String((opts && opts.filter) || '');
      if (set === 'systemform' && formEvidence) {
        // Real resolver filters include both the table and numeric type, e.g.
        // objecttypecode eq 'cnt_workitem' and name eq 'Work Item' and type eq 2.
        const name = /\bname eq '((?:[^']|'')*)'/.exec(filter);
        const entity = /\bobjecttypecode eq '((?:[^']|'')*)'/.exec(filter);
        const type = /\btype eq (\d+)/.exec(filter);
        const pin = /\bformid eq ([0-9a-f-]+)/i.exec(filter);
        return (formEvidence.forms || []).filter((f) =>
          (!name || f.name === name[1].replace(/''/g, "'"))
          && (!entity || lc(f.entity) === lc(entity[1].replace(/''/g, "'")))
          && (!type || FORM_TYPE_CODE[f.formType || 'Main'] === Number(type[1]))
          && (!pin || lc(f.id) === lc(pin[1])))
          .map((f) => ({ formid: f.id, objecttypecode: f.entity, type: FORM_TYPE_CODE[f.formType || 'Main'], name: f.name }));
      }
      const mainForm = set === 'systemform' && / type eq 2\b/.test(filter) && /\bname eq '((?:[^']|'')*)'/.exec(filter);
      if (mainForm) return [{ formid: `form:${mainForm[1].replace(/''/g, "'")}` }];
      return set === 'role'
        ? [{ roleid: 'role-x', description: SDK_ROLE_MARKER, ismanaged: false }]
        : set === 'businessunit'
        ? [{ businessunitid: '00000000-0000-0000-0000-000000000001' }]
        : set === 'workflow'
        ? workflowRow(opts && opts.filter)
        : [{ savedqueryid: 'x', savedqueryvisualizationid: 'x', formid: 'x' }];
    },
    sitemapXml: async () => xml,
    sitemapPageIds: async () => implementedPages.map(idOfPage),
    existenceIds: async () => implementedPages.map(idOfPage),
    manifest: async () => ({ pages: implementedPages.map((p) => ({ key: p.key || p.name, pageId: idOfPage(p) })) }),
    // The layout oracle. An "all present" reader that cannot read layouts would make verify report
    // every explicit form as UNVERIFIED — correct behaviour, but a fixture gap rather than a finding
    // about the spec. Rendering the AUTHORED layout is the honest synthesis here: the reader's whole
    // premise is "the environment already matches the spec". A Main form with an auto layout has no
    // authored tabs to render, so it answers with its form order alone.
    formTopology: async (entityLogical, formId) => {
      if (formEvidence) {
        const deployed = (formEvidence.forms || []).find((f) => lc(f.entity) === lc(entityLogical) && lc(f.id) === lc(formId));
        return deployed ? deployed.xml : null;
      }
      const named = /^form:([\s\S]*)$/.exec(String(formId || ''));
      const form = named
        ? (spec.forms || []).find((f) => isMainForm(f) && lc(f.entity) === lc(entityLogical) && mainFormName(f) === named[1])
        : (spec.forms || []).find((f) => lc(f.entity) === lc(entityLogical) && Array.isArray(f.tabs) && f.tabs.length);
      if (!form) return null;
      const layout = Array.isArray(form.tabs) && form.tabs.length ? formXmlForAuthoredLayout(spec, form) : '<form><tabs></tabs></form>';
      return isMainForm(form) ? withOrder(layout, lc(entityLogical), form) : layout;
    },
    servedMainForms: async (entityLogical) => formEvidence
      ? ((formEvidence.servedMainForms || {})[lc(entityLogical)] || [])
      : (plannedMainFormSequence(spec, entityLogical) || []).map((f) => ({ id: `form:${mainFormName(f)}`, name: mainFormName(f) })),
  };
}

function requiredVerifyChecks(spec, reader) {
  const mains = [...new Set((spec.forms || []).filter(isMainForm).map((f) => lc(f.entity)))];
  const ordered = mains.filter((entity) => plannedMainFormSequence(spec, entity));
  const pages = (spec.pages || []).filter((p) => {
    const source = normalizePageSource(p);
    return source && source.kind === 'tsx' && source.codeFile;
  });
  const subareas = ((spec.appShell && spec.appShell.areas) || []).flatMap((a) => (a.groups || []).flatMap((g) => g.subAreas || []));
  const counts = {
    entity: (spec.entities || []).length,
    column: (spec.entities || []).reduce((n, e) => n + (e.columns || []).length, 0),
    view: (spec.views || []).length,
    chart: (spec.charts || []).length,
    form: (spec.forms || []).length,
    dashboard: (spec.dashboards || []).length,
    'form-order': ordered.length,
    'form-topology': (spec.forms || []).filter((f) => Array.isArray(f.tabs) && f.tabs.length).length,
    'form-order-served': typeof reader.servedMainForms === 'function' ? ordered.length : 0,
    'business-rule': (spec.businessRules || []).length,
    'business-process-flow': (spec.businessProcessFlows || []).length,
    role: (spec.personas || []).length,
    subarea: subareas.filter((s) => s.entity || s.dashboard).length,
    'subarea-dashboard-launcher': subareas.filter((s) => s.dashboard).length,
    page: pages.length,
    'page-subarea': pages.length,
  };
  return {
    requiredChecks: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)),
    optionalUnavailable: ordered.length && typeof reader.servedMainForms !== 'function'
      ? [{ capability: 'servedMainForms', reason: 'servedMainForms is unavailable (optional served Main form order reader)' }]
      : [],
  };
}

async function verifyFacts(spec, options = {}) {
  const formEvidence = options.fixture && options.fixture.evidence && options.fixture.evidence.formReconcile;
  const reader = options.verifyReader || makeAllPresentReader(spec, formEvidence);
  const coverage = requiredVerifyChecks(spec, reader);
  try {
    const result = await (options.verifier || verifySpec)(spec, reader);
    if (!result || typeof result.ok !== 'boolean' || !Array.isArray(result.checks) || !Array.isArray(result.missing)) {
      throw new Error('verifySpec returned no valid verification result');
    }
    return { ...result, ...coverage };
  } catch (e) {
    // Required verification is fail-closed. A missing method, broken import or exception is evidence
    // the eval could not prove correctness, not permission to make the corpus greener with a SKIP.
    const error = (e && e.message) || String(e);
    return { ok: false, error, checks: [], missing: [{ kind: 'verify-error', name: 'verifySpec', present: false, detail: error }], ...coverage };
  }
}

const QUICK_VIEW_CLASS_ID = '5c5600e0-1d6e-4205-a272-be80da87fd42';
function quickViewsFromXml(xml) {
  const attr = (raw, name) => {
    const hit = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(raw || '');
    return hit ? decodeXmlEntities(hit[1] === undefined ? hit[2] : hit[1]) : '';
  };
  const out = [];
  // Quick View parameters are nested wire XML, not an ordinary field state:
  // <control classid="{5C5600E0-...}" datafieldname="cnt_projectid"><parameters>
  //   <QuickForms><QuickFormIds><QuickFormId entityname="cnt_project">GUID</QuickFormId>...
  // Also retain a wrong-class control with these parameters so it cannot disappear into a skip.
  const source = String(xml || '').replace(/<!--[\s\S]*?-->/g, '');
  for (const control of source.matchAll(/<control\b([^>]*?)(?:\/>|>([\s\S]*?)<\/control>)/gi)) {
    const classId = attr(control[1], 'classid').replace(/[{}]/g, '').toLowerCase();
    const form = /<QuickFormId\b([^>]*)>([^<]*)<\/QuickFormId>/i.exec(control[2] || '');
    if (classId !== QUICK_VIEW_CLASS_ID && !form) continue;
    out.push({
      classId,
      lookup: lc(attr(control[1], 'datafieldname')),
      targetEntity: form ? lc(attr(form[1], 'entityname')) : '',
      formId: form ? lc(form[2].trim().replace(/[{}]/g, '')) : '',
    });
  }
  return out;
}

function formReconcileFacts(spec, fixture) {
  const evidence = fixture && fixture.evidence && fixture.evidence.formReconcile;
  if (!evidence) return null;
  if (!fixture.baselineSpec) return { error: 'form reconciliation evidence has no baseline App Spec' };
  const before = migrateAppSpec(fixture.baselineSpec);
  const edits = (spec.forms || []).filter((f) => Array.isArray(f.tabs)).map((f) => {
    const prior = (before.forms || []).find((p) => lc(p.entity) === lc(f.entity) && p.name === f.name && (p.formType || 'Main') === (f.formType || 'Main'));
    return { entity: lc(f.entity), name: f.name, before: authoredFormShape(prior), after: authoredFormShape(f) };
  });
  const quickViews = [];
  for (const f of spec.forms || []) for (const qv of f.quickViews || []) {
    const host = (evidence.forms || []).find((p) => lc(p.entity) === lc(f.entity) && p.name === f.name && (p.formType || 'Main') === (f.formType || 'Main'));
    const target = (evidence.forms || []).find((p) => lc(p.entity) === lc(qv.targetEntity) && p.name === qv.form && p.formType === 'QuickView');
    quickViews.push({
      host: f.name, lookup: lc(qv.lookup), targetEntity: lc(qv.targetEntity), form: qv.form,
      formId: target ? lc(target.id) : null,
      deployed: quickViewsFromXml(host && host.xml),
    });
  }
  return {
    baselineValidation: validateAppSpec(before, { profile: 'plan' }),
    edits,
    beforeMainFormOrder: (before.entities || []).map((e) => ({ entity: lc(e.schemaName), forms: e.mainFormOrder || [] })),
    afterMainFormOrder: (spec.entities || []).map((e) => ({ entity: lc(e.schemaName), forms: e.mainFormOrder || [] })),
    quickViews,
  };
}

async function changedOnlyFacts(spec, fixture) {
  const evidence = fixture && fixture.evidence && fixture.evidence.changedOnly;
  if (!evidence) return null;
  try {
    if (!fixture.baselineSpec || !fixture.entityEditSpec) throw new Error('changed-only evidence needs baseline and entity-edited App Specs');
    const baselineDir = path.join(fixture.dir, 'baseline');
    const baseline = migrateAppSpec(fixture.baselineSpec);
    const entityEdit = migrateAppSpec(fixture.entityEditSpec);
    const annotate = (input, dir) => {
      const validation = validateAppSpec(input, { profile: 'deploy' });
      if (!validation.ok) throw new Error(`changed-only input validation: ${validation.errors.join('; ')}`);
      const sourceErrors = pageSourceFileErrors(input, dir);
      if (sourceErrors.length) throw new Error(`changed-only sources: ${sourceErrors.join('; ')}`);
      return annotateContentHashes(input, (relative) => fs.readFileSync(path.join(dir, relative)));
    };
    const prior = annotate(baseline, baselineDir);
    const current = annotate(spec, fixture.dir);
    const columnEdited = annotate(entityEdit, baselineDir);
    const verified = await verifyFacts(baseline);
    if (!verified.ok || Object.entries(verified.requiredChecks).some(([kind, n]) => verified.checks.filter((c) => c.kind === kind).length < n)) {
      throw new Error(`changed-only baseline could not be verified: ${JSON.stringify(verified.missing)}`);
    }
    // Exercise the real envelope lifecycle, including its serialization boundary. No workspace
    // lease, disk snapshot or live identity query is needed to test this pure eligibility gate.
    const envelope = makeEnvelope(evidence.identity, { generation: evidence.generation, priorSpec: prior });
    const promoted = markEligible(envelope);
    if (!promoted.ok) throw new Error(`changed-only snapshot promotion failed: ${promoted.reason}`);
    const persisted = parseEnvelope(serializeEnvelope(envelope));
    if (!persisted) throw new Error('changed-only snapshot could not be parsed after serialization');
    const snapshot = isFastPathEligible(persisted, evidence.identity);
    return {
      baselineVerified: verified.ok,
      snapshot,
      contentHashes: (current.pages || []).map((p) => ({
        key: p.key || p.name,
        before: (persisted.priorSpec.pages || []).find((b) => (b.key || b.name) === (p.key || p.name)).__contentSha,
        after: p.__contentSha,
      })),
      cases: [
        { name: 'page-only', ...classifyChanges(current, persisted.priorSpec) },
        { name: 'column-edit', ...classifyChanges(columnEdited, persisted.priorSpec) },
        { name: 'identical', ...classifyChanges(annotate(baseline, baselineDir), persisted.priorSpec) },
      ],
    };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

// page: PAGEREF_ resolution facts (Plan 3). Returns null when pageref-resolver isn't loaded →
// the assertion layer emits SKIP (loose Plan-3 coupling). When present, each declared nav edge
// is represented as a canonical navigateTo call site so resolvePageRefs can parse and resolve it.
// A missing keyToId entry → unresolved entry (tests prove the assertion can FAIL).
function pageFacts(spec) {
  if (!pagerefResolver) return null;
  const keyToId = new Map((spec.pages || []).map((p) => [p.key || p.name, `gp-${p.key || p.name}`]));
  const sources = new Map();
  // Synthesize a minimal navigateTo() call site for each declared nav edge so extractNavTargets
  // can classify them. A bare `"PAGEREF_x"` string is NOT a nav call site and would be invisible
  // to extractNavTargets, so the synthetic code uses the canonical navigateTo form (design §9).
  for (const p of spec.pages || []) {
    for (const nav of p.navigatesTo || []) {
      sources.set(`${p.key || p.name}:${nav.targetKey}`, {
        code: `navigateTo({ pageType: 'generative', pageId: "PAGEREF_${nav.targetKey}" })`,
      });
    }
  }
  const { unresolved } = pagerefResolver.resolvePageRefs(sources, keyToId);
  return { unresolved };
}

// Normalize an appShell's sitemap subareas to comparable `type:ref` tokens (order-preserving). Works
// for BOTH the authored spec shape and the hydrated (round-tripped) shape, since both express targets
// as { entity | page | dashboard | url }. Lets the round-trip oracle assert the sitemap survived the
// download→rebuild with the same subareas in the same order.
function subareaTargets(appShell) {
  const out = [];
  for (const a of (appShell && appShell.areas) || []) {
    for (const g of a.groups || []) {
      for (const sa of g.subAreas || []) {
        if (sa.entity) out.push(`entity:${lc(sa.entity)}`);
        else if (sa.page) out.push(`page:${sa.page}`);
        else if (sa.dashboard) out.push(`dashboard:${sa.dashboard}`);
        else if (sa.url) out.push(`url:${sa.url}`);
        else out.push('unmapped');
      }
    }
  }
  return out;
}

// teardown: the reverse-of-build delete plan (planTeardown is pure — no I/O). Facts expose the ordered
// artifact `kinds` so assertions can prove dependency-safe ordering (solution last; web resources AFTER
// tables — a table's icon web resource references the table; forms/charts/views/relationships + AI
// summaries BEFORE tables) and coverage (every declared table has a delete step). Mirrors the live
// teardown order in sdk-teardown.js planTeardown.
function teardownFacts(spec) {
  const kinds = planTeardown(spec).map((s) => s.kind);
  return { kinds };
}

// process: the two DECLARATIVE-LOGIC surfaces — `businessRules[]` and `businessProcessFlows[]`.
//
// Both compile to a nested node shape that the platform accepts far more readily than it honours: a
// business rule whose condition tree is mis-shaped deploys, activates, and never fires, and a BPF
// step with no bound field is refused outright by the platform rather than by any local check. So
// what matters here is not "did we emit something" but WHICH COLUMNS the emitted definition actually
// binds — the one property a downstream reader can compare against the spec's own data model.
//
// Facts are taken from the same pure def builders the engine pushes (`businessRuleDef` / `bpfDef`),
// so a mapping change that silently drops a field shows up as a missing binding rather than as a
// still-green count.
function processFacts(spec) {
  const rules = (spec.businessRules || []).map((r) => {
    const def = businessRuleDef(r);
    const clauses = (def.rootCondition && def.rootCondition.clauses) || [];
    const actions = (def.rootCondition && def.rootCondition.trueBranch) || [];
    return {
      name: def.name,
      entity: lc(def.entityLogicalName),
      status: def.status,
      // Every column the compiled rule touches, from both halves of the tree. A rule that binds a
      // column the app does not create is authored against nothing.
      fields: [...clauses.map((c) => lc(c.field)), ...actions.map((a) => lc(a.field))].filter(Boolean),
      operators: clauses.map((c) => c.operator),
      actionTypes: actions.map((a) => a.type),
    };
  });
  const flows = (spec.businessProcessFlows || []).map((f) => {
    const def = bpfDef(f);
    const stages = (def.stages || []).map((st) => ({
      name: st.name,
      entity: lc(st.entityLogicalName),
      steps: (st.steps || []).map((s) => ({ name: s.name, field: lc(s.fieldName), required: s.required === true })),
    }));
    return {
      name: def.name,
      entity: lc(def.entityLogicalName),
      status: def.status,
      stages,
      // Flattened for the binding check: a step whose `fieldName` did not survive the mapping
      // arrives here as an empty string, which the assertion reports by stage and step name.
      steps: stages.flatMap((st) => st.steps.map((s) => ({ stage: st.name, ...s }))),
    };
  });
  return { rules, flows };
}

// A synthetic "deployed app" reader built from the spec, so hydrateSpec (the pure download primitive)
// round-trips offline: the spec is projected into the deployed shapes hydrate consumes (sitemap JSON,
// pages with a GenPageId, entities, dashboards keyed by id), then hydrated back. Synthetic ids are
// deterministic (`gp-<key>` / `dash-<name>`) so GenPage/DashBoard subareas resolve back to their
// page-key / dashboard-name exactly as a live download would.
function buildDeployedReader(spec, downloadedPages = null) {
  const idOf = (p) => p.pageId || `gp-${p.key || p.name}`;
  const areas = ((spec.appShell && spec.appShell.areas) || []).map((a) => ({
    title: a.label,
    ...(a.icon ? { icon: a.icon } : {}),
    ...(a.vectorIcon ? { vectorIcon: a.vectorIcon } : {}),
    groups: (a.groups || []).map((g) => ({
      title: g.label,
      subAreas: (g.subAreas || []).map((sa) => {
        const base = { title: sa.title, ...(sa.icon ? { icon: sa.icon } : {}), ...(sa.vectorIcon ? { vectorIcon: sa.vectorIcon } : {}) };
        if (sa.entity) return { ...base, type: 'Entity', entity: sa.entity };
        if (sa.page) {
          const page = (spec.pages || []).find((p) => (p.key || p.name) === sa.page);
          return { ...base, type: 'GenPage', genPageId: page ? idOf(page) : `gp-${sa.page}` };
        }
        if (sa.dashboard) return { ...base, type: 'DashBoard', dashboardId: `dash-${sa.dashboard}` };
        if (sa.url) return { ...base, type: 'URL', url: sa.url };
        return base;
      }),
    })),
  }));
  return {
    app: async () => ({ name: spec.app.name, description: spec.app.description || '', siteMap: { areas } }),
    // Emit the v2 (keyed) page shape so hydrate resolves GenPage subareas by key and preserves them.
    pages: async () => downloadedPages || (spec.pages || []).map((p) => ({
      pageId: idOf(p), key: p.key || p.name, name: p.name,
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
      ...(p.dataSources ? { dataSources: p.dataSources } : {}),
      ...(p.navigatesTo ? { navigatesTo: p.navigatesTo } : {}),
      ...(p.pageInput !== undefined ? { pageInput: p.pageInput } : {}),
      // The manifest carries `directEntry` alongside `pageInput` (page-manifest.js), so the synthetic
      // reader must too. Omitting it let hydration's back-compat default silently rewrite an authored
      // `selector` to `emptyState` while the losslessness assertion below stayed green — the eval
      // proving a round-trip it was not actually checking.
      ...(p.directEntry !== undefined ? { directEntry: p.directEntry } : {}),
      codeFile: `pages/gp-${p.key || p.name}/page.tsx`,
    })),
    entities: async () => (spec.entities || []).map((e) => ({ schemaName: e.schemaName, primaryAttribute: e.primaryAttribute, columns: [] })),
    webResources: async () => spec.webResources || [],
    dashboards: async () => (spec.dashboards || []).map((d) => ({ id: `dash-${d.name}`, name: d.name, tiles: d.tiles || [] })),
    solution: async () => spec.solution,
    design: async () => spec.design,
  };
}

// round-trip: project the spec into a deployed app, hydrate it back, and expose the recovered
// solution / tables / page metadata / sitemap for the compared hydration subset. A hydrate error is
// captured as `error` and surfaced by assertions; no build or live download is executed here.
async function roundTripFacts(spec, options = {}) {
  let hydrated, downloadedPages = null;
  const unreadableConfigs = [], unkeptModels = [];
  const fixture = options.fixture;
  const evidence = fixture && fixture.evidence && fixture.evidence.pageRoundTrip;
  try {
    if (evidence) {
      const rawNames = new Map((evidence.envPages || []).map((p) => [lc(p.pageId), p.name]));
      const titles = new Map();
      for (const a of (spec.appShell && spec.appShell.areas) || []) for (const g of a.groups || []) for (const sa of g.subAreas || []) {
        if (sa.page) titles.set(sa.page, sa.title);
      }
      // Match download's seam: env-wide names outrank sitemap titles; PAC's \" is decoded before
      // parseDownloadedPages reads the real config files, then assignPageKeys supplies stable keys.
      const nameById = new Map((spec.pages || []).map((p) => [lc(p.pageId),
        unescapePacName(rawNames.get(lc(p.pageId)) || titles.get(p.key || p.name) || p.pageId)]));
      downloadedPages = parseDownloadedPages(path.join(fixture.dir, 'pages'), fixture.dir, nameById, unreadableConfigs, unkeptModels);
      assignPageKeys(downloadedPages, { pages: spec.pages || [] }, new Map((spec.pages || []).map((p) => [p.key || p.name, p.pageId])));
    }
    hydrated = await (options.hydrator || hydrateSpec)(buildDeployedReader(spec, downloadedPages));
  }
  catch (e) { return { error: (e && e.message) || String(e) }; }
  return {
    source: evidence ? 'pac-download-fixture' : 'synthetic-reader',
    solution: hydrated.solution && hydrated.solution.uniqueName,
    tables: (hydrated.entities || []).map((e) => lc(e.schemaName)).sort(),
    pageKeys: (hydrated.pages || []).map((p) => p.key || p.name).sort(),
    origSubareaTargets: subareaTargets(spec.appShell),
    hydratedSubareaTargets: subareaTargets(hydrated.appShell),
    // Exposed so a losslessness assertion can actually SEE this field. Hydration defaults a missing
    // `directEntry` for back-compat, so a fact set that never projected it could not tell a preserved
    // value from a silently rewritten one.
    origDirectEntry: directEntryByKey(spec.pages),
    hydratedDirectEntry: directEntryByKey(hydrated.pages),
    pageMetadata: (hydrated.pages || []).map((p) => ({
      key: p.key || p.name, pageId: p.pageId || null, name: p.name,
      model: p.model === undefined ? null : p.model,
      dataSources: p.dataSources || [],
    })).sort((a, b) => String(a.key).localeCompare(String(b.key))),
    unreadableConfigs,
    unkeptModels,
  };
}

// key -> directEntry.behavior, for pages that declare one. Sorted-key object so a comparison is
// order-independent.
function directEntryByKey(pages) {
  const out = {};
  for (const p of pages || []) {
    if (p && p.directEntry && p.directEntry.behavior) out[p.key || p.name] = p.directEntry.behavior;
  }
  return out;
}

// security: per-persona role facts from the pure spec->SDK mapper (personaRoleSpecFor). For each persona
// it exposes: the injected app-module read flag (so the app opens) unless the persona opts out; the
// DECLARED privilege union (author intent, from the raw spec) and the GRANTED union (what the role will
// carry, from the mapper — appmodule read included) so the least-privilege eval can prove the role does
// not exceed what was declared; and `unresolvedAppTables` — declared entities that carry the app's own
// publisher prefix but are not provisioned (a hallucinated/typo table the persona could never use).
// Empty for a spec with no personas — the assertions then pass trivially, so this fact is safe on every
// fixture.
function securityFacts(spec) {
  // App-owned publisher prefixes + the set of provisioned tables. #1 (JTBD coverage) flags a persona
  // privilege that names an APP-prefixed table the app never provisions. External/system tables
  // (account, msdyn_*, no prefix) are exempt — their existence is a LIVE metadata check the offline
  // harness can't (and shouldn't) make.
  const appTables = new Set((spec.entities || []).map((e) => lc(e.schemaName)));
  const appPrefixes = new Set([...appTables].map((t) => t.split('_')[0]).filter(Boolean));
  // Also treat the solution's declared publisher prefix as app-owned. Without this, an app that
  // provisions ONLY external tables yields no entity-derived prefix, so a persona privilege on a
  // <prefix>_typo table (a hallucinated app table) would go unflagged.
  const pubPrefix = spec.solution && spec.solution.publisherPrefix;
  if (pubPrefix) appPrefixes.add(lc(pubPrefix));

  // Serialize a union Map (entity -> access -> scope) to a plain nested object so facts stay
  // JSON-comparable and the assertion layer / tests can diff them without Map handling.
  const serialize = (m) => Object.fromEntries([...m.entries()].map(([ent, byAccess]) => [ent, Object.fromEntries([...byAccess.entries()].sort())]));

  return (spec.personas || []).map((p) => {
    const mapped = personaRoleSpecFor(p);
    const grantedList = flattenPrivileges({ jobs: mapped.jobs, additionalPrivileges: mapped.additionalPrivileges });
    const declared = unionPrivileges(flattenPrivileges(p)); // author intent (no appmodule injection)
    const granted = unionPrivileges(grantedList); // role's actual grant (appmodule read included)

    const appModuleRead = (mapped.additionalPrivileges || []).some((pr) => lc(pr.entity) === 'appmodule' && (pr.access || []).map(lc).includes('read'));
    const unresolvedAppTables = [...declared.keys()].filter((ent) => !appTables.has(ent) && appPrefixes.has(ent.split('_')[0]));

    return {
      persona: p.persona,
      appAccess: p.appAccess !== false,
      appModuleRead,
      privileges: grantedList.length,
      declared: serialize(declared),
      granted: serialize(granted),
      unresolvedAppTables,
    };
  });
}

async function stageFacts(rawSpec, options = {}) {
  // Capture approved text before any producer sees the input. Comparing with rawSpec after a
  // mutating lint/migration would let a sanitizer rewrite both the result and its expectation.
  const approvedPageNames = (Array.isArray(rawSpec && rawSpec.pages) ? rawSpec.pages : []).map((p) => p && p.name);
  const spec = migrateAppSpec(rawSpec);
  return {
    author: authorFacts(spec, approvedPageNames),
    plan: planFacts(spec),
    data: schemaFacts(spec),
    ui: wireFacts(spec),
    app: appFacts(spec),
    security: securityFacts(spec),
    verify: await verifyFacts(spec, options),
    formReconcile: formReconcileFacts(spec, options.fixture),
    changedOnly: await changedOnlyFacts(spec, options.fixture),
    page: pageFacts(spec),
    process: processFacts(spec),
    teardown: teardownFacts(spec),
    download: downloadFacts(spec),
    roundTrip: await roundTripFacts(spec, options),
    PHASES,
  };
}

module.exports = { stageFacts, makeAllPresentReader };
