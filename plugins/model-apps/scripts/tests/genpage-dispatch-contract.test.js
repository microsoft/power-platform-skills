// plugins/model-apps/scripts/tests/genpage-dispatch-contract.test.js
// The `Connectors:` dispatch line is a CONTRACT between two markdown files: the /genpage
// orchestrator produces it (skills/genpage/SKILL.md Phase 4.5 + the Phase 5c dispatch templates)
// and genpage-page-builder consumes it to decide whether to emit connector code.
//
// Nothing executes that contract, so a rename on one side is invisible until a real run produces a
// connector-backed page with no connector code. That happened when the `connectors` feature flag
// was retired: Phase 4.5 and the page-builder both moved to `none` / `<n> binding(s)`, but the
// Phase 5c dispatch templates were left emitting the retired `enabled` / `disabled` — a token that
// matches NEITHER the consumer's positive trigger nor its negative one, so the page would have
// shipped without its binding.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..');

function mdFiles() {
  const out = [];
  for (const dir of [path.join(PLUGIN, 'skills'), path.join(PLUGIN, 'agents'), path.join(PLUGIN, 'references')]) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) out.push(p);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
  }
  return out;
}

const rel = (p) => p.replace(PLUGIN + path.sep, '').replace(/\\/g, '/');

test('no Connectors dispatch line uses the retired enabled/disabled vocabulary', () => {
  const offenders = [];
  for (const f of mdFiles()) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      // Match the dispatch field in any of its markdown dressings: `Connectors:`,
      // `**Connectors:`, `- **Connectors** — …`.
      if (!/\bConnectors\b\s*(?::|\*\*\s*[—-])/.test(line)) return;
      if (/\b(enabled|disabled)\b/.test(line)) offenders.push(`${rel(f)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `Connectors dispatch must use none|<n> binding(s):\n${offenders.join('\n')}`);
});

test('the orchestrator emits the exact token the page-builder triggers on', () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'), 'utf8');
  const builder = fs.readFileSync(path.join(PLUGIN, 'agents', 'genpage-page-builder.md'), 'utf8');

  // Consumer side: the page-builder reads connectors.md and emits connector code only on the
  // positive token, and treats the negative token (or an absent line) as no connectors.
  assert.match(builder, /Connectors: <n> binding\(s\)/, 'page-builder must state its positive trigger');
  assert.match(builder, /Connectors: none/, 'page-builder must state its negative trigger');

  // Producer side: both Phase 5c dispatch templates (dataverse + mock) must carry the same
  // vocabulary, or a connector-backed page is dispatched with a token the consumer ignores.
  const templates = skill.match(/^> - Connectors: .*$/gm) || [];
  assert.ok(templates.length >= 2, `expected both dispatch templates to carry a Connectors line, found ${templates.length}`);
  for (const t of templates) {
    assert.match(t, /none\|<n> binding\(s\)/, `dispatch template must use the consumer's vocabulary: ${t}`);
  }
});

test('the connectors feature flag is not referenced by any skill or agent prose', () => {
  // The flag is retired. A lingering "probe the gate" step would send an agent to a CLI flag that
  // no longer exists, and `feature-flags.js connectors` now prints `disabled` (unknown flags are
  // fail-closed) — silently turning connector authoring back off for that run.
  const offenders = [];
  for (const f of mdFiles()) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/feature-flags(?:\.js)?["'\s]*\s+connectors\b/.test(line) || /GENPAGE_ENABLE_CONNECTORS/.test(line)) {
        offenders.push(`${rel(f)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `connectors flag references remain:\n${offenders.join('\n')}`);
});
