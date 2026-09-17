#!/usr/bin/env node
'use strict';

const { parseArgs } = require('../../../scripts/lib/classic-site-style-context');
const { checkColorPair } = require('../../../scripts/lib/style-site-contrast');

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, ['foreground', 'background', 'fontSize', 'fontWeight']);
  if (['foreground', 'background', 'fontSize', 'fontWeight'].some((key) => args[key] === undefined)) {
    throw new Error('Usage: check-style-contrast.js --foreground "#ffffff" --background "#111827" --fontSize 16 --fontWeight 400');
  }
  return checkColorPair(args);
}

if (require.main === module) {
  try {
    const result = main();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'fail') process.exitCode = 1;
  } catch (error) { console.error(`Style contrast: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
