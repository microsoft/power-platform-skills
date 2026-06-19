// scripts/steps/registry.js — the "workflow file": ordered build steps as data.
const { dataModel } = require('./data-model.js');
const { publishEntitiesStep, publishStep } = require('./publish.js');
const { sampleData } = require('./sample-data.js');
const { views } = require('./views.js');
const { charts } = require('./charts.js');
const { forms } = require('./forms.js');
const { appShell } = require('./app-shell.js');
const noop = () => undefined;

module.exports = [
  { id: 'data-model',       title: 'Tables, columns & relationships', when: () => true,          run: dataModel,           verify: noop, rollback: noop },
  { id: 'publish-entities', title: 'Publish new tables',              when: () => true,          run: publishEntitiesStep, verify: noop, rollback: noop },
  { id: 'sample-data',      title: 'Sample records',                  when: (o) => o.sampleData,  run: sampleData,         verify: noop, rollback: noop },
  { id: 'views',            title: 'Views',                           when: () => true,          run: views,               verify: noop, rollback: noop },
  { id: 'charts',           title: 'Charts',                          when: () => true,          run: charts,              verify: noop, rollback: noop },
  { id: 'forms',            title: 'Forms',                           when: () => true,          run: forms,               verify: noop, rollback: noop },
  { id: 'app-shell',        title: 'Sitemap & app module',            when: () => true,          run: appShell,            verify: noop, rollback: noop },
  { id: 'publish',          title: 'Publish customizations',          when: (o) => o.publish,    run: publishStep,         verify: noop, rollback: noop },
];
