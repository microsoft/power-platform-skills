'use strict';
// The teaching examples a page builder copies. Each reference shows a whole PageBody (and its top-level helpers) built on
// the page error block references/rules.md publishes ("Missing Error Handling"); here that block — copied unchanged up to
// its own example PageBody — and the document's code are put together into the complete page a builder would write, which
// must transpile with the TypeScript the plugin vendors (a syntax check, not a type check) and, for a Custom API, pass the
// runtime check of lib/custom-api-contract.js. The built-in operations' generated call is graded the same way in
// built-in-operation-pattern.test.js. A document that drifts back to a try/catch that sets a string, logs the thrown value
// or calls trackException itself fails here. Whether a page's failures all reach its reporter is not graded (EVAL_GUIDE.md);
// the approval tests at the end run the examples' own code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtimeProblems } = require('../lib/custom-api-contract.js');
const { loadVendoredTypeScript } = require('../../../../plugins/model-apps/scripts/lib/typescript-compiler.js');

const PLUGIN = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps');
const read = (...parts) => fs.readFileSync(path.join(PLUGIN, ...parts), 'utf8').replace(/\r\n/g, '\n');
const RULES = read('references', 'rules.md');
const ERRORS = RULES.slice(RULES.indexOf('\n### 2. Missing Error Handling\n'), RULES.indexOf('\n### 3. '));
const RULE_BLOCKS = [...ERRORS.matchAll(/```tsx\n([\s\S]*?)\n```/g)].map((match) => match[1]);
const FOUNDATION = RULE_BLOCKS.find((block) => /\bfunction reportPageError\(/.test(block));
const TELEMETRY = RULE_BLOCKS.find((block) => /appInsights\?\.trackException\?\.\(/.test(block));
const PREFIX = FOUNDATION.slice(0, FOUNDATION.indexOf('function PageBody('));
const WRAPPER = FOUNDATION.slice(FOUNDATION.indexOf('const GeneratedComponent = '));

// Fenced blocks, including the ones indented under a list item (their closing fence carries the same indentation).
const codeBlocks = (text) => [...text.matchAll(/^([ \t]*)```(?:typescript|tsx)\n([\s\S]*?)\n\1```/gm)].map((match) => match[2]);
// The blocks of a document that hold a whole PageBody.
const bodies = (text) => codeBlocks(text).filter((code) => /^function PageBody\(/m.test(code));
// The complete page: the canonical block up to its own example PageBody, the document's code, then the canonical wrapper
// unless the document shows its own.
const complete = (code, prefix = PREFIX) => `${prefix}${code}\n\n${/^export default GeneratedComponent;$/m.test(code) ? '' : WRAPPER}\n`;
// The documented telemetry insertion goes right after the reporter's console.error line.
function withTelemetry(source) {
  const lines = source.split('\n');
  const at = lines.findIndex((line) => /^\s*console\.error\(/.test(line));
  assert.ok(at > 0 && TELEMETRY, 'rules.md publishes the reporter and its telemetry insertion');
  return [...lines.slice(0, at + 1), ...TELEMETRY.split('\n'), ...lines.slice(at + 1)].join('\n');
}
let typescript;
function parses(source, label) {
  typescript ||= loadVendoredTypeScript();
  const { diagnostics } = typescript.transpileModule(source, {
    fileName: 'page.tsx',
    reportDiagnostics: true,
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React },
  });
  assert.deepEqual((diagnostics || []).map((entry) => typescript.flattenDiagnosticMessageText(entry.messageText, '\n')), [], `${label} parses`);
}
// One textual change; a change that does not apply is a broken test, never a pass.

const DOCS = {
  caching: read('references', 'data-caching.md'),
  customApi: read('references', 'custom-api.md'),
  connectors: read('references', 'connectors.md'),
  localization: read('references', 'localization.md'),
  telemetry: read('references', 'page-telemetry.md'),
  builtIns: read('references', 'dataverse-operations.md'),
  builder: read('agents', 'genpage-page-builder.md'),
};
const [CACHE_LIST, CACHE_RECORD] = bodies(DOCS.caching);
const [ACTION, FUNCTION] = bodies(DOCS.customApi);
const [CONNECTOR_TABLE, CONNECTOR_OPERATION] = bodies(DOCS.connectors);
const [SETTINGS] = bodies(DOCS.localization);
// The telemetry reference also shows the prop declaration around an empty PageBody; its example page is the one that saves.
const TELEMETRY_SAVE = bodies(DOCS.telemetry).find((code) => /'saveOrder'/.test(code));
// A localized page keeps the reference's top-level language resolver beside the block.
const LANGUAGE = codeBlocks(DOCS.localization).find((code) => /^function resolvePageLanguage\(\)/m.test(code));
const PAGES = {
  'data-caching.md Pattern 1 (list)': CACHE_LIST && complete(CACHE_LIST),
  'data-caching.md Pattern 2 (detail)': CACHE_RECORD && complete(CACHE_RECORD),
  'custom-api.md Action': ACTION && complete(ACTION),
  'custom-api.md Function': FUNCTION && complete(FUNCTION),
  'connectors.md tabular read': CONNECTOR_TABLE && complete(CONNECTOR_TABLE),
  'connectors.md REST operation': CONNECTOR_OPERATION && complete(CONNECTOR_OPERATION),
  'localization.md usersettings read': SETTINGS && LANGUAGE && complete(`${LANGUAGE}\n\n${SETTINGS}`),
  'page-telemetry.md failed-save report': TELEMETRY_SAVE && complete(TELEMETRY_SAVE, withTelemetry(PREFIX)),
};

test('each reference shows a complete PageBody built on the page error block, and each whole page parses', () => {
  assert.ok(FOUNDATION, 'rules.md publishes the canonical page error block');
  for (const [label, page] of Object.entries(PAGES)) {
    assert.ok(page, `${label}: the reference shows a whole PageBody built on the page error block`);
    parses(page, label);
  }
});

test('the Custom API Action and Function examples also pass the Custom API runtime check, through the boundary wrapper', () => {
  const action = { name: 'new_ApproveOrder', isFunction: false, boundEntityLogicalName: 'salesorder', displayName: 'Approve Order', parameterKinds: { Comment: 'String' } };
  const fn = { name: 'new_GetOrderSummary', isFunction: true, displayName: 'Order summary', parameterKinds: { OrderId: 'Guid' } };
  assert.deepEqual(runtimeProblems(PAGES['custom-api.md Action'], [action], { new_ApproveOrder: ['NewStatus'] }, new Map()), []);
  assert.deepEqual(runtimeProblems(PAGES['custom-api.md Function'], [fn], { new_GetOrderSummary: ['Total'] }, new Map()), []);
  // The order is part of the contract: each guard reports, stores the view and returns before the outputs, a network result
  // offers the named manual retry and nothing else does.
  for (const [label, page] of [['Action', PAGES['custom-api.md Action']], ['Function', PAGES['custom-api.md Function']]]) {
    const guards = ['if (res.indeterminate)', "if (res.error?.code === 'indeterminate')", "if (!res.ok && res.error?.code === 'network')", 'if (!res.ok)', 'res.outputs?.'];
    const at = guards.map((guard) => page.indexOf(guard));
    assert.ok(at.every((index, i) => index > 0 && (i === 0 || index > at[i - 1])), `${label}: the guards in order before the outputs (${at})`);
  }
  assert.doesNotMatch(DOCS.customApi, /setError\(|res\.error\?\.message \?\? 'The action failed\.'/, 'no string error state is left in the Custom API reference');
});

test('the telemetry example instruments only the save it was asked about, and only the reporter sends an exception', () => {
  const page = PAGES['page-telemetry.md failed-save report'];
  const reports = [...TELEMETRY_SAVE.matchAll(/\breportPageError\(/g)].map((match) => callArguments(TELEMETRY_SAVE, match.index + match[0].length - 1).join(', '));
  assert.deepEqual(reports, ["PAGE_NAME, 'saveOrder', undefined, error, 'write', undefined, appInsights"], 'one report, the save, carries the appInsights prop');
  assert.doesNotMatch(TELEMETRY_SAVE, /\.trackException\s*(?:\?\.\s*)?\(/, 'the page never calls trackException itself');
  assert.doesNotMatch(page.slice(page.indexOf('const GeneratedComponent')), /appInsights=/, 'a save-only request leaves the boundary as it is');
  // The other GOOD shapes report their failures with no telemetry argument: those requests measure, they do not report failures.
  const known = DOCS.telemetry.slice(DOCS.telemetry.indexOf('\n## 4. Known-good shapes\n'), DOCS.telemetry.indexOf('\n## 5. Anti-patterns\n'));
  assert.doesNotMatch(known, /\.trackException\s*(?:\?\.\s*)?\(/, 'no known-good shape calls trackException');
  for (const code of codeBlocks(known)) {
    for (const call of code.matchAll(/\breportPageError\(/g)) {
      const args = callArguments(code, call.index + call[0].length - 1);
      if (args.includes("'saveOrder'")) continue;
      assert.ok(args.length === 5, `a report outside the failed-save example hands no retry or telemetry: ${args.join(', ')}`);
    }
  }
  // The trigger row for failures names the reporter, not catch-block trackException calls.
  const triggers = DOCS.telemetry.slice(DOCS.telemetry.indexOf('\n### Trigger patterns\n'), DOCS.telemetry.indexOf('\n## 2. The API\n'));
  assert.doesNotMatch(triggers, /`trackException\(err, \{ \.\.\. \}\)` in the relevant `catch` blocks/);
  assert.match(triggers, /\| "report failed saves" \| the same insertion, and `props\.appInsights` as the seventh argument of the save's reports \*\*only\*\*/);
});

// A call's top-level argument texts: brackets, strings and template literals are skipped over, so a comma inside them does
// not split. Enough for the documents' own examples; a malformed call fails the count check below.
function callArguments(code, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      for (i += 1; i < code.length && code[i] !== ch; i += 1) if (code[i] === '\\') i += 1;
    } else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) { args.push(code.slice(start, i).trim()); return args; }
      depth -= 1;
    } else if (ch === ',' && depth === 0) { args.push(code.slice(start, i).trim()); start = i + 1; }
  }
  return null;
}

test('every reportPageError call the teaching documents show has the five required arguments and a literal kind', () => {
  const documents = { 'rules.md': RULES, ...Object.fromEntries(Object.entries(DOCS).map(([key, text]) => [key, text])) };
  let seen = 0;
  for (const [name, text] of Object.entries(documents)) {
    for (const code of codeBlocks(text)) {
      for (const call of code.matchAll(/(?<!function\s)\breportPageError\(/g)) {
        const args = callArguments(code, call.index + call[0].length - 1);
        assert.ok(args, `${name}: a reportPageError call closes`);
        seen += 1;
        const shown = `${name}: reportPageError(${args.join(', ')})`;
        assert.ok(args.length >= 5 && args.length <= 7, `${shown} has five to seven arguments`);
        assert.match(args[4], /^(['"])(?:read|write|indeterminate|network|render)\1$/, `${shown} has a literal kind at index 4`);
        assert.match(args[1], /^(['"])[A-Za-z][\w]*\1$/, `${shown} names its operation with one stable literal`);
        if (['write', 'indeterminate', 'render'].includes(args[4].slice(1, -1))) assert.ok(!args[5] || args[5] === 'undefined', `${shown} offers no retry`);
      }
    }
  }
  assert.ok(seen >= 40, `the documents show the reporter in use (${seen} calls)`);
});

test('the documents no longer teach a bare try/catch error string or a logged thrown value', () => {
  assert.doesNotMatch(DOCS.caching, /error: "Unable to load records\."|error: "Unable to load record\."|error: string \| null/);
  assert.doesNotMatch(DOCS.localization, /console\.error\("Failed to fetch user settings", error\)/);
  assert.doesNotMatch(DOCS.connectors, /if \(!response\.ok\) \{ return; \}/);
  assert.doesNotMatch(DOCS.builder, /setError\(|if \(!response\.ok\) \{ return; \}/);
  for (const [name, text] of Object.entries(DOCS)) {
    for (const code of codeBlocks(text)) assert.doesNotMatch(code, /console\.(?:error|log|warn)\([^)]*\berror\b\s*\)/, `${name} logs no thrown value`);
  }
});

// ---------- the samples a builder is pointed at ----------

const SAMPLES = path.join(PLUGIN, 'samples');
const sampleFiles = () => fs.readdirSync(SAMPLES).filter((name) => name.endsWith('.tsx')).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

test('every sample page parses, and each of its reports has the five required arguments and a literal kind', () => {
  const files = sampleFiles();
  assert.equal(files.length, 13, 'the thirteen complete sample pages');
  for (const name of files) {
    const source = fs.readFileSync(path.join(SAMPLES, name), 'utf8');
    parses(source, name);
    for (const call of source.matchAll(/(?<!function\s)\breportPageError\(/g)) {
      const args = callArguments(source, call.index + call[0].length - 1);
      assert.ok(args.length >= 5 && /^(['"])(?:read|write|indeterminate|network|render)\1$/.test(args[4]), `${name}: reportPageError(${args.join(', ')})`);
    }
    // No sample still keeps a failure as a bare string or logs the thrown value.
    assert.doesNotMatch(source, /error: string \| null|console\.error\([^)]*\berr\b/, `${name} keeps no string error state`);
  }
});

test('the Custom API sample also passes the Custom API runtime check, its Action latched and both results guarded in order', () => {
  const source = fs.readFileSync(path.join(SAMPLES, '13-custom-api-invocation.tsx'), 'utf8');
  const bindings = [
    { name: 'new_GetOrderSummary', isFunction: true, displayName: 'Order summary', parameterKinds: { OrderId: 'Guid' } },
    { name: 'new_ApproveOrder', isFunction: false, boundEntityLogicalName: 'salesorder', displayName: 'Approve Order', parameterKinds: { Comment: 'String' } },
  ];
  assert.deepEqual(runtimeProblems(source, bindings, { new_GetOrderSummary: ['Total', 'Status'], new_ApproveOrder: ['NewStatus'] }, new Map()), []);
  // Neither the effect nor anything else depends on dataApi or a shape derived from it (Rule 15).
  assert.doesNotMatch(source, /\[\s*actionApi\b|\bdataApi\s*\]/, 'no dataApi-derived value in a dependency array');
});

// ---------- an action belongs to the record it was started on ----------
// Sample 13, the custom-api.md Action page and fixture 27's page are transpiled and run against hook and element
// stand-ins with deferred fake requests — no React and no browser: the handlers, state updates and effects run as written,
// which is what decides where a result goes. The record on screen changes while an approval is pending, and after it has
// failed: a result for the earlier record — its error and its retry — never appears on the later record, and a retry kept
// from the earlier render sends nothing there. On the record it belongs to, the retry still re-sends that approval.
function runnablePage(source, exportNames) {
  typescript ||= loadVendoredTypeScript();
  const { outputText } = typescript.transpileModule(`${source}\nexport { ${exportNames.join(', ')} };\n`, {
    fileName: 'page.tsx',
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React, esModuleInterop: true },
  });
  const cells = [];
  const effects = [];
  let cursor = 0;
  const React = {
    Component: class { constructor(props) { this.props = props; } },
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const prior = cells[index];
      if (!prior || !deps || deps.some((value, i) => value !== prior.deps[i])) {
        effects.push(() => { prior?.cleanup?.(); cells[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  const fluent = new Proxy({ makeStyles: () => () => ({}), tokens: new Proxy({}, { get: (_, name) => String(name) }), createTableColumn: (column) => column },
    { get: (target, name) => (name in target ? target[name] : String(name)) });
  const icons = new Proxy({}, { get: (_, name) => String(name) });
  const imports = { react: React, '@fluentui/react-components': fluent, '@fluentui/react-icons': icons, './RuntimeTypes': {} };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'console', 'window', outputText)(
    (name) => { assert.ok(name in imports, `unexpected import ${name}`); return imports[name]; },
    module, module.exports, { error() {} }, {},
  );
  return {
    ...module.exports,
    render(props) { cursor = 0; return module.exports.PageBody(props); },
    flush() { for (const effect of effects.splice(0)) effect(); },
  };
}
// The elements of a rendered tree. A DataGrid's render-prop children are expanded the way the grid calls them: the body's
// for each of the grid's items, a row's (header or body) for its name column.
function elements(node, out = [], items = []) {
  if (Array.isArray(node)) { for (const child of node) elements(child, out, items); return out; }
  if (!node || typeof node !== 'object' || !node.type) return out;
  out.push(node);
  const rows = node.type === 'DataGrid' ? node.props.items || [] : items;
  for (const child of [].concat(node.props.children ?? [])) {
    if (typeof child !== 'function') { elements(child, out, rows); continue; }
    if (node.type === 'DataGridBody') for (const item of rows) elements(child({ item }), out, rows);
    else if (node.type === 'DataGridRow') elements(child({ renderCell: () => null, renderHeaderCell: () => null, columnId: 'name' }), out, rows);
  }
  return out;
}
const tick = () => new Promise(setImmediate);
const approvalBar = (page, tree) => elements(tree).find((node) => node.type === page.PageErrorBar && node.props.error?.operation === 'approveOrder');
const primaryButton = (tree) => elements(tree).find((node) => node.type === 'Button' && node.props.appearance === 'primary');
// A dataApi whose Action requests wait until the test answers them, in order.
function deferredActions() {
  const requests = [];
  const dataApi = {
    executeFunction: async () => ({ ok: true, outputs: { Total: 1, Status: 'Pending' } }),
    executeAction: (request) => new Promise((resolve) => { requests.push({ request, resolve }); }),
  };
  return { requests, dataApi };
}
const NETWORK = { ok: false, error: { code: 'network', message: 'The request did not leave the client' } };
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const RECORD_PAGES = {
  'samples/13-custom-api-invocation.tsx': () => read('samples', '13-custom-api-invocation.tsx'),
  'custom-api.md Action': () => PAGES['custom-api.md Action'],
};

test('a late answer for the record the page has left is not shown on the record now on screen, and offers it no retry', async () => {
  for (const [label, source] of Object.entries(RECORD_PAGES)) {
    const page = runnablePage(source(), ['PageBody', 'PageErrorBar']);
    const { requests, dataApi } = deferredActions();
    const props = (recordId) => ({ dataApi, pageInput: { entityName: 'salesorder', recordId } });
    page.render(props(A));
    page.flush();
    await tick();
    primaryButton(page.render(props(A))).props.onClick();
    assert.equal(requests.length, 1, `${label}: the approval of A is sent`);
    assert.equal(requests[0].request.boundTo.id, A, `${label}: bound to A`);
    page.render(props(B));
    page.flush();
    await tick();
    page.render(props(B));
    requests[0].resolve(NETWORK);
    await tick();
    assert.equal(approvalBar(page, page.render(props(B))), undefined, `${label}: A's failure is not shown on B`);
    assert.equal(requests.length, 1, `${label}: nothing more is sent`);
  }
});

test('a failure shown for one record is cleared when the page moves to another, and its kept retry sends nothing there', async () => {
  for (const [label, source] of Object.entries(RECORD_PAGES)) {
    const page = runnablePage(source(), ['PageBody', 'PageErrorBar']);
    const { requests, dataApi } = deferredActions();
    const props = (recordId) => ({ dataApi, pageInput: { entityName: 'salesorder', recordId } });
    page.render(props(A));
    page.flush();
    await tick();
    primaryButton(page.render(props(A))).props.onClick();
    requests[0].resolve(NETWORK);
    await tick();
    const shown = approvalBar(page, page.render(props(A)));
    assert.equal(shown?.props.error.kind, 'network', `${label}: the network failure is shown on A`);
    const keptRetry = shown.props.error.retry;
    assert.equal(typeof keptRetry, 'function', `${label}: with its manual retry`);
    page.render(props(B));
    page.flush();
    await tick();
    assert.equal(approvalBar(page, page.render(props(B))), undefined, `${label}: B starts with a clean approval panel`);
    keptRetry();
    await tick();
    assert.equal(requests.length, 1, `${label}: A's retry sends nothing while B is on screen`);
    // Back on A, the panel is clean too, and a new approval of A goes out bound to A.
    page.render(props(A));
    page.flush();
    await tick();
    primaryButton(page.render(props(A))).props.onClick();
    assert.equal(requests.length, 2, `${label}: a new approval is sent`);
    assert.equal(requests[1].request.boundTo.id, A, `${label}: bound to the record on screen`);
  }
});

test('on the record it belongs to, a network failure keeps its manual retry, and the retry re-sends that record\'s approval', async () => {
  for (const [label, source] of Object.entries(RECORD_PAGES)) {
    const page = runnablePage(source(), ['PageBody', 'PageErrorBar']);
    const { requests, dataApi } = deferredActions();
    const props = (recordId) => ({ dataApi, pageInput: { entityName: 'salesorder', recordId } });
    page.render(props(A));
    page.flush();
    await tick();
    primaryButton(page.render(props(A))).props.onClick();
    requests[0].resolve({ ok: false, indeterminate: true, error: { code: 'indeterminate', message: 'timed out after sending' } });
    await tick();
    const indeterminate = approvalBar(page, page.render(props(A)));
    assert.equal(indeterminate?.props.error.kind, 'indeterminate', `${label}: an indeterminate answer stays on its record`);
    assert.equal(indeterminate.props.error.retry, undefined, `${label}: with no retry`);
    primaryButton(page.render(props(A))).props.onClick();
    requests[1].resolve(NETWORK);
    await tick();
    approvalBar(page, page.render(props(A))).props.error.retry();
    await tick();
    assert.equal(requests.length, 3, `${label}: the retry re-sends`);
    assert.equal(requests[2].request.boundTo.id, A, `${label}: the approval of the record on screen`);
  }
});

test('fixture 27 holds the selected order while an approval runs, and another order clears the approval and its retry', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'fixtures', '27-page-error-helper', 'order-approvals.tsx'), 'utf8');
  const page = runnablePage(source, ['PageBody', 'PageErrorBar']);
  const orders = [A, B].map((salesorderid, i) => ({ salesorderid, name: `Order ${i + 1}`, totalamount: 10, statuscode: 1 }));
  const { requests, dataApi } = deferredActions();
  Object.assign(dataApi, {
    queryTable: async () => ({ rows: orders }),
    retrieveRow: async (table, { id }) => orders.find((order) => order.salesorderid === id),
  });
  const props = { dataApi, pageInput: {} };
  const orderButton = (tree, name) => elements(tree).find((node) => node.type === 'Button' && node.props.appearance === 'transparent' && [].concat(node.props.children).includes(name));
  page.render(props);
  page.flush();
  await tick();
  orderButton(page.render(props), 'Order 1').props.onClick();
  await tick();
  primaryButton(page.render(props)).props.onClick();
  assert.equal(requests[0].request.boundTo.id, A, 'the approval of order 1 is sent');
  assert.equal(orderButton(page.render(props), 'Order 2').props.disabled, true, 'another order cannot be selected while it runs');
  requests[0].resolve(NETWORK);
  await tick();
  const keptRetry = approvalBar(page, page.render(props))?.props.error.retry;
  assert.equal(typeof keptRetry, 'function', 'order 1 shows its network failure with a retry');
  orderButton(page.render(props), 'Order 2').props.onClick();
  await tick();
  assert.equal(approvalBar(page, page.render(props)), undefined, 'order 2 starts with a clean approval panel');
  keptRetry();
  await tick();
  assert.equal(requests.length, 1, 'order 1\'s retry sends nothing while order 2 is on screen');
});