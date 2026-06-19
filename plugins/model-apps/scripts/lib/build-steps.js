// Deterministic builder steps for the model-app-maker. Each step takes injectable
// deps { runScript, dv, kernel, log } so the builder is fully unit-testable with
// no environment. Ordering is strict (each step depends on the prior).
//
// Progress: runAll augments deps with `deps.step(label)`, which emits a numbered
// `[n/total] label` line so a caller (and the user) can see live which phase is
// running — important because publishing can take a minute or two.
const recs = require('./dataverse-records.js');
const { countSteps } = require('../steps/_progress.js');
const { dataModel } = require('../steps/data-model.js');
const { sampleData } = require('../steps/sample-data.js');
const { views } = require('../steps/views.js');
const { charts } = require('../steps/charts.js');
const { forms } = require('../steps/forms.js');
const { appShell } = require('../steps/app-shell.js');

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
