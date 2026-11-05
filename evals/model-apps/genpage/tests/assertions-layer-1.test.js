'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  WORKFLOW_ASSERTIONS,
  PHASE_EXPECTATIONS,
  planSection,
  validateGenpagePlanSchema,
  entitiesNeedCreating,
  newAppNeeded,
} = require('../lib/assertions-layer-1.js');

function fix(overrides = {}) {
  return {
    id: 2,
    dirName: '2-test',
    dir: '/fake',
    files: [],
    workflowLog: null,
    genpagePlan: null,
    genpageEditPlan: null,
    entityCreationLog: null,
    ...overrides,
  };
}

function evalStub(id = 2) {
  return { id, tier: 'smoke', prompt: '', data: {}, expectations: [] };
}

function validPlan() {
  return `# Genpage Plan

## User Requirements
Build a simple account page.

## Working Directory
D:\\work\\account-page

## Plugin Root
D:\\repo\\plugins\\model-apps

## Environment
- URL: https://org.crm.dynamics.com
- App: Existing App (app-id)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Account Overview | account-overview.tsx | Show account highlights | account |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
account

## Connector Bindings
No connector bindings.

## Custom API Bindings
No custom API bindings.

## Design Preferences
- Styling: Clean
- Features: Search
- Accessibility: WCAG AA

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Account Overview | 7-responsive-cards.tsx | Responsive cards |

## Per-Page Specifications

### Account Overview
- **File:** account-overview.tsx
- **Purpose:** Show account highlights
- **Entities:** account
- **Needs caching:** true
- **Key Features:** Search and summary cards
- **Components:** Card, Button
- **Layout:** Responsive grid
- **Data Binding:** queryTable("account")
- **Interactions:** Search box filters cards
`;
}

// ---------- helpers ----------

test('planSection extracts text under a heading', () => {
  const plan = `# Genpage Plan
## Environment

- Solution: Default
- Publisher Prefix: new

## Pages
foo
`;
  const env = planSection(plan, 'Environment');
  assert.match(env, /Solution: Default/);
  assert.doesNotMatch(env, /Pages/);
});

test('entitiesNeedCreating returns false on "No entity creation required"', () => {
  const plan = `## Entity Creation Required

No entity creation required — all entities already exist.

## Existing Entities
account
`;
  assert.equal(entitiesNeedCreating(plan), false);
});

test('entitiesNeedCreating returns true when section has content', () => {
  const plan = `## Entity Creation Required

| Table | Suffix |
|-------|--------|
| cr_widget | widget |

## Existing Entities
`;
  assert.equal(entitiesNeedCreating(plan), true);
});

test('newAppNeeded detects "create new app" intent', () => {
  assert.equal(newAppNeeded('plan: create new app'), true);
  assert.equal(newAppNeeded('plan: use existing app'), false);
});

// ---------- plan schema validator ----------

test('validateGenpagePlanSchema: valid canonical plan passes', () => {
  assert.deepEqual(validateGenpagePlanSchema(validPlan()), []);
});

test('Pages-table and per-page filenames agree instead of dispatching to different targets', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): genpage-plan.md is written to the working directory, conforming to references/plan-schema.md');
  const evaluate = (plan) => check({ fixture: fix({ genpagePlan: plan }), eval: evalStub() });
  assert.deepEqual(validateGenpagePlanSchema(validPlan()), []);
  assert.equal(evaluate(validPlan()).status, 'pass');
  for (const file of ['wrong-page.tsx', 'ACCOUNT-OVERVIEW.tsx', '']) {
    const plan = validPlan().replace('- **File:** account-overview.tsx', `- **File:** ${file}`);
    const errors = validateGenpagePlanSchema(plan);
    assert.ok(errors.some((error) => error.code === 'page-file-mismatch' && error.page === 'Account Overview'), JSON.stringify(errors));
    assert.equal(evaluate(plan).status, 'fail', file || '(empty File)');
  }
  const ambiguous = validPlan().replace('- **File:** account-overview.tsx', '- **File:** account-overview.tsx\n- **File:** wrong-page.tsx');
  assert.equal(evaluate(ambiguous).status, 'fail', 'two competing File fields are not an agreed dispatch target');
});

test('validateGenpagePlanSchema: missing each required per-page field fails clearly', () => {
  const requiredFields = [
    'File',
    'Purpose',
    'Entities',
    'Needs caching',
    'Key Features',
    'Components',
    'Layout',
    'Data Binding',
    'Interactions',
  ];

  for (const field of requiredFields) {
    const plan = validPlan().replace(new RegExp(`^- \\*\\*${field}:\\*\\*.*\\n`, 'm'), '');
    const errors = validateGenpagePlanSchema(plan);
    assert.ok(
      errors.some((error) => error.message.includes(`missing required per-page field "${field}"`)),
      `expected missing-field error for ${field}, got ${JSON.stringify(errors)}`
    );
  }
});

// ---------- workflow-log.md present check ----------

test('workflow-log.md present: fail when absent', () => {
  const check = WORKFLOW_ASSERTIONS.get('A workflow-log.md file is saved to the working directory documenting all phases attempted');
  const result = check({ fixture: fix(), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('workflow-log.md present: fail when very short', () => {
  const check = WORKFLOW_ASSERTIONS.get('A workflow-log.md file is saved to the working directory documenting all phases attempted');
  const result = check({ fixture: fix({ workflowLog: 'short' }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('workflow-log.md present: pass when content exceeds threshold', () => {
  const check = WORKFLOW_ASSERTIONS.get('A workflow-log.md file is saved to the working directory documenting all phases attempted');
  const log = '# Workflow Log\n' + 'a'.repeat(100);
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// ---------- Phase 1 prereq checks ----------

test('node --version and pac help: pass when both recorded separately', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): node --version and pac help are run separately (not chained with &&) and PAC CLI version > 2.10.0 is verified');
  const log = `## Phase 1
- node --version → v20
- pac help → PAC CLI Version 2.11.0
`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('node --version and pac help: fail when the recorded version is <= 2.10.0', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): node --version and pac help are run separately (not chained with &&) and PAC CLI version > 2.10.0 is verified');
  const log = `## Phase 1
- node --version → v20
- pac help → PAC CLI Version 2.7.3
`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /2\.10\.0/);
});

test('node --version and pac help: fail when only the node version is present (must not be mistaken for pac)', () => {
  // The node line records v20.x; without a "PAC CLI Version" line there is no valid pac version, so
  // the assertion must NOT pass by grabbing 20.x from `node --version`.
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): node --version and pac help are run separately (not chained with &&) and PAC CLI version > 2.10.0 is verified');
  const log = `## Phase 1
- node --version → v20.11.0
- pac help → (ran, but version not captured)
`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('node --version and pac help: fail when chained with &&', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): node --version and pac help are run separately (not chained with &&) and PAC CLI version > 2.10.0 is verified');
  const log = `node --version && pac help → 2.7.3`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /chained/);
});

test('node --version and pac help: fail when version not verified', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): node --version and pac help are run separately (not chained with &&) and PAC CLI version > 2.10.0 is verified');
  const log = `- node --version\n- pac help`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('unattended create/edit determination passes without AskUserQuestion marker', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): Question 1 (new or edit) is asked via AskUserQuestion');
  const log = `Unattended default: create new or edit existing → create new (--non-interactive flag)`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: validPlan() }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('unattended plan approval passes without attended interaction markers', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): The plan is presented via EnterPlanMode and user approval is requested');
  const log = `Unattended default: plan approval → approved (--non-interactive flag)`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: validPlan() }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('unattended plan approval rejects attended marker text even when phrased as not called', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): The plan is presented via EnterPlanMode and user approval is requested');
  const log = `Unattended default: plan approval → approved (--non-interactive flag)\nEnterPlanMode called → NOT called`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: validPlan() }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// `non-interactive: false` describes an ATTENDED run. Reading `interactive: false` out of the tail
// of that word flipped the whole log to the unattended branch, which then failed it for having no
// `Unattended default:` marker — a real attended run rejected for recording its own mode.
test('an attended log that records the flag as off is not misread as unattended', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): Question 1 (new or edit) is asked via AskUserQuestion');
  const log = `Interaction mode resolved: non-interactive: false\nAskUserQuestion: new or edit → create new`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: validPlan() }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// resolve-interaction-mode.js emits `{"ok":true,"interactive":false,"reason":"..."}`. A log that
// pastes that line is reporting an unattended run, so the QUOTED JSON key must register the same as
// the prose form. Isolation matters here: the probe line carries no `reason` and no
// `Unattended default:` marker, and the plan DOES need metadata work — so the attended branch would
// PASS this log (metadata required + question asked). Only the unattended branch can fail it, which
// makes the assertion sensitive to the quoted-key match and nothing else.
test('the resolver JSON line marks the log unattended, so an interactive question is a failure', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): The solution selection question is asked via AskUserQuestion ONLY when the build needs metadata work (new entities OR new app); for code-only flows the question is skipped but the Default values are still written');
  const plan = `${validPlan()}\n\n## Environment\n- App: create new app\n`;
  const log = `Interaction mode probe returned {"ok":true,"interactive":false}\nAskUserQuestion: which solution? → Default`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// An ATTENDED log legitimately NEGATES the two reason phrases when it explains why it is
// attended. Matching them as bare substrings anywhere in the log flipped such a log to the
// unattended branch, where its (correct) `AskUserQuestion:` line reads as an attended-marker
// violation — a correct run graded broken. The phrases only mean "unattended" in the resolver's
// `reason` field, so they are anchored to it.
test('an attended log that explains the flag was absent is not misread as unattended', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): Question 1 (new or edit) is asked via AskUserQuestion');
  const log = `Interaction mode: attended (no --non-interactive flag, TTY present)\nAskUserQuestion: new or edit → create new`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: validPlan() }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('an attended log that records the env var as unset is not misread as unattended', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): Question 1 (new or edit) is asked via AskUserQuestion');
  const log = `Checked: POWER_PLATFORM_SKILLS_NONINTERACTIVE is set -> no\nAskUserQuestion: new or edit → create new`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: validPlan() }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// The complement of the two tests above: in the resolver's own `reason` field the same phrase DOES
// mean unattended, so anchoring must not cost us the real signal. Same isolation trick as the
// quoted-JSON test — the plan needs metadata work, so only the unattended branch can fail this.
test('the resolver reason field still marks the log unattended', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): The solution selection question is asked via AskUserQuestion ONLY when the build needs metadata work (new entities OR new app); for code-only flows the question is skipped but the Default values are still written');
  const plan = `${validPlan()}\n\n## Environment\n- App: create new app\n`;
  const log = `Mode: {"ok":true,"reason":"--non-interactive flag"}\nAskUserQuestion: which solution? → Default`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- Solution lines in plan ----------

test('Solution+Publisher lines: pass with list-marker format', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): genpage-plan.md ALWAYS contains \'Solution:\' and \'Publisher Prefix:\' lines in ## Environment; default fallback is \'Solution: Default\' + \'Publisher Prefix: new\' for code-only flows');
  const plan = `## Environment

- Solution: Default
- Publisher Prefix: new

## Pages
`;
  const result = check({ fixture: fix({ genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Solution+Publisher lines: pass with bare format', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): genpage-plan.md ALWAYS contains \'Solution:\' and \'Publisher Prefix:\' lines in ## Environment; default fallback is \'Solution: Default\' + \'Publisher Prefix: new\' for code-only flows');
  const plan = `## Environment

Solution: Default
Publisher Prefix: new

## Pages
`;
  const result = check({ fixture: fix({ genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Solution+Publisher lines: fail when Solution missing', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): genpage-plan.md ALWAYS contains \'Solution:\' and \'Publisher Prefix:\' lines in ## Environment; default fallback is \'Solution: Default\' + \'Publisher Prefix: new\' for code-only flows');
  const plan = `## Environment\n- Publisher Prefix: new\n## Pages\n`;
  const result = check({ fixture: fix({ genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /Solution/);
});

// ---------- Solution question gating ----------

test('Solution question: pass on code-only flow that did NOT ask', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): The solution selection question is asked via AskUserQuestion ONLY when the build needs metadata work (new entities OR new app); for code-only flows the question is skipped but the Default values are still written');
  const log = `- Build is code-only — solution selection question SKIPPED\n- Wrote Solution: Default, Publisher Prefix: new`;
  const plan = `## Entity Creation Required\nNo entity creation required — all entities already exist.\n`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Solution question: fail on code-only that DID ask', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): The solution selection question is asked via AskUserQuestion ONLY when the build needs metadata work (new entities OR new app); for code-only flows the question is skipped but the Default values are still written');
  const log = `- AskUserQuestion about solution selection asked`;
  const plan = `## Entity Creation Required\nNo entity creation required — all entities already exist.\n`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Solution question: fail on metadata flow that did NOT ask', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): The solution selection question is asked via AskUserQuestion ONLY when the build needs metadata work (new entities OR new app); for code-only flows the question is skipped but the Default values are still written');
  const log = `- Plan written`;
  const plan = `## Entity Creation Required\n\n| Table | Suffix |\n| widget | widget |\n`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- Plan schema check ----------

test('plan-schema: fail when required heading missing', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): genpage-plan.md is written to the working directory, conforming to references/plan-schema.md');
  const plan = `# Genpage Plan\n## User Requirements\nfoo\n`;
  const result = check({ fixture: fix({ genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /## Working Directory/);
});

test('plan-schema: pass when all headings present', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): genpage-plan.md is written to the working directory, conforming to references/plan-schema.md');
  const result = check({ fixture: fix({ genpagePlan: validPlan() }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// ---------- check-auth before entity-builder ----------

test('check-auth gating: skip when no entity work', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 2a: When entities need creating, scripts/check-auth.js runs and returns ok:true before entity-builder is invoked (provision-entities.js, or legacy create-table.js/add-column.js/create-relationship.js/create-record.js); on ok:false the orchestrator surfaces the message to the user and halts');
  const plan = `## Entity Creation Required\nNo entity creation required — all entities already exist.\n`;
  const result = check({ fixture: fix({ workflowLog: 'something', genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'skip');
});

test('check-auth gating: pass when check-auth precedes the first entity script', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 2a: When entities need creating, scripts/check-auth.js runs and returns ok:true before entity-builder is invoked (provision-entities.js, or legacy create-table.js/add-column.js/create-relationship.js/create-record.js); on ok:false the orchestrator surfaces the message to the user and halts');
  const log = `node check-auth.js → ok: true
node create-table.js widget --solution Default`;
  const plan = `## Entity Creation Required\n| Table | Suffix |\n| widget | widget |\n`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('check-auth gating: fail when an entity script runs before check-auth', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 2a: When entities need creating, scripts/check-auth.js runs and returns ok:true before entity-builder is invoked (provision-entities.js, or legacy create-table.js/add-column.js/create-relationship.js/create-record.js); on ok:false the orchestrator surfaces the message to the user and halts');
  const log = `node create-table.js widget --solution Default
node check-auth.js → ok: true`;
  const plan = `## Entity Creation Required\n| Table | Suffix |\n| widget | widget |\n`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('check-auth gating: pass when builder agent name appears before check-auth but no scripts have run yet', () => {
  // This is the meta-list scenario: "## Agents Invoked\n- entity-builder\n##
  // Commands Executed\n- check-auth.js\n- create-table.js". The runner must
  // not treat the agent NAME mention as an actual invocation.
  const check = WORKFLOW_ASSERTIONS.get('Phase 2a: When entities need creating, scripts/check-auth.js runs and returns ok:true before entity-builder is invoked (provision-entities.js, or legacy create-table.js/add-column.js/create-relationship.js/create-record.js); on ok:false the orchestrator surfaces the message to the user and halts');
  const log = `## Agents Invoked
- genpage-entity-builder: invoked per workflow

## Commands
node check-auth.js → ok: true
node create-table.js widget --solution Default`;
  const plan = `## Entity Creation Required\n| Table | Suffix |\n| widget | widget |\n`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('check-auth gating (new flow): pass when check-auth precedes provision-entities.js', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 2a: When entities need creating, scripts/check-auth.js runs and returns ok:true before entity-builder is invoked (provision-entities.js, or legacy create-table.js/add-column.js/create-relationship.js/create-record.js); on ok:false the orchestrator surfaces the message to the user and halts');
  const log = `node check-auth.js → ok: true
node provision-entities.js --env "$ENV_URL" --input @provision-input.json --apply`;
  const plan = `## Entity Creation Required\n| Table | Suffix |\n| widget | widget |\n`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('check-auth gating (new flow): fail when provision-entities.js runs before check-auth', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 2a: When entities need creating, scripts/check-auth.js runs and returns ok:true before entity-builder is invoked (provision-entities.js, or legacy create-table.js/add-column.js/create-relationship.js/create-record.js); on ok:false the orchestrator surfaces the message to the user and halts');
  const log = `node provision-entities.js --env "$ENV_URL" --input @provision-input.json --apply
node check-auth.js → ok: true`;
  const plan = `## Entity Creation Required\n| Table | Suffix |\n| widget | widget |\n`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

const AUTH_GATE = [...WORKFLOW_ASSERTIONS.keys()].find((text) => text.startsWith('Phase 2a: When entities need creating'));

function authFixture(events, overrides = {}) {
  return fix({
    contractVersion: 2,
    manifest: { contractVersion: 2, provenance: 'synthetic' },
    events,
    workflowLog: events.map((event) => `${event.command}\nResult: ok: ${event.result?.ok}\n${JSON.stringify(event.result)}\n${event.userMessage || ''}`).join('\n'),
    genpagePlan: '## Entity Creation Required\n### widget\n',
    ...overrides,
  });
}

function authResult(overrides = {}) {
  return {
    ok: true,
    blocker: null,
    message: 'Ready.',
    warnings: [],
    envUrl: 'https://contoso.crm.dynamics.com',
    identitiesMatch: true,
    whoAmI: { ok: true },
    ...overrides,
  };
}

test('failed auth cannot borrow a later ok result', () => {
  const check = WORKFLOW_ASSERTIONS.get(AUTH_GATE);
  const log = `node check-auth.js --require-pac
Result: {"ok":false,"blocker":"az_timeout","message":"Azure CLI timed out; retry once."}
node provision-entities.js --env https://contoso.crm.dynamics.com --input @input.json --apply
Provisioning result: ok:true`;
  assert.equal(check({
    fixture: fix({ workflowLog: log, genpagePlan: '## Entity Creation Required\n### widget\n' }),
    eval: evalStub(),
  }).status, 'fail');

  const events = [
    { command: 'node check-auth.js --require-pac', result: authResult() },
    { command: 'node provision-entities.js --input @input.json --apply', result: { ok: true } },
  ];
  assert.equal(check({ fixture: authFixture(events), eval: evalStub() }).status, 'pass');

  const captured = fs.readFileSync(path.join(__dirname, '..', 'fixtures', '15-support-tickets-real', 'workflow-log.md'), 'utf8');
  const probe = captured.replace('Result: ok=true, identitiesMatch=true', 'Result: ok=false, blocker=az_timeout')
    + '\nProvisioning result: ok:true\n';
  assert.equal(check({
    fixture: fix({ workflowLog: probe, genpagePlan: '## Entity Creation Required\n### ticket\n' }),
    eval: evalStub(),
  }).status, 'fail');
  assert.equal(check({
    fixture: fix({ workflowLog: captured, genpagePlan: '## Entity Creation Required\n### ticket\n' }),
    eval: evalStub(),
  }).status, 'pass');
});

test('auth gates use the latest applicable result before every mutation', () => {
  const check = WORKFLOW_ASSERTIONS.get(AUTH_GATE);
  const message = 'Azure CLI did not answer within 60 s; retry once or set POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS=120000.';
  const slow = { command: 'node check-auth.js --require-pac', result: authResult({ ok: false, blocker: 'az_timeout', message, whoAmI: null }), userMessage: message };
  const upload = { command: 'node scripts\\genpage-upload.js --page-id 22222222-2222-4222-8222-222222222222', result: { ok: true } };
  const success = { command: 'node check-auth.js --require-pac', result: authResult() };
  assert.equal(check({ fixture: authFixture([success, slow, upload]), eval: evalStub() }).status, 'fail');
  assert.equal(check({ fixture: authFixture([slow, success, upload]), eval: evalStub() }).status, 'pass');
  assert.equal(check({ fixture: authFixture([upload, success]), eval: evalStub() }).status, 'fail');
  assert.equal(check({ fixture: authFixture([slow, slow, slow]), eval: evalStub() }).status, 'fail');
  assert.equal(check({ fixture: authFixture([slow, slow], { workflowLog: `${message}\nHalted; no provisioning or upload.` }), eval: evalStub() }).status, 'pass');
});

test('malformed auth results fail closed rather than authorizing a builder', () => {
  const check = WORKFLOW_ASSERTIONS.get(AUTH_GATE);
  for (const result of [null, [], {}, '{"ok":true,', { ok: 'true' }, authResult({ blocker: 'az_timeout' }), authResult({ whoAmI: { ok: false } }),
    authResult({ message: null }), authResult({ warnings: {} }), authResult({ envUrl: null })]) {
    const events = [
      { command: 'node check-auth.js --require-pac', result },
      { command: 'node provision-entities.js --input @input.json --apply', result: { ok: true } },
    ];
    assert.equal(check({ fixture: authFixture(events), eval: evalStub() }).status, 'fail', JSON.stringify(result));
  }
  const valid = [{ command: 'node check-auth.js --require-pac', result: authResult() }];
  assert.equal(check({ fixture: authFixture(valid), eval: evalStub() }).status, 'pass');
  valid[0].command = 'node check-auth.js';
  assert.equal(check({ fixture: authFixture(valid), eval: evalStub() }).status, 'fail', 'current genpage gates require --require-pac');
});

test('warning-only identity mismatch proceeds only after the warning is surfaced', () => {
  const check = WORKFLOW_ASSERTIONS.get(AUTH_GATE);
  const message = 'Ready, but az and pac use different identities. WhoAmI passed; run az login --username maker@contoso.com if provisioning returns 403.';
  const gate = { command: 'node check-auth.js --require-pac', result: authResult({ identitiesMatch: false, message }), userMessage: message };
  const provision = { command: 'node provision-entities.js --input @input.json --apply', result: { ok: true } };
  assert.equal(check({ fixture: authFixture([gate, provision]), eval: evalStub() }).status, 'pass');
  assert.equal(check({ fixture: authFixture([{ ...gate, userMessage: '' }, provision]), eval: evalStub() }).status, 'fail');
});

test('auth failure distinguishes slow, absent and signed-out CLIs and preserves advice', () => {
  const check = WORKFLOW_ASSERTIONS.get(AUTH_GATE);
  const cases = [
    ['az_timeout', 'Azure CLI did not answer within 60 s; retry once or set POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS=120000.'],
    ['pac_timeout', 'pac org who did not answer within 60 s. Login is unknown, not missing; retry once.'],
    ['az_missing', 'Azure CLI is not installed. Install Azure CLI, then run az login.'],
    ['az_not_logged_in', 'Azure CLI is installed but signed out. Run az login.'],
    ['pac_not_logged_in', 'PAC is signed out. Run pac auth create --environment https://contoso.crm.dynamics.com.'],
  ];
  for (const [blocker, message] of cases) {
    const failed = { command: 'node check-auth.js --require-pac', result: authResult({ ok: false, blocker, message, whoAmI: null }), userMessage: message };
    const attempts = /timeout$/.test(blocker) ? [failed, failed] : [failed];
    const fixture = authFixture(attempts, { workflowLog: `${message}\nHalted; no provisioning or upload.` });
    assert.equal(check({ fixture, eval: evalStub() }).status, 'pass', blocker);
    fixture.events = [...attempts, { command: 'node create-table.js widget --solution Default', result: { ok: true } }];
    assert.equal(check({ fixture, eval: evalStub() }).status, 'fail', `${blocker} must halt`);
    fixture.events = attempts.map((event) => ({ ...event, userMessage: 'Please log in again.' }));
    assert.equal(check({ fixture, eval: evalStub() }).status, 'fail', `${blocker} advice must not be rewritten`);
  }
});

test('associated auth evidence cannot conceal an unrecorded provisioning command', () => {
  const message = 'Azure CLI did not answer within 60 s; retry once or set POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS=120000.';
  const failed = { command: 'node check-auth.js --require-pac', result: authResult({ ok: false, blocker: 'az_timeout', message, whoAmI: null }), userMessage: message };
  const fixture = authFixture([failed, failed], { workflowLog: `${message}\nHalted; no provisioning or upload.` });
  const check = WORKFLOW_ASSERTIONS.get(AUTH_GATE);
  assert.equal(check({ fixture, eval: evalStub() }).status, 'pass');
  fixture.workflowLog += '\nnode provision-entities.js --input @input.json --apply\nResult: ok:true\n';
  assert.equal(check({ fixture, eval: evalStub() }).status, 'fail');
});

test('the latest auth gate must authorize the mutation environment, not another profile', () => {
  const check = WORKFLOW_ASSERTIONS.get(AUTH_GATE);
  const gate = { command: 'node check-auth.js --env https://contoso.crm.dynamics.com --require-pac', result: authResult() };
  const provision = { command: 'node provision-entities.js --env https://contoso.crm.dynamics.com/ --input @input.json --apply', result: { ok: true } };
  assert.equal(check({ fixture: authFixture([gate, provision]), eval: evalStub() }).status, 'pass');
  provision.command = provision.command.replace('contoso.crm', 'contoso-other.crm');
  assert.equal(check({ fixture: authFixture([gate, provision]), eval: evalStub() }).status, 'fail');
});

test('an absent historical auth result cannot borrow a named operation result in the same prose block', () => {
  const check = WORKFLOW_ASSERTIONS.get(AUTH_GATE);
  const plan = '## Entity Creation Required\n### widget\n';
  const command = 'node provision-entities.js --input @input.json --apply';
  for (const log of [
    `node check-auth.js\nProvisioning result: ok:true\n${command}`,
    `node check-auth.js\nResult: {"ok":true,\nProvisioning result: ok:true\n${command}`,
  ]) assert.equal(check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() }).status, 'fail');
  const log = `node check-auth.js\n  - Result: ok:true\n${command}`;
  assert.equal(check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() }).status, 'pass');
});

test('timeout blocker advice cannot be reclassified as installation or sign-in failure', () => {
  const check = WORKFLOW_ASSERTIONS.get(AUTH_GATE);
  for (const [blocker, badMessage] of [
    ['az_timeout', 'Azure CLI is missing. Install Azure CLI and run az login.'],
    ['pac_timeout', 'PAC is signed out. Run pac auth create.'],
  ]) {
    const goodMessage = blocker === 'az_timeout' ? 'Azure CLI did not answer in 60 s; retry once or set POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS=120000.'
      : 'pac org who did not answer in 60 s; login is unknown, not missing. Retry once.';
    const call = { command: 'node check-auth.js --require-pac', result: authResult({ ok: false, blocker, message: goodMessage, whoAmI: null }), userMessage: goodMessage };
    const fixture = authFixture([call, call], { workflowLog: 'Halted; no provisioning or upload.' });
    assert.equal(check({ fixture, eval: evalStub() }).status, 'pass');
    call.result.message = badMessage;
    call.userMessage = badMessage;
    assert.equal(check({ fixture, eval: evalStub() }).status, 'fail');
  }
});

test('failed discovery never creates a connection or reference', () => {
  const text = [...PHASE_EXPECTATIONS.keys()].find((key) => key.startsWith('Phase 1 (Planner): For a connector-backed page'));
  const check = PHASE_EXPECTATIONS.get(text);
  const plan = validPlan().replace('No connector bindings.', '| Logical Name | Connector Id |\n|---|---|\n| cnt_docs | /providers/Microsoft.PowerApps/apis/shared_sharepointonline |');
  const failure = { command: 'node scripts\\list-connections.js https://contoso.crm.dynamics.com', result: { ok: false, message: 'Unrecognized PAC connection header.' }, userMessage: 'Unrecognized PAC connection header.' };
  const refused = fix({ contractVersion: 2, manifest: { contractVersion: 2 }, events: [failure], genpagePlan: plan, workflowLog: 'node list-connections.js\nneeds_input: Unrecognized PAC connection header.' });
  assert.equal(check({ fixture: refused, eval: evalStub(18) }).status, 'fail', 'a binding cannot come from failed discovery');
  for (const command of [
    'npx power-apps create-connection --api-id shared_sharepointonline',
    'node create-connection-reference.js https://contoso.crm.dynamics.com cnt_docs shared_sharepointonline',
    'npx power-apps auth-switch --account maker',
    'node genpage-upload.js --connectors connectors.json',
  ]) {
    const fixture = { ...refused, events: [failure, { command, result: { ok: true } }], workflowLog: `${refused.workflowLog}\n${command}\nResult: {"ok":true}` };
    assert.equal(check({ fixture, eval: evalStub(18) }).status, 'fail', command);
  }
  const connectorId = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
  const discovered = { ok: true, connections: [{ connectorId, connectionId: 'synthetic-connection', readyToBind: true }], connectionReferences: [{ logicalName: 'cnt_docs', connectorId, connectionId: 'synthetic-connection' }] };
  const ready = { ...refused, events: [{ ...failure, result: discovered }], workflowLog: 'node list-connections.js\nResult: {"ok":true,"connections":[{}]}' };
  assert.equal(check({ fixture: ready, eval: evalStub(18) }).status, 'pass');

  const captured = fs.readFileSync(path.join(__dirname, '..', 'fixtures', '18-sharepoint-connectors', 'workflow-log.md'), 'utf8');
  const probe = captured.replace('2 connections found:', '{"ok":false,"message":"Unrecognized PAC connection header."}')
    + '\nnpx power-apps create-connection --api-id shared_sharepointonline\nResult: {"ok":true}\n';
  assert.equal(check({ fixture: fix({ workflowLog: probe, genpagePlan: plan }), eval: evalStub(18) }).status, 'fail');
});

// ---------- prefix discipline plan format ----------

test('prefix discipline plan format: pass on suffix-only names', () => {
  const check = WORKFLOW_ASSERTIONS.get('Prefix discipline — plan format: Every name in `## Entity Creation Required` (table headings, column Suffix values, choice column suffixes, relationship Lookup Suffix values) is a bare suffix matching `^[a-z][a-z0-9]+$`. No value contains an underscore or a prefix. The prefix lives only in `## Environment` → `Publisher Prefix:`.');
  const plan = `## Entity Creation Required

| Table | Suffix |
|-------|--------|
| Widget | widget |

`;
  const result = check({ fixture: fix({ genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('prefix discipline plan format: fail when prefix bled into suffix', () => {
  const check = WORKFLOW_ASSERTIONS.get('Prefix discipline — plan format: Every name in `## Entity Creation Required` (table headings, column Suffix values, choice column suffixes, relationship Lookup Suffix values) is a bare suffix matching `^[a-z][a-z0-9]+$`. No value contains an underscore or a prefix. The prefix lives only in `## Environment` → `Publisher Prefix:`.');
  const plan = `## Entity Creation Required

| Table |
| cr_widget |

`;
  const result = check({ fixture: fix({ genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /cr_widget/);
});

// ---------- prefix discipline resolved names ----------

test('prefix resolved names: pass when all names start with publisher prefix', () => {
  const check = WORKFLOW_ASSERTIONS.get('Prefix discipline — resolved names: For every operation in `genpage-entity-creation-log.md`, the Resolved Full Name starts with the `Publisher Prefix:` value from the plan\'s `## Environment` followed by `_` and the bare suffix from the plan (e.g., Publisher Prefix `crb2b` + suffix `playername` → `crb2b_playername`).');
  const plan = `## Environment\nPublisher Prefix: crb2b\n`;
  const elog = `- Create table widget: Resolved Full Name: crb2b_widget\n`;
  const result = check({ fixture: fix({ genpagePlan: plan, entityCreationLog: elog }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('prefix resolved names: fail on prefix mismatch', () => {
  const check = WORKFLOW_ASSERTIONS.get('Prefix discipline — resolved names: For every operation in `genpage-entity-creation-log.md`, the Resolved Full Name starts with the `Publisher Prefix:` value from the plan\'s `## Environment` followed by `_` and the bare suffix from the plan (e.g., Publisher Prefix `crb2b` + suffix `playername` → `crb2b_playername`).');
  const plan = `## Environment\nPublisher Prefix: crb2b\n`;
  const elog = `- Resolved Full Name: cr_widget\n`;
  const result = check({ fixture: fix({ genpagePlan: plan, entityCreationLog: elog }), eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /cr_widget/);
});

// ---------- Phase 4 type generator: genpage.js types, and the pac verb an older capture records ----------

test('Phase 4 type generator skipped: pass when the log only mentions "not run"', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 4: RuntimeTypes generation is SKIPPED (mock data)');
  for (const log of [
    `## Phase 4\n- genpage.js types not run (mock data)`,
    `## Phase 4\n- pac model genpage generate-types not run (mock data)`,
  ]) {
    assert.equal(check({ fixture: fix({ workflowLog: log }), eval: evalStub() }).status, 'pass', log);
  }
});

test('Phase 4 type generator skipped: fail when it was run, by the script — also with a quoted path — or by the pac verb of an older capture', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 4: RuntimeTypes generation is SKIPPED (mock data)');
  for (const log of [
    `node genpage.js types --env https://contoso.crm.dynamics.com --data-sources 'account' --output-file RuntimeTypes.ts`,
    `- \`node 'D:/repo/plugins/model-apps/scripts/genpage.js' types --env 'https://contoso.crm.dynamics.com' --data-sources 'account' --output-file 'RuntimeTypes.ts'\``,
    `pac model genpage generate-types --data-sources 'account' --output-file RuntimeTypes.ts`,
  ]) {
    assert.equal(check({ fixture: fix({ workflowLog: log }), eval: evalStub() }).status, 'fail', log);
  }
});

test('Phase 4 type generator run: genpage.js types for account — also with a quoted path — or the pac verb of an older capture; another table, or the listing, is not it', () => {
  const check = PHASE_EXPECTATIONS.get("Phase 4: genpage.js types --data-sources 'account' --output-file <working-dir>/RuntimeTypes.ts is run");
  const run = (workflowLog) => check({ fixture: fix({ workflowLog }), eval: evalStub() });
  for (const log of [
    `- \`node 'D:/repo/plugins/model-apps/scripts/genpage.js' types --env 'https://contoso.crm.dynamics.com' --data-sources 'account' --output-file 'D:/work/x/RuntimeTypes.ts'\``,
    `node "\${PLUGIN_ROOT}/scripts/genpage.js" types --env https://contoso.crm.dynamics.com --data-sources "account" --output-file RuntimeTypes.ts`,
    `pac model genpage generate-types --data-sources 'account' --output-file RuntimeTypes.ts`,
  ]) assert.equal(run(log).status, 'pass', log);
  assert.match(run(`node genpage.js types --env https://contoso.crm.dynamics.com --data-sources 'contact' --output-file RuntimeTypes.ts`).reason, /missing --data-sources account/);
  for (const log of [
    `node genpage.js list --env https://contoso.crm.dynamics.com --app-id 1 # --data-sources 'account'`,
    'RuntimeTypes.ts written by hand',
  ]) assert.match(run(log).reason, /was not invoked/, log);
});

// ---------- Edit flow: the page listing and the page download are genpage.js, and a capture made before it records the pac verbs ----------

test('Edit Phase 2 (eval 3): genpage.js download — also with a quoted path — or the pac verb of an older capture; a listing is not a download', () => {
  const check = PHASE_EXPECTATIONS.get('Edit Phase 2: genpage.js download produces <working-dir>/<page-id>/ with page.tsx, config.json, prompt.txt');
  const run = (workflowLog) => check({ fixture: fix({ workflowLog }), eval: evalStub(3) });
  for (const line of [
    `- \`node 'D:/repo/plugins/model-apps/scripts/genpage.js' download --env 'https://contoso.crm.dynamics.com' --app-id 1 --page-id 2 --output-directory 'D:/work/x'\``,
    `- \`node "\${PLUGIN_ROOT}/scripts/genpage.js" download --env https://contoso.crm.dynamics.com --page-id 2 --output-directory D:/work/x\``,
    '- `pac model genpage download --app-id 1 --page-id 2 --output-directory D:/work/x`',
  ]) assert.equal(run(line).status, 'pass', line);
  for (const line of [
    `- \`node 'D:/repo/plugins/model-apps/scripts/genpage.js' list --env 'https://contoso.crm.dynamics.com' --app-id 1\``,
    '- `pac model genpage list --app-id 1`',
    '- the page code was recalled from memory',
  ]) assert.equal(run(line).status, 'fail', line);
});

// ---------- Phase 6 upload flags ----------

test('Phase 6 flags: pass when all flags present', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 6: the upload (genpage-upload.js) includes --app-id, --code-file, --data-sources \'account\', --prompt, --model, --name, --agent-message, --add-to-sitemap');
  const log = `node scripts/genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 1 --code-file p.tsx --data-sources 'account' --prompt-file prompt.txt --model claude --name-file page-name.txt --agent-message-file agent-message.txt --add-to-sitemap`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Phase 6 flags: a capture made before the script, with the raw pac upload, is still read', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 6: the upload (genpage-upload.js) includes --app-id, --code-file, --data-sources \'account\', --prompt, --model, --name, --agent-message, --add-to-sitemap');
  const log = `pac model genpage upload --app-id 1 --code-file p.tsx --data-sources 'account' --prompt "x" --model claude --name "p" --agent-message "m" --add-to-sitemap`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Phase 6 flags: fail when --agent-message missing', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 6: the upload (genpage-upload.js) includes --app-id, --code-file, --data-sources \'account\', --prompt, --model, --name, --agent-message, --add-to-sitemap');
  const log = `node scripts/genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 1 --code-file p.tsx --data-sources 'account' --prompt-file prompt.txt --model claude --name-file page-name.txt --add-to-sitemap`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /--agent-message/);
});

test('Phase 6 mock-data: pass when upload omits --data-sources', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 6: Deployment omits --data-sources flag (mock data page)');
  const log = `node scripts/genpage-upload.js --app-id 1 --code-file p.tsx --prompt-file prompt.txt --add-to-sitemap`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Phase 6 mock-data: fail when upload has --data-sources', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 6: Deployment omits --data-sources flag (mock data page)');
  const log = `node scripts/genpage-upload.js --data-sources 'account' --code-file p.tsx`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Phase 6 mock-data: the raw pac upload of an older capture is still read', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 6: Deployment omits --data-sources flag (mock data page)');
  assert.equal(check({ fixture: fix({ workflowLog: `pac model genpage upload --app-id 1 --code-file p.tsx --prompt "x" --add-to-sitemap` }), eval: evalStub() }).status, 'pass');
  assert.equal(check({ fixture: fix({ workflowLog: `pac model genpage upload --data-sources 'account' --code-file p.tsx` }), eval: evalStub() }).status, 'fail');
});

// ---------- app and table discovery: the plugin's scripts, and the pac commands older captures record ----------

test('Phase 1 list-tables (eval 1): list-tables.js must be exact, and a capture made before it records pac model list-tables', () => {
  const check = PHASE_EXPECTATIONS.get("Phase 1 (Planner): list-tables.js --search 'account' --exact is run and the result is matched by exact logical name");
  const run = (workflowLog) => check({ fixture: fix({ workflowLog }), eval: evalStub(1) });
  assert.equal(run(`- \`node 'D:/repo/plugins/model-apps/scripts/list-tables.js' --env 'https://contoso.crm.dynamics.com' --search 'account' --exact\` → 1 table`).status, 'pass');
  assert.equal(run(`- \`pac model list-tables --search 'account'\` — account exists`).status, 'pass');
  const loose = run(`- \`node scripts/list-tables.js --env https://contoso.crm.dynamics.com --search 'account'\` → 4 tables`);
  assert.equal(loose.status, 'fail');
  assert.match(loose.reason, /without --exact/);
  assert.match(run(`- \`node scripts/list-tables.js --env https://contoso.crm.dynamics.com\` → every table`).reason, /without --search/);
  assert.match(run('- no table discovery was run').reason, /not invoked/);
});

test('Edit Phase 1a (eval 3): apps.js list — also with a quoted script path — or the pac model list of an older capture; a page listing is not an app listing', () => {
  const check = PHASE_EXPECTATIONS.get('Edit Phase 1a: apps.js list is run to discover available apps — orchestrator does NOT guess or invent app names');
  const run = (workflowLog) => check({ fixture: fix({ workflowLog }), eval: evalStub(3) });
  for (const line of [
    `- \`node "\${PLUGIN_ROOT}/scripts/apps.js" list --env 'https://contoso.crm.dynamics.com'\` → 2 apps`,
    `- \`node 'D:/repo/plugins/model-apps/scripts/apps.js' list --env 'https://contoso.crm.dynamics.com' --search sales\``,
    '- `pac model list` → 2 apps found',
  ]) assert.equal(run(line).status, 'pass', line);
  for (const line of [
    '- `pac model genpage list --app-id 11111111-2222-3333-4444-555555555555` → 2 pages',
    `- \`node 'D:/repo/plugins/model-apps/scripts/genpage.js' list --env 'https://contoso.crm.dynamics.com' --app-id 11111111-2222-3333-4444-555555555555\` → 2 pages`,
    `- \`node 'D:/repo/plugins/model-apps/scripts/apps.js' create --env 'https://contoso.crm.dynamics.com' --name X --solution Default --page-id 1\``,
    '- apps recalled from memory',
  ]) assert.equal(run(line).status, 'fail', line);
});

// ---------- entity-builder gating ----------

test('Phase 2 entity-builder SKIPPED (no entities): pass when not invoked', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 2: Entity-builder is SKIPPED (no entities to create)');
  const log = `## Phase 2\n- SKIPPED (account exists)`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Phase 2 entity-builder SKIPPED (no entities): fail when invoked', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 2: Entity-builder is SKIPPED (no entities to create)');
  const log = `genpage-entity-builder invoked`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- single-page fast path ----------

test('5b fast path: pass when no Task dispatch and inline noted', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 5b (single-page fast path): Plan has 1 page so orchestrator inlines the build — NO Task subagent dispatched for the page-builder');
  const log = `## Phase 5b — single-page fast path\n- inlined build, no Task subagent dispatched`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('5b fast path: fail when Task subagent dispatched', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 5b (single-page fast path): Plan has 1 page so orchestrator inlines the build — NO Task subagent dispatched for the page-builder');
  const log = `Task genpage-page-builder invoked`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- edit flow ----------

test('Edit flow detection: pass when "edit flow" mentioned', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 1 (Planner): User indicates \'edit existing\'; planner returns { action: \'edit\' }, skipping Phases 2-8 of the create flow');
  const log = `Edit flow taken; action: edit`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Edit Phase 6 page-id: fail when --add-to-sitemap present', () => {
  const check = PHASE_EXPECTATIONS.get('Edit Phase 6: the upload (genpage-upload.js) uses --page-id flag; omits --add-to-sitemap');
  const log = `node scripts/genpage-upload.js --page-id abc --add-to-sitemap`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Edit Phase 6 page-id: pass when --page-id and no --add-to-sitemap', () => {
  const check = PHASE_EXPECTATIONS.get('Edit Phase 6: the upload (genpage-upload.js) uses --page-id flag; omits --add-to-sitemap');
  const log = `node scripts/genpage-upload.js --page-id abc --prompt-file prompt.txt`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Edit Phase 6 page-id: the raw pac upload of an older capture is still read', () => {
  const check = PHASE_EXPECTATIONS.get('Edit Phase 6: the upload (genpage-upload.js) uses --page-id flag; omits --add-to-sitemap');
  assert.equal(check({ fixture: fix({ workflowLog: `pac model genpage upload --page-id abc --prompt "delta"` }), eval: evalStub() }).status, 'pass');
  assert.equal(check({ fixture: fix({ workflowLog: `pac model genpage upload --page-id abc --add-to-sitemap` }), eval: evalStub() }).status, 'fail');
});

// ---------- entity-builder --solution always ----------

test('Entity scripts --solution: pass when every call has --solution', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 2b (Entity Builder): Every create-table.js / add-column.js / create-relationship.js call passes --solution <name> (always — \'Default\' is a valid value, never omitted); provision-entities.js flow specifies solution via input JSON, verified through ## Environment → Solution: declaration');
  const log = `- node create-table.js --name widget --solution Default
- node add-column.js --table widget --name foo --type string --solution Default`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Entity scripts --solution: fail when a call missing --solution', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 2b (Entity Builder): Every create-table.js / add-column.js / create-relationship.js call passes --solution <name> (always — \'Default\' is a valid value, never omitted); provision-entities.js flow specifies solution via input JSON, verified through ## Environment → Solution: declaration');
  const log = `- node create-table.js --name widget
- node add-column.js --table widget --name foo --solution Default`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /create-table\.js/);
});

test('Entity scripts --solution (new flow): pass when provision-entities.js used and Solution: in plan', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 2b (Entity Builder): Every create-table.js / add-column.js / create-relationship.js call passes --solution <name> (always — \'Default\' is a valid value, never omitted); provision-entities.js flow specifies solution via input JSON, verified through ## Environment → Solution: declaration');
  const log = `node provision-entities.js --env "$ENV_URL" --input @provision-input.json --apply`;
  const plan = `## Environment\nSolution: Default\nPublisher Prefix: new\n`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Entity scripts --solution (new flow): fail when provision-entities.js used but NO Solution: in plan or log', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 2b (Entity Builder): Every create-table.js / add-column.js / create-relationship.js call passes --solution <name> (always — \'Default\' is a valid value, never omitted); provision-entities.js flow specifies solution via input JSON, verified through ## Environment → Solution: declaration');
  const log = `node provision-entities.js --env "$ENV_URL" --input @provision-input.json --apply`;
  const plan = `## Environment\nPublisher Prefix: new\n`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: plan }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Entity scripts --solution (new flow): pass when provision-entities.js used and Solution: in entity-creation-log', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 2b (Entity Builder): Every create-table.js / add-column.js / create-relationship.js call passes --solution <name> (always — \'Default\' is a valid value, never omitted); provision-entities.js flow specifies solution via input JSON, verified through ## Environment → Solution: declaration');
  const log = `node provision-entities.js --env "$ENV_URL" --input @provision-input.json --apply`;
  const elog = `## Environment\n- Solution: Default\n`;
  const result = check({ fixture: fix({ workflowLog: log, entityCreationLog: elog }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// The documented mode record puts the log on the unattended branch. genpage SKILL.md's unattended
// table requires `Unattended default: interaction mode → unattended (<reason>)`, so recording the
// mode is enough to make a prompt a violation — no prose matching needed. Isolation: this log DOES
// contain `EnterPlanMode called`, so the attended branch would pass it; only the unattended branch
// can fail here.
test('the documented mode record marks the log unattended, so a prompt is a failure', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): The plan is presented via EnterPlanMode and user approval is requested');
  const log = `Unattended default: interaction mode → unattended (--non-interactive flag)\nEnterPlanMode called`;
  const result = check({ fixture: fix({ workflowLog: log, genpagePlan: validPlan() }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// Guard against re-introducing free-prose mode matching. Each prose form below is an ATTENDED log
// that merely contains the word "unattended"; a `\bunattended\b` match flags the first, and a
// `mode: unattended` match flags the rest. Any of them classifying as unattended would fail this
// correct run for the `EnterPlanMode called` line attended runs are required to have.
for (const prose of [
  'Interaction mode: attended. Not unattended: the --non-interactive flag was absent',
  'Mode: unattended = false',
  'Interaction mode: unattended? no - TTY present',
  'Read the mode matrix: Unattended → skip; Attended → ask. We are attended.',
]) {
  test(`an attended log mentioning "${prose.slice(0, 34)}..." is not misread as unattended`, () => {
    const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): The plan is presented via EnterPlanMode and user approval is requested');
    const result = check({ fixture: fix({ workflowLog: `${prose}\nEnterPlanMode called`, genpagePlan: validPlan() }), eval: evalStub() });
    assert.equal(result.status, 'pass');
  });
}

test('validateGenpagePlanSchema: missing Custom API Bindings section fails closed', () => {
  const plan = validPlan().replace(/\n## Custom API Bindings\nNo custom API bindings\.\n/, '\n');
  const errors = validateGenpagePlanSchema(plan);
  assert.ok(
    errors.some((error) => error.code === 'missing-section' && error.section === 'Custom API Bindings'),
    `expected missing Custom API Bindings section, got ${JSON.stringify(errors)}`
  );
});

test('Custom API Bindings section accepts the exact sentinel', () => {
  const errors = validateGenpagePlanSchema(validPlan());
  assert.equal(errors.filter((e) => e.code === 'missing-customapi-table').length, 0);
});

// references/plan-schema.md orders Connector Bindings → Custom API Bindings → Solution Packaging →
// Design Preferences. The order check split the required list at a fixed index, so adding Custom API
// Bindings to it made a schema-conformant plan WITH Solution Packaging fail as out of order.
test('a plan with Solution Packaging in plan-schema.md order passes the order check, and the reverse fails', () => {
  const packaging = '## Solution Packaging\n- Solution: ContosoApp\n\n';
  const conformant = validPlan().replace('## Design Preferences', `${packaging}## Design Preferences`);
  assert.deepEqual(validateGenpagePlanSchema(conformant).filter((e) => e.code === 'section-order'), []);
  const swapped = validPlan()
    .replace('## Custom API Bindings\nNo custom API bindings.\n\n', '')
    .replace('## Design Preferences', `${packaging}## Custom API Bindings\nNo custom API bindings.\n\n## Design Preferences`);
  assert.ok(validateGenpagePlanSchema(swapped).some((e) => e.code === 'section-order'), 'Solution Packaging before Custom API Bindings is out of order');
});

// The Custom API mirror of the connector delimiter leak. If the planner prompt regresses and the
// planner copies the `----- BEGIN/END CUSTOM API BINDINGS -----` framing into the plan, the body
// is no longer the exact sentinel and must be rejected — previously nothing checked this half.
test('a leaked prompt delimiter in Custom API Bindings is rejected', () => {
  const plan = validPlan().replace(
    '## Custom API Bindings\nNo custom API bindings.',
    '## Custom API Bindings\n----- BEGIN CUSTOM API BINDINGS -----\nNo custom API bindings.\n----- END CUSTOM API BINDINGS -----'
  );
  const errors = validateGenpagePlanSchema(plan);
  assert.equal(errors.filter((e) => e.code === 'missing-customapi-table').length, 1);
});

test('a populated Custom API Bindings table is accepted', () => {
  const plan = validPlan().replace(
    '## Custom API Bindings\nNo custom API bindings.',
    '## Custom API Bindings\n| Name | Kind | Bound Entity | Display Name | Parameters (name: kind) |\n|------|------|--------------|--------------|-------------------------|\n| new_ApproveOrder | Action | salesorder | Approve Order | Comment: String |'
  );
  const errors = validateGenpagePlanSchema(plan);
  assert.equal(errors.filter((e) => e.code === 'missing-customapi-table').length, 0);
});

test('a Custom API Bindings table missing required schema columns is rejected', () => {
  const plan = validPlan().replace(
    '## Custom API Bindings\nNo custom API bindings.',
    '## Custom API Bindings\n| Name | Kind | Bound Entity |\n|------|------|--------------|\n| new_ApproveOrder | Action | salesorder |'
  );
  const errors = validateGenpagePlanSchema(plan);
  assert.equal(errors.filter((e) => e.code === 'missing-customapi-table').length, 1);
});

// `## Dataverse Operations` is OPTIONAL: absent is no new built-in authoring, and every existing plan stays valid. When present it sits after Custom
// API Bindings and before Solution Packaging, and is the exact sentinel or the built-in operation table under its not-checked verification line.
const DATAVERSE_OPERATIONS = '## Dataverse Operations\nVerification: environment not-checked, runtime not-checked, privileges not-checked.\n'
  + '| Name | Kind | Bound Entity | Display Name | Parameters | Response fields | Invoke |\n|------|------|--------------|--------------|------------|-----------------|--------|\n'
  + '| WhoAmI | Function | (Global) | Current Dataverse identity | (none) | BusinessUnitId, UserId, OrganizationId | button |\n\n';
const withOperations = (section, plan = validPlan()) => plan.replace('## Design Preferences', `${section}## Design Preferences`);

test('Dataverse Operations is optional: a plan without it is unchanged, and the sentinel or the table after Custom API Bindings passes', () => {
  assert.deepEqual(validateGenpagePlanSchema(validPlan()).filter((e) => /dataverse|order/i.test(`${e.code} ${e.section || ''}`)), []);
  for (const section of [DATAVERSE_OPERATIONS, '## Dataverse Operations\nNo Dataverse operations.\n\n']) {
    const errors = validateGenpagePlanSchema(withOperations(section));
    assert.deepEqual(errors.filter((e) => e.code === 'section-order' || e.section === 'Dataverse Operations'), [], JSON.stringify(errors));
  }
  // Before Solution Packaging, as references/plan-schema.md orders them.
  const both = withOperations(`${DATAVERSE_OPERATIONS}## Solution Packaging\n- Solution: ContosoApp\n\n`);
  assert.deepEqual(validateGenpagePlanSchema(both).filter((e) => e.code === 'section-order'), []);
});

test('Dataverse Operations out of order, or anything but the sentinel or the table, is refused', () => {
  const beforeCustomApis = validPlan()
    .replace('## Custom API Bindings\nNo custom API bindings.\n\n', `${DATAVERSE_OPERATIONS}## Custom API Bindings\nNo custom API bindings.\n\n`);
  assert.ok(validateGenpagePlanSchema(beforeCustomApis).some((e) => e.code === 'section-order'), 'before Custom API Bindings');
  const afterPackaging = withOperations(`## Solution Packaging\n- Solution: ContosoApp\n\n${DATAVERSE_OPERATIONS}`);
  assert.ok(validateGenpagePlanSchema(afterPackaging).some((e) => e.code === 'section-order'), 'after Solution Packaging');
  for (const [label, section] of [
    ['empty', '## Dataverse Operations\n\n'],
    ['prose', '## Dataverse Operations\nAdd WhoAmI.\n\n'],
    ['no verification line', DATAVERSE_OPERATIONS.replace('Verification: environment not-checked, runtime not-checked, privileges not-checked.\n', '')],
    ['a leaked delimiter', '## Dataverse Operations\n----- BEGIN DATAVERSE OPERATIONS -----\nNo Dataverse operations.\n----- END DATAVERSE OPERATIONS -----\n\n'],
    ['a column missing', DATAVERSE_OPERATIONS.replace(' Invoke |', '').replace('--------|\n', '\n').replace(' button |', '')],
    ['not in the catalogue', DATAVERSE_OPERATIONS.replace('| WhoAmI |', '| whoami |')],
    ['an on-load trigger', DATAVERSE_OPERATIONS.replace('| button |', '| on-load |')],
  ]) {
    const errors = validateGenpagePlanSchema(withOperations(section));
    assert.ok(errors.some((e) => e.code === 'invalid-dataverse-operations' && e.section === 'Dataverse Operations'), `${label}: ${JSON.stringify(errors)}`);
  }
});

test('validateGenpagePlanSchema: page file paths must stay inside the working directory', () => {
  for (const [file, codePattern] of [
    ['..\\outside.tsx', /separator|traversal|escape|absolute/i],
    ['../outside.tsx', /traversal|escape|outside/i],
    ['C:\\temp\\outside.tsx', /absolute|escape/i],
  ]) {
    const plan = validPlan().replace('account-overview.tsx', file);
    const errors = validateGenpagePlanSchema(plan);
    assert.ok(
      errors.some((error) => error.code === 'invalid-page-file' && codePattern.test(error.message)),
      `expected invalid-page-file for ${file}, got ${JSON.stringify(errors)}`
    );
  }
});

test('validateGenpagePlanSchema: page file parent realpath must stay inside the working directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-plan-outside-'));
  const link = path.join(root, 'linked');
  t.after(() => {
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (error) {
    t.skip(`cannot create directory link on this host: ${error.message}`);
    return;
  }

  const plan = validPlan()
    .replace('D:\\work\\account-page', root)
    .replace('account-overview.tsx', 'linked/page.tsx');
  const errors = validateGenpagePlanSchema(plan);
  assert.ok(
    errors.some((error) => error.code === 'invalid-page-file' && /outside|realpath|working directory/i.test(error.message)),
    `expected invalid-page-file for symlink parent escape, got ${JSON.stringify(errors)}`
  );
});

test('validateGenpagePlanSchema: page files cannot collide by normalized case-insensitive identity', () => {
  const plan = validPlan().replace(
    '| Account Overview | account-overview.tsx | Show account highlights | account |',
    '| Account Overview | Page.tsx | Show account highlights | account |\n| Account Details | page.tsx | Show account details | account |'
  ).replace(
    '### Account Overview',
    '### Account Overview\n- **File:** Page.tsx\n- **Purpose:** Show account highlights\n- **Entities:** account\n- **Needs caching:** true\n- **Key Features:** Search and summary cards\n- **Components:** Card, Button\n- **Layout:** Responsive grid\n- **Data Binding:** queryTable("account")\n- **Interactions:** Search box filters cards\n\n### Account Details'
  );
  const errors = validateGenpagePlanSchema(plan);
  assert.ok(
    errors.some((error) => error.code === 'duplicate-page-file' && /Page\.tsx|page\.tsx/i.test(error.message)),
    `expected duplicate-page-file, got ${JSON.stringify(errors)}`
  );
});

// ---------- solutions query: the planner's documented RELATIVE path form ----------

const SOLUTIONS_QUERY = [...WORKFLOW_ASSERTIONS.keys()].find((t) => t.startsWith('Phase 1 (Planner): When the solution question runs, the planner queries /solutions'));

test('solutions query: the documented relative `solutions?$select=` command passes on its own', () => {
  // genpage-planner.md documents `dataverse-request.js <env> GET 'solutions?$select=...'` (no
  // leading slash). The check once required a literal `/solutions`, so a log that copied the
  // documented command verbatim failed.
  const log = [
    '- Solution selection question asked',
    "- `node 'D:/repo/plugins/model-apps/scripts/dataverse-request.js' 'https://contoso.crm.dynamics.com' GET 'solutions?$select=uniquename,friendlyname&$top=10'`",
  ].join('\n');
  assert.equal(WORKFLOW_ASSERTIONS.get(SOLUTIONS_QUERY)({ fixture: fix({ workflowLog: log }), eval: evalStub(8) }).status, 'pass');
});

test('solutions query: no query at all still fails, and a lookalike entity set does not satisfy it', () => {
  const asked = '- Solution selection question asked\n';
  const check = WORKFLOW_ASSERTIONS.get(SOLUTIONS_QUERY);
  assert.equal(check({ fixture: fix({ workflowLog: asked }), eval: evalStub(8) }).status, 'fail');
  const lookalike = `${asked}- node dataverse-request.js https://contoso.crm.dynamics.com GET 'solutionsfoo?$top=1'\n`;
  assert.equal(check({ fixture: fix({ workflowLog: lookalike }), eval: evalStub(8) }).status, 'fail');
  assert.equal(check({ fixture: fix({ workflowLog: `${asked}- pac solution list\n` }), eval: evalStub(8) }).status, 'pass');
});

test('solutions query: the documented multi-line form (bash `\\` or PowerShell backtick continuation) passes', () => {
  const check = WORKFLOW_ASSERTIONS.get(SOLUTIONS_QUERY);
  const asked = '- Solution selection question asked\n';
  for (const cont of ['\\', '`']) {
    for (const eol of ['\n', '\r\n']) {
      const log = `${asked}node "\${PLUGIN_ROOT}/scripts/dataverse-request.js" "$ENV_URL" GET ${cont}${eol}  "solutions?\\$select=uniquename,friendlyname&\\$top=10"${eol}`;
      assert.equal(check({ fixture: fix({ workflowLog: log }), eval: evalStub(8) }).status, 'pass', JSON.stringify({ cont, eol }));
    }
  }
  // An ordinary line break is not a continuation: a later, unrelated mention of solutions must not
  // be credited to an earlier dataverse-request.js call.
  const unrelated = `${asked}node dataverse-request.js https://contoso.crm.dynamics.com GET 'WhoAmI'\n- solutions were discussed\n`;
  assert.equal(check({ fixture: fix({ workflowLog: unrelated }), eval: evalStub(8) }).status, 'fail');
});

// --- The plan's Assumptions section and per-page semantic records (references/plan-schema.md) ------------------------------------

const GOOD_A1 = [
  '### A1 — Initial-load caching',
  '- Decision: De-duplicate and cache the initial list read.',
  '- Alternatives considered: An empty form with no initial read; uncached loading.',
  '- Evidence: default: this page loads on mount, so Critical Rule 15 applies.',
  '- Resolution: planner-default',
].join('\n');
const withAssumptions = (body, plan = validPlan()) => plan.replace('## Working Directory', `## Assumptions\n\n${body}\n\n## Working Directory`);
const SEMANTICS = [
  '',
  '#### Data semantics',
  '',
  '##### F1',
  '- Kind: filter',
  '- Definition: Cards match the account name containing the search text.',
  '- Source: User Requirements',
  '- Requirement quote: simple account page',
  '',
  '#### Lookup metadata',
  '',
  'None.',
  '',
].join('\n');
const withSemantics = (plan, block = SEMANTICS) => `${plan.trimEnd()}\n${block}`;

test('validateGenpagePlanSchema: a present but malformed Assumptions section fails invalid-assumptions; an absent one keeps the legacy pass', () => {
  assert.deepEqual(validateGenpagePlanSchema(validPlan()), [], 'neighbour: a legacy plan without the section still passes');
  for (const [label, body] of [
    ['missing Resolution', GOOD_A1.replace(/\n- Resolution: planner-default/, '')],
    ['duplicate id', `${GOOD_A1}\n\n${GOOD_A1}`],
    ['unknown resolution', GOOD_A1.replace('planner-default', 'assumed')],
    ['user-confirmed without Question/Answer', GOOD_A1.replace('planner-default', 'user-confirmed')],
    ['evidence without a metadata:/sample:/default: prefix', GOOD_A1.replace('default: this page', 'this page')],
  ]) {
    const errors = validateGenpagePlanSchema(withAssumptions(body));
    assert.ok(errors.some((error) => error.code === 'invalid-assumptions'), `${label}: ${JSON.stringify(errors)}`);
  }
  // Mode never waives malformed content: an App Spec projection with a malformed present section fails too.
  const appBuilder = validPlan().replace('- Publisher Prefix: new', '- Mode: app-builder\n- Publisher Prefix: new');
  assert.ok(validateGenpagePlanSchema(withAssumptions('### A1\n- Decision: x', appBuilder)).some((error) => error.code === 'invalid-assumptions'));
});

test('validateGenpagePlanSchema: Assumptions sits right after User Requirements, by name — misplaced is section-order', () => {
  assert.deepEqual(validateGenpagePlanSchema(withAssumptions(GOOD_A1)), [], 'neighbour: a valid section in place');
  assert.deepEqual(validateGenpagePlanSchema(withAssumptions('No assumptions.')), [], 'neighbour: the empty sentinel in place');
  const misplaced = validPlan().replace('## Entity Creation Required', `## Assumptions\n\n${GOOD_A1}\n\n## Entity Creation Required`);
  assert.ok(validateGenpagePlanSchema(misplaced).some((error) => error.code === 'section-order'), 'after Pages');
  const first = validPlan().replace('## User Requirements', `## Assumptions\n\n${GOOD_A1}\n\n## User Requirements`);
  assert.ok(validateGenpagePlanSchema(first).some((error) => error.code === 'section-order'), 'before User Requirements');
  const late = validPlan().replace('## Plugin Root', `## Assumptions\n\n${GOOD_A1}\n\n## Plugin Root`);
  assert.ok(validateGenpagePlanSchema(late).some((error) => error.code === 'section-order'), 'after Working Directory');
  // The optional sections already placed by name keep their checks beside it.
  const packaged = withAssumptions(GOOD_A1).replace('## Design Preferences', '## Solution Packaging\n- Package into solution: false\n\n## Design Preferences');
  assert.deepEqual(validateGenpagePlanSchema(packaged).filter((error) => error.code === 'section-order'), []);
});

test('validateGenpagePlanSchema: present per-page semantic records are validated against Assumptions and the original requirements', () => {
  assert.deepEqual(validateGenpagePlanSchema(withSemantics(withAssumptions(GOOD_A1))), [], 'neighbour: a complete record set passes');
  const codes = (plan) => validateGenpagePlanSchema(plan).map((error) => error.code);
  assert.deepEqual(codes(withSemantics(withAssumptions(GOOD_A1), SEMANTICS.replace('- Source: User Requirements\n- Requirement quote: simple account page', '- Source: A9'))), ['unknown-assumption']);
  assert.deepEqual(codes(withSemantics(withAssumptions(GOOD_A1), SEMANTICS.replace('- Source: User Requirements\n', ''))), ['missing-semantic-source']);
  assert.deepEqual(codes(withSemantics(withAssumptions(GOOD_A1), SEMANTICS.replace('simple account page', 'every account in the tenant'))), ['unmatched-requirement-quote']);
  assert.ok(codes(withSemantics(withAssumptions(GOOD_A1), SEMANTICS.replace('None.', '| Table | Column |\n|---|---|\n| account | x |'))).every((code) => code === 'invalid-lookup-metadata'));
  assert.deepEqual(codes(withSemantics(withAssumptions(GOOD_A1), SEMANTICS.replace('##### F1', '##### R1'))), ['invalid-data-semantics']);
  // Required-new mode: a newly authored plan carries every part; an older plan is not asked to.
  assert.deepEqual(validateGenpagePlanSchema(validPlan(), { requireSemantics: true }).map((error) => error.code), ['invalid-assumptions', 'invalid-data-semantics', 'invalid-lookup-metadata']);
  assert.deepEqual(validateGenpagePlanSchema(withSemantics(withAssumptions('No assumptions.'), SEMANTICS.replace(/##### F1[\s\S]*?\n\n#### Lookup/, 'None.\n\n#### Lookup')), { requireSemantics: true }), []);
});

test('Phase 5a: a plan whose semantic records fail validation must not reach the builders', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 5a: Orchestrator validates the plan — at least one page, unique filenames, each page has a matching Per-Page Specifications subsection');
  const built = { files: [{ name: 'account-overview.tsx', content: 'export default function P() { return null; }' }] };
  assert.equal(check({ fixture: fix({ genpagePlan: withSemantics(withAssumptions(GOOD_A1)), ...built }), eval: evalStub() }).status, 'pass', 'neighbour: valid records');
  for (const [label, plan] of [
    ['malformed Assumptions', withSemantics(withAssumptions(GOOD_A1.replace('planner-default', 'assumed')))],
    ['a dangling assumption', withSemantics(withAssumptions(GOOD_A1), SEMANTICS.replace('- Source: User Requirements\n- Requirement quote: simple account page', '- Source: A9'))],
    ['a quote the requirements do not hold', withSemantics(withAssumptions(GOOD_A1), SEMANTICS.replace('simple account page', 'all accounts'))],
    ['malformed lookup metadata', withSemantics(withAssumptions(GOOD_A1), SEMANTICS.replace('None.', 'Customer lookup, see metadata.'))],
  ]) {
    const result = check({ fixture: fix({ genpagePlan: plan, ...built }), eval: evalStub() });
    assert.equal(result.status, 'fail', label);
    assert.match(result.reason, /fails Phase 5a/, label);
  }
});

// The plan-approval record is its own line: the words right after `Unattended default:` are `plan approval`, then an arrow and the
// whole word `approved`. A semantic default — whose question, answer or reason may say "plan" or "approved" — never stands in for it.
test('unattended plan approval is recognized only by its dedicated record, never by a semantic default that mentions approval', () => {
  const check = WORKFLOW_ASSERTIONS.get('Phase 1 (Planner): The plan is presented via EnterPlanMode and user approval is requested');
  const run = (log) => check({ fixture: fix({ workflowLog: log, genpagePlan: validPlan() }), eval: evalStub() });
  for (const line of [
    'Unattended default: plan approval → approved (unattended mode; all semantic questions resolved)',
    'Unattended default: plan approval -> approved (--non-interactive flag)',
    '- Unattended default: plan approval -> approved',
    '  * Unattended default: plan approval → approved, including explicit optional packaging into ContosoPages.',
  ]) {
    assert.equal(run(`Unattended default: interaction mode → unattended (flag)\n${line}`).status, 'pass', line);
  }
  for (const line of [
    'Unattended default: A1 / plan-status → Approved (the only status the request names)',
    'Unattended default: A2 / opportunities-account-scope → Direct customer account only (planner default; approved plan)',
    'Unattended default: solution selection → Default (approval not required; approved by default)',
  ]) {
    const result = run(`Unattended default: interaction mode → unattended (flag)\n${line}`);
    assert.equal(result.status, 'fail', line);
    assert.match(result.reason, /does not record plan approval/, line);
  }
});

// ---------- a newly authored plan's semantic records (evals 26 and 27) ----------

const NEW_CONTRACT = "Phase 1 (Planner): The newly authored plan records its assumptions and every page's data semantics and lookup metadata, the approved preview carries the same records, and provenance is verified with --require-assumptions";
const { loadFixtures } = require('../lib/fixture-loader.js');
const scenarioFixture = (id) => {
  const found = loadFixtures(path.join(__dirname, '..', 'fixtures')).find((fixture) => fixture.id === id);
  assert.ok(found, `fixture ${id} exists`);
  return found;
};
const gradeNewContract = (fixture) => PHASE_EXPECTATIONS.get(NEW_CONTRACT)({ fixture, eval: { id: fixture.id } });
// A Windows checkout gives a fixture's text files CRLF line ends (git's core.autocrlf), and the graders read them as they are. A variant below
// writes its lines with `\n`; `edit` and `asIn` write each `\n` as the line end the fixture's text really has, so a variant is graded in the
// checkout's own bytes, and `edit` fails when its text is not there: a change that finds nothing would grade the fixture itself, not a variant.
// `from` may also be a pattern, written with `\r?\n` so that it matches either line end.
const asIn = (text, lines) => lines.replace(/\r?\n/g, text.includes('\r\n') ? '\r\n' : '\n');
const edit = (text, from, to) => {
  const find = typeof from === 'string' ? asIn(text, from) : from;
  assert.ok(typeof find === 'string' ? text.includes(find) : text.search(find) >= 0, `the fixture's text has ${JSON.stringify(String(find))}`);
  return text.replace(find, () => asIn(text, to));
};

test('a newly authored plan passes with its records, the same approved preview and a --require-assumptions verification of exactly those records', () => {
  const fixture = scenarioFixture(27);
  assert.deepEqual(gradeNewContract(fixture), { status: 'pass', reason: '' });
});

test('a newly authored plan without its records, preview or matching verification fails — it never skips', () => {
  const base = scenarioFixture(27);
  const variant = (change) => {
    const copy = structuredClone({ ...base, files: [] });
    change(copy);
    return gradeNewContract(copy);
  };
  for (const [label, change, reason] of [
    ['no ## Assumptions in the written plan', (f) => { f.genpagePlan = edit(f.genpagePlan, /\r?\n## Assumptions\r?\n[\s\S]*?\r?\n## Working Directory\r?\n/, '\n## Working Directory\n'); }, /Assumptions/],
    ['no Data semantics for the page', (f) => { f.genpagePlan = edit(f.genpagePlan, '#### Data semantics\nNone.\n\n', ''); }, /Data semantics/],
    ['no approved preview declared', (f) => { delete f.manifest.semantics; }, /approved preview/],
    ['an assumption the preview never showed', (f) => { f.genpagePlan = edit(f.genpagePlan, '- Resolution: planner-default\n\n### A2', '- Resolution: planner-default\n\n### A3 — Extra\n- Decision: Hide archived orders.\n- Alternatives considered: Show them.\n- Evidence: default: none stated.\n- Resolution: planner-default\n\n### A2'); }, /differs from the approved preview/],
    ['a verification whose hash is another plan\'s', (f) => { for (const event of f.events) if (event.result?.semanticsHash) event.result.semanticsHash = '0'.repeat(64); }, /semanticsHash is not the hash/],
    ['a verification that failed', (f) => { for (const event of f.events) if (event.result?.semanticsHash) event.result.ok = false; }, /did not pass/],
  ]) {
    const result = variant(change);
    assert.equal(result.status, 'fail', label);
    assert.match(result.reason, reason, `${label}: ${result.reason}`);
  }
});

// ---------- eval 26: the answered question, the lookup metadata behind the records, the types and the gate ----------

const SEMANTIC_QUESTION = 'Phase 1 (Planner): The open account-scope question reaches the maker as needs_input with no default, the answer returns to the planner by its question id, and the written plan and the approved preview record it as a user-confirmed assumption before approval';
const LOOKUP_DISCOVERY = "Phase 1 (Planner): get-lookup-metadata.js reads opportunity's lookups before approval, its successful answer is the saved lookup-metadata.json, and every recorded lookup is observed with the complete targets and concrete paths it read";
const LOOKUP_TYPES = "Phase 4: RuntimeTypes.ts is generated for opportunity and types each recorded lookup's read property with exactly its recorded targets";
const OBSERVED_GATE = "Phase 5a: The page is generated only after provenance is verified with --require-assumptions --require-observed-lookups --lookup-metadata on this plan's records";
const grade = (text, fixture) => PHASE_EXPECTATIONS.get(text)({ fixture, eval: { id: fixture.id } });
// A changed copy of fixture 26: the manifest, events, artifacts and documents are cloned, so a variant never leaks into another.
const variant26 = (change) => {
  const copy = structuredClone({ ...scenarioFixture(26), files: [] });
  change(copy);
  return copy;
};
const event26 = (fixture, id) => fixture.events.find((event) => event.id === id);
const interactions26 = (fixture, change) => {
  const entries = JSON.parse(fixture.artifacts['semantic-interactions.json']);
  fixture.artifacts['semantic-interactions.json'] = JSON.stringify(change(entries));
};
const moveEvent26 = (fixture, id, after) => {
  const [moved] = fixture.events.splice(fixture.events.findIndex((event) => event.id === id), 1);
  fixture.events.splice(fixture.events.findIndex((event) => event.id === after) + 1, 0, moved);
};
const assertFails26 = (text, cases) => {
  for (const [label, change, reason] of cases) {
    const result = grade(text, variant26(change));
    assert.equal(result.status, 'fail', label);
    assert.match(result.reason, reason, `${label}: ${result.reason}`);
  }
};

test('eval 26: the answered question, the lookup metadata read, the typed lookup, the gate and the new contract all pass', () => {
  const fixture = scenarioFixture(26);
  for (const text of [SEMANTIC_QUESTION, LOOKUP_DISCOVERY, NEW_CONTRACT, LOOKUP_TYPES, OBSERVED_GATE]) {
    assert.deepEqual(grade(text, fixture), { status: 'pass', reason: '' }, text);
  }
});

// The graders read a fixture as the checkout gives it — CRLF line ends on Windows, LF elsewhere — so both scenarios are graded here in each,
// whichever this checkout gave them: every text the loader read from a file is written with those line ends (the manifest and the events are
// parsed JSON, with no line ends of their own). Both pass in each, and a variant whose change spans lines fails in each.
test('eval 26 and 27: the graders give the same verdicts to a fixture with LF and with CRLF line ends', () => {
  const withLineEnds = (fixture, eol) => {
    const copy = structuredClone(fixture);
    const ends = (text) => (typeof text === 'string' ? text.replace(/\r?\n/g, eol) : text);
    for (const key of ['workflowLog', 'genpagePlan', 'genpageEditPlan', 'runtimeTypes', 'entityCreationLog']) copy[key] = ends(copy[key]);
    for (const name of Object.keys(copy.artifacts)) copy.artifacts[name] = ends(copy.artifacts[name]);
    for (const file of copy.files) file.content = ends(file.content);
    return copy;
  };
  const [base26, base27] = [scenarioFixture(26), scenarioFixture(27)];
  for (const [ends, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    const fixture = withLineEnds(base26, eol);
    assert.equal(fixture.genpagePlan.includes('\r\n'), eol === '\r\n', `${ends}: the plan is written with ${ends} line ends`);
    for (const text of [SEMANTIC_QUESTION, LOOKUP_DISCOVERY, NEW_CONTRACT, LOOKUP_TYPES, OBSERVED_GATE]) {
      assert.deepEqual(grade(text, fixture), { status: 'pass', reason: '' }, `${ends}: ${text}`);
    }
    assert.deepEqual(gradeNewContract(withLineEnds(base27, eol)), { status: 'pass', reason: '' }, `${ends}: eval 27`);
    const unasked = withLineEnds(base26, eol);
    unasked.workflowLog = edit(unasked.workflowLog, '- AskUserQuestion: Which opportunities should this account show? → Direct customer\n', '');
    assert.equal(grade(SEMANTIC_QUESTION, unasked).status, 'fail', `${ends}: the question never asked`);
    const unrecorded = withLineEnds(base27, eol);
    unrecorded.genpagePlan = edit(unrecorded.genpagePlan, /\r?\n## Assumptions\r?\n[\s\S]*?\r?\n## Working Directory\r?\n/, '\n## Working Directory\n');
    assert.equal(gradeNewContract(unrecorded).status, 'fail', `${ends}: no assumptions in the written plan`);
  }
});

test('eval 26: a question that was not asked, answered, handed back, recorded or approved in that order fails — it never skips', () => {
  const SCOPE_LINE = '- AskUserQuestion: Which opportunities should this account show? → Direct customer\n';
  assertFails26(SEMANTIC_QUESTION, [
    ['no interactions declared', (f) => { delete f.manifest.semantics.interactions; }, /semantics\.interactions/],
    ['the answer removed before approval', (f) => interactions26(f, (entries) => entries.filter((entry) => entry.type !== 'answer')), /approved while opportunities-account-scope was unanswered/],
    ['approval before the answer', (f) => interactions26(f, (entries) => [entries[0], entries[2], entries[1]]), /unanswered/],
    ['a pre-settled default on a question with three candidates', (f) => {
      event26(f, 'planner-discovery').result.questions[0].options[1].default = true;
      interactions26(f, (entries) => { entries[0].defaults = ['Direct customer']; return entries; });
    }, /several candidates carries no default/],
    ['the options differ from the planner\'s', (f) => interactions26(f, (entries) => { entries[0].options = ['Direct customer']; return entries; }), /not the ones the planner returned/],
    ['an answer that is not an option', (f) => interactions26(f, (entries) => { entries[1].selected = 'Every account'; return entries; }), /not one of the options/],
    ['no AskUserQuestion for it in the log', (f) => { f.workflowLog = edit(f.workflowLog, SCOPE_LINE, ''); }, /AskUserQuestion: Which opportunities should this account show\? → Direct customer/],
    ['the plan approved before the question was asked', (f) => { f.workflowLog = edit(f.workflowLog, SCOPE_LINE, '') + asIn(f.workflowLog, `\n${SCOPE_LINE}`); }, /approved before the question was answered/],
    ['an unattended default for a question with no default', (f) => interactions26(f, (entries) => { entries[1].source = 'unattended-default'; return entries; }), /only the one option the planner marked/],
    ['the answer never handed back to the planner', (f) => interactions26(f, (entries) => { entries[1].event = 'planner-discovery'; return entries; }), /no planner event after the question carries its answer/],
    ['a re-invocation that does not carry the answer', (f) => { event26(f, 'planner-answers').command = 'Task genpage-planner (answers: app → Sales Hub)'; }, /does not hand back opportunities-account-scope → Direct customer/],
    ['the written plan records another answer', (f) => { f.genpagePlan = f.genpagePlan.replace('- Answer: Direct customer', '- Answer: Parent account'); }, /the written plan records A1's Answer as "Parent account"/],
    ['the preview records another answer', (f) => { f.artifacts['approved-plan.md'] = f.artifacts['approved-plan.md'].replace('- Answer: Direct customer', '- Answer: Customer plus contacts'); }, /the approved preview records A1's Answer/],
    ['no Assumptions in the written plan', (f) => { f.genpagePlan = edit(f.genpagePlan, /\r?\n## Assumptions\r?\n[\s\S]*?\r?\n## Working Directory\r?\n/, '\n## Working Directory\n'); }, /the written plan records no assumption answering opportunities-account-scope/],
    ['the preview saved before the answer reached the planner', (f) => moveEvent26(f, 'save-approved', 'planner-discovery'), /saved before the answer reached the planner/],
    ['an approval of another preview', (f) => interactions26(f, (entries) => { entries[2].preview = 'genpage-plan.md'; return entries; }), /not the approved preview the fixture declares/],
  ]);
});

test('eval 26: the lookup records must come from a successful lookup metadata read the run saved before approval', () => {
  const metadata = (f) => JSON.parse(f.artifacts['lookup-metadata.json']);
  assertFails26(LOOKUP_DISCOVERY, [
    ['no lookup metadata declared', (f) => { delete f.manifest.semantics.lookupMetadata; }, /semantics\.lookupMetadata/],
    ['no get-lookup-metadata.js read', (f) => { f.events = f.events.filter((event) => event.id !== 'lookup-metadata'); }, /never read opportunity/],
    ['a saved file that is not the answer read', (f) => {
      const changed = metadata(f);
      changed.tables[0].lookups[0].targets = ['account'];
      f.artifacts['lookup-metadata.json'] = JSON.stringify(changed);
    }, /no get-lookup-metadata.js answer is the saved lookup-metadata.json/],
    ['a failed read', (f) => {
      const failed = { ok: false, code: 'LOOKUP_RELATIONSHIPS_UNREADABLE', error: 'opportunity: the relationship read was refused' };
      f.artifacts['lookup-metadata.json'] = JSON.stringify(failed);
      event26(f, 'lookup-metadata').result = failed;
    }, /not a successful get-lookup-metadata.js answer/],
    ['metadata read after the approval', (f) => moveEvent26(f, 'lookup-metadata', 'save-approved'), /read after the plan was approved/],
    ['a record whose targets are not the complete set read', (f) => { f.genpagePlan = f.genpagePlan.replace('| _customerid_value | account, contact |', '| _customerid_value | account |'); }, /not the complete set read/],
    ['an existing table\'s lookup left planned', (f) => { f.genpagePlan = f.genpagePlan.replace('customer navigation; customer picker | observed |', 'customer navigation; customer picker | planned |'); }, /recorded planned, but opportunity exists/],
  ]);
});

test('eval 26: RuntimeTypes.ts must be generated for the table and type the lookup with exactly the recorded targets', () => {
  assertFails26(LOOKUP_TYPES, [
    ['RuntimeTypes.ts not captured', (f) => { f.runtimeTypes = null; }, /RuntimeTypes.ts was not captured/],
    ['types not generated for opportunity', (f) => { f.events = f.events.filter((event) => event.id !== 'generate-types'); }, /genpage.js types was not run for opportunity/],
    ['a one-target type', (f) => { f.runtimeTypes = edit(f.runtimeTypes, ' | `/contact(${string})`,\n    readonly customeridname', ',\n    readonly customeridname'); }, /types opportunity._customerid_value as account, the plan records account, contact/],
    ['the read property not declared', (f) => { f.runtimeTypes = edit(f.runtimeTypes, /^ {4}_customerid_value:.*\r?\n/m, ''); }, /does not declare opportunity._customerid_value/],
  ]);
});

test('eval 26: generation waits for a passing --require-observed-lookups verification of these records — removing the manifest key does not turn it off', () => {
  const gate = (f) => event26(f, 'plan-verify-5a');
  assertFails26(OBSERVED_GATE, [
    ['no gate', (f) => { f.events = f.events.filter((event) => event.id !== 'plan-verify-5a'); }, /not gated by a verification with --require-assumptions --require-observed-lookups --lookup-metadata/],
    ['the gate after the page was written', (f) => moveEvent26(f, 'plan-verify-5a', 'write-page'), /ran after the page was generated/],
    ['the gate verified other records', (f) => { gate(f).result = { ...gate(f).result, semanticsHash: '0'.repeat(64) }; }, /no observed-lookups verification passed/],
    ['the gate failed', (f) => { gate(f).result = { ok: false, action: 'verify', semanticProblems: ['opportunity.customerid is still planned'] }; }, /no observed-lookups verification passed/],
    ['the gate read another metadata file', (f) => { gate(f).command = gate(f).command.replace('/lookup-metadata.json', '/other-metadata.json'); }, /no observed-lookups verification passed/],
    ['a lookup still planned', (f) => { f.genpagePlan = f.genpagePlan.replace('customer navigation; customer picker | observed |', 'customer navigation; customer picker | planned |'); }, /opportunity.customerid is still planned/],
    ['the lookup metadata declaration removed', (f) => { delete f.manifest.semantics.lookupMetadata; }, /semantics\.lookupMetadata/],
  ]);
});

test('eval 26: an unattended run that takes the one option the planner marked, hands it back and records it as an unattended default passes — and fails without its record', () => {
  const RECORD = 'Unattended default: A1 / opportunities-account-scope → Direct customer account only (the request names the direct customer and metadata leaves one matching path)';
  const unattended = (change = () => {}) => variant26((f) => {
    event26(f, 'planner-discovery').result.questions[0].options = [{ label: 'Direct customer account only', description: 'The request names the direct customer.', default: true }];
    event26(f, 'planner-answers').command = 'Task genpage-planner (answers: opportunities-account-scope → Direct customer account only; app → Sales Hub)';
    interactions26(f, () => [
      { type: 'needs_input', event: 'planner-discovery', question: 'opportunities-account-scope', options: ['Direct customer account only'], defaults: ['Direct customer account only'] },
      { type: 'answer', event: 'planner-answers', question: 'opportunities-account-scope', selected: 'Direct customer account only', source: 'unattended-default' },
      { type: 'approval', preview: 'approved-plan.md', outcome: 'approved', source: 'unattended-default' },
    ]);
    const settle = (text) => edit(text, '- Resolution: user-confirmed\n- Question: opportunities-account-scope\n- Answer: Direct customer\n',
      `- Resolution: unattended-default\n- Question: opportunities-account-scope\n- Answer: Direct customer account only\n- Default record: ${RECORD}\n`);
    f.genpagePlan = settle(f.genpagePlan);
    f.artifacts['approved-plan.md'] = settle(f.artifacts['approved-plan.md']);
    f.workflowLog = edit(edit(f.workflowLog, '- AskUserQuestion: Which opportunities should this account show? → Direct customer\n', `- ${RECORD}\n`),
      '- ExitPlanMode → user approved the plan without changes\n', '- Unattended default: plan approval → approved (unattended mode; all semantic questions resolved)\n');
    change(f);
  });
  assert.deepEqual(grade(SEMANTIC_QUESTION, unattended()), { status: 'pass', reason: '' });
  for (const [label, change, reason] of [
    ['the default record missing from the log', (f) => { f.workflowLog = edit(f.workflowLog, `- ${RECORD}\n`, ''); }, /does not hold A1's Default record/],
    ['no plan-approval record', (f) => { f.workflowLog = edit(f.workflowLog, '- Unattended default: plan approval → approved (unattended mode; all semantic questions resolved)\n', ''); }, /no unattended plan-approval record/],
    // The interaction artifact still lists the approval last; only the log says it came first.
    ['the plan approved in the log before its default was recorded', (f) => {
      const approval = '- Unattended default: plan approval → approved (unattended mode; all semantic questions resolved)\n';
      f.workflowLog = asIn(f.workflowLog, approval) + edit(f.workflowLog, approval, '');
    }, /approved before its unattended default was recorded/],
    ['a second approval record after an early one', (f) => {
      f.workflowLog = asIn(f.workflowLog, '- Unattended default: plan approval -> approved\n') + f.workflowLog;
    }, /approved before its unattended default was recorded/],
    ['an answer recorded as user-confirmed', (f) => { f.genpagePlan = edit(edit(f.genpagePlan, '- Resolution: unattended-default', '- Resolution: user-confirmed'), `- Default record: ${RECORD}\n`, ''); }, /records A1 as user-confirmed, not unattended-default/],
  ]) {
    const result = grade(SEMANTIC_QUESTION, unattended(change));
    assert.equal(result.status, 'fail', label);
    assert.match(result.reason, reason, `${label}: ${result.reason}`);
  }
});