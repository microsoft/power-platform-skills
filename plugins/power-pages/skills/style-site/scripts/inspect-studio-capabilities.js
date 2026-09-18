#!/usr/bin/env node
'use strict';

const { parseArgs, readText } = require('../../../scripts/lib/classic-site-style-context');
const { compactSummary } = require('../../../scripts/lib/style-site-summary');
const { studioSupport, requestSupport } = require('../../../scripts/lib/studio-style-capabilities');

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, ['component', 'properties', 'flex', 'request']);
  if (args.request) {
    if (args.component || args.properties || args.flex) throw new Error('Use --request or --component/--properties, not both.');
    const request = JSON.parse(readText(args.request));
    if (!Array.isArray(request.styles) || request.styles.length < 1 || request.styles.length > 100) throw new Error('Request needs 1-100 style groups.');
    return compactSummary({ surface: 'Component Design panel only', assessments: requestSupport(request) });
  }
  if (!args.component || !args.properties) throw new Error('Usage: inspect-studio-capabilities.js --component "Button" --properties "text-shadow,text-align" [--flex available|unavailable], or --request <request.json>');
  const properties = args.properties.split(',').map((property) => property.trim());
  if (properties.length > 100 || properties.some((property) => !property)) throw new Error('Provide 1-100 non-empty property names.');
  return compactSummary({
    surface: 'Component Design panel only', component: args.component,
    properties: properties.map((property) => studioSupport.lookup(args.component, property, args.flex)),
  });
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(), null, 2)); }
  catch (error) { console.error(`Studio capabilities: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
