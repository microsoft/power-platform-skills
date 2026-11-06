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
const shared = read('shared/shared-instructions.md');
const routing = read('shared/references/app-edit-routing.md');
const removal = read('shared/references/data-source-removal.md');
const pluginGuidance = read('AGENTS.md');
const templateGuidance = read('template/AGENTS.md');
const edit = skill('edit-app');
const create = skill('create-mobile-app');
const pluginCheck = '> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` - if it outputs a message, show it to the user before proceeding.';

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing section: ${start}`);
  assert.ok(endIndex > startIndex, `Missing section end: ${end}`);
  return text.slice(startIndex, endIndex);
}

function creationStateRow(content, state) {
  const routing = section(content, '## Fresh-template working-directory mode', '## TypeScript Gate Policy');
  const row = routing.split('\n').find(line => line.startsWith(`| ${state} |`));
  assert.ok(row, `Missing creation state: ${state}`);
  const [, , detection, action] = row.split('|').map(cell => cell.trim());
  return { row, detection, action };
}

function assertCreationStateRouting(content) {
  const fresh = creationStateRow(content, 'Fresh template');
  assert.match(fresh.detection, /Confirmed new-app intent/);
  assert.match(fresh.detection, /confirmed uncustomized starter/);
  assert.match(fresh.action, /only when every condition is satisfied/);
  assert.match(fresh.detection, /approved creation plan and its planning artifacts are allowed/);

  const existing = creationStateRow(content, 'Already-created app');
  assert.match(existing.detection, /Existing-app intent or confirmed app customizations/);
  assert.match(existing.detection, /even when generated markers are missing/);
  assert.doesNotMatch(existing.detection, /native-app-plan\.md/);
  const continuation = creationStateRow(content, 'Creation continuation');
  assert.match(continuation.detection, /Explicit creation-continuation intent/);
  assert.match(continuation.detection, /not a request to edit an existing app/);
  assert.match(continuation.action, /matching unfinished creation progress/);

  const entry = section(content, '### Step 0 ', '### Step 1 ');
  assert.match(entry, /Apply the state-routing table above once/);
  assert.match(entry, /Classify the original request before\s+considering a creation resume/);
  const handoff = entry.indexOf('**Existing-app changes leave this skill before resume handling.**');
  const resume = entry.indexOf('#### Creation continuation');
  assert.ok(handoff >= 0 && resume > handoff, 'Existing-app handoff must precede resume handling');
  assert.match(entry, /return without entering Step 1 or modifying creation progress/);
  assert.match(entry, /Pre-initialization creation may have an approved plan and saved planning\s+progress without a memory bank/);
  assert.match(entry, /Completed creation[\s\S]*no unfinished creation to resume/);
  assert.match(entry, /Missing or conflicting progress[\s\S]*then stop/);
  assert.match(entry, /Reopen the build plan only after continuation approval/);
  assert.doesNotMatch(entry, /\*\*Bank absent\*\*.*fresh project|highest-numbered completed step|The bank is the only resume mechanism/);
  assert.doesNotMatch(entry, /If any already-created-app marker[\s\S]*STOP and tell the user to materialize a fresh template/);
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
  let body = content.replace(/^---\n[\s\S]*?\n---\n/, '').trimStart();
  if (body.startsWith(`${pluginCheck}\n\n`)) body = body.slice(pluginCheck.length).trimStart();
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
  assert.doesNotThrow(() => assertSharedEntry(valid, 'data-workflow'));
  assert.doesNotThrow(() => assertSharedEntry(valid.replace('**Shared instructions:', `${pluginCheck}\n\n**Shared instructions:`), 'data-workflow'));
  assert.throws(() => assertSharedEntry(valid.replace('**Shared instructions:', `${pluginCheck}\n\nRun auth first.\n**Shared instructions:`), 'data-workflow'));
  assert.throws(() => assertSharedEntry(valid.replace('**Shared instructions:', 'Run auth first.\n**Shared instructions:'), 'data-workflow'));
  assert.throws(() => assertSharedEntry(valid.replace('shared-instructions.md', 'other.md'), 'data-workflow'));
  assert.throws(() => assertSharedEntry(valid.replace('read first', 'optional'), 'data-workflow'));
  assert.throws(() => assertSharedEntry(valid.replace('Read, Bash', 'Bash'), 'data-workflow'));
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

test('app guidance selects any matching advertised skill without requiring slash commands', () => {
  const guidance = section(
    templateGuidance,
    '## Route natural-language requests to available skills',
    '## Identify the app state first',
  );
  assert.match(guidance, /do not need to type a slash command/);
  assert.match(guidance, /folder alone does not start a workflow/);
  assert.match(guidance, /app state against advertised skill descriptions/);
  assert.match(guidance, /most specific matching workflow/);
  assert.match(guidance, /exact advertised skill name and namespace/);
  assert.match(guidance, /respect its invocation\s+restrictions/);
  assert.match(guidance, /Hidden implementation helpers[\s\S]*do not invoke them directly/);
  assert.match(guidance, /required entry consent is captured, invoke the matching\s+skill/);
  assert.match(guidance, /Do not merely suggest its command/);
  assert.match(guidance, /Forward the original request[\s\S]*`working_dir`/);
  assert.match(guidance, /Do not restart routing once a matching skill is running/);
  assert.match(guidance, /invocations and approved children; let that skill own its workflow/);
  assert.match(guidance, /not an exhaustive list or closed allowlist/);
  assert.match(guidance, /Future or custom skills advertised by the host can match without a table entry/);
  assert.match(guidance, /multiple workflows fit but differ in scope, ask before choosing/);
  assert.match(guidance, /If none matches, continue only authorized bounded work/);
  assert.match(guidance, /never install or enable skills automatically/);
  assert.match(guidance, /Do not add a separate approval prompt just to choose or load a matching skill/);
  assert.match(guidance, /Keep the workflow's existing scope\/cost gates/);
  assert.match(shared, /host-advertised skill descriptions/);
  assert.match(shared, /Future or custom advertised workflows remain eligible/);
  assert.match(shared, /Invoke a matching skill\s+instead of merely recommending its command, after required entry consent/);
  assert.match(shared, /do not force unrelated intents through `\/edit-app`/i);
  assert.match(shared, /already-running matching skill owns its workflow; do not invoke it again/);
  assert.match(shared, /re-dispatch an approved\s+child from its current owner/);
  assert.match(pluginGuidance, /Natural-language routing is not a fixed skill list/);
  assert.match(pluginGuidance, /including future\/custom workflows not in the example table/);
});

test('automatic skill invocation is not Dataverse mutation or installation approval', () => {
  const approvals = section(
    templateGuidance,
    '## Keep operation approvals separate from routing',
    '## Identify the app state first',
  );
  assert.match(approvals, /every selected workflow, including future\/custom skills/);
  assert.match(approvals, /Confirm the exact target and proposed scope before cloud\/data mutations/);
  assert.match(approvals, /changed targets or expanded scope need renewed approval/);
  assert.match(approvals, /Dataverse work must use a matching data-workflow skill/);
  assert.match(approvals, /validate the selected environment and tenant/);
  assert.match(approvals, /inventory for reuse before proposing changes/);
  assert.match(approvals, /exact schema, record,\s+connection, or app-binding changes/);
  assert.match(approvals, /mutation approval\s+before writing/);
  assert.match(approvals, /target is missing or conflicting, stop and clarify/);
  assert.match(approvals, /Honor `--plan-only`/);
  assert.match(approvals, /Never fabricate `approved_scope`, approval\s+receipts, or caller context/);
  assert.match(approvals, /Cancellation, dismissal, or unclear consent stops the pending operation/);
  const unavailable = section(templateGuidance, '## If skills are unavailable', '## Respect code ownership');
  assert.match(unavailable, /required data-workflow skill is unavailable or cannot load/);
  assert.match(unavailable, /do not replace\s+it with a generic editor or ad-hoc CLI\/HTTP mutations/);
  assert.match(unavailable, /blocked until the required workflow and prerequisites are available/);
  assert.match(shared, /Do not add a separate approval prompt just to select or load a matching skill/);
  assert.match(shared, /Automatic routing never creates `approved_scope`, approval\s+receipts, or caller context/);
  const dataScope = section(shared, '## Data-source invocation scope', '## Version Check');
  assert.match(dataScope, /Dataverse work requires a matching data-workflow skill/);
  assert.match(dataScope, /before obtaining mutation approval/);
  assert.match(dataScope, /Missing\/conflicting\s+target context requires clarification/);
  assert.match(dataScope, /never substitute a generic editor or ad-hoc\s+CLI\/HTTP mutations/);
  assert.match(dataScope, /Installation approval is not approval of Dataverse changes/);
});

test('fresh starters do not enter the existing-app edit workflow', () => {
  const state = section(
    templateGuidance,
    '## Identify the app state first',
    '## Trigger edit-app for existing-app feature work',
  );
  assert.match(state, /minimal local markers/);
  assert.match(state, /Honor current approved create\/edit\s+caller context first/);
  assert.match(state, /Confirmed fresh starter[\s\S]*do not invoke `edit-app`/);
  assert.match(state, /native-control request uses the available `add-native`/);
  assert.match(state, /standalone prerequisites and approval gates/);
  assert.match(state, /Do not\s+silently widen it to full app creation/);
  assert.match(state, /missing\s+plan does not make the app fresh/);
  assert.match(state, /After full-integration consent, invoke\s+`edit-app`/);
  assert.match(state, /read-only inspection infers the current-state baseline/);
  assert.match(state, /impact and mutation approval gates/);
  assert.match(state, /Unclear state or intent[\s\S]*ask before choosing/);
  const direct = section(routing, '## Direct requests', '## Orchestrated calls');
  assert.match(direct, /confirmed fresh starter stays with `\/add-native`/);
  assert.match(direct, /do not invoke `\/edit-app` or silently start full app creation/);
  assert.match(direct, /Current approved create\/edit children retain their owner/);
});

test('template guidance invokes edit-app after explicit existing-app integration consent', () => {
  const editing = section(
    templateGuidance,
    '## Trigger edit-app for existing-app feature work',
    '## Trigger debug-app for reported issues',
  );
  assert.match(editing, /use the advertised `edit-app` workflow/);
  assert.match(editing, /do not force other intents or custom workflows\s+through `edit-app`/);
  assert.match(editing, /Do not merely suggest that the user run it/);
  assert.match(editing, /Native-control prompts[\s\S]*`add-native` entry point and its shared routing/);
  assert.match(editing, /approved child context; it does not\s+restart the entry-choice gate/);
  assert.match(editing, /before loading or invoking `edit-app`/);
  assert.match(editing, /\*\*Full app integration\*\*[\s\S]*invoke the available `edit-app` skill/);
  assert.match(editing, /original request[\s\S]*absolute app root as `working_dir`[\s\S]*`entry_choice: full-integration`/);
  assert.match(editing, /\*\*Implementation only\*\*[\s\S]*do not invoke `edit-app`/);
  assert.match(editing, /\*\*Cancel\*\*[\s\S]*stop without loading `edit-app` or changing files/);
  assert.match(editing, /direct `edit-app` invocation needs no mode question/);
  assert.match(editing, /reported runtime or build problems to `debug-app`/);
  assert.match(editing, /dependency\/template\nupgrades to `check-updates`/);
  assert.match(editing, /genuinely new apps to `create-mobile-app`/);
});

test('edit-app metadata recognizes natural existing-app requests', () => {
  const description = edit.match(/^description:\s*"([^"]+)"$/m)?.[1];
  assert.ok(description, 'edit-app needs a single-line routing description');
  for (const trigger of [
    'the app already exists',
    'edit my app',
    'change this screen',
    'add a feature to this app',
  ]) {
    assert.match(description, new RegExp(trigger));
  }
});

test('plugin maintenance guidance preserves natural existing-app routing', () => {
  assert.match(pluginGuidance, /Natural-language\n\s+existing-app feature requests preserve the original prompt and invoke/);
  assert.match(pluginGuidance, /`\/edit-app` after full-integration consent/);
  assert.match(pluginGuidance, /never merely suggest the command/);
  assert.match(pluginGuidance, /never merely suggest the command[\s\S]*`\/create-mobile-app`/);
});

test('create-mobile-app redirects existing-app change requests without re-scaffolding', () => {
  const freshMode = section(
    create,
    '## Fresh-template working-directory mode',
    '## TypeScript Gate Policy',
  );
  assert.match(freshMode, /Already-created app[\s\S]*never re-scaffold it/);
  assert.match(freshMode, /Do not send\s+an existing-app edit request to a new folder/);
  assert.match(freshMode, /Missing generated markers alone do\s+not prove freshness/);
  assert.match(freshMode, /preserve the original request and execute the shared existing-app entry routing/);
  assert.match(freshMode, /invoke `\/edit-app` only after \*\*Full app integration\*\*/);
  assert.match(freshMode, /Do not merely suggest `\/edit-app` or ask the user to repeat/);
  assert.match(freshMode, /original request, absolute `working_dir`, and\s+`entry_choice: full-integration`/);
  assert.match(freshMode, /Reported\s+problems still route to `\/debug-app`/);
  assert.match(freshMode, /dependency\/template upgrades route to\s+`\/check-updates`/);
  assertCreationStateRouting(create);
});

test('creation routing rejects marker-only freshness and contradictory resume rules', () => {
  const fresh = creationStateRow(create, 'Fresh template');
  const existing = creationStateRow(create, 'Already-created app');
  const mutations = [
    ['fresh without new-app intent', create.replace(fresh.row, fresh.row.replace('Confirmed new-app intent and ', ''))],
    ['fresh without customization confirmation', create.replace(fresh.row, fresh.row.replace('a confirmed uncustomized starter', 'a directory'))],
    ['plan alone treated as materialization', create.replace(existing.row, existing.row.replace('`memory-bank.md`', '`native-app-plan.md`, `memory-bank.md`'))],
    ['bank absence treated as fresh', create.replace('#### Fresh run', '#### Fresh run\n\n- **Bank absent** -> fresh project. Continue to Step 1.')],
    ['bank presence chooses arbitrary resume', create.replace('#### Creation continuation', '#### Creation continuation\n\nIdentify the highest-numbered completed step and resume it.')],
    ['old re-scaffold fallback returns', create.replace('#### Fresh run', '#### Fresh run\n\nIf any already-created-app marker exists, STOP and tell the user to materialize a fresh template.')],
    ['Step 0 no longer uses the shared decision', create.replace('Apply the state-routing table above once.', 'Run a separate freshness decision after checking the bank.')],
  ];
  for (const [name, mutated] of mutations) {
    assert.notEqual(mutated, create, `${name}: mutation must change the source`);
    assert.throws(() => assertCreationStateRouting(mutated), name);
  }
});

test('creation progress is not resumed or mutated for existing-app routing exits', () => {
  const protocol = section(create, '## Build documentation protocol', '### Step 0 ');
  assert.match(protocol, /after Step 0 selects fresh creation or an approved\s+creation continuation/);
  assert.match(protocol, /does not create, reopen, or reset the\s+creation plan or change its phase status/);
  assert.match(protocol, /Step 0 routing exits leave existing creation history untouched/);
  const memory = section(shared, '## Memory Bank', '## Preferred Environment');
  assert.match(memory, /Resume on explicit continuation/);
  assert.match(memory, /bank presence\s+alone is not resume intent/);
  assert.match(memory, /Existing-app edits must not resume creation/);
});

test('the entry choice precedes costly work and requires explicit integration consent', () => {
  const direct = section(routing, '## Direct requests', '## Orchestrated calls');
  assert.match(direct, /before loading\nor invoking `\/edit-app`/);
  assert.match(direct, /Do not run health\/type checks, scan\nall screens\/services/);
  assert.match(direct, /precedes operational toolchain\/auth checks/);
  assert.match(direct, /standard plugin-update notification still runs first/);
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

test('connector-owned actions and SharePoint schemas do not imply Dataverse schema', () => {
  assert.match(skill('add-connector'), /Action connectors do not imply Dataverse Data Model changes/);
  assert.match(skill('add-sharepoint'), /Keep SharePoint list\/library schemas in Connectors, not the Dataverse\nData Model/);
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
    /Teams\/email action or profile lookup/,
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
  assert.match(connector, /Standalone removal must stop if\s+it would leave broken consumers/);
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

test('connector discovery examples use the canonical local CLI resolver', () => {
  const connector = skill('add-connector');
  for (const verb of ['list-datasets', 'list-tables', 'list-procedures']) {
    assert.match(connector, new RegExp(`^\\$PA connection ${verb}\\b`, 'm'));
  }
  assert.doesNotMatch(connector, /^npx (?:--no-install )?power-apps /m);
});

for (const [label, discoveryVerb, addCommand, approval, proposalOnly] of [
  ['table', 'list-datasets', '$PA app add data-source --connector <apiId> --connection-id <connectionId> --dataset',
    /Approve\s+the exact selected bindings before generation, or reuse matching current owner\s+approval/, /proposal-only discovery returns without adding sources/],
  ['procedure', 'list-procedures', '$PA app add data-source --connector shared_sql',
    /Approve the exact procedure binding before generation if it was not already in\s+the current approved scope/, /proposal-only discovery returns without adding it/],
]) {
  test(`connector ${label} discovery returns through approval before a separate guarded mutation`, () => {
    const connector = skill('add-connector');
    const blocks = [...connector.matchAll(/^```bash\n([\s\S]*?)\n```/gm)];
    const discovery = blocks.find((block) => block[1].includes(`$PA connection ${discoveryVerb}`));
    const addition = blocks.find((block) => block[1].includes(addCommand));
    assert.ok(discovery, `${label}: documented discovery block`);
    assert.ok(addition, `${label}: documented registration block`);
    assert.ok(addition.index > discovery.index, 'Discovery and mutation must be separate, ordered calls');
    const guard = "cd -- '<working_dir>' || { echo \"BLOCKED: cannot enter working_dir\" >&2; exit 1; }";
    assert.ok(discovery[1].startsWith(`${guard}\n`));
    assert.ok(addition[1].startsWith(`${guard}\n`));
    assert.doesNotMatch(discovery[1], /^\$PA app add\b/m);
    const gate = connector.slice(discovery.index + discovery[0].length, addition.index);
    assert.match(gate, approval);
    assert.match(gate, proposalOnly);
  });
}

test('SharePoint proposal and binding approvals precede implementation', () => {
  const sharepoint = skill('add-sharepoint');
  const plan = section(sharepoint, '### Step 2:', '### Step 3:');
  assert.match(plan, /For `--plan-only` or a planning-phase handoff/);
  assert.match(plan, /bindings, any schema changes, and unresolved choices, then STOP before\s+implementation/);
  assert.match(plan, /Do not create connections\/lists, generate services, or update\s+the app plan or memory-bank/);
  assert.match(plan, /Missing discovery access is not permission to\s+create a connection/);
  assert.ok(plan.indexOf('For `--plan-only`') < plan.indexOf('**If lists already exist:**'));
  const binding = section(sharepoint, '### Step 6:', '### Step 7:');
  assert.match(binding, /obtain explicit approval to create a connection with the\s+command below/);
  assert.ok(binding.indexOf('obtain explicit approval') < binding.indexOf('```bash'));
  const add = section(sharepoint, '### Step 9:', '### Step 10:');
  assert.match(add, /Confirm approval covers this environment, connection\s+ID\/reference, site, and list\/library before registration/);
  assert.match(add, /approve any newly resolved binding; return a changed child scope to its\s+owner/);
  assert.match(add, /A picker\s+selection alone is not execution approval/);
  assert.ok(add.indexOf('Confirm approval') < add.indexOf('```bash'));
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
      assert.match(args, /--working-dir ['"]?<working_dir>['"]?/, name);
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
  assert.match(removal, /does not authorize deleting the server table,\s+its columns\/records/);
  assert.match(removal, /A missing row in a planner's output is a candidate, not consent/);
  assert.match(removal, /lookup\/identity reads, and offline requirements/);
  assert.match(removal, /Dynamic or ambiguous usage is a blocker/);
  assert.match(removal, /Never mutate\s+configuration\/generated files during\s+planning or `--plan-only`/);
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
  assert.match(refresh, /`--plan-only` or a planning-phase handoff returns the proposed\s+refresh without executing it/);
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
  assert.match(removal, /\$PA app remove data-source --connector dataverse --name '<registered-name>' --force --non-interactive/);
  assert.match(removal, /--procedure '<procedure>' --force --non-interactive/);
  assert.match(removal, /`PA_KIND=power-apps`[\s\S]*omit `--force`/);
  assert.match(removal, /`--non-interactive` alone is not removal consent/);
  assert.match(removal, /Do not manually delete `src\/generated\/` files/);
  assert.match(removal, /flat CLI can return exit 0 for a not-found\/no-op removal/);
  assert.match(removal, /same-named registrations in other\nconnectors\/datasets/);
  assert.match(removal, /empty references used by remaining flows/);
});

test('schema-map generation is distinct from service refresh and removal', () => {
  assert.match(removal, /does not infer unused tables from screen code, unregister sources/);
  assert.match(removal, /\$PA app refresh data-source --name '<registered-name>'/);
  assert.match(removal, /npm run generate-schemas\nnpx --no-install tsc --noEmit/);
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

test('generator ownership uses the shared PA resolver without a duplicate command catalog', () => {
  const ownership = section(shared, '### Mandatory changed-file validation', '### MUST (required');
  const cli = section(shared, '## CLI Invocation', '## Command Failure Handling');
  for (const verb of ['init', 'add data-source', 'refresh data-source', 'remove data-source']) {
    assert.ok(ownership.includes(`pa app ${verb}`), verb);
  }
  assert.match(ownership, /through the resolved `\$PA` command/);
  assert.match(ownership, /not modified afterward by the skill or its subagents/);
  assert.match(cli, /\[cli-binary\.md\]\(cli-binary\.md\)/);
  assert.match(cli, /`npm run generate-schemas` is the separate template command/);
  assert.doesNotMatch(shared, /Exact generated-output commands|Exact mobile command|^\s*(?:PA|PA_KIND)=/m);
  assert.doesNotMatch(cli, /npx --no-install power-apps/);
});

test('CLI guidance has no version preflight, hardcoded retirement version, or upgrade fallback', () => {
  const cli = section(shared, '## CLI Invocation', '## Command Failure Handling');
  assert.doesNotMatch(cli, /project-local CLI gate|--version|node_modules\/@microsoft\/power-apps-cli\/package\.json/);
  assert.match(cli, /Do not substitute a global binary/);
  assert.match(cli, /If the command is unsupported, report\nthe error/);
  assert.match(cli, /do not guess aliases, strip safety flags, or install another CLI/);
  assert.doesNotMatch(removal, /\b\d+\.\d+\.\d+\b|npx --no-install power-apps/);
  assert.match(removal, /\[command and flag mapping\]\(\.\.\/cli-binary\.md\)/);
});

test('unsupported cloud flows cannot enter connector routing or data-source lifecycle commands', () => {
  const connector = skill('add-connector');
  const router = skill('add-datasource');
  for (const text of [connector, router, removal]) {
    assert.match(text, /BLOCKED: cloud-flow integration is not supported/);
  }
  assert.ok(connector.indexOf('**Cloud flows are not supported') < connector.indexOf('**Removal branch:**'));
  for (const text of [connector, router, removal, read('shared/connector-reference.md')]) {
    assert.doesNotMatch(text, /\$PA app (?:add flow|remove flow|list-flows)|npx[^\n]*(?:add-flow|remove-flow|list-flows)/);
  }
  assert.match(removal, /Preserve existing flow dependencies/);
});

test('README explains data-source commands without internal execution mechanics', () => {
  const examples = section(read('README.md'), '### Data-source planning, refresh, and retirement', '### 5.');
  assert.match(examples, /--plan-only/);
  assert.match(examples, /--refresh --data-source-name/);
  assert.match(examples, /--remove --data-source-name/);
  assert.match(examples, /never deletes server tables/);
  assert.doesNotMatch(examples, /compact live-metadata|working_dir|PowerShell|Bash|schema map|allowlist|offline-profile-delta/);
});

test('scoped feature context preserves the separate upstream browser suppression flag', () => {
  assert.match(routing, /MOBILE_APP_ORCHESTRATING=1/);
  assert.match(routing, /CODE_APPS_NATIVE_ORCHESTRATING=1/);
  assert.match(routing, /suppresses browser openers/);
  const creation = section(create, '### Step 6.75', '#### Branch A');
  assert.match(creation, /Environment:\s+CODE_APPS_NATIVE_ORCHESTRATING=1/);
  assert.match(creation, /Context:\s+MOBILE_APP_ORCHESTRATING=1/);
  assert.match(edit, /CODE_APPS_NATIVE_ORCHESTRATING=1[\s\S]*suppress intermediate browser tabs/);
  assert.match(skill('design-system'), /CODE_APPS_NATIVE_ORCHESTRATING=1/);
  assert.match(read('skills/design-system/references/vibe/style-picker.md'), /CODE_APPS_NATIVE_ORCHESTRATING=1/);
});
