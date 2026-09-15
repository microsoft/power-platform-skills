#!/usr/bin/env node

/**
 * Validates that no plugin agent declares a tool that only works in an
 * INTERACTIVE session.
 *
 * WHY: agents under `plugins/<plugin>/agents/` are dispatched as `Task`
 * subagents, and a subagent is HEADLESS — `AskUserQuestion`, `EnterPlanMode`
 * and `ExitPlanMode` never reach the user from inside one. An agent that
 * declares them is specifying a flow that cannot complete: the subagent stalls
 * or silently skips the question, and the parent gets an answer nobody gave.
 *
 * This is not hypothetical. `/genpage` Phase 1 was specified to run its entire
 * interactive flow — prereqs, auth, the "create new / edit existing" question
 * and plan-mode approval — inside the `genpage-planner` subagent, while the same
 * plugin's AGENTS.md documented that subagents are headless and `/app-builder`
 * enforced the opposite rule. There was no compliant path through Phase 1, so
 * create flows could not complete (issue #541). The contradiction survived ~2.5
 * months because nothing checked for it: the frontmatter is prose to every test
 * in the repo.
 *
 * The rule is therefore: interaction belongs to the MAIN conversation loop. An
 * agent that needs input returns a structured REQUEST for it and the parent asks.
 *
 * SCOPE: model-apps only, and that is deliberate rather than an oversight.
 * `mobile-apps` and `power-pages` currently ship agents with the same
 * declarations; widening the scan today would fail PRs that have nothing to do
 * with this. Scrub a plugin, then add it to SCAN_PATHS — the same staged
 * approach `validate-no-real-environments.js` takes.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Add a plugin here only once its agents are scrubbed (see SCOPE above).
const SCAN_PATHS = [path.join('plugins', 'model-apps', 'agents')];

// Skills whose main loop owns the interaction, checked for the mirror-image defect below.
const SKILL_SCAN_PATHS = [path.join('plugins', 'model-apps', 'skills')];

// Tools that require a human on the other end of the conversation.
const INTERACTIVE_TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

// Tool names are HOST-SPECIFIC, and every host silently IGNORES a name it does not
// recognize rather than reporting it. That fail-silent behaviour is exactly why this needs
// a machine check: a capability named only in a scheme the running host does not know is
// simply absent, and the first symptom is a subagent that cannot run `node` or write a file
// — with nothing in any log saying why.
//   Copilot: "All unrecognized tool names are ignored, which allows product-specific tools to
//   be specified in an agent profile without causing problems."
//   https://docs.github.com/en/copilot/reference/custom-agents-configuration#tool-aliases
//   Claude Code behaves the same way: https://github.com/anthropics/claude-code/issues/93171
//
// Capability -> the Claude Code tool names that provide it. These are the names a Claude host
// recognizes; a capability declared ONLY as a Copilot primary alias (`execute`) is dropped there.
const CLAUDE_NAMES_FOR = {
  read: ['Read', 'NotebookRead'],
  edit: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  execute: ['Bash'],
  search: ['Grep', 'Glob'],
  agent: ['Task'],
  web: ['WebSearch', 'WebFetch'],
  // TaskCreate/TaskUpdate/TaskList are this repo's Claude-side todo tools.
  todo: ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'],
};

// Every tool name a Copilot host recognizes: the primary aliases plus the published
// compatible aliases, matched case-insensitively ("All aliases are case insensitive").
// NOTE the omissions that make this check worth having: TaskCreate, TaskUpdate and TaskList
// appear in NO published alias table, so on a Copilot host they are silently dropped and the
// agent loses progress tracking unless `todo` is also declared.
const COPILOT_RECOGNIZED = new Set(
  [
    'read', 'Read', 'NotebookRead',
    'edit', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
    'execute', 'shell', 'Bash', 'powershell',
    'search', 'Grep', 'Glob',
    'agent', 'custom-agent', 'Task',
    'web', 'WebSearch', 'WebFetch',
    'todo', 'TodoWrite',
  ].map((n) => n.toLowerCase())
);

// Claude-name -> capability, derived so the two tables cannot drift apart.
const CAPABILITY_OF = Object.entries(CLAUDE_NAMES_FOR).reduce((acc, [capability, names]) => {
  for (const n of names) acc[n] = capability;
  return acc;
}, {});

// Pull the YAML frontmatter block out of an agent .md. Returns '' when the file
// has no frontmatter, which is itself not an error here — this check is only
// about what a declared tool list contains.
function frontmatterOf(text) {
  // Frontmatter is the region between the FIRST `---` line and the next one.
  // Matched line-wise rather than with a lazy regex so a `---` inside the body
  // (a markdown horizontal rule, which several agents use) cannot terminate it
  // early and hide a declaration below.
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return '';
  const end = lines.indexOf('---', 1);
  if (end === -1) return '';
  return lines.slice(1, end).join('\n');
}

// Returns the interactive tools declared by one agent's frontmatter.
// Exported so the test can exercise the rule without touching the filesystem.
function interactiveToolsIn(frontmatter) {
  // The tool list is YAML, in either the block form
  //     tools:
  //       - Read
  //       - AskUserQuestion
  // or an inline/comma form (`allowed-tools: Read, Write, AskUserQuestion`).
  // A word-boundary match over the whole frontmatter covers both without
  // parsing YAML, and the names are distinctive enough that a false positive
  // would require an agent to mention the tool in its `description` — which is
  // itself worth flagging, since the description is what the model reads.
  return INTERACTIVE_TOOLS.filter((t) => new RegExp(`\\b${t}\\b`).test(frontmatter));
}

// Prose that claims the agent itself interacts, written WITHOUT naming a tool — so the
// tool-name check above cannot see it. Both planner agents described themselves as presenting
// "a plan for user approval via plan mode" while their own bodies correctly said the orchestrator
// does it; the `description` is what the dispatching model reads, so it is the sentence most
// likely to be acted on.
//
// Scoped to frontmatter, which carries only name/description/color/tools — there is no legitimate
// reason for any of those to mention plan mode or asking the user. A body may freely say
// "the orchestrator presents it with EnterPlanMode", and that is correct, so bodies are not scanned.
const SELF_INTERACTION_PROSE = [/\bplan mode\b/i, /\basks? the user\b/i, /\bprompts? the user\b/i];

function selfInteractionProseIn(frontmatter) {
  return SELF_INTERACTION_PROSE.filter((re) => re.test(frontmatter)).map((re) => String(re));
}

// Strip YAML comments before reading the tool list. These frontmatter blocks deliberately
// NAME tool aliases in their comments to explain why both naming schemes are present, so a
// plain regex over the raw text would read those explanations as declarations.
// Only whole-line and trailing comments are stripped; no value in this frontmatter is a
// quoted string containing '#', so there is nothing subtler to handle.
function stripYamlComments(frontmatter) {
  return frontmatter
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

// Returns every tool name a frontmatter declares, across the two forms in use here:
//     tools:                          allowed-tools: Read, Write, Bash
//       - Read                        tools: ['read/readFile', 'execute/runInTerminal']
//       - Write
// Quotes and list brackets are stripped so the inline array form parses like the comma form.
function declaredToolsIn(frontmatter) {
  const lines = stripYamlComments(frontmatter).split(/\r?\n/);
  const tools = [];
  let inBlock = false;
  for (const line of lines) {
    const inline = line.match(/^(?:tools|allowed-tools)\s*:\s*(\S.*)$/);
    if (inline) {
      tools.push(
        ...inline[1]
          .replace(/[[\]'"]/g, '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      );
      inBlock = false;
      continue;
    }
    if (/^(?:tools|allowed-tools)\s*:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const item = line.match(/^\s*-\s*(\S.*?)\s*$/);
      if (item) {
        tools.push(item[1].replace(/['"]/g, ''));
        continue;
      }
      // Any non-list line at column 0 ends the block (the next frontmatter key).
      if (/^\S/.test(line)) inBlock = false;
    }
  }
  return tools;
}

// Returns capabilities that are declared in a way one host cannot see, as human-readable
// problems. A one-sided declaration is not a style nit: the host that does not recognize the
// declared name drops it silently, and the agent runs without that capability.
function unportableToolsIn(frontmatter) {
  const declared = declaredToolsIn(frontmatter);
  const primaryAliases = new Set(Object.keys(CLAUDE_NAMES_FOR));

  // Group every declared name under the capability it provides, so each capability is judged
  // on the whole set of names declared for it rather than name by name.
  const byCapability = new Map();
  for (const tool of declared) {
    const capability = primaryAliases.has(tool.toLowerCase())
      ? tool.toLowerCase()
      : CAPABILITY_OF[tool];
    // A name in neither table (a host-specific tool, e.g. `execute/runInTerminal`) carries no
    // assertion: it is deliberately allowed, since unrecognized names are ignored everywhere.
    if (!capability) continue;
    if (!byCapability.has(capability)) byCapability.set(capability, []);
    byCapability.get(capability).push(tool);
  }

  const problems = [];
  for (const [capability, names] of byCapability) {
    if (!names.some((n) => CLAUDE_NAMES_FOR[capability].includes(n))) {
      problems.push(
        `${names.join('/')} (${capability}) is unknown to Claude Code — also declare one of ` +
          CLAUDE_NAMES_FOR[capability].join('/')
      );
    }
    if (!names.some((n) => COPILOT_RECOGNIZED.has(n.toLowerCase()))) {
      problems.push(
        `${names.join('/')} (${capability}) is unknown to Copilot — also declare '${capability}'`
      );
    }
  }
  return problems;
}

function agentFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(dir, e.name));
}

// The mirror-image defect, and the one that makes the fix for the first incomplete: moving
// interaction OUT of an agent and INTO the skill's main loop only works if the skill is allowed to
// interact. `/genpage` was rewritten to call `EnterPlanMode`/`ExitPlanMode` in the main loop while
// its `allowed-tools` still listed neither — the flow was moved to a context that also could not
// perform it. Nothing catches that either: a skill body is prose.
//
// The rule: a SKILL.md whose body tells the reader to use an interactive tool must DECLARE it.
// A body that merely quotes the tool name (the `workflow-log.md` line format is
// `AskUserQuestion: <q> → <a>`) also trips this, and that is fine — a skill documenting that format
// is a skill that asks questions, so the declaration is correct anyway.
function skillFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name, 'SKILL.md'))
    .filter((f) => fs.existsSync(f));
}

// Returns the interactive tools a skill USES in its body but does not DECLARE in its frontmatter.
function undeclaredSkillTools(text) {
  const fm = frontmatterOf(text);
  const body = fm ? text.slice(text.indexOf(fm) + fm.length) : text;
  const declared = new Set(interactiveToolsIn(fm));
  return INTERACTIVE_TOOLS.filter((t) => new RegExp(`\\b${t}\\b`).test(body) && !declared.has(t));
}

function main() {
  const errors = [];
  let checked = 0;

  for (const rel of SCAN_PATHS) {
    for (const filePath of agentFiles(path.join(ROOT, rel))) {
      checked += 1;
      const fm = frontmatterOf(fs.readFileSync(filePath, 'utf8'));
      const found = interactiveToolsIn(fm);
      if (found.length) {
        errors.push(
          `${path.relative(ROOT, filePath).replace(/\\/g, '/')}: declares ${found.join(', ')} — ` +
            'an agent runs as a headless Task subagent, so these never reach the user. ' +
            'Ask in the main conversation loop and have the agent return a structured request instead.'
        );
      }
      const prose = selfInteractionProseIn(fm);
      if (prose.length) {
        errors.push(
          `${path.relative(ROOT, filePath).replace(/\\/g, '/')}: frontmatter claims the agent itself ` +
            `interacts (matched ${prose.join(', ')}) — the description is what the dispatching model reads, ` +
            'and a headless subagent cannot present plan mode or ask the user. Describe what it RETURNS ' +
            'and say the orchestrator presents it.'
        );
      }
      const unportable = unportableToolsIn(fm);
      if (unportable.length) {
        errors.push(
          `${path.relative(ROOT, filePath).replace(/\\/g, '/')}: declares ${unportable.join('; ')} — ` +
            'tool names are host-specific and every host silently IGNORES a name it does not ' +
            'recognize, so a capability named in only one scheme is simply absent on the other ' +
            'host and the agent runs without it. Declare both names for the capability.'
        );
      }
    }
  }

  for (const rel of SKILL_SCAN_PATHS) {
    for (const filePath of skillFiles(path.join(ROOT, rel))) {
      checked += 1;
      const missing = undeclaredSkillTools(fs.readFileSync(filePath, 'utf8'));
      if (missing.length) {
        errors.push(
          `${path.relative(ROOT, filePath).replace(/\\/g, '/')}: uses ${missing.join(', ')} in its body ` +
            'but does not declare it in allowed-tools — the flow would be moved to a loop that cannot ' +
            'perform it. Add the tool to the frontmatter.'
        );
      }
    }
  }

  if (errors.length > 0) {
    console.log('Agent interactivity validation failed:');
    for (const error of errors) console.log(`- ${error}`);
    process.exit(1);
  }

  console.log(`Checked ${checked} agent/skill file(s): agents are headless, every skill declares the interactive tools it uses, and every agent capability is declared in both naming schemes.`);
}

if (require.main === module) {
  main();
}

module.exports = { frontmatterOf, interactiveToolsIn, selfInteractionProseIn, undeclaredSkillTools, stripYamlComments, declaredToolsIn, unportableToolsIn, agentFiles, skillFiles, INTERACTIVE_TOOLS, CLAUDE_NAMES_FOR, COPILOT_RECOGNIZED, CAPABILITY_OF, SCAN_PATHS, SKILL_SCAN_PATHS };
