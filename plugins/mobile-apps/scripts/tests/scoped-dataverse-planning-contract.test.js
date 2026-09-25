'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { cacheMatchesTarget, canUseCachedResolution, parseArgs } = require('../resolve-environment');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8').replace(/\r\n?/g, '\n');
const skill = (name) => read(`skills/${name}/SKILL.md`);
const planningPath = 'shared/references/dataverse-change-planning.md';
const planning = read(planningPath);
const setup = skill('setup-datamodel');
const edit = skill('edit-app');
const dataverse = skill('add-dataverse');
const create = skill('create-mobile-app');

function section(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0, `Missing section: ${start}`);
  assert.ok(to > from, `Missing section end: ${end}`);
  return text.slice(from, to);
}

function inOrder(text, ...markers) {
  let previous = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    assert.ok(index > previous, `Missing or out-of-order instruction: ${marker}`);
    previous = index;
  }
}

function resolverFlags(text) {
  const command = text.match(/^node "\$\{PLUGIN_ROOT\}\/scripts\/resolve-environment\.js" "<selected-environment-id>" ([^\n]+)$/m);
  assert.ok(command, 'Scoped planning must document an executable selected-environment resolver command');
  return command[1].trim().split(/\s+/);
}

for (const [name, ending] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`scoped planning command and section boundaries survive ${name}`, (t) => {
    t.mock.method(fs, 'readFileSync', (file, encoding) => {
      assert.equal(file, path.join(pluginRoot, planningPath));
      assert.equal(encoding, 'utf8');
      return planning.replace(/\n/g, ending);
    });
    const content = read(planningPath);
    assert.equal(content, planning);
    assert.deepEqual(resolverFlags(section(content, '## 1.', '## 2.')), ['--no-cache', '--require-tenant']);
    inOrder(content, '## 1.', '## 2.', '## 3.', '## 4.', '## 5.');
  });
}

test('the documented planning resolver leaves cached app identity files byte-for-byte unchanged', (t) => {
  const root = path.join(__dirname, `.scoped-dataverse-fixture-${randomUUID()}`);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'telemetry-config');
  fs.mkdirSync(configDir);
  const cached = {
    environmentId: '11111111-1111-4111-8111-111111111111',
    environmentUrl: 'https://contoso.crm.dynamics.com',
    tenantId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Planning fixture',
    clusterEnvironment: 'Prod',
    clusterGeoName: 'EU',
  };
  const fixtures = {
    'power.config.json': { environmentId: cached.environmentId },
    'auth.config.json': { msal: { clientId: 'preserve-client', tenantId: 'preserve-tenant' }, environment: cached },
    '.resolved-environment.json': { ...cached, cachedAt: '2026-01-01T00:00:00.000Z' },
    'app.json': { expo: { name: 'Planning fixture', extra: { telemetry: { appInstanceId: 'preserve-instance', cluster: null } } } },
  };
  const before = new Map();
  for (const [name, value] of Object.entries(fixtures)) {
    const file = path.join(root, name);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    before.set(file, fs.readFileSync(file));
  }

  assert.equal(cacheMatchesTarget(cached, cached.environmentId), true);
  assert.equal(canUseCachedResolution(cached, cached.environmentId), true);
  const args = [cached.environmentId, ...resolverFlags(planning)];
  assert.deepEqual(parseArgs(args), { noCache: true, target: cached.environmentId, requireTenant: true });
  // Complete matching cache + no az executable keeps this real CLI invocation offline.
  // Null cluster would be persisted by normal resolution, so byte equality checks routing too.
  const result = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/resolve-environment.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      PATH: '',
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { ...cached, source: 'cache' });
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, path.basename(file));
  assert.deepEqual(fs.readdirSync(root).sort(), [...Object.keys(fixtures), 'telemetry-config'].sort());
  assert.deepEqual(fs.readdirSync(configDir), []);
});

test('scope and selected environment are established before compact discovery', () => {
  const scope = section(planning, '## 1.', '## 2.');
  inOrder(scope, 'one absolute `working_dir`', 'only the proposed delta', 'resolve-environment.js', 'On conflict');
  assert.match(scope, /existing dependencies as `reuse`, not\s+`create`\/`extend`/);
  assert.match(scope, /do not copy historical creation rows from the full plan/);
  assert.match(scope, /Preserve unrelated services outside this contract/);
  assert.match(scope, /missing dependency[\s\S]*additional mutations goes into the proposal for approval/);
  assert.match(scope, /Connector-only, native\/design-only, removal-only, and retained-service-only\n\s+refresh requests skip/);
  assert.match(scope, /do not create empty Dataverse artifacts or require a data-model receipt/);
  assert.match(scope, /environment ID, HTTPS URL, and tenant to match/);
  assert.match(scope, /`NEEDS_CONTEXT` to the owner before discovery/);
  assert.match(scope, /never select another environment\nsilently/);
  assert.match(scope, /Planning must\nnot change auth\/app configuration[\s\S]*live plan before its owning approval/);
});

test('scoped planning adapts only the named create helper sections, not its wizard or gates', () => {
  const evidence = section(planning, '## 2.', '## 3.');
  assert.match(planning, /does not invoke `\/create-mobile-app` or add another approval gate/);
  assert.match(evidence, /Read and execute only\n\[Foreground Dataverse planning snapshot and evidence\]\(\.\.\/\.\.\/skills\/create-mobile-app\/SKILL\.md#foreground-dataverse-planning-snapshot-and-evidence\)/);
  assert.match(evidence, /ending before \*\*Planner completion dispatch\*\*/);
  assert.match(evidence, /not permission to run the create wizard, its planner, scaffolding, or gates/);
  assert.match(planning, /\[Dataverse planning recovery\]\(\.\.\/\.\.\/skills\/create-mobile-app\/SKILL\.md#dataverse-planning-recovery\)/);
  assert.match(evidence, /`<dataverse_planning_mode>` \| `required` only for this Dataverse delta/);
  assert.match(evidence, /Exact existing targets and necessary dependencies, not every table used anywhere/);
  assert.match(evidence, /Every proposed final custom logical name, including adapted names/);
  assert.match(evidence, /production read concurrency\n`1`/);
  assert.match(evidence, /valid cache is planning evidence only, never write authorization/);
  assert.match(evidence, /Never dispatch on failed\/stale output/);
  assert.match(evidence, /Agents read only the\ncompact sidecar; the full snapshot is an opaque validator input/);
  const helper = section(create, '### Foreground Dataverse planning snapshot and evidence', '#### Planner completion dispatch');
  inOrder(helper, 'resolve-environment.js', 'create-dataverse-snapshot.js', 'render-dataverse-architect-evidence.js', '--validate-only');
  assert.match(helper, /--read-concurrency 1/);
  assert.doesNotMatch(helper, /Task: mobile-app:native-app-planner|Invoke skill: \/create-mobile-app/);
  assert.doesNotMatch(planning, /^(?:Invoke skill: \/create-mobile-app|Task: mobile-app:native-app-planner|.*--approval-receipt )/m);
});

test('all scoped proposal sources share required snapshot-only architect inputs and outputs', () => {
  const proposal = section(planning, '## 3.', '## 4.');
  inOrder(proposal, 'Task: mobile-app:data-model-architect', 'phase: planning', 'Dataverse planning mode: required', 'Structured schema contract output:');
  for (const field of [
    'working_dir: <absolute owner root>',
    'proposal_only: <true for --plan-only or a planning-phase caller>',
    'Normalized Dataverse foreground planning snapshot (validator input only): <SNAPSHOT_PATH>',
    'Compact Dataverse architect evidence: <ARCHITECT_EVIDENCE_PATH>',
    'Output proposal: <working_dir>/_dm_section.md',
  ]) assert.ok(proposal.includes(field), field);
  assert.match(proposal, /do not save the live plan,\n\s+grant approval, run live discovery, or apply changes/);
  assert.match(proposal, /diagram, parsed text, existing-plan delta, or unavailable-agent inline\nfallback, produce the same two outputs/);
  assert.match(proposal, /Never use local models or Mermaid alone as\nproof/);
  assert.match(proposal, /do not replace its unaffected sections with the scoped contract/);

  const setupPlanner = section(setup, '#### Path B', '#### Path C');
  const editPlanner = section(edit, 'For the Data Model handoff', 'For Native Capabilities (no separate agent)');
  for (const handoff of [setupPlanner, editPlanner]) {
    assert.match(handoff, /Dataverse planning mode: required/);
    assert.match(handoff, /snapshot \(validator input only\): <SNAPSHOT_PATH>/);
    assert.match(handoff, /Compact Dataverse architect evidence: <ARCHITECT_EVIDENCE_PATH>/);
    assert.match(handoff, /Structured schema contract output: <working_dir>\/\.tmp\/dataverse-schema-contract\.json/);
    assert.doesNotMatch(handoff, /Dataverse planning mode: (?:default|optional|legacy)/);
  }
  assert.match(section(setup, '#### Path A', '#### Path B'), /same decision validation as Path B before[\s\S]*Phase 4 approval/);
  assert.match(section(dataverse, '### Step 2.5', '### Step 2.6'), /decision validation for the diagram just as for\nan architect result/);
  assert.match(section(dataverse, '### Step 2.6', '### Step 2.7'), /If the host cannot spawn agents, produce both inline from that same evidence/);
});

test('the architect refuses live-discovery fallback when required compact evidence is missing', () => {
  const architect = read('agents/data-model-architect.md');
  const snapshotOnly = section(architect, '## Snapshot-only', '## Step 1');
  inOrder(snapshotOnly, 'render-dataverse-architect-evidence.js', '--validate-only', 'Read the compact architect evidence once');
  assert.match(snapshotOnly, /Skip Steps 1–3[\s\S]*Skip every live Dataverse query in Step 5/);
  assert.match(snapshotOnly, /Do \*\*not\*\* run Bash discovery or call `resolve-environment\.js`/);
  assert.match(snapshotOnly, /`NEEDS_CONTEXT: matching-dataverse-snapshot-and-evidence`/);
  assert.match(snapshotOnly, /Do not fall back to\nlive discovery from `required` mode/);
  assert.match(snapshotOnly, /Bundled\nsetup\/edit\/standalone planning must not omit `required`/);
});

test('normalization and decision validation precede approval, including successful agent returns', () => {
  const validation = section(planning, '## 4.', '## 5.');
  inOrder(validation,
    'build-dataverse-operation-manifest.js',
    '--normalize-contract',
    'Only if normalization succeeds',
    'validate-dataverse-planning-decisions.js',
    'Only exit `0` permits presenting an executable proposal',
    'Handle structured signals before generic agent retry limits');
  assert.match(validation, /`DONE` \/ `DONE_WITH_CONCERNS` from an agent is not a validation result/);
  assert.match(validation, /section and contract describe the same delta[\s\S]*neither exceeds\nthe requested scope/);
  assert.match(validation, /deferred required dependency cannot be described as complete/);
  assert.doesNotMatch(validation, /--approval-receipt|EnterPlanMode|ExitPlanMode|Invoke skill: \/add-dataverse/);
  const directGate = section(dataverse, '### Step 2.7', '### Step 3');
  inOrder(directGate, 'require exit `0`', 'validate-dataverse-planning-decisions.js', 'STOP before saving', 'EnterPlanMode', 'saves only that delta', 'verify\nit using Step 2b');
  assert.match(directGate, /diagrams, architect results, inline fallbacks, and edits to an existing plan/);
  assert.match(directGate, /Already-approved scoped child\ncalls and valid creation fast-path calls do not repeat this gate/);
});

test('structured metadata expansion and deterministic revision precede generic retries without new gates', () => {
  const recovery = section(planning, 'Handle structured signals', '## 5.');
  assert.match(recovery, /before generic agent retry limits/);
  assert.match(recovery, /Exit `3`, `NEEDS_CONTEXT: detailed-dataverse-metadata:<names>`[^\n]*only names not already fully attempted[^\n]*regenerate\/validate compact evidence/);
  assert.match(recovery, /Exit `3`, `NEEDS_CONTEXT: proposed-dataverse-names:<names>`[^\n]*collision-only[^\n]*never reinterpret it as detail discovery/);
  assert.match(recovery, /Exit `4`, `NEEDS_REVISION: dataverse-plan-validation`[^\n]*same evidence[^\n]*no metadata read or user question/);
  assert.match(recovery, /`NEEDS_CONTEXT: dataverse-plan-revision:<classification>`[^\n]*inline revision fallback, not a generic context retry/);
  assert.match(recovery, /Exit `2`[^\n]*no approval, mutation, stale-output fallback, or downgrade to success/);
  assert.match(recovery, /`DETAIL_ATTEMPTED_NAMES` and `PROPOSED_CHECKED_NAMES` are separate\nmonotonic sets/);
  assert.match(recovery, /`core` detail remains eligible for full-detail expansion/);
  assert.match(recovery, /already-unavailable names are not fetched repeatedly/);
  assert.match(recovery, /On no progress,\nrevise inline using current evidence/);
  assert.match(recovery, /Never import creation's Gate 1\/2 prompts/);
  const canonical = section(create, '#### Dataverse planning recovery', '#### Step 3.0a');
  assert.match(canonical, /NEW_DETAIL_NAMES = requested names - DETAIL_ATTEMPTED_NAMES/);
  assert.match(canonical, /NEW_PROPOSED_NAMES = requested names - PROPOSED_CHECKED_NAMES/);
  assert.match(canonical, /If it is empty, do not issue another network request/);
  for (const owner of [
    section(setup, '#### Path B', '#### Path C'),
    section(edit, 'For the Data Model handoff', 'For Native Capabilities (no separate agent)'),
    section(dataverse, '### Step 2.6', '### Step 2.7'),
  ]) assert.match(owner, /(?:shared planning recovery before|recovery before generic retry limits|shared structured-signal recovery before generic retries)/);
});

test('accepted setup/edit scopes bind evidence and exact hashes without create-only artifact flags', () => {
  const accepted = planning.slice(planning.indexOf('## 5.'));
  inOrder(accepted, 'existing gate approves implementation', 'save only the accepted plan', '`contract_sha256`', '`plan_sha256`', 'Before execution');
  assert.match(accepted, /exact accepted operations\/dependencies/);
  assert.match(accepted, /SHA-256 of the\nnormalized contract file bytes/);
  assert.match(accepted, /never recalculate these approval hashes after discovering a mismatch/);
  assert.match(accepted, /not a new\nreceipt format/);
  assert.match(accepted, /receipt requires `workflow: create-mobile-app`\nand four approvals/);
  assert.match(accepted, /Do not fabricate those approvals for setup\/edit, weaken\nreceipt validation, or pass a partially populated fast-path argument set/);
  for (const [owner, content] of [['setup-datamodel', setup], ['edit-app', edit]]) {
    const handoff = section(content, 'Invoke skill: /add-dataverse', '\n```');
    assert.match(handoff, new RegExp(`orchestrator: ${owner}`));
    assert.match(handoff, /phase: implementation/);
    assert.match(handoff, /planning_snapshot: <SNAPSHOT_PATH>/);
    assert.match(handoff, /architect_evidence: <ARCHITECT_EVIDENCE_PATH>/);
    assert.match(handoff, /schema_contract: <working_dir>\/\.tmp\/dataverse-schema-contract\.json/);
    assert.match(handoff, /approved_scope: <[^\n]*delta[^\n]*contract_sha256, plan_sha256>/);
    assert.match(handoff, /--skip-planning/);
    assert.doesNotMatch(handoff, /--(?:schema-contract|approval-receipt|execution-reconciliation|operation-manifest|publish-checkpoint)\b/);
  }
});

test('Step 2b verifies approval before fresh bounded reconciliation, not whole-plan replay', () => {
  const entry = section(dataverse, 'For all non-fast-path Dataverse proposals', '#### Step 2a');
  assert.match(entry, /approved child[\s\S]*enters Step 2b[\s\S]*must\nnot rediscover or re-approve it/);
  assert.match(entry, /normalized contract's non-deferred\n`serviceRequired` declarations/);
  assert.match(entry, /broader existing-app service\ninventory as retained context, not a registration or mutation work list/);
  const binding = section(dataverse, '#### Step 2b', '### Step 2.5');
  inOrder(binding, 'Require all fields and real implementation approval', 'Before Step 3', 'compare SHA-256', 'verify the selected target identity', 'decision validators', 'After success', 'proceed to\nStep 3');
  assert.match(binding, /partial, missing, changed, or mismatched context returns `NEEDS_CONTEXT`/);
  assert.match(binding, /never a fallback to whole-plan replay or fresh approval inference/);
  assert.match(binding, /Do not overwrite either hash to accept changed files/);
  assert.match(binding, /normalized scoped contract, not historical Markdown rows/);
  assert.match(binding, /proposal-only caller returns without mutation/);
  assert.match(binding, /`<operation_manifest_mode> = fallback`/);
  assert.match(binding, /skip Steps 2.5–2.7/);
  const live = section(dataverse, '### Step 4 — Reconcile', '#### Step 4a');
  inOrder(dataverse, '#### Step 2b', '### Step 3 —', '### Step 4 —', '### Step 5 —');
  inOrder(live, 'only the approved\nnormalized contract', 'Do not substitute the planning snapshot or inventory cache', 'scripts/dataverse-request.js');
  assert.match(live, /never all saved-plan rows/);
  assert.match(live, /still unreadable after that is `unverified`: STOP before writes/);
  assert.match(planning, /must not reconstruct mutation\nscope from all rows in the saved Markdown plan/);
  assert.match(planning, /missing\/out-of-scope binding returns\nto the owner/);
});

test('creation retains its complete receipt-owned fast path and fails closed on partial artifacts', () => {
  const flags = ['schema-contract', 'approval-receipt', 'execution-reconciliation', 'operation-manifest', 'publish-checkpoint'];
  const handoff = section(create, 'Invoke skill: /add-dataverse', '\n```');
  const fast = section(dataverse, '#### Step 2a', '#### Step 2b');
  assert.match(handoff, /orchestrator: create-mobile-app/);
  for (const flag of flags) {
    assert.match(handoff, new RegExp(`--${flag} <working_dir>/\\.tmp/`));
    assert.match(fast, new RegExp(`--${flag} <working_dir>/\\.tmp/`));
  }
  assert.match(fast, /supplies all five paths/);
  assert.match(fast, /entirely absent fast-path handoff[\s\S]*fallback/);
  assert.match(fast, /partially supplied handoff[\s\S]*must fail closed/);
  assert.match(fast, /Never jump to\nStep 4 without Step 2 initialization/);
  assert.match(fast, /Do not reconstruct tables[\s\S]*from Markdown on this path/);
  assert.match(section(create, '### Step 8 — Apply', 'Invoke skill: /add-dataverse'), /Step 8 cannot create or refresh this receipt/);
});

test('both publish paths still require cache recovery before completion without replaying writes', () => {
  const fastPublish = section(dataverse, 'After the `publish` phase succeeds', '#### Step 5a');
  const standalonePublish = section(dataverse, '### Step 6b', '### Step 6c');
  for (const publish of [fastPublish, standalonePublish]) {
    inOrder(publish, 'publish', 'dataverse-inventory-cache.js', '--invalidate', 'NEEDS_RECOVERY: dataverse-inventory-cache', 'exit 2');
  }
  assert.match(fastPublish, /at most two targeted retries\nof the invalidation command/);
  assert.match(fastPublish, /do not replay metadata writes or publish to repair a local cache failure/);
  assert.match(fastPublish, /Do not reuse the failed cache or continue to service generation, verification,\nsample data, or offline setup until invalidation exits `0`/);
  assert.match(standalonePublish, /same cache-invalidation recovery rule from the validated publish path/);
  assert.match(planning, /Preserve pending offline-retirement outcomes independently of\naddition checks/);
  assert.match(planning, /never authorizes profile deletion/);
});
