'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('template delegates Metro logging to the host helper and fails open', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const metroConfig = fs.readFileSync(path.join(pluginRoot, 'template', 'metro.config.js'), 'utf8');
  const gitignore = fs.readFileSync(path.join(pluginRoot, 'template', '.gitignore'), 'utf8');

  assert.match(metroConfig, /@microsoft\/power-apps-native-host\/metro-logger/);
  assert.match(metroConfig, /withPowerNativeMetroLogging/);
  assert.match(metroConfig, /catch \{/);
  assert.doesNotMatch(metroConfig, /SENSITIVE_LINE_PATTERN|appendMetroLog|process\.stdout\.write/);
  assert.match(gitignore, /^\.powernative\//m);
});

test('skill contracts read .powernative logs directly', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const createSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8');
  const debugSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'debug-app', 'SKILL.md'), 'utf8');
  const deploySkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'deploy', 'SKILL.md'), 'utf8');

  const createFrontmatter = createSkill.split('---', 3)[1];
  assert.match(createFrontmatter, /allowed-tools:.*\bSkill\b/);
  assert.match(createSkill, /\.powernative\/metro-logs/);
  assert.match(createSkill, /npm run dev/);
  assert.doesNotMatch(createSkill, /scripts\/metro-session\.js|dev:expo|copy the plugin wrapper/i);
  assert.match(debugSkill, /\.powernative\/metro-logs/);
  assert.match(debugSkill, /latest .*\.powernative/i);
  assert.doesNotMatch(debugSkill, /BashOutput|METRO_TERMINAL_ID|metro-session\.js|start --project-root/);
  assert.match(deploySkill, /\.powernative/);
});
