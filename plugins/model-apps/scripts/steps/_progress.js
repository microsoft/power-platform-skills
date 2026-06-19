const { columnTypeMap, sampleRecordsFor } = require('../lib/app-spec.js');

// Count the phase-level steps runAll will emit, so [n/total] has a stable total.
// MUST mirror the deps.step(...) calls in each step function (steps/*.js) and registry.js.
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

module.exports = { countSteps };
