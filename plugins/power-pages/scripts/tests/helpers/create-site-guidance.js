'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../../skills/create-site');
const spaStages = [
  'discovery', 'template-selection', 'template-preflight', 'template-install-plan',
  'template-import', 'template-provisioning', 'template-activation', 'template-customization',
  'from-scratch', 'scaffold', 'component-planning', 'plan-approval', 'implementation',
  'bidirectional-preparation', 'design-critique', 'localization', 'verification', 'review', 'deployment',
];
const nonSpaStages = [
  'non-spa-prerequisites', 'non-spa-selection', 'non-spa-configuration',
  'non-spa-provisioning', 'non-spa-baseline', 'non-spa-customization',
];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

function readCreateSiteGuidance(branch) {
  if (branch !== 'spa' && branch !== 'non-spa') throw new Error(`Unknown creation branch: ${branch}`);
  const stages = branch === 'spa' ? spaStages : nonSpaStages;
  const entry = branch === 'spa' ? 'SKILL.md' : 'workflows/non-spa-site.md';
  // Follow execution order, not alphabetical filesystem order: lifecycle assertions must
  // still reject import-before-pack, activation-before-import and success-before-validation.
  return [read(entry), ...stages.map((stage) => read(`references/${stage}-workflow.md`))].join('\n\n');
}

module.exports = { readCreateSiteGuidance, spaStages, nonSpaStages };
