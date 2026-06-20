'use strict';
// SDK build engine: turn a validated App Spec into ordered @maker-studio/cds-maker-sdk
// calls, emitting granular progress events the orchestrator narrates. Deterministic; the
// caller injects a constructed `sdk` (createMakerSdk with solutionUniqueName = spec.solution
// .uniqueName, so every write is auto-added to that solution). Replaces the kernel + dv-*
// path. Dry-run (apply:false) emits the full plan and writes nothing.
//
// emit(event): { phase, status: 'start'|'ok'|'skip'|'error', label, n, total, detail? }
// On an SDK error, the engine throws a BuildHalt the orchestrator can gate on (AskUserQuestion).

const {
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  relationshipSchemaName,
} = require('./app-spec.js');
const { topoOrderEntities } = require('./_graph.js');

// App Spec column type -> SDK ColumnType (cds-maker-sdk types/schema.ts). Lookup is omitted:
// it is created as a side effect of a OneToMany relationship, never as a column.
const SDK_COLUMN_TYPE = {
  Text: 'string',
  Memo: 'memo',
  Choice: 'choice',
  Boolean: 'boolean',
  Money: 'money',
  DateTime: 'dateTime',
  Integer: 'integer',
  Decimal: 'decimal',
};

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

// Choice option labels -> the { value, label } pairs the SDK expects (mirrors the dv path:
// value = 100000000 + index, matching app-spec.js choiceValueMap so sample-data ints line up).
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

// --- the ordered plan (used by dry-run and to compute totals) --------------------------
function planFor(spec, opts) {
  const items = [];
  const sol = spec.solution;
  items.push({ phase: 'solution', label: `create-solution ${sol.uniqueName} (publisher ${sol.publisherPrefix})` });
  for (const e of spec.entities) {
    items.push({ phase: 'data-model', label: `create-table ${e.schemaName} ("${e.displayName}")` });
    for (const c of e.columns || []) {
      if (SDK_COLUMN_TYPE[c.type || 'Text']) {
        items.push({ phase: 'data-model', label: `add-column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})` });
      }
    }
  }
  for (const r of spec.relationships || []) {
    if (r.type === 'OneToMany') {
      items.push({ phase: 'data-model', label: `create-relationship 1:N ${r.referenced}->${r.referencing}` });
    }
  }
  if (opts.sampleData) {
    for (const e of spec.entities) {
      const n = sampleRecordsFor(spec, e).length;
      if (n) items.push({ phase: 'sample-data', label: `${n} sample record(s) -> ${e.schemaName}` });
    }
  }
  for (const v of spec.views) items.push({ phase: 'views', label: `view "${v.name}" for ${v.entity}` });
  for (const c of spec.charts || []) items.push({ phase: 'charts', label: `chart "${c.name}" (${c.chartType}) for ${c.entity}` });
  for (const f of spec.forms) {
    const subs = (f.subgrids || []).map((s) => s.childEntity).join(', ');
    items.push({ phase: 'forms', label: `main form for ${f.entity}${subs ? ` (sub-grids: ${subs})` : ''}` });
  }
  items.push({ phase: 'app-shell', label: `app module "${spec.app.name}" + sitemap` });
  if (opts.publish) items.push({ phase: 'publish', label: 'publish customizations' });
  return items;
}

// --- phase builders (pure: spec -> SDK payloads) ---------------------------------------
function viewDef(spec, v) {
  const entityLogical = v.entity.toLowerCase();
  const cols = (v.columns && v.columns.length ? v.columns : [primaryNameOf(spec, entityLogical)]).map((name, i) => ({
    name: String(name).toLowerCase(),
    width: 100,
    order: i,
  }));
  const filters =
    v.activeOnly === false
      ? { type: 'and', conditions: [], groups: [] }
      : { type: 'and', conditions: [{ attribute: 'statecode', operator: 'eq', value: '0' }], groups: [] };
  return {
    name: v.name,
    description: '',
    entityLogicalName: entityLogical,
    queryType: 0,
    isDefault: false,
    columns: cols,
    filters,
    sort: (v.sort || []).map((s) => ({ attribute: String(s.attr).toLowerCase(), descending: s.dir === 'desc' })),
  };
}

function chartDef(spec, ch) {
  const entityLogical = ch.entity.toLowerCase();
  return {
    name: ch.name,
    description: '',
    entityLogicalName: entityLogical,
    chartType: ch.chartType,
    isDefault: false,
    series: [{ attribute: `${entityLogical}id`, aggregate: ch.measure || 'count' }],
    categories: [{ attribute: String(ch.groupBy).toLowerCase() }],
    presentation: { showLegend: true, title: ch.name },
  };
}

// Standard field control classId — Dataverse renders the right widget by the bound
// attribute's type, so one classId serves every scalar field.
const STD_FIELD_CLASS_ID = '4273EDBD-AC1D-40d3-9FB2-095C621B552D';

// Build a Main-form definition: the primary name column plus every scalar column laid
// out one-per-row in a single-column section. Lookups are omitted (they come from the
// relationship, not a column); sub-grids are attached later via addSubGrid.
function formDef(spec, f) {
  const entityLogical = f.entity.toLowerCase();
  const entity = entityByLogical(spec, entityLogical);
  const cell = (logical, label, required) => ({
    visible: true,
    colspan: 1,
    rowspan: 1,
    control: {
      id: logical,
      classId: STD_FIELD_CLASS_ID,
      fieldName: logical,
      type: 'standard',
      isRequired: !!required,
      isReadOnly: false,
      label,
      showLabel: true,
      parameters: {},
    },
  });
  const rows = [];
  if (entity) {
    rows.push({ cells: [cell(entity.primaryAttribute.schemaName.toLowerCase(), entity.primaryAttribute.displayName || 'Name', true)] });
    for (const c of entity.columns || []) {
      if (!SDK_COLUMN_TYPE[c.type || 'Text']) continue; // skip Lookup (no scalar column)
      rows.push({ cells: [cell(c.schemaName.toLowerCase(), c.displayName || c.schemaName, c.required === true)] });
    }
  }
  return {
    entityLogicalName: entityLogical,
    name: f.name || `${f.entity} form`,
    formType: 'Main',
    status: 'Active',
    tabs: [
      {
        name: 'tab_general',
        label: 'General',
        expanded: true,
        visible: true,
        sections: [{ name: 'section_general', label: 'General', visible: true, showLabel: false, columns: 1, rows }],
      },
    ],
  };
}

function appDef(spec, result) {
  const sol = spec.solution;
  const uniqueName = `${sol.publisherPrefix}_${spec.app.name}`.replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const areas = (spec.appShell.areas || []).map((a, ai) => ({
    id: `area_${ai}`,
    title: a.label,
    groups: (a.groups || []).map((g, gi) => ({
      id: `group_${ai}_${gi}`,
      title: g.label,
      subAreas: (g.subAreas || []).map((s, si) => ({
        id: `sub_${ai}_${gi}_${si}`,
        type: 'Entity',
        entity: s.entity && s.entity.toLowerCase(),
        title: s.title,
      })),
    })),
  }));
  return {
    name: spec.app.name,
    uniqueName,
    description: spec.app.description || '',
    siteMap: { areas },
    components: {
      forms: Object.values(result.forms || {}).filter(Boolean),
      views: Object.values(result.views || {}).filter(Boolean),
      charts: Object.values(result.charts || {}).filter(Boolean),
    },
  };
}

// --- orchestrator ----------------------------------------------------------------------
async function runSdkBuild(spec, opts = {}) {
  const { sdk, apply = false, sampleData = false, publish = false } = opts;
  const emit = opts.emit || (() => undefined);
  // Header-less client. A writer constructed with solutionUniqueName stamps
  // MSCRM.SolutionUniqueName on every call. That breaks two cases: (1) createSolution/
  // createPublisher — the solution doesn't exist yet; (2) artifact pushes (savedqueries/
  // systemforms/appmodules) — Dataverse rejects that header on those endpoints. So the
  // solution lifecycle AND the view/chart/form/app pushes go through this header-less client,
  // and each pushed artifact is added to the solution explicitly via addSolutionComponent.
  // Metadata writes (tables/columns/relationships/records) keep the header-ful `sdk` (the
  // header is honored there). Falls back to `sdk` for mock-injected tests.
  const provision = opts.provisionSdk || sdk;
  // Dataverse solution-component type codes for the artifacts this engine adds.
  const COMPONENT_TYPE = { view: 26, chart: 59, form: 60, app: 80 };
  const buildOpts = { sampleData, publish };
  const plan = planFor(spec, buildOpts);

  if (!apply) {
    plan.forEach((p, i) => emit({ phase: p.phase, status: 'skip', label: p.label, n: i + 1, total: plan.length }));
    return { ok: true, dryRun: true, plan: plan.map((p) => p.label) };
  }

  const result = { ok: true, created: { entities: {}, relationships: {}, records: {}, views: {}, charts: {}, forms: {}, app: null } };
  const total = plan.length;
  let n = 0;
  const run = async (phase, label, fn, { recoverable = false } = {}) => {
    n += 1;
    emit({ phase, status: 'start', label, n, total });
    try {
      const out = await fn();
      emit({ phase, status: 'ok', label, n, total });
      return out;
    } catch (err) {
      emit({ phase, status: 'error', label, n, total, detail: String((err && err.message) || err) });
      throw new BuildHalt(`${phase} failed: ${(err && err.message) || err}`, {
        phase,
        code: (err && err.code) || 'sdk-error',
        recoverable,
        cause: err,
      });
    }
  };

  // 1. Solution. Resolve the publisher by prefix (the env's default publisher has prefix
  //    `new`), then create the solution — both via the header-less `provision` client.
  //    Idempotent: reuse an existing solution of the same unique name instead of colliding.
  const sol = spec.solution;
  await run('solution', `create-solution ${sol.uniqueName}`, async () => {
    const existing = await provision.queryRecords('solution', {
      select: ['solutionid', 'uniquename'],
      filter: `uniquename eq '${sol.uniqueName}'`,
      top: 1,
    });
    if (existing && existing[0]) return; // reuse the existing solution
    let publisherId;
    const pubs = await provision.queryRecords('publisher', {
      select: ['publisherid', 'uniquename'],
      filter: `customizationprefix eq '${sol.publisherPrefix}'`,
      top: 1,
    });
    if (pubs && pubs[0] && pubs[0].publisherid) {
      publisherId = pubs[0].publisherid;
    } else {
      const created = await provision.createPublisher({
        uniqueName: `${sol.publisherPrefix}publisher`,
        friendlyName: `${sol.publisherPrefix} publisher`,
        prefix: sol.publisherPrefix,
      });
      publisherId = created.id;
    }
    await provision.createSolution({ uniqueName: sol.uniqueName, friendlyName: sol.displayName || sol.uniqueName, publisherId });
  }, { recoverable: true });

  // 2. Data model: tables -> columns -> relationships.
  for (const e of spec.entities) {
    await run('data-model', `create-table ${e.schemaName}`, async () => {
      const t = await sdk.createTable({
        schemaName: e.schemaName,
        displayName: e.displayName,
        pluralName: e.pluralName || `${e.displayName}s`,
        primaryColumnSchemaName: e.primaryAttribute.schemaName,
        primaryColumnDisplayName: e.primaryAttribute.displayName || 'Name',
      });
      result.created.entities[e.schemaName] = { logicalName: (t.logicalName || e.schemaName).toLowerCase(), entitySetName: t.entitySetName };
    }, { recoverable: true });
    for (const c of e.columns || []) {
      const sdkType = SDK_COLUMN_TYPE[c.type || 'Text'];
      if (!sdkType) continue; // Lookup -> via relationship
      await run('data-model', `add-column ${e.schemaName}.${c.schemaName}`, async () => {
        const col = { schemaName: c.schemaName, displayName: c.displayName || c.schemaName, type: sdkType };
        if (c.type === 'Choice') col.options = choiceOptions(c);
        await sdk.createColumn(e.schemaName.toLowerCase(), col);
      });
    }
  }
  for (const rel of spec.relationships || []) {
    if (rel.type !== 'OneToMany') continue;
    await run('data-model', `create-relationship ${rel.referenced}->${rel.referencing}`, async () => {
      await sdk.createRelationship({
        type: 'OneToMany',
        schemaName: relationshipSchemaName(rel),
        referencedEntity: rel.referenced.toLowerCase(),
        referencingEntity: rel.referencing.toLowerCase(),
        lookupSchemaName: rel.lookup.schemaName,
        lookupDisplayName: rel.lookup.displayName,
      });
    });
  }

  // 3. Sample data (opt-in): topological, with $parent -> @odata.bind on the lookup nav prop.
  if (sampleData) {
    const createdByEntity = {};
    for (const e of topoOrderEntities(spec)) {
      const records = sampleRecordsFor(spec, e);
      if (!records.length) continue;
      await run('sample-data', `${records.length} record(s) -> ${e.schemaName}`, async () => {
        const entityLogical = e.schemaName.toLowerCase();
        const entitySet =
          (result.created.entities[e.schemaName] && result.created.entities[e.schemaName].entitySetName) ||
          (await sdk.resolveEntitySetName(entityLogical));
        const resolved = resolveSampleRecords(e, records);
        const bodies = resolved.map((rec, i) => {
          const raw = records[i];
          const body = Object.assign({}, rec);
          delete body.$parent;
          const parent = raw && raw.$parent;
          if (parent && parent.entity && parent.match) {
            const parentLogical = parent.entity.toLowerCase();
            const hit = (createdByEntity[parentLogical] || []).find((h) =>
              Object.entries(parent.match).every(([k, v]) => {
                const rk = Object.keys(h.raw).find((x) => x.toLowerCase() === k.toLowerCase());
                return rk !== undefined && h.raw[rk] === v;
              })
            );
            const rel = relationshipFor(spec, parent.entity, e.schemaName);
            const parentSet = result.created.entities[entityByLogical(spec, parentLogical).schemaName] || {};
            if (hit && hit.id && rel) {
              body[`${rel.lookup.schemaName}@odata.bind`] = `/${parentSet.entitySetName || `${parentLogical}s`}(${hit.id})`;
            }
          }
          return body;
        });
        const ids = await sdk.createRecordsBulk(entityLogical, bodies);
        result.created.records[e.schemaName] = ids;
        createdByEntity[entityLogical] = records.map((raw, i) => ({ raw, id: ids[i] })).filter((p) => p.id != null);
      });
    }
  }

  // 4. Views. Header-less push, then add to the solution explicitly.
  for (const v of spec.views) {
    await run('views', `view "${v.name}"`, async () => {
      const art = provision.createArtifact('view', viewDef(spec, v));
      const pushed = await provision.pushArtifact('view', art.id);
      await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.view, solutionUniqueName: sol.uniqueName });
      result.created.views[v.name] = pushed.id;
    });
  }

  // 5. Charts (before forms, so a form could reference one).
  for (const ch of spec.charts || []) {
    await run('charts', `chart "${ch.name}"`, async () => {
      const art = provision.createArtifact('chart', chartDef(spec, ch));
      const pushed = await provision.pushArtifact('chart', art.id);
      await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.chart, solutionUniqueName: sol.uniqueName });
      result.created.charts[ch.name] = pushed.id;
    });
  }

  // 6. Forms. Create a Main form per entity (primary + scalar columns laid out via the typed
  //    FormArtifact tree, serialized by the SDK's designer-grade SerializationService), then
  //    attach declared sub-grids referencing the child view id built above.
  for (const f of spec.forms) {
    await run('forms', `main form for ${f.entity}`, async () => {
      const entityLogical = f.entity.toLowerCase();
      const art = provision.createArtifact('form', formDef(spec, f));
      for (const sg of f.subgrids || []) {
        const rel = relationshipFor(spec, f.entity, sg.childEntity);
        if (!rel) continue;
        const childLogical = sg.childEntity.toLowerCase();
        let viewId = sg.view && result.created.views[sg.view];
        if (!viewId) {
          const childView = (spec.views || []).find((v) => v.entity.toLowerCase() === childLogical);
          viewId = childView && result.created.views[childView.name];
        }
        provision.addSubGrid(art.id, {
          entity: childLogical,
          relationshipName: relationshipSchemaName(rel),
          viewId,
          label: sg.label || sg.childEntity,
        });
      }
      const pushed = await provision.pushArtifact('form', art.id);
      await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.form, solutionUniqueName: sol.uniqueName });
      result.created.forms[entityLogical] = pushed.id;
    });
  }

  // 7. App module + sitemap.
  await run('app-shell', `app module "${spec.app.name}"`, async () => {
    const art = provision.createArtifact('app', appDef(spec, result.created));
    const pushed = await provision.pushArtifact('app', art.id);
    await provision.addSolutionComponent({ componentId: pushed.id, componentType: COMPONENT_TYPE.app, solutionUniqueName: sol.uniqueName });
    result.created.app = pushed.id;
  });

  // 8. Publish (opt-in): publish each created entity-artifact + the app so customizations go live.
  if (publish) {
    await run('publish', 'publish customizations', async () => {
      for (const [, id] of Object.entries(result.created.forms)) await provision.publishArtifact('form', id);
      for (const [, id] of Object.entries(result.created.views)) if (id) await provision.publishArtifact('view', id);
      for (const [, id] of Object.entries(result.created.charts)) if (id) await provision.publishArtifact('chart', id);
      if (result.created.app) await provision.publishArtifact('app', result.created.app);
    });
  }

  return result;
}

module.exports = { runSdkBuild, planFor, BuildHalt, SDK_COLUMN_TYPE, viewDef, chartDef, formDef, appDef };
