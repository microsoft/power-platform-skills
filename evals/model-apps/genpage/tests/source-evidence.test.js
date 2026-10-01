'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { literalString, objectFields, actionCalls, receiverIsDataApi } = require('../lib/source-evidence.js');

test('request string literals never evaluate concatenated or dynamic source', () => {
  assert.equal(literalString("'Approved'"), 'Approved');
  assert.equal(literalString('"Say \\"hi\\""'), 'Say "hi"');
  assert.equal(literalString("'a'+'b'"), null);
  assert.equal(literalString('getName()'), null);
  assert.equal(literalString('`dynamic ${value}`'), null);
});

test('request fields preserve nested objects and inert punctuation but refuse opaque overrides', () => {
  const fields = objectFields('{ name: "a{,}", /* inert */ parameters: { Comment: "x,y", Amount: 1 }, boundTo: { id: recordId } }');
  assert.equal(literalString(fields.get('name')), 'a{,}');
  assert.deepEqual([...objectFields(fields.get('parameters')).keys()], ['Comment', 'Amount']);
  for (const text of ['{ ...base, name:"x" }', '{ [key]: "x" }', '{ name:"a", name:"b" }', '{ name: ']) {
    assert.throws(() => objectFields(text), /dynamic|computed|duplicate|truncated|unbalanced/);
  }
});

test('API call extraction uses real optional calls and their own awaited helper result', () => {
  const code = `const help = 'api.executeAction({name:"inert"})';
// api.executeAction({name:"comment"});
async function summary(api: ActionApi) {
  const res = await api.executeFunction?.({ name: "cnt_Summary", parameters: { OrderId: recordId } });
  return res.outputs;
}
`;
  const calls = actionCalls(code);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'executeFunction');
  assert.equal(calls[0].resultName, 'res');
  assert.equal(calls[0].scope.name, 'summary');
  assert.equal(literalString(calls[0].fields.get('name')), 'cnt_Summary');
  assert.throws(() => actionCalls('api.executeAction({name:"unscoped"});'), /scope/);
  assert.equal(calls[0].receiver, 'api', 'the receiver is captured, optional chaining included');
});

// Whether the receiver of the (single) Custom API call in `code` resolves to the page's dataApi prop.
function receiverOk(code) {
  const calls = actionCalls(code);
  assert.equal(calls.length, 1, code);
  const [call] = calls;
  return receiverIsDataApi(call.mask, call.scopes, call.receiver, call.start);
}

const helper = (receiver, params = '', name = 'run') => `async function ${name}(${params}) {
  const res = await ${receiver}.executeAction({ name: 'cnt_Approve' });
  return res;
}
`;
// A page component (the default export) whose body is `body`.
const page = (param, body) => `const GeneratedComponent = (${param}) => {
  ${body}
  return null;
};
export default GeneratedComponent;
`;

test('a Custom API receiver resolves only to the page dataApi prop', () => {
  // Accepted: the prop itself, a destructured or renamed prop, a cast alias, and a helper parameter
  // that every outside call fills with one of those.
  assert.equal(receiverOk(page('props', `async function approve() {
    const res = await props.dataApi.executeAction({ name: 'cnt_Approve' });
  }`)), true, 'props.dataApi inside the component');
  assert.equal(receiverOk(helper('props.dataApi', 'props') + page('props', 'void run(props);')), true, 'props.dataApi on a helper parameter filled with the props');
  assert.equal(receiverOk(page('props', `const { dataApi } = props;
  async function approve() {
    const actionApi = dataApi as unknown as { executeAction?: (request: unknown) => Promise<unknown> };
    const res = await actionApi.executeAction({ name: 'cnt_Approve' });
  }`)), true, 'a cast alias of the destructured prop');
  assert.equal(receiverOk(helper('client', 'map: Map<string, number>, client: ActionApi, done: (value: boolean) => void')
    + page('props', 'const { dataApi: api } = props; void run(new Map<string, number>(), api, () => {});')), true, 'a renamed prop passed after a generic argument');
  assert.equal(receiverOk(helper('client', 'client') + page('{ dataApi }: Props', 'void run(dataApi);')), true, 'a destructured component parameter');

  // Refused: anything that is not provably the prop.
  assert.equal(receiverOk(helper('other') + 'const other = makeClient();'), false, 'an unrelated object');
  assert.equal(receiverOk(helper('client', 'client') + page('props', 'const other = makeClient(); void run(other);')), false, 'a helper filled with an unrelated object');
  assert.equal(receiverOk(helper('client', 'client') + page('props', 'const { dataApi } = props; void run(dataApi); void run(makeClient());')), false, 'one outside call with another object');
  assert.equal(receiverOk(helper('client', 'client')), false, 'a helper parameter no call fills');
  assert.equal(receiverOk(helper('dataApi') + 'const dataApi = makeClient();'), false, 'a local shadowing the prop name');
  assert.equal(receiverOk(helper('client', 'client') + page('props', 'const actionApi = props as unknown as ActionApi; void run(actionApi);')), false, 'the props object itself is not its dataApi');
  assert.equal(receiverOk(helper('props.dataApi', 'props') + page('props', 'void run({ dataApi: mockApi });')), false, 'a helper parameter named props filled with another object');
  assert.equal(receiverOk(helper('props.dataApi', 'props')), false, 'a helper parameter named props that no call fills');
  // An expression receiver is not gradeable at all: extraction refuses it, which the scorer reports
  // as a failure, before any receiver resolution.
  assert.throws(() => actionCalls(`async function run(props) {
  const res = await (props.dataApi as Api).executeAction({ name: 'cnt_Approve' });
}`), /no associated awaited result/, 'an expression receiver is not gradeable');
});

test('same-named aliases in different helpers resolve in their own scope', () => {
  const code = `async function approve(api: ActionApi) {
  const actionApi = api as unknown as ActionApi;
  const res = await actionApi.executeAction({ name: 'cnt_Approve' });
}
async function summary(client: ActionApi) {
  const actionApi = client as unknown as ActionApi;
  const res = await actionApi.executeFunction({ name: 'cnt_Summary' });
}
` + page('props', 'const { dataApi } = props; void approve(dataApi); void summary(dataApi);');
  const calls = actionCalls(code);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(receiverIsDataApi(call.mask, call.scopes, call.receiver, call.start), true, call.scope.name);
  const mixed = code.replace('void summary(dataApi);', 'void summary(makeClient());');
  const [approve, summary] = actionCalls(mixed);
  assert.equal(receiverIsDataApi(approve.mask, approve.scopes, approve.receiver, approve.start), true, 'approve keeps its own provenance');
  assert.equal(receiverIsDataApi(summary.mask, summary.scopes, summary.receiver, summary.start), false, 'summary is filled with another object');
});

test('a receiver binding needs lexical scope and an identity-preserving initializer', () => {
  // A named component's destructured props are not visible from a helper declared outside it.
  const outside = `async function run(dataApi: ActionApi) {
  const res = await dataApi.executeAction({ name: 'cnt_Approve' });
}
function GeneratedComponent({ dataApi }: Props) {
  void run(mockApi);
  return null;
}
export default GeneratedComponent;
`;
  assert.equal(receiverOk(outside), false, 'a helper filled with another object, beside a destructuring component');
  assert.equal(receiverOk(outside.replace('void run(mockApi);', 'void run(dataApi);')), true, 'the same helper filled with the prop');

  // The whole initializer must pass the value on; a prefix that names the prop is not enough.
  for (const init of ['dataApi && mockApi', 'dataApi || mockApi', 'dataApi ?? mockApi', 'ready ? dataApi : mockApi', 'wrap(dataApi)', 'dataApi\n    || mockApi', 'dataApi as Api || mockApi']) {
    assert.equal(receiverOk(helper('client', 'client') + page('props', `const { dataApi } = props;
  const actionApi = ${init};
  void run(actionApi);`)), false, init);
  }
  for (const init of ['dataApi', 'dataApi!', 'dataApi as Api', 'dataApi as unknown as { executeAction?: (request: unknown) => Promise<unknown> }', 'dataApi satisfies Api', 'dataApi as Map<string, () => void>']) {
    assert.equal(receiverOk(helper('client', 'client') + page('props', `const { dataApi } = props;
  const actionApi = ${init};
  void run(actionApi);`)), true, init);
  }

  // A function type inside a generic parameter type does not shift later parameters. The call passes
  // a plain name, so a mis-split parameter list cannot be cancelled out by a mis-split call.
  assert.equal(receiverOk(helper('api', 'handlers: Map<string, () => void>, api: ActionApi')
    + page('props', 'const { dataApi } = props; const handlers = new Map(); void run(handlers, dataApi);')), true, 'callback-valued generic before the receiver');
});

test('a receiver is refused when its value is not passed on unchanged', () => {
  // A helper argument is checked whole, like an initializer: the cast does not hide `&& mockApi`.
  assert.equal(receiverOk(helper('client', 'client') + page('props', 'const { dataApi } = props; void run(dataApi as ActionApi && mockApi);')), false, 'a cast argument with a trailing operator');
  assert.equal(receiverOk(helper('client', 'client') + page('props', 'const { dataApi } = props; void run(dataApi as ActionApi);')), true, 'a plain cast argument');
  // A line break straight after `=` (or after `as`) does not end the declaration.
  assert.equal(receiverOk(helper('client', 'client') + page('props', `const { dataApi } = props;
  const actionApi =
    dataApi as unknown as ActionApi;
  void run(actionApi);`)), true, 'an initializer on the next line');
  assert.equal(receiverOk(helper('client', 'client') + page('props', `const {
    dataApi,
  } =
    props;
  void run(dataApi);`)), true, 'a multi-line destructuring');
  assert.equal(receiverOk(helper('client', 'client') + page('props', `const { dataApi } = props;
  const actionApi = dataApi as
    ActionApi;
  void run(actionApi);`)), true, 'a cast continued on the next line');
  // A name or parameter assigned again no longer proves what it holds.
  assert.equal(receiverOk(helper('client', 'client') + page('props', 'const { dataApi } = props; let actionApi = dataApi; actionApi = mockApi; void run(actionApi);')), false, 'a reassigned alias');
  assert.equal(receiverOk(helper('client', 'client') + page('props', 'const { dataApi } = props; let actionApi = dataApi; actionApi ??= mockApi; void run(actionApi);')), false, 'a compound-assigned alias');
  assert.equal(receiverOk(`async function run(client) {
  client = mockApi;
  const res = await client.executeAction({ name: 'cnt_Approve' });
}
` + page('props', 'const { dataApi } = props; void run(dataApi);')), false, 'a helper parameter overwritten before the call');
  // A rest pattern copies the other properties; it is not the dataApi property.
  assert.equal(receiverOk(helper('client', 'client') + page('props', 'const { ...dataApi } = props; void run(dataApi as unknown as ActionApi);')), false, 'a rest pattern named dataApi');
  assert.equal(receiverOk(helper('client', 'client') + page('{ ...dataApi }: Props', 'void run(dataApi as unknown as ActionApi);')), false, 'a rest component parameter named dataApi');
});

test('arrow parameters, destructuring assignments and continued lines cannot launder a receiver', () => {
  // An arrow function's parameter shadows the outer prop, and its callers cannot be traced.
  assert.equal(receiverOk(helper('client', 'client') + page('props', `const { dataApi } = props;
  const invoke = (dataApi: ActionApi) => run(dataApi);
  invoke(mockApi);`)), false, 'an arrow parameter shadowing the prop');
  assert.equal(receiverOk(helper('client', 'client') + page('props', `const { dataApi } = props;
  const invoke = dataApi => run(dataApi);
  invoke(mockApi);`)), false, 'a bare arrow parameter shadowing the prop');
  // An arrow without that parameter still sees the prop.
  assert.equal(receiverOk(helper('client', 'client') + page('props', `const { dataApi } = props;
  const invoke = () => run(dataApi);
  invoke();`)), true, 'an arrow closing over the prop');
  // A destructuring assignment or a for-of target overwrites the name.
  for (const write of ['[client] = [mockApi];', '({ client } = { client: mockApi });', 'for (client of [mockApi]) break;']) {
    assert.equal(receiverOk(`async function run(client) {
  ${write}
  const res = await client.executeAction({ name: 'cnt_Approve' });
}
` + page('props', 'const { dataApi } = props; void run(dataApi);')), false, write);
  }
  // A line that starts with `[`, `(` or a template continues the previous one.
  for (const next of ["['executeAction']", '(mockApi)', '`tag`']) {
    assert.equal(receiverOk(helper('client', 'client') + page('props', `const { dataApi } = props;
  const actionApi = dataApi
    ${next};
  void run(actionApi as unknown as ActionApi);`)), false, next);
  }
});

test('any rebinding of a provenance name refuses, whatever the binding form', () => {
  const refused = {
    'an array-destructured arrow parameter': 'const invoke = ([dataApi]: [ActionApi]) => run(dataApi);\n  invoke([mockApi]);',
    'an object-rest arrow parameter': 'const invoke = ({ ...dataApi }: Props) => run(dataApi as unknown as ActionApi);\n  invoke(mockProps);',
    'an anonymous function parameter': 'const invoke = function (dataApi: ActionApi) { return run(dataApi); };\n  invoke(mockApi);',
    'an arrow with an object return type': 'const invoke = (dataApi: ActionApi): { result: unknown } => ({ result: run(dataApi) });\n  invoke(mockApi);',
    'an arrow with a generic return type': 'const invoke = (dataApi: ActionApi): Promise<void> => run(dataApi);\n  invoke(mockApi);',
    'a declared loop variable': 'for (const dataApi of [mockApi]) run(dataApi);',
    'a catch binding': 'try { throw mockApi; } catch (dataApi) { run(dataApi); }',
  };
  for (const [label, body] of Object.entries(refused)) {
    assert.equal(receiverOk(helper('client', 'client') + page('props', `const { dataApi } = props;\n  ${body}`)), false, label);
  }
  // An unrelated arrow without a semicolon before the documented alias does not hide that alias.
  assert.equal(receiverOk(helper('client', 'client') + page('props', `const { dataApi } = props;
  const normalize = (x: string) => x.trim()
  const actionApi = dataApi as unknown as ActionApi;
  void run(actionApi);`)), true, 'an expression arrow ended by a line break');
});

test('a named helper\u2019s destructured parameter binds its own names', () => {
  // The helper sits inside the component, under the component's own trusted `dataApi`.
  const nested = (params, calls, receiver = 'dataApi') => page('props', `const { dataApi } = props;
  async function invoke(${params}) {
    const res = await ${receiver}.executeAction({ name: 'cnt_Approve' });
    return res;
  }
  ${calls}`);
  const refused = {
    'an object literal is passed': nested('{ dataApi }: Props', 'void invoke({ dataApi: mockApi });'),
    'not every call passes the props': nested('{ dataApi }: Props', 'void invoke(props);\n  void invoke({ dataApi: mockApi });'),
    'a renamed property, from an object literal': nested('{ dataApi: api }: Props', 'void invoke({ dataApi: mockApi });', 'api'),
    'another property, renamed': nested('{ other: api }: Props', 'void invoke(props);', 'api'),
    'a nested pattern': nested('{ deps: { dataApi } }: Bag', 'void invoke({ deps: props });'),
    'an array pattern': nested('[dataApi]: [ActionApi]', 'void invoke([props.dataApi]);'),
    'a rest parameter': nested('...dataApi: ActionApi[]', 'void invoke(props.dataApi);'),
  };
  for (const [label, code] of Object.entries(refused)) assert.equal(receiverOk(code), false, label);
  // Accepted: every call passes the props object, so the property is the props' own dataApi.
  assert.equal(receiverOk(nested('{ dataApi }: Props', 'void invoke(props);')), true, 'destructured');
  assert.equal(receiverOk(nested('{ dataApi: api }: Props', 'void invoke(props);', 'api')), true, 'destructured and renamed');
  // A recursive call is pass-through only for a PLAIN parameter: passing a destructured parameter's local on
  // hands the next call the property, not the props it came from, so that call must pass the props too.
  const recursive = (again) => page('props', `async function readAll({ dataApi }: Props, page: number) {
    const res = await dataApi.executeAction({ name: 'cnt_Approve' });
    if (page < 3) await readAll(${again}, page + 1);
    return res;
  }
  void readAll(props, 1);`);
  assert.equal(receiverOk(recursive('dataApi')), false, 'recursion passing the extracted property');
  assert.equal(receiverOk(recursive('props')), true, 'recursion passing the props again');
  // The same rule for a helper outside the component.
  assert.equal(receiverOk(helper('dataApi', '{ dataApi }: Props') + page('props', 'void run(props);')), true, 'an outer helper');
  assert.equal(receiverOk(helper('dataApi', '{ dataApi }: Props') + page('props', 'void run({ dataApi: mockApi });')), false, 'an outer helper, given a mock');
});