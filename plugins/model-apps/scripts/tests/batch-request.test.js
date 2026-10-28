'use strict';
// lib/batch-request.js: a multipart `$batch` REQUEST read the way the service reads it — the delimiters its Content-Type declares, a change set one level down, one
// HTTP request in each part — or refused with the reason it cannot be read. The reader exists so that the guard of lib/app-header-text.js can see which rows a raw change
// set writes before it leaves the process; these tests pin what it accepts (the SDK's own rendering, the platform's documented layout and the spellings of it that are
// still the same batch) and what it refuses (anything the guard could not be sure it reads as the service does).
const test = require('node:test');
const assert = require('node:assert');
const { readBatchRequest } = require('../lib/batch-request.js');
const { API, APP, renderChangeSet, renderDocumentedBatch } = require('./helpers/batch-bodies.js');

const ROW = `${API}/appmodules(${APP})`;
const MIXED = (boundary) => `multipart/mixed;boundary=${boundary}`;
const operations = (text, contentType) => {
  const read = readBatchRequest(text, contentType);
  assert.strictEqual(read.problem, undefined, `read as a batch, got: ${read.problem}`);
  return read.operations;
};
const problem = (text, contentType) => {
  const read = readBatchRequest(text, contentType);
  assert.strictEqual(read.operations, undefined, 'no operations are handed over for a batch that cannot be read');
  assert.strictEqual(typeof read.problem, 'string');
  assert.ok(read.problem.length > 0);
  return read.problem;
};

// --- what is read ----------------------------------------------------------------------------------------------------------------------------------------

test('the SDK\'s own rendering of a change set is read operation by operation: the method, the address as written, the Content-ID and the body as text', () => {
  const { body, boundary } = renderChangeSet([
    { method: 'PATCH', path: `/appmodules(${APP})`, body: { name: 'Help Desk', description: 'Track tickets' }, etag: 'W/"1"' },
    { method: 'POST', path: '/EntityDefinitions(LogicalName=\'new_ticket\')/Attributes', body: { SchemaName: 'new_a' }, headers: { 'X-Probe': 'yes' } },
    { method: 'DELETE', path: `/sitemaps(${APP})`, etag: 'W/"2"' },
    { method: 'PATCH', path: `/workflows(${APP})`, rawBody: '<xaml>\r\n\r\n  line two\r\n</xaml>', contentType: 'text/plain', etag: '*' },
  ], { solution: 'Probe' });
  assert.deepStrictEqual(operations(body, MIXED(boundary)), [
    { method: 'PATCH', target: ROW, contentId: '1', body: '{"name":"Help Desk","description":"Track tickets"}' },
    { method: 'POST', target: `${API}/EntityDefinitions(LogicalName='new_ticket')/Attributes`, contentId: '2', body: '{"SchemaName":"new_a"}' },
    { method: 'DELETE', target: `${API}/sitemaps(${APP})`, contentId: '3', body: '' },
    { method: 'PATCH', target: `${API}/workflows(${APP})`, contentId: '4', body: '<xaml>\n\n  line two\n</xaml>' },
  ]);
});

test('the platform\'s documented layout is read: a quoted boundary, relative addresses, several change sets, requests outside any change set, a blank line before each delimiter', () => {
  const { body, contentType } = renderDocumentedBatch({
    changeSets: [
      [{ method: 'POST', target: '/api/data/v9.2/tasks', contentId: '1', body: { subject: 'one' } }, { method: 'PATCH', target: `appmodules(${APP})`, contentId: '2', body: '{\n  "name": "Help Desk"\n}' }],
      [{ method: 'DELETE', target: `${ROW}`, contentId: '3', headers: { 'If-Match': 'W/"7"' } }],
    ],
    singles: [{ method: 'GET', target: `/api/data/v9.2/accounts(${APP})/Account_Tasks?$select=subject` }],
  });
  const read = operations(body, contentType);
  assert.deepStrictEqual(read.map((op) => [op.method, op.target, op.contentId]), [
    ['POST', '/api/data/v9.2/tasks', '1'],
    ['PATCH', `appmodules(${APP})`, '2'],
    ['DELETE', ROW, '3'],
    ['GET', `/api/data/v9.2/accounts(${APP})/Account_Tasks?$select=subject`, undefined],
  ]);
  assert.deepStrictEqual(JSON.parse(read[1].body), { name: 'Help Desk' });
  assert.strictEqual(read[3].body, '');
});

test('the same batch with bare line feeds (the platform has been seen to take them) is read the same', () => {
  const crlf = renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: ROW, contentId: '1', body: { name: 'x' } }]] });
  const lf = renderDocumentedBatch({ changeSets: [[{ method: 'PATCH', target: ROW, contentId: '1', body: { name: 'x' } }]] }, { eol: '\n' });
  assert.notStrictEqual(lf.body, crlf.body);
  assert.deepStrictEqual(operations(lf.body, lf.contentType), operations(crlf.body, crlf.contentType));
});

test('the boundary is the one the Content-Type declares — quoted or not, with or without a space after the semicolon, whatever the case of the names around it', () => {
  const { body } = renderChangeSet([{ method: 'PATCH', path: `/appmodules(${APP})`, body: { name: 'x' } }], { batch: 'batch_a.b+c' });
  for (const contentType of ['multipart/mixed;boundary=batch_a.b+c', 'multipart/mixed; boundary=batch_a.b+c', 'multipart/mixed; boundary="batch_a.b+c"', 'Multipart/Mixed ; Boundary = "batch_a.b+c"; charset=utf-8', 'multipart/mixed;boundary=batch_a.b+c;']) {
    assert.strictEqual(operations(body, contentType).length, 1, contentType);
  }
});

test('with no Content-Type at all the batch opens with its own delimiter line, as the SDK\'s reader of an answer finds it; a preamble and an epilogue are not parts', () => {
  const { body } = renderChangeSet([{ method: 'PATCH', path: `/appmodules(${APP})`, body: { name: 'x' } }]);
  assert.strictEqual(operations(body, undefined).length, 1);
  assert.strictEqual(operations(`\r\nthis text is ignored\r\n${body}\r\nand so is this`, MIXED('batch_test')).length, 1);
  assert.strictEqual(operations(`\r\n\r\n${body}`, undefined).length, 1, 'blank lines before the first delimiter');
});

test('what a body holds is only ever its text: lines that look like delimiters of another boundary, request lines or headers are data, and so are a body\'s own blank lines', () => {
  const content = ['--changeset_other', 'PATCH https://contoso.crm.dynamics.com/api/data/v9.0/appmodules(1) HTTP/1.1', 'Content-Type: application/http', '', '--batch_testx', '--batch_test_', '--'].join('\r\n');
  const { body } = renderChangeSet([
    { method: 'PATCH', path: `/uxagentprojectfiles(${APP})/filecontent`, rawBody: content, contentType: 'text/plain', etag: '*' },
    { method: 'DELETE', path: `/sitemaps(${APP})` },
  ]);
  const read = operations(body, MIXED('batch_test'));
  assert.deepStrictEqual(read.map((op) => op.method), ['PATCH', 'DELETE']);
  assert.strictEqual(read[0].body, content.replace(/\r\n/g, '\n'));
});

// --- what is refused, and why ------------------------------------------------------------------------------------------------------------------------------

test('a body whose delimiters are not the declared ones is not a batch: the service runs only the parts of the boundary its Content-Type names', () => {
  const { body } = renderChangeSet([{ method: 'PATCH', path: `/appmodules(${APP})`, body: { name: 'x' } }]);
  assert.match(problem(body, MIXED('batch_elsewhere')), /batch_elsewhere/);
  assert.match(problem(body, 'application/json'), /boundary/);
  assert.match(problem(body, 'multipart/mixed'), /boundary/);
  assert.match(problem(body, 'multipart/mixed; boundary=""'), /boundary/);
  assert.match(problem('{"requests":[]}', undefined), /boundary|delimiter/);
  assert.match(problem('', undefined), /boundary|delimiter/);
});

test('a batch is whole: its closing delimiter is there, nothing follows it, and it holds a part', () => {
  const { body } = renderChangeSet([{ method: 'PATCH', path: `/appmodules(${APP})`, body: { name: 'x' } }]);
  assert.match(problem(body.replace(/--batch_test--\r\n$/, ''), MIXED('batch_test')), /closing delimiter --batch_test-- is missing/);
  assert.match(problem(body.replace(/--changeset_test--\r\n/, ''), MIXED('batch_test')), /changeset_test/);
  assert.match(problem(`${body}--batch_test\r\nContent-Type: application/http\r\n\r\nDELETE /x HTTP/1.1\r\n\r\n--batch_test--\r\n`, MIXED('batch_test')), /follows the closing delimiter/);
  assert.match(problem('--batch_test\r\n--batch_test--\r\n', MIXED('batch_test')), /a part is empty/);
  assert.match(problem('--batch_test--\r\n', MIXED('batch_test')), /no delimiter line --batch_test\b/);
});

test('a part is read only when it is what the service reads: headers, an empty line, a content type it knows, a binary body, one request line', () => {
  const part = (...lines) => ['--b', ...lines, '--b--', ''].join('\r\n');
  const request = ['PATCH /api/data/v9.0/appmodules(1) HTTP/1.1', 'Content-Type: application/json', '', '{}'];
  assert.strictEqual(operations(part('Content-Type: application/http', 'Content-Transfer-Encoding: binary', '', ...request), MIXED('b')).length, 1);
  assert.strictEqual(operations(part('Content-Type: application/http', '', ...request), MIXED('b')).length, 1, 'binary is the default encoding');
  assert.match(problem(part('Content-Type: application/http'), MIXED('b')), /no empty line/);
  assert.match(problem(part('', ...request), MIXED('b')), /content type/);
  assert.match(problem(part('Content-Type: text/plain', '', ...request), MIXED('b')), /text\/plain/);
  assert.match(problem(part('Content-Type: application/http', 'Content-Type: application/http', '', ...request), MIXED('b')), /repeats its Content-Type/);
  assert.match(problem(part('Content-Type: application/http', 'this is not a header', '', ...request), MIXED('b')), /not a header/);
  assert.match(problem(part('Content-Type: application/http', '   ', '', ...request), MIXED('b')), /not a header/);
  assert.match(problem(part('Content-Type: application/http', 'Content-Transfer-Encoding: base64', '', ...request), MIXED('b')), /base64/);
  assert.match(problem(part('Content-Type: application/http', '', '', ...request), MIXED('b')), /request line/);
  assert.match(problem(part('Content-Type: application/http', '', 'PATCH /api/data/v9.0/appmodules(1)', '', '{}'), MIXED('b')), /request line/);
  assert.match(problem(part('Content-Type: application/http', '', 'PATCH /api/data/v9.0/appmodules(1) HTTP/1.1', 'a header with no colon', '', '{}'), MIXED('b')), /not a header/);
});

test('a change set is one level down and made of requests: it declares its own boundary, and holds no change set of its own', () => {
  const inner = (...lines) => ['--b', 'Content-Type: multipart/mixed; boundary=c', '', ...lines, '--b--', ''].join('\r\n');
  const request = ['--c', 'Content-Type: application/http', '', 'DELETE /api/data/v9.0/appmodules(1) HTTP/1.1', '', '--c--'];
  assert.strictEqual(operations(inner(...request), MIXED('b')).length, 1);
  assert.match(problem(['--b', 'Content-Type: multipart/mixed', '', ...request, '--b--', ''].join('\r\n'), MIXED('b')), /change set declares no boundary/);
  assert.match(problem(inner('--c', 'Content-Type: multipart/mixed; boundary=d', '', '--d', 'Content-Type: application/http', '', 'DELETE /x HTTP/1.1', '', '--d--', '--c--'), MIXED('b')), /not a request/);
  assert.match(problem(inner('--c', 'Content-Type: application/http', '', 'DELETE /x HTTP/1.1', ''), MIXED('b')), /--c-- is missing/);
});
