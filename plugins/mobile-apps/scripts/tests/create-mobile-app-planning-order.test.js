'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readSkillWorkflow } = require('./helpers/workflow-documents');

const pluginRoot = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
const phase = name => read(`skills/create-mobile-app/references/${name}.md`);
const createSkill = readSkillWorkflow('create-mobile-app');
const entry = read('skills/create-mobile-app/SKILL.md');
const intake = phase('phase-01-intake');
const planning = phase('phase-02-planning');
const data = phase('phase-06-data');
const planner = read('agents/native-app-planner.md');
const architect = read('agents/data-model-architect.md');
const screenPlanner = read('agents/screen-planner.md');
const screenBuilder = read('agents/screen-builder.md');
const screenContract = read('shared/references/screen-planning/spec-contract.md');

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

function inOrder(source, ...markers) {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    assert.ok(index > previous, `missing or out-of-order planning boundary: ${marker}`);
    previous = index;
  }
}

// These contracts follow ownership across the phased workflow, not the retired
// monolithic planner's headings or child-owned approval/fallback implementation.
test('planning contracts contain no unresolved merge markers', () => {
  for (const source of [createSkill, planner, architect, screenPlanner, screenBuilder]) {
    assert.doesNotMatch(source, /^(?:<{7}|={7}|>{7})(?: |$)/m);
  }
});

test('connectivity wording is owned by the post-materialization offline flow', () => {
  const classification = section(intake, 'Infer a **provisional**', '### Step 2c');
  assert.match(classification, /connectivity-intent-ownership\.md/);
  assert.match(classification, /offline wording is operating context, not a reason to select Dataverse/);
  assert.doesNotMatch(classification, /Dataverse offline data/);
  for (const file of [
    'agents/native-app-planner.md',
    'agents/data-model-architect.md',
    'agents/screen-planner.md',
    'agents/screen-builder.md',
    'agents/references/screen-builder/native.md',
    'skills/create-mobile-app/references/requirements-discovery.md',
    'shared/references/screen-planning/spec-contract.md',
    'shared/references/universal-patterns/recipes.md',
  ]) assert.match(read(file), /connectivity-intent-ownership\.md/, file);

  const ownership = read('shared/references/connectivity-intent-ownership.md');
  assert.match(ownership, /offline-first[\s\S]*limited or[\s\S]*intermittent connectivity[\s\S]*no connectivity/);
  assert.match(ownership, /operating\s+context only/);
  assert.match(ownership, /must not add offline-specific business tables[\s\S]*services[\s\S]*stores[\s\S]*routes[\s\S]*screens/);
  assert.match(ownership, /power-apps-native-host[\s\S]*local SQLite[\s\S]*status overlay/);
  const templatePackage = JSON.parse(read('template/package.json'));
  assert.equal(typeof templatePackage.dependencies['@microsoft/power-apps-native-offline'], 'string');
  assert.match(read('shared/references/universal-patterns/recipes.md'),
    /approved product requirement.*app-owned sync queue/is);
  assert.doesNotMatch(read('skills/create-mobile-app/references/requirements-discovery.md'),
    /Camera capability \+ image column/);
});

test('the wizard targets iOS and Android without asking a platform question', () => {
  const requirements = section(intake, '### Step 2 — Gather requirements', '### Step 2b');
  assert.doesNotMatch(requirements, /\| Target platforms \|/);
  assert.match(requirements, /<target_platforms> = "ios, android"/);
  assert.match(requirements, /do not ask an iOS\/Android platform\s+question/);
  assert.match(requirements, /Preserve explicit target constraints/);
});

test('data platform and integrations are approved before Dataverse modeling', () => {
  const classification = section(intake, 'Infer a **provisional**', '### Step 2c');
  assert.match(classification, /`connector-only` only if \*\*every record source\/write target\*\* is an explicit non-Dataverse/);
  assert.match(classification, /no app-owned Dataverse rows, retained Dataverse File\/Image artifacts,\s+existing Dataverse tables, or Dataverse-backed native capabilities/);
  assert.match(classification, /`required` otherwise, including ambiguity/);
  assert.match(classification, /confirmed mode may differ from this provisional recommendation/);
  inOrder(planning, '## 3.0 — Experience', '## 3.1 — Architecture proposal',
    '### Gate 1 — Data platform', '## 3.2 — Verified data evidence',
    'execute deferred Step 1.7', '[planning-snapshot.md]',
    'Dispatch `mobile-app:data-model-architect`', '**Gate 2 — Data model',
    '**Gate 3 — Screen graph', '**Gate 4 — Screen specs');
  assert.doesNotMatch(createSkill, /\*\*Question header:\*\* `Data platform`/);
  assert.match(planning, /No publisher discovery, Dataverse snapshot or data-model-architect dispatch occurs before Gate 1/);
  const architectureGate = section(planning, '### Gate 1 — Data platform', '## 3.2');
  assert.match(architectureGate, /matrices including `None`/);
  assert.match(architectureGate, /Empty matrices are not self-approval/);
  assert.match(architectureGate, /actual approval timestamps[\s\S]*native-app-plan\.md[\s\S]*## Approvals/);
  assert.match(planning, /For Gate 1-approved `required`[\s\S]*For approved `connector-only`, skip prefix discovery,\s+snapshot and data-model-architect entirely/);
  assert.match(planning, /zero-table\/no-Dataverse[\s\S]*No Dataverse schema contract or receipt/);
  assert.match(planning, /Approved native capabilities:[\s\S]*Approved connectors:/);
  assert.match(architect, /approved native capabilities/i);
  assert.match(architect, /approved connectors/i);
  assert.match(architect, /Do not create a Dataverse duplicate of a connector-owned entity/);
  assert.match(architect, /BLOCKED: This step only applies when Dataverse is selected/);
  assert.match(intake, /Execute only after Step 3 Gate 1 approves[\s\S]*mode `required`/);
  assert.match(phase('planning-snapshot'), /Gate 1 approves required Dataverse planning/);
  assert.match(phase('planning-snapshot'), /Connector-only runs skip all commands/);
  assert.doesNotMatch(`${createSkill}\n${planner}\n${architect}\n${screenPlanner}`, /Gate 4a|Gate 4b/);
});

test('screen specs stay inside Screens before the canonical Approvals section', () => {
  const skeleton = section(planning, 'Foreground assembles the human plan skeleton',
    'Use the host');
  inOrder(skeleton, '`## Screens`', '`## Approvals`');
  assert.doesNotMatch(skeleton, /## Approval Status/);
  assert.match(screenPlanner, /Update specs within `## Screens`, before the next level-two section/);
  assert.match(screenContract, /everything outside the assigned section unchanged/);
});

test('deferred design does not create an extra industry question', () => {
  assert.match(intake, /design_vibe_opt_in: deferred[\s\S]*design_vibe_opt_in: skip/);
  assert.match(planning, /Brand selection is deferred to Step 6\.75/);
  assert.match(planner, /foreground `\/design-system` phase owns brand inputs/);
  assert.match(planner, /No style picker or legacy early-return\s+signal/);
  assert.match(planner, /industry:<options and reason>` if it\s+changes workflow assumptions; otherwise flag provisional inference/);
  assert.doesNotMatch(planner, /design is reviewed visually at Gate 4/i);
});

test('preview preferences defer visual rendering until the post-scaffold design phase', () => {
  assert.match(intake, /visual_companion: yes[\s\S]*design_vibe_opt_in: deferred/);
  assert.match(intake, /`--no-design`[\s\S]*visual_companion: no[\s\S]*design_vibe_opt_in: skip/);
  assert.match(planning, /Both screen phases use `skip_preview: true`/);
  assert.match(planning, /no plan-time browser open[\s\S]*requirement to render before Gate 4/);
  assert.match(screenPlanner, /`skip_preview: true`: no HTML/);
  assert.match(entry, /\| Anything else \| `BLOCKED: malformed agent return`/);
  assert.doesNotMatch(planning, /(?:open "|xdg-open|Start-Process|PLAN_PREVIEW_PATH:)/);
  const design = phase('phase-04-design');
  assert.match(design, /after the scaffold TypeScript gate/);
  assert.match(design, /`\/design-system` is the sole owner[\s\S]*design preview/);
  assert.match(design, /`--no-design`[\s\S]*skip this phase \(including visual preview\)/);
  assert.match(design, /preview_mode: intent/);
  assert.match(design, /Honor `visual_companion` for opening,\s+including browser opt-out/);
  assert.doesNotMatch(design, /Step 6\.85|every path through the flow gets at least one visual preview/);
});

test('offline completion summary reflects the bundled native host runtime', () => {
  const summary = section(readSkillWorkflow('setup-offline-profile'),
    '### Step 10 — Summary', '## Status code');
  assert.match(summary, /@microsoft\/power-apps-native-host[\s\S]*consumes the profile/);
  assert.match(summary, /SQLite[\s\S]*queued synchronization[\s\S]*reconnect[\s\S]*status/);
  assert.doesNotMatch(summary, /does not yet consume|Native runtime support remains deferred/i);
});

test('inline fallback preserves architecture-first conditional modeling through the same leaf contract', () => {
  assert.match(entry, /read that\s+leaf agent's contract and execute the same bounded work in foreground/);
  assert.match(entry, /never approvals, outputs, evidence or quality gates/);
  assert.match(planning, /if agent tooling is unavailable, execute that same leaf contract here/);
  assert.match(planning, /No no-op probes, second fallback workflow, or skipped approvals/);
  assert.match(planning, /foreground owns this check even without agent tooling/);
  assert.match(planning, /approved `connector-only`, skip prefix discovery,\s+snapshot and data-model-architect entirely/);
  assert.match(planning, /Dispatch `mobile-app:data-model-architect` directly in required mode/);
  assert.match(planning, /Approved native capabilities:[\s\S]*Approved connectors:/);
  assert.doesNotMatch(`${createSkill}\n${planner}`, /approved-architecture\.md|Architecture phase: gate-only/);
});

test('foreground screen planning persists the approved graph before requesting specs', () => {
  inOrder(planning, 'Foreground assembles the human plan skeleton',
    '**Gate 3 — Screen graph', '**Gate 4 — Screen specs');
  assert.match(planning, /Gate 3 — Screen graph[\s\S]*embed its section[\s\S]*before specs/);
  assert.match(planning, /Foreground reviews\/embeds that graph into `plan_path` before dispatching specs/);
  assert.match(planning, /plan_path: <working_dir>\/native-app-plan\.md/);
  assert.match(planning, /Both screen phases use `skip_preview: true`/);
  assert.match(planning, /Missing, malformed, stale or contradictory approval returns to Gate 1/);
});

test('screen specs use the canonical plan and never rewrite graph scratch', () => {
  const dispatch = section(planning, '## 3.3', '## 3.4');
  assert.match(dispatch, /plan_path: <working_dir>\/native-app-plan\.md/);
  assert.match(dispatch, /For `phase: specs`, read the locked `## Screens` in `plan_path`, not graph scratch/);
  assert.match(dispatch, /specs only in `plan_path` \(never `_screens_section\.md`\)/);
  assert.match(screenPlanner, /Specs never writes `_screens_section\.md`/);
  assert.match(screenPlanner, /approved graph, IDs, journeys, preview selection, routes, and conventions are immutable/);
});

test('screen completeness repair belongs to graph planning before approval', () => {
  assert.match(screenPlanner, /scope\/consolidation review[\s\S]*before graph approval/);
  assert.match(screenContract, /Before Gate 3[\s\S]*preserves every approved job/);
  assert.match(screenContract, /Every journey still has its entry, action, outcome/);
  assert.match(screenPlanner, /spec-contract\.md#spec-writes/);
  assert.match(screenContract, /Check missing graph\s+context before any specs write/);
  assert.match(screenContract, /return to foreground for Gate 3 rather than repairing routes here/);
  assert.match(screenPlanner, /NEEDS_CONTEXT: graph revision required/);
  assert.match(planning, /scope\/consolidation review[\s\S]*before returning the graph/);
  assert.match(planning, /Every approved job must remain covered/);
});

test('missing screen graph context returns to approval instead of retrying specs', () => {
  const dispatch = section(planning, '## 3.3', '## 3.4');
  assert.match(dispatch, /NEEDS_CONTEXT: graph missing[\s\S]*NEEDS_CONTEXT: graph revision required[\s\S]*before a\s+generic specs retry/);
  assert.match(dispatch, /return to graph planning and explicit Gate 3 approval, then regenerate specs/);
  assert.match(planning, /Gate 4 rejection reruns specs only\. Structural changes return to Gate 3/);
});

test('screen specs retries replace owned sections without changing the approved graph', () => {
  assert.match(screenPlanner, /spec-contract\.md#spec-writes/);
  const write = section(screenContract, '## Spec writes', '## Graph fields');
  assert.match(write, /Replace all prior copies of the phase-owned/);
  for (const heading of ['Per-Screen Specs', 'Open Questions', 'Open Questions for the User',
    'JavaScript Dependencies']) {
    assert.ok(write.includes(`### ${heading}`), `missing owned subsection: ${heading}`);
  }
  assert.match(write, /in one edit/);
  assert.match(write, /Remove an optional owned subsection if the replacement omits it/);
  assert.match(write, /at most one current copy/);
  assert.match(write, /(?:remove|replace)[\s\S]*### Screen Graph/i);
  assert.match(write, /Keep graph fields and everything outside the assigned section unchanged/);
  assert.match(screenPlanner, /no duplicate Screen Graph table/);
  assert.match(screenPlanner, /Write once/);
  assert.doesNotMatch(screenPlanner, /Then append the markdown block|only the append into `plan_path` is allowed/);
});

test('architecture approval is validated before discovery or generic missing-context retries', () => {
  const gate = section(planning, '### Gate 1 — Data platform', '## 3.2');
  assert.match(gate, /confirmed `required`\/`connector-only` mode/);
  assert.match(gate, /actual approval timestamps[\s\S]*## Approvals/);
  assert.match(gate, /Do not create an architecture sidecar or a Dataverse receipt before a schema exists/);
  assert.match(gate, /Validate these recorded decisions before discovery and architect dispatch, including on resume/);
  assert.match(gate, /Missing, malformed, stale or contradictory approval returns to Gate 1, not a generic worker\s+retry/);
  assert.match(gate, /or a silent fallback to required mode/);
  assert.match(gate, /Changed architecture invalidates dependent model,\s+graph\/spec and receipt approvals/);
  assert.match(phase('planning-snapshot'), /Verify the accepted architecture and mode in the human plan first/);
  assert.match(phase('planning-snapshot'), /returns to Gate 1 before discovery, even on resume/);
});

test('planner permissions allow only bounded proposals and keep schema and receipts with their owners', () => {
  assert.doesNotMatch(planner.split('---')[1], /AskUserQuestion|EnterPlanMode|ExitPlanMode|Task/);
  assert.match(planner, /Write only that proposal file/);
  for (const artifact of ['native-app-plan.md', '_dm_section.md', '_screens_section.md',
    'memory-bank.md', '.tmp/mobile-plan-status.json']) {
    assert.ok(section(planner, 'Do not edit', 'Return the output path').includes(artifact));
  }
  assert.match(planner, /You cannot mark a gate approved or write an approval receipt/);
  assert.match(planner, /No interactive tools, nested agents[\s\S]*application source writes/);
  assert.match(architect, /--normalize-contract/);
  assert.match(planning, /normalize the structured schema contract per your agent contract/);
  const receipt = phase('approval-receipt');
  assert.match(receipt, /only at explicit Gate 2 user acceptance/);
  assert.match(receipt, /schemaVersion: 1/);
  assert.match(receipt, /Copy `nativeCapabilities` and `connectors`[\s\S]*original Gate 1 timestamps[\s\S]*decisions are unchanged/);
  assert.match(receipt, /never\s+synthesize it from model acceptance/);
  assert.match(receipt, /Gate 3 acceptance[\s\S]*`screenPlan` remains pending until Gate 4/);
  assert.match(receipt, /Children and Step 8 cannot create, repair or\s+restamp it/);
});

test('post-specs audit reads the canonical plan and routes data addenda to Gate 2', () => {
  const audit = section(planning, '## 3.4', 'Only after these checks');
  assert.match(audit, /before Gate 4 acceptance/);
  assert.match(audit, /plan_path: <working_dir>\/native-app-plan\.md/);
  assert.match(audit, /not graph scratch/);
  assert.match(audit, /Connector-only, local and auth-only screens are included/);
  assert.match(audit, /mode: screen-data-audit/);
  assert.match(architect, /cross-entity-audit` is a compatibility alias/);
  assert.match(architect, /owning gate \(Gate 2 for Dataverse model addenda\)/);
  assert.match(architect, /Never\s+read `_screens_section.md` in preference to it or fall back/);
  assert.doesNotMatch(architect, /addendum to Gate 1|Gate 1 view/);
});

test('architecture revalidates storage and native dependencies without silently dropping requirements', () => {
  const gate = section(planning, '### Gate 1 — Data platform', '## 3.2');
  assert.match(gate, /Before acceptance and whenever a platform, connector or storage choice changes, revalidate\s+every native capability/);
  assert.match(gate, /supported upload\/write operation, not just a connector name/);
  assert.match(gate, /Dataverse File\/Image host controls require Dataverse/);
  assert.match(gate, /Continuous `geolocation` requires\s+its supported Dataverse target/);
  assert.match(gate, /one-shot `location` is not an automatic replacement/);
  assert.match(gate, /Do not silently remove capabilities/);
  inOrder(gate, 'before acceptance', 'Record the accepted data platform');
  assert.match(planner, /approved connector-owned storage\s+with a supported upload\/write operation/);
  assert.match(planner, /connector name alone is\s+not a storage implementation/i);
  assert.match(planner, /Dataverse File\/Image host controls still require Dataverse/);
  assert.match(planner, /Revalidate capability\/storage compatibility whenever the platform or connector choice changes/);
  assert.match(planner, /Return conflicts to foreground before Gate 1 acceptance/);
  assert.doesNotMatch(planner, /missing Dataverse storage for a persisted artifact/);
});

test('architecture owns connector confirmation without changing the shared standalone workflow', () => {
  const connectors = section(planner, '## Connector proposals', '## Provisional design context');
  assert.match(connectors, /not its interactive confirmation step/);
  assert.match(connectors, /foreground[\s\S]*gate confirms, adds or removes connectors/);
  const gate = section(planning, '### Gate 1 — Data platform', '## 3.2');
  assert.match(gate, /capability\/connector\s+matrices including `None`/);
  const shared = read('shared/references/connector-planning.md');
  assert.match(shared, /## Step 2 — Present to User for Confirmation/);
  assert.match(shared, /present using `AskUserQuestion`/);
});

test('reuse-only apps retain a verified materialized inventory without replaying schema writes', () => {
  const addDataverse = readSkillWorkflow('add-dataverse');
  const verification = section(addDataverse, '### Step 6c — Verify tables exist', '### Step 6d — Write');
  const materialized = section(addDataverse, '### Step 6d — Write', '### Step 7 — Inspect generated files');
  assert.match(verification, /every table in `SERVICE_REQUIRED_TABLES`, including reused-as-is tables/);
  assert.match(materialized, /reuse-only app must still have a populated manifest/);
  assert.match(materialized, /Include every service-required table[\s\S]*status: "reused"/);
  assert.match(materialized, /Exclude deferred or unverified tables/);
  assert.match(materialized, /not by replaying successful schema writes/);
  assert.match(materialized, /standard-system-table exclusions still apply/);
  assert.doesNotMatch(materialized, /Do NOT include tables reused/);
  const seeding = section(data, '### Step 8.5', '### Step 6.85');
  inOrder(seeding, 'service.requiredTables',
    'OPERATION_MANIFEST="<working_dir>/.tmp/dataverse-operation-manifest.json"',
    'verify-dataverse-services.js',
    'Rebuild the local manifest', 'Invoke `/add-sample-data');
  assert.match(seeding, /Zero schema writes is a valid reuse-only\s+result/);
  assert.match(seeding, /Step 6's read-only service verifier and Steps 6c–6d/);
  assert.match(seeding, /manifest belongs to the current approved plan, schema and environment/);
  assert.match(seeding, /missing or stale operation manifest returns to reconciliation/);
  assert.match(seeding, /without replaying successful metadata\s+writes or republishing/);
  assert.match(seeding, /do not run the whole mutating skill again/);
  assert.match(seeding, /Recheck coverage and services/);
  assert.match(data, /Step 8 already succeeded[\s\S]*read-only inventory\/service recovery instead of replaying/);
  const offline = data.slice(data.indexOf('### Step 6.85'));
  assert.match(offline, /including reused tables[\s\S]*all service-required names/);
  assert.match(offline, /read-only manifest recovery in Step 8\.5/);
});

test('offline profile opt-in runs after Dataverse materialization and before native wiring', () => {
  inOrder(data, '### Step 8 — Apply data model', '### Step 8.5 — Seed sample data',
    '### Step 6.85 — Offline profile');
  inOrder(createSkill, '### Step 8.5 — Seed sample data', '### Step 6.85 — Offline profile',
    '### Step 9 — Apply native capabilities');
  assert.match(data, /→ \[Offline profile\] Asking whether/i);
  assert.match(data, /manifest is missing, malformed, contains no Dataverse tables or lacks required verified\s+tables after recovery[\s\S]*BLOCKED: Dataverse materialization/);
  assert.match(data, /If verification still fails[\s\S]*BLOCKED: offline setup requires/);
  assert.match(data, /^`BLOCKED: Dataverse materialization did not produce a usable \.datamodel-manifest\.json`$/m);
  assert.match(data, /^`BLOCKED: offline setup requires the materialized Dataverse manifest from Step 8`$/m);
  assert.match(data, /Do not infer\s+connector-only from a missing manifest/);
  assert.match(data, /Do not seed or offer offline setup from\s+unverified names/);
  assert.match(data, /No keyword heuristic may skip the question/);
  assert.match(data, /Continue to Step 9 only after this decision/);
  assert.doesNotMatch(createSkill, /Step 8\.6 — Offline profile/);
});
