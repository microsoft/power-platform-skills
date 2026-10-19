'use strict';
// For tests: every text a value holds, and the spellings in which an access token can still be read out of one. A failure that left the SDK is clean only when none of those spellings holds the token —
// not when a plain `includes(TOKEN)` finds nothing, which a token folded onto several lines or spelled with an escape survives.

// Every string a value holds, wherever it is: an Error's message and stack, its own properties (the non-enumerable and the symbol-keyed ones too), its `cause` chain, and the keys and values of whatever those hold.
// Accessors are not read, as the plugin's own walk does not read them; an Error's `stack` is, because a recent engine makes it one.
function stringsOf(value, seen = new Set(), out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return out;
  seen.add(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return out;
  if (value instanceof Error) out.push(String(value.message), String(value.stack));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') out.push(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) stringsOf(descriptor.value, seen, out);
  }
  return out;
}

// The JSON escapes a text can still hold after the SDK decoded it once (a body that was JSON inside JSON): `\u0073` for `s`, `\/` for `/`, and `\r`, `\n`, `\t` for the white space they spell.
const unescaped = (text) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\\//g, '/').replace(/\\[rnt]/g, '');

// The ways a reader gets the token back out of `text`: as it is, with the line folds and any other white space taken out, and with the escapes decoded as well.
const viewsOf = (text) => [text, text.replace(/\s+/g, ''), unescaped(text).replace(/\s+/g, '')];

// The secrets (the token, and each part of it) that can be read out of any text `value` holds, in any of those spellings.
function leaksIn(value, secrets) {
  const views = stringsOf(value).flatMap(viewsOf);
  return secrets.filter((secret) => views.some((view) => view.includes(secret)));
}

module.exports = { stringsOf, viewsOf, unescaped, leaksIn };
