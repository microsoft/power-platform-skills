'use strict';
// The generated call of a built-in Dataverse operation, as the evaluator reads a page's source (action-binding-union.js builtInRuntimeProblems).
//
// The reference is the pattern plugins/model-apps/references/dataverse-operations.md teaches — read from that document, so the document and the
// evaluator cannot drift apart. It must pass; and each departure the reference forbids must fail, with the problem that names it: a call on mount
// or at render, a handler handed to a timer, an effect, a ref or a child (or through an alias), a partial identity, a spread or serialized result,
// a member read, a read from the root or `res.value`, outputs read before `res.ok`, no object check for an empty answer, an unbounded Version, raw
// fault text, a status read out of the message, a message that says to deploy a Custom API, a pre-dispatch check that does not return, extra
// request fields, no disabled button, one shared pending state, no stale request guard, no catch, and a logged result. A whole built-in-only
// lifecycle through the Phase 5 evaluator passes with it too — and a built-in entry the page already held keeps the contract it declares.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtInRuntimeProblems } = require('../lib/action-binding-union.js');
const { customApiProblems } = require('../lib/custom-api-contract.js');
const { PHASE_EXPECTATIONS } = require('../lib/assertions-layer-1.js');
const { PHASE5_EXPECTATIONS } = require('../lib/assertions-layer-2.js');
const { getDataverseOperationCatalogue } = require('../../../../plugins/model-apps/scripts/lib/dataverse-operations.js');

const REFERENCES = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'references');
const DOC = path.join(REFERENCES, 'dataverse-operations.md');
// The document shows the page's helpers, PageBody and boundary wrapper; the rest of the page is the page error block
// references/rules.md publishes ("Missing Error Handling") — copied unchanged, up to its own example PageBody — which supplies
// PAGE_NAME, reportPageError, PageErrorBar, PageErrorBoundary and the error copy holding the fixed built-in sentences. The
// complete page is what the built-in checks read.
const REFERENCE = (() => {
  const text = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
  const section = text.slice(text.indexOf('\n## Generated call\n'));
  const block = /```tsx\n([\s\S]*?)\n```/.exec(section);
  assert.ok(block, 'the reference document holds the generated call');
  const rules = fs.readFileSync(path.join(REFERENCES, 'rules.md'), 'utf8').replace(/\r\n/g, '\n');
  const errors = rules.slice(rules.indexOf('\n### 2. Missing Error Handling\n'), rules.indexOf('\n### 3. '));
  const foundation = [...errors.matchAll(/```tsx\n([\s\S]*?)\n```/g)].map((match) => match[1]).find((code) => /\bfunction reportPageError\(/.test(code));
  assert.ok(foundation, 'rules.md publishes the canonical page error block');
  return `${foundation.slice(0, foundation.indexOf('function PageBody('))}${block[1]}\n`;
})();
const BOTH = ['WhoAmI', 'RetrieveVersion'];
const problems = (source, names = BOTH) => builtInRuntimeProblems(source, names);

// One textual change to the reference; a change that does not apply is a broken test, not a pass.
function mutated(find, replace) {
  assert.ok(REFERENCE.includes(find), `the reference holds: ${find}`);
  return REFERENCE.replace(find, replace);
}

test('the reference pattern of the document passes, for each operation alone and for both', () => {
  assert.deepStrictEqual(problems(REFERENCE), []);
  assert.deepStrictEqual(problems(REFERENCE, ['WhoAmI']), []);
  assert.deepStrictEqual(problems(REFERENCE, ['RetrieveVersion']), []);
});

test('a call that is not the user\'s — on mount, at render, on a timer, in a memo, or a retry of itself — fails', () => {
  for (const [label, source, reason] of [
    ['an effect calls it', mutated('React.useEffect(() => () => { mounted.current = false; }, []);', 'React.useEffect(() => { void showIdentity(); return () => { mounted.current = false; }; }, []);'), /effect, a memo or a timer/],
    ['an effect calls the helper', mutated('React.useEffect(() => () => { mounted.current = false; }, []);', 'React.useEffect(() => { void readIdentity(api); return () => { mounted.current = false; }; }, []);'), /effect, a memo or a timer/],
    ['the render calls it', mutated('  return (\n    <div>', '  void readVersion(api);\n  return (\n    <div>'), /while the page renders/],
    ['a timer calls it', mutated('    if (identityState.pending) return;', '    if (identityState.pending) return;\n    setTimeout(() => void readIdentity(api), 0);'), /effect, a memo or a timer/],
    ['a memo calls it', mutated('  const identityRequest = React.useRef(0);', '  const identityRequest = React.useRef(0);\n  React.useMemo(() => readIdentity(api), [api]);'), /effect, a memo or a timer/],
    ['it retries itself', mutated("      const view = reportPageError(PAGE_NAME, 'showIdentity', res.error?.code, res.error?.message, 'read');", "      if (res.error?.code === 'network') return readIdentity(api);\n      const view = reportPageError(PAGE_NAME, 'showIdentity', res.error?.code, res.error?.message, 'read');"), /calls itself/],
    ['no button reaches it', mutated('onClick={() => void showVersion()}', 'title="version"'), /not reached from a button/],
  ]) {
    const found = problems(source);
    assert.ok(found.some((p) => reason.test(p)), `${label}: ${JSON.stringify(found)}`);
  }
});

// The identity guard of readIdentity, and its object check: one block each that reports the unexpected shape and returns.
const IDENTITY_GUARD = "    if (![userId, businessUnitId, organizationId].every((id) => typeof id === 'string' && GUID.test(id))) {\n      const view = reportPageError(PAGE_NAME, 'showIdentity', undefined, 'WhoAmI returned an unexpected identity', 'read');\n      view.fallbackKey = 'error.builtinUnexpected';\n      view.message = '';\n      return { error: view };\n    }\n";
const IDENTITY_OBJECT_CHECK = "    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {\n      const view = reportPageError(PAGE_NAME, 'showIdentity', undefined, 'WhoAmI returned no output object', 'read');\n      view.fallbackKey = 'error.builtinUnexpected';\n      view.message = '';\n      return { error: view };\n    }\n    const userId";

test('outputs are read only after the success check, through own-property reads of a checked object, and shown all or nothing', () => {
  for (const [label, source, reason] of [
    ['a partial identity', mutated("    if (![userId, businessUnitId, organizationId].every((id) => typeof id === 'string' && GUID.test(id))) {", '    if (!userId || !GUID.test(userId)) {'), /all or none/],
    ['the identity is never tested', mutated(IDENTITY_GUARD, ''), /all or none/],
    ['no object check (an empty or 204 answer)', mutated(IDENTITY_OBJECT_CHECK, '    const userId'), /non-null, non-array object/],
    ['a member read', mutated("const userId = ownString(outputs, 'UserId');", 'const userId = outputs.UserId as string | undefined;'), /as a member/],
    ['a destructured read', mutated("const version = ownString(outputs, 'Version');", 'const { Version: version } = outputs as { Version?: string };'), /as a member/],
    ['a read from the result root', mutated("const userId = ownString(outputs, 'UserId');", "const userId = (res as unknown as { UserId?: string }).UserId ?? ownString(outputs, 'UserId');"), /from the result root/],
    ['a spread of outputs', mutated('  return { version };', '  return { version, ...outputs };'), /spread, iterated or serialized/],
    ['a serialized result', mutated('  return { version };', '  return { version: JSON.stringify(res.outputs) };'), /spread, iterated or serialized/],
    ['an unbounded Version', mutated('    if (!version || version.length > 128) {', '    if (!version) {'), /1 to 128 characters/],
    ['an empty Version shown', mutated('    if (!version || version.length > 128) {', '    if (version === undefined || version.length > 128) {'), /1 to 128 characters/],
    ['no unexpected-shape sentence', REFERENCE.replace('The operation returned an unexpected response. No result was displayed.', 'Something went wrong.'), /unexpected shape must say/],
  ]) {
    const found = problems(source);
    assert.ok(found.some((p) => reason.test(p)), `${label}: ${JSON.stringify(found)}`);
  }
});

test('a failure shows only sanitized text: no stack, no status read out of the message, no advice to deploy a Custom API', () => {
  for (const [label, source, reason] of [
    ['a stack', mutated("    view.fallbackKey = 'error.builtinFailed';\n    view.message = '';\n    return { error: view };\n  }\n}\n\nasync function readVersion(", "    view.fallbackKey = 'error.builtinFailed';\n    view.message = String((error as Error).stack);\n    return { error: view };\n  }\n}\n\nasync function readVersion("), /stack/],
    ['a status from the words', mutated("const unavailable = typeof res.error?.status === 'number' && res.error.status === 404;", "const unavailable = res.error?.message?.includes('404') === true;"), /message's words/],
    ['a 404 that says to deploy', REFERENCE.replace('The selected operation is unavailable in this environment or player. No fallback was attempted.', 'The selected operation is unavailable. Deploy the Custom API first.'), /deploy a Custom API/],
  ]) {
    const found = problems(source);
    assert.ok(found.some((p) => reason.test(p)), `${label}: ${JSON.stringify(found)}`);
  }
});

test('the request is exactly { name }, and a failed presence check returns before any request', () => {
  for (const [label, source, reason] of [
    ['parameters', mutated("api.executeFunction({ name: 'WhoAmI' })", "api.executeFunction({ name: 'WhoAmI', parameters: {} })"), /exactly \{ name \}/],
    ['boundTo', mutated("api.executeFunction({ name: 'RetrieveVersion' })", "api.executeFunction({ name: 'RetrieveVersion', boundTo: { entityName: 'organization', id: 'x' } })"), /exactly \{ name \}/],
    ['a presence check that does not return', mutated("  if (typeof api.executeFunction !== 'function') {\n    const view = reportPageError(PAGE_NAME, 'showIdentity'", "  if (typeof api.executeFunction !== 'function') console.warn('unsupported');\n  {\n    const view = reportPageError(PAGE_NAME, 'showIdentity'"), /return before any request/],
  ]) {
    const found = problems(source);
    assert.ok(found.some((p) => reason.test(p)), `${label}: ${JSON.stringify(found)}`);
  }
});

test('each button is disabled while its own call is pending, ignores a stale answer, catches a rejection, and nothing of the result is logged or kept', () => {
  for (const [label, source, reason] of [
    ['no disabled button', mutated('<Button disabled={identityState.pending} onClick={() => void showIdentity()}>', '<Button onClick={() => void showIdentity()}>'), /not disabled while the call is pending/],
    ['one pending state for both', mutated('<Button disabled={versionState.pending} onClick={() => void showVersion()}>', '<Button disabled={identityState.pending} onClick={() => void showVersion()}>'), /pending state of its own/],
    ['no stale-request guard', mutated('      if (mounted.current && requestId === identityRequest.current) setIdentityState({ pending: false, view });', '      if (mounted.current) setIdentityState({ pending: false, view });')
      .replace('    const requestId = ++identityRequest.current;\n    setIdentityState({ pending: true, view: {} });', '    setIdentityState({ pending: true, view: {} });')
      .replace("      if (mounted.current && requestId === identityRequest.current) setIdentityState({ pending: false, view: { error: reportPageError(PAGE_NAME, 'showIdentity', undefined, error, 'read') } });", "      if (mounted.current) setIdentityState({ pending: false, view: { error: reportPageError(PAGE_NAME, 'showIdentity', undefined, error, 'read') } });"), /stale request/],
    // Both catches go: the request helper's own and the handler's.
    ['no catch', mutated("    } catch (error) {\n      if (mounted.current && requestId === versionRequest.current) setVersionState({ pending: false, view: { error: reportPageError(PAGE_NAME, 'showVersion', undefined, error, 'read') } });\n    }\n  };", '    } finally {\n    }\n  };')
      .replace("  } catch (error) {\n    const view = reportPageError(PAGE_NAME, 'showVersion', undefined, error, 'read');\n    view.fallbackKey = 'error.builtinFailed';\n    view.message = '';\n    return { error: view };\n  }\n}", '  } finally {\n  }\n}'), /not caught/],
    ['a logged result', mutated('      const view = await readIdentity(api);', '      const view = await readIdentity(api);\n      console.log(view);'), /logged, stored, copied or sent/],
    ['a stored result', mutated('  return { version };', '  localStorage.setItem(\'version\', version);\n  return { version };'), /logged, stored, copied or sent/],
  ]) {
    const found = problems(source);
    assert.ok(found.some((p) => reason.test(p)), `${label}: ${JSON.stringify(found)}`);
  }
});

// ── Through the whole Phase 5 evaluator (custom-api-contract.js), in both layers ────────────────────────────────────────────────────────
const RULE = 'Phase 5: Custom API discovery, gate, bare bindings, runtime calls and update preservation or explicit clear agree';
const PAGE = '99999999-9999-4999-8999-999999999999';
const APP = '88888888-8888-4888-8888-888888888888';
const ENV = 'https://contoso.crm.dynamics.com';
const ROWS = getDataverseOperationCatalogue().operations.map((operation) => ({ name: operation.name, isFunction: true, displayName: operation.displayName, parameterKinds: {} }));
const [WHO_AM_I, RETRIEVE_VERSION] = ROWS;
const TABLE_ROWS = {
  WhoAmI: '| WhoAmI | Function | (Global) | Current Dataverse identity | (none) | BusinessUnitId, UserId, OrganizationId | button |',
  RetrieveVersion: '| RetrieveVersion | Function | (Global) | Dataverse server version | (none) | Version | button |',
};
// The plan of a run that adds the named built-ins (none: the plan has no `## Dataverse Operations` section).
const planFor = (names) => `## Custom API Bindings
No custom API bindings.
${names.length ? `
## Dataverse Operations
Verification: environment not-checked, runtime not-checked, privileges not-checked.
| Name | Kind | Bound Entity | Display Name | Parameters | Response fields | Invoke |
|------|------|--------------|--------------|------------|-----------------|--------|
${names.map((name) => TABLE_ROWS[name]).join('\n')}
` : ''}`;
const listingEvent = () => ({ id: 'listing', command: 'node list-dataverse-operations.js', result: { ok: true, ...structuredClone(getDataverseOperationCatalogue()) } });
const verdicts = (fixture) => [PHASE_EXPECTATIONS, PHASE5_EXPECTATIONS].map((map) => map.get(RULE)({ fixture, files: fixture.files, eval: { id: 24 } }));

// A page that binds only the two built-ins: create with an enabled built-in gate, the listing and a re-probe.
const fixture = (source) => ({
  contractVersion: 2,
  files: [{ name: 'page.tsx', content: source }],
  artifacts: { 'stages/page.tsx': source, 'actions.json': JSON.stringify(ROWS), 'created/config.json': JSON.stringify({ actionBindings: ROWS }) },
  genpagePlan: planFor(['WhoAmI', 'RetrieveVersion']),
  workflowLog: 'Built-in operation create with the gate enabled.',
  manifest: { customApi: { outputs: {}, stages: [{ id: 'create', target: 'page.tsx', source: 'stages/page.tsx', actions: 'actions.json', afterConfig: 'created/config.json', upload: 'create' }] } },
  events: [
    { id: 'custom-api-gate', command: 'node feature-flags.js custom-api', result: 'disabled' },
    { id: 'builtin-gate', command: 'node feature-flags.js dataverse-operations', result: 'enabled' },
    listingEvent(),
    { id: 'builtin-regate', command: 'node feature-flags.js dataverse-operations', result: 'enabled' },
    { id: 'write', command: 'Write page.tsx', artifact: 'stages/page.tsx' },
    { id: 'create', command: 'node genpage-upload.js --code-file page.tsx --actions actions.json --add-to-sitemap', result: { ok: true, pageId: PAGE } },
  ],
});

// An edit of a downloaded page that already holds `before`. With nothing in `add` it is an unrelated edit: both gates OFF, no `--actions`, the
// bindings preserved. With rows in `add`, this run adds them (or replaces an entry of the same name, in its place): the built-in gate ON, the
// listing, a re-probe, and the full array uploaded.
function editFixture({ before, add = [], source }) {
  const after = [
    ...before.map((entry) => add.find((row) => row.name === entry.name) || entry),
    ...add.filter((row) => !before.some((entry) => entry.name === row.name)),
  ];
  const identity = JSON.stringify({ pageId: PAGE, appId: APP });
  const authoring = add.length > 0;
  return {
    contractVersion: 2,
    files: [{ name: 'page.tsx', content: source }],
    artifacts: {
      'stages/page.tsx': source, 'actions.json': JSON.stringify(after),
      'before/config.json': JSON.stringify({ actionBindings: before }), 'after/config.json': JSON.stringify({ actionBindings: after }),
      'before/page.json': identity, 'after/page.json': identity,
    },
    genpagePlan: planFor(add.map((row) => row.name)),
    workflowLog: authoring ? 'An edit that adds a built-in operation the maker selected.' : 'An unrelated edit of a page that already binds built-in operations; its bindings are preserved.',
    manifest: {
      customApi: {
        outputs: {},
        stages: [{
          id: 'edit', target: 'page.tsx', source: 'stages/page.tsx', beforeConfig: 'before/config.json', afterConfig: 'after/config.json', upload: 'edit',
          ...(authoring && { actions: 'actions.json', change: { add } }),
        }],
      },
      uploads: [{ event: 'edit', mode: 'update', beforeConfig: 'before/config.json', afterConfig: 'after/config.json', beforePage: 'before/page.json', afterPage: 'after/page.json' }],
    },
    events: [
      { id: 'download', command: `node genpage.js download --env ${ENV} --page-id ${PAGE} --app-id ${APP} --output-directory before`, result: { ok: true, pages: [{ pageId: PAGE }] } },
      { id: 'custom-api-gate', command: 'node feature-flags.js custom-api', result: 'disabled' },
      { id: 'builtin-gate', command: 'node feature-flags.js dataverse-operations', result: authoring ? 'enabled' : 'disabled' },
      ...(authoring ? [listingEvent(), { id: 'builtin-regate', command: 'node feature-flags.js dataverse-operations', result: 'enabled' }] : []),
      { id: 'write', command: 'Write page.tsx', artifact: 'stages/page.tsx' },
      { id: 'edit', command: `node genpage-upload.js --env ${ENV} --page-id ${PAGE} --app-id ${APP} --code-file page.tsx${authoring ? ' --actions actions.json' : ''}`, result: { ok: true, pageId: PAGE, appId: APP } },
    ],
  };
}

test('a built-in-only lifecycle with the reference page passes the Phase 5 evaluator in both layers, and the same page reading outputs before success fails', () => {
  for (const [map, layer] of [[PHASE_EXPECTATIONS, 1], [PHASE5_EXPECTATIONS, 2]]) {
    const good = fixture(REFERENCE);
    const result = map.get(RULE)({ fixture: good, files: good.files, eval: { id: 24 } });
    assert.equal(result.status, 'pass', `layer ${layer}: ${result.reason}`);
  }
  const early = mutated("    const res = await api.executeFunction({ name: 'RetrieveVersion' });\n    if (res.ok !== true) {", "    const res = await api.executeFunction({ name: 'RetrieveVersion' });\n    const early = res.outputs;\n    if (res.ok !== true) {");
  const bad = fixture(early);
  const result = PHASE_EXPECTATIONS.get(RULE)({ fixture: bad, files: bad.files, eval: { id: 24 } });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /RetrieveVersion: response\.ok must refuse before outputs are read/);
  // The pattern is part of the lifecycle verdict: a page that calls WhoAmI from an effect fails the Phase 5 evaluator itself.
  const mounted = fixture(mutated('React.useEffect(() => () => { mounted.current = false; }, []);', 'React.useEffect(() => { void showIdentity(); return () => { mounted.current = false; }; }, []);'));
  for (const map of [PHASE_EXPECTATIONS, PHASE5_EXPECTATIONS]) {
    const verdict = map.get(RULE)({ fixture: mounted, files: mounted.files, eval: { id: 24 } });
    assert.equal(verdict.status, 'fail');
    assert.match(verdict.reason, /WhoAmI: called from an effect, a memo or a timer/);
  }
});

// ── A built-in entry the page already held keeps the contract it declares ──────────────────────────────────────────────────────────────
// Only a built-in this run adds or replaces is held to the catalogue's contract — a Function with no input and no target — and to the generated
// pattern. An entry downloaded with the page and preserved by an unrelated edit keeps what it declares: an input of its own, or no `isFunction` at
// all (legacy: the runtime enforces the kind only when it is a real boolean). Its call is still checked against that, as a Custom API's is.
const LEGACY_WHO_AM_I = { ...WHO_AM_I, displayName: 'Legacy identity', parameterKinds: { Legacy: 'String' } };
const LEGACY_CALL = mutated("api.executeFunction({ name: 'WhoAmI' })", "api.executeFunction({ name: 'WhoAmI', parameters: { Legacy: 'kept' } })");
// A call that also reads an output by member — one the catalogue does not list.
const READS_EXTRA = (source, output) => {
  const find = "const userId = ownString(outputs, 'UserId');";
  assert.ok(source.includes(find));
  return source.replace(find, `const userId = ownString(outputs, 'UserId') ?? String(res.outputs?.${output});`);
};

test('a preserved built-in entry keeps the contract it declares — an input of its own, or no kind at all — through an unrelated edit with both gates OFF', () => {
  for (const [label, before, source, outputs = {}] of [
    ['a declared input and its matching call', [LEGACY_WHO_AM_I, RETRIEVE_VERSION], LEGACY_CALL],
    ['an output the scenario declares for it', [LEGACY_WHO_AM_I, RETRIEVE_VERSION], READS_EXTRA(LEGACY_CALL, 'Legacy'), { WhoAmI: ['UserId', 'Legacy'] }],
    ['no isFunction and no parameterKinds', [{ name: 'WhoAmI', displayName: 'Legacy identity' }, RETRIEVE_VERSION], REFERENCE],
    ['the catalogue projection itself', ROWS, REFERENCE],
  ]) {
    const edit = editFixture({ before, source });
    edit.manifest.customApi.outputs = outputs;
    for (const [index, result] of verdicts(edit).entries()) {
      assert.equal(result.status, 'pass', `${label}, layer ${index + 1}: ${result.reason}`);
    }
  }
  // Kept is not unchecked: the call must still agree with what the entry declares.
  const missingInput = customApiProblems(editFixture({ before: [LEGACY_WHO_AM_I, RETRIEVE_VERSION], source: REFERENCE }));
  assert.ok(missingInput.includes('WhoAmI: runtime parameter names differ from the declared kinds and discovered lookups'), JSON.stringify(missingInput));
  const declaredAction = customApiProblems(editFixture({ before: [{ ...WHO_AM_I, isFunction: false }, RETRIEVE_VERSION], source: REFERENCE }));
  assert.ok(declaredAction.includes('WhoAmI: runtime method disagrees with discovered Action/Function kind'), JSON.stringify(declaredAction));
});

test('a built-in this run adds or replaces is held to the catalogue\'s contract, beside a preserved legacy entry that keeps its own', () => {
  // RetrieveVersion added this run; the page's legacy WhoAmI, with an input of its own, stays as it was written.
  for (const [index, result] of verdicts(editFixture({ before: [LEGACY_WHO_AM_I], add: [RETRIEVE_VERSION], source: LEGACY_CALL })).entries()) {
    assert.equal(result.status, 'pass', `layer ${index + 1}: ${result.reason}`);
  }
  // A WhoAmI this run puts in place of the legacy entry is new authoring: its call takes no input.
  const replaced = customApiProblems(editFixture({ before: [LEGACY_WHO_AM_I, RETRIEVE_VERSION], add: [WHO_AM_I], source: LEGACY_CALL }));
  assert.ok(replaced.includes('WhoAmI: runtime parameter names differ from the declared kinds and discovered lookups'), JSON.stringify(replaced));
  assert.ok(replaced.includes('WhoAmI: the request must be exactly { name } — no parameters and no boundTo'), JSON.stringify(replaced));
  // On create, an authored call with an input, as an Action, or with a target is refused.
  for (const [label, source, problem] of [
    ['an input', LEGACY_CALL, 'WhoAmI: runtime parameter names differ from the declared kinds and discovered lookups'],
    ['an Action', mutated("api.executeFunction({ name: 'WhoAmI' })", "api.executeAction({ name: 'WhoAmI' })"), 'WhoAmI: runtime method disagrees with discovered Action/Function kind'],
    ['a target', mutated("api.executeFunction({ name: 'WhoAmI' })", "api.executeFunction({ name: 'WhoAmI', boundTo: { entityName: 'systemuser', id: 'x' } })"), 'WhoAmI: global operation must omit boundTo'],
  ]) {
    const found = customApiProblems(fixture(source));
    assert.ok(found.includes(problem), `${label}: ${JSON.stringify(found)}`);
  }
  // A scenario that declares more outputs for WhoAmI does not widen what a NEW call may read: its response is the catalogue's.
  const widened = fixture(READS_EXTRA(REFERENCE, 'SystemUserName'));
  widened.manifest.customApi.outputs = { WhoAmI: ['UserId', 'SystemUserName'] };
  const read = customApiProblems(widened);
  assert.ok(read.includes('WhoAmI: runtime reads an undeclared output'), JSON.stringify(read));
});

// ── A handler handed on, not called ──────────────────────────────────────────────────────────────────────────────────────────────────
// `setTimeout(showIdentity, 0)` names the handler without calling it, and the timer then calls it with no click. Handing a handler or a helper to
// an effect, a memo, a timer, a frame or a microtask fails, whatever else also calls it — a button included. A constant that names it is another
// name for it, followed the same way. Any other hand-off (a ref, a child's prop) could call it without a click too. Naming it in the button's own
// onClick, through an alias the button calls, or in a hook's dependency list calls nothing.
const BEFORE_RENDER = '  return (\n    <div>';
const atRender = (lines) => mutated(BEFORE_RENDER, `${lines}\n${BEFORE_RENDER}`);

test('a handler or helper handed to an effect, a timer, a frame, a microtask, a ref or a child — or through an alias — fails in both layers, even when its button also calls it', () => {
  for (const [label, source, reason] of [
    ['a timer in an effect', atRender('  React.useEffect(() => {\n    const timer = setTimeout(showIdentity, 0);\n    return () => clearTimeout(timer);\n  }, []);'), /^WhoAmI: handed to an effect, a memo or a timer/],
    ['a frame', atRender('  React.useEffect(() => { requestAnimationFrame(showVersion); }, []);'), /^RetrieveVersion: handed to an effect, a memo or a timer/],
    ['a microtask at render', atRender('  queueMicrotask(showVersion);'), /^RetrieveVersion: handed to an effect, a memo or a timer/],
    ['the effect callback itself', atRender('  React.useEffect(showIdentity as unknown as () => void, []);'), /^WhoAmI: handed to an effect, a memo or a timer/],
    ['an interval of the helper', atRender('  React.useEffect(() => { const id = setInterval(readVersion, 60000, api); return () => clearInterval(id); }, []);'), /^RetrieveVersion: handed to an effect, a memo or a timer/],
    ['an alias handed to a timer', atRender('  const run = showIdentity;\n  React.useEffect(() => { const timer = setTimeout(run, 0); return () => clearTimeout(timer); }, []);'), /^WhoAmI: handed to an effect, a memo or a timer/],
    ['a ref callback', mutated('      <PageErrorBar error={identityState.view.error ?? null} />', '      <div ref={showIdentity as unknown as React.Ref<HTMLDivElement>} />\n      <PageErrorBar error={identityState.view.error ?? null} />'), /^WhoAmI: showIdentity is handed somewhere other than its button's onClick/],
    ['a child component', mutated('      <PageErrorBar error={versionState.view.error ?? null} />', '      <Watcher onReady={showVersion} />\n      <PageErrorBar error={versionState.view.error ?? null} />'), /^RetrieveVersion: showVersion is handed somewhere other than its button's onClick/],
    ['a subscription, not a rename', atRender('  const unsubscribe = subscribeToRefresh(showIdentity);'), /^WhoAmI: showIdentity is handed somewhere other than its button's onClick/],
    ['a memo factory with a type argument', atRender('  React.useMemo<Promise<void>>(showVersion, []);'), /^RetrieveVersion: handed to an effect, a memo or a timer/],
  ]) {
    const found = problems(source);
    assert.ok(found.some((p) => reason.test(p)), `${label}: ${JSON.stringify(found)}`);
    for (const [index, result] of verdicts(fixture(source)).entries()) assert.equal(result.status, 'fail', `${label}, layer ${index + 1}`);
  }
  // Naming it calls nothing: in the button's own onClick, through an alias the button calls, a memoized alias, or a hook's dependency list.
  for (const [label, source] of [
    ['onClick names the handler', mutated('onClick={() => void showIdentity()}', 'onClick={showIdentity}')],
    ['an alias the button calls', mutated('onClick={() => void showVersion()}', 'onClick={() => void onVersion()}').replace(BEFORE_RENDER, `  const onVersion = showVersion;\n${BEFORE_RENDER}`)],
    ['a memoized alias', mutated('onClick={() => void showIdentity()}', 'onClick={onIdentity}').replace(BEFORE_RENDER, `  const onIdentity = React.useCallback(showIdentity, [showIdentity]);\n${BEFORE_RENDER}`)],
    ['a dependency list', mutated('React.useEffect(() => () => { mounted.current = false; }, []);', 'React.useEffect(() => () => { mounted.current = false; }, [showIdentity]);')],
  ]) {
    assert.deepStrictEqual(problems(source), [], label);
    for (const [index, result] of verdicts(fixture(source)).entries()) assert.equal(result.status, 'pass', `${label}, layer ${index + 1}: ${result.reason}`);
  }
});

// ── The result after the helper returns it ──────────────────────────────────────────────────────────────────────────────────────────
// The handler stores the helper's answer in state (`setIdentityState({ pending: false, view })`), and the page renders that state. Nothing kept
// from the result — the state, a ref it is written to, a variable initialized from either — may reach a log, storage, the clipboard, a URL,
// telemetry or the network, wherever on the page that happens: at render, in an effect, in another handler. A sink that carries none of it
// (telemetry of something else, a log of the request counter, a same-named variable in another function) is not the operation's business.
test('a value kept from the result — in state, a ref or a variable — logged, stored, copied, put in a URL or sent anywhere on the page fails in both layers', () => {
  const lastIdentity = (sink) => mutated('  const identityRequest = React.useRef(0);', '  const identityRequest = React.useRef(0);\n  const lastIdentity = React.useRef<IdentityView>({});')
    .replace('setIdentityState({ pending: false, view });\n', 'setIdentityState({ pending: false, view });\n      lastIdentity.current = view;\n')
    .replace(BEFORE_RENDER, `${sink}\n${BEFORE_RENDER}`);
  for (const [label, source, reason] of [
    ['the identity state logged at render', atRender('  console.log(identityState.view.identity);'), /^WhoAmI: a value kept from its result \(identityState\) must not be logged, stored, copied or sent/],
    ['the version logged by an effect', atRender('  React.useEffect(() => { if (versionState.view.version) console.info(versionState.view.version); }, [versionState]);'), /^RetrieveVersion: a value kept from its result \(versionState\)/],
    ['the identity state stored', atRender("  React.useEffect(() => { localStorage.setItem('me', JSON.stringify(identityState)); }, [identityState]);"), /^WhoAmI: a value kept from its result \(identityState\)/],
    ['a variable derived from the version, sent to telemetry', atRender("  const shown = versionState.view.version;\n  React.useEffect(() => { appInsights.trackEvent({ name: 'Version', properties: { shown } }); }, [shown]);"), /^RetrieveVersion: a value kept from its result \(shown\)/],
    ['the user id put in the URL', atRender("  React.useEffect(() => { if (identityState.view.identity) history.replaceState(null, '', `?user=${identityState.view.identity.userId}`); }, [identityState]);"), /^WhoAmI: a value kept from its result \(identityState\)/],
    ['the version sent with fetch', atRender("  React.useEffect(() => { if (versionState.view.version) void fetch('/log', { method: 'POST', body: versionState.view.version }); }, [versionState]);"), /^RetrieveVersion: a value kept from its result \(versionState\)/],
    ['a copy button of its own', mutated('      <PageErrorBar error={identityState.view.error ?? null} />', "      <Button onClick={() => void navigator.clipboard.writeText(identityState.view.identity?.userId ?? '')}>Copy</Button>\n      <PageErrorBar error={identityState.view.error ?? null} />"), /^WhoAmI: a value kept from its result \(identityState\)/],
    ['a ref written from the result, logged at render', lastIdentity('  console.log(lastIdentity.current);'), /^WhoAmI: a value kept from its result \(lastIdentity\)/],
    ['a module variable assigned the result, logged by an effect', mutated('setVersionState({ pending: false, view });\n', 'setVersionState({ pending: false, view });\n      lastVersion = view;\n')
      .replace('const GeneratedComponent', 'let lastVersion: VersionView | undefined;\n\nconst GeneratedComponent')
      .replace(BEFORE_RENDER, `  React.useEffect(() => { console.log(lastVersion); }, [versionState]);\n${BEFORE_RENDER}`), /^RetrieveVersion: a value kept from its result \(lastVersion\)/],
  ]) {
    const found = problems(source);
    assert.ok(found.some((p) => reason.test(p)), `${label}: ${JSON.stringify(found)}`);
    for (const [index, result] of verdicts(fixture(source)).entries()) assert.equal(result.status, 'fail', `${label}, layer ${index + 1}`);
  }
  for (const [label, source] of [
    ['telemetry of something else', atRender("  React.useEffect(() => { appInsights.trackEvent({ name: 'PageViewed', properties: { identity: 'not-recorded' } }); }, []);")],
    ['a log of the request counter', atRender("  console.debug('identity requests', identityRequest.current);")],
    ['same-named variables in another function', mutated('async function readVersion(', 'function logRows(view: unknown[]) { const res = view.length; console.log(view.length, res); }\n\nasync function readVersion(')],
    ['a constant named like the button attribute', atRender("  const onClick = 'tracked';\n  console.debug('button', onClick);")],
  ]) {
    assert.deepStrictEqual(problems(source), [], label);
    for (const [index, result] of verdicts(fixture(source)).entries()) assert.equal(result.status, 'pass', `${label}, layer ${index + 1}: ${result.reason}`);
  }
});

// ── An edit that adds a built-in operation ────────────────────────────────────────────────────────────────────────────────────────────
// An edit never visits the create flow's Phase 4.6b, so its own re-probe is what stops an add the flag no longer allows (edit-flow.md, Edit
// Phase 4): the gate is probed again after the listing — whether the need was asked for up front or found in the planner's clarification, the
// builder lists the operations first — and before the source is written. A flip to OFF in between, no re-probe, or one after the write fails.
test('an edit that adds a built-in re-probes the gate after the listing and before the source is written — a flip to OFF, no re-probe, or a late one fails in both layers', () => {
  const add = () => editFixture({ before: [LEGACY_WHO_AM_I], add: [RETRIEVE_VERSION], source: LEGACY_CALL });
  for (const [index, result] of verdicts(add()).entries()) assert.equal(result.status, 'pass', `layer ${index + 1}: ${result.reason}`);
  for (const [label, mutate, reason] of [
    ['the flag turned off before the source was edited', (f) => { f.events.find((call) => call.id === 'builtin-regate').result = 'disabled'; }, /^edit: a disabled or unreadable dataverse-operations gate must halt built-in authoring/],
    ['no re-probe after the listing', (f) => { f.events = f.events.filter((call) => call.id !== 'builtin-regate'); }, /^edit: built-in authoring must re-probe the dataverse-operations gate after the listing/],
    ['a re-probe after the source was written', (f) => {
      const [regate] = f.events.splice(f.events.findIndex((call) => call.id === 'builtin-regate'), 1);
      f.events.splice(f.events.findIndex((call) => call.id === 'write') + 1, 0, regate);
    }, /^edit: the dataverse-operations re-probe must come before generation/],
  ]) {
    const bad = add();
    mutate(bad);
    const found = customApiProblems(bad);
    assert.ok(found.some((problem) => reason.test(problem)), `${label}: ${JSON.stringify(found)}`);
    for (const [index, result] of verdicts(bad).entries()) assert.equal(result.status, 'fail', `${label}, layer ${index + 1}`);
  }
});
