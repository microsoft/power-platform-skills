const recs = require('../lib/dataverse-records.js');

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

module.exports = { charts };
