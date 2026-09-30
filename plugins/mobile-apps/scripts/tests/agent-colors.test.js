'use strict';

/**
 * Agent colours are how the host tells concurrently running subagents apart in its UI. They
 * regressed to three of five sharing `cyan`, which made the planning agents indistinguishable
 * on screen, and one used `teal` — a value no other plugin in this repo uses.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const agentsDir = path.resolve(__dirname, '..', '..', 'agents');

// Only values already in use elsewhere in this repo (power-pages, model-apps, canvas-apps).
// Widening this set means confirming the host actually renders the new value.
const KNOWN_COLORS = new Set(['cyan', 'blue', 'green', 'yellow', 'purple']);

function agentColors() {
  return fs.readdirSync(agentsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const text = fs.readFileSync(path.join(agentsDir, name), 'utf8');
      const match = text.match(/^color:\s*(\S+)\s*$/m);
      return { agent: path.basename(name, '.md'), color: match && match[1] };
    });
}

test('every agent declares a colour', () => {
  const missing = agentColors().filter((entry) => !entry.color).map((entry) => entry.agent);
  assert.deepEqual(missing, []);
});

test('no two agents share a colour', () => {
  const entries = agentColors();
  const seen = new Map();
  const clashes = [];
  for (const { agent, color } of entries) {
    if (seen.has(color)) clashes.push(`${color}: ${seen.get(color)} and ${agent}`);
    else seen.set(color, agent);
  }
  assert.deepEqual(clashes, [], `agents must be visually distinguishable:\n  ${clashes.join('\n  ')}`);
  assert.ok(entries.length >= 5, 'the whole agent set must be covered');
});

test('colours stay within the set this repo already uses', () => {
  const unknown = agentColors()
    .filter((entry) => !KNOWN_COLORS.has(entry.color))
    .map((entry) => `${entry.agent}=${entry.color}`);
  assert.deepEqual(unknown, []);
});

test('the cross-plugin planner and builder conventions are kept', () => {
  const byAgent = Object.fromEntries(agentColors().map((e) => [e.agent, e.color]));
  // Planners are cyan and code-writing builders are green in power-pages, model-apps and
  // canvas-apps; matching them keeps the colour meaningful across the whole marketplace.
  assert.equal(byAgent['native-app-planner'], 'cyan');
  assert.equal(byAgent['screen-builder'], 'green');
});
