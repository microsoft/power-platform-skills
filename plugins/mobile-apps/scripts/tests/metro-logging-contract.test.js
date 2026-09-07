'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function caretVersionAtLeast(value, minimum) {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  assert.ok(match, `expected a caret semver range, received ${value}`);
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function extractMetroCollector(debugSkill) {
  const collector = /node - "\$LOG_PATH" <saved-cursor> 262144 5000 <<'NODE'\r?\n([\s\S]*?)\r?\nNODE/.exec(debugSkill);
  assert.ok(collector, 'expected the foreground Metro log collector snippet');
  return collector[1];
}

function metroCollectorSource() {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const debugSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'debug-app', 'SKILL.md'), 'utf8');
  return extractMetroCollector(debugSkill);
}

function runMetroCollector(source, logPath, cursor, observationMs) {
  const result = spawnSync(
    process.execPath,
    ['-', logPath, String(cursor), '262144', String(observationMs)],
    { input: source, encoding: 'utf8', timeout: 2000 },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test('template uses the host Metro factory that installs project-local logging', () => {
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
    /const \{ createPowerAppsMetroConfig \} = require\('@microsoft\/power-apps-native-host\/config\/metroConfig'\);/,
  );
  assert.doesNotMatch(
    metroConfig,
    /power-apps-native-host\/metro-logger|SENSITIVE_LINE_PATTERN|appendMetroLog|process\.stdout\.write/,
  );
  assert.ok(
    caretVersionAtLeast(packageJson.dependencies['@microsoft/power-apps-native-host'], [0, 2, 26]),
    'the host package must include the Metro logger introduced in 0.2.26',
  );
  assert.match(gitignore, /^\.powernative\//m);
  assert.equal(packageJson.scripts.dev, 'expo start');
  assert.equal(packageJson.scripts.predev, 'npm run generate-schemas && npm run type-check');
  const workflowCoversMobileApps = /plugins\/mobile-apps\/\*\*/.test(workflow);
  assert.ok(workflowCoversMobileApps || /plugins\/mobile-apps\/template\/metro\.config\.js/.test(workflow));
  assert.ok(workflowCoversMobileApps || /plugins\/mobile-apps\/template\/package\.json/.test(workflow));
  assert.match(workflow, /appDisplayName: 'Template Quality Probe'/);
  assert.match(workflow, /npm run predev/);
});

test('skill contracts read logs and persist host-neutral state under .powernative', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const createSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8');
  const debugSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'debug-app', 'SKILL.md'), 'utf8');
  const deploySkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'deploy', 'SKILL.md'), 'utf8');
  const agentsGuide = fs.readFileSync(path.join(pluginRoot, 'AGENTS.md'), 'utf8');

  const createFrontmatter = createSkill.split('---', 3)[1];
  assert.match(createFrontmatter, /allowed-tools:.*\bSkill\b/);
  assert.match(createSkill, /\.powernative\/metro-logs/);
  assert.match(createSkill, /npm run dev/);
  assert.match(createSkill, /12\. Start Metro \(`npm run dev`\)/);
  assert.match(createSkill, /createPowerAppsMetroConfig/);
  assert.match(createSkill, /npm does not launch `expo start` when either gate fails/);
  assert.doesNotMatch(createSkill, /npx expo start|without rerunning the `predev` schema hook/);
  assert.doesNotMatch(createSkill, /delegates Metro terminal output.*power-apps-native-host\/metro-logger/);
  assert.doesNotMatch(createSkill, /scripts\/metro-session\.js|dev:expo|copy the plugin wrapper/i);
  assert.match(debugSkill, /\.powernative\/metro-logs/);
  assert.match(debugSkill, /\.powernative\/debug-app/);
  assert.doesNotMatch(debugSkill, /\.claude\/debug-app/);
  assert.match(debugSkill, /--working-dir <path>/);
  assert.match(debugSkill, /Use `workingDir` from argument parsing as `<working_dir>`/);
  assert.match(debugSkill, /every relative project path and command below runs from that directory/);
  assert.match(debugSkill, /Early-return subcommands/);
  assert.match(debugSkill, /execute only Phase 0\.0 discovery through the status branch/);
  assert.match(debugSkill, /read `\.powernative\/debug-app\/metro-cursor\.json` only when it is nonempty valid JSON/);
  assert.match(debugSkill, /process\.kill\(pid, 0\)/);
  assert.match(debugSkill, /Treat a missing, empty, malformed, or shape-invalid file as no saved cursor/);
  assert.match(debugSkill, /discover valid project-local Metro sessions/i);
  assert.match(debugSkill, /"logPath":/);
  assert.match(debugSkill, /"pid":/);
  assert.match(debugSkill, /predates project-local Metro logging/);
  assert.match(debugSkill, /createPowerAppsMetroConfig/);
  assert.match(debugSkill, /factory installs project-local logging internally/);
  assert.match(debugSkill, /exact subpath resolves from the project's installed dependencies/);
  assert.match(debugSkill, /dependency version string alone does not prove/);
  assert.doesNotMatch(debugSkill, /raw return value|any auth\/data props passed in|JSON\.stringify\(value\) for objects/);
  assert.match(debugSkill, /Never log raw records, response bodies, arbitrary objects/);
  assert.doesNotMatch(debugSkill, /recorded as `NEEDS ATTENTION`/);
  assert.doesNotMatch(debugSkill, /status\.running|verbatim error|<exact error line>/);
  assert.match(debugSkill, /Output contains only the logger startup line/);
  assert.match(debugSkill, /append only the verifier's output/);
  assert.match(debugSkill, /logging instrumentation failed/);
  assert.match(debugSkill, /baseline read gets `ENOENT`/);
  assert.match(debugSkill, /watcher = fs\.watch/);
  assert.match(debugSkill, /observation: interval/);
  assert.doesNotMatch(debugSkill, /ordinary tool execution provides the cadence/);
  assert.doesNotThrow(() => new vm.Script(metroCollectorSource()));
  assert.doesNotThrow(() => new vm.Script(extractMetroCollector(debugSkill.replace(/\n/g, '\r\n'))));
  const traceScanCount = (debugSkill.match(/find app src -type f/g) || []).length;
  const generatedExclusionCount = (debugSkill.match(/! -path 'src\/generated\/\*'/g) || []).length;
  assert.ok(traceScanCount >= 2, 'expected trace discovery and verification scans');
  assert.equal(generatedExclusionCount, traceScanCount, 'every trace scan must exclude generated code');
  assert.doesNotMatch(debugSkill, /tail -n 500 "\$LOG_PATH"/);
  assert.doesNotMatch(debugSkill, /BashOutput|METRO_TERMINAL_ID|metro-session\.js|start --project-root/);
  assert.match(deploySkill, /\.powernative/);
  assert.match(agentsGuide, /user-owned `npm run dev`/);
  assert.doesNotMatch(agentsGuide, /detached project-local process|start\/status\/tail\/stop/);
});

test('Metro collector returns already-appended bytes without waiting', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metro-collector-backlog-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, 'metro.log');
  fs.writeFileSync(logPath, 'new output');

  const result = runMetroCollector(metroCollectorSource(), logPath, 0, 1000);

  assert.equal(result.observation, 'initial');
  assert.equal(result.output, 'new output');
  assert.equal(result.nextCursor, 10);
  assert.equal(result.readError, null);
});

test('Metro collector waits for a complete idle observation interval', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metro-collector-idle-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, 'metro.log');
  fs.writeFileSync(logPath, 'existing');

  const result = runMetroCollector(metroCollectorSource(), logPath, 8, 50);

  assert.equal(result.observation, 'interval');
  assert.equal(result.output, '');
  assert.ok(result.observedMs >= 40, `expected an idle wait, received ${result.observedMs}ms`);
  assert.equal(result.readError, null);
});
