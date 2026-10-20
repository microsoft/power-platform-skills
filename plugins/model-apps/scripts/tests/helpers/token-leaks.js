'use strict';
// For tests: every text a value holds, and the spellings in which an access token can still be read out of one. A text a script writes is clean only when none of those spellings holds the token —
// not when a plain `includes(TOKEN)` finds nothing, which a token folded onto several lines, spelled with an escape, printed the way `util.inspect` prints a long string (in colours too) or with a stray backslash in it survives.
const { stripVTControlCharacters } = require('node:util');

// Every string a value holds, wherever it is: an Error's message and stack, its own properties (the non-enumerable and the symbol-keyed ones too), its `cause` chain, and the keys and values of whatever those hold.
// Accessors are not read: a test must not run code the subject would not. An Error's `stack` is, because a recent engine makes it one.
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

// The JSON escapes a text can hold: `\u0073` for `s`, `\/` for `/`, and `\r`, `\n`, `\t`, `\f` for the white space they spell. Each is read whatever the number of backslashes before it: a text that was JSON inside JSON, or
// was written as JSON once more, holds `\\u0073` and `\\r\\n`, which a reader who decodes it once more reads as the same characters.
const unescaped = (text) => text.replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\+\//g, '/').replace(/\\+[rntf]/g, '');

// The ways a reader gets the token back out of `text`: as it is, with the line folds and any other white space taken out, with the escapes decoded as well, and with the quotes and plus signs of a long string printed
// over several lines (`'abc\r\n' +\n  ' def'`) taken out too — each of them also with the terminal's colour codes taken out first (what a person reading a console sees), and each also with every backslash taken out
// (a token a diagnostic spelled with a literal backslash between its characters).
const viewsOf = (text) => {
  const views = [];
  for (const base of [text, stripVTControlCharacters(text)]) {
    const spelled = unescaped(base).replace(/\s+/g, '');
    for (const view of [base, base.replace(/\s+/g, ''), spelled, spelled.replace(/['"`+]/g, '')]) views.push(view, view.replace(/\\+/g, ''));
  }
  return views;
};

// The secrets (the token, and each part of it) that can be read out of any text `value` holds, in any of those spellings.
function leaksIn(value, secrets) {
  const views = stringsOf(value).flatMap(viewsOf);
  return secrets.filter((secret) => views.some((view) => view.includes(secret)));
}

module.exports = { stringsOf, viewsOf, unescaped, leaksIn };
