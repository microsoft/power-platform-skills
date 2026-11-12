'use strict';

// Programs for the sweeps of what a signature's text can hide (ambiguity-sweep.test.js): `<T>(x)` and what stands after its `)`, read to the closing tag `</T>`, which a type with the same text
// may hold in a string, a template, a comment or a regex, so that the text of a call after it is data — and which an element ends at, so that the call is real. TypeScript says which programs
// are pages and which tokens are data; a lexer that reads the text wrongly rewrites the token of a call that is not one.
//
// Eleven families, each drawn from a seeded generator (a failure is reproducible) and exhaustive where the family is small:
//   - a member named by a number: a decimal literal with a signed exponent is ONE token to the scanner, `1e-5`, so `1e` and a sign are not two names (numberedMemberPages);
//   - an expression in a member — a default value, a computed name, an initializer — that holds a nested element, whose text is JSX text to a type that reads the element and code to a reading that
//     does not, after which a string, a template or a regex holds the closing tag (nestedTextPages);
//   - a literal in such an expression that holds the text of an element, in one literal or across two (`<b>` in a string and `</b>` in the next): the type reads the literals as tokens, and the tags in them are no
//     element's (literalTagPages);
//   - a nested element whose text is a soup of quotes, back-ticks, comment openers, tags and containers, with the same decoys after it (nestedSoupPages);
//   - a nested tag that is no element — the type arguments of a name, a comparison, the type parameters of a signature or a method — whose closing tag a string before it holds, so that the quote that ends the string is
//     the start of the one that holds the closing tag of the head (nestedCodePages);
//   - a nested tag whose words are TypeScript's own — a modifier, an operator, a keyword, a dotted or dashed name, a value — with a line break of any kind before its `=`, and a fragment after an operand and a line comment of any
//     ending, in every place a tag can stand: drawn from the whole vocabulary, whether or not the lexer's rule calls the tag code, so that a rule that is wrong about a word is met (nestedTagPages);
//   - two or three nested elements, each with a comment opener, a quote or a back-tick in its text, whose regions end at one place (nestedPairPages);
//   - the same type arguments, comparison or type parameters, then strings and elements that hold tags — fragments, tags with an attribute, closing tags — which are text to the type, and which an element reading pairs the
//     quotes around differently (taggedStringPages);
//   - the lines that an element can have after `(a);` — a bracket, a quote, a tag, an operator, a number, a modifier, a postfix, a comment — placed in an expression of a type, where a regex after the
//     comment may hold the closing tag, which is the shape that a lexer that takes the last word of a comment for the token before a `/` reads wrong (expressionLinePages);
//   - an import type, `typeof import` and `import`, with a line terminator, a space or a comment between its tokens, whose `(` stands on a later line (importTypePages);
//   - an accessor, `get` or `set`, or another word before a computed name that holds a comma and a regex, which holds the closing tag (accessorNamePages).

const { CALL } = require('./angle-frames.js');
const { mulberry32 } = require('./jsx-element-fuzz.js');

const pick = (rng, options) => options[Math.floor(rng() * options.length)];
const chance = (rng, p) => rng() < p;

// The call as a type's string holds it, with the closing tag before it.
const HOLDING = `'</T>;${CALL};//'`;
const HOLDING_BODY = `</T>;${CALL};//`;

// ─── A member named by a number ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Every spelling of a decimal literal that takes an exponent: a main part, a fraction, an `e` or `E`, a sign, digits, separators. Those with a signed exponent are one numeric literal to the scanner (scanNumber).
const MANTISSAS = ['1', '12', '1_0', '1.5', '.5', '1.', '0', '1.5_5'];
const EXPONENTS = ['e5', 'E5', 'e+5', 'e-5', 'E+3', 'E-3', 'e+0', 'e-0', 'e+10', 'e+1_0', 'e-0_1', 'e+', 'e-', 'e+x', 'e', 'e1n'];
const NUMBER_NAMES = MANTISSAS.flatMap((mantissa) => EXPONENTS.map((exponent) => `${mantissa}${exponent}`));
const MEMBER_HEADS = ['<T>(x)', 'new <T>(x)', '<T>()'];
const MEMBER_FRAMES = [
  (member) => `interface I { ${member} }`,
  (member) => `type L = { ${member} };`,
  (member) => `let v: { ${member} } = f;`,
  (member) => `function p(x: { ${member} }) {}`,
];
const MEMBER_SEPARATORS = [';', ',', '\n', ';\n  ', ',\n  ', ' // c\n', ' /* c */ ', '\r\n', '\u2028'];
// What follows the name: a type that holds the closing tag in a string, a template or a comment, which is how a type hides it.
const MEMBER_TAILS = [`: ${HOLDING}`, `?: ${HOLDING}`, `: \`</T>;${CALL};//\``, `(): ${HOLDING}`, `: { a: ${HOLDING} }`, ` // </T>;${CALL};\n  m: T`, ` /* </T>;${CALL}; */ m: T`, `: A\n  | ${HOLDING}`];
function numberedMemberPages() {
  const pages = [];
  for (const frame of MEMBER_FRAMES) {
    for (const head of MEMBER_HEADS) {
      for (const name of NUMBER_NAMES) {
        MEMBER_SEPARATORS.forEach((separator, index) => {
          const tail = MEMBER_TAILS[(index + name.length) % MEMBER_TAILS.length];
          pages.push({ code: `${frame(`${head}${separator}${name}${tail}`)}\n${CALL};\n`, label: `${frame('…')} / ${head} / ${JSON.stringify(separator)} / ${name} / ${JSON.stringify(tail)}`, name });
        });
      }
    }
  }
  return pages;
}

// ─── The text of a nested element in an expression of a member ────────────────────────────────────────────────────────────────────────────────────────
const NESTED_TEXTS = ['x // y', 'x /* y', "'x", '"x', '`x', "it's", 'https://x.y', 'a / b', 'see: // c', '// c', 'x', '', 'a, b', "x 'y", '5" wide', 'x /* y */ z', 'r/e/', 'x /* y\n */ z', '(x) // c', "'x' // c"];
const NESTED_TAGS = ['b', 'i', 'span', 'A.B'];
const NESTED_OPERATORS = [' +', ' ||', ' &&', ' ??', ' ,', ' ?', ' :', ' =', ' (', ' [', '', ' in', ' instanceof', ' -', ' *'];
const NESTED_BREAKS = ['\n', '\r\n', '\r', '\u2028', '\u2029', ' ', '\n  // more\n', ' /* c */ ', '\n\n'];
const NESTED_DECOYS = [`/[</T>;${CALL}//]/`, `\`</T>;${CALL};//\``, `'</T>;${CALL};//'`, `"</T>;${CALL};//"`, `/[</T>;${CALL}//]/.source`];
const NESTED_SEPARATORS = [';', ',', '\n', '; '];
const nestedElement = (rng) => {
  const roll = rng();
  const text = pick(rng, NESTED_TEXTS);
  if (roll < 0.15) return `<>${text}</>`;
  const tag = pick(rng, NESTED_TAGS);
  if (roll < 0.25) return `<${tag}>${text}<i/>${pick(rng, NESTED_TEXTS)}</${tag}>`;
  if (roll < 0.32) return `<${tag}>${text}<i>${pick(rng, NESTED_TEXTS)}</i></${tag}>`;
  return `<${tag}>${text}</${tag}>`;
};
const NESTED_FRAMES = [
  (separator, value) => `interface I { <T>(x)${separator}m(a = ${value}): void }`,
  (separator, value) => `interface I { <T>(x)${separator}[${value}]: string }`,
  (separator, value) => `type L = { <T>(x)${separator}m(a?: string, b = ${value}): void };`,
  (separator, value) => `interface C { new <T>(x)${separator}m(a = ${value}): void }`,
  (separator, value) => `interface I { <T>(x)${separator}<U>(a = ${value}): void }`,
  (separator, value) => `interface I { <T>(x)${separator}m = ${value} }`,
];
function nestedTextPages(seed, count) {
  const rng = mulberry32(seed);
  const pages = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    let value = nestedElement(rng);
    if (chance(rng, 0.3)) value = `f(${value})`;
    if (chance(rng, 0.3)) value = `${pick(rng, ['1', 'x', '[', '('])}${pick(rng, NESTED_OPERATORS)} ${value}`;
    value += pick(rng, NESTED_OPERATORS) + pick(rng, NESTED_BREAKS);
    if (chance(rng, 0.2)) value += `${pick(rng, NESTED_OPERATORS)} `;
    value += pick(rng, NESTED_DECOYS);
    if (chance(rng, 0.4)) value += pick(rng, [')', ']', ' : 1', '])', ')]']);
    const code = `${pick(rng, NESTED_FRAMES)(pick(rng, NESTED_SEPARATORS), value)}\n${CALL};\n`;
    if (seen.has(code)) continue;
    seen.add(code);
    pages.push({ code, label: `nested text / ${JSON.stringify(value)}` });
  }
  return pages;
}

// ─── The lines of a prose element, in an expression of a type ──────────────────────────────────────────────────────────────────────────────────────────
// `<p>(a);` and a line that holds a `//`, then a line that starts with a `/`, is an element, for certain, where no type can have its text (typeMembersFail). The same lines in an expression of a type — a default
// value, a computed name, an initializer, after `m: A` and a line break — are where a regex after the comment may hold the closing tag: the token before the comment says whether the `/` divides or begins one.
const EXPRESSION_TAILS = [' // note', '// note', ' https://x.y', ' /* c */ // d', ' // c1\n // c2'];
const EXPRESSION_DECOYS = [`/[</T>;${CALL}//]/`, `/[</T>;${CALL}//]/g`, `/[</T>;${CALL}//]/.source`];
const EXPRESSION_FRAMES = [
  (line, tail, br, decoy) => `interface I { <T>(x); m(a = q${br}  ${line}${tail}${br}${decoy}): void }`,
  (line, tail, br, decoy) => `interface I { <T>(x); m(a = ${line}${tail}${br}${decoy}): void }`,
  (line, tail, br, decoy) => `interface I { <T>(x); [q${br}  ${line}${tail}${br}${decoy}]: string }`,
  (line, tail, br, decoy) => `interface I { <T>(x); [${line}${tail}${br}${decoy}]: string }`,
  (line, tail, br, decoy) => `interface I { <T>(x); m(a = q ? r${br}  ${line}${tail}${br}${decoy}): void }`,
  (line, tail, br, decoy) => `interface I { <T>(x); m(a = q${br}  ${line}${tail}${br}${decoy} : 1): void }`,
  (line, tail, br, decoy) => `interface I { <T>(x); m(a = [q,${br}  ${line}${tail}${br}${decoy}]): void }`,
  (line, tail, br, decoy) => `interface I { <T>(x); m = q${br}  ${line}${tail}${br}${decoy}.source }`,
  (line, tail, br, decoy) => `interface I { <T>(x); m: A${br}  = q${br}  ${line}${tail}${br}${decoy}.source }`,
  // A line after `m: A` or `m` and a line break, which a member's initializer, type or optional mark may go on: where the line begins with `|`, `&`, `=`, `?` or `:` the type or member before it goes on, and a regex after the
  // comment may be the initializer's.
  (line, tail, br, decoy) => `interface I { <T>(x); m: A${br}  ${line}${tail}${br}${decoy} }`,
  (line, tail, br, decoy) => `interface I { <T>(x); m${br}  ${line}${tail}${br}${decoy} }`,
  (line, tail, br, decoy) => `interface I { <T>(x); readonly${br}  ${line}${tail}${br}${decoy} }`,
];
const EXPRESSION_BREAKS = ['\n', '\r\n', '\r', '\u2028', '\u2029'];
function expressionLinePages(lines, seed, count) {
  const rng = mulberry32(seed);
  const pages = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const line = pick(rng, lines);
    const code = `${pick(rng, EXPRESSION_FRAMES)(line, pick(rng, EXPRESSION_TAILS), pick(rng, EXPRESSION_BREAKS), pick(rng, EXPRESSION_DECOYS))}\n${CALL};\n`;
    if (seen.has(code)) continue;
    seen.add(code);
    pages.push({ code, label: `an expression / ${JSON.stringify(line)}` });
  }
  return pages;
}

// ─── The tags that a literal holds ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A string, a template, a regex or a comment that holds the text of an element — `'<b>c</b>'`, or `<b>` in one and `</b>` in the next — in a default value or a computed name, then an operator and a decoy that holds the closing
// tag of the head. The element reading takes the tags in the literals for an element's, which opens in one literal and closes in another; the type reads the literals as tokens, and the decoy holds the closing tag and the text of a call.
const TAG_LITERALS = ["'<b>c</b>'", '"<b>c</b>"', '`<b>c</b>`', '`<b>${x}</b>`', "'<b>'", "'</b>'", "'<>'", "'</>'", "'<b/>'", "'<b>c</b> d <i>e</i>'", '/<b>/', '/<\\/b>/', '/<b>c<\\/b>/', '/* <b>c</b> */', '/* <b> */', '/* </b> */',
  '// <b>c</b>\n', '// <b>\n', '// </b>\n', "'a <b>'", "'</b> a'", '`</b>`', '`<b>`', "'<b>c'", "'c</b>'", "'x // <b>y</b>'", "'x /* <b>y</b> */'", '`<b>\n</b>`', '`a ${b} <i>c</i>`', "'<b x=\"1\">c</b>'", "'<b x={1}>c</b>'",
  '<b>c</b>', '<b>x</b>', '<>c</>', "<b>'</b>", '<b>"</b>', '<b>`</b>'];
const TAG_OPERATORS = [' +', ' ||', ' &&', ' ??', ' ,', ' ?', ' :', ' =', ' (', ' [', '', ' in', ' instanceof', ' -', ' *', ' ==', ' <', ' >'];
const TAG_BREAKS = ['\n', '\r\n', ' ', '\n  // more\n', ' /* c */ ', '\n\n', '\u2028'];
const TAG_DECOYS = [`'</T>;${CALL}//'`, `\`</T>;${CALL};//\``, `/[</T>;${CALL}//]/`, `/[</T>;${CALL}//]/.source`, `\`\n</T>;${CALL}//\``];
const TAG_FRAMES = [
  (value) => `interface I { <T>(x); m(a = ${value}): void }`,
  (value) => `interface I { <T>(x); [${value}]: string }`,
  (value) => `type L = { <T>(x); m(a?: string, b = ${value}): void };`,
  (value) => `interface C { new <T>(x); m(a = ${value}): void }`,
  (value) => `interface I { <T>(x); m: A = ${value} }`,
  (value) => `interface I { <T>(x); <U>(a = ${value}): void }`,
];
function literalTagPages(seed, count) {
  const rng = mulberry32(seed);
  const pages = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    let value = pick(rng, TAG_LITERALS);
    if (chance(rng, 0.3)) value = `f(${value})`;
    if (chance(rng, 0.3)) value = `${pick(rng, ['1', 'x', '(', '['])}${pick(rng, TAG_OPERATORS)} ${value}`;
    value += pick(rng, TAG_OPERATORS) + pick(rng, TAG_BREAKS);
    if (chance(rng, 0.2)) value += `${pick(rng, TAG_LITERALS)}${pick(rng, TAG_OPERATORS)} `;
    value += pick(rng, TAG_DECOYS);
    if (chance(rng, 0.4)) value += pick(rng, [')', ']', ' : 1', '])', ')]']);
    const code = `${pick(rng, TAG_FRAMES)(value)}\n${CALL};\n`;
    if (seen.has(code)) continue;
    seen.add(code);
    pages.push({ code, label: `literal tags / ${JSON.stringify(value)}` });
  }
  return pages;
}

// ─── The text of a nested element, as a soup ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A nested element — or two — whose text is a draw of quotes, back-ticks, comment openers, tags, containers and words, in a default value or a computed name, then an operator and a decoy that holds the closing tag of the head.
// The text is JSX text to a type that reads the element, and code to a reading that does not, and the tags in it may be a tag in one and a token's in the other: what the text opens ends with its element in the one and goes on in
// the other, and the scan must hold the closing tag hidden where either hides it (nestedSoupPages).
const SOUP = ['x', 'y z', "'", '"', '`', '//', '/*', '*/', '<i>', '</i>', '<b/>', '<i/>', '{y}', "'<i>'", "it's", 'https://x.y', '\n', ' ', '&amp;', '(', ')', '[', ']', 'a/b', '/', '</>', '<>', "'a'", '`t`', '"q"', '// c\n', '/* c */', '{z}'];
const SOUP_FRAMES = [
  (value) => `interface I { <T>(x); m(a = ${value}): void }`,
  (value) => `interface I { <T>(x); [${value}]: string }`,
  (value) => `type L = { <T>(x); m(a?: string, b = ${value}): void };`,
  (value) => `interface C { new <T>(x); m(a = ${value}): void }`,
  (value) => `interface I { <T>(x); m: A = ${value} }`,
];
function nestedSoupPages(seed, count) {
  const rng = mulberry32(seed);
  const element = () => {
    const tag = pick(rng, ['b', 'i', 'span', '']);
    const text = Array.from({ length: 1 + Math.floor(rng() * 6) }, () => pick(rng, SOUP)).join(pick(rng, ['', ' ']));
    return tag === '' ? `<>${text}</>` : `<${tag}>${text}</${tag}>`;
  };
  const pages = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    let value = element();
    if (chance(rng, 0.25)) value = `${value}${pick(rng, TAG_OPERATORS)} ${element()}`;
    if (chance(rng, 0.3)) value = `f(${value})`;
    if (chance(rng, 0.3)) value = `${pick(rng, ['1', 'x', '(', '['])}${pick(rng, TAG_OPERATORS)} ${value}`;
    value += pick(rng, TAG_OPERATORS) + pick(rng, TAG_BREAKS);
    if (chance(rng, 0.2)) value += `${pick(rng, ["'a <i>'", '`</i>`', "'</i>'", '/* <i> */'])}${pick(rng, TAG_OPERATORS)} `;
    value += pick(rng, TAG_DECOYS);
    if (chance(rng, 0.4)) value += pick(rng, [')', ']', ' : 1', '])', ')]']);
    const code = `${pick(rng, SOUP_FRAMES)(value)}\n${CALL};\n`;
    if (seen.has(code)) continue;
    seen.add(code);
    pages.push({ code, label: `nested soup / ${JSON.stringify(value)}` });
  }
  return pages;
}

// ─── A nested tag that no element has ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A nested `<b>…</b>` in the text is an element to a reading that takes the head for one, and to a type that reads an element in an expression. To a type it may be anything else: the type arguments of a name (`Array<b>`),
// a comparison (`a<b>c`), the type parameters of a signature (`<b>(y): T`, `<U extends A>(y): T`) or of a method (`m<b>(y)`). The text after its `>` is code there, and what looks like its closing tag is in a string that stands
// before it, so that the quote that ends that string is the start of the next — the one that holds the closing tag of the head and the text of a call. Where the head is an element, the nested closing tag closes the nested
// element, and the quote after it is text: the same page, with the call in the string read as code (nestedCodePages).
const CODE_TAGS = ['b', 'U', 'span', 'A.B', 'in', 'T1'];
const codeLiterals = (tag) => [`'</${tag}>'`, `"</${tag}>"`, `\`</${tag}>\``, `'a </${tag}> b'`, `'<${tag}></${tag}>'`, `'x'`, `'</${tag}>x'`, `\`\n</${tag}>\``];
const CODE_BREAKS = ['', ' ', '\n', '\r\n', ' /* c */ ', ' // c\n', '\u2028', '\n  '];
const CODE_UNIONS = [' |', ' &', ' |\n  ', ' | '];
const CODE_OPERATORS = [' +', ' ||', ' &&', ' ??', ' ,', ' :', ' ?', ' ==', ' in', ' instanceof'];
const CODE_DECOYS = [HOLDING, `\`</T>;${CALL};//\``, `\`\n</T>;${CALL};//\``, `"</T>;${CALL};//"`, `/[</T>;${CALL}//]/`, `/[</T>;${CALL}//]/.source`];
const CODE_FRAMES = [
  (separator, member) => `interface I { <T>(x)${separator}${member} }`,
  (separator, member) => `type L = { <T>(x)${separator}${member} };`,
  (separator, member) => `interface C { new <T>(x)${separator}${member} }`,
  (separator, member) => `declare const v: { <T>(x)${separator}${member} };`,
  (separator, member) => `function f(a: { <T>(x)${separator}${member} }) {}`,
];
function nestedCodePages(seed, count) {
  const rng = mulberry32(seed);
  const pages = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const tag = pick(rng, CODE_TAGS);
    const literal = pick(rng, codeLiterals(tag));
    const decoy = pick(rng, CODE_DECOYS);
    const gap = pick(rng, CODE_BREAKS);
    const operator = pick(rng, CODE_OPERATORS);
    const union = pick(rng, CODE_UNIONS);
    const member = [
      `m: Array<${tag}> =${gap} ${literal}${operator}${gap} ${decoy}`,
      `m: A<${tag}>;${gap} n: ${literal}${union}${gap} ${decoy}`,
      `m: A = a<${tag}>c;${gap} n: ${literal}${union}${gap} ${decoy}`,
      `m(a = x < ${tag} > y, c = ${literal}${operator}${gap} ${decoy}): void`,
      `<${tag}>(y): ${literal};${gap} q: ${decoy}`,
      `<${tag} extends A>(y): ${literal};${gap} q: ${decoy}`,
      `m<${tag}>(y): ${literal};${gap} q: ${decoy}`,
      `m: Array<${tag}>${gap} = f(${literal}, ${decoy})`,
      `m: Array<${tag}> =${gap} [${literal}${operator}${gap} ${decoy}]`,
      `[k: ${literal}]: Array<${tag}>;${gap} q: ${decoy}`,
    ][Math.floor(rng() * 10)];
    const code = `${pick(rng, CODE_FRAMES)(pick(rng, NESTED_SEPARATORS), member)}\n${CALL};\n`;
    if (seen.has(code)) continue;
    seen.add(code);
    pages.push({ code, label: `nested code tag / ${JSON.stringify(member)}` });
  }
  return pages;
}

// ─── Tags that stand in strings ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// After type arguments, a comparison or the type parameters of a signature, the text is code, and a string, a template or a comment that holds tags — a fragment, a tag with an attribute, an element with none, their closing
// tags — holds them as text. The element reading takes them for tags, and a closing tag in the next string cuts that string: the quote that ends it, which the type pairs with the one that opened it, then opens a string, and
// the string that holds the closing tag of the head is read as code. The operands are literals and elements — with an attribute, plain, a fragment — whose text holds quotes, back-ticks, comment openers and tags
// (taggedStringPages); one literal holds the closing tag of the head and the text of a call.
const STRING_PIECES = ['<>', '</>', '<a href="x">', '</a>', '<i d="1">', '</i>', '<b>', '</b>', '<b d>', '<A.B x>', '</A.B>', 'x', ' ', 'it', '<i>', '<U extends A>', '</U>', '<>x</>', '<a href="x">y</a>', '</b></T>', '</T>', '<T>'];
const ELEMENT_TEXTS = ['x', "it's", '"', "'", '`', '// c', '/* c', 'https://x.y', '</i>', '<i>', '<>', '</>', '<a href="x">', '</a>', ' '];
const STRING_OPERATORS = [' +', ' |', ' ||', ' &&', ' ,', ' ?', ' ??'];
const STRING_GAPS = ['', ' ', '\n', ' // c\n'];
const STRING_HEADS = ['m: Array<b> =', 'm: A<b> =', 'm: A = a<b>c +', 'm(a = x < b > y,', 'm<b>(y): void; n =', 'm: A<b>; n: A =', 'm: Array<i> ='];
const STRING_FRAMES = [
  (member) => `interface I { <T>(x); ${member} }`,
  (member) => `type L = { <T>(x); ${member} };`,
  (member) => `interface C { new <T>(x); ${member} }`,
];
function taggedStringPages(seed, count) {
  const rng = mulberry32(seed);
  const stringOf = (withBody) => {
    const quote = pick(rng, ["'", '"', '`']);
    let inner = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(rng, STRING_PIECES)).join(chance(rng, 0.3) ? ' ' : '');
    if (withBody) inner = chance(rng, 0.5) ? `${inner}${HOLDING_BODY}` : `${HOLDING_BODY}${inner}`;
    if (quote === '"') inner = inner.replace(/"/g, '\\"');
    return `${quote}${inner}${quote}`;
  };
  const elementOf = () => {
    const inner = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(rng, ELEMENT_TEXTS)).join('');
    const roll = rng();
    if (roll < 0.35) return `<a href="x">${inner}</a>`;
    if (roll < 0.7) return `<b>${inner}</b>`;
    if (roll < 0.85) return `<>${inner}</>`;
    return `<i d="1">${inner}</i>`;
  };
  const pages = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const operands = 2 + Math.floor(rng() * 3);
    const at = Math.floor(rng() * operands);
    let value = '';
    for (let k = 0; k < operands; k += 1) {
      value += k !== at && chance(rng, 0.25) ? elementOf() : stringOf(k === at);
      if (k < operands - 1) value += pick(rng, STRING_OPERATORS) + pick(rng, STRING_GAPS);
    }
    let member = `${pick(rng, STRING_HEADS)} ${value}`;
    if (member.startsWith('m(a')) member += '): void';
    const code = `${pick(rng, STRING_FRAMES)(member)}\n${CALL};\n`;
    if (seen.has(code)) continue;
    seen.add(code);
    pages.push({ code, label: `tags in strings / ${JSON.stringify(member)}` });
  }
  return pages;
}

// ─── The words of a nested tag ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A tag in the text of a member is an element to one reading of a type, and to another it is code, by the words in it: the type parameters of a signature (`<public U>(y): T`, `<in out U>`, `m<static U>(y)`), the type arguments
// of a name (`Array<keyof X>`), a comparison or a tagged template with type arguments (`x <a in b> y`, `x <typeof U> \`t\``), empty angle brackets after a name, a call or a bracket, or before a parenthesis (`f(x)<>`,
// `a[0]<>`, `<>(y)`, `m<>(y)`). The tags are drawn from every word TypeScript has — keywords, modifiers, operators, names — joined with a name, a dot, a dash or a value, and from the tags that no type has (a word that is given a value,
// a link): where the words say that no type has the tag, the text is JSX text and the page is read exactly, and where one has it, the text after its `>` is code and a string there holds the closing tag. The tag is the whole of the
// vocabulary, not the tags that the lexer's rule already calls code: that is how a rule that is wrong about a word is found (nestedTagPages).
const TAG_NAMES = ['b', 'U', 'span', 'A', 'x', 'in', 'out', 'type', 'of', 'as', 'is', 'async', 'get', 'set'];
function tagShapes(words) {
  const shapes = [];
  for (const word of words) {
    shapes.push({ text: word, name: word }, { text: `${word} U`, name: word }, { text: `U ${word}`, name: 'U' }, { text: `${word} U extends A`, name: word }, { text: `U extends ${word}`, name: 'U' }, { text: `A.${word}`, name: `A.${word}` },
      { text: `${word}.A`, name: `${word}.A` }, { text: `${word}-a`, name: `${word}-a` }, { text: `a-${word}`, name: `a-${word}` }, { text: `${word}="v"`, name: word }, { text: `a ${word}="v"`, name: 'a' }, { text: `${word}={v}`, name: word },
      { text: `a ${word}`, name: 'a' }, { text: `a="v" ${word}`, name: 'a' }, { text: `${word} ${word}`, name: word }, { text: `A.B ${word} x`, name: 'A.B' }, { text: `${word} U = V`, name: word },
      // A line break between a word and its `=`, or before a valued `get` or `set`, makes the tag the members of a type: an initializer that ends at the break, and a member with an initializer of its own. With the `=` on the line
      // of its word the tag is an element's, as prettier writes one.
      { text: `a\n${word}\n="v"`, name: 'a' }, { text: `a ${word}\n="v"`, name: 'a' }, { text: `a\n${word}="v"`, name: 'a' }, { text: `a\r\n${word}\r\n='v'`, name: 'a' }, { text: `a\r${word}\r={v}`, name: 'a' }, { text: `${word}\n="v"`, name: word },
      { text: `A.B\n${word}\n="v"`, name: 'A.B' }, { text: `A.${word}\nx\n="v"`, name: `A.${word}` }, { text: `a\nb\n${word}\n="v"`, name: 'a' }, { text: `a\n${word}="v"\n${word}\n="v"`, name: 'a' }, { text: `a\n  ${word}\n  ="v"\n`, name: 'a' },
      { text: `a\n  ${word}="v"\n  title="t"\n`, name: 'a' }, { text: `a\u2028${word}\u2028="v"`, name: 'a' }, { text: `a\n${word}\u2029="v"`, name: 'a' });
  }
  return shapes;
}
const TAG_ROLES = [
  // The tag as the comparison or the type arguments of an expression, as type arguments of a name in a type, and as the type parameters of a signature or a method: its text, a string that holds its closing tag, then the
  // decoy that holds the closing tag of the head.
  (tag, lit, decoy, gap, op) => `m(p = x <${tag.text}>${gap} ${lit}${op}${gap} ${decoy}): void`,
  (tag, lit, decoy, gap, op) => `m: Array<${tag.text}> =${gap} ${lit}${op}${gap} ${decoy}`,
  (tag, lit, decoy, gap) => `<${tag.text}>(y): ${lit};${gap} q: ${decoy}`,
  (tag, lit, decoy, gap) => `m<${tag.text}>(y): ${lit};${gap} q: ${decoy}`,
  (tag, lit, decoy, gap) => `new <${tag.text}>(y): ${lit};${gap} q: ${decoy}`,
  (tag, lit, decoy, gap, op) => `m: A<${tag.text}>;${gap} n: ${lit}${op}${gap} ${decoy}`,
  (tag, lit, decoy, gap, op) => `m: A = a <${tag.text}> c;${gap} n: ${lit} |${gap} ${decoy}`,
  (tag, lit, decoy, gap, op) => `m(p = x <${tag.text}>\`t\`${op}${gap} ${lit}${op}${gap} ${decoy}): void`,
  // The tag as an element: its text is JSX text, and what stands after its closing tag is read as the code it follows.
  (tag, lit, decoy, gap, op) => `m(p = <${tag.text}>x</${tag.name}>${op}${gap} ${decoy}): void`,
  (tag, lit, decoy, gap, op) => `m(p = <${tag.text}>'x</${tag.name}>${op}${gap} ${lit}${op}${gap} ${decoy}): void`,
  (tag, lit, decoy, gap, op) => `[<${tag.text}>x // y</${tag.name}>${op}${gap} ${decoy}]: string`,
];
const FRAGMENT_OPERANDS = ['f(x)', 'a[0]', 'a!', "'s'", '{}', 'x', '1', 'this', 'f<U>(x)', '(a)', '`t`', '/re/', 'x.y', 'f()', 'a[0][1]', 'async', 'm', '1.', '\u00e9', 'a?.b'];
// What stands between the operand and the fragment: a space, a line break of any kind, a comment — and a line comment, which may end in any character, so that the character before the fragment on the next line is no operand's:
// `f // note:` and a line break, then `<> || …`, is the instantiation expression `f<> || …`.
const FRAGMENT_SEPARATORS = ['', '', '', ' ', '\n', '\r\n', '\r', '\u2028', '\u2029', '\u0085', ' /* c */ ', ' // note:\n', ' // note.\n', ' // note,\n', ' // note -\n', ' // note =\n', ' // note (\n', ' // note\n', ' // note:\r\n', ' // note:\r',
  ' // note:\u2028', ' // note:\u2029', '\n\n  // note:\n  ', ' // c\n// d:\n'];
const FRAGMENT_ROLES = [
  // An empty pair of angle brackets after an operand (the type arguments of an instantiation or of a call), after a name in a type, and before a parenthesis or a back-tick (type parameters, type arguments of a tagged template); a
  // fragment after an operator or a separator is JSX.
  (operand, lit, decoy, gap, op) => `m(p = ${operand}<>${op}${gap} ${lit}${op}${gap} ${decoy}): void`,
  (operand, lit, decoy, gap, op) => `m(p = ${operand}<> ${lit}${op}${gap} ${decoy}): void`,
  (operand, lit, decoy, gap, op) => `m: ${operand}<> =${gap} ${lit}${op}${gap} ${decoy}`,
  (operand, lit, decoy, gap) => `${operand}<>(y): ${lit};${gap} q: ${decoy}`,
  (operand, lit, decoy, gap) => `new ${operand}<>(y): ${lit};${gap} q: ${decoy}`,
  (operand, lit, decoy, gap, op) => `m(p = ${operand} <>\`t\`${op}${gap} ${lit}${op}${gap} ${decoy}): void`,
  (operand, lit, decoy, gap, op) => `m(p = ${operand}${op} <>x // y</>${op}${gap} ${decoy}): void`,
  (operand, lit, decoy, gap) => `m(p = ${operand}, <>x // y</>${gap} + ${decoy}): void`,
  (operand, lit, decoy, gap) => `[${operand}; <>x // y</>${gap} + ${decoy}]: string`,
];
function nestedTagPages(seed, count, keywords) {
  const rng = mulberry32(seed);
  const words = [...new Set([...keywords, ...TAG_NAMES])];
  const shapes = tagShapes(words);
  const pages = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const gap = pick(rng, CODE_BREAKS);
    const operator = pick(rng, CODE_OPERATORS);
    const decoy = pick(rng, CODE_DECOYS);
    let member;
    let what;
    if (chance(rng, 0.25)) {
      const operand = pick(rng, FRAGMENT_OPERANDS) + pick(rng, FRAGMENT_SEPARATORS);
      member = pick(rng, FRAGMENT_ROLES)(operand, "'</>'", decoy, gap, operator);
      what = `fragment after ${JSON.stringify(operand)}`;
    } else {
      const tag = pick(rng, shapes);
      member = pick(rng, TAG_ROLES)(tag, `'</${tag.name}>'`, decoy, gap, operator);
      what = `tag ${JSON.stringify(tag.text)}`;
    }
    const code = `${pick(rng, CODE_FRAMES)(pick(rng, NESTED_SEPARATORS), member)}\n${CALL};\n`;
    if (seen.has(code)) continue;
    seen.add(code);
    pages.push({ code, label: `nested tag words / ${what} / ${JSON.stringify(member)}`, what });
  }
  return pages;
}

// ─── Two nested elements whose text opens a region each ───────────────────────────────────────────────────────────────────────────────────────────────
// Each of two nested elements in a default value, a computed name or an initializer holds a comment opener, a quote or a back-tick in its text, which is JSX text to an element and code to a type: the region that the first
// opens, and the one that the second opens, may end at one place — two `//` comments on one line end at its line break, and a template or a string that one holds may end where the other's does. Every region that is open at the
// closing tag of an element is a place to choose between the two readings of it, told by where it starts, so that two regions with one end are two places (nestedPairPages).
const PAIR_TEXTS = ['//', 'x // y', '/*', 'x /* y', "'", "'x", '"x', '`', '`x', '// y\n', 'x', ''];
const PAIR_TAGS = ['b', 'i', 'span', 'A.B', ''];
const PAIR_JOINS = [' -', ' +', ' ??', ' ||', ' &&', ',', ' ?', ' :', ' ==', ''];
const PAIR_FRAMES = [
  (value) => `interface I { <T>(x); m(a = ${value}): void }`,
  (value) => `interface I { <T>(x); [${value}]: string }`,
  (value) => `type L = { <T>(x); m(a?: string, b = ${value}): void };`,
  (value) => `interface C { new <T>(x); m(a = ${value}): void }`,
  (value) => `interface I { <T>(x); m: A = ${value} }`,
  (value) => `interface I { <T>(x); m(a = [${value}]): void }`,
];
function nestedPairPages(seed, count) {
  const rng = mulberry32(seed);
  const element = () => {
    const tag = pick(rng, PAIR_TAGS);
    const text = pick(rng, PAIR_TEXTS);
    return tag === '' ? `<>${text}</>` : `<${tag}>${text}</${tag}>`;
  };
  const pages = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    let value = element();
    for (let k = 1 + Math.floor(rng() * 2); k > 0; k -= 1) value += `${pick(rng, PAIR_JOINS)}${pick(rng, ['', ' '])}${element()}`;
    if (chance(rng, 0.2)) value = `f(${value})`;
    value += pick(rng, TAG_OPERATORS) + pick(rng, TAG_BREAKS);
    value += pick(rng, TAG_DECOYS);
    if (chance(rng, 0.4)) value += pick(rng, [')', ']', ' : 1', '])', ')]']);
    const code = `${pick(rng, PAIR_FRAMES)(value)}\n${CALL};\n`;
    if (seen.has(code)) continue;
    seen.add(code);
    pages.push({ code, label: `nested pair / ${JSON.stringify(value)}` });
  }
  return pages;
}

// ─── An import type whose `(` stands on a later line ─────────────────────────────────────────────────────────────────────────────────────────────────────
// `typeof import` and `import` have no line-break rule before their `(` (parseImportType), so a line terminator, a space of any kind or a comment may stand between each two of their tokens, where after any other type a `(` at the
// start of a line begins a call signature, whose first parameter a string is not. The string, template, comment or regex that holds the closing tag is the import path or what follows the type (importTypePages).
const IMPORT_LEADS = ['m: ', 'm?: ', 'm(): ', 'readonly m: ', 'm: A | ', 'm: A & ', 'm: keyof ', "'k': ", '[k: string]: ', 'get x(): ', 'new (): ', 'm(p: ', 'static m: ', 'm: A.B | ', 'm: readonly '];
const IMPORT_WORD_GAPS = ['\n', '\r', '\r\n', '\u2028', '\u2029', '\u0085', ' ', ' /* c */ ', ' /*\n*/ ', ' // c\n', '\n  ', '/**/'];
const IMPORT_PAREN_GAPS = ['', ...IMPORT_WORD_GAPS];
const IMPORT_PATHS = ["'./m'", `'${HOLDING_BODY}'`, '"./m"', '`./m`', `\`${HOLDING_BODY}\``, `'./m' /* ${HOLDING_BODY} */`, `"${HOLDING_BODY.replace(/"/g, "'")}"`];
const IMPORT_TAILS = ['', '', '.X', ' | A', ' & B', '[]', '.X.Y', '<A>', ' extends B ? C : D'];
const IMPORT_AFTERS = [`;\n  q: ${HOLDING}`, ` // ${HOLDING_BODY}\n  q: T`, `,\n  q: \`</T>;${CALL};//\``, `\n  q: ${HOLDING}`, ` /* ${HOLDING_BODY} */ q: T`, `;\n  q: /[</T>;${CALL}//]/`, '', ';'];
function importTypePages(seed, count) {
  const rng = mulberry32(seed);
  const pages = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const word = () => pick(rng, IMPORT_WORD_GAPS);
    const gap = () => pick(rng, IMPORT_PAREN_GAPS);
    const form = pick(rng, [`typeof${word()}import${gap()}`, `import${gap()}`, `keyof${word()}typeof${word()}import${gap()}`, `typeof${word()}import${gap()}`, `readonly${word()}typeof${word()}import${gap()}`]);
    const member = `${pick(rng, IMPORT_LEADS)}${form}(${gap()}${pick(rng, IMPORT_PATHS)}${gap()})${pick(rng, IMPORT_TAILS)}${pick(rng, IMPORT_AFTERS)}`;
    const code = `${pick(rng, CODE_FRAMES)(pick(rng, NESTED_SEPARATORS), member)}\n${CALL};\n`;
    if (seen.has(code)) continue;
    seen.add(code);
    pages.push({ code, label: `import type / ${JSON.stringify(member)}` });
  }
  return pages;
}

// ─── An accessor, or another modifier, before a computed name that holds a comma ──────────────────────────────────────────────────────────────────────
// `get [a, /x/]()` is an accessor whose computed name is a comma expression with a regex in it: parseTypeMember tries `get` and `set` before an index signature, and what follows them may be any `[`, on any line. After any other word
// that `[`, a name and a `,` or a `:` are an index signature, and no `/` follows. The regex holds the closing tag and the text of a call (accessorNamePages).
const ACCESSOR_MODIFIERS = ['', '', 'static ', 'readonly ', 'declare ', 'public ', 'private ', 'abstract ', 'override ', 'accessor ', 'async ', 'static readonly ', 'get ', 'set '];
const ACCESSOR_WORDS = ['get', 'set', 'get', 'set', 'static', 'readonly', 'accessor', 'x', 'type', 'of', 'new', 'in', 'default'];
const ACCESSOR_NAMES = ['a', 'this', 'a?', 'A.b', '1', "'x'", 'type', 'get', 'new', 'in', '\u00e9', 'a, b', 'x1'];
const ACCESSOR_COMMAS = [',', ':', '?,', '?:', ',\n', ', // note\n', ': // note\n', ' ,', ', /* c */ ', ', // note:\r\n'];
const ACCESSOR_REGEXES = [`/[${HOLDING_BODY}]/`, `/[</T>;${CALL};\\/\\/]/`, `/[</T>;${CALL}//]/.source`, `/x[</T>;${CALL}//]/`];
const ACCESSOR_TAILS = [']()', '](): string', ']: string', '](v)', ']?: A', ']', '] = 1', '](): A;\n  q: T'];
function accessorNamePages(seed, count) {
  const rng = mulberry32(seed);
  const pages = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const gap = () => pick(rng, IMPORT_PAREN_GAPS);
    const member = `${pick(rng, ACCESSOR_MODIFIERS)}${pick(rng, ACCESSOR_WORDS)}${gap()}[${gap()}${pick(rng, ACCESSOR_NAMES)}${pick(rng, ACCESSOR_COMMAS)}${gap()}${pick(rng, ACCESSOR_REGEXES)}${pick(rng, ACCESSOR_TAILS)}`;
    const code = `${pick(rng, CODE_FRAMES)(pick(rng, NESTED_SEPARATORS), member)}\n${CALL};\n`;
    if (seen.has(code)) continue;
    seen.add(code);
    pages.push({ code, label: `accessor name / ${JSON.stringify(member)}` });
  }
  return pages;
}

module.exports = { numberedMemberPages, nestedTextPages, expressionLinePages, literalTagPages, nestedSoupPages, nestedCodePages, nestedTagPages, nestedPairPages, taggedStringPages, importTypePages, accessorNamePages, NUMBER_NAMES };
