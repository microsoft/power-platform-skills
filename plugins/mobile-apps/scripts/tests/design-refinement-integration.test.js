'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function section(markdown, startHeading, endHeading) {
  const start = markdown.indexOf(startHeading);
  const end = markdown.indexOf(endHeading, start + startHeading.length);
  assert.ok(start >= 0, `missing ${startHeading}`);
  assert.ok(end > start, `missing ${endHeading} after ${startHeading}`);
  return markdown.slice(start, end);
}

const REQUIRED_FLAGS = [
  '--orchestrated',
  '--working-dir',
  '--plan',
  '--brand',
  '--tokens',
  '--scope',
  '--ui-only',
  '--no-questions',
];

test('design skill defines a non-interactive plan-aware UI-only boundary', () => {
  const skill = read('skills/design-react-native-app/SKILL.md');
  const orchestrated = section(skill, '### Orchestrated UI-only mode', '## Understand the request');
  for (const marker of REQUIRED_FLAGS) assert.match(orchestrated, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const marker of [
    'Never ask a question',
    'Read the full approved contract',
    'Treat plan and brand artifacts as read-only',
    'Modify only files named by',
    'Do not modify behavior',
    'Never edit',
    'Do not install dependencies',
  ]) assert.match(orchestrated, new RegExp(marker));
  assert.match(skill, /DONE_WITH_CONCERNS:/);
  assert.match(skill, /NEEDS_CONTEXT:/);
  assert.match(skill, /BLOCKED:/);
});

test('all generation workflows invoke refinement with the bounded contract', () => {
  const workflows = [
    {
      file: 'skills/create-mobile-app/SKILL.md',
      start: '#### Step 11.5 — Automated Design Refinement (LLM Polish)',
      end: '#### Optional static preview',
    },
    {
      file: 'skills/create-mobile-prototype/SKILL.md',
      start: '### Step 9.6 - Automated Design Refinement (LLM Polish)',
      end: '### Step 10 - Record State And Start Metro',
    },
    {
      file: 'skills/sync-from-plan/SKILL.md',
      start: '### Step 6.5 - Automated Design Refinement (LLM Polish)',
      end: '### Step 7 - Optional Static Preview',
    },
  ];
  for (const workflow of workflows) {
    const block = section(read(workflow.file), workflow.start, workflow.end);
    assert.match(block, /\/design-react-native-app/);
    for (const flag of REQUIRED_FLAGS) assert.ok(block.includes(flag), `${workflow.file} missing ${flag}`);
    for (const marker of ['changed-file', 'route', 'quality', 'contrast', 'composition', 'type-check|TypeScript']) {
      assert.match(block, new RegExp(marker, 'i'), `${workflow.file} missing ${marker}`);
    }
    assert.match(block, /audit-ui-only-refinement\.js/);
    assert.match(block, /--capture/);
    assert.match(block, /--verify/);
    assert.match(block, /auditor's `changed` list as (?:the )?authoritative/i);
    assert.match(block, /unapproved\s+media/i);
    assert.match(block, /preserve[\s\S]{0,180}routes[\s\S]{0,180}(?:data|service)[\s\S]{0,180}experience-\*/i);
  }
});

test('Gate 3 preview has one validated renderer owner', () => {
  const planner = read('agents/native-app-planner.md');
  const screenPlanner = read('agents/screen-planner.md');
  const renderer = read('scripts/render-mobile-plan.js');
  assert.match(planner, /build-gate3-preview-contract\.js/);
  assert.match(planner, /--preview-contract/);
  assert.match(planner, /\.tmp\/gate3-preview-contract\.json/);
  assert.match(screenPlanner, /Do not generate `_plan_preview\.html`/);
  assert.doesNotMatch(screenPlanner, /Write file_path="<working_dir>\/_plan_preview\.html"/);
  assert.match(renderer, /function renderStructuralPreview/);
  assert.match(renderer, /Gate 3 structural design preview/);
});

test('post-build HTML is opt-in and reads generated brand tokens first', () => {
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  const sync = read('skills/sync-from-plan/SKILL.md');
  const preview = read('skills/preview-screens/SKILL.md');
  assert.match(prototype, /only when the original request includes `--preview`/);
  assert.match(sync, /Only when the request includes `--preview`/);
  assert.match(preview, /Read generated brand tokens first/);
  assert.match(preview, /brand\/tokens\.ts/);
  assert.match(preview, /parsing\s+only `tamagui\.config\.ts` silently falls back/);
});

test('native visual QA requires locale evidence for approved RTL support', () => {
  const visualQa = read('skills/visual-qa/SKILL.md');
  const create = read('skills/create-mobile-app/SKILL.md');
  assert.match(visualQa, /--rtl-locale <locale>/);
  assert.match(visualQa, /source inspection are not RTL proof/);
  assert.match(visualQa, /Home plus the most text-dense form\/list route/);
  assert.match(visualQa, /Missing required RTL locale support or capture/);
  assert.match(create, /Pass `--rtl-locale <locale>`/);
});