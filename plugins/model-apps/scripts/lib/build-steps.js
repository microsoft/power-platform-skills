// Deterministic builder steps for the model-app-maker. Each step takes injectable
// deps { runScript, dv, kernel, log } so the builder is fully unit-testable with
// no environment. Ordering is strict (each step depends on the prior).
//
// Progress: runAll augments deps with `deps.step(label)`, which emits a numbered
// `[n/total] label` line so a caller (and the user) can see live which phase is
// running — important because publishing can take a minute or two.
const { columnTypeMap, sampleRecordsFor, resolveSampleRecords } = require('./app-spec.js');
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
  n += spec.forms.length; // one per form
  n += spec.views.length; // one per view
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
      rel.lookup.schemaName,
      rel.referenced.toLowerCase(),
      rel.referencing.toLowerCase(),
      rel.lookup.schemaName,
      rel.lookup.displayName,
      '--solution',
      sol.uniqueName,
    ]);
  }
}

// --- 2. Sample data (opt-in): resolve choice labels -> ints, then bulk-create.
// Runs right after entities are created + published, so the columns resolve.
async function sampleData(spec, opts, deps, result) {
  result.created.records = {};
  for (const e of spec.entities) {
    const records = sampleRecordsFor(spec, e);
    if (!records.length) {
      continue;
    }
    deps.step(`sample data: ${records.length} record(s) for ${e.schemaName}`);
    const resolved = resolveSampleRecords(e, records);
    const entitySet = await recs.getEntitySetName(deps.dv, e.schemaName.toLowerCase());
    const r = deps.runScript('create-record.js', [opts.env, entitySet, '--body', JSON.stringify(resolved)]);
    result.created.records[e.schemaName] = (r && r.ids) || [];
  }
}

// --- 3. Forms: kernel buildForm -> PATCH the system-generated main form.
async function forms(spec, opts, deps, result) {
  result.created.forms = {};
  for (const f of spec.forms) {
    deps.step(`form for ${f.entity}`);
    const entityLogical = f.entity.toLowerCase();
    const entity = spec.entities.find((x) => x.schemaName.toLowerCase() === entityLogical);
    const typeOf = (logical) => {
      if (entity && logical === entity.primaryAttribute.schemaName.toLowerCase()) {
        return 'string';
      }
      const col = entity && (entity.columns || []).find((c) => c.schemaName.toLowerCase() === logical);
      return col ? columnTypeMap(col.type || 'Text').kernel : 'string';
    };
    const kernelSpec = {
      tabs: f.tabs.map((t) => ({
        label: t.label,
        sections: t.sections.map((s) => ({
          label: s.label,
          columns: s.columns || 1,
          fields: s.fields.map((fl) => ({ logicalName: fl.toLowerCase(), type: typeOf(fl.toLowerCase()) })),
        })),
      })),
    };
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
  await forms(spec, opts, d, result);
  await views(spec, opts, d, result);
  await appShell(spec, opts, d, result);
}

module.exports = { runAll, dataModel, sampleData, forms, views, appShell, countSteps };
