'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runCliSync, CliLaunchError } = require('./process-runner');
const {
  exactVersion, declarationSpec, dependencySections, isRuntimePackage, readProjectRequirements, validateRelease,
  readProject, readPlatformContext, validateProjectAgainstRelease, summarizeRelease, validHostIntegrity,
} = require('./mobile-release');

const HOST = '@microsoft/power-apps-native-host';
const TEMPLATE = '@microsoft/power-apps-native-template';
const PLATFORMS = ['android', 'ios'];
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;

function requireValue(condition, message) {
  if (condition) return;
  const error = new Error(message);
  error.code = 'MOBILE_RELEASE_BLOCKED';
  throw error;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    requireValue(false, `Cannot inspect ${label}; restore the published package or project installation.`);
  }
}

function same(left, right) {
  if (left === right) return true;
  return Boolean(left && right && typeof left === 'object' && typeof right === 'object'
    && Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every((key) => Object.hasOwn(right, key) && same(left[key], right[key])));
}

function compareVersions(left, right) {
  requireValue(exactVersion(left, true) && exactVersion(right, true), 'Select exact stable published package versions.');
  const a = left.split('+', 1)[0].split('.').map(BigInt);
  const b = right.split('+', 1)[0].split('.').map(BigInt);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function run(command, args, cwd) {
  try {
    return runCliSync(command, args, {
      cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false' },
    });
  } catch (error) {
    if (!(error instanceof CliLaunchError) && !(Number.isInteger(error.status) && error.status > 0)) throw error;
    requireValue(false, command === 'npm'
      ? 'Published package lookup failed. Check the exact version, configured npm registry, authentication and network; no other version was substituted.'
      : 'Package inspection failed. Ensure tar is available; no package code was executed.');
  }
}

function parseOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    requireValue(false, 'npm returned invalid package metadata; inspect registry access locally (raw output withheld).');
  }
}

function createSource(options = {}) {
  const execute = options.run || run;
  const context = options.cwd || process.cwd();
  const cache = new Map();
  return {
    defaultVersion() {
      const version = parseOutput(execute('npm', ['view', HOST, 'version', '--json'], context));
      requireValue(exactVersion(version, true), 'The npm default host channel must resolve to one exact stable version.');
      return version;
    },
    versions() {
      if (options.versions) return options.versions();
      const versions = parseOutput(execute('npm', ['view', TEMPLATE, 'versions', '--json'], context));
      requireValue(Array.isArray(versions) && versions.every((version) => exactVersion(version)),
        'The template registry response must contain published package versions.');
      return versions;
    },
    read(name, version) {
      requireValue([HOST, TEMPLATE].includes(name) && exactVersion(version, true),
        'Select an exact stable host or template package version, not a release id, range, URL or tag.');
      const key = `${name}@${version}`;
      if (cache.has(key)) return cache.get(key);
      if (options.readPackage) {
        const result = options.readPackage(name, version);
        cache.set(key, result);
        return result;
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-published-package-'));
      fs.chmodSync(directory, 0o700);
      try {
        const metadata = parseOutput(execute('npm', ['view', key, '--json'], context));
        // Older host publications use npm's registry shasum rather than
        // dist.integrity. Verify that original digest; never invent an attestation.
        const integrity = metadata.dist?.integrity ?? (name === HOST && /^[a-f0-9]{40}$/.test(metadata.dist?.shasum || '')
          ? `sha1-${Buffer.from(metadata.dist.shasum, 'hex').toString('base64')}` : null);
        requireValue(metadata?.name === name && metadata.version === version
          && (name === HOST ? validHostIntegrity(integrity) : SRI.test(integrity || '')),
          `Registry metadata for ${key} must identify the exact package and its published integrity.`);
        const packed = parseOutput(execute('npm', [
          'pack', key, '--ignore-scripts', '--json', '--pack-destination', directory,
        ], context));
        requireValue(Array.isArray(packed) && packed.length === 1 && packed[0].name === name
          && packed[0].version === version && SRI.test(packed[0].integrity || '')
          && typeof packed[0].filename === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]*\.tgz$/.test(packed[0].filename),
        'Downloaded package identity or integrity differs from npm publication metadata.');
        const archive = path.join(directory, packed[0].filename);
        requireValue(fs.lstatSync(archive).isFile() && !fs.lstatSync(archive).isSymbolicLink(),
          'Downloaded package must be a regular archive.');
        const bytes = fs.readFileSync(archive);
        const algorithm = integrity.slice(0, integrity.indexOf('-'));
        requireValue(`${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}` === integrity
          && `sha512-${createHash('sha512').update(bytes).digest('base64')}` === packed[0].integrity,
        'Downloaded package bytes do not match the published integrity.');
        const { unpack } = require('./mobile-diagnostic-artifacts');
        const root = unpack(archive, directory, execute);
        const pkg = readJson(path.join(root, 'package.json'), 'packed package manifest');
        requireValue(pkg.name === name && pkg.version === version && pkg.private !== true && !pkg.powerAppsDiagnostic,
          'Packed package identity must match the selected public production package.');
        const publication = { package: name, version, integrity };
        let result;
        if (name === HOST) {
          const profile = readJson(path.join(root, 'compatibility/current.json'), 'published host compatibility profile');
          const migrationIds = profile.migrations === undefined ? [] : profile.migrations;
          requireValue(Array.isArray(migrationIds), 'The published host migration list must be an array.');
          const migrations = migrationIds.map((id) => {
            requireValue(typeof id === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(id), 'Invalid published migration identity.');
            return readJson(path.join(root, 'compatibility/migrations', `${id}.json`), 'published host migration');
          });
          result = { publication, pkg, profile, migrations };
        } else {
          result = {
            publication, pkg,
            app: readJson(path.join(root, 'template/app.json'), 'published template state'),
            manifest: readJson(path.join(root, 'template/package.json'), 'published template dependencies'),
            lock: readJson(path.join(root, 'template/package-lock.json'), 'published template lock'),
          };
        }
        cache.set(key, result);
        return result;
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

function validateHost(host) {
  const { profile, publication } = host;
  requireValue(publication?.package === HOST && exactVersion(publication.version, true)
    && validHostIntegrity(publication.integrity) && host.pkg?.name === HOST && host.pkg.version === publication.version,
  'Invalid published host identity.');
  requireValue(profile?.schemaVersion === 1 && Number.isSafeInteger(profile.targetTemplateVersion)
    && profile.targetTemplateVersion > 0 && exactVersion(profile.expoVersion, true)
    && PLATFORMS.every((platform) => Number.isSafeInteger(profile.nativeRuntime?.[platform]?.version)
      && profile.nativeRuntime[platform].version > 0 && /^[a-f0-9]{64}$/.test(profile.nativeRuntime[platform].fingerprint)),
  'The published host lacks a supported template/native compatibility profile.');
  const managed = { dependencies: { ...profile.managedDependencies, expo: profile.expoVersion, [HOST]: publication.version } };
  if (profile.managedDevDependencies) managed.devDependencies = profile.managedDevDependencies;
  dependencySections(managed);
  requireValue(Object.values(managed).every((section) => Object.values(section).every(declarationSpec))
    && ['react', 'react-native'].every((name) => exactVersion(managed.dependencies[name], true)),
  'The published host must declare the coordinated Expo, React and React Native dependency set.');
  requireValue(Array.isArray(host.migrations), 'The published host migration graph is unavailable.');
  for (const migration of host.migrations) {
    requireValue(Number.isSafeInteger(migration.fromTemplateVersion) && migration.fromTemplateVersion > 0
      && migration.toTemplateVersion === migration.fromTemplateVersion + 1
      && migration.toTemplateVersion <= profile.targetTemplateVersion
      && exactVersion(migration.targetProfile?.hostVersion, true),
    'The host contains an invalid or unfinalized migration target. Wait for a finalized published release; do not replace version placeholders.');
  }
  return managed;
}

function templateState(template) {
  requireValue(template.publication?.package === TEMPLATE && exactVersion(template.publication.version, true)
    && SRI.test(template.publication.integrity || ''), 'Invalid published template identity.');
  const state = template.app?.expo?.extra?.powerappsNative;
  requireValue(state?.schemaVersion === 1 && Number.isSafeInteger(state.templateVersion) && state.templateVersion > 0
    && PLATFORMS.every((platform) => Number.isSafeInteger(state.nativeRuntimeVersions?.[platform])
      && state.nativeRuntimeVersions[platform] > 0), 'The published template lacks protected compatibility metadata.');
  return state;
}

function findTemplate(source, host, requestedVersion) {
  const versions = requestedVersion ? [requestedVersion]
    : source.versions().filter((version) => exactVersion(version, true)).sort((a, b) => compareVersions(b, a));
  for (const version of versions) {
    const template = source.read(TEMPLATE, version);
    const state = templateState(template);
    if (state.templateVersion !== host.profile.targetTemplateVersion
      || !PLATFORMS.every((platform) => state.nativeRuntimeVersions[platform] === host.profile.nativeRuntime[platform].version)) {
      if (requestedVersion) requireValue(false, 'Selected host and template require different native/template versions.');
      continue;
    }
    requireValue([2, 3].includes(template.lock?.lockfileVersion) && template.lock.packages?.[''],
      'The published template must include its immutable npm lock.');
    requireValue(same(dependencySections(template.manifest), dependencySections(template.lock.packages[''])),
      'Published template dependency declarations differ from its packaged lock.');
    const lockedHost = template.lock.packages[`node_modules/${HOST}`]?.version;
    requireValue(exactVersion(lockedHost, true), 'The published template must pin a production host in its lock.');
    if (compareVersions(lockedHost, host.publication.version) > 0) {
      if (requestedVersion) requireValue(false, 'The selected template requires a newer host; do not downgrade its published baseline.');
      continue;
    }
    const baseline = source.read(HOST, lockedHost);
    validateHost(baseline);
    requireValue(same(baseline.profile.nativeRuntime, host.profile.nativeRuntime),
      'The selected host differs from the template native fingerprint. Select a compatible published template; counters alone are insufficient.');
    for (const [name, version] of Object.entries({
      expo: host.profile.expoVersion, react: host.profile.managedDependencies.react,
      'react-native': host.profile.managedDependencies['react-native'],
    })) {
      requireValue(template.lock.packages[`node_modules/${name}`]?.version === version,
        'The template lock does not match the selected host Expo/React/React Native requirements.');
    }
    return template;
  }
  requireValue(false, 'No published template matches this host compatibility profile. Finish publishing the matching template; do not use a bundled snapshot.');
}

function contractFromPackages(host, template, project) {
  const managed = validateHost(host);
  const state = templateState(template);
  const nativePackages = {};
  for (const [installPath, entry] of Object.entries(template.lock.packages)) {
    if (!installPath.startsWith('node_modules/')) continue;
    const name = installPath.split('/node_modules/').pop().replace(/^node_modules\//, '');
    if (isRuntimePackage(name) || project?.installed.get(installPath)?.native) {
      requireValue(exactVersion(entry.version), 'The published template has an invalid native lock entry.');
      nativePackages[installPath] = entry.version;
    }
  }
  nativePackages[`node_modules/${HOST}`] = host.publication.version;
  // The host CLI pins itself exactly; an untouched scaffold may retain the
  // template's published range. Neither permits a different installed version.
  const declaredHost = project?.declarations.dependencies?.[HOST];
  if (declaredHost === template.manifest.dependencies?.[HOST]) managed.dependencies[HOST] = declaredHost;
  return validateRelease({
    source: 'npm',
    id: `host-${host.publication.version}-template-${template.publication.version}`,
    host: { ...host.publication },
    template: { ...template.publication },
    templateVersion: state.templateVersion,
    nativeRuntimeVersions: { ...state.nativeRuntimeVersions },
    managedDependencies: managed,
    nativePackages,
    platforms: Object.fromEntries(PLATFORMS.map((platform) => [platform, {
      fingerprint: host.profile.nativeRuntime[platform].fingerprint,
    }])),
  });
}

function selectPublishedContract(hostVersion, options = {}) {
  const source = createSource(options);
  const host = source.read(HOST, hostVersion);
  validateHost(host);
  const template = findTemplate(source, host, options.templateVersion);
  return contractFromPackages(host, template, options.project);
}

function selectTemplateContract(templateVersion, options = {}) {
  const source = createSource(options);
  const template = source.read(TEMPLATE, templateVersion);
  templateState(template);
  const hostVersion = template.lock?.packages?.[`node_modules/${HOST}`]?.version;
  const host = source.read(HOST, hostVersion);
  validateHost(host);
  findTemplate(source, host, templateVersion);
  return contractFromPackages(host, template);
}

function readSourceRequirements(projectRoot) {
  const metadata = readProjectRequirements(projectRoot);
  const hostRoot = path.join(projectRoot, 'node_modules', HOST);
  for (const relative of ['node_modules', 'node_modules/@microsoft', `node_modules/${HOST}`]) {
    const stat = fs.lstatSync(path.join(projectRoot, relative), { throwIfNoEntry: false });
    requireValue(stat?.isDirectory() && !stat.isSymbolicLink(), 'Restore a regular installed host before planning an upgrade.');
  }
  const installed = readJson(path.join(hostRoot, 'package.json'), 'installed host manifest');
  requireValue(installed.name === HOST && exactVersion(installed.version, true), 'Upgrade planning requires an exact installed production host version.');
  return {
    templateVersion: metadata.templateVersion,
    nativeRuntimeVersions: metadata.nativeRuntimeVersions,
    hostVersion: installed.version,
    validationScope: 'requirements-only',
  };
}

function projectContract(projectRoot, project, options = {}) {
  const requirements = readSourceRequirements(projectRoot);
  const source = createSource({ ...options, cwd: projectRoot });
  const contract = selectPublishedContract(requirements.hostVersion, {
    ...options, project, readPackage: source.read, versions: source.versions,
  });
  requireValue(contract.templateVersion === requirements.templateVersion
    && same(contract.nativeRuntimeVersions, requirements.nativeRuntimeVersions),
  'Installed host and recorded template/native state differ. Run check-updates to preview the host migration; do not rewrite the app metadata.');
  assertInstalledProfile(projectRoot, source.read(HOST, requirements.hostVersion).profile);
  return contract;
}

function assertInstalledProfile(projectRoot, profile) {
  const installed = readJson(path.join(projectRoot, 'node_modules', HOST, 'compatibility/current.json'), 'installed host compatibility profile');
  requireValue(same(installed, profile), 'Installed host compatibility metadata differs from its published package.');
}

function planPublishedUpdate(projectRoot, hostVersion, options = {}) {
  const sourceRequirements = readSourceRequirements(projectRoot);
  requireValue(compareVersions(sourceRequirements.hostVersion, hostVersion) <= 0,
    'Selected published host would downgrade the app; choose a supported forward version.');
  const source = createSource({ ...options, cwd: projectRoot });
  const host = source.read(HOST, hostVersion);
  validateHost(host);
  const template = findTemplate(source, host, options.templateVersion);
  const target = contractFromPackages(host, template);
  requireValue(sourceRequirements.templateVersion <= target.templateVersion
    && PLATFORMS.every((platform) => sourceRequirements.nativeRuntimeVersions[platform] <= target.nativeRuntimeVersions[platform]),
  'Selected published host would downgrade the app; choose a supported forward version.');
  const migrationRequired = sourceRequirements.templateVersion < target.templateVersion;
  const nativeChanged = PLATFORMS.some((platform) => sourceRequirements.nativeRuntimeVersions[platform] !== target.nativeRuntimeVersions[platform]);
  requireValue(!nativeChanged || migrationRequired, 'Native runtime changes require a host-owned template migration.');
  const installedProfilePath = path.join(projectRoot, 'node_modules', HOST, 'compatibility/current.json');
  if (fs.existsSync(installedProfilePath)) {
    const installedProfile = readJson(installedProfilePath, 'installed host compatibility profile');
    for (const platform of PLATFORMS) {
      const previous = installedProfile.nativeRuntime?.[platform];
      if (previous?.version !== sourceRequirements.nativeRuntimeVersions[platform]) continue;
      requireValue(/^[a-f0-9]{64}$/.test(previous.fingerprint || ''), 'Invalid installed native fingerprint; restore the host package before planning.');
      if (previous.fingerprint !== target.platforms[platform].fingerprint) {
        requireValue(migrationRequired && target.nativeRuntimeVersions[platform] > previous.version,
          'A native fingerprint change must advance its runtime version through a template migration.');
      }
    }
  }
  const edges = [];
  for (let version = sourceRequirements.templateVersion; version < target.templateVersion; version += 1) {
    const matching = host.migrations.filter((migration) => migration.fromTemplateVersion === version);
    requireValue(matching.length === 1, 'The selected published host does not contain an unambiguous migration chain for this app.');
    edges.push(matching[0]);
  }
  if (nativeChanged) {
    const fromSpec = edges[0]?.packageTransitions?.dependencies?.[HOST]?.from;
    const fromVersion = typeof fromSpec === 'string' ? fromSpec.replace(/^[~^]/, '') : sourceRequirements.hostVersion;
    requireValue(exactVersion(fromVersion, true)
      && BigInt(hostVersion.split('.')[0]) > BigInt(fromVersion.split('.')[0]),
    'A native runtime transition requires a new host major; the published migration must identify the source host requirement.');
  }
  const hostInstallRequired = sourceRequirements.hostVersion !== hostVersion;
  if (!migrationRequired && !hostInstallRequired) {
    const project = readProject(projectRoot, readPlatformContext());
    assertInstalledProfile(projectRoot, host.profile);
    validateProjectAgainstRelease(project, contractFromPackages(host, template, project));
  }
  return {
    kind: migrationRequired ? 'template-upgrade' : hostInstallRequired ? 'host-repair' : 'current',
    installedHostVersion: sourceRequirements.hostVersion,
    source: sourceRequirements,
    target: summarizeRelease(target),
    hostInstallRequired,
    migrationRequired,
    fullChainPreviewRequired: migrationRequired,
    nativeChanged,
    binaryAvailability: 'not-checked; package publication does not prove Player or Wrap availability',
  };
}

module.exports = {
  HOST, TEMPLATE, createSource, compareVersions, selectPublishedContract, selectTemplateContract,
  readSourceRequirements, projectContract, planPublishedUpdate,
};
