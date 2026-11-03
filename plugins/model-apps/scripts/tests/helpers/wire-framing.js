'use strict';
// What Node's HTTP client would send as a request's Content-Length, for the tests of what a transport puts on the wire. A client keeps ONE header per name, whatever the case, and the later one wins:
// OutgoingMessage.setHeader is what ClientRequest calls for each header it is given, so this is that rule itself and not a copy of it. The plugin's transport (lib/sdk-http-client.js) does not count
// a body it writes (written with `write` and `end`, it is sent chunked unless a Content-Length is declared), so the header a caller declares is the one that goes on.
const { OutgoingMessage } = require('node:http');

// The Content-Length of the request as a string, or undefined when no spelling of it is declared.
function effectiveContentLength(headers) {
  const message = new OutgoingMessage();
  for (const [name, value] of Object.entries(headers || {})) message.setHeader(name, value);
  const declared = message.getHeader('content-length');
  return declared === undefined ? undefined : String(declared);
}

module.exports = { effectiveContentLength };
