'use strict';
// A synthetic access token shaped the way Azure issues one — three base64url parts joined by dots, the first two being small JSON documents — for the tests that prove a token never reaches what `pcf-push.js` writes.
const PARTS = [
  Buffer.from('{"alg":"RS256","typ":"JWT","test":"synthetic"}').toString('base64url'),
  Buffer.from('{"aud":"synthetic","test":"not-a-real-credential"}').toString('base64url'),
  'syntheticSignaturePartNotARealCredential',
];
const TOKEN = PARTS.join('.');
// What must not be readable in anything the push wrote: the token and each part of it.
const SECRETS = [TOKEN, ...PARTS];

// The ways a reader gets a token back out of a text: as it is, with the white space taken out (a fold), and with the JSON escapes of a line break taken out as well (a body that was JSON, written as JSON again).
const views = (text) => [text, text.replace(/\s+/g, ''), text.replace(/\\+[rntf]/g, '').replace(/\s+/g, '')];
const leaksIn = (text, secrets = SECRETS) => secrets.filter((secret) => views(String(text)).some((view) => view.includes(secret)));

module.exports = { PARTS, TOKEN, SECRETS, leaksIn };
