#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMPLATE_MARKERS = [
  'package.json',
  'app.config.js',
  'auth.config.json',
  'tamagui.config.ts',
];

function usage() {
  return [
    'Usage: node resolve-mobile-app-target.js --launch-dir <path> --slug <slug> [--working-dir <path>]',
    '',
    'Without --working-dir, an existing template/app in --launch-dir is adopted.',
    'Otherwise the target is resolved as <launch-dir>/<slug>.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = {
    launchDir: null,
    slug: null,
    workingDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--launch-dir') {
      parsed.launchDir = argv[index + 1];
      index += 1;
    } else if (arg === '--slug') {
      parsed.slug = argv[index + 1];
      index += 1;
    } else if (arg === '--working-dir') {
      parsed.workingDir = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function canonicalizeCandidate(candidatePath) {
  const unresolvedSegments = [];
  let existingAncestor = candidatePath;

  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    unresolvedSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  const canonicalAncestor = fs.realpathSync(existingAncestor);
  return path.join(canonicalAncestor, ...unresolvedSegments);
}

function hasTemplateMarkers(projectRoot) {
  return TEMPLATE_MARKERS.every((relativePath) => (
    fs.existsSync(path.join(projectRoot, relativePath))
  ));
}

function hasGeneratedServices(projectRoot) {
  const servicesPath = path.join(projectRoot, 'src', 'generated', 'services');
  if (!fs.existsSync(servicesPath) || !fs.statSync(servicesPath).isDirectory()) {
    return false;
  }
  return fs.readdirSync(servicesPath).some((entry) => entry.endsWith('.ts'));
}

function isDirectoryEmpty(directoryPath) {
  return fs.readdirSync(directoryPath).length === 0;
}

function hasInitializedPowerConfig(projectRoot) {
  const powerConfigPath = path.join(projectRoot, 'power.config.json');
  if (!fs.existsSync(powerConfigPath)) return false;
  try {
    const powerConfig = JSON.parse(fs.readFileSync(powerConfigPath, 'utf8'));
    return typeof powerConfig.environmentId === 'string'
      && powerConfig.environmentId.trim().length > 0;
  } catch {
    // A malformed config is generated state too; never overwrite it as though
    // it were the template's known empty placeholder.
    return true;
  }
}

function inspectTarget(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return { exists: false, empty: true };
  }

  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Target must not be a symbolic link: ${targetPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Target must be a directory: ${targetPath}`);
  }

  return {
    exists: true,
    empty: isDirectoryEmpty(targetPath),
    hasTemplate: hasTemplateMarkers(targetPath),
    hasMemoryBank: fs.existsSync(path.join(targetPath, 'memory-bank.md')),
    hasPlan: fs.existsSync(path.join(targetPath, 'native-app-plan.md')),
    hasDataModel: fs.existsSync(path.join(targetPath, '.datamodel-manifest.json')),
    hasGeneratedServices: hasGeneratedServices(targetPath),
    hasInitializedPowerConfig: hasInitializedPowerConfig(targetPath),
    dependenciesInstalled: (
      fs.existsSync(path.join(targetPath, 'node_modules', 'expo'))
      && fs.existsSync(path.join(targetPath, 'node_modules', '.package-lock.json'))
    ),
  };
}

function resolveMobileAppTarget({ launchDir, slug, workingDir }) {
  if (!launchDir) throw new Error('--launch-dir is required');
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('--slug must be a non-empty kebab-case app slug');
  }

  const requestedLaunchDir = path.resolve(launchDir);
  if (!fs.existsSync(requestedLaunchDir) || !fs.statSync(requestedLaunchDir).isDirectory()) {
    throw new Error(`Launch directory not found: ${requestedLaunchDir}`);
  }
  const canonicalLaunchDir = fs.realpathSync(requestedLaunchDir);
  const launchInspection = inspectTarget(canonicalLaunchDir);

  // Running the skill from an already materialized template remains supported.
  // Otherwise a no-flag invocation creates a sibling project directory from the
  // approved app slug, which works the same in CLI and VS Code agent sessions.
  const requestedTarget = workingDir
    ? path.resolve(canonicalLaunchDir, workingDir)
    : launchInspection.hasTemplate
      ? canonicalLaunchDir
      : path.join(canonicalLaunchDir, slug);
  if (fs.existsSync(requestedTarget) && fs.lstatSync(requestedTarget).isSymbolicLink()) {
    throw new Error(`Target must not be a symbolic link: ${requestedTarget}`);
  }
  const targetPath = canonicalizeCandidate(requestedTarget);

  const filesystemRoot = path.parse(targetPath).root;
  const homeDirectory = fs.realpathSync(os.homedir());
  if (targetPath === filesystemRoot || targetPath === homeDirectory) {
    throw new Error(`Unsafe mobile app target: ${targetPath}`);
  }

  const inspection = inspectTarget(targetPath);
  if (!inspection.exists || inspection.empty) {
    if (targetPath === canonicalLaunchDir && !workingDir) {
      throw new Error('Refusing to materialize the template over the launch directory; use a child path');
    }
    return {
      action: 'materialize',
      dependenciesInstalled: false,
      launchDir: canonicalLaunchDir,
      partialPlan: false,
      workingDir: targetPath,
    };
  }

  if (!inspection.hasTemplate) {
    throw new Error(`Target is non-empty and is not a Power Apps mobile template: ${targetPath}`);
  }

  if (inspection.hasMemoryBank) {
    return {
      action: 'resume',
      dependenciesInstalled: inspection.dependenciesInstalled,
      launchDir: canonicalLaunchDir,
      partialPlan: inspection.hasPlan,
      workingDir: targetPath,
    };
  }

  if (
    inspection.hasDataModel
    || inspection.hasGeneratedServices
    || inspection.hasInitializedPowerConfig
  ) {
    throw new Error(
      `Target contains generated app data without memory-bank.md and cannot be safely resumed: ${targetPath}`,
    );
  }

  return {
    action: 'adopt',
    dependenciesInstalled: inspection.dependenciesInstalled,
    launchDir: canonicalLaunchDir,
    partialPlan: inspection.hasPlan,
    workingDir: targetPath,
  };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 1;
  }

  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    const result = resolveMobileAppTarget(parsed);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  inspectTarget,
  parseArgs,
  resolveMobileAppTarget,
};
