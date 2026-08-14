#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONTRACTS = {
  'native-app-planner': {
    pluginFiles: ['agents/native-app-planner.md', 'agents/data-model-architect.md', 'agents/screen-planner.md'],
    needsSnapshot: true,
    writes: ['native-app-plan.md', 'mobile-app-plan.html', 'mobile-app-status.json'],
    fallback: 'foreground-gates-2-3',
  },
  'data-model-architect': {
    pluginFiles: ['agents/data-model-architect.md', 'shared/references/data-performance.md'],
    needsSnapshot: true,
    writes: ['_dm_section.md'],
    fallback: 'foreground-data-model-from-snapshot',
  },
  'screen-planner': {
    pluginFiles: ['agents/screen-planner.md', 'shared/references/screen-templates.md'],
    needsSnapshot: false,
    writes: ['_screens_section.md', 'mobile-app-plan.html'],
    fallback: 'foreground-screen-plan',
  },
  'screen-builder': {
    pluginFiles: ['agents/screen-builder.md'],
    needsSnapshot: false,
    writes: [],
    fallback: 'foreground-screen-build',
  },
};

function canWriteTarget(root, relativePath) {
  const parent = path.dirname(path.join(root, relativePath));
  try {
    fs.mkdirSync(parent, { recursive: true });
    fs.accessSync(parent, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function checkAgentPreflight({ agent, workingDir, pluginRoot, snapshot, output }) {
  const contract = CONTRACTS[agent];
  if (!contract) return { status: 'fallback', agent, missing: ['registered agent contract'], fallback: 'foreground-inline' };
  const missing = [];
  if (!workingDir || !fs.existsSync(workingDir)) missing.push('working directory');
  if (!pluginRoot || !fs.existsSync(pluginRoot)) missing.push('plugin root');
  if (pluginRoot) {
    for (const file of contract.pluginFiles) {
      if (!fs.existsSync(path.join(pluginRoot, file))) missing.push(`plugin file ${file}`);
    }
  }
  if (contract.needsSnapshot && (!snapshot || !fs.existsSync(snapshot))) {
    missing.push('normalized Dataverse snapshot');
  }
  if (workingDir) {
    const writes = output ? [output] : contract.writes;
    for (const file of writes) {
      if (!canWriteTarget(workingDir, file)) missing.push(`writable output ${file}`);
    }
  }
  return {
    status: missing.length === 0 ? 'ready' : 'fallback',
    agent,
    missing,
    fallback: missing.length === 0 ? null : contract.fallback,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1]) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.agent || !args['working-dir'] || !args['plugin-root']) {
    process.stderr.write('Usage: node agent-preflight.js --agent <name> --working-dir <path> --plugin-root <path> [--snapshot <path>] [--output <relative-path>]\n');
    process.exit(1);
  }
  const result = checkAgentPreflight({
    agent: args.agent,
    workingDir: path.resolve(args['working-dir']),
    pluginRoot: path.resolve(args['plugin-root']),
    snapshot: args.snapshot ? path.resolve(args.snapshot) : null,
    output: args.output,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main();

module.exports = { CONTRACTS, checkAgentPreflight };
