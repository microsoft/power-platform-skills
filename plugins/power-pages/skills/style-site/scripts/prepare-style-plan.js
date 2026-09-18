#!/usr/bin/env node
'use strict';

const { readText, parseArgs } = require('../../../scripts/lib/classic-site-style-context');
const { preparePlan, saveJson } = require('../../../scripts/lib/style-site-plan');

function main(argv) {
  const args = parseArgs(argv, ['siteRoot', 'request', 'out']);
  if (!args.request || !args.out) throw new Error('--request and --out are required.');
  const plan = preparePlan(args.siteRoot, JSON.parse(readText(args.request)));
  saveJson(args.out, plan, plan.siteRoot);
  return { plan: args.out, planHash: plan.planHash, files: plan.writes.map((write) => write.path), warnings: plan.warnings };
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`style-site: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
