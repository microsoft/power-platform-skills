#!/usr/bin/env node
'use strict';

const { inspectSite, parseArgs } = require('../../../scripts/lib/classic-site-style-context');

function main(argv) {
  const args = parseArgs(argv, ['siteRoot']);
  return inspectSite(args.siteRoot);
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`style-site: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
