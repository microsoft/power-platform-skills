'use strict';
// A synthetic access token and the ways a service's diagnostic can spell it, for the tests that prove a token never reaches what a script writes.
//
// A token the way Azure issues one — three base64url parts joined by dots — and synthetic: each part is at least 24 characters, so each is taken out on its own.
const PARTS = ['syntheticHeaderPartNotARealCredential', 'syntheticPayloadPartNotARealCredential', 'syntheticSignaturePartNotARealCredential'];
const TOKEN = PARTS.join('.');
// What must not be readable anywhere: the token and each of its parts.
const SECRETS = [TOKEN, ...PARTS];
const NL = '\r\n';
const CODE = '0x80040220';
// A gateway that wraps a long header value folds it (RFC 9112 section 5.2, the obsolete line folding: a line break and a space) — here every eight characters.
const FOLDED = TOKEN.match(/.{1,8}/g).join(`${NL} `);
// The first character of each part spelled as a JSON escape (`\u0073` is `s`): written into a JSON body the SDK decodes it, written as text it stays what it is.
const ESCAPED_INITIALS = PARTS.map((part) => `\\u${part.charCodeAt(0).toString(16).padStart(4, '0')}${part.slice(1)}`).join('.');

// What the refused part of a change set can say. The SDK quotes the body of the part as it parses it — a JSON body is decoded, so a character written `\uXXXX` is the character itself in the message, and a body that is
// itself escaped JSON keeps its escapes — and takes any text between the part's own delimiters as that body, whatever lines it holds. `typed` is the platform's own code, which the SDK keeps in the body it parsed.
const REFUSALS = [
  { name: 'plain JSON', body: JSON.stringify({ error: { code: CODE, message: `Principal user rejected bearer ${TOKEN} for this write` } }), typed: CODE },
  { name: 'multi-byte JSON', body: JSON.stringify({ error: { code: CODE, message: `Accès refusé 日本語 🧪 ${TOKEN} — fin` } }), typed: CODE },
  { name: 'JSON that names one part of the token', body: JSON.stringify({ error: { code: CODE, message: `The payload ${PARTS[1]} is not valid` } }), typed: CODE },
  { name: 'JSON with the first character of each part spelled as a \\u escape', body: `{"error":{"code":"${CODE}","message":"Rejected bearer ${ESCAPED_INITIALS} for this write"}}`, typed: CODE },
  { name: 'JSON that spells the escape itself (the escape is escaped, so the decoded message still holds it)', body: JSON.stringify({ error: { code: CODE, message: `The supplied literal spelling was ${ESCAPED_INITIALS}` } }), typed: CODE },
  { name: 'JSON with the token folded onto several lines', body: JSON.stringify({ error: { code: CODE, message: `Rejected bearer ${FOLDED}` } }), typed: CODE },
  { name: 'JSON with the token as a key of the body', body: JSON.stringify({ error: { code: CODE, message: 'no detail' }, [TOKEN]: 'the header the gateway echoed' }), typed: CODE },
  { name: 'plain text with a line that looks like an HTTP/2 status line', body: `Gateway diagnostic${NL}HTTP/2 200 OK${NL}Rejected bearer ${TOKEN}` },
  { name: 'plain text that looks like a delimiter: two dashes and the token', body: `--${TOKEN}` },
  { name: 'plain text with the token folded onto several lines', body: `Rejected bearer ${FOLDED}` },
];

module.exports = { PARTS, TOKEN, SECRETS, NL, CODE, FOLDED, ESCAPED_INITIALS, REFUSALS };
