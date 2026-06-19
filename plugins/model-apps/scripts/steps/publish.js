// scripts/steps/publish.js — publish steps, extracted from the old inline runAll/appShell.
const recs = require('../lib/dataverse-records.js');

async function publishEntitiesStep(spec, opts, deps, result) {
  deps.step('publish entities');
  await recs.publishEntities(deps.dv, spec.entities.map((e) => e.schemaName.toLowerCase()));
}
async function publishStep(spec, opts, deps, result) {
  deps.step('publish customizations (this can take 1-2 min)');
  await recs.publishAll(deps.dv);
}
module.exports = { publishEntitiesStep, publishStep };
