#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compareDerivedMetadata } = require('./lib/derived-metadata');

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--expected') args.expected = argv[++index];
    else if (argv[index] === '--actual') args.actual = argv[++index];
  }
  return args;
}

function readJson(filePath, label) {
  if (!filePath) throw new Error(`${label} path is required`);
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`${label} path not found: ${resolved}`);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv);
  const expected = readJson(args.expected, '--expected');
  const actual = readJson(args.actual, '--actual');
  const results = compareDerivedMetadata(expected.columns || expected, actual.columns || actual);
  const incompatible = results.filter((result) => !result.compatible);
  process.stdout.write(`${JSON.stringify({
    status: incompatible.length === 0 ? 'VALID' : 'BLOCKED',
    results,
  }, null, 2)}\n`);
  return incompatible.length === 0 ? 0 : 2;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, readJson };
