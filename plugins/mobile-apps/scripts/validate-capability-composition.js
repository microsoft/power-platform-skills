#!/usr/bin/env node
'use strict';
const { validateCapabilityComposition } = require('./lib/workflow-regression');
const { runWorkflowRegressionCli } = require('./lib/run-workflow-regression-cli');
if (require.main === module) process.exitCode = runWorkflowRegressionCli(process.argv.slice(2), 'validate-capability-composition', validateCapabilityComposition);
module.exports = { validateCapabilityComposition };