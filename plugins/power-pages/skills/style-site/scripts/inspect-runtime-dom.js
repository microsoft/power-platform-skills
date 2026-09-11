#!/usr/bin/env node
'use strict';

const { parseArgs } = require('../../../scripts/lib/classic-site-style-context');
const { buildRuntimeInspection } = require('../../../scripts/lib/runtime-style-context');

function main(argv) {
  const args = parseArgs(argv, ['url', 'selector', 'maxCandidates']);
  return buildRuntimeInspection(args);
}

if (require.main === module) {
  try { console.log(main(process.argv.slice(2))); }
  catch (error) { console.error(`style-site: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
