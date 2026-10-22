'use strict';
// The ways a message can spell a settings value, written out here on purpose and independent of scripts/solution-settings.js: that script DECODES a text (JSON string escapes,
// XML character references, percent-encoding) and looks for the value in each decoded form, so a list of spellings that it generates itself would only prove it agrees with
// itself. Each function takes a value and returns the text a message could hold in its place; the tests put each one in a message of its own, so that one that is
// recognised cannot hide one that is not.

const hex = (number, width, upper) => {
  const digits = number.toString(16).padStart(width, '0');
  return upper ? digits.toUpperCase() : digits;
};
// Every character that is not a letter or a digit — and, of those, only the ones `chosen` accepts — written by `write(codePoint)`.
const written = (text, write, chosen = () => true) => [...text].map((char) => (/[A-Za-z0-9]/.test(char) || !chosen(char) ? char : write(char.codePointAt(0)))).join('');
const utf8 = (codePoint, upper) => [...Buffer.from(String.fromCodePoint(codePoint), 'utf8')].map((byte) => `%${hex(byte, 2, upper)}`).join('');
// A BMP character as \uXXXX, an astral one as the surrogate pair JSON writes.
const unicodeEscape = (codePoint, upper) => {
  if (codePoint <= 0xffff) return `\\u${hex(codePoint, 4, upper)}`;
  const offset = codePoint - 0x10000;
  return `\\u${hex(0xd800 + (offset >> 10), 4, upper)}\\u${hex(0xdc00 + (offset & 0x3ff), 4, upper)}`;
};
// The characters a JSON encoder, an XML writer or a URL writer is likely to change by default.
const specials = (char) => /["'<>&\\/]/.test(char);

const json = (value) => JSON.stringify(value).slice(1, -1);
const xmlNamed = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const percent = (value) => encodeURIComponent(value);

/** name -> (value) => the text. */
const SPELLINGS = {
  raw: (value) => value,
  // JSON string escapes (RFC 8259 §7): the ones the format requires, the optional `\/`, and the escape escaped again — JSON inside a JSON string.
  json,
  jsonEscapedSlashes: (value) => json(value).replace(/\//g, '\\/'),
  jsonTwice: (value) => JSON.stringify(json(value)).slice(1, -1),
  // \uXXXX: only the characters an encoder escapes by default (a double quote among them — the escape a list of spellings is likeliest to miss), and every one; either hex case.
  unicodeSpecialsLower: (value) => written(value, (cp) => unicodeEscape(cp, false), specials),
  unicodeSpecialsUpper: (value) => written(value, (cp) => unicodeEscape(cp, true), specials),
  unicodeAllLower: (value) => written(value, (cp) => unicodeEscape(cp, false)),
  unicodeAllUpper: (value) => written(value, (cp) => unicodeEscape(cp, true)),
  // XML character references: the five named ones, and numeric ones in decimal and hexadecimal (either case of the x and the digits).
  xmlNamed,
  xmlDecimal: (value) => written(value, (cp) => `&#${cp};`),
  xmlHexLower: (value) => written(value, (cp) => `&#x${hex(cp, 1, false)};`),
  xmlHexUpper: (value) => written(value, (cp) => `&#X${hex(cp, 1, true)};`),
  // Percent-encoding: what encodeURIComponent writes, every character, lower-case hex, a form's `+` for a space, and twice.
  percent,
  percentAll: (value) => written(value, (cp) => utf8(cp, true)),
  percentLower: (value) => written(value, (cp) => utf8(cp, false)),
  plusForSpace: (value) => percent(value).replace(/%20/g, '+'),
  // Spaces alone percent-encoded, a `+` that is a plus left as it is: a decoder that read every `+` as a space would not find this one.
  spacesPercentEncoded: (value) => value.replace(/ /g, '%20'),
  percentTwice: (value) => percent(percent(value)),
  // The same text in another case, which a service may normalise (a GUID is quoted in lower case): raw, and percent-encoded with the hex digits in the case of the rest.
  lowerCased: (value) => value.toLowerCase(),
  upperCased: (value) => value.toUpperCase(),
  percentLowerCased: (value) => percent(value).toLowerCase(),
  // One inside another, two and three levels deep: how a value reaches a message that quotes a log that quotes a request.
  percentOfJson: (value) => percent(json(value)),
  xmlOfJson: (value) => xmlNamed(json(value)),
  jsonOfXml: (value) => json(xmlNamed(value)),
  unicodeOfJson: (value) => json(written(value, (cp) => unicodeEscape(cp, false), specials)),
  unicodeOfXml: (value) => written(xmlNamed(value), (cp) => unicodeEscape(cp, false), (char) => /[&;]/.test(char)),
  percentOfXml: (value) => percent(xmlNamed(value)),
  percentOfJsonOfXml: (value) => percent(json(xmlNamed(value))),
  // Different characters of one value in different spellings.
  mixed: (value) => [...value].map((char, index) => {
    if (/[A-Za-z0-9]/.test(char)) return char;
    const cp = char.codePointAt(0);
    return [unicodeEscape(cp, false), `&#${cp};`, utf8(cp, true), char][index % 4];
  }).join(''),
};

// Values with every kind of character a spelling changes. The first is the smallest that has a double quote; the last has a `+` that is a plus.
const VALUES = {
  quote: 'cedar pine-"token"',
  mixed: 'C:\\keys\\vault <a&b> "q" \'s\' \u00e9\u4e16/x',
  astral: 'rocket \ud83d\ude80 key',
  plus: 'key+secret value',
};

/** The distinct [name, text] spellings of `value`. */
function spellingsOfValue(value) {
  const seen = new Set();
  const result = [];
  for (const [name, spell] of Object.entries(SPELLINGS)) {
    const text = spell(value);
    if (seen.has(text)) continue;
    seen.add(text);
    result.push([name, text]);
  }
  return result;
}

module.exports = { SPELLINGS, VALUES, spellingsOfValue };
