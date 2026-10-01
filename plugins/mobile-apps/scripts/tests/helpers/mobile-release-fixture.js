'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '../../..');
const HOST = '@microsoft/power-apps-native-host';

// Synthetic test records only. They are never inserted into the bundled policy
// and do not assert publication, compatibility, or real-device verification.
function fixtureRelease(number = 1) {
  const version = `${number}.0.0`;
  const dependencies = { [HOST]: `^${version}`, expo: version, 'react-native': version, react: version, 'expo-haptics': version };
  const target = (platform) => ({
    fingerprint: `fixture-${platform}-${number}`,
    base: { version: `fixture-base-${number}`, evidence: `https://example.com/fixture/${number}/${platform}/base` },
    player: { version: `fixture-player-${number}`, evidence: `https://example.com/fixture/${number}/${platform}/player` },
  });
  return {
    id: `fixture-release-${number}`,
    template: {
      package: '@microsoft/power-apps-native-template',
      version,
      integrity: `sha512-${Buffer.alloc(64, number).toString('base64')}`,
    },
    templateVersion: number,
    nativeRuntimeVersions: { android: number, ios: number },
    managedDependencies: { dependencies },
    nativePackages: Object.fromEntries(Object.keys(dependencies).map((name) => [`node_modules/${name}`, version])),
    platforms: { android: target('android'), ios: target('ios') },
    evidence: [`https://example.com/fixture/${number}/publication`, `https://example.com/fixture/${number}/device-validation`],
  };
}

function makeRelease(overrides = {}) {
  function merge(target, source) {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value)
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        merge(target[key], value);
      } else {
        target[key] = structuredClone(value);
      }
    }
    return target;
  }
  return merge(fixtureRelease(), overrides);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function modifyJson(filePath, change) {
  const value = readJson(filePath);
  change(value);
  writeJson(filePath, value);
}

function installPackage(projectRoot, installPath, version, properties = {}) {
  const name = installPath.split('/node_modules/').pop().replace(/^node_modules\//, '');
  writeJson(path.join(projectRoot, installPath, 'package.json'), { name, version, ...properties });
}

function addDependency(projectRoot, name, version, { section = 'dependencies', properties = {}, installPath = `node_modules/${name}` } = {}) {
  if (section) modifyJson(path.join(projectRoot, 'package.json'), (pkg) => {
    pkg[section] ||= {};
    pkg[section][name] = version;
  });
  modifyJson(path.join(projectRoot, 'package-lock.json'), (lock) => {
    if (section) {
      lock.packages[''][section] ||= {};
      lock.packages[''][section][name] = version;
    }
    lock.packages[installPath] = { version };
  });
  installPackage(projectRoot, installPath, version, properties);
}

function writeProject(projectRoot, release) {
  writeJson(path.join(projectRoot, 'app.json'), {
    expo: { extra: {
      powerappsNative: { schemaVersion: 1, templateVersion: release.templateVersion, nativeRuntimeVersions: release.nativeRuntimeVersions },
      appInsightsConfig: { connectionString: 'fixture-secret-do-not-echo' },
    } },
  });
  const manifest = { name: 'fixture-mobile-app', version: '1.0.0', ...release.managedDependencies };
  writeJson(path.join(projectRoot, 'package.json'), manifest);
  const packages = { '': manifest };
  for (const [installPath, version] of Object.entries(release.nativePackages)) {
    packages[installPath] = { version };
    installPackage(projectRoot, installPath, version);
  }
  for (const section of Object.values(release.managedDependencies)) {
    for (const [name, spec] of Object.entries(section)) {
      const installPath = `node_modules/${name}`;
      if (packages[installPath]) continue;
      const version = /^\d+\.\d+\.\d+$/.test(spec) ? spec : '1.0.0';
      packages[installPath] = { version };
      installPackage(projectRoot, installPath, version);
    }
  }
  writeJson(path.join(projectRoot, 'package-lock.json'), { name: manifest.name, lockfileVersion: 3, packages });
  return projectRoot;
}

function createFixture(t, { release = fixtureRelease(), catalog = { schemaVersion: 1, defaultRelease: release.id, releases: [release] } } = {}) {
  const directory = path.resolve(__dirname, '..', `.release-fixture-${randomUUID()}`);
  const pluginRoot = path.join(directory, 'plugin');
  const projectRoot = path.join(directory, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of [
    'scripts/lib/mobile-release.js', 'scripts/resolve-mobile-release.js',
    'scripts/validate-mobile-files.js', 'scripts/lib/mobile-validator-manifest.js',
    'hooks/validate-package-deps.js', 'hooks/validate-write-safety.js', 'hooks/validate-protected-paths.js',
  ]) {
    const target = path.join(pluginRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(PLUGIN_ROOT, file), target);
  }
  writeJson(path.join(pluginRoot, 'shared/mobile-releases.json'), catalog);
  writeProject(projectRoot, release);
  return { directory, pluginRoot, projectRoot, release, catalog };
}

function runCli(fixture, args) {
  return spawnSync(process.execPath, [path.join(fixture.pluginRoot, 'scripts/resolve-mobile-release.js'), ...args], {
    cwd: fixture.projectRoot, encoding: 'utf8',
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
  });
}

function runValidator(fixture, { approved = [], explicit = true, tool = 'Write', input = {} } = {}) {
  const filePath = path.join(fixture.projectRoot, 'package.json');
  return spawnSync(process.execPath, [path.join(fixture.pluginRoot, 'hooks/validate-package-deps.js')], {
    cwd: fixture.projectRoot, encoding: 'utf8',
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' },
    input: JSON.stringify({
      tool_name: tool,
      tool_input: {
        file_path: filePath,
        ...(explicit ? { validation_mode: 'explicit-mobile-workflow' } : {}),
        approved_js_dependencies: approved.map((entry) => {
          const separator = entry.lastIndexOf('@');
          return { name: entry.slice(0, separator), version: entry.slice(separator + 1) };
        }),
        ...input,
      },
    }),
  });
}

module.exports = {
  HOST, PLUGIN_ROOT, fixtureRelease, makeRelease, writeProject, createFixture, writeJson, readJson, modifyJson,
  installPackage, addDependency, runCli, runValidator,
};
