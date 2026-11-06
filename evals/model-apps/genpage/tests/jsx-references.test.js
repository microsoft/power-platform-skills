'use strict';

// What a character reference in JSX renders (lib/jsx-references.js), as the evals read it: JSX text and a JSX attribute's
// string decode `&#72;`, `&#x48;` and the compiler's named references (`&amp;`, `&eacute;`, `&nbsp;`), so a page shows
// `<Text>&#72;&#105;</Text>` exactly as it shows `<Text>Hi</Text>`. The decoding is the vendored page compiler's own
// (plugins/model-apps/scripts/lib/typescript-compiler.js, with the SDK's { target: ES5, module: ES2020, jsx: React }): a
// table copied into the evals could drift from it, so these tests hold the reader to the compiler's emit instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderedText, characterReferences, hasReference } = require('../lib/jsx-references.js');
const { jsxTextRuns, renderedSource } = require('../lib/tsx-structure.js');
const { loadVendoredTypeScript } = require('../../../../plugins/model-apps/scripts/lib/typescript-compiler.js');

test('a character reference reads as what the page compiler decodes it to, and anything it does not decode as written', () => {
  const cases = [
    ['&#72;&#x69;', 'Hi'],
    ['Save &amp; close', 'Save & close'],
    ['&eacute;&Eacute;&apos;&sup2;', 'éÉ\'²'],
    ['&#1575;&#1604;', 'ال'],
    ['&#x1F600;', '\u{1F600}'],
    ['&nbsp;&#32;', '\u00a0 '],
    ['&mdash;&copy;&euro;', '—©€'],
    // Decoded once, left to right: the "&" that `&#38;` gives does not start another reference.
    ['&#38;amp;', '&amp;'],
    ['&am&amp;p;', '&am&p;'],
    // Not decoded: a capital X, a name the compiler's table lacks or spells differently, an empty or malformed one.
    ['&#X48;', '&#X48;'],
    ['&AMP;', '&AMP;'],
    ['&nosuch;', '&nosuch;'],
    ['&#;&#x;&;& amp;', '&#;&#x;&;& amp;'],
    // Past U+10FFFF the compile itself fails, so no page holding it renders: it is left as written.
    ['&#x110000;', '&#x110000;'],
    ['&#99999999999;', '&#99999999999;'],
    ['no reference', 'no reference'],
  ];
  for (const [written, shown] of cases) assert.equal(renderedText(written), shown, written);
  assert.deepEqual(characterReferences('a&amp;b&nosuch;'), [{ start: 1, end: 6, shown: '&' }, { start: 7, end: 15, shown: '&nosuch;' }]);
  assert.equal(hasReference('R&D, a=1&b=2'), false);
  assert.equal(hasReference('&nbsp;'), true);
});

// The reader decodes one reference at a time; the compiler decodes a whole run of text with one pattern. The two agree on any
// text — a reference's `&` and `;` bound it, and no match of either holds another `&` — and here that is checked against the
// compiler itself, in both places JSX decodes: generated text is compiled as an element's child and as an attribute's string,
// and the strings the compiler emits are read back with its own parser. The samples put each reference inside every other
// one at every cut (`&am` + `&nbsp;` + `p;`), and join random runs of references and of the characters they are made of, so
// they hold references that are cut short, run into each other, overlap or are formed across pieces.
test('decoding one reference at a time gives what the page compiler gives for the whole text, in JSX text and in an attribute', () => {
  const ts = loadVendoredTypeScript();
  const REFERENCES = ['&amp;', '&AMP;', '&#72;', '&#x48;', '&#X48;', '&#x1F600;', '&#0;', '&nbsp;', '&eacute;', '&apos;', '&sup2;',
    '&nosuch;', '&#;', '&#x;', '&;', '&_x;', '&1;', '&#38;'];
  // No raw piece holds a digit or is made of hex digits alone, so every numeric reference in a sample is a whole one from
  // REFERENCES, within U+10FFFF: no sample fails the compile.
  const RAW = ['&', '&', '&', '#', '#', ';', ';', ';', 'x', 'X', ' ', '_', 'q', 'amp', 'amp', 'AMP', 'nbsp', 'copy', 'eacute'];
  const PIECES = [...RAW, ...REFERENCES];
  let seed = 20261026;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 16) % n;
  };
  const samples = [];
  for (const outer of REFERENCES) {
    for (const inner of REFERENCES) {
      samples.push(outer + inner);
      for (let cut = 1; cut < outer.length; cut += 1) samples.push(outer.slice(0, cut) + inner + outer.slice(cut));
    }
  }
  for (let i = 0; i < 400; i += 1) samples.push(Array.from({ length: 1 + random(8) }, () => PIECES[random(PIECES.length)]).join(''));
  // A letter on each side keeps JSX's white-space rules from trimming a sample that starts or ends with a space.
  const source = `[${samples.map((s) => `<i>Z${s}Z</i>, <i a="Z${s}Z" />`).join(', ')}];`;
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.ES2020, jsx: ts.JsxEmit.React },
    fileName: 'samples.tsx',
  });
  // [React.createElement("i", null, "Z&Z"), React.createElement("i", { a: "Z&Z" }), …];
  const emitted = ts.createSourceFile('samples.js', outputText, ts.ScriptTarget.ES5, false, ts.ScriptKind.JS);
  const calls = emitted.statements[0].expression.elements;
  assert.equal(calls.length, samples.length * 2);
  let decoded = 0;
  samples.forEach((sample, i) => {
    const asText = calls[2 * i].arguments[2];
    const asAttribute = calls[2 * i + 1].arguments[1].properties[0].initializer;
    assert.ok(ts.isStringLiteral(asText) && ts.isStringLiteral(asAttribute), sample);
    const shown = renderedText(`Z${sample}Z`);
    assert.equal(shown, asText.text, `JSX text ${sample}`);
    assert.equal(shown, asAttribute.text, `attribute string ${sample}`);
    if (shown !== `Z${sample}Z`) decoded += 1;
  });
  assert.ok(decoded > samples.length / 2, `most samples hold a reference the compiler decodes (${decoded} of ${samples.length})`);
});

test('JSX text and JSX attribute strings render decoded; JavaScript strings, templates and code are kept as written', () => {
  const page = `const P = () => <Text title="&#72;i">&euro;{total} &amp; {'&euro;'} {\`&amp;\`}</Text>;`;
  assert.deepEqual(jsxTextRuns(page).map((r) => r.text), ['€', '&']);
  const { shown, at } = renderedSource(page);
  assert.equal(shown, `const P = () => <Text title="Hi">€{total} & {'&euro;'} {\`&amp;\`}</Text>;`);
  assert.equal(at.length, shown.length);
  // A decoded reference's characters come from its `&`; every other character comes from where it was written.
  assert.equal(at[shown.indexOf('H')], page.indexOf('&#72;'));
  assert.equal(at[shown.indexOf('€')], page.indexOf('&euro;'));
  assert.equal(at[shown.indexOf(' & ') + 1], page.indexOf('&amp;'));
  for (let k = 0; k < shown.length; k += 1) if (!'H€'.includes(shown[k])) assert.equal(page[at[k]], shown[k], `offset ${k}`);
  const plain = "const P = () => <Text>{'R&D'} a=1&b=2 &copy</Text>;";
  const view = renderedSource(plain);
  assert.equal(view.shown, plain);
  assert.deepEqual(view.at, [...plain].map((_, k) => k));
  const scriptOnly = "const P = () => <Text title={'&#72;i'}>{'&euro;'}{`&amp;`}</Text>; // &copy;";
  assert.equal(renderedSource(scriptOnly).shown, scriptOnly, 'a reference in a JavaScript string, a template or a comment is not decoded');
});
