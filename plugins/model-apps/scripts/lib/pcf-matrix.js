'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.join(__dirname, '..', '..');
const MATRIX_RELATIVE_PATH = path.join('pcf', 'compatibility-matrix.json');
const KNOWN_HOSTS = new Set(['model', 'pages']);

function normalizeVersion(version) {
  const [core, suffix] = String(version).split('-', 2);
  return {
    parts: core.split('.').map((part) => Number.parseInt(part, 10)),
    prerelease: suffix || '',
  };
}

function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  const length = Math.max(left.parts.length, right.parts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = Number.isFinite(left.parts[index]) ? left.parts[index] : 0;
    const rightPart = Number.isFinite(right.parts[index]) ? right.parts[index] : 0;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }

  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease < right.prerelease) return -1;
  if (left.prerelease > right.prerelease) return 1;
  return 0;
}

function inRange(version, range) {
  if (range.min && compareVersions(version, range.min) < 0) return false;
  if (range.max && compareVersions(version, range.max) > 0) return false;
  return true;
}

function addRequiredObject(errors, value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${name} must be an object`);
    return false;
  }
  return true;
}

function hasSourceAndDate(value) {
  return value && typeof value.source === 'string' && value.source && typeof value.date === 'string' && value.date;
}

function validateLibrary(errors, name, library) {
  if (!addRequiredObject(errors, library, `platformLibraries.${name}`)) return;
  if (!hasSourceAndDate(library.recommendedBaseline) || typeof library.recommendedBaseline.version !== 'string') {
    errors.push(`platformLibraries.${name}.recommendedBaseline must include version, source and date`);
  }
  for (const section of ['documentedDeclarations', 'toolingAccepted', 'testedRuntime']) {
    if (!Array.isArray(library[section])) {
      errors.push(`platformLibraries.${name}.${section} must be an array`);
      continue;
    }
    for (const [index, item] of library[section].entries()) {
      if (!hasSourceAndDate(item) && section !== 'testedRuntime') {
        errors.push(`platformLibraries.${name}.${section}[${index}] must include source and date`);
      }
    }
  }
  if (!hasSourceAndDate(library.documentedRuntime)) {
    errors.push(`platformLibraries.${name}.documentedRuntime must include source and date`);
  }
}

function validateMatrix(matrix) {
  const errors = [];
  if (!addRequiredObject(errors, matrix, 'matrix')) return errors;

  if (matrix.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof matrix.reviewed !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(matrix.reviewed)) {
    errors.push('reviewed must be YYYY-MM-DD');
  }
  if (!addRequiredObject(errors, matrix.sources, 'sources')) return errors;
  if (!addRequiredObject(errors, matrix.toolchain, 'toolchain')) return errors;
  for (const tool of ['node', 'npm', 'pac', 'dotnet']) {
    if (!addRequiredObject(errors, matrix.toolchain[tool], `toolchain.${tool}`)) continue;
    if (!Object.hasOwn(matrix.toolchain[tool], 'historicalMinimum')) {
      errors.push(`toolchain.${tool}.historicalMinimum is required`);
    }
    if (!Object.hasOwn(matrix.toolchain[tool], 'tested')) errors.push(`toolchain.${tool}.tested is required`);
    if (!addRequiredObject(errors, matrix.toolchain[tool].recommended, `toolchain.${tool}.recommended`)) continue;
    if (!hasSourceAndDate(matrix.toolchain[tool].recommended) || typeof matrix.toolchain[tool].recommended.version !== 'string') {
      errors.push(`toolchain.${tool}.recommended must include version, source and date`);
    }
  }
  if (!addRequiredObject(errors, matrix.toolchain.msbuildPcf, 'toolchain.msbuildPcf')) return errors;
  if (!hasSourceAndDate(matrix.toolchain.msbuildPcf) || typeof matrix.toolchain.msbuildPcf.version !== 'string') {
    errors.push('toolchain.msbuildPcf must include version, source and date');
  }

  if (!addRequiredObject(errors, matrix.dependencySets, 'dependencySets')) return errors;
  for (const set of ['standard', 'virtual']) {
    if (!addRequiredObject(errors, matrix.dependencySets[set], `dependencySets.${set}`)) continue;
    if (typeof matrix.dependencySets[set].lockDir !== 'string') {
      errors.push(`dependencySets.${set}.lockDir must be a string`);
    }
  }

  if (!addRequiredObject(errors, matrix.platformLibraries, 'platformLibraries')) return errors;
  validateLibrary(errors, 'React', matrix.platformLibraries.React);
  validateLibrary(errors, 'Fluent', matrix.platformLibraries.Fluent);

  if (!Array.isArray(matrix.baselineExclusions)) errors.push('baselineExclusions must be an array');
  if (!addRequiredObject(errors, matrix.hosts, 'hosts')) return errors;
  for (const host of KNOWN_HOSTS) {
    if (!addRequiredObject(errors, matrix.hosts[host], `hosts.${host}`)) continue;
    if (!Array.isArray(matrix.hosts[host].controlTypes)) errors.push(`hosts.${host}.controlTypes must be an array`);
  }
  if (!Array.isArray(matrix.unsupportedPropertyTypes)) errors.push('unsupportedPropertyTypes must be an array');

  return errors;
}

function loadMatrix(deps = {}) {
  const readFs = deps.fs || fs;
  const pathApi = deps.path || path;
  const root = deps.root || DEFAULT_ROOT;
  const file = pathApi.join(root, MATRIX_RELATIVE_PATH);
  const matrix = JSON.parse(readFs.readFileSync(file, 'utf8'));
  const errors = validateMatrix(matrix);
  if (errors.length) {
    throw new Error(`compatibility-matrix.json: ${errors.join('; ')}`);
  }
  return matrix;
}

function dependencySet(matrix, kind) {
  if (!['standard', 'virtual'].includes(kind)) throw new Error(`Unknown PCF dependency set: ${kind}`);
  const lockDir = path.join(DEFAULT_ROOT, matrix.dependencySets[kind].lockDir);
  const packageJson = JSON.parse(fs.readFileSync(path.join(lockDir, 'package.json'), 'utf8'));
  return {
    lockDir,
    dependencies: { ...(packageJson.dependencies || {}) },
    devDependencies: { ...(packageJson.devDependencies || {}) },
  };
}

function hostPolicy(matrix, host) {
  if (!KNOWN_HOSTS.has(host)) throw new Error(`Unknown PCF host: ${host}`);
  const policy = { ...matrix.hosts[host] };
  if (host === 'pages') {
    policy.unsupportedPropertyTypes = [...matrix.unsupportedPropertyTypes];
  }
  return policy;
}

function declarationMatches(declaration, version) {
  if (declaration.version) return compareVersions(version, declaration.version) === 0;
  return inRange(version, { min: declaration.min, max: declaration.max });
}

function fluentFamily(version) {
  return String(version).startsWith('8.') ? 'v8' : String(version).startsWith('9.') ? 'v9' : 'unknown';
}

function platformLibraryFindings(matrix, declared, hosts) {
  const findings = [];
  const libraries = matrix.platformLibraries || {};
  const declaredFluentFamilies = new Set();

  if (hosts.includes('pages') && declared.length > 0) {
    findings.push({
      code: 'PCF_PAGES_PLATFORM_LIBRARY',
      severity: 'error',
      message: 'Power Pages does not support platform-library declarations; use a standard control bundle for Pages.',
      fix: 'Remove platform-library elements when targeting Power Pages.',
    });
  }

  for (const item of declared) {
    const library = libraries[item.name];
    if (!library) {
      findings.push({
        code: 'PCF_PLATFORM_LIB_UNKNOWN',
        severity: 'error',
        message: `Unknown platform library '${item.name}'.`,
      });
      continue;
    }

    const inDocumentedRange = library.documentedDeclarations.some((declaration) => declarationMatches(declaration, item.version));
    if (!inDocumentedRange) {
      findings.push({
        code: 'PCF_PLATFORM_LIB_RANGE',
        severity: 'warning',
        message: `${item.name} ${item.version} is outside the Microsoft Learn documented declaration range.`,
        fix: `Use ${library.recommendedBaseline.version}.`,
      });
    }

    const exclusion = (matrix.baselineExclusions || []).find(
      (entry) => entry.library === item.name && compareVersions(entry.version, item.version) === 0,
    );
    if (exclusion) {
      findings.push({
        code: 'PCF_PLATFORM_LIB_KNOWN_BAD',
        severity: exclusion.scope === 'observed-rejection' ? 'error' : 'warning',
        message: `${item.name} ${item.version} is excluded from the baseline: ${exclusion.reason}`,
        fix: `Use ${library.recommendedBaseline.version}.`,
      });
    }

    if (item.name === 'Fluent') declaredFluentFamilies.add(fluentFamily(item.version));
  }

  if (declaredFluentFamilies.has('v8') && declaredFluentFamilies.has('v9')) {
    findings.push({
      code: 'PCF_FLUENT_8_AND_9',
      severity: 'error',
      message: 'Fluent 8 and Fluent 9 cannot both be specified in the same manifest.',
      fix: 'Choose one Fluent family for the control.',
    });
  }

  return findings;
}

function renderRequirement(requirement) {
  const parts = [];
  if (requirement.siteVersion) parts.push(`site ${requirement.siteVersion.min}`);
  if (requirement.starterPackageVersion) parts.push(`starter package ${requirement.starterPackageVersion.min}`);
  if (requirement.basePackageVersion) parts.push(`base package ${requirement.basePackageVersion.min}`);
  return parts.join(', ');
}

function renderHostsTable(matrix) {
  const pages = matrix.hosts.pages;
  const requirements = Object.entries(pages.requirements)
    .map(([capability, requirement]) => `${capability}: ${renderRequirement(requirement)}`)
    .join('<br>');

  return [
    '<!-- pcf-matrix:begin -->',
    '| Host | Control types | Platform libraries | Key rules |',
    '| --- | --- | --- | --- |',
    `| ${matrix.hosts.model.displayName} | ${matrix.hosts.model.controlTypes.join(', ')} | supported | Virtual controls declare React ${matrix.platformLibraries.React.recommendedBaseline.version} and Fluent ${matrix.platformLibraries.Fluent.recommendedBaseline.version}. |`,
    `| ${pages.displayName} | ${pages.controlTypes.join(', ')} | not supported | ${requirements}; required features must not be true; unsupported property types include ${matrix.unsupportedPropertyTypes.join(', ')}. |`,
    '<!-- pcf-matrix:end -->',
    '',
  ].join('\n');
}

module.exports = {
  loadMatrix,
  validateMatrix,
  compareVersions,
  inRange,
  dependencySet,
  hostPolicy,
  platformLibraryFindings,
  renderHostsTable,
};
