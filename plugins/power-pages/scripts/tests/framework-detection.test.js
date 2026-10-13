'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  detectFramework,
  packageDependencies,
} = require('../lib/framework-detection');
const { createTempProject, writeProjectFile } = require('./test-utils');

const CLI_PATH = path.join(__dirname, '..', 'detect-framework.js');

function writePackage(projectRoot, fields) {
  writeProjectFile(
    projectRoot,
    'package.json',
    JSON.stringify(fields, null, 2)
  );
}

test('detects supported frameworks from dependencies and development dependencies', (t) => {
  const cases = [
    ['react', { dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }],
    ['vue', { dependencies: { vue: '^3.5.0' } }],
    ['angular', { dependencies: { '@angular/core': '^19.1.0' } }],
    ['astro', { devDependencies: { astro: '^6.1.0' } }],
  ];

  for (const [expected, packageJson] of cases) {
    const projectRoot = createTempProject(t);
    writePackage(projectRoot, packageJson);
    assert.equal(detectFramework(projectRoot).framework, expected);
  }
});

test('ignores peer dependencies as installation evidence', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, {
    devDependencies: { astro: '^6.1.0' },
    peerDependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
    },
  });

  assert.deepEqual(packageDependencies(projectRoot), { astro: '^6.1.0' });
  assert.deepEqual(detectFramework(projectRoot).candidates, ['astro']);
});

test('reports ambiguous dependency and configuration evidence without guessing', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, {
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      vue: '^3.5.0',
    },
  });
  writeProjectFile(projectRoot, 'angular.json', '{}');

  const result = detectFramework(projectRoot);
  assert.equal(result.framework, null);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.candidates, ['react', 'vue', 'angular']);
});

test('returns unsupported for missing or malformed package metadata', (t) => {
  const missingRoot = createTempProject(t);
  assert.deepEqual(detectFramework(missingRoot), {
    framework: null,
    candidates: [],
    ambiguous: false,
    unsupported: true,
    evidence: [],
  });

  const malformedRoot = createTempProject(t);
  writeProjectFile(malformedRoot, 'package.json', '{invalid');
  assert.equal(detectFramework(malformedRoot).unsupported, true);
});

test('CLI returns the shared detection result', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, {
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
  });

  const result = spawnSync(
    process.execPath,
    [CLI_PATH, '--projectRoot', projectRoot],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).framework, 'react');
});
