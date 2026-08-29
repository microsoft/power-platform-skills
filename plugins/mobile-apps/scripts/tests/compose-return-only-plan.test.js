'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DATA_MODEL_PLACEHOLDER,
  REQUIRED_HEADINGS,
  SCREENS_PLACEHOLDER,
  composePlan,
  run,
} = require('../compose-return-only-plan');

function draft() {
  return [
    '# Native App Plan',
    '## Overview',
    'Overview.',
    '## App Requirements',
    'Requirements.',
    '## Product Experience',
    'Experience.',
    '## Product Scope',
    'Scope.',
    DATA_MODEL_PLACEHOLDER,
    '## Native Capabilities',
    'None.',
    '## Design',
    'Deferred.',
    '## Connectors',
    'None.',
    SCREENS_PLACEHOLDER,
    '## Approval Status',
    'Pending.',
    '## Plan Provenance',
    'Return-only.',
  ].join('\n');
}

test('composes the unchanged plan heading shape from complete role sections', () => {
  const content = composePlan({
    draft: draft(),
    dataModel: '## Data Model\nNo Dataverse tables.',
    screens: '## Screens\nHome.',
  });
  assert.deepEqual(
    [...content.matchAll(/^## ([^\n]+)$/gm)].map((match) => match[1]),
    REQUIRED_HEADINGS,
  );
  assert.doesNotMatch(content, /RETURN_ONLY_/);
});

test('rejects missing placeholders and malformed role sections', () => {
  assert.throws(() => composePlan({
    draft: draft().replace(DATA_MODEL_PLACEHOLDER, ''),
    dataModel: '## Data Model\nNone.',
    screens: '## Screens\nHome.',
  }), /Data Model placeholder must occur exactly once/);
  assert.throws(() => composePlan({
    draft: draft(),
    dataModel: 'No heading.',
    screens: '## Screens\nHome.',
  }), /must start with ## Data Model/);
});

test('does not replace an existing final plan when composition fails', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'return-plan-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'draft.md'), draft());
  fs.writeFileSync(path.join(root, 'data.md'), 'invalid');
  fs.writeFileSync(path.join(root, 'screens.md'), '## Screens\nHome.');
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), 'previous\n');
  assert.throws(() => run({
    projectRoot: root,
    draft: 'draft.md',
    dataModel: 'data.md',
    screens: 'screens.md',
    output: 'native-app-plan.md',
  }), /must start with ## Data Model/);
  assert.equal(fs.readFileSync(path.join(root, 'native-app-plan.md'), 'utf8'), 'previous\n');
});