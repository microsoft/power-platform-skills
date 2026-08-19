#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getSection, parseBulletFields } = require('./validate-experience-contract');

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
    version: 2,
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

function experienceStatusFromPlan(planPath) {
  if (!planPath || !fs.existsSync(planPath)) return {};
  const section = getSection(fs.readFileSync(planPath, 'utf8'), 'Product Experience');
  if (!section) return {};
  const fields = parseBulletFields(section.split(/^### First Viewport Contract\s*$/m)[0]);
  return {
    productArchetype: fields.get('product archetype'),
    visualPersonality: fields.get('visual personality'),
    homeComposition: fields.get('home composition'),
    referenceFidelity: fields.get('reference fidelity'),
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args['project-root']) {
    process.stderr.write('Usage: node mobile-plan-status.js --project-root <path> [--from-plan <path>] [--phase <name>] [--message <text>] [--state <state>] [--completed <n>] [--total <n>] [--awaiting-input true|false] [--input-prompt <text>] [--product-archetype <slug>] [--visual-personality <slug>] [--home-composition <slug>] [--reference-fidelity <level>] [--visual-qa-state <state>] [--visual-qa-report <path>] [--visual-qa-coverage <summary>] [--clear]\n');
    process.exit(1);
  }
  const file = path.join(path.resolve(args['project-root']), 'mobile-app-status.json');
  if (args.clear) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    console.log(JSON.stringify({ status: 'cleared', file }));
    return;
  }
  const fromPlan = experienceStatusFromPlan(args['from-plan'] ? path.resolve(args['from-plan']) : null);
  const value = updateStatus(file, {
    ...fromPlan,
    phase: args.phase,
    message: args.message,
    state: args.state,
    completed: args.completed === undefined ? undefined : Number(args.completed),
    total: args.total === undefined ? undefined : Number(args.total),
    awaitingInput: asBoolean(args['awaiting-input']),
    inputPrompt: args['input-prompt'],
    productArchetype: args['product-archetype'],
    visualPersonality: args['visual-personality'],
    homeComposition: args['home-composition'],
    referenceFidelity: args['reference-fidelity'],
    visualQaState: args['visual-qa-state'],
    visualQaReport: args['visual-qa-report'],
    visualQaCoverage: args['visual-qa-coverage'],
  });
  console.log(JSON.stringify({ status: 'ok', file, value }));
}

if (require.main === module) main();

module.exports = { experienceStatusFromPlan, updateStatus };
