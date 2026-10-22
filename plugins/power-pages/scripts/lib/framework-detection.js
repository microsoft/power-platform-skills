'use strict';

const fs = require('fs');
const path = require('path');

function readPackageJson(projectRoot) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    );
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function packageDependencies(projectRoot) {
  const packageJson = readPackageJson(projectRoot);
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
}

function detectFramework(projectRoot) {
  const dependencies = packageDependencies(projectRoot);
  const evidence = [];
  const candidates = [];

  if (dependencies.react && dependencies['react-dom']) {
    candidates.push('react');
    evidence.push({
      framework: 'react',
      kind: 'primary',
      detail: 'react and react-dom dependencies',
    });
  }
  if (dependencies.vue) {
    candidates.push('vue');
    evidence.push({
      framework: 'vue',
      kind: 'primary',
      detail: 'vue dependency',
    });
  }
  if (dependencies['@angular/core']) {
    candidates.push('angular');
    evidence.push({
      framework: 'angular',
      kind: 'primary',
      detail: '@angular/core dependency',
    });
  }
  if (dependencies.astro) {
    candidates.push('astro');
    evidence.push({
      framework: 'astro',
      kind: 'primary',
      detail: 'astro dependency',
    });
  }

  for (const [framework, relativePath] of [
    ['angular', 'angular.json'],
    ['astro', 'astro.config.mjs'],
    ['astro', 'astro.config.js'],
    ['astro', 'astro.config.ts'],
  ]) {
    if (fs.existsSync(path.join(projectRoot, relativePath))) {
      candidates.push(framework);
      evidence.push({ framework, kind: 'primary', detail: relativePath });
    }
  }

  const uniqueCandidates = [...new Set(candidates)];
  return {
    framework: uniqueCandidates.length === 1 ? uniqueCandidates[0] : null,
    candidates: uniqueCandidates,
    ambiguous: uniqueCandidates.length > 1,
    unsupported: uniqueCandidates.length === 0,
    evidence,
  };
}

module.exports = {
  detectFramework,
  packageDependencies,
};
