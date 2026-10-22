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

test('connector docs do not probe the retired feature flag', () => {
  const docs = [
    path.join(PLUGIN, 'agents', 'genpage-connector-builder.md'),
    path.join(PLUGIN, 'agents', 'genpage-planner.md'),
    path.join(PLUGIN, 'agents', 'genpage-edit-planner.md'),
    path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md'),
    path.join(PLUGIN, 'skills', 'genpage', 'edit-flow.md'),
    path.join(PLUGIN, 'references', 'connectors.md'),
  ];
  for (const doc of docs) {
    const text = readDoc(doc);
    assert.doesNotMatch(text, /feature-flags\.js"?\s+connectors\b/, `${rel(doc)} must not probe the retired connectors flag`);
    assert.doesNotMatch(text, /GENPAGE_ENABLE_CONNECTORS/, `${rel(doc)} must not document the retired connectors env var`);
    // Prose that still describes a connectors "rollback gate" tells an agent to probe for it, and the
    // retired flag now always reports disabled, which would silently drop the page's connectors.
    // Matched in any word order: "the builder owns the rollback gate" slipped past a pattern that
    // required "connectors" before it.
    assert.doesNotMatch(text, /rollback\s+gate|connector\s+discovery\s+and\s+its\s+rollback\s+gate|probes\s+first,\s+writes\s+`No connector bindings/i,
      `${rel(doc)} must not describe a connectors rollback gate`);
    // Nor may it describe a connectors-off mode, or a connector builder that gates on a flag.
    assert.doesNotMatch(text, /connectors\s+(?:are|is)\s+(?:off|disabled)/i, `${rel(doc)} must not describe connectors being off`);
    assert.doesNotMatch(text, /genpage-connector-builder`?[\s\S]{0,40}?gated\s+on\s+the\s+flag/i,
      `${rel(doc)} must not say the connector builder gates on a flag`);
  }
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

// The Griffel shorthand gate (AB#6691124). Griffel's runtime drops ten CSS shorthands from a `makeStyles` object and the page then deploys without them, so every instruction
// that writes, edits or accepts a page names them, and every orchestrator runs scripts/check-griffel-styles.js on the page before it transpiles or uploads it. Nothing executes
// those instructions, so — as with the Connectors line above — a document that drops the rule or the command is invisible until a page ships without its border. The rule is ONE
// text, stated in the same words in every document (whitespace aside: they wrap their lines differently), so a correction to one cannot leave another stating the old rule.
const { UNSUPPORTED_GRIFFEL_SHORTHANDS } = require('../lib/griffel-styles.js');

const squash = (text) => text.replace(/\s+/g, ' ');
const GRIFFEL_RULE = [
  'Griffel does not support ten CSS shorthands, and `makeStyles` drops them at runtime: the page type-checks, transpiles and deploys, then renders without the border, color or reset.',
  'They are `all`, `borderColor`, `borderStyle`, `borderWidth`, `borderBlock`, `borderBlockStart`, `borderBlockEnd`, `borderInline`, `borderInlineStart` and `borderInlineEnd`.',
  'Write longhands instead: `borderColor`, `borderStyle` and `borderWidth` become one longhand per side, `border` + `Top`, `Right`, `Bottom` or `Left` + `Color`, `Style` or `Width`',
  '(`borderWidth` → `borderTopWidth`, `borderRightWidth`, `borderBottomWidth`, `borderLeftWidth`);',
  '`borderBlock`, `borderInline` and their `Start` and `End` forms become the `Width`, `Style` and `Color` longhands of the sides they name',
  '(`borderBlockStart` → `borderBlockStartWidth`, `borderBlockStartStyle`, `borderBlockStartColor`; `borderBlock` → those and the three `borderBlockEnd…` ones);',
  '`all` has no longhands, so set the properties you need one by one.',
  'Every other shorthand (`padding`, `margin`, `border`, `borderRadius`, `gap`, `outline`) is supported, and an inline `style={{ … }}` is not Griffel at all.',
].join(' ');
// What the documents that RUN the checker add: its output, its exit code, and that nothing is transpiled or uploaded before it exits 0.
const GRIFFEL_GATE = [
  '`check-griffel-styles.js` prints each problem it finds — a key Griffel drops in a `makeStyles` call, at any depth, with its line, column and longhands,',
  'or a call or a style object it cannot read, with what to change — and exits 3 while any is left:',
  'fix what it reports and run it again, and do not transpile or upload the page until it exits 0.',
  'It reads the style objects written inline in the call, `makeStyles({ … })`, so write them there:',
  'one passed or spread in from elsewhere (`makeStyles(styles)`, `...base`) is reported, because the check cannot see its keys,',
  'and so is a key computed from an expression (`[key]: …`), whose name it cannot see (a template that starts with `--`, `&`, `:` or `@` is read);',
  'Fluent\'s `...shorthands.*(…)` and `...typographyStyles.*` may be spread as they are.',
].join(' ');
const OLD_BORDER_WIDTH_GREP = `['"]?borderWidth['"]?\\s*:`;

function griffelDocs() {
  return {
    rules: readDoc(path.join(PLUGIN, 'references', 'rules.md')),
    'page-builder': readDoc(path.join(PLUGIN, 'agents', 'genpage-page-builder.md')),
    'create flow': readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md')),
    'edit flow': readDoc(path.join(PLUGIN, 'skills', 'genpage', 'edit-flow.md')),
    'app-builder': readDoc(path.join(PLUGIN, 'skills', 'app-builder', 'SKILL.md')),
  };
}

test('every instruction that writes a page states the Griffel rule in the same words, with all ten properties and their longhands', () => {
  for (const [name, text] of Object.entries(griffelDocs())) {
    assert.ok(squash(text).includes(GRIFFEL_RULE), `${name} must state the Griffel rule in the shared words`);
  }
  // The shared text is the checker's own set: a property the checker gains has to reach the instructions, and one it loses must leave them.
  for (const property of UNSUPPORTED_GRIFFEL_SHORTHANDS.keys()) assert.ok(GRIFFEL_RULE.includes(`\`${property}\``), `the rule names ${property}`);
  assert.equal(GRIFFEL_RULE.match(/ They are (.*?)\. /)[1].split(/, | and /).length, UNSUPPORTED_GRIFFEL_SHORTHANDS.size, 'and names no other');
  for (const property of ['borderWidth', 'borderBlockStart']) {
    for (const longhand of UNSUPPORTED_GRIFFEL_SHORTHANDS.get(property)) assert.ok(GRIFFEL_RULE.includes(`\`${longhand}\``), `the rule spells out ${longhand}`);
  }
});

test('the grep for borderWidth alone — one of the ten, and blind to a string or a comment — is gone from every instruction', () => {
  for (const file of mdFiles()) assert.ok(!readDoc(file).includes(OLD_BORDER_WIDTH_GREP), `${rel(file)} still greps for borderWidth alone`);
});

test('every orchestrator runs the Griffel checker as a gate before it transpiles or uploads a page', () => {
  const docs = griffelDocs();
  const command = (target) => `node "\${PLUGIN_ROOT}/scripts/check-griffel-styles.js" --file '${target}'`;
  const gated = (name, text) => assert.ok(squash(text).includes(GRIFFEL_GATE), `${name} must state the gate: exit 3 while a problem is left, nothing uploaded until exit 0`);

  // /genpage, one page: step 9 of Phase 5b, ahead of the completeness gate (step 10) and of Phase 6.
  const skill = docs['create flow'];
  const fastPath = skill.split(/#### 5b\. Single-page fast path/)[1].split(/#### 5c\. Multi-page/)[0];
  assert.ok(fastPath.includes(command('<working-dir>/<filename>.tsx')), 'single-page generation runs the checker on the page it wrote');
  gated('single-page generation', fastPath);
  assert.ok(fastPath.indexOf('check-griffel-styles.js') < fastPath.indexOf('genpage-worker-output.js" --file'), 'the Griffel check comes before the completeness gate');

  // /genpage, several pages: the workers cannot run it, so the orchestrator does, per page, before Phase 6.
  const multiPage = skill.split(/#### 5c\. Multi-page/)[1].split(/### Phase 6: Deploy/)[0];
  assert.ok(multiPage.includes(command('<working-dir>/<filename>.tsx')), 'multi-page generation runs the checker on every page');
  assert.match(squash(multiPage), /workers have no shell, so they cannot run the Griffel check themselves/);
  assert.match(squash(multiPage), /A page that has not exited 0 is not deployed\./);
  assert.ok(multiPage.lastIndexOf('genpage-worker-output.js') < multiPage.indexOf('check-griffel-styles.js'), 'the Griffel check follows the completeness gate');

  // /genpage, an edit: before Edit Phase 6.
  const edit = docs['edit flow'];
  assert.ok(edit.includes(command('<working-dir>/<page-id>/page.tsx')), 'an edited page is checked');
  gated('the edit flow', edit);
  assert.ok(edit.indexOf('check-griffel-styles.js') < edit.indexOf('## Edit Phase 6: Deploy Updated Page'), 'the edited page is checked before it is uploaded');

  // /app-builder: its pages come from the same workers, and are checked before promote-intent-pages.js commits them.
  const appBuilder = docs['app-builder'];
  assert.ok(appBuilder.includes('node "${PLUGIN_ROOT}/scripts/check-griffel-styles.js" --file <working-dir>/<file>'), 'app-builder checks every generated page');
  gated('app-builder', appBuilder);
  assert.ok(appBuilder.indexOf('check-griffel-styles.js') < appBuilder.indexOf('promote-intent-pages.js" \\'), 'the pages are checked before they are promoted');

  // The reference the workers read spells the same command and gate out.
  assert.ok(docs.rules.includes(command('<page.tsx>')), 'rules.md names the checker');
  gated('rules.md', docs.rules);
});

// The page-builder worker has Read, Write, Edit and Grep — no shell — so it cannot run a Node script, and an instruction to would be one it can only skip or fake. It gets the rule
// and a Grep to find the places to look; the orchestrators above run the checker on what it writes.
test('the page-builder, which has no shell, is given the Griffel rule and a Grep self-review rather than a command it cannot run', () => {
  const builder = griffelDocs()['page-builder'];
  const tools = /^---\n([\s\S]*?)\n---/.exec(builder)[1];
  assert.doesNotMatch(tools, /^\s*-\s*(Bash|execute|shell|powershell)\s*$/im, 'the premise: this agent has no shell tool — if it gains one, make it run the checker');
  const step = squash(builder.split('## Step 2.6')[1].split('## Step 3')[0]);
  assert.doesNotMatch(step, /node\s+"\$\{PLUGIN_ROOT\}/, 'no command for a worker to run');
  assert.match(step, /You have no shell, so you cannot run the checker: after you return, the orchestrator runs `\$\{PLUGIN_ROOT\}\/scripts\/check-griffel-styles\.js` on your file and fixes anything it reports before the page is deployed\./);
  assert.match(step, /so write every one that way\./, 'the worker is told to write the objects inline, the one form the checker reads');
  assert.match(step, /Do not return a file that still has one in a `makeStyles` object\./);

  // The Grep is the documented regex: it must list every place a flagged key is written and nothing that merely resembles one.
  const documented = /with the regex `([^`]+)`/.exec(step)[1];
  const grep = new RegExp(documented);
  for (const property of UNSUPPORTED_GRIFFEL_SHORTHANDS.keys()) assert.ok(documented.includes(property), `the regex lists ${property}`);
  const keyed = ["borderWidth: 0", "  borderWidth : 0", "{ all: 'unset' }", '"borderColor": 1', "'borderStyle' : 'solid'", "['borderBlock']: x", '{borderInline: 1}',
    ',borderInlineStart: 1', 'root: { borderBlockEnd: `1px` }', '\tborderBlockStart:'];
  for (const line of keyed) assert.match(line, grep, `the Grep must list ${JSON.stringify(line)}`);
  const lookalikes = ['overall: 1', 'borderTopWidth: 1', 'borderWidths: 1', 'padding: 1', "border: '1px solid red'", 'borderRadius: 1', 'borderBlockStartWidth: 1', 'allow: true', "content: 'borderWidth'"];
  for (const line of lookalikes) assert.doesNotMatch(line, grep, `the Grep must not list ${JSON.stringify(line)}`);
});

// The orchestrators' gate above is an instruction, and an instruction can be skipped — so the paths that upload a page AFTER a fix or a hand edit, which had no check at all, name the
// checker as well, and say that the code holds the same line: genpage-upload.js refuses the page, and so does the build (scripts/tests/genpage-upload.test.js and
// sdk-build-pages-deploy.test.js run those).
test('the paths that re-upload a page after a browser-verify fix or a hand edit run the Griffel checker too, and say the upload and the build enforce it', () => {
  const checker = (target) => `node "\${PLUGIN_ROOT}/scripts/check-griffel-styles.js" --file ${target}`;
  // /genpage §7.5: the fix is new code, checked before the update command.
  const fix = readDoc(path.join(PLUGIN, 'skills', 'genpage', 'verify-flow.md')).split('## 7.5 Fix and Re-deploy')[1];
  assert.ok(fix.includes(checker("'<working-dir>/<file>.tsx'")), 'the fixed page is checked');
  assert.ok(fix.indexOf('check-griffel-styles.js') < fix.indexOf('node "${PLUGIN_ROOT}/scripts/genpage-upload.js" `'), 'the check comes before the update command');
  assert.match(squash(fix), /Do not upload until it exits 0: fix what it reports \(each key's line, column and longhands\) and run it again\./);
  assert.match(squash(fix), /`genpage-upload\.js` makes the same check and refuses a page that adds a key the deployed page did not already have, or gives one it had another value \(`griffel-shorthand`\)/);
  assert.match(squash(fix), /`references\/rules\.md` Common Pitfalls 5/, 'and it points at the rule rather than restating it');

  // /app-builder, editing a deployed app: a page edited by hand is checked before the rebuild, and the build's own halt is named.
  const appBuilder = readDoc(path.join(PLUGIN, 'skills', 'app-builder', 'SKILL.md'));
  const editing = appBuilder.split('## Editing a deployed app')[1].split('## What the builder does')[0];
  const editStep = editing.split(/\n2\. /)[1].split(/\n3\. /)[0];
  assert.ok(editStep.includes(checker('<page.tsx>')), 'a hand-edited page is checked');
  assert.match(squash(editStep), /before you rebuild \(the rule and the ten shorthands are in Phase 1\.5, step 5\)/);
  assert.match(squash(editStep), /halts as `pages-griffel-shorthand` — naming the page, each key's line and column, and the longhands/);
  assert.match(squash(appBuilder), /- `pages-griffel-shorthand` — a page's `makeStyles` writes a CSS shorthand Griffel drops at runtime/, 'the halt is in the list a user is told to follow');
  assert.match(readDoc(path.join(PLUGIN, 'references', 'app-spec-schema.md')), /- `pages-griffel-shorthand` — a page that this run uploads has a `makeStyles` key Griffel drops at runtime/);

  // /genpage Phase 6: the upload script's refusal is described, with its code.
  const skill = squash(readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md')));
  assert.match(skill, /`genpage-upload\.js` reads the code file and refuses a page whose `makeStyles` writes one of the ten Griffel shorthands \(Phase 5b step 9\): a create outright, before it lists, reads or writes anything, and an update for any key the deployed page did not already have \(below\)\. The result is `"code":"griffel-shorthand"`/);
  assert.match(skill, /no flag skips it, and `--overwrite-deployed` does not/);
  // The plugin guide says the same, and that the check is made in code.
  const agents = squash(readDoc(path.join(PLUGIN, 'AGENTS.md')));
  assert.match(agents, /the code \*\*enforces\*\* it where pages are uploaded/);
  assert.match(agents, /`genpage-upload\.js` reads the code file first and refuses a create with `code: "griffel-shorthand"`/);
  assert.match(agents, /the build's pages phase halts as `pages-griffel-shorthand` in its pre-write scan/);
});

// A page deployed by an earlier release can already hold a key Griffel drops (its only guard was a grep for `borderWidth`), and it renders without it today. Sending the same bytes again
// ships nothing new, and refusing them stops a rebuild over a page nobody touched — whose way through, the longhands, CHANGES how the page renders. So the gates hold a page to what a run
// would ADD, and say what each way out does. These are instructions nothing executes, so a document that drops the distinction — or the advice that goes with it — is invisible until
// a maker is told to change how a page looks. scripts/tests/sdk-build-pages-deploy.test.js and genpage-upload.test.js run the gates themselves.
test('the docs say the gates hold a page to what a run would add, and say what each way out does to the page', () => {
  const read = (...parts) => squash(readDoc(path.join(PLUGIN, ...parts)));
  const agents = read('AGENTS.md');
  // The plugin guide: the build's four standings and why the unrecorded one fails open, and the upload script's comparison.
  const holds = agents.split('**What the gates hold a page to.**')[1].split('- **Who runs it.**')[0];
  assert.match(holds, /So every refusal and warning says both: \*deleting a key changes nothing on screen; writing the longhands makes the style start to render\*\./);
  assert.match(holds, /A page that does not exist yet \(`keyToId` has no id for it: it is \*created\*\) and a page that exists but whose source no longer hashes to the `__contentSha` that `last-applied\.json` recorded for it at the last apply \(\*changed\*\) are held to the check/);
  assert.match(holds, /A page whose source hashes to that record \(\*unchanged\*\), or that has no record \(\*unrecorded\*\), is sent as it is, and the build warns \(`opts\.warn`\) with file:line:column and both remedies\./);
  assert.match(holds, /returned only for this app \*\*in this environment\*\* \(`readBaseline`/);
  assert.match(holds, /\*Unrecorded\* [^.]*fails \*\*open\*\* on purpose/);
  assert.match(holds, /a page that does not exist is always held, record or not/);
  assert.match(holds, /\*\*`genpage-upload\.js`\*\* has the deployed page in hand/);
  assert.match(holds, /`griffelProblemsNotIn`: only the same key set to the same value in the same place \(`within`: its slot, selectors and at-rules — of the same `makeStyles` call, `owner`: the name its hook is bound to at the top of the page, read through a type annotation \(`const usePanel: Hook = …` is `usePanel`, not `Hook`\) and for a property it is assigned to \(`hooks\.panel = …`\); and the same arm of every condition between the call and the key — `branch` for the call's own argument, and `arms` below it: [^)]*\) is the deployed page's own — one set to the same value in \*another\* place is new, so an edit that removes a key from one place and sets it in another has added one/);
  assert.match(holds, /a key moved to another hook's `root` or into the other arm of a condition, at any level: the source cannot tell it from a removal and an addition[^.]*where the correspondence cannot be shown[^.]*the key is new, never inherited/);
  assert.match(holds, /\*\*Only a unique name at the top of the page proves which hook a call is\*\* — not its order among the calls, not the type it is annotated with, not the function it is written in[^.]*is nobody's \(`owner: null`\)[^.]*a key in it is refused on an update like any new one/);
  assert.match(holds, /A key given \*\*another value\*\* is new too: Griffel drops the new value as it dropped the old one, so the page would show none of the change the maker meant/);
  assert.match(holds, /the hash recorded is of the source the pages phase \*read and checked\* \(`created\.pageSourceShas`\), not of the file when the baseline is written as the build ends/);
  assert.match(holds, /Every page is written as the text the scan read — the SDK takes a page's text, so there is no file for a later save to reach — and a page saved after the scan does not ship: the next build checks it, because the record holds the source that was checked and the file no longer matches it\./);
  assert.doesNotMatch(holds, /sent from its own file|ships unchecked/, 'no page is uploaded from its canonical file any more, so the guide must not describe the gap that closed');
  assert.match(holds, /`--overwrite-deployed` is no way past that/);
  assert.match(holds, /A call the checker cannot read\*\* is not CSS Griffel drops, and is not said to be/);
  assert.match(holds, /quotes a path that has white space/);
  // The skills and references that tell a user or an agent what to do.
  const editFlow = read('skills', 'genpage', 'edit-flow.md');
  assert.match(editFlow, /A page that was deployed before this check existed can already hold such a key, so the checker may report one that your edit did not add\./);
  assert.match(editFlow, /\*\*delete the key\*\* — nothing changes on screen, so it is the edit that preserves the page — or \*\*write the longhands\*\*, which makes the style start to render, so the page changes\. Delete it unless the user asked for that change/);
  const skill = read('skills', 'genpage', 'SKILL.md');
  assert.match(skill, /An update is held to what it \*\*adds\*\*\./);
  assert.match(skill, /\*\*delete the key\*\* \(nothing changes on screen\) or \*\*write the longhands\*\* \(the style starts to render, so the page changes\)\. Only a key the deployed page did not have in that place stops the upload: a key it had in another place \(an edit that removes it from one slot and sets it in another, or renames the slot, or moves it to another hook's slot of the same name — every hook has a `root` — or into the other arm of a condition, at any level, has added a key there\), or one it had, given another value, because Griffel drops the new value just as it dropped the old, so the page would show none of the change\./);
  assert.match(skill, /the same place \(the same `makeStyles` hook — told by the name it is bound to at the top of the file, even with a type annotation — and its slot and selector, and the same arm of every condition above the key\)/);
  assert.match(skill, /A hook whose name the file does not prove — written inside a function or a block, passed as an argument, exported as the default, or bound to a name two hooks share — has no earlier self to be compared with, so a key in it is refused on an update like any new one: delete it, or write the longhands\./);
  assert.match(read('skills', 'genpage', 'verify-flow.md'), /delete it to keep the page looking as it does, or write the longhands to make the style start to render/);
  const appBuilder = read('skills', 'app-builder', 'SKILL.md');
  assert.match(appBuilder, /The build runs the same check on every page it uploads that is new or that you changed since the last successful apply of this app, and halts as `pages-griffel-shorthand`/);
  assert.match(appBuilder, /"Changed" is measured against the source that apply recorded for the page in `\.maker-workspace\/last-applied\.json` \(a successful full or changed-only apply, or a download, writes it; a failed or partial build records nothing\)\./);
  assert.match(appBuilder, /A page you did not touch is sent again as it is, and a key it already has only draws a warning — and so does a page you changed in a workspace that holds no record of it/);
  assert.match(appBuilder, /Deleting a key keeps the page looking as it does; writing the longhands makes the style start to render\. The same halt reports a `makeStyles` call the check cannot read for certain as that — not as CSS Griffel drops — and says what to change in the code\./);
  const schema = read('references', 'app-spec-schema.md');
  assert.match(schema, /is \*\*new\*\* \(no deployed page\) or \*\*changed\*\* \(its source no longer hashes to the `__contentSha` that `last-applied\.json` recorded for it at the last apply to this app in this environment — the record a successful full or changed-only apply, or a download, writes; for a page it is the hash of the source the build read and sent, and a failed or partial build records nothing\)/);
  assert.match(schema, /deleting a key changes nothing on screen \(Griffel never applied it\), writing the longhands makes the style start to render/);
  assert.match(schema, /is sent as it is and the build \*\*warns\*\* with the same detail instead: it ships nothing new\./);
});

// A page write that cannot say what it did must never be sent again blindly, and what the maker or the agent does next depends on what the write can have done. The SDK writes a page as ONE atomic change
// set, so a write either landed whole or wrote nothing; an unknown outcome is settled by reading the page, and the advice an update's refusal carries depends on the caller. AGENTS.md says so,
// and says every page-write error is final for the build's own retry — but a throttle (HTTP 429) the service refused the write with, which is waited out and sent again, and left to the build when it outlasts the waits.
// scripts/tests/genpage-sdk.test.js and genpage-sdk-real-bundle.test.js run what the backend does.
test('AGENTS.md says a page write whose outcome is not known is never sent again blindly, where each caller is pointed, that a throttled write is waited out and why that is safe, and that every other page-write error is final for the build\'s retry', () => {
  const agents = squash(readDoc(path.join(PLUGIN, 'AGENTS.md')));
  assert.match(agents, /\*\*Generative pages are written through the SDK\*\*/);
  assert.match(agents, /so a write either landed whole or wrote nothing/);
  assert.match(agents, /A \*\*create\*\* mints the page's id on the client before anything is sent, so what it did can always be found out by reading that id\./);
  assert.match(agents, /absent — nothing has landed \*yet\*, so it is sent \*\*once more under the same id\*\*: a first send that lands late collides on the id, so no second page can exist\./);
  assert.match(agents, /the page is as it was — nothing has landed yet, and it is sent \*\*once more\*\*/);
  assert.match(agents, /anything else — refused, \*\*not\*\* sent again, with where to look\./);
  // What a failure may claim: only a proven refusal is "nothing was written", and a send with no usable answer stays open — a later failure, or a read that finds nothing, does not settle it.
  assert.match(agents, /Only a failure that PROVES nothing was written is reported as `nothing` and not sent again/);
  assert.match(agents, /A send that got no usable answer stays \*\*open\*\*: it can still reach the service after anything the operation has read or been told/);
  assert.match(agents, /The turn keeps \*\*one identity\*\* across that read \(`newTurn\.id`, minted per update\)/);
  // The advice depends on the caller: the upload script has a base marker to check against, the build has none and reads every page again when it runs.
  assert.match(agents, /the upload script's message names `genpage-base\.js check` \(the deployed page against the file and the base marker beside it\), and a re-run goes back through the script's own guards; the \*\*build\*\* keeps no base marker and reads every page again when it runs, so its message says to run the build again\./);
  // A refusal with a throttle is the one write that is not a known failure of the page: it is waited out and sent again, and why that cannot write a page twice is written down.
  assert.match(agents, /\*\*A first send the service refuses with a throttle \(HTTP 429\) is waited out and sent again\*\* \(`pushThroughThrottle`\), where any other 4xx is final\./);
  assert.match(agents, /A 429 is the service declining to \*start\* the request, so the atomic change set committed nothing; and sending it again cannot write a page twice: a create's ids are minted before the first send/);
  assert.match(agents, /an update's turn carries one identity from which the SDK derives its messages' ids\. An update's send goes through the SDK's version check again, so a page someone saved during the wait is refused as `VERSION_CONFLICT` and not written over/);
  assert.match(agents, /an update's writes carry `If-Match: \*`, and `lib\/sdk-http-client\.js` re-sends a `\$batch` only when it is made of conditional deletes/);
  assert.match(agents, /The wait is the schedule that client gives every throttled request \(`throttleBackoffMs`: 1 s, 2 s, 4 s, 8 s, 8 s, plus jitter\) or the answer's `Retry-After` when that asks for longer, \*\*waited whole\*\*/);
  assert.match(agents, /inside \*\*one budget of five minutes for the waiting a throttled page write costs a build run\*\*/);
  // What the budget bounds: all the waiting a run does for a throttle — the HTTP client's own waits too, when it is given the budget — and not the waits that are not for a throttle, which keep the schedule they always had.
  assert.match(agents, /\*\*The budget bounds all the waiting a run does for a throttle — the HTTP client's waits as well as the backend's and the build's\.\*\*/);
  assert.match(agents, /A wait that does not fit is \*\*not taken\*\*: the throttled answer comes back as it came — the SDK reports the 429 it is, a refusal that started nothing, and not a failure of the transport, which it would treat as an unknown outcome — and the client tells the budget what the service asked \(`decline`; the SDK's error holds no headers\), which the build's retry loop reads: the build stops with `throttle-budget-exhausted`, saying what the service asked, on the last run as on the first, and does not run the phases again to meet the same answer\./);
  assert.match(agents, /What is not throttling keeps its own schedule and is not drawn from the budget — a 5xx \(a customization lock or a SQL deadlock victim is a 500, a gateway's hiccup a 502, 503 or 504\) whatever `Retry-After` it carries, a reset connection, the re-send of a deadlock victim — and so does a client that is given no budget/);
  // What the engine's guard lets through: the name column's length a run owes, which no later run can set — in the pass that completes the phase as in the settlement of a halt.
  assert.match(agents, /what pays what the run owes is let through \(`settling`: the name column's length of a table the run created, which no later run can set — a run that finds the table leaves its name column as it is, so a stop would leave the table at the platform's default for good — and which is therefore paid in the settlement of a halted data-model phase and in the pass that completes one, where the refusal of one table's update does not keep the next table's from being set/);
  assert.match(agents, /a resumed create that brings an earlier payload up to date hands the same budget — the one it was given, or the one it made for itself — on to the update it makes/);
  assert.match(agents, /which reads an answer only when it is complete and well-formed — its outer boundary closes, every change set in it closes, and every part is a complete response whose first line is a status line — and takes ANYTHING missing or malformed/);
  assert.match(agents, /takes ANYTHING missing or malformed \(a part with no response in it, a part with no status line or one cut off, a change set that is never closed, one that is declared and never opened, one whose delimiters are not the boundary it declares, a body shorter or longer than the `Content-Length` its response gives, a part that declares a `Transfer-Encoding`\) as proving nothing/);
  assert.match(agents, /a part that declares a `Transfer-Encoding` \(chunked or any other\) is not read at all, whole stream or not — the delimiters around it say nothing of whether its chunk stream is finished, so it never certifies a refusal or a deadlock victim/);
  assert.doesNotMatch(agents, /all the waiting of the run one budget|the ONE budget a run spends on waiting out a throttled service/, 'AGENTS.md says the budget bounds all the waiting of a run');
  assert.match(agents, /at most six sends in all, and `dispose\(\)` ends a wait that is under way\. \*\*A change set the service refuses as a whole is answered HTTP 200 with the one part that failed\*\*/);
  assert.match(agents, /when every part is one 400, 403 or 404 the change set is a known refusal and is sent \*\*once\*\*, create and update/);
  assert.match(agents, /A mix of statuses, an answer cut off or incomplete inside, a 409 or 412 \(the ids of an earlier send that landed\) and a 500 prove nothing about the change set and stay unknown outcomes/);
  assert.match(agents, /A \*\*resumed\*\* create is not sent again this way/);
  assert.match(agents, /alone among the errors a page write raises — \*\*without\*\* `transient: false` \(`throttledError`\), carrying `statusCode: 429` and what the last answer asked \(`retryAfterMs`, and `retryNotBefore`: the moment before which nothing may be sent\), so the build runs the phase again/);
  assert.match(agents, /\*\*waits for what the service asked, not for its own shorter backoff\*\*/);
  assert.match(agents, /the build stops with `throttle-budget-exhausted` — a transient halt that says the service asked to wait N seconds and that a later run continues\. A wait of more than five seconds is announced on stderr/);
  assert.match(agents, /A 502, 503 or 504 is not waited out as a throttle: an intermediary answered, so the write may have committed and it is \*unknown\*/);
  assert.match(agents, /A write that was throttled and then taken says so in the `warnings` of its result \(which the build prints with the page's name\)/);
  // Every other error is final for the build's own retry of a halt that reads as transient — the page's name and the service's words are what that retry reads.
  assert.match(agents, /\*\*Every other page-write error carries `transient: false`\*\*/);
  assert.match(agents, /so without the marker a re-run would send a write again\./);
  assert.match(agents, /A \*publish\* that fails after a write is not an error: it is returned \(`publish\.kind: 'failed'`\) with the page's id, because the caller must still record that the page exists\./);
  assert.match(agents, /halts on it as `pages-publish-failed` \(re-runnable: the page is reused and published, not written again\)/);
  // The retired claims are in none of the places that could carry them, nor in the backend's own comments.
  for (const [name, text] of [['AGENTS.md', agents], ['lib/genpage-sdk.js', squash(fs.readFileSync(path.join(PLUGIN, 'scripts', 'lib', 'genpage-sdk.js'), 'utf8'))]]) {
    assert.doesNotMatch(text, /cannot create anything|So it is retried\.|a time out is retried once, and so is an \*\*update\*\*/i, `${name} still says a second send of an update is harmless`);
    assert.doesNotMatch(text, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS|time-bounded|runPac/, `${name} still describes the pac wrapper's time limits`);
  }
});

// The build's retry decides from the structure of a failure, and a SQL deadlock victim is the one condition that structure names in two places: the generic SQL error code every SQL failure carries, and the platform's signature in the
// service's own answer. lib/retry-policy.js has the rule and scripts/tests/retry-policy.test.js and halt-retry-policy.test.js run it, with the real SDK and the real retry loop; this pins that the plugin's guide says it, and no longer says it is not run again.
test('AGENTS.md says a SQL deadlock victim is run again by the build — the generic SQL error code and the platform\'s signature in the service\'s own answer, never either alone — and no longer says it is final', () => {
  const agents = squash(readDoc(path.join(PLUGIN, 'AGENTS.md')));
  assert.match(agents, /The SQL deadlock victim a service answers with a 500 is run again, narrowly \(`isDeadlockVictimAnswer`\): its code, `0x80044150`, is the generic SQL error every SQL failure carries, so it takes that code — read from the `error\.code` of the answer's body, never from text — AND the platform's deadlock signature \(`Sql Number: 1205`, the HTTP client's `SQL_DEADLOCK_VICTIM`\) in the service's own answer, which is what follows the url in the SDK's message, so a name the maker put in the url is not read\./);
  assert.match(agents, /The code beside another SQL number \(a constraint, a lock timeout\) and the signature with no such code — a 500 whose words only quote it, a display name that reads as one — stay final, and a deadlock victim is counted as any transient failure is: the build runs the phase again up to three times\./);
  assert.match(agents, /The number that counts is the LAST one the answer gives: the platform writes its own diagnostic after the SQL text, and the SQL text can quote what a maker named \(a duplicate key quotes the value that collided\), so a name spelled `Sql Number: 1205` in front of a unique-key violation \(2627\) is not a deadlock, and one that quotes another number in front of the platform's 1205 does not hide one — the same pattern is the HTTP client's own signature for its deadlock re-sends\./);
  assert.match(agents, /a SQL deadlock victim \(the generic SQL error code `0x80044150` AND the platform's `Sql Number: 1205` — the last SQL number the answer gives — in the service's own answer, `isDeadlockVictimAnswer`\)/);
  assert.doesNotMatch(agents, /deadlock victim[^.]*is therefore final for the build/, 'AGENTS.md says a deadlock victim is final for the build');
  const policy = squash(fs.readFileSync(path.join(PLUGIN, 'scripts', 'lib', 'retry-policy.js'), 'utf8'));
  assert.doesNotMatch(policy, /NOT here, on purpose: the SQL deadlock victim/, 'lib/retry-policy.js still says a deadlock victim is not recovered');
});

// What the /genpage skill tells the agent to do when a page write cannot say what it did. The page is written through the SDK (lib/genpage-sdk.js), so there is no pac process to stall,
// no time limit of its own and no `pac model genpage upload` to compose: the advice follows what the backend reports (`outcome`, `pageId`, `code`) — AGENTS.md has the behaviour,
// scripts/tests/genpage-sdk.test.js and genpage-upload.test.js run it, and this pins that the skill says it.
test('the genpage skill gives the advice for a page write whose answer was lost, in the backend\'s own terms', () => {
  const skill = squash(readDoc(path.join(PLUGIN, 'skills', 'genpage', 'SKILL.md')));
  assert.match(skill, /\*\*A write whose answer was lost is never sent again blindly\.\*\* `genpage-upload\.js` writes a page as one atomic change set, so a write either landed whole or wrote nothing\./);
  assert.match(skill, /sends a create at most once more, under the same id — so no second page can exist\./);
  assert.match(skill, /exit 1 and a JSON object with `error`, the page's `pageId` once the write got as far as the send, `outcome` and the SDK's `code`\. Follow the message; do not simply re-run the command\./);
  assert.match(skill, /\*\*`"outcome": "nothing"`\*\* — nothing was written \(the SDK refused before it sent anything, or the service rejected the whole change set\): fix what the message names and run the command again\./);
  // An update that may have landed is compared with the file first, through the base marker.
  assert.match(skill, /\*\*An update with `"outcome": "unknown"`\*\* "MAY HAVE LANDED" and is not sent again\. Compare the deployed page with your file first: `node "\$\{PLUGIN_ROOT\}\/scripts\/genpage-base\.js" check --env '<org-url>' --app-id '<app-id>' --page-id '<page-id>' --file '<working-dir>\/<file>\.tsx'`/);
  assert.match(skill, /`"contentSame": true` means the update landed: do not upload it again/);
  assert.match(skill, /`"deployed": "unchanged"` means it did not land, and re-running the update is safe\./);
  // A create that may have landed is looked for by its id before it is made again: a second run would mint a second page.
  assert.match(skill, /\*\*A create with `"outcome": "unknown"`\*\* is an \*uncertain\* create: its message says to look for the page by its `pageId` before creating it again, and it is never run again until that is done — a second run mints a second page\./);
  assert.match(skill, /An update of a page that is not in the app's navigation is refused, and a second create makes a duplicate — so neither is the way on while the page is unaccounted for\./);
  // A create that wrote the page and could not publish or place it is finished by the same command with --page-id, never created twice.
  assert.match(skill, /\*\*A create that did not finish\.\*\* A create reports `ok: false` \*\*with the page's `pageId`\*\* when the page was written but its publish failed, or — with `--add-to-sitemap` — when it could not be placed in the app\./);
  assert.match(skill, /Run the \*\*same command again with `--page-id '<page-id>'` added\*\* and nothing else changed \(keep `--add-to-sitemap` if it was given\): that publishes the page and places it, without the check of the app's navigation an ordinary update makes — for that page only/);
  assert.match(skill, /Never create the page a second time\./);
  assert.match(skill, /`--add-to-sitemap` is \*\*refused\*\* together with `--page-id` — an update cannot add a sitemap entry, and the page it names is already placed\. The one exception is finishing a page this script created and did not finish/);
  // What the pac wrapper's advice said is gone with the wrapper: its time limits, its two-step page write, the `Page ID` it printed, and the rules about names it stored.
  assert.doesNotMatch(skill, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS|A pac call that stalls|pac can fail while publishing|pac writes the page|after pac had printed a `Page ID`|created as `<page-id>`/i, 'the genpage skill still describes the pac upload that stalled');
  assert.doesNotMatch(skill, /cannot create anything|So it is retried\.|a time out is retried once, and so is an \*\*update\*\*/i, 'the genpage skill still says a second send of an update is harmless');
  assert.doesNotMatch(skill, /pac\.cmd|pac stores each one|upload --help|requires a pac build|PowerPlatform-Scale-AdminTools/, 'the genpage skill still carries a rule of the pac upload');
});

// Measured against the SDK's page compile (genpage-sdk-real-bundle.test.js, "the compile is a transpile"): the compile the upload runs — TypeScript's `transpileModule`, in the bundled SDK —
// accepted a `string` assigned to a `number` and a selected column that does not exist, and wrote JavaScript. It refuses only a page that does not parse, has no default export or imports a value
// from RuntimeTypes that it does not hold. So no instruction may present the compile as a type check — a worker that believes it is one ships unchecked types with false confidence — and the
// page-builder, the one place that explains the compile, must say what it is not.
//
// The claim can be worded many ways ("to type-check the page", "a clean compile means it is
// type-safe", "catches type errors", "fails on type errors", "type errors are caught during
// compilation"), and one exact phrase in four files would miss all of them. So
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
// Who a claim can belong to: `t` the compile — transpiling or compiling, whatever the document calls the step the upload runs — `x` a checker the reader
// runs itself — named, or a generic "type-check script" — and `r` the reader.
const ACTOR = new RegExp([
  String.raw`(?<t>transpil\w*|\bcompil(?:e|es|ed|ing|ation)\b)`,
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
    'Run the compile to type-check the page before deploy.',
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
    'Type-check the page with the compile.',
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
    'The compile exits non-zero on type errors.',
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
    // The step the upload runs is the compile, whatever a document calls it: the same claims about it are the same guarantee.
    'A clean compile means the page is type-safe.',
    'The compile step fails on type errors.',
    'Type errors are caught during compilation.',
    'Compilation validates the types of every prop.',
    'The SDK compile type-checks the page.',
    'Run the compile. It type-checks the page.',
  ]) {
    assert.ok(transpileTypeClaims(claim).length > 0, `must be caught: ${claim}`);
  }
  for (const fine of [
    'The compile only transpiles the page: it does not type-check it.',
    'A clean transpile is not proof that the types are correct.',
    'A clean transpile is therefore no proof that the page is type-safe.',
    'A transpile that succeeds does not mean the page is type-safe.',
    'Transpile never type-checks.',
    'Transpile cannot type-check.',
    'It passes TypeScript and the compile, then logs a runtime error.',
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
    'The compile exits 0 even with type errors.',
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
    'The compile only transpiles the page: a type error still compiles and writes JavaScript.',
    '- Transpile the page.\n- It does not type-check it.',
    // A sentence that continues with something other than `it` making the claim is about something else.
    'The compile only transpiles the page. That is what the type check in Step 5 is for.',
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
    // The compile is a transpile: it parses the page, and says so when it does not check its types.
    'A clean compile is no proof that the page is type-safe.',
    'The compile does not type-check the page; run `tsc` for that.',
    'The upload compiles the page and refuses one that does not parse; it does not type-check it.',
    'Compile the page, then type-check separately with `tsc`.',
    'After compiling, the page is type-checked by `tsc`.',
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

test('no genpage instruction presents the compile or the transpile as a type check — and the page-builder says what the upload\'s compile is', () => {
  for (const file of mdFiles()) {
    assert.deepEqual(transpileTypeClaims(readDoc(file)), [], `${rel(file)} must not present the compile as a type check`);
  }
  // The point the page-builder's Step 2.6 makes: the upload's compile (TypeScript's `transpileModule` in the bundled SDK) is a transpile, a clean one is no proof the page is type-safe,
  // and the Griffel shorthands still compile. genpage-sdk-real-bundle.test.js runs the real compile on a page with type errors, so a re-vendored SDK that began to type-check fails there first.
  const builder = squash(readDoc(path.join(PLUGIN, 'agents', 'genpage-page-builder.md')));
  assert.match(builder, /The upload compiles the page with the TypeScript the bundled SDK carries, and that compile is a transpile \(`transpileModule`\), not a type check: it refuses a page that does not parse or has no default export, but a type error, or a reference to a column that does not exist, still compiles and writes JavaScript, and it does not execute `makeStyles`\./, 'the page-builder must say the upload\'s compile is a transpile, not a type check');
  assert.match(builder, /A clean compile is therefore no proof that the page is type-safe, and unsupported Griffel shorthands can compile and then log runtime errors in the browser\./, 'and that a clean compile does not mean the page is type-safe');
  // No instruction still names the pac verb whose place the upload's compile took.
  for (const file of mdFiles()) assert.doesNotMatch(readDoc(file), /genpage\s+transpile/, `${rel(file)} still names the pac transpile`);
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
