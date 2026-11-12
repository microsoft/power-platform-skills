'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createSkillPhaseA, createSkillPhaseB } = require('./helpers/create-skill');

const pluginRoot = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8').replace(/\r\n?/g, '\n');
const lean = read('agents/preview-screen-builder.md');
const full = read('agents/screen-builder.md');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section boundary: ${end}`);
  return source.slice(from, to);
}

test('the preview builder stays lean, because its size is paid on every turn of every builder', () => {
  // Measured: the full screen-builder (about 140 KB) took 3.5 to 7 minutes per screen, most of it
  // reading. The preview's first screen waits on this agent, so its instructions stay small.
  assert.ok(Buffer.byteLength(lean) < 12 * 1024, `preview-screen-builder.md is ${Buffer.byteLength(lean)} bytes`);
  const frontmatter = lean.split('---')[1];
  assert.match(frontmatter, /^name: preview-screen-builder$/m);
  assert.match(frontmatter, /^user-invocable: false$/m);
  // An explicit model breaks Copilot CLI (it rejects `sonnet`); both hosts inherit the session model.
  assert.doesNotMatch(frontmatter, /^model:/m);
});

test('the preview builder reads one screen\'s worth, writes once, and checks only its own file', () => {
  const steps = section(lean, '## Steps', '## Rules');
  assert.match(steps, /\*\*Read, in one message\.\*\*/);
  assert.match(steps, /`screens_file`/);
  assert.match(steps, /in one `Write`, replacing the whole file/);
  assert.match(steps, /npx --no-install tsc --noEmit 2>&1 \| grep -F/);
  assert.match(steps, /check-data-layer\.js/);
  assert.match(steps, /Errors in other files belong to sibling builders/);
  // The data layer is written alongside: the check polls for its barrel every 2 s, so a builder
  // finished early returns within seconds of it (fixed 20 s sleeps cost the first screen 20 s).
  assert.match(steps, /for i in \$\(seq 1 90\); do \[ -f src\/hooks\/data\/index\.ts \] && break; sleep 2; done/);
  // It never reads the long design references the full builder requires.
  assert.doesNotMatch(lean, /mobile-design-philosophy\.md|mobile-ui-patterns\.md|screen-templates\.md/);
});

test('the preview builder keeps the rules that make a screen correct', () => {
  for (const rule of [
    /comes from `@\/hooks\/data`/,
    /branch on `result\.ok`/,
    /`cancelled`[\s\S]*`denied`, `unavailable`, and `error`/,
    /`<field>Uri`/,
    /useLocalSearchParams<\{ id: string \}>\(\)/,
    /`push` a record drill-down, `navigate` to a singleton[\s\S]*`replace` for sign-in and sign-out/,
    /keyExtractor=\{\(item\) => item\.id\}/,
    /ListEmptyComponent/,
    /RefreshControl/,
    /KeyboardAvoidingView/,
    /through `onChangeText`/,
    /Ionicons/,
    /Button\.Text/,
    /Profile alone signs out/,
  ]) {
    assert.match(lean, rule);
  }
  assert.match(lean.slice(lean.indexOf('## Return status')), /`DONE`[\s\S]*`DONE_WITH_CONCERNS: <concerns>`[\s\S]*`NEEDS_CONTEXT: <what is missing>`[\s\S]*`BLOCKED: <reason>`/);
});

test('a live run\'s lessons stay fixed: plugin root, blocking wait, validator-shaped locks', () => {
  // Without the plugin root a builder searched the disk for 30 s and skipped the data-layer check.
  assert.match(lean, /`plugin_root`, the plugin's install directory: `\$\{PLUGIN_ROOT\}` below means that path/);
  assert.match(section(createSkillPhaseA(), '#### 6.1', '#### 6.2'), /plugin_root: \$\{PLUGIN_ROOT\}/);
  assert.match(section(createSkillPhaseB(), '### Step 9.3', '### Step 10 '), /plugin_root: \$\{PLUGIN_ROOT\}/);
  // The spawn result says "you'll be notified"; the notice lagged the builder by a minute.
  assert.match(section(createSkillPhaseA(), '#### 6.1', '#### 6.2'), /Keep working in this turn: write the data layer \(6\.2\), then run 6\.3's command, which waits on the entry screen's `done_file`/);
  assert.match(lean, /\*\*Signal, then return\.\*\* Write your status's first line to `done_file`/);
  // Step 7's validator blocked a builder's screen after the fact; builders now run it themselves,
  // and write locks in the shapes it accepts.
  assert.match(lean, /validate-mobile-files\.js" --project-root '<working_dir>' --file '<target_file>'/);
  assert.match(lean, /if \(isSubmitting\) return; setIsSubmitting\(true\); try \{ \.\.\. \} finally \{ setIsSubmitting\(false\); \}/);
  assert.match(lean, /a left stripe \(`borderLeftWidth`\) with a plain text label, or a `StatusPill`/);
  assert.match(section(createSkillPhaseA(), '### Step 7', '### Step 8'), /a builder that has returned is finished/);
  // The orchestrator read core.ts and hook sources and messaged builders before writing the data
  // layer, which the first screen waits on.
  assert.match(createSkillPhaseA(), /\*\*Wait on files, not notices\.\*\*/);
  assert.match(section(createSkillPhaseA(), '#### 6.2', '#### 6.3'), /`core\.ts` and the hook sources stay closed/);
  assert.match(section(createSkillPhaseA(), '### Step 3 ', '#### 3.1'), /a read of \[`preview-data-layer\.md`\]/);
});

test('Phase A builds with the preview builder and Phase B brings every screen to the full checklist', () => {
  const phaseA = createSkillPhaseA();
  assert.match(phaseA, /Spawn agent: mobile-app:preview-screen-builder/);
  assert.doesNotMatch(phaseA, /Spawn agent: mobile-app:screen-builder\b/);

  const pass = section(createSkillPhaseB(), '### Step 9.3', '### Step 10 ');
  assert.match(pass, /Spawn agent: mobile-app:screen-builder/);
  assert.match(pass, /spec_source: built/);
  assert.match(pass, /This runs on every path, `--no-design` included/);
  assert.match(pass, /Collect every builder before Step 11 starts/);
  assert.match(pass, /run Step 7's whole-app check once more/);

  const quality = section(full, '## Quality pass', '## Workflow');
  assert.match(quality, /Read `target_file` first\. Its layout, data use, navigation, and copy are what the user approved: keep them\./);
  assert.match(quality, /every Hard Rule and every Quality checklist item/);
  assert.match(full, /`spec_source` \(optional\) - `built`/);
  assert.doesNotMatch(full, /spec_source: graph|\[Graph mode\]/);
});
