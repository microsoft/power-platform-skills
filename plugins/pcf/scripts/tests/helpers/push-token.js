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

// The base64 of `text` as it stands inside a longer value, at each of the three byte alignments, found by trying rather than by the module's arithmetic: the characters that stay the same whatever bytes stand before
// and after it (the characters at either end that also hold bits of a neighbour change with it, and are not the text's own).
function base64Of(text, alphabet = 'base64') {
  const spellings = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const zeros = Buffer.concat([Buffer.alloc(offset, 0x00), Buffer.from(text), Buffer.alloc(3, 0x00)]).toString(alphabet);
    const ones = Buffer.concat([Buffer.alloc(offset, 0xff), Buffer.from(text), Buffer.alloc(3, 0xff)]).toString(alphabet);
    let from = 0;
    while (zeros[from] !== ones[from]) from += 1;
    let to = from;
    while (to < zeros.length && zeros[to] === ones[to]) to += 1;
    spellings.push(zeros.slice(from, to));
  }
  return spellings;
}

module.exports = { PARTS, TOKEN, SECRETS, leaksIn, base64Of };
