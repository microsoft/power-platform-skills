'use strict';

// Explicit local test inputs are never admitted to the published release policy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  readProject, readProjectRequirements, readPlatformContext, validateProjectAgainstRelease, exactVersion, declarationSpec, dependencySections, npmAliasTarget,
} = require('./mobile-release');

const HOST = '@microsoft/power-apps-native-host';
const TEMPLATE = '@microsoft/power-apps-native-template';
const PUSH = '@microsoft/power-apps-native-push-notifications';
const LOCAL = ['auth', 'common', 'assets', 'push-notifications', 'host'].map((name) => `@microsoft/power-apps-native-${name}`);
const PLAYER_KEY = 'com.microsoft.powerapps.devlauncher.PLAYER_COMPATIBILITY';
const PLAYER_ASSET = 'assets/powerapps-player-compatibility.json';
const OFFLINE = '@microsoft/power-apps-native-offline';
const OFFLINE_SOURCE = /@microsoft\/power-apps-native-offline|(?:\b__offlineProfile|["']__offlineProfile["'](?:\s*\])?)\s*(?::|(?:\?\?|\|\||&&)?=)/;
const PLATFORMS = ['android', 'ios'];
const SHA256 = /^[a-f0-9]{64}$/;
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;
const INSPECTION = { protocol: 'online-only-57-v1', purpose: 'upgrade-inspection-only' };
const PRIVATE_VERSION = '1.0.0-expo57-diagnostic.0';

function requireValue(condition, message) {
  if (condition) return;
  const error = new Error(message);
  error.code = 'MOBILE_RELEASE_BLOCKED';
  throw error;
}

function json(file, label = 'diagnostic artifact metadata') {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    requireValue(false, `Cannot read valid ${label}; inspect the selected local artifacts.`);
  }
}

function digest(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let size;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest(encoding);
  } finally {
    fs.closeSync(descriptor);
  }
}

function relativeFile(root, value, directory = false) {
  requireValue(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)
    && !/[\\:\u0000-\u001f]/.test(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..'),
  'Diagnostic artifacts must use contained relative paths, never URLs or parent traversal.');
  const file = path.join(root, value);
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  requireValue(!relative.startsWith('..') && !path.isAbsolute(relative)
    && (directory ? fs.lstatSync(file).isDirectory() : fs.lstatSync(file).isFile())
    && !fs.lstatSync(file).isSymbolicLink(), 'Diagnostic input must be a real contained file or directory.');
  let current = root;
  for (const part of value.split('/')) {
    current = path.join(current, part);
    requireValue(!fs.lstatSync(current).isSymbolicLink(), 'Diagnostic inputs must not traverse symbolic links.');
  }
  return file;
}

function verifyHash(file, expected, label) {
  requireValue(typeof expected === 'string' && SHA256.test(expected) && digest(file) === expected,
    `${label} hash changed or is missing. Rebuild and review a new diagnostic selection; do not refresh approval in place.`);
}

function execute(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', shell: false, timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  });
  requireValue(!result.error && result.status === 0,
    'Local artifact inspection failed. Ensure tar, unzip and aapt2 are available and the selected package CLI is supported (raw output withheld).');
  return result.stdout;
}

function unpack(archive, destination, run) {
  // Keep tar's archive and extraction in one cwd, without drive letters or cross-drive -C.
  const archiveName = 'artifact.tgz';
  const stagedArchive = path.join(destination, archiveName);
  fs.copyFileSync(archive, stagedArchive, fs.constants.COPYFILE_EXCL);
  try {
    const names = run('tar', ['-tzf', archiveName], destination).trim().split(/\r?\n/);
    const types = run('tar', ['-tvzf', archiveName], destination).trim().split(/\r?\n/);
    requireValue(names.length > 0 && names.length === types.length
      && types.every((line) => /^[-d]/.test(line))
      && new Set(names).size === names.length
      && names.every((name) => /^package(?:\/|$)/.test(name)
        && !/[\\:\u0000-\u001f]/.test(name) && name.split('/').every((part) => part !== '..' && part !== '.')),
    'Packed artifacts must contain only regular package files and directories; links and unsafe archive paths are rejected.');
    run('tar', ['-xzf', archiveName], destination);
    return path.join(destination, 'package');
  } finally {
    fs.unlinkSync(stagedArchive);
  }
}

function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every((key) => Object.hasOwn(right, key) && same(left[key], right[key]));
}

function privateDiagnosticPackage(pkg, purpose) {
  const sourceVersion = pkg.powerAppsDiagnostic?.sourceVersion;
  return pkg.private === true && pkg.version === PRIVATE_VERSION
    && exactVersion(sourceVersion) && sourceVersion.startsWith('0.')
    && same(pkg.powerAppsDiagnostic, { protocol: INSPECTION.protocol, purpose, sourceVersion });
}

function verifyInstalledPackage(packedRoot, installedRoot) {
  requireValue(fs.lstatSync(installedRoot).isDirectory() && !fs.lstatSync(installedRoot).isSymbolicLink(),
    'Installed local packages must be real directories.');
  const expected = new Set(fs.readdirSync(packedRoot));
  requireValue(fs.readdirSync(installedRoot).every((name) => name === 'node_modules' || expected.has(name)),
    'Installed local package has unselected extra files.');
  for (const entry of fs.readdirSync(packedRoot, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const packed = path.join(packedRoot, entry.name);
    const installed = path.join(installedRoot, entry.name);
    requireValue(!entry.isSymbolicLink(), 'Packed package links are not supported.');
    if (entry.isDirectory()) {
      requireValue(fs.existsSync(installed) && fs.lstatSync(installed).isDirectory()
        && !fs.lstatSync(installed).isSymbolicLink(), 'Installed local package differs from its selected archive.');
      verifyInstalledPackage(packed, installed);
    } else {
      requireValue(fs.existsSync(installed) && fs.lstatSync(installed).isFile()
        && !fs.lstatSync(installed).isSymbolicLink() && digest(packed) === digest(installed),
      'Installed local package content differs from its selected archive. Restore the immutable diagnostic install.');
    }
  }
}

function assertOnlineOnly(projectRoot) {
  const config = json(path.join(projectRoot, 'app.json'), 'app configuration');
  const extra = config.expo?.extra || {};
  requireValue(extra.__offlineProfile == null
    && !JSON.stringify(config.expo?.plugins || []).includes('@microsoft/power-apps-native-offline')
    && !fs.lstatSync(path.join(projectRoot, 'offline-profile.json'), { throwIfNoEntry: false }),
  'This diagnostic target is online-only. Offline-enabled or ambiguous offline configuration is blocked; preserve the app and wait for an offline-compatible release. Do not disable offline automatically.');
  const pkg = json(path.join(projectRoot, 'package.json'), 'app package manifest');
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides']) {
    for (const [name, spec] of Object.entries(pkg[section] || {})) {
      requireValue(npmAliasTarget(spec) !== OFFLINE
        && (name !== OFFLINE || (section === 'dependencies' && spec === '^0.1.32')),
      'Customized offline SDK declarations, aliases or overrides cannot be converted by this online-only diagnostic. Only the unused retired baseline may be removed by its reviewed migration.');
    }
  }
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      requireValue(!entry.isSymbolicLink(), 'Source links require manual review before an online-only diagnostic.');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        requireValue(!OFFLINE_SOURCE.test(fs.readFileSync(file, 'utf8')),
          'This app references the native offline package or profile. The online-only diagnostic cannot preserve that capability; no files were converted.');
      }
    }
  }
  visit(path.join(projectRoot, 'app'));
  visit(path.join(projectRoot, 'src'));
  for (const name of ['app.config.js', 'app.config.ts', 'app.config.cjs', 'app.config.mjs']) {
    const file = path.join(projectRoot, name);
    if (!fs.existsSync(file)) continue;
    requireValue(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(),
      'Dynamic app configuration must be a regular local file.');
    requireValue(!OFFLINE_SOURCE.test(fs.readFileSync(file, 'utf8')),
      'Dynamic app configuration references native offline behavior. Review it without execution; an online-only diagnostic cannot convert it.');
  }
}

function parseAndroidPlayerMetadata(output) {
  // aapt2 xmltree prints one E: meta-data node with separate A: name/value
  // lines. Match the value only within the node naming PLAYER_COMPATIBILITY.
  const nodes = output.split(/^\s*E:\s+/m);
  const matches = nodes.filter((node) => /^meta-data\b/.test(node) && node.split('\n').some((line) =>
    /^\s*A:\s+(?:android|http:\/\/schemas\.android\.com\/apk\/res\/android):name(?:\([^)]*\))?=/.test(line)
      && line.match(/="([^"]*)"/)?.[1] === PLAYER_KEY));
  requireValue(matches.length === 1, 'Selected APK does not contain unique baked player compatibility metadata.');
  const values = matches[0].split('\n').filter((line) =>
    /^\s*A:\s+(?:android|http:\/\/schemas\.android\.com\/apk\/res\/android):value(?:\([^)]*\))?=/.test(line));
  requireValue(values.length === 1, 'Selected APK player metadata requires one literal JSON value.');
  const line = values[0];
  const raw = line?.match(/\(Raw: "(.*)"\)\s*$/)?.[1]
    ?? line?.match(/="(.*)"\s*$/)?.[1];
  requireValue(raw, 'Selected APK player metadata is missing or not a literal JSON value.');
  try {
    // aapt versions differ in whether embedded JSON quotes are escaped.
    return JSON.parse(raw.startsWith('{\\') ? JSON.parse(`"${raw}"`) : raw);
  } catch {
    requireValue(false, 'Selected APK contains malformed player compatibility metadata.');
  }
}

function validatePlayer(metadata, target) {
  const currentMetadata = metadata?.schemaVersion === 2 && metadata.mode === 'diagnostic';
  const legacyMetadata = metadata?.schemaVersion === 1 && metadata.mode === undefined;
  requireValue((legacyMetadata || currentMetadata) && PLATFORMS.every((platform) => {
    const supported = metadata.supportedNativeRuntimeVersions?.[platform];
    return Array.isArray(supported) && supported.length > 0
      && supported.every((version) => Number.isSafeInteger(version) && version > 0)
      && new Set(supported).size === supported.length
      && supported.includes(metadata.recommendedNativeRuntimeVersions?.[platform]);
  }), 'Selected player has invalid supported/recommended runtime counters.');
  const recommended = metadata.recommendedTemplatePackage;
  requireValue((currentMetadata && recommended === undefined) || (recommended?.name === TEMPLATE && exactVersion(recommended.version, currentMetadata)
    && Number.isSafeInteger(recommended.templateVersion) && recommended.templateVersion > 0
    && same(recommended.nativeRuntimeVersions, metadata.recommendedNativeRuntimeVersions)
    && (!currentMetadata || (recommended.registry === 'https://registry.npmjs.org'
      && /^sha512-[A-Za-z0-9+/]{86}==$/.test(recommended.integrity || '')))),
  'Selected APK has an inconsistent recommended template/runtime contract.');
  requireValue(metadata.supportedNativeRuntimeVersions.android.includes(target.nativeRuntimeVersions.android),
    'Selected APK does not support the target Android runtime counter. Select a matching actual player; recommendations cannot authorize unsupported runtimes.');
}

function summary(selection) {
  const { target, player, manifestSha256 } = selection;
  return {
    validationScope: 'local-diagnostic-only',
    manifestSha256,
    deploymentAllowed: false,
    onlineOnly: true,
    templatePurpose: selection.inspectionOnly ? 'upgrade-inspection-only' : 'scaffold-and-upgrade',
    template: target.template,
    hostVersion: target.nativePackages[`node_modules/${HOST}`],
    templateVersion: target.templateVersion,
    nativeRuntimeVersions: target.nativeRuntimeVersions,
    managedDependencies: target.managedDependencies,
    nativePackages: target.nativePackages,
    fingerprints: target.fingerprints,
    player: {
      platform: 'android', sha256: player.sha256,
      bakedAndroidFingerprint: player.metadata.diagnostic.nativeRuntime.android.fingerprint,
      supportedNativeRuntimeVersions: Object.fromEntries(PLATFORMS.map((platform) => [
        platform, [...player.metadata.supportedNativeRuntimeVersions[platform]],
      ])),
      recommendedNativeRuntimeVersions: Object.fromEntries(PLATFORMS.map((platform) => [
        platform, player.metadata.recommendedNativeRuntimeVersions[platform],
      ])),
      recommendedTemplatePackage: player.metadata.recommendedTemplatePackage === undefined ? null : {
        name: TEMPLATE,
        version: player.metadata.recommendedTemplatePackage.version,
        templateVersion: player.metadata.recommendedTemplatePackage.templateVersion,
        nativeRuntimeVersions: Object.fromEntries(PLATFORMS.map((platform) => [
          platform, player.metadata.recommendedTemplatePackage.nativeRuntimeVersions[platform],
        ])),
      },
    },
    platformValidation: { android: 'apk-metadata-verified; device validation not implied', ios: 'not-validated' },
  };
}

function loadDiagnosticArtifacts(manifestPath, options = {}) {
  manifestPath = path.resolve(manifestPath);
  const root = path.dirname(manifestPath);
  requireValue(fs.lstatSync(manifestPath).isFile() && !fs.lstatSync(manifestPath).isSymbolicLink(),
    'Select a regular local diagnostic manifest explicitly.');
  const manifestSha256 = digest(manifestPath);
  const manifest = json(manifestPath);
  requireValue(manifest.schemaVersion === 1 && manifest.kind === 'mobile-local-diagnostic'
    && Array.isArray(manifest.packages) && [LOCAL.length, LOCAL.length + 1].includes(manifest.packages.length),
  'Unsupported diagnostic artifact contract; no production release was selected.');
  const names = manifest.packages.map((item) => item.name);
  const localPackages = LOCAL.filter((name) => name !== PUSH || names.includes(PUSH));
  requireValue(new Set(names).size === names.length && names.length === localPackages.length + 1
    && [...localPackages, TEMPLATE].every((name) => names.includes(name)),
  'Diagnostic artifacts require packed host, auth, common, assets, template and any selected push-notifications package.');
  const reference = relativeFile(root, manifest.referenceProject?.path, true);
  verifyHash(path.join(reference, 'package.json'), manifest.referenceProject.packageJsonSha256, 'Reference package');
  verifyHash(path.join(reference, 'package-lock.json'), manifest.referenceProject.packageLockSha256, 'Reference lock');
  assertOnlineOnly(reference);
  requireValue(fs.existsSync(path.join(reference, 'node_modules', HOST, 'package.json')),
    'The copied diagnostic reference is not installed. After separate approval, run npm ci inside its reference directory using the protected lock and existing registry authentication. This guard never installs dependencies.');
  const project = readProject(reference, readPlatformContext());
  const state = json(path.join(reference, '.branch-install.json'), 'protected reference installation state');
  requireValue(state.schemaVersion === 1 && state.source === 'template'
    && state.files?.['package.json'] === manifest.referenceProject.packageJsonSha256
    && state.files?.['package-lock.json'] === manifest.referenceProject.packageLockSha256,
  'Reference staging hashes do not match the immutable diagnostic selection.');
  for (const [file, hash] of Object.entries(state.files)) {
    verifyHash(relativeFile(reference, file), hash, 'Protected reference input');
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-artifact-inspection-'));
  fs.chmodSync(staging, 0o700);
  const run = options.run || execute;
  try {
    const packages = new Map();
    for (const [index, item] of manifest.packages.entries()) {
      requireValue(exactVersion(item.version) && SRI.test(item.integrity), 'Local artifacts require exact package versions and sha512 integrity.');
      const archive = relativeFile(root, item.path);
      verifyHash(archive, item.sha256, 'Packed package');
      requireValue(`sha512-${digest(archive, 'sha512', 'base64')}` === item.integrity, 'Packed package integrity mismatch.');
      const directory = path.join(staging, String(index));
      fs.mkdirSync(directory);
      const packageRoot = unpack(archive, directory, run);
      const pkg = json(path.join(packageRoot, 'package.json'), 'packed package manifest');
      requireValue(pkg.name === item.name && pkg.version === item.version, 'Packed package identity differs from the diagnostic selection.');
      packages.set(item.name, { ...item, archive, packageRoot, pkg });
      if (item.name !== TEMPLATE) {
        const installPath = `node_modules/${item.name}`;
        const locked = project.lock.packages[installPath];
        requireValue(locked?.version === item.version && locked.integrity === item.integrity
          && /^file:\.branch-packages\/[a-zA-Z0-9._-]+\.tgz$/.test(project.declarations.dependencies?.[item.name]),
        'Reference local package declaration/lock must bind the selected archive, not an unpublished registry target.');
        const declared = relativeFile(reference, project.declarations.dependencies[item.name].slice(5));
        requireValue(state.files[project.declarations.dependencies[item.name].slice(5)] === item.sha256
          && locked.resolved === project.declarations.dependencies[item.name]
          && json(path.join(reference, 'package.json')).overrides?.[item.name] === `$${item.name}`,
        'Reference lock, overrides and staging state do not identify the same local package.');
        verifyHash(declared, item.sha256, 'Reference local archive');
        verifyInstalledPackage(packageRoot, path.join(reference, installPath));
      }
    }
    const host = packages.get(HOST);
    relativeFile(host.packageRoot, host.pkg.bin?.['upgrade-template']);
    const installedHostRoot = path.join(reference, 'node_modules', HOST);
    const hostHelp = run(process.execPath, [
      relativeFile(installedHostRoot, host.pkg.bin['upgrade-template']), '--help',
    ], reference);
    requireValue(['--project', '--dry-run', '--no-install', '--diagnostic-artifacts'].every((flag) => hostHelp.includes(flag)),
      'The selected packed host does not expose the required diagnostic migration CLI. Obtain the producer implementation; do not guess flags or substitute an unflagged registry migration.');
    const profile = json(path.join(host.packageRoot, 'compatibility/current.json'), 'packed host compatibility profile');
    requireValue(profile.schemaVersion === 1 && profile.expoSdk === 57 && exactVersion(profile.expoVersion)
      && profile.expoVersion.startsWith('57.')
      && project.declarations.dependencies.expo === profile.expoVersion
      && Number.isSafeInteger(profile.targetTemplateVersion)
      && profile.targetTemplateVersion > 0 && PLATFORMS.every((platform) => (
      Number.isSafeInteger(profile.nativeRuntime?.[platform]?.version) && profile.nativeRuntime[platform].version > 0
      && SHA256.test(profile.nativeRuntime[platform].fingerprint)
    )) && Array.isArray(profile.migrations), 'Packed host compatibility profile is incomplete.');
    const template = packages.get(TEMPLATE);
    const inspectionOnly = template.version === PRIVATE_VERSION || host.version === PRIVATE_VERSION
      || template.pkg.powerAppsDiagnostic !== undefined || host.pkg.powerAppsDiagnostic !== undefined;
    if (inspectionOnly) {
      const sourceVersions = template.version.startsWith('0.') && host.version.startsWith('0.')
        && template.pkg.private === true && same(template.pkg.powerAppsDiagnostic, INSPECTION)
        && (host.pkg.powerAppsDiagnostic === undefined || (host.pkg.private === true && same(host.pkg.powerAppsDiagnostic, INSPECTION)));
      const privateTargets = privateDiagnosticPackage(host.pkg, 'upgrade-target')
        && privateDiagnosticPackage(template.pkg, INSPECTION.purpose);
      requireValue((sourceVersions || privateTargets)
        && profile.expoSdk === 57
        && !fs.existsSync(path.join(template.packageRoot, 'template/package-lock.json')),
      'Inspection artifacts require a private diagnostic template, consistent package versions/roles/sourceVersion provenance, an SDK 57 profile and no stale template lock.');
    }
    const templateApp = json(path.join(template.packageRoot, 'template/package.json'), 'packed template app manifest');
    if (!localPackages.includes(PUSH)) {
      const requiresPush = [...packages.values(), { pkg: templateApp }].some(({ pkg }) => (
        Object.values(dependencySections(pkg)).some((section) => (
          Object.entries(section).some(([name, spec]) => name === PUSH || npmAliasTarget(spec) === PUSH)
        ))
      ));
      requireValue(!requiresPush, 'Diagnostic artifacts must include the push-notifications archive required by their packed packages.');
    }
    const expectedDeclarations = dependencySections(templateApp);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const expected = { ...expectedDeclarations[section] };
      if (section === 'dependencies') {
        for (const name of localPackages) expected[name] = project.declarations.dependencies[name];
      }
      requireValue(same(project.declarations[section] || {}, expected),
        'Reference dependency declarations must match the packed template, with only selected local package substitutions.');
    }
    const bin = template.pkg.bin?.['create-power-app-native'];
    const executable = relativeFile(template.packageRoot, bin);
    let templateManifest;
    try {
      templateManifest = JSON.parse(run(process.execPath, [executable, '--manifest'], template.packageRoot));
    } catch {
      requireValue(false, 'Packed template --manifest failed or returned unsupported JSON.');
    }
    const requirements = {
      schemaVersion: 1, templateVersion: profile.targetTemplateVersion,
      nativeRuntimeVersions: Object.fromEntries(PLATFORMS.map((platform) => [platform, profile.nativeRuntime[platform].version])),
    };
    requireValue(same(templateManifest, { ...requirements, templatePackage: { name: TEMPLATE, version: template.version } })
      && same(project.metadata, requirements), 'Packed template CLI, host profile and reference metadata disagree.');
    for (const [section, managed] of [
      ['dependencies', profile.managedDependencies], ['devDependencies', profile.managedDevDependencies],
    ]) {
      requireValue(managed && typeof managed === 'object' && !Array.isArray(managed), 'Packed host managed dependency contract is missing.');
      for (const [name, spec] of Object.entries(managed)) {
        requireValue(localPackages.includes(name) || project.declarations[section]?.[name] === spec,
          'Reference declarations differ from the packed host managed dependencies.');
      }
    }
    const referenceManifest = json(path.join(reference, 'package.json'));
    requireValue(Object.entries(profile.managedOverrides || {}).every(([name, value]) => same(referenceManifest.overrides?.[name], value)),
      'Reference overrides differ from the packed host compatibility contract.');
    const nativePackages = Object.fromEntries([...project.installed].filter(([, pkg]) => pkg.native)
      .map(([installPath, pkg]) => [installPath, pkg.version]));
    requireValue(!Object.keys(nativePackages).some((name) => name.includes('power-apps-native-offline')),
      'The selected reference still contains native offline code; an online-only diagnostic is required.');
    const target = {
      ...requirements, template: { package: TEMPLATE, version: template.version, integrity: template.integrity },
      managedDependencies: project.declarations, nativePackages,
      fingerprints: Object.fromEntries(PLATFORMS.map((platform) => [platform, profile.nativeRuntime[platform].fingerprint])),
    };
    const migrations = profile.migrations.map((id) => {
      requireValue(typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id), 'Unsafe packed migration identifier.');
      const migration = json(path.join(host.packageRoot, 'compatibility/migrations', `${id}.json`), 'packed migration');
      requireValue(migration.schemaVersion === 1 && migration.id === id
        && Number.isSafeInteger(migration.fromTemplateVersion) && migration.fromTemplateVersion > 0
        && migration.toTemplateVersion === migration.fromTemplateVersion + 1,
      'Packed migrations must expose valid adjacent version edges.');
      return migration;
    });
    const player = manifest.player;
    requireValue(player?.platform === 'android', 'Local diagnostic selection currently requires an Android APK; iOS is not validated.');
    const apk = relativeFile(root, player.path);
    verifyHash(apk, player.sha256, 'Selected player APK');
    const actual = parseAndroidPlayerMetadata(run('aapt2', ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], staging));
    let asset;
    try {
      asset = JSON.parse(run('unzip', ['-p', apk, PLAYER_ASSET], staging));
    } catch {
      requireValue(false, 'Selected APK diagnostic metadata asset is missing or malformed; rebuild the actual player, not a source-profile sidecar.');
    }
    requireValue(asset && typeof asset === 'object' && !Array.isArray(asset), 'Selected APK metadata asset must be a JSON object.');
    const { diagnostic, ...assetRuntime } = asset;
    const { diagnostic: manifestDiagnostic, ...manifestRuntime } = actual;
    requireValue(same(asset, player.metadata) && same(assetRuntime, manifestRuntime)
      && (manifestDiagnostic === undefined || same(manifestDiagnostic, diagnostic)),
    'Selected APK asset, authoritative AndroidManifest and supplied metadata disagree. Asset-only or source-profile evidence is insufficient.');
    requireValue(diagnostic?.protocol === INSPECTION.protocol && same(diagnostic.nativeRuntime, profile.nativeRuntime),
      'Selected APK baked diagnostic fingerprints differ from the packed host profile. Equal runtime counters do not prove equal native builds.');
    validatePlayer(actual, target);
    const result = { target, migrations, player, packages: manifest.packages, reference, referenceLock: project.lock, manifestSha256, profile, inspectionOnly };
    validateProjectAgainstRelease(project, target);
    return result;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function verifyAppArchive(projectRoot, app, lock, item) {
  const spec = app.dependencies?.[item.name];
  const locked = lock.packages?.[`node_modules/${item.name}`];
  requireValue(typeof spec === 'string' && spec.startsWith('file:') && spec.length > 5
    && typeof locked?.resolved === 'string' && locked.resolved.startsWith('file:')
    && locked.version === item.version && locked.integrity === item.integrity
    && app.overrides?.[item.name] === `$${item.name}`,
  'App declarations, lock and overrides do not bind the selected diagnostic archive.');
  const archive = path.resolve(projectRoot, spec.slice(5));
  requireValue(path.resolve(projectRoot, locked.resolved.slice(5)) === archive
    && fs.existsSync(archive) && fs.lstatSync(archive).isFile()
    && fs.realpathSync(archive) === archive,
  'App and lock must resolve to the same regular local diagnostic archive, without symbolic links.');
  verifyHash(archive, item.sha256, 'App local archive');
  return spec;
}

function resolveDiagnosticProject(projectRoot, manifestPath, options) {
  assertOnlineOnly(projectRoot);
  const selection = loadDiagnosticArtifacts(manifestPath, options);
  const project = readProject(projectRoot, readPlatformContext());
  const app = json(path.join(projectRoot, 'package.json'));
  requireValue(Object.entries(selection.profile.managedOverrides || {}).every(([name, value]) => same(app.overrides?.[name], value)),
    'App overrides differ from the selected host compatibility contract.');
  requireValue(same(project.metadata, {
    schemaVersion: 1, templateVersion: selection.target.templateVersion,
    nativeRuntimeVersions: selection.target.nativeRuntimeVersions,
  }), 'App metadata does not match the selected diagnostic target. Rehearse its migrations; never backfill counters.');
  const projectBaseline = {
    ...selection.target,
    managedDependencies: Object.fromEntries(Object.entries(selection.target.managedDependencies)
      .map(([section, dependencies]) => [section, { ...dependencies }])),
  };
  for (const [section, managed] of [
    ['dependencies', selection.profile.managedDependencies],
    ['devDependencies', selection.profile.managedDevDependencies],
  ]) {
    for (const [name, expected] of Object.entries(managed)) {
      const actual = project.declarations[section]?.[name];
      const locked = selection.referenceLock.packages[`node_modules/${name}`]?.version;
      // Only the producer's baseline semver range may become its immutable
      // reference resolution. Aliases, file specs and custom declarations stay exact.
      if (projectBaseline.managedDependencies[section]?.[name] === expected
        && !exactVersion(expected) && declarationSpec(expected) && !expected.startsWith('file:')
        && exactVersion(actual) && actual === locked) {
        projectBaseline.managedDependencies[section][name] = actual;
      }
    }
  }
  for (const item of selection.packages.filter((pkg) => pkg.name !== TEMPLATE)) {
    projectBaseline.managedDependencies.dependencies[item.name] = verifyAppArchive(projectRoot, app, project.lock, item);
    verifyInstalledPackage(path.join(selection.reference, 'node_modules', item.name), path.join(projectRoot, 'node_modules', item.name));
  }
  validateProjectAgainstRelease(project, projectBaseline);
  // Absolute archive declarations stay internal to dependency admission; the
  // public summary always uses the canonical, package-relative reference tuple.
  return { ...selection, projectBaseline };
}

function planDiagnosticUpdate(projectRoot, manifestPath, options) {
  assertOnlineOnly(projectRoot);
  const selection = loadDiagnosticArtifacts(manifestPath, options);
  const source = readProjectRequirements(projectRoot);
  const installed = json(path.join(projectRoot, 'node_modules', HOST, 'package.json'), 'installed host');
  requireValue(installed.name === HOST && exactVersion(installed.version), 'An installed exact host is required for diagnostic planning.');
  const targetHost = selection.target.nativePackages[`node_modules/${HOST}`];
  const target = selection.target;
  requireValue(source.templateVersion <= target.templateVersion
    && PLATFORMS.every((platform) => source.nativeRuntimeVersions[platform] <= target.nativeRuntimeVersions[platform]),
  'Diagnostic downgrades are not supported.');
  const numeric = (version) => version.split(/[.-]/).slice(0, 3).map(Number);
  const a = numeric(installed.version);
  const b = numeric(targetHost);
  requireValue(Math.sign(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) <= 0
    && !(a.every((value, index) => value === b[index]) && !installed.version.includes('-') && targetHost.includes('-')),
  'Diagnostic host downgrade is not supported.');
  const migrationRequired = source.templateVersion < target.templateVersion;
  const edges = [];
  for (let current = source.templateVersion; current < target.templateVersion; current += 1) {
    const matches = selection.migrations.filter((edge) => edge.fromTemplateVersion === current);
    requireValue(matches.length === 1 && matches[0].toTemplateVersion === current + 1,
      'Packed host does not provide an unambiguous adjacent migration chain for this app.');
    edges.push(matches[0]);
  }
  const coreChanged = ['expo', 'react-native'].some((name) => {
    const pkg = json(path.join(projectRoot, 'node_modules', name, 'package.json'), 'installed runtime package');
    requireValue(pkg.name === name && exactVersion(pkg.version), 'Installed runtime package identity is invalid.');
    return pkg.version !== target.nativePackages[`node_modules/${name}`];
  });
  const nativeTransition = coreChanged
    || PLATFORMS.some((platform) => source.nativeRuntimeVersions[platform] !== target.nativeRuntimeVersions[platform]);
  requireValue(!nativeTransition || migrationRequired, 'Runtime changes require a packed migration; metadata edits cannot substitute.');
  requireValue(!coreChanged || PLATFORMS.every((platform) => source.nativeRuntimeVersions[platform] < target.nativeRuntimeVersions[platform]),
    'An Expo/React Native transition must advance both protected runtime counters through the packed migration.');
  let productionReleaseRequirement = null;
  if (nativeTransition) {
    const from = edges[0]?.packageTransitions?.dependencies?.[HOST]?.from || installed.version;
    const sourceMajor = /^[~^]?(\d+)\./.exec(from)?.[1];
    requireValue(sourceMajor !== undefined, 'Cannot establish the source host major for native-transition planning.');
    const newMajor = Number(targetHost.split('.')[0]) > Number(sourceMajor)
      && Number(target.template.version.split('.')[0]) > Number(sourceMajor);
    const sourceVersions = selection.inspectionOnly && targetHost.startsWith('0.') && target.template.version.startsWith('0.');
    requireValue(sourceVersions || newMajor,
    'A native transition requires a new host and template package major. Diagnostic prereleases are allowed only in that new major.');
    productionReleaseRequirement = {
      minimumHostMajor: Number(sourceMajor) + 1,
      status: sourceVersions ? 'unpublished-source-artifacts-do-not-satisfy-production-release' : 'new-major-diagnostic-not-a-published-release',
    };
  }
  const hostArtifact = selection.packages.find((item) => item.name === HOST);
  let hostInstallRequired = installed.version !== targetHost;
  if (!hostInstallRequired) {
    try {
      verifyAppArchive(projectRoot, json(path.join(projectRoot, 'package.json'), 'app package manifest'),
        json(path.join(projectRoot, 'package-lock.json'), 'app lock'), hostArtifact);
      verifyInstalledPackage(path.join(selection.reference, 'node_modules', HOST), path.join(projectRoot, 'node_modules', HOST));
    } catch (error) {
      if (error.code !== 'MOBILE_RELEASE_BLOCKED') throw error;
      hostInstallRequired = true;
    }
  }
  if (!migrationRequired && !hostInstallRequired) resolveDiagnosticProject(projectRoot, manifestPath, options);
  const supported = selection.player.metadata.supportedNativeRuntimeVersions.android;
  return {
    kind: migrationRequired ? 'template-upgrade' : hostInstallRequired ? 'host-repair' : 'current',
    source, target: summary(selection), installedHostVersion: installed.version,
    hostInstallRequired, migrationRequired, fullChainPreviewRequired: migrationRequired, productionReleaseRequirement,
    hostInstallReason: hostInstallRequired ? 'The selected archive identity, lock binding or installed content differs from the source host.' : null,
    migrationEdges: edges.map((edge) => ({ from: edge.fromTemplateVersion, to: edge.toTemplateVersion })),
    playerCompatibility: {
      platform: 'android', required: source.nativeRuntimeVersions.android, supported,
      matchesSource: supported.includes(source.nativeRuntimeVersions.android),
      guidance: supported.includes(source.nativeRuntimeVersions.android)
        ? 'The selected APK supports the recorded source counter; installed app inventory still needs verification.'
        : 'The selected APK cannot load this app yet. Rehearse the selected migration or choose an actual older matching player; do not change counters to silence the mismatch.',
    },
  };
}

function acquireDiagnosticTemplate(destination, manifestPath, options = {}) {
  const { assertEmptyDestination, assertTemplateManifest } = require('../mobile-template-lifecycle');
  const target = path.resolve(destination);
  assertEmptyDestination(target);
  const selection = loadDiagnosticArtifacts(manifestPath, options);
  requireValue(!selection.inspectionOnly,
    'This private template is upgrade-inspection-only and cannot scaffold an app. Use it only to inspect/rehearse the approved local upgrade; no template source or lock is copied.');
  const item = selection.packages.find((pkg) => pkg.name === TEMPLATE);
  const archive = relativeFile(path.dirname(path.resolve(manifestPath)), item.path);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-artifact-create-'));
  fs.chmodSync(staging, 0o700);
  const run = options.run || execute;
  try {
    const packageRoot = unpack(archive, staging, run);
    const pkg = json(path.join(packageRoot, 'package.json'));
    const executable = relativeFile(packageRoot, pkg.bin['create-power-app-native']);
    assertEmptyDestination(target);
    run(process.execPath, [executable, target], staging);
    assertTemplateManifest({
      ...readProjectRequirements(target), templatePackage: { name: TEMPLATE, version: item.version },
    }, selection.target);
    // A fresh scaffold may use unpublished registry declarations. Substitute
    // only the selected local first-party inputs and its verified reference lock.
    const app = json(path.join(target, 'package.json'));
    const reference = json(path.join(selection.reference, 'package.json'));
    for (const local of selection.packages.filter((entry) => entry.name !== TEMPLATE)) {
      const spec = selection.target.managedDependencies.dependencies[local.name];
      app.dependencies[local.name] = spec;
      app.overrides = { ...app.overrides, [local.name]: `$${local.name}` };
      const file = path.join(target, spec.slice(5));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(relativeFile(path.dirname(path.resolve(manifestPath)), local.path), file, fs.constants.COPYFILE_EXCL);
    }
    requireValue(app.name === reference.name && same(app.dependencies, reference.dependencies)
      && same(app.devDependencies, reference.devDependencies) && same(app.overrides, reference.overrides),
    'Fresh diagnostic template declarations differ from its verified reference lock. Preserve the partial target for review.');
    fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify(app, null, 2)}\n`);
    fs.copyFileSync(path.join(selection.reference, 'package-lock.json'), path.join(target, 'package-lock.json'));
    return { target: summary(selection), installedDependencies: false };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = {
  loadDiagnosticArtifacts, resolveDiagnosticProject, planDiagnosticUpdate, summary,
  assertOnlineOnly, parseAndroidPlayerMetadata, acquireDiagnosticTemplate,
};
