#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runVariant } = require('./run-live-build-plan-acceptance');

const DEFINITIONS = Object.freeze({
  flight: { id: 'live-flight', scenario: 'flightCommerce', mode: 'connector-only' },
  gym: { id: 'live-gym', scenario: 'gymMaintenance', mode: 'mixed' },
  icrc: { id: 'live-icrc', scenario: 'icrcReceiving', mode: 'dataverse' },
});
const CANONICAL_ARTIFACTS = Object.freeze({
  'product-experience-contract.json': (run) => run.artifacts.bundle.experience,
  'product-scope-contract.json': (run) => run.artifacts.bundle.scope,
  'workflow-journey-contract.json': (run) => run.artifacts.bundle.journey,
  'screen-build-pack.json': (run) => run.artifacts.bundle.buildPack,
  'compiled-screen-build-pack.json': (run) => run.artifacts.compiled,
  'navigation-manifest.json': (run) => run.artifacts.navigation,
  'scenario-facts.json': (run) => run.artifacts.scenario,
  'persistence-contract.json': (run) => run.artifacts.persistence,
});

function copyTemplate(templateRoot, outputRoot) {
  fs.cpSync(templateRoot, outputRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(templateRoot, source);
      const first = relative.split(path.sep)[0];
      return !['node_modules', '.git', '.expo', '.tmp', 'dist', 'dist-web', 'web-build'].includes(first)
        && !['_plan_preview.html', '_plan_preview.structural.html', '_build_plan.html'].includes(relative);
    },
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function materializeWorkspace(scenario, outputRoot, pluginRoot = path.resolve(__dirname, '../../..')) {
  const definition = DEFINITIONS[scenario];
  if (!definition) throw new Error(`unsupported scenario: ${scenario}`);
  const root = path.resolve(outputRoot);
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    throw new Error(`output directory must be empty: ${root}`);
  }
  fs.mkdirSync(root, { recursive: true });
  copyTemplate(path.join(pluginRoot, 'template'), root);
  const run = runVariant(definition);
  for (const [name, project] of Object.entries(CANONICAL_ARTIFACTS)) {
    writeJson(path.join(root, '.tmp', name), project(run));
  }
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), [
    `# ${run.productName}`,
    '',
    '## Overview',
    run.artifacts.bundle.descriptor.brief,
    '',
    '## Product Experience',
    `Primary goal: ${run.artifacts.bundle.experience.primaryGoal}`,
    '',
    '## Product Scope',
    ...run.artifacts.bundle.scope.coreJobs.map((job) => `- ${job.statement}`),
    '',
    '## Screens',
    ...run.artifacts.compiled.screens.map((screen) => `- ${screen.title}: ${screen.pack.purpose}`),
    '',
  ].join('\n'));
  const manifest = {
    scenario,
    productName: run.productName,
    authoringInputs: [
      'native-app-plan.md',
      ...Object.keys(CANONICAL_ARTIFACTS).map((name) => `.tmp/${name}`),
    ],
    prohibitedInputCount: 0,
    previewPresentBeforeRun: fs.existsSync(path.join(root, '_plan_preview.html')),
  };
  writeJson(path.join(root, '.tmp', 'live-preview-acceptance-inputs.json'), manifest);
  return { root, run, manifest };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--scenario') args.scenario = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!args.scenario || !args.output) {
    throw new Error('Usage: materialize-final-preview-acceptance.js --scenario <flight|gym|icrc> --output <empty-dir>');
  }
  return args;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv);
    const result = materializeWorkspace(args.scenario, args.output);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      root: result.root,
      productName: result.run.productName,
      authoringInputs: result.manifest.authoringInputs,
      prohibitedInputCount: result.manifest.prohibitedInputCount,
      previewPresentBeforeRun: result.manifest.previewPresentBeforeRun,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`materialize-final-preview-acceptance: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CANONICAL_ARTIFACTS,
  DEFINITIONS,
  materializeWorkspace,
};