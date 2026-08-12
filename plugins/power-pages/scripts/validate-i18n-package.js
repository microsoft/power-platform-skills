#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  KNOWN_PACKAGES,
  LOCALIZATION_CAPABILITIES,
  detectFramework,
} = require('./lib/localization-config');

const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
]);
function fetchJson(url, request = https.get) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { Accept: 'application/json' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`npm registry returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('npm registry returned invalid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout?.(15000, () => req.destroy(new Error('npm registry request timed out')));
  });
}

function fetchText(
  url,
  request = https.get,
  redirectsRemaining = 3,
  allowedHostname = new URL(url).hostname
) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { Accept: 'text/html,text/plain' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 &&
          response.headers.location && redirectsRemaining > 0) {
        response.resume();
        const redirectUrl = new URL(response.headers.location, url).toString();
        const parsedRedirect = new URL(redirectUrl);
        if (parsedRedirect.protocol !== 'https:' ||
            parsedRedirect.hostname !== allowedHostname) {
          reject(new Error('Package documentation redirected outside its approved HTTPS host.'));
          return;
        }
        fetchText(
          redirectUrl,
          request,
          redirectsRemaining - 1,
          allowedHostname
        ).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`Package documentation returned HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) {
          req.destroy(new Error('Package documentation exceeds the 1 MiB evidence limit'));
        }
      });
      response.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout?.(15000, () =>
      req.destroy(new Error('Package documentation request timed out'))
    );
  });
}

function normalizeLicense(license) {
  if (typeof license === 'string') return license;
  if (license && typeof license.type === 'string') return license.type;
  return '';
}

function isPrerelease(version) {
  return String(version || '').includes('-');
}

function majorOf(versionRange) {
  const match = String(versionRange || '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function resolveVersionsWithNpm(packageName, versionSpec = 'latest', execute = execFileSync) {
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const output = execute(
    npmExecutable,
    ['view', `${packageName}@${versionSpec}`, 'version', '--json'],
    { encoding: 'utf8', timeout: 30000, windowsHide: true }
  );
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
}

function resolveVersionWithNpm(packageName, versionSpec = 'latest', execute = execFileSync) {
  const resolved = resolveVersionsWithNpm(packageName, versionSpec, execute).at(-1);
  if (!resolved) throw new Error(`No published version satisfies "${versionSpec}".`);
  return resolved;
}

function versionSatisfiesRangeWithNpm(packageName, version, range, execute = execFileSync) {
  return resolveVersionsWithNpm(packageName, range, execute).includes(version);
}

function peerRangeAllowsMajor(range, major) {
  if (!range || major === null) return true;
  const alternatives = String(range).split('||').map((value) => value.trim());
  return alternatives.some((alternative) => {
    const exactMajors = [...alternative.matchAll(/(?:^|[^\d])(\d+)(?:\.\d+)?(?:\.\d+)?/g)]
      .map((match) => Number(match[1]));
    if (alternative.includes('>=')) {
      const minimum = majorOf(alternative.match(/>=\s*([^\s]+)/)?.[1]);
      const upperMatch = alternative.match(/<\s*(\d+)/);
      const upper = upperMatch ? Number(upperMatch[1]) : Infinity;
      return minimum !== null && major >= minimum && major < upper;
    }
    return exactMajors.includes(major);
  });
}

function assessModeSupport(packageName, mode, metadata, additionalEvidence = '') {
  const known = KNOWN_PACKAGES[packageName];
  if (known) {
    if (known.mode === mode) {
      return {
        status: 'supported',
        source: 'known-capability',
        detail: `${packageName} is registered for ${known.framework} ${known.mode} localization.`,
      };
    }
    return {
      status: 'unsupported',
      source: 'known-capability',
      detail: `${packageName} is registered for ${known.mode}, not ${mode}, localization.`,
    };
  }
  const searchable = [
    ...(metadata.keywords || []),
    metadata.description || '',
    metadata.readme || '',
    additionalEvidence,
  ].join(' ').toLowerCase();
  const supported = mode === 'runtime'
    ? /runtime|language switch|change language|dynamic locale/.test(searchable)
    : /build[- ]time|compile[- ]time|static localization|localized build/.test(searchable);
  if (supported) {
    return {
      status: 'supported',
      source: additionalEvidence ? 'official-documentation' : 'package-documentation',
      detail: `Package documentation contains evidence of ${mode} localization support.`,
    };
  }
  return {
    status: 'inconclusive',
    source: 'none',
    detail:
      `Package health and compatibility can be checked, but the available documentation ` +
      `does not establish ${mode} localization support.`,
  };
}

function modeSupported(packageName, mode, metadata) {
  return assessModeSupport(packageName, mode, metadata).status === 'supported';
}

function normalizeDocumentationUrl(value) {
  const raw = typeof value === 'string' ? value : value?.url;
  if (!raw) return null;
  let normalized = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/');
  normalized = normalized.replace(/\.git$/, '');
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function validateModeEvidenceUrl(evidenceUrl, metadata) {
  let parsed;
  try {
    parsed = new URL(evidenceUrl);
  } catch {
    throw new Error('Mode evidence URL must be a valid HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Mode evidence URL must use HTTPS.');
  }
  // npm metadata is package-author controlled, so matching its hostname alone
  // is not enough to make a documentation fetch safe. Reject address literals,
  // single-label hosts, and reserved/internal DNS suffixes before any request.
  const reservedSuffixes = [
    '.local',
    '.internal',
    '.lan',
    '.home',
    '.test',
    '.invalid',
    '.example',
  ];
  if (parsed.hostname === 'localhost' || !parsed.hostname.includes('.') ||
      reservedSuffixes.some((suffix) => parsed.hostname.endsWith(suffix)) ||
      net.isIP(parsed.hostname)) {
    throw new Error('Mode evidence URL must use a public documentation hostname.');
  }
  const officialUrls = [
    normalizeDocumentationUrl(metadata.homepage),
    normalizeDocumentationUrl(metadata.repository),
  ].filter(Boolean);
  if (!officialUrls.some((official) => official.hostname === parsed.hostname)) {
    throw new Error(
      'Mode evidence URL must use the package homepage or repository hostname from npm metadata.'
    );
  }
  return parsed.toString();
}

function packageSupportsFramework(packageName, framework, peerDependencies = {}) {
  if (KNOWN_PACKAGES[packageName]?.framework === framework) return true;
  const peerNames = LOCALIZATION_CAPABILITIES.frameworks[framework]?.frameworkPeers || [];
  return peerNames.some((name) => Object.hasOwn(peerDependencies, name));
}

function selectFramework(detection, requestedFramework) {
  if (detection.framework) {
    if (requestedFramework && requestedFramework !== detection.framework) return null;
    return detection.framework;
  }
  if (requestedFramework && detection.candidates.includes(requestedFramework)) {
    return requestedFramework;
  }
  return null;
}

function evaluatePackage(metadata, options) {
  const { packageName, framework, frameworkVersion, mode, now = new Date() } = options;
  const version = metadata.version;
  const peerDependencies = metadata.peerDependencies || {};
  const rangeSatisfies = options.rangeSatisfies || versionSatisfiesRangeWithNpm;
  const frameworkVersions = options.frameworkVersions || {
    [{
      react: 'react',
      vue: 'vue',
      angular: '@angular/core',
      astro: 'astro',
    }[framework]]: frameworkVersion,
  };
  const failures = [];
  const warnings = [];
  const license = normalizeLicense(metadata.license);
  const publishedAt = metadata.time?.[version] || metadata.publishedAt;
  const ageLimit = new Date(now);
  ageLimit.setUTCMonth(ageLimit.getUTCMonth() - 24);

  if (!version) failures.push('No resolvable package version was returned.');
  if (metadata.deprecated) failures.push(`Package version is deprecated: ${metadata.deprecated}`);
  if (isPrerelease(version) && !options.allowPrerelease) {
    failures.push('Selected version is a prerelease and requires explicit confirmation.');
  }
  if (!ALLOWED_LICENSES.has(license)) {
    failures.push(`License "${license || 'unknown'}" is not in the approved permissive-license list.`);
  }
  if (!publishedAt || new Date(publishedAt) < ageLimit) {
    failures.push('Selected package has not published this version within the previous 24 months.');
  }
  if (!packageSupportsFramework(packageName, framework, peerDependencies)) {
    failures.push(`Package metadata does not demonstrate ${framework} framework support.`);
  }
  const relevantPeers =
    LOCALIZATION_CAPABILITIES.frameworks[framework]?.frameworkPeers || [];
  for (const peerName of relevantPeers) {
    if (!peerDependencies[peerName]) continue;
    const projectVersion = frameworkVersions[peerName];
    if (!projectVersion ||
        !rangeSatisfies(peerName, projectVersion, peerDependencies[peerName])) {
      failures.push(
        `Peer dependency ${peerName} "${peerDependencies[peerName]}" ` +
        `does not support project version "${projectVersion || 'not installed'}".`
      );
    }
  }
  if (framework === 'angular') {
    const projectMajor = majorOf(frameworkVersion);
    if (packageName.startsWith('@angular/') && majorOf(version) !== projectMajor) {
      failures.push(
        `Official Angular package major ${majorOf(version)} must match project major ${projectMajor}.`
      );
    }
  }
  if (!metadata.homepage && !metadata.repository) {
    failures.push('Package metadata does not provide official documentation or a repository.');
  }
  const modeEvidence = assessModeSupport(
    packageName,
    mode,
    metadata,
    options.modeEvidenceText
  );
  if (modeEvidence.status === 'unsupported') {
    failures.push(modeEvidence.detail);
  } else if (modeEvidence.status === 'inconclusive') {
    warnings.push(modeEvidence.detail);
  }
  if (options.modeEvidenceError) {
    warnings.push(`Official mode evidence could not be read: ${options.modeEvidenceError}`);
  }
  const approvedUnverified = failures.length === 0 &&
    modeEvidence.status === 'inconclusive' &&
    Boolean(options.allowUnverifiedMode);
  const viable = failures.length === 0 &&
    (modeEvidence.status === 'supported' || approvedUnverified);
  const status = failures.length || modeEvidence.status === 'unsupported'
    ? 'unsupported'
    : modeEvidence.status;

  return {
    viable,
    status,
    verificationStatus: modeEvidence.status === 'supported'
      ? 'verified'
      : approvedUnverified
        ? 'unverified'
        : 'not-approved',
    requiresConfirmation: failures.length === 0 &&
      modeEvidence.status === 'inconclusive' &&
      !options.allowUnverifiedMode,
    packageName,
    version,
    framework,
    frameworkVersion,
    mode,
    license,
    publishedAt,
    prerelease: isPrerelease(version),
    modeEvidence: {
      ...modeEvidence,
      evidenceUrl: options.modeEvidenceUrl || null,
      fetchError: options.modeEvidenceError || null,
    },
    failures,
    warnings,
  };
}

async function resolvePackage(
  packageName,
  versionSpec = 'latest',
  request,
  resolveVersion = resolveVersionWithNpm
) {
  const encodedName = encodeURIComponent(packageName);
  const resolvedVersion = resolveVersion(packageName, versionSpec);
  const packageMetadata = await fetchJson(`https://registry.npmjs.org/${encodedName}`, request);
  const versionMetadata = packageMetadata.versions?.[resolvedVersion];
  if (!versionMetadata) {
    throw new Error(`npm metadata is missing resolved version ${resolvedVersion}.`);
  }
  return {
    ...versionMetadata,
    readme: packageMetadata.readme,
    time: packageMetadata.time,
  };
}

function resolveInstalledVersion(projectRoot, packageName, versionSpec) {
  const installed = path.join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json');
  if (fs.existsSync(installed)) {
    const installedMetadata = JSON.parse(fs.readFileSync(installed, 'utf8'));
    if (installedMetadata.version) return installedMetadata.version;
  }
  const lockPath = path.join(projectRoot, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const lockedVersion = lock.packages?.[`node_modules/${packageName}`]?.version ||
      lock.dependencies?.[packageName]?.version;
    if (lockedVersion) return lockedVersion;
  }
  for (const unsupportedLock of ['pnpm-lock.yaml', 'yarn.lock']) {
    if (fs.existsSync(path.join(projectRoot, unsupportedLock))) {
      throw new Error(
        `Cannot determine the exact installed version of ${packageName} from ${unsupportedLock}. ` +
        'Install project dependencies before validating the localization package.'
      );
    }
  }
  return resolveVersionWithNpm(packageName, versionSpec);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--allowPrerelease' || key === '--allowUnverifiedMode') {
      args[key.slice(2)] = true;
      continue;
    }
    if (key.startsWith('--')) {
      args[key.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectRoot || !args.package || !args.mode) {
    throw new Error(
      'Usage: validate-i18n-package.js --projectRoot <path> --package <name> ' +
      '[--framework <detected-candidate>] [--version <range>] ' +
      '--mode <runtime|static> [--modeEvidenceUrl <official-https-url>] ' +
      '[--allowPrerelease] [--allowUnverifiedMode]'
    );
  }
  const projectRoot = path.resolve(args.projectRoot);
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const detection = detectFramework(projectRoot);
  const framework = selectFramework(detection, args.framework);
  if (!framework) {
    throw new Error(
      'Cannot validate package because the selected framework is not supported by project evidence.'
    );
  }
  const frameworkPeers =
    LOCALIZATION_CAPABILITIES.frameworks[framework]?.frameworkPeers || [];
  const frameworkDependency = frameworkPeers[0];
  const projectDependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  const frameworkVersionSpec = projectDependencies[frameworkDependency];
  const frameworkVersion = resolveInstalledVersion(
    projectRoot,
    frameworkDependency,
    frameworkVersionSpec
  );
  const frameworkVersions = {};
  for (const peerName of frameworkPeers) {
    if (!projectDependencies[peerName]) continue;
    frameworkVersions[peerName] = resolveInstalledVersion(
      projectRoot,
      peerName,
      projectDependencies[peerName]
    );
  }
  const metadata = await resolvePackage(args.package, args.version || 'latest');
  let modeEvidenceText = '';
  let modeEvidenceUrl = null;
  let modeEvidenceError = null;
  if (args.modeEvidenceUrl) {
    modeEvidenceUrl = validateModeEvidenceUrl(args.modeEvidenceUrl, metadata);
    try {
      modeEvidenceText = await fetchText(modeEvidenceUrl);
    } catch (error) {
      // A documentation outage must not turn uncertainty into a hard package
      // rejection. Preserve the URL and return the normal inconclusive flow.
      modeEvidenceError = error.message;
    }
  }
  const result = evaluatePackage(metadata, {
    packageName: args.package,
    framework,
    frameworkVersion,
    frameworkVersions,
    mode: args.mode,
    allowPrerelease: args.allowPrerelease,
    allowUnverifiedMode: args.allowUnverifiedMode,
    modeEvidenceText,
    modeEvidenceUrl,
    modeEvidenceError,
    rangeSatisfies: versionSatisfiesRangeWithNpm,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.viable ? 0 : 1;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_LICENSES,
  assessModeSupport,
  evaluatePackage,
  fetchJson,
  fetchText,
  isPrerelease,
  majorOf,
  modeSupported,
  normalizeLicense,
  packageSupportsFramework,
  peerRangeAllowsMajor,
  resolveInstalledVersion,
  resolveVersionsWithNpm,
  resolveVersionWithNpm,
  versionSatisfiesRangeWithNpm,
  validateModeEvidenceUrl,
  resolvePackage,
  selectFramework,
};
