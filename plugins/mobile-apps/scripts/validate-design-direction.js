#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const block = require('./lib/design-direction-block');

function main() {
  try {
    const planArg = process.argv.find((value, index) => index > 1 && !value.startsWith('--'));
    if (!planArg) throw new Error('usage: validate-design-direction.js <native-app-plan.md> [--json] [--allow-fallback]');
    const result = block.inspect(fs.readFileSync(path.resolve(planArg), 'utf8'));
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else if (!result.present) console.log('design-direction: ABSENT (catalogue fallback)');
    else if (result.valid) console.log(`design-direction: PASS (${result.bundle.direction})`);
    else console.log(`design-direction: MALFORMED (fallback)\n- ${result.errors.join('\n- ')}`);
    if (result.present && !result.valid && !process.argv.includes('--allow-fallback')) process.exitCode = 2;
  } catch (error) {
    console.error(`design-direction: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();