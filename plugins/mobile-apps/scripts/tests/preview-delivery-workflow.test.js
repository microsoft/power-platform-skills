'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const preview = read('skills/preview-screens/SKILL.md');
const intent = read('skills/preview-screens/references/intent-authoring.md');

test('preview selection demonstrates the primary work without a fixed screen or domain template', () => {
  const spec = read('shared/references/screen-planning/spec-contract.md');
  const planner = read('agents/screen-planner.md');
  const designPhase = read('skills/create-mobile-app/references/phase-04-design.md');
  assert.match(spec, /Selection must demonstrate the primary working activity, not only valid IDs/);
  assert.match(spec, /name the journey step shown/);
  assert.match(spec, /A reader, conversation or form may itself be the main activity/);
  assert.match(spec, /Add a necessary frame rather than forcing three/);
  assert.match(planner, /Show the primary working activity itself/);
  assert.match(intent, /not merely reachable through a hidden modal/);
  assert.match(intent, /not a ban on forms/);
  assert.match(designPhase, /foreground revises the existing\s+Preview selection before rendering/);
});

test('visual recipes must become concrete rendered treatments instead of component names', () => {
  for (const evidence of [
    /recognizable task\/record context/,
    /Decorative cards and separators need\s+not all use the same strong control outline/,
    /repeated full-width button in every row is not a default/,
    /recognizable local SVG\/icon artwork/,
    /colored box saying "photo" cannot validate\s+media prominence/,
    /mark the selected\s+populated media treatment unverified/,
    /not the smallest fixture that makes\s+handlers pass/,
  ]) assert.match(intent, evidence);
  assert.match(intent, /No fixed colors, card count, density or screenshot imitation/);
  assert.match(intent, /do not automatically improve\s+weak grouping/);
  assert.match(read('skills/design-system/references/design-system-schema.md'),
    /Choose a visible treatment, not only a component name/);
});

test('simulation UI is outside app frames without pretending native controls execute', () => {
  assert.match(preview, /Put simulation controls/);
  assert.match(preview, /outside `data-preview-screen-id` frames/);
  assert.match(preview, /normal app controls must not pretend to execute native success/);
  assert.match(preview, /Native-only — not executed in browser/);
  assert.match(read('skills/create-mobile-app/references/phase-09-build.md'),
    /Keep preview-only scenario controls out of native UI/);
});

test('ordinary preview delivery opens or links without launching browser tests', () => {
  assert.match(preview, /## 6 — Open and report/);
  assert.match(preview, /Honor `visual_companion: no` and legacy `skip`/);
  assert.match(preview, /open or reload the preview for the user/);
  assert.match(preview, /If page opening fails, use the OS opener/);
  assert.match(preview, /Stop after delivery/);
  assert.match(preview, /Do not automatically run Playwright\/browser interactions, screenshot\s+capture/);
  assert.match(preview, /Browser testing runs only when the user explicitly requests it as a separate task/);
  assert.match(preview, /absence of browser testing is not a failure or concern gate/);
  assert.match(preview, /do not imply automatic testing happened/);
});

test('static authoring review keeps design and correctness without screenshot evidence requirements', () => {
  assert.match(intent, /## Authoring review/);
  assert.match(intent, /source checks, not browser observations/);
  assert.match(intent, /Do not automatically run interactions/);
  assert.match(intent, /absence\s+of browser testing does not block completion/);
  assert.match(intent, /Static checks cannot establish effective rendered hit areas/);
  assert.match(preview, /Static checks before handoff/);
  assert.match(preview, /preview-provenance\.js/);
  assert.match(preview, /--require-source/);
});

test('removed review gate has no remaining workflow dependencies', () => {
  for (const file of [
    'scripts/validate-preview-review.js',
    'scripts/tests/validate-preview-review.test.js',
    'shared/references/rendered-preview-review.md',
  ]) assert.equal(fs.existsSync(path.join(root, file)), false, `${file} must be removed`);
  for (const file of [
    'skills/preview-screens/SKILL.md',
    'skills/preview-screens/references/intent-authoring.md',
    'skills/design-system/SKILL.md',
    'skills/create-mobile-app/references/phase-04-design.md',
    'skills/create-mobile-app/references/phase-09-build.md',
    'skills/edit-app/SKILL.md',
    'skills/design-system/references/refresh-flow.md',
    'shared/references/native-visual-review.md',
    'shared/memory-bank.md',
    'AGENTS.md',
    'README.md',
  ]) {
    assert.doesNotMatch(read(file),
      /rendered-preview-review\.md|validate-preview-review\.js|\breview_path\b|\breview_status\b|intent-preview-review\.json|implementation-preview-review\.json/,
      `${file} still depends on the removed gate`);
  }
});

test('source validation and foreground approval remain separate from optional browser testing', () => {
  const design = read('skills/design-system/SKILL.md');
  assert.match(design, /`DONE` requires both brand files, the intent preview and required static\/changed-file checks/);
  assert.match(design, /Only foreground approves through an actual available host question tool/);
  assert.match(design, /No browser testing is required/);
  assert.match(read('shared/shared-instructions.md'), /Browser testing requires a separate explicit user request/);
  const build = read('skills/create-mobile-app/references/phase-09-build.md');
  for (const gate of ['npx tsc --noEmit', 'check-routes.js', 'validate-mobile-files.js']) {
    assert.ok(build.includes(gate), `removal must preserve ${gate}`);
  }
});

test('benchmarks preserve first-pass results without copying reference style into generation', () => {
  const evaluation = read('shared/references/ux-generation-evaluation.md');
  assert.match(evaluation, /Preserve the first-pass artifact before giving corrective feedback/);
  assert.match(evaluation, /reference-assisted revisions separately/);
  assert.match(evaluation, /cannot replace a weak prompt-only result/);
  assert.match(evaluation, /quality benchmarks, not app-specific generation rules/);
  assert.match(evaluation, /Do not require\s+the benchmark's brand color, domain fields, navigation or card layout/);
});

test('remaining preview and evaluation references resolve their local Markdown links', () => {
  const files = [
    'shared/references/native-visual-review.md',
    'shared/references/ux-generation-evaluation.md',
    'skills/preview-screens/references/intent-authoring.md',
  ];
  for (const file of files) {
    for (const [, target] of read(file).matchAll(/\[[^\]]*\]\(([^)\s]+\.md(?:#[^)\s]+)?)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const destination = path.resolve(root, path.dirname(file), target.split('#')[0]);
      assert.ok(fs.existsSync(destination), `${file}: missing ${target}`);
    }
  }
});

test('entry quality is task-led rather than a domain layout or fuller fixture', () => {
  const design = read('shared/references/design-planning.md');
  assert.match(design, /Where am I\? Which content or work is relevant\? What can I do or read next\?/);
  assert.match(design, /Neither location-first\s+rows nor an organization-first header is a universal default/);
  assert.match(design, /before adding records, banners or metrics/);
  assert.match(design, /before shrinking typography or targets/);
  assert.match(design, /not a sparse wireframe/);
  assert.match(design, /not a percentage similarity gate/);
  assert.match(intent, /first-preview-usefulness/);
  assert.match(intent, /container level first/);
  assert.match(intent, /must not hide the date, amount, unit or distinguishing name/);
});

test('preview fidelity includes distinct records, compound filters and reset after edits', () => {
  assert.match(intent, /Keep one local scenario state/);
  assert.match(intent, /Model two distinct records/);
  assert.match(intent, /read-only\/completed variant/);
  assert.match(intent, /not only show a\s+"saved" message/);
  assert.match(intent, /recheck its source in every scope/);
  assert.match(intent, /Include compound filters/);
  assert.match(intent, /reset after edits/);
  assert.match(intent, /Handler presence is not evidence/);
});

test('manual evaluations do not reactivate automatic post-preview testing', () => {
  const evaluation = read('shared/references/ux-generation-evaluation.md');
  assert.match(evaluation, /runs only when a maintainer explicitly requests it/);
  assert.match(evaluation, /Ordinary HTML preview delivery does not trigger browser tests/);
  assert.match(preview, /Check theme selector ownership and inheritance in the stylesheet/);
});
