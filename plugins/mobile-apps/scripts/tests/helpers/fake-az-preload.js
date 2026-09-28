'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');

const originalExecFileSync = childProcess.execFileSync;

childProcess.execFileSync = function fakeAzExecFileSync(command, args, options) {
  if (command !== 'az') {
    return originalExecFileSync.call(this, command, args, options);
  }

  const cliArgs = Array.isArray(args) ? args : [];
  if (process.env.FAKE_AZ_LOG) {
    fs.appendFileSync(process.env.FAKE_AZ_LOG, `${cliArgs.join(' ')}\n`);
  }

  if (cliArgs[0] === 'account' && cliArgs[1] === 'show') {
    return `${process.env.FAKE_AZ_ACCOUNT_TENANT || ''}\n`;
  }

  if (cliArgs[0] === 'account' && cliArgs[1] === 'get-access-token') {
    const tenantIndex = cliArgs.indexOf('--tenant');
    const tenant = tenantIndex === -1 ? '' : cliArgs[tenantIndex + 1];
    const failing = (process.env.FAKE_AZ_FAIL_TENANTS || '').split(',').filter(Boolean);
    if (tenant && failing.includes(tenant)) {
      const error = new Error(`Fake Azure CLI rejected tenant ${tenant}`);
      error.status = 1;
      throw error;
    }
    if (process.env.FAKE_AZ_STATIC_TOKEN) {
      return `${process.env.FAKE_AZ_STATIC_TOKEN}\n`;
    }
    return `token-for:${tenant || 'active-account'}\n`;
  }

  const error = new Error(`Unexpected fake Azure CLI arguments: ${cliArgs.join(' ')}`);
  error.status = 1;
  throw error;
};
