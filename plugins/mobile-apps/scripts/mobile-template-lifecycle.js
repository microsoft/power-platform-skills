#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  readCatalog,
  selectRelease,
  selectProjectRelease,
  resolveProjectRelease,
  summarizeRelease,
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
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!pattern.test(left) || !pattern.test(right)) {
    throw new Error('Only exact stable package versions can be compared');
  }
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return Math.sign(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

function planUpdate(projectRoot, releaseId, catalog = readCatalog()) {
  const source = selectProjectRelease(projectRoot, catalog);
  const target = selectRelease(releaseId, catalog);
  const installedHost = readJson(path.join(projectRoot, 'node_modules', HOST, 'package.json')).version;
  const targetHost = target.nativePackages[`node_modules/${HOST}`];
  if (target.templateVersion < source.templateVersion
    || ['android', 'ios'].some((platform) => (
      target.nativeRuntimeVersions[platform] < source.nativeRuntimeVersions[platform]
    )) || compareVersions(installedHost, targetHost) > 0) {
    throw new Error('Selected release would downgrade the app; choose a supported forward release');
  }

  const migrationRequired = target.templateVersion > source.templateVersion;
  if (!migrationRequired && ['android', 'ios'].some((platform) => (
    target.nativeRuntimeVersions[platform] !== source.nativeRuntimeVersions[platform]
  ))) {
    throw new Error('Runtime changes require a published template migration, not metadata edits');
  }
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

function run(command, args, cwd) {
  const isNpm = command === 'npm';
  const result = spawnSync(isNpm && process.platform === 'win32' ? 'npm.cmd' : command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    // Only fixed npm options and a validated package@version reach cmd.exe.
    shell: isNpm && process.platform === 'win32',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${isNpm ? 'Template package installation' : 'Template CLI'} failed; check registry access or package support locally (raw output withheld)`);
  }
  return result.stdout;
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

function acquireTemplate(destination, releaseId, options = {}) {
  const release = selectRelease(releaseId, options.catalog || readCatalog());
  const target = path.resolve(destination);
  assertEmptyDestination(target);
  const execute = options.run || run;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-template-package-'));
  fs.chmodSync(staging, 0o700);
  try {
    fs.writeFileSync(path.join(staging, 'package.json'), '{"name":"template-acquisition","private":true}\n');
    execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
      `${TEMPLATE}@${release.template.version}`], staging);
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

function main(argv) {
  const [action, ...args] = argv;
  const values = {};
  const allowed = action === 'acquire' ? ['--destination', '--release'] : ['--project-root', '--release'];
  if (!['acquire', 'plan'].includes(action)) throw new Error('Use acquire or plan with an explicit --release');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!allowed.includes(key) || values[key] !== undefined || !args[index + 1]
      || args[index + 1].startsWith('--')) throw new Error('Unknown, duplicate, or missing lifecycle argument');
    values[key] = args[index + 1];
  }
  if (allowed.some((key) => !values[key])) throw new Error(`Required: ${allowed.join(', ')}`);
  return action === 'acquire'
    ? acquireTemplate(values['--destination'], values['--release'])
    : planUpdate(path.resolve(values['--project-root']), values['--release']);
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { acquireTemplate, assertEmptyDestination, assertTemplateManifest, compareVersions, main, planUpdate };
