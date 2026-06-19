const recs = require('../lib/dataverse-records.js');

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

module.exports = { views };
