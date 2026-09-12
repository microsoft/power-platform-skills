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
      const found = interactiveToolsIn(frontmatterOf(fs.readFileSync(filePath, 'utf8')));
      if (found.length) {
        errors.push(
          `${path.relative(ROOT, filePath).replace(/\\/g, '/')}: declares ${found.join(', ')} — ` +
            'an agent runs as a headless Task subagent, so these never reach the user. ' +
            'Ask in the main conversation loop and have the agent return a structured request instead.'
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

  console.log(`Checked ${checked} agent/skill file(s): agents are headless, and every skill declares the interactive tools it uses.`);
}

if (require.main === module) {
  main();
}

module.exports = { frontmatterOf, interactiveToolsIn, undeclaredSkillTools, agentFiles, skillFiles, INTERACTIVE_TOOLS, SCAN_PATHS, SKILL_SCAN_PATHS };
