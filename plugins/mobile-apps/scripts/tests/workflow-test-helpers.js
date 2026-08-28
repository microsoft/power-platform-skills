'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CREATE_PHASES = [
  'phase-0-setup.md',
  'phase-3-planning.md',
  'phase-4-scaffold.md',
  'phase-7-data.md',
  'phase-10-navigation.md',
  'phase-11-screens.md',
];

function composeCreateMobileAppWorkflow(pluginRoot) {
  const skillRoot = path.join(pluginRoot, 'skills', 'create-mobile-app');
  const core = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const phases = CREATE_PHASES.map((fileName) => (
    fs.readFileSync(path.join(skillRoot, 'references', fileName), 'utf8')
  ));
  return [core, ...phases].join('\n\n');
}

module.exports = {
  CREATE_PHASES,
  composeCreateMobileAppWorkflow,
};
