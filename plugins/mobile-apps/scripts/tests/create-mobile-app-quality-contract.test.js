'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const scaffoldPath = path.resolve(
  __dirname,
  '../../skills/create-mobile-app/references/phase-03-scaffold.md',
);
const scaffold = fs.readFileSync(scaffoldPath, 'utf8');

test('template preparation is delegated to the deterministic script', () => {
  const start = scaffold.indexOf('### Step 5 — Prepare existing template');
  const end = scaffold.indexOf('### Step 6 — Initialize');
  assert.ok(start >= 0 && end > start, 'the active scaffold phase must own preparation');
  const step = scaffold.slice(start, end);

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
  const initializeStart = scaffold.indexOf('### Step 6 — Initialize');
  const initializeEnd = scaffold.indexOf('### Step 6.5 — Verify dependencies');
  assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
  const initialize = scaffold.slice(initializeStart, initializeEnd);
  assert.match(initialize, /npx power-apps init -t MobileApp/);
  assert.match(initialize, /--display-name "<displayName>"/);
  assert.match(initialize, /--environment-id "<environment-id>"/);
  assert.match(initialize, /approved Step 2 display name and Step 4 environment ID/);
  assert.match(initialize, /shell-safe quoting/);
  assert.match(initialize, /If a populated file remains, STOP/);
  assert.doesNotMatch(initialize, /spawnSync|node <<'NODE'/);
});
