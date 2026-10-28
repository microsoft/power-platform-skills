'use strict';

// The text that JSX text or a JSX attribute's string renders: every HTML character reference in it read as the character
// the page compiler decodes it to. JSX decodes character references in both (https://react.github.io/jsx/#sec-jsx-string),
// so `<Text>&#72;&#105;</Text>` and `placeholder="&#72;&#105;"` show "Hi" exactly as `<Text>Hi</Text>` does. A JavaScript
// string or template keeps them as written (`{'&amp;'}` shows "&amp;"), so its text is never passed here.
//
// THE COMPILER DECIDES. The bundled SDK compiles a page with TypeScript's `transpileModule` and { target: ES5, module: ES2020,
// jsx: React }, with the compiler the plugin vendors (plugins/model-apps/scripts/lib/typescript-compiler.js: 5.8, the version
// the maker portal compiles with). Its JSX emit decodes, in JSX text and in a JSX attribute's string alike:
//   &#<decimal>;  &#x<hex>;   the code point: `&#72;` and `&#x48;` are "H". `&#X48;` (a capital X) is not decoded. Past
//                             U+10FFFF the compile itself fails ("Invalid code point"), so such a page never renders.
//   &<name>;                  the code point its own table gives the name: the HTML 4 names and `apos`, case-sensitive
//                             (`&amp;` is "&", `&AMP;` is not decoded).
//   anything else             stays as written: `&nosuch;`, `&#;`.
// No table is copied here, so none can drift from the compiler's: each distinct reference is compiled once, as the only
// child of an element and with the SDK's options, and the string the compiler emits for it is read back with the
// compiler's own parser:
//   <i>&copy;</i>;   →   React.createElement("i", null, "\u00A9");   →   "©"
// A reference the compile fails on (past U+10FFFF) is left as written: a page that holds one does not compile at all, so
// there is no rendered text to read in its place.
//
// ONE REFERENCE AT A TIME. The compiler finds references with /&((#((\d+)|x([\da-fA-F]+)))|(\w+));/g. REFERENCE matches
// everything that pattern matches, at the same offset and with the same length — an `&`, then only `#` and word
// characters up to the first `;` — and strings it does not (`&#X48;`, `&nosuch;`), which the compiler then leaves as
// written. A match of either holds no other `&`, so decoding a text one REFERENCE match at a time gives what compiling
// the whole text gives; tests/jsx-references.test.js holds the two to the same result.
//
// The compiler is loaded lazily, once per process (~200 ms, ~20 MB): only a page whose JSX holds a reference pays for it.
// It fails closed — a vendored compiler that does not match its provenance throws (typescript-compiler.js), and an emit
// of an unexpected shape throws here, rather than reading a reference as some guessed text.
const { loadVendoredTypeScript } = require('../../../../plugins/model-apps/scripts/lib/typescript-compiler.js');

const REFERENCE = /&[#\w]+;/g;
const decoded = new Map();

function decodeReference(reference) {
  const known = decoded.get(reference);
  if (known !== undefined) return known;
  const ts = loadVendoredTypeScript();
  let outputText;
  try {
    // The SDK's compile options, exactly (see the header): the reference is decoded as it is in a page.
    ({ outputText } = ts.transpileModule(`<i>${reference}</i>;`, {
      compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.ES2020, jsx: ts.JsxEmit.React },
      fileName: 'reference.tsx',
    }));
  } catch (error) {
    // `&#x110000;` and `&#99999999;`: String.fromCodePoint refuses the code point (RangeError: Invalid code point 1114112).
    if (!(error instanceof RangeError)) throw error;
    decoded.set(reference, reference);
    return reference;
  }
  const emitted = ts.createSourceFile('reference.js', outputText, ts.ScriptTarget.ES5, false, ts.ScriptKind.JS);
  const statement = emitted.statements[0];
  const call = statement && ts.isExpressionStatement(statement) ? statement.expression : null;
  const child = call && ts.isCallExpression(call) && call.arguments.length === 3 ? call.arguments[2] : null;
  if (!child || !ts.isStringLiteral(child)) throw new Error(`the page compiler emitted no string for the JSX text ${reference}: ${outputText.trim()}`);
  decoded.set(reference, child.text);
  return child.text;
}

/**
 * JSX text, or a JSX attribute's string, as the page renders it.
 * @param {string} text - the source text between the tags, or between the attribute's quotes
 * @returns {string} the text with each character reference decoded as the page compiler decodes it
 */
function renderedText(text) {
  return String(text).replace(REFERENCE, (reference) => decodeReference(reference));
}

/**
 * The character references in JSX text or a JSX attribute's string, in order: each one's offsets in `text` and what it
 * renders (as written where the compiler does not decode it). For a reader that must keep the source offsets.
 * @param {string} text
 * @returns {Array<{ start: number, end: number, shown: string }>}
 */
function characterReferences(text) {
  return [...String(text).matchAll(REFERENCE)].map((m) => ({ start: m.index, end: m.index + m[0].length, shown: decodeReference(m[0]) }));
}

// Whether `text` holds anything the compiler might decode (a page without one never loads the compiler).
const ANY_REFERENCE = new RegExp(REFERENCE.source);
const hasReference = (text) => ANY_REFERENCE.test(String(text));

module.exports = { renderedText, characterReferences, hasReference };
