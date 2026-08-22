#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const directionBlock = require('./lib/design-direction-block');

function atomicWrite(filePath, contents) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, filePath);
}

function render(input) {
  const references = Array.isArray(input.referenceApps) ? input.referenceApps : [];
  const timestamp = String(input.pickedAt || '').replace(/\s+\(via\s+[^)]+\)\s*$/i, '').trim();
  const bundleValue = (key) => input.bundle && Object.hasOwn(input.bundle, key) ? String(input.bundle[key]) : '';
  const lines = [
    directionBlock.HEADING,
    '',
    `**Picked:** ${input.picked || ''}`,
    `**Reference apps:** ${references.join(', ')}`,
    `**Picked at:** ${timestamp} (via /design-system style picker)`,
    '',
    ...directionBlock.REQUIRED_KEYS.map((key) => `${key}: ${bundleValue(key)}`),
    '',
    '> Downstream agents (`screen-planner`, `screen-builder`) MUST use these values',
    '> as defaults for their own per-screen Surface / Density / List style / Motion',
    '> fields unless a per-screen spec explicitly overrides.',
  ];
  return `${lines.join('\n')}\n`;
}

function write(planPath, input) {
  const markdown = fs.readFileSync(planPath, 'utf8');
  const previous = directionBlock.inspect(markdown);
  const candidate = directionBlock.replace(markdown, render(input));
  const validation = directionBlock.inspect(candidate);
  if (!validation.valid || !validation.present) throw new Error(`invalid Design Direction block: ${validation.errors.join('; ')}`);
  atomicWrite(planPath, candidate);
  return {
    direction: validation.bundle.direction,
    previousDirection: previous.valid && previous.present ? previous.bundle.direction : null,
    replaced: previous.present,
  };
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const plan = value('--plan');
  const input = value('--input');
  if (!plan || !input) throw new Error('usage: write-design-direction.js --plan <native-app-plan.md> --input <direction.json>');
  return { plan: path.resolve(plan), input: path.resolve(input) };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = write(args.plan, JSON.parse(fs.readFileSync(args.input, 'utf8')));
    console.log(`design-direction: wrote ${result.direction}${result.replaced ? ' (replaced)' : ' (inserted)'}`);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`design-direction: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { atomicWrite, parseArgs, render, write };