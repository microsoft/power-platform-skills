#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const { runNpm } = require('./lib/node-tool.js');
const {
  listTemplates,
  listRecipes,
  planScaffold,
  writeScaffold,
} = require('./lib/pcf-scaffold.js');

const USAGE = `Usage:
  node scripts/pcf-scaffold.js --list
  node scripts/pcf-scaffold.js --template <id> --namespace <Namespace> --name <ControlName> --out <dir> [--hosts model,pages] [--recipe <id>] [--display-name <text>] [--description <text>] [--install] [--npm-cli <path>]`;

const KNOWN = [
  'template',
  'namespace',
  'name',
  'out',
  'recipe',
  'hosts',
  'display-name',
  'description',
  'install',
  'list',
  'npm-cli',
];
const NEED_VALUE = ['template', 'namespace', 'name', 'out', 'recipe', 'hosts', 'display-name', 'description', 'npm-cli'];

function usageError(message) {
  process.stderr.write(`${USAGE}\n${message}\n`);
  process.exit(1);
}

function main(argv) {
  const parsed = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: KNOWN,
    needValue: NEED_VALUE,
    hints: {
      template: 'use --list to see available templates',
      hosts: 'comma-separated values: model,pages',
      'npm-cli': 'path to npm-cli.js',
    },
  });
  if (flagError) usageError(flagError);

  const { flags } = parsed;
  if (flags.list) {
    return emitResult(true, { ok: true, templates: listTemplates(), recipes: listRecipes() });
  }

  for (const required of ['template', 'namespace', 'name', 'out']) {
    if (!flags[required]) usageError(`--${required} is required`);
  }

  const outDir = path.resolve(String(flags.out));
  const recipe = flags.recipe ? String(flags.recipe) : undefined;
  const plan = planScaffold({
    template: String(flags.template),
    recipe,
    namespace: String(flags.namespace),
    name: String(flags.name),
    displayName: flags['display-name'] ? String(flags['display-name']) : undefined,
    description: flags.description ? String(flags.description) : undefined,
    hosts: flags.hosts ? String(flags.hosts).split(',') : ['model'],
  });
  const written = writeScaffold(plan, outDir);

  if (flags.install) {
    const install = runNpm(['ci'], { cwd: outDir, npmCli: flags['npm-cli'] ? String(flags['npm-cli']) : undefined });
    if (install.status !== 0) {
      const detail = [install.stderr, install.stdout].filter(Boolean).join('\n').trim();
      throw new Error(`npm ci failed${detail ? `:\n${detail}` : ''}`);
    }
  }

  emitResult(true, {
    ok: true,
    outDir,
    template: String(flags.template),
    recipe: recipe || null,
    recipeTitle: plan.recipe ? plan.recipe.title : recipe || null,
    files: written.written,
    next: [
      'node node_modules/pcf-scripts/bin/pcf-scripts.js build --buildMode production',
      'node node_modules/pcf-scripts/bin/pcf-scripts.js lint',
      'node node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand',
    ],
  });
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    emitResult(false, err);
  }
}

module.exports = { main };
