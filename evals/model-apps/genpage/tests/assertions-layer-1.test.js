'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

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
  const check = WORKFLOW_ASSERTIONS.get('Prefix discipline — resolved names: For every operation in `entity-creation-log.md`, the Resolved Full Name starts with the `Publisher Prefix:` value from the plan\'s `## Environment` followed by `_` and the bare suffix from the plan (e.g., Publisher Prefix `crb2b` + suffix `playername` → `crb2b_playername`).');
  const plan = `## Environment\nPublisher Prefix: crb2b\n`;
  const elog = `- Create table widget: Resolved Full Name: crb2b_widget\n`;
  const result = check({ fixture: fix({ genpagePlan: plan, entityCreationLog: elog }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('prefix resolved names: fail on prefix mismatch', () => {
  const check = WORKFLOW_ASSERTIONS.get('Prefix discipline — resolved names: For every operation in `entity-creation-log.md`, the Resolved Full Name starts with the `Publisher Prefix:` value from the plan\'s `## Environment` followed by `_` and the bare suffix from the plan (e.g., Publisher Prefix `crb2b` + suffix `playername` → `crb2b_playername`).');
  const plan = `## Environment\nPublisher Prefix: crb2b\n`;
  const elog = `- Resolved Full Name: cr_widget\n`;
  const result = check({ fixture: fix({ genpagePlan: plan, entityCreationLog: elog }), eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /cr_widget/);
});

// ---------- Phase 4 generate-types ----------

test('Phase 4 generate-types skipped: pass when log only mentions "not run"', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 4: RuntimeTypes generation is SKIPPED (mock data)');
  const log = `## Phase 4\n- pac model genpage generate-types not run (mock data)`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Phase 4 generate-types skipped: fail when actually invoked', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 4: RuntimeTypes generation is SKIPPED (mock data)');
  const log = `pac model genpage generate-types --data-sources 'account' --output-file RuntimeTypes.ts`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- Phase 6 upload flags ----------

test('Phase 6 flags: pass when all flags present', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 6: pac model genpage upload includes --app-id, --code-file, --data-sources \'account\', --prompt, --model, --name, --agent-message, --add-to-sitemap');
  const log = `pac model genpage upload --app-id 1 --code-file p.tsx --data-sources 'account' --prompt "x" --model claude --name "p" --agent-message "m" --add-to-sitemap`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Phase 6 flags: fail when --agent-message missing', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 6: pac model genpage upload includes --app-id, --code-file, --data-sources \'account\', --prompt, --model, --name, --agent-message, --add-to-sitemap');
  const log = `pac model genpage upload --app-id 1 --code-file p.tsx --data-sources 'account' --prompt "x" --model claude --name "p" --add-to-sitemap`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /--agent-message/);
});

test('Phase 6 mock-data: pass when upload omits --data-sources', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 6: Deployment omits --data-sources flag (mock data page)');
  const log = `pac model genpage upload --app-id 1 --code-file p.tsx --prompt "x" --add-to-sitemap`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Phase 6 mock-data: fail when upload has --data-sources', () => {
  const check = PHASE_EXPECTATIONS.get('Phase 6: Deployment omits --data-sources flag (mock data page)');
  const log = `pac model genpage upload --data-sources 'account' --code-file p.tsx`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
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
  const check = PHASE_EXPECTATIONS.get('Edit Phase 6: pac model genpage upload uses --page-id flag; omits --add-to-sitemap');
  const log = `pac model genpage upload --page-id abc --add-to-sitemap`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Edit Phase 6 page-id: pass when --page-id and no --add-to-sitemap', () => {
  const check = PHASE_EXPECTATIONS.get('Edit Phase 6: pac model genpage upload uses --page-id flag; omits --add-to-sitemap');
  const log = `pac model genpage upload --page-id abc --prompt "delta"`;
  const result = check({ fixture: fix({ workflowLog: log }), eval: evalStub() });
  assert.equal(result.status, 'pass');
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
