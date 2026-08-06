'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('template imports the host Metro logger at config startup', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const metroConfig = fs.readFileSync(path.join(pluginRoot, 'template', 'metro.config.js'), 'utf8');
  const gitignore = fs.readFileSync(path.join(pluginRoot, 'template', '.gitignore'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'template', 'package.json'), 'utf8'));

  assert.match(
    metroConfig,
    /const \{ withPowerNativeMetroLogging \} = require\('@microsoft\/power-apps-native-host\/metro-logger'\);/,
  );
  assert.doesNotMatch(metroConfig, /SENSITIVE_LINE_PATTERN|appendMetroLog|process\.stdout\.write/);
  assert.equal(packageJson.dependencies['@microsoft/power-apps-native-host'], '^0.2.26');
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
  assert.match(debugSkill, /"logPath":/);
  assert.match(debugSkill, /"pid":/);
  assert.doesNotMatch(debugSkill, /tail -n 500 "\$LOG_PATH"/);
  assert.doesNotMatch(debugSkill, /BashOutput|METRO_TERMINAL_ID|metro-session\.js|start --project-root/);
  assert.match(deploySkill, /\.powernative/);
});
