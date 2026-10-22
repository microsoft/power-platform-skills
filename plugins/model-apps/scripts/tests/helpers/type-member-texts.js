'use strict';

// Texts for the sweeps of what a type can hold for its members (source-literals.test.js, typeMembersFail). The text after the `)` of a call signature, `interface I { <T>(x)TEXT }`, is read up to the first thing that could hide
// the closing tag of an element head `<T>` — a comment, a string, a template, a regex — and the reader may claim that no type has the text for its members, so that nothing hides the closing tag. The claim is TypeScript's
// to judge: its parser's first diagnostic for the text must be at or before the thing that opens. These generators make the texts where a claim that is too eager is wrong:
//   - tokenTexts, drawnTexts: every text of up to `depth` tokens of a vocabulary of the pieces of a member and of what TypeScript rejects there, in order, and seeded draws of four to seven of them;
//   - memberTexts: runs of valid members — names, strings, numbers, computed names, signatures, modifiers, accessors, optional members, initializers — with separators, comments and line breaks, mutated at one or two
//     places, so that the texts are near-misses of types;
//   - keywordTexts: every keyword of TypeScript in each place of a member where a word may stand;
//   - bracketTexts: an operand that ends in a `)` or a `]`, in each place an expression stands, then a comment of every kind, where a `/` follows;
//   - wordTexts: every keyword after a `.`, `typeof`, `infer`, `keyof`, `readonly` and `unique`, then each thing that may follow a name or a type;
//   - numberWordTexts: a number of every spelling, then a word, a quote or a `/` with nothing between;
//   - importTypeTexts, drawnImportTypeTexts: `typeof import` and `import` with a line terminator, a space or a comment between every two tokens, in each place a type stands, and a type query on a name before a `(` on the next line;
//   - accessorNameTexts, drawnAccessorNameTexts: `get`, `set` and every other modifier before a computed name that holds a comma or a colon and a regex, with trivia between;
//   - tupleTexts: a `[` after a `:`, a type or an operator type, then trivia and a `/`.

const { mulberry32 } = require('./jsx-element-fuzz.js');

// What a member is made of, and what a text of prose may have in it: names and keywords, numbers of every spelling (a signed exponent is ONE token to the scanner), brackets, strings, tags, the operators.
const BASE_TOKENS = ['a', '1', 'type', 'new', 'in', 'readonly', ':', ',', ';', ' ', '\n', '/* c */', '/* c\n */', '// c\n', '?', '.', '(', '-', "'a'", '\u00e9', '&', '|', '*', '1.5', 'extends'];
const MORE_TOKENS = ['1e+5', '1e-5', '.5', '1.', '1e+', '0x1e', '[', ']', ')', '!', 'x!', '=', '=>', '<', '>', '<b>', '</b>', '#', '#x', '@', '{', '}', '"a"', "'a", '"a', '...', '||', '+', '%', '\\', '\u2014',
  'static', 'get', 'string', 'https', '(x)', '[x]', 'x = 1', '1 2', '<T>', '<T,U>', '`a`',
  '&&', '==', '??', '?.', '<=', '>=', '++', '--', '**', '::', '</', '-1', 'keyof', 'typeof', 'unique', 'is', 'A.B', ': A', ': -1', ': A | B', ': A & B', ': keyof A',
  'infer', '\\u0061', '0x1F', '0b1'];
const ALL_TOKENS = [...BASE_TOKENS, ...MORE_TOKENS];

function* tokenTexts(tokens, depth, prefix = '') {
  yield prefix;
  if (depth > 0) for (const token of tokens) yield* tokenTexts(tokens, depth - 1, prefix + token);
}
function* drawnTexts(tokens, seed, count) {
  const rng = mulberry32(seed);
  for (let n = 0; n < count; n += 1) yield Array.from({ length: 4 + Math.floor(rng() * 4) }, () => tokens[Math.floor(rng() * tokens.length)]).join('');
}

// ─── Near-misses of types ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const NAMES = ['a', 'b1', '$x', '_y', 'https', 'url', '\u00e9', 'new', 'type', 'in', 'default', 'readonly', 'static', 'get', 'set', 'of', 'is', 'class', 'return', 'abstract', 'async', 'declare', 'private', 'out', 'const'];
const TYPES = ['string', 'A', 'A.B', "'lit'", '1', '-1', 'A[]', 'A | B', 'A & B', '[A, B]', '(A)', '{ x: A }', 'keyof A', 'typeof a', 'A<B>', 'readonly A[]', '`t${string}`', 'void', '(x: A) => B', 'new () => A', 'A extends B ? C : D',
  'unique symbol', 'infer U'];
const PARAMS = ['', 'x', 'x: A', 'x?: A', '...x: A[]', 'x = 1', 'x: A, y?: B', 'this: A', '{ a }: B', '[a]: B'];
const GAPS = [' ', ' ', ' ', '', '\n', '\n  ', ' /* c */ ', ' // c\n', '\r\n', '\u2028', ' /* c\n */ '];
const SEPARATORS = [';', ',', '\n', ';\n', ',\n', ' ; ', '\n\n', ';;', ';,'];
const MODIFIERS = ['readonly', 'static', 'public', 'private', 'declare', 'abstract', 'async', 'accessor', 'override', 'in', 'out', 'default', 'export', 'const'];
const NUMBERS = ['1', '1.5', '.5', '1e+5', '1e-3', '0x1F', '1_0'];
const KEYS = ['k: string', 'x', 'a.b', 'Symbol.iterator', "'k'", '1', ''];
const INITIALIZERS = ['1', 'a', "'s'", 'a + b', 'f(x)', '[1]', 'x as A', 'typeof x', '{}', '/re/', '`t`'];
const MUTATIONS = ['!', '=', '|', '&', '?', '.', '@', '#', '#x', '<', '>', '</b>', '<b/>', '<b>', '(', ')', '[', ']', "'", '"', '`', '{', '}', ':', ',', ';', ' x', ' 1', "'a'", '1e+5', '...', '=>', '||', '/', '\\', '\u2014', '*',
  '%', '+', '-', '~', '^', 'extends', 'typeof', 'in', 'is', 'as'];

function* memberTexts(seed, count) {
  const rng = mulberry32(seed);
  const pick = (options) => options[Math.floor(rng() * options.length)];
  const gap = () => pick(GAPS);
  const member = () => {
    const roll = rng();
    const name = pick(NAMES);
    const optionalType = () => (rng() < 0.5 ? `: ${pick(TYPES)}` : '');
    if (roll < 0.14) return name;
    if (roll < 0.27) return `${name}${gap()}:${gap()}${pick(TYPES)}`;
    if (roll < 0.34) return `${name}?${gap()}:${gap()}${pick(TYPES)}`;
    if (roll < 0.40) return `'${name}'${gap()}:${gap()}${pick(TYPES)}`;
    if (roll < 0.44) return `${pick(NUMBERS)}${gap()}:${gap()}${pick(TYPES)}`;
    if (roll < 0.50) return `[${pick(KEYS)}]${gap()}:${gap()}${pick(TYPES)}`;
    if (roll < 0.58) return `${name}(${pick(PARAMS)})${rng() < 0.5 ? `${gap()}:${gap()}${pick(TYPES)}` : ''}`;
    if (roll < 0.62) return `<T>(${pick(PARAMS)})${optionalType()}`;
    if (roll < 0.66) return `new${gap()}(${pick(PARAMS)})${optionalType()}`;
    if (roll < 0.74) return `${pick(MODIFIERS)}${gap()}${name}${gap()}:${gap()}${pick(TYPES)}`;
    if (roll < 0.80) return `${pick(['get', 'set'])}${gap()}${name}(${pick(['', 'v: A'])})${gap()}:${gap()}${pick(TYPES)}`;
    if (roll < 0.86) return `${name}${gap()}=${gap()}${pick(INITIALIZERS)}`;
    if (roll < 0.92) return `${name}${gap()}:${gap()}${pick(TYPES)}${gap()}=${gap()}${pick(['1', 'a'])}`;
    if (roll < 0.96) return `${name}<U>(${pick(PARAMS)})${optionalType()}`;
    return `${name}${gap()}?`;
  };
  const mutate = (text) => {
    let out = text;
    const edits = 1 + (rng() < 0.4 ? 1 : 0);
    for (let i = 0; i < edits; i += 1) {
      const at = Math.floor(rng() * (out.length + 1));
      const roll = rng();
      if (roll < 0.5) out = out.slice(0, at) + pick(MUTATIONS) + out.slice(at);
      else if (roll < 0.75 && out.length > 0) out = out.slice(0, at) + out.slice(at + 1 + Math.floor(rng() * 3));
      else out = out.slice(0, at) + pick(MUTATIONS) + out.slice(at + 1);
    }
    return out;
  };
  for (let n = 0; n < count; n += 1) {
    let text = pick(SEPARATORS);
    const members = 1 + Math.floor(rng() * 4);
    for (let m = 0; m < members; m += 1) text += pick(GAPS) + member() + (m < members - 1 ? pick(SEPARATORS) : pick(['', ' ', '\n', ';', ',', ';\n']));
    yield rng() < 0.8 ? mutate(text) : text;
  }
}

// ─── Every keyword, wherever a word may stand ───────────────────────────────────────────────────────────────────────────────────────────────────────
// A word where a member begins, after a name, a type, an initializer's operand, a modifier, in a type, on the next line: whether it is a modifier, a name, an operator or an error is the parser's to say.
const KEYWORD_SHAPES = [
  (k) => `;\n  ${k}`, (k) => `;\n  ${k} b`, (k) => `;\n  ${k}: A`, (k) => `;\n  ${k}?: A`, (k) => `;\n  ${k}(): A`, (k) => `;\n  ${k}\n  b`, (k) => `;\n  ${k} ${k}`, (k) => `;\n  ${k} 'b'`, (k) => `;\n  ${k} 1`, (k) => `;\n  ${k} [b]`,
  (k) => `;\n  a ${k}`, (k) => `;\n  a: A ${k}`, (k) => `;\n  a(): A ${k}`, (k) => `;\n  a: A\n  ${k}`, (k) => `;\n  a?: ${k}`, (k) => `;\n  a: ${k} b`, (k) => `;\n  [a] ${k}`,
  (k) => `;\n  readonly ${k}`, (k) => `;\n  readonly ${k} b`, (k) => `;\n  static ${k}: A`, (k) => `;\n  get ${k}()`,
  (k) => `;\n  a = 1 ${k}`, (k) => `;\n  a = b ${k}`, (k) => `;\n  a = 'b' ${k}`, (k) => `;\n  a = (b) ${k}`, (k) => `;\n  a = 1\n  ${k}`, (k) => `;\n  a = ${k}`, (k) => `;\n  a = ${k} b`, (k) => `;\n  a = 1 ${k} b`, (k) => `;\n  a = 1 ${k} 2`,
  (k) => `;\n  a: A = 1 ${k}`, (k) => `;\n  a = typeof ${k}`,
  // A keyword in a type: after an operator, a `.`, a `|` or an `&`, twice, and before a second type.
  (k) => `;\n  a: A | ${k}`, (k) => `;\n  a: A & ${k} b`, (k) => `;\n  a: A.${k}`, (k) => `;\n  a: ${k} ${k}`, (k) => `;\n  a: keyof ${k}`, (k) => `;\n  a: typeof ${k} b`, (k) => `;\n  a: A\n  | ${k}`, (k) => `;\n  a: A\n  ${k} b`,
];
// A character after a keyword — where a member begins, after a modifier or a name, and where a type must follow — on its line and the next.
const KEYWORD_PUNCTUATION = ['*', '.', '!', '&', '|', '+', '-', '%', '^', '~', '@', '=', '?', ':', '(', ')', '[', ']', '<', ',', ';', '#', '\\', '||', '&&'];
function* keywordTexts(keywords) {
  for (const keyword of keywords) {
    for (const shape of KEYWORD_SHAPES) yield shape(keyword);
    for (const punctuation of KEYWORD_PUNCTUATION) yield* [`;\n  ${keyword} ${punctuation}`, `;\n  ${keyword}\n  ${punctuation}`, `;\n  a: ${keyword} ${punctuation}`, `;\n  a: A ${punctuation} ${keyword}`, `;\n  a: A ${keyword} ${punctuation}`];
  }
}

// ─── A `/` after a bracket ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// An expression in a default value, a computed name or an initializer that ends in a `)` or a `]` — a parenthesised expression, a call, an array, an index, an optional call — and then a comment of every kind, where the
// probe's `/` stands. After the bracket the `/` divides, as it does after a name: a parser that has read an operand takes it for the operator. (After a `)` that ends the head of a statement it begins a regex, `if (a) /x/.test(b)`,
// but a statement needs a block, whose braces the reading does not enter.) Operands that end in anything else — a template, a regex, a tag — are left to a regex, and are in the texts to show that nothing is claimed of them.
const BRACKET_OPERANDS = ['(a)', '(a, b)', '((a))', 'f(a)', 'f(a, (b))', 'f()(g)', 'a[0]', 'a[b[0]]', '[1]', '[1, 2]', '[]', '()', '(a)[0]', 'a?.[0]', 'a?.(b)', 'new A()', '(a as B)', '(<b/>)', 'f(<b/>)', 'f(/x/)', '[/x/]', '(a /* c */)',
  '(a // c\n)', '`t`', 'f(`t${a}`)', '/x/', '<b/>', 'a!', 'a++', 'this', '1'];
const BRACKET_FRAMES = [(o) => `; m(a = ${o}`, (o) => `; m(a = 1 + ${o}`, (o) => `; [${o}`, (o) => `; [x, ${o}`, (o) => `; m(a = f(${o}`, (o) => `; m(a = q ? ${o}`, (o) => `; m: A = ${o}`, (o) => `;\n  m(a = x ||\n  ${o}`];
const BRACKET_GAPS = ['', ' ', '\n  ', ' // c\n  ', ' /* c */ ', '\n  // c\n  ', ' /* c\n */ ', '\r\n', '\u2028 // c\u2029'];
function* bracketTexts() {
  for (const frame of BRACKET_FRAMES) for (const operand of BRACKET_OPERANDS) for (const gap of BRACKET_GAPS) yield frame(operand) + gap;
}

// Two keywords in a row, the first of the words that a type or a member may start with, and then each keyword: `abstract new`, `keyof typeof`, `readonly static`, `extends infer`.
const FIRST_KEYWORDS = ['keyof', 'typeof', 'readonly', 'unique', 'infer', 'asserts', 'new', 'abstract', 'function', 'import', 'extends', 'is', 'in', 'out', 'static', 'get', 'set', 'declare', 'public', 'async', 'default', 'const',
  'export', 'accessor', 'override', 'private', 'protected', 'type', 'of', 'as', 'satisfies'];
function* keywordPairTexts(keywords) {
  for (const first of FIRST_KEYWORDS) {
    for (const second of keywords) yield* [`;\n  a: ${first} ${second}`, `;\n  ${first} ${second}`, `;\n  a: A ${first} ${second}`, `;\n  a = 1 ${first} ${second}`, `;\n  a: ${first}\n  ${second}`];
  }
}

// ─── A word where a name or a type must stand ───────────────────────────────────────────────────────────────────────────────────────────────────────
// After a `.` any word is a name (`A.new`, `A.unique`); `typeof` takes an entity name and `infer` an identifier, so a keyword after them is a name too; `keyof`, `readonly` and `unique` take a type, which a word that no type
// begins with is not. What the word is decides whether the `,` or the `;` after it ends a member, which is the difference between a type that goes on and one that fails there.
const WORD_PREFIXES = ['A.', 'A.B.', 'typeof ', 'typeof A.', 'infer ', 'infer U extends ', 'keyof ', 'keyof keyof ', 'readonly ', 'unique ', 'keyof readonly ', 'keyof unique ', 'keyof typeof ', 'keyof infer ', 'A | ', 'A | A.'];
const WORD_TAILS = [',', ';', '\n  b', '\n  b: A', ' | A', ' & A', '[]', '.B', ' ?', ' =', ' b', '<A>', ': A'];
function* wordTexts(keywords) {
  for (const keyword of keywords) for (const prefix of WORD_PREFIXES) for (const tail of WORD_TAILS) yield `;\n  a: ${prefix}${keyword}${tail}`;
}

// ─── A number and a word right after it ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A decimal literal that a name follows with no space is TS1351, and a hex, octal or binary one is not: the scanner ends it at its last digit, and `0x1Fin` is `0x1F` and `in`, an operator. After a word that is an operator
// a `/` or a quote begins a regex or a string, and after an operand it divides or is an error: the reading must end the number where the scanner does.
const NUMBER_SPELLINGS = ['0x1F', '0xE', '0x1e', '0b1', '0o7', '0x1Fn', '1', '1.5', '1e5', '1e+5', '.5', '1n', '1_0'];
const NUMBER_WORDS = ['in', 'instanceof', 'as', 'satisfies', 'of', 'b', 'x1', '\u00e9', 'e', 'n', 'typeof', 'extends'];
const NUMBER_TAILS = ["'", '\n  /', ' /', '\n  `', ' b', '=', ' in', '/'];
function* numberWordTexts(keywords) {
  for (const number of NUMBER_SPELLINGS) {
    for (const word of [...NUMBER_WORDS, ...keywords]) for (const tail of NUMBER_TAILS) yield `;\n  a = ${number}${word}${tail}`;
  }
}

// ─── An import type, an accessor's computed name and a tuple that begins with a `/` ─────────────────────────────────────────────────────────────────────────
// The `(` of an import type has no line-break rule (parseImportType), so `typeof import` and a line break, then `('./m')`, is one type, where after any other type the `(` on a new line begins a call signature; `get [` and
// `set [` begin an accessor whatever line the `[` is on (canFollowGetOrSetKeyword), and its computed name is an expression, `[a, /x/]`, where after any other word that `[` is an index signature that no `/` follows; and a `[`
// after a `:` or a type begins a tuple or an indexed access, whose first type is no `/`. Between each two tokens stands every kind of line terminator, a space of each kind and a comment, or nothing where the grammar allows it.
const LINE_BREAKS = ['\n', '\r', '\r\n', '\u2028', '\u2029'];
const WORD_GAPS = [...LINE_BREAKS, '\u0085', ' ', ' /* c */ ', ' /*\n*/ ', ' // c\n', ' // c\r\n', '\n  ', '/**/'];
const PAREN_GAPS = ['', ...WORD_GAPS, '\u00a0'];
const IMPORT_LEADS = [';\n  m: ', ';\n  m?: ', ';\n  m(): ', ';\n  [k: string]: ', ';\n  readonly m: ', ';\n  m: A | ', ';\n  m: A & ', ';\n  m: keyof ', ';\n  m: readonly ', ';\n  m: (', ';\n  get x(): ', ';\n  new (): ', ';\n  m(p: ', ';\n  static m: ', ";\n  'k': ", ';\n  1: ', ';\n  new: ', ';\n  get: ', ';\n  m: A.B | ', ',\n  m: [A, '];
const IMPORT_FORMS = [(g, p) => `typeof${g}import${p}`, (g, p) => `import${p}`, (g, p) => `keyof${g}typeof${g}import${p}`, (g, p) => `typeof${g}import${g}${p}`, (g, p) => `readonly${g}typeof${g}import${p}`];
const IMPORT_PATHS = ["'./m'", '"./m"', '`./m`', "'./m', { with: { 'resolution-mode': 'import' } }", "'a</T>b'"];
const IMPORT_TAILS = ['', '.X', '.X.Y', ' | A', ' & B', '[]', '<A>', '.X<A>', ';\n  n: A', ',\n  n: A', '\n  n: A', ' extends B ? C : D', ')', ']', ')[]'];
// A type query on a name, and a `(` on the next line: the type ends, and the `(` begins a call signature, whose first parameter a string is not.
const TYPE_QUERY_FORMS = [(g) => `typeof${g}A.import`, (g) => `typeof${g}a`, (g) => `typeof${g}import_`, (g) => `typeof${g}importer`, (g) => `typeof${g}\u00e9mport`, (g) => `A${g}.import`];
function* importTypeTexts() {
  for (const lead of IMPORT_LEADS.slice(0, 3)) for (const form of IMPORT_FORMS.slice(0, 3)) for (const g of WORD_GAPS) for (const p of PAREN_GAPS) yield `${lead}${form(g, p)}('./m')`;
  for (const form of TYPE_QUERY_FORMS) for (const g of WORD_GAPS) for (const p of LINE_BREAKS) yield `;\n  m: ${form(g)}${p}('x')`;
}
function* drawnImportTypeTexts(seed, count) {
  const rng = mulberry32(seed);
  const pick = (options) => options[Math.floor(rng() * options.length)];
  for (let n = 0; n < count; n += 1) yield `${pick(IMPORT_LEADS)}${pick(IMPORT_FORMS)(pick(WORD_GAPS), pick(PAREN_GAPS))}(${pick(PAREN_GAPS)}${pick(IMPORT_PATHS)}${pick(PAREN_GAPS)})${pick(IMPORT_TAILS)}`;
}

const ACCESSOR_MODIFIERS = ['', 'static ', 'readonly ', 'declare ', 'public ', 'private ', 'protected ', 'abstract ', 'override ', 'accessor ', 'async ', 'static readonly ', 'get ', 'set '];
const ACCESSOR_WORDS = ['get', 'set', 'static', 'readonly', 'accessor', 'async', 'declare', 'new', 'x', 'type', 'of', 'in', 'is', 'as', 'default'];
const COMPUTED_NAMES = ['a', 'a?', 'this', 'A.b', '1', "'x'", 'type', 'get', 'new', 'in', '\u00e9', 'a, b'];
const COMPUTED_COMMAS = [',', ':', '?,', '?:', ' ,', ',\n', ', // note\n', ': // note\n', ', /* c */ '];
const COMPUTED_REGEXES = ['/[</T>]/', '/b </T> /', '/b </T>'];
const COMPUTED_TAILS = ['', ']', ']()', '](): string', ']: string', '](v)', ']?: A'];
function* accessorNameTexts() {
  for (const modifier of ['', 'static ', 'readonly ']) for (const word of ['get', 'set', 'static', 'readonly', 'x']) for (const g of PAREN_GAPS) for (const name of ['a', 'this', 'a?']) for (const comma of COMPUTED_COMMAS) {
    yield `;\n  ${modifier}${word}${g}[${name}${comma}${COMPUTED_REGEXES[0]}](): string`;
  }
}
function* drawnAccessorNameTexts(seed, count) {
  const rng = mulberry32(seed);
  const pick = (options) => options[Math.floor(rng() * options.length)];
  for (let n = 0; n < count; n += 1) {
    yield `${pick([';\n  ', ',\n  ', ';\n  m: A\n  ', ';\n  m(): A\n  ', ';\n  m\n  '])}${pick(ACCESSOR_MODIFIERS)}${pick(ACCESSOR_WORDS)}${pick(PAREN_GAPS)}[${pick(PAREN_GAPS)}${pick(COMPUTED_NAMES)}${pick(COMPUTED_COMMAS)}${pick(PAREN_GAPS)}${pick(COMPUTED_REGEXES)}${pick(COMPUTED_TAILS)}`;
  }
}

// A `[` after a `:`, a type, `keyof` or `readonly`, then trivia and a `/`: the first type of a tuple or an indexed access is none, and a `/` after a name is a division, not read.
const TUPLE_LEADS = [';\n  Total: ', ';\n  m: A', ';\n  m: A | ', ';\n  m: keyof ', ';\n  m: readonly ', ';\n  m: A.B', ';\n  m: typeof a', ';\n  m: unique ', ';\n  m\n  ', ';\n  m: A\n  ', ';\n  m?: ', ';\n  m(): ', ';\n  m: ', ';\n  m: [A, '];
function* tupleTexts() {
  for (const lead of TUPLE_LEADS) for (const g of PAREN_GAPS) for (const h of PAREN_GAPS.slice(0, 8)) for (const after of ['/b </T> /', '/docs </T>', '/[</T>]/', 'a, /b </T> /', '] // c </T>']) yield `${lead}[${g}${h}${after}`;
}

module.exports = { BASE_TOKENS, MORE_TOKENS, ALL_TOKENS, tokenTexts, drawnTexts, memberTexts, keywordTexts, keywordPairTexts, bracketTexts, wordTexts, numberWordTexts, importTypeTexts, drawnImportTypeTexts, accessorNameTexts, drawnAccessorNameTexts, tupleTexts, LINE_BREAKS };
