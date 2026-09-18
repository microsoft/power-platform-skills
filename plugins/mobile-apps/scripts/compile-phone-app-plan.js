#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { compileInitialPhonePlan, readPhonePlan } = require('./lib/phone-app-plan');

async function main(argv = process.argv.slice(2)) {
  try {
    let root, receipt, check = false;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--receipt') receipt = argv[++index];
      else if (argv[index] === '--check') check = true;
      else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!root) throw new Error('--project-root is required');
    root = path.resolve(root);
    const context = require('./lib/mobile-authoring-context').readDescriptor({ projectRoot: root });
    const client = context
      ? require('./lib/mobile-authoring-transport').createClient({ projectRoot: root }) : null;
    if (client) {
      if (client.descriptor.operation !== 'prototype') throw new Error('Initial phone planning belongs to a new app build, not an edit or data connection');
      await client.verify({ refresh: true });
    }
    if (receipt) {
      if (!client) throw new Error('A signed phone app-plan decision requires an active Player job');
      const decision = await client.verifySavedDecision(receipt, { gateId: 'phone-app-plan' });
      if (decision.receipt.action !== 'approve') throw new Error('The app plan was not approved');
    }
    const result = compileInitialPhonePlan(root, { check, approved: Boolean(receipt) });
    if (client && !check && !receipt) {
      const plan = readPhonePlan(root, { initial: true });
      await client.event({
        kind: 'plan',
        screens: plan.screens.map(({ screenId, title, route, dependencies }) => ({ id: screenId, title, route, dependencies })),
      });
    }
    console.log(JSON.stringify({
      ...result,
      planDecisionVerified: Boolean(receipt),
    }));
    return 0;
  } catch (error) {
    console.error(`compile-phone-app-plan: ${error.message}`);
    return 1;
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main };
