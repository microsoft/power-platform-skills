'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const entry = fs.readFileSync(path.join(root, 'agents/screen-builder.md'), 'utf8');

test('screen builder entry stays bounded and conditionally loads owned references', () => {
  assert.ok(entry.trimEnd().split('\n').length <= 180);
  assert.ok(Buffer.byteLength(entry) <= 12 * 1024);
  const references = [...entry.matchAll(/\]\((references\/screen-builder\/[^)]+)\)/g)];
  assert.ok(references.length > 0);
  for (const [, reference] of references) {
    assert.ok(fs.existsSync(path.join(root, 'agents', reference)), reference);
  }
  assert.match(entry, /only when its trigger applies/);
  assert.match(entry, /API\/import sample is optional/);
  assert.match(entry, /existing artifacts, not a new work-order or sidecar/);
});

test('builder keeps child ownership and truthful outcomes separate from presentation', () => {
  assert.match(entry, /Write \*\*only `target_file`\*\*/);
  assert.match(entry, /Never ask the user questions, enter plan mode/);
  assert.match(entry, /root layout\/gesture-provider repairs/);
  assert.match(entry, /result\.success/);
  assert.match(entry, /Live empty results stay empty/);
  assert.match(entry, /motion: none/);
  assert.match(entry, /No universal large header\/search, bottom CTA/);
  assert.match(entry, /normalizeDataverseGuid/);
  assert.match(entry, /NEVER use `expo-haptics`/);
  assert.match(entry, /validate-mobile-files\.js/);
  for (const status of ['DONE', 'DONE_WITH_CONCERNS:', 'NEEDS_CONTEXT:', 'BLOCKED:']) {
    assert.ok(entry.includes(status));
  }
});

test('AI may create task-specific components without being constrained to samples', () => {
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const planning = read('shared/references/design-planning.md');
  const shell = read('skills/create-mobile-app/references/phase-08-screens.md');
  const api = read('agents/references/screen-builder/design-api.md');
  const samples = read('shared/samples/src/components/index.tsx');
  assert.match(planning, /AI may reuse, adapt, compose, or generate task-specific UI/);
  assert.match(planning, /starting point, not a closed catalog or a ceiling/);
  assert.match(planning, /Inspect existing components first/);
  assert.match(planning, /do not force a task into an unsuitable sample/);
  assert.match(planning, /no separate component-choice approval/);
  assert.match(planning, /owning foreground gate/);
  assert.match(entry, /New task-specific UI is allowed within `target_file`/);
  assert.match(entry, /shared component additions\/adaptations go to foreground/);
  for (const text of [shell, api]) assert.match(text, /#component-choice-and-creation/);
  assert.match(samples, /Create task-specific UI when needed/);
  assert.doesNotMatch(samples, /Never re-define inline/);
});

test('builders consume concrete accepted presentation and realized shared interfaces', () => {
  assert.match(entry, /`design_reference` supplies the accepted\s+preview screen\/state and observed review row/);
  assert.match(entry, /explicit no-design\/unverified status/);
  assert.match(entry, /`component_interfaces` names actual shared exports\/props/);
  assert.match(entry, /Match actual shared components to the accepted recipes/);
  assert.match(entry, /missing exports return to foreground/);
  assert.match(entry, /style acceptance does not verify an unobserved screen or native control/);
});
