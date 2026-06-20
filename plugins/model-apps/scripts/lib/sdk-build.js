'use strict';
// SDK build engine: turn a validated App Spec into ordered @maker-studio/cds-maker-sdk
// calls, emitting granular progress events the orchestrator narrates. Deterministic and
// IDEMPOTENT — every table/column/relationship/solution is checked-then-created, so new,
// existing, and mixed environments all work (create-table is automatically optional).
// All Dataverse access goes through the SDK (findTables/findColumns/fetchEntityMetadata for
// discovery, create* for writes), so the workspace ends up holding the metadata for reuse.
//
// Phases (ordered): solution · data-model · sample-data · views · charts · forms · app-shell
//   · publish.  Select a subset with opts.phases (see resolvePhases).
// emit(event): { phase, status:'start'|'ok'|'skip'|'error', label, n, total, detail? }
// On an SDK error, throws a BuildHalt the orchestrator can gate on (AskUserQuestion).

const {
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  relationshipSchemaName,
} = require('./app-spec.js');
const { topoOrderEntities } = require('./_graph.js');

// App Spec column type -> SDK ColumnType. Lookup is omitted: it's a side effect of a
// OneToMany relationship, never a column.
const SDK_COLUMN_TYPE = {
  Text: 'string', Memo: 'memo', Choice: 'choice', Boolean: 'boolean',
  Money: 'money', DateTime: 'dateTime', Integer: 'integer', Decimal: 'decimal',
};

// Standard field control classId (Dataverse picks the widget by attribute type) and the
// classic Notes/timeline control classId.
const STD_FIELD_CLASS_ID = '4273EDBD-AC1D-40d3-9FB2-095C621B552D';
const NOTES_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E';
const COMPONENT_TYPE = { view: 26, chart: 59, form: 60, app: 80 };

const PHASES = ['solution', 'data-model', 'sample-data', 'views', 'charts', 'forms', 'app-shell', 'publish'];

class BuildHalt extends Error {
  constructor(message, { phase, code, recoverable = false, cause } = {}) {
    super(message);
    this.name = 'BuildHalt';
    this.phase = phase;
    this.code = code;
    this.recoverable = recoverable;
    this.cause = cause;
  }
}

/** Resolve --only/--skip/--from/--to into the ordered set of phases to run. */
function resolvePhases({ only, skip, from, to } = {}) {
  let active = PHASES.slice();
  if (from) { const i = active.indexOf(from); if (i >= 0) active = active.slice(i); }
  if (to) { const i = active.indexOf(to); if (i >= 0) active = active.slice(0, i + 1); }
  const onlySet = only && new Set([].concat(only));
  const skipSet = skip && new Set([].concat(skip));
  return active.filter((p) => (!onlySet || onlySet.has(p)) && (!skipSet || !skipSet.has(p)));
}

// Bounded-concurrency map — parallelize independent ops without flooding Dataverse (which
// raises SQL-deadlock risk). Preserves input order in the result.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function choiceOptions(col) {
  return (col.options || []).map((label, i) => ({ value: 100000000 + i, label }));
}
function entityByLogical(spec, logical) {
  const l = String(logical).toLowerCase();
  return (spec.entities || []).find((e) => e.schemaName.toLowerCase() === l);
}
function primaryNameOf(spec, logical) {
  const e = entityByLogical(spec, logical);
  return e ? e.primaryAttribute.schemaName.toLowerCase() : `${String(logical).toLowerCase()}name`;
}

// --- the ordered plan (dry-run + totals) -----------------------------------------------
function planFor(spec, opts) {
  const has = (p) => !opts.phases || opts.phases.includes(p);
  const items = [];
  const sol = spec.solution;
  if (has('solution')) items.push({ phase: 'solution', label: `solution ${sol.uniqueName} (publisher ${sol.publisherPrefix})` });
  if (has('data-model')) {
    for (const e of spec.entities) {
      items.push({ phase: 'data-model', label: `table ${e.schemaName} ("${e.displayName}")` });
      for (const c of e.columns || []) {
        if (SDK_COLUMN_TYPE[c.type || 'Text']) items.push({ phase: 'data-model', label: `column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})` });
      }
    }
    for (const r of spec.relationships || []) {
      if (r.type === 'OneToMany') items.push({ phase: 'data-model', label: `relationship 1:N ${r.referenced}->${r.referencing}` });
    }
  }
  if (has('sample-data') && opts.sampleData) {
    for (const e of spec.entities) { const n = sampleRecordsFor(spec, e).length; if (n) items.push({ phase: 'sample-data', label: `${n} sample record(s) -> ${e.schemaName}` }); }
  }
  if (has('views')) for (const v of spec.views) items.push({ phase: 'views', label: `view "${v.name}" for ${v.entity}` });
  if (has('charts')) for (const c of spec.charts || []) items.push({ phase: 'charts', label: `chart "${c.name}" (${c.chartType}) for ${c.entity}` });
  if (has('forms')) for (const f of spec.forms) { const subs = (f.subgrids || []).map((s) => s.childEntity).join(', '); items.push({ phase: 'forms', label: `form for ${f.entity}${subs ? ` (sub-grids: ${subs})` : ''}` }); }
  if (has('app-shell')) items.push({ phase: 'app-shell', label: `app module "${spec.app.name}" + sitemap` });
  if (has('publish') && opts.publish) items.push({ phase: 'publish', label: 'publish customizations' });
  return items;
}

// --- phase builders (pure: spec -> SDK payloads) ---------------------------------------
function viewDef(spec, v) {
  const entityLogical = v.entity.toLowerCase();
  const cols = (v.columns && v.columns.length ? v.columns : [primaryNameOf(spec, entityLogical)]).map((name, i) => ({ name: String(name).toLowerCase(), width: 100, order: i }));
  const filters = v.activeOnly === false
    ? { type: 'and', conditions: [], groups: [] }
    : { type: 'and', conditions: [{ attribute: 'statecode', operator: 'eq', value: '0' }], groups: [] };
  return { name: v.name, description: '', entityLogicalName: entityLogical, queryType: 0, isDefault: false, columns: cols, filters,
    sort: (v.sort || []).map((s) => ({ attribute: String(s.attr).toLowerCase(), descending: s.dir === 'desc' })) };
}

function chartDef(spec, ch) {
  const entityLogical = ch.entity.toLowerCase();
  return { name: ch.name, description: '', entityLogicalName: entityLogical, chartType: ch.chartType, isDefault: false,
    series: [{ attribute: `${entityLogical}id`, aggregate: ch.measure || 'count' }],
    categories: [{ attribute: String(ch.groupBy).toLowerCase() }], presentation: { showLegend: true, title: ch.name } };
}

function fieldCell(logical, label, required) {
  return { visible: true, colspan: 1, rowspan: 1,
    control: { id: logical, classId: STD_FIELD_CLASS_ID, fieldName: logical, type: 'standard', isRequired: !!required, isReadOnly: false, label, showLabel: true, parameters: {} } };
}
function notesCell() {
  return { visible: true, colspan: 1, rowspan: 1,
    control: { id: 'notescontrol', classId: NOTES_CLASS_ID, fieldName: null, type: 'notes', isRequired: false, isReadOnly: false, label: 'Notes', showLabel: false, parameters: {} } };
}
// Arrange field cells into `columns` cells-per-row.
function rowsFromCells(cells, columns) {
  const cols = Math.max(1, Math.min(4, columns || 1));
  const rows = [];
  for (let i = 0; i < cells.length; i += cols) rows.push({ cells: cells.slice(i, i + cols) });
  return rows;
}

// Build a Main-form definition. Honors explicit `tabs`/`sections`/`columns` from the spec;
// otherwise lays the primary + scalar columns into a "General" section (2-column when the
// table is field-heavy). Adds a Notes section when the form/entity opts in.
function formDef(spec, f) {
  const entityLogical = f.entity.toLowerCase();
  const entity = entityByLogical(spec, entityLogical);
  const labelFor = (logical) => {
    if (entity && logical === entity.primaryAttribute.schemaName.toLowerCase()) return entity.primaryAttribute.displayName || 'Name';
    const c = entity && (entity.columns || []).find((x) => x.schemaName.toLowerCase() === logical);
    return (c && (c.displayName || c.schemaName)) || logical;
  };
  const requiredFor = (logical) => {
    if (entity && logical === entity.primaryAttribute.schemaName.toLowerCase()) return true;
    const c = entity && (entity.columns || []).find((x) => x.schemaName.toLowerCase() === logical);
    return !!(c && c.required === true);
  };

  let tabs;
  const explicit = Array.isArray(f.tabs) || f.layout === 'explicit';
  if (explicit && Array.isArray(f.tabs)) {
    // Honor the authored layout verbatim.
    tabs = f.tabs.map((t, ti) => ({
      name: t.name || `tab_${ti}`, label: t.label || 'General', expanded: true, visible: true,
      sections: (t.sections || []).map((s, si) => {
        const cells = (s.fields || []).map((fl) => { const lg = String(fl).toLowerCase(); return fieldCell(lg, labelFor(lg), requiredFor(lg)); });
        return { name: s.name || `section_${ti}_${si}`, label: s.label || 'Details', visible: true, showLabel: s.showLabel !== false, columns: s.columns || 1, rows: rowsFromCells(cells, s.columns || 1) };
      }),
    }));
  } else {
    // Auto: primary + every scalar column. 2-column when field-heavy (> 6), else 1.
    const cells = [];
    if (entity) {
      cells.push(fieldCell(entity.primaryAttribute.schemaName.toLowerCase(), entity.primaryAttribute.displayName || 'Name', true));
      for (const c of entity.columns || []) { if (!SDK_COLUMN_TYPE[c.type || 'Text']) continue; cells.push(fieldCell(c.schemaName.toLowerCase(), c.displayName || c.schemaName, c.required === true)); }
    }
    const columns = cells.length > 6 ? 2 : 1;
    tabs = [{ name: 'tab_general', label: 'General', expanded: true, visible: true,
      sections: [{ name: 'section_general', label: 'General', visible: true, showLabel: false, columns, rows: rowsFromCells(cells, columns) }] }];
  }

  // Notes section (opt-in: form.notes or entity.hasNotes).
  const wantNotes = f.notes === true || (entity && entity.hasNotes === true);
  if (wantNotes) {
    tabs[0].sections.push({ name: 'section_notes', label: 'Notes', visible: true, showLabel: true, columns: 1, rows: [{ cells: [notesCell()] }] });
  }

  return { entityLogicalName: entityLogical, name: f.name || `${f.entity} form`, formType: 'Main', status: 'Active', tabs };
}

function appDef(spec, result) {
  const sol = spec.solution;
  const uniqueName = `${sol.publisherPrefix}_${spec.app.name}`.replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const areas = (spec.appShell.areas || []).map((a, ai) => ({ id: `area_${ai}`, title: a.label,
    groups: (a.groups || []).map((g, gi) => ({ id: `group_${ai}_${gi}`, title: g.label,
      subAreas: (g.subAreas || []).map((s, si) => ({ id: `sub_${ai}_${gi}_${si}`, type: 'Entity', entity: s.entity && s.entity.toLowerCase(), title: s.title })) })) }));
  return { name: spec.app.name, uniqueName, description: spec.app.description || '', siteMap: { areas },
    components: { forms: Object.values(result.forms || {}).filter(Boolean), views: Object.values(result.views || {}).filter(Boolean), charts: Object.values(result.charts || {}).filter(Boolean) } };
}

// --- orchestrator ----------------------------------------------------------------------
async function runSdkBuild(spec, opts = {}) {
  const { sdk, apply = false, sampleData = false, publish = false } = opts;
  const emit = opts.emit || (() => undefined);
  // Header-less client for solution lifecycle + artifact pushes (Dataverse rejects the
  // MSCRM.SolutionUniqueName header on createSolution and on savedquery/systemform/appmodule
  // creates); metadata + records keep the header-ful `sdk`. Reads (find*/fetch*) ignore the
  // header, so either client works for discovery.
  const provision = opts.provisionSdk || sdk;
  const phases = opts.phases || PHASES;
  const has = (p) => phases.includes(p);
  const concurrency = opts.concurrency || 4;
  const plan = planFor(spec, { sampleData, publish, phases });

  if (!apply) {
    plan.forEach((p, i) => emit({ phase: p.phase, status: 'skip', label: p.label, n: i + 1, total: plan.length }));
    return { ok: true, dryRun: true, plan: plan.map((p) => p.label) };
  }

  const result = { ok: true, created: { entities: {}, relationships: {}, records: {}, views: {}, charts: {}, forms: {}, app: null } };
  const total = plan.length;
  let n = 0;
  const run = async (phase, label, fn, { recoverable = false } = {}) => {
    const myN = (n += 1);
    emit({ phase, status: 'start', label, n: myN, total });
    try {
      const out = await fn();
      emit({ phase, status: 'ok', label, n: myN, total });
      return out;
    } catch (err) {
      emit({ phase, status: 'error', label, n: myN, total, detail: String((err && err.message) || err) });
      throw new BuildHalt(`${phase} failed: ${(err && err.message) || err}`, { phase, code: (err && err.code) || 'sdk-error', recoverable, cause: err });
    }
  };
  const sol = spec.solution;

  // 1. Solution (idempotent; header-less provisioning client).
  if (has('solution')) {
    await run('solution', `solution ${sol.uniqueName}`, async () => {
      const existing = await provision.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${sol.uniqueName}'`, top: 1 });
      if (existing && existing[0]) return;
      let publisherId;
      const pubs = await provision.queryRecords('publisher', { select: ['publisherid'], filter: `customizationprefix eq '${sol.publisherPrefix}'`, top: 1 });
      if (pubs && pubs[0] && pubs[0].publisherid) publisherId = pubs[0].publisherid;
      else publisherId = (await provision.createPublisher({ uniqueName: `${sol.publisherPrefix}publisher`, friendlyName: `${sol.publisherPrefix} publisher`, prefix: sol.publisherPrefix })).id;
      await provision.createSolution({ uniqueName: sol.uniqueName, friendlyName: sol.displayName || sol.uniqueName, publisherId });
    }, { recoverable: true });
  }

  // 2. Data model — idempotent. Discover existing tables/columns/relationships via the SDK
  //    (find*/fetch*), then create only what's missing. Captures entitySetName for every
  //    entity (fresh -> createTable result, existing -> findTables hit).
  if (has('data-model')) {
    for (const e of spec.entities) {
      const logical = e.schemaName.toLowerCase();
      const hits = await provision.findTables(e.schemaName, { top: 50 });
      const existingTable = (hits || []).find((t) => t.logicalName === logical);
      let existingCols = new Set();
      if (existingTable) {
        emit({ phase: 'data-model', status: 'skip', label: `table ${e.schemaName} (exists — reuse)`, n: (n += 1), total });
        result.created.entities[e.schemaName] = { logicalName: logical, entitySetName: existingTable.entitySetName };
        existingCols = new Set(((await provision.findColumns(logical)) || []).map((c) => c.logicalName));
      } else {
        await run('data-model', `table ${e.schemaName}`, async () => {
          const t = await sdk.createTable({ schemaName: e.schemaName, displayName: e.displayName, pluralName: e.pluralName || `${e.displayName}s`,
            primaryColumnSchemaName: e.primaryAttribute.schemaName, primaryColumnDisplayName: e.primaryAttribute.displayName || 'Name', hasNotes: e.hasNotes === true });
          result.created.entities[e.schemaName] = { logicalName: (t.logicalName || logical), entitySetName: t.entitySetName };
        }, { recoverable: true });
      }
      // Columns: create only the missing ones (parallel, bounded).
      const toAdd = (e.columns || []).filter((c) => SDK_COLUMN_TYPE[c.type || 'Text'] && !existingCols.has(c.schemaName.toLowerCase()));
      await mapLimit(toAdd, concurrency, (c) => run('data-model', `column ${e.schemaName}.${c.schemaName}`, async () => {
        const col = { schemaName: c.schemaName, displayName: c.displayName || c.schemaName, type: SDK_COLUMN_TYPE[c.type || 'Text'] };
        if (c.type === 'Choice') col.options = choiceOptions(c);
        await sdk.createColumn(logical, col);
      }));
    }
    // Relationships: skip those already on the referenced entity.
    for (const rel of spec.relationships || []) {
      if (rel.type !== 'OneToMany') continue;
      const schema = relationshipSchemaName(rel);
      let exists = false;
      try { exists = ((await provision.fetchEntityMetadata(rel.referenced.toLowerCase())).relationships || []).some((r) => r.schemaName.toLowerCase() === schema.toLowerCase()); } catch { /* referenced just created — none yet */ }
      if (exists) { emit({ phase: 'data-model', status: 'skip', label: `relationship ${schema} (exists)`, n: (n += 1), total }); continue; }
      await run('data-model', `relationship ${rel.referenced}->${rel.referencing}`, async () => {
        await sdk.createRelationship({ type: 'OneToMany', schemaName: schema, referencedEntity: rel.referenced.toLowerCase(), referencingEntity: rel.referencing.toLowerCase(),
          lookupSchemaName: rel.lookup.schemaName, lookupDisplayName: rel.lookup.displayName });
      });
    }
  }

  // entity-set resolver: fresh tables cached above; existing ones via fetchEntityMetadata.
  const entitySetCache = {};
  const entitySetFor = async (logical) => {
    const ent = entityByLogical(spec, logical);
    const cached = ent && result.created.entities[ent.schemaName] && result.created.entities[ent.schemaName].entitySetName;
    if (cached) return cached;
    if (!entitySetCache[logical]) entitySetCache[logical] = (await provision.fetchEntityMetadata(logical)).entitySetName;
    return entitySetCache[logical];
  };

  // 3. Sample data (opt-in): topological, $parent -> @odata.bind on the lookup nav prop.
  if (has('sample-data') && sampleData) {
    const createdByEntity = {};
    for (const e of topoOrderEntities(spec)) {
      const records = sampleRecordsFor(spec, e);
      if (!records.length) continue;
      await run('sample-data', `${records.length} record(s) -> ${e.schemaName}`, async () => {
        const entityLogical = e.schemaName.toLowerCase();
        const resolved = resolveSampleRecords(e, records);
        const bodies = [];
        for (let i = 0; i < resolved.length; i++) {
          const raw = records[i];
          const body = Object.assign({}, resolved[i]);
          delete body.$parent;
          const parent = raw && raw.$parent;
          if (parent && parent.entity && parent.match) {
            const parentLogical = parent.entity.toLowerCase();
            const hit = (createdByEntity[parentLogical] || []).find((h) => Object.entries(parent.match).every(([k, v]) => { const rk = Object.keys(h.raw).find((x) => x.toLowerCase() === k.toLowerCase()); return rk !== undefined && h.raw[rk] === v; }));
            const rel = relationshipFor(spec, parent.entity, e.schemaName);
            if (hit && hit.id && rel) body[`${rel.lookup.schemaName}@odata.bind`] = `/${await entitySetFor(parentLogical)}(${hit.id})`;
          }
          bodies.push(body);
        }
        const ids = await sdk.createRecordsBulk(entityLogical, bodies);
        result.created.records[e.schemaName] = ids;
        createdByEntity[entityLogical] = records.map((raw, i) => ({ raw, id: ids[i] })).filter((p) => p.id != null);
      });
    }
  }

  // helper: create an artifact header-less, push, add to the solution.
  const buildArtifact = (type, def) => run(type === 'app' ? 'app-shell' : `${type}s`, `${type} "${def.name}"`, async () => {
    const art = provision.createArtifact(type, def);
    if (type === 'form' && def.__subgrids) for (const sg of def.__subgrids) provision.addSubGrid(art.id, sg);
    const pushed = await provision.pushArtifact(type, art.id);
    await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE[type], solutionUniqueName: sol.uniqueName });
    return pushed.id;
  });

  // 4. Views (independent -> parallel).
  if (has('views')) {
    const ids = await mapLimit(spec.views, concurrency, (v) => buildArtifact('view', viewDef(spec, v)));
    spec.views.forEach((v, i) => { result.created.views[v.name] = ids[i]; });
  }

  // 5. Charts (independent -> parallel; built before forms so a form could reference one).
  if (has('charts')) {
    const charts = spec.charts || [];
    const ids = await mapLimit(charts, concurrency, (c) => buildArtifact('chart', chartDef(spec, c)));
    charts.forEach((c, i) => { result.created.charts[c.name] = ids[i]; });
  }

  // 6. Forms (independent -> parallel; sub-grids reference the child view ids built above).
  if (has('forms')) {
    const defs = spec.forms.map((f) => {
      const def = formDef(spec, f);
      def.__subgrids = (f.subgrids || []).map((sg) => {
        const rel = relationshipFor(spec, f.entity, sg.childEntity); if (!rel) return null;
        const childLogical = sg.childEntity.toLowerCase();
        let viewId = sg.view && result.created.views[sg.view];
        if (!viewId) { const cv = (spec.views || []).find((v) => v.entity.toLowerCase() === childLogical); viewId = cv && result.created.views[cv.name]; }
        return { entity: childLogical, relationshipName: relationshipSchemaName(rel), viewId, label: sg.label || sg.childEntity };
      }).filter(Boolean);
      return { f, def };
    });
    const ids = await mapLimit(defs, concurrency, (d) => buildArtifact('form', d.def));
    defs.forEach((d, i) => { result.created.forms[d.f.entity.toLowerCase()] = ids[i]; });
  }

  // 7. App module + sitemap.
  if (has('app-shell')) {
    result.created.app = await buildArtifact('app', appDef(spec, result.created));
  }

  // 8. Publish (opt-in). Publish ONE artifact per entity (covers that entity's customizations)
  //    + the app — far fewer PublishXml round-trips than publishing every artifact.
  if (has('publish') && publish) {
    await run('publish', 'publish customizations', async () => {
      const seen = new Set();
      const perEntity = []; // [type, id] — first artifact found per entity
      for (const f of spec.forms) { const id = result.created.forms[f.entity.toLowerCase()]; if (id && !seen.has(f.entity.toLowerCase())) { seen.add(f.entity.toLowerCase()); perEntity.push(['form', id]); } }
      for (const v of spec.views) { const k = v.entity.toLowerCase(); if (result.created.views[v.name] && !seen.has(k)) { seen.add(k); perEntity.push(['view', result.created.views[v.name]]); } }
      await mapLimit(perEntity, concurrency, ([type, id]) => provision.publishArtifact(type, id));
      if (result.created.app) await provision.publishArtifact('app', result.created.app);
    });
  }

  return result;
}

module.exports = { runSdkBuild, planFor, resolvePhases, PHASES, BuildHalt, SDK_COLUMN_TYPE, viewDef, chartDef, formDef, appDef };
