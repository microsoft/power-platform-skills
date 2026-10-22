'use strict';
// #673 — the skill text is the only thing that stops an unattended run from passing
// --overwrite-deployed. A prompt the user cannot see must never become permission to replace
// a deployed page. These assertions are anchored to that rule, the record step, and the
// workflow-log instruction, not to nearby prose that happens to share a word.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const editFlow = fs.readFileSync(path.join(ROOT, 'skills', 'genpage', 'edit-flow.md'), 'utf8');
const skill = fs.readFileSync(path.join(ROOT, 'skills', 'genpage', 'SKILL.md'), 'utf8');
const verifyFlow = fs.readFileSync(path.join(ROOT, 'skills', 'genpage', 'verify-flow.md'), 'utf8');

test('the edit flow records a base after download and binds a chosen local file to the observed hash', () => {
  const phase2 = editFlow.split('## Edit Phase 2:')[1].split('## Edit Phase 3:')[0];
  assert.match(phase2, /genpage-base\.js" record --app-id '<app-id>' --page-id '<page-id>' --file '<working-dir>\/<page-id>\/page\.tsx'/);
  assert.match(phase2, /Starting from a local copy/);
  assert.match(phase2, /--deployed-sha256 '<deployedSha256>'/);
  assert.match(phase2, /<working-dir>\/<page-id>\/page\.tsx/);
  assert.match(phase2, /workflow-log\.md/);
});

test('unattended upload never passes --overwrite-deployed, in both the edit flow and the create skill', () => {
  for (const [name, text] of [['edit-flow', editFlow], ['SKILL', skill]]) {
    assert.match(text, /Never pass `--overwrite-deployed`/, `${name} must forbid the overwrite flag when nobody can answer`);
    assert.match(text, /suppressing a prompt never authorizes an overwrite/i, name);
    assert.match(text, /workflow-log\.md/, `${name} must log the marker, the check, and the choice`);
    // The logged answer is a line of its own. A mention of the words in an options list is not a choice.
    assert.match(text, /Choice: Overwrite the deployed changes/, `${name} must record the overwrite answer as its own Choice line`);
    assert.match(text, /Choice: Stop so I can merge/, `${name} must record the stop answer as its own Choice line`);
  }
});

test('Phase 6.5 treats a refusal as someone else saving the page this run just deployed', () => {
  const phase = skill.split('### Phase 6.5:')[1].split('### Phase 6.7:')[0];
  assert.match(phase, /no-base/);
  assert.match(phase, /deployed-changed/);
  assert.match(phase, /someone else saved it/);
  assert.match(phase, /Never pass `--overwrite-deployed`/);
  assert.match(phase, /workflow-log\.md/);
});

test('the Phase 7.5 fix re-deploy reuses the marked code file and stops on a divergence refusal', () => {
  const phase = verifyFlow.split('## 7.5 Fix and Re-deploy')[1];
  assert.match(phase, /same `--code-file` that Phase 6 \(or Edit Phase 6\) uploaded/);
  for (const code of ['no-base', 'deployed-changed', 'deployed-unreadable']) assert.match(phase, new RegExp(code));
  assert.match(phase, /Choice: Overwrite the deployed changes/);
  assert.match(phase, /Choice: Stop so I can merge/);
  assert.match(phase, /Never pass `--overwrite-deployed` unless the user\s+chose/);
  assert.match(phase, /workflow-log\.md/);
});

test('an unattended local copy is bound only when it matches the deployed page', () => {
  const section = editFlow.split('### Starting from a local copy')[1].split('## Edit Phase 3:')[0];
  assert.match(section, /contentSame` false[\s\S]*\*\*Unattended:\*\* STOP and report `code` when present, `lines`, and `deployedCopy`/);
  assert.match(section, /Do not record and do not bind/);
  assert.match(section, /Naming a base does not authorize a file that does not match the deployed page/);
  assert.match(section, /authorizes using that file only when it matches the deployed page/);
  assert.doesNotMatch(section, /Naming it is the authorization to use that base/);
  assert.match(section, /ask which base to edit/);
  assert.match(section, /`deployed` is `"changed"`[\s\S]*\*\*Attended:\*\* show the summary and ask before recording over that marker/);
  assert.match(section, /`deployed` is `"changed"`[\s\S]*\*\*Unattended:\*\* STOP and report `code` when present, `lines`, and `deployedCopy`/);
});

test('docs record the uploaded hash, not a readback the service may have rewritten', () => {
  for (const [name, text] of [['SKILL', skill], ['edit-flow', editFlow], ['verify-flow', verifyFlow]]) {
    assert.doesNotMatch(text, /as the service stored it/, `${name} must not treat a readback as the trusted base`);
    assert.match(text, /upload-unverified/, `${name} must name the unverified marker source`);
  }
});
