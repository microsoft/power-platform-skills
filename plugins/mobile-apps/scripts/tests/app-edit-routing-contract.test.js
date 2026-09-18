'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8');
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

// These are instruction-contract tests, not live native-app or model evaluations.
// Keep all alternate feature entry points covered so a dedicated leaf cannot
// silently bypass the same edit gate that the generic router uses.
for (const name of [
  'add-native', 'add-connector', 'add-datasource', 'add-dataverse',
  'add-sharepoint', 'setup-datamodel', 'design-system',
]) {
  test(`${name} gates full integration before executing its leaf workflow`, () => {
    const content = skill(name);
    const entry = section(content, '**Entry routing:**', '\n## ');
    assert.match(entry, /app-edit-routing\.md/);
    assert.match(entry, /entry-choice\s+gate/);
    assert.match(entry, /\/edit-app/);
    assert.match(content.match(/^allowed-tools: (.+)$/m)[1], /\bSkill\b/);
    assert.ok(content.indexOf('**Entry routing:**') < content.indexOf('**Telemetry checkpoint:'));
  });
}

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

test('connector aliases and operations preserve dedicated routing and dependency gates', () => {
  const connector = skill('add-connector');
  assert.match(connector, /shared_sharepointonline/);
  assert.match(connector, /shared_commondataserviceforapps/);
  assert.match(connector, /actions\/functions follow the discovery-only branch/);
  assert.doesNotMatch(connector, /npx expo install <missing-package>/);
  assert.match(connector, /Do not install\nnative packages absent from the template/);
  assert.match(connector, /implementation-only removal must stop if it would leave broken consumers/);
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
}

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
