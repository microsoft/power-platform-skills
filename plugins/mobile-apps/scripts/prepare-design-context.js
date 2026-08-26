#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DESIGN_ROOT = path.resolve(__dirname, '..', 'skills', 'design-system');
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const BASE = [
  'skills/design-system/references/design-system-schema.md',
  'skills/design-system/references/preview-template.md',
];
const MODES = {
  automatic: BASE,
  brand: [...BASE, 'skills/design-system/references/input-modes.md'],
  reference: [...BASE, 'skills/design-system/references/reference-intake.md', 'shared/references/reference-fidelity.md'],
  full: [...BASE, 'skills/design-system/references/input-modes.md', 'skills/design-system/references/vibe/style-picker.md', 'skills/design-system/references/vibe/brand-examples.md'],
  refresh: [...BASE, 'skills/design-system/references/refresh-flow.md'],
  figma: [...BASE, 'skills/design-system/references/input-modes.md', 'skills/design-system/references/figma-extraction.md'],
  'code-app': [...BASE, 'skills/design-system/references/input-modes.md', 'skills/design-system/references/code-app-extraction.md'],
  'canvas-app': [...BASE, 'skills/design-system/references/input-modes.md', 'skills/design-system/references/canvas-app-extraction.md'],
  'power-pages': [...BASE, 'skills/design-system/references/input-modes.md', 'skills/design-system/references/power-pages-extraction.md'],
  'design-spec': [...BASE, 'skills/design-system/references/input-modes.md', 'skills/design-system/references/design-spec-extraction.md'],
};

function referenceAllowlist(mode) {
  if (!Object.hasOwn(MODES, mode)) throw new Error(`Unsupported design context mode: ${mode}.`);
  return [...new Set(MODES[mode])];
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function prepareDesignContext(projectRoot, mode, options = {}) {
  const references = referenceAllowlist(mode).map((relativePath) => {
    const filePath = path.join(PLUGIN_ROOT, relativePath);
    if (!fs.existsSync(filePath)) throw new Error(`Design reference is missing: ${relativePath}.`);
    return { path: relativePath, bytes: fs.statSync(filePath).size };
  });
  const evidence = {
    schemaVersion: 1,
    mode,
    projectRoot: path.resolve(projectRoot),
    referenceFiles: references,
    totalReferenceBytes: references.reduce((total, reference) => total + reference.bytes, 0),
    designModelCalls: Number.isInteger(options.modelCalls) && options.modelCalls >= 0 ? options.modelCalls : 1,
    recordedAt: options.now || new Date().toISOString(),
    policy: mode === 'automatic'
      ? 'Only the automatic reference allowlist may be read.'
      : 'Only references owned by the selected explicit mode may be read.',
  };
  const output = path.resolve(projectRoot, options.output || '.tmp/design-execution-evidence.json');
  const root = path.resolve(projectRoot);
  if (output !== root && !output.startsWith(`${root}${path.sep}`)) throw new Error('Design evidence output must stay inside the project root.');
  writeJsonAtomic(output, evidence);
  return { output, evidence };
}

function parseArgs(argv) {
  const args = { mode: 'automatic', modelCalls: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--mode') args.mode = argv[++index];
    else if (argv[index] === '--model-calls') args.modelCalls = Number(argv[++index]);
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write(`Usage: node prepare-design-context.js --project-root <dir> [--mode ${Object.keys(MODES).join('|')}] [--model-calls <count>] [--output <relative-path>]\n`);
    return 2;
  }
  try {
    const result = prepareDesignContext(args.projectRoot, args.mode, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`prepare-design-context: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { DESIGN_ROOT, MODES, prepareDesignContext, referenceAllowlist, writeJsonAtomic };