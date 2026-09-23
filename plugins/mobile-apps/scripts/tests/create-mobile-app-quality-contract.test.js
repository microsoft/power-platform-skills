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
  assert.match(initialize, /npx power-apps init -t MobileApp/);
  assert.match(initialize, /--display-name "<displayName>"/);
  assert.match(initialize, /--environment-id "<environment-id>"/);
  assert.match(initialize, /approved Step 2 display name and Step 4 environment ID/);
  assert.match(initialize, /shell-safe quoting/);
  assert.match(initialize, /If a populated file remains, STOP/);
  assert.doesNotMatch(initialize, /spawnSync|node <<'NODE'/);
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

function section(start, end) {
  const startIndex = skill.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section: ${start}`);
  const endIndex = skill.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section boundary: ${end}`);
  return skill.slice(startIndex, endIndex);
}

test('creating an app has no user prerequisites', () => {
  assert.match(skill, /\*\*This skill has no setup steps\.\*\*/);
  // The prerequisite this replaced: the user had to materialize a template and
  // install its dependencies before the skill would run at all.
  assert.doesNotMatch(skill, /rerun `\/create-mobile-app --working-dir <fresh-template-dir>`/);
  assert.doesNotMatch(skill, /must run `npm install` in the fresh template folder/);
  assert.doesNotMatch(skill, /ask the user to run `npm install`/i);
});

test('the app folder is created from the bundled snapshot, never fetched', () => {
  const bootstrap = section(
    '### Step 2a — Create the app folder, start dependency install',
    '### Step 2b — Requirements discovery',
  );

  assert.match(bootstrap, /scripts\/bootstrap-mobile-project\.js/);
  assert.match(bootstrap, /--parent-dir "\$PWD" --slug "<slug>"/);
  assert.match(bootstrap, /Exit 2 is an actionable refusal/);
  assert.match(bootstrap, /Set `<working_dir>` to `result\.targetDir`/);
  // Network template fetches would let main drift ahead of prepare-mobile-template.js.
  assert.doesNotMatch(bootstrap, /npx degit|git clone|curl |wget /);

  const source = fs.readFileSync(
    path.resolve(__dirname, '../bootstrap-mobile-project.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /\bhttps?:\/\/(?!\/)[^\s)]*\/(?:archive|tarball)/);
  assert.doesNotMatch(source, /child_process|fetch\(/);
});

test('dependency install starts in Step 2a and is collected in Step 5', () => {
  const bootstrap = section(
    '### Step 2a — Create the app folder, start dependency install',
    '### Step 2b — Requirements discovery',
  );
  assert.match(bootstrap, /scripts\/install-dependencies\.js" --working-dir "<working_dir>" start/);
  assert.match(bootstrap, /\*\*Do not poll, tail, or block on the install here\.\*\*/);

  const preparation = section(
    '### Step 5 — Prepare existing template',
    '### Step 6 — Initialize',
  );
  assert.match(preparation, /install-dependencies\.js" --working-dir "<working_dir>" wait --timeout-ms 900000/);
  for (const state of ['succeeded', 'failed', 'stalled', 'timeout', 'not-started']) {
    assert.ok(preparation.includes(`\`${state}\``), `Step 5 must handle ${state}`);
  }
  assert.match(preparation, /never substitute your own `npm install` for this gate/);

  // Step 5 runs after planning, so its gate is the only blocking wait in the flow.
  const betweenBootstrapAndPreparation = skill.slice(
    skill.indexOf('### Step 2b — Requirements discovery'),
    skill.indexOf('### Step 5 — Prepare existing template'),
  );
  assert.doesNotMatch(betweenBootstrapAndPreparation, /install-dependencies\.js/);
});
