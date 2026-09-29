#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const { listTemplates, listRecipes, planScaffold, writeScaffold } = require('./lib/pcf-scaffold.js');
const { loadMatrix, dependencySet } = require('./lib/pcf-matrix.js');
const { buildControl } = require('./lib/pcf-build.js');
const { runNodeScript, runNpm } = require('./lib/node-tool.js');

const USAGE = `Usage:
  node scripts/pcf-ci-build.js [--all | --template <id> | --recipe <id>] [--latest] [--keep] [--package] [--npm-cli <path>]`;

const KNOWN = ['all', 'template', 'recipe', 'latest', 'keep', 'package', 'npm-cli'];
const NEED_VALUE = ['template', 'recipe', 'npm-cli'];
const SCRIPT_DIR = __dirname;
const DEFAULT_ROOT = path.join(SCRIPT_DIR, '..');
const PACKAGE_VERSION = '1.0.0';

function usageError(message) {
  process.stderr.write(`${USAGE}\n${message}\n`);
  process.exit(1);
}

function runCiBuild(options = {}, deps = {}) {
  const fsDep = deps.fs || fs;
  const osDep = deps.os || os;
  const pathDep = deps.path || path;
  const root = deps.root || DEFAULT_ROOT;
  const createdRoot = pathDep.join(osDep.tmpdir(), `pcf-ci-${crypto.randomBytes(6).toString('hex')}`);
  const started = Date.now();
  const targets = options.package ? packageSmokeTargets(deps) : selectTargets(options, deps);
  const results = [];
  const skipped = [];
  try {
    fsDep.mkdirSync(createdRoot, { recursive: true });
    if (options.all) {
      for (const recipe of recipes(deps).filter((item) => item.status === 'planned')) {
        skipped.push({ id: recipe.id, kind: 'recipe', reason: 'planned' });
      }
    }

    for (const target of targets) {
      const targetStarted = Date.now();
      const projectDir = pathDep.join(createdRoot, target.id);
      const result = runTarget(target, projectDir, options, { ...deps, root });
      results.push({ id: target.id, kind: target.kind, ok: result.ok, gates: result.gates || [], durationMs: Date.now() - targetStarted, ...result.extra });
    }
  } finally {
    if (!options.keep) fsDep.rmSync(createdRoot, { recursive: true, force: true });
  }

  const ok = results.every((item) => item.ok);
  return { ok, results, skipped, durationMs: Date.now() - started };
}

function selectTargets(options, deps = {}) {
  const allTemplates = templates(deps);
  const allRecipes = recipes(deps);
  if (options.template) return [templateTarget(String(options.template), allTemplates)];
  if (options.recipe) return [recipeTarget(String(options.recipe), allRecipes, allTemplates)];
  if (!options.all) throw new Error('Choose --all, --template <id>, --recipe <id>, or --package.');
  return [
    ...allTemplates.map((template) => targetFromTemplate(template)),
    ...allRecipes.filter((recipe) => recipe.status !== 'planned').map((recipe) => targetFromRecipe(recipe, allTemplates)),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

function packageSmokeTargets(deps = {}) {
  const allTemplates = templates(deps);
  const allRecipes = recipes(deps);
  const targets = [
    targetFromTemplate(allTemplates.find((item) => item.id === 'field-virtual')),
    targetFromRecipe(allRecipes.find((item) => item.id === 'grid-customizer'), allTemplates),
    targetFromRecipe(allRecipes.find((item) => item.id === 'star-rating'), allTemplates),
  ].filter(Boolean);
  return targets.sort((a, b) => a.id.localeCompare(b.id));
}

function templates(deps) {
  return (deps.listTemplates || listTemplates)(deps);
}

function recipes(deps) {
  return (deps.listRecipes || listRecipes)(deps);
}

function templateTarget(id, allTemplates) {
  const template = allTemplates.find((item) => item.id === id);
  if (!template) throw new Error(`Unknown PCF template: ${id}`);
  return targetFromTemplate(template);
}

function recipeTarget(id, allRecipes, allTemplates) {
  const recipe = allRecipes.find((item) => item.id === id);
  if (!recipe) throw new Error(`Unknown PCF recipe: ${id}`);
  if (recipe.status === 'planned') throw new Error(`Recipe ${id} is planned, not available in this release.`);
  return targetFromRecipe(recipe, allTemplates);
}

function targetFromTemplate(template) {
  if (!template) return null;
  return {
    id: template.id,
    kind: 'template',
    template: template.id,
    dependencySet: template.dependencySet || template.controlType,
    hosts: [...template.hosts],
  };
}

function targetFromRecipe(recipe, allTemplates) {
  if (!recipe) return null;
  const template = allTemplates.find((item) => item.id === recipe.template);
  if (!template) throw new Error(`Recipe ${recipe.id} references unknown template ${recipe.template}.`);
  return {
    id: recipe.id,
    kind: 'recipe',
    recipe: recipe.id,
    template: recipe.template,
    dependencySet: template.dependencySet || template.controlType,
    hosts: [...recipe.hosts],
  };
}

function runTarget(target, projectDir, options, deps) {
  const plan = (deps.planScaffold || planScaffold)({
    template: target.template,
    recipe: target.recipe,
    namespace: 'Contoso.PcfCi',
    name: controlName(target.id),
    displayName: displayName(target.id),
    description: `${displayName(target.id)} PCF CI smoke control.`,
    hosts: target.hosts,
  }, deps);
  (deps.writeScaffold || writeScaffold)(plan, projectDir, deps);

  // Install per scaffold instead of sharing a dependency-set install cache: pcf-gates resolves
  // pcf-scripts and Jest from the project-local node_modules, and the package smoke lets MSBuild
  // restore the referenced PCF project in place. Reusing one install would need link/copy logic
  // across Windows and Linux that is more fragile than the registry work this workflow isolates.
  const npmResult = (deps.runNpm || runNpm)(['ci'], { cwd: projectDir, npmCli: options.npmCli });
  if (!succeeded(npmResult)) {
    return failure(`npm ci failed: ${toolDetail(npmResult)}`, { gates: [] });
  }

  let latest = [];
  if (options.latest) {
    latest = probeLatestDependencies(target, projectDir, options, deps);
  }

  if (options.package) {
    ensurePackageBuildScript(projectDir, deps);
    const packaged = (deps.runPackageSmoke || runPackageSmoke)(target, projectDir, { ...options, latest }, deps);
    return { ok: Boolean(packaged.ok), gates: [], extra: { latest, package: packaged } };
  }

  const gates = runGates(projectDir, target.hosts, deps);
  return { ok: gates.ok, gates: gates.gates, extra: { latest } };
}

function probeLatestDependencies(target, projectDir, options, deps) {
  const matrix = (deps.loadMatrix || loadMatrix)(deps);
  const set = (deps.dependencySet || dependencySet)(matrix, target.dependencySet, deps);
  const names = [...Object.keys(set.dependencies || {}).sort(), ...Object.keys(set.devDependencies || {}).sort()];
  const packages = { ...set.dependencies, ...set.devDependencies };
  const specs = names.map((name) => `${name}@latest`);
  if (specs.length) {
    const installed = (deps.runNpm || runNpm)(['install', ...specs], { cwd: projectDir, npmCli: options.npmCli });
    if (!succeeded(installed)) throw new Error(`npm install latest failed: ${toolDetail(installed)}`);
  }
  return names.map((name) => ({
    name,
    matrixVersion: String(packages[name]).replace(/^[~^]/, ''),
    resolvedVersion: readPackageVersion(projectDir, name, deps) || null,
  }));
}

function runGates(projectDir, hosts, deps = {}) {
  const runner = deps.runGates;
  const result = runner
    ? runner(projectDir, hosts)
    : runNodeScript(path.join(SCRIPT_DIR, 'pcf-gates.js'), ['--project', projectDir, '--hosts', hosts.join(',')], { cwd: path.join(SCRIPT_DIR, '..') });
  const parsed = parseJsonLine(result.stdout);
  return {
    ok: succeeded(result) && (!parsed || parsed.ok !== false),
    gates: parsed && Array.isArray(parsed.gates) ? parsed.gates : [],
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function runPackageSmoke(target, projectDir, options = {}, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const runNode = deps.runNodeScript || runNodeScript;
  const runCommand = deps.spawnSync || spawnSync;
  const solutionDir = pathDep.join(projectDir, '_solution');
  const checks = [];
  setManifestVersion(projectDir, PACKAGE_VERSION, deps);

  const devBuild = runPcfBuild(projectDir, 'development', { ...deps, runNodeScript: runNode });
  if (!devBuild.ok) return { ok: false, error: `development build failed: ${devBuild.error || toolDetail(devBuild)}`, checks };
  const prodBuild = runPcfBuild(projectDir, 'production', { ...deps, runNodeScript: runNode });
  if (!prodBuild.ok) return { ok: false, error: `production build failed: ${prodBuild.error || toolDetail(prodBuild)}`, checks };

  const pacInit = runCommand('pac', ['solution', 'init', '--publisher-name', 'Contoso', '--publisher-prefix', 'contoso'], {
    cwd: ensureDir(solutionDir, fsDep),
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (!succeeded(pacInit)) return { ok: false, error: `pac solution init failed: ${toolDetail(pacInit)}`, checks };
  setSolutionVersion(solutionDir, PACKAGE_VERSION, deps);

  const pacAdd = runCommand('pac', ['solution', 'add-reference', '--path', projectDir], {
    cwd: solutionDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (!succeeded(pacAdd)) return { ok: false, error: `pac solution add-reference failed: ${toolDetail(pacAdd)}`, checks };

  const build = runCommand('dotnet', ['build', '-c', 'Release', '-p:SolutionPackageType=Managed'], {
    cwd: solutionDir,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (!succeeded(build)) return { ok: false, error: `dotnet build failed: ${toolDetail(build)}`, checks };

  const zip = newestZip(pathDep.join(solutionDir, 'bin', 'Release'), deps);
  if (!zip) return { ok: false, error: 'dotnet build did not produce a managed solution ZIP.', checks };
  const inspected = inspectSolutionZip(zip, PACKAGE_VERSION, {
    productionBytes: bundleBytes(prodBuild),
    developmentBytes: bundleBytes(devBuild),
  }, deps);
  return { ok: inspected.ok, zip, checks: inspected.checks };
}

function runPcfBuild(projectDir, mode, deps) {
  if (deps.runPcfBuild) return deps.runPcfBuild(projectDir, mode);
  return buildControl({ projectDir, mode, clean: true }, deps);
}

function inspectSolutionZip(zipPath, manifestVersion, sizes = {}, deps = {}) {
  const entries = readZipEntries(zipPath, deps);
  const solutionXml = textEntry(entries, /(^|\/)solution\.xml$/i);
  const customizationsXml = textEntry(entries, /(^|\/)customizations\.xml$/i);
  const manifestXml = textEntry(entries, /ControlManifest\.xml$/i);
  const checks = [
    { id: 'managed', ok: /<Managed>1<\/Managed>/.test(solutionXml), detail: 'solution.xml Managed=1' },
    { id: 'root-component-66', ok: /<RootComponent\b[^>]*type="66"/i.test(solutionXml), detail: 'solution.xml RootComponent type 66' },
    { id: 'custom-controls', ok: /<CustomControls\b/i.test(customizationsXml), detail: 'customizations.xml CustomControls' },
    { id: 'manifest-version', ok: new RegExp(`\\bversion=["']${escapeRegExp(manifestVersion)}["']`).test(manifestXml), detail: 'embedded ControlManifest.xml version' },
    { id: 'production-bundle-smaller', ok: Number(sizes.productionBytes) > 0 && Number(sizes.developmentBytes) > 0 && Number(sizes.productionBytes) < Number(sizes.developmentBytes), detail: 'production bundle smaller than development bundle' },
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

function readZipEntries(zipPath, deps = {}) {
  const fsDep = deps.fs || fs;
  const buffer = fsDep.readFileSync(zipPath);
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory header.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = zlib.inflateRawSync(compressed);
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    if (content.length !== uncompressedSize) throw new Error(`ZIP entry ${name} size mismatch.`);
    entries.set(name.replace(/\\/g, '/'), content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('ZIP end-of-central-directory record not found.');
}

function textEntry(entries, pattern) {
  for (const [name, content] of entries) {
    if (pattern.test(name)) return content.toString('utf8');
  }
  return '';
}

function setManifestVersion(projectDir, version, deps = {}) {
  const fsDep = deps.fs || fs;
  const manifest = walkFiles(projectDir, deps).find((file) => path.basename(file) === 'ControlManifest.Input.xml');
  if (!manifest) throw new Error('Cannot set package-smoke manifest version because ControlManifest.Input.xml was not found.');
  const text = fsDep.readFileSync(manifest, 'utf8');
  fsDep.writeFileSync(manifest, text.replace(/(<control\b[^>]*\bversion=)(["']).*?\2/i, `$1$2${version}$2`));
}

function ensurePackageBuildScript(projectDir, deps = {}) {
  const fsDep = deps.fs || fs;
  const file = path.join(projectDir, 'package.json');
  const pkg = JSON.parse(fsDep.readFileSync(file, 'utf8'));
  pkg.scripts = { ...(pkg.scripts || {}) };
  // The Microsoft.PowerApps.MSBuild.Pcf target invokes `npm run build -- ...` internally when a
  // PCF project is referenced by a solution project. This script is created only in the throwaway
  // CI scaffold so MSBuild can call its documented target; this tool still invokes npm packages
  // directly through `process.execPath <bin.js>` for every command it owns.
  pkg.scripts.build = 'node node_modules/pcf-scripts/bin/pcf-scripts.js build';
  fsDep.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

function setSolutionVersion(solutionDir, version, deps = {}) {
  const fsDep = deps.fs || fs;
  const solutionXml = path.join(solutionDir, 'Other', 'Solution.xml');
  if (!fsDep.existsSync(solutionXml)) return;
  const text = fsDep.readFileSync(solutionXml, 'utf8');
  fsDep.writeFileSync(solutionXml, text.replace(/<Version>.*?<\/Version>/i, `<Version>${version}</Version>`));
}

function bundleBytes(result) {
  return ((result && result.controls) || []).reduce((sum, control) => sum + Number(control.bundleBytes || 0), 0);
}

function newestZip(dir, deps = {}) {
  const fsDep = deps.fs || fs;
  const files = walkFiles(dir, deps).filter((file) => file.toLowerCase().endsWith('.zip'));
  files.sort((a, b) => fsDep.statSync(b).mtimeMs - fsDep.statSync(a).mtimeMs);
  return files[0] || null;
}

function walkFiles(dir, deps = {}) {
  const fsDep = deps.fs || fs;
  const files = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fsDep.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  return files;
}

function readPackageVersion(projectDir, pkgName, deps = {}) {
  const fsDep = deps.fs || fs;
  const file = path.join(projectDir, 'node_modules', ...String(pkgName).split('/'), 'package.json');
  try {
    return JSON.parse(fsDep.readFileSync(file, 'utf8')).version;
  } catch {
    return null;
  }
}

function ensureDir(dir, fsDep) {
  fsDep.mkdirSync(dir, { recursive: true });
  return dir;
}

function controlName(id) {
  return String(id).split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join('') || 'Control';
}

function displayName(id) {
  return controlName(id).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function succeeded(result) {
  return result && (result.status === 0 || result.status === undefined || result.status === null) && !result.error;
}

function failure(error, extra = {}) {
  return { ok: false, error, extra: { ...extra, error } };
}

function parseJsonLine(text) {
  const line = String(text || '').split(/\r?\n/).find((item) => item.trim().startsWith('{'));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function toolDetail(result) {
  if (result && result.error) return String(result.error.message || result.error);
  return [result && result.stderr, result && result.stdout].filter(Boolean).join('\n').trim() || 'tool exited with a non-zero status';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: KNOWN,
    needValue: NEED_VALUE,
    hints: {
      template: 'template id, for example field-standard',
      recipe: 'recipe id, for example star-rating',
      'npm-cli': 'path to npm-cli.js',
    },
  });
  if (flagError) usageError(flagError);
  const flags = parsed.flags;
  const selectors = [Boolean(flags.all), Boolean(flags.template), Boolean(flags.recipe), Boolean(flags.package)].filter(Boolean).length;
  if (selectors !== 1) usageError('Choose exactly one of --all, --template <id>, --recipe <id>, or --package.');
  const result = runCiBuild({
    all: Boolean(flags.all),
    template: flags.template ? String(flags.template) : undefined,
    recipe: flags.recipe ? String(flags.recipe) : undefined,
    latest: Boolean(flags.latest),
    keep: Boolean(flags.keep),
    package: Boolean(flags.package),
    npmCli: flags['npm-cli'] ? String(flags['npm-cli']) : undefined,
  });
  emitResult(result.ok, result);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    emitResult(false, { ok: false, error: String(err && err.message ? err.message : err), results: [], skipped: [] });
  }
}

module.exports = {
  main,
  runCiBuild,
  selectTargets,
  packageSmokeTargets,
  inspectSolutionZip,
  readZipEntries,
};
