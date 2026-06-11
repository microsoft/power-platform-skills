'use strict';

// Integration test — exercises the FULL `plan-inner-loop` orchestrator flow
// across every one of the 7 canonical states from inner-loop-flow.md §3:
//
//     Disconnected | Clean | Dirty | Stale | Mixed | Conflicted | Broken
//
// For each state the test:
//   1. Spins up a Dataverse mock returning state-appropriate responses
//      for the four discovery helpers (binding, changes, updates, conflicts).
//   2. Invokes the helpers in the same order plan-inner-loop's Phase 2 runs.
//   3. Applies the state-classification rules to derive the state.
//   4. Writes inner-loop-plan.json the way the skill's Phase 3 does.
//   5. Renders the HTML via render-inner-loop-plan.render().
//   6. Reads back through inner-loop-plan-state.checkInnerLoopPlan() and
//      asserts the state round-trips correctly.
//   7. Spawns validate-plan-inner-loop.js — must exit 0 (HTML well-formed).
//
// This is the most cross-cutting of the 5 integration tests: it touches the
// orchestrator validator, every discovery helper, the state classifier
// function from the SKILL.md workflow, the renderer module, AND the heartbeat
// helper.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { startMock } = require('./mock-dataverse');

const { detectGitBinding } = require('../../lib/detect-git-binding');
const { listPendingChanges } = require('../../lib/list-pending-changes');
const { listIncomingUpdates } = require('../../lib/list-incoming-updates');
const { listConflicts } = require('../../lib/list-conflicts');
const { checkInnerLoopPlan } = require('../../lib/inner-loop-plan-state');
const {
  render, STATE_LABEL, NEXT_STEP,
} = require('../../../skills/plan-inner-loop/scripts/render-inner-loop-plan');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const PLAN_TEMPLATE = path.join(
  PLUGIN_ROOT, 'skills', 'plan-inner-loop', 'assets', 'inner-loop-plan-template.html',
);
const PLAN_VALIDATOR = path.join(
  PLUGIN_ROOT, 'skills', 'plan-inner-loop', 'scripts', 'validate-plan-inner-loop.js',
);

function mkTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-orchestrator-'));
  fs.writeFileSync(
    path.join(dir, 'powerpages.config.json'),
    JSON.stringify({ siteName: 'OrchestratorTestSite' }, null, 2),
  );
  fs.mkdirSync(path.join(dir, 'docs', 'inner-loop'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function runValidator(scriptPath, cwd) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
}

/**
 * Pure state-classifier — mirrors inner-loop-flow.md §3 transitions. This is
 * the logic plan-inner-loop's Phase 3 applies after Phase 2 discovery.
 *
 *   not bound                              → Disconnected
 *   bound + binding-read error             → Broken
 *   bound + 0/0/0                          → Clean
 *   bound + conflicts > 0                  → Conflicted   (takes precedence)
 *   bound + changes > 0 AND updates > 0    → Mixed
 *   bound + changes > 0                    → Dirty
 *   bound + updates > 0                    → Stale
 */
function classifyState(binding, counts) {
  if (binding && binding.broken) return 'Broken';
  if (!binding || !binding.bound) return 'Disconnected';
  const { changes = 0, updates = 0, conflicts = 0 } = counts || {};
  if (conflicts > 0) return 'Conflicted';
  if (changes > 0 && updates > 0) return 'Mixed';
  if (changes > 0) return 'Dirty';
  if (updates > 0) return 'Stale';
  return 'Clean';
}

function bindingRow({ branch = 'main', solutionUniqueName = null } = {}) {
  return {
    gitintegrationid: 'orch-binding-001',
    connectiontype: solutionUniqueName ? 0 : 1,
    organizationname: 'contoso',
    projectname: 'pp-site',
    repositoryname: 'pp-repo',
    branchname: branch,
    gitfolder: '/site',
    rootfolder: null,
    solutionuniquename: solutionUniqueName,
    connectionstatus: 'Connected',
  };
}

function changeRow(n) {
  // list-pending-changes.js queries /sourcecontrolcomponents (NOT /gitcommitfiles).
  return {
    sourcecontrolcomponentid: `scc-${n}`, componentid: `chg-${n}`,
    componentdisplayname: `Change${n}`, name: `Change${n}`,
    componenttypename: 'mspp_webpage', componenttype: 1054,
    solutioncomponentstate: 1, action: 0,
    'action@OData.Community.Display.V1.FormattedValue': 'Push',
    componentpath: `src/web-pages/p${n}.html`,
    partitionid: '00000000-0000-0000-0000-000000000000',
    modifiedon: '2025-01-01T00:00:00Z',
  };
}

function updateRow(n) {
  return {
    gitupdatefileid: `upd-${n}`, componentname: `Update${n}`,
    componenttype: 'mspp_webpage', updatetype: 0,
    commitsha: `sha${n}`, commitmessage: `commit ${n}`,
    solutionuniquename: 'IntSol',
  };
}

function conflictRow(n) {
  return {
    gitconflictfileid: `cnf-${n}`, componentname: `Conflict${n}`,
    componenttype: 'mspp_webtemplate', localchangetype: 1, incomingchangetype: 1,
    localcommitsha: null, incomingcommitsha: `sha${n}`,
    solutionuniquename: 'IntSol',
  };
}

/**
 * Build a route set returning given counts for each tab.
 * Pass `binding: 'missing'` to simulate the Disconnected state (empty value).
 * Pass `bindingStatus: 404` to simulate the env-not-managed case.
 */
function routesForCounts({
  binding = 'present',
  bindingStatus = 200,
  changes = 0, updates = 0, conflicts = 0,
}) {
  return [
    {
      method: 'GET',
      matcher: '/gitintegrations',
      status: bindingStatus,
      body:
        bindingStatus !== 200
          ? { error: { code: '0x80060000', message: 'simulated binding-read failure' } }
          : (binding === 'missing'
            ? { value: [] }
            : { value: [bindingRow({})] }),
    },
    {
      method: 'GET',
      matcher: '/sourcecontrolcomponents',
      body: { '@odata.count': changes, value: Array.from({ length: changes }, (_, i) => changeRow(i + 1)) },
    },
    {
      method: 'GET',
      matcher: '/gitupdatefiles',
      body: { value: Array.from({ length: updates }, (_, i) => updateRow(i + 1)) },
    },
    {
      method: 'GET',
      matcher: '/gitconflictfiles',
      body: { value: Array.from({ length: conflicts }, (_, i) => conflictRow(i + 1)) },
    },
  ];
}

/**
 * Reusable round-trip helper: spins up a mock with `routes`, runs the
 * orchestrator's Phase 2 + Phase 3 logic, writes both inner-loop-plan.json
 * AND inner-loop-plan.html, runs checkInnerLoopPlan + the validator, and
 * returns the observations.
 */
async function runOrchestratorCycle({ projectRoot, expectedState, routes, expectedCounts }) {
  const mock = await startMock(routes);
  try {
    // --- Phase 2 discovery ---
    const binding = await detectGitBinding({ envUrl: mock.baseUrl, token: 'fake-tok' });
    let counts = { changes: 0, updates: 0, conflicts: 0 };
    let broken = false;

    if (binding.error) {
      broken = true;
    } else if (binding.bound) {
      const [c, u, cn] = await Promise.all([
        listPendingChanges({ envUrl: mock.baseUrl, token: 'fake-tok' }),
        listIncomingUpdates({ envUrl: mock.baseUrl, token: 'fake-tok' }),
        listConflicts({       envUrl: mock.baseUrl, token: 'fake-tok' }),
      ]);
      counts = {
        changes:   c.error ? 0 : c.count,
        updates:   u.error ? 0 : u.count,
        conflicts: cn.error ? 0 : cn.count,
      };
    }

    // --- Phase 3 classify ---
    const computed = classifyState(
      binding.error ? { broken } : binding,
      counts,
    );
    assert.equal(computed, expectedState,
      `classifier mismatch for ${expectedState}: got ${computed}, counts=${JSON.stringify(counts)}`);
    if (expectedCounts) assert.deepEqual(counts, expectedCounts);

    // --- Phase 3 write plan + render HTML ---
    const planObj = {
      GENERATED_AT: '2025-01-01T00:00:00Z',
      PLAN_STATUS: 'Idle',
      siteName: 'OrchestratorTestSite',
      state: computed,
      binding: binding.bound ? {
        envUrl: mock.baseUrl,
        bindingType: binding.bindingType,
        organization: binding.organization,
        project: binding.project,
        repository: binding.repository,
        branch: binding.branch,
        gitFolder: binding.gitFolder,
      } : null,
      pendingCounts: counts,
      changes:   { count: counts.changes,   items: [] },
      updates:   { count: counts.updates,   items: [] },
      conflicts: { count: counts.conflicts, items: [] },
    };
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'inner-loop-plan.json'),
      JSON.stringify(planObj, null, 2),
    );
    const template = fs.readFileSync(PLAN_TEMPLATE, 'utf8');
    const html = render(template, planObj);
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'inner-loop-plan.html'),
      html, 'utf8',
    );

    // HTML sanity — must contain plan-status sentinel (validator looks for it)
    assert.ok(html.length > 500, `rendered HTML too small (${html.length} bytes)`);
    assert.ok(html.includes('plan-status'),
      'rendered HTML must carry the plan-status marker (validator looks for it)');
    // banner-title must reflect the state we expected
    assert.ok(html.includes(STATE_LABEL[computed].title),
      `HTML banner missing title for state ${computed}: ${STATE_LABEL[computed].title}`);
    // recommended next step must match
    assert.ok(html.includes(NEXT_STEP[computed].cmd),
      `HTML missing recommended cmd for state ${computed}: ${NEXT_STEP[computed].cmd}`);

    // --- Phase 0 heartbeat read-back ---
    const planState = await checkInnerLoopPlan({ projectRoot, writeHeartbeat: false });
    assert.equal(planState.exists, true);
    assert.equal(planState.state, computed);
    if (binding.bound) {
      assert.equal(planState.bindingDetected, true);
      assert.equal(planState.bindingType, binding.bindingType);
    } else {
      assert.equal(planState.bindingDetected, false);
    }

    // --- Validator gate ---
    const r = runValidator(PLAN_VALIDATOR, projectRoot);
    assert.equal(r.status, 0,
      `plan-inner-loop validator should approve for state ${computed}; stderr=${r.stderr}`);
  } finally {
    await mock.close();
  }
}

test('integration orchestrator — Disconnected: empty value array → not bound', async () => {
  const projectRoot = mkTempProject();
  try {
    await runOrchestratorCycle({
      projectRoot,
      expectedState: 'Disconnected',
      routes: routesForCounts({ binding: 'missing' }),
    });
  } finally { cleanup(projectRoot); }
});

test('integration orchestrator — Clean: bound + 0/0/0', async () => {
  const projectRoot = mkTempProject();
  try {
    await runOrchestratorCycle({
      projectRoot,
      expectedState: 'Clean',
      routes: routesForCounts({ changes: 0, updates: 0, conflicts: 0 }),
      expectedCounts: { changes: 0, updates: 0, conflicts: 0 },
    });
  } finally { cleanup(projectRoot); }
});

test('integration orchestrator — Dirty: bound + 3 changes', async () => {
  const projectRoot = mkTempProject();
  try {
    await runOrchestratorCycle({
      projectRoot,
      expectedState: 'Dirty',
      routes: routesForCounts({ changes: 3 }),
      expectedCounts: { changes: 3, updates: 0, conflicts: 0 },
    });
  } finally { cleanup(projectRoot); }
});

test('integration orchestrator — Stale: bound + 2 updates', async () => {
  const projectRoot = mkTempProject();
  try {
    await runOrchestratorCycle({
      projectRoot,
      expectedState: 'Stale',
      routes: routesForCounts({ updates: 2 }),
      expectedCounts: { changes: 0, updates: 2, conflicts: 0 },
    });
  } finally { cleanup(projectRoot); }
});

test('integration orchestrator — Mixed: bound + 2 changes AND 1 update', async () => {
  const projectRoot = mkTempProject();
  try {
    await runOrchestratorCycle({
      projectRoot,
      expectedState: 'Mixed',
      routes: routesForCounts({ changes: 2, updates: 1 }),
      expectedCounts: { changes: 2, updates: 1, conflicts: 0 },
    });
  } finally { cleanup(projectRoot); }
});

test('integration orchestrator — Conflicted: bound + 1 conflict (takes precedence over changes/updates)', async () => {
  const projectRoot = mkTempProject();
  try {
    await runOrchestratorCycle({
      projectRoot,
      expectedState: 'Conflicted',
      // Even with changes + updates present, conflicts dominate the state.
      routes: routesForCounts({ changes: 2, updates: 3, conflicts: 1 }),
      expectedCounts: { changes: 2, updates: 3, conflicts: 1 },
    });
  } finally { cleanup(projectRoot); }
});

test('integration orchestrator — Broken: binding read returns 500 error envelope', async () => {
  const projectRoot = mkTempProject();
  try {
    await runOrchestratorCycle({
      projectRoot,
      expectedState: 'Broken',
      routes: routesForCounts({ bindingStatus: 500 }),
    });
  } finally { cleanup(projectRoot); }
});

test('integration orchestrator — validate-plan-inner-loop BLOCKS when HTML is truncated', () => {
  const projectRoot = mkTempProject();
  try {
    fs.writeFileSync(
      path.join(projectRoot, 'docs', 'inner-loop', 'inner-loop-plan.html'),
      '<html><body>too small</body></html>',  // ~35 bytes < 500
    );
    const r = runValidator(PLAN_VALIDATOR, projectRoot);
    assert.equal(r.status, 2, `validator must block on truncated HTML; stderr=${r.stderr}`);
    assert.match(r.stderr, /too small/);
  } finally { cleanup(projectRoot); }
});

test('integration orchestrator — heartbeat write-back updates LAST_INVOCATION_AT when status=In Execution', async () => {
  const projectRoot = mkTempProject();
  try {
    const planPath = path.join(projectRoot, 'docs', 'inner-loop', 'inner-loop-plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      GENERATED_AT: '2025-01-01T00:00:00Z',
      PLAN_STATUS: 'In Execution',
      state: 'Clean',
      binding: { bindingType: 'environment', envUrl: 'http://x' },
      pendingCounts: { changes: 0, updates: 0, conflicts: 0 },
    }, null, 2));

    const now = Date.parse('2025-06-01T12:00:00.000Z');
    const r = await checkInnerLoopPlan({ projectRoot, writeHeartbeat: true, now });
    assert.equal(r.exists, true);
    assert.equal(r.state, 'Clean');
    assert.equal(r.inExecution.status, 'active'); // freshly heartbeated

    const written = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(written.LAST_INVOCATION_AT, new Date(now).toISOString(),
      'heartbeat write-back must update LAST_INVOCATION_AT');
  } finally { cleanup(projectRoot); }
});
