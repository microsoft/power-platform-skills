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
// Every document is read with its line endings normalized: a Windows checkout turns them into CRLF, and a
// check measured in characters then read differently there than on the LF checkout it was written on.
const readDoc = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('no Connectors dispatch line uses the retired enabled/disabled vocabulary', () => {
  const offenders = [];
  for (const f of mdFiles()) {
    const lines = readDoc(f).split(/\r?\n/);
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
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const builder = readDoc(path.join(PLUGIN, 'agents', 'genpage-page-builder.md'));

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
  const builder = readDoc(path.join(PLUGIN, 'agents', 'genpage-connector-builder.md'));
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const probe = /feature-flags\.js"?\s+connectors\b/;
  assert.match(builder, probe, 'the connector-builder owns the gate and must probe it');
  assert.match(skill, probe, 'Phase 4.5 must re-probe the gate before deploying bindings');
  // Both must describe the OFF outcome, or an agent has no defined behaviour for it.
  assert.match(builder, /\bdisabled\b/, 'connector-builder must define the disabled path');
  assert.match(skill, /\bdisabled\b/, 'Phase 4.5 must define the disabled path');
});

test('connector metadata discovery uses the PAC connector name, not the full API resource path', () => {
  const builder = readDoc(path.join(PLUGIN, 'agents', 'genpage-connector-builder.md'));
  assert.match(
    builder,
    /terminal segment|final path segment/i,
    'connector-builder must explain how to derive the short PAC connector name from connectorId',
  );
  assert.match(
    builder,
    /--connector-id <connectorName>/,
    'PAC metadata commands must receive the short connector name',
  );
  assert.match(
    builder,
    /connectors\.json[\s\S]*full.*connectorId|full.*connectorId[\s\S]*connectors\.json/i,
    'the persisted binding must retain the full connector resource path',
  );
});

test('connector-builder defines setup when no suitable connection exists', () => {
  const builder = readDoc(path.join(PLUGIN, 'agents', 'genpage-connector-builder.md'));
  assert.match(builder, /power-apps\s+create-connection/, 'connector-builder must document the connection-creation command');
  assert.match(builder, /POWERAPPS_CLI_ENABLE_BROWSER_CONNECTION/, 'interactive connector setup gate must be explicit');
  // Bare /needs_input/ is the agent's universal return shape and was already present, so it
  // asserted nothing. Anchor to the connection-setup path that must hand back to the orchestrator.
  // Spans use `\s+`/bounded `[\s\S]` rather than literal spaces and `[^\n]*`: these phrases sit on
  // hard-wrapped ~76-col prose lines, so a pure re-wrap (identical words, different line breaks)
  // would otherwise break the build for no safety gain. Word order is still required.
  assert.match(
    builder,
    /create-connection[\s\S]{0,120}reports\s+that\s+login[\s\S]{0,200}needs_input/i,
    'connection setup that requires interaction must return to the orchestrator',
  );
  assert.match(builder, /Org URL[\s\S]*<ENV_URL>|<ENV_URL>[\s\S]*Org URL/i, 'connection setup must compare the active profile with the resolved environment');
  assert.match(builder, /mismatch[\s\S]*needs_input|needs_input[\s\S]*mismatch/i, 'an environment mismatch must stop before mutation');
  assert.match(builder, /auth-status/, 'headless setup must inspect cached Power Apps CLI accounts');
  assert.match(builder, /auth-switch/, 'headless setup may switch only to an already-cached account');
  assert.match(builder, /never.*login|do not.*login/i, 'the headless worker must not launch browser login');
  assert.match(builder, /homeAccountId/, 'cached account selection must be tenant-specific');
  // "exactly one" and "ambiguous" both occur in unrelated prose; anchor to the cached-match rule.
  assert.match(builder, /exactly\s+one\*{0,2}\s+cached\s+match/i, 'duplicate cached usernames must fail closed');
  assert.match(builder, /Node 22|major.*22|22\+/i, 'the optional Power Apps CLI path must guard its Node requirement');
  assert.match(builder, /UsGovHigh[\s\S]*usgovhigh/, 'sovereign cloud mapping must be explicit');
  assert.match(builder, /unknown[\s\S]*cloud[\s\S]*needs_input|needs_input[\s\S]*unknown[\s\S]*cloud/i, 'unknown clouds must fail closed');
});

test('genpage orchestrator defines inline recovery for a worker missing declared tools', () => {
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const editFlow = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'edit-flow.md'));
  // No `s` flag and no unbounded `[\s\S]*`: with them, `.*` spans the whole document and any doc
  // containing "missing" … "file" … "tool" anywhere passes. Anchor to the new sentence instead.
  assert.match(skill, /declared\s+file\s+or\s+process-execution\s+tools\s+are\s+unavailable/i);
  assert.match(skill, /inline fallback|run the worker workflow inline/i);
  assert.match(skill, /do\s+(?:\*\*)?not(?:\*\*)?\s+(?:re-dispatch|retry the same worker)/i);
  assert.match(skill, /genpage-planner[\s\S]*file tools[\s\S]*halt/i, 'create planner file-tool failure must preserve plan provenance');
  // `genpage-edit-planner` is deliberately absent from this loop: it already passed against the
  // pre-change doc, so including it advertised coverage the loop did not provide — the same trap
  // that made the earlier assertions vacuous. The anchored assertion below owns that worker.
  for (const worker of ['genpage-connector-builder', 'genpage-customapi-builder']) {
    assert.match(editFlow, new RegExp(`${worker}[\\s\\S]{0,1200}(?:tool|unavailable|halt|inline)`, 'i'), `edit flow must define a missing-tool outcome for ${worker}`);
  }
  // Anchored to the edit-planner's own halt rule. A loose /edit-planner[\s\S]*halt/ matched
  // unrelated prose elsewhere in the file and passed before this rule was written.
  assert.match(
    editFlow,
    /genpage-edit-planner[\s\S]{0,160}declared\s+file\s+tools\s+are\s+unavailable[\s\S]{0,400}Halt\s+the\s+edit\s+flow/i,
    'edit planner failure must preserve plan provenance by halting',
  );
});

test('genpage orchestrator gates planner output with deterministic plan provenance checks', () => {
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const editFlow = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'edit-flow.md'));

  assert.match(skill, /genpage-plan-provenance\.js[\s\S]{0,500}prepare/i, 'create flow must quarantine stale genpage-plan.md before planner writeback');
  assert.match(skill, /genpage-plan-provenance\.js[\s\S]{0,500}verify/i, 'create flow must hash-check the written plan against the approved body');
  assert.match(skill, /approved\s+plan\s+body/i, 'create flow must verify against the approved plan body, not mere file existence');
  assert.match(editFlow, /genpage-plan-provenance\.js[\s\S]{0,500}prepare/i, 'edit flow must quarantine stale genpage-edit-plan.md before planner writeback');
  assert.match(editFlow, /genpage-plan-provenance\.js[\s\S]{0,500}verify/i, 'edit flow must hash-check the written edit plan against the approved body');
  // `prepare` refuses a link at the plan path or the quarantine folder; carrying on would let the
  // planner write the approved plan through it.
  for (const [flow, text] of [['create', skill], ['edit', editFlow]]) {
    const prep = text.indexOf('genpage-plan-provenance.js" prepare');
    assert.ok(prep > -1, `${flow} flow runs prepare`);
    assert.match(text.slice(prep, prep + 700), /Continue only on `"ok":true`[\s\S]{0,300}halt/, `${flow} flow halts when prepare refuses`);
  }
});

test('genpage orchestrator validates worker output completeness before accepting parallel results', () => {
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));

  assert.match(skill, /genpage-worker-output\.js/, 'multi-page flow must call the deterministic worker-output validator');
  assert.match(skill, /unbalanced|default export|markdown code fence/i, 'skill text must name the completeness checks that trigger inline fallback');
  assert.match(skill, /inline fallback|Phase 5b page-builder workflow inline/i, 'invalid worker output must use the same inline fallback path as missing output');
});

// #585 item 2: every page that can ship passes the gate — a worker's (5c), and one the orchestrator
// writes itself (5b), which is also what the 5c fallback runs.
test('the completeness gate also runs on pages written inline, including the fallback', () => {
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const fastPath = skill.split(/#### 5b\. Single-page fast path/)[1].split(/#### 5c\. Multi-page/)[0];
  assert.match(fastPath, /genpage-worker-output\.js/, 'the single-page path runs the gate');
  assert.match(fastPath, /rewrite the page once[\s\S]{0,120}halt/i, 'a page that keeps failing halts instead of deploying');
  assert.match(fastPath, /5c fallback/, 'the fallback is the same path, so it is covered');
});

// #588 item 4: page filenames are checked by the deterministic gate BEFORE any worker is dispatched —
// a link or junction escape cannot be spotted by reading the plan.
test('genpage orchestrator runs the page-file gate before dispatching page workers', () => {
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const gate = skill.indexOf('check-page-files.js');
  assert.ok(gate > -1, 'the skill must run scripts/check-page-files.js');
  const dispatch = skill.indexOf('genpage-worker-output.js');
  assert.ok(dispatch > gate, 'the filename gate must come before workers run and their output is checked');
  // Anywhere in the gate's own section: a fixed window broke as the list of refused names grew.
  const rest = skill.slice(gate);
  const next = rest.search(/\n#{2,6}\s/);
  assert.match(next < 0 ? rest : rest.slice(0, next), /halt and\s+re-plan/i, 'a refused filename halts; it is never rewritten after approval');
});

test('single-page inline generation treats missing or malformed Custom API Bindings as a halt', () => {
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const fastPath = skill.split(/#### 5b\. Single-page fast path/)[1].split(/#### 5c\. Multi-page/)[0];

  assert.match(fastPath, /No custom API bindings\./, 'the exact sentinel must remain the only no-actions value');
  assert.match(fastPath, /missing[\s\S]{0,120}malformed[\s\S]{0,160}halt|halt[\s\S]{0,160}missing[\s\S]{0,120}malformed/i, 'single-page generation must halt on missing or malformed Custom API sections');
  assert.doesNotMatch(fastPath, /empty\/missing\/malformed section, as\s+having no Custom APIs/i, 'single-page generation must not downgrade malformed Custom API sections to none');
});

// #585 item 3, the other two readers: the orchestrator's Custom API phase and the page-builder worker.
// Only the exact sentinel means "none" — a missing, empty or malformed section is a broken plan.
test('the Custom API phase and the page builder never read a missing or malformed section as none', () => {
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const phase = skill.slice(skill.indexOf("**If it prints `enabled`:** read the plan's `## Custom API Bindings`"));
  assert.ok(phase.length > 0, 'the Custom API phase is where it was');
  assert.match(phase.slice(0, 700), /only when its body is exactly `No custom API bindings\.`/);
  assert.match(phase.slice(0, 700), /missing, empty, or malformed, \*\*halt\*\*/);
  const builder = readDoc(path.join(PLUGIN, 'agents', 'genpage-page-builder.md'));
  assert.match(builder, /That sentinel is the only way a plan says\s+"none"/);
  assert.match(builder, /\*\*stop and report it instead of writing the page\*\*/);
  assert.doesNotMatch(builder, /is missing entirely, or contains no binding row, the page has \*\*no Custom APIs\*\*/);
});

// A plan made while `custom-api` was ON still carries its binding table after the flag is turned OFF.
// Page generation takes that table as permission to emit executeAction/executeFunction calls, while the
// OFF branch drops actions.json and --actions — so skipping the phase "regardless of the plan" deployed
// pages calling Custom APIs that were never bound. OFF with a real table must halt before generation.
test('a disabled Custom API probe halts on a plan that still carries a binding table', () => {
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const start = skill.indexOf("**If it prints `disabled`:** Custom API support is OFF.");
  assert.ok(start > -1, 'the disabled branch of the Custom API phase is where it was');
  const off = skill.slice(start, skill.indexOf("**If it prints `enabled`:** read the plan's `## Custom API Bindings`"));
  assert.match(off, /actual binding table[\s\S]{0,200}\*\*halt before page generation\*\*/, 'a real table under a disabled probe halts');
  assert.match(off, /only a body of exactly `No custom API bindings\.` continues/, 'only the sentinel lets a disabled run go on');
  assert.match(off, /missing, empty, or malformed section halts too/, 'a broken section halts under a disabled probe as well');
  assert.doesNotMatch(off, /regardless of what the\s+plan's/i, 'the disabled branch must not ignore the plan');
  assert.doesNotMatch(off, /Any other section body/i, 'no body but the sentinel means "none"');
  const fastPath = skill.split(/#### 5b\. Single-page fast path/)[1].split(/#### 5c\. Multi-page/)[0];
  assert.match(fastPath, /3b\. Only when the Phase 4\.6 probe printed `enabled` \*\*and\*\*/, 'inline generation reads Custom API guidance only under an enabled probe');
});

// The manifest generator exits 2 when an existing package.json lacks a package a requested feature needs
// (and when the working directory is a link). The step used to say "do not block the workflow if the
// script returns non-zero", so a charts rerun carried on over the stale manifest the check exists to stop.
test('the manifest step halts on exit 2 instead of carrying on over a stale package.json', () => {
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const start = skill.indexOf('scripts/generate-page-manifest.js');
  assert.ok(start > -1, 'the manifest step is where it was');
  const step = skill.slice(start, skill.indexOf('### Phase 1: Plan', start));
  assert.match(step, /\*\*Continue only on exit 0\.\*\*/);
  assert.match(step, /\*\*Exit 2 — halt\*\*[\s\S]{0,400}--force/, 'exit 2 halts and surfaces the merge / --force choice');
  assert.doesNotMatch(step, /do\s+not\s+block\s+the\s+workflow/i, 'no non-zero exit is waved through');
});

test('page generation rejects Griffel borderWidth shorthand before deploy', () => {
  const rules = readDoc(path.join(PLUGIN, 'references', 'rules.md'));
  const builder = readDoc(path.join(PLUGIN, 'agents', 'genpage-page-builder.md'));
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const editFlow = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'edit-flow.md'));
  assert.match(rules, /borderWidth/i, 'rules must name the runtime-only Griffel failure');
  assert.match(builder, /borderWidth/i, 'page-builder must scan its output for the shorthand');
  assert.match(skill, /borderWidth/i, 'inline page generation must run the same scan');
  assert.match(editFlow, /borderWidth/i, 'edited pages must run the same scan before upload');
  const documentedPattern = `['"]?borderWidth['"]?\\s*:`;
  for (const [name, text] of [['rules', rules], ['page-builder', builder], ['create flow', skill], ['edit flow', editFlow]]) {
    assert.ok(text.includes(documentedPattern), `${name} must carry the complete Griffel key regex`);
  }
  const regex = /['"]?borderWidth['"]?\s*:/;
  for (const source of ['borderWidth: 0', 'borderWidth : 0', '"borderWidth": 0', "'borderWidth' : 0"]) {
    assert.match(source, regex, `guard must detect ${source}`);
  }
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
  const core = readDoc(path.join(PLUGIN, 'references', 'app-spec-schema.md'));
  const adv = readDoc(path.join(PLUGIN, 'references', 'app-spec-schema-advanced.md'));

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
  const core = readDoc(path.join(PLUGIN, 'references', 'app-spec-schema.md'));
  const coreSections = [...core.matchAll(/^## (\S+)/gm)].map((m) => m[1]);
  for (const moved of ['globalChoices[]', 'webResources[]', 'commands[]', 'businessRules[]', 'dashboards[]', 'roleGrants[]']) {
    assert.ok(!coreSections.includes(moved), `${moved} must live only in app-spec-schema-advanced.md`);
  }
});

test('the skill tells the agent when to read the advanced schema', () => {
  // The split only stays safe while the skill body routes the reader to it. Without this line an
  // agent reads the core doc, never opens the advanced one, and quietly cannot author half the
  // conditional features.
  const skill = readDoc(path.join(PLUGIN, 'skills', 'app-builder', 'SKILL.md'));
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
    const src = readDoc(file);
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
  const builder = readDoc(path.join(PLUGIN, 'agents', 'genpage-page-builder.md'));
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

// A worker that writes nothing leaves an earlier attempt's page in place, and it passes every content check.
// Each target is stamped before it is written, in both paths, so the gate can refuse a page left as it was.
test('genpage stamps every page target before it is written, in both paths', () => {
  const skill = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'));
  const fastPath = skill.split(/#### 5b\. Single-page fast path/)[1].split(/#### 5c\. Multi-page/)[0];
  const multi = skill.split(/#### 5c\. Multi-page/)[1];
  const stamp = /genpage-worker-output\.js" --stamp --file/;
  assert.match(fastPath, stamp, 'the single-page path stamps its target');
  assert.ok(fastPath.search(stamp) < fastPath.search(/write the `\.tsx` file/i), 'before it writes it');
  assert.match(multi, stamp, 'the multi-page path stamps every target');
  assert.ok(multi.search(stamp) < multi.search(/Fire all invocations in a single message/), 'before it dispatches the workers');
  assert.match(multi, /exactly as its dispatch stamp\s+recorded it/, 'and the gate names what an unchanged page means');
  // The plan's File values already end in `.tsx`, and every command appends it: `<filename>` is the stem.
  assert.match(fastPath, /`<filename>` is the page's `File` value from the plan without its `\.tsx`\s+extension/, 'the single-page path says what <filename> is');
  assert.match(multi, /`<filename>` and `\[filename\]` are each page's `File` value from the\s+plan without its `\.tsx` extension/, 'and so does the multi-page path');
});
