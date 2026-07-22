'use strict';

// Smoke tests for the centralized PostToolUse hook (hooks/run-skill-posttool-validation.js).
//
// Two contracts are covered here that no other test exercised:
//   1. The ALM-plan reconcile BACKSTOP actually spawns after an ALM skill when a
//      docs/.alm-plan-data.json exists — and heals a skipped refresh (auto-heal).
//   2. EXIT-CODE NEUTRALITY: the reconcile is best-effort and must never change the
//      hook's exit code — the validator's status stands. We prove this by running the
//      SAME blocking-validator scenario with the reconcile branch reachable (plan
//      present) and unreachable (no plan) and asserting the exit code is identical.
//
// The hook is exercised as a real child process (the way Claude Code invokes it),
// piping a tool_input JSON over stdin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOOK_PATH = path.join(__dirname, '..', '..', 'hooks', 'run-skill-posttool-validation.js');

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-posttool-'));
  fs.mkdirSync(path.join(root, 'docs', 'alm'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Backdate the plan file so a just-written marker is unambiguously "newer".
function backdatePlan(root, secondsAgo = 60) {
  const p = path.join(root, 'docs', '.alm-plan-data.json');
  const ts = (Date.now() - secondsAgo * 1000) / 1000;
  fs.utimesSync(p, ts, ts);
}

function runHook(root, skill) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ tool_input: { skill }, cwd: root }),
    encoding: 'utf8',
    cwd: root,
  });
}

test('hook spawns the reconcile backstop and heals a skipped refresh after an ALM skill', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'T',
    pipelineMeta: { lastDeploy: null },
    steps: [{ name: 'Deploy via pipeline to Staging', status: 'pending' }],
    stages: [{ label: 'Staging', envUrl: 'https://stg.crm.dynamics.com/', type: 'target' }],
  });
  // Marker written AFTER the plan (skill ran but its in-skill refresh step was skipped).
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    pipelineId: 'p1',
    stageRunId: 'sr1',
    solutionName: 'MySolution',
    stageName: 'Staging',
    status: 'Succeeded',
    deployedAt: '2026-06-16T00:00:00.000Z',
    componentCount: 118,
  });
  backdatePlan(root);

  const res = runHook(root, 'deploy-pipeline');

  // Validator approves (all required fields present, not Failed) → exit 0.
  assert.equal(res.status, 0, `hook should exit 0; stderr=${res.stderr}`);
  // The backstop fired and announced the auto-heal.
  assert.match(res.stdout, /refreshed automatically/i,
    `expected the reconcile notice in stdout; got: ${res.stdout}`);
  // And it actually ingested the marker into the plan.
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.pipelineMeta.lastDeploy.status, 'Succeeded');
  assert.equal(planData.pipelineMeta.lastDeploy.componentCount, 118);
  // A clean reconcile must stay quiet on stderr — the hook fires on every Skill
  // use, so success must not produce failure noise.
  assert.doesNotMatch(res.stderr, /reconcile/i, 'a successful reconcile must not write failure noise to stderr');
});

test('hook forwards reconcile failure detail to stderr without changing the exit code', (t) => {
  // A malformed plan file makes refresh-alm-plan-data.js --reconcile throw and exit
  // non-zero with its reason on stderr. The hook must (a) surface that — the prior
  // empty JSON.parse catch swallowed spawn errors / timeouts / non-zero exits — and
  // (b) stay non-blocking (the reconcile is best-effort; the validator's status stands).
  const root = makeProject(t);
  fs.writeFileSync(path.join(root, 'docs', '.alm-plan-data.json'), 'not json {{{', 'utf8');
  // A newer marker guarantees the reconcile reaches the plan-parse (and would heal if it could).
  writeJson(path.join(root, 'docs', 'alm', 'last-export.json'), { solutionUniqueName: 'S', exportedAt: '2026-06-16T00:00:00.000Z' });
  backdatePlan(root);

  // export-solution is an ALM skill; its validator gracefully approves (no zip) → exit 0.
  const res = runHook(root, 'export-solution');

  assert.equal(res.status, 0, 'a broken reconcile must not change the validator-determined exit code');
  assert.match(res.stderr, /reconcile did not complete/i, 'the hook must report the broken reconcile');
  assert.match(res.stderr, /Could not parse/i, 'the child reconcile stderr must be forwarded verbatim');
});

test('hook does NOT reconcile for a non-ALM skill even when a plan + newer marker exist', (t) => {
  const root = makeProject(t);
  writeJson(path.join(root, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'T',
    pipelineMeta: { lastDeploy: null },
    steps: [{ name: 'Deploy via pipeline to Staging', status: 'pending' }],
  });
  writeJson(path.join(root, 'docs', 'alm', 'last-deploy.json'), {
    pipelineId: 'p1', stageRunId: 'sr1', solutionName: 'S', status: 'Succeeded',
    deployedAt: '2026-06-16T00:00:00.000Z', componentCount: 99,
  });
  backdatePlan(root);

  // create-site is a tracked skill but NOT an ALM plan skill → isAlmPlanSkill === false.
  const res = runHook(root, 'create-site');

  assert.doesNotMatch(res.stdout, /refreshed automatically/i,
    'non-ALM skill must not trigger the reconcile backstop');
  // The plan must be untouched — the deploy marker was NOT ingested.
  const planData = readJson(path.join(root, 'docs', '.alm-plan-data.json'));
  assert.equal(planData.pipelineMeta.lastDeploy, null,
    'non-ALM skill path must leave the plan unchanged');
});

test('reconcile backstop is exit-code-neutral: a blocking validator status is unchanged whether or not the plan is present', (t) => {
  // A Failed deploy marker makes validate-deploy-pipeline.js BLOCK (exit 2). The
  // reconcile runs too (plan present) — and must NOT mask or alter that exit code.
  const failedMarker = {
    pipelineId: 'p1', stageRunId: 'sr1', solutionName: 'S', stageName: 'Staging',
    status: 'Failed', deployedAt: '2026-06-16T00:00:00.000Z',
  };

  // (A) Reconcile branch REACHABLE — docs/.alm-plan-data.json exists.
  const withPlan = makeProject(t);
  writeJson(path.join(withPlan, 'docs', 'alm', 'last-deploy.json'), failedMarker);
  writeJson(path.join(withPlan, 'docs', '.alm-plan-data.json'), {
    SITE_NAME: 'T', steps: [{ name: 'Deploy via pipeline to Staging', status: 'pending' }],
  });
  backdatePlan(withPlan);
  const resWith = runHook(withPlan, 'deploy-pipeline');

  // (B) Reconcile branch UNREACHABLE — no plan file at all.
  const withoutPlan = makeProject(t);
  writeJson(path.join(withoutPlan, 'docs', 'alm', 'last-deploy.json'), failedMarker);
  const resWithout = runHook(withoutPlan, 'deploy-pipeline');

  assert.equal(resWith.status, 2, 'blocking validator must surface exit 2 with the plan present');
  assert.equal(resWithout.status, 2, 'blocking validator must surface exit 2 with no plan');
  assert.equal(resWith.status, resWithout.status,
    'the reconcile backstop must not change the validator-determined exit code');
});
