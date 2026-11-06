'use strict';

const { registerHookTests } = require('./helpers/telemetry-hook-tests.js');

registerHookTests('run-user-prompt-telemetry.js', (skill) => ({
  prompt: `/${skill} private arguments https://contoso.crm.dynamics.com`,
}));
