#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openZipReader } = require('./lib/safe-zip.js');

const NO_CURRENT_SOURCE_EXIT = 3;
const MAX_SOURCE_TREE_ENTRIES = 100000;
const SOURCE_MARKER = '.mobile-app-modernizer-source';
const SOURCE_MARKER_TEXT = 'Owned by modernize-canvas-app source acquisition. Generated artifacts only.\n';

class NoCurrentSourceError extends Error {
  constructor(details) {
    super('The package does not contain current Src/*.pa.yaml source.');
    this.name = 'NoCurrentSourceError';
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = { msapp: null, out: null, findSourceRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--msapp') args.msapp = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--find-source-root') args.findSourceRoot = argv[++index];
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.findSourceRoot) {
    if (args.msapp || args.out) throw new Error('--find-source-root cannot be combined with --msapp or --out');
  } else if (!args.msapp || !args.out) {
    throw new Error('--msapp and --out are required together');
  }
  return args;
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node extract-msapp-source.js --msapp <file.msapp> --out <owned-output-dir>',
    '  node extract-msapp-source.js --find-source-root <extracted-dir>',
    '',
    `Exit ${NO_CURRENT_SOURCE_EXIT} means a valid tree/package contained no current Src/*.pa.yaml source.`,
    'Only that exit is eligible for the deprecated PAC SourceCode-unpack fallback.',
    '',
  ].join('\n'));
}

function assertRealDirectory(directory, label) {
  const resolved = path.resolve(directory);
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory: ${resolved}`);
  return fs.realpathSync(resolved);
}

function inspectSourceTree(directory) {
  const root = assertRealDirectory(directory, 'source tree');
  const sourceDirectories = new Map();
  let retiredFormulaFiles = 0;
  let currentSourceFiles = 0;
  let entriesScanned = 0;

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      entriesScanned += 1;
      if (entriesScanned > MAX_SOURCE_TREE_ENTRIES) {
        throw new Error(`source tree exceeds ${MAX_SOURCE_TREE_ENTRIES} entries`);
      }
      const fullPath = path.join(current, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed in Canvas source: ${fullPath}`);
      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`special files are not allowed in Canvas source: ${fullPath}`);
      const lowerName = entry.name.toLowerCase();
      if (lowerName.endsWith('.fx.yaml')) retiredFormulaFiles += 1;
      if (!lowerName.endsWith('.pa.yaml')) continue;

      const relative = path.relative(root, fullPath);
      const segments = relative.split(path.sep);
      const srcIndex = segments.findIndex((segment) => segment.toLowerCase() === 'src');
      if (srcIndex < 0) continue;
      const srcDirectory = path.join(root, ...segments.slice(0, srcIndex + 1));
      const ownerRoot = path.dirname(srcDirectory);
      sourceDirectories.set(srcDirectory, ownerRoot);
      currentSourceFiles += 1;
    }
  }

  walk(root);
  const candidates = [...sourceDirectories.entries()]
    .map(([srcDirectory, ownerRoot]) => ({ srcDirectory, ownerRoot }))
    .sort((left, right) => left.srcDirectory.localeCompare(right.srcDirectory));
  return { root, candidates, currentSourceFiles, retiredFormulaFiles, entriesScanned };
}

function findUniqueSourceRoot(directory) {
  const inspection = inspectSourceTree(directory);
  if (inspection.candidates.length === 0) {
    throw new NoCurrentSourceError({
      reason: inspection.retiredFormulaFiles > 0 ? 'retired-fx-yaml-only' : 'no-current-pa-yaml',
      currentSourceFiles: 0,
      retiredFormulaFiles: inspection.retiredFormulaFiles,
      entriesScanned: inspection.entriesScanned,
    });
  }
  if (inspection.candidates.length > 1) {
    const candidates = inspection.candidates.map((entry) => path.relative(inspection.root, entry.srcDirectory) || path.basename(entry.srcDirectory));
    throw new Error(`multiple Canvas source roots found; refusing to guess: ${candidates.join(', ')}`);
  }
  return {
    sourceRoot: inspection.candidates[0].ownerRoot,
    srcDirectory: inspection.candidates[0].srcDirectory,
    currentSourceFiles: inspection.currentSourceFiles,
    retiredFormulaFiles: inspection.retiredFormulaFiles,
    entriesScanned: inspection.entriesScanned,
  };
}

function assertMsapp(msappPath) {
  const resolved = path.resolve(msappPath);
  if (!resolved.toLowerCase().endsWith('.msapp')) throw new Error(`local package must use the .msapp extension: ${resolved}`);
  if (!fs.existsSync(resolved)) throw new Error(`MSAPP file does not exist: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`MSAPP must be a regular file: ${resolved}`);
  return fs.realpathSync(resolved);
}

function assertOutputAvailable(outputPath, msappPath) {
  const output = path.resolve(outputPath);
  const relativeArchive = path.relative(output, msappPath);
  if (relativeArchive !== '..' && !relativeArchive.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeArchive)) {
    throw new Error('extraction output must not contain the source MSAPP file');
  }
  if (!fs.existsSync(output)) return output;
  const stat = fs.lstatSync(output);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`output must be a real directory: ${output}`);
  if (fs.readdirSync(output).length > 0) throw new Error(`output directory must be absent or empty: ${output}`);
  return output;
}

function extractMsapp(msappPath, outputPath) {
  const msapp = assertMsapp(msappPath);
  const requestedOutput = assertOutputAvailable(outputPath, msapp);
  const parent = path.dirname(requestedOutput);
  fs.mkdirSync(parent, { recursive: true });
  const canonicalParent = fs.realpathSync(parent);
  const output = path.join(canonicalParent, path.basename(requestedOutput));
  const staging = fs.realpathSync(fs.mkdtempSync(path.join(canonicalParent, `.${path.basename(output)}.partial-`)));
  let committed = false;
  try {
    const archive = openZipReader(msapp, { label: 'MSAPP' });
    archive.extractTo(staging);
    const source = findUniqueSourceRoot(staging);
    const relativeSourceRoot = path.relative(staging, source.sourceRoot);
    fs.writeFileSync(path.join(staging, SOURCE_MARKER), SOURCE_MARKER_TEXT, { encoding: 'utf8', flag: 'wx' });
    if (fs.existsSync(output)) fs.rmdirSync(output);
    fs.renameSync(staging, output);
    committed = true;
    return {
      acquisition: 'safe-direct-msapp-extraction',
      extractedRoot: output,
      sourceRoot: path.resolve(output, relativeSourceRoot),
      currentSourceFiles: source.currentSourceFiles,
      retiredFormulaFiles: source.retiredFormulaFiles,
      archiveEntries: archive.entries().length,
      sourceMarker: SOURCE_MARKER,
    };
  } finally {
    if (!committed) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }
  const result = args.findSourceRoot
    ? { acquisition: 'existing-source-tree', ...findUniqueSourceRoot(args.findSourceRoot) }
    : extractMsapp(args.msapp, args.out);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (error instanceof NoCurrentSourceError) {
      process.stdout.write(`${JSON.stringify({
        acquisition: 'no-current-source',
        fallbackEligible: true,
        ...error.details,
      })}\n`);
      process.stderr.write(`[msapp-source] NO_CURRENT_SOURCE: ${error.message}\n`);
      process.exit(NO_CURRENT_SOURCE_EXIT);
    }
    process.stderr.write(`[msapp-source] FAILED: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  }
}

module.exports = {
  MAX_SOURCE_TREE_ENTRIES,
  NO_CURRENT_SOURCE_EXIT,
  SOURCE_MARKER,
  SOURCE_MARKER_TEXT,
  NoCurrentSourceError,
  extractMsapp,
  findUniqueSourceRoot,
  inspectSourceTree,
  main,
};
