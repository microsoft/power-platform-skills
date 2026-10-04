#!/usr/bin/env node
'use strict';

const https = require('https');
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  KNOWN_PACKAGES,
  LOCALIZATION_CAPABILITIES,
  MAX_MODE_EVIDENCE_ENTRIES,
  resolveProjectRelativePath,
} = require('./lib/localization-config');
const { detectFramework } = require('./lib/framework-detection');
const {
  AUTOMATICALLY_ACCEPTED_LICENSES,
  assessPackageLicense,
  normalizeLicense,
} = require('./lib/package-license-policy');

const MAX_EVIDENCE_TEXT_CHARS = 200000;
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

function parseIpv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function parseIpv6(address) {
  let normalized = address.toLowerCase().split('%')[0];
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (!ipv4) return null;
    normalized = normalized.slice(0, lastColon) +
      `:${((ipv4[0] << 8) | ipv4[1]).toString(16)}` +
      `:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) ||
      (halves.length === 2 && missing < 1)) {
    return null;
  }
  const words = [...left, ...Array(missing).fill('0'), ...right];
  if (words.length !== 8 ||
      words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) {
    return null;
  }
  return words.reduce(
    (value, word) => (value << 16n) | BigInt(Number.parseInt(word, 16)),
    0n
  );
}

function matchesIpv6Prefix(value, prefix, bits) {
  const prefixValue = parseIpv6(prefix);
  const shift = BigInt(128 - bits);
  return prefixValue !== null && (value >> shift) === (prefixValue >> shift);
}

function isPublicIpAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = parseIpv4(address);
    const [a, b, c] = parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family !== 6) return false;

  const value = parseIpv6(address);
  if (value === null || value === 0n || value === 1n) return false;
  // IPv4-mapped IPv6 addresses inherit the IPv4 address classification.
  if ((value >> 32n) === 0xFFFFn) {
    const ipv4 = Number(value & 0xFFFFFFFFn);
    return isPublicIpAddress([
      (ipv4 >>> 24) & 0xFF,
      (ipv4 >>> 16) & 0xFF,
      (ipv4 >>> 8) & 0xFF,
      ipv4 & 0xFF,
    ].join('.'));
  }
  return !(
    matchesIpv6Prefix(value, '::', 96) ||
    matchesIpv6Prefix(value, '100::', 64) || // discard-only
    matchesIpv6Prefix(value, 'fc00::', 7) ||
    matchesIpv6Prefix(value, 'fe80::', 10) ||
    matchesIpv6Prefix(value, 'fec0::', 10) || // deprecated site-local
    matchesIpv6Prefix(value, 'ff00::', 8) ||
    matchesIpv6Prefix(value, '2001::', 23) || // IETF protocol assignments
    matchesIpv6Prefix(value, '2001:db8::', 32) || // documentation
    matchesIpv6Prefix(value, '2002::', 16) || // 6to4
    matchesIpv6Prefix(value, '3fff::', 20) || // documentation
    matchesIpv6Prefix(value, '5f00::', 16) || // segment-routing local-use
    matchesIpv6Prefix(value, '64:ff9b::', 96) || // NAT64
    matchesIpv6Prefix(value, '64:ff9b:1::', 48) // local-use NAT64
  );
}

async function resolvePublicHostname(hostname, lookup = dns.promises.lookup) {
  const resolved = await lookup(hostname, { all: true, verbatim: true });
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (!addresses.length ||
      addresses.some(({ address, family }) =>
        !isPublicIpAddress(address) || ![4, 6].includes(family)
      )) {
    throw new Error(
      'Package documentation hostname must resolve only to public IP addresses.'
    );
  }
  return addresses;
}

function createPinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, addresses.map(({ address, family }) => ({ address, family })));
      return;
    }
    const requestedFamily = typeof options === 'number' ? options : options?.family;
    const selected = addresses.find(({ family }) =>
      !requestedFamily || family === requestedFamily
    );
    if (!selected) {
      callback(new Error('No validated public address matches the requested family.'));
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

async function fetchText(
  url,
  request = https.get,
  redirectsRemaining = 3,
  allowedHostname = new URL(url).hostname,
  lookup = dns.promises.lookup
) {
  const parsedUrl = new URL(url);
  const addresses = await resolvePublicHostname(parsedUrl.hostname, lookup);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: { Accept: 'text/html,text/plain' },
      lookup: createPinnedLookup(addresses),
    }, (response) => {
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
          allowedHostname,
          lookup
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

function isPrerelease(version) {
  return String(version || '').includes('-');
}

function majorOf(versionRange) {
  const match = String(versionRange || '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function resolveVersionsWithNpm(packageName, versionSpec = 'latest', execute = execFileSync) {
  const npmArgs = ['view', `${packageName}@${versionSpec}`, 'version', '--json'];
  // Keep both executable names as fixed literals so package input can only
  // populate argv. Windows resolves npm through npm.cmd; other platforms use npm.
  const output = process.platform === 'win32'
    ? execute('npm.cmd', npmArgs, {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      shell: false,
    })
    : execute('npm', npmArgs, {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      shell: false,
    });
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

function extractEvidenceText(content) {
  const decodeNumericEntity = (rawCode, radix) => {
    const codePoint = Number.parseInt(rawCode, radix);
    return Number.isInteger(codePoint) &&
      codePoint >= 0 &&
      codePoint <= 0x10FFFF &&
      !(codePoint >= 0xD800 && codePoint <= 0xDFFF)
      ? String.fromCodePoint(codePoint)
      : '\uFFFD';
  };
  const withoutActiveContent = String(content || '')
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?(?:<\/noscript>|$)/gi, ' ');
  const decoded = withoutActiveContent
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => decodeNumericEntity(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => decodeNumericEntity(code, 16));
  const normalized = decoded.replace(/\s+/g, ' ').trim();
  return {
    text: normalized.slice(0, MAX_EVIDENCE_TEXT_CHARS),
    truncated: normalized.length > MAX_EVIDENCE_TEXT_CHARS,
  };
}

function validateModeEvidenceClassification(
  classification,
  { mode, evidenceUrl, documentText }
) {
  if (!classification || typeof classification !== 'object' ||
      Array.isArray(classification)) {
    throw new Error('Mode evidence classification must be a JSON object.');
  }
  if (classification.requestedMode !== mode) {
    throw new Error(`Mode evidence classification requestedMode must be "${mode}".`);
  }
  if (!['supported', 'unsupported', 'inconclusive'].includes(
    classification.classification
  )) {
    throw new Error(
      'Mode evidence classification must be supported, unsupported, or inconclusive.'
    );
  }
  if (typeof classification.explanation !== 'string' ||
      !classification.explanation.trim() ||
      classification.explanation.length > 2000) {
    throw new Error(
      'Mode evidence classification explanation must be a non-empty string of at most 2000 characters.'
    );
  }
  if (!Array.isArray(classification.evidence) ||
      classification.evidence.length > MAX_MODE_EVIDENCE_ENTRIES) {
    throw new Error(
      `Mode evidence classification evidence must be an array of at most ${MAX_MODE_EVIDENCE_ENTRIES} entries.`
    );
  }
  if (!Array.isArray(classification.supportConditions) ||
      classification.supportConditions.length > 20 ||
      classification.supportConditions.some((condition) =>
        typeof condition !== 'string' ||
        !condition.trim() ||
        condition.length > 500
      )) {
    throw new Error(
      'Mode evidence classification supportConditions must contain at most 20 non-empty strings of at most 500 characters.'
    );
  }
  if (classification.classification !== 'inconclusive' &&
      classification.evidence.length === 0) {
    throw new Error(
      'Supported or unsupported mode evidence classifications require an exact quotation.'
    );
  }

  const normalizedDocument = String(documentText || '').replace(/\s+/g, ' ').trim();
  const evidence = classification.evidence.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.quote !== 'string' || !entry.quote.trim() ||
        entry.quote.length > 2000 ||
        typeof entry.explanation !== 'string' || !entry.explanation.trim() ||
        entry.explanation.length > 2000) {
      throw new Error(
        'Each mode evidence entry must contain a non-empty quote and explanation of at most 2000 characters.'
      );
    }
    const normalizedQuote = entry.quote.replace(/\s+/g, ' ').trim();
    if (!normalizedDocument.includes(normalizedQuote)) {
      throw new Error(
        'Mode evidence quotation was not found in the fetched official documentation.'
      );
    }
    return {
      quote: normalizedQuote,
      explanation: entry.explanation.trim(),
    };
  });

  return {
    requestedMode: mode,
    classification: classification.classification,
    explanation: classification.explanation.trim(),
    evidence,
    supportConditions: classification.supportConditions.map((condition) =>
      condition.trim()
    ),
    evidenceUrl,
  };
}

function assessModeSupport(packageName, mode, metadata, classification = null) {
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
  if (classification?.classification === 'supported') {
    return {
      status: 'supported',
      source: 'official-documentation',
      detail: classification.explanation,
      classification,
    };
  }
  if (classification?.classification === 'unsupported') {
    return {
      status: 'unsupported',
      source: 'official-documentation',
      detail: classification.explanation,
      classification,
    };
  }
  return {
    status: 'inconclusive',
    source: classification ? 'official-documentation' : 'none',
    detail:
      classification?.explanation ||
      `Package health and compatibility can be checked, but ${mode} localization ` +
      'requires agent classification of official documentation.',
    classification,
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
    '.localhost',
    '.local',
    '.internal',
    '.lan',
    '.home',
    '.test',
    '.invalid',
    '.example',
  ];
  // URL normalizes host casing, and the trailing-dot removal also rejects the
  // fully-qualified loopback spelling `localhost.`.
  const hostname = parsed.hostname.replace(/\.$/, '');
  if (hostname === 'localhost' || !hostname.includes('.') ||
      reservedSuffixes.some((suffix) => hostname.endsWith(suffix)) ||
      net.isIP(hostname)) {
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
  const failureCodes = [];
  const warnings = [];
  const licenseAssessment = assessPackageLicense(metadata.license);
  const license = licenseAssessment.license;
  const licenseReviewConfirmed = Boolean(options.confirmLicenseReview);
  const publishedAt = metadata.time?.[version] || metadata.publishedAt;
  const ageLimit = new Date(now);
  ageLimit.setUTCMonth(ageLimit.getUTCMonth() - 24);

  function addFailure(code, message) {
    failureCodes.push(code);
    failures.push(message);
  }

  const licenseAccepted =
    licenseAssessment.automaticallyAccepted ||
    licenseReviewConfirmed;

  if (!version) {
    addFailure('package-not-resolvable', 'No resolvable package version was returned.');
  }
  if (metadata.deprecated) {
    addFailure('package-deprecated', `Package version is deprecated: ${metadata.deprecated}`);
  }
  if (isPrerelease(version) && !options.allowPrerelease) {
    addFailure(
      'prerelease-not-approved',
      'Selected version is a prerelease and requires explicit confirmation.'
    );
  }
  if (!licenseAssessment.automaticallyAccepted && !licenseReviewConfirmed) {
    failureCodes.push(
      licenseAssessment.classification === 'unknown'
        ? 'license-unknown'
        : 'license-review-required'
    );
    warnings.push(licenseAssessment.reason);
  }
  if (!publishedAt || new Date(publishedAt) < ageLimit) {
    addFailure(
      'package-stale',
      'Selected package has not published this version within the previous 24 months.'
    );
  }
  if (!packageSupportsFramework(packageName, framework, peerDependencies)) {
    addFailure(
      'framework-not-supported',
      `Package metadata does not demonstrate ${framework} framework support.`
    );
  }
  const relevantPeers =
    LOCALIZATION_CAPABILITIES.frameworks[framework]?.frameworkPeers || [];
  for (const peerName of relevantPeers) {
    if (!peerDependencies[peerName]) continue;
    const projectVersion = frameworkVersions[peerName];
    if (!projectVersion ||
        !rangeSatisfies(peerName, projectVersion, peerDependencies[peerName])) {
      addFailure(
        'framework-peer-incompatible',
        `Peer dependency ${peerName} "${peerDependencies[peerName]}" ` +
        `does not support project version "${projectVersion || 'not installed'}".`
      );
    }
  }
  if (framework === 'angular') {
    const projectMajor = majorOf(frameworkVersion);
    if (packageName.startsWith('@angular/') && majorOf(version) !== projectMajor) {
      addFailure(
        'angular-major-mismatch',
        `Official Angular package major ${majorOf(version)} must match project major ${projectMajor}.`
      );
    }
  }
  if (!metadata.homepage && !metadata.repository) {
    addFailure(
      'documentation-missing',
      'Package metadata does not provide official documentation or a repository.'
    );
  }
  const modeEvidence = assessModeSupport(
    packageName,
    mode,
    metadata,
    options.modeEvidenceClassification
  );
  if (modeEvidence.status === 'unsupported') {
    addFailure('mode-unsupported', modeEvidence.detail);
  } else if (modeEvidence.status === 'inconclusive') {
    failureCodes.push('mode-inconclusive');
    warnings.push(modeEvidence.detail);
  }
  if (options.modeEvidenceError) {
    failureCodes.push('documentation-fetch-failed');
    warnings.push(`Official mode evidence could not be read: ${options.modeEvidenceError}`);
  }
  const approvedUnverified = failures.length === 0 &&
    licenseAccepted &&
    modeEvidence.status === 'inconclusive' &&
    Boolean(options.allowUnverifiedMode);
  const viable = failures.length === 0 &&
    licenseAccepted &&
    (modeEvidence.status === 'supported' || approvedUnverified);
  const status = failures.length || modeEvidence.status === 'unsupported'
    ? 'unsupported'
    : !licenseAccepted || modeEvidence.status === 'inconclusive'
      ? 'inconclusive'
      : 'supported';

  return {
    viable,
    status,
    verificationStatus: modeEvidence.status === 'supported'
      ? 'verified'
      : approvedUnverified
        ? 'unverified'
        : 'not-approved',
    requiresConfirmation: failures.length === 0 && (
      !licenseAccepted ||
      (modeEvidence.status === 'inconclusive' && !options.allowUnverifiedMode)
    ),
    requiresLicenseReview: !licenseAssessment.automaticallyAccepted &&
      !licenseReviewConfirmed,
    packageName,
    version,
    framework,
    frameworkVersion,
    mode,
    license,
    licenseAssessment: {
      classification: licenseAssessment.classification,
      status: licenseAssessment.automaticallyAccepted
        ? 'automatically-accepted'
        : licenseReviewConfirmed
          ? 'user-confirmed'
          : 'review-required',
      reason: licenseAssessment.reason,
    },
    publishedAt,
    prerelease: isPrerelease(version),
    modeEvidence: {
      ...modeEvidence,
      evidenceUrl: options.modeEvidenceUrl || null,
      fetchError: options.modeEvidenceError || null,
      classificationRequired: Boolean(
        !KNOWN_PACKAGES[packageName] &&
        options.modeEvidenceDocument &&
        !options.modeEvidenceClassification
      ),
      document: options.modeEvidenceDocument || null,
    },
    failureCodes: [...new Set(failureCodes)],
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
    if (key === '--allowPrerelease' || key === '--allowUnverifiedMode' ||
        key === '--confirmLicenseReview') {
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
      '[--modeEvidenceClassificationFile <project-relative-json-path>] ' +
      '[--allowPrerelease] [--allowUnverifiedMode] ' +
      '[--confirmLicenseReview]'
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
  let modeEvidenceDocument = null;
  let modeEvidenceClassification = null;
  let modeEvidenceUrl = null;
  let modeEvidenceError = null;
  if (args.modeEvidenceUrl) {
    modeEvidenceUrl = validateModeEvidenceUrl(args.modeEvidenceUrl, metadata);
    try {
      const fetched = await fetchText(modeEvidenceUrl);
      const extracted = extractEvidenceText(fetched);
      modeEvidenceDocument = {
        url: modeEvidenceUrl,
        text: extracted.text,
        truncated: extracted.truncated,
      };
    } catch (error) {
      // A documentation outage must not turn uncertainty into a hard package
      // rejection. Preserve the URL and return the normal inconclusive flow.
      modeEvidenceError = error.message;
    }
  }
  if (args.modeEvidenceClassificationFile) {
    if (!modeEvidenceDocument) {
      throw new Error(
        'Mode evidence classification requires successfully fetched official documentation.'
      );
    }
    const classificationPath = resolveProjectRelativePath(
      projectRoot,
      args.modeEvidenceClassificationFile
    );
    if (!classificationPath.valid || !fs.existsSync(classificationPath.path) ||
        !fs.statSync(classificationPath.path).isFile()) {
      throw new Error(
        'Mode evidence classification file must be a project-relative JSON file inside the project root.'
      );
    }
    let classification;
    try {
      classification = JSON.parse(fs.readFileSync(classificationPath.path, 'utf8'));
    } catch {
      throw new Error('Mode evidence classification file must contain valid JSON.');
    }
    modeEvidenceClassification = validateModeEvidenceClassification(classification, {
      mode: args.mode,
      evidenceUrl: modeEvidenceUrl,
      documentText: modeEvidenceDocument.text,
    });
  }
  const result = evaluatePackage(metadata, {
    packageName: args.package,
    framework,
    frameworkVersion,
    frameworkVersions,
    mode: args.mode,
    allowPrerelease: args.allowPrerelease,
    allowUnverifiedMode: args.allowUnverifiedMode,
    confirmLicenseReview: args.confirmLicenseReview,
    modeEvidenceClassification,
    modeEvidenceDocument,
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
  AUTOMATICALLY_ACCEPTED_LICENSES,
  assessModeSupport,
  evaluatePackage,
  extractEvidenceText,
  fetchJson,
  fetchText,
  isPrerelease,
  isPublicIpAddress,
  majorOf,
  modeSupported,
  normalizeLicense,
  packageSupportsFramework,
  peerRangeAllowsMajor,
  resolveInstalledVersion,
  resolvePublicHostname,
  resolveVersionsWithNpm,
  resolveVersionWithNpm,
  versionSatisfiesRangeWithNpm,
  validateModeEvidenceUrl,
  resolvePackage,
  selectFramework,
  validateModeEvidenceClassification,
};
