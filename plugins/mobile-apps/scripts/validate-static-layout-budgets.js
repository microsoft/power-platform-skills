#!/usr/bin/env node
'use strict';
const { validateStaticLayoutBudgets } = require('./lib/workflow-regression');
const { runWorkflowRegressionCli } = require('./lib/run-workflow-regression-cli');
if (require.main === module) process.exitCode = runWorkflowRegressionCli(process.argv.slice(2), 'validate-static-layout-budgets', validateStaticLayoutBudgets);
module.exports = { validateStaticLayoutBudgets };