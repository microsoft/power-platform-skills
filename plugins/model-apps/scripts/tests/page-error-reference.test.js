'use strict';
// The page error contract's canonical code, as references/rules.md publishes it ("Missing Error Handling"): the one
// reporter every failed data operation goes through, the English error copy, the error bar, the render boundary and the
// default-export wrapper. A generated page copies that block, so these tests run the block's ACTUAL source rather than
// a restatement of it: it is transpiled with the TypeScript the plugin vendors (the compile the
// SDK applies to a page — a transpile, so this is not a type check) and evaluated against a stand-in React that only
// builds element objects. Nothing here renders through real React; the element trees are inspected as data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'references', 'rules.md'), 'utf8').replace(/\r\n/g, '\n');

// The section from its heading to the next heading of the same level.
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `rules.md has the section "${heading}"`);
  const next = text.indexOf('\n### ', start + heading.length + 2);
  return text.slice(start, next < 0 ? text.length : next);
}
const MISSING_ERROR_HANDLING = section(RULES, '### 2. Missing Error Handling');
const blocks = [...MISSING_ERROR_HANDLING.matchAll(/```(?:tsx|typescript)\n([\s\S]*?)\n```/g)].map((match) => match[1]);
const FOUNDATION = blocks.find((block) => /\bfunction reportPageError\(/.test(block));
const TELEMETRY = blocks.find((block) => /appInsights\?\.trackException\?\.\(/.test(block));

// The telemetry insertion goes immediately after the reporter's console.error line, the one place the section names.
function withTelemetry(source) {
  assert.ok(source && TELEMETRY, 'rules.md publishes the canonical block and its telemetry insertion');
  const lines = source.split('\n');
  const at = lines.findIndex((line) => /^\s*console\.error\(/.test(line));
  assert.ok(at > 0, 'the reporter has its console.error line');
  return [...lines.slice(0, at + 1), ...TELEMETRY.split('\n'), ...lines.slice(at + 1)].join('\n');
}

// A stand-in React: elements are plain objects, components are what the page passes to createElement.
function fakeReact() {
  class Component {
    constructor(props) { this.props = props; }
  }
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props || {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) },
  });
  const unsupported = () => { throw new Error('hooks do not run in this test'); };
  return { Component, createElement, Fragment: 'Fragment', useState: unsupported, useRef: unsupported, useEffect: unsupported, useMemo: unsupported };
}
const FLUENT = Object.fromEntries(['Button', 'Input', 'MessageBar', 'MessageBarActions', 'MessageBarBody', 'Text'].map((name) => [name, name]));

let typescript;
// Transpile and run a page module; its top-level functions are reached through one appended export line.
function load(source) {
  assert.ok(source, 'rules.md "Missing Error Handling" publishes the canonical page error block');
  typescript ||= loadVendoredTypeScript();
  const exported = 'export { reportPageError, PageErrorBar, PageErrorBoundary, PageBody, translate, ERROR_COPY, PAGE_NAME };';
  const { outputText } = typescript.transpileModule(`${source}\n${exported}\n`, {
    fileName: 'page.tsx',
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
      jsx: typescript.JsxEmit.React,
      esModuleInterop: true,
    },
  });
  const logged = [];
  const console = { error: (...args) => logged.push(args), log() {}, warn() {} };
  const React = fakeReact();
  const modules = { react: React, '@fluentui/react-components': FLUENT, './RuntimeTypes': {} };
  const require = (name) => {
    assert.ok(Object.hasOwn(modules, name), `the page imports only what a page may: ${name}`);
    return modules[name];
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'console', outputText)(require, module, module.exports, console);
  return { ...module.exports, logged };
}

// Every element of a tree, depth first.
function elements(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) elements(child, out); return out; }
  if (node && typeof node === 'object' && 'type' in node) {
    out.push(node);
    elements(node.props.children, out);
  }
  return out;
}

test('the Missing Error Handling section publishes the canonical reporter, copy, bar, boundary and wrapper, and no raw-error logging', () => {
  assert.ok(FOUNDATION, 'the section holds the canonical page error block (types, reportPageError, error copy, PageErrorBar, PageErrorBoundary, wrapper)');
  assert.ok(TELEMETRY, 'the section holds the telemetry insertion for an authorized failure-reporting request');
  for (const name of ['type PageErrorKind', 'type PageErrorView', 'type PageErrorTelemetry', 'const PAGE_NAME', 'const ERROR_COPY',
    'function translate(', 'function reportPageError(', 'function PageErrorBar(', 'class PageErrorBoundary extends React.Component<',
    'function PageBody(', 'const GeneratedComponent = (props: GeneratedComponentProps) => (', 'export default GeneratedComponent;']) {
    assert.ok(FOUNDATION.includes(name), `the canonical block declares ${name}`);
  }
  assert.doesNotMatch(FOUNDATION, /\.\s*trackException\s*(?:\?\.\s*)?\(/, 'the canonical reporter itself emits no telemetry');
  // The old instruction caught the error and logged the thrown value itself; the only console call left is the reporter's.
  assert.doesNotMatch(MISSING_ERROR_HANDLING, /Always wrap async dataApi calls in try-catch\./);
  const consoleCalls = blocks.join('\n').match(/console\.\w+\(/g) || [];
  assert.deepEqual(consoleCalls, ['console.error('], 'the reporter is the only code in the section that logs, and it logs bounded diagnostics');
});

test('the reporter keeps a supplied code and the bounded message, logs both exactly once, and returns the view', () => {
  const page = load(FOUNDATION);
  assert.equal(page.reportPageError.length, 7, 'five required arguments, then retry and telemetry');
  const thrown = Object.assign(new Error('Boom'), { code: '0x80040217' });
  const view = page.reportPageError('Accounts', 'loadAccounts', undefined, thrown, 'read');
  assert.deepEqual(view, { operation: 'loadAccounts', message: 'Boom', fallbackKey: 'error.read', kind: 'read', code: '0x80040217' });
  assert.equal(page.logged.length, 1, 'one log line per report');
  const [prefix, diagnostics, ...rest] = page.logged[0];
  assert.equal(prefix, '[Accounts] loadAccounts failed');
  assert.deepEqual(diagnostics, { code: '0x80040217', message: 'Boom' });
  assert.deepEqual(Object.keys(diagnostics), ['code', 'message']);
  assert.equal(rest.length, 0, 'the thrown value is never a console argument');
  // A returned failure: a string third argument IS the code, kept apart from its message.
  const result = page.reportPageError('Accounts', 'approveOrder', 'not_permitted', 'You do not have permission.', 'write');
  assert.deepEqual(result, { operation: 'approveOrder', message: 'You do not have permission.', fallbackKey: 'error.write', kind: 'write', code: 'not_permitted' });
  assert.deepEqual(page.logged[1][1], { code: 'not_permitted', message: 'You do not have permission.' });
});

test('a code is a non-empty string or a finite number, then the thrown code, errorCode or error.code — never a status or the wording', () => {
  const page = load(FOUNDATION);
  const code = (...args) => page.reportPageError('P', 'op', ...args, 'read').code;
  assert.equal(code(404, 'Not found'), '404', 'a finite number is kept as text');
  assert.equal(code(Number.NaN, { code: 'E1' }), 'E1', 'a non-finite number is no code');
  assert.equal(code('   ', { code: 'E1' }), 'E1', 'a blank string is no code');
  assert.equal(code(undefined, { errorCode: 'E2', error: { code: 'E3' } }), 'E2');
  assert.equal(code(undefined, { error: { code: 'E3', message: 'nested' } }), 'E3');
  assert.equal(code(undefined, { code: 'E1', errorCode: 'E2' }), 'E1');
  assert.equal(code(undefined, { status: 404, statusCode: 404, message: 'HTTP 404 network failure' }), undefined, 'a status and the message wording never become a code');
  assert.equal(code(`  ${'x'.repeat(100)}\n`, undefined), 'x'.repeat(80), 'a code is trimmed and stops at 80 characters');
  assert.equal(code('E\u0007\tsub', undefined), 'E sub', 'control characters and white space collapse');
});

test('a message keeps its first line, collapses white space, refuses object and stack-frame text, and stops at 300 characters', () => {
  const page = load(FOUNDATION);
  const message = (value) => page.reportPageError('P', 'op', undefined, value, 'read').message;
  assert.equal(message('  First   line\nsecond line'), 'First line');
  assert.equal(message({ message: 'Outer', error: { message: 'Inner' } }), 'Outer');
  assert.equal(message({ error: { message: 'Inner' } }), 'Inner');
  assert.equal(message('[object Object]'), '');
  assert.equal(message({ message: '[object Object]', error: { message: 'Readable' } }), 'Readable', 'an unusable message falls through to the next field');
  assert.equal(message('at loadAccounts (page.tsx:12:7)'), '', 'a stack frame is not a message');
  assert.equal(message({ message: 42 }), '', 'a message is a string, never a coerced object or number');
  const long = message('y'.repeat(400));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('\u2026'), 'the cut is marked with an ellipsis inside the 300 characters');
  assert.deepEqual(page.logged.at(-1)[1], { code: '', message: long }, 'the log keeps the same bounded text');
});

test('a hostile thrown value never breaks the error path, and only the named fields are read', () => {
  const page = load(FOUNDATION);
  const throwing = new Proxy({}, { get() { throw new Error('getter'); } });
  assert.deepEqual(page.reportPageError('P', 'op', undefined, throwing, 'read'), { operation: 'op', message: '', fallbackKey: 'error.read', kind: 'read' });
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(page.reportPageError('P', 'op', undefined, proxy, 'write').message, '');
  const partial = { get code() { throw new Error('no code'); }, message: 'Still readable' };
  assert.equal(page.reportPageError('P', 'op', undefined, partial, 'read').message, 'Still readable', 'one unreadable field leaves the others');
  const reads = [];
  const record = (target, prefix) => new Proxy(target, { get(object, key) { reads.push(`${prefix}${String(key)}`); return object[key]; } });
  const thrown = record({
    message: 'Outer', stack: 'Error: Outer\n    at x (y.js:1:1)', outputs: { UserId: 'x' }, value: 1, body: 'b', detail: 'd',
    details: ['d'], correlationId: 'c', status: 500, statusCode: 500,
    error: record({ code: 'E', message: 'm', stack: 's', correlationId: 'c' }, 'error.'),
    toString() { throw new Error('coerced'); },
  }, '');
  page.reportPageError('P', 'op', undefined, thrown, 'read');
  assert.deepEqual([...new Set(reads)].sort(), ['code', 'error', 'error.code', 'error.message', 'errorCode', 'message']);
});

test('the kind decides what is shown and what may retry, and the reporter never calls retry', () => {
  const page = load(FOUNDATION);
  let calls = 0;
  const retry = () => { calls += 1; };
  const view = (kind, code = undefined) => page.reportPageError('P', 'op', code, new Error('Host text'), kind, retry);
  assert.equal(view('read').retry, retry, 'a read may offer a manual reload');
  assert.equal(view('network', 'network').retry, retry, 'a pre-dispatch network failure may offer a manual retry');
  assert.equal(view('write').retry, undefined, 'a write never gains a retry');
  const indeterminate = view('indeterminate', 'network');
  assert.equal(indeterminate.retry, undefined, 'an indeterminate result never retries, whatever its code says');
  assert.equal(indeterminate.code, 'network', 'the host code is kept beside the kind');
  assert.equal(indeterminate.message, '', 'an indeterminate result shows its fixed copy, not host text');
  assert.equal(indeterminate.fallbackKey, 'error.indeterminate');
  const render = view('render');
  assert.equal(render.retry, undefined);
  assert.equal(render.message, '');
  assert.equal(page.logged.at(-1)[1].message, 'Host text', 'suppressed text is still logged, bounded');
  assert.equal(calls, 0, 'the reporter never invokes a retry');
});

test('the page name in the log line loses line breaks and closing brackets', () => {
  const page = load(FOUNDATION);
  page.reportPageError('Acc]ounts\r\nView', 'loadAccounts', undefined, 'x', 'read');
  assert.equal(page.logged[0][0], '[AccountsView] loadAccounts failed');
});

test('telemetry is sent only from the inserted block: one privacy-safe exception per report, never the thrown value', () => {
  const sent = [];
  const appInsights = { trackException: (error, properties) => sent.push([error, properties]) };
  const plain = load(FOUNDATION);
  plain.reportPageError('P', 'loadAccounts', undefined, new Error('Row Contoso failed'), 'read', undefined, appInsights);
  assert.equal(sent.length, 0, 'the canonical reporter alone sends nothing, even when handed a telemetry object');

  const page = load(withTelemetry(FOUNDATION));
  const thrown = Object.assign(new Error('Row Contoso failed'), { code: 'E_FREE_FORM' });
  const withSink = page.reportPageError('P', 'loadAccounts', undefined, thrown, 'read', undefined, appInsights);
  assert.equal(sent.length, 1);
  const [error, properties] = sent[0];
  assert.ok(error instanceof Error && error !== thrown, 'a new Error, not the thrown value');
  assert.equal(error.message, 'loadAccounts failed', 'only the fixed operation name — no host text');
  assert.deepEqual(properties, { outcome: 'failure', category: 'page', source: 'loadAccounts' }, 'a free-form code stays in the local log only');
  assert.deepEqual(withSink, page.reportPageError('P', 'loadAccounts', undefined, thrown, 'read'), 'telemetry changes nothing the page shows');
  for (const [code, expected] of [['not_permitted', 'not_permitted'], ['network', 'network'], ['0x80040217', '0x80040217']]) {
    sent.length = 0;
    page.reportPageError('P', 'saveOrder', code, 'Denied', 'write', undefined, appInsights);
    assert.equal(sent[0][1].statusCode, expected, `a recognized code is the statusCode: ${code}`);
  }
  sent.length = 0;
  page.reportPageError('P', 'render', undefined, new Error('x'), 'render', undefined, appInsights);
  assert.equal(sent[0][1].category, 'errorBoundary');
  assert.doesNotThrow(() => page.reportPageError('P', 'op', undefined, 'x', 'read'), 'no telemetry object');
  assert.doesNotThrow(() => page.reportPageError('P', 'op', undefined, 'x', 'read', undefined, {}), 'a telemetry object without trackException');
});

test('the English error copy holds every fallback key, and translate falls back to the key', () => {
  const page = load(FOUNDATION);
  assert.deepEqual(page.ERROR_COPY, {
    'error.read': 'Unable to load data. Please try again.',
    'error.write': 'The change could not be saved. Refresh before trying again.',
    'error.network': 'The request did not go through. You can try again.',
    'error.indeterminate': "We couldn't confirm this completed \u2014 refresh before retrying.",
    'error.render': 'This page hit a problem and could not render. Refresh the page.',
    'error.tryAgain': 'Try again',
    'error.builtinFailed': 'The operation failed. No result was displayed.',
    'error.builtinUnavailable': 'The selected operation is unavailable in this environment or player. No fallback was attempted.',
    'error.builtinUnexpected': 'The operation returned an unexpected response. No result was displayed.',
    'error.builtinUnsupported': 'This page player cannot call built-in Dataverse operations.',
  });
  assert.equal(page.translate('error.write'), page.ERROR_COPY['error.write']);
  assert.equal(page.translate('error.unknown'), 'error.unknown');
});

test('the error bar renders nothing without an error, escaped text with one, and a retry button only for a retry', () => {
  const page = load(FOUNDATION);
  assert.equal(page.PageErrorBar({ error: null }), null);
  const fallback = page.PageErrorBar({ error: { operation: 'op', message: '', fallbackKey: 'error.read', kind: 'read' } });
  assert.equal(fallback.type, 'MessageBar');
  assert.equal(fallback.props.intent, 'error');
  const body = elements(fallback).find((element) => element.type === 'MessageBarBody');
  assert.equal(body.props.children, page.ERROR_COPY['error.read'], 'an empty message shows the fallback copy');
  assert.equal(elements(fallback).some((element) => element.type === 'Button'), false, 'no retry, no button');
  let calls = 0;
  const retry = () => { calls += 1; };
  const html = '<img src=x onerror=alert(1)>';
  const offered = page.PageErrorBar({ error: { operation: 'op', message: html, fallbackKey: 'error.read', kind: 'read', retry } });
  const tree = elements(offered);
  assert.equal(tree.find((element) => element.type === 'MessageBarBody').props.children, html, 'host text is a text child, which React escapes');
  assert.ok(tree.every((element) => !('dangerouslySetInnerHTML' in element.props)), 'never rendered as HTML');
  const button = tree.find((element) => element.type === 'Button');
  assert.equal(button.props.onClick, retry, 'the retry is handed to the button, not called while rendering');
  assert.equal(button.props.children, page.ERROR_COPY['error.tryAgain']);
  assert.ok(tree.some((element) => element.type === 'MessageBarActions'));
  assert.equal(calls, 0);
});

test('the boundary reports a render crash once as a render failure and shows the fixed fallback, with no reset', () => {
  const page = load(FOUNDATION);
  assert.deepEqual(page.PageErrorBoundary.getDerivedStateFromError(new Error('x')), { failed: true });
  const boundary = new page.PageErrorBoundary({ children: 'page' });
  assert.deepEqual(boundary.state, { failed: false });
  assert.equal(boundary.render(), 'page', 'healthy: the children render');
  boundary.componentDidCatch(new Error('Cannot read properties of undefined'));
  assert.equal(page.logged.length, 1);
  assert.deepEqual(page.logged[0], [`[${page.PAGE_NAME}] render failed`, { code: '', message: 'Cannot read properties of undefined' }]);
  boundary.state = { failed: true };
  const fallback = boundary.render();
  const tree = elements(fallback);
  assert.equal(fallback.type, 'MessageBar');
  assert.equal(tree.find((element) => element.type === 'MessageBarBody').props.children, page.ERROR_COPY['error.render']);
  assert.equal(tree.some((element) => element.type === 'Button'), false, 'no reset or retry re-renders a crashing tree');
  assert.doesNotMatch(FOUNDATION, /\bsetState\s*\(/, 'the boundary never sets its own state back');
});

test('the default export only forwards its props, unchanged, to PageBody inside the boundary', () => {
  const page = load(FOUNDATION);
  const props = { dataApi: { queryTable() {} }, pageInput: { recordId: 'x' } };
  const root = page.default(props);
  assert.equal(root.type, page.PageErrorBoundary);
  const child = root.props.children;
  assert.equal(child.type, page.PageBody);
  assert.deepEqual(Object.keys(child.props), ['dataApi', 'pageInput']);
  assert.equal(child.props.dataApi, props.dataApi, 'the same dataApi object');
});

// ---------- the rule text and the templates a builder copies ----------

const BUILDER = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'genpage-page-builder.md'), 'utf8').replace(/\r\n/g, '\n');
const squashed = (text) => text.replace(/\s+/g, ' ');
const CRITICAL_RULES = RULES.slice(RULES.indexOf('\n## Critical Rules\n'), RULES.indexOf('\n## Supported Libraries\n'));
// The numbered Critical Rule `n`, from its number to the next one.
function criticalRule(n) {
  const match = new RegExp(`\\n${n}\\. ([\\s\\S]*?)(?=\\n\\d+\\. |\\n---)`).exec(CRITICAL_RULES);
  assert.ok(match, `rules.md has Critical Rule ${n}`);
  return squashed(match[1]);
}
// Does a TSX source parse? A transpile with diagnostics on reports syntax only — it is not a type check.
function parses(source, label) {
  typescript ||= loadVendoredTypeScript();
  const { diagnostics } = typescript.transpileModule(source, {
    fileName: 'page.tsx',
    reportDiagnostics: true,
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React },
  });
  assert.deepEqual((diagnostics || []).map((entry) => typescript.flattenDiagnosticMessageText(entry.messageText, '\n')), [], `${label} parses`);
}
const WRAPPER = /const GeneratedComponent = \(props: (\w+)\) => \(\n\s*<PageErrorBoundary>\n\s*<PageBody \{\.\.\.props\} \/>\n\s*<\/PageErrorBoundary>\n\);\n\nexport default GeneratedComponent;/;

test('Critical Rule 22 states the one error contract, and Rule 3 makes the boundary the single class exception', () => {
  assert.equal(criticalRule(22), squashed(`**Consistent errors**: Route failed data operations through the page's single top-level
    \`reportPageError\`, retain bounded code and message diagnostics, and put its returned view in the operation's error state. Render
    errors as escaped Fluent MessageBar text with localized application fallbacks. Offer manual retry only for proven-safe reads or the
    documented pre-dispatch Custom API network result; never retry an indeterminate result automatically. Wrap PageBody in the page's
    one top-level React PageErrorBoundary. Instrument only explicitly authorized failure sites, only through the helper. Expected
    null/empty states are not failures. See “Missing Error Handling” for the canonical patterns and the static check's declared limits.`));
  const rule3 = criticalRule(3);
  assert.match(rule3, /each as separate top-level function \(no nesting\)/, 'Rule 3 still forbids nesting');
  assert.match(rule3, /The one exception is a single top-level React class, `PageErrorBoundary` \(Rule 22\)/);
  assert.match(rule3, /Event handlers and loaders that close over a component's state stay inside that component/);
  assert.match(rule3, /No new library or runtime dependency/);
  // The section the rule points at states what the eval check reads and what it does not: today, nothing.
  assert.match(squashed(MISSING_ERROR_HANDLING), /What the eval check reads, and what it does not\./);
  assert.match(squashed(MISSING_ERROR_HANDLING), /The eval suite does not grade a page's error handling yet/);
});

test('rules.md Component Structure and both builder templates mount PageBody inside the boundary', () => {
  const structure = RULES.slice(RULES.indexOf('\n## Component Structure\n'), RULES.indexOf('\n## Layout and Styling\n'));
  const block = /```typescript\n([\s\S]*?)\n```/.exec(structure)[1];
  assert.match(block, /function PageBody\(props: GeneratedComponentProps\) \{\n\s*const \{ dataApi, pageInput \} = props;/);
  assert.match(block, WRAPPER);
  assert.match(block, /The page error block of "Missing Error Handling" \(Common Errors\), copied unchanged/);
  assert.doesNotMatch(block, /const GeneratedComponent = \(props: GeneratedComponentProps\) => \{/, 'the old component body is gone');
  parses(block, 'rules.md Component Structure');
  const templates = BUILDER.slice(BUILDER.indexOf('\n### Component Structure\n'), BUILDER.indexOf('\n### Mandatory Rules\n'));
  const [dataverse, mock] = [...templates.matchAll(/```typescript\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.ok(dataverse && mock, 'the builder shows the Dataverse and the mock template');
  assert.equal(WRAPPER.exec(dataverse)?.[1], 'GeneratedComponentProps');
  assert.equal(WRAPPER.exec(mock)?.[1], 'Props', 'the mock page keeps its local Props');
  assert.match(dataverse, /function PageBody\(props: GeneratedComponentProps\) \{\n\s*const \{ dataApi, pageInput \} = props;/);
  assert.match(mock, /function PageBody\(props: Props\) \{\n\s*const \{ pageInput \} = props;/);
  assert.doesNotMatch(mock, /RuntimeTypes/, 'a mock page imports nothing from ./RuntimeTypes');
  for (const [label, source] of [['the Dataverse template', dataverse], ['the mock template', mock]]) {
    assert.match(source, /The page error block of rules\.md "Missing Error Handling"[\s\S]*copied unchanged/, `${label} copies the canonical block`);
    parses(source, label);
  }
  assert.match(squashed(templates), /copy the page error block of `rules\.md` → \*Common Errors\* → \*Missing Error Handling\* \*\*unchanged\*\*/);
});

test('the builder routes every failure through the five-argument reporter, with the boundary as its one class', () => {
  const rules = squashed(BUILDER.slice(BUILDER.indexOf('\n### Mandatory Rules\n'), BUILDER.indexOf('\n### Localization\n')));
  assert.doesNotMatch(rules, /all async `dataApi` calls wrapped in try-catch/, 'the old try/catch-only instruction is gone');
  assert.match(rules, /\*\*Error handling\*\* — every failed data operation goes through the page's one `reportPageError` with its five required arguments — `reportPageError\(PAGE_NAME, '<operation>', code, error, '<kind>'\)`/);
  assert.match(rules, /rendered by `PageErrorBar`/);
  assert.match(rules, /never retry a write or an indeterminate result/);
  assert.match(rules, /\*\*Top-level functions\*\* — components and utilities as separate top-level functions, no nesting; the page's one class is `PageErrorBoundary`/);
  // The connector and Custom API fragments the builder shows report their failures, never set a bare string.
  const examples = BUILDER.slice(BUILDER.indexOf('\n### Connector-backed data\n'), BUILDER.indexOf('\n## Step 6'));
  assert.doesNotMatch(examples, /\bsetError\(|if \(!response\.ok\) \{ return; \}|isSubmitting/);
  assert.match(examples, /if \(!response\.ok\) \{ setWeather\(\{ weather: null, error: reportPageError\(PAGE_NAME, 'loadWeather', undefined, undefined, 'read', retryWeather\) \}\); return; \}/);
  const order = ['if (res.indeterminate)', "if (res.error?.code === 'indeterminate')", "if (!res.ok && res.error?.code === 'network')", 'if (!res.ok)', 'const status = res.outputs?.NewStatus;'];
  const at = order.map((guard) => examples.indexOf(guard));
  assert.ok(at.every((index, i) => index > 0 && (i === 0 || index > at[i - 1])), `the Custom API guards come in order before the outputs: ${at}`);
  for (const report of ["'indeterminate')); return; }", "'network', retryApprove)); return; }", "res.error?.message, 'write')); return; }", "undefined, error, 'write'));"]) {
    assert.ok(examples.includes(report), `the Custom API fragment reports: ${report}`);
  }
});