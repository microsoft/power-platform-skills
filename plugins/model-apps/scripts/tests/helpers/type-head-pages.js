'use strict';

// Pages for the type-parameter heads that start like an element's head (source-literals.js, signatureHeadFollows): a modifier run before the name (`<in U>`, `<const in U>`, `<static` LF `U>`), an empty list, a method named `delete`,
// `typeof`, `void` or `instanceof` that has type parameters, after the words that TypeScript's parser takes before a member's name, a decorator or a line break. Each page puts one head in a place where TypeScript reads a signature,
// a method, a function type or an element, with a decoy after it — a string, a template, a comment or a regex that holds the closing tag of the head's name and the text of a navigation call — and then the one real call. A lexer that
// read a head for an element took the closing tag in the decoy for the end of its text and the call after it for code, and rewrote a token that is data.
//
// The programs are drawn from a grammar with a seeded generator, so that a failure names the same page on every run; the sweep that reads them (ambiguity-sweep.test.js) asks TypeScript which are valid and where the real calls are.

const CALL = 'navigateTo({pageType:"generative",pageId:"PAGEREF_detail"})';

const MODIFIERS = ['in', 'out', 'public', 'private', 'protected', 'readonly', 'static', 'abstract', 'async', 'declare', 'override', 'accessor', 'const'];
const OPERATORS = ['delete', 'typeof', 'void', 'instanceof'];
// What may stand before a member's name on its line: the words of MEMBER_PREFIX_WORDS (and the one that only a class takes), a generator's `*`, and decorators in every shape (a class only).
const MEMBER_PREFIXES = ['', '', '', 'readonly ', 'static ', 'public ', 'async ', 'abstract ', 'override ', 'declare ', 'accessor ', 'in ', 'out ', 'export ', 'get ', 'set ', 'const ', 'static async ', 'public static ', '@dec ', '@dec() ', '@a.b ',
  '@(x) ', '@dec<T>() ', 'static *', 'async *', '*'];
const GAPS = [' ', ' ', ' ', '\n', '\r\n', '\u2028', ' /**/ ', '/*\n*/', '\t', '  '];
const NAMES = ['U', 'T', 'out', 'in', 'accessor'];
// What follows the name in a list: a constraint, a default, a string with an escaped quote (which a JSX attribute string reads as ending earlier), a regex for a constraint, a self-closing end.
const TAILS = ['', '', '', ' extends X', ' extends X = Y', ' = string', '="x"', ' = "x"', '="\\">"', "='\\''", ' = "\\""', ' extends />', ' extends /x/', ' extends / />', ' extends A<B>', ' extends { a: string }', ' extends (x: T) => T', ' extends typeof y',
  ' extends keyof T', ', V', ', out V', ', in V = W', ' extends />;x;/', ' extends string="\\">"', ' extends X="\\\\"', ' extends X="\\x3e"', '=`t`', ' extends `a${string}`', ' extends [A, B]', ' extends A | B', ' extends A & B', ' extends -1',
  ' extends 1n', ' extends this'];
const PARAMETERS = ['(y)', '(y: U)', '()', '(y?: U)', '(...a: U[])', '({ a }: { a: U })', '(y: Array<U>)'];
const RETURNS = ['', ': void', ': U', ': Promise<U>'];
const BODIES = ['(y)', '(y); // note', '(y) plain text', '(y), x', '(y);', '(a = f(/)/))', '(y): title', '(y)\n  text\n', '(y); m: string', '(x) => y'];

// The member before one that a line break separates from it, in a type and in a class: each ends in a token that may end a member.
const PREVIOUS_TYPE_MEMBERS = ['n: number', 'n?: string', 'n()', 'n(): void', '[k: string]: T', 'n: A<B>', "n: 'x'", 'n', 'n?', 'n: string[]', 'n: { a: 1 }', 'n: (x: T) => void', 'readonly n', 'n: `t`', 'n<U>(): void', '<U>(y)', 'new <U>(y)', 'n: A | B', 'n: 1'];
const PREVIOUS_CLASS_MEMBERS = [...PREVIOUS_TYPE_MEMBERS, 'n = 1', 'n = x!', 'n = i++', 'n!', 'n = f()', 'n = a[0]', 'n = "s"', 'n = `t`', 'n = /x/', 'n = /x/g', 'n = {}', 'n = [] as A<B>', 'static n = 1', 'n() {}', 'get n() { return 1 }', 'n!: A',
  'n = a ? b : c'];

function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const pick = (list) => list[Math.floor(next() * list.length)];
  const chance = (p) => next() < p;
  return { pick, chance };
}

// The head of a list of type parameters: its text and the name of the tag that an element with the same text would close with.
function headOf({ pick, chance }) {
  if (chance(0.08)) return { text: '<>', name: '' };
  const words = [];
  for (let k = pick([0, 1, 1, 1, 2, 2, 3]); k > 0; k -= 1) words.push(pick(MODIFIERS));
  let text = '<';
  for (const word of words) text += `${word}${chance(0.85) ? ' ' : pick(GAPS)}`;
  text += `${pick(NAMES)}${pick(TAILS)}>`;
  return { text, name: words.length > 0 ? words[0] : text.slice(1).split(/[^A-Za-z0-9_$]/)[0] };
}

// A member that has the head: a call or construct signature, a method, a method named like an operator, after a prefix, with a return type or a body.
function memberOf(head, withBody, { pick }) {
  const parameters = pick(PARAMETERS);
  const returns = pick(RETURNS);
  const body = withBody ? pick([' { return y; }', ' {}', ' { const z = y; return z; }']) : pick([';', '', ',', ';\n  m: string;', '\n  m: string']);
  const kinds = [
    () => `${pick(MEMBER_PREFIXES)}${pick(OPERATORS)}${head.text}${parameters}${returns}${body}`,
    () => `${pick(MEMBER_PREFIXES)}m${head.text}${parameters}${returns}${body}`,
    () => `${head.text}${parameters}${returns}${body}`,
    () => `new ${head.text}${parameters}${returns}${body}`,
    () => `${pick(MEMBER_PREFIXES)}${pick(OPERATORS)} ${head.text}${parameters}${returns}${body}`,
    () => `${pick(OPERATORS)}?${head.text}${parameters}${returns}${body}`,
  ];
  return pick(kinds)();
}

const MEMBER_PLACES = ['interface', 'type literal', 'class', 'declared class', 'abstract class', 'object literal', 'class expression', 'after a member', 'after a line', 'after a method body'];
function placeMember(member, place) {
  switch (place) {
    case 'interface': return `interface I { ${member} }`;
    case 'type literal': return `type L = { ${member} };`;
    case 'class': return `class C { ${member} }`;
    case 'declared class': return `declare class C { ${member} }`;
    case 'abstract class': return `abstract class C { ${member} }`;
    case 'object literal': return `const o = { ${member.replace(/;\s*$/, '')} };`;
    case 'class expression': return `const K = class { ${member} };`;
    case 'after a member': return `interface I { n: number; ${member} }`;
    case 'after a line': return `interface I {\n  n: number\n  ${member}\n}`;
    case 'after a method body': return `class C { m() {} ${member} }`;
    default: throw new Error(place);
  }
}

// Where a function type stands: after a `:` in an annotation, after an `=>`, a `(`, a `[`, a `=` — where no member begins, and a type may.
function functionTypeOf(head, { pick }) {
  const type = `${head.text}${pick(['(y: U)', '(y)', '()', '(...a: U[])', '(y: U, z?: V)'])} => ${pick(['void', 'U', 'Promise<U>'])}`;
  const places = [
    () => `interface I { cb: ${type}; }`, () => `interface I { cb?: ${type}; }`, () => `type L = { cb: ${type} };`, () => `let x: ${type};`, () => `type F = ${type};`, () => `type F = () => ${type};`, () => `function f(a: ${type}) {}`,
    () => `const g = (cb: ${type}) => 1;`, () => `type T = [${type}];`, () => `type T = (${type})[];`, () => `interface I { m(cb: ${type}): void }`, () => `type G<T = ${type}> = T;`, () => `class C { cb: ${type} = null as any; }`,
    () => `declare const d: { cb: ${type} };`, () => `let y: A<${type}>;`, () => `type U2 = A | (${type});`,
  ];
  return pick(places)();
}

// An element that has the head: its text starts with a parenthesis, in every place an expression stands, after an operator and across a line break.
function elementOf(head, { pick }) {
  const element = `${head.text}${pick(BODIES)}</${head.name}>`;
  const places = [
    () => `const e = ${element};`, () => `f(${element});`, () => `const a = [${element}];`, () => `const e = c ? 0 : ${element};`, () => `const o = { p: ${element} };`, () => `const e = () => ${element};`, () => `function g() { return ${element}; }`,
    () => `const e = (0, ${element});`, () => `${element};`, () => `const e = ${pick(OPERATORS)} ${element};`, () => `x;\n${pick(OPERATORS)} ${element};`, () => `const e =\n${pick(OPERATORS)} ${element};`,
    () => `const e = a ${pick(['+', '&&', '||', '??', '*', '-'])}\n${pick(OPERATORS)} ${element};`,
  ];
  return pick(places)();
}

function decoyOf(name, { pick }) {
  const closing = `</${name}>`;
  return pick([
    `const note = '${closing};${CALL};//';`, `const note = "${closing};${CALL};//";`, `const note = \`${closing};${CALL};//\`;`, `/* ${closing};${CALL}; */`, `// ${closing};${CALL};`, `const re = /[${closing};${CALL}]/;`,
    `const note = '${closing}};${CALL};//';`,
  ]);
}

// What a class or an object literal may hold right after a method's body: a comment, and in a class a property that a string or a template is the value of. Each has the closing tag of the head's name and a call, which are data to the type
// and the text of an element and a call to a lexer that reads the head for an element.
function afterBodyOf(name, place, { pick }) {
  const closing = `</${name}>`;
  const comments = [`// note ${closing} ${CALL}\n`, `/* ${closing} ${CALL} */`, `/* c */ // ${closing} ${CALL}\n`];
  if (place === 'object literal') return pick(comments);
  return pick([...comments, `x = '${closing} ${CALL}';`, `x = "${closing} ${CALL}";`, `x = \`${closing} ${CALL}\`;`]);
}

// `count` pages, each { code, label }: a head in a place, a decoy and the one real call. Families: a member of a type or a class (with a prefix, a return type or a body), a member after a line break, a function type, an element.
function* typeHeadPages(seed, count) {
  const random = generator(seed);
  const { pick, chance } = random;
  for (let n = 0; n < count; n += 1) {
    const head = headOf(random);
    const tail = `\n${decoyOf(head.name || 'x', random)}\n${CALL};\n`;
    const family = pick(['member', 'member', 'member', 'type', 'type', 'element', 'line', 'line']);
    if (family === 'line') {
      const withBody = chance(0.5);
      const previous = pick(withBody ? PREVIOUS_CLASS_MEMBERS : PREVIOUS_TYPE_MEMBERS);
      const separator = pick(['\n', '\n  ', '\r\n', ' /* c */\n', '\n\n', ' // c\n', '\u2028']);
      const member = memberOf(head, withBody, random);
      yield { family: 'after a line', code: `${withBody ? 'class C' : 'interface I'} { ${previous}${separator}${member} }${tail}`, label: `after a line / ${previous} / ${member}` };
    } else if (family === 'member') {
      const place = pick(MEMBER_PLACES);
      const hasBody = ['class', 'object literal', 'class expression', 'after a method body'].includes(place);
      let member = memberOf(head, hasBody, random);
      let name = place;
      if (hasBody && chance(0.4)) {
        member = `${member} ${afterBodyOf(head.name || 'x', place, random)}`;
        name = `${place} and a decoy after the body`;
      }
      yield { family: name, code: `${placeMember(member, place)}${tail}`, label: `${name} / ${member}` };
    } else if (family === 'type') {
      yield { family: 'function type', code: `${functionTypeOf(head, random)}${tail}`, label: `function type / ${head.text}` };
    } else {
      yield { family: 'element', code: `${elementOf(head, random)}${tail}`, label: `element / ${head.text}` };
    }
  }
}

// The newline corpus: an element after a unary word, in a place that wants an expression, with every kind of line break or comment between the place's token and the word. A member of a type cannot begin after the
// `=`, `=>`, `:`, `(`, `[`, prefix `!`, `+`, `&&`, conditional `?` and property `:` that stand there, so the element is the only reading, wherever the line break is.
const NEWLINE_GAPS = [' ', '\n', '\r\n', '\u2028', '\u2029', '/**/', '/*\n*/', '// note\n'];
const NEWLINE_PLACES = [
  ['an initializer', (g, s) => `const e =${g}${s};`], ['a conditional alternative', (g, s) => `const e = true ? 0 :${g}${s};`], ['an arrow body', (g, s) => `const e = () =>${g}${s};`], ['an argument', (g, s) => `f(${g}${s});`],
  ['an array element', (g, s) => `const e = [${g}${s}];`], ['an operand of !', (g, s) => `const e = !${g}${s};`], ['the right side of +', (g, s) => `const e = x +${g}${s};`], ['the right side of &&', (g, s) => `const e = x &&${g}${s};`],
  ['a conditional consequent', (g, s) => `const e = x ?${g}${s} : y;`], ['a property value', (g, s) => `const e = {key:${g}${s}};`],
];
const NEWLINE_ELEMENTS = ['<span>(value); // note</span>', '<span>(value) text</span>', '<span>(value)</span>', '<span>(x = f(/)/))</span>', '<>(value); // note</>', '<public U>(value); // note</public>'];
function* newlinePages() {
  for (const [place, wrap] of NEWLINE_PLACES) {
    for (const gap of NEWLINE_GAPS) {
      for (const word of ['void', 'typeof', 'delete']) {
        for (const element of NEWLINE_ELEMENTS) yield { code: `${wrap(gap, `${word} ${element}`)}\n${CALL};\nexport default function Page(){return null;}`, label: `${place} / ${JSON.stringify(gap)} / ${word} / ${element}` };
      }
    }
  }
}

module.exports = { typeHeadPages, newlinePages, MODIFIERS, OPERATORS, MEMBER_PREFIXES, MEMBER_PLACES, NEWLINE_GAPS, NEWLINE_PLACES, NEWLINE_ELEMENTS, CALL };
