'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(PLUGIN, ...parts), 'utf8');

test('app-builder and genpage both define unattended authoring behavior', () => {
  for (const [name, text] of [
    ['app-builder', read('skills', 'app-builder', 'SKILL.md')],
    ['genpage', read('skills', 'genpage', 'SKILL.md')],
  ]) {
    assert.match(text, /resolve-interaction-mode\.js/, `${name} must resolve attended vs unattended once`);
    assert.match(text, /POWER_PLATFORM_SKILLS_NONINTERACTIVE/, `${name} must honor the shared automation switch`);
    assert.match(text, /do not call `AskUserQuestion`|do not call AskUserQuestion/i, `${name} must suppress questions when unattended`);
    // Anchored to the unattended *decision*. A loose /plan.*approved/ also matches the ATTENDED
    // gate ("the build plan was already presented and approved"), so it passed before this rule
    // existed and asserted nothing. `\s+` rather than literal spaces: the phrase sits mid-paragraph
    // on hard-wrapped prose, so a pure re-wrap must not break CI.
    assert.match(text, /treat\s+the\s+plan\s+as\s+approved|as\s+the\s+approved\s+plan/i, `${name} must define unattended plan approval`);
    assert.match(text, /does not authorize destructive|never authorizes destructive/i, `${name} must keep destructive authority separate`);
  }
  const appBuilder = read('skills', 'app-builder', 'SKILL.md');
  // The general destructive-authority assertion above is satisfied by pre-existing prose, so
  // assert the concrete new rule: suppression does not grant `--allow-destructive`.
  assert.match(
    appBuilder,
    /still\s+requires\s+`--allow-destructive`/i,
    'unattended apply must still require explicit destructive authority',
  );
  assert.match(appBuilder, /append[\s\S]*`--non-interactive` to every `build-model-app\.js` invocation/i);
  assert.match(appBuilder, /resolve-interaction-mode\.js" \[--non-interactive\]/);
});

test('genpage planner prompt delimits binding contracts from upload-file status', () => {
  const skill = read('skills', 'genpage', 'SKILL.md');
  assert.match(skill, /BEGIN CONNECTOR BINDINGS[\s\S]*END CONNECTOR BINDINGS/);
  assert.match(skill, /BEGIN CUSTOM API BINDINGS[\s\S]*END CUSTOM API BINDINGS/);
  assert.match(skill, /upload file[\s\S]*not part of[\s\S]*section/i);
  // The delimiters only help if the planner is told they are framing. Without this the prompt
  // reads "use this as the entire section" over a block whose first/last lines are the
  // delimiters, and a verbatim copy yields a `missing-connector-table` schema error.
  for (const kind of ['CONNECTOR BINDINGS', 'CUSTOM API BINDINGS']) {
    // `[\s>]+` spans the blockquote wrap (`BEGIN/END\n> CONNECTOR BINDINGS`) and `\*{0,2}`
    // tolerates the bold `Do **not** copy`.
    assert.match(
      skill,
      new RegExp(`BEGIN/END[\\s>]+${kind}[^\\n]*-----[\\s\\S]{0,240}not\\*{0,2} copy them into`, 'i'),
      `${kind} delimiters must be marked as prompt framing, not plan content`,
    );
  }
  const planner = read('agents', 'genpage-planner.md');
  assert.match(
    planner,
    /prompt\s+delimiters,\s+not\s+content:\s+copy\s+only\s+what\s+is\s+between\s+them/i,
    'planner must be told the delimiters are not part of the section body',
  );
});
