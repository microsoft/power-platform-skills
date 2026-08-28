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

test('REAL BUNDLE: 0x80040216 falls back to the classic XAML row, and the XAML names the authored columns', async () => {
  // This is the whole point of the uptake: the bound member faults with a server-side plugin error on
  // our tenants, so business rules were unauthorable. The fallback compiles the same typed rule to WWF
  // XAML and writes a plain `workflows` row, which works.
  const { sdk, calls } = sdkWith({
    post: (url) => (/WithWfomJson/i.test(url)
      ? { status: 400, headers: {}, body: { error: { code: '0x80040216', message: 'System failure in WorkflowService' } } }
      : undefined),
  });
  const art = authorRule(sdk);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', CONDITION);
  const res = await sdk.pushArtifact('businessRule', art.id);
  assert.strictEqual(res.saved, true, 'the fallback makes the push succeed');

  const classic = calls.find((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url)));
  assert.ok(classic, 'the classic row is written; urls: ' + JSON.stringify(calls.map((c) => c.url)));
  assert.strictEqual(classic.body.category, 2, 'category 2 = Business Rule');
  assert.strictEqual(classic.body.type, 1);
  assert.strictEqual(classic.body.primaryentity, BR_ENTITY);
  assert.strictEqual(classic.body.iscrmuiworkflow, true);

  // The DECISIVE assertion. A compiler that emitted well-formed but EMPTY XAML would satisfy every
  // structural check above and still produce a rule that does nothing — which is exactly what a
  // wrongly-shaped condition silently produces (see the next test).
  const xaml = classic.body.xaml;
  assert.ok(typeof xaml === 'string' && xaml.length > 500, 'the row carries compiled XAML');
  assert.match(xaml, /lvz_status/, 'the condition column reaches the XAML');
  assert.match(xaml, /lvz_notes/, 'the action column reaches the XAML');
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

test('REAL BUNDLE: a 404 on the bound member DOES qualify for the classic fallback', async () => {
  // The other qualifying trigger: an org where the member is not declared at all. Kept separate from
  // the 0x80040216 case so a change that narrowed the trigger to only one of them is caught.
  const { sdk, calls } = sdkWith({
    post: (url) => (/WithWfomJson/i.test(url) ? { status: 404, headers: {}, body: {} } : undefined),
  });
  const art = authorRule(sdk);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', CONDITION);
  const res = await sdk.pushArtifact('businessRule', art.id);
  assert.strictEqual(res.saved, true);
  assert.ok(calls.some((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url))),
    'an undeclared member falls back to the classic row');
});

test('REAL BUNDLE: a wrongly-shaped condition compiles an EMPTY rule rather than erroring', async () => {
  // Recorded because it cost real time and would cost it again. `operator`/`lhs`/`rhs`/`thenActions`
  // is the natural guess at the shape; `updateElement` merges those keys onto the node, the compiler
  // ignores them, and the push SUCCEEDS with XAML that mentions none of the author's columns.
  //
  // So a caller CANNOT rely on an error to tell them the shape is wrong. Any future plugin-side
  // business-rule support must validate `clauses`/`trueBranch` itself before pushing.
  const { sdk, calls } = sdkWith({
    post: (url) => (/WithWfomJson/i.test(url)
      ? { status: 400, headers: {}, body: { error: { code: '0x80040216', message: 'fault' } } }
      : undefined),
  });
  const art = authorRule(sdk);
  await sdk.updateElement('businessRule', art.id, '/rootCondition', {
    operator: 'Equal',
    lhs: { type: 'Field', attributeLogicalName: 'lvz_status' },
    rhs: { type: 'Value', value: 'Closed' },
    thenActions: [{ type: 'SetVisibility', attributeLogicalName: 'lvz_notes', visible: false }],
  });
  const res = await sdk.pushArtifact('businessRule', art.id);
  assert.strictEqual(res.saved, true, 'the push succeeds — that is the trap');

  const classic = calls.find((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url)));
  assert.ok(classic, 'a row is still written');
  assert.doesNotMatch(classic.body.xaml, /lvz_status/, 'the guessed shape contributes NO condition');
  assert.doesNotMatch(classic.body.xaml, /lvz_notes/, 'and NO action');
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
// 4. The #482 double-write fix, pinned against the bundle.
//
// The platform COMMITS the workflow row and only then faults generating its UiData, raising the
// qualifying 400. The old bundle treated that status as "nothing was written" and its fallback
// wrote a SECOND copy — measured live as 4 rows for 2 authored rules, both Active, both firing.
//
// The fix probes for the committed row on that 400 and DELETES it before writing its own. Pinning
// it here because a future re-vendor that loses this reverts to silently duplicating every rule,
// and the resulting rows are not always deletable afterwards.
test('REAL BUNDLE: a qualifying 400 makes the SDK remove the committed row before the classic write', async () => {
  const COMMITTED = '77777777-7777-7777-7777-777777777777';
  const { sdk, calls } = sdkWith({
    // The bound member faults AFTER committing.
    post: (url) => (/CreateProcessWithWfomJson/i.test(url)
      ? { status: 400, headers: {}, body: { error: { code: '0x80040216', message: 'Error generating UiData for workflow' } } }
      : { status: 204, headers: { 'odata-entityid': 'https://x/workflows(55555555-5555-5555-5555-555555555555)' }, body: {} }),
    // The probe for the orphan finds exactly one candidate.
    get: (url) => (/workflows\?/i.test(String(url))
      ? { status: 200, headers: {}, body: { value: [{ workflowid: COMMITTED }] } }
      : { status: 200, headers: {}, body: { value: [] } }),
  });

  const res = await authorDupGuard(sdk);
  assert.strictEqual(res.saved, true, 'the fallback still succeeds');

  // The committed orphan must be DELETED — not adopted. Its content is unverified (the fault
  // happened while generating UiData), so promoting it would activate a half-built definition.
  const del = calls.find((c) => c.verb === 'DELETE' && String(c.url).includes(COMMITTED));
  assert.ok(del, 'the committed row must be deleted; calls: ' + JSON.stringify(calls.map((c) => `${c.verb} ${c.url}`)));

  // And the delete must precede the classic POST, or the row it removes could be the new one.
  const delIdx = calls.indexOf(del);
  const classicIdx = calls.findIndex((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url)));
  assert.ok(classicIdx > -1, 'the classic fallback write must still happen');
  assert.ok(delIdx < classicIdx, 'the orphan is removed BEFORE the replacement is written');

  // The PROBE must be narrow. A broad probe would delete somebody else's rule, which is far worse
  // than the duplicate it exists to prevent. Measured shape:
  //   workflows?$select=workflowid,createdon&$filter=category eq 2 and type eq 1 and
  //     name eq 'Dup Guard' and primaryentity eq 'account' and createdon ge <watermark>
  //     &$orderby=createdon desc&$top=2
  const probe = calls.find((c) => c.verb === 'GET' && /workflows\?/i.test(String(c.url)));
  assert.ok(probe, 'the orphan probe must run');
  const probeUrl = decodeURIComponent(String(probe.url));
  for (const needle of ['category eq 2', 'type eq 1', "name eq 'Dup Guard'", "primaryentity eq 'account'", 'createdon ge', '$top=2']) {
    assert.ok(probeUrl.includes(needle), `the probe must constrain on ${needle}; got ${probeUrl}`);
  }
});

test('REAL BUNDLE: orphan cleanup FAILS CLOSED — no replacement is written when it cannot be trusted', async () => {
  // "Best-effort fall-through" is how the duplicate comes back. Both of these are measured, not
  // assumed: a failed DELETE and an ambiguous probe each rethrow, and crucially neither goes on to
  // write the classic row — which would leave the orphan AND a new copy.
  const COMMITTED = '77777777-7777-7777-7777-777777777777';
  const faultingPost = (url) => (/CreateProcessWithWfomJson/i.test(url)
    ? { status: 400, headers: {}, body: { error: { code: '0x80040216', message: 'Error generating UiData for workflow' } } }
    : { status: 204, headers: { 'odata-entityid': 'https://x/workflows(55555555-5555-5555-5555-555555555555)' }, body: {} });

  // 1. The delete itself fails (the wedged-row case seen live: 405 0x80040227).
  {
    const { sdk, calls } = sdkWith({
      post: faultingPost,
      get: (url) => (/workflows\?/i.test(String(url))
        ? { status: 200, headers: {}, body: { value: [{ workflowid: COMMITTED }] } }
        : { status: 200, headers: {}, body: { value: [] } }),
      del: () => ({ status: 405, headers: {}, body: { error: { code: '0x80040227', message: 'cannot be deleted' } } }),
    });
    await assert.rejects(() => authorDupGuard(sdk), 'a failed cleanup must not resolve as success');
    assert.strictEqual(calls.some((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url))), false,
      'no classic write may follow a failed cleanup — that is how BOTH rows end up present');
  }

  // 2. The probe is ambiguous (more than one candidate) — deleting either could destroy a real rule.
  {
    const { sdk, calls } = sdkWith({
      post: faultingPost,
      get: (url) => (/workflows\?/i.test(String(url))
        ? { status: 200, headers: {}, body: { value: [{ workflowid: COMMITTED }, { workflowid: '88888888-8888-8888-8888-888888888888' }] } }
        : { status: 200, headers: {}, body: { value: [] } }),
    });
    await assert.rejects(() => authorDupGuard(sdk), 'an ambiguous probe must not resolve as success');
    assert.strictEqual(calls.some((c) => c.verb === 'DELETE'), false, 'an ambiguous probe must delete NOTHING');
    assert.strictEqual(calls.some((c) => c.verb === 'POST' && /\/workflows$/.test(String(c.url))), false,
      'and must not write a replacement either');
  }
});
