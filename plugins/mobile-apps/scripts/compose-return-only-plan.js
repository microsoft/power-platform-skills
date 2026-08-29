#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_MODEL_PLACEHOLDER = '<!-- RETURN_ONLY_DATA_MODEL_SECTION -->';
const SCREENS_PLACEHOLDER = '<!-- RETURN_ONLY_SCREENS_SECTION -->';
const REQUIRED_HEADINGS = [
  'Overview',
  'App Requirements',
  'Product Experience',
  'Product Scope',
  'Data Model',
  'Native Capabilities',
  'Design',
  'Connectors',
  'Screens',
  'Approval Status',
  'Plan Provenance',
];

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--draft') args.draft = argv[++index];
    else if (token === '--data-model') args.dataModel = argv[++index];
    else if (token === '--screens') args.screens = argv[++index];
    else if (token === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function projectFile(projectRoot, file, label) {
  if (!file) throw new Error(`${label} is required`);
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside project root`);
  }
  return resolved;
}

function requireOnce(content, marker, label) {
  const count = content.split(marker).length - 1;
  if (count !== 1) throw new Error(`${label} must occur exactly once`);
}

function normalizedSection(content, heading) {
  const normalized = String(content || '').trim();
  if (!normalized.startsWith(`## ${heading}\n`)) {
    throw new Error(`${heading} section must start with ## ${heading}`);
  }
  return normalized;
}

function composePlan({ draft, dataModel, screens }) {
  const normalizedDraft = String(draft || '').trim();
  requireOnce(normalizedDraft, DATA_MODEL_PLACEHOLDER, 'Data Model placeholder');
  requireOnce(normalizedDraft, SCREENS_PLACEHOLDER, 'Screens placeholder');
  const result = `${normalizedDraft
    .replace(DATA_MODEL_PLACEHOLDER, normalizedSection(dataModel, 'Data Model'))
    .replace(SCREENS_PLACEHOLDER, normalizedSection(screens, 'Screens'))}\n`;
  const headings = [...result.matchAll(/^## ([^\n]+)$/gm)].map((match) => match[1]);
  if (JSON.stringify(headings) !== JSON.stringify(REQUIRED_HEADINGS)) {
    throw new Error(
      `composed plan headings must be exactly: ${REQUIRED_HEADINGS.join(', ')}`,
    );
  }
  return result;
}

function atomicWrite(file, content, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fileSystem.writeFileSync(temporary, content, 'utf8');
    fileSystem.renameSync(temporary, file);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
  }
}

function run(args, fileSystem = fs) {
  if (!args.projectRoot) throw new Error('--project-root is required');
  const draftPath = projectFile(args.projectRoot, args.draft, '--draft');
  const dataModelPath = projectFile(args.projectRoot, args.dataModel, '--data-model');
  const screensPath = projectFile(args.projectRoot, args.screens, '--screens');
  const outputPath = projectFile(args.projectRoot, args.output, '--output');
  const content = composePlan({
    draft: fileSystem.readFileSync(draftPath, 'utf8'),
    dataModel: fileSystem.readFileSync(dataModelPath, 'utf8'),
    screens: fileSystem.readFileSync(screensPath, 'utf8'),
  });
  atomicWrite(outputPath, content, fileSystem);
  return { status: 'DONE', output: outputPath, headings: REQUIRED_HEADINGS };
}

function main(argv = process.argv) {
  try {
    const result = run(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`compose-return-only-plan: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  DATA_MODEL_PLACEHOLDER,
  REQUIRED_HEADINGS,
  SCREENS_PLACEHOLDER,
  composePlan,
  main,
  run,
};