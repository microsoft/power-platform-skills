#!/usr/bin/env node
'use strict';

const { inspectSite, parseArgs, assertOutsideSite, readText } = require('../../../scripts/lib/classic-site-style-context');
const { attachRuntimeEvidence } = require('../../../scripts/lib/runtime-style-context');

function main(argv) {
  const args = parseArgs(argv, ['siteRoot', 'runtimeSnapshot', 'pageId']);
  const context = inspectSite(args.siteRoot);
  if (args.runtimeSnapshot) {
    const file = assertOutsideSite(context.siteRoot, args.runtimeSnapshot);
    context.runtime = attachRuntimeEvidence(context, args.pageId, JSON.parse(readText(file)));
  } else if (args.pageId) throw new Error('--pageId is used with --runtimeSnapshot.');
  return context;
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`style-site: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
