'use strict';

// This is a plugin-owned, maintainer-reviewed policy, not an npm release feed.
// An entry is admitted only after its template, host, players and bases are verified.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const CATALOG_PATH = path.resolve(__dirname, '../../shared/mobile-releases.json');
const HOST = '@microsoft/power-apps-native-host';
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const CORE = [HOST, 'expo', 'react-native', 'react'];
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/;
const PACKAGE_PART = '[a-z0-9][a-z0-9._-]*';
const PACKAGE_NAME = new RegExp(`^(?:@${PACKAGE_PART}/)?${PACKAGE_PART}$`);
const INSTALL_PATH = new RegExp(`^node_modules/(?:@${PACKAGE_PART}/)?${PACKAGE_PART}(?:/node_modules/(?:@${PACKAGE_PART}/)?${PACKAGE_PART})*$`);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RUNTIME_NAMES = [
  /^expo($|-)/, /^@expo\//, /^react$/, /^react-native$/, /^@react-native\//,
  /^@react-native-community\//, /^@shopify\/react-native-/, /^@config-plugins\//,
  /^@sentry\/react-native$/, /^@microsoft\/power-apps-native-/,
  /^expo-msal-intune$/, /^@microsoft\/pa-/,
  /^react-native-(?:gesture-handler|reanimated|screens|safe-area-context|webview|svg|maps|camera|vision-camera|document-picker|fs|permissions|device-info|keychain|biometrics|nfc-manager|worklets)$/,
  /^react-native-ble-/,
];

function blocked(message) {
  const error = new Error(message);
  error.code = 'MOBILE_RELEASE_BLOCKED';
  throw error;
}

function requireValue(condition, message) {
  if (!condition) blocked(message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value, allowed, required = allowed) {
  return object(value)
    && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactVersion(value, stable = false) {
  if (typeof value !== 'string' || value.length > 128) return false;
  const match = VERSION.exec(value);
  return Boolean(match && (!stable || !match[4])
    && (!match[4] || match[4].split('.').every((part) => !/^\d+$/.test(part) || part === '0' || part[0] !== '0')));
}

function safePackageName(name) {
  return typeof name === 'string' && name.length <= 214 && PACKAGE_NAME.test(name)
    && !name.split('/').some((part) => part === '.' || part === '..' || part === 'node_modules');
}

function safeInstallPath(value) {
  return typeof value === 'string' && value.length <= 4096 && INSTALL_PATH.test(value)
    && value.split('/node_modules/').every((part) => safePackageName(part.replace(/^node_modules\//, '')));
}

function declarationSpec(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  if (/^file:\.\/vendor\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(value)) return true;
  // Reviewed registry declarations may be ranges; the installed inventory is exact.
  const partial = /^(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])){0,2}$/;
  const range = (item) => {
    const version = item.replace(/^(?:[~^]|[<>]=?|=)/, '');
    return exactVersion(version) || partial.test(version);
  };
  return value.split(' || ').every((part) => {
    const hyphen = part.split(' - ');
    if (hyphen.length === 2) return hyphen.every(range);
    return part.split(' ').every(range);
  });
}

function publicEvidence(value) {
  if (typeof value !== 'string' || !value.startsWith('https://') || value.length > 2048 || /\s|\\/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    // No signed URLs, credentials, IP literals, intranet names, or private repo hosts.
    return url.protocol === 'https:' && !url.username && !url.password && !url.search
      && !url.hash && !url.port && !net.isIP(host) && !host.includes(':')
      && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)
      && !host.split('.').some((label) => /^(?:localhost|local|localdomain|internal|intranet|corp|lan|home|private|invalid|test)$/.test(label))
      && host !== 'ghe.com' && !host.endsWith('.ghe.com')
      && !/(?:token|password|secret|signature|authorization)[=:]/i.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

function validateRelease(release) {
  requireValue(keys(release, [
    'id', 'template', 'templateVersion', 'nativeRuntimeVersions', 'managedDependencies',
    'nativePackages', 'platforms', 'evidence',
  ]), 'Invalid reviewed release schema; ask a maintainer to repair the release policy.');
  requireValue(typeof release.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(release.id), 'Invalid reviewed release id.');
  requireValue(keys(release.template, ['package', 'version', 'integrity'])
    && release.template.package === '@microsoft/power-apps-native-template'
    && exactVersion(release.template.version, true), 'Reviewed template must have its public package name and exact stable version.');
  const integrity = release.template.integrity;
  requireValue(typeof integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
    && Buffer.from(integrity.slice(7), 'base64').toString('base64') === integrity.slice(7), 'Reviewed template must have a sha512 SRI integrity.');
  requireValue(positiveInteger(release.templateVersion), 'Invalid reviewed templateVersion.');
  requireValue(keys(release.nativeRuntimeVersions, ['android', 'ios'])
    && Object.values(release.nativeRuntimeVersions).every(positiveInteger), 'Invalid reviewed nativeRuntimeVersions.');
  requireValue(keys(release.managedDependencies, SECTIONS, []), 'Invalid reviewed managedDependencies.');
  const managedNames = new Set();
  for (const section of SECTIONS) {
    if (!Object.hasOwn(release.managedDependencies, section)) continue;
    const dependencies = release.managedDependencies[section];
    requireValue(object(dependencies), 'Invalid reviewed dependency section.');
    for (const [name, spec] of Object.entries(dependencies)) {
      requireValue(safePackageName(name) && declarationSpec(spec) && !managedNames.has(name), 'Invalid or duplicate reviewed managed dependency.');
      managedNames.add(name);
    }
  }
  requireValue(CORE.every((name) => Object.hasOwn(release.managedDependencies.dependencies || {}, name)), 'Reviewed release must manage the host, expo, react-native and react runtime dependencies.');
  requireValue(object(release.nativePackages) && Object.keys(release.nativePackages).length > 0, 'Reviewed release needs an exact native package inventory.');
  for (const [installPath, version] of Object.entries(release.nativePackages)) {
    requireValue(safeInstallPath(installPath) && exactVersion(version), 'Invalid reviewed native package path or exact version.');
  }
  requireValue(CORE.every((name) => Object.hasOwn(release.nativePackages, `node_modules/${name}`)), 'Reviewed native inventory must include the host, expo, react-native and react.');
  for (const name of managedNames) {
    requireValue(!isRuntimePackage(name) || Object.hasOwn(release.nativePackages, `node_modules/${name}`), 'Reviewed native inventory is missing a managed runtime dependency.');
  }
  requireValue(keys(release.platforms, ['android', 'ios']), 'Reviewed release needs both Android and iOS verification.');
  for (const platform of Object.values(release.platforms)) {
    requireValue(keys(platform, ['fingerprint', 'base', 'player'])
      && typeof platform.fingerprint === 'string'
      && /^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,255}$/.test(platform.fingerprint), 'Invalid reviewed platform fingerprint.');
    for (const target of ['base', 'player']) {
      requireValue(keys(platform[target], ['version', 'evidence'])
        && typeof platform[target].version === 'string' && TOKEN.test(platform[target].version)
        && publicEvidence(platform[target].evidence), 'Reviewed base and player need versions and public HTTPS verification evidence.');
    }
  }
  requireValue(Array.isArray(release.evidence) && release.evidence.length > 0
    && release.evidence.every(publicEvidence), 'Reviewed release needs public HTTPS publication and device-validation evidence.');
  return release;
}

function validateCatalog(catalog) {
  requireValue(keys(catalog, ['schemaVersion', 'defaultRelease', 'releases'])
    && catalog.schemaVersion === 1 && Array.isArray(catalog.releases), 'Invalid bundled mobile release policy; update or repair the plugin.');
  const ids = new Set();
  for (const release of catalog.releases) {
    validateRelease(release);
    requireValue(!ids.has(release.id), 'Duplicate reviewed release id.');
    ids.add(release.id);
  }
  requireValue(catalog.defaultRelease === null || (typeof catalog.defaultRelease === 'string' && ids.has(catalog.defaultRelease)), 'The default release must reference a reviewed policy entry, or be null.');
  return catalog;
}

function readJson(filePath, label) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    requireValue(object(parsed), `${label} must contain a JSON object.`);
    return parsed;
  } catch (error) {
    if (error.code === 'MOBILE_RELEASE_BLOCKED') throw error;
    // JSON parse and filesystem errors may contain application config or paths.
    blocked(`Cannot read valid ${label}. Restore the file before continuing.`);
  }
}

function readCatalog() {
  return validateCatalog(readJson(CATALOG_PATH, 'bundled mobile release policy'));
}

function selectRelease(id, catalog = readCatalog()) {
  validateCatalog(catalog);
  requireValue(id === undefined || id === null || (typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)), 'Use a valid reviewed release id.');
  const selected = catalog.releases.find((release) => release.id === (id ?? catalog.defaultRelease));
  requireValue(selected, 'No verified mobile release is available for this selection. Ask a maintainer to publish and review template, host, Android/iOS player and base evidence; do not use npm latest or bypass this gate.');
  return selected;
}

function isRuntimePackage(name) {
  return RUNTIME_NAMES.some((pattern) => pattern.test(name));
}

function npmAliasTarget(spec) {
  if (typeof spec !== 'string' || !spec.startsWith('npm:')) return null;
  const separator = spec.indexOf('@', spec[4] === '@' ? 5 : 4);
  const name = spec.slice(4, separator < 0 ? undefined : separator);
  return safePackageName(name) ? name : null;
}

function dependencySections(pkg) {
  const result = {};
  for (const section of SECTIONS) {
    if (pkg[section] === undefined) continue;
    requireValue(object(pkg[section]), 'Invalid package dependency section.');
    result[section] = pkg[section];
    for (const [name, spec] of Object.entries(pkg[section])) {
      requireValue(safePackageName(name) && typeof spec === 'string' && spec.length > 0, 'Invalid package dependency declaration.');
    }
  }
  return result;
}

function detectsNative(directory, pkg) {
  if (Object.hasOwn(pkg, 'codegenConfig') || pkg.expo?.plugins || pkg.expo?.autolinking) return true;
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      requireValue(!entry.isSymbolicLink(), 'Linked package contents cannot be verified against the reviewed runtime.');
      if (/\.podspec(?:\.json)?$|\.(?:java|kt|kts|gradle|swift|m|mm|h|hpp|c|cc|cpp|cxx|aar|so|a|dylib|dll|lib|vcxproj|csproj|sln)$/.test(entry.name)
        || /^(?:expo-module\.config\.json|app\.plugin\.[cm]?js|react-native\.config\.[cm]?js|Podfile|CMakeLists\.txt|AndroidManifest\.xml)$/.test(entry.name)
        || /\.(?:xcodeproj|xcworkspace|xcframework|framework)$/.test(entry.name)) return true;
      if (entry.isDirectory()
        && (entry.name === 'android' || entry.name === 'ios' || visit(path.join(current, entry.name)))) return true;
    }
    return false;
  }
  return visit(directory);
}

function inspectInstalledPackages(projectRoot, lock) {
  const installed = new Map();
  function visitModules(relativeDirectory) {
    const directory = path.join(projectRoot, relativeDirectory);
    if (!fs.existsSync(directory)) return;
    requireValue(!fs.lstatSync(directory).isSymbolicLink(), 'Linked node_modules cannot be verified against the reviewed runtime.');
    function visitPackage(relativePath) {
      requireValue(safeInstallPath(relativePath), 'Unsupported installed package path.');
      const absolutePath = path.join(projectRoot, relativePath);
      requireValue(!fs.lstatSync(absolutePath).isSymbolicLink(), 'Linked packages cannot be verified against the reviewed runtime.');
      const pkg = readJson(path.join(absolutePath, 'package.json'), 'installed package manifest');
      const name = relativePath.split('/node_modules/').pop().replace(/^node_modules\//, '');
      requireValue(safePackageName(pkg.name) && exactVersion(pkg.version), 'Installed package identity or version is invalid.');
      dependencySections(pkg);
      const native = isRuntimePackage(name) || isRuntimePackage(pkg.name) || detectsNative(absolutePath, pkg);
      const alias = pkg.name !== name;
      const locked = lock?.packages?.[relativePath];
      if (alias) {
        // npm aliases retain the canonical package name in package.json and the
        // v2/v3 lock entry, e.g. string-width-cjs -> string-width. The release
        // inventory cannot bind a separate canonical native identity safely.
        requireValue(!native, 'Native/runtime npm aliases cannot be admitted by the reviewed inventory schema.');
        requireValue([2, 3].includes(lock?.lockfileVersion) && object(locked) && !locked.link
          && locked.name === pkg.name && locked.version === pkg.version,
        'Installed npm alias must match its canonical name and exact version in the app lock.');
      }
      requireValue(locked?.name === undefined || locked.name === pkg.name, 'Installed package canonical identity differs from the app lock.');
      installed.set(relativePath, {
        name, canonicalName: pkg.name, alias, version: pkg.version, pkg, native,
      });
      visitModules(`${relativePath}/node_modules`);
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        requireValue(entry.isDirectory() && !entry.isSymbolicLink(), 'Invalid installed package scope.');
        for (const child of fs.readdirSync(path.join(directory, entry.name), { withFileTypes: true })) {
          requireValue(child.isDirectory() || child.isSymbolicLink(), 'Invalid installed scoped package.');
          visitPackage(`${relativeDirectory}/${entry.name}/${child.name}`);
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        visitPackage(`${relativeDirectory}/${entry.name}`);
      }
    }
  }
  try {
    const lockPath = path.join(projectRoot, 'package-lock.json');
    if (lock === undefined && fs.existsSync(lockPath)) lock = readJson(lockPath, 'package-lock.json');
    visitModules('node_modules');
    return installed;
  } catch (error) {
    if (error.code === 'MOBILE_RELEASE_BLOCKED') throw error;
    blocked('Cannot inspect installed dependencies. Restore a complete npm installation before continuing.');
  }
}

function readPlatformContext({ os = process.platform, cpu = process.arch, getReport = () => process.report?.getReport?.() } = {}) {
  let libc = null;
  if (os === 'linux') {
    try {
      // Inspect only in memory: diagnostic reports also contain environment
      // variables and paths and must never be logged or written by this gate.
      const report = getReport();
      if (typeof report?.header?.glibcVersionRuntime === 'string' && report.header.glibcVersionRuntime) {
        libc = 'glibc';
      } else if (Array.isArray(report?.sharedObjects) && report.sharedObjects.some((file) => typeof file === 'string'
        && /(?:^|\/)(?:ld-musl-[^/]+|libc\.musl-[^/]+)\.so(?:\.\d+)*$/.test(file))) {
        libc = 'musl';
      }
    } catch {
      // An unknown libc is not evidence that an optional package is ineligible.
    }
  }
  return { os, cpu, libc };
}

function optionalForOtherPlatform(entry, context) {
  const excludes = (value, current) => {
    if (value === undefined) return false;
    const values = typeof value === 'string' ? [value] : value;
    requireValue(Array.isArray(values) && values.every((item) => typeof item === 'string' && /^!?[a-zA-Z0-9_-]+$/.test(item)),
      'Invalid platform constraints in the app lock.');
    if (!current || values.length === 0 || (values.length === 1 && values[0] === 'any')) return false;
    return values.includes(`!${current}`)
      || (values.some((item) => !item.startsWith('!')) && !values.includes(current));
  };
  return entry.optional === true && (excludes(entry.os, context.os) || excludes(entry.cpu, context.cpu)
    || (context.os === 'linux' && excludes(entry.libc, context.libc)));
}

function resolveInstalledDependency(inventory, from, name) {
  let parent = from;
  while (parent) {
    const candidate = `${parent}/node_modules/${name}`;
    if (inventory.has(candidate)) return candidate;
    const index = parent.lastIndexOf('/node_modules/');
    parent = index < 0 ? '' : parent.slice(0, index);
  }
  return inventory.has(`node_modules/${name}`) ? `node_modules/${name}` : null;
}

function dependencyEdges(pkg, includeDev = false) {
  dependencySections(pkg);
  const required = { ...pkg.dependencies, ...(includeDev ? pkg.devDependencies : {}) };
  const children = { ...required, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  return new Map(Object.keys(children).map((name) => {
    const optionalDependency = Object.hasOwn(pkg.optionalDependencies || {}, name);
    const optionalPeer = !Object.hasOwn(required, name) && !optionalDependency
      && pkg.peerDependenciesMeta?.[name]?.optional === true;
    const spec = pkg.optionalDependencies?.[name] ?? required[name] ?? pkg.peerDependencies?.[name];
    return [name, { optional: optionalDependency || optionalPeer, optionalPeer, specs: [spec] }];
  }));
}

function validateDependencyReachability(lock, installed, context) {
  const inventory = new Map(Object.entries(lock.packages));
  const edgesFor = (installPath) => {
    const result = dependencyEdges(inventory.get(installPath), installPath === '');
    const actual = installed.get(installPath);
    if (actual) {
      // Installed manifests are inspected too: incomplete/stale lock metadata
      // must not conceal an ordinary JS wrapper's native dependency.
      for (const [name, edge] of dependencyEdges(actual.pkg)) {
        const previous = result.get(name);
        result.set(name, previous ? {
          optional: previous.optional && edge.optional,
          optionalPeer: previous.optionalPeer && edge.optionalPeer,
          specs: [...previous.specs, ...edge.specs],
        } : edge);
      }
    }
    return result;
  };

  const omitted = new Set();
  const pendingOmissions = [...inventory].filter(([installPath, entry]) => installPath !== ''
    && !installed.has(installPath) && optionalForOtherPlatform(entry, context)).map(([installPath]) => installPath);
  while (pendingOmissions.length > 0) {
    const installPath = pendingOmissions.pop();
    if (omitted.has(installPath)) continue;
    omitted.add(installPath);
    for (const name of dependencyEdges(inventory.get(installPath)).keys()) {
      const child = resolveInstalledDependency(inventory, installPath, name);
      if (child) pendingOmissions.push(child);
    }
  }

  // Every installed package stays in scope, even if its optional parent is
  // absent. Only missing, exclusively inactive optional branches may be omitted.
  for (const installPath of ['', ...installed.keys()]) {
    for (const [name, edge] of edgesFor(installPath)) {
      const child = resolveInstalledDependency(inventory, installPath, name);
      const actual = installed.get(child);
      if (actual) {
        requireValue(!actual.alias || edge.specs.every((spec) => npmAliasTarget(spec) === actual.canonicalName),
          'Installed npm alias canonical identity does not match its dependency declaration.');
        continue;
      }
      if (edge.optionalPeer) continue;
      if (child && edge.optional && optionalForOtherPlatform(inventory.get(child), context)) continue;
      blocked(installPath === ''
        ? 'A declared dependency is not installed and cannot be checked for native code. Restore the app lock installation with npm ci.'
        : 'An installed dependency has an incomplete transitive dependency tree. Restore the app lock installation with npm ci before native verification.');
    }
  }
  for (const [installPath, entry] of inventory) {
    if (installPath !== '' && !installed.has(installPath)) {
      requireValue(entry.optional === true && omitted.has(installPath),
        'A locked dependency is not installed. Restore the app lock installation with npm ci.');
    }
  }
}

function readProjectRequirements(projectRoot) {
  requireValue(typeof projectRoot === 'string' && projectRoot.length > 0, 'A project root is required.');
  const config = readJson(path.join(projectRoot, 'app.json'), 'app.json');
  const metadata = config.expo?.extra?.powerappsNative;
  requireValue(keys(metadata, ['schemaVersion', 'templateVersion', 'nativeRuntimeVersions'])
    && metadata.schemaVersion === 1 && positiveInteger(metadata.templateVersion)
    && keys(metadata.nativeRuntimeVersions, ['android', 'ios'])
    && Object.values(metadata.nativeRuntimeVersions).every(positiveInteger), 'Missing or invalid protected app.json expo.extra.powerappsNative metadata. Use a verified template; do not invent or rewrite runtime versions.');
  return {
    schemaVersion: metadata.schemaVersion,
    templateVersion: metadata.templateVersion,
    nativeRuntimeVersions: { ...metadata.nativeRuntimeVersions },
  };
}

function readProject(projectRoot, platformContext) {
  const metadata = readProjectRequirements(projectRoot);
  const pkg = readJson(path.join(projectRoot, 'package.json'), 'package.json');
  const declarations = dependencySections(pkg);
  const lock = readJson(path.join(projectRoot, 'package-lock.json'), 'package-lock.json');
  requireValue([2, 3].includes(lock.lockfileVersion) && object(lock.packages) && object(lock.packages['']), 'A complete npm package-lock.json v2 or v3 is required to verify this runtime.');
  const lockDeclarations = dependencySections(lock.packages['']);
  for (const section of SECTIONS) {
    const declared = declarations[section] || {};
    const locked = lockDeclarations[section] || {};
    requireValue(Object.keys(declared).length === Object.keys(locked).length
      && Object.entries(declared).every(([name, version]) => locked[name] === version), 'package.json declarations do not match the app lock. Restore the approved lock and install with npm ci.');
  }
  const installed = inspectInstalledPackages(projectRoot, lock);
  for (const [installPath, entry] of Object.entries(lock.packages)) {
    if (installPath === '') continue;
    requireValue(safeInstallPath(installPath) && object(entry) && !entry.link && exactVersion(entry.version), 'Invalid or linked app lock package inventory.');
    const actual = installed.get(installPath);
    requireValue(!actual || actual.version === entry.version, 'An installed dependency version differs from the app lock. Restore the reviewed installation with npm ci.');
  }
  for (const installPath of installed.keys()) {
    requireValue(Object.hasOwn(lock.packages, installPath), 'An installed dependency is absent from the app lock. Restore the reviewed installation with npm ci.');
  }
  validateDependencyReachability(lock, installed, platformContext);
  return { metadata, declarations, lock, installed };
}

function validateProjectAgainstRelease(project, release) {
  const { declarations, installed, lock } = project;
  const managed = new Set();
  for (const section of SECTIONS) {
    for (const [name, spec] of Object.entries(release.managedDependencies[section] || {})) {
      requireValue(declarations[section]?.[name] === spec, `Managed dependency ${name} does not match the reviewed release declaration. Restore the release dependency set.`);
      requireValue(SECTIONS.every((other) => other === section || !Object.hasOwn(declarations[other] || {}, name)), 'A managed dependency is shadowed in another dependency section.');
      managed.add(name);
    }
  }
  for (const dependencies of Object.values(declarations)) {
    for (const name of Object.keys(dependencies)) {
      requireValue(managed.has(name) || !(isRuntimePackage(name) || installed.get(`node_modules/${name}`)?.native), `Native/runtime dependency ${name} is not managed by this app's verified release.`);
    }
  }
  for (const [installPath, version] of Object.entries(release.nativePackages)) {
    requireValue(installed.get(installPath)?.version === version && lock.packages[installPath]?.version === version, 'Installed native inventory does not match the reviewed release, including nested package versions. Restore the release lock and installation.');
  }
  for (const [installPath, actual] of installed) {
    requireValue(!actual.native || release.nativePackages[installPath] === actual.version, 'Unreviewed native package detected in the installed dependency tree. Select a verified runtime that includes it; JavaScript approval cannot add native code.');
  }
}

function reviewedProjectCatalog(catalog) {
  validateCatalog(catalog);
  requireValue(catalog.releases.length > 0, 'No verified mobile releases are configured. A maintainer must review public template, host, Android/iOS player and base evidence before this workflow can proceed.');
  return catalog;
}

function matchingProjectRequirements(metadata, catalog) {
  const candidates = catalog.releases.filter((release) => release.templateVersion === metadata.templateVersion
    && ['android', 'ios'].every((platform) => release.nativeRuntimeVersions[platform] === metadata.nativeRuntimeVersions[platform]));
  requireValue(candidates.length > 0, 'Protected app metadata does not match a verified release. Do not substitute the newest template or invent runtime metadata.');
  return candidates;
}

function selectProjectRelease(projectRoot, catalog = readCatalog()) {
  reviewedProjectCatalog(catalog);
  // Read-only update planning must survive host/dependency drift. This identifies
  // the source template's requirements, not an admitted installation or deployment.
  let candidates = matchingProjectRequirements(readProjectRequirements(projectRoot), catalog);
  if (candidates.length > 1) {
    // Host-only releases can share protected runtime counters. Use only the
    // installed host identity to break that tie; declarations or npm latest must
    // not choose a source record, and this still does not admit the installation.
    for (const relativePath of ['node_modules', 'node_modules/@microsoft', `node_modules/${HOST}`]) {
      const directory = path.join(projectRoot, relativePath);
      requireValue(fs.existsSync(directory), 'Protected app requirements match multiple reviewed releases and the installed host is unavailable. Restore a reviewed host installation before update planning.');
      requireValue(!fs.lstatSync(directory).isSymbolicLink(), 'Linked host installations cannot disambiguate reviewed project requirements.');
    }
    const host = readJson(path.join(projectRoot, 'node_modules', HOST, 'package.json'), 'installed host package manifest');
    requireValue(host.name === HOST && exactVersion(host.version), 'Installed host identity or version is invalid; it cannot disambiguate reviewed project requirements.');
    candidates = candidates.filter((release) => release.nativePackages[`node_modules/${HOST}`] === host.version);
  }
  requireValue(candidates.length === 1, 'Protected app requirements match multiple reviewed releases and the installed host does not identify a unique source record. A maintainer must disambiguate the policy before update planning.');
  return candidates[0];
}

function resolveProjectRelease(projectRoot, catalog = readCatalog(), platformContext = readPlatformContext()) {
  reviewedProjectCatalog(catalog);
  requireValue(keys(platformContext, ['os', 'cpu', 'libc']) && typeof platformContext.os === 'string'
    && /^[a-z0-9_-]+$/.test(platformContext.os) && typeof platformContext.cpu === 'string'
    && /^[a-z0-9_-]+$/.test(platformContext.cpu) && [null, 'glibc', 'musl'].includes(platformContext.libc),
  'A valid installation platform context is required.');
  const project = readProject(projectRoot, platformContext);
  const candidates = matchingProjectRequirements(project.metadata, catalog);
  const matches = [];
  let mismatch;
  for (const release of candidates) {
    try {
      validateProjectAgainstRelease(project, release);
      matches.push(release);
    } catch (error) {
      if (error.code !== 'MOBILE_RELEASE_BLOCKED') throw error;
      mismatch = error;
    }
  }
  if (matches.length === 0) throw mismatch;
  requireValue(matches.length === 1, 'The project matches multiple reviewed releases. A maintainer must disambiguate the release policy.');
  return matches[0];
}

function summarizeRelease(release) {
  validateRelease(release);
  // Only reviewed policy metadata: canonical package-relative inventory and
  // safe declarations are useful to planners. Never include project config,
  // absolute filesystem paths, or app lockfile resolution URLs.
  return {
    id: release.id,
    template: { ...release.template },
    templateVersion: release.templateVersion,
    nativeRuntimeVersions: { ...release.nativeRuntimeVersions },
    hostVersion: release.nativePackages[`node_modules/${HOST}`],
    managedDependencies: Object.fromEntries(Object.entries(release.managedDependencies)
      .map(([section, dependencies]) => [section, { ...dependencies }])),
    nativePackages: { ...release.nativePackages },
    platforms: Object.fromEntries(['android', 'ios'].map((platform) => [platform, {
      fingerprint: release.platforms[platform].fingerprint,
      base: { ...release.platforms[platform].base },
      player: { ...release.platforms[platform].player },
    }])),
    evidence: [...release.evidence],
  };
}

module.exports = {
  readCatalog, selectRelease, resolveProjectRelease, validateRelease, summarizeRelease,
  readProjectRequirements, selectProjectRelease,
  // Shared by the backwards-compatible write validator; not a release bypass.
  dependencySections, inspectInstalledPackages, isRuntimePackage, resolveInstalledDependency, readPlatformContext, npmAliasTarget,
  readProject, validateProjectAgainstRelease, exactVersion, declarationSpec,
};
