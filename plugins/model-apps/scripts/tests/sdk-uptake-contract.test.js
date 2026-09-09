'use strict';
// REAL BUNDLE contract tests for the capabilities this SDK uptake introduced.
//
// These drive the shipped `vendor/cds-maker-sdk.cjs`, not a mock, because the whole failure mode of a
// re-vendor is "the bundle stopped doing what we believe it does" — a mock cannot detect that. They
// exist so the next uptake fails loudly here instead of silently on a customer's org.
//
// Covered:
//   1. App icon is now REQUIRED and must be an IMAGE (the behaviour that broke 13 tests on uptake).
//   2. Business-rule authoring, which was previously impossible on our tenants: supported bound
//      member first, classic WWF-XAML `workflows` row as a NARROW fallback.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const dirs = [];

// Offline SDK whose POST handler the test supplies, so a server fault can be simulated exactly.
// GET answers an empty collection: that is what an org with no image web resource looks like, which
// is precisely the state the icon contract below is about.
function sdkWith({ post, get, del } = {}) {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uptake-'));
  dirs.push(dir);
  const calls = [];
  const ok204 = { status: 204, headers: { 'odata-entityid': 'https://x/workflows(55555555-5555-5555-5555-555555555555)' }, body: {} };
  const sdk = createMakerSdk({
    workspacePath: dir,
    instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: {
      get: async (url) => { calls.push({ verb: 'GET', url }); return (get && get(url)) || { status: 200, headers: {}, body: { value: [] } }; },
      post: async (url, body) => { calls.push({ verb: 'POST', url, body }); return (post && post(url, body)) || ok204; },
      patch: async (url, body) => { calls.push({ verb: 'PATCH', url, body }); return { status: 204, headers: {}, body: {} }; },
      put: async (url, body) => { calls.push({ verb: 'PUT', url, body }); return { status: 204, headers: {}, body: {} }; },
      delete: async (url) => { calls.push({ verb: 'DELETE', url }); return (del && del(url)) || { status: 204, headers: {}, body: {} }; },
    },
  });
  sdk.initWorkspace();
  return { sdk, calls };
}

test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// The smallest complete business rule, authored the way the build authors one: create the artifact,
// set the condition tree through the generic element surface, push. Shared by the #482 tests below.
async function authorDupGuard(sdk) {
  const art = sdk.createArtifact('businessRule', {
    name: 'Dup Guard', entityLogicalName: 'account', scope: 'Entity', status: 'Draft',
  });
  await sdk.updateElement('businessRule', art.id, '/rootCondition', {
    id: 'root', logicalOperator: 'And',
    clauses: [{ id: 'c1', field: 'name', operator: 'Equals', valueType: 'Value', value: 'x', valueWorkflowType: 'String' }],
    trueBranch: [{ id: 'a1', type: 'SetVisibility', field: 'fax', visible: false }],
  });
  return sdk.pushArtifact('businessRule', art.id);
}

// --- 1. app icon ------------------------------------------------------------------------------

test('REAL BUNDLE: creating an app with no icon and no image web resource fails with APP_ICON_UNRESOLVED', async () => {
  // `appmodule.webresourceid` is a REQUIRED attribute. The SDK used to fall back to ANY unmanaged web
  // resource, which on an org whose images are all managed returned a JAVASCRIPT file — the platform
  // then rejected the create with an opaque "dependent component WebResource does not exist". It now
  // requires an IMAGE and says so plainly when there is none.
  //
  // The PLUGIN never relies on this path (`ensureAppIcon` always resolves or generates an SVG and
  // `appDef` passes `iconWebResourceId`), so this pins a boundary we depend on NOT crossing. If a
  // future bundle silently restored the old fallback, an app could again be created pointing at a
  // JavaScript file.
  const { sdk } = sdkWith();
  const app = sdk.createArtifact('app', { name: 'No Icon App', uniqueName: 'cr_noiconapp' });
  await assert.rejects(
    () => sdk.pushArtifact('app', app.id),
    (err) => {
      assert.strictEqual(err.code, 'APP_ICON_UNRESOLVED', `expected APP_ICON_UNRESOLVED, got ${err.code}: ${err.message}`);
      assert.match(err.message, /image web resource/i, 'the message names what is missing');
      return true;
    }
  );
});

test('REAL BUNDLE: an explicit iconWebResourceId is used verbatim and skips discovery', async () => {
  // What the plugin actually does. The id must reach the appmodule write unchanged — a bundle that
  // ignored it would silently re-introduce the cross-solution managed-icon dependency the plugin
  // generates its own SVG to avoid.
  const ICON = '11111111-2222-3333-4444-555555555555';
  const { sdk, calls } = sdkWith();
  const app = sdk.createArtifact('app', { name: 'Icon App', uniqueName: 'cr_iconapp', iconWebResourceId: ICON });
  await sdk.pushArtifact('app', app.id);
  const write = calls.find((c) => c.verb === 'POST' && c.body && c.body.webresourceid);
  assert.ok(write, 'the appmodule write carries a webresourceid; urls: ' + JSON.stringify(calls.map((c) => c.url)));
  assert.strictEqual(write.body.webresourceid, ICON, 'the explicit id is used verbatim');
  // No icon-discovery query should have been issued at all.
  assert.strictEqual(
    calls.some((c) => c.verb === 'GET' && /webresourceset/i.test(c.url) && /webresourcetype/i.test(c.url)),
    false,
    'an explicit id must short-circuit icon discovery entirely');
});

// --- 2. business rules ------------------------------------------------------------------------

const BR_ENTITY = 'lvz_ticket';

// The authoring shape, which is NOT obvious and is silently forgiving of getting it wrong: conditions
// go in `clauses` and actions in `trueBranch`. Passing `operator`/`lhs`/`rhs`/`thenActions` (a very
// natural guess) merges those keys onto the node, the compiler ignores them, and you get a rule with
// an EMPTY condition that still creates 204 — a wrong artifact behind a success. Pinned below.
function authorRule(sdk) {
  const art = sdk.createArtifact('businessRule', {
    name: 'Hide notes when closed', entityLogicalName: BR_ENTITY, scope: 'Entity', status: 'Active',
  });
  return art;
}
const CONDITION = {
  id: 'r1', displayName: 'If status is Closed', logic: 'AND',
  clauses: [{ id: 'c1', field: 'lvz_status', operator: 'Equals', valueType: 'Value', value: '1', valueWorkflowType: 'Picklist' }],
  trueBranch: [{ id: 'a1', type: 'SetVisibility', displayName: 'Hide notes', field: 'lvz_notes', visible: false }],
  falseBranch: [],
};

test('REAL BUNDLE: a business rule goes through the SUPPORTED bound member first', async () => {
  const { sdk, calls } = sdkWith();
  const art = authorRule(sdk);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', CONDITION);
  const res = await sdk.pushArtifact('businessRule', art.id);
  assert.strictEqual(res.saved, true);

  const bound = calls.find((c) => c.verb === 'POST' && /CreateProcessWithWfomJson/i.test(c.url));
  assert.ok(bound, 'the supported member is tried FIRST; urls: ' + JSON.stringify(calls.map((c) => c.url)));
  assert.ok(typeof bound.body.WfomJson === 'string' && bound.body.WfomJson.length > 100,
    'it carries a compiled workflow object model');
  // When the supported member succeeds there must be NO classic write — two writes would be two rules.
  assert.strictEqual(calls.some((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url))), false,
    'a successful supported write must not also POST the classic row');
  // Activation is a separate PATCH (statecode 1 / statuscode 2).
  const activate = calls.find((c) => c.verb === 'PATCH' && c.body && c.body.statecode !== undefined);
  assert.ok(activate, 'status: Active triggers an activation PATCH');
  assert.strictEqual(activate.body.statecode, 1);
  assert.strictEqual(activate.body.statuscode, 2);
});

test('REAL BUNDLE: a qualifying 400 no longer falls back — it throws, and writes nothing else', async () => {
  // This USED to be the point of the uptake: the bound member faulted with a server-side plugin error
  // on our tenants, and the SDK compiled the same typed rule to WWF XAML and wrote a plain
  // `workflows` row instead.
  //
  // That fallback has been DELETED upstream, deliberately. It covered 4 of the 7 action types, a
  // single clause and no else-if, so it silently narrowed a rule into something the platform accepted
  // but that did not say what the author wrote. A loud refusal is strictly better than a rule that
  // quietly means something else.
  //
  // Pinned here because the failure mode of losing this is invisible: a re-vendored bundle that
  // resurrected the fallback would make every one of these pushes "succeed" again, with narrowed
  // rules nobody asked for.
  const { sdk, calls } = sdkWith({
    post: (url) => (/WithWfomJson/i.test(url)
      ? { status: 400, headers: {}, body: { error: { code: '0x80040216', message: 'System failure in WorkflowService' } } }
      : undefined),
  });
  const art = authorRule(sdk);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', CONDITION);
  await assert.rejects(() => sdk.pushArtifact('businessRule', art.id), 'the 400 must propagate, not be papered over');

  assert.strictEqual(calls.some((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url))), false,
    'no classic XAML row may be written; calls: ' + JSON.stringify(calls.map((c) => `${c.verb} ${c.url}`)));
});

test('REAL BUNDLE: a NON-qualifying failure must NOT fall back (a second write could duplicate the rule)', async () => {
  // The fallback trigger is deliberately narrow: only a 400 carrying 0x80040216, or a 404. An auth
  // failure, a throttle or a lost response tells us NOTHING about whether the first write committed,
  // so writing again risks a duplicate or a half-configured rule.
  //
  // The INVARIANT under test is "no classic write", not "throws". Measured against the bundle, the
  // failure is surfaced two different ways and both are correct:
  //   401 / 403 / 429 / 500 / 400-with-another-code -> THROW
  //   412                                            -> resolves with `saved: false`
  // A 412 is a version conflict, which this SDK reports BY VALUE like every other push outcome
  // (the same throw-to-return refactor this release already handles); `requireSuccessfulPush` turns
  // that into a build halt. Asserting "throws" for it would have been asserting the wrong contract.
  const THROWS = [[401, null], [403, null], [429, null], [500, null], [400, '0x80040265']];
  for (const [status, code] of THROWS) {
    const { sdk, calls } = sdkWith({
      post: (url) => (/WithWfomJson/i.test(url)
        ? { status, headers: {}, body: { error: { code: code || '0x0', message: 'unrelated' } } }
        : undefined),
    });
    const art = authorRule(sdk);
    await sdk.updateElement('businessRule', art.id, '/rootCondition', CONDITION);
    await assert.rejects(() => sdk.pushArtifact('businessRule', art.id), `HTTP ${status} must propagate`);
    assert.strictEqual(
      calls.some((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url))), false,
      `HTTP ${status} must not trigger a classic write`);
  }

  // 412: reported by value, still no second write.
  const { sdk, calls } = sdkWith({
    post: (url) => (/WithWfomJson/i.test(url) ? { status: 412, headers: {}, body: {} } : undefined),
  });
  const art = authorRule(sdk);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', CONDITION);
  const res = await sdk.pushArtifact('businessRule', art.id);
  assert.strictEqual(res.saved, false, 'a version conflict is reported by value, not swallowed');
  assert.strictEqual(
    calls.some((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url))), false,
    'a 412 must not trigger the very write the caller\'s stale token exists to prevent');
});

test('REAL BUNDLE: a 404 on the bound member is refused with a STABLE, matchable code', async () => {
  // The plugin degrades gracefully on an environment that does not declare the member (it skips the
  // rules and builds the rest of the app rather than halting 90% of the way through). That branch is
  // selected by the error's `code`, so the code is a contract, not an implementation detail.
  //
  // It must NOT be selected by `err.name`: the bundle is minified, so the class name is a
  // rebuild-unstable two-letter string that also happens to be the shared base error. Matching it
  // would silently disarm the branch on the next re-vendor.
  //
  // MEASURED live: `$metadata` on a real environment (16.5 MB) does not mention the member, and every
  // POST to it answers 404. The SDK's own message reports 18 of 20 environments in the same state.
  //
  // ⚠ HOW it is refused CHANGED, and the change was invisible to every mock-based test in the suite.
  // The SDK used to THROW here; it now treats the preview rollout as a reported no-op and RESOLVES
  // with `saved: false` carrying the same code, so a `pushAll` can carry on with the other artifacts.
  // `saved` staying FALSE is the load-bearing half — "skipped" must never read as "written". The
  // plugin reads the code off the CAUSE CHAIN so both shapes reach the same skip; asserting only
  // one of them here is what let the by-value form turn into a build halt on most environments.
  const { sdk, calls } = sdkWith({
    post: (url) => (/WithWfomJson/i.test(url) ? { status: 404, headers: {}, body: {} } : undefined),
  });
  const art = authorRule(sdk);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', CONDITION);

  const res = await sdk.pushArtifact('businessRule', art.id).then((r) => r, (e) => ({ threw: e }));
  // Accept EITHER shape deliberately: a bundle that goes back to throwing must not fail this guard,
  // because the plugin still handles it. What may never happen is a reported SUCCESS.
  const err = res.threw || res.error;
  assert.ok(err, `an undeclared member must be refused, not silently substituted; got ${JSON.stringify(res)}`);
  if (!res.threw) {
    assert.strictEqual(res.saved, false, 'a no-op must never be reported as a write that committed');
    assert.strictEqual(res.shipped, false, 'nor as live');
  }
  assert.strictEqual(err.code, 'BUSINESS_RULE_API_UNAVAILABLE',
    `the plugin branches on this exact code; got ${JSON.stringify(err.code)}`);
  assert.match(err.message, /not enabled on this environment|does not expose/i,
    'the message must name the cause for the operator');
  assert.strictEqual(calls.some((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url))), false,
    'and nothing else may be written in its place');
});

test('REAL BUNDLE: a wrongly-shaped condition produces an EMPTY rule rather than erroring', async () => {
  // Recorded because it cost real time and would cost it again. `operator`/`lhs`/`rhs`/`thenActions`
  // is the natural guess at the shape; `updateElement` merges those keys onto the node, the
  // serializer ignores them, and the push SUCCEEDS with a workflow object model that mentions none of
  // the author's columns.
  //
  // So a caller CANNOT rely on an error to tell them the shape is wrong. The plugin's App Spec
  // validation exists precisely because of this: it checks `conditions`/`actions` itself before
  // anything is pushed.
  const { sdk, calls } = sdkWith();
  const art = authorRule(sdk);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', {
    operator: 'Equal',
    lhs: { type: 'Field', attributeLogicalName: 'lvz_status' },
    rhs: { type: 'Value', value: 'Closed' },
    thenActions: [{ type: 'SetVisibility', attributeLogicalName: 'lvz_notes', visible: false }],
  });
  const res = await sdk.pushArtifact('businessRule', art.id);
  assert.strictEqual(res.saved, true, 'the push succeeds — that is the trap');

  const bound = calls.find((c) => c.verb === 'POST' && /CreateProcessWithWfomJson/i.test(String(c.url)));
  assert.ok(bound, 'a rule is still written');
  const wfom = String(bound.body.WfomJson);
  assert.doesNotMatch(wfom, /lvz_status/, 'the guessed shape contributes NO condition');
  assert.doesNotMatch(wfom, /lvz_notes/, 'and NO action');
});

// ---------------------------------------------------------------------------------------------
// 3. The AI setting NAMES the build writes to, pinned against the bundle's own maps.
//
// Discovered while chasing a report that form fill was enabled when our probe read it as off. The
// names turned out to be correct — but NOTHING was checking that. Every existing test hardcoded the
// same strings the source does, so an upstream rename would leave the whole suite green while the
// build wrote to a setting that no longer exists, and the feature would silently never turn on.
//
// That is the exact failure this uptake already suffered once: `PushResult.success` was renamed to
// `saved`, and the guard reading `success === false` simply stopped firing. A constant is only
// guarded if something compares it to the BUNDLE.
test('REAL BUNDLE: AI_APP_SETTING matches the SDK per-app setting map exactly', () => {
  const src = fs.readFileSync(BUNDLE, 'utf8');
  // The maps are emitted as, e.g.:
  //   {formFill:"FormFillBarUXEnabled",formFillSuggestions:"FormPredictEnabled",
  //    formFillSmartPaste:"FormPredictSmartPasteEnabledOnByDefault",formFillFiles:"...",
  //    nlSearch:"NLGridSearchSetting",nlChart:"...",m365:"..."}
  // The GATE map additionally carries `summaries` (the per-app map has none — row summaries are
  // configured through configureRowSummary, not a flag). Anchor on the `formFill` key rather than
  // the minified variable name, which changes every build, and accept any key set after it so a new
  // capability is caught by the deepEqual below rather than silently skipped by the regex.
  const m = /\{formFill:"[^"]+"(?:,[A-Za-z0-9_]+:"[^"]+")+\}/g;
  const maps = [...src.matchAll(m)].map((x) => x[0]);
  assert.ok(maps.length >= 2, `expected both the gate and per-app maps in the bundle, found ${maps.length}`);

  const parse = (s) => Object.fromEntries([...s.matchAll(/(\w+):"([^"]+)"/g)].map((x) => [x[1], x[2]]));
  const parsed = maps.map(parse);

  // The GATE map and the PER-APP map are deliberately different for nlSearch and nlChart — that
  // difference is the whole reason `AI_APP_SETTING` exists as its own constant. Identify the
  // per-app map as the one whose nlSearch is NOT the gate name.
  const appMap = parsed.find((p) => p.nlSearch !== 'EnableNLGridSearch');
  assert.ok(appMap, 'could not identify the per-app setting map in the bundle');

  const { AI_APP_SETTING } = require('../lib/ai-app-settings.js');
  assert.deepStrictEqual(AI_APP_SETTING, appMap);

  // And pin the distinction itself: if these ever collapse to the same name, the "gate is not the
  // setting" logic in verify and preflight becomes dead code and should be revisited deliberately.
  const gateMap = parsed.find((p) => p.nlSearch === 'EnableNLGridSearch');
  assert.ok(gateMap, 'could not identify the gate map in the bundle');
  assert.notStrictEqual(gateMap.nlSearch, appMap.nlSearch, 'gate and per-app names must stay distinct for nlSearch');
  assert.notStrictEqual(gateMap.nlChart, appMap.nlChart, 'gate and per-app names must stay distinct for nlChart');
  // formFill and m365 legitimately share one name; pinned so a future divergence is noticed.
  assert.strictEqual(gateMap.formFill, appMap.formFill);
  assert.strictEqual(gateMap.m365, appMap.m365);
});

// ---------------------------------------------------------------------------------------------
// 4. There is exactly ONE write path, so #482 cannot recur.
//
// #482 was a DOUBLE WRITE. The platform commits the workflow row and only then faults generating its
// UiData, raising a 400; the old bundle read that status as "nothing was written" and its XAML
// fallback wrote a SECOND copy. Measured live as 4 rows for 2 authored rules, both Active, both
// firing. The SDK then grew an orphan-probe-and-delete dance to compensate.
//
// The fallback — and with it the entire dance — has been deleted upstream. A business rule is now
// written through the bound member or not at all, which removes the second writer rather than
// coordinating it. That is a stronger guarantee, but only while it holds, so it is pinned here: any
// re-vendor that reintroduces ANY second write path fails these tests.
//
// https://github.com/microsoft/power-platform-skills/issues/482
test('REAL BUNDLE: the happy path writes the rule EXACTLY once', async () => {
  const { sdk, calls } = sdkWith();
  const res = await authorDupGuard(sdk);
  assert.strictEqual(res.saved, true);

  const writes = calls.filter((c) => c.verb === 'POST' && /workflow/i.test(String(c.url)));
  assert.strictEqual(writes.length, 1, 'exactly one POST may create the rule; got ' + JSON.stringify(writes.map((c) => c.url)));
  assert.match(String(writes[0].url), /CreateProcessWithWfomJson/, 'and it must be the bound member');
});

test('REAL BUNDLE: no failure of the bound member produces a second write', async () => {
  // The qualifying 400 (0x80040216) and the 404 are the two statuses that USED to trigger the
  // fallback, so they are the two that would resurrect the duplicate. The rest are included because
  // "nothing else writes twice either" is the actual invariant, and a partial check would let a
  // narrower fallback back in unnoticed.
  //
  // The invariant is NO SECOND WRITE — deliberately not "throws". How each failure is SURFACED is a
  // separate contract (pinned above) and it is not uniform: the 404 preview gate is reported by
  // value, everything else throws. Conflating the two is what made this test fail on an uptake that
  // changed only the reporting shape, while the duplicate-write invariant it exists to protect was
  // never at risk.
  const FAILURES = [
    [400, '0x80040216'],  // committed-then-faulted: the exact #482 trigger
    [404, null],          // member not declared on this environment -> reported BY VALUE
    [400, '0x80040265'],  // an unrelated 400
    [401, null],
    [403, null],
    [429, null],
    [500, null],
  ];
  for (const [status, code] of FAILURES) {
    const { sdk, calls } = sdkWith({
      post: (url) => (/CreateProcessWithWfomJson/i.test(url)
        ? { status, headers: {}, body: code ? { error: { code, message: 'fault' } } : {} }
        : undefined),
    });
    const outcome = await authorDupGuard(sdk).then((r) => r, (e) => ({ threw: e }));
    // Whichever way it is surfaced, it must NOT be a success.
    const failed = Boolean(outcome.threw) || outcome.saved === false;
    assert.ok(failed,
      `HTTP ${status} ${code || ''} must surface, not be absorbed; got ${JSON.stringify(outcome)}`);
    assert.ok(outcome.threw || outcome.error,
      `HTTP ${status} ${code || ''} must carry the cause either way`);

    // The decisive assertion: no classic row, and no retry of the member either. Either one would be
    // a second rule on the table for a single authored rule.
    assert.strictEqual(calls.some((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url))), false,
      `HTTP ${status} ${code || ''} must not write a classic row`);
    const memberPosts = calls.filter((c) => c.verb === 'POST' && /CreateProcessWithWfomJson/i.test(String(c.url)));
    assert.strictEqual(memberPosts.length, 1,
      `HTTP ${status} ${code || ''} must not retry the member; got ${memberPosts.length} posts`);
  }
});

test('REAL BUNDLE: the deleted fallback leaves no trace in the bundle', async () => {
  // Deliberately NOT a grep for XAML fingerprints. That was tried and was wrong twice over:
  // `iscrmuiworkflow` is still in the bundle because it is part of the BOUND MEMBER's own create
  // payload, and the WWF activities namespace is still there because the BUSINESS PROCESS FLOW
  // compiler — an unrelated feature — emits it. A sentinel that fires on either would fail for a
  // reason that has nothing to do with business rules.
  //
  // The one string that WAS unique to the deleted compiler is its null-parameter emission, the exact
  // shape of the #481 fix. Its return would mean the compiler is back.
  const src = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(!src.includes('x:Null x:Key="Parameters"'),
    'the business-rule XAML compiler\'s null-parameter emission is back — the fallback has been reintroduced');
});
