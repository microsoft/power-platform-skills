'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assessModeSupport,
  evaluatePackage,
  packageSupportsFramework,
  peerRangeAllowsMajor,
  resolveInstalledVersion,
  resolveVersionWithNpm,
  selectFramework,
  validateModeEvidenceUrl,
  versionSatisfiesRangeWithNpm,
} = require('../validate-i18n-package');
const { createTempProject, writeProjectFile } = require('./test-utils');

function metadata(overrides = {}) {
  return {
    version: '16.2.0',
    license: 'MIT',
    description: 'Internationalization for React with runtime language switching',
    homepage: 'https://example.test/docs',
    peerDependencies: { react: '>=16.8.0 <20' },
    time: { '16.2.0': '2026-07-01T00:00:00.000Z' },
    ...overrides,
  };
}

function evaluationOptions(overrides = {}) {
  return {
    packageName: 'react-i18next',
    framework: 'react',
    frameworkVersion: '^19.0.0',
    frameworkVersions: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    mode: 'runtime',
    now: new Date('2026-07-30T00:00:00.000Z'),
    rangeSatisfies: (packageName, version, range) =>
      peerRangeAllowsMajor(range, Number(String(version).match(/\d+/)?.[0])),
    ...overrides,
  };
}

test('accepts a stable, maintained, compatible runtime package', () => {
  const result = evaluatePackage(metadata(), evaluationOptions());

  assert.equal(result.viable, true, result.failures.join('\n'));
});

test('uses shared package capabilities for known framework support', () => {
  assert.equal(packageSupportsFramework('react-i18next', 'react'), true);
  assert.equal(packageSupportsFramework('@angular/localize', 'react'), false);
  assert.equal(packageSupportsFramework('astro-built-in', 'astro'), true);
});

test('rejects prereleases without explicit confirmation', () => {
  const result = evaluatePackage(metadata({
    version: '17.0.0-rc.1',
    time: { '17.0.0-rc.1': '2026-07-01T00:00:00.000Z' },
  }), evaluationOptions());

  assert.equal(result.viable, false);
  assert.match(result.failures.join('\n'), /prerelease/);
  assert.deepEqual(result.failureCodes, ['prerelease-not-approved']);
});

test('rejects stale, deprecated, incompatible, or disallowed-license packages', () => {
  const result = evaluatePackage(metadata({
    deprecated: 'Use another package',
    license: 'GPL-3.0',
    peerDependencies: { react: '^18.0.0' },
    time: { '16.2.0': '2022-01-01T00:00:00.000Z' },
  }), evaluationOptions());

  const failures = result.failures.join('\n');
  assert.equal(result.viable, false);
  assert.match(failures, /deprecated/);
  assert.match(failures, /License/);
  assert.match(failures, /previous 24 months/);
  assert.match(failures, /does not support project version/);
  assert.deepEqual(result.failureCodes, [
    'package-deprecated',
    'license-not-approved',
    'package-stale',
    'framework-peer-incompatible',
  ]);
});

test('understands common peer dependency ranges', () => {
  assert.equal(peerRangeAllowsMajor('^18.0.0 || ^19.0.0', 19), true);
  assert.equal(peerRangeAllowsMajor('>=16.8.0 <20', 19), true);
  assert.equal(peerRangeAllowsMajor('>=16.8.0 <19', 19), false);
  assert.equal(peerRangeAllowsMajor('^18.0.0', 19), false);
});

test('requires mode evidence for unknown alternatives', () => {
  const result = evaluatePackage(metadata({
    description: 'A React formatting helper',
  }), evaluationOptions({ packageName: 'unknown-react-helper' }));

  assert.equal(result.viable, false);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.failureCodes, ['mode-inconclusive']);
  assert.match(result.warnings.join('\n'), /does not establish runtime localization support/);
});

test('allows an explicitly confirmed inconclusive package without marking it verified', () => {
  const result = evaluatePackage(metadata({
    description: 'A React formatting helper',
  }), evaluationOptions({
    packageName: 'unknown-react-helper',
    allowUnverifiedMode: true,
  }));

  assert.equal(result.viable, true);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.verificationStatus, 'unverified');
  assert.equal(result.requiresConfirmation, false);
});

test('accepts mode evidence from official documentation text', () => {
  const result = evaluatePackage(metadata({
    description: 'A React formatting helper',
  }), evaluationOptions({
    packageName: 'unknown-react-helper',
    modeEvidenceText: 'Users can change language dynamically at runtime.',
    modeEvidenceUrl: 'https://example.test/docs/runtime',
  }));

  assert.equal(result.viable, true);
  assert.equal(result.status, 'supported');
  assert.equal(result.verificationStatus, 'verified');
  assert.equal(result.modeEvidence.source, 'official-documentation');
  assert.equal(result.modeEvidence.evidenceUrl, 'https://example.test/docs/runtime');
});

test('keeps an unavailable official evidence URL in the inconclusive flow', () => {
  const result = evaluatePackage(metadata({
    description: 'A React formatting helper',
  }), evaluationOptions({
    packageName: 'unknown-react-helper',
    modeEvidenceUrl: 'https://docs.example.com/runtime',
    modeEvidenceError: 'request timed out',
  }));

  assert.equal(result.status, 'inconclusive');
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.modeEvidence.fetchError, 'request timed out');
  assert.match(result.warnings.join('\n'), /could not be read: request timed out/);
});

test('does not let an unverified override bypass hard failures', () => {
  const result = evaluatePackage(metadata({
    description: 'A React formatting helper',
    license: 'GPL-3.0',
  }), evaluationOptions({
    packageName: 'unknown-react-helper',
    allowUnverifiedMode: true,
  }));

  assert.equal(result.viable, false);
  assert.equal(result.status, 'unsupported');
  assert.match(result.failures.join('\n'), /License/);
});

test('treats a known package mode mismatch as unsupported', () => {
  const result = assessModeSupport('react-i18next', 'static', metadata());

  assert.equal(result.status, 'unsupported');
  assert.match(result.detail, /runtime, not static/);
});

test('accepts evidence URLs only from npm-published documentation hosts', () => {
  const packageMetadata = {
    homepage: 'https://docs.example.com/package',
    repository: { url: 'git+https://github.com/example/package.git' },
  };

  assert.equal(
    validateModeEvidenceUrl('https://docs.example.com/package/runtime', packageMetadata),
    'https://docs.example.com/package/runtime'
  );
  assert.equal(
    validateModeEvidenceUrl('https://github.com/example/package/blob/main/README.md', packageMetadata),
    'https://github.com/example/package/blob/main/README.md'
  );
  assert.throws(
    () => validateModeEvidenceUrl('https://unrelated.example.test/runtime', packageMetadata),
    /public documentation hostname/
  );
  assert.throws(
    () => validateModeEvidenceUrl(
      'https://127.0.0.1/runtime',
      { homepage: 'https://127.0.0.1/package' }
    ),
    /public documentation hostname/
  );
});

test('rejects alternatives with an incompatible react-dom peer', () => {
  const result = evaluatePackage(metadata({
    peerDependencies: { react: '^19.0.0', 'react-dom': '^18.0.0' },
  }), evaluationOptions());

  assert.equal(result.viable, false);
  assert.match(result.failures.join('\n'), /react-dom.*does not support project version/);
});

test('delegates all valid npm version syntax to npm semver resolution', () => {
  const calls = [];
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const execute = (command, args) => {
    calls.push([command, args]);
    if (args[1].includes('16.2 - 16.4')) return '["16.2.0","16.4.3"]';
    return '"16.2.7"';
  };

  assert.equal(resolveVersionWithNpm('react-i18next', '16.2', execute), '16.2.7');
  assert.equal(resolveVersionWithNpm('react-i18next', '16.2 - 16.4', execute), '16.4.3');
  assert.deepEqual(calls, [
    [npmExecutable, ['view', 'react-i18next@16.2', 'version', '--json']],
    [npmExecutable, ['view', 'react-i18next@16.2 - 16.4', 'version', '--json']],
  ]);
});

test('checks exact framework versions against full npm peer ranges', () => {
  const execute = (command, args) => {
    assert.equal(command, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    assert.deepEqual(args, ['view', 'react@>=18.0.0 <19.1.0', 'version', '--json']);
    return '["18.3.1","19.0.0"]';
  };

  assert.equal(
    versionSatisfiesRangeWithNpm('react', '19.0.0', '>=18.0.0 <19.1.0', execute),
    true
  );
  assert.equal(
    versionSatisfiesRangeWithNpm('react', '19.1.0', '>=18.0.0 <19.1.0', execute),
    false
  );
});

test('accepts only evidence-backed framework selections when detection is ambiguous', () => {
  const detection = {
    framework: null,
    candidates: ['react', 'vue'],
  };

  assert.equal(selectFramework(detection, 'react'), 'react');
  assert.equal(selectFramework(detection, 'angular'), null);
  assert.equal(selectFramework(detection), null);
});

test('does not guess exact versions for uninstalled Yarn or pnpm projects', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'yarn.lock', 'react@^19.0.0:\n  version "19.0.0"\n');

  assert.throws(
    () => resolveInstalledVersion(projectRoot, 'react', '^19.0.0'),
    /Install project dependencies before validating/
  );
});

test('rejects official Angular packages whose major does not match the project', () => {
  const result = evaluatePackage(metadata({
    version: '22.1.0',
    description: 'Angular official build-time localization',
    peerDependencies: {
      '@angular/compiler': '22.1.0',
      '@angular/compiler-cli': '22.1.0',
    },
    time: { '22.1.0': '2026-07-01T00:00:00.000Z' },
  }), evaluationOptions({
    packageName: '@angular/localize',
    framework: 'angular',
    frameworkVersion: '^19.1.0',
    frameworkVersions: {
      '@angular/core': '^19.1.0',
      '@angular/compiler': '^19.1.0',
      '@angular/compiler-cli': '^19.1.0',
    },
    mode: 'static',
  }));

  assert.equal(result.viable, false);
  assert.match(result.failures.join('\n'), /@angular\/compiler.*does not support project version/);
  assert.match(result.failures.join('\n'), /package major 22 must match project major 19/);
});
