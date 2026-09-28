#!/usr/bin/env node
'use strict';

// Reports whether a human can answer a question in THIS run, so a skill can pick a documented
// default instead of waiting for an answer that will never come.
//
// WHY a script and not just "check the env var in the prompt": `/genpage` decides this at several
// gates (create-vs-edit, an agent's needs_input, plan approval, the browser-verify offer). Each
// one re-deriving the rule from prose is how they end up disagreeing — and a gate that guesses
// "attended" under Copilot autopilot or Claude auto-accept stalls the whole run with no output
// explaining why. One command, one answer, and the eval harness can assert it.
//
// Output is a single JSON line, matching the other discovery scripts in this plugin:
//   {"ok":true,"interactive":false,"reason":"POWER_PLATFORM_SKILLS_NONINTERACTIVE is set"}
// Always exits 0: "there is no user" is a fact about the run, not a failure of it.

const { resolveInteractionMode } = require('./lib/interaction-mode.js');

function main(argv = process.argv.slice(2)) {
  const mode = resolveInteractionMode({ argv, env: process.env });
  process.stdout.write(JSON.stringify({ ok: true, ...mode }) + '\n');
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };
