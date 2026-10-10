'use strict';

// Pages shaped like the ones a generative-page author writes, each valid TSX with one real navigation call in a handler — the call the build must resolve. They hold the text that the lexer's reading of a `<` and of
// a `/` is about: JSX text that starts with a parenthesis (a note, a hint, a URL, a path, a link), a method whose type parameters follow a name, and a callee in parentheses.
//   - RESOLVED_PAGES are read for certain: the one real call is resolved, and nothing else is.
//   - REFUSED_PAGES have a call signature whose default value puts a `/` after a line comment, where a regex may begin: whether it does decides where the parameter list ends, or whether a closing tag is hidden in
//     the regex, so a token that is data cannot be told from a call, and the build halts on the page. (The released lexer refuses one of the two and reads the other wrong.)
//
// No page holds a real environment, tenant or person.
const page = (...lines) => `${lines.join('\n')}\n`;
const IMPORTS = ["import * as React from 'react';", 'declare const navigateTo: (input: unknown) => void;'];
const CALL = 'navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" })';
const HANDLER = `  const open = () => ${CALL};`;
const RETURN = '  return <div><button onClick={open}>Detail</button></div>;';
const COMPONENT = ['const GeneratedComponent = () => {', HANDLER, RETURN, '};', 'export default GeneratedComponent;'];
// The same, with the element that the page declares shown before the button.
const withElement = (declaration, shown) => page(...IMPORTS, 'const GeneratedComponent = () => {', `  ${declaration.replace(/\n/g, '\n  ')}`, HANDLER, `  return <div>${shown}<button onClick={open}>Detail</button></div>;`, '};', 'export default GeneratedComponent;');

const RESOLVED_PAGES = [
  // `async<T>(x: T)` is a method named `async` with type parameters: its `<T>` is no element and no cast.
  { name: 'a method named like a modifier, with type parameters', code: page(...IMPORTS, 'const o = { async<T>(x: T) { return x; } };', 'const GeneratedComponent = () => {', HANDLER, '  void o;', RETURN, '};', 'export default GeneratedComponent;') },
  // A regex in the text of an element is text.
  { name: 'JSX text that has a regex-like default in it', code: page(...IMPORTS, 'const note = <p>(a = /x/)</p>;', 'const GeneratedComponent = () => {', HANDLER, '  return <div>{note}<button onClick={open}>Detail</button></div>;', '};', 'export default GeneratedComponent;') },
  // A callee in parentheses: the `(` after `return` is no parameter list.
  { name: 'a callee in parentheses', code: page(...IMPORTS, 'const GeneratedComponent = () => {', `  const open = () => { return (navigateTo)({ pageType: "generative", pageId: "PAGEREF_detail" }); };`, RETURN, '};', 'export default GeneratedComponent;') },
  {
    name: 'JSX text that starts with a parenthesis and holds links, a keyword, a number',
    code: page(...IMPORTS, 'declare const user: { name: string };', 'declare const profile: string;', 'const h1 = <small>(Size: 10 MB max, <a href="/x">upgrade</a>)</small>;', 'const h2 = <small>(Name: {user.name}, <a href={profile}>edit</a>)</small>;',
      'const h3 = <small>(Mode: new <a href="/x">beta</a>)</small>;', 'const h4 = <small>(Hint: import <a href="/x">docs</a>)</small>;', 'const h5 = <small>(Tip: use <code>=</code>)</small>;', 'const GeneratedComponent = () => {', HANDLER,
      '  return <div>{h1}{h2}{h3}{h4}{h5}<button onClick={open}>Detail</button></div>;', '};', 'export default GeneratedComponent;'),
  },
  { name: 'JSX text with an `=` and a nested element, and an attribute named like a keyword', code: page(...IMPORTS, 'declare const Flag: (props: { extends?: boolean }) => JSX.Element;', 'const n1 = <p>(a = <b>c</b>)</p>;', 'const f1 = <Flag extends />;', 'const GeneratedComponent = () => {', HANDLER, '  return <div>{n1}{f1}<button onClick={open}>Detail</button></div>;', '};', 'export default GeneratedComponent;') },
  // The text after `(a);` is lines of prose: a URL, a path that starts a line. No type has them for its members, so no closing tag is hidden in a regex that begins at the path.
  { name: 'a note, a URL on its own line, and a path that starts a line', code: withElement('const e = <p>(a);\n  https://contoso.com\n  /b</p>;', '{e}') },
  { name: 'a note, a label and a URL, and a path that starts a line', code: withElement('const e = <p>(a);\n  Docs: https://contoso.com/help\n  /b</p>;', '{e}') },
  { name: 'a note, a comma, a word with a comment, and a path that starts a line', code: withElement('const e = <p>(a),\n  b // c\n  /d</p>;', '{e}') },
  { name: 'a note, a line break, a URL, and a path that starts a line', code: withElement('const e = <p>(a)\n  https://contoso.com/x\n  /b</p>;', '{e}') },
  // A bracket where a member would begin is no member (TS1131), so nothing after it is a type's.
  { name: 'a note, a bracketed word and a URL, and a path that starts a line', code: withElement('const e = <p>(a);\n  [x] https://contoso.com\n  /b</p>;', '{e}') },
  // A link is an element with an attribute, which no type has the tag of: its text is JSX text, and a URL, an apostrophe, a back-tick or a comment opener in it opens nothing, whatever stands after the link.
  { name: 'a hint that holds a link whose text is a URL', code: withElement('const e = <p>(Docs: <a href="https://contoso.com/help">https://contoso.com/help</a>)</p>;', '{e}') },
  { name: 'a note that holds a link whose text has an apostrophe and a back-tick, and a second link', code: withElement("const e = <p>(a); <a href=\"/x\">it's `quick`</a> and <a href=\"/y\">that's</a></p>;", '{e}') },
  { name: 'a note that holds a link whose text opens a comment, and a path that starts a line', code: withElement('const e = <p>(a), <a href="/x">/* tip</a> done\n  /b</p>;', '{e}') },
  { name: 'a hint that holds a link, a line comment in its text, and a quote after it', code: withElement("const e = <p>(a)\n  <a href=\"/x\">see // here</a> 'not a string</p>;", '{e}') },
  // A button, a label and a link whose attribute has a keyword for its name or its value (`type="button"`, `for="x"`, `as="span"`) are elements to every reading: the text in them is JSX text, and nothing after them is guessed.
  { name: 'a note that holds a button, a label and a link with keyword attributes', code: withElement("const e = <p>(a); <button type=\"button\">see https://contoso.com</button> <label for=\"x\">it's</label> <Link as=\"span\" href=\"/x\">`t</Link> `u`</p>;", '{e}') },
  { name: 'a note, a fragment after a comma, and a path that starts a line', code: withElement('const e = <p>(a), <>x // y</> and\n  /b</p>;', '{e}') },
  // A line that opens a parenthesis, or ends in an initializer, after a note: no type has it for a member where its `(` opens a parameter list that a `/` fails, or after an `=` where no member of a type begins.
  { name: 'a note and a line that opens a parenthesis, then a comment and a path on the next line', code: withElement('const e = <p>(optional);\n  foo( // note\n  /docs</p>;', '{e}') },
  { name: 'a note and a line that opens a parenthesis, where a member of a type may begin (after `return`)', code: page(...IMPORTS, 'const GeneratedComponent = () => {', HANDLER, '  return <p>(optional);', '    foo( // note', '    /docs <button onClick={open}>Detail</button></p>;', '};', 'export default GeneratedComponent;') },
  { name: 'a note and a line that ends in an initializer, then a comment and a path on the next line', code: withElement('const e = <p>(optional);\n  x = // note\n  /docs</p>;', '{e}') },
  // A tag whose attributes each stand on a line of its own, as prettier writes one, has every `=` on the line of its word: no member of a type is that, so the tag is an element's, and the URL, the apostrophe and the comment opener in its
  // text open nothing. A fragment on a line of its own after an operator, a separator or a tag stands where no operand ends.
  { name: 'a hint that holds a link whose attributes are on lines of their own, with a URL in its text', code: withElement('const e = <p>(optional){" "}\n  <a\n    href="https://contoso.com/help"\n    target="_blank"\n    rel="noreferrer"\n  >\n    see https://contoso.com\n  </a>\n</p>;', '{e}') },
  { name: 'a hint that holds a fragment on a line of its own after a tag, with an apostrophe and a URL in its text', code: withElement("const e = <p>(optional)\n  <b>x</b>\n  <>it's https://contoso.com/x</>\n</p>;", '{e}') },
  // After a `:` a `[` opens a tuple type, whose first type is no `/`: the note, the unfinished line and the path on the next line are no type's, where a member of a type may begin (after `return`).
  { name: 'a note and a line that opens a bracket after a colon, where a member of a type may begin (after `return`)', code: page(...IMPORTS, 'const GeneratedComponent = () => {', HANDLER, '  return <p>(optional);', '    Total: [ // note', '    /docs <button onClick={open}>Detail</button></p>;', '};', 'export default GeneratedComponent;') },
];

// A call signature whose default value has a `/` on the line after a line comment: a regex may begin there, and TypeScript reads one. In the first page the regex holds the `)` that would end the parameter list, and the
// string after the list holds the closing tag of the signature's head and a token that is data; in the second the regex holds the closing tag and the token. A lexer that read the `/` as a division, or the head as an element,
// took the closing tag for its own and rewrote the token that is data as well as the real call.
const DECOY = '</T>;navigateTo({ pageType: "generative", pageId: "PAGEREF_detail" })//';
const REFUSED_PAGES = [
  {
    name: 'a default value whose regex follows a line comment, in a signature',
    code: page(...IMPORTS, 'interface Callable { <T>(a = 1 + // fallback', '  /[)]/); m: \'' + DECOY + '\' }', ...COMPONENT),
  },
  {
    name: 'a method whose default holds the closing tag in a regex after a line comment',
    code: page(...IMPORTS, 'interface Callable { <T>(x); m(a = 1 + // fallback', '  /[' + DECOY + ']/): void }', ...COMPONENT),
  },
];

// A call signature `<T>(x)` and the text after it, which the lexer reads to the closing tag `</T>` that an element would end at, and that a type with the same text for its members may hold in a string, a template, a
// comment or a regex. Each page below is valid to TypeScript's parser (the type checker rejects an initializer or a computed name in a type; the parser and a transpile do not), has one real call after the type, and
// holds a token in the type that is data: it is in a string, a template or a regex that holds the closing tag. A lexer that took the head for an element rewrote that token as well as the real call, so each page is
// refused, with the `generic` guess at the `<` of the head, and nothing in it is rewritten.
//   - A member named by a number: `1e-5` is ONE numeric literal to the scanner (scanNumber, a sign after the `e` is part of it), a valid name, so the type exists and its string holds the closing tag.
//   - The text of a nested element in an expression of a member — a default value or a computed name. A type reads the element, which has no comment or string in its text, and code goes on after the closing tag of the
//     nested element: a `//`, a `/*`, a quote or a back-tick in its text opens nothing that reaches past the closing tag, and the operator after it is what decides whether the `/` on the next line begins a regex.
//     The released lexer reads the pages with a quote, a back-tick or a comment in the nested text wrong too; the pages with a signed exponent it refuses.
const CALL_NO_SPACE = 'navigateTo({pageType:"generative", pageId:"PAGEREF_detail"});';
const HOLD = `'</T>;${CALL_NO_SPACE}//'`;
const TEMPLATE = `\`\n</T>;${CALL_NO_SPACE}//\``;
const REGEX = `/[</T>;${CALL_NO_SPACE}//]/`;
const typePage = (type) => `interface I { <T>(x); ${type} }\n${CALL_NO_SPACE}\n`;
const HIDDEN_CLOSING_TAG_PAGES = [
  { name: 'a member named by a number with a signed exponent', code: typePage(`1e-5: ${HOLD}`) },
  { name: 'a member named by a number with a positive exponent, and a method type', code: `interface I { <T>(x), 1E+5(): ${HOLD} }\n${CALL_NO_SPACE}\n` },
  { name: 'a construct signature, a line break, and a member named by a number with a signed exponent and an underscore', code: `interface I { new <T>(x)\n  1_0e+1?: ${HOLD} }\n${CALL_NO_SPACE}\n` },
  { name: 'a line comment in a nested element, an operator, and a regex on the next line that holds the closing tag', code: typePage(`m(a = <b>x // y</b> +\n${REGEX}): void`) },
  { name: 'a line comment in a nested element in a computed name', code: typePage(`[<b>x // y</b> +\n${REGEX}.source]: string`) },
  { name: 'a line comment in a nested fragment, a real comment, and a regex', code: typePage(`[<>x // y</> ||\n  // more\n${REGEX}]: string`) },
  { name: 'a quote in a nested element, an operator, and a string that holds the closing tag', code: typePage(`m(a = <b>'x</b> + ${HOLD}): void`) },
  { name: 'a quote in a nested element in an element, an operator, and a string that holds the closing tag', code: typePage(`m(a = <b><i>'x</i></b> + ${HOLD}): void`) },
  { name: 'a quote in a nested element in a computed name', code: typePage(`[<b>'x</b> + ${HOLD}]: string`) },
  { name: 'a quote in a nested element in an initializer', code: typePage(`m: A = <b>'x</b> + ${HOLD}`) },
  { name: 'a quote in a nested fragment, a block comment, and a string that holds the closing tag', code: typePage(`m(a = <>'x</> + /* c */ ${HOLD}): void`) },
  { name: 'a back-tick in a nested element, an operator, and a template that holds the closing tag', code: typePage(`m(a = <b>\`x</b> + ${TEMPLATE}): void`) },
  { name: 'a line comment in a nested element, an operator, and a template that holds the closing tag', code: typePage(`m(a = <b>x // y</b> + ${TEMPLATE}): void`) },
  // A string, a template or a regex that holds the text of an element is one token, whose quote ends it: the string after it holds the closing tag.
  { name: 'a string that holds an element, an operator, and a string that holds the closing tag', code: typePage(`m(a = '<b>c</b>' + ${HOLD}): void`) },
  { name: 'a template that holds an element, an operator, and a template that holds the closing tag', code: typePage(`m(a = \`<b>c</b>\` + ${TEMPLATE}): void`) },
  { name: 'a regex that holds an element, an operator, and a string that holds the closing tag', code: typePage(`m(a = /<b>c<\\/b>/ + ${HOLD}): void`) },
  { name: 'a fragment in one string and its closing tag in a template, then a template that holds the closing tag', code: typePage(`m(a = '<>' + \`</>\` && ${TEMPLATE}): void`) },
  // A nested tag that is no element: the type arguments of a name, a comparison, the type parameters of a signature. The text after its `>` is code, and its closing tag is in a string that comes before the one that holds
  // the closing tag of the head, so that quote is the end of one string and the start of the next — where an element would take it for text.
  { name: 'type arguments, and a string that holds their closing tag before the string that holds the closing tag of the head', code: typePage(`m: Array<b> = '</b>' + ${HOLD}`) },
  { name: 'type arguments in a member of its own, and a string that holds their closing tag', code: typePage(`m: A<b>; n: '</b>' | ${HOLD}`) },
  { name: 'a comparison, and a string that holds the closing tag of its element', code: typePage(`m: A = a<b>c; n: '</b>' | ${HOLD}`) },
  { name: 'the type parameters of a signature, and a string that holds their closing tag', code: typePage(`<b>(y): '</b>'; q: ${HOLD}`) },
  { name: 'the type parameters of a signature with a constraint, and a string that holds their closing tag', code: typePage(`<U extends A>(y): '</U>'; k: ${HOLD}`) },
  // A tag with a keyword of TypeScript's in it is code to a type — a modifier of a type parameter (`<public U>`), an operator in a comparison (`a <b in c>`), a type operator in type arguments (`Array<keyof X>`) — and so is an empty
  // pair of angle brackets after a name, a call or a bracket, or before a parenthesis (`<>(y)`, `f(x)<>`): the text after the `>` is code, and a string there holds the closing tag. (The parser accepts them all; the checker does not.)
  { name: 'a type parameter with a modifier, and a string that holds its closing tag', code: typePage(`<public U>(y): '</public>'; q: ${HOLD}`) },
  { name: 'a type parameter with a modifier after a name, and a string that holds its closing tag', code: typePage(`m<static U>(y): '</static>'; q: ${HOLD}`) },
  { name: 'a comparison with `in` between two names in a default, and a string that holds the closing tag of its element', code: typePage(`m(p = x <a in b> '</a>' + ${HOLD}): void`) },
  { name: 'a comparison with `typeof` after the `<` in a default, and a string that holds the closing tag of its element', code: typePage(`m(p = x <typeof U> '</typeof>' + ${HOLD}): void`) },
  { name: 'type arguments with a type operator in a type, and a string that holds their closing tag', code: `type X = { a: 1 };\ninterface I { <T>(x); m: Array<keyof X>; n: '</keyof>'; q: ${HOLD} }\n${CALL_NO_SPACE}\n` },
  { name: 'empty type parameters before a parenthesis, and a string that holds their closing tag', code: typePage(`<>(y): '</>'; q: ${HOLD}`) },
  { name: 'empty type arguments after a call in a default, and a string that holds their closing tag', code: typePage(`m(p = f(x)<> || '</>' + ${HOLD}): void`) },
  // Two regions that end at one place — two line comments on a line, each opened in the text of an element of its own — are two crossings of the closing tags between them, told by where each starts.
  { name: 'two line comments on one line in two nested elements, an operator, and a template that holds the closing tag', code: typePage(`m(a = <b>//</b> - <i>//</i> ?? ${TEMPLATE}): void`) },
  { name: 'two line comments on one line in two nested elements in a computed name, and a regex that holds the closing tag', code: typePage(`[<b>x // y</b> + <i>u // v</i> +\n${REGEX}]: string`) },
  // A line break ends a member of a type, so a tag whose `=` stands on a line of its own — or whose valued `get` does — is an initializer that ends at the break and a member with an initializer of its own: the string after it holds
  // the closing tag. A line comment may end in any character, so a fragment on the next line may follow an operand before it (`f // note:` and `<> || …` is `f<> || …`), and so may a number that ends in a dot (`1.<>`).
  { name: 'a tag whose attribute has its `=` on a line of its own, in an initializer, and a string that holds the closing tag', code: typePage(`m: A = x <a\nhref\n="/x"> '</a>' + ${HOLD}`) },
  { name: 'a tag whose valued `get` stands on a line of its own, in an initializer, and a string that holds the closing tag', code: typePage(`m: A = x <a\nget="/x"> '</a>' + ${HOLD}`) },
  { name: 'a fragment after an operand and a line comment that ends in a colon, in a default, and a string that holds the closing tag', code: typePage(`m(p = f // note:\n<> || '</>' + ${HOLD}): void`) },
  { name: 'a fragment after a number that ends in a dot, in a default, and a string that holds the closing tag', code: typePage(`m(p = 1.<> || '</>' + ${HOLD}): void`) },
  // The `(` of an import type has no line-break rule: `typeof import` and a line break, then the path, which holds the closing tag. After `get` or `set` a `[` begins an accessor's computed name, an expression that a regex may hold.
  { name: 'an import type with its `(` on the next line, and a path that holds the closing tag', code: typePage(`m: typeof import\n(${HOLD})`) },
  { name: 'an accessor whose computed name holds a comma and a regex that holds the closing tag', code: typePage(`get [a, ${REGEX}](): string`) },
];

module.exports = { RESOLVED_PAGES, REFUSED_PAGES, HIDDEN_CLOSING_TAG_PAGES, DECOY };
