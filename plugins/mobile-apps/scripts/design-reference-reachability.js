#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AUTOMATIC_SEEDS = Object.freeze([
  'auto-experience.md',
  'design-system-schema.md',
  'final-experience-preview.md',
]);
const OPTIONAL_MODE_SEEDS = Object.freeze([
  'brand-style-workflow.md',
  'figma-extraction.md',
  'gallery-review.md',
  'lifecycle-migration.md',
  'tamagui-integration.md',
]);

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function walkFiles(root, predicate) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(target, predicate));
    else if (entry.isFile() && predicate(target)) files.push(target);
  }
  return files.sort();
}

function localReferenceLinks(file, referenceRoot) {
  const source = fs.readFileSync(file, 'utf8');
  const targets = [];
  for (const match of source.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]+)?\)/g)) {
    const resolved = path.resolve(path.dirname(file), match[1]);
    const relative = path.relative(referenceRoot, resolved);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      targets.push(toPosix(relative));
    }
  }
  return [...new Set(targets)].sort();
}

function closure(seeds, graph) {
  const reached = new Set();
  const pending = [...seeds];
  while (pending.length > 0) {
    const current = pending.shift();
    if (reached.has(current) || !graph.has(current)) continue;
    reached.add(current);
    pending.push(...graph.get(current));
  }
  return reached;
}

function testReferences(pluginRoot, referencePaths) {
  const testsRoot = path.join(pluginRoot, 'scripts', 'tests');
  const testFiles = walkFiles(testsRoot, (file) => /\.(?:js|cjs|mjs|ts)$/.test(file));
  const sources = testFiles.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
  return new Map(referencePaths.map((referencePath) => {
    const fullPath = `skills/design-system/references/${referencePath}`;
    const matches = sources
      .filter(({ source }) => source.includes(fullPath))
      .map(({ file }) => toPosix(path.relative(pluginRoot, file)));
    return [referencePath, matches];
  }));
}

function buildReachabilityReport(pluginRoot = path.resolve(__dirname, '..')) {
  const referenceRoot = path.join(pluginRoot, 'skills', 'design-system', 'references');
  const references = walkFiles(referenceRoot, (file) => file.endsWith('.md'));
  const referencePaths = references.map((file) => toPosix(path.relative(referenceRoot, file)));
  const graph = new Map(references.map((file) => [
    toPosix(path.relative(referenceRoot, file)),
    localReferenceLinks(file, referenceRoot),
  ]));
  // Automatic mode is intentionally not a transitive graph walk: links inside its schema are
  // documentation pointers, not authorization to load optional implementation references.
  const automatic = new Set(AUTOMATIC_SEEDS.filter((seed) => graph.has(seed)));
  const optional = closure(OPTIONAL_MODE_SEEDS, graph);
  const testOnly = testReferences(pluginRoot, referencePaths);
  const classified = referencePaths.map((referencePath) => {
    let classification = 'genuinely-unreachable';
    if (automatic.has(referencePath)) classification = 'automatic';
    else if (optional.has(referencePath)) classification = 'explicit-optional-mode';
    else if ((testOnly.get(referencePath) || []).length > 0) classification = 'test-only';
    return {
      path: referencePath,
      classification,
      outgoingReferences: graph.get(referencePath),
      testReferences: testOnly.get(referencePath),
    };
  });
  const missingOptionalSeeds = OPTIONAL_MODE_SEEDS.filter((seed) => !graph.has(seed));
  return {
    schemaVersion: 1,
    reportType: 'design-reference-reachability',
    automaticSeeds: [...AUTOMATIC_SEEDS],
    optionalModeSeeds: [...OPTIONAL_MODE_SEEDS],
    summary: {
      total: classified.length,
      automatic: classified.filter((entry) => entry.classification === 'automatic').length,
      explicitOptionalMode: classified.filter(
        (entry) => entry.classification === 'explicit-optional-mode',
      ).length,
      testOnly: classified.filter((entry) => entry.classification === 'test-only').length,
      genuinelyUnreachable: classified.filter(
        (entry) => entry.classification === 'genuinely-unreachable',
      ).length,
    },
    references: classified,
    deletionCandidates: classified
      .filter((entry) => entry.classification === 'genuinely-unreachable')
      .map((entry) => entry.path),
    warnings: missingOptionalSeeds.map((seed) => ({
      code: 'optional-design-reference-missing',
      message: `optional design reference is unavailable: ${seed}`,
    })),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--plugin-root') args.pluginRoot = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const report = buildReachabilityReport(args.pluginRoot);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) {
      const output = path.resolve(args.output);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, serialized, 'utf8');
    }
    process.stdout.write(serialized);
    return 0;
  } catch (error) {
    process.stderr.write(`design-reference-reachability: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  AUTOMATIC_SEEDS,
  OPTIONAL_MODE_SEEDS,
  buildReachabilityReport,
  closure,
  localReferenceLinks,
  main,
};