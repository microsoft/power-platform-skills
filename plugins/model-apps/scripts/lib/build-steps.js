// scripts/lib/build-steps.js — back-compat shim. runAll moved to ./runner.js; steps in ../steps/*.
const { dataModel } = require('../steps/data-model.js');
const { sampleData } = require('../steps/sample-data.js');
const { views } = require('../steps/views.js');
const { charts } = require('../steps/charts.js');
const { forms } = require('../steps/forms.js');
const { appShell } = require('../steps/app-shell.js');
const { countSteps } = require('../steps/_progress.js');
const { runAll } = require('./runner.js');

module.exports = { runAll, dataModel, sampleData, forms, views, charts, appShell, countSteps };
