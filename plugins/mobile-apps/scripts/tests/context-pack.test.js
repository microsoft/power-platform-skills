'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const generatorPath = path.join(pluginRoot, 'scripts', 'generate-context-pack.js');
const generator = require(generatorPath);

test('generated planner context pack is current and contains required facts', () => {
  assert.equal(fs.readFileSync(generator.OUTPUT, 'utf8'), generator.generate());
  const pack = generator.generate();
  for (const heading of ['Template Contract', 'Template Dependency Allowlist', 'Catalogue Keys', 'Cardinality pattern defaults', 'Shared Component Inventory', 'Design Directions', 'Derivation Contract']) assert.match(pack, new RegExp(heading));
  assert.match(pack, /`expo-camera`/);
  assert.match(pack, /`StatusPill`/);
});

test('context pack check command passes committed output', () => {
  const result = spawnSync(process.execPath, [generatorPath, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /context-pack: current/);
});

test('prototype planners scope reads to context pack and zero Dataverse references', () => {
  const native = fs.readFileSync(path.join(pluginRoot, 'agents', 'native-app-planner.md'), 'utf8');
  const data = fs.readFileSync(path.join(pluginRoot, 'agents', 'data-model-architect.md'), 'utf8');
  const screen = fs.readFileSync(path.join(pluginRoot, 'agents', 'screen-planner.md'), 'utf8');
  assert.match(native, /only plugin reference you\s+may read/);
  assert.match(native, /Do not read any Dataverse reference/);
  assert.match(data, /Read zero Dataverse\s+references/);
  assert.match(screen, /Prototype context rule/);
  assert.match(screen, /Three or fewer signed-in screens/);
});