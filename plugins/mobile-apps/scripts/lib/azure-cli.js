'use strict';

const { CliLaunchError, runCliSync } = require('./process-runner');

function runAzureCli(args, options, dependencies) {
  return runCliSync('az', args, options, dependencies);
}

module.exports = { AzureCliLaunchError: CliLaunchError, runAzureCli };
