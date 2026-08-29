'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');

function read(relative) {
  return fs.readFileSync(path.join(pluginRoot, relative), 'utf8');
}

const files = {
  agents: read('AGENTS.md'),
  create: read('skills/create-mobile-app/SKILL.md'),
  phase3: read('skills/create-mobile-app/references/phase-3-planning.md'),
  phase4: read('skills/create-mobile-app/references/phase-4-scaffold.md'),
  phase7: read('skills/create-mobile-app/references/phase-7-data.md'),
  phase11: read('skills/create-mobile-app/references/phase-11-screens.md'),
  degraded: read('skills/create-mobile-app/references/degraded-hosts.md'),
  common: read('skills/create-mobile-app/references/return-only-agents.md'),
  offline: read('skills/setup-offline-profile/SKILL.md'),
};

test('Phase 3 uses one return-only planner and foreground planning roles', () => {
  assert.match(files.phase3, /healthy path dispatches\s+this role once/);
  assert.match(files.phase3, /record `planning:native` with dispatch reason\s+`initial`/);
  assert.match(files.phase3, /dispatch ledger rejects a second `initial` call/);
  assert.match(files.phase3, /has no `approval`\s+reason/);
  assert.match(files.phase3, /plan:native-app-draft/);
  assert.match(files.phase3, /contract:product-experience/);
  assert.match(files.phase3, /contract:product-scope/);
  assert.match(files.phase3, /schema-product-experience-contract\.json/);
  assert.match(files.phase3, /schema-product-scope-contract\.json/);
  assert.match(files.phase3, /exact Workflow Journey JSON schema/);
  assert.match(files.phase3, /exact screen build-pack JSON schema/);
  assert.match(files.phase3, /data-model-architect` work order/);
  assert.match(files.phase3, /screen-planner` work orders/);
  assert.match(files.phase3, /compose-return-only-plan\.js/);
  assert.match(files.phase3, /foreground, never a child,\s+creates and updates `\.tmp\/mobile-plan-status\.json`/);
  assert.doesNotMatch(files.phase3, /literal first.line/i);
  assert.doesNotMatch(files.phase3, /planner runs Gates 1.2/i);
  assert.doesNotMatch(files.phase3, /BLOCKED: tool surface missing/i);
  assert.doesNotMatch(files.phase3, /DESIGN_VIBE_REQUESTED:/);
});

test('Phase 11 validates complete builder waves before deterministic writes', () => {
  assert.match(files.phase11, /one work order per screen/);
  assert.match(files.phase11, /complete typed skeleton\/import content/);
  assert.match(files.phase11, /full wave's\s+unique target paths before any final write/);
  assert.match(files.phase11, /deterministic target-path order/);
  assert.match(files.phase11, /Unicode code unit \(`left < right`\)/);
  assert.match(files.phase11, /does\s+not use locale-aware comparison/);
  assert.match(files.phase11, /Keep valid sibling responses unchanged/);
  assert.match(files.phase11, /validate-mobile-files\.js --file/);
  assert.doesNotMatch(files.phase11, /Return per AGENTS\.md rule/);
  assert.doesNotMatch(files.phase11, /builder's first line/);
  assert.doesNotMatch(files.phase11, /Apply affected files in parallel/);
  assert.doesNotMatch(files.phase11, /target_file:\s*<working_dir>/);
});

test('foreground-return is one shared workflow without leaf tool assumptions', () => {
  assert.match(files.degraded, /same complete sealed work order/);
  assert.match(files.degraded, /same response-envelope schema/);
  assert.match(files.degraded, /same role validators and materializer/);
  assert.match(files.degraded, /Normal foreground conversation/);
  assert.match(files.degraded, /does not load a second inline planning or implementation\s+specification/);
  assert.doesNotMatch(files.degraded, /leaf agents.*Read|leaf agents.*Write|leaf agents.*Bash/i);
  assert.doesNotMatch(files.degraded, /BLOCKED: tool surface missing/i);
  assert.doesNotMatch(files.degraded, /EnterPlanMode/);
});

test('foreground owns questions approvals persistence and mutations', () => {
  for (const value of [files.agents, files.create, files.common]) {
    assert.match(value, /foreground/i);
  }
  assert.match(files.common, /askUser\(question, context\)/);
  assert.match(files.common, /approveSection\(sectionId, renderedContent, revision\)/);
  assert.match(files.common, /waiting_for_user/);
  assert.match(files.common, /resume the same phase and revision/i);
  assert.match(files.phase7, /normal foreground chat/);
  assert.match(files.phase4, /normal foreground conversation/);
  assert.match(files.phase4, /persist `waiting_for_user`/);
  assert.match(files.offline, /foreground reads the materialized model/);
  assert.match(files.offline, /required Dataverse reads sequentially/);
  assert.match(files.offline, /structured `AskUserQuestion` prompts when\s+available/);
});

test('common orchestration seals fingerprints and validates staged artifacts', () => {
  assert.match(files.common, /seal-work-order/);
  assert.match(files.common, /SHA-256 over the complete\s+work order/);
  assert.match(files.common, /complete context includes the exact current JSON\s+schema/);
  assert.match(files.common, /64-zero\s+placeholder/);
  assert.match(files.common, /bind-return-only-contracts\.js/);
  assert.match(files.common, /duplicate artifact IDs or target paths/i);
  assert.match(files.common, /validation plan/);
  assert.match(files.common, /stages all\s+content with its original extension/);
  assert.match(files.common, /atomically\s+renames in deterministic\s+target-path order/);
  assert.match(files.common, /agent-materialization-state\.json/);
  assert.match(files.common, /increments the foreground-owned revision/);
  assert.match(files.common, /pipeline-state\.json/);
  assert.match(files.common, /agent-tool-call-count 0/);
});

test('missing child tools cannot become a product block', () => {
  for (const value of [files.agents, files.create, files.phase3, files.phase11,
    files.degraded, files.common, files.offline]) {
    assert.doesNotMatch(value, /BLOCKED: tool surface missing/i);
  }
  assert.match(files.agents, /missing Plan Mode[\s\S]*never\s+product `blocked`/i);
  assert.match(files.common, /Missing tools, filesystem, shell, Plan Mode[\s\S]*never valid child blocks/i);
});

test('Dataverse and connector mutation remain sequential', () => {
  assert.match(files.create, /Dataverse and connector mutations remain sequential/);
  assert.match(files.phase7, /Run sequentially/);
  assert.match(files.degraded, /Dataverse and connector mutation are never parallelized/);
});

test('no mutation can begin before current final approval', () => {
  assert.match(files.phase4, /No mutation command or mutating skill may run/);
  assert.match(files.phase4, /implementation\.status` is `approved`/);
  assert.match(files.phase4, /bound plan\/contract hashes\s+still match/);
  assert.match(files.phase4, /pending-consolidated-review[\s\S]*stops before mutation/);
});