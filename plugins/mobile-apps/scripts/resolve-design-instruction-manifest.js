#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const skillRoot = path.join(pluginRoot, 'skills', 'design-system');
const ownershipPath = path.join(skillRoot, 'reference-ownership.json');
const OUTPUT_PATH = '.tmp/design-instruction-manifest.json';

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function referenceFiles(directory, prefix = 'references') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...referenceFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function validateOwnership(ownership) {
  const errors = [];
  if (ownership?.schemaVersion !== 1) errors.push('/schemaVersion: must be 1');
  const references = Array.isArray(ownership?.references) ? ownership.references : [];
  const listed = references.map((entry) => entry.path);
  const actual = referenceFiles(path.join(skillRoot, 'references'));
  if (new Set(listed).size !== listed.length) errors.push('/references: paths must be unique');
  for (const relativePath of actual) if (!listed.includes(relativePath)) errors.push(`/references: unowned file ${relativePath}`);
  for (const relativePath of listed) if (!actual.includes(relativePath)) errors.push(`/references: missing file ${relativePath}`);
  for (const [index, entry] of references.entries()) {
    if (!['mode-specific', 'historical-example'].includes(entry.classification)) errors.push(`/references/${index}/classification: invalid value`);
    if (typeof entry.owner !== 'string' || !entry.owner) errors.push(`/references/${index}/owner: is required`);
  }
  const automaticReferences = ownership?.automaticMode?.referenceFiles;
  if (!Array.isArray(automaticReferences) || automaticReferences.length) errors.push('/automaticMode/referenceFiles: automatic mode must load no optional references');
  if (ownership?.automaticMode?.modelCalls !== 0) errors.push('/automaticMode/modelCalls: automatic design must use zero model calls');
  return errors;
}

function projectFile(relativePath) {
  const absolute = path.resolve(pluginRoot, relativePath);
  if (!absolute.startsWith(`${pluginRoot}${path.sep}`) || !fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) throw new Error(`instruction file is missing or unsafe: ${relativePath}`);
  return absolute;
}

function resolveDesignInstructionManifest(mode = 'automatic-native') {
  const ownership = readJson(ownershipPath, 'Design reference ownership');
  const errors = validateOwnership(ownership);
  if (errors.length) throw new Error(`invalid design reference ownership: ${errors.join('; ')}`);
  const automatic = mode === 'automatic-native';
  const referenceEntries = automatic
    ? []
    : ownership.references.filter((entry) => entry.owner === mode || mode === 'optional-all');
  if (!automatic && !referenceEntries.length) throw new Error(`unknown or empty optional design mode: ${mode}`);
  const instructionFiles = automatic
    ? ownership.automaticMode.instructionFiles
    : ['skills/design-system/SKILL.md', 'skills/design-system/optional-modes.md'];
  const loadedFiles = [...instructionFiles, ...referenceEntries.map((entry) => `skills/design-system/${entry.path}`)];
  const fileBytes = Object.fromEntries(loadedFiles.map((relativePath) => [relativePath, fs.statSync(projectFile(relativePath)).size]));
  return {
    schemaVersion: 1,
    kind: 'design-instruction-manifest',
    mode,
    loadedFiles,
    fileBytes,
    loadedBytes: Object.values(fileBytes).reduce((total, value) => total + value, 0),
    modelCalls: automatic ? 0 : 1,
    referenceFiles: referenceEntries.map((entry) => entry.path),
    optionalReferencesLoaded: referenceEntries.length,
  };
}

function writeAtomic(projectRoot, manifest) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const target = path.join(root, OUTPUT_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return target;
}

function main(argv) {
  const args = { mode: 'automatic-native' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--mode') args.mode = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node resolve-design-instruction-manifest.js --project-root <dir> [--mode automatic-native] [--json]\n');
    return 2;
  }
  try {
    const manifest = resolveDesignInstructionManifest(args.mode);
    writeAtomic(args.projectRoot, manifest);
    process.stdout.write(`${args.json ? JSON.stringify(manifest, null, 2) : `Design instructions: ${manifest.mode}, ${manifest.loadedFiles.length} file(s), ${manifest.loadedBytes} bytes, ${manifest.modelCalls} model call(s).`}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`resolve-design-instruction-manifest: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { OUTPUT_PATH, referenceFiles, resolveDesignInstructionManifest, validateOwnership, writeAtomic };
