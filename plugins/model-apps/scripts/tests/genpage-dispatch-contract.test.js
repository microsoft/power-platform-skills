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

// Measured against the PAC CLI: `pac model genpage transpile` accepted a `string` assigned to a
// `number` and a selected column that does not exist, exited 0 and wrote JavaScript. So no instruction
// may present it as a type check — a worker that believes it is one ships unchecked types with false
// confidence — and the page-builder, the one place that names the command, must say what it is not.
//
// The claim can be worded many ways ("to type-check the page", "a clean transpile means it is
// type-safe", "catches type errors", "fails on type errors", "type errors are caught during
// transpilation"), and one exact phrase in four files would miss all of them. So
// every agent, skill and reference document is read CLAUSE by clause, and a clause fails when it
// ATTRIBUTES a type guarantee to transpiling that no negation governs. It is a tripwire, not a parser: a
// correct sentence it flags is reworded with the checker as its subject, or with the denial stated
// directly. And its vocabulary is FINITE — the claim families below, each pinned by a predicate — so it
// catches the wordings those families describe and their near variants, not every sentence that could
// mean the same. A new wording it misses is a new family (and a new predicate), not a bug in the rest.
//   · Attribution, not co-occurrence. A claim belongs to the actor named nearest before it in its clause
//     — transpiling, a checker the reader runs itself (`tsc`, the TypeScript compiler, the type checker,
//     an `npm run` script) or the reader ("you") — so "Use `tsc` to type-check the page after
//     transpiling it" is about tsc, unless transpiling is what runs that checker ("Transpile runs `tsc`
//     to type-check the page"). A claim with no actor before it is an instruction, and belongs to
//     transpiling only when transpiling is its MEANS ("Type-check the page by transpiling it", "To
//     type-check the page, run the transpile"), never its time ("Type-check separately before
//     transpiling"). A PASSIVE claim whose agent is a checker named after it ("After transpiling, the
//     page is type-checked by `tsc`") is that checker's, again unless transpiling runs it.
//   · A clause with no subject of its own continues the previous one only when it opens with the claim:
//     `it`/`this`/`that` or nothing, then a claim verb in the third person ("…, but it type-checks",
//     "… and reports type errors", "That validates the types") — built from the same stems as the claim
//     families, so the two vocabularies cannot drift apart. What `it` continues is the actor named last:
//     "Transpile the page, then run `tsc`. It type-checks every prop." is about tsc.
//   · A negation governs a claim only from just before it, in its own clause, with nothing between but
//     words that carry the denial to it ("is not proof that the page is", "does not mean the", "by
//     itself"). A negation of anything else — "does not bundle and type-checks", "does not need a flag to
//     type-check" — does not excuse the claim, and neither does a hedge: "does not always / necessarily /
//     fully / really type-check" says that sometimes it does. Inline emphasis is not a word in between:
//     "does **not** type-check" is a denial.
//   · List items, table cells, headings and paragraphs are separate units, so a "not" in one bullet never
//     excuses the next; fenced code is skipped.
const CATCHING = ['catch', 'detect', 'flag', 'report', 'find', 'surface', 'prevent', 'reject', 'stop', 'spot', 'check', 'warn', 'raise', 'throw'];
// The same verbs as past participles, in the same order: "type errors are caught".
const CAUGHT = ['caught', 'detected', 'flagged', 'reported', 'found', 'surfaced', 'prevented', 'rejected', 'stopped', 'spotted', 'checked', 'warned', 'raised', 'thrown'];
// The verbs of a step that FAILS on them: "fails on type errors", "errors out on a type mismatch".
const FAILING = ['fail', 'error', 'break', 'abort', 'halt', 'exit'];
const CHECKING = ['validat', 'verif', 'check'];
const BEING = ['is', 'acts as', 'serves as', 'works as', 'doubles as'];
const TYPE_ERROR = String.raw`typ(?:e|ing) (?:errors?|mistakes?|bugs?|issues?|problems?|mismatch(?:es)?)`;
// One alternative per claim family. The test pins a predicate for each, so a family added here without
// one fails there.
const CLAIM_FAMILIES = [
  // "type checker" included: a mention of the checker is the checker's own (see the host rule in
  // attributed), so it counts only when transpiling runs it — "Transpile uses the type checker".
  String.raw`\btype[- ]?check\w*`,
  String.raw`\btype[- ]?safe\w*`,
  // A catching VERB, a few words or a condition away ("checks whether the page has type errors"). A bare
  // "a type error … still transpiles" says the opposite of a claim, and so do a contrast in between
  // ("checks syntax even with type errors") and a denial right after ("warns that type errors are not
  // checked").
  String.raw`\b(?:${CATCHING.join('|')})\w* (?:(?:(?:an? |the )?(?:error|exception|warning|user|maker|developer) )?(?:whether|if|when) (?:\w+ ){0,3}?(?:has|have|contains?|hits?) (?:any )?|(?:(?!even\b|despite\b|regardless\b|though\b|although\b|while\b|yet\b)\w+ ){0,3}?)${TYPE_ERROR}\b(?! (?:(?:are|is|were|was) (?:not|never)\b|(?:aren|isn|weren|wasn)['’]t\b|(?:remain|remains|go|goes|stay|stays) un\w+))`,
  // …the same in the passive. A negation never stands in for the adverb: "are not caught" is no claim.
  String.raw`\b${TYPE_ERROR} (?:are|is|get|gets|will be|would be)(?: (?!not\b|never\b)\w+)? (?:${CAUGHT.join('|')})\b`,
  // …and a step that FAILS on them, or exits non-zero: "exits non-zero on type errors". A plain exit is
  // left out on purpose — "exits 0 even with type errors" is the truth, and says so.
  String.raw`\b(?:(?:${FAILING.join('|')})\w*(?: out)?|(?:exit|return)\w* (?:with )?(?:a )?non-?zero(?: (?:exit )?(?:code|status))?) (?:on|over|with|for|at) (?:\w+ ){0,2}?${TYPE_ERROR}\b`,
  String.raw`\btype (?:correctness|soundness|analysis|validation|verification)\b`,
  // The ABSENCE of type errors: "guarantees no type errors", "the page is free of type errors". The "no" is
  // the claim's own word, so it never reads as a negation governing it.
  String.raw`\b(?:no|zero|free of|without any) ${TYPE_ERROR}\b`,
  String.raw`\btypes? (?:are|is) (?:valid|correct|checked|verified|sound|safe)\b`,
  String.raw`\b(?:${CHECKING.join('|')})\w* (?:the |its |their |all |every )?types?\b`,
  String.raw`\b(?:correct|valid|sound|safe) typ(?:es|ing)\b`,
  String.raw`\b(?:${BEING.join('|')}) (?:a |an |the )?type[- ]?checker\b`,
];
const TYPE_CLAIM = new RegExp(CLAIM_FAMILIES.join('|'), 'gi');
// The same families as a predicate in the third person: what a clause with no subject of its own must
// open with to continue the previous one.
const THIRD_PERSON = [
  String.raw`type[- ]?checks`,
  String.raw`(?:${[...CATCHING, ...CHECKING, ...FAILING].join('|')})\w*s`,
  'guarantees|ensures|proves|confirms|performs|provides|means|shows|implies|does|returns',
  String.raw`is (?:a |an |the )?(?:type[- ]?check(?:er)?|type[- ]?safe)`,
  ...BEING.filter((b) => b !== 'is'),
].join('|');
const CONTINUES = new RegExp(String.raw`^(?:(?:and|but|then|so|yet|while|whereas|although|though|however),?\s+)?(?:(?:it|this|that)\s+)?(?:also |then |still |now |just |only |even |simply |already |therefore |thus )?(?:${THIRD_PERSON})\b`, 'i');
const NEGATION = /\b(?:not|never|no|nor|without|neither|cannot)\b|n't\b/gi;
// The only words that may stand between a negation and the claim it denies. No hedge: "always",
// "necessarily", "fully" and "really" each turn the denial into "sometimes".
const BRIDGE = /^(?:a|an|the|any|its|their|this|that|there|page|pages|code|file|types?|is|are|be|being|been|by|itself|on|own|proof|guarantee|evidence|sign|mean|means|imply|implies|ensure|ensures|show|shows|prove|proves|of|for|actually|also|even|therefore|thus|in|way)$/i;
// Clause boundaries: `;`, a `:` that is not a URL's, a spaced dash, a comma before a conjunction, and the
// conjunctions that start a new statement.
const CLAUSE_BREAK = /\s*(?:;|:(?!\/\/)|\s[—–]\s|,(?=\s*(?:and|but|then|so|yet|while|whereas|although|though|however)\b)|(?<=\S)\s+(?=(?:and|but|then|whereas|although|though)\s))\s*/i;
// Who a claim can belong to: `t` transpiling (the whole command is one mention), `x` a checker the reader
// runs itself — named, or a generic "type-check script" — and `r` the reader.
const ACTOR = new RegExp([
  String.raw`(?<t>\x60pac model genpage transpile\x60|transpil\w*)`,
  String.raw`(?<x>\x60?\btsc\b\x60?|\bTypeScript compiler\b|\btype[- ]?checker\b|\x60npm run [^\x60]*\x60|\btype[- ]?check(?:ing)? (?:script|command|step|task|job)\b)`,
  String.raw`(?<r>\b(?:you|yourself|we)\b)`,
].join('|'), 'gi');
// Transpiling running the checker makes the checker's claim its own: "Transpile runs `tsc` to type-check".
const OWNS = /\b(?:runs|invokes|uses|calls|executes|wraps|includes|contains|has|applies|launches|spawns)\b/i;
// The last word before transpiling that makes it an instruction's MEANS: "by transpiling", "with the
// transpile", "run the transpile", "in the transpile step". Anything else — "before", "after", "you" —
// makes it the instruction's time, or someone else's act.
const MEANS = /^(?:by|with|via|using|through|run|running|use|in|during|within)$/i;
const FILLER = /^(?:the|a|an|its|this|that|your|every|each|page|pages|code|file|it|them)$/i;
// A passive claim, and the words that name its agent after it: "…is type-checked BY `tsc`".
const AUX = /\b(?:is|are|be|been|being|was|were|gets?|got)\s+(?:(?!not\b|never\b)\w+\s+)?$/i;
const AGENT = /^(?:by|with|using|via|through)$/i;
const gapWords = (text) => text.split(/\s+/).map((w) => w.replace(/[^\w-]/g, '')).filter((w) => w && !FILLER.test(w));
// Inline emphasis is not a word between a negation and its claim: "does **not** type-check" denies it.
const plain = (text) => text.replace(/\*+/g, '').replace(/(^|[\s(])_([^_\s][^_]*?)_(?=$|[\s).,;:!?])/g, '$1$2');

function governed(clause, claimIndex) {
  let last = null;
  for (const m of clause.slice(0, claimIndex).matchAll(NEGATION)) last = m;
  if (!last) return false;
  const words = clause.slice(last.index + last[0].length, claimIndex).trim().split(/\s+/).filter(Boolean);
  if (words.every((w) => BRIDGE.test(w))) return true;
  // A denial carried through a coordination: "does not bundle or type-check", "does not minify, bundle or
  // type-check". The claim is the last item of a list the negation heads: `or`/`nor`, then bridge words at
  // most. A new subject after the `or` ("…, or it type-checks") is no such list.
  let i = words.length - 1;
  while (i >= 0 && BRIDGE.test(words[i])) i -= 1;
  return i > 0 && /^n?or$/i.test(words[i]);
}

function actorsOf(clause) {
  return [...clause.matchAll(ACTOR)].map((m) => ({ kind: m.groups.t ? 't' : m.groups.x ? 'x' : 'r', start: m.index, end: m.index + m[0].length }));
}

// Is the claim at [at, end) made of transpiling? See the header.
function attributed(clause, actors, at, end, continued) {
  // A claim that is part of a checker's own name ("run the type-check script") is that checker's,
  // unless transpiling is what runs it ("Transpile includes a type-check step").
  const host = actors.find((a) => a.kind === 'x' && a.start <= at && end <= a.end);
  if (host) {
    const runner = actors.filter((a) => a.kind === 't' && a.end <= host.start).pop();
    return !!runner && OWNS.test(clause.slice(runner.end, host.start));
  }
  const next = actors.find((a) => a.start >= end);
  // A PASSIVE claim whose agent is a checker named after it — "the page is type-checked by `tsc`", "type
  // errors are caught by the type checker" — is that checker's, unless transpiling is what runs it.
  const passive = AUX.test(clause.slice(0, at)) || /\b(?:is|are|gets?|be)\b/i.test(clause.slice(at, end));
  if (passive && next && next.kind === 'x' && gapWords(clause.slice(end, next.start)).some((w) => AGENT.test(w))) {
    const runner = actors.filter((a) => a.kind === 't' && a.start < next.start).pop();
    return !!runner && OWNS.test(clause.slice(runner.end, next.start));
  }
  const before = actors.filter((a) => a.start < at);
  if (before.length) {
    const near = before[before.length - 1];
    if (near.kind === 't') return true;
    const owner = before[before.length - 2];
    return near.kind === 'x' && !!owner && owner.kind === 't' && OWNS.test(clause.slice(owner.end, near.start));
  }
  if (continued) return true;
  if (!next || next.kind !== 't') return false;
  const gap = gapWords(clause.slice(end, next.start));
  // Nothing but filler between the two: "To type-check the page, transpile it" and "For type-checking,
  // transpile the page" are purposes; without the "to" or "for" ("Type-check, transpile, upload.") it is
  // a list of steps.
  if (!gap.length) return /\b(?:to|for)\s+$/i.test(clause.slice(0, at));
  return MEANS.test(gap[gap.length - 1]);
}

// Paragraphs, list items and table cells, as separate units (a heading is a unit too, so what `It` refers
// to after one is decided by the heading itself). Fenced code is skipped — it is commands, not claims.
function docUnits(markdown) {
  const units = [];
  let cur = [];
  let fenced = false;
  const flush = () => { if (cur.length) units.push(cur.join(' ')); cur = []; };
  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { flush(); fenced = !fenced; continue; }
    if (fenced) continue;
    if (!line) { flush(); continue; }
    if (/^#{1,6}\s/.test(line)) { flush(); units.push(line.replace(/^#+\s*/, '')); continue; }
    if (line.startsWith('|')) { flush(); for (const cell of line.split('|')) if (cell.trim()) units.push(cell.trim()); continue; }
    const item = /^(?:[-*+]|\d+[.)]|>)\s+/.exec(line);
    if (item) flush();
    cur.push(item ? line.slice(item[0].length) : line);
  }
  flush();
  return units;
}

function transpileTypeClaims(markdown) {
  const found = [];
  let prev = false; // is the actor named last transpiling — what `it` would continue
  for (const unit of docUnits(markdown)) {
    for (const sentence of unit.split(/(?<=[.!?])\s+(?=[A-Z`(*"'])/)) {
      for (const raw of sentence.split(CLAUSE_BREAK)) {
        const clause = plain(raw.trim());
        const actors = actorsOf(clause);
        const continued = prev && CONTINUES.test(clause);
        if ((continued || actors.some((a) => a.kind === 't')) && !found.includes(sentence)
          && [...clause.matchAll(TYPE_CLAIM)].some((m) => !governed(clause, m.index) && attributed(clause, actors, m.index, m.index + m[0].length, continued))) {
          found.push(sentence);
        }
        prev = actors.length ? actors[actors.length - 1].kind === 't' : continued;
      }
    }
  }
  return found;
}

test('the transpile claim detector catches reworded claims and allows negated ones', () => {
  for (const claim of [
    'Run `pac model genpage transpile` to type-check the page before deploy.',
    'A clean transpile means the page is type-safe.',
    'Transpilation catches type errors early.',
    'The transpile step validates the types of every prop.',
    'Use the transpile as a typecheck, then upload.',
    'After transpiling, the types are correct.',
    'Transpile performs static type analysis.',
    'Transpile catches typing mistakes.',
    'A clean transpile guarantees type correctness.',
    'The transpiler acts as a type checker.',
    // A negation that governs something ELSE does not excuse the claim — in its clause, beyond a
    // conjunction, or too far before it.
    'Transpile does not bundle dependencies, but it type-checks the page.',
    'Transpile does not bundle and type-checks the page.',
    'Transpile does not require the reader to install anything to type-check the page.',
    'Transpile does not need a flag to type-check the page.',
    // …but not past a new subject.
    'Transpile does not bundle anything, or it type-checks the page.',
    // A hedge is not a denial: each says that sometimes it does.
    'Transpile does not always type-check the page.',
    'Transpile does not necessarily type-check the page.',
    'Transpile does not fully type-check the page.',
    'Transpile does not really type-check the page.',
    // An instruction whose MEANS is transpiling, and a checker that transpiling runs.
    'Type-check the page by transpiling it.',
    'To type-check the page, run the transpile.',
    'To type-check the page, transpile it.',
    'Type-check the page with `pac model genpage transpile`.',
    'Type-check in the transpile step.',
    'Transpile runs `tsc` to type-check the page.',
    // A step that FAILS on type errors, and the passive of catching them, are the same guarantee.
    'The transpile step fails on type errors.',
    'Transpile rejects code with type errors.',
    'Type errors are caught during transpilation.',
    'Run the transpile. It fails on type errors.',
    // A checker named after an ACTIVE claim is its instrument, not its agent — and a passive one's agent
    // that transpiling runs is transpiling's.
    'Transpile type-checks the page with `tsc`.',
    'Transpiling runs `tsc`, which means the page is type-checked by `tsc`.',
    // A purpose with "for", a non-zero exit, and a checker step that transpiling itself includes.
    'For type-checking, transpile the page.',
    '`pac model genpage transpile` exits non-zero on type errors.',
    'Transpile returns a non-zero exit code for type errors.',
    'Run the transpile. It exits non-zero on type errors.',
    'Run the transpile. It returns non-zero on type errors.',
    // A checking or warning verb reaches the type errors across a few words, as the catching verbs do.
    'Transpile checks for type errors.',
    'The transpile step checks the page for type errors.',
    'Transpile warns about type errors.',
    'Transpile throws on type errors.',
    'Transpile raises an error on type mismatches.',
    'Transpile raises type errors early.',
    'Transpile checks whether the page has type errors.',
    // Type soundness, and the absence of type errors, are the same guarantee.
    'The transpiler proves type soundness.',
    'Transpilation guarantees no type errors.',
    'A clean transpile means the page is free of type errors.',
    'Transpile warns when the page has type errors.',
    'Transpile throws if the code contains type errors.',
    'Transpile throws an exception if the page has type errors.',
    'Transpile warns the user when the page has type errors.',
    'Type errors are checked during transpilation.',
    'Transpile includes a type-check step.',
    'Transpile has a type-check step.',
    'Transpile contains a type-check step.',
    'Transpile uses the type checker.',
    // `it`, `this` or `that` carries the subject across a clause, a sentence, a blank line, or into the
    // next list item.
    'Run the transpile. It type-checks the page.',
    'Run the transpile; this type-checks the page.',
    'Run the transpile. That validates the types.',
    'Run the transpile. It does not bundle. It type-checks the page.',
    'Transpile the page.\n\nIt type-checks every prop.',
    '- Transpile does not bundle anything.\n- It type-checks the page.',
    // Each list item, table cell and heading is its own unit, so a negation in one never excuses the next.
    '- Transpile does not bundle anything\n- Transpile type-checks the page',
    '| Transpile does not bundle | Transpile type-checks the page |',
    '## Transpile does not bundle\nTranspile type-checks the page.',
  ]) {
    assert.ok(transpileTypeClaims(claim).length > 0, `must be caught: ${claim}`);
  }
  for (const fine of [
    '`pac model genpage transpile` only transpiles the page: it does not type-check it.',
    'A clean transpile is not proof that the types are correct.',
    'A clean transpile is therefore no proof that the page is type-safe.',
    'A transpile that succeeds does not mean the page is type-safe.',
    'Transpile never type-checks.',
    'Transpile cannot type-check.',
    'It passes TypeScript and `pac model genpage transpile`, then logs a runtime error.',
    'Run the type check separately, before you upload the page.',
    'Transpile first, then type-check separately with `tsc`.',
    'Transpile the page and use `tsc` to type-check it.',
    // A claim belongs to the actor named nearest before it: a checker, or the reader.
    'Use `tsc` to type-check the page after transpiling it.',
    'After transpiling it, use `tsc` to type-check the page.',
    'Transpile emits JavaScript while `tsc` type-checks the source.',
    'After transpiling, the type checker catches type errors.',
    'After transpiling, the TypeScript compiler reports type errors.',
    // A passive claim whose agent is a checker named after it is that checker's.
    'After transpiling, the page is type-checked by `tsc`.',
    'After transpiling, type errors are caught by the type checker.',
    // The failure and passive families deny the same way, and emphasis around a denial is no word between.
    'Type errors are not caught during transpilation.',
    'The transpile step does not fail on type errors.',
    'Transpile does **not** type-check the page.',
    'Transpile does *not* type-check the page.',
    'Transpile does _not_ type-check the page.',
    // A negation carries through a list it heads.
    'Transpile does not bundle or type-check the page.',
    'Transpile does not minify, bundle or type-check the page.',
    'Transpile does not bundle it or type-check it.',
    // The truth about the exit code, a generic checker step, and a "for" purpose served by a checker.
    '`pac model genpage transpile` exits 0 even with type errors.',
    "After transpiling, run the project's type-check script.",
    'For type-checking, use `tsc`.',
    'Run the transpile. That means you must type-check it yourself.',
    // An instruction whose TIME is transpiling is not about it.
    'Type-check separately before transpiling.',
    'Type-check the page before you transpile it.',
    'Type-check the page in a separate step before transpiling it.',
    'Type-check, transpile, upload.',
    // …and so does a check for type errors the reader runs, or one that is denied.
    'Transpile the page, then check it for type errors with `tsc`.',
    'Transpile does not check for type errors.',
    'After transpiling, `tsc` checks for type errors.',
    // A contrast between the verb and the type errors, or a denial right after them, is the truth.
    'Transpile checks syntax even with type errors.',
    // …and so is denying that absence.
    'A clean transpile does not mean there are no type errors.',
    'Transpile does not guarantee the page is free of type errors.',
    'Transpile reports success despite type errors.',
    'Transpile warns that type errors are not checked.',
    'Transpile warns that type errors aren’t checked.',
    "Transpile warns that type errors aren't checked.",
    'Transpile warns that type errors remain unchecked.',
    'Transpile checks syntax while type errors remain.',
    'Transpile reports success yet type errors remain.',
    // `It` continues the MOST RECENT subject — here `tsc`.
    'Transpile the page, then run `tsc`. It type-checks every prop.',
    'Transpile before invoking the type checker.',
    // A type error named as a SUBJECT is the opposite of a claim.
    '`pac model genpage transpile` only transpiles the page: a type error still transpiles and writes JavaScript.',
    '- Transpile the page.\n- It does not type-check it.',
    // A sentence that continues with something other than `it` making the claim is about something else.
    '`pac model genpage transpile` only transpiles the page. That is what the type check in Step 5 is for.',
    'Transpile the page; it is important to type-check it too.',
    // After a heading, `It` is whatever the heading names.
    'Transpile the page.\n\n## The type checker\nIt type-checks every prop.',
    // A unit boundary ends a subject: joined up, each of these would make transpile the subject of the
    // next unit's claim.
    '- Transpile the page\n- The `tsc` step type-checks every prop',
    '| Transpile the page | The `tsc` step type-checks every prop |',
    '## Transpile the page\nThe `tsc` step type-checks every prop.',
    // …even with no checker named to take the claim, where only the boundary keeps it apart — and so
    // does a clause boundary before "and".
    '- Transpile the page\n- The type check is a separate step',
    '| Transpile the page | The type check is a separate step |',
    '## Transpile the page\nThe type check is a separate step.',
    'Transpile the page and the type check runs separately.',
    // Fenced code is commands, not claims.
    '```\ntranspile && npm run typecheck\n```',
  ]) {
    assert.deepEqual(transpileTypeClaims(fine), [], `must be allowed: ${fine}`);
  }
});

// One third-person predicate per claim family. Each must be caught both in a clause about transpiling and
// as the continuation of one: the claim families and the continuation vocabulary are built from the same
// stems, and this is what proves they agree — a family added to one without the other fails here.
const FAMILY_PREDICATES = [
  'type-checks the page',
  'is type-safe',
  'reports type errors',
  'ensures type errors are caught',
  'fails on type errors',
  'guarantees type correctness',
  'guarantees no type errors',
  'means the types are correct',
  'validates the types',
  'guarantees correct types',
  'acts as a type checker',
];
test('every claim family is caught directly and as a continuation, so the two vocabularies cannot drift', () => {
  assert.strictEqual(FAMILY_PREDICATES.length, CLAIM_FAMILIES.length, 'one pinned predicate per claim family');
  FAMILY_PREDICATES.forEach((p, i) => assert.match(p, new RegExp(CLAIM_FAMILIES[i], 'i'), `predicate ${i} pins its own family`));
  assert.strictEqual(CAUGHT.length, CATCHING.length, 'one past participle per catching verb');
  const catching = CATCHING.map((v) => `${v}${/ch$/.test(v) ? 'es' : 's'} type errors`);
  const caught = CAUGHT.map((c) => `ensures type errors are ${c}`);
  const failing = FAILING.map((v) => `${v}s on type errors`);
  const checking = ['validates the types', 'verifies the types', 'checks the types'];
  assert.ok(CHECKING.every((stem) => checking.some((p) => p.startsWith(stem))), 'every checking stem is pinned');
  const serving = BEING.filter((b) => b !== 'is').map((b) => `${b} a type checker`);
  for (const p of [...FAMILY_PREDICATES, ...catching, ...caught, ...failing, ...checking, ...serving]) {
    for (const text of [`Transpile ${p}.`, `Run the transpile. It ${p}.`, `Run the transpile; this ${p}.`, `Transpile does not bundle anything, and ${p}.`]) {
      assert.ok(transpileTypeClaims(text).length > 0, `must be caught: ${text}`);
    }
  }
  for (const c of CAUGHT) assert.ok(transpileTypeClaims(`Type errors are ${c} during transpilation.`).length > 0, `must be caught: ${c}`);
});

test('no genpage instruction presents transpilation as a type check', () => {
  for (const file of mdFiles()) {
    assert.deepEqual(transpileTypeClaims(fs.readFileSync(file, 'utf8')), [], `${rel(file)} must not present transpilation as a type check`);
  }
  const builder = fs.readFileSync(path.join(PLUGIN, 'agents', 'genpage-page-builder.md'), 'utf8');
  assert.match(builder, /genpage transpile`\s+only transpiles the page: it does not type-check it/, 'the page-builder must say transpilation is not a type check');
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
