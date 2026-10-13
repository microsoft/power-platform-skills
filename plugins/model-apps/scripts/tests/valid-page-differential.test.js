'use strict';
// The regression net of the lexer: pages TypeScript parses, each with a navigation call after it, read by this lexer and by the base it was derived from.
//
// The navigation reader refuses what its lexer cannot read for certain (source-literals.js, `onAmbiguity`), and a refusal of a page that compiles costs the author a retry. So the claim the
// differential makes is one of precision, and the other half of it is soundness:
//
//   - SOUND: whatever page TypeScript parses, a call or string that TypeScript reads as DATA — a regex or a string that holds the text of a navigation call — is never rewritten. Each page
//     is read again with two such decoys after it; the base is counted too, which rewrites them in the places this lexer refuses.
//   - PRECISE: every valid page the lexer refuses is one of the RECORDED classes below, each a place where two programs share the text up to the decision and compile differently
//     (TWO_WAY shows both, with TypeScript's reading of each), and every refusal names its guess. A page that is refused and belongs to no class fails the test, so a regression of a new
//     shape cannot arrive silently; a class that no page meets fails too, so the list cannot go stale.
//   - NO REGRESSION: where the base is given, every valid page that it resolves is resolved here: a page lost anywhere fails the test. The count of the pages that this lexer resolves and the base does not is reported.
//
// The pages are tests/helpers/valid-pages.js: generic arrows and function expressions in every position, casts and `satisfies` with every operator and operand after them, instantiation
// expressions and hooks, interfaces and type literals with every member form, generic function types in every position and with every kind of parameter list, destructured and default
// parameters, and the statements an everyday page is made of. The base is optional: BASE_LIB_PATH points at the scripts/lib directory of the lexer before this change; without it the
// comparison is skipped and the rest runs. What the comparison asserts depends on the base, because the decoys are what a lexer that misreads rewrites: a base from before the lexer was hardened misreads
// shapes this corpus holds and rewrites the data after them on at least 100 pages, which shows that the net sees a misread (and this lexer rewrites none of them); a base that reads every page of the
// corpus right — the previous release, whose misreads are in pages that hold the text of a call in their own text, which the decoys after a page cannot show (TWO_WAY has those pairs) — rewrites none, so
// what it shows is the improvement: pages that this lexer resolves and the base does not. Either way the count of each is reported.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadTypescriptOracle, loadBaseLexer } = require('./helpers/typescript-oracle.js');
const { validPages, openLinePages, NAVIGATION_CALL, SIGNATURE_MEMBERS, HIDDEN_CLOSING_MEMBERS, HIDING_ELEMENTS, INITIALIZER_ELEMENTS, FAILING_LIST_ELEMENTS, EXACT_INITIALIZER_ELEMENTS, PROSE_ELEMENTS, SHAPED_PROSE_ELEMENTS, PROSE_OPEN_ELEMENTS } = require('./helpers/valid-pages.js');
const next = require('../lib/pageref-resolver.js');

const SKIP = 'no TypeScript parser oracle: set TYPESCRIPT_ORACLE_PATH to a typescript package to run it';
const ID = '11111111-1111-4111-8111-111111111111';
const loadBase = loadBaseLexer;

// What a lexer does with a page: whether it resolves the call the page makes (and nothing else is changed), and the guess it names where it does not.
function reading(lib, code) {
  const resolved = lib.resolvePageRefs(new Map([['page', { code }]]), new Map([['detail', ID]]));
  const deployed = resolved.deployment.get('page');
  const frontier = lib.navigationFrontier ? lib.navigationFrontier(code) : null;
  return { deployed, resolves: deployed === code.replace('"PAGEREF_detail"', `"${ID}"`), kind: frontier ? frontier.kind : null };
}

// Two places where data holds the text of a navigation call, after the snippet and before the real call. TypeScript reads a regex and a string; a lexer that read the snippet wrongly reads
// them as code (a string that holds the closing tags that an element read by mistake would be looking for), and rewrites the token in them.
const DECOY_REGEX = `  const decoyRegex = /${NAVIGATION_CALL.replace(/;$/, '')}/;`;
const DECOY_STRING = `  const decoyString = '</T></U></b></A></B></W></Cmp>;${NAVIGATION_CALL}//';`;
const withDecoys = (code) => code.replace(`  ${NAVIGATION_CALL}`, `${DECOY_REGEX}\n${DECOY_STRING}\n  ${NAVIGATION_CALL}`);
const decoysIntact = (deployed) => deployed.includes(DECOY_REGEX) && deployed.includes(DECOY_STRING);

// ─── The classes of valid page this lexer refuses ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Each is { kind, what, matches }: the guess it names, the two programs that share the text, and which generated pages are in it.
const ANGLE_OPERATORS = ['>', '>>', '>>>', '/'];
const SLASH_OPERANDS = ['/re/', '<b>text</b>', '<b>{y}</b>', '<b/>', '<>x</>', '<T extends X>text</T>'];
// A `/` or `<` after a `/` is no class any more: the lexer read the first `/`, so it knows whether it ended a regex (an operand ended: a division or a comparison follows) or was the division
// operator (an operand follows: a regex or an element), and decides by it (source-literals.js, `ends`). What is left of the pair that once stood for it is a `>`: `x as A<B> / /re/` is a division
// by a regex after type arguments, and `a > / /re/` a comparison with a regex, which the first class holds.
const REFUSAL_CLASSES = [
  {
    id: 'a ">" before a "/" or "<"',
    kind: 'angle',
    what: 'a `>` that is not the end of `=>` and closes no cast, before a `/` or a `<`: a comparison and then a regex or an element, or the end of type arguments and then a division. `a > /re/` and `f<A> / x / 2` end in the same `> /`, and the two are told apart by whether what stands between the `<` and the `>` is a list of types, which only a type parser says.',
    matches: (page) => page.group === 'everyday' && /^const g\d+ = /.test(page.name),
  },
  {
    id: 'a generic call signature in an object type',
    kind: 'generic',
    what: 'a `<Name>`, a parameter list and a `:`: a call or construct signature with type parameters in an object type, or JSX text that starts with a parenthesis. `interface P { <U>(x: U): T }` and `<U>(x: U): T</U>` are the same text.',
    matches: (page) => /^type literal in a generic function type|^interface member|^type literal member|^class implements|^type literal in a parameter/.test(page.group) && /^(new )?<U>\(x: U\): T;$/.test(page.name),
  },
  {
    id: 'a call signature with no return type, and its closing tag in a string, a template or a comment of its type',
    kind: 'generic',
    what: 'a `<Name>`, a parameter list and no return type, then a string, a template or a comment of the same type that holds `</Name>`: `interface P { <U>(x: U); a: \'</U>\' }` is a type, and with that `</U>` closing it `<U>(x: U); a: \'</U>` is an element whose text starts with a parenthesis.',
    matches: (page) => /^type literal in a generic function type|^interface member|^type literal member|^class implements|^type literal in a parameter/.test(page.group) && HIDDEN_CLOSING_MEMBERS.includes(page.name),
  },
  {
    id: 'JSX text that starts with a parenthesis, then a `,`, `;` or line break, and a comment, a template or a regex that is open at its closing tag',
    kind: 'generic',
    what: 'the text after the `)` could be the members of a type that holds a comment, a template or a regex with the closing tag in it: `interface P { <U>(x: U); // </U> }` and `<U>(x: U); // </U>` share their text, and the closing tag is the end of the element in one and inside a comment in the other. Text before it that no type can hold (two names on a line, a name and a `/`) leaves no such type, and is read as the element. After an `=`, a `(`, a `[`, a `:` or an `=>` no member of a type begins, and the text is the element for certain.',
    matches: (page) => page.group === 'parenthesised element' && HIDING_ELEMENTS.includes(page.element),
  },
  {
    id: 'JSX text that starts with a parenthesis, where something may start an expression before its `)` and a `/`, a `<` or a back-tick follows that the scan cannot read exactly',
    kind: 'generic',
    what: 'the parenthesised text could be the parameter list of a call signature with a default, a computed name, a decorator, an accessor\'s body or a constraint, and what follows may be a regex, JSX or a template that holds a `)` of its own: `interface P { <U>(a = f(/[)]/)); m: \'</U>\' }` and `<U>(a = f(/[)]/)); m: \'</U>` share their text, and the `)` that ends the list is another one in each. A default that starts with a regex or an element, a `/` that divides a name or a number, and a template with no `${` are read exactly. A `/` after a line comment is none of those: the comment may end in a word, and the regex on the next line is no division (`<U>(a = 1 + // c` and `/[)]/)`).',
    matches: (page) => page.group === 'parenthesised element' && INITIALIZER_ELEMENTS.includes(page.element),
  },
  {
    id: 'an element whose first attribute is `extends` and that closes at once, where another `/` closes the regex on its line',
    kind: 'generic',
    what: 'a `<Name extends` and a `/`: an element with an attribute named `extends` where an expression starts, and type parameters in a type, whose constraint is read as an expression where it starts no type — here a regex that another `/` on the line closes. `const e = <T extends />; const r = a / b;` and `let f: <T extends />; const r = a />(a: T) => T;` begin with the same text. (A regex that its line does not close is unterminated, TS1161: only the element compiles.)',
    matches: (page) => page.group === 'everyday' && /^const e3 = /.test(page.name),
  },
  {
    id: 'a division on the next line',
    kind: 'newline',
    what: 'a `/` on a later line than the operand before it, where a regex could close on its line: a division that continues the statement, or (after a type) a regex that begins the next one. `const q = x` LF `/ y / z` and `let v: number` LF `/ y /.test(z)` are the same text.',
    matches: (page) => page.group === 'everyday' && page.name === 'const r5 = x\n/ y / z;',
  },
];

// ─── Pairs of programs with the same text, whose readings differ ───────────────────────────────────────────────────────────────────────────────────────────
// [what TypeScript reads, the snippet, the real navigation calls TypeScript finds in the page]. Each pair compiles; each page is refused after the class's guess; and where the base is given,
// at least one of the pair is read wrong by it — it rewrites the token of data, or leaves a real call as it was.
const CALL = 'navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})';
const TWO_WAY = [
  {
    kind: 'angle',
    pairs: [
      ['a comparison with a regex that holds the call', `const k = a > /${CALL}/;`, 0],
      ['an instantiation expression divided by the call', `const k = f<A> / ${CALL} / 2;`, 1],
      ['an instantiation expression divided, and a regex that holds the call', `const k = f<A> / 2; const re = /${CALL}/;`, 0],
    ],
  },
  {
    kind: 'generic',
    // An element whose text starts with a parenthesis stands where a member of a type may begin at its head — after a `return` here, where `return <U>(x)` is also a method named `return` — so that the text alone does not tell the two programs
    // apart. After an `=`, a `(`, a `[`, a `:` or an `=>` no member begins, and such an element is read for certain (source-literals.js, NO_MEMBER_BEFORE).
    pairs: [
      ['an interface with a call signature, and a string that holds the call', `interface P { <U>(x: U): T; }\nconst s = '</U>;${CALL};//';`, 0],
      ['an element whose text starts with a parenthesis, then the call', `const el = <U>(x: U): T;</U>;\n${CALL};`, 1],
      ['a type literal with a call signature, then the call', `type P = { <U>(x: U): T; };\n${CALL};`, 1],
      // The same text with no return type: the type's string holds the closing tag and the call, and an element's text ends at the closing tag that is in it.
      ['an interface with a call signature with no return type, and a string that holds the closing tag and the call', `interface P { <U>(x: U); a: '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis, which ends at the closing tag in what is a string to the type, then the call', `return <U>(x: U); a: '</U>;${CALL};//'`, 1],
      ['an interface with a call signature with no return type, and a comment that holds the closing tag and the call', `interface P { <U>(x: U); // </U>;${CALL};\n}`, 0],
      ['an element whose text starts with a parenthesis, which ends at the closing tag in what is a comment to the type, then the call', `return <U>(x: U); // </U>;${CALL};`, 1],
      // A default in the parameter list: the regex holds a `)`, which ends the list in a scan that does not read the regex and is the regex's to the type. Where the regex is the default's first token the scan reads
      // it exactly; here it is an argument, which the scan does not.
      ['an interface with a call signature whose default calls a function with a regex that holds a `)`, and a string that holds the closing tag and the call', `interface P { <U>(a = f(/[)]/)); m: '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis and holds the same default, then the call', `const el = <U>(a = f(/[)]/)); m: '</U>;\n${CALL};`, 1],
      // A default whose regex follows a line comment: the last token before the comment is the operator, so the `/` on the next line begins a regex, whose `)` is not the one that ends the list. Taken for a division, the
      // `/` ended the list at that `)`, and (for the text of a signature with no return type) hid the closing tag of the head in the regex. The base reads the second pair wrong: it rewrites the token in the regex.
      ['an interface with a call signature whose default holds a regex after a line comment, and a string that holds the closing tag and the call', `interface P { <U>(a = 1 + // c\n/[)]/); m: '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis and holds the same default, then the call', `const el = <U>(a = 1 + // c\n/[)]/); m: '</U>;\n${CALL};`, 1],
      ['an interface with a call signature with no return type, and a later member whose default holds, after a line comment, a regex that holds the closing tag and the call', `interface P { <U>(x); m(a = 1 + // c\n/[</U>;${CALL}//]/): void }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); m(a = 1 + // c\n/[</U>;\n${CALL};//]/): void`, 1],
      // `<T extends` and a `/`: type parameters whose constraint is a regex in a type, an element with an attribute named `extends` where an expression starts. A regex that its line does not close is no type's.
      ['a function type whose type parameter\'s constraint is a regex that holds the call', `let f: <T extends />;${CALL};[/]/>(a: T) => T;`, 0],
      ['an element whose first attribute is `extends` and that closes at once, with another `/` on its line, then the call', `const el = <T extends />; const r = a / b; ${CALL};`, 1],
      // A member named by a number: `1e-5` is ONE token to the scanner, so a type that has one for a name, then a string that holds the closing tag and the call, is a type, and `1e` and a `-` are two names and a sign in the text of an element.
      ['an interface with a call signature with no return type, and a member named `1e-5` whose type is a string that holds the closing tag and the call', `interface P { <U>(x); 1e-5: '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); 1e-5: '</U>;${CALL};//'`, 1],
      // A nested element in a default value: its text is JSX text, which has no comment or string in it, and code goes on after its closing tag. Taken for code, `x // y</b> +` is a comment up to the end of its line, and the `/` on the
      // next line a division; and `<b>'x</b> + '` is a string, which hides the quote that opens the string that holds the closing tag and the call.
      ['an interface with a call signature with no return type, and a later member whose default holds a nested element with a `//` in its text, an operator, and on the next line a regex that holds the closing tag and the call', `interface P { <U>(x); m(a = <b>x // y</b> +\n/[</U>;${CALL}//]/): void }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); m(a = <b>x // y</b> +\n/[</U>;${CALL};//]/): void`, 1],
      ['an interface with a call signature with no return type, and a later member whose default holds a nested element with a quote in its text, and a string that holds the closing tag and the call', `interface P { <U>(x); m(a = <b>'x</b> + '</U>;${CALL};//'): void }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); m(a = <b>'x</b> + '</U>;${CALL};//'): void`, 1],
      ['an interface with a call signature with no return type, and a later member whose default holds a nested element with a `//` in its text, an operator, and a template that holds the closing tag and the call', `interface P { <U>(x); m(a = <b>x // y</b> + \`\n</U>;${CALL};//\`): void }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); m(a = <b>x // y</b> + \`\n</U>;${CALL};//\`): void`, 1],
      // A nested tag that a type reads as code although its second word is no `extends`: the type parameters of a signature with a modifier (`<public V>`), a comparison with a keyword in it (`a <b in c> d`), the type arguments of a name with a type
      // operator in them (`Array<keyof X>`), an empty list of type parameters or type arguments (`<>(y)`, `f(x)<> || …`). The tag is an element's, to the reading that takes the head for one, whose closing tag is in the string after it.
      ['an interface with a call signature with no return type, a signature whose type parameters start with a modifier, and a string that holds the closing tag and the call', `interface P { <U>(x); <public V>(y): '</public>'; q: '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis and holds an element named `public`, then the call', `return <U>(x); <public V>(y): '</public>'; q: '</U>;${CALL};//'`, 1],
      ['an interface with a call signature with no return type, and a member whose default compares with a keyword in the tag, and a string that holds the closing tag and the call', `interface P { <U>(x); m(p = a <b in c> '</b>' + '</U>;${CALL};//'): void }`, 0],
      ['an element whose text starts with a parenthesis and holds an element with an attribute named `in`, then the call', `return <U>(x); m(p = a <b in c> '</b>' + '</U>;${CALL};//'): void`, 1],
      ['an interface with a call signature with no return type, and a member whose type arguments start with a type operator, and a string that holds the closing tag and the call', `interface P { <U>(x); m: Array<keyof X> = '</keyof>' + '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis and holds an element named `keyof`, then the call', `return <U>(x); m: Array<keyof X> = '</keyof>' + '</U>;${CALL};//'`, 1],
      ['an interface with a call signature with no return type, a signature with an empty list of type parameters, and a string that holds the closing tag and the call', `interface P { <U>(x); <>(y): '</>'; q: '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis and holds a fragment, then the call', `return <U>(x); <>(y): '</>'; q: '</U>;${CALL};//'`, 1],
      ['an interface with a call signature with no return type, and a member whose default has an empty list of type arguments after a call, and a string that holds the closing tag and the call', `interface P { <U>(x); m(p = f(x)<> || '</>' + '</U>;${CALL};//'): void }`, 0],
      ['an element whose text starts with a parenthesis and holds a fragment, then the call', `return <U>(x); m(p = f(x)<> || '</>' + '</U>;${CALL};//'): void`, 1],
      // Two comments on one line, each opened in the text of its own nested element, end at the same line break: both are places where the type's reading and the element's differ.
      ['an interface with a call signature with no return type, and a member whose default holds two nested elements with a `//` in their text, and a template that holds the closing tag and the call', `interface P { <U>(x); m(a = <b>//</b> - <i>//</i> ?? \`\n</U>;${CALL};//\`): void }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); m(a = <b>//</b> - <i>//</i> ?? \`\n</U>;${CALL};//\`): void`, 1],
      // A `/` on the line after a comment that stands behind an open `[` or an initializer's `=` may begin a regex that a computed name, a default or an initializer holds, and the closing tag of the head is inside it. The base takes the
      // last word of the comment for the token before the `/`, and resolves the element.
      ['an interface with a call signature with no return type, and a computed name whose regex follows a comment behind an open bracket and holds the closing tag and the call', `interface P { <U>(x); [ // note\n/[</U>;${CALL};//]/]: string }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); [ // note\n/[</U>;${CALL};//]/]: string`, 1],
      ['an interface with a call signature with no return type, and an initializer whose regex follows a comment behind its `=` and holds the closing tag and the call', `interface P { <U>(x); m: A = // note\n/[</U>;${CALL};//]/ }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); m: A = // note\n/[</U>;${CALL};//]/`, 1],
      // The other lines that end in an open bracket, an `=` or an operator after a comment, where a member of a type may begin at the head: none is told from the members of a type by its text, and each is a pair. (Where no member of
      // a type begins — after an `=`, a `(`, a `[`, a `:` or an `=>` — the element is the only reading and these are certain.)
      ['an interface with a call signature with no return type, and a method whose default has a regex on the line after a comment behind its `=`, which holds the closing tag and the call', `interface P { <U>(x); f(a = // note\n/[</U>;${CALL};//]/): void }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); f(a = // note\n/[</U>;\n${CALL};//]/): void`, 1],
      ['an interface with a call signature with no return type, and an optional member whose initializer is a regex on the line after a comment behind its `=`', `interface P { <U>(x); m? = // note\n/[</U>;${CALL};//]/ }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); m? = // note\n/[</U>;\n${CALL};//]/`, 1],
      ['an interface with a call signature with no return type, and a computed name that is an assignment, with a regex on the line after a comment behind its `=`', `interface P { <U>(x); [ x = // note\n/[</U>;${CALL};//]/]: string }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); [ x = // note\n/[</U>;\n${CALL};//]/]: string`, 1],
      ['an interface with a call signature with no return type, and an initializer with an operator before a comment, and a regex on the next line', `interface P { <U>(x); m: A = b + // note\n/[</U>;${CALL};//]/ }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); m: A = b + // note\n/[</U>;\n${CALL};//]/`, 1],
      // Where a member of a type may begin at the head, the head is not told from a call signature by what stands before it: `return <U>(x)` is a method named `return`, and `m? <U>(x)` a method with an optional mark. After an `=` or a
      // `(` none begins and the element is read for certain; these two stay a guess, which is why NO_MEMBER_BEFORE has neither a keyword nor a `?`.
      ['an interface with a method named `return` that has type parameters and no return type, and a string that holds the closing tag and the call', `interface P { return <U>(x); a: '</U>;${CALL};//'; }`, 0],
      ['an element returned, whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); a: '</U>;${CALL};//'`, 1],
      ['an interface with an optional method that has type parameters and no return type, and a string that holds the closing tag and the call', `interface P { m? <U>(x); a: '</U> : null; ${CALL};//'; }`, 0],
      ['an element in a conditional, whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `const el = c ? <U>(x); a: '</U> : null; ${CALL};//'`, 1],
      // A tag with a line break before the `=` of its attribute: in a type it is an initializer that ends at the break and a member with an initializer of its own, and the string after it holds the closing tag and the call; in the
      // element it is an element with an attribute, whose closing tag is in what is a string to the type.
      ['an interface with a call signature with no return type, and an initializer that compares with a tag whose `=` is on a line of its own, and a string that holds the closing tag and the call', `interface P { <U>(x); m: A = x <a\nhref\n="/x"> '</a>' + '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis and holds an element with an attribute on three lines, then the call', `return <U>(x); m: A = x <a\nhref\n="/x"> '</a>' + '</U>;${CALL};//'`, 1],
      ['an interface with a call signature with no return type, and an initializer that compares with a tag whose valued `get` is on a line of its own', `interface P { <U>(x); m: A = x <a\nget="/x"> '</a>' + '</U>;${CALL};//'; }`, 0],
      ['an element whose text starts with a parenthesis and holds an element with an attribute named `get` on its own line, then the call', `return <U>(x); m: A = x <a\nget="/x"> '</a>' + '</U>;${CALL};//'`, 1],
      // A fragment after an operand and a line comment that ends in any character: the operand is what stands before the comment, and `<>` is an empty list of type arguments after it.
      ['an interface with a call signature with no return type, and a default whose operand is followed by a line comment that ends in a colon, and `<>` on the next line', `interface P { <U>(x); m(p = f // note:\n<> || '</>' + '</U>;${CALL};//'): void }`, 0],
      ['an element whose text starts with a parenthesis and holds a fragment after the comment, then the call', `return <U>(x); m(p = f // note:\n<> || '</>' + '</U>;${CALL};//'): void`, 1],
      ['an interface with a call signature with no return type, and a default whose operand is a number that ends in a dot, and `<>` after it', `interface P { <U>(x); m(p = 1.<> || '</>' + '</U>;${CALL};//'): void }`, 0],
      ['an element whose text starts with a parenthesis and holds a fragment after a number, then the call', `return <U>(x); m(p = 1.<> || '</>' + '</U>;${CALL};//'): void`, 1],
      // An import type has no line-break rule before its `(`, and a `(` on the next line after any other type begins a call signature: `typeof import` and a line break, then the path that holds the closing tag and the call.
      ['an interface with a call signature with no return type, and a member of type `typeof import`, a line break, and a path that holds the closing tag and the call', `interface P { <U>(x); m: typeof import\n('</U>;${CALL};//') }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); m: typeof import\n('</U>;${CALL};//')`, 1],
      // After `get` or `set` a `[` begins an accessor's computed name, an expression: `[a, /x/]` is a comma expression with a regex in it, which holds the closing tag and the call. Elsewhere it is an index signature.
      ['an interface with a call signature with no return type, and an accessor whose computed name is a comma expression with a regex that holds the closing tag and the call', `interface P { <U>(x); get [a, /[</U>;${CALL};//]/](): string }`, 0],
      ['an element whose text starts with a parenthesis and holds the same text up to the closing tag, then the call', `return <U>(x); get [a, /[</U>;${CALL};//]/](): string`, 1],
    ],
  },
  {
    kind: 'newline',
    pairs: [
      ['a regex statement after a type annotation, which holds the call', `let v: number\n/${CALL}/.test(z);`, 0],
      ['a division that continues the statement', `const q = x\n/ y / ${CALL};`, 1],
    ],
  },
  {
    kind: 'operator',
    // A head with a constraint and a parameter list that a colon follows, after the cut `>=`: the first `>` may have ended type arguments, so the `>` and `=` are a cut that this lexer
    // cannot make, and the colon leaves the arrow's return type and JSX text open. No generated page has this shape (a head with no parameter list, `<T extends X>text</T>`, is an element
    // whatever the cut is, and is read as one), so the pair stands for it. The base reads both of these right, by looking past the head for an arrow; the lexer here reads the head and
    // its parameter list. Both compile, and the same text up to the colon is read two ways.
    baseRight: true,
    pairs: [
      ['an element after `>=` whose text starts with a parenthesis and a colon', `const k = a >= <T extends X>(y: T): T</T>; const re = /${CALL}/;`, 0],
      ['an arrow with a return type, after the end of type arguments', `let x: A<number>= <T extends X>(y: T): T => y;\n${CALL};`, 1],
    ],
  },
];

const wrap = (snippet) => `import * as React from "react";\nexport default function Page() {\n  ${snippet.replace(/\n/g, '\n  ')}\n  return null;\n}\n`;
const parses = (ts, code) => ts.createSourceFile('page.tsx', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const realCalls = (ts, source) => {
  let found = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'navigateTo') found += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

// The shapes that were refused, with a guess named, where only one program has the text: each is certain now, and a page of one that is refused again fails the test (and a shape that no valid page
// has fails it too), so the rule behind each is pinned here as well as in its own unit test.
const CERTAIN_SHAPES = [
  ['a cast, then `>`, `>>`, `>>>`, `/` or `<` and a regex or an element: the closer of a cast and the operator after it are read for certain', (page) => page.group === 'cast then operator' && ANGLE_OPERATORS.includes(page.parts.operator) && SLASH_OPERANDS.includes(page.parts.operand)],
  ['a regex or an element, then a division or a comparison, or a division, then a regex or an element', (page) => page.group === 'everyday' && /^const m\d+ = /.test(page.name)],
  ['an element as an attribute value', (page) => page.group === 'everyday' && /^const v\d+ = /.test(page.name)],
  ['a comment in a closing tag', (page) => page.group === 'everyday' && /^const c\d+ = /.test(page.name)],
  ['a regex with flags, then a division or a comparison, and a word that the flags spell', (page) => page.group === 'everyday' && /^const w\d+ = /.test(page.name)],
  ['a self-closing tag with trivia between its `/` and its `>`', (page) => page.group === 'everyday' && /^const z\d+ = /.test(page.name)],
  ['a closing tag name with a colon or a dot and trivia around it', (page) => page.group === 'everyday' && /^const k\d+ = /.test(page.name)],
  ['a generic function type with a comment in its object type', (page) => page.group === 'everyday' && /^const h\d+: /.test(page.name)],
  ['an element whose text starts with a parenthesis and holds an apostrophe, with a string after it on its line', (page) => page.group === 'everyday' && /^const q\d+ = /.test(page.name)],
  ['a hashbang', (page) => page.group === 'hashbang'],
  ['a method named `async` that has type parameters, or `async` and a comparison', (page) => page.group.startsWith('declaration') && /^(const o[34]|class F2|const r[234])\b/.test(page.name)],
  ['a quoted method signature in an object type', (page) => /^type literal in a (parameter|generic function type)/.test(page.group) && /^(['"])(?:m|a\\'b)\1\(/.test(page.name)],
  ['a call or construct signature with no return type', (page) => /^type literal in a generic function type|^interface member|^type literal member|^class implements|^type literal in a parameter/.test(page.group) && SIGNATURE_MEMBERS.includes(page.name)],
  ['an element whose text starts with a parenthesis', (page) => page.group === 'parenthesised element' && !HIDING_ELEMENTS.includes(page.element) && !INITIALIZER_ELEMENTS.includes(page.element)],
  ['an element whose text starts with a parenthesis and holds a comment, a template or a regex that is open at its closing tag, after an `=`, a `(`, a `[`, a `:` or an `=>`, where no member of a type begins', (page) => page.group === 'parenthesised element' && page.member === false && HIDING_ELEMENTS.includes(page.element)],
  ['an element whose text starts with a parenthesis, a separator and a line that ends in an open `[`, an initializer\'s `=` or an operator after a `//`, and a line that starts with a `/`, where no member of a type begins', (page) => page.group === 'parenthesised element' && page.member === false && PROSE_OPEN_ELEMENTS.includes(page.element)],
  ['an element whose text starts with a parenthesis, a separator, a line with a `//` in it — a URL, a label and a URL, a name and a note — and a line that starts with a `/`', (page) => page.group === 'parenthesised element' && PROSE_ELEMENTS.includes(page.element)],
  ['an element whose text starts with a parenthesis, a separator, a line with a `//` in it that begins with a bracket, a quote, a tag or an operator, ends in a postfix `!`, a call or an index, has a number with a `.` or an exponent sign, or starts with a modifier, and a line that starts with a `/`', (page) => page.group === 'parenthesised element' && SHAPED_PROSE_ELEMENTS.includes(page.element)],
  ['a label and a type that fails at its second token (a number and a word, an object type that is none, `new`, `import`) or an `=` before a closing tag', (page) => page.group === 'parenthesised element' && FAILING_LIST_ELEMENTS.includes(page.element)],
  ['a default whose first token is a regex or an element, a division of a name or a number, or a template with no `${`', (page) => page.group === 'parenthesised element' && EXACT_INITIALIZER_ELEMENTS.includes(page.element)],
  ['an element whose first attribute is `extends` and that closes at once, where no `/` closes a regex on its line', (page) => page.group === 'everyday' && /^const e[12] = /.test(page.name)],
];

test('valid pages: this lexer never reads the text of a call as a call, and refuses a page that compiles only in the recorded classes, naming its guess', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const base = loadBase();
  const stats = { pages: 0, valid: 0, resolved: 0, refused: 0, baseResolved: 0, baseRegressions: 0, baseImprovements: 0, baseDecoysRewritten: 0, decoysRewritten: 0 };
  const met = new Map(REFUSAL_CLASSES.map((cls) => [cls, 0]));
  const shapes = new Map(CERTAIN_SHAPES.map(([what]) => [what, { valid: 0, resolved: 0 }]));
  const unexplained = [];
  const unsound = [];
  const silent = [];
  const refusedAgain = [];
  const regressed = [];
  for (const page of validPages()) {
    stats.pages += 1;
    const source = parses(ts, page.code);
    if (source.parseDiagnostics.length > 0 || realCalls(ts, source) !== 1) continue;
    stats.valid += 1;
    const here = reading(next, page.code);
    for (const [what, belongs] of CERTAIN_SHAPES) {
      if (!belongs(page)) continue;
      shapes.get(what).valid += 1;
      if (here.resolves) shapes.get(what).resolved += 1;
      else refusedAgain.push(`${what}: ${page.group} / ${JSON.stringify(page.name)} (${here.kind})`);
    }
    if (here.resolves) stats.resolved += 1;
    else {
      stats.refused += 1;
      const cls = REFUSAL_CLASSES.find((candidate) => candidate.kind === here.kind && candidate.matches(page));
      if (here.kind === null) silent.push(page.name);
      else if (cls) met.set(cls, met.get(cls) + 1);
      else unexplained.push(`${page.group} / ${here.kind}: ${JSON.stringify(page.name)}`);
    }
    // The data after the snippet is never rewritten, wherever the snippet is read right or wrong.
    const decoyed = withDecoys(page.code);
    if (parses(ts, decoyed).parseDiagnostics.length === 0 && !decoysIntact(reading(next, decoyed).deployed)) { stats.decoysRewritten += 1; unsound.push(`${page.group}: ${JSON.stringify(page.name)}`); }
    if (base) {
      const there = reading(base, page.code);
      if (there.resolves) stats.baseResolved += 1;
      if (there.resolves && !here.resolves) {
        stats.baseRegressions += 1;
        regressed.push(`${page.group} / ${JSON.stringify(page.name)} (${here.kind})`);
      }
      if (!there.resolves && here.resolves) stats.baseImprovements += 1;
      if (parses(ts, decoyed).parseDiagnostics.length === 0 && !decoysIntact(reading(base, decoyed).deployed)) stats.baseDecoysRewritten += 1;
    }
  }
  t.diagnostic(`${stats.pages} pages, ${stats.valid} valid to TypeScript: ${stats.resolved} resolved, ${stats.refused} refused after a named guess; decoys rewritten: ${stats.decoysRewritten}`
    + `${base ? `; the base resolves ${stats.baseResolved}, refuses ${stats.baseRegressions} that it resolves and resolves ${stats.baseImprovements} that it does not, and rewrites the decoys of ${stats.baseDecoysRewritten}` : '; no base lexer (BASE_LIB_PATH): not compared'}`);
  t.diagnostic(`refused, by class: ${REFUSAL_CLASSES.map((cls) => `${cls.id}: ${met.get(cls)}`).join('; ')}`);
  t.diagnostic(`certain shapes, resolved of valid: ${[...shapes].map(([what, n]) => `${what}: ${n.resolved}/${n.valid}`).join('; ')}`);
  assert.deepStrictEqual(refusedAgain.slice(0, 8), [], 'a page of a shape that is certain now is refused again');
  assert.deepStrictEqual([...shapes].filter(([, n]) => n.valid === 0).map(([what]) => what), [], 'a shape that no valid page has');
  assert.deepStrictEqual(unsound.slice(0, 5), [], 'a page whose data is read as code and rewritten');
  assert.deepStrictEqual(silent.slice(0, 5), [], 'a valid page the lexer refuses with no guess to name');
  assert.deepStrictEqual(unexplained.slice(0, 8), [], `${unexplained.length} valid pages are refused that belong to no recorded class`);
  assert.deepStrictEqual([...met].filter(([, n]) => n === 0).map(([cls]) => cls.id), [], 'a recorded class that no page meets');
  if (base) assert.deepStrictEqual(regressed.slice(0, 8), [], `${regressed.length} pages that the base resolves are refused here`);
  // The net is not vacuous, and the lexer is precise: nearly every page that compiles is resolved.
  assert.ok(stats.valid >= 25000, `only ${stats.valid} pages were valid`);
  assert.ok(stats.resolved >= 0.96 * stats.valid, `only ${stats.resolved} of ${stats.valid} valid pages were resolved`);
  if (base) {
    // A base that misreads is what calibrates the net: it rewrites the data after the pages it reads wrong, and this lexer rewrites none of it. The previous release rewrites none of these decoys (see the head of this
    // file), so there is nothing to calibrate against and the count is not demanded: the improvements are the comparison.
    if (stats.baseDecoysRewritten > 0) assert.ok(stats.baseDecoysRewritten >= 100 && stats.baseDecoysRewritten > stats.decoysRewritten, `the base rewrites ${stats.baseDecoysRewritten} decoys, this lexer ${stats.decoysRewritten}`);
    assert.ok(stats.baseImprovements >= 100, `${stats.baseImprovements} pages are resolved here and not by the base`);
  }
});

// Each recorded class is a place where the same text compiles two ways: both pages parse, TypeScript finds the calls the table says, this lexer refuses both after the class's guess, and
// where the base is given it reads one of them wrong.
test('valid pages: each recorded class is two programs with the same text, both of which compile and which a lexer without a parser cannot tell apart', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const base = loadBase();
  for (const { kind, pairs, baseRight } of TWO_WAY) {
    let baseWrong = 0;
    for (const [what, snippet, calls] of pairs) {
      const code = wrap(snippet);
      const source = parses(ts, code);
      assert.deepStrictEqual(source.parseDiagnostics.map((d) => d.code), [], `${kind}: ${what} compiles`);
      assert.strictEqual(realCalls(ts, source), calls, `${kind}: ${what}: the calls TypeScript reads`);
      const here = reading(next, code);
      assert.strictEqual(here.kind, kind, `${kind}: ${what}: the guess`);
      assert.ok(!here.resolves && here.deployed === code, `${kind}: ${what}: nothing is rewritten`);
      if (base) {
        const there = reading(base, code);
        // Wrong is the token of data rewritten (no real call, and the page changed), or a real call left (one call, and the page as it was).
        if ((calls === 0 && there.deployed !== code) || (calls === 1 && there.deployed === code)) baseWrong += 1;
      }
    }
    if (base && !baseRight) assert.ok(baseWrong >= 1, `${kind}: the base reads one of the pair wrong`);
  }
});

// The lines that end in an open `[`, an initializer's `=` after a `?` or a type, or an `=` or an operator in a parameter list, behind a `//` and a path on the next line, at a head where a member of a type may begin (`return`, `,`,
// `;`, `{`, a `?`, `default`): the text could be the members of a type, a regex may begin at the path's `/`, and the closing tag may be inside it — both programs compile (TWO_WAY has the pairs). The page is refused after the guess and
// nothing in it is rewritten. 2.13.0 resolves some of them: it takes the word that ends the comment for the token before the `/`, which reads the element's page right and the other program's page wrong, and the text alone does not tell
// them apart. How many it resolves is reported. Where no member begins the same lines are the element for certain, and the corpus of the first test holds them (resolved, none lost).
test('valid pages: a line that ends in an open bracket or an initializer, at a head where a member of a type may begin, is refused after a guess, and nothing is rewritten', (t) => {
  const ts = loadTypescriptOracle();
  if (!ts) return t.skip(SKIP);
  const base = loadBase();
  let valid = 0;
  let baseResolved = 0;
  const wrong = [];
  for (const page of openLinePages()) {
    const source = parses(ts, page.code);
    if (source.parseDiagnostics.length > 0 || realCalls(ts, source) !== 1) continue;
    valid += 1;
    const here = reading(next, page.code);
    if (here.resolves || here.kind !== 'generic' || here.deployed !== page.code) wrong.push(`${page.name}: ${here.kind}`);
    if (base && reading(base, page.code).resolves) baseResolved += 1;
  }
  t.diagnostic(`${valid} valid pages with a line that ends in an open bracket or an initializer, at a head where a member may begin; the base resolves ${baseResolved} of them`);
  assert.deepStrictEqual(wrong.slice(0, 5), [], 'a page that is resolved, or refused with another guess, or rewritten');
  assert.ok(valid >= 50, `only ${valid} pages were valid`);
});
