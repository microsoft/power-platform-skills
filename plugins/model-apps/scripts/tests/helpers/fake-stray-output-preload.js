'use strict';
// `node --require` for a test of what a script prints when code it does not own writes to its streams. The transport (`makeRequest` of lib/dataverse-auth.js, which the fake platform
// replaces) is wrapped so that the FIRST request it carries is preceded by STRAY_OUTPUT, written the way a library writes — `console.error` to stderr and `console.log` to stdout (the SDK's
// XML parser reports with `console.warn` and `console.error`) — after the run has been given its access token, so that what the text quotes of it is a token the script has sent.
// Either order of loading works: it takes over `makeRequest` whether the fake platform has set it already or sets it afterwards.
const auth = require('../../lib/dataverse-auth.js');

let written = false;
const wrap = (request) => async (options) => {
  if (!written && process.env.STRAY_OUTPUT) {
    written = true;
    console.error(process.env.STRAY_OUTPUT);
    console.log(process.env.STRAY_OUTPUT);
  }
  return request(options);
};

let current = wrap(auth.makeRequest);
Object.defineProperty(auth, 'makeRequest', {
  configurable: true,
  enumerable: true,
  get: () => current,
  set: (request) => { current = wrap(request); },
});
