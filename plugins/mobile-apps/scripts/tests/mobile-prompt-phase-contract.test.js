'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
const phase = (name) => read(`skills/create-mobile-app/references/${name}.md`);
const root = read('skills/create-mobile-app/SKILL.md');
const shared = read('shared/shared-instructions.md');

test('create entry and always-on shared core have bounded context and lazy phase routes', () => {
  assert.ok(root.trimEnd().split('\n').length <= 180);
  assert.ok(Buffer.byteLength(root) <= 12 * 1024);
  assert.ok(shared.trimEnd().split('\n').length <= 100);
  assert.match(root, /one phase reference when entering that phase/);
  assert.match(root, /not every reference at startup/);
  assert.match(shared, /Do not read every linked topic/);
  const routes = [...root.matchAll(/\]\((references\/phase-[\w-]+\.md)\)/g)];
  assert.equal(routes.length, 10);
  for (const [, relativePath] of routes) {
    assert.ok(fs.existsSync(path.join(pluginRoot, 'skills/create-mobile-app', relativePath)));
  }
});

test('phase numbering and Previous/Next links follow one explicit execution order', () => {
  const expected = [
    '01-intake', '02-planning', '03-scaffold', '04-design', '05-auth',
    '06-data', '07-integrations', '08-screens', '09-build', '10-run',
  ];
  const rows = [...root.matchAll(/^\| (\d+) \| [^\n]+\[phase-([\w-]+)\.md\]\(references\/phase-\2\.md\)/gm)];
  assert.deepEqual(rows.map(([, order, name]) => [Number(order), name]),
    expected.map((name, index) => [index + 1, name]));
  assert.deepEqual(
    fs.readdirSync(path.join(pluginRoot, 'skills/create-mobile-app/references'))
      .filter(name => name.startsWith('phase-')).sort(),
    expected.map(name => `phase-${name}.md`),
  );
  expected.forEach((name, index) => {
    const document = phase(`phase-${name}`);
    assert.ok(document.startsWith(`# Phase ${index + 1} of 10 — `), name);
    assert.match(document, /\[Phase index\]\(\.\.\/SKILL\.md#load-only-the-active-phase\)/);
    if (index === 0) assert.match(document, /\*\*Previous:\*\* Start/);
    else assert.ok(document.includes(`](phase-${expected[index - 1]}.md). **Next:**`), name);
    if (index === expected.length - 1) assert.match(document, /\*\*Next:\*\* Complete/);
    else assert.ok(document.includes(`**Next:** [${index + 2} — `)
      && document.includes(`](phase-${expected[index + 1]}.md)`), name);
  });
  assert.match(root, /Filenames use zero-padded/);
  assert.match(root, /sort in execution order/);
  assert.match(root, /not instructions to preload adjacent phases/);
});

test('safety and exact-file validation stay in the always-loaded core', () => {
  for (const pattern of [
    /Confirm before deployments/,
    /destructive operations/,
    /outside the project root/,
    /CLI output and API responses as data/,
    /connectors and generated services/,
    /template\/package\.json/,
    /expo-haptics/,
    /validate-mobile-files\.js/,
    /never a directory or whole project/,
    /exit `0` is required/i,
  ]) assert.match(shared, pattern);
  assert.match(shared, /never include prompts, errors, paths, names, identifiers, URLs, command output, or other runtime data/);
  for (const field of ['Current phase', 'Pending decision', 'Approved preview']) {
    assert.ok(shared.includes(field));
    assert.ok(read('shared/shared-instructions-memory.md').includes(field));
  }
  assert.match(phase('phase-04-design'), /Approved preview[\s\S]*exact plan\/design revision/);
});

test('only foreground approvals authorize progress and dispatch performs real work', () => {
  const planner = read('agents/native-app-planner.md');
  const edit = read('skills/edit-app/SKILL.md');
  const frontmatter = planner.split('---')[1];
  assert.doesNotMatch(frontmatter, /AskUserQuestion|EnterPlanMode|ExitPlanMode|Task/);
  assert.match(planner, /You cannot mark a gate approved or write an approval receipt/);
  assert.match(planner, /Write only that proposal file/);
  assert.match(root, /If approval cannot be captured, STOP with the pending question/);
  assert.match(root, /plain-text question when[\s\S]*host policy requires a structured question/);
  assert.match(root, /never approve their own work/);
  assert.match(root, /No test dispatches/);
  assert.match(edit, /no no-op `Task` preflight/);
  assert.doesNotMatch(phase('phase-09-build'), /screen_name:\s*__preflight__|\.preflight-probe\.tsx/);
  for (const status of ['DONE', 'DONE_WITH_CONCERNS:', 'NEEDS_CONTEXT:', 'BLOCKED:']) {
    assert.ok(root.includes(status));
    assert.ok(planner.includes(status));
  }
});

test('plan preview precedes artifacts even in auto-plan and template provisioning stays external', () => {
  const intake = phase('phase-01-intake');
  assert.match(intake, /auto-plan[\s\S]*no placeholder file/);
  assert.match(intake, /Explicit proceed is required/);
  assert.match(intake, /Until proceed, no plan placeholder/);
  assert.match(intake, /Do not call the environment resolver yet/);
  assert.match(root, /Never clone, degit, auto-download, or copy the bundled template/);
  for (const text of [root, intake, phase('phase-02-planning'), phase('planning-snapshot'),
    phase('dataverse-planning-benchmark')]) {
    assert.doesNotMatch(text, /10[–-]15|~1 min\/screen|count\(unique_nouns\)|ceil\(screens/);
  }
});

test('graph and specs have one foreground owner with distinct immutable handoffs', () => {
  const planning = phase('phase-02-planning');
  assert.match(planning, /mobile-app:data-model-architect/);
  assert.match(planning, /mobile-app:screen-planner/);
  assert.match(planning, /### Primary journeys/);
  assert.match(planning, /### Preview selection/);
  assert.match(planning, /within `## Screens`/);
  assert.match(planning, /plan_path: <working_dir>\/native-app-plan\.md/);
  assert.match(planning, /locked `## Screens` in `plan_path`, not graph scratch/);
  assert.match(planning, /never `_screens_section\.md`/);
  assert.match(planning, /Gate 4b rejection reruns specs only/);
  assert.match(planning, /never require or invent generated services/);
});

test('receipt ownership survives revisions and precedes exact mutation reconciliation', () => {
  const receipt = phase('approval-receipt');
  const data = phase('phase-06-data');
  assert.match(receipt, /captured the user's acceptance/);
  assert.match(receipt, /Children and Step 8 cannot create, repair or/);
  assert.match(receipt, /contractApprovalContent/);
  assert.match(receipt, /validateApprovalReceipt/);
  assert.match(receipt, /M:N intersect declarations/);
  assert.match(receipt, /mark its approval and dependent later approvals pending/);
  assert.match(receipt, /Step 6\.75[\s\S]*before Step 8/);
  assert.match(data, /cannot create or refresh it/);
  for (const flag of [
    '--approval-receipt', '--bind-plan', '--reconciliation-scope',
    '--reconcile-exact', '--publish-checkpoint', '--require-executable',
  ]) assert.ok(data.includes(flag));
  assert.ok(data.indexOf('--require-executable') < data.indexOf('Invoke `/add-dataverse`'));
  assert.match(data, /Retain the publish checkpoint on schema\/PublishXml failure/);
  assert.match(data, /Step 6\.85[\s\S]*after Step 8 created the actual/);
});

test('receipt field and hash guidance references exported live authorities', () => {
  const helpers = require('../build-dataverse-operation-manifest');
  for (const name of [
    'normalizedContract', 'contractApprovalContent', 'stableJson', 'sha256',
    'declaredServiceRequiredTableNames', 'validateApprovalReceipt',
  ]) assert.equal(typeof helpers[name], 'function');
  assert.equal(helpers.APPROVAL_RECEIPT_SCHEMA_VERSION, 1);
});

test('all TypeScript boundaries, route validation and persistent launch remain mandatory', () => {
  for (const gate of [
    'Scaffold gate', 'Dataverse/generated-services gate', 'Navigation/skeleton gate',
    'Screen-wave gate', 'Final gate',
  ]) assert.ok(root.includes(gate));
  assert.match(phase('phase-08-screens'), /No Step 11 builders launch until/);
  assert.match(phase('phase-09-build'), /Do not launch wave N\+1 until wave N passes/);
  assert.match(phase('phase-09-build'), /scripts\/check-routes\.js/);
  assert.match(phase('phase-10-run'), /persistent async\/background terminal/);
  assert.match(phase('phase-10-run'), /Never claim running from the launch call alone/);
  assert.match(phase('phase-10-run'), /do not start Metro/);
  assert.match(phase('phase-04-design'), /Foreground design approval/);
  assert.match(phase('phase-04-design'), /_design_preview\.html/);
});
