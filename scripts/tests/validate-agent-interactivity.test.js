// Guards the guard. validate-agent-interactivity.js exists because an agent declaring an
// interactive tool specifies a flow that CANNOT complete — a Task subagent is headless, so the
// question is never answered — and nothing else in the repo reads agent frontmatter. The
// /genpage Phase 1 contradiction survived ~2.5 months for exactly that reason, so the cases that
// matter most are the ones asserting this does not stay silent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  frontmatterOf,
  interactiveToolsIn,
  agentFiles,
  INTERACTIVE_TOOLS,
  SCAN_PATHS,
} = require('../validate-agent-interactivity.js');

const ROOT = path.resolve(__dirname, '..', '..');

test('a headless agent passes', () => {
  const fm = 'name: worker\ntools:\n  - Read\n  - Write\n  - Bash';
  assert.deepEqual(interactiveToolsIn(fm), []);
});

test('each interactive tool is detected on its own', () => {
  for (const tool of INTERACTIVE_TOOLS) {
    assert.deepEqual(interactiveToolsIn(`tools:\n  - Read\n  - ${tool}`), [tool], tool);
  }
});

test('all three are reported together, so one run names every problem in a file', () => {
  const fm = 'tools:\n  - Read\n  - EnterPlanMode\n  - ExitPlanMode\n  - AskUserQuestion';
  assert.deepEqual(interactiveToolsIn(fm).sort(), ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
});

test('the inline / comma-separated tool form is caught too', () => {
  assert.deepEqual(interactiveToolsIn('allowed-tools: Read, Write, AskUserQuestion'), ['AskUserQuestion']);
});

// A substring must not trip it: an agent legitimately named or describing something like
// "AskUserQuestionnaireBuilder" is not declaring the tool.
test('matching is word-bounded, not substring', () => {
  assert.deepEqual(interactiveToolsIn('tools:\n  - AskUserQuestionnaire'), []);
  assert.deepEqual(interactiveToolsIn('tools:\n  - MyEnterPlanModeHelper'), []);
});

// The frontmatter extractor must stop at the FIRST closing `---`, but it must not be fooled by a
// markdown horizontal rule in the BODY into reading further — nor stop early and miss a
// declaration. Several agents use `---` as a section break.
test('frontmatterOf reads only the leading block, and a body rule does not extend it', () => {
  const doc = ['---', 'name: a', 'tools:', '  - Read', '---', '', '# Body', '', '---', '', 'tools:', '  - AskUserQuestion'].join('\n');
  const fm = frontmatterOf(doc);
  assert.match(fm, /name: a/);
  assert.doesNotMatch(fm, /AskUserQuestion/, 'a declaration below a body rule is not frontmatter');
});

test('a file with no frontmatter yields an empty block rather than throwing', () => {
  assert.strictEqual(frontmatterOf('# Just a heading\n'), '');
  assert.strictEqual(frontmatterOf(''), '');
});

test('an unterminated frontmatter block yields empty rather than swallowing the file', () => {
  assert.strictEqual(frontmatterOf('---\nname: a\ntools:\n  - AskUserQuestion\n'), '');
});

// The real repository must satisfy the rule — this is what actually fails a PR.
test('every scanned agent in the repo is headless', () => {
  let checked = 0;
  for (const rel of SCAN_PATHS) {
    const files = agentFiles(path.join(ROOT, rel));
    assert.ok(files.length > 0, `expected agents under ${rel}`);
    for (const f of files) {
      checked += 1;
      const found = interactiveToolsIn(frontmatterOf(fs.readFileSync(f, 'utf8')));
      assert.deepEqual(found, [], `${path.relative(ROOT, f)} declares ${found.join(', ')}`);
    }
  }
  assert.ok(checked >= 6, `expected to scan the genpage agents, scanned ${checked}`);
});

// The scope is deliberately narrow (other plugins still carry these declarations). Pinning it
// means widening the scan is a conscious edit with a test change, not an accident.
test('the scan scope is explicit', () => {
  assert.deepEqual(SCAN_PATHS, [path.join('plugins', 'model-apps', 'agents')]);
});
