'use strict';
// The body of an OData `$batch` request, rendered the way the vendored SDK renders a change set (its `renderChangeSet`, which the bundle does not export), so a
// test can put the SDK's own shape through a client without making the SDK write it. app-header-text-transport.test.js pins this renderer against the bytes the SDK
// itself puts on the wire for the same operations (`createColumns`), so it cannot drift from the bundle unseen.
//
// One change set inside one batch, every operation a part of its own (CRLF between lines):
//   --batch_<id>
//   Content-Type: multipart/mixed;boundary=changeset_<id>
//
//   --changeset_<id>
//   Content-Type: application/http
//   Content-Transfer-Encoding: binary
//   Content-ID: 1
//
//   PATCH https://contoso.crm.dynamics.com/api/data/v9.0/appmodules(11111111-2222-3333-4444-555555555555) HTTP/1.1
//   Content-Type: application/json;type=entry
//   If-Match: W/"1"
//
//   {"name":"Help Desk","description":"Track tickets"}
//   --changeset_<id>--
//   --batch_<id>--
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api
const API = 'https://contoso.crm.dynamics.com/api/data/v9.0';
const APP = '11111111-2222-3333-4444-555555555555';

// `operations`: `{ method, path | url, body?, rawBody?, contentType?, etag?, headers? }` — `path` is under the API root (`/appmodules(<id>)`), as the SDK is given it; `body` is an
// object the SDK serializes with JSON.stringify (`application/json;type=entry`); `rawBody` is text that is sent as it is, under `contentType`. Answers `{ body, boundary }`: the
// text to send and the boundary of the batch, which is what `postBatch(body, boundary)` takes.
function renderChangeSet(operations, { batch = 'batch_test', changeset = 'changeset_test', solution } = {}) {
  const parts = operations.map((op, index) => {
    const content = op.rawBody !== undefined ? op.rawBody : op.body === undefined ? undefined : JSON.stringify(op.body);
    return [
      `--${changeset}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${index + 1}`, '',
      `${op.method} ${op.url || `${API}${op.path}`} HTTP/1.1`,
      ...(content === undefined ? [] : [`Content-Type: ${op.rawBody !== undefined ? op.contentType : 'application/json;type=entry'}`]),
      ...(solution ? [`MSCRM.SolutionUniqueName: ${solution}`] : []),
      ...(op.etag ? [`If-Match: ${op.etag}`] : []),
      ...Object.entries(op.headers || {}).map(([name, value]) => `${name}: ${value}`),
      '', ...(content === undefined ? [] : [content]),
    ].join('\r\n');
  });
  const body = [`--${batch}`, `Content-Type: multipart/mixed;boundary=${changeset}`, '', ...parts, `--${changeset}--`, `--${batch}--`, ''].join('\r\n');
  return { body, boundary: batch };
}

// The same operations in a batch the way the platform's documentation writes one: a quoted boundary, relative addresses, single requests beside a change set, a blank line
// before each delimiter. `layout` names which operation goes where: `changeSets` is a list of lists of operations, `singles` a list of operations sent outside any change set.
function renderDocumentedBatch({ changeSets = [], singles = [] }, { batch = 'batch_doc', eol = '\r\n' } = {}) {
  const request = (op) => [
    'Content-Type: application/http', 'Content-Transfer-Encoding: binary', ...(op.contentId ? [`Content-ID: ${op.contentId}`] : []), '',
    `${op.method} ${op.target} HTTP/1.1`,
    ...(op.body === undefined ? [] : ['Content-Type: application/json; type=entry']), ...Object.entries(op.headers || {}).map(([name, value]) => `${name}: ${value}`), '',
    ...(op.body === undefined ? [] : [typeof op.body === 'string' ? op.body : JSON.stringify(op.body)]),
  ];
  const lines = [];
  changeSets.forEach((operations, set) => {
    const changeset = `changeset_doc${set}`;
    lines.push(`--${batch}`, `Content-Type: multipart/mixed; boundary="${changeset}"`, '');
    for (const op of operations) lines.push(`--${changeset}`, ...request(op));
    lines.push(`--${changeset}--`, '');
  });
  for (const op of singles) lines.push(`--${batch}`, ...request(op), '');
  lines.push(`--${batch}--`, '');
  return { body: lines.join(eol), boundary: batch, contentType: `multipart/mixed; boundary="${batch}"` };
}

module.exports = { API, APP, renderChangeSet, renderDocumentedBatch };
