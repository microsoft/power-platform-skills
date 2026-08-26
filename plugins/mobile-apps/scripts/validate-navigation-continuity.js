#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validateNavigationContinuity(pack) {
  const issues = [];
  const destinations = new Map((pack.navigation?.destinations || []).map((destination) => [destination.id, destination]));
  const flowByScreen = new Map((pack.navigation?.flows || []).flatMap((flow) => flow.screenIds.map((screenId) => [screenId, flow])));
  const screens = new Map((pack.screens || []).map((screen) => [screen.id, screen]));
  for (const destination of destinations.values()) {
    const root = screens.get(destination.rootScreenId);
    if (!root || root.navigation?.destinationId !== destination.id || !['durable-destination', 'destination-root'].includes(root.navigation?.role)) issues.push({ rule: 'destination-root-drift', screenId: destination.rootScreenId, message: `Destination ${destination.id} root does not match the Screen Contract.` });
    if (pack.navigation.model === 'tabs-stack' && (!destination.label || !destination.iconIntent || !destination.testId)) issues.push({ rule: 'tab-accessibility-missing', screenId: destination.rootScreenId, message: `Destination ${destination.id} lacks label, icon, or test ID.` });
  }
  for (const screen of screens.values()) {
    const destinationId = screen.navigation?.destinationId;
    if (!destinations.has(destinationId)) issues.push({ rule: 'screen-owner-missing', screenId: screen.id, message: `Screen ${screen.id} has no valid destination owner.` });
    if (['durable-destination', 'destination-root'].includes(screen.navigation?.role)) continue;
    const flow = flowByScreen.get(screen.id);
    if (!flow || flow.ownerDestinationId !== destinationId) issues.push({ rule: 'flow-owner-drift', screenId: screen.id, message: `Screen ${screen.id} flow owner does not match its destination.` });
    if (['immersive-modal', 'modal-flow'].includes(screen.navigation?.role)) {
      if (screen.navigation.tabVisibility !== 'covered-by-modal' || !screen.navigation.cancelTarget || !screen.navigation.completionTarget) issues.push({ rule: 'modal-return-policy-missing', screenId: screen.id, message: `Modal screen ${screen.id} lacks covered-tab and return targets.` });
    } else if (pack.navigation.model === 'tabs-stack' && screen.navigation?.tabVisibility !== 'visible') {
      issues.push({ rule: 'ordinary-detail-hides-tabs', screenId: screen.id, message: `Ordinary nested screen ${screen.id} unexpectedly hides persistent navigation.` });
    }
    if (screen.navigation?.deepLinkable !== true || !screen.navigation?.backTarget) issues.push({ rule: 'deep-link-back-path-missing', screenId: screen.id, message: `Screen ${screen.id} lacks deep-link ownership or a valid back path.` });
  }
  for (const stage of pack.journey?.stages || []) {
    const stageScreens = stage.screenIds.map((screenId) => screens.get(screenId)).filter(Boolean);
    const owners = new Set(stageScreens.map((screen) => screen.navigation?.destinationId));
    if (owners.size > 1) issues.push({ rule: 'journey-stage-owner-drift', message: `Journey stage ${stage.id} crosses destination owners.` });
  }
  if (pack.navigation?.globalRoutePolicy?.homeReturnRequired && !destinations.has(pack.navigation.initialDestinationId)) issues.push({ rule: 'global-home-return-missing', message: 'Navigation requires a global return but initial destination is unavailable.' });
  const profilePolicy = pack.navigation?.globalRoutePolicy;
  const profile = screens.get(profilePolicy?.profileScreenId);
  if (!profile || profile.route !== profilePolicy.profileRoute) issues.push({ rule: 'profile-route-missing', message: 'Profile route is absent from the Screen Contract.' });
  for (const destinationId of destinations.keys()) {
    if (!(profilePolicy?.profileReachableFromDestinationIds || []).includes(destinationId)) issues.push({ rule: 'profile-unreachable', message: `Profile is not reachable from ${destinationId}.` });
  }
  return issues;
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-navigation-continuity.js --project-root <dir> [--pack .tmp/screen-build-pack.json] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const pack = JSON.parse(fs.readFileSync(path.resolve(root, args.pack || '.tmp/screen-build-pack.json'), 'utf8'));
    const issues = validateNavigationContinuity(pack);
    if (args.json) process.stdout.write(`${JSON.stringify({ validator: 'validate-navigation-continuity', valid: issues.length === 0, issues }, null, 2)}\n`);
    else if (issues.length) issues.forEach((item) => process.stderr.write(`- [${item.rule}] ${item.message}\n`));
    else process.stdout.write('Navigation continuity valid.\n');
    return issues.length ? 2 : 0;
  } catch (error) {
    process.stderr.write(`validate-navigation-continuity: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateNavigationContinuity };