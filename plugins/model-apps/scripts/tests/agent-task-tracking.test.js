'use strict';
// Task tracking is optional for an agent. A host that recognizes the `todo` alias has not thereby handed a subagent a
// task tool: a Copilot CLI session gave genpage-page-builder only view, create, edit and grep although its frontmatter
// declares TaskCreate, TaskUpdate and todo. An agent whose steps say "call TaskCreate" and nothing else has an
// instruction it can only skip or fake, and the model improvises. Agent files are prose to every other test, so the
// wording that says what to do without a task tool is pinned here.
// See references/agent-interaction-contract.md -> "A declared tool is not always a delivered one".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..');
const AGENTS = path.join(PLUGIN, 'agents');

// Line endings normalized, as in the other document tests: a Windows checkout turns them into CRLF.
const readDoc = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const squash = (s) => s.replace(/\s+/g, ' ');

// An agent's instructions: everything after its frontmatter, which names the tools in comments and in the list.
function instructionsOf(text) {
  const lines = text.split('\n');
  assert.equal(lines[0], '---', 'an agent file starts with its frontmatter');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'the frontmatter is closed');
  return lines.slice(end + 1).join('\n');
}

// The sections of a document (a heading and what follows up to the next heading), each with its fenced code blocks
// taken out: a fence holds a template or an example, and a tool named inside one is not an instruction to use it.
// A heading-looking line inside a fence is not a heading either (the planner's plan template has several).
function sectionsOf(instructions) {
  const sections = [{ heading: '(start)', lines: [] }];
  let inFence = false;
  for (const line of instructions.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s/.test(line)) sections.push({ heading: line.trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections.map((s) => ({ heading: s.heading, text: squash(s.lines.join('\n')) }));
}

// Headings of the sections that tell the reader to use a task tool without saying what to do with none. A section
// "tells" the reader when it names TaskCreate or TaskUpdate; it says what to do with none when it opens that case
// ("If you have a task tool") and closes it ("never say you created a task").
function unconditionalTaskToolSections(instructions) {
  return sectionsOf(instructions)
    .filter((s) => /\bTask(?:Create|Update)\b/.test(s.text))
    .filter((s) => !(/If you have a task tool/.test(s.text) && /never say you created a task/.test(s.text)))
    .map((s) => s.heading);
}

test('the check finds a step that uses a task tool with no alternative, and passes one that has it', () => {
  const unconditional = '## Step 4 — Create a Task\n\nCall `TaskCreate` for: "Generate page"\n\nMark it as in_progress immediately.\n';
  assert.deepEqual(unconditionalTaskToolSections(unconditional), ['## Step 4 — Create a Task']);

  const conditional = [
    '## Step 4 — Track the Page',
    '',
    '- **If you have a task tool** (`TaskCreate`/`TaskUpdate`): create the task.',
    '- **If you have none**: skip it and never say you created a task.',
    '',
  ].join('\n');
  assert.deepEqual(unconditionalTaskToolSections(conditional), []);

  // A tool named in a code fence is a template value, not an instruction; a section that names no tool is not judged.
  const fenced = '## Step 7\n\nReturn:\n\n```\nTask tool: [TaskCreate/TaskUpdate | todo]\n```\n\n## Other\n\nUse `todo` if you like.\n';
  assert.deepEqual(unconditionalTaskToolSections(fenced), []);

  // Both halves are needed: naming the tool and promising to skip it is not the same as saying when.
  const half = '## Step 4\n\nCall `TaskCreate`, and never say you created a task you did not.\n';
  assert.deepEqual(unconditionalTaskToolSections(half), ['## Step 4']);
});

const AGENT_FILES = fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md')).sort();

test('every agent that tracks its work with a task tool says what to do when it has none', () => {
  const tracking = [];
  const offenders = [];
  for (const file of AGENT_FILES) {
    const instructions = instructionsOf(readDoc(path.join(AGENTS, file)));
    if (/\bTaskCreate\b/.test(instructions)) tracking.push(file);
    for (const heading of unconditionalTaskToolSections(instructions)) offenders.push(`${file}: ${heading}`);
  }
  assert.deepEqual(offenders, [], 'these steps name TaskCreate/TaskUpdate without saying what to do with no task tool');
  // The check had something to judge: a set of agents that stopped naming the tool would pass it for nothing.
  assert.ok(tracking.includes('genpage-page-builder.md'), `the page builder names the task tool (agents that do: ${tracking.join(', ')})`);
});

test('the page builder tracks its page with a task tool only if it has one, and in plain words when it has none', () => {
  const instructions = instructionsOf(readDoc(path.join(AGENTS, 'genpage-page-builder.md')));
  const step4 = sectionsOf(instructions).find((s) => /^## Step 4\b/.test(s.heading));
  assert.ok(step4, 'Step 4 is where it was');
  assert.match(step4.heading, /Track the Page/);

  // The tool case: unchanged behaviour where a task tool exists.
  assert.match(step4.text, /\*\*If you have a task tool\*\* \(`TaskCreate`\/`TaskUpdate` on Claude Code, `todo` where Copilot provides it\): create the task and mark it `in_progress`\./);
  // The case the Copilot CLI hit: nothing to call, nothing to search for, nothing to claim.
  assert.match(step4.text, /\*\*If you have none\*\*: do not search for one, do not call a tool you were not given, and never say you created a task\./);
  assert.match(step4.text, /Open your first message with `Task: Generate \[Page Name\] page — in progress` instead; Step 7 closes it\./);
  assert.match(step4.text, /check the tools you were actually given, once/);
  assert.match(step4.text, /Copilot CLI session gives this agent only its file and search tools/);

  assert.doesNotMatch(squash(instructions), /Call `TaskCreate` for:/, 'no unconditional call to TaskCreate is left');
  assert.doesNotMatch(squash(instructions), /Mark it as in_progress immediately/);
});

test('the page builder\'s result closes the task, says which tool tracked it, and keeps the lines the orchestrators read', () => {
  const instructions = readDoc(path.join(AGENTS, 'genpage-page-builder.md'));
  const step7 = instructions.split(/^## Step 7 — Return Result$/m)[1].split(/^## Critical Constraints$/m)[0];
  assert.match(squash(step7), /Close the task from Step 4 \(mark it complete if you have a task tool\)\./);
  const block = /```\n([\s\S]*?)\n```/.exec(step7);
  assert.ok(block, 'the result template is a code block');
  assert.deepEqual(block[1].split('\n'), [
    'Page: [Page Name]',
    'File: [working directory]/[filename].tsx',
    'Status: Written',
    'Task: Generate [Page Name] page — complete',
    'Task tool: [TaskCreate/TaskUpdate | todo | none on this host]',
  ]);
});

test('the frontmatter still declares the task tool in both naming schemes, and says a declaration is not delivery', () => {
  const text = readDoc(path.join(AGENTS, 'genpage-page-builder.md'));
  const frontmatter = text.split('\n---\n')[0];
  const tools = frontmatter.split('\n').filter((l) => /^\s+- \S+$/.test(l)).map((l) => l.replace(/^\s+- /, ''));
  for (const name of ['TaskCreate', 'TaskUpdate', 'todo']) assert.ok(tools.includes(name), `${name} stays declared`);
  // The explanation lives in the frontmatter's own comment block, one `# ` per line.
  const comment = squash(frontmatter.split('\n').filter((l) => l.startsWith('#')).map((l) => l.replace(/^#\s?/, '')).join('\n'));
  assert.match(comment, /a Copilot CLI session gave this agent no task tool at all, so Steps 4 and 7 say what to do without one/);
});

test('the interaction contract explains that a declared tool is not always a delivered one', () => {
  const doc = squash(readDoc(path.join(PLUGIN, 'references', 'agent-interaction-contract.md')));
  // assert.ok with a message: a failed assert.match would print the whole document.
  const says = (re, what) => assert.ok(re.test(doc), `the contract must say ${what}`);
  says(/## A declared tool is not always a delivered one/, 'it has a section on a declared tool that is not delivered');
  says(/Declaring a capability in both schemes makes a host \*recognize\* it\. It does not make the host \*hand it to a subagent\*\./, 'that a declaration is recognized, not delivered');
  says(/So an agent never \*depends\* on a task tool\./, 'that an agent never depends on a task tool');
  says(/agent-task-tracking\.test\.js/, 'which test pins the wording');
});
