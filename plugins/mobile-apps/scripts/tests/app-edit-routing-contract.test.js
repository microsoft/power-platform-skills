'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isInvocable, readInvocationMetadata } = require('../lib/mobileapp-hook-utils');

const pluginRoot = path.resolve(__dirname, '../..');
// Windows checkouts can use CRLF; the prose contracts should not depend on Git's EOL setting.
const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8').replace(/\r\n?/g, '\n');
const skill = (name) => read(`skills/${name}/SKILL.md`);
const routing = read('shared/references/app-edit-routing.md');
const removal = read('shared/references/data-source-removal.md');
const edit = skill('edit-app');
const create = skill('create-mobile-app');

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing section: ${start}`);
  assert.ok(endIndex > startIndex, `Missing section end: ${end}`);
  return text.slice(startIndex, endIndex);
}

for (const [name, ending] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`Markdown reader preserves the same contracts with ${name} line endings`, (t) => {
    const file = 'shared/references/app-edit-routing.md';
    const content = '# Routing\n\n## Direct requests\nfirst\nsecond\n\n## Orchestrated calls\n';
    t.mock.method(fs, 'readFileSync', (filePath, encoding) => {
      assert.equal(filePath, path.join(pluginRoot, file));
      assert.equal(encoding, 'utf8');
      return content.replace(/\n/g, ending);
    });
    const actual = read(file);
    assert.equal(actual, content);
    assert.match(section(actual, '## Direct requests', '## Orchestrated calls'), /first\nsecond/);
  });
}

function assertSharedEntry(content, name) {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '').trimStart();
  const firstLine = body.split('\n')[0];
  assert.match(firstLine, /\[shared-instructions\.md\]\([^)]+\/shared-instructions\.md\)/, `${name}: shared policy must be the first instruction`);
  assert.match(firstLine, /read (?:this |both )?first/i, `${name}: read-first prerequisite`);
  assert.match(content.match(/^allowed-tools: (.+)$/m)?.[1] || '', /\bRead\b/, `${name}: allow reading policy`);
}

// Discover invocable skills instead of allowing new entry points to escape a
// fixed list. This verifies instructions, not whether a model obeys them.
const invocableSkills = fs.readdirSync(path.join(pluginRoot, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && isInvocable(readInvocationMetadata(
    path.join(pluginRoot, 'skills', entry.name, 'SKILL.md'),
  )))
  .map((entry) => entry.name)
  .sort();

for (const name of invocableSkills) {
  test(`${name} starts with the shared entry preflight`, () => {
    const content = skill(name);
    // The cross-plugin telemetry preference wrapper has no app workflow.
    if (name === 'telemetry') {
      assert.match(content, /\*\*Workflow:.*telemetry-workflow\.md/);
      return;
    }
    assertSharedEntry(content, name);
    if (content.includes('**Entry routing:**')) {
      const entry = content.split('**Entry routing:**')[1].split('\n\n')[0];
      assert.match(entry, /shared-instructions\.md#app-feature-entry-points/);
      assert.doesNotMatch(entry, /Offer|implementation-only|full integration|cancel/);
      assert.ok(content.indexOf('**Entry routing:**') < content.indexOf('**Telemetry checkpoint:'));
    }
  });
}

test('a future skill cannot omit, defer, or disable reading shared policy', () => {
  const valid = '---\nallowed-tools: Read, Bash\n---\n\n**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** - read first.\n\n## Workflow\n';
  assert.doesNotThrow(() => assertSharedEntry(valid, 'future-feature'));
  assert.throws(() => assertSharedEntry(valid.replace('**Shared instructions:', 'Run auth first.\n**Shared instructions:'), 'future-feature'));
  assert.throws(() => assertSharedEntry(valid.replace('shared-instructions.md', 'other.md'), 'future-feature'));
  assert.throws(() => assertSharedEntry(valid.replace('read first', 'optional'), 'future-feature'));
  assert.throws(() => assertSharedEntry(valid.replace('Read, Bash', 'Bash'), 'future-feature'));
});

test('shared policy classifies future feature skills before operational commands', () => {
  const shared = read('shared/shared-instructions.md');
  const preflight = section(shared, '## App feature entry points', '## Version Check');
  assert.match(preflight, /before any workflow commands or app\/cloud writes/);
  assert.match(preflight, /cannot be loaded, STOP/);
  assert.match(preflight, /applies to new skills too/);
  assert.match(preflight, /read and execute \[app-edit-routing\.md\]/);
  assert.match(preflight, /Do not repeat or narrow the\n\s+choices in individual skills/);
  assert.match(preflight, /Pure operational\/configuration requests/);
  assert.match(preflight, /`--plan-only` or a planning-phase handoff never authorizes mutating leaves/);
  assert.match(routing, /includes future feature skills/);
});

test('direct requests preserve intent and do not infer implementation-only work', () => {
  assert.match(routing, /original request,\nall arguments, supplied answers/);
  assert.match(routing, /Naming a capability, connector, table, or package does not establish/);
  assert.match(routing, /Do not infer this mode merely because the user did not mention screens/);
  assert.match(routing, /Do not re-scaffold over the app/);
  assert.match(routing, /UI integration was intentionally\nnot performed/);
});

test('the entry choice precedes costly work and requires explicit integration consent', () => {
  const direct = section(routing, '## Direct requests', '## Orchestrated calls');
  assert.match(direct, /before loading\nor invoking `\/edit-app`/);
  assert.match(direct, /Do not run health\/type checks, scan\nall screens\/services/);
  assert.match(direct, /precedes operational version\/auth checks/);
  for (const choice of ['Implementation only', 'Full app integration', 'Cancel']) {
    assert.ok(direct.includes(`| ${choice} |`));
  }
  assert.match(direct, /costs more than implementation-only work/);
  assert.match(direct, /Silence, dismissal, or an ambiguous answer is not\nconsent/);
  assert.match(direct, /Only after \*\*Full app integration\*\* is selected/);
  assert.match(direct, /Stop without invoking `\/edit-app`, running implementation commands, or changing files/);
});

test('shared prompt defaults cannot override explicit consent gates', () => {
  const policy = section(
    read('shared/shared-instructions.md'),
    '## Execution Style',
    '## Inline Shell',
  );
  assert.match(policy, /Explicit approval gates take precedence/);
  assert.match(policy, /entry-choice, plan\/mutation, data-source removal, and deployment/);
  assert.match(policy, /Cancellation or dismissal stops the pending operation/);
  assert.match(policy, /empty or ambiguous answer requires clarification/);
  assert.match(policy, /already-approved scoped child calls do not repeat approvals/);
  assert.doesNotMatch(policy, /empty\/cancel answer auto-proceeds|empty answer proceeds|default-yes/);
});

test('shared connector setup follows entry consent and approved implementation', () => {
  const connector = section(
    read('shared/shared-instructions.md'),
    '## Connector Reference',
    '## Safety Guardrails',
  );
  assert.doesNotMatch(connector, /Always run `\/list-connections` first/);
  assert.match(connector, /entry-choice gate precedes `\/list-connections`/);
  assert.match(connector, /only in the approved implementation phase/);
  assert.match(connector, /Reuse a supplied connection ID or reference/);
  assert.match(connector, /Do not invoke it during planning, `--plan-only`, cancellation, or removal-only work/);
  assert.match(connector, /Direct operational `\/list-connections` requests keep their own workflow/);
});

test('implementation-only choice is forwarded rather than silently escalated', () => {
  const direct = section(routing, '## Direct requests', '## Orchestrated calls');
  assert.match(direct, /forward\n`--implementation-only` through any router/);
  assert.match(direct, /Do not silently escalate\nto `\/edit-app`/);
  assert.match(direct, /entry choice approves entering that workflow, not its mutations/);
  assert.match(direct, /explicit approval for data-source removals/);
});

test('current approved create and edit handoffs do not repeat the entry question', () => {
  const orchestrated = section(routing, '## Orchestrated calls', '## Conditional impact');
  assert.match(orchestrated, /Check valid caller context before the entry-choice gate/);
  assert.match(orchestrated, /approved\n`\/create-mobile-app` or `\/edit-app` child call skips the entry question/);
  assert.match(orchestrated, /Do not add a second integration\/cost question/);
  assert.match(edit, /Reuse\n`entry_choice: full-integration`/);
  assert.match(edit, /direct `\/edit-app` invocation also needs no entry-choice menu/);
});

test('orchestration context is scoped, forwarded, and not an approval bypass', () => {
  assert.match(routing, /MOBILE_APP_ORCHESTRATING=1/);
  for (const field of ['orchestrator', 'working_dir', 'phase', 'approved_scope']) {
    assert.ok(routing.includes(`\`${field}\``));
  }
  assert.match(routing, /Routers forward the same context/);
  assert.match(routing, /internal\nnative helpers inherit it/);
  assert.match(routing, /never\ndelegates back to `\/edit-app`/);
  assert.match(routing, /A bare\/stale environment value or `--skip-planning` without a matching current/);
  assert.match(routing, /Do not persist the marker/);
});

test('create calls native and data leaves without routing its partial app into edit', () => {
  for (const [start, end, expected] of [
    ['Invoke skill: /add-native', 'Run sequentially.', /approved capability row/],
    ['Invoke skill: /add-dataverse', '`/add-dataverse` validates', /bound operation-manifest artifacts/],
    ['### Step 10 — Add connectors', '### Step 10b', /connector row and supplied/],
  ]) {
    const handoff = section(create, start, end);
    assert.match(handoff, /MOBILE_APP_ORCHESTRATING=1/);
    assert.match(handoff, /orchestrator: create-mobile-app/);
    assert.match(handoff, /phase: implementation/);
    assert.match(handoff, expected);
  }
  assert.match(create, /children must use this context rather than mistake creation for a standalone\nedit/);
});

test('edit planning defers connector and design execution until approval', () => {
  const planning = section(edit, '### Step 2 — Re-plan', '### Step 3 — Gate');
  const design = section(edit, '**If the user picks (d) Design:**', '### Step 2 — Re-plan');
  assert.match(planning, /Do not execute connector skills, create connections, or generate services/);
  assert.doesNotMatch(planning, /read and execute `\/add-/);
  assert.match(design, /Steps 2-4 before executing `\/design-system` in Step 5/);
  assert.match(design, /during `--plan-only`/);
  assert.match(edit, /inspection-only gate/);
  assert.match(edit, /Run only operations in the approved delta/);
  assert.match(edit, /If `--plan-only` is present, do not invoke the configuration skill/);
});

test('edit validates scoped Dataverse planning before its existing gate and preserves docs-only approval', () => {
  const planning = section(edit, '### Step 2 — Re-plan', '### Step 3 — Gate');
  const gate = section(edit, '### Step 3 — Gate', '### Step 4 — Write');
  const save = section(edit, '### Step 4 — Write', '### Step 5 — Apply');
  assert.ok(planning.indexOf('dataverse-change-planning.md') < planning.indexOf('Spawn agent:'));
  assert.match(planning, /structured Dataverse context\/revision signals[\s\S]*before generic retry limits/);
  assert.match(planning, /Every Data Model result, including inline output, must pass[\s\S]*`DONE` alone never authorizes Step 3/);
  assert.match(gate, /require exit `0` from\n`validate-dataverse-planning-decisions\.js`[\s\S]*before showing this gate/);
  assert.ok(gate.indexOf('validate-dataverse-planning-decisions.js') < gate.indexOf('Show the user'));
  assert.match(gate, /no extra create-flow approval gate/);
  assert.match(gate, /If cancel → STOP, leave the plan and app untouched/);
  assert.match(gate, /`--plan-only`[\s\S]*"Approve and save plan only"[\s\S]*stop after Step 4/);
  assert.match(save, /preserve all other sections verbatim/);
  assert.match(save, /`--plan-only`[\s\S]*`plan_only: true`[\s\S]*and stop/);
  assert.match(save, /A plan-only save does not create this implementation approval context/);
  assert.ok(save.indexOf('and stop') < save.indexOf('freeze the shared workflow'));
  assert.doesNotMatch(planning, /Invoke skill: \/add-dataverse|--approval-receipt|--operation-manifest/);
});

test('planning-phase edit children return to their owner before the direct docs-only approval path', () => {
  const gate = section(edit, '### Step 3 — Gate', '### Step 4 — Write');
  const childReturn = section(gate, 'If this is a planning-phase handoff from another owner', 'Show the user');
  const directGate = gate.slice(gate.indexOf('Show the user'));
  assert.match(childReturn, /return the validated\nproposal and concerns to that owner now/);
  assert.match(childReturn, /without saving the live plan or\nopening an implementation gate/);
  assert.match(childReturn, /Do not turn the caller's planning consent\ninto approval to apply the edit/);
  assert.match(childReturn, /A direct `--plan-only` request retains the\nexplicit plan-document approval below/);
  assert.doesNotMatch(childReturn, /Approve and apply|Approve and save plan only|Invoke skill:|--skip-planning/);
  const validation = gate.indexOf('validate-dataverse-planning-decisions.js');
  const returnToOwner = gate.indexOf('If this is a planning-phase handoff');
  const localGate = gate.indexOf('Show the user');
  assert.ok(validation >= 0 && validation < returnToOwner && returnToOwner < localGate);
  assert.match(directGate, /If cancel → STOP, leave the plan and app untouched/);
  assert.match(directGate, /If `\$ARGUMENTS` includes `--plan-only`, change option \(a\) to "Approve and save plan only" and stop after Step 4/);
  assert.ok(directGate.indexOf('Approve this edit') < directGate.indexOf('Approve and save plan only'));
});

test('connector and native intent do not unconditionally create Dataverse schema', () => {
  for (const expected of [
    /Teams\/email action, profile lookup, or cloud flow/,
    /SQL\/Excel\/SharePoint data/,
    /not automatically Dataverse/,
    /missing generated services/,
    /Ask about retention rather than assuming/,
  ]) {
    assert.match(routing, expected);
  }
  assert.match(edit, /\*\*Data Model is conditional\.\*\*/);
  assert.match(edit, /Preserve unaffected Data Model content verbatim/);
  assert.match(edit, /ask about retention, then update Data Model only if/);
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
  assert.doesNotMatch(planning, /EnterPlanMode|ExitPlanMode|--approval-receipt/);
});

test('connector aliases and operations preserve dedicated routing and dependency gates', () => {
  const connector = skill('add-connector');
  assert.match(connector, /shared_sharepointonline/);
  assert.match(connector, /shared_commondataserviceforapps/);
  assert.match(connector, /actions\/functions follow the discovery-only branch/);
  assert.doesNotMatch(connector, /npx expo install <missing-package>/);
  assert.match(connector, /Do not install\nnative packages absent from the template/);
  assert.match(connector, /implementation-only removal must stop if it would leave broken consumers/);
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

test('every explicit create/edit child context includes its working directory', () => {
  for (const [name, content] of [['create-mobile-app', create], ['edit-app', edit]]) {
    const contexts = [...content.matchAll(/(?:Context|Environment):\n([\s\S]*?)\nArguments:\n([\s\S]*?)\n```/g)];
    assert.ok(contexts.length > 0, `${name} handoff coverage`);
    for (const [, context, args] of contexts) {
      assert.match(context, /working_dir: <working_dir>/, name);
      assert.match(args, /--working-dir "?<working_dir>"?/, name);
    }
  }
});

test('connector-only summary does not claim a nonexistent Dataverse manifest', () => {
  const summary = section(skill('setup-datamodel'), '### Phase 7', '## Reference');
  assert.match(summary, /Manifest as `not applicable`/);
  assert.match(summary, /<verified manifest path and updated\/unchanged status, or "not applicable">/);
  assert.doesNotMatch(summary, /Manifest\s+:\s+\.datamodel-manifest\.json/);
});

test('existing native wrappers and Dataverse plans are checked against the requested delta', () => {
  assert.match(skill('add-native'), /inspect its exports against the approved capability\ncontract/);
  assert.doesNotMatch(skill('add-native'), /regeneration skipped — wrapper already exists/);
  const dataverse = skill('add-dataverse');
  assert.match(dataverse, /restrict schema writes to the exact `approved_scope` delta/);
  assert.match(dataverse, /flag alone must not suppress standalone reconciliation/);
  assert.doesNotMatch(dataverse, /empty\/cancel input auto-proceeds/);
});

test('design changes return screen impact and use the existing host theme integration', () => {
  const design = skill('design-system');
  const refresh = read('skills/design-system/references/refresh-flow.md');
  assert.doesNotMatch(design, /\/tweak-screen|src\/theme\/ThemeProvider\.tsx/);
  assert.match(design, /runtime wiring, affected screen changes, and final verification/);
  assert.match(design, /Drift detection \(Mode A\/B/);
  assert.match(refresh, /before either spec or token write/i);
  assert.match(refresh, /Cancellation leaves both artifacts unchanged/);
  assert.match(refresh, /paired pre-write snapshot/);
  assert.match(refresh, /screen constraints/);
});

test('configuration-only workflows retain their own approvals and return to their caller', () => {
  assert.match(routing, /Do not route a\npure operational request through app planning/);
  assert.match(skill('setup-app-insights'), /MOBILE_APP_ORCHESTRATING=1 AND explicit edit-app caller context/);
  assert.match(skill('setup-app-insights'), /Configuration approval remains owned by Step 3/);
});

test('data-source removal is an explicit app-only retirement, not server deletion', () => {
  assert.match(removal, /does not authorize deleting the server table, its columns\/records/);
  assert.match(removal, /A missing row in a planner's output is a candidate, not consent/);
  assert.match(removal, /lookup\/identity reads, and offline requirements/);
  assert.match(removal, /Dynamic or ambiguous usage is a blocker/);
  assert.match(removal, /Never mutate\nconfiguration\/generated files during planning or `--plan-only`/);
});

test('retired consumers are updated before the edit unregisters their sources', () => {
  const mutations = section(edit, '### Step 5 — Apply app mutations', '### Step 6 — Rebuild');
  const consumers = section(edit, '### Step 6 — Rebuild', '### Step 6.5 — Unregister');
  const retirement = section(edit, '### Step 6.5 — Unregister', '### Step 7 — Verify');
  assert.match(mutations, /Step 5 applies additions\/refreshes, not removals/);
  assert.match(mutations, /Never add a retiring table to the offline profile/);
  assert.match(consumers, /Pass the approved retiring service\/source list/);
  assert.match(retirement, /After Step 6 updates\/removes the\nconsumers/);
  assert.match(retirement, /Refresh the Generated Services snapshot again/);
  assert.match(retirement, /no-op, partial cleanup, or remaining consumer blocks completion/);
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
  assert.match(refresh, /`--plan-only` returns the proposed refresh without executing it/);
  assert.match(refresh, /Require one unambiguous stored\nregistration/);
  assert.match(refresh, /name-only selector could refresh unrelated registrations, STOP/);
  assert.match(refresh, /never guess from a display label or silently add an absent source/);
  assert.match(refresh, /per-source failure output/);
  assert.match(refresh, /preserve unrelated registration identities/);
  assert.match(refresh, /do not repair generator output by hand or retry through addition/);
  assert.match(skill('add-datasource'), /--refresh --data-source-name "<registered-name>"/);
  assert.match(skill('debug-app'), /--refresh --data-source-name "<registered-name>"/);
  assert.match(edit, /do not route refreshes through addition/);
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
  assert.match(skill('debug-app'), /do not resurrect retired sources during repair/i);
  assert.doesNotMatch(skill('debug-app'), /tell the user to re-run `npm run generate-schemas`; if the error reproduces/);
});

test('verified removal reconciles the app inventory without faking offline cleanup', () => {
  assert.match(removal, /remove retired app-inventory entries while preserving verified facts/);
  assert.match(removal, /valid empty\n`tables` array/);
  assert.match(removal, /do not reuse old plan-bound operation manifests/i);
  assert.match(removal, /detects additions, not excess profile tables/);
  assert.match(removal, /do not silently remove them or edit the local\nsnapshot to pretend the server changed/);
});

test('generator ownership names exact CLI verbs and their command forms', () => {
  const shared = read('shared/shared-instructions.md');
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
  const cli = section(read('shared/shared-instructions.md'), '## CLI Invocation', '## Command Failure Handling');
  assert.doesNotMatch(cli, /project-local CLI gate|--version|node_modules\/@microsoft\/power-apps-cli\/package\.json/);
  assert.match(cli, /Do not substitute a global binary/);
  assert.match(cli, /If the command is unsupported, report\nthe error/);
  assert.match(cli, /do not guess aliases, strip safety flags, or install another CLI/);
});

test('all mobile instruction files use the mobile-specific orchestration marker', () => {
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.name.endsWith('.md')) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /CODE_APPS_NATIVE_ORCHESTRATING/, file);
      }
    }
  }
  inspect(path.join(pluginRoot, 'skills'));
  inspect(path.join(pluginRoot, 'shared'));
});
