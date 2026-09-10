'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('create and edit own strict source checks and full-screen presentation handoffs', () => {
  for (const file of ['skills/create-mobile-app/references/phase-09-build.md', 'skills/edit-app/SKILL.md']) {
    const text = read(file);
    assert.match(text, /validate-screen-quality\.js"? --report --strict/);
    assert.match(text, /validate-color-contrast\.js"? --report --strict/);
    assert.match(text, /native-visual-review\.md/);
    assert.match(text, /provenance/);
    assert.match(text, /unverified/);
    assert.match(text, /component/);
    assert.match(text, /source-pattern heuristics/);
  }
  const hooks = JSON.parse(read('hooks/hooks.json')).hooks;
  assert.equal(hooks.PostToolUse, undefined);
});

test('preview freshness is tied to exact reviewed inputs without creating a second approval', () => {
  const preview = read('skills/preview-screens/SKILL.md');
  assert.match(preview, /preview-provenance\.js.*--write/);
  assert.match(preview, /preview-provenance\.js.*--check/);
  assert.match(preview, /--scope "<full-screens\|components>"/);
  assert.match(preview, /never merely restamp/);
  assert.match(preview, /Reload the page from disk/);
  const review = read('shared/references/native-visual-review.md');
  assert.match(review, /not a new design brief, another approval authority/);
  assert.match(review, /not dependency|cannot\s+discover omitted dependencies/);
  assert.match(review, /accepted design is the minimum presentation baseline/);
  assert.match(review, /Do not tie that baseline to a particular model/);
  assert.match(review, /component-only/);
});

test('image guidance distinguishes storage, resolution, cache and artwork without raw HTTP', () => {
  const media = read('shared/references/media-sources.md');
  const reads = read('agents/references/screen-builder/data-reads.md');
  assert.match(reads, /record are thumbnails/);
  assert.match(reads, /fullSize: true/);
  assert.match(media, /downloadImage\(id, columnName, fullSize = false\)/);
  assert.match(media, /passes `true`, checks the operation result's `success`/);
  assert.match(media, /CanStoreFullImage/);
  assert.match(media, /record, image column, resolution and\s+image version/);
  assert.match(media, /previous record's asynchronous result/);
  assert.match(media, /sharper,\s+not photographic/);
  assert.match(reads, /Never construct an authenticated URL or call raw HTTP/);
});

test('review explicitly checks applied typography, native chrome, long content and usable actions', () => {
  const review = read('shared/references/native-visual-review.md');
  for (const phrase of ['Actual component weight', 'intended row count', 'bottom insets',
    'wrapping/long content', 'resolution appropriate', 'scroll to it', 'ordinary clicks/keyboard']) {
    assert.ok(review.includes(phrase), phrase);
  }
  assert.match(review, /idle Metro terminal is not proof/);
  assert.match(review, /DONE_WITH_CONCERNS/);
  assert.match(review, /Do not impose equal heights/);
  assert.match(read('shared/references/tamagui-html-mapping.md'), /Do not infer\s+bold weight/);
});

test('bounded edit approvals consolidate without converting interrupted prompts into consent', () => {
  const edit = read('skills/edit-app/SKILL.md');
  assert.match(edit, /combine[\s\S]*one\s+foreground question/);
  assert.match(edit, /explicit acceptance of that exact proposal satisfies both gates/);
  assert.match(edit, /never covers new data\/schema/);
  assert.match(edit, /paused; edits have not started/);
  assert.match(edit, /repeated\s+screenshot is not consent/);
  assert.match(edit, /must not automatically reopen the same prompt/);
});

test('native typography contract is wired before builders and distinguished from static success', () => {
  const integration = read('skills/create-mobile-app/references/phase-07-integrations.md');
  const shell = read('skills/create-mobile-app/references/phase-08-screens.md');
  const build = read('skills/create-mobile-app/references/phase-09-build.md');
  const edit = read('skills/edit-app/SKILL.md');
  assert.match(integration, /createNativeTypography/);
  assert.match(integration, /assertNativeFontDefaults\(tamaguiConfig\)/);
  assert.match(integration, /final host factory call/);
  assert.match(shell, /nativeTypography.text/);
  assert.match(shell, /TypographyText/);
  for (const text of [integration, build, edit]) assert.match(text, /typography-unverified/);
});

test('fixed controls are reviewed for remaining task space, not only correct insets', () => {
  const platform = read('agents/references/screen-builder/platform.md');
  const detail = read('agents/references/screen-builder/detail.md');
  const review = read('shared/references/native-visual-review.md');
  assert.match(platform, /remaining scroll\s+viewport/);
  assert.match(platform, /short and long content/);
  assert.match(platform, /FilterChipRow/);
  assert.match(platform, /not a fixed height/);
  assert.match(detail, /CompactActionBar/);
  assert.match(detail, /48px-minimum/);
  assert.match(detail, /fixed percentage is right for every app/);
  assert.match(review, /valid button size inside a clipped viewport still fails/);
});

test('image seeding and manifest writes require live post-publish and original-byte verification', () => {
  const data = read('skills/add-dataverse/SKILL.md');
  const seed = read('skills/add-sample-data/SKILL.md');
  const media = read('shared/references/media-sources.md');
  assert.match(data, /Re-read the published\s+ImageAttributeMetadata/);
  assert.match(data, /values come from the Step 6c read-back/);
  assert.match(seed, /after each authorized original upload/);
  assert.match(seed, /Only the primary image can be supplied on create/);
  assert.match(media, /HTTP 204/);
  assert.match(media, /was false at upload time/);
  assert.match(media, /verifyImageColumn/);
  assert.match(media, /verifyImageRoundTrip/);
  assert.match(media, /Enabling storage does not\s+recreate discarded originals/);
});

test('shared queries keep observer visibility out of access guards', () => {
  const data = read('agents/references/screen-builder/data-reads.md');
  assert.match(data, /visibility in `enabled`/);
  assert.match(data, /never capture it in the shared `queryFn` access guard/);
  assert.match(data, /manual refetches/);
  assert.match(data, /Clear private query data on sign-out/);
  assert.match(data, /Test two observers sharing a key/);
});

test('design richness and approved local demo context are not treated as real-service promises', () => {
  const design = read('shared/references/design-planning.md');
  assert.match(design, /Do not overcorrect a crowded composition into a visually empty one/);
  assert.match(design, /neither adding nor removing a hero is a universal quality rule/);
  assert.match(design, /\*\*real integration\*\* from\s+\*\*explicit demo presentation\*\*/);
  assert.match(design, /Centralize shared demo values/);
  assert.match(design, /never use it to mask a failed request/);
});
