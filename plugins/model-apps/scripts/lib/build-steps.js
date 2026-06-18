// Deterministic builder steps for the model-app-maker. Each step takes injectable
// deps { runScript, dv, kernel, log } so the builder is fully unit-testable with
// no environment. Ordering is strict (each step depends on the prior).
//
// Progress: runAll augments deps with `deps.step(label)`, which emits a numbered
// `[n/total] label` line so a caller (and the user) can see live which phase is
// running — important because publishing can take a minute or two.
const {
  columnTypeMap,
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  relationshipSchemaName,
} = require('./app-spec.js');
const recs = require('./dataverse-records.js');

// Count the phase-level steps runAll will emit, so [n/total] has a stable total.
// MUST mirror the deps.step(...) calls below.
function countSteps(spec, opts) {
  let n = 1; // solution
  for (const e of spec.entities) {
    n += 1; // table
    for (const c of e.columns || []) {
      if (columnTypeMap(c.type || 'Text').dv) {
        n += 1; // add-column (lookups have no add-column step)
      }
    }
  }
  for (const rel of spec.relationships || []) {
    if (rel.type === 'OneToMany') {
      n += 1;
    }
  }
  n += 1; // publish entities
  if (opts.sampleData) {
    for (const e of spec.entities) {
      if (sampleRecordsFor(spec, e).length) {
        n += 1; // insert sample data for this entity
      }
    }
  }
  n += spec.views.length; // one per view (views build before forms)
  n += (spec.charts || []).length; // one per chart (charts build before forms)
  n += spec.forms.length; // one per form
  n += 1; // app shell
  if (opts.publish) {
    n += 1; // publish customizations
  }
  return n;
}

// --- 1. Data model: solution + tables + columns + relationships (via dv-* scripts).
async function dataModel(spec, opts, deps, result) {
  const env = opts.env;
  const sol = spec.solution;
  deps.step(`solution ${sol.uniqueName}`);
  // Resolve the publisher whose customization prefix matches the spec, so the
  // entity/column schema names (e.g. new_project) are accepted. Falls back to the
  // env's default publisher if none is found.
  let publisherUnique = null;
  try {
    const pubRes = await deps.dv(
      'GET',
      `publishers?$select=uniquename&$filter=customizationprefix eq '${sol.publisherPrefix}'`
    );
    const pubs = (pubRes && pubRes.data && pubRes.data.value) || [];
    publisherUnique = pubs[0] && pubs[0].uniquename;
  } catch (e) {
    /* fall back to the env's default publisher */
  }
  const solArgs = [env, sol.uniqueName, sol.displayName || sol.uniqueName];
  if (publisherUnique) {
    solArgs.push('--publisher', publisherUnique);
  }
  deps.runScript('create-solution.js', solArgs);

  result.created.entities = {};
  for (const e of spec.entities) {
    deps.step(`table ${e.schemaName} ("${e.displayName}")`);
    const t = deps.runScript('create-table.js', [
      env,
      e.schemaName,
      e.displayName,
      e.pluralName || e.displayName + 's',
      '--primary-name',
      e.primaryAttribute.displayName,
      '--primary-name-logical',
      e.primaryAttribute.schemaName,
      '--solution',
      sol.uniqueName,
    ]);
    result.created.entities[e.schemaName] = {
      logicalName: (t.logicalName || e.schemaName).toLowerCase(),
      metadataId: t.metadataId,
    };
    for (const c of e.columns || []) {
      const map = columnTypeMap(c.type || 'Text');
      if (!map.dv) {
        deps.log(`skip column ${c.schemaName} (type ${c.type} not via add-column)`);
        continue;
      }
      deps.step(`column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`);
      const args = [env, e.schemaName.toLowerCase(), c.schemaName, c.displayName || c.schemaName, map.dv, '--solution', sol.uniqueName];
      if (c.type === 'Choice') {
        args.push('--options', JSON.stringify((c.options || []).map((label, i) => ({ value: 100000000 + i, label }))));
      }
      deps.runScript('add-column.js', args);
    }
  }

  for (const rel of spec.relationships || []) {
    if (rel.type !== 'OneToMany') {
      deps.log(`skip relationship type ${rel.type}`);
      continue;
    }
    deps.step(`relationship ${rel.referenced}->${rel.referencing}`);
    deps.runScript('create-relationship.js', [
      '1n',
      env,
      relationshipSchemaName(rel), // relationship schema name — MUST differ from the lookup name
      rel.referenced.toLowerCase(),
      rel.referencing.toLowerCase(),
      rel.lookup.schemaName, // the lookup attribute created on the referencing table
      rel.lookup.displayName,
      '--solution',
      sol.uniqueName,
    ]);
  }
}

// Order the entities so that any entity referenced by a OneToMany relationship is
// inserted before the entity that references it (parents before children). A simple
// Kahn topological sort over the relationship edges; entities not in any relationship
// keep their declared order. Cycles (shouldn't happen for 1:N hierarchies) fall back
// to declared order for the unresolved tail.
function topoOrderEntities(spec) {
  const entities = spec.entities || [];
  const byLower = new Map(entities.map((e) => [e.schemaName.toLowerCase(), e]));
  // edge: referenced (parent) -> referencing (child). child depends on parent.
  const deps = new Map(entities.map((e) => [e.schemaName.toLowerCase(), new Set()]));
  for (const rel of spec.relationships || []) {
    if (rel.type !== 'OneToMany') {
      continue;
    }
    const parent = String(rel.referenced || '').toLowerCase();
    const child = String(rel.referencing || '').toLowerCase();
    if (byLower.has(parent) && byLower.has(child) && parent !== child) {
      deps.get(child).add(parent);
    }
  }
  const ordered = [];
  const done = new Set();
  // Preserve declared order among ready nodes for determinism.
  let progressed = true;
  while (ordered.length < entities.length && progressed) {
    progressed = false;
    for (const e of entities) {
      const key = e.schemaName.toLowerCase();
      if (done.has(key)) {
        continue;
      }
      const unmet = [...deps.get(key)].some((d) => !done.has(d));
      if (!unmet) {
        ordered.push(e);
        done.add(key);
        progressed = true;
      }
    }
  }
  // Append any remaining (cyclic) entities in declared order.
  for (const e of entities) {
    if (!done.has(e.schemaName.toLowerCase())) {
      ordered.push(e);
    }
  }
  return ordered;
}

// Does a resolved sample record satisfy the $parent.match? Compares against the
// ORIGINAL author-written record (match values are author labels/values, not the
// choice-resolved ints), so we match on the raw record map.
function recordMatches(rawRecord, match) {
  return Object.entries(match).every(([k, v]) => {
    const rk = Object.keys(rawRecord).find((x) => x.toLowerCase() === k.toLowerCase());
    return rk !== undefined && rawRecord[rk] === v;
  });
}

// --- 2. Sample data (opt-in): resolve choice labels -> ints, then bulk-create.
// Runs right after entities are created + published, so the columns resolve.
// Supports RELATIONAL data: entities are inserted parent-before-child (topological),
// created ids are captured per entity keyed by the record's match fields, and any
// record carrying $parent:{entity,match} gets a "<navprop>@odata.bind" lookup bound
// to the parent record's id (navprop = the OneToMany lookup schema name).
async function sampleData(spec, opts, deps, result) {
  result.created.records = {};
  // entitySetName cache so a $parent reference can resolve a parent's collection.
  const entitySets = {};
  const setNameFor = async (logical) => {
    if (!entitySets[logical]) {
      entitySets[logical] = await recs.getEntitySetName(deps.dv, logical);
    }
    return entitySets[logical];
  };
  // Per-entity list of { raw, id } so a child can match a parent record -> its id.
  const createdByEntity = {};

  for (const e of topoOrderEntities(spec)) {
    const records = sampleRecordsFor(spec, e);
    if (!records.length) {
      continue;
    }
    deps.step(`sample data: ${records.length} record(s) for ${e.schemaName}`);
    const entityLogical = e.schemaName.toLowerCase();
    const resolved = resolveSampleRecords(e, records); // choice labels -> ints, drops $parent
    // Bind each record's $parent (if any) as an @odata.bind lookup.
    const bodies = resolved.map((rec, i) => {
      const raw = records[i];
      const body = Object.assign({}, rec);
      delete body.$parent; // never send the directive to the Web API
      const parent = raw && raw.$parent;
      if (parent && parent.entity && parent.match) {
        const parentLogical = parent.entity.toLowerCase();
        const hits = createdByEntity[parentLogical] || [];
        const hit = hits.find((h) => recordMatches(h.raw, parent.match));
        const rel = relationshipFor(spec, parent.entity, e.schemaName);
        if (hit && hit.id && rel) {
          const navprop = rel.lookup.schemaName;
          body[`${navprop}@odata.bind`] = `/${entitySets[parentLogical]}(${hit.id})`;
        } else {
          deps.log(
            `sample data: could not bind $parent for a ${e.schemaName} record ` +
              `(parent ${parent.entity} match=${JSON.stringify(parent.match)})`
          );
        }
      }
      return body;
    });
    const entitySet = await setNameFor(entityLogical);
    const r = deps.runScript('create-record.js', [opts.env, entitySet, '--body', JSON.stringify(bodies)]);
    // create-record.js returns `ids` positionally aligned 1:1 with the records we
    // sent: ids[i] is the created id for records[i], or null if that record failed.
    // (See create-record.js createBatch — failed slots are null, never collapsed out,
    // so the index never shifts.) That alignment is load-bearing here: children
    // resolve their parent by matching raw fields, then read that parent's id.
    const ids = (r && r.ids) || [];
    result.created.records[e.schemaName] = ids;
    // Record raw->id pairs so children can resolve this as a parent. Only keep
    // successfully-created records (id != null): a child must never bind to a parent
    // that failed to insert, which would otherwise corrupt the relational graph.
    createdByEntity[entityLogical] = records
      .map((raw, i) => ({ raw, id: ids[i] }))
      .filter((pair) => pair.id != null);
  }
}

// --- 3. Forms: kernel buildForm -> PATCH the system-generated main form.
// If the form declares explicit `tabs` (or layout==="explicit") we send the maker's
// structure verbatim (now with a per-field display label). Otherwise we send
// `autoFields` (the entity's primary + columns as {logicalName,label,type,required})
// plus `purpose` and let the kernel's planFormLayout derive the layout. Sub-grids in
// `form.subgrids` are resolved here to a relationshipName + child view id.
async function forms(spec, opts, deps, result) {
  result.created.forms = {};
  for (const f of spec.forms) {
    deps.step(`form for ${f.entity}`);
    const entityLogical = f.entity.toLowerCase();
    const entity = spec.entities.find((x) => x.schemaName.toLowerCase() === entityLogical);
    const primaryLogical = entity && entity.primaryAttribute.schemaName.toLowerCase();
    const colOf = (logical) =>
      entity && (entity.columns || []).find((c) => c.schemaName.toLowerCase() === logical);
    // Kernel field type for a logical name (primary is always string).
    const typeOf = (logical) => {
      if (logical === primaryLogical) {
        return 'string';
      }
      const col = colOf(logical);
      return col ? columnTypeMap(col.type || 'Text').kernel : 'string';
    };
    // Display label for a logical name (fixes F1: forms showed logical names).
    const labelOf = (logical) => {
      if (logical === primaryLogical) {
        return entity.primaryAttribute.displayName || logical;
      }
      const col = colOf(logical);
      return (col && (col.displayName || col.schemaName)) || logical;
    };

    const kernelSpec = {};
    const explicit = Array.isArray(f.tabs) || f.layout === 'explicit';
    if (explicit) {
      kernelSpec.tabs = (f.tabs || []).map((t) => ({
        label: t.label,
        sections: t.sections.map((s) => ({
          label: s.label,
          columns: s.columns || 1,
          fields: s.fields.map((fl) => {
            const logical = fl.toLowerCase();
            return { logicalName: logical, label: labelOf(logical), type: typeOf(logical) };
          }),
        })),
      }));
    } else {
      // autoFields: the primary, then every scalar column, with display labels.
      const autoFields = [];
      if (entity) {
        const primaryDisplay = entity.primaryAttribute.displayName || primaryLogical;
        autoFields.push({
          logicalName: primaryLogical,
          // `label` keeps the explicit-tabs/cellXml path working; `displayName` is what
          // the kernel's planFormLayout/displayLabel reads for the auto-layout path (fixes F1).
          label: primaryDisplay,
          displayName: primaryDisplay,
          type: 'string',
          required: true,
        });
        for (const c of entity.columns || []) {
          const colDisplay = c.displayName || c.schemaName;
          autoFields.push({
            logicalName: c.schemaName.toLowerCase(),
            label: colDisplay,
            displayName: colDisplay,
            type: columnTypeMap(c.type || 'Text').kernel,
            required: c.required === true,
          });
        }
      }
      kernelSpec.autoFields = autoFields;
      if (f.purpose) {
        kernelSpec.purpose = f.purpose;
      }
    }

    // Resolve declared sub-grids: relationshipName from the App Spec relationship,
    // child view id from the views we already built (by name, else the child's first).
    const subgrids = [];
    for (const sg of f.subgrids || []) {
      const rel = relationshipFor(spec, f.entity, sg.childEntity);
      if (!rel) {
        deps.log(`form ${f.entity}: skipping subgrid for ${sg.childEntity} (no OneToMany relationship)`);
        continue;
      }
      const childLogical = sg.childEntity.toLowerCase();
      let viewId = sg.view && result.created.views[sg.view];
      if (!viewId) {
        // fall back to the first built view of the child entity
        const childView = (spec.views || []).find((v) => v.entity.toLowerCase() === childLogical);
        viewId = childView && result.created.views[childView.name];
      }
      subgrids.push({
        targetEntity: childLogical,
        relationshipName: relationshipSchemaName(rel), // the relationship schema name, not the lookup
        viewId,
        label: sg.label || sg.childEntity,
      });
    }
    if (subgrids.length) {
      kernelSpec.subgrids = subgrids;
    }

    const built = deps.kernel({
      kind: 'buildForm',
      spec: kernelSpec,
      ctx: { entityName: entityLogical, formId: '{00000000-0000-0000-0000-000000000000}', formName: f.name },
    });
    if (!built.ok) {
      throw new Error(`kernel buildForm failed: ${built.error && built.error.message}`);
    }
    const form = await recs.findMainForm(deps.dv, entityLogical);
    if (!form) {
      throw new Error(`no main form found for ${entityLogical}`);
    }
    await recs.patchFormXml(deps.dv, form.formid, built.formxml);
    deps.runScript('add-to-solution.js', [opts.env, spec.solution.uniqueName, form.formid, '60']); // 60 = Form
    result.created.forms[entityLogical] = form.formid;
  }
}

// --- 4. Views: kernel buildView -> create savedquery.
async function views(spec, opts, deps, result) {
  result.created.views = {};
  for (const v of spec.views) {
    deps.step(`view "${v.name}" for ${v.entity}`);
    const entityLogical = v.entity.toLowerCase();
    const built = deps.kernel({
      kind: 'buildView',
      spec: {
        entity: entityLogical,
        primaryId: entityLogical + 'id',
        columns: (v.columns || []).map((name) => ({ name: name.toLowerCase() })),
        sort: (v.sort || []).map((s) => ({ attr: s.attr.toLowerCase(), descending: s.dir === 'desc' })),
        activeOnly: v.activeOnly !== false,
      },
    });
    if (!built.ok) {
      throw new Error(`kernel buildView failed: ${built.error && built.error.message}`);
    }
    const res = await recs.createSavedQuery(deps.dv, {
      name: v.name,
      entityLogical,
      fetchxml: built.fetchxml,
      layoutxml: built.layoutxml,
    });
    const id = recs.extractId(res);
    if (id) {
      deps.runScript('add-to-solution.js', [opts.env, spec.solution.uniqueName, id, '26']); // 26 = SavedQuery
    }
    result.created.views[v.name] = id;
  }
}

// --- 4b. Charts: kernel buildChart -> create savedqueryvisualization. Runs after
// views, before forms, so a form quick-chart could reference one. component type 59.
async function charts(spec, opts, deps, result) {
  result.created.charts = {};
  for (const ch of spec.charts || []) {
    deps.step(`chart "${ch.name}" for ${ch.entity}`);
    const entityLogical = ch.entity.toLowerCase();
    const built = deps.kernel({
      kind: 'buildChart',
      spec: {
        entity: entityLogical,
        primaryId: entityLogical + 'id',
        name: ch.name,
        groupBy: ch.groupBy.toLowerCase(),
        measure: ch.measure || 'count',
        chartType: ch.chartType,
      },
    });
    if (!built.ok) {
      throw new Error(`kernel buildChart failed: ${built.error && built.error.message}`);
    }
    const res = await recs.createSavedQueryVisualization(deps.dv, {
      name: ch.name,
      primaryEntityLogical: entityLogical,
      datadescription: built.datadescription,
      presentationdescription: built.presentationdescription,
    });
    const id = recs.extractId(res);
    if (id) {
      deps.runScript('add-to-solution.js', [opts.env, spec.solution.uniqueName, id, '59']); // 59 = savedqueryvisualization
    }
    result.created.charts[ch.name] = id;
  }
}

// --- 5. App shell: kernel buildSitemap -> appmodule + sitemap + AddAppComponents -> publish (opt-in).
async function appShell(spec, opts, deps, result) {
  deps.step(`app shell (sitemap + app module "${spec.app.name}")`);
  const sm = deps.kernel({
    kind: 'buildSitemap',
    spec: {
      areas: (spec.appShell.areas || []).map((a) => ({
        title: a.label,
        groups: (a.groups || []).map((g) => ({
          title: g.label,
          subAreas: (g.subAreas || []).map((s) => ({ entity: s.entity && s.entity.toLowerCase(), title: s.title })),
        })),
      })),
    },
  });
  if (!sm.ok) {
    throw new Error(`kernel buildSitemap failed: ${sm.error && sm.error.message}`);
  }

  const uniqueName = (spec.solution.publisherPrefix + '_' + spec.app.name).replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const webresourceid = await recs.resolveAppIcon(deps.dv); // appmodule.webresourceid is required
  const appRes = await recs.createAppModule(deps.dv, {
    name: spec.app.name,
    uniqueName,
    description: spec.app.description,
    webresourceid,
  });
  const appId = recs.extractId(appRes);
  const smRes = await recs.createSitemap(deps.dv, {
    sitemapname: spec.app.name,
    sitemapnameunique: uniqueName,
    sitemapxml: sm.sitemapxml,
  });
  const smId = recs.extractId(smRes);
  result.created.app = { appModuleId: appId, sitemapId: smId };

  // Components = sitemap + forms + views (the entity is implied by its form/view).
  const components = [];
  if (smId) {
    components.push({ '@odata.type': 'Microsoft.Dynamics.CRM.sitemap', sitemapid: smId });
  }
  for (const formId of Object.values(result.created.forms || {})) {
    components.push({ '@odata.type': 'Microsoft.Dynamics.CRM.systemform', formid: formId });
  }
  for (const viewId of Object.values(result.created.views || {})) {
    if (viewId) {
      components.push({ '@odata.type': 'Microsoft.Dynamics.CRM.savedquery', savedqueryid: viewId });
    }
  }
  for (const chartId of Object.values(result.created.charts || {})) {
    if (chartId) {
      components.push({ '@odata.type': 'Microsoft.Dynamics.CRM.savedqueryvisualization', savedqueryvisualizationid: chartId });
    }
  }
  if (appId) {
    await recs.addAppComponents(deps.dv, appId, components);
    deps.runScript('add-to-solution.js', [opts.env, spec.solution.uniqueName, appId, '80']); // 80 = appmodule
  }

  if (opts.publish) {
    deps.step('publish customizations (this can take 1-2 min)');
    await recs.publishAll(deps.dv);
  } else {
    deps.log('skipped publish (pass --publish to publish)');
  }
}

async function runAll(spec, opts, deps, result) {
  // Augment deps with a numbered progress emitter shared by every phase.
  const total = countSteps(spec, opts);
  let i = 0;
  const d = Object.assign({}, deps, {
    step: (label) => deps.log(`[${++i}/${total}] ${label}`),
  });

  await dataModel(spec, opts, d, result);
  // Publish the new entities BEFORE building forms/views — Dataverse silently
  // strips form cells that reference unpublished attributes on save.
  d.step('publish entities');
  await recs.publishEntities(
    d.dv,
    spec.entities.map((e) => e.schemaName.toLowerCase())
  );
  if (opts.sampleData) {
    await sampleData(spec, opts, d, result);
  }
  // Views and charts BEFORE forms: a parent form's sub-grid references a child view
  // id, and a form quick-chart references a chart id — both must exist first (DA6).
  await views(spec, opts, d, result);
  await charts(spec, opts, d, result);
  await forms(spec, opts, d, result);
  await appShell(spec, opts, d, result);
}

module.exports = { runAll, dataModel, sampleData, forms, views, charts, appShell, countSteps };
