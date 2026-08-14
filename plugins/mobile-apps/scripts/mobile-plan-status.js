#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--clear') {
      args.clear = true;
    } else if (argv[i].startsWith('--') && argv[i + 1]) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

function asBoolean(value) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected true or false, received ${value}`);
}

function updateStatus(file, patch) {
  let current = {};
  if (fs.existsSync(file)) current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = {
    version: 1,
    startedAt: current.startedAt || new Date().toISOString(),
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return next;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args['project-root']) {
    process.stderr.write('Usage: node mobile-plan-status.js --project-root <path> [--phase <name>] [--message <text>] [--state <state>] [--completed <n>] [--total <n>] [--awaiting-input true|false] [--input-prompt <text>] [--clear]\n');
    process.exit(1);
  }
  const file = path.join(path.resolve(args['project-root']), 'mobile-app-status.json');
  if (args.clear) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    console.log(JSON.stringify({ status: 'cleared', file }));
    return;
  }
  const value = updateStatus(file, {
    phase: args.phase,
    message: args.message,
    state: args.state,
    completed: args.completed === undefined ? undefined : Number(args.completed),
    total: args.total === undefined ? undefined : Number(args.total),
    awaitingInput: asBoolean(args['awaiting-input']),
    inputPrompt: args['input-prompt'],
  });
  console.log(JSON.stringify({ status: 'ok', file, value }));
}

if (require.main === module) main();

module.exports = { updateStatus };
