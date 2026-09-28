'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
// Windows checkouts can use CRLF; the prose contracts should not depend on Git's EOL setting.
const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8').replace(/\r\n?/g, '\n');
const skill = (name) => read(`skills/${name}/SKILL.md`);
const shared = read('shared/shared-instructions.md');
const removal = read('shared/references/data-source-removal.md');
const create = skill('create-mobile-app');
const dataSkills = [
  'add-datasource',
  'setup-datamodel',
  'add-dataverse',
  'add-connector',
  'add-sharepoint',
  'add-sample-data',
];

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing section: ${start}`);
  assert.ok(endIndex > startIndex, `Missing section end: ${end}`);
  return text.slice(startIndex, endIndex);
}

for (const [name, ending] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`Markdown reader preserves the same data contracts with ${name} line endings`, (t) => {
    const file = 'shared/shared-instructions.md';
    const content = '# Shared Instructions\n\n## Data-source invocation scope\nfirst\nsecond\n\n## Version Check\n';
    t.mock.method(fs, 'readFileSync', (filePath, encoding) => {
      assert.equal(filePath, path.join(pluginRoot, file));
      assert.equal(encoding, 'utf8');
      return content.replace(/\n/g, ending);
    });
    const actual = read(file);
    assert.equal(actual, content);
    assert.match(section(actual, '## Data-source invocation scope', '## Version Check'), /first\nsecond/);
  });
}

function assertSharedEntry(content, name) {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '').trimStart();
  const firstLine = body.split('\n')[0];
  assert.match(firstLine, /\[shared-instructions\.md\]\([^)]+\/shared-instructions\.md\)/, `${name}: shared policy must be the first instruction`);
  assert.match(firstLine, /read (?:this |both )?first/i, `${name}: read-first prerequisite`);
  assert.match(content.match(/^allowed-tools: (.+)$/m)?.[1] || '', /\bRead\b/, `${name}: allow reading policy`);
}

for (const name of dataSkills) {
  test(`${name} starts with the shared data-scope preflight`, () => {
    const content = skill(name);
    assertSharedEntry(content, name);
    const entry = section(content, '**Invocation scope:**', '\n\n');
    assert.match(entry, /shared-instructions\.md#data-source-invocation-scope/);
    assert.ok(content.indexOf('**Invocation scope:**') < content.indexOf('## Workflow'));
    assert.doesNotMatch(content, /#app-feature-entry-points|(?:app-edit-routing|native-artifact-compatibility)\.md/);
  });
}

test('data workflows cannot omit, defer, or disable reading shared policy', () => {
  const valid = '---\nallowed-tools: Read, Bash\n---\n\n**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** - read first.\n\n## Workflow\n';
  assert.doesNotThrow(() => assertSharedEntry(valid, 'data-workflow'));
  assert.throws(() => assertSharedEntry(valid.replace('**Shared instructions:', 'Run auth first.\n**Shared instructions:'), 'data-workflow'));
  assert.throws(() => assertSharedEntry(valid.replace('shared-instructions.md', 'other.md'), 'data-workflow'));
  assert.throws(() => assertSharedEntry(valid.replace('read first', 'optional'), 'data-workflow'));
  assert.throws(() => assertSharedEntry(valid.replace('Read, Bash', 'Bash'), 'data-workflow'));
});

test('shared data scope precedes operational work and does not turn caller markers into approval', () => {
  const scope = section(shared, '## Data-source invocation scope', '## Version Check');
  assert.match(scope, /before any workflow commands or app\/cloud writes/);
  assert.match(scope, /cannot be loaded, STOP/);
  assert.match(scope, /Resolve the current requested operation before discovery or mutation/);
  assert.match(scope, /An existing plan or inventory is context, not permission to replay every row/);
  assert.match(scope, /Standalone calls keep the data workflow's own approval and validation gates/);
  assert.match(scope, /MOBILE_APP_ORCHESTRATING=1/);
  for (const field of ['orchestrator', 'working_dir', 'phase', 'approved_scope']) {
    assert.ok(scope.includes(`\`${field}\``));
  }
  assert.match(scope, /including routers and retries/);
  assert.match(scope, /do not persist it, rely on a prior shell export, or infer\napproval from a flag alone/);
  assert.match(scope, /expanded or conflicting scope returns `NEEDS_CONTEXT`/);
  assert.match(scope, /Older callers without a complete approved handoff must establish current scope\nthrough the leaf's approval gate/);
  assert.match(scope, /`--plan-only` or a planning-phase handoff never authorizes mutating leaves/);
  assert.match(scope, /Propagate the mode and current scoped context through routers/);
});

test('shared prompt defaults cannot override explicit data approval gates', () => {
  const policy = section(shared, '## Execution Style', '## Inline Shell');
  assert.match(policy, /Explicit approval gates take precedence/);
  assert.match(policy, /plan\/mutation, data-source removal, and deployment/);
  assert.match(policy, /Cancellation or dismissal stops the pending operation/);
  assert.match(policy, /empty or ambiguous answer requires clarification/);
  assert.match(policy, /already-approved scoped child calls do not repeat approvals/);
  assert.match(policy, /expanded scope returns to the owner for a new decision/);
  assert.doesNotMatch(policy, /empty\/cancel answer auto-proceeds|empty answer proceeds|default-yes/);
});

test('shared connector setup requires approved implementation and preserves supplied bindings', () => {
  const connector = section(shared, '## Connector Reference', '## Safety Guardrails');
  assert.doesNotMatch(connector, /Always run `\/list-connections` first/);
  assert.match(connector, /only in the approved implementation phase/);
  assert.match(connector, /Reuse a supplied connection ID or reference/);
  assert.match(connector, /Do not invoke it during planning, `--plan-only`, cancellation, or removal-only work/);
  assert.match(connector, /Approved data child calls reuse their scoped handoff without repeating\napproval/);
  assert.match(connector, /Direct operational `\/list-connections` requests keep their own workflow/);
});

test('data routers preserve the current request and proposal-only context without granting approval', () => {
  const router = skill('add-datasource');
  assert.match(router, /Forward the absolute `working_dir`, current request, owner\/phase\/scope,\n\s+supplied answers, and `--plan-only` or planning-phase status unchanged on every\n\s+handoff/);
  assert.match(router, /a saved plan or router choice is not consent to mutate/);
  assert.match(router, /Conflicting add\/refresh\/remove scopes return to the owner for separate calls/);
  const connector = skill('add-connector');
  assert.match(connector, /same `\$ARGUMENTS`, absolute `working_dir`,\ncurrent request, owner\/phase\/scope, and proposal-only mode/);
  assert.match(connector, /Do not continue this\nskill's workflow.*or infer execution approval from this routing decision/);
});

test('creation passes scoped approval and the app root to data leaves', () => {
  for (const [start, end, expected] of [
    ['Invoke skill: /add-dataverse', '`/add-dataverse` validates', /bound operation-manifest artifacts/],
    ['### Step 10 — Add connectors', '### Step 10b', /connector row and supplied/],
  ]) {
    const handoff = section(create, start, end);
    assert.match(handoff, /MOBILE_APP_ORCHESTRATING=1/);
    assert.match(handoff, /orchestrator: create-mobile-app/);
    assert.match(handoff, /working_dir: <working_dir>|`working_dir`/);
    assert.match(handoff, /--working-dir "?<working_dir>"?/);
    assert.match(handoff, /phase: implementation/);
    assert.match(handoff, expected);
  }
});

test('connector-owned actions and SharePoint schemas do not imply Dataverse schema', () => {
  assert.match(skill('add-connector'), /Action connectors and cloud flows do not imply Dataverse Data Model changes/);
  assert.match(skill('add-sharepoint'), /Keep SharePoint list\/library schemas in Connectors, not the Dataverse\nData Model/);
});

test('setup-datamodel saves every approved path and passes scope to its leaves', () => {
  const setup = skill('setup-datamodel');
  const planning = section(setup, '### Phase 2', '### Phase 4');
  assert.match(planning, /connector-only requests\ntake Path C/);
  assert.match(planning, /Preserve any existing Data Model section/);
  assert.doesNotMatch(planning, /On `ExitPlanMode` approval, write/);
  assert.match(setup, /save both approved sections to `native-app-plan.md`/);
  for (const [start, end] of [
    ['Invoke skill: /add-dataverse', '`/add-dataverse` creates'],
    ['Invoke skill: /add-connector', 'Run sequentially.'],
  ]) {
    const handoff = section(setup, start, end);
    assert.match(handoff, /MOBILE_APP_ORCHESTRATING=1/);
    assert.match(handoff, /orchestrator: setup-datamodel/);
    assert.match(handoff, /approved_scope:/);
  }
});

test('setup validates all Dataverse proposal paths before the one combined approval', () => {
  const setup = skill('setup-datamodel');
  const planning = section(setup, '### Phase 2', '### Phase 3');
  const gate = section(setup, '### Phase 4', '### Phase 5');
  const workflow = planning.indexOf('dataverse-change-planning.md');
  assert.ok(workflow >= 0 && workflow < planning.indexOf('#### Path A'));
  assert.ok(workflow < planning.indexOf('Task: mobile-app:data-model-architect'));
  assert.match(planning, /Path C, removal-only work, and a\nretained-service-only refresh skip schema planning and its artifacts/);
  assert.match(gate, /Dataverse proposal from any path[\s\S]*exit `0`\nbefore this gate/);
  const validate = gate.indexOf('validate-dataverse-planning-decisions.js');
  const proposalExit = gate.indexOf('**Proposal-only exit:**');
  const approval = gate.indexOf('Present the full plan');
  const save = gate.indexOf('- **Approved**');
  assert.ok(validate >= 0 && validate < proposalExit && proposalExit < approval && approval < save);
  assert.match(gate, /Connector-only, retirement-only, and refresh-only proposals[\s\S]*must not reuse stale schema-planning artifacts/);
  assert.match(gate, /Revisions repeat validation, not broad discovery or another\napproval ceremony/);
  assert.match(gate, /A saved plan or `--skip-planning` alone is not approval/);
  assert.doesNotMatch(planning, /EnterPlanMode|ExitPlanMode|--approval-receipt/);
});

test('connector aliases and operations preserve dedicated routing and dependency gates', () => {
  const connector = skill('add-connector');
  assert.match(connector, /shared_sharepointonline/);
  assert.match(connector, /shared_commondataserviceforapps/);
  assert.match(connector, /actions\/functions follow the discovery-only branch/);
  assert.doesNotMatch(connector, /npx expo install <missing-package>/);
  assert.match(connector, /Do not install\nnative packages absent from the template/);
  assert.match(connector, /Standalone removal must stop if\nit would leave broken consumers/);
});

test('Dataverse discovery executes before connector setup and ends the leaf', () => {
  const connector = skill('add-connector');
  const identify = section(connector, '### Step 2', '### Step 3');
  const setup = section(connector, '### Step 3', '### Step 4');
  assert.match(identify, /find-dataverse-api --search/);
  assert.match(identify, /STOP this leaf/);
  assert.match(identify, /Do not enter Step 3/);
  assert.ok(identify.indexOf('find-dataverse-api') < identify.indexOf('| Connector API name'));
  assert.doesNotMatch(setup, /find-dataverse-api/);
});

test('generic connector preserves supplied IDs and references before resolving a missing binding', () => {
  const setup = section(skill('add-connector'), '### Step 3', '**Classify the connector');
  assert.match(setup, /Supplied `--connection-id`[\s\S]*reuse that exact/);
  assert.match(setup, /Supplied `--connection-ref`[\s\S]*preserve that/);
  assert.match(setup, /skip `\/list-connections` and creation/);
  assert.match(setup, /Missing binding only:.*invoke `\/list-connections`/);
  assert.match(setup, /ambiguous supplied values return to the owner instead of creating a fallback/);
  assert.match(setup, /`--connection-ref '<connectionRef>'` on `add-data-source` only/);
  assert.match(setup, /backing ID for the approved reference/);
  assert.doesNotMatch(setup, /Run the `\/list-connections` skill/);
});

test('SharePoint reuses supplied bindings and emits the matching registration form', () => {
  const sharepoint = skill('add-sharepoint');
  const binding = section(sharepoint, '### Step 6:', '### Step 7:');
  assert.match(binding, /Supplied `--connection-id`[\s\S]*reuse the exact ID/);
  assert.match(binding, /Supplied `--connection-ref`[\s\S]*retain the exact/);
  assert.match(binding, /Missing binding only/);
  assert.match(binding, /skip `create-connection` and `\/list-connections`/);
  assert.match(binding, /Do not create another connection for discovery/);
  const add = section(sharepoint, '### Step 9:', '### Step 10:');
  assert.match(add, /Run only the applicable command/);
  assert.match(add, /--connection-id '<connectionId>'/);
  assert.match(add, /--connection-ref '<connectionRef>'/);
  assert.match(section(sharepoint, '### Step 7:', '### Step 8:'), /Skip this picker/);
  assert.match(section(sharepoint, '### Step 8:', '### Step 9:'), /Skip this picker/);
});

test('connector-only summary does not claim a nonexistent Dataverse manifest', () => {
  const summary = section(skill('setup-datamodel'), '### Phase 7', '## Reference');
  assert.match(summary, /Manifest as `not applicable`/);
  assert.match(summary, /<verified manifest path and updated\/unchanged status, or "not applicable">/);
  assert.doesNotMatch(summary, /Manifest\s+:\s+\.datamodel-manifest\.json/);
});

test('existing Dataverse plans are checked against the requested delta rather than replayed', () => {
  const dataverse = skill('add-dataverse');
  assert.match(dataverse, /restrict schema writes to the exact `approved_scope` delta/);
  assert.match(dataverse, /flag alone must not suppress standalone reconciliation/);
  assert.match(dataverse, /If the request adds nothing, verify the existing outcome and report a no-op/);
  assert.doesNotMatch(dataverse, /empty\/cancel input auto-proceeds/);
});

test('data-source removal is an explicit app-only retirement, not server deletion', () => {
  assert.match(removal, /shared-instructions\.md#data-source-invocation-scope/);
  assert.doesNotMatch(removal, /#app-feature-entry-points|(?:app-edit-routing|native-artifact-compatibility)\.md/);
  assert.match(removal, /does not authorize deleting the server table,\s+its columns\/records/);
  assert.match(removal, /A missing row in a planner's output is a candidate, not consent/);
  assert.match(removal, /lookup\/identity reads, and offline requirements/);
  assert.match(removal, /Dynamic or ambiguous usage is a blocker/);
  assert.match(removal, /Never mutate\s+configuration\/generated files during\s+planning or `--plan-only`/);
});

test('data-source retirement requires consumers to be retired before unregistering', () => {
  const consumers = section(removal, '## 2.', '## 3.');
  assert.match(consumers, /responsible app workflow adds\/refreshes replacement sources first/);
  assert.match(consumers, /updates or removes the approved consumers and verifies they no longer depend\s+on the retiring source/);
  assert.match(consumers, /Keep the old binding available until those source edits are complete/);
  assert.match(consumers, /Only then call the appropriate leaf in removal mode/);
  assert.match(consumers, /removal must stop if consumers remain/);
  assert.match(consumers, /cannot be staged safely,\nreturn the conflict to the owner for an explicit migration plan/);
});

for (const name of ['add-connector', 'add-dataverse', 'add-sharepoint']) {
  test(`${name} dispatches removals before its normal add workflow`, () => {
    const content = skill(name);
    const branch = section(content, '**Removal branch:**', '\n## ');
    assert.match(branch, /--remove/);
    assert.match(branch, /data-source-removal\.md/);
    assert.match(branch, /return/);
    assert.ok(content.indexOf('**Removal branch:**') < content.indexOf('**Telemetry checkpoint:'));
  });
  test(`${name} returns from targeted refresh before the add workflow`, () => {
    const content = skill(name);
    const branch = section(content, '**Refresh branch:**', '\n## ');
    assert.match(branch, /--refresh/);
    assert.match(branch, /data-source-removal\.md#refresh-a-retained-source/);
    assert.match(branch, /--data-source-name/);
    assert.match(branch, /returns before Steps/);
    assert.match(branch, /(?:do not|Do not)[\s\S]*add-data-source/);
    assert.ok(content.indexOf('**Refresh branch:**') < content.indexOf('**Telemetry checkpoint:'));
  });
}

test('refresh preserves registration identity and never falls back to an add', () => {
  const refresh = section(removal, '## Refresh a retained source', '## 1.');
  assert.match(refresh, /`--plan-only` or a planning-phase handoff returns the proposed\s+refresh without executing it/);
  assert.match(refresh, /Require one unambiguous stored\nregistration/);
  assert.match(refresh, /name-only selector could refresh unrelated registrations, STOP/);
  assert.match(refresh, /never guess from a display label or silently add an absent source/);
  assert.match(refresh, /per-source failure output/);
  assert.match(refresh, /preserve unrelated registration identities/);
  assert.match(refresh, /do not repair generator output by hand or retry through addition/);
  assert.match(skill('add-datasource'), /--refresh --data-source-name "<registered-name>"/);
});

test('the router and data-only orchestrator retain the removal operation', () => {
  assert.match(skill('add-datasource'), /matching leaf's removal branch/);
  const dataOnly = skill('setup-datamodel');
  assert.match(dataOnly, /Skip this phase for a removal-only delta/);
  const retirement = section(dataOnly, '### Phase 6.25', '### Phase 6.5');
  assert.match(retirement, /--remove/);
  assert.match(retirement, /MOBILE_APP_ORCHESTRATING=1/);
  assert.match(retirement, /if any remain, stop/);
});

test('removal uses CLI-owned cleanup with explicit consent and verifies silent no-ops', () => {
  assert.match(removal, /delete-data-source --api-id dataverse --data-source-name '<registered-name>' --force --non-interactive/);
  assert.match(removal, /--sql-stored-procedure '<procedure>' --force --non-interactive/);
  assert.match(removal, /remove-flow --flow-id '<flow-id>' --force --non-interactive/);
  assert.match(removal, /`--non-interactive` alone is not removal consent/);
  assert.match(removal, /Do not manually delete `src\/generated\/` files/);
  assert.match(removal, /flat CLI can return exit 0 for a not-found\/no-op removal/);
  assert.match(removal, /same-named registrations in other\nconnectors\/datasets/);
  assert.match(removal, /empty references used by remaining flows/);
});

test('schema-map generation is distinct from service refresh and removal', () => {
  assert.match(removal, /does not infer unused tables from screen code, unregister sources/);
  assert.match(removal, /refresh-data-source --data-source-name '<registered-name>'/);
  assert.match(removal, /npm run generate-schemas\nnpx tsc --noEmit/);
  assert.match(removal, /including when the\nlast source was removed/);
});

test('verified removal reconciles the app inventory without faking offline cleanup', () => {
  assert.match(removal, /remove retired app-inventory entries while preserving verified facts/);
  assert.match(removal, /valid empty\n`tables` array/);
  assert.match(removal, /do not reuse old plan-bound operation manifests/i);
  assert.match(removal, /detects additions, not excess profile tables/);
  assert.match(removal, /do not silently remove them or edit the local\nsnapshot to pretend the server changed/);
});

test('generator ownership names exact CLI verbs and their command forms', () => {
  const ownership = section(shared, '### Mandatory changed-file validation', '### MUST (required');
  const commands = section(shared, '### Exact generated-output commands', 'Other discovery commands:');
  for (const verb of ['init', 'add-data-source', 'refresh-data-source', 'delete-data-source', 'add-flow', 'remove-flow']) {
    assert.ok(ownership.includes(`npx --no-install power-apps ${verb}`), verb);
    assert.ok(commands.includes(`npx --no-install power-apps ${verb}`), verb);
  }
  assert.match(ownership, /not modified afterward by the skill or its subagents/);
  assert.match(commands, /command templates, not a batch to run/);
  assert.match(commands, /--force --non-interactive/);
  assert.match(commands, /--api-id dataverse --org-url '<environment-url>' --resource-name '<table-logical-name>' --non-interactive/);
  assert.match(commands, /`npm run generate-schemas` is the separate template command/);
});

test('the exact-command guidance adds no CLI version preflight or upgrade workflow', () => {
  const cli = section(shared, '## CLI Invocation', '## Command Failure Handling');
  assert.doesNotMatch(cli, /project-local CLI gate|--version|node_modules\/@microsoft\/power-apps-cli\/package\.json/);
  assert.match(cli, /Do not substitute a global binary/);
  assert.match(cli, /If the command is unsupported, report\nthe error/);
  assert.match(cli, /do not guess aliases, strip safety flags, or install another CLI/);
});
