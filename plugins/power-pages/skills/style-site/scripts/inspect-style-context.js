#!/usr/bin/env node
'use strict';

const { captureSite, parseArgs, assertOutsideSite, readText } = require('../../../scripts/lib/classic-site-style-context');
const { attachRuntimeEvidence } = require('../../../scripts/lib/runtime-style-context');
const { saveJson } = require('../../../scripts/lib/style-site-plan');
const { selectContext, inspectionSummary } = require('../../../scripts/lib/style-site-summary');

function main(argv) {
  const args = parseArgs(argv, ['siteRoot', 'runtimeSnapshot', 'pageId', 'page', 'target', 'summary', 'out']);
  const snapshot = captureSite(args.siteRoot);
  const context = structuredClone(snapshot.context);
  const selection = selectContext(snapshot, args);
  if (args.runtimeSnapshot) {
    const file = assertOutsideSite(context.siteRoot, args.runtimeSnapshot);
    context.runtime = attachRuntimeEvidence(context, args.pageId, JSON.parse(readText(file)));
  }
  if (args.summary || args.pageId || args.page || args.target) context.selection = selection;
  const artifact = args.out ? saveJson(args.out, context, context.siteRoot) : null;
  return args.summary || args.out ? inspectionSummary(context, selection, artifact) : context;
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`style-site: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
