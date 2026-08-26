#!/usr/bin/env node
'use strict';
const { validateSemanticColorUsage } = require('./lib/workflow-regression');
const { runWorkflowRegressionCli } = require('./lib/run-workflow-regression-cli');
if (require.main === module) process.exitCode = runWorkflowRegressionCli(process.argv.slice(2), 'validate-semantic-color-usage', validateSemanticColorUsage);
module.exports = { validateSemanticColorUsage };