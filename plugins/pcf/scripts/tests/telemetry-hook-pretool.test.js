'use strict';

const { registerHookTests } = require('./helpers/telemetry-hook-tests.js');

registerHookTests('run-skill-pretool-telemetry.js', (skill) => ({
  tool_name: 'Skill',
  tool_input: { skill, args: 'private arguments https://contoso.crm.dynamics.com' },
}), {
  noEmitPayloads: [
    ['a Skill call whose first skill field names another plugin', {
      tool_name: 'Skill',
      tool_input: { skill: 'other-plugin:pcf', name: 'pcf' },
    }],
  ],
});
