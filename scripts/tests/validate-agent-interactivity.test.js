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
  selfInteractionProseIn,
  undeclaredSkillTools,
  declaredToolsIn,
  unportableToolsIn,
  agentFiles,
  skillFiles,
  INTERACTIVE_TOOLS,
  SCAN_PATHS,
  SKILL_SCAN_PATHS,
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

// The mirror-image defect. Moving interaction OUT of an agent and INTO the skill's main loop only
// works if the skill is ALLOWED to interact — /genpage was rewritten to call plan mode in the main
// loop while its allowed-tools declared neither tool, moving the flow to a second context that
// could not perform it either.
test('a skill that uses an interactive tool but does not declare it is flagged', () => {
  const doc = [
    '---',
    'name: x',
    'allowed-tools: Read, Write, Task',
    '---',
    '',
    'Present the plan with `EnterPlanMode` and approve via `ExitPlanMode`.',
  ].join('\n');
  assert.deepEqual(undeclaredSkillTools(doc).sort(), ['EnterPlanMode', 'ExitPlanMode']);
});

test('a skill that declares what it uses passes', () => {
  const doc = [
    '---',
    'name: x',
    'allowed-tools: Read, Write, Task, AskUserQuestion, EnterPlanMode, ExitPlanMode',
    '---',
    '',
    'Ask with `AskUserQuestion`, present with `EnterPlanMode`, approve with `ExitPlanMode`.',
  ].join('\n');
  assert.deepEqual(undeclaredSkillTools(doc), []);
});

test('a skill that mentions no interactive tool needs no declaration', () => {
  const doc = ['---', 'name: x', 'allowed-tools: Read, Bash', '---', '', 'Run the script.'].join('\n');
  assert.deepEqual(undeclaredSkillTools(doc), []);
});

// The frontmatter's own declaration must not be mistaken for body usage, or every correctly
// declared skill would report itself.
test('the declaration in the frontmatter is not counted as body usage', () => {
  const doc = ['---', 'allowed-tools: Read, AskUserQuestion', '---', '', 'No tool mentioned here.'].join('\n');
  assert.deepEqual(undeclaredSkillTools(doc), []);
});

// Every real skill in the scanned plugin must satisfy it — this is what fails the PR.
test('every scanned skill declares the interactive tools it uses', () => {
  for (const rel of SKILL_SCAN_PATHS) {
    const files = skillFiles(path.join(ROOT, rel));
    assert.ok(files.length > 0, `expected skills under ${rel}`);
    for (const f of files) {
      const missing = undeclaredSkillTools(fs.readFileSync(f, 'utf8'));
      assert.deepEqual(missing, [], `${path.relative(ROOT, f)} uses but does not declare ${missing.join(', ')}`);
    }
  }
});

// The tool-name check cannot see prose. Both planner agents described themselves as presenting
// "a plan for user approval via plan mode" while their own bodies correctly said the orchestrator
// does it — and `description` is the sentence the dispatching model reads, so it is the one most
// likely to be acted on. Scoped to frontmatter, which carries only name/description/color/tools.
test('frontmatter prose claiming the agent itself interacts is rejected', () => {
  const doc = [
    '---',
    'name: some-planner',
    'description: >-',
    '  Gathers requirements and presents a plan for user approval via plan mode.',
    'tools: Read, Write',
    '---',
    '# Body',
  ].join('\n');
  assert.deepEqual(selfInteractionProseIn(frontmatterOf(doc)), ['/\\bplan mode\\b/i']);
});

test('a frontmatter that describes what the agent RETURNS is accepted', () => {
  const doc = [
    '---',
    'name: some-planner',
    'description: >-',
    '  Gathers requirements and returns a proposed plan for the orchestrator to present.',
    'tools: Read, Write',
    '---',
    '# Body: the orchestrator presents it with EnterPlanMode and reports the outcome.',
  ].join('\n');
  assert.deepEqual(selfInteractionProseIn(frontmatterOf(doc)), []);
});

// A BODY may freely say the orchestrator uses plan mode — that is the correct statement, and
// flagging it would push authors to stop documenting the contract.
test('body prose about plan mode is not flagged', () => {
  const doc = ['---', 'name: a', 'description: Returns a plan.', 'tools: Read', '---',
    'The orchestrator presents this in plan mode and asks the user to approve.'].join('\n');
  assert.deepEqual(selfInteractionProseIn(frontmatterOf(doc)), []);
});

// Every real agent in the scanned plugin must satisfy it — this is what fails the PR.
test('no scanned agent claims in its frontmatter that it interacts', () => {
  for (const rel of SCAN_PATHS) {
    const files = agentFiles(path.join(ROOT, rel));
    assert.ok(files.length > 0, `expected agents under ${rel}`);
    for (const f of files) {
      const prose = selfInteractionProseIn(frontmatterOf(fs.readFileSync(f, 'utf8')));
      assert.deepEqual(prose, [], `${path.relative(ROOT, f)} frontmatter matched ${prose.join(', ')}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Cross-host tool portability — the second silent failure mode in the same frontmatter.
//
// Tool names are host-specific and every host IGNORES a name it does not recognize instead of
// reporting it, so a capability named only in a scheme the running host does not know is simply
// absent. The agent launches and then cannot run `node` or track progress, with nothing in any
// log explaining why. That is the same fail-silent shape as the interactivity defect above,
// which is why it is guarded in the same place.

test('Claude names that Copilot publishes as compatible aliases are accepted as-is', () => {
  // Read/Write/Bash ARE documented Copilot aliases, so they are already portable. A check that
  // cried wolf here would be tuned out, and the real defect below would go with it.
  assert.deepEqual(unportableToolsIn('tools:\n  - Read\n  - Write\n  - Bash'), []);
});

test('TaskCreate/TaskUpdate/TaskList alone are flagged — no host but Claude Code knows them', () => {
  const problems = unportableToolsIn('tools:\n  - Read\n  - TaskCreate\n  - TaskUpdate\n  - TaskList');
  assert.equal(problems.length, 1, problems.join('; '));
  assert.match(problems[0], /unknown to Copilot/);
  assert.match(problems[0], /declare 'todo'/);
});

test('adding the portable todo alias clears it', () => {
  assert.deepEqual(unportableToolsIn('tools:\n  - Read\n  - TaskCreate\n  - todo'), []);
});

test('a Copilot-only declaration is flagged as invisible to Claude Code', () => {
  const problems = unportableToolsIn('tools:\n  - execute\n  - todo');
  assert.equal(problems.length, 2, problems.join('; '));
  assert.ok(problems.every((p) => /unknown to Claude Code/.test(p)), problems.join('; '));
});

test('a host-specific namespaced tool name carries no assertion', () => {
  // `execute/runInTerminal` is a real Copilot CLI tool id. It is in neither table, and because
  // unrecognized names are ignored everywhere, declaring one is deliberately allowed.
  assert.deepEqual(unportableToolsIn("tools: ['execute/runInTerminal', 'read/readFile']"), []);
});

test('tool names mentioned in YAML comments are not read as declarations', () => {
  // The real agent frontmatter explains in a comment WHY both schemes are present, and names
  // TaskCreate/TaskUpdate/TaskList while doing so. Reading those as declared would make a file
  // pass or fail for reasons unrelated to what it actually grants.
  const fm = [
    '# TaskCreate/TaskUpdate/TaskList are NOT aliases anywhere - todo is the portable name.',
    'tools:',
    '  - Read',
    '  - todo  # portable name',
  ].join('\n');
  assert.deepEqual(declaredToolsIn(fm), ['Read', 'todo']);
});

test('the inline comma form parses like the block form', () => {
  assert.deepEqual(declaredToolsIn('allowed-tools: Read, Write, Bash'), ['Read', 'Write', 'Bash']);
});

test('the tool block ends at the next frontmatter key', () => {
  const fm = 'tools:\n  - Read\n  - todo\ncolor: green\ndescription: not a tool';
  assert.deepEqual(declaredToolsIn(fm), ['Read', 'todo']);
});

// Every real agent must satisfy it — this is what fails the PR.
test('every scanned agent declares each capability in a form both hosts recognize', () => {
  for (const rel of SCAN_PATHS) {
    const files = agentFiles(path.join(ROOT, rel));
    assert.ok(files.length > 0, `expected agents under ${rel}`);
    for (const f of files) {
      const problems = unportableToolsIn(frontmatterOf(fs.readFileSync(f, 'utf8')));
      assert.deepEqual(problems, [], `${path.relative(ROOT, f)}: ${problems.join('; ')}`);
    }
  }
});

// A skill's allowed-tools is the same kind of host-specific allow-list and fails the same silent
// way — /genpage and /app-builder both track progress through TaskCreate/TaskUpdate/TaskList,
// which no Copilot host recognizes.
test('every scanned skill declares each capability in a form both hosts recognize', () => {
  for (const rel of SKILL_SCAN_PATHS) {
    const files = skillFiles(path.join(ROOT, rel));
    assert.ok(files.length > 0, `expected skills under ${rel}`);
    for (const f of files) {
      const problems = unportableToolsIn(frontmatterOf(fs.readFileSync(f, 'utf8')));
      assert.deepEqual(problems, [], `${path.relative(ROOT, f)}: ${problems.join('; ')}`);
    }
  }
});

// The interactive tools have no portable equivalent — they are Claude-only names and there is
// nothing to declare alongside them. They must therefore carry NO portability assertion, or every
// skill that legitimately asks the user would fail this check.
test('interactive tool names carry no portability assertion', () => {
  assert.deepEqual(
    unportableToolsIn('allowed-tools: Read, read, AskUserQuestion, EnterPlanMode, ExitPlanMode'),
    []
  );
});
