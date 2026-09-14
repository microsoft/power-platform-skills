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
      // Only DECLARATION lines: a dispatch template row (`> - Connectors: …`) or an input-spec
      // bullet (`- **Connectors** — …` / `- **Connectors: …**`). Prose that merely mentions the
      // field while explaining it — "`Connectors: none` and `Telemetry: disabled` are constants
      // here" — is legitimate and must not trip this, which an unanchored match cannot tell apart.
      if (!/^\s*>?\s*-\s*(?:\*\*)?Connectors\b/.test(line)) return;
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

test('the connectors rollback gate is documented where the scripts enforce it', () => {
  // connectors is GA and ships ON, but the gate was kept for one release as a rollback switch.
  // The scripts fail closed with exit 3 when it is off, so the prose has to tell an agent that
  // path exists — otherwise a run that hits exit 3 looks like a crash rather than a switch.
  //
  // This assertion is the inverse of the one that stood here while the flag was being retired.
  // When the follow-up change removes the gate, invert it again: assert NO prose references the
  // flag, because a probe of a removed flag prints `disabled` (unknown flags are fail-closed) and
  // would silently turn connector authoring back off.
  const builder = fs.readFileSync(path.join(PLUGIN, 'agents', 'genpage-connector-builder.md'), 'utf8');
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'), 'utf8');
  const probe = /feature-flags\.js"?\s+connectors\b/;
  assert.match(builder, probe, 'the connector-builder owns the gate and must probe it');
  assert.match(skill, probe, 'Phase 4.5 must re-probe the gate before deploying bindings');
  // Both must describe the OFF outcome, or an agent has no defined behaviour for it.
  assert.match(builder, /\bdisabled\b/, 'connector-builder must define the disabled path');
  assert.match(skill, /\bdisabled\b/, 'Phase 4.5 must define the disabled path');
});

// --- App Spec schema split -------------------------------------------------
//
// app-spec-schema.md is read IN FULL at the start of every /app-builder run, so the conditional
// feature sections were moved to app-spec-schema-advanced.md and replaced by a pointer table.
//
// The pointer table is the ONLY thing that tells an agent those capabilities exist. If a section
// is added to the advanced doc without a matching row — or a row survives a section being renamed
// — the agent silently stops offering that capability, which shows up as under-building (an app
// missing a business process flow nobody realised it could have) rather than as an error.

test('every advanced schema section is named in the pointer table, and vice versa', () => {
  const core = fs.readFileSync(path.join(PLUGIN, 'references', 'app-spec-schema.md'), 'utf8');
  const adv = fs.readFileSync(path.join(PLUGIN, 'references', 'app-spec-schema-advanced.md'), 'utf8');

  // Sections in the advanced doc: "## globalChoices[] (optional — …)" → "globalChoices[]"
  const sections = [...adv.matchAll(/^## (\S+)/gm)].map((m) => m[1]);
  assert.ok(sections.length >= 8, `expected the advanced doc to carry its sections, found ${sections.length}`);

  // Rows in the core doc's pointer table: "| `globalChoices[]` | shared option sets |"
  const tableBlock = core.split(/^## Conditional features[^\n]*$/m)[1] || '';
  const rows = [...tableBlock.split(/^## /m)[0].matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]);
  assert.ok(rows.length >= 8, `expected a pointer row per advanced section, found ${rows.length}`);

  assert.deepEqual(
    [...sections].sort(),
    [...rows].sort(),
    'the pointer table in app-spec-schema.md and the sections in app-spec-schema-advanced.md have drifted'
  );
});

test('the core schema no longer carries the moved sections', () => {
  // A section left in BOTH docs is worse than in neither: the two copies drift and an author
  // follows whichever they happened to read.
  const core = fs.readFileSync(path.join(PLUGIN, 'references', 'app-spec-schema.md'), 'utf8');
  const coreSections = [...core.matchAll(/^## (\S+)/gm)].map((m) => m[1]);
  for (const moved of ['globalChoices[]', 'webResources[]', 'commands[]', 'businessRules[]', 'dashboards[]', 'roleGrants[]']) {
    assert.ok(!coreSections.includes(moved), `${moved} must live only in app-spec-schema-advanced.md`);
  }
});

test('the skill tells the agent when to read the advanced schema', () => {
  // The split only stays safe while the skill body routes the reader to it. Without this line an
  // agent reads the core doc, never opens the advanced one, and quietly cannot author half the
  // conditional features.
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'app-builder', 'SKILL.md'), 'utf8');
  assert.match(skill, /app-spec-schema-advanced\.md/, '/app-builder must point at the advanced schema');
  assert.match(skill, /conditional feature/i, 'and say when to read it');
});
//
// Every field below is produced by a SKILL.md dispatch template and consumed by
// genpage-page-builder. `Connectors` drifted because nothing executed that contract; the same
// hazard applies to each of the others, so pin them all rather than the one that happened to break.

// Producer → the two /genpage templates plus the one /app-builder template.
function dispatchTemplates() {
  const out = [];
  for (const [file, re] of [
    [path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'), /^> - (.+)$/gm],
    [path.join(PLUGIN, 'skills', 'app-builder', 'SKILL.md'), /^\s+> - (.+)$/gm],
  ]) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = [...src.matchAll(re)].map((m) => m[1].trim());
    // Split into blocks on "Target file", which starts each template.
    let cur = null;
    for (const l of lines) {
      if (/^Target file:/.test(l)) { cur = { file: rel(file), fields: [] }; out.push(cur); }
      if (cur) cur.fields.push(l);
    }
  }
  return out;
}

test('every page-builder dispatch template carries the same required field set', () => {
  const templates = dispatchTemplates();
  assert.ok(templates.length >= 3, `expected 3 dispatch templates (2 genpage + 1 app-builder), found ${templates.length}`);
  // RuntimeTypes is deliberately conditional (dataverse pages only), so it is not required.
  const required = ['Target file', 'Plan document', 'Data mode', 'Connectors', 'Telemetry', 'Working directory', 'Plugin root'];
  for (const t of templates) {
    for (const field of required) {
      const has = t.fields.some((l) => new RegExp(`^${field}:`).test(l));
      assert.ok(has, `${t.file} dispatch template is missing the "${field}:" line — the page-builder reads it`);
    }
  }
});

test('every dispatch field the page-builder documents is one a template actually sends', () => {
  // Catches the reverse drift: a consumer input bullet nobody produces is dead documentation that
  // an agent will still try to honour.
  const builder = fs.readFileSync(path.join(PLUGIN, 'agents', 'genpage-page-builder.md'), 'utf8');
  // The input spec is the bulleted block under "You will be invoked with a prompt that includes:".
  const specBlock = builder.split(/You will be invoked with a prompt that includes:/)[1] || '';
  const spec = specBlock.split(/\n#{2,}\s/)[0];
  const documented = [...spec.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1].trim());
  assert.ok(documented.length >= 7, `expected the page-builder input spec to list its fields, found ${documented.length}`);

  const produced = new Set();
  for (const t of dispatchTemplates()) for (const l of t.fields) produced.add((l.split(':')[0] || '').trim());

  // Map the consumer's prose labels onto the wire field names where they differ.
  const alias = { 'Page name': 'Target file', 'Plan document path': 'Plan document', 'RuntimeTypes path': 'RuntimeTypes' };
  for (const d of documented) {
    const wire = alias[d] || d;
    assert.ok(produced.has(wire), `page-builder documents input "${d}" but no dispatch template sends a "${wire}:" line`);
  }
});

test('Telemetry uses enabled|disabled and is never conflated with the Connectors vocabulary', () => {
  // The two fields are gated differently — Telemetry is still a live feature flag (custom-telemetry),
  // Connectors is derived from the plan — so they must not converge on one vocabulary by accident.
  for (const t of dispatchTemplates()) {
    const tel = t.fields.find((l) => /^Telemetry:/.test(l));
    assert.ok(tel, `${t.file} has no Telemetry line`);
    assert.match(tel, /\b(enabled|disabled)\b/, `${t.file}: Telemetry must be enabled|disabled, got: ${tel}`);
    assert.doesNotMatch(tel, /binding\(s\)|\bnone\b/, `${t.file}: Telemetry must not use the Connectors vocabulary: ${tel}`);
  }
});
