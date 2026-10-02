'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const updates = read('skills/check-updates/SKILL.md');
const create = read('skills/create-mobile-app/SKILL.md');
const lifecycle = read('shared/references/mobile-release-lifecycle.md');

test('native updates are evaluated independently of outdated-host discovery', () => {
  assert.match(updates, /even when the host is absent from `outdated\.json`/);
  assert.match(updates, /--requirements-only/);
  assert.match(updates, /Equal supported targets are valid/);
  assert.match(updates, /Do not require or fabricate template advancement/);
  assert.match(updates, /even if `hostInstallRequired` is false/);
  assert.doesNotMatch(updates, /Do not run `upgrade-template`/);
});

test('rehearsal, full-chain approval, drift checks and recovery are separate gates', () => {
  const rehearsal = updates.indexOf('Prepare isolated preview');
  const perEdge = updates.indexOf('repeat dry-run and apply');
  const approval = updates.indexOf('Apply reviewed release');
  const apply = updates.indexOf('### Apply only the approved plan');
  assert.ok(rehearsal < perEdge && perEdge < approval && approval < apply);
  assert.match(updates, /nonzero preview is never automatically a clean plan/);
  assert.match(updates, /`--no-install` to simulate state advancement/);
  assert.match(updates, /under `<working_dir>`/);
  assert.match(updates, /Changed inputs invalidate approval/);
  assert.match(updates, /restore only touched files/);
  assert.match(updates, /rollback or journal recovery cannot complete safely/);
  assert.match(updates, /Never report `DONE` for a partial migration/);
  assert.match(updates, /Skipping excludes all coupled packages/);
});

test('JavaScript updates retain approval and audit safeguards without native bumps', () => {
  assert.match(updates, /Skip package.*recommended default/);
  assert.match(updates, /exact JS dependency exceptions/);
  assert.match(updates, /installed transitive closure adds native code/);
  assert.match(updates, /isDirect: true/);
  assert.match(updates, /Ignore string-only `via` rollups/);
  assert.match(updates, /Never run `npx expo install --fix`/);
  for (const checkpoint of [
    'check_mobile_app_plugin_version', 'update_native_host_dependency',
    'update_microsoft_dependencies', 'update_remaining_npm_dependencies',
  ]) assert.ok(updates.includes(`\`${checkpoint}\``), checkpoint);
});

test('creation resolves a reviewed immutable release before planning or data mutations', () => {
  assert.match(create, /No reviewed release means `BLOCKED` before scaffolding or data-platform mutations/);
  assert.match(create, /mobile-template-lifecycle\.js acquire/);
  assert.match(create, /Separately approve dependency installation/);
  assert.match(create, /Never run acquisition over a non-empty directory/);
  assert.match(create, /Pass its sanitized compatibility context to every planner\/builder/);
  assert.match(create, /`app\.json` byte-for-byte/);
  assert.match(create, /project-rooted aliases/);
  assert.doesNotMatch(create, /npx degit|template#main/);
  assert.match(lifecycle, /initially has \*\*no releases and no default\*\*/);
  assert.match(lifecycle, /not an upstream service/);
  assert.match(lifecycle, /Per-customer optional-permission selection during wrapping\s+is not part/);
});
