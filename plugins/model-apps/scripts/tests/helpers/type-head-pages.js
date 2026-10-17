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
// What may stand before a member's name on its line: the words of MEMBER_PREFIX_WORDS (and the one that only a class takes), a generator's `*`, and decorators in every shape (a class only) — a decorator may end in the `>` of type arguments
// (`@dec<T>`, which the parser takes for an instantiation expression when a binary operator follows it — a generator's `*`, `instanceof`, a field named `in` that a line break ends — or a line break does) and in a number's decimal point (`@1.`).
const MEMBER_PREFIXES = ['', '', '', 'readonly ', 'static ', 'public ', 'async ', 'abstract ', 'override ', 'declare ', 'accessor ', 'in ', 'out ', 'export ', 'get ', 'set ', 'const ', 'static async ', 'public static ', '@dec ', '@dec() ', '@a.b ',
  '@(x) ', '@dec<T>() ', 'static *', 'async *', '*', '@dec<T> ', '@dec<T> *', '@a.b<T> *', '@dec<A, B> *', '@dec<T>\n  ', '@dec<T> in\n  ', '@dec<T> instanceof\n  ', '@1. *', '@1.\n  *', '@\u00a01. *', '@\u2028 1.\n  *', '@/*x*/1. *'];
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

// An element after a word that takes an operand and a line break: `const e = void` and a line break, then `void <span>(value); // note</span>`. The word before the break is an operator, and the element is its operand's, so the page is read exactly
// in every place that holds statements — the body of a function or a method, a block. Where the braces may be those of a class, an object literal or a type — the block of an arrow function, which a function type's object type cannot be told from, and the
// value of an arrow function in an object literal — a line break after `await` may end a field that the identifier initialises, and a method named `void` may follow (`class C { a = await` and a line break, then `void<span>(value)…`): the lexer does not
// know the function is async, so a closing tag that a comment may hold is a guess. The real call is after the function.
const KEYWORD_PREFIXES = ['void', 'typeof', 'delete', 'await', 'a in', 'a instanceof'];
const KEYWORD_LINE_PLACES = [
  ['an async function', (s) => `async function f(){ const e = ${s}; }`], ['an async method', (s) => `class C { async m() { const e = ${s}; } }`], ['an async function expression', (s) => `const f = async function () { const e = ${s}; };`],
  ['a block in an async function', (s) => `async function f(){ if (a) { const e = ${s}; } }`], ['an else block', (s) => `async function f(){ if (a) { b; } else { const e = ${s}; } }`], ['a try block', (s) => `async function f(){ try { const e = ${s}; } catch { g(); } }`],
  ['a method of an object literal', (s) => `const o = { async m() { const e = ${s}; } };`], ['a call in an async function', (s) => `async function f(){ g(a, ${s}); }`], ['a class that extends a call', (s) => `class C extends mixin(A) { async m() { const e = ${s}; } }`],
  ['the block of an async arrow', (s) => `const f = async () => { const e = ${s}; };`], ['the value of an async arrow in an object', (s) => `const o = { f: async () => ${s} };`],
];
function* keywordLinePages() {
  for (const [place, wrap] of KEYWORD_LINE_PLACES) {
    // The first place has every kind of line break and every element, the others the three that differ.
    const first = place === KEYWORD_LINE_PLACES[0][0];
    for (const prefix of KEYWORD_PREFIXES) {
      for (const gap of first ? NEWLINE_GAPS : ['\n', '\r\n', '/*\n*/']) {
        for (const word of ['void', 'typeof', 'delete']) {
          for (const element of first ? NEWLINE_ELEMENTS : NEWLINE_ELEMENTS.slice(0, 2)) {
            yield { code: `${wrap(`${prefix}${gap}${word} ${element}`)}\nfunction openDetail(){${CALL};}\nexport default function Page(){return null;}\n`, label: `${place} / ${prefix} / ${JSON.stringify(gap)} / ${word} / ${element}` };
          }
        }
      }
    }
  }
}

// An element after a word, and an `@` earlier on the statement: in the arguments of a decorator, a field initializer, a method body, and a field after them. A member may begin where a decorator ends, and not in the expression that its arguments hold.
const DECORATED_PLACES = [
  ['an argument', (s) => `class C { @decorate(${s}) method() {} }`], ['an argument of a class decorator', (s) => `@decorate(${s}) class C {}`], ['a field initializer', (s) => `class C { @decorate element = ${s}; }`], ['a method body', (s) => `class C { @decorate method() { const e = ${s}; } }`],
  ['an arrow in an argument', (s) => `class C { @decorate(() => ${s}) method() {} }`], ['a later argument', (s) => `class C { @decorate(a, ${s}) method() {} }`], ['a nested call', (s) => `class C { @decorate(f(a, ${s})) method() {} }`],
  ['an array argument', (s) => `class C { @decorate([a, ${s}]) method() {} }`], ['an object argument', (s) => `class C { @decorate({ a: ${s} }) method() {} }`], ['the default of a parameter', (s) => `class C { @decorate method(a = ${s}) {} }`],
  ['a static field', (s) => `class C { @decorate static element = ${s}; }`], ['a later field', (s) => `class C { @decorate x = 1; element = ${s}; }`], ['a field after a decorated method', (s) => `class C { @decorate method() {} element = ${s}; }`],
  ['a modifier and a decorator', (s) => `class C { @decorate static method() { return [${s}]; } }`], ['no decorator', (s) => `class C { method() { const e = ${s}; } }`],
  // The body of a method is a block, where the statement that `return` and a line break ends is certain.
  ['the value of a return', (s) => `class C { @decorate method() { return ${s}; } }`],
  // The block of an arrow function may be a function type's object type, and a member named `return` may stand in it: after `return` and a line break the statement may have ended, and the page is a guess.
  ['the value of a return in an arrow', (s) => `class C { @decorate method = () => { return ${s}; } }`],
];
function* decoratedPages() {
  for (const [place, wrap] of DECORATED_PLACES) {
    for (const gap of NEWLINE_GAPS) {
      for (const word of ['void', 'typeof', 'delete']) {
        for (const element of NEWLINE_ELEMENTS) yield { code: `${wrap(`${gap}${word} ${element}`)}\nfunction openDetail(){${CALL};}\nexport default function Page(){return null;}\n`, label: `${place} / ${JSON.stringify(gap)} / ${word} / ${element}` };
      }
    }
  }
}

// A decorator that ends in the `>` of type arguments or in a number's decimal point, and a member named like an operator that has type parameters right after it. A decorator is an `@` and a left-hand-side expression, and the parser takes `@dec<T>` for an instantiation
// expression when a binary operator follows its `>` — a generator's `*`, the name `instanceof`, a field named `in` — or a line break does (canFollowTypeArgumentsInExpression, https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/parser.ts); `1.` is a number of its
// own. The member begins where the decorator ends, so the method is code and the note after it, which holds the closing tag of its type parameter and a call, is data.
const DECORATOR_ENDS = [
  '@dec<T>', '@dec<A, B>', '@a.b<T>', '@(d)<T>', '@dec<() => void>', '@dec<(x: A) => B>', '@dec<{ a: 1 }>', '@dec<Array<string>>', '@dec<"s">', '@dec<1>', '@dec<T>()<U>', '@dec<T> /* c */', '@dec<T> // c\n', '@1.', '@1_0.',
  // What ended a decorator before, and a `>` that no decorator ends in.
  '@dec', '@a.b', '@dec()', '@dec<T>()', '@(x)', '@dec!', '@1', '@1.5', "@'x'", '@dec`x`', '@dec(a > b)',
];
const DECORATOR_FOLLOWERS = [
  { text: (w) => ` *${w}<U>(y: U): MARK { yield y; }` }, { text: (w) => ` * ${w}<U>(y: U): MARK { yield y; }` }, { text: (w) => `\n  *${w}<U>(y: U): MARK { yield y; }` }, { text: (w) => ` *\n  ${w}<U>(y: U): MARK { yield y; }` },
  { text: (w) => ` ${w}<U>(y: U): MARK {}` }, { text: (w) => `\n  ${w}<U>(y: U): MARK {}` }, { text: (w) => ` in\n  ${w}<U>(y: U): MARK {}` }, { text: (w) => ` instanceof\n  ${w}<U>(y: U): MARK {}` }, { text: (w) => ` in\n  *${w}<U>(y: U): MARK { yield y; }` },
  { text: (w) => ` in = 1;\n  ${w}<U>(y: U): MARK {}` }, { text: () => ' instanceof<U>(y: U): MARK {}', words: ['instanceof'] }, { text: () => ' instanceof /* c */ <U>(y: U): MARK {}', words: ['instanceof'] },
];
const DECORATOR_FRAMES = [(m) => `class C { ${m} }`, (m) => `const K = class { ${m} };`, (m) => `class C extends B { ${m} }`, (m) => `class C { x = 1; ${m} }`, (m) => `function f() { return class C { ${m} }; }`];
function* decoratorEndPages() {
  for (const decorator of DECORATOR_ENDS) {
    for (const { text, words = ['delete', 'void'] } of DECORATOR_FOLLOWERS) {
      for (const word of words) {
        for (const [f, frame] of DECORATOR_FRAMES.entries()) {
          yield { code: `function openDetail(){${CALL};}\n${frame(`${decorator}${text(word)}`)}\nconst note = '</U>};${CALL};//';\nexport default function Page(){return null;}\n`, label: `${JSON.stringify(decorator)} / ${JSON.stringify(text(word))} / frame ${f}` };
        }
      }
    }
  }
}

// What stands before a number that ends in a decimal point: right after the `@` of a decorator, or after the `=` of a field's initializer. TypeScript's scanner skips every character of `isWhiteSpaceSingleLine` and `isLineBreak`
// between two tokens (https://github.com/microsoft/TypeScript/blob/v5.8.3/src/compiler/scanner.ts) — the ASCII ones, the next-line character U+0085, the no-break space, the ogham space mark, U+2000–U+200B, the line and paragraph separators, U+202F, U+205F, the
// ideographic space and the byte order mark — and a comment is trivia too. A number is not the end of a name or of another number where one of them stands before its digits, whatever it is: a test asks the parser for every character that it skips.
const NUMBER_GAPS = ['', ' ', '\t', '\v', '\f', '\n', '\r', '\r\n', '\u0085', '\u00a0', '\u1680', ...Array.from({ length: 12 }, (unused, k) => String.fromCharCode(0x2000 + k)), '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', '/*x*/', '/*\u2028*/', '// c\n'];
const DECIMAL_NUMBERS = ['1.', '1_000.'];
// The text as a JSON string with every character beyond ASCII written as an escape, so that a label names the character that a page puts where it is: a no-break space and a zero-width space print the same.
const escapedText = (text) => JSON.stringify(text).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
// A decorator that is a number ending in a decimal point, with each gap between its `@` and its digits, and a field that such a number initialises, with each gap before it and each line break after it: the member after either begins where the number ends, so the method is
// code and the note after it, with the closing tag of its type parameter and a call, is data.
function* decimalPointPages() {
  const page = (member) => `function openDetail(){${CALL};}\n${member}\nconst note = '</U>};${CALL};//';\nexport default function Page(){return null;}\n`;
  for (const gap of NUMBER_GAPS) {
    for (const number of DECIMAL_NUMBERS) {
      for (const [f, frame] of DECORATOR_FRAMES.slice(0, 2).entries()) {
        for (const { text, words = ['delete'] } of DECORATOR_FOLLOWERS) {
          for (const word of words) yield { code: page(frame(`@${gap}${number}${text(word)}`)), label: `a decorator / ${escapedText(gap)} / ${number} / ${escapedText(text(word))} / frame ${f}` };
        }
        // The white space after the number too: the member begins after whatever stands between the number and a generator's `*`.
        const after = `${gap}*delete<U>(y: U): MARK { yield y; }`;
        yield { code: page(frame(`@${number}${after}`)), label: `a decorator / ${escapedText('')} / ${number} / ${escapedText(after)} / frame ${f}` };
        for (const word of ['delete', 'typeof']) {
          for (const lineBreak of ['\n', '\r\n', '\u2028', '\u2029']) yield { code: page(frame(`a =${gap}${number}${lineBreak}${word}<U>(y: U): MARK {}`)), label: `a field / ${escapedText(gap)} / ${number} / ${word} / ${escapedText(lineBreak)} / frame ${f}` };
        }
      }
    }
  }
}

// A method, a function or a property that a heritage keyword names (`class C { implements() { … } }`, `{ extends() { … } }`), and a value that one of them spells, or that a letter beyond ASCII or a private name makes (`{ a: café, m() { … } }`, `{ a: this.#item, m() { … } }`).
// The word before the `(` of `class C extends (B) {` or `class C implements (B) {` is the keyword of a heritage clause, whose braces hold members; here it is a name, and the braces after the `)` are the body of a function, whose statements an element may start: an element
// after `void` there is read for certain. A comma before such a name is an object literal's, and the heritage list that a comma may belong to (`class C extends A, B() {`) is read back to the keyword that begins it, through whatever it holds.
const KEYWORD_NAMES = ['implements', 'extends', 'new', 'ordinary'];
// What the braces after the `)` hold: an element after `void`, and one after `return`, whose text has a comment that could hide the closing tag, so that braces that may hold members are a guess.
const KEYWORD_BODIES = ['void <span>(MARK); // note</span>;', 'x;\nvoid <span>(MARK); // note</span>;', 'return <>(MARK); // note</>;', 'const e = <in U>(MARK); // note</in>;', 'return <span>(MARK) // detail</span>;', 'return <>(MARK) // details</>;'];
// A class expression that is complete where it stands, as the value of a property or as an initializer: its own head — its `class`, its name, its type parameters, its `extends` and `implements` clauses — is read back from the comma or the name after it, and is no heritage of
// what follows. Each also stands in parentheses, which the reading crosses as one bracket.
const CLASS_VALUES = [
  'class {}', 'class extends Base {}', 'class Named {}', 'class Named<T> extends Base<T> implements I {}', 'class C implements D {}', 'class extends mixin(A) {}', 'class extends (B) {}', 'class implements A, B() {}', 'class { m() {} }', 'class { a = 1; static b() { return 1; } }',
  'class extends a.b.C<T> {}', 'class extends Base<{ a: 1 }> {}', 'class extends A, B {}', 'class \u00e9 extends B {}', 'class Named<T extends { a: 1 }> {}', 'class<T> {}', 'class implements {}', 'class interface {}', 'class extends Base implements I, J<K> {}', '@dec class {}',
  // The white space and the comments that stand inside a class and after it: every character that the scanner skips between two tokens.
  'class\u00a0extends\u2028Base\u3000{}', 'class /* c */ extends /* d */ Base /* e */ {}', 'class\nextends\nBase\n{}', 'class\ufeffNamed\u200b{}\u0085',
];
const CLASS_VALUES_WRAPPED = [...CLASS_VALUES, ...CLASS_VALUES.map((value) => `(${value})`)];
const KEYWORD_METHOD_FRAMES = [
  ['a method of a class', (n, b) => `class C { ${n}() { ${b} } }`], ['a method after a method', (n, b) => `class C { a() {} ${n}() { ${b} } }`], ['a method after a field', (n, b) => `class C { a = 1; ${n}() { ${b} } }`],
  ['a method after a field and a line break', (n, b) => `class C { a = 1\n  ${n}() { ${b} } }`], ['a method after a name and a line break', (n, b) => `class C { a\n  ${n}() { ${b} } }`], ['a method after a name and a comment', (n, b) => `class C { a /* c */\n  ${n}() { ${b} } }`],
  // A field that a keyword names and no initializer or `;` ends, then a method on the next line: the word before the method's name is the name of a field, no keyword (`new` is read as it was: the operator).
  ['a method after a field that the keyword names', (n, b) => (n === 'new' ? null : `class C { ${n}\n  m() { ${b} } }`)],
  ['a static method', (n, b) => `class C { static ${n}() { ${b} } }`], ['an async method', (n, b) => `class C { async ${n}() { ${b} } }`], ['a getter', (n, b) => `class C { get ${n}() { ${b} } }`], ['a setter', (n, b) => `class C { set ${n}(v) { ${b} } }`],
  ['a generator', (n, b) => `class C { *${n}() { ${b} } }`], ['an async generator', (n, b) => `class C { async *${n}() { ${b} } }`], ['a decorated method', (n, b) => `class C { @d ${n}() { ${b} } }`], ['a public method', (n, b) => `class C { public ${n}() { ${b} } }`],
  ['a method of a class that extends a name', (n, b) => `class C extends B { ${n}() { ${b} } }`], ['a method of a class that extends a call', (n, b) => `class C extends mixin(A) { ${n}() { ${b} } }`], ['a method of a class that implements a name', (n, b) => `class C implements I { ${n}() { ${b} } }`],
  ['a method of a class that implements a call', (n, b) => `class C implements B() { ${n}() { ${b} } }`], ['a method of a class that implements a parenthesis', (n, b) => `class C implements (B) { ${n}() { ${b} } }`],
  ['a method of a class that extends a parenthesis', (n, b) => `class C extends (B) { ${n}() { ${b} } }`], ['a method of a class with type parameters', (n, b) => `class C<T> extends B<T> implements I { ${n}() { ${b} } }`],
  ['a method of a class expression', (n, b) => `const K = class { ${n}() { ${b} } };`], ['a method of a class in a function', (n, b) => `function f() { class C { ${n}() { ${b} } } }`],
  ['a method of an object literal', (n, b) => `const o = { ${n}() { ${b} } };`], ['a method after a property', (n, b) => `const o = { a: 1, ${n}() { ${b} } };`], ['a method after a shorthand property', (n, b) => `const o = { a, ${n}() { ${b} } };`],
  ['a method after a method', (n, b) => `const o = { a() {}, ${n}() { ${b} } };`], ['a method after a spread', (n, b) => `const o = { ...s, ${n}() { ${b} } };`], ['a generator after a property', (n, b) => `const o = { a: 1, *${n}() { ${b} } };`],
  ['an async method after a property', (n, b) => `const o = { a: 1, async ${n}() { ${b} } };`], ['a getter after a property', (n, b) => `const o = { a: 1, get ${n}() { ${b} } };`], ['a method of an object literal that an argument is', (n, b) => `f({ a: 1, ${n}() { ${b} } });`],
  ['a method of an object literal that a function returns', (n, b) => `function g() { return { ${n}() { ${b} } }; }`], ['a method of an object literal after a comma', (n, b) => `const v = (0, { ${n}() { ${b} } });`],
  ['a function', (n, b) => `function ${n}() { ${b} }`], ['a function expression', (n, b) => `const f = function ${n}() { ${b} };`], ['a generator function', (n, b) => `function* ${n}() { ${b} }`], ['a method after a class', (n, b) => `class D {}\nconst o = { ${n}() { ${b} } };`],
  // A class that is complete before the name — the value of a property, the initializer of a field, a declaration that no `;` ends — leaves its own head behind it: its `class`, and the `extends` or `implements` that it was read back to, are not the keyword of
  // the braces after the name.
  ...CLASS_VALUES_WRAPPED.map((value) => [`a method after the class value ${value}`, (n, b) => `const o = { a: ${value}, ${n}() { ${b} } };`]),
  ['a method after a class value and a property', (n, b) => `const o = { a: class extends B {}, b: 1, ${n}() { ${b} } };`], ['a method after two class values', (n, b) => `const o = { a: class {}, b: class extends B {}, ${n}() { ${b} } };`],
  ['a generator after a class value', (n, b) => `const o = { a: class extends B {}, *${n}() { ${b} } };`], ['an async method after a class value', (n, b) => `const o = { a: class extends B {}, async ${n}() { ${b} } };`],
  ['a method after a class value in an argument', (n, b) => `f({ a: class extends B {}, ${n}() { ${b} } });`], ['a method after a class value in a class', (n, b) => `class H { make() { return { a: class extends B {}, ${n}() { ${b} } }; } }`],
  ['a method after a field that a class initialises', (n, b) => `class H { a = class {}\n  ${n}() { ${b} } }`], ['a method after a static field that a class initialises', (n, b) => `class H { static a = class extends B {}\n  ${n}() { ${b} } }`],
  ['a function after a class', (n, b) => `class D {}\nfunction ${n}() { ${b} }`], ['a function after a class that extends a name', (n, b) => `class D extends B {}\nfunction ${n}() { ${b} }`], ['a function after a class that implements a name', (n, b) => `class D implements I {}\nfunction ${n}() { ${b} }`],
  ['a function after a class that extends a call', (n, b) => `class D extends mixin(A) {}\nfunction ${n}() { ${b} }`], ['a function after a class whose list ends in a call', (n, b) => `class D implements A, B() {}\nfunction ${n}() { ${b} }`],
  ['a function after a class with type parameters', (n, b) => `class D<T> extends B<T> implements I {}\nfunction ${n}() { ${b} }`], ['a function after an abstract class', (n, b) => `abstract class D {}\nfunction ${n}() { ${b} }`],
  ['a function after an exported class', (n, b) => `export default class {}\nfunction ${n}() { ${b} }`], ['a function after a decorated class', (n, b) => `@dec class D {}\nfunction ${n}() { ${b} }`],
  ['a function after an interface', (n, b) => `interface D {}\nfunction ${n}() { ${b} }`], ['a function after an interface that extends names', (n, b) => `interface D extends A, B {}\nfunction ${n}() { ${b} }`],
  ['a function after a class expression', (n, b) => `const K = class extends B {}\nfunction ${n}() { ${b} }`], ['a function after a class and a comment', (n, b) => `class D {} // note\nfunction ${n}() { ${b} }`],
];
// A value or a name before a method, in the braces of an object literal after a comma: what a letter beyond ASCII, a private name, a word that a heritage keyword spells or a class expression makes of the comma's left side. Each is read to the `:` or the `{` that tells an object
// literal's comma from a heritage list's, and the method after the comma is a function's head. (A private name stands in a class; the `class`, `extends` and `implements` of a class that is complete before the comma are not those of a list that the comma ends.)
const OBJECT_VALUES = [
  'café', '名', 'a?.café', 'f(café)', '[café]', '{ café: 1 }', 'café.b', '"café"', '`x${café}y`', 'x as typeof café', 'café!', '(café)', '1 + café', 'café ? 1 : 2', 'café || 2', '() => café', 'café => 1', 'new Café()', 'x.café', 'x.名',
  'this.#item', 'this.#item.x', 'this?.#item', '(this.#item)', 'f(this.#item)', '#item in this', 'this.#item!',
  'implements', 'x.implements', 'x.extends', 'implements.x', 'implements(1)', 'typeof implements', '!implements', 'implements + 1', '[implements]', '{ implements: 1 }', 'implements ? 1 : 2', 'x => implements', '(implements)', 'f(implements)',
  // A class expression, complete, with its own `class`, `extends` and `implements` behind the comma.
  ...CLASS_VALUES_WRAPPED,
];
const OBJECT_VALUE_FRAMES = [
  ['a property', (v, b) => `class H { #item = 1; make() { return { a: ${v}, m() { ${b} } }; } }`], ['two properties', (v, b) => `class H { #item = 1; make() { return { a: ${v}, b: ${v}, m() { ${b} } }; } }`],
  ['a property and a method before it', (v, b) => `class H { #item = 1; make() { return { a: ${v}, n() {}, m() { ${b} } }; } }`], ['a computed key', (v, b) => `class H { #item = 1; make() { return { [k]: ${v}, m() { ${b} } }; } }`],
  ['a quoted key', (v, b) => `class H { #item = 1; make() { return { 'k': ${v}, m() { ${b} } }; } }`], ['an argument', (v, b) => `class H { #item = 1; make() { f({ a: ${v}, m() { ${b} } }); } }`],
  ['a getter', (v, b) => `class H { #item = 1; make() { return { a: ${v}, get m() { ${b} } }; } }`], ['an async method', (v, b) => `class H { #item = 1; make() { return { a: ${v}, async m() { ${b} } }; } }`],
  ['a generator', (v, b) => `class H { #item = 1; make() { return { a: ${v}, *m() { ${b} } }; } }`], ['no class', (v, b) => `const o = { a: ${v}, m() { ${b} } };`],
];
// A name for a shorthand property, a spread and a method name: the same words and letters.
const SHORTHAND_NAMES = ['café', '名', 'implements', 'a'];
const SHORTHAND_FRAMES = [
  ['a shorthand property', (v, b) => `const o = { ${v}, m() { ${b} } };`], ['a shorthand property after a property', (v, b) => `const o = { a: 1, ${v}, m() { ${b} } };`], ['two shorthand properties', (v, b) => `const o = { ${v}, ${v}2, m() { ${b} } };`],
  ['a spread', (v, b) => `const o = { ...${v}, m() { ${b} } };`], ['a shorthand property before a method', (v, b) => `const o = { ${v}, n() {}, m() { ${b} } };`],
];
function* keywordNamedPages() {
  const real = `function openDetail(){${CALL};}\n`;
  const tail = '\nexport default function Page(){return null;}\n';
  // The text of the element holds a token that is data (a bare token: the braces of a call would be an expression of the element).
  const withData = (body) => body.replace('MARK', 'PAGEREF_detail');
  for (const [place, frame] of KEYWORD_METHOD_FRAMES) {
    for (const name of KEYWORD_NAMES) {
      for (const body of KEYWORD_BODIES) {
        const text = frame(name, withData(body));
        if (text !== null) yield { code: `${real}${text}${tail}`, label: `${place} / ${name} / ${JSON.stringify(body)}`, family: 'a method named like a keyword' };
      }
    }
  }
  for (const [place, frame] of OBJECT_VALUE_FRAMES) {
    for (const value of OBJECT_VALUES) {
      for (const body of KEYWORD_BODIES) yield { code: `${real}${frame(value, withData(body))}${tail}`, label: `${place} / ${JSON.stringify(value)} / ${JSON.stringify(body)}`, family: 'a value before a method' };
    }
  }
  for (const [place, frame] of SHORTHAND_FRAMES) {
    for (const name of SHORTHAND_NAMES) {
      for (const body of KEYWORD_BODIES) yield { code: `${real}${frame(name, withData(body))}${tail}`, label: `${place} / ${name} / ${JSON.stringify(body)}`, family: 'a shorthand property before a method' };
    }
  }
}

// A function type whose head starts like an element's and whose parameter list cannot be read to its end: a template with a template or a comment in a substitution, a regex after a call in a default, a list longer than the window. The list is no
// less a function type for that — an arrow follows it — and a lexer that took the head for an element read the closing tag in the note after the type for its own.
const UNREADABLE_LISTS = [
  ['a template inside a substitution', '(value: `${`prefix`}`)'], ['a comment inside a substitution', '(value: `${/* note */ string}`)'], ['a comment after a type in a substitution', '(value: `${string /* note */}`)'],
  ['a regex after a call in a default', '(x = f(/[)]/))'], ['a regex in parentheses in a default', '(x = (/[)]/))'], ['a template in a template in a default', '(x = `${`)`}`)'],
  ['a list longer than the window', `(${Array.from({ length: 260 }, (unused, k) => `p${k}: string`).join(', ')})`],
];
const UNREADABLE_HEADS = ['<in U>', '<out U>', '<public U>', '<const in U>', '<>', '<U>', '<const U>'];
const UNREADABLE_PLACES = [
  (t) => `interface I { callback: ${t}; }`, (t) => `interface I { callback?: ${t}; }`, (t) => `type L = { callback: ${t} };`, (t) => `let v: ${t};`, (t) => `function f(a: ${t}) {}`, (t) => `interface I { m(cb: ${t}): void }`, (t) => `type F = () => ${t};`, (t) => `type T = [${t}];`,
  (t) => `type T = (${t})[];`, (t) => `type G<T = ${t}> = T;`, (t) => `class C { callback: ${t} = null as any; }`,
];
function* unreadableListPages() {
  for (const head of UNREADABLE_HEADS) {
    const closing = (/^<\s*([A-Za-z]+)/.exec(head) || [null, ''])[1];
    for (const [k, place] of UNREADABLE_PLACES.entries()) {
      for (const [what, list] of UNREADABLE_LISTS) {
        yield { code: `function openDetail(){${CALL};}\n${place(`${head}${list} => void`)}\nconst note = '</${closing}>};${CALL};//';\nexport default function Page(){return null;}\n`, label: `place ${k} / ${head} / ${what}` };
      }
    }
  }
}

// A type parameter written with a Unicode escape (`\u0054` is `T`), in a method named like an operator, a method and a signature, in every kind of type and a class. TypeScript reads the word it spells; an element has no escape in a tag or attribute name.
const ESCAPED_HEADS = [[String.raw`<\u0054>`, 'T'], [String.raw`<\u{54}>`, 'T'], [String.raw`<T\u0031>`, 'T'], [String.raw`<\u0054wo>`, 'T'], [String.raw`<in \u0054>`, 'in'], [String.raw`<public \u0054>`, 'public'], [String.raw`<const \u0054>`, 'const'],
  ['<static\n\\u0054>', 'static'],
  // A keyword spelled with an escape is TS1260 to the parser, which reads it as the keyword all the same: no page that builds has one, and it is refused like the rest.
  [String.raw`<\u0069n U>`, 'in'], [String.raw`<T \u0065xtends X>`, 'T']];
const ESCAPE_PLACES = [['an interface', (m) => `interface Api { ${m}; }`], ['a type literal', (m) => `type Api = { ${m} };`], ['a class', (m) => `class Api { ${m} {} }`], ['an object literal', (m) => `const api = { ${m} {} };`],
  // After a heritage that ends in a call after a comma or `implements`: the braces hold members there too.
  ['an interface that extends a call after a comma', (m) => `interface Api extends A, B() { ${m}; }`], ['a class that implements a call', (m) => `class Api implements B() { ${m} {} }`],
  ['a class that extends a call after a comma', (m) => `class Api extends A, B() { ${m} {} }`], ['a class that implements a call after a comma', (m) => `class Api implements A, ns.B() { ${m} {} }`]];
const ESCAPE_GAPS = ['', ' ', '\n', '/**/', '/*\n*/'];
function* escapedHeadPages() {
  for (const [head, closing] of ESCAPED_HEADS) {
    for (const [place, wrap] of ESCAPE_PLACES) {
      for (const name of [...OPERATORS, 'm']) {
        for (const gap of ESCAPE_GAPS) {
          // An object literal has a property with no gap before the list: `delete` and a line break, then `<T>()`, is two members there, which a comma would have to separate.
          if (place === 'an object literal' && gap !== '') continue;
          yield { code: `function openDetail(){${CALL};}\n${wrap(`${name}${gap}${head}(): void`)}\nconst note = '</${closing}>};${CALL};//';\nexport default function Page(){return null;}\n`, label: `${place} / ${name}${JSON.stringify(gap)}${head}` };
        }
      }
    }
  }
}

// A method named like an operator that has type parameters, in the braces that follow every token that a lexer may take for the opener of a block: the braces of a class after every heritage that ends in a `)` (`class C extends mixin(A) {`), after a name that a keyword
// of a block spells (`class C extends a.else {`) or one written with an escape, a `$` or a letter beyond ASCII, those of an object literal after a `;` of a `for` head or a `{`, and those of a type literal after an `=>`. The method is the member there, and
// the closing tag of its type parameter is in the string after the type: a lexer that took the braces for a block read the method for an element, whose text ran on to that closing tag and held the call in the string.
// The element that ends a heritage list in a `)`: a call or a parenthesis, whatever it holds, after `implements`, after `extends A,` and after any other comma — the parser reads it as it reads any left-hand-side expression, so the braces after it hold members.
const LAST_ELEMENTS = ['f(A)', '(A)', 'import("x")', 'this.f(A)', '(A as any)', 'f(A)(B)', 'a.b.f(A)', '(f)(A)', 'new F(A)', 'f<T>(A)', 'a?.b(A)', 'a!.b(A)', 'a[0](A)', 'f(A).g(B)', 'async(A)', 'get(A)', 'f((A))', 'f(() => A)', 'f({ a: 1 })', 'f(function () {})',
  'f(A, B)', 'f()', 'implements(A)', 'extends(A)', 'f(caf\u00e9)'];
const HERITAGE_INTRODUCERS = ['class C implements ', 'class C extends A, ', 'class C extends A implements ', 'class C implements A, ', 'class C extends A implements I, ', 'abstract class C implements ', 'class C<T> extends A<T> implements ', 'const K = class implements '];
const LAST_ELEMENT_HERITAGES = HERITAGE_INTRODUCERS.flatMap((introducer) => LAST_ELEMENTS.map((element) => `${introducer}${element}`));
const CLASS_HERITAGES = [
  'class C', 'class C extends B', 'class C extends mixin(A)', 'class C extends (B)', 'class C extends a.b.mixin(A)', 'class C extends new X()', 'class C extends new (X)', 'class C extends new X', 'class C extends f(A)(B)', 'class C extends f(A).g(B)',
  'class C extends a?.b(c)', 'class C extends a!.b(c)', 'class C extends a[0](c)', 'class C extends f<T>(c)', 'class C extends async(c)', 'class C extends import("x")', 'class C extends this.f(c)', 'class C extends (cond ? A : B)', 'class C extends class {}',
  'class C extends function () {}', 'class C extends {}', 'class C extends a.else', 'class C extends a.try', 'class C extends a.do', 'class C extends a.catch', 'class C extends a.finally', 'class C extends \u00e9else', 'class C extends else1', 'class C extends _do',
  'class C<T> extends B<T> implements I', 'class C extends mixin<T>(A)', 'class C extends (B as any)', 'class C extends mixin(function () { return A; })', 'class C extends function f(a) {}.bind(x)', 'class C extends a.static', 'class C extends static', 'class static',
  'class $', 'class C extends $', 'class C extends mixin($)', 'class C extends \u00e9a(A)', 'class C extends a.\u00e9b(A)', String.raw`class C extends \u0061(A)`, String.raw`class C extends a.\u0062(A)`, 'abstract class C', 'abstract class C extends mixin(A)',
  'class C extends A\n', 'class C extends mixin(A)\n', '@dec() class C', '@dec class C extends mixin(A)',
  // A heritage clause is a list, and the parser reads each element as a left-hand-side expression (parseExpressionWithTypeArguments): a call or a parenthesis stands after `implements` and after a comma as it does after `extends`, and the checker
  // alone objects (TS2500, and TS1174 for a second base class). The braces after such a `)` hold members.
  'class C implements B()', 'class C implements (B)', 'class C implements A, B()', 'class C extends A, B()', 'class C extends A implements B()', 'class C extends A implements I, B()', 'class C implements ns.B()', 'class C implements A, ns.B()', 'class C extends A, ns.B()',
  'class C implements A<T>, B()', 'class C implements A, B(c, d)', 'class C implements A(x, y), B()', 'class C implements A,\n  B()', 'class C implements A, /* c */ B()', 'class C implements A, B(), D()', 'class C implements A, $()', 'class C implements A, B()\n',
  'abstract class C implements A, B()', 'export class C implements A, B()', '@dec class C implements B()', 'declare class C implements A, B()', 'class C implements "x", B()', String.raw`class C implements A, \u0042()`, String.raw`class C implements A, a.\u0062()`,
  // What stays as it was: a parenthesis, a `new` and an unread callee after a comma.
  'class C implements A, (B)', 'class C extends A, (B)', 'class C extends A, new B()', 'class C implements A, B<T>()', 'class C extends A, a?.b(c)', 'class C extends A, B.C().d()', 'class C<T> extends A<T>, B() implements I',
  // A letter beyond ASCII in a name of the list, which the comma is read back through, and the word that begins the list in other heads.
  'class C implements A, caf\u00e9()', 'class C extends caf\u00e9, B()', 'class C extends A, B(), caf\u00e9()', 'class C<T> implements (B)', 'abstract class C implements (B)', 'class C implements caf\u00e9, (B)', 'const K = class extends A, B()', 'class C extends implements, B()', 'class C extends A, implements, B()',
  // A class expression among the elements: its own head and braces stand between the keyword and the call, and are one element. The list that the braces after the call end is the outer class's, whatever words the inner class has.
  'class C extends class {}, B()', 'class C extends class {} implements (B)', 'class C extends class {} implements A, B()', 'class C implements A, class {}, B()', 'class C implements class {}, B()', 'class C extends class D extends E {} implements (B)', 'class C extends class D extends E {}, B()',
  'class C extends class extends mixin(A) {}, B()', 'class C extends class { m() {} }, B()', 'class C extends class D implements E, F() {}, G()', 'class C extends class {} implements class {}, B()', 'class C extends function () {}, B()', 'class C implements function () {}, class {}, B()',
  'class C extends class {}.x, B()', 'class C implements A, class<T> {}, B()', 'class C extends class Named<T> extends Base<T> implements I {}, B()', 'class C extends class implements {} implements (B)', 'class C implements class extends B {}, class extends D {}, E()', 'const K = class extends class {}, B()',
  'class C extends class { a = class {}; } implements (B)', '@dec class C extends class {}, B()', 'class C extends class {} implements A<{ a: 1 }>, B()', 'class C implements new @d class {}, B()', 'class C extends A, new @d(1) class {}, B()', 'class C extends new @a.b @c class {} implements (B)',
  // Braces after `extends`, `implements` or a comma are an object literal's, one element of the list, and no class's body.
  'class C extends {}, B()', 'class C implements {}, B()', 'class C extends { a: 1 }, B()', 'class C extends A implements {}, B()', 'class C extends A, {}, B()', 'class C implements A, { a: 1, m() {} }, B()', 'class C extends {}.x, B()', 'class C extends [{}], B()',
  // Each of the elements that ends a list in a `)`, after `implements`, after a comma and after both keywords: the braces after it hold members (the sweep reads a part of them in every wrap).
  ...LAST_ELEMENT_HERITAGES,
];
const CLASS_CONTAINER_WRAPS = [(c) => c, (c) => `export ${c}`, (c) => `function f() { ${c} }`, (c) => `if (a) { b; } else { ${c} }`, (c) => `a(b)\n${c}`, (c) => `async () => { ${c} }`];
// The same for an interface, which names its bases after `extends` (and, to the parser, after `implements`, which only the checker refuses).
const INTERFACE_HERITAGES = [
  'interface I extends J', 'interface I extends A, B()', 'interface I extends B()', 'interface I extends A<T>, B()', 'interface I extends A, ns.B()', 'interface I extends A, B(), C()', 'interface I extends B(),\n  C()', 'interface I extends A, /* c */ B()', 'interface I extends A, B(x, y)',
  'interface I extends A(x, y), B()', 'interface I implements B()', 'interface I implements A, B()', 'export interface I extends A, B()', 'declare interface I extends A, B()', 'interface I<T> extends A<T>, B()', 'interface I extends A, B()\n',
  // What stays as it was: a parenthesis after a comma, and an unread callee.
  'interface I extends A, (B)', 'interface I extends A, B<T>()', 'interface I extends A, a?.b()',
  // A call, a parenthesis, an import, `this.f(A)` and a cast after `extends` and after a comma, and after `implements`, which only the checker refuses.
  'interface I extends f(A)', 'interface I extends (A)', 'interface I extends A, f(B)', 'interface I extends A, import("x")', 'interface I extends A, this.f(B)', 'interface I extends A, (B as any)', 'interface I implements f(A)', 'interface I implements (A)',
  'interface I<T> extends A<T>, f(B)', 'interface I extends A, f(B), g(C)', 'interface I extends A, caf\u00e9()', 'interface I extends caf\u00e9, B()', 'interface I extends A, class {}, B()', 'interface I extends A, new @d class {}, B()', 'interface I extends class D extends E {}, B()',
];
const OBJECT_CONTAINER_WRAPS = [
  (m) => `const o = { ${m} };`, (m) => `f({ ${m} });`, (m) => `function g() { return { ${m} }; }`, (m) => `x = [{ ${m} }];`, (m) => `for (let i = 0;; { ${m} }) {}`, (m) => `for (let i = 0; i < 1; { ${m} }) {}`, (m) => `for (const x of [{ ${m} }]) {}`,
  (m) => `({ ${m} });`, (m) => `a ? { ${m} } : b;`, (m) => `const s = \`\${{ ${m} }}\`;`, (m) => `const e = <div style={{ ${m} }} />;`, (m) => `const h = () => ({ ${m} });`, (m) => `function k(a = { ${m} }) {}`, (m) => `new Foo({ ${m} });`,
  (m) => `export default { ${m} };`, (m) => `switch (a) { case 1: ({ ${m} }); }`, (m) => `a;\n({ ${m} })`, (m) => `{ const q = { ${m} }; }`, (m) => `const o = { a: { ${m} } };`, (m) => `class K { static p = { ${m} }; }`, (m) => `class K { m() { return { ${m} }; } }`,
  (m) => `for (;;) { for (;; { ${m} }) {} }`,
];
const TYPE_CONTAINER_WRAPS = [
  (m) => `interface I { ${m} }`, (m) => `interface I extends J { ${m} }`, (m) => `type T = { ${m} };`, (m) => `type T = A & { ${m} };`, (m) => `function f(a: { ${m} }) {}`, (m) => `let x: { ${m} };`, (m) => `f<{ ${m} }>();`, (m) => `const f = (a: { ${m} }) => a;`,
  (m) => `function f(): { ${m} } { return null as any; }`, (m) => `class K { p: { ${m} }; }`, (m) => `type F = () => { ${m} };`, (m) => `let f: (a) => { ${m} };`, (m) => `function f(a: () => { ${m} }) {}`, (m) => `const g = (): { ${m} } => null as any;`,
  (m) => `type G = new () => { ${m} };`, (m) => `interface I { p: () => { ${m} } }`,
  ...INTERFACE_HERITAGES.map((heritage) => (m) => `${heritage} { ${m} }`),
];
function* containerPages() {
  const page = (code, label) => ({ code: `function openDetail(){${CALL};}\n${code}\nconst note = '</U>};${CALL};//';\nexport default function Page(){return null;}\n`, label });
  // A method whose list starts on the line after its name may be a method or the name and an element (the guess `generic`, after `void`): it is in the pages to show that it is never read wrong.
  // The heritages that LAST_ELEMENT_HERITAGES make (more than a hundred) are read plain, in two wraps: the others stand in every kind of member and every wrap.
  const generated = new Set(LAST_ELEMENT_HERITAGES);
  for (const heritage of CLASS_HERITAGES) {
    const escaped = heritage.includes('\\') ? ' / an escape' : '';
    for (const name of ['delete', 'void']) {
      for (const [kind, member] of [['plain', `${name}<U>(y: U): T {}`], ['a line break before the list', `${name}\n<U>(y: U): T {}`], ['after a field that await initialises', `a = await\n${name}<U>(y: U): T {}`]]) {
        if (generated.has(heritage) && kind !== 'plain') continue;
        for (const [w, wrap] of CLASS_CONTAINER_WRAPS.entries()) {
          if (generated.has(heritage) && w !== 0 && w !== 2) continue;
          yield page(wrap(`${heritage} { ${member} }`), `${JSON.stringify(heritage)}${escaped} / ${name} / ${kind} / wrap ${w}`);
          // No white space between the heritage and its braces: `class ${ … }` is a class named `$`.
          if (kind === 'plain') yield page(wrap(`${heritage.replace(/\n$/, '')}{ ${member} }`), `${JSON.stringify(heritage)}${escaped} with no space / ${name} / wrap ${w}`);
        }
      }
    }
  }
  for (const name of OPERATORS) {
    for (const [kind, member] of [['plain', `${name}<U>(y: U): T {}`], ['a line break before the list', `${name}\n<U>(y: U): T {}`], ['after a property', `x: 1,\n${name}<U>(y: U): T {}`]]) {
      for (const [w, wrap] of OBJECT_CONTAINER_WRAPS.entries()) yield page(wrap(member), `an object literal ${w} / ${name} / ${kind}`);
    }
    for (const [kind, member] of [['plain', `${name}<U>(y: U): T;`], ['a line break before the list', `${name}\n<U>(y: U): T;`], ['after a member', `a: void\n${name}<U>(y: U): T`]]) {
      for (const [w, wrap] of TYPE_CONTAINER_WRAPS.entries()) yield page(wrap(member), `a type ${w} / ${name} / ${kind}`);
    }
  }
}

// A seeded grammar of nested braces, parentheses and brackets. The innermost payload is a method named like an operator that has type parameters (a member of a class, an object literal or a type) or an element after one of the words that take
// an operand — in an expression, after a line break or not — and it is wrapped in up to four frames. A frame holds statements, expressions or members, and is a statement or an expression itself: a function, a class, an object literal, a call, an
// array, a template, a JSX container, the head of a `for`. TypeScript says which pages parse and what each payload is; a lexer that took the braces of a class for a block read the method for an element, and one that took the braces of a block
// for a class's read the element for a method.
const NEST_FRAMES = [
  // Statements inside, a statement.
  ['stmt', 'stmt', 'function f() { __X__ }'], ['stmt', 'stmt', 'async function f() { __X__ }'], ['stmt', 'stmt', 'function* g() { __X__ }'], ['stmt', 'stmt', 'if (a) { __X__ }'], ['stmt', 'stmt', 'if (a) { b; } else { __X__ }'], ['stmt', 'stmt', '{ __X__ }'],
  ['stmt', 'stmt', 'for (;;) { __X__ }'], ['stmt', 'stmt', 'for (const k of v) { __X__ }'], ['stmt', 'stmt', 'while (a) { __X__ }'], ['stmt', 'stmt', 'do { __X__ } while (a);'], ['stmt', 'stmt', 'try { __X__ } catch { }'], ['stmt', 'stmt', 'try { } catch (e) { __X__ }'],
  ['stmt', 'stmt', 'try { } finally { __X__ }'], ['stmt', 'stmt', 'switch (a) { case 1: __X__ }'], ['stmt', 'stmt', 'l: { __X__ }'], ['stmt', 'stmt', 'class C { m() { __X__ } }'], ['stmt', 'stmt', 'class C extends mixin(A) { m() { __X__ } }'],
  ['stmt', 'stmt', 'class C { constructor(a) { __X__ } }'], ['stmt', 'stmt', 'class C { get x() { __X__ } }'], ['stmt', 'stmt', 'class C { static { __X__ } }'], ['stmt', 'stmt', 'class C { async m() { __X__ } }'], ['stmt', 'stmt', 'a;\n{ __X__ }'],
  ['stmt', 'stmt', 'const f = () => { __X__ };'], ['stmt', 'stmt', 'const f = async () => { __X__ };'], ['stmt', 'stmt', 'const f = function () { __X__ };'], ['stmt', 'stmt', 'const o = { m() { __X__ } };'], ['stmt', 'stmt', 'const o = { async m() { __X__ } };'],
  // A method after another member of an object literal has a comma before its name, which a heritage clause that ends in a call has too (`class C implements A, B() { … }`): the first braces hold statements and the second members.
  ['stmt', 'stmt', 'const o = { a: 1, m() { __X__ } };'], ['stmt', 'stmt', 'const o = { a, b() {}, m() { __X__ } };'], ['stmt', 'stmt', 'class C implements A, B() { m() { __X__ } }'], ['stmt', 'stmt', 'class C extends A, B() { m() { __X__ } }'],
  // A method, a function or a property that a heritage keyword names has the body of a function; and what stands before the comma of an object literal — a name with a letter beyond ASCII, a private name, a word that a heritage keyword spells — is no heritage list's.
  ['stmt', 'stmt', 'class C { implements() { __X__ } }'], ['stmt', 'stmt', 'class C { extends() { __X__ } }'], ['stmt', 'stmt', 'class C { static implements() { __X__ } }'], ['stmt', 'stmt', 'class C { a = 1\n  implements() { __X__ } }'], ['stmt', 'stmt', 'const o = { implements() { __X__ } };'],
  ['stmt', 'stmt', 'const o = { a: 1, implements() { __X__ } };'], ['stmt', 'stmt', 'const o = { a: caf\u00e9, m() { __X__ } };'], ['stmt', 'stmt', 'const o = { a: implements, m() { __X__ } };'], ['stmt', 'stmt', 'const o = { implements, m() { __X__ } };'],
  ['stmt', 'stmt', 'class H { #x = 1; f() { return { a: this.#x, m() { __X__ } }; } }'], ['stmt', 'stmt', 'function implements() { __X__ }'], ['stmt', 'stmt', 'class C implements (B) { implements() { __X__ } }'], ['stmt', 'stmt', 'class C extends (B) { extends() { __X__ } }'],
  // A class that is complete before the name or the comma — the value of a property, the initializer of a field, a declaration that no `;` ends — leaves its own `class`, `extends` and `implements` behind, and they are no heritage of the braces after the call.
  ['stmt', 'stmt', 'const o = { a: class extends B {}, m() { __X__ } };'], ['stmt', 'stmt', 'const o = { a: class {}, implements() { __X__ } };'], ['stmt', 'stmt', 'const o = { a: class Named<T> extends Base<T> implements I {}, m() { __X__ } };'],
  ['stmt', 'stmt', 'const o = { a: (class extends B {}), m() { __X__ } };'], ['stmt', 'stmt', 'class Q {}\nfunction implements() { __X__ }'], ['stmt', 'stmt', 'interface Q {}\nfunction implements() { __X__ }'], ['stmt', 'stmt', 'class Q extends mixin(A) {}\nfunction f() { __X__ }'],
  ['stmt', 'stmt', 'class H { a = class {}\n  implements() { __X__ } }'], ['stmt', 'stmt', 'class H { static a = class extends B {}\n  extends() { __X__ } }'],
  // Statements inside, an expression.
  ['stmt', 'expr', '(function () { __X__ })'], ['stmt', 'expr', '(() => { __X__ })'], ['stmt', 'expr', '(async () => { __X__ })'], ['stmt', 'expr', '({ m() { __X__ } })'], ['stmt', 'expr', '({ get x() { __X__ } })'], ['stmt', 'expr', '(class { m() { __X__ } })'],
  ['stmt', 'expr', '({ a: 1, m() { __X__ } })'], ['stmt', 'expr', '({ a: caf\u00e9, m() { __X__ } })'], ['stmt', 'expr', '({ implements() { __X__ } })'], ['stmt', 'expr', '({ a: class extends B {}, m() { __X__ } })'],
  ['stmt', 'expr', '(class extends mixin(A) { m() { __X__ } })'], ['stmt', 'expr', '(function* () { __X__ })'], ['stmt', 'expr', '(class { static { __X__ } })'],
  // An expression inside, a statement.
  ['expr', 'stmt', 'f(__X__);'], ['expr', 'stmt', '[__X__];'], ['expr', 'stmt', '(__X__);'], ['expr', 'stmt', 'const e = __X__;'], ['expr', 'stmt', 'a ? __X__ : b;'], ['expr', 'stmt', 'const o = { k: __X__ };'], ['expr', 'stmt', 'const h = () => __X__;'],
  ['expr', 'stmt', 'const t = `${__X__}`;'], ['expr', 'stmt', 'const e = <div a={__X__} />;'], ['expr', 'stmt', 'const e = <div>{__X__}</div>;'], ['expr', 'stmt', 'function g() { return __X__; }'], ['expr', 'stmt', 'x = __X__;'], ['expr', 'stmt', 'for (__X__;;) {}'],
  ['expr', 'stmt', 'for (;; __X__) {}'], ['expr', 'stmt', '@dec(__X__) class C {}'], ['expr', 'stmt', 'class C { p = __X__; }'], ['expr', 'stmt', 'class C { @dec(__X__) m() {} }'], ['expr', 'stmt', 'a || __X__;'], ['expr', 'stmt', 'new F(__X__);'],
  ['expr', 'stmt', 'async function f() { await __X__; }'], ['expr', 'stmt', 'function f(a = __X__) {}'], ['expr', 'stmt', 'class C { m(a = __X__) {} }'], ['expr', 'stmt', 'const f = (a = __X__) => a;'], ['expr', 'stmt', 'const o = { [__X__]: 1 };'],
  // An expression inside, an expression.
  ['expr', 'expr', 'f(__X__)'], ['expr', 'expr', '[__X__]'], ['expr', 'expr', '(__X__)'], ['expr', 'expr', 'a ? __X__ : b'], ['expr', 'expr', '({ k: __X__ })'], ['expr', 'expr', '(() => __X__)'], ['expr', 'expr', '`${__X__}`'], ['expr', 'expr', '<div a={__X__} />'],
  ['expr', 'expr', '(a = __X__)'], ['expr', 'expr', 'a || __X__'], ['expr', 'expr', '(0, __X__)'], ['expr', 'expr', '[...__X__]'], ['expr', 'expr', '(class { p = __X__; })'], ['expr', 'expr', '(async () => await __X__)'],
  // Members inside: the braces of a class, an interface, a type literal and an object literal.
  ['member', 'stmt', 'class C { __X__ }'], ['member', 'stmt', 'class C extends B { __X__ }'], ['member', 'stmt', 'class C extends mixin(A) { __X__ }'], ['member', 'stmt', 'class C extends (B) { __X__ }'], ['member', 'stmt', 'class C extends new X() { __X__ }'],
  ['member', 'stmt', 'class C extends a.else { __X__ }'], ['member', 'stmt', 'abstract class C { __X__ }'], ['member', 'stmt', 'declare class C { __X__ }'], ['member', 'stmt', 'class C<T> extends B<T> implements I { __X__ }'], ['member', 'stmt', 'class C extends f(A)(B) { __X__ }'],
  ['member', 'stmt', 'interface I { __X__ }'], ['member', 'stmt', 'type T = { __X__ };'], ['member', 'stmt', 'let x: { __X__ };'], ['member', 'stmt', 'type F = () => { __X__ };'], ['member', 'stmt', 'const o = { __X__ };'],
  ['member', 'stmt', 'class C implements B() { __X__ }'], ['member', 'stmt', 'class C implements A, B() { __X__ }'], ['member', 'stmt', 'class C extends A, B() { __X__ }'], ['member', 'stmt', 'class C extends A implements B() { __X__ }'], ['member', 'stmt', 'interface I extends A, B() { __X__ }'],
  ['member', 'stmt', 'interface I extends B() { __X__ }'],
  ['member', 'stmt', 'class C implements (B) { __X__ }'], ['member', 'stmt', 'class C extends A implements (B) { __X__ }'], ['member', 'stmt', 'class C implements (A as any) { __X__ }'], ['member', 'stmt', 'class C<T> implements (B) { __X__ }'], ['member', 'stmt', 'class C implements import("x") { __X__ }'],
  ['member', 'stmt', 'class C implements this.f(A) { __X__ }'], ['member', 'stmt', 'class C implements A, caf\u00e9() { __X__ }'], ['member', 'stmt', 'interface I extends A, f(B) { __X__ }'], ['member', 'stmt', 'interface I extends A, import("x") { __X__ }'],
  ['member', 'expr', '(class extends (B) { __X__ })'], ['member', 'expr', '(class extends A implements (B) { __X__ })'],
  // A class expression among the elements of a list: the braces after the call are the outer class's, whatever its own head has.
  ['member', 'stmt', 'class C extends class {} { __X__ }'], ['member', 'stmt', 'class C extends class {}, B() { __X__ }'], ['member', 'stmt', 'class C extends class {} implements (B) { __X__ }'], ['member', 'stmt', 'class C implements A, class {}, B() { __X__ }'],
  ['member', 'stmt', 'class C extends class D extends E {} implements (B) { __X__ }'], ['member', 'stmt', 'class C extends class Named<T> extends Base<T> {}, B() { __X__ }'], ['member', 'stmt', 'class C extends function () {}, B() { __X__ }'],
  ['member', 'expr', '(class extends class {}, B() { __X__ })'],
  ['member', 'expr', '({ __X__ })'], ['member', 'expr', '(class { __X__ })'], ['member', 'expr', '(class extends mixin(A) { __X__ })'],
];
// What stands before the payload member, by the kind of the braces: a member that a separator or a line break ends.
const NEST_MEMBER_BEFORE = { body: ['', '', '', 'static ', 'async ', 'get a() { return 1; }\n', 'a = await\n', 'a = 1;\n', 'x;\n', '@dec ', 'a: 1,\n', 'a() {},\n', '*', 'readonly ', '@dec<T> *', '@dec<T> in\n', '@dec<T> instanceof\n', '@1. *', 'a = 1\n', 'a\n',
  // A decimal point that ends a number, after white space that is not ASCII.
  '@\u00a01. *', '@\u2028 1.\n', 'a =\u00a01.\n', 'a =\u3000 1.\n'], signature: ['', '', 'a: void\n', 'a: string;\n', 'a(): void\n', 'readonly ', 'a?: T,\n'] };
const NEST_PRECEDING_WORDS = ['', '', 'void', 'typeof', 'delete', 'await', 'a in', 'a instanceof', 'x ? 1 :', 'a &&', 'a ||'];
function* nestedBracePages(seed, count) {
  const { pick, chance } = generator(seed);
  const framesHolding = (kind) => NEST_FRAMES.filter(([holds]) => holds === kind);
  for (let n = 0; n < count; n += 1) {
    const holds = pick(['stmt', 'expr', 'expr', 'member', 'member']);
    let [, is, text] = pick(framesHolding(holds));
    let payload;
    let name;
    if (holds === 'member') {
      name = pick(OPERATORS);
      const signature = /^(?:interface|type |let |abstract|declare)/.test(text) || /=> \{ __X__ \}/.test(text);
      const kind = signature ? 'signature' : 'body';
      payload = `${pick(NEST_MEMBER_BEFORE[kind])}${name}${chance(0.15) ? ' ' : ''}<U>(y: U): MARK${signature ? (chance(0.5) ? ';' : '') : ' {}'}`;
    } else {
      name = pick(['void', 'typeof', 'delete']);
      const before = pick(NEST_PRECEDING_WORDS);
      const element = pick(NEWLINE_ELEMENTS);
      const expression = `${before ? `${before}${pick([' ', '\n', '\r\n', '/*\n*/'])}` : ''}${name} ${element}`;
      payload = holds === 'stmt' ? pick([`const e = ${expression};`, `${expression};`]) : expression;
    }
    let code = text.replace('__X__', () => payload);
    const chain = [text];
    let kind = is;
    for (let depth = pick([0, 1, 1, 2, 3]); depth > 0; depth -= 1) {
      const [, outer, wrap] = pick(framesHolding(kind));
      code = wrap.replace('__X__', () => code);
      chain.push(wrap);
      kind = outer;
    }
    if (kind === 'expr') code = `const top = ${code};`;
    yield { code: `function openDetail(){${CALL};}\n${code}\nconst note = '</U>};${CALL};//';\nexport default function Page(){return null;}\n`, label: `${chain.join(' < ')} / ${JSON.stringify(payload)}`, holds, name };
  }
}

module.exports = { typeHeadPages, newlinePages, keywordLinePages, decoratedPages, decoratorEndPages, decimalPointPages, keywordNamedPages, unreadableListPages, escapedHeadPages, containerPages, nestedBracePages, MODIFIERS, OPERATORS, MEMBER_PREFIXES, MEMBER_PLACES, NEWLINE_GAPS, NEWLINE_PLACES, NEWLINE_ELEMENTS, KEYWORD_LINE_PLACES,
  DECORATED_PLACES, DECORATOR_ENDS, DECORATOR_FOLLOWERS, DECORATOR_FRAMES, NUMBER_GAPS, KEYWORD_NAMES, KEYWORD_BODIES, KEYWORD_METHOD_FRAMES, CLASS_VALUES, CLASS_VALUES_WRAPPED, OBJECT_VALUES, OBJECT_VALUE_FRAMES, SHORTHAND_NAMES, SHORTHAND_FRAMES, UNREADABLE_LISTS, UNREADABLE_HEADS, ESCAPED_HEADS, ESCAPE_PLACES, ESCAPE_GAPS, CLASS_HERITAGES, LAST_ELEMENT_HERITAGES, CALL };
