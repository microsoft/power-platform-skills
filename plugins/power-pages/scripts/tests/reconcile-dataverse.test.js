'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reconcileDataverse, isActionAbsent } = require('../lib/reconcile-dataverse');

const COMPONENTS = [{
  conflictId: 'g1',
  componentId: 'c1',
  name: 'Search',
  type: 8,
  field: 'source',
  adoPath: '/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Search/Search.webtemplate.source.html',
  oursContent: 'OURS',
  mergedContent: 'MERGED\n',
}];

function fakeRunState() {
  const phases = ['started', 'accepted', 'pulled', 'verified'];
  return {
    writes: [],
    isAtOrBeyond: (current, target) => phases.indexOf(current) >= phases.indexOf(target),
    writeRunState(dir, state) { this.writes.push({ dir, state }); },
  };
}

function deps(overrides = {}) {
  return {
    refreshChangesFromGit: async () => ({ ok: true }),
    resolveGitConflictUserAction: async () => ({ ok: true, useraction: 2 }),
    resolveConflictAccept: async () => ({ resolved: true, outcome: 'accept-incoming' }),
    pullChangesFromGit: async () => ({ ok: true }),
    listConflicts: async () => ({ count: 0, items: [] }),
    readComponentContent: async () => ({ mergeFields: [{ key: 'source', value: 'MERGED\r\n', isText: true }] }),
    resolveSolutionId: async () => 'resolved-sol-id',
    runState: fakeRunState(),
    ...overrides,
  };
}

test('dry-run: returns plan, performs no mutations', async () => {
  let refreshed = false;
  const d = deps({ refreshChangesFromGit: async () => { refreshed = true; return { ok: true }; } });
  const r = await reconcileDataverse({
    components: COMPONENTS,
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    apply: false,
    deps: d,
  });
  assert.equal(r.status, 'dry-run');
  assert.equal(r.ok, true);
  assert.equal(r.plan.wouldRefresh, true);
  assert.deepEqual(r.plan.wouldAccept, ['g1']);
  assert.equal(r.plan.wouldPull, true);
  assert.equal(refreshed, false);
});

test('keep-current ("keep mine") decision is passed through to useraction and skips content-verify', async () => {
  let decisionUsed = null;
  const d = deps({
    resolveGitConflictUserAction: async ({ decision }) => { decisionUsed = decision; return { ok: true, useraction: 1 }; },
  });
  const r = await reconcileDataverse({
    components: [{ ...COMPONENTS[0], decision: 'keep-current' }],
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    apply: true,
    deps: d,
  });
  assert.equal(decisionUsed, 'keep-current');
  // content-verify must SKIP a keep-current component (env value intentionally retained)
  const cv = r.contentVerify.find((x) => x.name === 'Search');
  assert.equal(cv.result, 'skipped');
  assert.match(cv.reason, /keep-current/);
});

// ---- A5: converged-conflict detection + bounded retry ----
test('A5 converged detection: env == bound-branch → decision flipped to keep-current (no accept-incoming loop)', async () => {
  let decisionUsed = null;
  const d = deps({
    // env value and branch file are byte-identical (after LF/BOM) → converged.
    readComponentContent: async () => ({ mergeFields: [{ key: 'source', value: 'SAME\r\n', isText: true }] }),
    readBranchContent: async () => 'SAME\n',
    resolveGitConflictUserAction: async ({ decision }) => { decisionUsed = decision; return { ok: true, useraction: decision === 'keep-current' ? 1 : 2 }; },
  });
  const r = await reconcileDataverse({
    components: COMPONENTS, envUrl: 'https://e', solutionUniqueName: 'RetailOS', solutionId: 'sol', apply: true, deps: d,
  });
  assert.equal(decisionUsed, 'keep-current'); // flipped automatically
  assert.equal(r.status, 'success');
  const dc = r.steps.find((s) => s.step === 'detect-converged');
  assert.ok(dc && dc.converged.includes('Search'));
});

test('A5 converged (flat-yml): branch yml `value:` == env value → keep-current (compares the value line, not the whole yml)', async () => {
  let decisionUsed = null;
  const SS = {
    conflictId: 'g9', componentId: 'c9', name: 'HTTP/X-Frame-Options', type: 9, field: 'value',
    adoPath: '/solutions/RetailOS/powerpagesites/RetailOS/site-settings/HTTP-X-Frame-Options.sitesetting.yml',
    oursContent: 'DENY', mergedContent: 'DENY',
  };
  const d = deps({
    readComponentContent: async () => ({ mergeFields: [{ key: 'value', value: 'DENY', isText: false }] }),
    // the bound-branch file is the WHOLE .sitesetting.yml — only the value: line matches the env scalar
    readBranchContent: async () => 'name: HTTP/X-Frame-Options\nvalue: DENY\nwebsiteid: abc-123\n',
    resolveGitConflictUserAction: async ({ decision }) => { decisionUsed = decision; return { ok: true, useraction: decision === 'keep-current' ? 1 : 2 }; },
  });
  const r = await reconcileDataverse({ components: [SS], envUrl: 'https://e', solutionUniqueName: 'RetailOS', solutionId: 'sol', apply: true, deps: d });
  assert.equal(decisionUsed, 'keep-current'); // converged via value: extraction → auto-flipped
  const dc = r.steps.find((s) => s.step === 'detect-converged');
  assert.ok(dc && dc.converged.includes('HTTP/X-Frame-Options'));
});

test('A5 NOT converged: env != branch → stays accept-incoming', async () => {
  let decisionUsed = null;
  const d = deps({
    readComponentContent: async () => ({ mergeFields: [{ key: 'source', value: 'ENV-VALUE\n', isText: true }] }),
    readBranchContent: async () => 'DIFFERENT-BRANCH-VALUE\n',
    resolveGitConflictUserAction: async ({ decision }) => { decisionUsed = decision; return { ok: true, useraction: 2 }; },
  });
  await reconcileDataverse({
    components: COMPONENTS, envUrl: 'https://e', solutionUniqueName: 'RetailOS', solutionId: 'sol', apply: true, deps: d,
  });
  assert.equal(decisionUsed, 'accept-incoming');
});

test('A5 bounded retry: persistent conflict → flip strategy once → pull → verify clears', async () => {
  const order = [];
  let verifyCalls = 0;
  const decisions = [];
  const d = deps({
    resolveGitConflictUserAction: async ({ decision }) => { decisions.push(decision); order.push(`ua:${decision}`); return { ok: true, useraction: decision === 'keep-current' ? 1 : 2 }; },
    pullChangesFromGit: async () => { order.push('pull'); return { ok: true }; },
    listConflicts: async () => {
      verifyCalls++;
      order.push(`verify:${verifyCalls}`);
      // first verify: still conflicting (the phantom); after the flip+pull: clear.
      return verifyCalls === 1 ? { count: 1, items: [{ componentId: 'c1', componentName: 'Search.webtemplate' }] } : { count: 0, items: [] };
    },
  });
  const r = await reconcileDataverse({
    components: COMPONENTS, envUrl: 'https://e', solutionUniqueName: 'RetailOS', solutionId: 'sol', apply: true, deps: d,
  });
  assert.equal(r.status, 'success');
  assert.equal(r.conflictsRemaining, 0);
  // strategy was flipped to keep-current on retry; a second pull + verify ran
  assert.ok(decisions.includes('keep-current'));
  assert.ok(order.includes('verify:2'));
  const retry = r.steps.find((s) => s.step === 'retry-flip-strategy');
  assert.ok(retry && retry.flipped.some((f) => f.componentId === 'c1'));
});

test('A5 bounded retry is SINGLE-pass: a permanently-stuck conflict ends partial, never loops', async () => {
  let verifyCalls = 0;
  const d = deps({
    resolveGitConflictUserAction: async () => ({ ok: true }),
    listConflicts: async () => { verifyCalls++; return { count: 1, items: [{ componentId: 'c1', componentName: 'Search.webtemplate' }] }; },
  });
  const r = await reconcileDataverse({
    components: COMPONENTS, envUrl: 'https://e', solutionUniqueName: 'RetailOS', solutionId: 'sol', apply: true, deps: d,
  });
  assert.equal(r.status, 'partial');
  assert.equal(r.conflictsRemaining, 1);
  assert.equal(verifyCalls, 2); // verify + exactly ONE retry verify; no infinite loop
});

test('happy path: refresh -> accept(useraction) -> pull -> verify(0) -> content-verify match => success', async () => {
  const order = [];
  let uaArgs = null;
  const d = deps({
    refreshChangesFromGit: async () => { order.push('refresh'); return { ok: true }; },
    resolveGitConflictUserAction: async (a) => { order.push('useraction'); uaArgs = a; return { ok: true, useraction: 2 }; },
    resolveConflictAccept: async () => { order.push('resolvegitconflict'); return { resolved: true }; },
    pullChangesFromGit: async () => { order.push('pull'); return { ok: true }; },
    listConflicts: async () => { order.push('verify'); return { count: 0 }; },
    readComponentContent: async () => { order.push('content'); return { mergeFields: [{ key: 'source', value: 'MERGED\r\n' }] }; },
  });

  const r = await reconcileDataverse({
    components: COMPONENTS,
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    solutionId: 'sol',
    dvToken: 'tok',
    apply: true,
    runId: 'run-1',
    deps: d,
  });
  assert.equal(r.status, 'success');
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['refresh', 'useraction', 'pull', 'verify', 'content']);
  assert.equal(uaArgs.decision, 'accept-incoming');
  assert.equal(uaArgs.solutionId, 'sol');
  assert.equal(r.accepted[0].via, 'useraction');
  assert.equal(r.conflictsRemaining, 0);
  assert.equal(r.contentVerify[0].result, 'verified');
});

test('run-state journaling uses runStateDir as the write directory and does not create a runId directory', async () => {
  const runId = `reconcile-test-${Date.now()}`;
  const runStateDir = path.join(process.cwd(), `.test-run-state-${runId}`);
  const strayRunIdDir = path.join(process.cwd(), runId);
  fs.rmSync(runStateDir, { recursive: true, force: true });
  fs.rmSync(strayRunIdDir, { recursive: true, force: true });
  try {
    const d = deps();
    const r = await reconcileDataverse({
      components: COMPONENTS,
      envUrl: 'https://e',
      solutionUniqueName: 'RetailOS',
      solutionId: 'sol',
      apply: true,
      runId,
      runStateDir,
      deps: d,
    });
    assert.equal(r.status, 'success');
    assert.ok(d.runState.writes.length > 0);
    assert.equal(d.runState.writes[0].dir, runStateDir);
    assert.equal(d.runState.writes[0].state.runId, runId);
    assert.equal(fs.existsSync(strayRunIdDir), false);
  } finally {
    fs.rmSync(runStateDir, { recursive: true, force: true });
    fs.rmSync(strayRunIdDir, { recursive: true, force: true });
  }
});

test('auto-resolves solutionId from solutionUniqueName so useraction path is used', async () => {
  let uaArgs = null;
  const d = deps({
    resolveSolutionId: async ({ base, token, solutionUniqueName }) => (base === 'https://e' && token === 'tok' && solutionUniqueName === 'RetailOS' ? 'auto-sol' : null),
    resolveGitConflictUserAction: async (a) => { uaArgs = a; return { ok: true, useraction: 2 }; },
    resolveConflictAccept: async () => ({ statusCode: 404, error: "Resource not found for the segment 'ResolveGitConflict'." }),
  });
  const r = await reconcileDataverse({
    components: COMPONENTS,
    envUrl: 'https://e/',
    solutionUniqueName: 'RetailOS',
    dvToken: 'tok',
    apply: true,
    deps: d,
  });
  assert.equal(r.status, 'success');
  assert.equal(uaArgs.solutionId, 'auto-sol');
  const step = r.steps.find((s) => s.step === 'resolve-solution-id');
  assert.ok(step && step.ok);
});

test('useraction notFound is treated as already-resolved with no ResolveGitConflict fallback', async () => {
  const order = [];
  let fallbackCalled = false;
  const d = deps({
    resolveGitConflictUserAction: async () => { order.push('useraction'); return { ok: false, notFound: true }; },
    resolveConflictAccept: async () => { fallbackCalled = true; order.push('resolvegitconflict'); return { statusCode: 404, error: "Resource not found for the segment 'ResolveGitConflict'." }; },
    pullChangesFromGit: async () => { order.push('pull'); return { ok: true }; },
    listConflicts: async () => { order.push('verify'); return { count: 0 }; },
  });
  const r = await reconcileDataverse({
    components: COMPONENTS,
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    solutionId: 'sol',
    apply: true,
    deps: d,
  });
  assert.equal(r.status, 'success');
  assert.equal(fallbackCalled, false);
  assert.deepEqual(order, ['useraction', 'pull', 'verify']);
  assert.equal(r.accepted[0].result, 'already-resolved');
});

test('useraction unavailable and ResolveGitConflict absent => manual-resolution-required + portalFallback', async () => {
  let pulled = false;
  const d = deps({
    resolveGitConflictUserAction: async () => ({ ok: false, error: 'useraction unavailable' }),
    resolveConflictAccept: async () => ({ statusCode: 404, error: "Resource not found for the segment 'ResolveGitConflict'." }),
    pullChangesFromGit: async () => { pulled = true; return { ok: true }; },
  });
  const r = await reconcileDataverse({
    components: COMPONENTS,
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    solutionId: 'sol',
    apply: true,
    deps: d,
  });
  assert.equal(r.status, 'manual-resolution-required');
  assert.equal(r.ok, true);
  assert.equal(pulled, false);
  assert.equal(r.resolvedVia, 'maker-portal');
  const accept = r.steps.find((s) => s.step === 'accept-incoming');
  assert.equal(accept.portalFallback, true);
  assert.equal(r.accepted[0].result, 'action-absent');
});

test('content mismatch => partial with positional-only metadata and no raw differing content', async () => {
  const comp = [{ ...COMPONENTS[0], mergedContent: 'line1\nMERGED\nline3\n' }];
  const d = deps({
    readComponentContent: async () => ({ mergeFields: [{ key: 'source', value: 'line1\nDIVERGED\nline3\n' }] }),
  });
  const r = await reconcileDataverse({
    components: comp,
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    solutionId: 'sol',
    apply: true,
    deps: d,
  });
  assert.equal(r.status, 'partial');
  assert.equal(r.contentVerify[0].result, 'mismatch');
  assert.equal(r.contentVerify[0].divergedAtLine, 2);
  assert.equal(typeof r.contentVerify[0].divergedAtIndex, 'number');
  assert.ok(!JSON.stringify(r.contentVerify).includes('DIVERGED'));
  assert.ok(!JSON.stringify(r.contentVerify).includes('MERGED'));
});

test('conflictsRemaining > 0 => partial', async () => {
  const d = deps({ listConflicts: async () => ({ count: 2 }) });
  const r = await reconcileDataverse({
    components: COMPONENTS,
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    solutionId: 'sol',
    apply: true,
    deps: d,
  });
  assert.equal(r.status, 'partial');
  assert.equal(r.conflictsRemaining, 2);
});

test('null verify count => partial, never false success', async () => {
  const d = deps({ listConflicts: async () => ({ error: 'token expired' }) });
  const r = await reconcileDataverse({
    components: COMPONENTS,
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    solutionId: 'sol',
    apply: true,
    deps: d,
  });
  assert.equal(r.status, 'partial');
  assert.equal(r.conflictsRemaining, null);
});

test('resume past accepted skips refresh and accept, then pulls and verifies', async () => {
  const order = [];
  const prior = [{ name: 'Search', conflictId: 'g1', result: 'accepted', via: 'useraction' }];
  const d = deps({
    refreshChangesFromGit: async () => { order.push('refresh'); return { ok: true }; },
    resolveGitConflictUserAction: async () => { order.push('useraction'); return { ok: true }; },
    resolveConflictAccept: async () => { order.push('resolvegitconflict'); return { resolved: true }; },
    pullChangesFromGit: async () => { order.push('pull'); return { ok: true }; },
    listConflicts: async () => { order.push('verify'); return { count: 0 }; },
    readComponentContent: async () => { order.push('content'); return { mergeFields: [{ key: 'source', value: 'MERGED\n' }] }; },
  });
  const r = await reconcileDataverse({
    components: COMPONENTS,
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    apply: true,
    resumeFrom: 'accepted',
    priorAcceptResults: prior,
    deps: d,
  });
  assert.equal(r.status, 'success');
  assert.deepEqual(order, ['pull', 'verify', 'content']);
  const accept = r.steps.find((s) => s.step === 'accept-incoming');
  assert.equal(accept.resumed, true);
  assert.deepEqual(r.accepted, prior);
});

test('refresh and pull failures return partial', async () => {
  const refreshFailed = await reconcileDataverse({
    components: COMPONENTS,
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    apply: true,
    deps: deps({ refreshChangesFromGit: async () => ({ error: 'refresh boom' }) }),
  });
  assert.equal(refreshFailed.status, 'partial');
  assert.match(refreshFailed.error, /RefreshChangesFromGit failed/);

  const pullFailed = await reconcileDataverse({
    components: COMPONENTS,
    envUrl: 'https://e',
    solutionUniqueName: 'RetailOS',
    solutionId: 'sol',
    apply: true,
    deps: deps({ pullChangesFromGit: async () => ({ error: 'pull boom' }) }),
  });
  assert.equal(pullFailed.status, 'partial');
  assert.match(pullFailed.error, /PullChangesFromGit failed/);
});

test('isActionAbsent helper', () => {
  assert.equal(isActionAbsent({ statusCode: 404, error: "Resource not found for the segment 'ResolveGitConflict'." }), true);
  assert.equal(isActionAbsent({ statusCode: 404, error: 'some other 404' }), false);
  assert.equal(isActionAbsent({ statusCode: 500, error: 'ResolveGitConflict missing' }), false);
  assert.equal(isActionAbsent(null), false);
});

// ---- Webfile text unit: content-verify via readWebFileBytes ----

const WF_COMPONENT = {
  conflictId: 'gwf1', componentId: 'cwf1', name: 'theme.css',
  type: 3, field: null, webfile: true,
  adoPath: '/solutions/R/powerpagesites/site/web-files/theme.css',
  oursContent: 'body { color: red; }\n',
  mergedContent: 'body { color: blue; }\n',
};

test('webfile text unit: readWebFileBytes matches mergedContent → verified', async () => {
  const d = deps({
    readWebFileBytes: async () => ({ bytes: Buffer.from('body { color: blue; }\n'), eol: '\n', bom: false }),
  });
  const r = await reconcileDataverse({
    components: [WF_COMPONENT],
    envUrl: 'https://e', solutionUniqueName: 'R', solutionId: 'sol',
    apply: true, deps: d,
  });
  assert.equal(r.status, 'success');
  const cv = r.contentVerify.find((x) => x.name === 'theme.css');
  assert.ok(cv, 'content-verify entry must exist');
  assert.equal(cv.result, 'verified');
});

test('webfile text unit: EOL difference normalised — CRLF-in-env vs LF-in-merge still verifies', async () => {
  const d = deps({
    readWebFileBytes: async () => ({ bytes: Buffer.from('body { color: blue; }\r\n'), eol: '\r\n', bom: false }),
  });
  const r = await reconcileDataverse({
    components: [WF_COMPONENT],
    envUrl: 'https://e', solutionUniqueName: 'R', solutionId: 'sol',
    apply: true, deps: d,
  });
  const cv = r.contentVerify.find((x) => x.name === 'theme.css');
  assert.equal(cv.result, 'verified', 'CRLF vs LF diff must be normalised away');
});

test('webfile text unit: bytes mismatch + patchWebFileBytes succeeds → patched-fallback (not full mismatch)', async () => {
  let patchCalled = false;
  let patchArgs = null;
  const d = deps({
    readWebFileBytes: async () => ({ bytes: Buffer.from('body { color: red; }\n'), eol: '\n', bom: false }), // old content, not merged
    patchWebFileBytes: async (a) => { patchCalled = true; patchArgs = a; return { ok: true }; },
  });
  const r = await reconcileDataverse({
    components: [WF_COMPONENT],
    envUrl: 'https://e', solutionUniqueName: 'R', solutionId: 'sol',
    apply: true, deps: d,
  });
  // status should still be success (patched-fallback does NOT count as mismatch)
  assert.equal(r.status, 'success');
  assert.ok(patchCalled, 'patchWebFileBytes must be called on mismatch');
  assert.equal(patchArgs.componentId, 'cwf1');
  assert.equal(typeof patchArgs.base64, 'string', 'base64 payload must be passed');
  const cv = r.contentVerify.find((x) => x.name === 'theme.css');
  assert.equal(cv.result, 'patched-fallback');
  assert.ok(cv.note, 'fallback note must be present');
});

test('webfile text unit: bytes mismatch + patchWebFileBytes unavailable → mismatch → partial', async () => {
  const d = deps({
    readWebFileBytes: async () => ({ bytes: Buffer.from('body { color: red; }\n'), eol: '\n', bom: false }),
    // no patchWebFileBytes → fallback unavailable
  });
  delete d.patchWebFileBytes;
  const r = await reconcileDataverse({
    components: [WF_COMPONENT],
    envUrl: 'https://e', solutionUniqueName: 'R', solutionId: 'sol',
    apply: true, deps: d,
  });
  assert.equal(r.status, 'partial');
  const cv = r.contentVerify.find((x) => x.name === 'theme.css');
  assert.equal(cv.result, 'mismatch');
});

test('webfile text unit: keep-current decision → content-verify skipped', async () => {
  let readCalled = false;
  const d = deps({
    readWebFileBytes: async () => { readCalled = true; return { bytes: Buffer.from('x'), eol: '\n', bom: false }; },
  });
  const r = await reconcileDataverse({
    components: [{ ...WF_COMPONENT, decision: 'keep-current' }],
    envUrl: 'https://e', solutionUniqueName: 'R', solutionId: 'sol',
    apply: true, deps: d,
  });
  assert.equal(readCalled, false, 'readWebFileBytes must not be called for keep-current');
  const cv = r.contentVerify.find((x) => x.name === 'theme.css');
  assert.equal(cv.result, 'skipped');
  assert.match(cv.reason, /keep-current/);
});

test('webfile + non-webfile in same reconcile: both verified correctly', async () => {
  const nonWf = { ...COMPONENTS[0], mergedContent: 'MERGED\n' };
  const wf = WF_COMPONENT;
  const d = deps({
    readComponentContent: async () => ({ mergeFields: [{ key: 'source', value: 'MERGED\r\n' }] }),
    readWebFileBytes: async () => ({ bytes: Buffer.from('body { color: blue; }\n'), eol: '\n', bom: false }),
  });
  const r = await reconcileDataverse({
    components: [nonWf, wf],
    envUrl: 'https://e', solutionUniqueName: 'R', solutionId: 'sol',
    apply: true, deps: d,
  });
  assert.equal(r.status, 'success');
  const cvNonWf = r.contentVerify.find((x) => x.name === 'Search');
  const cvWf = r.contentVerify.find((x) => x.name === 'theme.css');
  assert.equal(cvNonWf.result, 'verified');
  assert.equal(cvWf.result, 'verified');
});
