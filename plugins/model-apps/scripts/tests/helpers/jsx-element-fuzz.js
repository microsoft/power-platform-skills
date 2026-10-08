'use strict';

// The harness of the differential fuzz of the element reading (jsx-element-reading.test.js).
//
// A `<Name>(…) =>` is a generic function type, for certain, where the ELEMENT reading of its text provably fails to parse (source-literals.js, elementFailsAt):
// TypeScript has no other reading of a `<` in an expression of a .tsx file, and in a type there is no JSX. TypeScript is the judge here. Wherever the lexer says
// the element reading fails, TypeScript's parser must report a diagnostic for the element reading, and at or before the character the lexer named; wherever the lexer
// says nothing, how often TypeScript's parser reports none (the element compiles, so the guess is real) and how often it does (the guess is only conservative) is
// the cost of the rule.
//
// The programs are drawn from two small grammars — type syntax and JSX syntax — mixed, from every short string of the characters that matter, and from
// cases written by hand (an attribute string with a backslash-quote, so that JavaScript's strings and JSX's end in different places). A seeded generator
// makes a failure reproducible.

const { CALL, DECOYS, SIGNATURE_FRAMES, ELEMENT_FRAMES } = require('./angle-frames.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, options) => options[Math.floor(rng() * options.length)];
const chance = (rng, p) => rng() < p;
const between = (rng, low, high) => low + Math.floor(rng() * (high - low + 1));

// ─── Type syntax ────────────────────────────────────────────────────────────────────────────────────────────────────

const TYPE_NAMES = ['T', 'U', 'K', 'V', 'Item', 'string', 'number', 'void', 'never', 'unknown', 'Foo.Bar', 'React.ReactNode', 'a', 'x1', '$t', '_u'];
const GENERIC_NAMES = ['Array', 'Promise', 'Record', 'Map', 'Set', 'Partial', 'Foo.Bar', 'React.FC', 'Pick', 'Omit', 'ReadonlyArray'];
// Strings and literals as types, with the characters JSX text and tags treat as syntax.
const LITERAL_TYPES = ['"a"', "'b'", '"a\\"b"', "'a\\'b'", '"a<b>c"', '"a{b}c"', '"}"', '"{"', '"<"', '">"', '"</div>"', '"=>"', '")"', '"("', '"a b"', '""', '"\\\\"', '`a`', '`a${T}b`', '1', '-1', 'true'];

function repeated(rng, depth, low, high, separator, make) {
  return Array.from({ length: between(rng, low, high) }, () => make(rng, depth)).join(separator);
}

function typeText(rng, depth) {
  if (depth <= 0 || chance(rng, 0.25)) return chance(rng, 0.2) ? pick(rng, LITERAL_TYPES) : pick(rng, TYPE_NAMES);
  switch (Math.floor(rng() * 12)) {
    case 0: case 1: case 2: return `${pick(rng, GENERIC_NAMES)}<${repeated(rng, depth - 1, 1, 3, pick(rng, [', ', ',', ' , ']), typeText)}>`;
    case 3: return `${typeText(rng, depth - 1)}[]`;
    case 4: return `${typeText(rng, depth - 1)} | ${typeText(rng, depth - 1)}`;
    case 5: return `${typeText(rng, depth - 1)} & ${typeText(rng, depth - 1)}`;
    case 6: return `{ ${repeated(rng, depth - 1, 1, 3, pick(rng, ['; ', ', ']), memberText)} }`;
    case 7: return `(${repeated(rng, depth - 1, 0, 3, ', ', paramText)}) => ${typeText(rng, depth - 1)}`;
    case 8: return `[${repeated(rng, depth - 1, 1, 3, ', ', typeText)}]`;
    case 9: return `keyof ${typeText(rng, 0)}`;
    case 10: return `<${pick(rng, ['U', 'V'])}>(${repeated(rng, depth - 1, 0, 2, ', ', paramText)}) => ${typeText(rng, depth - 1)}`;
    default: return `${typeText(rng, 0)} extends ${typeText(rng, 0)} ? ${typeText(rng, 0)} : ${typeText(rng, 0)}`;
  }
}

function memberText(rng, depth) {
  const name = pick(rng, ['a', 'b', 'label', '$a', '_a', 'type', 'async', 'x1']);
  switch (Math.floor(rng() * 9)) {
    case 0: return `${name}: ${typeText(rng, depth)}`;
    case 1: return `${name}?: ${typeText(rng, depth)}`;
    case 2: return `readonly ${name}: ${typeText(rng, depth)}`;
    case 3: return `[k: string]: ${typeText(rng, depth)}`;
    case 4: return `${name}(x: ${typeText(rng, depth)}): ${typeText(rng, depth)}`;
    case 5: return `(x: ${typeText(rng, depth)}): ${typeText(rng, depth)}`;
    case 6: return `${name} : ${typeText(rng, depth)}`;
    case 7: return `${name} ?: ${typeText(rng, depth)}`;
    default: return `'${name}': ${typeText(rng, depth)}`;
  }
}

function paramText(rng, depth) {
  const name = pick(rng, ['x', 'y', 'cb', 'items', 'value', 'a1']);
  switch (Math.floor(rng() * 8)) {
    case 0: return `${name}: ${typeText(rng, depth)}`;
    case 1: return `${name}?: ${typeText(rng, depth)}`;
    case 2: return `...${name}: ${typeText(rng, depth)}[]`;
    case 3: return `{ a, b }: ${typeText(rng, depth)}`;
    case 4: return `[a, b]: ${typeText(rng, depth)}`;
    case 5: return `${name} = 1`;
    case 6: return name;
    default: return `${name}: ${typeText(rng, depth)}`;
  }
}

// ─── White space ────────────────────────────────────────────────────────────────────────────────────────────────────

// What TypeScript's scanner skips between tokens — isWhiteSpaceSingleLine and isLineBreak, which is more than ASCII's white space: U+00A0, U+0085, U+1680, U+2000–U+200B,
// U+202F, U+205F, U+3000, U+FEFF, and the line breaks U+2028 and U+2029. A reading that takes one of them for a character that means something is wrong in a way that no
// fuzz of ASCII alone can find, so the alphabets here hold every kind of it, and the test asserts that each was generated where a reading could take it for something else.
const ASCII_SPACE = [' ', '\t', '\n', '\r', '\v', '\f'];
const SPACE_BEYOND_ASCII = ['\u00A0', '\u0085', '\u200B', '\u2028', '\u2029', '\uFEFF', '\u3000', '\u1680', '\u2003', '\u202F', '\u205F'];
const ANY_SPACE = [...ASCII_SPACE, ...SPACE_BEYOND_ASCII];
// The characters the fuzz must be shown to have put right next to an `=`, on both sides (the test asserts it): where an attribute value starts, and where `x ="…"` has its space.
const TRACKED_SPACE = ['\u00A0', '\u0085', '\u200B', '\u2028', '\u2029', '\uFEFF', '\u3000', '\t', '\r', '\v', '\f'];

// A run of white space between two tokens of a tag: mostly one ordinary space, otherwise any of the above, once or twice.
function spaceText(rng) {
  const roll = rng();
  if (roll < 0.4) return ' ';
  const options = roll < 0.65 ? ASCII_SPACE : SPACE_BEYOND_ASCII;
  return Array.from({ length: chance(rng, 0.25) ? 2 : 1 }, () => pick(rng, options)).join('');
}

// ─── JSX syntax ─────────────────────────────────────────────────────────────────────────────────────────────────────

const TEXTS = ['text', 'a b', 'a > b', 'a } b', '&gt;', "it's", '"quoted"', '\\', '(optional)', '=>', '(a): Title', '1 < 2', 'x = y', ' ', '\n', ''];
const TAGS = ['b', 'A', 'A.B', 'a-b', 'a:b', 'this', 'Foo.Bar.Baz', 'await', 'class', 'é', '$x', '_y', 'T'];
const ATTRIBUTE_NAMES = ['x', 'y-z', 'a:b', 'class', 'é', '$a', 'data-x', 'extends'];
const ATTRIBUTE_STRINGS = ['""', '"1"', "'1'", '"\\"', "'\\'", '">"', '"}"', '"{"', '"<"', '")"', '"=>"', '") =>"', "') =>'", '"\'"', '\'"\'', '"a\nb"', '"a\\"', '"\\\\"'];
const EXPRESSIONS = ['a', '1', '() => 1', '(x) => x', 'f(x)', 'a ? b : c', '{ a: 1 }', '"s"', '`t`', '[1, 2]', 'x => { return 1; }', 'a, b', ''];
const TYPE_ARGUMENT_LISTS = ['<T>', '<T, U>', '<Array<T>>', '<{ a: T }>', '<"a">', '<T[]>', '< T >', '<A.B<C>>', '<keyof T>', '<T extends U ? 1 : 2>', '<>', '<T', '<T,>'];
// Hand-written cases: the attribute strings that JavaScript and JSX end in different places, with the arrow or the parenthesis inside, and the like.
const HAND_WRITTEN = [
  '<b x="\\" y=") =>" />', "<b x='\\' y=') =>' />", '<b x="\\" y=")" />', '<b x="\\"/>) =>', '<b x="\\" y=") =>"></b>', '<b x="\\" y=") =>" z="\\" w="x" />', '<b x="\\"/><c y=") =>"/>',
  '<b x=") =>"/>', '<b x="\\"/>', '<b x={() => 1} y=") =>" />', '<b>{() => 1}</b>', '<b>{ ) => }</b>', '{ a ) => b }', '{/* ) => */}', '<b /* ) => */ x/>',
  '<b<T> x=") =>" />', '<b x=">" y="\\" z=") =>" />',
];

// An attribute whose `=` has white space of every kind next to it, with a string or a container for a value: valid JSX, and exactly what a fuzz of ASCII alone never writes.
// TypeScript's scanner skips the white space before a value that is not a string right after the `=`, so `x=<NBSP>{1}` and `x=<NBSP>"a"` are both fine to it.
function spacedAttribute(rng) {
  const name = pick(rng, ['x', 'p', 'q', 'data-a', '$a']);
  const value = pick(rng, ['"a"', "'a'", '{1}', '{a}', '""']);
  switch (Math.floor(rng() * 4)) {
    case 0: return `${name}=${spaceText(rng)}${value}`;
    case 1: return `${name}${spaceText(rng)}=${value}`;
    case 2: return `${name}${spaceText(rng)}=${spaceText(rng)}${value}`;
    default: return `${name}=${value}`;
  }
}

// An element in which the arrow is inside an attribute string — so the element can compile — with attributes in front of it whose values follow white space of every kind.
function hiddenArrowText(rng) {
  const tag = pick(rng, ['b', 'C', 'W', 'A.B']);
  const lead = Array.from({ length: between(rng, 0, 3) }, () => `${spaceText(rng)}${spacedAttribute(rng)}`).join('');
  const hidden = pick(rng, ['x="\\" y=") =>"', "x='\\' y=') =>'", 'x=") =>"', "x=') =>'", 'x="\\" y=") =>" z="\\" w="q"']);
  return `<${tag}${lead}${spaceText(rng)}${hidden}${pick(rng, [' />', '/>', `${spaceText(rng)}/>`, `></${tag}>`])}`;
}

function attributeText(rng, depth) {
  switch (Math.floor(rng() * 13)) {
    case 0: return pick(rng, ATTRIBUTE_NAMES);
    case 1: case 2: return `${pick(rng, ATTRIBUTE_NAMES)}=${pick(rng, ATTRIBUTE_STRINGS)}`;
    case 3: return `${pick(rng, ATTRIBUTE_NAMES)}={${pick(rng, EXPRESSIONS)}}`;
    case 4: return `{...${pick(rng, ['p', 'props', 'a.b'])}}`;
    case 5: return `${pick(rng, ATTRIBUTE_NAMES)} = ${pick(rng, ATTRIBUTE_STRINGS)}`;
    case 6: return pick(rng, ['/* c */', '// c\n']);
    case 7: return `${pick(rng, ATTRIBUTE_NAMES)}=${depth > 0 ? elementText(rng, depth - 1) : '1'}`;
    case 8: case 9: return spacedAttribute(rng);
    case 10: return `${pick(rng, ATTRIBUTE_NAMES)}=${spaceText(rng)}${pick(rng, ATTRIBUTE_STRINGS)}`;
    case 11: return `${pick(rng, ATTRIBUTE_NAMES)}=${spaceText(rng)}${pick(rng, ['1', 'a', '-1', '`t`', '', '<c/>', '/* c */ "1"'])}`;
    default: return `${pick(rng, ATTRIBUTE_NAMES)}=${pick(rng, ['1', 'a', '-1', '`t`', ''])}`;
  }
}

function childrenText(rng, depth) {
  return Array.from({ length: between(rng, 0, 3) }, () => {
    const roll = rng();
    if (roll < 0.4) return pick(rng, TEXTS);
    if (roll < 0.7) return `{${pick(rng, EXPRESSIONS)}}`;
    return depth > 0 ? elementText(rng, depth - 1) : pick(rng, TEXTS);
  }).join(pick(rng, ['', ' ', spaceText(rng)]));
}

function elementText(rng, depth) {
  const tag = pick(rng, TAGS);
  const attributes = Array.from({ length: between(rng, 0, 3) }, () => `${spaceText(rng)}${attributeText(rng, depth)}`).join('');
  switch (Math.floor(rng() * 7)) {
    case 0: return `<${tag}${attributes}/>`;
    case 1: return `<${tag}${attributes}${spaceText(rng)}/>`;
    case 2: case 3: return `<${tag}${attributes}>${childrenText(rng, depth)}</${tag}>`;
    case 4: return `<${tag}${attributes}>${childrenText(rng, depth)}`;
    case 5: return `<${tag}${pick(rng, TYPE_ARGUMENT_LISTS)}${attributes}>${childrenText(rng, depth)}</${tag}>`;
    default: return `<${tag}${pick(rng, ['', ' ', '\n', spaceText(rng)])}${attributes}${pick(rng, ['>', '/>', ' >', '/ >', `${spaceText(rng)}>`, `/${spaceText(rng)}>`])}`;
  }
}

function jsxText(rng) {
  const roll = rng();
  if (roll < 0.1) return pick(rng, HAND_WRITTEN);
  if (roll < 0.2) return hiddenArrowText(rng);
  if (roll < 0.3) return `{${pick(rng, EXPRESSIONS)}}`;
  if (roll < 0.35) return pick(rng, TEXTS);
  if (roll < 0.43) return pick(rng, ['</b>', '<>', '</>', '<>x</>', '< b>', '< /b>', `<${spaceText(rng)}b>`, `<${spaceText(rng)}/b>`]);
  return elementText(rng, 2);
}

// ─── Mixes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const NOISE = [...'<>{}/="\'\\()[],|&;?!*+%^~:.-`#@ \n_$1aTé', ...ANY_SPACE];
const noiseText = (rng) => Array.from({ length: between(rng, 1, 6) }, () => pick(rng, NOISE)).join('');

// What goes between the parentheses: parameters, JSX, or noise, one to three of them.
function mixText(rng) {
  return Array.from({ length: between(rng, 1, 3) }, () => {
    const roll = rng();
    return roll < 0.45 ? repeated(rng, 2, 1, 2, ', ', paramText) : roll < 0.85 ? jsxText(rng) : noiseText(rng);
  }).join(pick(rng, [', ', ' ', '', '\n', ',', spaceText(rng)]));
}

const RETURN_TYPES = ['T', 'void', 'x', '1', 'Array<T>', '{ a: T }', 'T[]'];
const HEAD_NAMES = ['T', 'W', 'Wrapper', 'Item', 'K'];

// What may stand between two tokens of a function type's head — `<` `T` `>` `(`…`)` `=>` — or nothing: TypeScript's scanner skips all of it in a type, white space of every kind and
// comments, so the type is as valid as it was. A reading that takes a character of it for a token reads a valid type as an element, and no fuzz without it can find that.
function gap(rng) {
  const roll = rng();
  if (roll < 0.45) return '';
  if (roll < 0.55) return pick(rng, ['/* */', ' /* - */ ', '// -\n']);
  return spaceText(rng);
}

// `<Name>`, with a gap after the `<`, before the `>` and after it, which is where a parameter list starts.
const headText = (rng) => `<${gap(rng)}${pick(rng, HEAD_NAMES)}${gap(rng)}>${gap(rng)}`;

// `<Name>(MIX) => R`, as the text of a function type or an element; now and then with no arrow after the parentheses, so that the arrows are only those in the mix (the
// cases put one inside an attribute string), and a body can be an element that compiles.
function* bodies(seed, count) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i += 1) {
    const head = `${headText(rng)}(${mixText(rng)})`;
    yield chance(rng, 0.3) ? head : `${head}${gap(rng)}=>${gap(rng) || ' '}${pick(rng, RETURN_TYPES)}`;
  }
}

// The elements that compile although they hold `) =>`, as bodies: the arrow is inside an attribute string, and the attributes before it have white space of every kind.
function* hiddenBodies(seed, count) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i += 1) yield `<${pick(rng, HEAD_NAMES)}>(${hiddenArrowText(rng)}${pick(rng, ['', hiddenArrowText(rng), ' x: T', ', y'])})`;
}

// A parameter list that is a valid type: parameters of type syntax only.
function* typeBodies(seed, count) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i += 1) yield `${headText(rng)}(${repeated(rng, 3, 0, 3, ', ', paramText)})${gap(rng)}=>${gap(rng) || ' '}${pick(rng, RETURN_TYPES)}`;
}

// ─── Every member and parameter form ─────────────────────────────────────────────────────────────────────────────────

// The members an object type has, in every form the grammar gives one — a property, readonly and optional, with every kind of key (a name, a keyword used as a name, a quoted
// name in either quote, a number, a computed name, an index signature, a mapped type's), a method, a call signature, a construct signature, an accessor — and the parameters a
// function type has, destructured or not. Each is what an object type or a parameter list holds in the middle of a generic function type's parameter list
//   <T>(value: { readonly current: T }) => T        <T>({ a }: { a: T }) => T        <T>(m: { [k: string]: T }) => T        <T>(o: { m(x: T): T }) => T        <T>(o: { 'a': T }) => T
// where the element reading of the text has an expression container with that member in it. The names are the ones TypeScript reads as an expression's first word (`typeof`,
// `new`, `async`, `yield`, …) as well as ordinary ones, since what the reading decides turns on the word.
const MEMBER_KEYS = ['a', 'label', '$a', '_a1', 'type', 'async', 'yield', 'await', 'new', 'get', 'set', 'readonly', 'function', 'class', 'typeof', 'void', 'delete', 'import', 'in', 'as', 'satisfies', 'instanceof'];
function memberForms(rng, depth) {
  const key = pick(rng, MEMBER_KEYS);
  const type = () => typeText(rng, depth);
  const space = () => pick(rng, ['', ' ', '\n']);
  return [
    () => `${key}: ${type()}`, () => `${key}?: ${type()}`, () => `readonly ${key}: ${type()}`, () => `readonly ${key}?: ${type()}`, () => `${key} : ${type()}`, () => `${key}${space()}?${space()}:${space()}${type()}`,
    () => `[k: string]: ${type()}`, () => `[k: number]: ${type()}`, () => `readonly [k: string]: ${type()}`, () => `[k${space()}:${space()}string]: ${type()}`, () => `[K in keyof T]: ${type()}`,
    () => `readonly [K in keyof T]?: ${type()}`, () => `-readonly [K in keyof T]-?: ${type()}`, () => `+readonly [K in ${type()}]+?: ${type()}`, () => `[Symbol.iterator](): ${type()}`,
    () => `[a.b]: ${type()}`, () => `[a]?: ${type()}`, () => `[${key}]: ${type()}`,
    () => `${key}(x: ${type()}): ${type()}`, () => `${key}(): ${type()}`, () => `${key}?(x: ${type()}): ${type()}`, () => `${key}<U>(x: U): ${type()}`, () => `${key}(x?: ${type()}, ...rest: U[]): ${type()}`,
    () => `${key}(this: ${type()}): ${type()}`, () => `${key}({ a }: ${type()}): ${type()}`, () => `${key}([a]: ${type()}): ${type()}`, () => `${key}(x): ${type()}`, () => `${key} (x: ${type()}) : ${type()}`,
    () => `(x: ${type()}): ${type()}`, () => `(): ${type()}`, () => `<U>(x: U): ${type()}`, () => `new (x: ${type()}): ${type()}`, () => `new (): ${type()}`, () => `new <U>(x: U): ${type()}`,
    () => `get ${key}(): ${type()}`, () => `set ${key}(v: ${type()})`, () => `'${key}': ${type()}`, () => `"${key}": ${type()}`, () => `'${key}'?: ${type()}`, () => `"${key}" ${space()}: ${type()}`,
    () => `'a-b': ${type()}`, () => `'a\\'b': ${type()}`, () => `"a\\"b": ${type()}`, () => `'${key}'(x: ${type()}): ${type()}`, () => `1: ${type()}`, () => `1.5: ${type()}`, () => `0x1: ${type()}`,
    // A quoted name and a call: a string is called as a name is. The string is read with its escapes, so a quote, a parenthesis, a brace or an escaped backslash inside it ends nothing.
    () => `"${key}"(x: ${type()}): ${type()}`, () => `'${key}'(): ${type()}`, () => `"${key}"(): ${type()}`, () => `'${key}'(x?: ${type()}): ${type()}`, () => `"${key}"(x?: ${type()}): ${type()}`,
    () => `'${key}'(x, y): ${type()}`, () => `'${key}'(x): ${type()}`, () => `'${key}'${space()}(x: ${type()})${space()}: ${type()}`, () => `'${key}'(x: ${type()}${pick(rng, [',', ''])}): ${type()}`,
    () => `'a\\'b'(x: ${type()}): ${type()}`, () => `"a\\"b"(x: ${type()}): ${type()}`, () => `'a(b'(x: ${type()}): ${type()}`, () => `'a)b'(x, y): ${type()}`, () => `"a}b"(x: ${type()}): ${type()}`,
    () => `'a{b'(): ${type()}`, () => `"a\\\\"(x: ${type()}): ${type()}`, () => `'a\\\\'(): ${type()}`, () => `'${key}'?(x: ${type()}): ${type()}`, () => `'${key}'<U>(x: U): ${type()}`,
    () => `'${key}'(this: ${type()}): ${type()}`, () => `'${key}'({ a }: ${type()}): ${type()}`, () => `'${key}'(x: ${type()}, ...rest: U[]): ${type()}`,
  ];
}

// The parameters a function type has, with a destructuring pattern, a rest, a `this`, a default, an optional mark, an object type or none.
function parameterForms(rng, depth) {
  const type = () => typeText(rng, depth);
  const members = () => `{ ${repeated(rng, depth, 1, 3, pick(rng, ['; ', ', ', ';\n']), (r, d) => pick(r, memberForms(r, d))())} }`;
  return [
    () => `x: ${members()}`, () => `x?: ${members()}`, () => `...rest: ${members()}[]`, () => `{ a }: ${type()}`, () => `{ a, b }: ${type()}`, () => `{ a: b, c = 1 }: ${type()}`, () => `{ a = 1 }: ${type()}`,
    () => `{ ...rest }: ${type()}`, () => `{ a: { b } }: ${type()}`, () => `{ a, b }: ${members()}`, () => `[a, ...b]: ${type()}`, () => `[a, b]: ${type()}`, () => `this: ${type()}`, () => `{}: ${type()}`,
    () => `{ a }`, () => `{ a } = {}`, () => `x: ${type()} = ${pick(rng, ['1', '{}', 'null'])}`, () => `x = ${pick(rng, ['{ a: 1 }', '{}', '1'])}`,
  ];
}

// A body whose parameter list holds those forms, one to three of them, in `<Name>(…) => R`: valid where the forms are, and the element reading of its text a failure wherever the
// lexer says so, which is what the fuzz asks.
function* formBodies(seed, count) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i += 1) {
    const params = repeated(rng, 1, 1, 3, ', ', (r, d) => pick(r, parameterForms(r, d))());
    const arrow = `${gap(rng)}=>${gap(rng) || ' '}${pick(rng, RETURN_TYPES)}`;
    yield `${headText(rng)}(${params})${arrow}`;
  }
}

// Texts that hold an arrow, for the reading of the element's text itself: structured mixes, with an arrow after them or inside them, or both.
function* directTexts(seed, count) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i += 1) {
    const arrowAfter = chance(rng, 0.65);
    const inside = arrowAfter && chance(rng, 0.3) ? ` ${pick(rng, ['=>', ') =>', '=> 1', ') => 1'])} ` : '';
    yield `(${mixText(rng)}${inside}${mixText(rng)})${arrowAfter ? ` => ${pick(rng, RETURN_TYPES)}` : ''}`;
  }
}

// Texts whose only arrow is inside an attribute string, so that the element compiles: TypeScript has no diagnostic, and any verdict that the reading is wrong is unsound.
function* hiddenTexts(seed, count) {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i += 1) yield `(${hiddenArrowText(rng)}${pick(rng, ['', hiddenArrowText(rng), ' x: T', ', y'])})`;
}

// Every string of up to `length` characters from `alphabet`, as the text before an arrow, after `prefix`.
function* exhaustiveTexts(alphabet, length, prefix = '') {
  const symbols = [...alphabet];
  let level = [''];
  for (let n = 0; n <= length; n += 1) {
    for (const text of level) yield `${prefix}${text}=>`;
    if (n === length) break;
    level = level.flatMap((text) => symbols.map((symbol) => text + symbol));
  }
}

function* chain(...parts) {
  for (const part of parts) yield* part;
}

// ─── `<Name>(…)` that neither `=>` nor `:` follows ───────────────────────────────────────────────────────────────────────────────────────────────────────

// `<T>(x)` is the text of an element in an expression and a call signature with no return type in a type that holds members (callSignatureOrElement in lib/source-literals.js; the shapes are in
// helpers/angle-frames.js). The lexer tells them apart by the token after the `)` and, where a type may stand, by the text after it read as the children of an element up to its closing tag;
// where it cannot say, it guesses. The same characters are a type's members and an element's text, so each program draws its text from both grammars — JSX text, containers, nested elements;
// separators, members, strings, comments — and is put in both places, as a type and as an element, each of which TypeScript parses or does not. Where it parses, TypeScript says what the head is:
//   a type that TypeScript parses is never read as an element for certain, and an element that it parses is never read as code for certain;
//   where the lexer says that the text of an element fails, TypeScript reports a diagnostic for the element, at or before the character the lexer named.
// Every program ends in a decoy — a string, a template, a comment or a regex that holds the closing tag of the head's name and the text of a call — and then the one real call.
const SIGNATURE_NAMES = ['T', 'U', 'Wrapper', 'b', 'Text', 'Foo.Bar'];
const SIGNATURE_PARAMETERS = ['(x)', '()', '(x, y)', '(x?)', '(...a)', '({ a })', '(optional)', '(total: {count})', '(x: number[])', "(x: 'a')", '(a) b', '(x = 1)', '({count} items)', '({formatDate(d)})', '({t("label")})', '(a, b)', "(it's)", '(x: Array<T>)'];
// What stands between the `>` of the head and its `(`, and between the `)` and what follows: white space of every kind TypeScript skips, comments, line breaks of every kind.
const HEAD_GAPS = ['', '', '', '', ' ', '\n  ', '\n', ' /* c */ ', '/* c */', '// c\n', '\u00a0', '\u2028', '\u0085'];
const SIGNATURE_SEPARATORS = ['', '', '', ';', ',', '\n', ' ', '; ', ', ', ';\n  ', '\n  ', ' // c\n', ' /* c */ ', ' /* c\n */ ', '\r\n', ' /* c */\n', '\n// c\n', ' \n ', ...ANY_SPACE];
// JSX text that holds nothing a closing tag could be inside of; text with a quote, which is a string only where a closing quote follows on the line, and none does in these programs after the closing
// tag; and text that holds a back-tick or a slash — a template, a comment, a regex — which could hide the closing tag, so that a reading of it may be a guess.
const PLAIN_TEXTS = [' more text ', 'text', '(a)', '(b: c)', '1 + 2', 'x = y', '&amp;', ' ', '\n', ';', ',', ': ', '(x) ', '* 2', '\t'];
const QUOTE_TEXTS = ["it's", '"quoted"', "'single'", "'a' b 'c'", '"a" it\'s', '5" wide', "the user's 'x'"];
const HIDING_TEXTS = ['a/b', 'https://x.y', '`t`', '/* c */', ' / ', '// c\n'];
// Containers whose content the reading skips (containerFailsAt) — one that holds a string with the closing tag of the head's name (NAME) is among them — and containers it does not read: a comment, a
// template, a division, a regex, a comparison, an element.
const READ_CONTAINERS = [
  '{a}', '{count}', '{items.length}', '{formatDate(d)}', '{t("label")}', '{a ? "x" : "y"}', '{"}"}', "{'it\\'s'}", '{x["k"]}', '{a, b}', '{}', '{ a }', '{{ a: 1 }}', '{{ a: "}" }}', '{a ? { b: 1 } : c}', '{() => 1}',
  '{() => { return "}"; }}', '{"</NAME>"}', "{'</NAME>'}", '{...a}',
];
const UNREAD_CONTAINERS = ['{/* c */ a}', '{`t`}', '{a / b}', '{/re/.test(s)}', '{a < b}', '{<b/>}', '{c && <b>x</b>}', '{`</NAME>`}'];
// Nested elements, with attributes of every kind the reading skips: a string, a container, a spread, an object, a string that holds the closing tag of the head's name.
const NESTED_ELEMENTS = [
  '<b>x</b>', '<c/>', '<></>', '<b>(x) {y}</b>', '<A.B>z</A.B>', '<b x="1">y</b>', '<b x={1}>y</b>', '<b>\n  t\n</b>', '<>a</>', '<br />', '<b {...p}/>', '<b style={{ color: "red" }}>y</b>', '<b x={a ? "}" : 1} />',
  '<b x={{ a: "}" }}>y</b>', '<b x={t("</NAME>")}>y</b>', '<b x="</NAME>">y</b>', '<b\n  x={1}\n  y="2"\n/>', '<Icon name={icon} />', '<b x = {1}>y</b>',
];
// Members: the ones only a type has, and the ones that hold the closing tag of the head's name (NAME) in a string, a template or a comment — which is what makes the head's reading a guess.
const TYPE_MEMBERS = ['<U>(y)', 'new <U>(y)', '<U>(y: U): void', 'm: { a: string }', 'm: { <U>(y: U): void }', 'm: Array<string>', '[k: string]: T', 'readonly m?: 1', 'm(): void', 'm: (a: T) => void', 'm: Array<Array<string>>', 'n?: number', "'a-b': T", 'm: <U>(y: U) => void', '</* c */NAME>(y)', '</* c */U extends X>(y)'];
const HIDING_MEMBERS = [
  "m: '</NAME>'", 'm: "a</NAME>b"', 'm: `</NAME>`', '// </NAME>\n', '/* </NAME> */', '/** </NAME> */ m: number', "m: '</NAME>' | '<NAME>'", "m: 'a' | '</NAME>'", 'm: { a: "</NAME>" }',
  // A backslash before a line break continues the string, which then holds the closing tag on its second line.
  "m: 'a\\\n</NAME>'", "m: 'a\\\r\n</NAME>'", "m: 'it\\'s </NAME>'", 'm: `a${string}</NAME>`', '[/[</NAME>]/.source]: string',
  // A string right after a keyword, with no white space between: its quote is no apostrophe.
  "readonly'a</NAME>': number", "m: keyof'a</NAME>'", "m: T extends'a</NAME>' ? 1 : 2", "m: { [K in'a</NAME>']: T }", "m: { get'a</NAME>'(): T }",
];

// One piece of JSX text, with whether the lexer may be unable to read it to its end (a back-tick or a slash that could hide the closing tag; a container it does not read).
function jsxPiece(rng) {
  const roll = rng();
  if (roll < 0.35) return [pick(rng, PLAIN_TEXTS), false];
  if (roll < 0.45) return [pick(rng, QUOTE_TEXTS), false];
  if (roll < 0.52) return [pick(rng, HIDING_TEXTS), true];
  if (roll < 0.75) return [pick(rng, READ_CONTAINERS), false];
  if (roll < 0.8) return [pick(rng, UNREAD_CONTAINERS), true];
  return [pick(rng, NESTED_ELEMENTS), false];
}

// What follows the head's `)` and the separator: JSX text (40%), members (45%), or a bit of each. `plain` is JSX alone; `risky` is where the lexer may say nothing.
function signatureTail(rng, name) {
  const roll = rng();
  const jsx = (n) => Array.from({ length: n }, () => jsxPiece(rng));
  const members = (n) => Array.from({ length: n }, () => {
    const kind = rng();
    return kind < 0.3 ? pick(rng, TYPE_MEMBERS) : kind < 0.5 ? pick(rng, HIDING_MEMBERS) : pick(rng, memberForms(rng, 1))();
  });
  let tail;
  if (roll < 0.4) {
    const pieces = jsx(between(rng, 0, 4));
    tail = { text: pieces.map(([text]) => text).join(pick(rng, ['', ' ', '\n'])), plain: true, risky: pieces.some(([, risky]) => risky) };
  } else if (roll < 0.85) {
    tail = { text: members(between(rng, 0, 3)).join(pick(rng, ['; ', ',\n  ', '\n  ', ';\n  ', ', ', ' '])), plain: false, risky: true };
  } else {
    const pieces = jsx(between(rng, 1, 2));
    tail = { text: `${pieces.map(([text]) => text).join(' ')}${pick(rng, ['; ', ',\n  ', '\n  '])}${members(between(rng, 1, 2)).join('; ')}`, plain: false, risky: true };
  }
  return { ...tail, text: tail.text.replaceAll('NAME', name) };
}

// The characters of white space and comments before the first token after the `)`: a `:` there makes the head a call signature with a return type as much as JSX text, which is its own, documented guess.
const COLON_NEXT = new RegExp(`^(?:[${ANY_SPACE.join('')}]|/\\*[^]*?\\*/|//[^\\n]*\\n)*:`);
// A parameter list in which something may start an expression — an `=` that is not the `=>` of a function type, a `[` that is not the `[]` of an array type, an `@`, `import`, `extends`,
// `get` or `set` — and a `/`, a `<` or a back-tick follows it is read with the guess (genericFunctionTypeFollows): a regex, JSX or a template there may move the `)` that ends the list. This
// errs toward naming more lists than the lexer does (an `=` in a string, a comment in `[ ]`), which only leaves an element out of the precise ones.
const MAY_HOLD_EXPRESSION = /(?:=(?!>)|\[(?!\s*\])|@|\b(?:import|extends|get|set)\b)[^]*[/<`]/;

// A program per head: `kind` is where the head stands, in a type (`signature`) or as an element, which is the same text with the closing tag of the head after it. `at` is the offset of the `<`,
// `after` the offset just past the `>` of `<Name>`, and `precise` marks an element that holds nothing the lexer may be unable to read: it must be read as an element, for certain, where it parses.
function* signaturePrograms(seed, count) {
  const rng = mulberry32(seed);
  const decoys = Object.values(DECOYS);
  for (let i = 0; i < count; i += 1) {
    const name = pick(rng, SIGNATURE_NAMES);
    const head = `<${name}>${pick(rng, HEAD_GAPS)}`;
    const parameters = pick(rng, SIGNATURE_PARAMETERS);
    const separator = pick(rng, SIGNATURE_SEPARATORS);
    const tail = signatureTail(rng, name);
    const decoy = pick(rng, decoys).replaceAll('NAME', name);
    const [, typeFrame] = pick(rng, SIGNATURE_FRAMES);
    const construct = chance(rng, 0.15);
    yield { kind: 'signature', code: `${typeFrame.replace('@', `${construct ? 'new ' : ''}${head}${parameters}${separator}${tail.text}`)}\n${decoy}\n${CALL};\n`, at: typeFrame.indexOf('@') + (construct ? 4 : 0), name };
    const [, elementFrame] = pick(rng, ELEMENT_FRAMES);
    const at = elementFrame.indexOf('@');
    // A `<` in the parameters opens a tag of its own, and a slash in the white space is a comment or a division: neither is a text the lexer must be able to read.
    yield {
      kind: 'element', code: `${elementFrame.replace('@', `${head}${parameters}${separator}${tail.text}</${name}>`)}\n${decoy}\n${CALL};\n`, at, after: at + name.length + 2, name,
      precise: tail.plain && !tail.risky && !head.includes('/') && !separator.includes('/') && !parameters.includes('<') && !MAY_HOLD_EXPRESSION.test(parameters) && !COLON_NEXT.test(`${separator}${tail.text}`),
    };
  }
}

// ─── Judging ────────────────────────────────────────────────────────────────────────────────────────────────────────

// TypeScript reports the closing tag of a nested element that nothing closes at its OPENING tag, however late it finds out, so those diagnostics say nothing of where
// an error is: they are left out when judging whether a diagnostic supports the lexer.
const CLOSING_TAG_CODES = new Set([17002, 17008, 17014, 17015]);

const parseDiagnostics = (ts, source) => ts.createSourceFile('fuzz.tsx', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX).parseDiagnostics;
const relevant = (diagnostics) => diagnostics.filter((d) => !CLOSING_TAG_CODES.has(d.code));
const firstOf = (diagnostics) => diagnostics.reduce((first, d) => (d.start < first.start ? d : first), diagnostics[0]);

const arrowsIn = (text) => {
  const found = [];
  for (let at = text.indexOf('=>'); at !== -1; at = text.indexOf('=>', at + 1)) found.push(at);
  return found;
};

const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

// What the reading of an element's text says of `text` — the text from just past the `>` of `<T>` — at each of its arrows, against TypeScript's parse of
// `const e = <T>TEXT</T>;`. `read(text, arrow)` is the offset it names or -1.
function judgeDirect(ts, read, texts) {
  const head = 'const e = <T>';
  const stats = { texts: 0, arrows: 0, invalid: 0, unsure: 0, unsureCompiles: 0, unsureFails: 0, spaceAfterEqualsCompiles: 0, byCode: {}, unsound: [], unjustified: [] };
  for (const text of texts) {
    const arrows = arrowsIn(text);
    if (!arrows.length) continue;
    stats.texts += 1;
    const diagnostics = parseDiagnostics(ts, `${head}${text}</T>;`);
    const real = relevant(diagnostics);
    // A text that compiles with white space beyond ASCII right after an `=`: the case that a reading which takes the character for a value gets wrong.
    if (diagnostics.length === 0 && SPACE_BEYOND_ASCII.some((c) => text.includes(`=${c}`))) stats.spaceAfterEqualsCompiles += 1;
    for (const arrow of arrows) {
      stats.arrows += 1;
      const at = read(text, arrow);
      if (at === -1) {
        stats.unsure += 1;
        if (diagnostics.length === 0) stats.unsureCompiles += 1; else stats.unsureFails += 1;
        continue;
      }
      stats.invalid += 1;
      if (real.length === 0) { stats.unsound.push({ text, arrow, at }); continue; }
      const first = firstOf(real);
      bump(stats.byCode, first.code);
      // TypeScript's first diagnostic is at the character the lexer named, or before it where TypeScript found an earlier error the lexer did not name: never after it.
      if (first.start - head.length > at) stats.unjustified.push({ text, arrow, at, first: first.start - head.length, code: first.code });
    }
  }
  return stats;
}

// A quoted name directly followed by a `(`: the call of a string, which the reading decides as it decides the call of a name (containerFailsAt). The fuzz counts the bodies it was judged certain in.
const QUOTED_CALL = /(['"])(?:[^'"\\\n]|\\.)*\1\s*\(/;

// A body that ends in an arrow and a return type, as the generators write them (`gap`, RETURN_TYPES): the reading of such a body names an offset no later than the `>` of its last arrow. One
// that does not is read to its end.
const regexEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ENDS_IN_AN_ARROW = new RegExp(`=>(?:[${ANY_SPACE.join('')}]|/\\* \\*/| /\\* - \\*/ |// -\\n)*(?:${RETURN_TYPES.map(regexEscape).join('|')})$`);

// What the lexer says of each `<Name>(…) => R` body, end to end, against TypeScript's parse of the body as an element. `opens(body)` is { generic, ambiguity }: a type
// for certain is { true, null }, a type with a guess { true, 'generic' }.
function judgeBodies(ts, opens, bodyList) {
  const stats = { bodies: 0, certain: 0, quotedCall: 0, typeGuess: 0, element: 0, typeGuessCompiles: 0, typeGuessFails: 0, unsound: [], unjustified: [] };
  const head = 'const e = ';
  for (const body of bodyList) {
    stats.bodies += 1;
    const verdict = opens(body);
    if (!verdict.generic) { stats.element += 1; continue; }
    const name = body.match(/^<[^\w<>]*(\w+)/)[1];
    const diagnostics = parseDiagnostics(ts, `${head}${body}</${name}>;`);
    if (verdict.ambiguity !== null) {
      stats.typeGuess += 1;
      if (diagnostics.length === 0) stats.typeGuessCompiles += 1; else stats.typeGuessFails += 1;
      continue;
    }
    stats.certain += 1;
    if (QUOTED_CALL.test(body)) stats.quotedCall += 1;
    const real = relevant(diagnostics);
    // The reading names an offset no later than the `>` of the last arrow, where the body ends in one; a diagnostic after it is the text after the arrow, not the reading. A body with no
    // arrow after its parameter list is read to its end, and the diagnostic must be in it.
    const limit = ENDS_IN_AN_ARROW.test(body) ? body.lastIndexOf('=>') + 1 : body.length;
    if (real.length === 0) stats.unsound.push({ body });
    else if (firstOf(real).start - head.length > limit) stats.unjustified.push({ body });
  }
  return stats;
}

// The same bodies where a type stands, with the lexer's verdict for each that is valid there. `withSpace` counts the valid ones that hold each kind of white space beyond ASCII: the
// test asserts that every kind was met, since a reading that does not skip one reads a valid type as an element only where one is.
function judgeTypes(ts, opens, bodyList) {
  const stats = { bodies: 0, valid: 0, certain: 0, guess: 0, element: 0, guesses: [], elements: [], withSpace: Object.fromEntries(SPACE_BEYOND_ASCII.map((c) => [c, 0])) };
  for (const body of bodyList) {
    stats.bodies += 1;
    if (parseDiagnostics(ts, `export {};\nlet v: ${body};`).length) continue;
    stats.valid += 1;
    for (const c of SPACE_BEYOND_ASCII) if (body.includes(c)) stats.withSpace[c] += 1;
    const verdict = opens(body);
    if (!verdict.generic) { stats.element += 1; if (stats.elements.length < 12) stats.elements.push(body); }
    else if (verdict.ambiguity === null) stats.certain += 1;
    else { stats.guess += 1; if (stats.guesses.length < 12) stats.guesses.push(body); }
  }
  return stats;
}

// What the lexer says of each program of signaturePrograms — `opens(code, at)` is { generic, ambiguity }: code for certain is { true, null }, an element for certain { false, null }, anything with an
// ambiguity a guess — against TypeScript's parse of it. `children(code, after, name)` is the reading of the text of an element to its closing tag, which names where it fails.
function judgeSignatures(ts, { opens, children }, programs) {
  const sideOf = (verdict) => (verdict.ambiguity !== null ? 'guess' : verdict.generic ? 'code' : 'element');
  const stats = {
    programs: 0, valid: 0, failing: 0,
    signature: { valid: 0, code: 0, guess: 0, element: 0 },
    element: { valid: 0, code: 0, guess: 0, element: 0 },
    precise: { valid: 0, guessed: [] },
    unsound: [], unjustified: [],
  };
  for (const program of programs) {
    stats.programs += 1;
    const side = sideOf(opens(program.code, program.at));
    const diagnostics = parseDiagnostics(ts, program.code);
    if (diagnostics.length === 0) {
      stats.valid += 1;
      stats[program.kind].valid += 1;
      stats[program.kind][side] += 1;
      // A type that parses is no element, and an element that parses is no signature: the verdict that says otherwise is the rewritten token that was data.
      if (program.kind === 'signature' ? side === 'element' : side === 'code') stats.unsound.push({ kind: program.kind, code: program.code });
      if (program.kind === 'element' && program.precise) {
        stats.precise.valid += 1;
        if (side !== 'element') stats.precise.guessed.push(program.code);
      }
    } else if (program.kind === 'element' && side === 'code') {
      stats.failing += 1;
      const read = children(program.code, program.after, program.name);
      if (read === null || read.fails === undefined) {
        stats.unjustified.push({ code: program.code, why: 'the verdict is code, and the text is not read as failing' });
        continue;
      }
      // The failure is supported by a diagnostic at or before the character named: any other than the closing tag codes, which are reported at an opening tag that nothing closes however late TypeScript finds out
      // (CLOSING_TAG_CODES), or — where the lexer names a closing tag that is not the open element's — a closing tag diagnostic, at its name, one past the `/`, or at the opening tag.
      const atClosingTag = program.code[read.fails - 1] === '<' && program.code[read.fails] === '/';
      const real = relevant(diagnostics);
      const early = real.length > 0 && firstOf(real).start <= read.fails;
      const closingTagReported = atClosingTag && diagnostics.some((d) => (CLOSING_TAG_CODES.has(d.code) || d.code === 1003) && d.start <= read.fails + 1);
      if (!early && !closingTagReported) {
        stats.unjustified.push({ code: program.code, why: real.length > 0 ? `the first diagnostic is at ${firstOf(real).start}, after the ${read.fails} named` : 'no diagnostic' });
      }
    }
  }
  return stats;
}

// The whole fuzz at a scale: 1 is the size of the test. `coverage` says, for each white space character the test requires, how many of the texts judged had it right after an `=` and
// right before one: a fuzz that never put a character where a bug is cannot find it.
function runFuzz({ ts, elementFailsAt, opens, scale = 1, seed = 20261003 }) {
  const read = (text, arrow) => elementFailsAt(text, 0, arrow);
  const coverage = Object.fromEntries(TRACKED_SPACE.map((c) => [c, { afterEquals: 0, beforeEquals: 0 }]));
  const tally = function* (texts) {
    for (const text of texts) {
      for (const c of TRACKED_SPACE) {
        if (text.includes(`=${c}`)) coverage[c].afterEquals += 1;
        if (text.includes(`${c}=`)) coverage[c].beforeEquals += 1;
      }
      yield text;
    }
  };
  const punctuation = '<>{}/="\'\\()[],|&;?!*+%^~:.-`#@';
  const tokens = `${punctuation}aT_$1é${ANY_SPACE.join('')}`;
  // Where a token starts next to white space: right after a `<`, a tag name, an attribute name, an `=` and a value, after a `{` and a container's name, and in a tag's type
  // arguments. Every string of up to three characters (four from scale 4) from the characters that matter there and every kind of white space follows each.
  const sites = ['<', '<b', '<b a', '<b a=', '<b a="1"', '{', '{a', '<b<'];
  const site = `>/=" {a:${TRACKED_SPACE.join('')}`;
  const length = scale >= 4 ? 4 : 3;
  const exhaustive = chain(exhaustiveTexts(punctuation, 3), exhaustiveTexts(tokens, 2), ...sites.map((prefix) => exhaustiveTexts(site, length, prefix)));
  return {
    exhaustive: judgeDirect(ts, read, tally(exhaustive)),
    structured: judgeDirect(ts, read, tally(chain(directTexts(seed, 12000 * scale), hiddenTexts(seed + 3, 4000 * scale)))),
    bodies: judgeBodies(ts, opens, tally(chain(bodies(seed + 1, 15000 * scale), hiddenBodies(seed + 4, 4000 * scale)))),
    types: judgeTypes(ts, opens, typeBodies(seed + 2, 8000 * scale)),
    // Every member and parameter form, as a body and as a type (see formBodies).
    forms: { bodies: judgeBodies(ts, opens, formBodies(seed + 5, 12000 * scale)), types: judgeTypes(ts, opens, formBodies(seed + 5, 12000 * scale)) },
    coverage,
  };
}

// The fuzz of a parameter list that neither an arrow nor a colon follows (see signaturePrograms): 25000 heads per scale, each as a type and as an element.
function runSignatureFuzz({ ts, opens, children, scale = 1, seed = 20261009 }) {
  return judgeSignatures(ts, { opens, children }, signaturePrograms(seed, 25000 * scale));
}

module.exports = { mulberry32, bodies, hiddenBodies, typeBodies, formBodies, signaturePrograms, directTexts, hiddenTexts, exhaustiveTexts, judgeDirect, judgeBodies, judgeTypes, judgeSignatures, runFuzz, runSignatureFuzz, CLOSING_TAG_CODES, ASCII_SPACE, SPACE_BEYOND_ASCII, ANY_SPACE, TRACKED_SPACE };
