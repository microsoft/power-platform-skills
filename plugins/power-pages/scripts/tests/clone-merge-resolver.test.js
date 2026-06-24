'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runCloneMerge, resolveUnits, repoUrlFromBinding } = require('../lib/clone-merge-resolver');
const { isAtOrBeyond } = require('../lib/merge-run-state');

const REL = 'solutions/RetailOS/powerpagesites/site/web-templates/Search-Results/Search-Results.webtemplate.source.html';

function baseOpts(overrides = {}) {
  const phases = [];
  const calls = { openMergeFolder: 0, pushOrPr: 0, reconcileDataverse: 0, stageGitMerge: 0 };
  const deps = {
    buildAdoPath: () => ({ path: '/' + REL, field: 'source' }),
    readComponentContent: async () => ({ mergeFields: [{ key: 'source', value: 'a\nb-mine\nc\n', isText: true }], mergeStrategy: 'text' }),
    cloneOrUpdateRepo: async () => ({ ok: true, repoDir: '/clone/repo', ppMergeDir: '/clone/.pp-merge', branchTip: 'tipsha', inProgressMerge: false }),
    cloneDirLayout: ({ cloneDir }) => ({ cloneDir, repoDir: '/clone/repo', ppMergeDir: '/clone/.pp-merge' }),
    stageGitMerge: () => { calls.stageGitMerge++; return { ok: true, merge: { clean: false, conflicted: true, conflictedPaths: [REL] }, mergeCommit: null }; },
    detectMergeState: () => ({ clean: true, unmergedPaths: [], markerFiles: [] }),
    matchesRoster: () => ({ matches: true, missing: [], extra: [] }),
    openMergeFolder: () => { calls.openMergeFolder++; return { opened: true }; },
    pushOrPr: async () => { calls.pushOrPr++; return { mode: 'direct-push', pushed: true, branch: 'main' }; },
    reconcileDataverse: async () => { calls.reconcileDataverse++; return { ok: true, status: 'success', accepted: [{ name: 'Search Results' }] }; },
    recordMergeMetrics: () => {},
    git: {
      addAll: () => ({ ok: true }), mergeAbort: () => ({ ok: true }),
      runGit: () => ({ ok: true, stdout: '', stderr: '' }),
      revParse: () => ({ ok: true, stdout: 'mergedsha\n' }),
    },
    runState: { writeRunState: (dir, s) => phases.push(s.status ? `${s.phase}:${s.status}` : s.phase), readRunState: () => null, isAtOrBeyond },
  };
  const confirm = { done: async () => true, push: async () => true, pull: async () => true };
  const fsImpl = { readFileSync: () => 'a\nb-resolved\nc\n' };
  const opts = {
    cloneDir: 'C:/clones/sri-alm-dev-1', envUrl: 'https://org.crm.dynamics.com',
    solutionUniqueName: 'RetailOS', solutionId: 'sln1',
    binding: { organization: 'GitIntegration22', project: 'srijan-pp-alm', repository: 'srijan-pp-alm-2', branch: 'feature/dev-b', rootFolder: 'solutions', gitFolder: 'RetailOS', baseCommit: 'basesha', repositoryId: 'repo-guid' },
    conflicts: [{ conflictId: 'c1', componentId: 'cmp1', name: 'Search Results', type: 8, componentPath: '/powerpagesites/site/web-templates/Search-Results' }],
    user: 'sriagrawal', dvToken: 'dv', adoToken: 'ado', apply: true, deps, confirm, fsImpl,
  };
  return { opts: { ...opts, ...overrides }, phases, calls, deps, confirm };
}

test('Task 1: orchestrator extracts stages for the first conflict and passes mergeEditor to the launcher', async () => {
  const { opts } = baseOpts();
  opts.deps.extractMergeStages = ({ repoDir, relPath }) => ({ left: repoDir + '/stages/x/Dataverse.html', right: repoDir + '/stages/x/ADO.html', base: repoDir + '/stages/x/Base.html', result: repoDir + '/' + relPath, hasBase: true });
  let openArgs = null;
  opts.deps.openMergeFolder = (a) => { openArgs = a; return { opened: true, mergeCommand: 'code --merge ...', scmPointer: 'Open Source Control', panelLabels: { current: 'Dataverse (your environment)' } }; };
  // pause so we capture the awaiting-resolution return
  opts.pauseForResolution = true;
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'awaiting-resolution');
  assert.ok(openArgs.mergeEditor, 'mergeEditor passed to launcher');
  assert.match(openArgs.mergeEditor.left, /Dataverse\.html$/);   // Env → left
  assert.match(openArgs.mergeEditor.right, /ADO\.html$/);        // ADO → right
  assert.strictEqual(res.mergeEditorOpened, true);
  assert.match(res.scmPointer, /Source Control/);
});

test('dry-run returns a plan and performs no mutations', async () => {
  const { opts, calls } = baseOpts({ apply: false });
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'dry-run');
  assert.deepStrictEqual(res.plan.textUnits, ['/' + REL]);
  assert.strictEqual(calls.stageGitMerge, 0);
  assert.strictEqual(calls.pushOrPr, 0);
});

test('happy path: stage → resolve → direct push → reconcile success, gates honored', async () => {
  const { opts, phases, calls } = baseOpts();
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(res.mergeCommit, 'mergedsha');
  assert.strictEqual(calls.openMergeFolder, 1);
  assert.strictEqual(calls.pushOrPr, 1);
  assert.strictEqual(calls.reconcileDataverse, 1);
  // phase journal advanced through the clone-flow phases
  assert.ok(phases.some((p) => p.startsWith('staged')));
  assert.ok(phases.some((p) => p.startsWith('resolved')));
  assert.ok(phases.some((p) => p.startsWith('pushed')));
  assert.ok(phases.some((p) => p.startsWith('verified')));
});

test('reconcile receives resolved mergedContent read back from the clone', async () => {
  const { opts } = baseOpts();
  let received = null;
  opts.deps.reconcileDataverse = async (a) => { received = a.components; return { ok: true, status: 'success' }; };
  await runCloneMerge(opts);
  assert.strictEqual(received[0].mergedContent, 'a\nb-resolved\nc\n');
  assert.strictEqual(received[0].conflictId, 'c1');
});

test('done-gate: leftover markers stop the run before any push', async () => {
  const { opts, calls } = baseOpts();
  opts.deps.detectMergeState = () => ({ clean: false, unmergedPaths: [REL], markerFiles: [REL] });
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'needs-resolution');
  assert.deepStrictEqual(res.remaining.markerFiles, [REL]);
  assert.strictEqual(calls.pushOrPr, 0);
});

test('A1 fail-closed: text-eligible conflict that produces 0 text units aborts (no empty merge)', async () => {
  const { opts, calls } = baseOpts();
  // Simulate the silent-data-loss bug: a type-8 (web template = text-eligible)
  // conflict whose path can't be built → it would fall into binaryUnits and stage
  // an empty merge. The resolver must REFUSE and never call stageGitMerge.
  opts.deps.buildAdoPath = () => ({ supported: false, reason: 'simulated unsupported (e.g. string type slipped through)' });
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'failed');
  assert.match(res.error, /Expected 1 selective merge\(s\) but staged 0/);
  assert.ok(Array.isArray(res.eligibleButNotText) && res.eligibleButNotText.length === 1);
  assert.strictEqual(res.eligibleButNotText[0].name, 'Search Results');
  assert.strictEqual(calls.stageGitMerge, 0);
  assert.strictEqual(calls.openMergeFolder, 0);
});

test('A1 dry-run surfaces eligibleButNotText so the caller can see the mismatch', async () => {
  const { opts } = baseOpts({ apply: false });
  opts.deps.buildAdoPath = () => ({ supported: false, reason: 'simulated' });
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'dry-run');
  assert.strictEqual(res.plan.eligibleButNotText.length, 1);
});

test('A1: a genuinely binary-only conflict (web file) does NOT trip the abort', async () => {
  const { opts, calls } = baseOpts();
  // type 3 (web file) IS now selective-merge-eligible (sniff-based routing), but when
  // buildAdoPath returns {supported: false} the conflict is routed to binaryUnits
  // BEFORE the isWebFile sniff check — so it still ends up in binary, which is correct
  // and must not abort.
  opts.conflicts = [{ conflictId: 'c2', componentId: 'cmp2', name: 'theme.css', type: 3, componentPath: '/powerpagesites/site/web-files/theme.css' }];
  opts.deps.buildAdoPath = () => ({ supported: false, reason: 'Web File path not supported in this test' });
  opts.deps.stageGitMerge = () => { calls.stageGitMerge++; return { ok: true, merge: { clean: true, conflicted: false, conflictedPaths: [] }, mergeCommit: 'm' }; };
  const res = await runCloneMerge(opts);
  assert.notStrictEqual(res.status, 'failed');
});

test('A7 auto-stage: a resolved-but-unstaged file (no markers) is git-added before verify', async () => {
  const { opts } = baseOpts();
  const added = [];
  const baseRunGit = opts.deps.git.runGit;
  opts.deps.git.runGit = (a) => { if (a.args && a.args[0] === 'add' && a.args[1] === '--') added.push(a.args[2]); return baseRunGit(a); };
  // fsImpl returns fully-resolved content (no conflict markers) → must be auto-staged.
  opts.fsImpl = { readFileSync: () => 'a\nb-resolved\nc\n' };
  opts.deps.detectMergeState = () => ({ clean: false, unmergedPaths: [], markerFiles: [] });
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'success');
  assert.ok(added.includes(REL), 'resolved file should have been git-added');
});

test('A7 auto-stage: a file STILL containing conflict markers is NOT staged', async () => {
  const { opts } = baseOpts();
  const added = [];
  const baseRunGit = opts.deps.git.runGit;
  opts.deps.git.runGit = (a) => { if (a.args && a.args[0] === 'add' && a.args[1] === '--') added.push(a.args[2]); return baseRunGit(a); };
  opts.fsImpl = { readFileSync: () => 'a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> azure-devops\nc\n' };
  // markers present → detectMergeState reports markerFiles → needs-resolution, no add
  opts.deps.detectMergeState = () => ({ clean: false, unmergedPaths: [], markerFiles: [REL] });
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'needs-resolution');
  assert.ok(!added.includes(REL), 'a still-conflicted file must not be staged');
});

test('A8 atomic: binary decision is made BEFORE push, then exactly ONE push + ONE reconcile', async () => {
  const { opts, calls } = baseOpts();
  const order = [];
  // add a binary (web file) conflict alongside the text one
  opts.conflicts = [
    { conflictId: 'c1', componentId: 'cmp1', name: 'Search Results', type: 8, componentPath: '/powerpagesites/site/web-templates/Search-Results' },
    { conflictId: 'b1', componentId: 'cmpB', name: 'theme.css', type: 3, componentPath: '/powerpagesites/site/web-files/theme.css' },
  ];
  opts.deps.buildAdoPath = ({ type }) => (type === 3 ? { supported: false, reason: 'web file binary' } : { path: '/' + REL, field: 'source' });
  // per-file matrix: theme.css is the 2nd conflict → GLOBAL serial 2; select it.
  opts.confirm.binaryResolution = async ({ binaryUnits }) => { order.push('binary-decision'); assert.strictEqual(binaryUnits[0].serial, 2); return [2]; };
  const basePush = opts.deps.pushOrPr;
  opts.deps.pushOrPr = async (a) => { order.push('push'); return basePush(a); };
  let reconComponents = null;
  opts.deps.reconcileDataverse = async (a) => { order.push('reconcile'); reconComponents = a.components; return { ok: true, status: 'success' }; };
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(calls.pushOrPr, 1, 'exactly one push');
  // decision happens before push, push before reconcile
  assert.deepStrictEqual(order, ['binary-decision', 'push', 'reconcile']);
  // the SINGLE reconcile receives the COMPLETE set (text + binary with its decision)
  assert.strictEqual(reconComponents.length, 2);
  const bin = reconComponents.find((c) => c.name === 'theme.css');
  assert.strictEqual(bin.decision, 'accept-incoming'); // serial 2 selected → accept-incoming
});

test('A8 atomic: an UNSELECTED binary defaults to keep-current in the single reconcile (no separate commit/push)', async () => {
  const { opts, calls } = baseOpts();
  opts.conflicts = [
    { conflictId: 'c1', componentId: 'cmp1', name: 'Search Results', type: 8, componentPath: '/powerpagesites/site/web-templates/Search-Results' },
    { conflictId: 'b1', componentId: 'cmpB', name: 'Logo.png', type: 3, componentPath: '/powerpagesites/site/web-files/Logo.png' },
  ];
  opts.deps.buildAdoPath = ({ type }) => (type === 3 ? { supported: false, reason: 'web file binary' } : { path: '/' + REL, field: 'source' });
  opts.confirm.binaryResolution = async () => []; // user selects NOTHING → all keep-current
  let reconComponents = null;
  opts.deps.reconcileDataverse = async (a) => { reconComponents = a.components; return { ok: true, status: 'success' }; };
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(calls.pushOrPr, 1);            // still exactly one push
  const bin = reconComponents.find((c) => c.name === 'Logo.png');
  assert.strictEqual(bin.decision, 'keep-current'); // unselected → keep-current
});

test('Issue-3: reconcile runs in its OWN run-state sub-namespace (cannot masquerade as unstaged resolver run)', async () => {
  const { opts } = baseOpts();
  let reconRunStateDir = null;
  opts.deps.reconcileDataverse = async (a) => { reconRunStateDir = a.runStateDir; return { ok: true, status: 'success' }; };
  await runCloneMerge(opts);
  assert.ok(/[\\/]reconcile$/.test(String(reconRunStateDir)), `expected reconcile sub-dir, got ${reconRunStateDir}`);
});

test('Issue-1: polling an awaiting-pr run NEVER opens a second PR (run-state persists awaiting-pr)', async () => {
  // Stateful run-state that actually persists writes and returns them (the original
  // bug was masked by a fixed readRunState mock).
  let stored = null;
  const runState = {
    writeRunState: (_dir, s) => { stored = JSON.parse(JSON.stringify(s)); },
    readRunState: () => stored,
    isAtOrBeyond,
  };
  let pushCount = 0;
  function freshOpts(resume) {
    const { opts } = baseOpts();
    opts.deps.runState = runState;
    opts.deps.pushOrPr = async () => { pushCount++; return { mode: 'pr', prId: 101, prUrl: 'http://pr/101', runBranch: 'pp-merge/u/feature-dev-b-x' }; };
    // no getPr → prMerged() returns false → PR stays open (awaiting-pr)
    delete opts.deps.getPr;
    opts.resume = resume;
    return opts;
  }
  const inv1 = await runCloneMerge(freshOpts(false));
  assert.strictEqual(inv1.status, 'awaiting-pr');
  assert.strictEqual(pushCount, 1);
  const inv2 = await runCloneMerge(freshOpts(true));
  assert.strictEqual(inv2.status, 'awaiting-pr');
  const inv3 = await runCloneMerge(freshOpts(true));
  assert.strictEqual(inv3.status, 'awaiting-pr');
  assert.strictEqual(pushCount, 1, 'exactly one push/PR across all polls — no duplicate PR');
  // run-state still carries the awaiting-pr record for the next poll
  assert.strictEqual(stored.status, 'awaiting-pr');
  assert.ok(stored.pushInfo, 'pushInfo preserved across polls');
});

test('done-gate: resolved-but-uncommitted merge (in-progress, no unmerged/markers) proceeds', async () => {
  const { opts, calls } = baseOpts();
  // Merge still in progress (clean=false) but NO unmerged paths and NO markers →
  // the user resolved in VS Code without clicking "Continue"; must still finalize.
  opts.deps.detectMergeState = () => ({ clean: false, unmergedPaths: [], markerFiles: [] });
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(calls.pushOrPr, 1);
  assert.strictEqual(calls.reconcileDataverse, 1);
});

test('push consent denied → cancelled, no push', async () => {
  const { opts, calls } = baseOpts();
  opts.confirm.push = async () => false;
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'cancelled');
  assert.strictEqual(res.stage, 'push-consent');
  assert.strictEqual(calls.pushOrPr, 0);
});

test('pull consent fails closed when no gate is supplied', async () => {
  const { opts, calls } = baseOpts();
  delete opts.confirm.pull; // no pull gate → fail closed
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'cancelled');
  assert.strictEqual(res.stage, 'pull-consent');
  assert.strictEqual(calls.reconcileDataverse, 0);
});

test('PR path that has not merged → awaiting-pr (resumable), reconcile not run', async () => {
  const { opts, calls, phases } = baseOpts();
  opts.deps.pushOrPr = async () => ({ mode: 'pr', prId: 42, prUrl: 'http://pr/42', runBranch: 'pp-merge/sriagrawal/feature-dev-b-x' });
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'awaiting-pr');
  assert.strictEqual(res.prId, 42);
  assert.strictEqual(calls.reconcileDataverse, 0);
  assert.ok(phases.includes('resolved:awaiting-pr'));
});

test('resume of awaiting-pr: PR merged → proceeds to reconcile, opens NO new PR', async () => {
  const { opts, calls } = baseOpts({ resume: true });
  opts.deps.runState.readRunState = () => ({ phase: 'resolved', status: 'awaiting-pr', pushInfo: { mode: 'pr', prId: 42, prUrl: 'http://pr/42', runBranch: 'pp-merge/x' } });
  opts.deps.getPr = async () => ({ status: 'completed' });
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(calls.pushOrPr, 0); // must NOT open a new PR
  assert.strictEqual(calls.reconcileDataverse, 1);
});

test('resume of awaiting-pr: PR not merged → re-pauses on the SAME PR, no duplicate', async () => {
  const { opts, calls } = baseOpts({ resume: true });
  opts.deps.runState.readRunState = () => ({ phase: 'resolved', status: 'awaiting-pr', pushInfo: { mode: 'pr', prId: 42, prUrl: 'http://pr/42', runBranch: 'pp-merge/x' } });
  opts.deps.getPr = async () => ({ status: 'active' });
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'awaiting-pr');
  assert.strictEqual(res.prId, 42); // the SAME PR, not a freshly-created one
  assert.strictEqual(calls.pushOrPr, 0);
  assert.strictEqual(calls.reconcileDataverse, 0);
});

test('resolveUnits: text (8) + flat-yml site setting (9) → textUnits; web file (3) → binary', async () => {
  const deps = {
    buildAdoPath: ({ type }) =>
      type === 3 ? { supported: false, reason: 'web file binary' }
        : type === 9 ? { path: '/p/site-settings/S.sitesetting.yml', field: 'value', format: 'flat-yml' }
          : { path: '/' + REL, field: 'source' },
    readComponentContent: async ({ componentId }) =>
      componentId === 'b'
        ? { mergeFields: [{ key: 'value', value: 'DENY', isText: false }], mergeStrategy: 'scalar' } // site setting scalar
        : { mergeFields: [{ key: 'source', value: 'x\ny\n', isText: true }], mergeStrategy: 'text' },
  };
  const { textUnits, binaryUnits } = await resolveUnits({
    conflicts: [
      { conflictId: 'c1', componentId: 'a', name: 'Tpl', type: 8, componentPath: '/p/web-templates/Tpl' },
      { conflictId: 'c2', componentId: 'b', name: 'X-Frame', type: 9, componentPath: '/p/site-settings/X-Frame' },
      { conflictId: 'c3', componentId: 'c', name: 'logo.png', type: 3, componentPath: '/p/web-files/logo.png' },
    ],
    binding: { rootFolder: 'solutions', gitFolder: 'RetailOS' }, envUrl: 'u', dvToken: 't', deps,
  });
  assert.strictEqual(textUnits.length, 2);                       // Tpl + X-Frame (flat-yml)
  assert.ok(textUnits.find((u) => u.name === 'X-Frame' && u.flatYml === true));
  assert.strictEqual(binaryUnits.length, 1);
  assert.strictEqual(binaryUnits[0].name, 'logo.png');           // web file
});

test('resolveUnits: a MULTI-LINE site setting value falls back to binary/keep-accept', async () => {
  const deps = {
    buildAdoPath: () => ({ path: '/p/site-settings/J.sitesetting.yml', field: 'value', format: 'flat-yml' }),
    readComponentContent: async () => ({ mergeFields: [{ key: 'value', value: '{\n  "a": 1\n}', isText: true }], mergeStrategy: 'text' }),
  };
  const { textUnits, binaryUnits } = await resolveUnits({
    conflicts: [{ conflictId: 'c1', componentId: 'a', name: 'JsonSetting', type: 9, componentPath: '/p/site-settings/JsonSetting' }],
    binding: { rootFolder: 'solutions', gitFolder: 'RetailOS' }, envUrl: 'u', dvToken: 't', deps,
  });
  assert.strictEqual(textUnits.length, 0);
  assert.strictEqual(binaryUnits.length, 1);
  assert.match(binaryUnits[0].reason, /multi-line/);
});

test('binary/scalar conflict: not selected → keep-current threaded to reconcile', async () => {
  const { opts } = baseOpts();
  opts.conflicts = [{ conflictId: 'b1', componentId: 'set1', name: 'logo.png', type: 3, componentPath: '/p/web-files/logo.png' }];
  opts.deps.buildAdoPath = ({ type }) => (type === 3 ? { supported: false, reason: 'web file binary' } : { path: '/' + REL, field: 'source' });
  opts.deps.stageGitMerge = () => ({ ok: true, merge: { clean: true, conflicted: false, conflictedPaths: [] }, mergeCommit: 'msha' });
  let received = null;
  opts.deps.reconcileDataverse = async (a) => { received = a.components; return { ok: true, status: 'success' }; };
  opts.confirm.binaryResolution = async () => []; // select nothing
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].decision, 'keep-current');
  assert.strictEqual(received[0].conflictId, 'b1');
});

test('binary matrix: selecting a file by serial OR by name → accept-incoming for that file only', async () => {
  const { opts } = baseOpts();
  opts.conflicts = [
    { conflictId: 'b1', componentId: 's1', name: 'Alpha', type: 3, componentPath: '/p/web-files/Alpha.png' },
    { conflictId: 'b2', componentId: 's2', name: 'Beta', type: 3, componentPath: '/p/web-files/Beta.png' },
  ];
  opts.deps.buildAdoPath = ({ type }) => (type === 3 ? { supported: false, reason: 'web file binary' } : { path: '/' + REL, field: 'source' });
  opts.deps.stageGitMerge = () => ({ ok: true, merge: { clean: true, conflicted: false, conflictedPaths: [] }, mergeCommit: 'msha' });
  let received = null;
  opts.deps.reconcileDataverse = async (a) => { received = a.components; return { ok: true, status: 'success' }; };
  opts.confirm.binaryResolution = async () => [2]; // serial 2 = Beta → accept-incoming; Alpha → keep-current
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(received.find((c) => c.name === 'Alpha').decision, 'keep-current');
  assert.strictEqual(received.find((c) => c.name === 'Beta').decision, 'accept-incoming');
  // per-file decisions surfaced on the result
  assert.strictEqual(res.binaryDecisions.Alpha, 'keep-current');
  assert.strictEqual(res.binaryDecisions.Beta, 'accept-incoming');
});

test('Task 2: binary matrix carries GLOBAL roster serials (text first → binaries 3,4,5)', async () => {
  const { opts } = baseOpts();
  // 2 text conflicts (serials 1,2) then 3 binary (serials 3,4,5)
  opts.conflicts = [
    { conflictId: 't1', componentId: 'c1', name: 'Search Results', type: 8, componentPath: '/p/web-templates/Search-Results' },
    { conflictId: 't2', componentId: 'c2', name: 'Pagination', type: 8, componentPath: '/p/web-templates/Pagination' },
    { conflictId: 'b1', componentId: 's1', name: 'Cat.png', type: 3, componentPath: '/p/web-files/Cat.png' },
    { conflictId: 'b2', componentId: 's2', name: 'X-Frame', type: 3, componentPath: '/p/web-files/X-Frame.css' },
    { conflictId: 'b3', componentId: 's3', name: 'theme.css', type: 3, componentPath: '/p/web-files/theme.css' },
  ];
  opts.deps.buildAdoPath = ({ type }) => (type === 3 ? { supported: false, reason: 'binary' } : { path: '/' + REL, field: 'source' });
  let presentedMatrix = null;
  opts.confirm.binaryResolution = async ({ binaryUnits }) => { presentedMatrix = binaryUnits; return [3, 5]; }; // accept Cat.png(3) + theme.css(5)
  let received = null;
  opts.deps.reconcileDataverse = async (a) => { received = a.components; return { ok: true, status: 'success' }; };
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'success');
  assert.deepStrictEqual(presentedMatrix.map((m) => m.serial), [3, 4, 5]); // global serials
  // serials 3 & 5 → accept-incoming; 4 (X-Frame) → keep-current
  assert.strictEqual(received.find((c) => c.name === 'Cat.png').decision, 'accept-incoming');
  assert.strictEqual(received.find((c) => c.name === 'theme.css').decision, 'accept-incoming');
  assert.strictEqual(received.find((c) => c.name === 'X-Frame').decision, 'keep-current');
});

test('binary/scalar conflict: default (no gate) → keep-current (user must explicitly accept incoming)', async () => {
  const { opts } = baseOpts();
  opts.conflicts = [{ conflictId: 'b1', componentId: 'set1', name: 'logo.png', type: 3, componentPath: '/p/web-files/logo.png' }];
  opts.deps.buildAdoPath = ({ type }) => (type === 3 ? { supported: false } : { path: '/' + REL, field: 'source' });
  opts.deps.stageGitMerge = () => ({ ok: true, merge: { clean: true, conflicted: false, conflictedPaths: [] }, mergeCommit: 'msha' });
  let received = null;
  opts.deps.reconcileDataverse = async (a) => { received = a.components; return { ok: true, status: 'success' }; };
  await runCloneMerge(opts); // no binaryResolution gate → default keep-current
  assert.strictEqual(received[0].decision, 'keep-current');
});

test('buildBinaryMatrix + resolveBinaryDecisions: serials, accept-all/keep-all, mixed selection', () => {
  const { buildBinaryMatrix, resolveBinaryDecisions } = require('../lib/clone-merge-resolver');
  const matrix = buildBinaryMatrix([
    { name: 'Cat.png', type: 3, route: 'keep-accept' },
    { name: 'theme.css', type: 3, route: 'keep-accept' },
    { name: 'X-Frame', type: 9, reason: 'scalar' },
  ]);
  assert.deepStrictEqual(matrix.map((m) => m.serial), [1, 2, 3]);
  assert.equal(matrix[0].typeLabel, 'Web File');
  // default / keep-all
  assert.deepStrictEqual(resolveBinaryDecisions(matrix, []), { 'Cat.png': 'keep-current', 'theme.css': 'keep-current', 'X-Frame': 'keep-current' });
  assert.deepStrictEqual(resolveBinaryDecisions(matrix, null), { 'Cat.png': 'keep-current', 'theme.css': 'keep-current', 'X-Frame': 'keep-current' });
  assert.deepStrictEqual(resolveBinaryDecisions(matrix, 'keep-mine'), { 'Cat.png': 'keep-current', 'theme.css': 'keep-current', 'X-Frame': 'keep-current' });
  // accept-all
  assert.deepStrictEqual(resolveBinaryDecisions(matrix, 'all-accept'), { 'Cat.png': 'accept-incoming', 'theme.css': 'accept-incoming', 'X-Frame': 'accept-incoming' });
  // mixed by serial + name
  assert.deepStrictEqual(resolveBinaryDecisions(matrix, [1, 'X-Frame']), { 'Cat.png': 'accept-incoming', 'theme.css': 'keep-current', 'X-Frame': 'accept-incoming' });
});

test('Task 2 (per-file matrix): 4 binary/scalar conflicts, --binary-accept "2,4" → #2,#4 accept-incoming, rest keep-current', () => {
  const { buildBinaryMatrix, resolveBinaryDecisions } = require('../lib/clone-merge-resolver');
  const { parseSerialSelection } = require('../lib/parse-serial-selection');
  // 4 binary/scalar conflicts presented with stable serials 1..4
  const matrix = buildBinaryMatrix([
    { name: 'Cat-PC.png', type: 3, route: 'keep-accept' },
    { name: 'Logo.png', type: 3, route: 'keep-accept' },
    { name: 'theme.css', type: 3, route: 'keep-accept' },
    { name: 'X-Frame-Options', type: 9, reason: 'scalar' },
  ]);
  assert.deepStrictEqual(matrix.map((m) => m.serial), [1, 2, 3, 4]);

  // Reproduce the EXACT CLI chain for `--binary-accept "2,4"` (clone-merge-resolver.js binaryResolution):
  const validSerials = matrix.map((u) => u.serial);
  const parsed = parseSerialSelection('2,4', validSerials);
  assert.ok(parsed.ok && !parsed.all);
  assert.deepStrictEqual(parsed.accepted, [2, 4]);
  const selection = parsed.all ? 'all-accept' : parsed.accepted; // mirrors line ~534
  const decisions = resolveBinaryDecisions(matrix, selection);

  // #2 (Logo.png) and #4 (X-Frame-Options) accept-incoming; the other two keep-current — a real MIX in one run.
  assert.deepStrictEqual(decisions, {
    'Cat-PC.png': 'keep-current',
    'Logo.png': 'accept-incoming',
    'theme.css': 'keep-current',
    'X-Frame-Options': 'accept-incoming',
  });
});

test('repoUrlFromBinding builds a dev.azure.com URL or passes one through', () => {
  assert.strictEqual(
    repoUrlFromBinding({ organization: 'O', project: 'P', repository: 'R' }),
    'https://dev.azure.com/O/P/_git/R',
  );
  assert.strictEqual(repoUrlFromBinding({ repoUrl: 'https://x/y' }), 'https://x/y');
});

test('RESUME must NOT reset the clone (no-push bug): resume uses cloneDirLayout, never cloneOrUpdateRepo', async () => {
  // Regression for the silent no-op push: cloneOrUpdateRepo's reuse path resets HEAD to
  // origin/<branch>, moving it OFF the local `dataverse` merge commit. Since the push
  // step pushes HEAD → <branch>, a reset on resume makes the push a no-op (it pushes the
  // unchanged origin tip). On resume we must ONLY locate the clone paths (cloneDirLayout)
  // and leave the worktree — with the resolved merge on HEAD — untouched.
  let cloneOrUpdateCallCount = 0;
  let layoutCallCount = 0;
  let layoutArgs = null;
  const { opts } = baseOpts({ resume: true });
  opts.deps.runState.readRunState = () => ({ phase: 'staged', binding: opts.binding, envUrl: opts.envUrl, solutionUniqueName: opts.solutionUniqueName });
  opts.deps.cloneOrUpdateRepo = async () => { cloneOrUpdateCallCount++; return { ok: true, repoDir: '/clone/repo', ppMergeDir: '/clone/.pp-merge', branchTip: 'tipsha' }; };
  opts.deps.cloneDirLayout = ({ cloneDir }) => { layoutCallCount++; layoutArgs = { cloneDir }; return { cloneDir, repoDir: '/clone/repo', ppMergeDir: '/clone/.pp-merge' }; };
  await runCloneMerge(opts);
  assert.strictEqual(cloneOrUpdateCallCount, 0, 'resume must NOT call cloneOrUpdateRepo (would reset HEAD off the merge)');
  assert.strictEqual(layoutCallCount, 1, 'resume locates the clone via cloneDirLayout');
  assert.strictEqual(layoutArgs.cloneDir, 'C:/clones/sri-alm-dev-1', 'cloneDir passed to cloneDirLayout');
});

test('FRESH run still clones via cloneOrUpdateRepo (reset to a pristine tree)', async () => {
  let cloneOrUpdateCallCount = 0;
  let capturedArgs = null;
  const { opts } = baseOpts(); // resume defaults to false
  opts.deps.cloneOrUpdateRepo = async (a) => { cloneOrUpdateCallCount++; capturedArgs = a; return { ok: true, repoDir: '/clone/repo', ppMergeDir: '/clone/.pp-merge', branchTip: 'tipsha', reused: false }; };
  opts.pauseForResolution = true;
  await runCloneMerge(opts);
  assert.strictEqual(cloneOrUpdateCallCount, 1, 'fresh run clones/updates exactly once');
  assert.strictEqual(capturedArgs.cloneDir, 'C:/clones/sri-alm-dev-1');
  assert.ok(!('base' in capturedArgs) && !('envName' in capturedArgs), 'no base/envName in the clone call');
});

test('A3: awaiting-resolution result carries clonePath + reusedClone from cloneOrUpdateRepo', async () => {
  const { opts } = baseOpts();
  opts.deps.cloneOrUpdateRepo = async () => ({
    ok: true, repoDir: '/clone/repo', ppMergeDir: '/clone/.pp-merge', branchTip: 'tipsha', reused: true, inProgressMerge: false,
  });
  opts.pauseForResolution = true;
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'awaiting-resolution');
  assert.strictEqual(res.clonePath, 'C:/clones/sri-alm-dev-1', 'clonePath must match the input cloneDir');
  assert.strictEqual(res.reusedClone, true, 'reusedClone must reflect cloneOrUpdateRepo.reused');
});

// ---- Webfile (type 3) sniff-based routing ----

test('resolveUnits: TEXT web file (sniff → text) becomes textUnit with webfile:true, field:null', async () => {
  const deps = {
    buildAdoPath: ({ type }) =>
      type === 3 ? { path: '/solutions/R/powerpagesites/site/web-files/theme.css', field: null }
                 : { path: '/' + REL, field: 'source' },
    readComponentContent: async () => ({ mergeFields: [{ key: 'source', value: 'x', isText: true }], mergeStrategy: 'text' }),
    readWebFileBytes: async () => ({ bytes: Buffer.from('body { color: red; }'), eol: '\n', bom: false }),
    sniffTextOrBinary: () => ({ isText: true, encoding: 'utf-8', reason: 'no NUL bytes' }),
  };
  const { textUnits, binaryUnits } = await resolveUnits({
    conflicts: [{ conflictId: 'wf1', componentId: 'cmpW', name: 'theme.css', type: 3, componentPath: '/p/web-files/theme.css' }],
    binding: { rootFolder: 'solutions', gitFolder: 'RetailOS' }, envUrl: 'u', dvToken: 't', deps,
  });
  assert.strictEqual(textUnits.length, 1, 'text web file should be a text unit');
  assert.strictEqual(textUnits[0].webfile, true, 'webfile flag must be true');
  assert.strictEqual(textUnits[0].field, null, 'field must be null for web files');
  assert.strictEqual(textUnits[0].adoPath, '/solutions/R/powerpagesites/site/web-files/theme.css');
  assert.ok(textUnits[0].oursContent.includes('body'), 'oursContent must contain decoded text');
  assert.strictEqual(binaryUnits.length, 0, 'no binary units');
});

test('resolveUnits: BINARY web file (sniff → binary) goes to binaryUnits (matrix)', async () => {
  const deps = {
    buildAdoPath: ({ type }) =>
      type === 3 ? { path: '/solutions/R/powerpagesites/site/web-files/Logo.png', field: null }
                 : { path: '/' + REL, field: 'source' },
    readWebFileBytes: async () => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]), eol: null, bom: false }),
    sniffTextOrBinary: () => ({ isText: false, reason: 'NUL byte at offset 4' }),
  };
  const { textUnits, binaryUnits } = await resolveUnits({
    conflicts: [{ conflictId: 'wf2', componentId: 'cmpB', name: 'Logo.png', type: 3, componentPath: '/p/web-files/Logo.png' }],
    binding: { rootFolder: 'solutions', gitFolder: 'RetailOS' }, envUrl: 'u', dvToken: 't', deps,
  });
  assert.strictEqual(textUnits.length, 0, 'binary web file must not be a text unit');
  assert.strictEqual(binaryUnits.length, 1, 'binary web file must be in binaryUnits');
  assert.strictEqual(binaryUnits[0].name, 'Logo.png');
  assert.strictEqual(binaryUnits[0].route, 'keep-accept');
});

test('resolveUnits: readWebFileBytes error → binary (safe fallback, not an abort)', async () => {
  const deps = {
    buildAdoPath: ({ type }) =>
      type === 3 ? { path: '/web-files/bad.css', field: null } : { path: '/' + REL, field: 'source' },
    readWebFileBytes: async () => ({ error: 'Dataverse 403', statusCode: 403 }),
    sniffTextOrBinary: () => ({ isText: true }),
  };
  const { textUnits, binaryUnits, eligibleButNotText } = await resolveUnits({
    conflicts: [{ conflictId: 'wf3', componentId: 'cmpE', name: 'bad.css', type: 3, componentPath: '/p/web-files/bad.css' }],
    binding: { rootFolder: 'solutions', gitFolder: 'RetailOS' }, envUrl: 'u', dvToken: 't', deps,
  });
  assert.strictEqual(textUnits.length, 0);
  assert.strictEqual(binaryUnits.length, 1);
  assert.strictEqual(eligibleButNotText.length, 0, 'web file read errors must never trigger fail-closed abort');
});

test('THEIRS-binary DEMOTION: env bytes text but staged THEIRS sniffs binary → unit demoted, binaryMatrix updated, warning emitted', async () => {
  const { opts } = baseOpts();
  // Add a webfile conflict alongside the existing text conflict
  opts.conflicts = [
    { conflictId: 'c1', componentId: 'cmp1', name: 'Search Results', type: 8, componentPath: '/powerpagesites/site/web-templates/Search-Results' },
    { conflictId: 'wf1', componentId: 'cmpW', name: 'theme.css', type: 3, componentPath: '/powerpagesites/site/web-files/theme.css' },
  ];
  const WF_PATH = 'solutions/RetailOS/powerpagesites/site/web-files/theme.css';
  opts.deps.buildAdoPath = ({ type }) =>
    type === 3 ? { path: '/' + WF_PATH, field: null }
               : { path: '/' + REL, field: 'source' };
  opts.deps.readWebFileBytes = async () => ({ bytes: Buffer.from('/* CSS text */'), eol: '\n', bom: false });
  // sniff: text when no NUL, binary when NUL present
  opts.deps.sniffTextOrBinary = (buf) => {
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0) return { isText: false, reason: 'NUL at ' + i };
    return { isText: true, encoding: 'utf-8' };
  };
  // THEIRS (:3:) for the webfile returns binary content (has NUL byte)
  const baseRunGit = opts.deps.git.runGit;
  opts.deps.git.runGit = (a) => {
    if (a.args && a.args[0] === 'show' && a.args[1] && String(a.args[1]).startsWith(':3:') && String(a.args[1]).includes('web-files')) {
      return { ok: true, stdout: '\x89PNG\x00\x00binary-content' }; // binary THEIRS
    }
    return baseRunGit(a);
  };
  opts.pauseForResolution = true;
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'awaiting-resolution');
  // theme.css was demoted: appears in binaryMatrix, not in conflictedPaths
  assert.ok(Array.isArray(res.binaryMatrix) && res.binaryMatrix.some((m) => m.name === 'theme.css'), 'demoted webfile must appear in binaryMatrix');
  assert.ok(Array.isArray(res.demotionWarnings) && res.demotionWarnings.length > 0, 'demotion warning must be emitted');
  assert.ok(res.demotionWarnings[0].includes('theme.css'), 'warning must name the demoted file');
  // The type-8 text conflict is still in the text merge (not demoted)
  assert.ok(!res.binaryMatrix.some((m) => m.name === 'Search Results'), 'non-webfile text unit must NOT be demoted');
});

test('containerized web file: post-clone leaf resolution rewrites the text-unit path before staging (EISDIR fix)', async () => {
  const { opts } = baseOpts();
  const FOLDER = '/solutions/RetailOS/powerpagesites/site/web-files/theme.css';
  const LEAF = FOLDER + '/theme.css';
  opts.conflicts = [
    { conflictId: 'w1', componentId: 'wf1', name: 'theme.css', type: 3, componentPath: '/powerpagesites/site/web-files/theme.css' },
  ];
  opts.deps.buildAdoPath = ({ type }) => (type === 3 ? { path: FOLDER, kind: 'webfile', field: null } : { path: '/' + REL, field: 'source' });
  opts.deps.readWebFileBytes = async () => ({ bytes: Buffer.from('body { color: red; }'), eol: '\n', bom: false });
  opts.deps.sniffTextOrBinary = () => ({ isText: true, encoding: 'utf-8' });
  let leafArg = null;
  opts.deps.resolveWebFileLeaf = ({ repoDir, webFilePath }) => { leafArg = { repoDir, webFilePath }; return webFilePath === FOLDER ? LEAF : webFilePath; };
  let stagedTextUnits = null;
  opts.deps.stageGitMerge = ({ textUnits }) => { stagedTextUnits = textUnits; return { ok: true, merge: { clean: false, conflicted: true, conflictedPaths: [LEAF.replace(/^\//, '')] }, mergeCommit: null }; };
  opts.pauseForResolution = true;
  const res = await runCloneMerge(opts);
  assert.strictEqual(res.status, 'awaiting-resolution');
  // resolveWebFileLeaf was called with the clone's repoDir + the FOLDER path
  assert.ok(leafArg && leafArg.webFilePath === FOLDER, 'resolveWebFileLeaf called with the folder path');
  assert.strictEqual(leafArg.repoDir, '/clone/repo');
  // staging received the inner LEAF path (not the folder) → no EISDIR
  assert.ok(stagedTextUnits && stagedTextUnits.some((u) => u.adoPath === LEAF), 'stage received the inner leaf path');
  assert.ok(!stagedTextUnits.some((u) => u.adoPath === FOLDER), 'stage must NOT receive the folder path');
});
