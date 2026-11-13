#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCliSync, CliLaunchError } = require('./lib/process-runner');
const { withNpmContext } = require('./lib/npm-context');
const {
  selectRelease,
  selectProjectRelease,
  resolveProjectRelease,
  summarizeRelease,
  exactVersion,
} = require('./lib/mobile-release');

const HOST = '@microsoft/power-apps-native-host';
const TEMPLATE = '@microsoft/power-apps-native-template';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Cannot read valid ${path.basename(file)}; restore it before continuing`);
  }
}

function compareVersions(left, right) {
  if (!exactVersion(left, true) || !exactVersion(right, true)) {
    throw new Error('Only exact stable package versions can be compared');
  }
  const a = left.split('+', 1)[0].split('.').map(BigInt);
  const b = right.split('+', 1)[0].split('.').map(BigInt);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function assertMajorTransition(source, target) {
  const changed = ['android', 'ios'].some((platform) => (
    source.nativeRuntimeVersions[platform] !== target.nativeRuntimeVersions[platform]
    || source.platforms?.[platform]?.fingerprint !== target.platforms?.[platform]?.fingerprint
  )) || ['expo', 'react-native'].some((name) => (
    source.nativePackages[`node_modules/${name}`] !== target.nativePackages[`node_modules/${name}`]
  ));
  if (changed && (Number(target.nativePackages[`node_modules/${HOST}`].split('.')[0])
    <= Number(source.nativePackages[`node_modules/${HOST}`].split('.')[0])
    || Number(target.template.version.split('.')[0]) <= Number(source.template.version.split('.')[0]))) {
    throw new Error('A native runtime transition requires a new host and template package major release; counters alone do not authorize an ABI change');
  }
}

function planUpdate(projectRoot, releaseId, catalog) {
  if (catalog === undefined) return require('./lib/mobile-published-packages').planPublishedUpdate(projectRoot, releaseId);
  const source = selectProjectRelease(projectRoot, catalog);
  const target = selectRelease(releaseId, catalog);
  const installedHost = readJson(path.join(projectRoot, 'node_modules', HOST, 'package.json')).version;
  const targetHost = target.nativePackages[`node_modules/${HOST}`];
  if (target.templateVersion < source.templateVersion
    || compareVersions(source.template.version, target.template.version) > 0
    || compareVersions(source.nativePackages[`node_modules/${HOST}`], targetHost) > 0
    || ['android', 'ios'].some((platform) => (
      target.nativeRuntimeVersions[platform] < source.nativeRuntimeVersions[platform]
    )) || compareVersions(installedHost, targetHost) > 0) {
    throw new Error('Selected release would downgrade the app; choose a supported forward release');
  }

  const migrationRequired = target.templateVersion > source.templateVersion;
  if (!migrationRequired && ['android', 'ios'].some((platform) => (
    target.nativeRuntimeVersions[platform] !== source.nativeRuntimeVersions[platform]
    || target.platforms[platform].fingerprint !== source.platforms[platform].fingerprint
  ))) {
    throw new Error('Runtime or fingerprint changes require a published template migration, not metadata edits');
  }
  assertMajorTransition(source, target);
  let kind = migrationRequired ? 'template-upgrade' : 'host-repair';
  if (!migrationRequired && installedHost === targetHost) {
    // Equality is supported, but is not proof the rest of the app is undrifted.
    const resolved = resolveProjectRelease(projectRoot, catalog);
    if (resolved.id !== target.id) throw new Error('Installed app does not match the selected release');
    kind = 'current';
  }
  return {
    kind,
    installedHostVersion: installedHost,
    source: summarizeRelease(source),
    target: summarizeRelease(target),
    hostInstallRequired: installedHost !== targetHost,
    migrationRequired,
    fullChainPreviewRequired: migrationRequired,
  };
}

function assertEmptyDestination(destination) {
  const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(destination).length)) {
    throw new Error('Creation requires a new or empty real directory; existing apps are never overwritten');
  }
}

function run(command, args, cwd, { env = process.env, failureMessage } = {}) {
  const isNpm = command === 'npm';
  const configuredTimeoutMs = Number.parseInt(process.env.MOBILE_TEMPLATE_NPM_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : 10 * 60 * 1000;
  try {
    return runCliSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...env, npm_config_ignore_scripts: 'true' },
    });
  } catch (error) {
    if (!(error instanceof CliLaunchError) && !(Number.isInteger(error.status) && error.status > 0)) throw error;
    throw new Error(failureMessage || `${isNpm ? 'Template package installation' : 'Template CLI'} failed; check registry access, slow network conditions, package support locally, or increase MOBILE_TEMPLATE_NPM_TIMEOUT_MS if the command is timing out (raw output withheld)`);
  }
}

function assertTemplateManifest(manifest, release) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schemaVersion !== 1
    || manifest.templatePackage?.name !== TEMPLATE
    || manifest.templatePackage?.version !== release.template.version
    || manifest.templateVersion !== release.templateVersion
    || ['android', 'ios'].some((platform) => (
      manifest.nativeRuntimeVersions?.[platform] !== release.nativeRuntimeVersions[platform]
    ))) {
    throw new Error('Packaged template manifest does not match the reviewed release');
  }
}

function assertSelfContainedTemplate(installed, lock, packageRoot) {
  if (['dependencies', 'optionalDependencies', 'peerDependencies'].some(section => (
    Object.keys(installed[section] || {}).length > 0
  )) || installed.bundleDependencies === true || installed.bundledDependencies === true
    || installed.bundleDependencies?.length || installed.bundledDependencies?.length
    || Object.keys(lock.packages || {}).some(name => name && name !== `node_modules/${TEMPLATE}`)
    || fs.existsSync(path.join(packageRoot, 'node_modules'))) {
    throw new Error('Template creation requires a self-contained CLI with no acquired or bundled dependencies.');
  }
  const modules = path.dirname(path.dirname(packageRoot));
  if (fs.readdirSync(modules).some(name => !['.bin', '.package-lock.json', '@microsoft'].includes(name))
    || fs.readdirSync(path.join(modules, '@microsoft')).some(name => name !== 'power-apps-native-template')) {
    throw new Error('The template tooling installation contains unexpected packages; no creation CLI was executed.');
  }
}

function inspectDestination(destination) {
  const target = path.resolve(destination);
  assertEmptyDestination(target);
  let parent = path.dirname(target);
  while (!fs.lstatSync(parent, { throwIfNoEntry: false })) parent = path.dirname(parent);
  if (!fs.statSync(parent).isDirectory()) throw new Error('Creation requires an existing directory ancestor.');
  const canonicalParent = fs.realpathSync.native(parent);
  const resolved = path.resolve(canonicalParent, path.relative(parent, target));
  assertEmptyDestination(resolved);
  return { parent: canonicalParent, destination: resolved, exists: fs.existsSync(resolved) };
}

function acquireTemplate(destination, releaseId, options = {}) {
  const release = options.catalog ? selectRelease(releaseId, options.catalog)
    : require('./lib/mobile-published-packages').selectTemplateContract(releaseId, options);
  const target = path.resolve(destination);
  assertEmptyDestination(target);
  const execute = options.run || run;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-template-package-'));
  fs.chmodSync(staging, 0o700);
  try {
    fs.writeFileSync(path.join(staging, 'package.json'), '{"name":"template-acquisition","private":true}\n');
    withNpmContext(options.cwd || process.cwd(), staging, (env, cwd) => execute('npm', [
      'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
      `${TEMPLATE}@${release.template.version}`, '--prefix', staging,
    ], cwd, { env }));
    const packageRoot = path.join(staging, 'node_modules', TEMPLATE);
    if (!fs.lstatSync(packageRoot).isDirectory() || fs.lstatSync(packageRoot).isSymbolicLink()) {
      throw new Error('Template must be an installed registry package, not a symbolic link');
    }
    const installed = readJson(path.join(packageRoot, 'package.json'));
    const lock = readJson(path.join(staging, 'package-lock.json'));
    const locked = lock.packages?.[`node_modules/${TEMPLATE}`];
    if (installed.name !== TEMPLATE || installed.version !== release.template.version
      || locked?.version !== release.template.version || locked?.integrity !== release.template.integrity) {
      throw new Error('Installed template version/integrity does not match the reviewed release');
    }
    assertSelfContainedTemplate(installed, lock, packageRoot);
    const bin = installed.bin?.['create-power-app-native'];
    if (typeof bin !== 'string' || path.isAbsolute(bin) || bin.split(/[\\/]/).includes('..')) {
      throw new Error('Template package does not expose the supported creation CLI');
    }
    const executable = path.join(packageRoot, bin);
    const relative = path.relative(fs.realpathSync(packageRoot), fs.realpathSync(executable));
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.lstatSync(executable).isFile()) {
      throw new Error('Template CLI must be a regular file inside its package');
    }
    let manifest;
    try {
      manifest = JSON.parse(execute(process.execPath, [executable, '--manifest'], staging));
    } catch {
      throw new Error('Template CLI inspection failed or returned an unsupported manifest');
    }
    assertTemplateManifest(manifest, release);
    assertEmptyDestination(target);
    execute(process.execPath, [executable, target], staging);
    const created = readJson(path.join(target, 'app.json')).expo?.extra?.powerappsNative;
    assertTemplateManifest({ ...created, templatePackage: manifest.templatePackage }, release);
    return { release: summarizeRelease(release), installedDependencies: false };
  } finally {
    // This is only the unique temporary package install, never the customer's target.
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function acquireHost(destination, version, options = {}) {
  const target = path.resolve(destination);
  assertEmptyDestination(target);
  const published = require('./lib/mobile-published-packages');
  const source = published.createSource(options);
  const contract = published.selectPublishedContract(version, {
    ...options, readPackage: source.read, versions: source.versions,
  });
  const profile = source.read(HOST, version).profile;
  const execute = options.run || run;
  assertEmptyDestination(target);
  fs.mkdirSync(target, { recursive: true });
  withNpmContext(options.cwd || process.cwd(), target, (env, cwd) => {
    fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({
      name: 'mobile-upgrade-tooling', private: true,
      ...contract.managedDependencies,
      dependencies: { ...contract.managedDependencies.dependencies, [HOST]: version },
      ...(profile.managedOverrides ? { overrides: profile.managedOverrides } : {}),
    }, null, 2)}\n`, { flag: 'wx' });
    return execute('npm', [
      'install', '--ignore-scripts', '--strict-peer-deps', '--no-legacy-peer-deps', '--no-force', '--no-audit', '--no-fund',
      '--prefix', target,
    ], cwd, { env });
  });
  const hostRoot = path.join(target, 'node_modules', HOST);
  const installed = readJson(path.join(hostRoot, 'package.json'));
  const locked = readJson(path.join(target, 'package-lock.json')).packages?.[`node_modules/${HOST}`];
  if (installed.name !== HOST || installed.version !== version || locked?.version !== version
    || locked.integrity !== contract.host.integrity || locked.link
    || !fs.lstatSync(hostRoot).isDirectory() || fs.lstatSync(hostRoot).isSymbolicLink()) {
    throw new Error('The tooling installation does not match the selected published host integrity');
  }
  const executable = installed.bin?.['upgrade-template'];
  if (typeof executable !== 'string' || path.isAbsolute(executable) || executable.split(/[\\/]/).includes('..')) {
    throw new Error('The published host does not expose a contained upgrade-template CLI');
  }
  const relative = path.relative(fs.realpathSync(hostRoot), fs.realpathSync(path.join(hostRoot, executable)));
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.lstatSync(path.join(hostRoot, executable)).isFile()) {
    throw new Error('The upgrade CLI must be a regular file inside the published host package');
  }
  return {
    target: summarizeRelease(contract), installedDependencies: true, lifecycleScriptsExecuted: false,
    upgradeCli: `node_modules/${HOST}/${executable.replaceAll('\\', '/')}`,
  };
}

function restorePreviewDependencies(projectRoot, previewRoot, options = {}) {
  const source = fs.realpathSync.native(path.resolve(projectRoot));
  const preview = fs.realpathSync.native(path.resolve(previewRoot));
  const related = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  if (related(source, preview) || related(preview, source)) {
    throw new Error('Source and preview must be separate, non-nested directories; source dependencies cannot be restored during preview.');
  }
  const modules = path.join(preview, 'node_modules');
  if (fs.lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('Preview node_modules must not be a symbolic link.');
  }
  const snapshots = new Map();
  for (const name of ['package.json', 'package-lock.json', 'app.json', '.npmrc']) {
    const sourcePath = path.join(source, name);
    const previewPath = path.join(preview, name);
    if (name === '.npmrc' && !fs.existsSync(sourcePath) && !fs.existsSync(previewPath)) continue;
    for (const file of [sourcePath, previewPath]) {
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
        throw new Error('Source and preview inputs must be regular files.');
      }
    }
    const original = fs.readFileSync(sourcePath);
    if (!original.equals(fs.readFileSync(previewPath))) {
      throw new Error(`Preview ${name} differs from the source; create and review a fresh snapshot.`);
    }
    snapshots.set(name, original);
  }
  const manifest = readJson(path.join(source, 'package.json'));
  const lock = readJson(path.join(source, 'package-lock.json'));
  if (manifest.workspaces || fs.existsSync(path.join(source, 'npm-shrinkwrap.json'))
    || (manifest.packageManager && !manifest.packageManager.startsWith('npm@'))
    || ![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) {
    throw new Error('Preview dependency restore requires a standalone npm package-lock project.');
  }
  const execute = options.run || run;
  try {
    withNpmContext(source, preview, (env, cwd) => execute('npm', [
      'ci', '--ignore-scripts', '--no-legacy-peer-deps', '--no-force', '--no-audit', '--no-fund',
      '--prefix', preview,
    ], cwd, { env }));
  } finally {
    for (const [name, content] of snapshots) {
      if (!content.equals(fs.readFileSync(path.join(source, name)))
        || !content.equals(fs.readFileSync(path.join(preview, name)))) {
        throw new Error(`Preview dependency restore changed ${name}; preserve the snapshot and investigate before continuing.`);
      }
    }
  }
  return { previewRoot: preview, installedDependencies: true, sourceModified: false, lifecycleScriptsExecuted: false };
}

function checkSdk(projectRoot, options = {}) {
  const root = fs.realpathSync.native(path.resolve(projectRoot));
  const expoRoot = fs.realpathSync.native(path.join(root, 'node_modules/expo'));
  const expo = readJson(path.join(expoRoot, 'package.json'));
  const bin = typeof expo.bin === 'string' ? expo.bin : expo.bin?.expo;
  if (expo.name !== 'expo' || typeof bin !== 'string' || !bin || path.isAbsolute(bin)) {
    throw new Error('SDK validation requires the project\'s installed Expo CLI; automatic acquisition is not allowed.');
  }
  const cli = fs.realpathSync.native(path.resolve(expoRoot, bin));
  const relative = path.relative(expoRoot, cli);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
    || !fs.statSync(cli).isFile()) {
    throw new Error('The installed Expo CLI must be contained in its package.');
  }
  const output = (options.run || run)(process.execPath, [cli, 'install', '--check'], root, {
    env: { ...process.env, EXPO_OFFLINE: '1' },
    failureMessage: 'Installed Expo SDK validation failed. Preserve the release pins and investigate the local compatibility mismatch; do not install newer online recommendations (raw output withheld).',
  });
  return { projectRoot: root, expoVersion: expo.version, versionSource: 'installed-expo', output: output.trim() };
}

function main(argv) {
  const [action, ...args] = argv;
  const values = {};
  const allowed = action === 'check-sdk' ? ['--project-root']
    : action === 'restore-preview' ? ['--project-root', '--preview-root']
    : action === 'destination' ? ['--destination'] : action === 'acquire'
    ? ['--destination', '--release', '--host-version', '--template-version']
    : ['--project-root', '--release', '--host-version'];
  if (!['acquire', 'plan', 'destination', 'restore-preview', 'check-sdk'].includes(action)) throw new Error('Use acquire, plan, destination, restore-preview or check-sdk with explicit arguments; the published host CLI owns migration writes');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!allowed.includes(key) || values[key] !== undefined || !args[index + 1]
      || args[index + 1].startsWith('--')) throw new Error('Unknown, duplicate, or missing lifecycle argument');
    values[key] = args[index + 1];
  }
  if (action === 'check-sdk') {
    if (!values['--project-root']) throw new Error('Required: --project-root for installed SDK validation.');
    return checkSdk(values['--project-root']);
  }
  if (action === 'restore-preview') {
    if (!values['--project-root'] || !values['--preview-root']) {
      throw new Error('Required: --project-root and --preview-root for an approved isolated snapshot.');
    }
    return restorePreviewDependencies(values['--project-root'], values['--preview-root']);
  }
  if (action === 'destination') {
    if (!values['--destination']) throw new Error('Required: --destination for read-only creation inspection');
    return inspectDestination(values['--destination']);
  }
  if (!values[allowed[0]] || ['--release', '--host-version', '--template-version']
    .filter((key) => values[key]).length !== 1) {
    throw new Error(`Required: ${allowed[0]} and one exact host/template version`);
  }
  if (action === 'plan') return planUpdate(path.resolve(values['--project-root']), values['--host-version'] || values['--release']);
  return values['--host-version']
    ? acquireHost(values['--destination'], values['--host-version'])
    : acquireTemplate(values['--destination'], values['--template-version'] || values['--release']);
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { acquireTemplate, acquireHost, assertEmptyDestination, assertTemplateManifest, assertMajorTransition, checkSdk, compareVersions, inspectDestination, main, planUpdate, restorePreviewDependencies };
