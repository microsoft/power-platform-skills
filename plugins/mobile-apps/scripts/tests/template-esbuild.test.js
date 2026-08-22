'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const templateRoot = path.join(pluginRoot, 'template');

test('template installs the harness esbuild version as a direct dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(templateRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.devDependencies?.esbuild, '0.28.1');
  assert.equal(packageJson.overrides?.esbuild, '0.28.1');

  const esbuildCli = path.join(templateRoot, 'node_modules', 'esbuild', 'bin', 'esbuild');
  assert.equal(fs.existsSync(esbuildCli), true, 'template node_modules must contain direct esbuild');
  const result = spawnSync(esbuildCli, ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.28.1');
});