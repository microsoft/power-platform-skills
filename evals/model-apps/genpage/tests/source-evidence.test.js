'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { literalString, objectFields, actionCalls } = require('../lib/source-evidence.js');

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
});
