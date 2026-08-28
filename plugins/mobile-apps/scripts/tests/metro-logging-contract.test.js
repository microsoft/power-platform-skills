'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function caretVersionAtLeast(value, minimum) {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  assert.ok(match, `expected a caret semver range, received ${value}`);
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

test('template imports the host Metro logger at config startup', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const workflow = fs.readFileSync(
    path.resolve(pluginRoot, '..', '..', '.github', 'workflows', 'mobile-apps-script-tests.yml'),
    'utf8',
  );
  const metroConfig = fs.readFileSync(path.join(pluginRoot, 'template', 'metro.config.js'), 'utf8');
  const gitignore = fs.readFileSync(path.join(pluginRoot, 'template', '.gitignore'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'template', 'package.json'), 'utf8'));

  assert.match(
    metroConfig,
    /const \{ withPowerNativeMetroLogging \} = require\('@microsoft\/power-apps-native-host\/metro-logger'\);/,
  );
  assert.doesNotMatch(metroConfig, /SENSITIVE_LINE_PATTERN|appendMetroLog|process\.stdout\.write/);
  assert.ok(
    caretVersionAtLeast(packageJson.dependencies['@microsoft/power-apps-native-host'], [0, 2, 26]),
    'the host package must include the Metro logger introduced in 0.2.26',
  );
  assert.match(gitignore, /^\.powernative\//m);
  const workflowCoversMobileApps = /plugins\/mobile-apps\/\*\*/.test(workflow);
  assert.ok(workflowCoversMobileApps || /plugins\/mobile-apps\/template\/metro\.config\.js/.test(workflow));
  assert.ok(workflowCoversMobileApps || /plugins\/mobile-apps\/template\/package\.json/.test(workflow));
});

test('skill contracts read logs and persist host-neutral state under .powernative', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const createSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8');
  const debugSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'debug-app', 'SKILL.md'), 'utf8');
  const deploySkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'deploy', 'SKILL.md'), 'utf8');

  const createFrontmatter = createSkill.split('---', 3)[1];
  assert.match(createFrontmatter, /allowed-tools:.*\bSkill\b/);
  assert.match(createSkill, /\.powernative\/metro-logs/);
  assert.match(createSkill, /npm run dev/);
  assert.match(createSkill, /npx expo start/);
  assert.match(createSkill, /without rerunning the `predev` schema hook/);
  assert.doesNotMatch(createSkill, /scripts\/metro-session\.js|dev:expo|copy the plugin wrapper/i);
  assert.match(debugSkill, /\.powernative\/metro-logs/);
  assert.match(debugSkill, /\.powernative\/debug-app/);
  assert.doesNotMatch(debugSkill, /\.claude\/debug-app/);
  assert.match(debugSkill, /discover valid project-local Metro sessions/i);
  assert.match(debugSkill, /"logPath":/);
  assert.match(debugSkill, /"pid":/);
  assert.match(debugSkill, /predates project-local Metro logging/);
  assert.match(debugSkill, /\^0\.2\.26/);
  assert.doesNotMatch(debugSkill, /tail -n 500 "\$LOG_PATH"/);
  assert.doesNotMatch(debugSkill, /BashOutput|METRO_TERMINAL_ID|metro-session\.js|start --project-root/);
  assert.match(deploySkill, /\.powernative/);
});
