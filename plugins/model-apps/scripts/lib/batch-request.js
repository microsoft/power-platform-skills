'use strict';
// A multipart `$batch` REQUEST, read the way the service reads it: the operations it holds, in order, so that a guard can say what a raw change set would write before it is sent.
//
// The SDK sends every atomic write (a table's columns, the app and its sitemap, a page's rows) as one OData batch holding one change set, and `dataverse.postBatch(body, boundary)` lets a
// caller send a body of its own. The body is text, and it is the only place the rows it writes can be seen, so reading it has to be exact: the service executes only the parts delimited by the
// boundary the request's Content-Type declares, each part is one HTTP request, and a text that merely LOOKS like a request line (a page's source, a body that quotes one) is a body, not an operation.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api
// http://docs.oasis-open.org/odata/odata/v4.0/errata03/os/complete/part1-protocol/odata-v4.0-errata03-os-part1-protocol-complete.html#_Toc453752313 (11.7 Batch Requests)
//
// What the vendored SDK renders (its `renderChangeSet`, which the bundle does not export), CRLF between lines, the request's own header being
//   Content-Type: multipart/mixed;boundary=batch_<id>
// and the body:
//   --batch_<id>
//   Content-Type: multipart/mixed;boundary=changeset_<id>                 a change set: the requests below, until its own closing delimiter
//
//   --changeset_<id>
//   Content-Type: application/http                                        each request is a part ...
//   Content-Transfer-Encoding: binary
//   Content-ID: 1                                                         ... which `$1` names to the parts that follow
//
//   PATCH https://contoso.crm.dynamics.com/api/data/v9.0/appmodules(<id>) HTTP/1.1      the request line, then the request's headers
//   Content-Type: application/json;type=entry
//   If-Match: W/"1"
//
//   {"name":"Help Desk","description":"Track tickets"}                    an empty line, then the body, up to the next delimiter line
//   --changeset_<id>--
//   --batch_<id>--
// The platform's own documentation writes the same thing a little more loosely, and all of it is the same batch: the boundary quoted (`boundary="batch_<id>"`), a space after the semicolon, a
// blank line before a delimiter, an address relative to the host (`PATCH /api/data/v9.0/accounts(<id>) HTTP/1.1`) or to the service root (`PATCH accounts(<id>) HTTP/1.1`), requests outside any change
// set beside it, several change sets, and bare line feeds (the documentation says CRLF is required and that other endings "might cause deserialization errors", which is not the same as being refused).
//
// WHAT IS REFUSED. `readBatchRequest` answers `{ problem }` for everything it cannot read with confidence — a boundary the Content-Type does not declare or the body does not use, a Content-Type (of the
// batch or of a change set) whose parameters cannot be taken apart or that declares its boundary more than once, a batch that is not
// closed, a part with no content type or with one the service does not run, a part that is not encoded as binary, a line among the headers that is not a header, a request line that is not one — because
// a reader that guessed would see a different batch from the service's, and the only reason to read it is to know what it writes. A caller that cannot read a batch must decide what that means; the
// header guard of lib/app-header-text.js refuses one that names the app module table. The reasons contain no parentheses: they are put inside some in a message.

// The line breaks of a batch: CRLF, and a bare LF is read too.
const LINE_BREAK = /\r?\n/;
// The name of a header: a token (RFC 9110 5.6.2, https://www.rfc-editor.org/rfc/rfc9110#section-5.6.2). A header line is that, a colon and the value — `Content-ID: 1` — and is taken apart at its
// first colon, not by one pattern over the whole line: a pattern that trims the value lazily goes quadratic on a long run of spaces, and this reads whatever a caller sends.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// The continuation of a header on the next line (obsolete line folding, RFC 9112 5.2, https://www.rfc-editor.org/rfc/rfc9112#section-5.2): whitespace and then something. A line of nothing but
// whitespace is neither a header nor that.
const CONTINUATION = /^[ \t]+\S/;
// The request line of a part, as the SDK writes it and the documentation does: the method, the address (absolute, or relative to the host or to the service root, or a `$1` reference to an earlier
// part's row), no spaces in it, and the HTTP version.
//   PATCH https://contoso.crm.dynamics.com/api/data/v9.0/appmodules(<id>) HTTP/1.1
const REQUEST_LINE = /^([A-Za-z]+) (\S+) HTTP\/\d(?:\.\d)?$/;
// A token (RFC 9110 5.6.2) as one character: what a parameter name and an unquoted parameter value are made of.
const TOKEN_CHAR = /^[!#$%&'*+.^_`|~0-9A-Za-z-]$/;
const isSpace = (c) => c === ' ' || c === '\t';

// The parameters of a Content-Type, read the way the media type grammar has them (RFC 9110 5.6.6 and 8.3.1,
// https://www.rfc-editor.org/rfc/rfc9110#section-5.6.6): after the type, `;`-separated `name=value` pairs, a name being a
// token (its case does not matter) and a value a token or a quoted string, in which a backslash quotes the next character.
//   multipart/mixed; note="; boundary=decoy"; boundary=actual
// has two parameters, `note` (`; boundary=decoy`) and `boundary` (`actual`): text inside a quoted value is never a
// parameter. A search for `boundary=` anywhere would take the quoted `decoy`, and the parts it delimits — a preamble to the
// service, which runs the parts of `actual` — would be read in place of the real ones. Spaces around `;` and `=` are let
// through (`Multipart/Mixed ; Boundary = "b"`), as lenient readers take them. Answers `{ parameters: [{ name, value }] }`,
// names lower-cased, or `{ problem }` when the text cannot be taken apart this way: a reader that guessed where a parameter
// starts could pick a boundary the service does not.
function parametersOf(contentType) {
  const text = String(contentType);
  let at = text.indexOf(';');
  if (at === -1) return { parameters: [] };
  if (text.slice(0, at).includes('"')) return { problem: 'its media type holds a quote' };
  const parameters = [];
  const skipSpace = () => { while (at < text.length && isSpace(text[at])) at += 1; };
  while (at < text.length) {
    // `at` is on a `;`. An empty parameter (`;;`, or a `;` at the end) is allowed by the grammar and carries nothing.
    at += 1;
    skipSpace();
    if (at >= text.length) break;
    if (text[at] === ';') continue;
    const nameStart = at;
    while (at < text.length && TOKEN_CHAR.test(text[at])) at += 1;
    const name = text.slice(nameStart, at).toLowerCase();
    if (!name) return { problem: 'a parameter of its Content-Type has no name' };
    skipSpace();
    if (text[at] !== '=') return { problem: `the parameter ${name} of its Content-Type has no value` };
    at += 1;
    skipSpace();
    let value = '';
    if (text[at] === '"') {
      at += 1;
      let closed = false;
      while (at < text.length) {
        const c = text[at];
        if (c === '"') { closed = true; at += 1; break; }
        if (c === '\\') {
          if (at + 1 >= text.length) break;
          value += text[at + 1];
          at += 2;
          continue;
        }
        value += c;
        at += 1;
      }
      if (!closed) return { problem: `the quoted value of the parameter ${name} of its Content-Type is not closed` };
    } else {
      const valueStart = at;
      while (at < text.length && TOKEN_CHAR.test(text[at])) at += 1;
      value = text.slice(valueStart, at);
    }
    skipSpace();
    if (at < text.length && text[at] !== ';') return { problem: `the parameter ${name} of its Content-Type is followed by text that is not another parameter` };
    parameters.push({ name, value });
  }
  return { parameters };
}

// The boundary a multipart Content-Type declares — `multipart/mixed;boundary=batch_1`, `multipart/mixed; boundary="batch_1"` —
// as `{ boundary }`, or `{ problem }`. Exactly one `boundary` parameter, read by parametersOf; two of them (whichever the
// service took, the other could be read), or a `boundary*` extended form (RFC 2231, which a reader may or may not apply), make
// the boundary ambiguous and are refused rather than resolved.
function boundaryOf(contentType) {
  const read = parametersOf(contentType);
  if (read.problem) return read;
  if (read.parameters.some((p) => p.name.startsWith('boundary*'))) return { problem: 'its Content-Type gives the boundary in an extended form' };
  const found = read.parameters.filter((p) => p.name === 'boundary');
  if (found.length > 1) return { problem: 'its Content-Type declares more than one boundary' };
  return found.length && found[0].value ? { boundary: found[0].value } : {};
}

const mediaTypeOf = (headers) => String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();

// A line without the spaces and tabs at its end — the only padding a delimiter line may carry (RFC 2046 5.1.1) — by a loop: a pattern for it goes quadratic on a long run of them.
function trimPadding(line) {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return end === line.length ? line : line.slice(0, end);
}

// `{ name, value }` of a header line, or undefined when the line is not one.
function headerOf(line) {
  const colon = line.indexOf(':');
  if (colon < 1) return undefined;
  const name = trimPadding(line.slice(0, colon));
  return HEADER_NAME.test(name) ? { name, value: line.slice(colon + 1).trim() } : undefined;
}

// True when a block of header lines is not made of headers (the first line cannot continue another).
const hasBadHeaderLine = (lines) => lines.some((line, index) => !(headerOf(line) || (index > 0 && CONTINUATION.test(line))));

// The parts between the delimiter lines of `boundary`, each as its lines — or the reason the text is not a batch of that boundary. A delimiter is a line of `--<boundary>` (the closing one
// `--<boundary>--`), which may be followed by whitespace (RFC 2046 5.1.1, https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1); a line that only starts with it is a line of a part. Text before
// the first delimiter (the preamble) and after the closing one (the epilogue) is not a part and is ignored, but a delimiter after the closing one is not: a reader that stopped at the close
// would not see what a more lenient service went on to run.
function splitParts(lines, boundary) {
  const open = `--${boundary}`;
  const close = `${open}--`;
  const parts = [];
  let part = null;
  let opened = false;
  let closed = false;
  for (const line of lines) {
    const delimiter = trimPadding(line);
    if (delimiter !== open && delimiter !== close) {
      if (part) part.push(line);
      continue;
    }
    if (closed) return { problem: `a delimiter line follows the closing delimiter ${close}` };
    if (part) parts.push(part);
    opened = opened || delimiter === open;
    part = delimiter === open ? [] : null;
    closed = delimiter === close;
  }
  if (!opened) return { problem: `it has no delimiter line ${open}` };
  if (!closed) return { problem: `the closing delimiter ${close} is missing` };
  return { parts };
}

// A part is its headers, an empty line and its content. The headers are read as `{ lower-cased name: value }`; one that is repeated is refused, since which of two Content-Types the service
// would act on is not something to guess.
function readPart(lines) {
  if (!lines.length) return { problem: 'a part is empty' };
  const blank = lines.indexOf('');
  if (blank === -1) return { problem: 'a part has no empty line after its headers' };
  const headerLines = lines.slice(0, blank);
  if (hasBadHeaderLine(headerLines)) return { problem: 'a part has a line among its headers that is not a header' };
  const headers = Object.create(null);
  let last;
  for (const line of headerLines) {
    const field = headerOf(line);
    if (!field) {
      headers[last] += ` ${line.trim()}`;
      continue;
    }
    last = field.name.toLowerCase();
    if (Object.hasOwn(headers, last)) return { problem: `a part repeats its ${field.name} header` };
    headers[last] = field.value;
  }
  return { headers, content: lines.slice(blank + 1) };
}

// The one request a part of type application/http holds: its request line, its headers up to the first empty line, and everything after that as its body. The body is text and nothing in it is
// ever read as anything else — it may hold blank lines, lines that read as request lines or as delimiters of another boundary.
function readOperation({ headers, content }) {
  const encoding = String(headers['content-transfer-encoding'] || 'binary').trim().toLowerCase();
  if (!['binary', '7bit', '8bit'].includes(encoding)) return { problem: `a part is encoded as ${encoding}, not binary` };
  const request = REQUEST_LINE.exec(content[0] || '');
  if (!request) return { problem: 'a part does not start with a request line' };
  const rest = content.slice(1);
  const end = rest.indexOf('');
  if (hasBadHeaderLine(end === -1 ? rest : rest.slice(0, end))) return { problem: 'a request has a line among its headers that is not a header' };
  const contentId = headers['content-id'] === undefined ? undefined : String(headers['content-id']).trim();
  return { method: request[1], target: request[2], contentId, body: end === -1 ? '' : rest.slice(end + 1).join('\n') };
}

/**
 * The operations of a `$batch` request body, in the order the service runs them, or why it cannot be read.
 * @param {string} text - the request body
 * @param {string} [contentType] - the request's Content-Type header, whose boundary the service reads the parts by. Left out (`undefined`) for a request that has none, the batch then opens with its
 *   own delimiter line, as the SDK's own reader of a batch answer finds it; a Content-Type that declares no boundary is a problem.
 * @returns {{ operations: Array<{ method: string, target: string, contentId: string|undefined, body: string }> } | { problem: string }}
 *   `target` is the address as written in the request line; `body` is the text after the request's headers (lines joined with `\n`).
 */
function readBatchRequest(text, contentType) {
  const lines = String(text).split(LINE_BREAK);
  let boundary;
  if (contentType === undefined) {
    const delimiter = /^--(\S+)$/.exec((lines.find((line) => line.trim() !== '') || '').trim());
    if (!delimiter) return { problem: 'it declares no boundary and does not open with a delimiter line' };
    boundary = delimiter[1];
  } else {
    const declared = boundaryOf(contentType);
    if (declared.problem) return declared;
    boundary = declared.boundary;
    if (boundary === undefined) return { problem: 'its Content-Type declares no boundary' };
  }
  const outer = splitParts(lines, boundary);
  if (outer.problem) return outer;
  const operations = [];
  // A request of its own, in a part of the batch or of a change set.
  const request = (part, inChangeSet) => {
    const type = String(part.headers['content-type'] || '').trim();
    if (!type) return { problem: 'a part declares no content type' };
    if (mediaTypeOf(part.headers) !== 'application/http') {
      return { problem: inChangeSet ? `a part of a change set is not a request: its content type is ${type}` : `a part has the content type ${type}, which is neither application/http nor a change set` };
    }
    return readOperation(part);
  };
  for (const partLines of outer.parts) {
    const part = readPart(partLines);
    if (part.problem) return part;
    if (mediaTypeOf(part.headers) !== 'multipart/mixed') {
      const operation = request(part, false);
      if (operation.problem) return operation;
      operations.push(operation);
      continue;
    }
    // A change set: requests, one level down — the service does not run a change set inside one.
    const declared = boundaryOf(part.headers['content-type']);
    if (declared.problem) return { problem: `a change set cannot be read: ${declared.problem.replace(/^its /, 'its own ')}` };
    const changeSetBoundary = declared.boundary;
    if (changeSetBoundary === undefined) return { problem: 'a change set declares no boundary' };
    const changeSet = splitParts(part.content, changeSetBoundary);
    if (changeSet.problem) return changeSet;
    for (const requestLines of changeSet.parts) {
      const inner = readPart(requestLines);
      if (inner.problem) return inner;
      const operation = request(inner, true);
      if (operation.problem) return operation;
      operations.push(operation);
    }
  }
  return { operations };
}

module.exports = { readBatchRequest };
