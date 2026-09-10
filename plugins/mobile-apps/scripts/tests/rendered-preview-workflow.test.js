'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const preview = read('skills/preview-screens/SKILL.md');
const intent = read('skills/preview-screens/references/intent-authoring.md');
const review = read('shared/references/rendered-preview-review.md');

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
  assert.match(review, /preview-only scenario controls and explanations outside the app composition/);
  assert.match(read('skills/create-mobile-app/references/phase-09-build.md'),
    /Keep preview-only scenario controls out of native UI/);
});

test('a failed browser adapter triggers independent discovery rather than repeated profile retries', () => {
  assert.match(review, /tools actually advertised by the host/);
  assert.match(review, /shared\/integrated\s+browser page, then another independent available browser adapter/);
  assert.match(review, /One failed adapter does not mean all browser tools are unavailable/);
  assert.match(review, /Calling `tabs` after\s+`navigate` on the same locked adapter is not an independent fallback/);
  assert.match(review, /Never terminate the user's browser, delete profile locks/);
  assert.match(review, /bypass a tool's access restriction/);
  assert.match(review, /Respect browser\s+opt-out/);
  assert.match(preview, /If all independent available browser paths fail/);
  assert.match(preview, /File opening\s+is not rendered verification/);
});

test('rendered review uses current screenshots and interactions, a bounded repair and no beauty score', () => {
  assert.match(review, /Capture and inspect screenshots of every required frame/);
  assert.match(review, /after internal\s+scrolling where needed/);
  assert.match(review, /normal pointer\s+and keyboard actions/);
  assert.match(review, /No forced\s+click or direct handler injection/);
  assert.match(review, /one focused repair pass/);
  assert.match(review, /old observations must not be silently restamped/);
  assert.match(review, /not a new design\/data authority or a\s+beauty score/);
  assert.match(review, /cannot independently authenticate them or judge the image contents/);
  assert.match(review, /`complete` means the declared current review coverage is complete/);
});

test('review evidence gate is wired through design, preview, create, edit and native handoff', () => {
  for (const file of [
    'skills/preview-screens/SKILL.md',
    'skills/preview-screens/references/intent-authoring.md',
    'skills/design-system/SKILL.md',
    'skills/create-mobile-app/references/phase-04-design.md',
    'skills/edit-app/SKILL.md',
    'shared/references/native-visual-review.md',
  ]) assert.ok(read(file).includes('rendered-preview-review.md'), `${file} must execute the shared review`);
  for (const flag of ['--fingerprint', '--review', '--mode', '--screen-id', '--viewport', '--theme', '--require-source']) {
    assert.ok(review.includes(flag), `missing executable review input: ${flag}`);
  }
  for (const file of ['skills/design-system/SKILL.md', 'skills/preview-screens/SKILL.md', 'skills/edit-app/SKILL.md']) {
    assert.ok(read(file).includes('review_path'), `${file} must return review evidence`);
    assert.ok(read(file).includes('review_status'), `${file} must preserve review status`);
  }
  assert.match(read('skills/create-mobile-app/references/phase-09-build.md'), /validate-preview-review\.js/);
  assert.match(review, /DONE_WITH_CONCERNS: visual review incomplete/);
  assert.match(review, /remaining required failure returns `BLOCKED`/);
  assert.match(review, /explicit decision to proceed with that\s+unverified scope, but cannot relabel it verified/);
});

test('evidence example starts unverified rather than pre-approving unobserved screenshots', () => {
  const block = review.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block);
  const record = JSON.parse(block[1]);
  assert.equal(record.version, 1);
  assert.equal(record.observations[0].status, 'unverified');
  assert.deepEqual(record.observations[0].screenshots, []);
  assert.equal(record.observations[0].interaction, '');
  assert.match(review, /Never prefill successful observations/);
});

test('benchmarks preserve first-pass results without copying reference style into generation', () => {
  const evaluation = read('shared/references/ux-generation-evaluation.md');
  assert.match(evaluation, /Preserve the first-pass artifact before giving corrective feedback/);
  assert.match(evaluation, /reference-assisted revisions separately/);
  assert.match(evaluation, /cannot replace a weak prompt-only result/);
  assert.match(evaluation, /quality benchmarks, not app-specific generation rules/);
  assert.match(evaluation, /Do not require\s+the benchmark's brand color, domain fields, navigation or card layout/);
});

test('new rendered review reference resolves its local Markdown links', () => {
  const files = [
    'shared/references/rendered-preview-review.md',
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
  assert.match(intent, /Test two distinct records/);
  assert.match(intent, /read-only\/completed variant/);
  assert.match(intent, /not only show a\s+"saved" message/);
  assert.match(intent, /recheck its source in every scope/);
  assert.match(intent, /Exercise compound filters/);
  assert.match(intent, /reset after edits/);
  assert.match(intent, /"Control visible" or "still available" is not evidence/);
});

test('review calibrates real captures and binds each observation instead of bulk-restamping', () => {
  assert.match(review, /First capture one complete frame/);
  assert.match(review, /Open saved files as well as tool-returned images/);
  assert.match(review, /Measure the usable app frame separately/);
  assert.match(review, /or alter DOM\/CSS\/theme state/);
  assert.match(review, /Each inspected observation records its own\s+`previewSha256`/);
  assert.match(review, /measured `renderedViewport`/);
  assert.match(review, /"sha256": "<hash of inspected image bytes>"/);
  assert.match(review, /changing the top-level hash cannot refresh\s+old observations/);
  assert.match(review, /Do not copy one\s+case's successful checks into untested viewport\/theme cases/);
  assert.match(review, /Collect findings across the selected screens before editing/);
  assert.match(review, /Freeze candidate source\/HTML bytes before the final\s+review matrix/);
  assert.match(review, /Report evidence coverage, observed usability and user acceptance separately/);
  assert.match(preview, /Check computed colors on the element that owns the theme/);
});
