'use strict';
// A differential fuzz of the reading of an element's text (source-literals.js, elementFailsAt), with TypeScript's parser as the judge.
//
// `<Name>(…) =>` is a generic function type, for certain, where the ELEMENT reading of its text provably fails to parse: TypeScript has no other reading of a `<` in an
// expression of a .tsx file, and in a type there is no JSX. The lexer says the reading fails by reading the text from the `>` of `<Name>` to the arrow the way
// TypeScript reads the children of an element, token by token, and naming the first character it rejects. The claim under test is one-sided and exact:
//
//     wherever the lexer says the element reading fails, TypeScript reports a parse diagnostic for the element reading, at or before the character the lexer named.
//
// An unsound verdict is a page that compiles, with a `<` read as a type where TypeScript reads an element, and the regex after it read as code. The other side is
// a cost, not a defect, and is counted: where the lexer says nothing, TypeScript's parser sometimes reports an error (the guess was only conservative) and
// sometimes none (the element compiles, so the guess is real). The programs come from grammars of type syntax and JSX syntax, from every short string of the
// characters that matter, and from cases written by hand (tests/helpers/jsx-element-fuzz.js); set JSX_FUZZ_SCALE to run more of them.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadTypescriptOracle } = require('./helpers/typescript-oracle.js');
const { runFuzz, runSignatureFuzz, signaturePrograms, judgeDirect, judgeTypes, judgeSignatures, TRACKED_SPACE } = require('./helpers/jsx-element-fuzz.js');
const { elementFailsAt, elementChildren, opensTypeParameters } = require('../lib/source-literals.js');

const SKIP = 'no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it';
const opens = (body) => opensTypeParameters(body, 0);
const codes = (counts) => Object.entries(counts).sort(([a], [b]) => a - b).map(([code, n]) => `TS${code} ${n}`).join(', ');
const visible = (text) => String(text).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

test('fuzz (TypeScript parser): wherever the lexer says the element reading of "<Name>(…) =>" fails to parse, TypeScript reports a diagnostic there', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const scale = Number(process.env.JSX_FUZZ_SCALE) || 1;
  const { exhaustive, structured, bodies, types, forms, coverage } = runFuzz({ ts, elementFailsAt, opens, scale });
  for (const [name, stats] of [['every short text', exhaustive], ['structured texts', structured]]) {
    t.diagnostic(`${name}: ${stats.texts} texts, ${stats.arrows} arrows; read as failing ${stats.invalid} (${codes(stats.byCode)}), undecided ${stats.unsure} (${stats.unsureCompiles} compile, ${stats.unsureFails} fail in TypeScript); unsound ${stats.unsound.length}, unsupported ${stats.unjustified.length}`);
  }
  t.diagnostic(`bodies "<Name>(…) => R" end to end: ${bodies.bodies} bodies; a type for certain ${bodies.certain}, a type with a guess ${bodies.typeGuess} (${bodies.typeGuessCompiles} compile as elements, ${bodies.typeGuessFails} fail), an element ${bodies.element}; unsound ${bodies.unsound.length}, unsupported ${bodies.unjustified.length}`);
  t.diagnostic(`valid types "let v: <Name>(…) => R": ${types.valid} of ${types.bodies}; certain ${types.certain}, guessed ${types.guess}, read as an element ${types.element}`);
  t.diagnostic(`every member and parameter form, as bodies: ${forms.bodies.bodies} bodies; a type for certain ${forms.bodies.certain} (${forms.bodies.quotedCall} with a quoted method signature), a type with a guess ${forms.bodies.typeGuess} (${forms.bodies.typeGuessCompiles} compile as elements, ${forms.bodies.typeGuessFails} fail), an element ${forms.bodies.element}; unsound ${forms.bodies.unsound.length}, unsupported ${forms.bodies.unjustified.length}`);
  t.diagnostic(`every member and parameter form, as types: ${forms.types.valid} of ${forms.types.bodies} valid; certain ${forms.types.certain} (${(100 * forms.types.certain / forms.types.valid).toFixed(1)}%), guessed ${forms.types.guess}, read as an element ${forms.types.element}; certain share of the grammar's valid types ${(100 * types.certain / types.valid).toFixed(1)}%`);
  t.diagnostic(`white space next to an "=" (after/before): ${TRACKED_SPACE.map((c) => `${visible(c)} ${coverage[c].afterEquals}/${coverage[c].beforeEquals}`).join(', ')}; texts that compile with white space beyond ASCII after an "=": ${structured.spaceAfterEqualsCompiles}`);

  for (const stats of [exhaustive, structured]) {
    assert.deepStrictEqual(stats.unsound.slice(0, 5).map((u) => ({ ...u, text: visible(u.text) })), [], 'a text read as failing that TypeScript parses with no diagnostic');
    assert.deepStrictEqual(stats.unjustified.slice(0, 5).map((u) => ({ ...u, text: visible(u.text) })), [], 'a text read as failing whose first TypeScript diagnostic is after the character named');
  }
  assert.deepStrictEqual(bodies.unsound.slice(0, 5).map((u) => visible(u.body)), [], 'a body called a type for certain whose element reading TypeScript parses with no diagnostic');
  assert.deepStrictEqual(bodies.unjustified.slice(0, 5).map((u) => visible(u.body)), [], 'a body called a type for certain whose element reading fails only after its arrow');
  assert.deepStrictEqual(forms.bodies.unsound.slice(0, 5).map((u) => visible(u.body)), [], 'a body with a member or parameter form called a type for certain whose element reading TypeScript parses with no diagnostic');
  assert.deepStrictEqual(forms.bodies.unjustified.slice(0, 5).map((u) => visible(u.body)), [], 'a body with a member or parameter form called a type for certain whose element reading fails only after its arrow');

  // The fuzz is not vacuous: it reaches every way the reading fails and the places where it says nothing, with a real element among them.
  const byCode = {};
  for (const stats of [exhaustive, structured]) for (const [code, n] of Object.entries(stats.byCode)) byCode[code] = (byCode[code] || 0) + n;
  for (const code of [1382, 1381, 1005, 1109, 1003]) assert.ok((byCode[code] || 0) >= 20, `TS${code} was reached ${byCode[code] || 0} times: ${codes(byCode)}`);
  assert.ok(exhaustive.invalid >= 10000 && structured.invalid >= 3000, `${exhaustive.invalid} and ${structured.invalid} texts were read as failing`);
  assert.ok(exhaustive.unsureCompiles + structured.unsureCompiles >= 10, 'elements that compile were met, and left undecided');
  assert.ok(bodies.certain >= 1000 && bodies.typeGuess >= 100, `${bodies.certain} bodies were certain and ${bodies.typeGuess} guessed`);
  assert.ok(types.valid >= 1000 && types.certain > types.guess, `${types.certain} of ${types.valid} valid types were certain`);
  // The share of valid function types the reading settles for certain: a reading that gives up on a member or parameter form leaves its types guessed, and every page that holds one loses the
  // calls after it. The grammar's types, and the forms alone, each have a floor, and every form was met in a valid type.
  assert.ok(types.certain >= 0.88 * types.valid, `${types.certain} of ${types.valid} valid types were certain (${(100 * types.certain / types.valid).toFixed(1)}%)`);
  assert.ok(forms.types.valid >= 3000 && forms.types.certain >= 0.75 * forms.types.valid, `${forms.types.certain} of ${forms.types.valid} valid types with every member and parameter form were certain (${(100 * forms.types.certain / forms.types.valid).toFixed(1)}%)`);
  assert.ok(forms.bodies.certain >= 3000 && forms.bodies.typeGuess >= 100, `${forms.bodies.certain} bodies with a member or parameter form were certain and ${forms.bodies.typeGuess} guessed`);
  // A quoted name and a call (`{ 'm'(x: T): T }`, `{ "m"(): T }`, a name with an escape or a bracket in it) fails as the call of a name does; each verdict was proved against TypeScript above.
  assert.ok(forms.bodies.quotedCall >= 300, `only ${forms.bodies.quotedCall} bodies with a quoted method signature were judged certain`);
  assert.deepStrictEqual(forms.types.elements.map(visible), [], 'a valid function type with a member or parameter form read as an element');
  // A valid function type is never read as an element: that reads its text as JSX and the regex after it as code. The types have white space of every kind and comments between
  // the tokens of their heads, `<`, the name, `>`, `(`, `)` and `=>`, which TypeScript skips, and each kind beyond ASCII was met in a valid type.
  assert.deepStrictEqual(types.elements.map(visible), [], 'a valid function type read as an element');
  for (const [c, n] of Object.entries(types.withSpace)) assert.ok(n >= 10, `${visible(c)} stood in ${n} valid types`);
  // And it reaches what an ASCII-only fuzz cannot: every kind of white space TypeScript skips was put right after an `=` (where an attribute value starts) and right before one
  // (`x ="…"`), and elements that compile with such white space there were met. A reading that takes one of these for a value is a failure, and only these texts show it.
  for (const c of TRACKED_SPACE) {
    assert.ok(coverage[c].afterEquals >= 10 && coverage[c].beforeEquals >= 10, `${visible(c)} was put next to an "=" ${coverage[c].afterEquals} times after it and ${coverage[c].beforeEquals} times before it`);
  }
  assert.ok(structured.spaceAfterEqualsCompiles >= 10, `${structured.spaceAfterEqualsCompiles} texts compile with white space beyond ASCII after an "="`);
});

// `<T>(x)` that neither an arrow nor a colon follows is the text of an element in an expression and a call signature with no return type in a type that holds members, and TypeScript parses
// both. A reading that took it for an element where a type stood read the rest of the type as JSX text up to a closing tag in a string after it, and rewrote the token that string held; one that
// took it for code where an element stood read the element's text as code. Each program is put in both places with the same text (tests/helpers/jsx-element-fuzz.js, signaturePrograms),
// and TypeScript says which of them parse.
test('fuzz (TypeScript parser): "<Name>(…)" that neither an arrow nor a colon follows is never read as an element where TypeScript parses a signature, or as code where it parses an element', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const scale = Number(process.env.JSX_FUZZ_SCALE) || 1;
  const stats = runSignatureFuzz({ ts, opens: opensTypeParameters, children: elementChildren, scale });
  t.diagnostic(`parameter lists with neither an arrow nor a colon after them, each as a type and as an element: ${stats.programs} programs, ${stats.valid} valid to TypeScript`);
  t.diagnostic(`as a type, ${stats.signature.valid} valid: code for certain ${stats.signature.code} (${(100 * stats.signature.code / stats.signature.valid).toFixed(1)}%), a guess ${stats.signature.guess}, an element ${stats.signature.element}`);
  t.diagnostic(`as an element, ${stats.element.valid} valid: an element for certain ${stats.element.element} (${(100 * stats.element.element / stats.element.valid).toFixed(1)}%), a guess ${stats.element.guess}, code ${stats.element.code}; elements with nothing the reading may be unable to read ${stats.precise.valid}, guessed ${stats.precise.guessed.length}`);
  t.diagnostic(`elements that TypeScript rejects, which the lexer reads as code: ${stats.failing}; unsound ${stats.unsound.length}, unsupported ${stats.unjustified.length}`);
  assert.deepStrictEqual(stats.unsound.slice(0, 5).map((u) => ({ kind: u.kind, code: visible(u.code) })), [], 'a type that TypeScript parses read as an element, or an element that it parses read as code, for certain');
  assert.deepStrictEqual(stats.unjustified.slice(0, 5).map((u) => ({ why: u.why, code: visible(u.code) })), [], 'an element read as failing that TypeScript does not reject, or not where the lexer says');
  assert.deepStrictEqual(stats.precise.guessed.slice(0, 5).map(visible), [], 'an element with nothing that hides a closing tag, nothing unread in it and no colon after its parameters, that is guessed at');
  // The fuzz is not vacuous: it met the types read as code and the guessed ones, the elements read as elements and the guessed ones, and the elements that fail.
  assert.ok(stats.signature.valid >= 3000 * scale && stats.signature.code >= 2800 * scale && stats.signature.guess >= 300 * scale, `${stats.signature.valid} types were valid, ${stats.signature.code} read as code and ${stats.signature.guess} guessed`);
  assert.ok(stats.element.valid >= 8000 * scale && stats.element.element >= 6500 * scale && stats.element.guess >= 300 * scale, `${stats.element.valid} elements were valid, ${stats.element.element} read as elements and ${stats.element.guess} guessed`);
  assert.ok(stats.failing >= 2000 * scale, `${stats.failing} elements that fail were read as code`);
  assert.ok(stats.precise.valid >= 2800 * scale, `${stats.precise.valid} elements with nothing to hide were valid`);
  // The rule keeps what it can decide: nearly every valid type that does not hold a closing tag in a string, a template or a comment is code for certain.
  assert.ok(stats.signature.code >= 0.8 * stats.signature.valid, `${stats.signature.code} of ${stats.signature.valid} valid types were read as code`);
});

// A fuzz that cannot fail proves nothing: a reading that calls every such head an element is the one that rewrote the token in the string after a type, and one that calls every head code reads
// the text of an element as code; the judge says so of both, and of a reading that says an element fails where it does not.
test('fuzz (TypeScript parser): the judge of the parameter lists catches a reading that calls every head an element, and one that calls every head code', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const programs = [...signaturePrograms(7, 4000)];
  const everyElement = judgeSignatures(ts, { opens: () => ({ generic: false, ambiguity: null }), children: elementChildren }, programs);
  assert.ok(everyElement.unsound.some((u) => u.kind === 'signature') && everyElement.unsound.every((u) => u.kind === 'signature'), 'a type that TypeScript parses is read as an element, and nothing else is wrong');
  const everyCode = judgeSignatures(ts, { opens: () => ({ generic: true, ambiguity: null }), children: elementChildren }, programs);
  assert.ok(everyCode.unsound.some((u) => u.kind === 'element') && everyCode.unsound.every((u) => u.kind === 'element'), 'an element that TypeScript parses is read as code, and nothing else is wrong');
  // A reading that says an element fails where the text does not show it, and one that names a place before the first diagnostic.
  const neverFails = judgeSignatures(ts, { opens: () => ({ generic: true, ambiguity: null }), children: () => null }, programs);
  assert.ok(neverFails.unjustified.length > 0, 'a failure that the text does not show');
  const tooEarly = judgeSignatures(ts, { opens: () => ({ generic: true, ambiguity: null }), children: () => ({ fails: 0 }) }, programs);
  assert.ok(tooEarly.unjustified.some((u) => /after the 0 named/.test(u.why)), 'a failure named before the first diagnostic');
  assert.deepStrictEqual(judgeSignatures(ts, { opens: opensTypeParameters, children: elementChildren }, programs).unsound, [], 'and the lexer\'s own reading has none');
});

// A fuzz that cannot fail proves nothing: a reading that calls every arrow invalid is an unsound one, and the judge says so.
test('fuzz (TypeScript parser): the judge catches a reading that calls every arrow a failure', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const everything = (text, arrow) => arrow + 1;
  const stats = judgeDirect(ts, everything, ['(<Child x="\\" y=") =>" />)', '(<b x=") =>"/>)', '(<b x=") =>"/>) => T', '(x: T) => T']);
  assert.strictEqual(stats.unsound.length, 2, 'two texts are elements that compile');
  assert.strictEqual(stats.unjustified.length, 1, 'one is read as failing at an arrow inside a string while the first error is after it');
  assert.strictEqual(judgeDirect(ts, (text, arrow) => elementFailsAt(text, 0, arrow), ['(<Child x="\\" y=") =>" />)', '(<b x=") =>"/>)', '(<b x=") =>"/>) => T', '(x: T) => T']).unsound.length, 0);
});

// The failure that a fuzz of ASCII alone cannot find: a reading that takes a character beyond ASCII right after an `=` for an attribute value, where TypeScript's scanner reads it as white
// space (U+00A0, U+0085, U+2028, U+FEFF, …) and goes on to the value after it. The judge flags it, in the texts that compile and in those that do not.
test('fuzz (TypeScript parser): the judge catches a reading that takes white space beyond ASCII after an "=" for an attribute value', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const takesSpaceForAValue = (text, arrow) => {
    const found = text.search(/=[\u00A0\u0085\u2028\uFEFF]/);
    return found !== -1 && found + 1 < arrow ? found + 1 : elementFailsAt(text, 0, arrow);
  };
  const texts = ['\u00A0', '\u0085', '\u2028', '\uFEFF'].map((c) => `(<C x=${c}"a" /><D p="\\" q=") =>" />)`);
  const stats = judgeDirect(ts, takesSpaceForAValue, texts);
  assert.strictEqual(stats.unsound.length, 4, 'each text is an element that compiles, read as failing at the white space');
  assert.strictEqual(judgeDirect(ts, (text, arrow) => elementFailsAt(text, 0, arrow), texts).unsound.length, 0, 'and the reading itself says nothing of them');
  const after = ['\u00A0', '\u0085'].map((c) => `<b a=${c}=>`);
  assert.strictEqual(judgeDirect(ts, takesSpaceForAValue, after).unjustified.length, 2, 'in a text that does not compile, TypeScript\'s first diagnostic is after the white space');
});

// The same for the other failure of this kind: a rule that did not skip U+0085 and U+200B between the tokens of a head — they are TypeScript's trivia and not JavaScript's `\s` — read a
// valid function type as an element. The judge of the types counts it.
test('fuzz (TypeScript parser): the judge of the types counts a valid function type that a reading takes for an element because it does not skip U+0085', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const doesNotSkipNextLine = (body) => (body.includes('\u0085') ? { generic: false, ambiguity: null } : opens(body));
  const bodies = ['<T>\u0085(x: T) => T', '<T\u0085>(x: T) => T', '<T>(x: T)\u0085=> T', '<T>(x: T) => T'];
  const stats = judgeTypes(ts, doesNotSkipNextLine, bodies);
  assert.strictEqual(stats.valid, 4, 'each is a valid type');
  assert.strictEqual(stats.element, 3, 'three are read as elements');
  assert.strictEqual(judgeTypes(ts, opens, bodies).element, 0, 'and the rule reads none of them so');
});
