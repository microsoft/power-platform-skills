'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const skillPath = path.resolve(
  __dirname,
  '../../skills/create-mobile-app/SKILL.md',
);
const skill = fs.readFileSync(skillPath, 'utf8');

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
  assert.match(initialize, /npx pa app init --app-type MobileApp/);
  assert.match(initialize, /--display-name "<displayName>"/);
  assert.match(initialize, /--environment-id "<environment-id>"/);
  assert.match(initialize, /--non-interactive/);
  assert.match(initialize, /approved Step 2 display name and Step 4 environment ID/);
  assert.match(initialize, /shell-safe quoting/);
  assert.match(initialize, /If a populated file remains, STOP/);
  assert.doesNotMatch(initialize, /spawnSync|node <<'NODE'/);
});

test('grouped Dataverse generation retains the URL required by the pinned CLI', () => {
  const pluginRoot = path.resolve(__dirname, '../..');
  for (const file of [
    'shared/connector-reference.md',
    'skills/add-dataverse/SKILL.md',
    'skills/create-mobile-app/SKILL.md',
    'skills/setup-datamodel/SKILL.md',
    'agents/data-model-architect.md',
    'hooks/validate-connector-first.js',
  ]) {
    const content = fs.readFileSync(path.join(pluginRoot, file), 'utf8');
    const commands = [...content.matchAll(/npx pa app add data-source --connector dataverse[^`\r\n]*/g)];
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
