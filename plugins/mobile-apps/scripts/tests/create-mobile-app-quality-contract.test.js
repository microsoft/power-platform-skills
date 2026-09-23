'use strict';

const assert = require('assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const skillPath = path.resolve(
  __dirname,
  '../../skills/create-mobile-app/SKILL.md',
);
const skill = fs.readFileSync(skillPath, 'utf8');

function assertInitializationCommand(section) {
  const commands = [...section.matchAll(/^npx --no-install pa app init[^\r\n]*/gm)];
  assert.strictEqual(commands.length, 1, 'Expected one executable initialization command');
  const command = commands[0][0];
  assert.match(command, /--app-type MobileApp(?:\s|$)/);
  assert.match(command, /--display-name "<displayName>"(?:\s|$)/);
  assert.match(command, /--environment-id "<environment-id>"(?:\s|$)/);
  assert.match(command, /--non-interactive(?:\s|$)/);
}

test('template preparation is delegated to the deterministic script', () => {
  const start = skill.indexOf('### Step 5 — Prepare existing template');
  const end = skill.indexOf('### Step 6 — Initialize');
  const step = skill.slice(start, end);

  assert.match(step, /scripts\/prepare-mobile-template\.js/);
  assert.match(step, /JSON_STRING_OF_WORKING_DIR/);
  assert.match(step, /JSON_STRING_OF_DISPLAY_NAME/);
  assert.match(step, /JSON_STRING_OF_SLUG/);
  assert.doesNotMatch(step, /--display-name "<displayName>"/);
  assert.match(step, /must not create, reset, delete, or\s+write anything under `src\/generated\/`/);
  assert.doesNotMatch(step, /rm\s+-rf[\s\S]*src\/generated/);
  assert.doesNotMatch(step, /src\/generated\/index\.ts[\s\S]*printf/);
  assert.doesNotMatch(step, /\ncp\s+.*shared\/samples/);
  assert.doesNotMatch(step, /baseUrl\s*=/);
  assert.doesNotMatch(step, /Write `app\/_layout\.tsx`/);
  assert.match(
    step,
    /`native-app-plan\.md` is expected here because Step 3 writes the approved plan before template preparation/,
  );
});

test('Power Apps initialization directly invokes the CLI with approved values', () => {
  const initializeStart = skill.indexOf('### Step 6 — Initialize');
  const initializeEnd = skill.indexOf('### Step 6.5 — Verify dependencies');
  const initialize = skill.slice(initializeStart, initializeEnd);
  assertInitializationCommand(initialize);
  assert.match(initialize, /approved Step 2 display name and Step 4 environment ID/);
  assert.match(initialize, /shell-safe quoting/);
  assert.match(initialize, /If a populated file remains, STOP/);
  assert.doesNotMatch(initialize, /spawnSync|node <<'NODE'/);
});

test('init contract rejects missing flags even when the status message includes them', () => {
  const command = 'npx --no-install pa app init --app-type MobileApp --display-name "<displayName>" --environment-id "<environment-id>" --non-interactive';
  const status = `> Running \`${command}\`\n`;
  for (const flag of ['--no-install ', '--app-type MobileApp', '--display-name "<displayName>"', '--environment-id "<environment-id>"', '--non-interactive']) {
    assert.throws(
      () => assertInitializationCommand(`${status}${command.replace(flag, '')}\n`),
      assert.AssertionError,
      flag,
    );
  }
  assert.doesNotThrow(() => assertInitializationCommand(`${status}${command}\n`));
  assert.doesNotThrow(() => assertInitializationCommand(`${status}${command}\n`.replace(/\n/g, '\r\n')));
});

test('documented local CLI gate accepts grouped POSIX and Windows shims and fails closed otherwise', (t) => {
  const shared = fs.readFileSync(path.join(pluginRoot, 'shared/shared-instructions.md'), 'utf8');
  const invocation = shared.slice(shared.indexOf('## CLI Invocation'), shared.indexOf('Typical commands:'));
  const snippet = /node -e "([\s\S]*?)"\r?\n/.exec(invocation);
  assert.ok(snippet, 'Expected an executable local CLI presence check');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cli-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, shim, isDirectory, expectedStatus] of [
    ['absent', null, false, 1],
    ['legacy-only', 'power-apps', false, 1],
    ['directory', 'pa', true, 1],
    ['posix', 'pa', false, 0],
    ['windows', 'pa.cmd', false, 0],
  ]) {
    const cwd = path.join(root, name);
    const bin = path.join(cwd, 'node_modules/.bin');
    fs.mkdirSync(bin, { recursive: true });
    if (shim) {
      if (isDirectory) fs.mkdirSync(path.join(bin, shim));
      else fs.writeFileSync(path.join(bin, shim), 'must not execute this shim\n');
    }
    const result = spawnSync(process.execPath, ['-e', snippet[1]], {
      cwd, encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, expectedStatus, `${name}: ${result.stderr}`);
    if (expectedStatus) assert.match(result.stderr, /Local grouped Power Apps CLI is missing/);
    else assert.strictEqual(result.stderr, '');
  }
  assert.match(invocation, /STOP before invoking `npx`/);
  assert.match(invocation, /No automatic flat-command fallback/);
  assert.match(skill, /Before any Power Apps CLI command, run the \*\*local CLI gate\*\*/);
});

test('mobile CLI examples always retain no-install and document the separate prompt flag', () => {
  function check(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) check(file);
      else if (/\.(md|js)$/.test(entry.name)) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\bnpx\s+pa\b/, path.relative(pluginRoot, file));
      }
    }
  }
  check(pluginRoot);
  const connector = fs.readFileSync(path.join(pluginRoot, 'skills/add-connector/SKILL.md'), 'utf8');
  const parameters = connector.slice(connector.indexOf('**Parameter reference:**'), connector.indexOf('### Step 4'));
  assert.match(parameters, /`--no-install`/);
  assert.match(parameters, /`--non-interactive`[^\r\n]*required on every/);
});

test('grouped Dataverse generation retains the URL required by the pinned CLI', () => {
  for (const file of [
    'shared/connector-reference.md',
    'skills/add-dataverse/SKILL.md',
    'skills/create-mobile-app/SKILL.md',
    'skills/setup-datamodel/SKILL.md',
    'agents/data-model-architect.md',
    'hooks/validate-connector-first.js',
  ]) {
    const content = fs.readFileSync(path.join(pluginRoot, file), 'utf8');
    const commands = [...content.matchAll(/npx --no-install pa app add data-source --connector dataverse[^`\r\n]*/g)];
    assert.ok(commands.length > 0, `Expected a Dataverse command in ${file}`);
    for (const [command] of commands) {
      assert.match(command, /--org-url <[^>]+>/, file);
      assert.match(command, /--table <[^>]+>/, file);
      assert.match(command, /--non-interactive/, file);
    }
  }
  const shared = fs.readFileSync(path.join(pluginRoot, 'shared/shared-instructions.md'), 'utf8');
  assert.match(shared, /still requires the resolved Dataverse URL in non-interactive mode/);
});

test('tabular discovery retains the pinned CLI connection group', () => {
  for (const file of [
    'shared/connector-reference.md',
    'skills/add-connector/SKILL.md',
    'skills/add-sharepoint/SKILL.md',
    'skills/add-sharepoint/references/sharepoint-reference.md',
  ]) {
    const source = fs.readFileSync(path.join(pluginRoot, file), 'utf8');
    assert.match(source, /npx --no-install pa connection list-tables\b/, file);
    assert.doesNotMatch(source, /\bpa connector list-(?:datasets|tables|procedures)\b/, file);
  }
});

test('scaffold changed-file validation separates preparation and generator ownership', () => {
  const preparation = skill.slice(
    skill.indexOf('### Step 5 — Prepare existing template'),
    skill.indexOf('### Step 6 — Initialize'),
  );
  const memory = skill.slice(
    skill.indexOf('### Step 6.7 — Seed the memory bank'),
    skill.indexOf('### Step 6.75 — Design system'),
  );
  const shared = fs.readFileSync(path.resolve(__dirname, '../../shared/shared-instructions.md'), 'utf8');

  assert.match(preparation, /result\.writtenFiles/);
  assert.match(preparation, /removedPowerConfig.*removedLegacyFiles/);
  assert.match(preparation, /Do not rebuild this list from `git status`/);
  assert.match(memory, /Step 5's `writtenFiles`.*`memory-bank\.md`/);
  assert.match(memory, /read-only.*Step 6/);
  assert.match(shared, /not modified afterward by the skill or its subagents/);
  assert.match(shared, /Do not suppress a protected-path finding/);
});
