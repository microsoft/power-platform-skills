'use strict';

// Valid pages for the regression net (valid-page-differential.test.js): the shapes a generated page holds that a lexer without a parser can get wrong, each followed by a real
// navigation call that the reader must still see and resolve. A page that TypeScript parses with no diagnostic is valid; the test drops the others, so every generator may be liberal.
//
// The claim the differential makes is one-sided: wherever a lexer that was sound before this change (the base) resolves the call after a valid page, this one does too, unless the shape
// is listed with the reason a second reading of it compiles. The shapes come from the places a `<`, `>`, `*`, `{` or a quote means more than one thing:
//   - generic arrows in every position a value can stand, and async ones, nested ones, and ones with a constraint, a default or a `const` type parameter;
//   - generic function expressions, generators, methods and classes;
//   - casts and `satisfies` with nested type arguments, then every operator and an operand that is a name, a number, an element, a regex or a string;
//   - instantiation expressions, calls and `new` with type arguments, comparisons that look like them;
//   - hooks and components with type arguments, generic components, elements with type arguments, and elements whose text starts with a parenthesis;
//   - interfaces and type literals with every member form (a call or construct signature with and without a return type), mapped and conditional types;
//   - generic function types in every position, with every kind of parameter list;
//   - destructured and default parameters.

const NAVIGATION_CALL = 'navigateTo({pageType:"generative", pageId:"PAGEREF_detail"});';

// A page: `top` is module-level code (declarations), `body` the statements of the component before its navigation call. `ownDefault` says that `top` has the default export.
function page({ top = '', body = '', ownDefault = false }) {
  return [
    'import * as React from "react";',
    top,
    `${ownDefault ? '' : 'export default '}function Page() {`,
    `  ${body}`,
    `  ${NAVIGATION_CALL}`,
    '  return null;',
    '}',
    '',
  ].join('\n');
}

// Where a value stands. `$` is the value.
const VALUE_POSITIONS = [
  ['an initializer', (v) => ({ body: `const f = ${v};` })],
  ['an argument', (v) => ({ body: `g(${v});` })],
  ['a second argument', (v) => ({ body: `g(a, ${v});` })],
  ['a return value', (v) => ({ body: `function mk() { return ${v}; }` })],
  ['an array element', (v) => ({ body: `const r = [${v}];` })],
  ['an object value', (v) => ({ body: `const o = { k: ${v} };` })],
  ['a conditional branch', (v) => ({ body: `const c = cond ? ${v} : null;` })],
  ['the right side of ||', (v) => ({ body: `const d = a || ${v};` })],
  ['the right side of ??', (v) => ({ body: `const e = a ?? ${v};` })],
  ['parentheses', (v) => ({ body: `const p = (${v});` })],
  ['a cast', (v) => ({ body: `const u = ${v} as any;` })],
  ['a hook argument', (v) => ({ body: `const cb = React.useCallback(${v}, []);` })],
  ['a JSX attribute container', (v) => ({ body: `const el = <Cmp render={${v}} />;` })],
  ['a nested JSX attribute container', (v) => ({ body: `const el = <A><B render={${v}} /></A>;` })],
  ['an assignment', (v) => ({ body: `let w; w = ${v};` })],
  ['a class property', (v) => ({ top: `class K { f = ${v}; }` })],
  ['an export default', (v) => ({ top: `export default ${v};`, ownDefault: true })],
  ['a default parameter', (v) => ({ top: `function dp(cb = ${v}) {}` })],
  ['a template substitution', (v) => ({ body: `const t = \`a\${${v}}b\`;` })],
  ['a spread', (v) => ({ body: `const s = [...g(${v})];` })],
  ['an await', (v) => ({ body: 'async function aw() { await (' + v + '); }' })],
];

// Generic arrows, of every kind.
const ARROWS = [
  '<T,>(x: T) => x', '<T extends unknown>(x: T) => x', '<T = string>(x: T) => x', '<T, U>(x: T, y: U) => x', '<const T,>(x: T) => x', '<T extends X = Y>(x: T) => x', 'async <T,>(x: T) => x',
  '<T,>(x: T): T => x', '<T,>({ a }: { a: T }) => a', '<T,>(x: T = null as any) => x', '<T,>(...x: T[]) => x', '<T,>() => 1', '<T,>(x: Array<T>) => x', '<T,>(x: T) => <U,>(y: U) => [x, y]',
  'async <T extends X>(x: T) => x', '<T,>(x: T) => { return x; }', '<T,>(x: T) => ({ x })', 'async <T,>(x: T) => { await x; }', '<T extends X>(x: T) => x', '<T,>([a, b]: [T, T]) => a',
  '<T,>(x: { readonly a: T }) => x', '<T,>(x: { [k: string]: T }) => x', '<T,>(x: { m(y: T): T }) => x', "<T,>(x: { 'a': T }) => x", 'async<T,>(x: T) => x', 'async <T,>(x) => x',
  '<T,>(x: T) => x as T', '<T,>(x: T) => <b>{x}</b>',
];

// Function expressions and the rest of what takes type parameters after `function`, `async` or a name.
const FUNCTION_VALUES = [
  'function <T>(x: T) { return x; }', 'function* <T>(x: T) { yield x; }', 'async function <T>(x: T) { return x; }', 'async function* <T>(x: T) { yield x; }',
  'function id<T>(x: T) { return x; }', 'function* gen<T>(x: T) { yield x; }', 'function <T extends X>(x: T) { return x; }', 'function <T, U>(x: T, y: U) { return x; }',
  'function * <T>(x: T) { yield x; }', 'function *<T>(x: T) { yield x; }', 'function*<T>(x: T) { yield x; }', 'function /* c */ * /* d */ <T>(x: T) { yield x; }',
  'async function * <T>(x: T) { yield x; }', 'function*\n<T>(x: T) { yield x; }', 'function\n*\n<T>(x: T) { yield x; }',
];

const FUNCTION_DECLARATIONS = [
  'function id<T>(x: T) { return x; }', 'function* gen<T>(x: T) { yield x; }', 'async function ld<T>(x: T) { return x; }', 'async function* agen<T>(x: T) { yield x; }',
  'export function pick<T>(x: T) { return x; }', 'export async function pick2<T>(x: T) { return x; }', 'export default async function* <T>(x: T) { yield x; }',
  'function ov<T>(x: T): T;\nfunction ov(x: any) { return x; }', 'declare function dd<T>(x: T): T;', 'class C<T> { m<U>(x: U) { return x; } static s<V>(v: V) { return v; } }',
  'class D<T extends X = Y> extends B<T> implements I<T> { f = <U,>(x: U) => x; }', 'abstract class E<T> { abstract m<U>(x: U): T; }', 'class F { constructor(x: number) {} async m<T>(x: T) { return x; } *g<T>(x: T) { yield x; } async *h<T>(x: T) { yield x; } }',
  'const o = { m<T>(x: T) { return x; }, async n<T>(x: T) { return x; }, *g<T>(x: T) { yield x; }, get a() { return 1; } };', 'const oo = { async *h<T>(x: T) { yield x; }, [k]<T>(x: T) { return x; } };',
  'class G { get a(): number { return 1; } set a(v: number) {} @dec m<T>(x: T) { return x; } }',
  // A method named `async` that has type parameters, and the identifier `async` before type arguments or a comparison.
  'const o3 = { async<T>(x: T) { return x; } };', 'const o4 = { async <T>(x: T) { return x; }, async<T,>(x: T) { return x; } };', 'class F2 { async<T>(x: T) { return x; } static async<T extends X>(x: T) { return x; } }',
  'const r2 = async<T>(1);', 'const r3 = async < T;', 'const r4 = async <T extends X>(x);',
];

// A cast or `satisfies`, with type arguments that end in one or more `>`.
const CASTS = [
  'x as A<B>', 'x as A<B<C>>', 'x as A<B<C<D>>>', 'x satisfies A<B>', 'x satisfies A<B<C>>', 'x as unknown as A<B>', 'x as A<B>[]', 'x as A<B, C>', 'x as A.B<C>', 'x as A<B<C>, D<E>>',
  'f(x) as A<B>', 'x! as A<B>', 'x as A<B | C>', 'x as A<keyof B>', 'x as A<B[]>', 'x as A<{ a: B }>', 'x as A<() => B>', 'x as A<B extends C ? D : E>', 'x as Array<Array<string>>',
  'x as Promise<Array<number>>', 'x as A<B> | C', 'x as A<B> & C',
];

// What follows a cast: an operator and an operand. A `<` is the operand's start in an element, an arrow and a comparison.
const OPERATORS = ['<', '>', '<=', '>=', '>>=', '>>>=', '<<', '>>', '>>>', '==', '!=', '===', '!==', '+', '-', '*', '/', '%', '**', '&&', '||', '??', '&', '|', '^', 'in', 'instanceof', 'as', 'satisfies', ',', '=', '+=', '-=', '*=', '/=', '??=', '&&=', '||=', '<<=', '**=', '%='];
const OPERANDS = ['y', '1', '"s"', '/re/', '`t`', '<b>text</b>', '<b>{y}</b>', '<b/>', '<>x</>', '<T extends X>text</T>', '<T,>(x: T) => x', '(y)', '[y]', '{}', 'y.z', 'f(y)', '-y', '!y', 'typeof y', 'await y', 'void 0', 'A<B>', 'A<B>(y)', 'new A<B>()', 'y as A<B>'];

// Where a type argument list is an expression's: instantiation, calls, `new`, tagged templates, and what looks like them.
const TYPE_ARGUMENT_EXPRESSIONS = [
  'const g1 = f<string>;', 'const g2 = obj.m<string>;', 'const g3 = f<string>(x);', 'const g4 = new Map<string, number>();', 'const g5 = new Map<string, Array<number>>();', 'const g6 = a < b && c > d;',
  'const g7 = a<b>(c);', 'const g8 = a < b > c;', 'const g9 = f<A<B>>(y);', 'const g10 = f<A>`tpl`;', 'const g11 = a?.b<c>();', 'const g12 = y as Array<string>;', 'const g13 = new Set<Array<number>>([]);',
  'const g14 = f<A<B<C>>>(y);', 'const g15 = a < b ? c : d;', 'const g16 = (a < b) > (c);', 'const g17 = f(a < b, c > (d));', 'const g18 = f<(x: number) => void>(y);', 'const g19 = f<{ a: number }>(y);',
  'const g20 = f<typeof y>(y);', 'const g21 = f<"a" | "b">(y);', 'const g22 = f<`a${string}`>(y);', 'const g23 = f<A[]>(y);', 'const g24 = f<A extends B ? C : D>(y);', 'const g25 = <T,>(x: T) => f<T>(x);',
  'const g26 = f<A, B>(y);', 'const g27 = f<A,>(y);', 'for (let i = 0; i < n; i++) {}', 'if (a < b && c > d) {}', 'while (i < n) i++;', 'const g28 = a <= b >= c;', 'const g29 = a >> b >>> c;',
  'let g30: Array<Array<string>> = [];', 'let g31: Map<string, Array<number>>= new Map();', 'let g32: Array<number>=[];', 'x = y < z;', 'x = (y) < (z);', 'x = y < z > (w);',
  'const g33 = x as A<B>>= 1;', 'const g34 = (x as A<B>) >= y;', 'const g35 = x as A<B<C>>>= 1;', 'const g36 = [x as A<B>];', 'const g37 = { k: x as A<B> };', 'const g38 = x as A<B> ? 1 : 2;',
  'const g39 = f<A>?.();', 'const g40 = f?.<A>();', 'const g41 = (f<A>);', 'const g42 = f<A>\n(y);', 'const g43 = a < b\n> c;', 'const g44 = a\n< b;',
];

// Hooks, components and elements with type arguments.
const COMPONENTS = [
  'const [s, setS] = React.useState<string | null>(null);', 'const [l, setL] = React.useState<Array<string>>([]);', 'const ref = React.useRef<HTMLDivElement>(null);',
  'const cb1 = React.useCallback<(x: number) => void>((x) => {}, []);', 'const m1 = React.useMemo<Array<string>>(() => [], []);', 'const m2 = React.useMemo(() => <T,>(x: T) => x, []);',
  'const Fwd = React.forwardRef<HTMLDivElement, Props>((props, ref) => null);', 'const Table = <T,>(props: P<T>) => null;', 'const Table2 = <T extends object>(props: P<T>) => null;',
  'const Ctx = React.createContext<Ctx | null>(null);', 'const v = React.useContext<Ctx>(Ctx);', 'const Memo = React.memo<Props>(Comp);', 'const Memo2 = React.memo(<T,>(p: P<T>) => null);',
  'const [st, dispatch] = React.useReducer<React.Reducer<S, A>>(reducer, init);', 'const el1 = <List<string> items={[]} />;', 'const el2 = <DataGrid<Row> rows={rows}>x</DataGrid>;',
  'const el3 = <Select render={<T,>(x: T) => <b>{x}</b>} />;', 'const el4 = <Select<Array<string>> items={[]} />;', 'const el5 = <A.B<C> x={1} />;', 'const el6 = <Table<Record<string, number>> rows={[]} />;',
  'const el7 = <Foo<A | B> x={1} />;', 'const el8 = <Foo<A[]> x={1} />;', 'const el9 = <Foo<A, B> x={1} />;', 'const el10 = <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;',
  'const el11 = <p>{a < b ? "x" : "y"}</p>;', 'const el12 = <p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>;', 'const el13 = <input value={v} onChange={(e) => setV(e.target.value)} />;',
  'const el14 = <button onClick={() => navigate<string>("x")}>go</button>;', 'const el15 = <>{x}<b>y</b></>;', 'const el16 = <div style={{ a: 1 }} className="a" data-x={`t${v}`}>{v}</div>;',
  'const el17 = <A b="1" c=\'2\' d={3} {...e} />;', 'const el18 = <A b= "1" c = \'2\' />;', 'const el19 = <A b="it\'s" c=\'say "hi"\' />;', 'const el20 = <p>it\'s a "quote" and a \\ backslash</p>;',
];

// A call or construct signature with no return type: TypeScript parses it with no diagnostic, and its text up to the end of the member is also the text of an element that starts with a parenthesis,
// so the reading of `<U>(x: U)` turns on what comes after it (source-literals.js, callSignatureOrElement).
const SIGNATURE_MEMBERS = [
  '<U>(x: U);', '<U>(x: U)', '<U>();', 'new <U>(x: U);', 'new <U>(x: U)', 'new <U>();', '<U>(x?: U, ...rest: T[]);', '<U>({ a }: { a: U });', '<U>(x: { readonly a: U });', '<U>(x: Array<U>)', '<U>(x: U), a: T;',
  '<U>(x: U)\n  a: T;', '<U>(x: U);\n  a: { b: T };', '<U>(x: U); [k: string]: T;', '<U>(x: U); (y: T): T;', '<U>(x: U)\n  <V>(y: V)', '<U>(x: U); new <V>(y: V);', '<U>(x: U) // c\n  a: T;', '<U>(x: U); a: Array<Array<T>>;',
];
// The same, where the member holds the closing tag of its head in a string, a template or a comment: the text up to that closing tag is an element too, so the reading is a guess.
const HIDDEN_CLOSING_MEMBERS = ["<U>(x: U); a: '</U>';", '<U>(x: U); /* </U> */', '<U>(x: U);\n  // </U>\n  a: T;', '<U>(x: U); a: `</U>`;'];

// Members an interface or a type literal can have.
const MEMBERS = [
  'a: T;', 'a?: T;', 'readonly a: T;', '[k: string]: T;', 'readonly [k: string]: T;', '[k: number]: T;', 'm(x: T): T;', 'm?(x: T): T;', 'm<U>(x: U): T;', '(x: T): T;', '<U>(x: U): T;', 'new (x: T): T;',
  'new <U>(x: U): T;', 'get a(): T;', 'set a(v: T);', "'a-b': T;", '"a": T;', '1: T;', '[Symbol.iterator](): T;', 'readonly [K in keyof T]: T[K];', 'cb: <U>(x: { readonly a: U }) => U;',
  'cb: <U>(x: Array<U>) => U;', 'cb: <U>({ a }: { a: U }) => U;', "cb: <U>(x: { 'a': U }) => U;", 'cb: <U>(x: { m(y: U): U }) => U;', 'cb: <U>(x: { [k: string]: U }) => U;',
  'async: T;', 'yield: T;', 'new: T;', 'typeof: T;', 'function: T;', 'class: T;', 'import: T;', 'in: T;', 'as: T;', 'satisfies: T;', 'readonly: T;', 'get: T;', 'set: T;', 'await: T;', 'delete: T;', 'void: T;',
  // A method with a quoted name: a string and a call, in an object type that stands in a function type's parameter list.
  "'m'(x: T): T;", '"m"(x: T): T;', '"m"(): T;', "'a\\'b'(x: T, y: U): T;", "'m'(x?: T): T;",
  'a: <T>() => T;', 'a: new <T>() => T;', 'a: abstract new <T>() => T;', 'a: (x: T) => <U>(y: U) => T;', 'a(): <U>(y: U) => T;',
  ...SIGNATURE_MEMBERS, ...HIDDEN_CLOSING_MEMBERS,
];

// Elements whose text starts with a parenthesis, as a page holds them — a hint after a label, a count, a translated label, a note with a link, several lines — and as a value in every place one stands. Each
// is JSX text that a call signature with no return type shares the start of: the reading turns on what comes after the `)` and, where a line break or a separator follows it, on the text to the closing tag.
const PARENTHESISED_ELEMENTS = [
  '<b>(optional)</b>', '<span>(total: {count})</span>', '<Text>({items.length} items)</Text>', '<p>({formatDate(d)})</p>', '<p>({t("label")})</p>', '<li>(x) = {y}</li>', '<div><b>(x)</b></div>', '<Label>(required)</Label>',
  '<Badge>(beta)</Badge>', '<p>(see <a href={url}>docs</a>)</p>', '<p>({count}) <b>items</b></p>', '<span>({a ? "x" : "y"})</span>', '<p>(a), (b)</p>', '<p>(a);</p>', '<Text>(total: {items.length}), {done} done</Text>',
  '<p>(a)\n  <b x={1}>y</b>\n</p>', '<Text>\n  (see below)\n  <Link href={url} onClick={() => go("/x")}>docs</Link>\n</Text>', '<p>(a),\n  <Icon name={icon} />\n</p>', '<p>(a)\n  {t("label")}\n</p>',
  '<p>(a);\n  <b style={{ color: "red" }}>y</b></p>', '<Text>(it\'s fine)</Text>', '<Text>(a), it\'s fine</Text>', '<p>({`x`})</p>', '<p>(a) text with a/b and https://x.y</p>', '<p>(a)\n</p>', '<p>\n  (a)\n</p>',
  // A `,`, `;` or line break after the `)`, and then prose with a `/`, a URL or a back-tick: no type has such text for its members, or the comment, template or regex is closed before the closing tag.
  '<p>(a), see https://x.y</p>', '<p>(a);\n  and/or more</p>', '<p>(a)\n  `x`</p>', '<p>(a), 1/2 done</p>', '<p>(a)\n  see https://x.y\n</p>', '<p>(a); /* note */ more</p>', '<p>(a),\n  // note\n  more\n</p>',
];
// The same, where a `,`, `;` or line break follows the `)` and the text holds a comment, a template or a regex that is open at the closing tag, after text that a type could hold for its members: the closing tag
// could be inside it, in a type that has the same text, so the reading of the head is a guess.
const HIDING_ELEMENTS = ['<p>(a); // c </p>', '<p>(a);\n  /* c </p>', '<p>(a), x // c </p>', '<p>(a); `x ${y} </p>'];

// Types that are not function types and hold a `<`, `>` or `{`.
const TYPE_DECLARATIONS = [
  'type M1<T> = { [K in keyof T]?: T[K] };', 'type M2<T> = { -readonly [K in keyof T]-?: T[K] };', 'type M3<T> = { +readonly [K in keyof T]+?: T[K] };', 'type M4<T> = { readonly [K in keyof T as `get${string & K}`]: T[K] };',
  'type C1<T> = T extends (infer U)[] ? U : never;', 'type C2<T> = T extends { a: infer U } ? U : never;', 'type C3<T> = T extends <U>(x: U) => infer R ? R : never;', 'type C4<T> = T extends Array<infer U> ? U : T;',
  'type L1 = `a${string}b`;', 'type L2<T extends string> = `${T}-${T}`;', 'type U1 = A<B> | C<D>;', 'type I1 = A<B> & C<D>;', 'type K1 = keyof A<B>;', 'type P1 = A<B>["c"];', 'type T1 = [A<B>, C<D>];',
  'type T2 = [a: A<B>, b?: C<D>, ...rest: E<F>[]];', 'type R1 = Record<string, Array<Record<string, number>>>;', 'type F0 = Array<Array<Array<string>>>;', 'type D1<T = Array<string>> = T;', 'type D2<T extends Array<string> = Array<string>> = T;',
  'type G1 = typeof x<string>;', 'type Q1 = typeof import("a");', 'type Q2 = import("a").B<C>;', 'type S1 = A<B>[number];', 'type X1<T> = T extends A<infer U extends string> ? U : never;',
  'enum E1 { A = 1 << 2, B = 1 >> 1, C = 4 >>> 1 }', 'declare module "m" { export const a: Array<string>; }', 'namespace N1 { export type T = Array<string>; }', 'declare global { interface W { a: Array<string> } }',
  'abstract class AC<T> { abstract a: Array<T>; }', 'let v1: Array<string>[] = [];', 'const v2 = null as unknown as Array<Array<string>>;', 'let v3: A<B>=null as any;', 'let v4: A<B<C>>=null as any;',
];

// The heads, parameter lists and returns of generic function types.
const FUNCTION_TYPE_PARAMETER_LISTS = [
  '', 'x: T', 'x: Array<T>', 'x: Promise<T>', 'm: Record<string, T>', 'x: Map<string, Array<T>>', 'x: Array<Array<T>>', 'cb: (a: T) => void', 'cb: <U>(a: U) => T', 'x: T[]', 'x: [T, T]', 'x: T | null',
  'x: T extends string ? 1 : 2', 'x: keyof T', 'x: typeof y', 'x: `a${string}`', 'x: "a" | "b"', 'x: { a: T }', 'x: { a?: T }', 'x: { readonly a: T }', 'x: { readonly [k: string]: T }', 'x: { [k: string]: T }',
  'x: { [K in keyof T]: T[K] }', 'x: { m(y: T): T }', 'x: { m?(y: T): T }', 'x: { (y: T): T }', 'x: { new (y: T): T }', 'x: { get a(): T }', 'x: { set a(v: T) }', "x: { 'a': T }", 'x: { "a": T }', 'x: { 1: T }',
  '{ a }: { a: T }', '{ a, b }: { a: T; b: T }', '[a, b]: [T, T]', 'x: T, ...rest: T[]', 'this: Window, x: T', 'x?: T', 'x: { a: { b: T } }', 'x: { a: T; b: U }', 'x: { a: T, b: U }', 'x: { a: T }[]', 'x: Array<{ a: T }>',
  'x: Partial<{ a: T }>', 'x: Pick<{ a: T }, "a">', 'x: React.ReactNode', 'props: React.PropsWithChildren<{ a: T }>', 'x: React.Dispatch<React.SetStateAction<T>>', 'x: { readonly a: T }, y: { b?: T }',
  'x: { a: T }, y: Array<T>', 'x: Array<T>, y: { a: T }', 'x: { m(y: T): T }, y: { readonly b: T }', '{ a }: { a: T }, y: { [k: string]: T }', 'x: { [k: string]: T }, { a }: { a: T }',
];
const FUNCTION_TYPE_HEADS = ['<T>', '<T,>', '<T extends object>', '<T = string>', '<const T>', '<T, U>', '<T extends { a: string }>', '<T extends readonly unknown[]>'];
const FUNCTION_TYPE_RETURNS = ['void', 'T', 'Promise<T>', '{ a: T }', 'JSX.Element', 'React.ReactNode', 'T extends A ? B : C', 'x is T', 'asserts x is T', 'T[]', 'Array<T>'];

// A function type: every parameter list under the plain head and return, every head and return under a plain parameter list, and a rotating mix of the three.
function functionTypes() {
  const out = new Set();
  for (const list of FUNCTION_TYPE_PARAMETER_LISTS) out.add(`<T>(${list}) => void`);
  for (const list of FUNCTION_TYPE_PARAMETER_LISTS) out.add(`<T>(${list}) => T`);
  for (const head of FUNCTION_TYPE_HEADS) for (const list of ['x: T', 'x: Array<T>', 'x: { a: T }', '{ a }: { a: T }', 'x: { readonly a: T }']) out.add(`${head}(${list}) => void`);
  for (const ret of FUNCTION_TYPE_RETURNS) for (const list of ['x: T', 'x: Array<T>', 'x: { a: T }', '{ a }: { a: T }']) out.add(`<T>(${list}) => ${ret}`);
  let n = 0;
  for (const list of FUNCTION_TYPE_PARAMETER_LISTS) {
    out.add(`${FUNCTION_TYPE_HEADS[n % FUNCTION_TYPE_HEADS.length]}(${list}) => ${FUNCTION_TYPE_RETURNS[(n * 3) % FUNCTION_TYPE_RETURNS.length]}`);
    n += 1;
  }
  out.add('<T>(x: T) => <U>(y: U) => [T, U]');
  out.add('<T>(x: <U>(y: U) => T) => T');
  out.add('<T>(x: <U>(y: { a: U }) => T) => T');
  out.add('<T>(x: new <U>(y: U) => T) => T');
  out.add('new <T>(x: T) => T');
  out.add('abstract new <T>(x: { a: T }) => T');
  out.add('<T>(\n  x: T,\n  y: { a: T }\n) => T');
  out.add('<T>(x: T /* c */) /* d */ => T');
  return [...out];
}

// Where a type stands. `$` is the type; each position needs it to be a whole type, so a function type in a union is parenthesised.
const TYPE_POSITIONS = [
  ['an annotation', (t) => ({ body: `let v: ${t};` })],
  ['an annotation with an initializer', (t) => ({ body: `let v: ${t} = null as any;` })],
  ['a type alias', (t) => ({ top: `type A1 = ${t};` })],
  ['an exported type alias', (t) => ({ top: `export type A2 = ${t};` })],
  ['an alias with type parameters', (t) => ({ top: `type A3<A> = ${t};` })],
  ['an interface member', (t) => ({ top: `interface I1 { m: ${t}; }` })],
  ['an optional interface member', (t) => ({ top: `interface I2 { m?: ${t}; }` })],
  ['a readonly interface member', (t) => ({ top: `interface I3 { readonly m: ${t}; }` })],
  ['a parameter type', (t) => ({ top: `function f1(cb: ${t}) {}` })],
  ['an optional parameter type', (t) => ({ top: `function f2(cb?: ${t}) {}` })],
  ['an arrow parameter type', (t) => ({ body: `const g1 = (cb: ${t}) => cb;` })],
  ['a destructured parameter type', (t) => ({ body: `const g2 = ({ a }: { a: ${t} }) => a;` })],
  ['a return type', (t) => ({ top: `declare function f3(): ${t};` })],
  ['a class property', (t) => ({ top: `class K1 { m: ${t} = null as any; }` })],
  ['a static class property', (t) => ({ top: `class K2 { static m: ${t}; }` })],
  ['an array element', (t) => ({ top: `type A4 = Array<${t}>;` })],
  ['a nested type argument', (t) => ({ top: `type A5 = Promise<Array<${t}>>;` })],
  ['a record value', (t) => ({ top: `type A6 = Record<string, ${t}>;` })],
  ['a tuple element', (t) => ({ top: `type A7 = [${t}, ${t}];` })],
  ['a union member', (t) => ({ top: `type A8 = (${t}) | null;` })],
  ['an unparenthesised last union member', (t) => ({ top: `type A8b = Foo | ${t};` })],
  ['a leading union member', (t) => ({ top: `type A8c = | ${t};` })],
  ['an intersection member', (t) => ({ top: `type A9 = (${t}) & Foo;` })],
  ['an unparenthesised last intersection member', (t) => ({ top: `type A9b = Foo & ${t};` })],
  ['an unparenthesised last union member in an annotation', (t) => ({ body: `let v: Foo | ${t};` })],
  ['an unparenthesised last union member in a parameter', (t) => ({ top: `function f5(x: Foo | ${t}) {}` })],
  ['a parenthesised type', (t) => ({ top: `type A10 = (${t});` })],
  ['a type literal member', (t) => ({ top: `type A11 = { cb: ${t} };` })],
  ['a type literal member after another', (t) => ({ top: `type A12 = { a: string; cb: ${t}; b: number };` })],
  ['a mapped type value', (t) => ({ top: `type A13 = { [K in "a"]: ${t} };` })],
  ['a generic default', (t) => ({ top: `type A14<A = ${t}> = A;` })],
  ['a generic constraint', (t) => ({ top: `type A15<A extends ${t}> = A;` })],
  ['a conditional type', (t) => ({ top: `type A16<A> = A extends ${t} ? 1 : 2;` })],
  ['a conditional result', (t) => ({ top: `type A17<A> = A extends 1 ? ${t} : never;` })],
  ['a cast', (t) => ({ body: `const c1 = null as unknown as ${t};` })],
  ['a satisfies', (t) => ({ body: `const c2 = f satisfies ${t};` })],
  ['a type argument of a call', (t) => ({ body: `const c3 = g<${t}>(f);` })],
  ['a type argument of new', (t) => ({ body: `const c4 = new Map<string, ${t}>();` })],
  ['a hook type argument', (t) => ({ body: `const c5 = React.useRef<${t} | null>(null);` })],
  ['a hook type argument, bare', (t) => ({ body: `const c6 = React.useState<${t}>(null as any);` })],
  ['an index type', (t) => ({ top: `type A18 = Foo<${t}>["a"];` })],
  ['a rest parameter type', (t) => ({ top: `function f4(...cbs: ${t}[]) {}` })],
  ['a constructor parameter property', (t) => ({ top: `class K3 { constructor(private cb: ${t}) {} }` })],
  ['a module-level declaration', (t) => ({ top: `declare const m1: ${t};` })],
  ['an exported declaration', (t) => ({ top: `export declare const m2: ${t};` })],
  ['a for-of annotation', (t) => ({ body: `for (const cb of [] as Array<${t}>) {}` })],
  ['a catch-free try', (t) => ({ body: `try { let v: ${t}; } finally {}` })],
  ['a function type in a function type', (t) => ({ top: `type A19 = (cb: ${t}) => void;` })],
  ['a generic function type with a function type default', (t) => ({ top: `type A20 = <U = ${t}>(x: U) => U;` })],
];

// Destructured and default parameters, of functions, arrows and methods.
const PARAMETER_FORMS = [
  'function p1({ a, b }: { a: number; b: string } = { a: 1, b: "" }) {}', 'const p2 = ({ a = 1, b }: P) => a;', 'const p3 = ([a, b]: [number, number]) => a;', 'function p4<T>({ a }: { a: T }) { return a; }',
  'const p5 = async ({ a }: { a: number }) => a;', 'function p6(x = 1, { y }: { y?: number } = {}) {}', 'class P7 { constructor(private x: number = 1, readonly y = 2) {} }', 'const p8 = <T,>({ a = 1 }: { a?: T }) => a;',
  'function p9({ a: { b } }: { a: { b: number } }) {}', 'function p10({ a, ...rest }: { a: number; b: string }) {}', 'function p11([a, ...rest]: number[]) {}', 'const p12 = ({ a }: { a: number }, { b }: { b: string }) => a;',
  'function p13(cb: (x: { a: number }) => void = () => {}) {}', 'const p14 = ({ a }: { a: Array<number> } = { a: [] }) => a;', 'function p15({ a = { b: 1 } }: any) {}', 'const p16 = ({ a }: { a: <T>(x: T) => T }) => a;',
  'class P17 { m({ a }: { a: number }) {} static s([a]: [number]) {} }', 'const p18 = { m({ a }: { a: number }) {}, n: ({ b }: { b: number }) => b };', 'function p19<T extends { a: number }>({ a }: T) { return a; }',
  'const p20 = function ({ a }: { a: number }) { return a; };',
];

// Statements a generated page is made of, with the `<`, `>`, `/`, `*` and `{` they use: comparisons, generics, casts, regexes and divisions, JSX with expressions and text, template
// literals that hold them. Each stands in the component's body before its navigation call.
const EVERYDAY = [
  'if (a < b && c > d) { g(); }', 'if (a > 0) /x/.test(s);', 'const half = total / 2; const ratio = a / b / c;', 'const pct = Math.round((done / total) * 100);', 'const avg = items.reduce((s, i) => s + i.n, 0) / items.length;',
  'const re = /[a-z]+\\/(\\d+)/g;', 'const m = text.match(/^(\\w+)@(\\w+)$/);', 'const parts = path.split("/").filter(Boolean);', 'const url = `${base}/api/${id}?q=${encodeURIComponent(q)}`;',
  'const r = items.map((i) => i.n * 2).filter((n) => n > 3 && n < 10);', 'const sorted = [...items].sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));',
  'const byId = items.reduce<Record<string, Item>>((m, i) => ({ ...m, [i.id]: i }), {});', 'const keys = Object.keys(o) as Array<keyof typeof o>;', 'const entries = Object.entries(o) as [string, number][];',
  'const [a, b] = await Promise.all<A, B>([f(), g()]);', 'const timer = setTimeout(() => g(), 1000 / 60);', 'const style = { width: `${(n / total) * 100}%`, height: n * 2 };',
  'const el = <div className="a" onClick={() => g()}>{n} / {total}</div>;', 'const el = <p>{a < b ? "lt" : "ge"} and {c > d ? "gt" : "le"}</p>;', 'const el = <ul>{items.map((i) => <li key={i.id}>{i.n > 1 ? "many" : "one"}</li>)}</ul>;',
  'const el = <input type="number" min={0} max={total / 2} value={v} onChange={(e) => setV(Number(e.target.value) / 10)} />;', 'const el = <a href="/x/y">go</a>;',
  'const el = <Cmp<Row> rows={rows} render={(r) => <b>{r.n < 3 ? "a" : "b"}</b>} />;', 'const el = <T,>(x: T) => <b>{String(x)}</b>;', 'const label = a > b ? <b>big</b> : <i>small</i>;',
  'const label = count > 0 && <span>{count}</span>;', 'const label = (n >= 10 ? "ten" : n <= 1 ? "one" : "few") + "/" + total;', 'const v = a as number / 2;', 'const v = (a as number) / 2 / 3;',
  'const v = a! / b! / c!;', 'const w = a?.b / c?.d / 2;', 'const x1 = i++ / 2 / 3;', 'const x2 = a[0] / b[1] / 4;', 'const x3 = f(a) / g(b) / 5;', 'const x4 = (a + b) / (c + d) / 6;', 'const x5 = a ** 2 / b ** 2 / 7;',
  'const cmp = a < b > c;', 'const sh = 1 << n; const sh2 = (1 << a) | (1 << b); const sh3 = x >> 2 >>> 1;', 'const f2 = (x: number): x is 1 => x === 1;', 'const f3 = async (x: number) => { await g(x); };',
  'const f4 = function* () { yield 1; yield* [2, 3]; };', 'const f5 = <T extends object>(x: T): T => x;', 'const f6 = <T,>(x: T) => x;', 'const f7 = async <T,>(x: T) => x;',
  'for (let i = 0; i < n; i++) { g(i); }', 'for (const k in o) { if (o[k] > 1) g(k); }', 'while (i < n && j > 0) { i++; j--; }', 'do { i++; } while (i < 10);', 'switch (a) { case 1: g(); break; default: break; }',
  'try { g(); } catch (e) { if (e instanceof Error && e.message.length > 3) g(); } finally { h(); }', 'label: for (;;) { break label; }', 'const o2 = { a, b, ...rest, [k]: v, m() { return 1; }, get g() { return 2; } };',
  'const arr = [1, 2, 3] as const; type Arr = typeof arr[number];', 'const u = x satisfies Record<string, number>;', 'const n1 = a ?? b ?? c; const n2 = a || b && c;', 'a ||= b; a &&= c; a ??= d; a **= 2; a >>= 1; a >>>= 1; a <<= 1;',
  'let t: Array<Array<number>> = [[1]]; let t2: Map<string, Set<number>> = new Map();', 'let t3: Promise<Array<Record<string, number>>>;', 'let t4: ReturnType<typeof f>;', 'let t5: Parameters<typeof f>[0];',
  'enum E { A = 1 << 0, B = 1 << 1, C = A | B }', 'abstract class Q { abstract m(): void; static s = 1; #p = 2; get p() { return this.#p; } }', 'declare module "m" { export const x: number; }',
  'const big = 10n ** 20n / 3n;', 'const t6 = x < y ? <b>a</b> : <i>b</i>;', 'const t7 = a < b, c = d > e;', 'const t8 = f(a < b, c > d);', 'const t9 = f(a<b, c>(d));',
  'const r1 = a / b; const r2 = /c/.test(d);', 'const r3 = (a) / b / c; const r4 = /d/.exec(e)!.index;', 'const r5 = x\n/ y / z;', 'const r6 = a ? /b/ : /c/;', 'const r7 = [/a/, /b/];', 'const r8 = {a: /b/};',
  'const r9 = typeof a === "number" ? a / 2 : /x/.test(a);', 'if (x) /y/.test(z); else /w/.test(z);', 'while (a) /y/.test(z) && g();', 'return_: { const q = /a/; }',
  // A regex or an element that the lexer read, then a division or a comparison; a division, then a regex or an element.
  'const m1 = /x/ /2;', 'const m2 = /x/ / 2 / 3;', 'const m3 = <b/> / 2;', 'const m4 = <b>t</b> /2;', 'const m5 = a / /y/.source;', 'const m6 = /x/\n/ 2;', 'const m7 = <b/>\n/ 2;', 'const m8 = a / <b>t</b>;',
  'const m9 = a /\n/y/.source;', 'const m10 = /x/ < 2;', 'const m11 = <></> / 2 / 3;', 'const m12 = /x/ / /y/ / 2;', 'const m13 = <a><b/></a> / 2;', 'const m14 = /[/]/ / 2;', 'const m15 = a / <T extends X>t</T>;',
  // A `>` that closes nothing the lexer can tell: a comparison, or an instantiation expression, before a regex, an element or a division (no cast stands before it).
  'const g1 = a > /y/.test(z);', 'const g2 = f<A> / 2;', 'const g3 = a >> /y/.test(z);', 'const g4 = a > <b>t</b>;', 'const g5 = a >> <b>t</b>;', 'const g6 = f<A, B> / 2 / 3;',
  // An element or a fragment as an attribute's value, and a comment in a closing tag.
  'const v1 = <A x=<B/>>text</A>;', 'const v2 = <A x= <B>t</B> y="1" />;', 'const v3 = <A x=/* c */<></>>text</A>;', 'const v4 = <A x=<B y=<C/> />>text</A>;', 'const v5 = <A x=<B>{1}</B>>text</A>;',
  'const c1 = <A>x</A /* > */>;', 'const c2 = <A></A // >\n>;', 'const c3 = <A.B></A /* > */ . B>;', 'const c4 = <></ /* > */>;',
  // A regex with flags, then a division or a comparison: the scanner takes every identifier part after the closing slash as part of the literal, so a word that the flags spell is no keyword.
  'const w1 = /x/g;', 'const w2 = s.replace(/x/gi, "y");', 'const w3 = /x/gimsuyd.test(s);', 'const w4 = /x/g / 2;', 'const w5 = /x/is /2;', 'const w6 = /x/in / 2;', 'const w7 = /x/g\n/ 2;', 'const w8 = /x/g < 2;',
  'const w9 = /x/$ / 2;', 'const w10 = /x/é / 2;', 'const w11 = /x/instanceof / 2;',
  // The `/` and the `>` of a self-closing tag are two tokens, with trivia between them; so are the parts of a closing tag's name.
  'const z1 = <B / >;', 'const z2 = <B x="1" /\n>;', 'const z3 = <A x=<B / >/>text</A>;', 'const z4 = <B / /* c */ >;', 'const z5 = <A><B / ></A>;', 'const z6 = <B\n  x="1"\n  /\n>;', 'const z7 = <B / // c\n>;',
  'const k1 = <a:b></a :b>;', 'const k2 = <a:b></a/*c*/:b>;', 'const k3 = <a:b></a:/*c*/b>;', 'const k4 = <A.B></A . B>;', 'const k5 = <a:b>t</a: b>;',
  // A comment in the object type of a generic function type, which is a function type for certain.
  'const h1: <T>(x: { /* c */ readonly a: T }) => T = g;', 'const h2: <T>(x: { a /* c */ : T }) => T = g;', 'const h3: <T>(x: { [k /* c */ : string]: T }) => T = g;', 'const h4: <T>(x: { m(a /* c */): T }) => T = g;',
  // An element whose text starts with a parenthesis and holds an apostrophe, with a string on the same line after it.
  "const q1 = cond ? <p>(a), it's</p> : 'none';", "const q2 = [<p>(a); the user's</p>, 'x'];", 'const q3 = <p>(a), 5" wide</p> + "x";',
];

// The pages. Each is { group, name, code }; the test drops those TypeScript does not parse.
function* validPages() {
  for (const statement of EVERYDAY) yield { group: 'everyday', name: statement, code: page({ body: statement }) };
  // A hashbang is trivia to TypeScript at the start of the file, to the end of its line.
  for (const first of ['#!/usr/bin/env node', '#!', '#! /* is not a comment opener', '#!"unterminated']) yield { group: 'hashbang', name: first, code: `${first}\n${page({ body: 'const h = 1;' })}` };
  const types = functionTypes();
  for (const [position, place] of VALUE_POSITIONS) {
    for (const arrow of ARROWS) yield { group: 'generic arrow', name: `${arrow} / ${position}`, code: page(place(arrow)) };
    for (const fn of FUNCTION_VALUES) yield { group: 'function expression', name: `${fn} / ${position}`, code: page(place(fn)) };
  }
  for (const declaration of FUNCTION_DECLARATIONS) {
    yield { group: 'declaration', name: declaration, code: page({ top: declaration, ownDefault: /^export default /.test(declaration) }) };
    yield { group: 'declaration in the component', name: declaration, code: page({ body: declaration.replace(/^export (default )?/, '') }) };
  }
  for (const cast of CASTS) {
    for (const operator of OPERATORS) {
      for (const operand of OPERANDS) yield { group: 'cast then operator', name: `${cast} ${operator} ${operand}`, parts: { cast, operator, operand }, code: page({ body: `const k = ${cast} ${operator} ${operand};` }) };
    }
    yield { group: 'cast alone', name: cast, code: page({ body: `const k = ${cast};` }) };
    yield { group: 'cast, parenthesised', name: cast, code: page({ body: `const k = (${cast}) > 1;` }) };
    yield { group: 'cast, then a call', name: cast, code: page({ body: `const k = (${cast}).m();` }) };
    yield { group: 'cast, then a member', name: cast, code: page({ body: `const k = (${cast}).m < 1;` }) };
  }
  for (const declaration of TYPE_ARGUMENT_EXPRESSIONS) yield { group: 'type arguments in an expression', name: declaration, code: page({ body: declaration }) };
  for (const declaration of COMPONENTS) yield { group: 'component or hook', name: declaration, code: page({ body: declaration }) };
  for (const [position, place] of VALUE_POSITIONS) for (const element of [...PARENTHESISED_ELEMENTS, ...HIDING_ELEMENTS]) yield { group: 'parenthesised element', name: `${element} / ${position}`, element, code: page(place(element)) };
  for (const member of MEMBERS) {
    yield { group: 'interface member', name: member, code: page({ top: `interface P1<T, U> { ${member} }` }) };
    yield { group: 'type literal member', name: member, code: page({ top: `type P2<T, U> = { ${member} };` }) };
    yield { group: 'class implements', name: member, code: page({ top: `interface P3<T, U> {\n  ${member}\n}\nclass Q3 {}` }) };
    yield { group: 'type literal in a parameter', name: member, code: page({ top: `function p<T, U>(x: { ${member} }) {}` }) };
    yield { group: 'type literal in a generic function type', name: member, code: page({ top: `type P4 = <T, U>(x: { ${member} }) => T;` }) };
    yield { group: 'type literal in a generic function type member', name: member, code: page({ top: `interface P5 { cb: <T, U>(x: { ${member} }) => T; }` }) };
  }
  for (const declaration of TYPE_DECLARATIONS) yield { group: 'type declaration', name: declaration, code: page({ top: declaration }) };
  for (const type of types) for (const [position, place] of TYPE_POSITIONS) yield { group: 'function type', name: `${type} / ${position}`, code: page(place(type)) };
  for (const form of PARAMETER_FORMS) yield { group: 'parameter form', name: form, code: page({ top: form }) };
}

module.exports = { validPages, functionTypes, NAVIGATION_CALL, page, ARROWS, FUNCTION_VALUES, CASTS, OPERATORS, OPERANDS, MEMBERS, SIGNATURE_MEMBERS, HIDDEN_CLOSING_MEMBERS, PARENTHESISED_ELEMENTS, HIDING_ELEMENTS, TYPE_POSITIONS, VALUE_POSITIONS, EVERYDAY };
