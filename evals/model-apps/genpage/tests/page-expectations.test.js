'use strict';

// Unit tests for the Phase 5 page checks graded from how a generated page is BUILT
// (lib/page-checks.js, lib/tsx-structure.js and lib/column-contract.js, registered in
// lib/assertions-layer-2.js): eval 4's review summary and field labels (its step navigation is recorded as
// unscored instead, and a test pins why), eval 5's top-level functions, eval 12's search box beside a filter
// toolbar, eval 13's translated text, eval 15's choice names, and the column names evals 1 and 7 verify
// against RuntimeTypes.ts.
//
// Each check PASSES on the committed fixture it grades, FAILS on an in-memory mutation of that page
// that introduces exactly the regression it exists to catch, and SKIPs only where its evidence is not
// part of a page. Mutations go through `edit`, which asserts the text it replaces is really there, so a
// fixture change cannot silently turn a failing case into a vacuous one. Small inline pages pin the
// equivalent forms a check accepts (a condition read through a declaration, a Fluent Field's label).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { PHASE5_EXPECTATIONS } = require('../lib/assertions-layer-2.js');
const { loadFixtures } = require('../lib/fixture-loader.js');
const { nestedDefinitionProblems, jsxElements, jsxTextRuns, patternNames } = require('../lib/tsx-structure.js');
const layer1 = require('../run-layer-1.js');
const layer2 = require('../run-layer-2.js');
const BASELINE = require('../../tests/eval-coverage-baseline.json');

const FIXTURES = loadFixtures(path.join(__dirname, '..', 'fixtures'));

function committed(dirName) {
  const fixture = FIXTURES.find((f) => f.dirName === dirName);
  assert.ok(fixture, `committed fixture ${dirName} exists`);
  return fixture;
}

function edit(text, from, to) {
  // A Windows checkout may hold a fixture with CRLF line ends; multi-line edits follow the file's.
  if (typeof text === 'string' && text.includes('\r\n')) [from, to] = [from, to].map((s) => s.replace(/\r?\n/g, '\r\n'));
  assert.ok(typeof text === 'string' && text.includes(from), `fixture text contains ${JSON.stringify(from)}`);
  return text.split(from).join(to);
}

// A copy of a committed fixture whose page `name` has each [from, to] edit applied.
function withPage(dirName, name, ...edits) {
  const base = committed(dirName);
  assert.ok(base.files.some((f) => f.name === name), `${dirName} has ${name}`);
  return {
    ...base,
    files: base.files.map((f) => (f.name === name ? { ...f, content: edits.reduce((text, [from, to]) => edit(text, from, to), f.content) } : f)),
  };
}

function inline(content, extra = {}) {
  return { files: [{ path: '/fake/page.tsx', name: 'page.tsx', content }], ...extra };
}

function grade(text, fixture) {
  const check = PHASE5_EXPECTATIONS.get(text);
  assert.ok(check, `a check is registered for: ${text}`);
  return check({ files: fixture.files, fixture, eval: { id: fixture.id } });
}

function assertPass(result) { assert.equal(result.status, 'pass', result.reason); }
function assertFail(result, reason) {
  assert.equal(result.status, 'fail', `expected a failure, got ${result.status}: ${result.reason}`);
  assert.match(result.reason, reason);
}
function assertSkip(result, reason) {
  assert.equal(result.status, 'skip', `expected a skip, got ${result.status}: ${result.reason}`);
  assert.match(result.reason, reason);
}

// --- The structure reader ------------------------------------------------------------------------

test('tsx structure: elements, attributes and JSX text are read from code, never from strings or comments', () => {
  const page = `// <Input placeholder="in a comment" />
const label = '<Input aria-label="in a string" />';
const C = () => <Field label="First name"><Input aria-label="First" value={form.x} onChange={(_, d) => set(d.value > 1)} /></Field>;
const D = () => <Text>Hello {name} world &amp; more</Text>;
const n = useState<Row>(null);`;
  const inputs = jsxElements(page, /^Input$/);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].attrs.get('aria-label').value, 'First');
  assert.equal(inputs[0].attrs.get('value').value, 'form.x');
  assert.equal(inputs[0].selfClosing, true);
  const field = jsxElements(page, /^Field$/)[0];
  assert.ok(field.childrenStart <= inputs[0].start && inputs[0].start < field.childrenEnd);
  assert.deepEqual(jsxElements(page, /^Row$/), [], 'a type argument is not an element');
  assert.deepEqual(jsxTextRuns(page).map((r) => r.text.trim()), ['Hello', 'world & more']);
  assert.deepEqual(patternNames('[{ tasks, loading, error }, setData]'), ['tasks', 'loading', 'error', 'setData']);
  assert.deepEqual(patternNames('(e: React.DragEvent<HTMLDivElement>, id: string)'), ['e', 'id']);
  assert.deepEqual(patternNames('{ dataApi, pageInput: input = null }'), ['dataApi', 'input']);
  assert.deepEqual(patternNames('{ item, dragging }: TaskCardProps'), ['item', 'dragging']);
});

// A tag's type arguments (`<DataGridRow<Row> title="…">`) are erased before it renders: the tag is read like any other
// when they are names only, the form the plugin's lexer reads for certain. Anything else in them (a function, string,
// template, object or other type) leaves the tag unreadable: it is not read as an element, and unreadableElements reports
// where it is, so a check can refuse the page rather than pass what it cannot see.
test('tsx structure: a tag with type arguments of names only is read; any other is reported as unreadable', () => {
  const { unreadableElements } = require('../lib/tsx-structure.js');
  const read = (page) => jsxElements(page).map((e) => [e.name, e.start, e.openEnd, e.childrenEnd, e.end, Object.fromEntries([...e.attrs].map(([k, a]) => [k, a.value]))]);
  for (const tag of ['<DataGridRow<Row>', '<A <Row>', '<A /* row */ <Row>', '<A\n<Row>', '<A\r\n<Row>', '<A // row\n<Row>', '<Grid<Map<string, Row[]>>', '<A.B<T | U, V & W>', '<A<| ns.T>', '<A<B>']) {
    const page = `${tag} title="&euro;" />`;
    const name = tag.match(/^<([\w.]+)/)[1];
    assert.deepEqual(read(page), [[name, 0, page.length, page.length, page.length, { title: '&euro;' }]], tag);
    assert.deepEqual(unreadableElements(page), [], tag);
  }
  // Nested elements of one name, with and without type arguments, close where they do; nothing inside the arguments is a tag.
  const nested = '<L<Row>><L>a</L><L<Map<K, V>>>b</L></L>';
  assert.deepEqual(read(nested).map(([name, start, openEnd, childrenEnd, end]) => [name, start, openEnd, childrenEnd, end]), [['L', 0, 8, 35, 39], ['L', 8, 11, 12, 16], ['L', 16, 30, 31, 35]]);
  assert.deepEqual(jsxElements('<A<B<C>> />', /^[BC]$/), [], 'a type argument is no element');
  // Not names only: not read, and reported at its line and column (a line ends at LF, CR LF or a lone CR).
  const unreadable = [
    '<A<() => () => "<B<() => string>>"> title="&euro;">Hello</A>',
    '<DataGridRow<() => () => string /* <B<() => string>> */> title="&euro;" />',
    '<A<() => "a\\\nb"> title="&euro;" />',
    '<A<() => "a\\\r\nb"> title="&euro;" />',
    '<A<() => `x${string /* the type\'s name */}y`> title={t("ok")} />',
    '<A<"a\\"//"> title="&euro;" />',
    '<A<"a\\"/*"> title="&euro;" />',
    '<A<keyof Row> />', '<A<typeof row> />', '<A<Row["k"]> />', '<A<{ x: T }> />', '<A<[T, U]> />', '<A<1> />', '<A<(T)> />', '<A<T,> />', '<A<> />',
  ];
  for (const tag of unreadable) {
    const page = `const a = 1;\r\nconst b = 2;\rconst P = () => ${tag};\nexport default P;`;
    const name = tag.match(/^<([\w.]+)/)[1];
    assert.deepEqual(unreadableElements(page)[0], { name, start: 43, line: 3, column: 17 }, tag);
    assert.ok(!jsxElements(page).some((e) => e.start === 43), `${tag} is not read`);
  }
  // Type arguments of a call or a generic arrow, and a comparison, are no tags at all.
  const code = 'const x = a < b;\nconst y = fn<T>(x);\nconst [r] = useState<Row>(null);\nconst f = <T,>(x: T) => x;\nconst m = useMemo<Record<string, Row[]>>(() => ({}), []);';
  assert.deepEqual(jsxElements(code), []);
  assert.deepEqual(unreadableElements(code), []);
});

// The closing tag of an element is found by counting the openings of its name that the one traversal of the page found,
// which steps over every tag's type arguments: a type named `of` (an expression keyword's spelling) does not make
// `<Field<Row>>` inside `<Box<of<Field<Row>>> />` an opening that would close the outer Field early.
test('tsx structure: a name inside another tag\u2019s type arguments never counts toward a closing tag', () => {
  const bounds = (page, name) => jsxElements(page, new RegExp(`^${name}$`)).map((e) => [e.start, e.openEnd, e.childrenEnd, e.end]);
  assert.deepEqual(bounds('<A><B<of<A<T>>> /></A>', 'A'), [[0, 3, 18, 22]]);
  const page = 'type of<T> = T;\nconst P = () => <Field label="Name"><Box<of<Field<Row>>> /><Input /></Field>;';
  assert.deepEqual(bounds(page, 'Field'), [[32, 52, 84, 92]]);
  assertPass(grade(LABELS, inline(page)));
});

// closingTag finds the first opening of the name after an element's opening tag by a binary search over the source-ordered
// openings: a scan from the first opening read n² / 2 openings for n flat siblings (2,100,223 for 2,048 `<div></div>`).
// The count of openings read, through a proxy, is the measure, not the time.
test('tsx structure: finding the closing tags of n same-name siblings reads about n log n openings, not n squared', () => {
  const { closingTag, sourceView } = require('../lib/tsx-structure.js');
  for (const n of [512, 1024, 2048]) {
    const page = `const P = () => <>${'<div></div>'.repeat(n)}</>;`;
    const { code } = sourceView(page);
    const openings = [...code.matchAll(/<div>/g)].map((m) => ({ start: m.index, open: { attrsFrom: m.index + 4 } }));
    let reads = 0;
    const counted = new Proxy(openings, { get: (target, key, receiver) => { if (/^\d+$/.test(String(key))) reads += 1; return Reflect.get(target, key, receiver); } });
    const ends = openings.map((tag) => closingTag(code, 'div', tag.start + 5, counted).end);
    assert.deepEqual(ends, openings.map((tag) => tag.start + 11), `n = ${n}: each div closes itself`);
    assert.deepEqual(jsxElements(page, /^div$/).map((e) => e.end), ends, `n = ${n}: jsxElements finds the same ends`);
    assert.ok(reads <= n * (Math.log2(n) + 3), `n = ${n}: ${reads} openings read`);
  }
  // Nested same-name elements, and a same-name opening inside another tag's type arguments, keep their exact bounds.
  const bounds = (page, name) => jsxElements(page, new RegExp(`^${name}$`)).map((e) => [e.start, e.openEnd, e.childrenEnd, e.end]);
  assert.deepEqual(bounds('<L<T>><L>x</L><L<U> /><L<V>>y</L></L>', 'L'), [[0, 6, 33, 37], [6, 9, 10, 14], [14, 22, 22, 22], [22, 28, 29, 33]]);
});

// A tag's name may start with `_` or `$`, as any identifier may: such a tag is read, or reported, like any other.
test('tsx structure: a tag whose name starts with _ or $ is read or reported like any other', () => {
  const { unreadableElements } = require('../lib/tsx-structure.js');
  const read = (page) => jsxElements(page).map((e) => [e.name, e.start, e.openEnd, e.childrenEnd, e.end, Object.fromEntries([...e.attrs].map(([k, a]) => [k, a.value]))]);
  assert.deepEqual(read('<$Grid<Row> title="&euro;">x</$Grid>'), [['$Grid', 0, 27, 28, 36, { title: '&euro;' }]]);
  assert.deepEqual(read('<_Grid title="a"><_Grid<Row> /></_Grid>'), [['_Grid', 0, 17, 31, 39, { title: 'a' }], ['_Grid', 17, 31, 31, 31, {}]]);
  assert.deepEqual(unreadableElements('const P = () => <_Grid<keyof Row> title="&euro;" />;'), [{ name: '_Grid', start: 16, line: 1, column: 17 }]);
  const code = 'const c = a <_b;\nconst d = x <$y> z;';
  assert.deepEqual(jsxElements(code), []);
  assert.deepEqual(unreadableElements(code), []);
  const CURRENCY = 'Phase 5 (Page Builder): Generated .tsx does NOT hardcode currency symbols or date formats';
  assertFail(grade(CURRENCY, inline('function t(k) { return k; }\nconst P = () => <$Grid<Row> title="&euro;">{t("ok")}</$Grid>;')), /hardcoded currency symbol "\u20ac"/);
  assertFail(grade(CURRENCY, inline('function t(k) { return k; }\nconst P = () => <_Grid<keyof Row> title="&euro;">{t("ok")}</_Grid>;')), /<_Grid> at line 2, column 17 has type arguments that are not only names/);
  assertPass(grade(CURRENCY, inline('function t(k) { return k; }\nconst P = () => <_Grid title={t("total")}>{t("ok")}</_Grid>;')));
});

// `of` is a keyword only inside a `for (… of …)` head, and a name outside every one (the lexer's ofTakesOperand), so
// a `<` after a type or a value named `of` opens type arguments or compares; it never starts an element. Generic calls
// and annotations through such a type are no tags, and the page's checks read only its real elements.
test('tsx structure: a type or value named `of` starts no element; the `of` of a for head still does', () => {
  const { unreadableElements } = require('../lib/tsx-structure.js');
  const CURRENCY = 'Phase 5 (Page Builder): Generated .tsx does NOT hardcode currency symbols or date formats';
  const body = 'function t(k) { return k; }\nexport default function P() { return <Field label={t("name")}><Input aria-label={t("name")} /><Text>{t("hi")}</Text></Field>; }\n';
  const names = (page) => jsxElements(page).map((e) => e.name);
  for (const head of [
    'type of<T> = T;\nconst x = fn<of<List<() => Row>>>();\n', 'import type { of } from "./t";\nconst x = fn<of<List<() => Row>>>();\n',
    'type of<T> = T;\nconst x = fn<of<List<Row>>>();\n', 'type of<T> = T;\nlet v: Map<string, of<List<() => Row>>>;\n',
    'const of = 1;\nconst y = of < 2;\nconst z = of / 2;\nconst w = x.of < y;\n',
  ]) {
    const page = head + body;
    assert.deepEqual(unreadableElements(page), [], head);
    assert.deepEqual(names(page), ['Field', 'Input', 'Text'], head);
    for (const check of [LABELS, TRANSLATED, CURRENCY]) assertPass(grade(check, inline(page)));
  }
  for (const head of ['for (const x of <A title="&euro;" />.props.items) {}\n', 'async function f() { for await (const x of <A title="&euro;" />) {} }\n']) {
    assert.deepEqual(names(head + body), ['A', 'Field', 'Input', 'Text'], head);
    assertFail(grade(CURRENCY, inline(head + body)), /hardcoded currency symbol "\u20ac"/);
  }
});

// --- Eval 4: the wizard ----------------------------------------------------------------------------

const E4 = '4-case-wizard';
const WIZARD = 'Phase 5 (Page Builder): Generated code includes step state management (current step tracking) and Next/Back navigation';
const REVIEW = 'Phase 5 (Page Builder): Step 3 (review) shows a summary of entered data before submission';
const LABELS = 'Phase 5 (Page Builder): All form fields have aria-labels or aria-labelledby for accessibility';

// The step navigation is recorded as unscored (tests/eval-coverage-baseline.json): whether Next and Back move
// the step is the value the step's setter RECEIVES, and a syntactic scan of a handler cannot prove that —
// `setStep((s) => { const next = s + 1; return s; })` computes the next step and returns the old one, so the
// wizard never advances, though the increment is right there in the handler. Grading it needs data-flow
// analysis, so no check is registered in either runner rather than one that passes a page like that.
test('eval 4: step state and Next/Back navigation stay unscored, because what the setter receives needs data-flow analysis', () => {
  assert.equal(PHASE5_EXPECTATIONS.has(WIZARD), false, 'no Layer 2 check is registered for the step navigation');
  assert.equal(layer2.getExpectationCheck(WIZARD), undefined, 'the Layer 2 runner finds no check for it');
  assert.equal(layer1.getExpectationCheck(WIZARD), undefined, 'the Layer 1 runner finds no check for it');
  const entry = BASELINE.genpage.unscored.find((e) => e.text === WIZARD);
  assert.ok(entry, 'the coverage baseline records the expectation as unscored');
  assert.equal(entry.eval, 4);
  assert.equal(entry.status, 'deferred');
  assert.match(entry.reason, /data-flow analysis/);
});

test('eval 4: the review step shows every entered field and gates the submit', () => {
  assertPass(grade(REVIEW, committed(E4)));
  assertFail(grade(REVIEW, withPage(E4, 'page.tsx', ['<Text weight="semibold">{form.contactEmail}</Text>', '<Text weight="semibold">—</Text>'])), /does not show form\.contactEmail/);
  assertFail(grade(REVIEW, withPage(E4, 'page.tsx', ['{step === 3 && (', '{step === 9 && false && ('])), /does not show form\./);
  const ungated = `const GeneratedComponent = () => {
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState('');
  return <div>
    {step === 1 && (<Input aria-label="Title" value={title} onChange={(_, d) => setTitle(d.value)} />)}
    {step === 2 && (<Text>{title}</Text>)}
    <Button onClick={() => dataApi.createRow('incident', { title })}>Submit</Button>
  </div>;
};`;
  assertFail(grade(REVIEW, inline(ungated)), /submit button "Submit" can be pressed when step is 1, not only on the review step/);
  assertPass(grade(REVIEW, inline(ungated.replace('<Button onClick', '{step === 2 && <Button onClick').replace('Submit</Button>', 'Submit</Button>}'))));
});

test('eval 4: every form field is labelled, a Fluent Field label included', () => {
  assertPass(grade(LABELS, committed(E4)));
  // The Field around a control labels it (Field wires aria-labelledby), so dropping only the control's own aria-label keeps it labelled ...
  assertPass(grade(LABELS, withPage(E4, 'page.tsx', ['<Input\n                            aria-label="Title"', '<Input'])));
  // ... and dropping both leaves the Title input with no accessible name.
  assertFail(grade(LABELS, withPage(E4, 'page.tsx', ['<Field label="Title">\n                        <Input\n                            aria-label="Title"', '<Field>\n                        <Input'])), /<Input> has no aria-label, aria-labelledby or label/);
  assertPass(grade(LABELS, inline('const P = () => <div><Label htmlFor="due">Due</Label><Input id="due" /><Checkbox label="Urgent" /><input type="hidden" /></div>;')));
  assertSkip(grade(LABELS, inline('const P = () => <Text>No fields</Text>;')), /no form fields/);
});

// --- Eval 5: top-level functions --------------------------------------------------------------------

const E5 = '5-kanban-task-board';
const TOP_LEVEL = 'Phase 5 (Page Builder): All components and utilities are separate top-level functions (no nested function definitions)';

test('eval 5: components and utilities are top level; handlers that close over state are not reported', () => {
  assertPass(grade(TOP_LEVEL, committed(E5)));
  assertFail(grade(TOP_LEVEL, withPage(E5, 'task-board.tsx', ['    const handleDragEnd = () => {', '    const Spacer = () => <div className={styles.root} />;\n    const handleDragEnd = () => {'])), /component Spacer is defined inside another function/);
  assertFail(grade(TOP_LEVEL, withPage(E5, 'task-board.tsx', ['    const handleDragEnd = () => {', '    const percent = (n: number) => Math.round(n * 100);\n    const handleDragEnd = () => {'])), /utility percent is defined inside another function but reads nothing from it/);
  assertFail(grade(TOP_LEVEL, withPage(E5, 'task-board.tsx', ['    const handleDragEnd = () => {', '    function label(t: task) { return t.subject; }\n    const handleDragEnd = () => {'])), /utility label is defined inside another function/);
  // An effect's loader reads the component's state and setters: a closure, not a utility.
  assert.deepEqual(nestedDefinitionProblems(`const GeneratedComponent = (props) => {
  const { dataApi } = props;
  const [rows, setRows] = useState([]);
  useEffect(() => { async function load() { setRows((await dataApi.queryTable('task', {})).rows); } load(); }, []);
  return <div>{rows.length}</div>;
};`), []);
});

// A check that needs a page's function scopes reads them through this export rather than keeping a second scope reader.
// A missing export must fail here, by name — never surface later as a TypeError a caller turns into a skip — and
// exporting it changes nothing about the top-level check above.
test('tsx-structure exports its function scope reader, and the top-level check is unchanged by it', () => {
  const structure = require('../lib/tsx-structure.js');
  assert.equal(typeof structure.functionScopes, 'function', 'functionScopes is exported');
  const code = structure.sourceView(`function load(id: string) { return id; }
const PageBody = (props: Props) => { const go = async () => { await load('x'); }; return null; };`).code;
  const scopes = structure.functionScopes(code);
  assert.deepEqual(scopes.map((scope) => scope.params).sort((a, b) => a.join().localeCompare(b.join())), [[], ['id'], ['props']]);
  assert.ok(scopes.every((scope) => scope.start < scope.end && code.slice(scope.start, scope.end).trim()), 'each scope is a body range');
  assert.deepEqual(nestedDefinitionProblems(`function PageBody(props: Props) {
  const { dataApi } = props;
  async function save() { await dataApi.createRow('task', {}); }
  return null;
}`), [], 'a handler that closes over the props is not a nested utility');
});

// --- Eval 12: the revised plan -----------------------------------------------------------------------

const E12 = '12-account-plan-revision';
const REVISED = 'Phase 5 (Page Builder): Generated code implements the revised plan (includes BOTH filter toolbar AND search box)';

test('eval 12: the page has the search box the revision added AND the filter toolbar', () => {
  assertPass(grade(REVISED, committed(E12)));
  assertFail(grade(REVISED, withPage(E12, 'account-list.tsx', ["onChange={(_, data) => setSearch(data.value ?? '')}", ''])), /no search box/);
  assertFail(grade(REVISED, withPage(E12, 'account-list.tsx',
    ['<Toolbar className={styles.toolbar} aria-label="Account filters">', '<div className={styles.toolbar} aria-label="Account filters">'],
    ['</Toolbar>', '</div>'])), /no filter toolbar/);
  assertPass(grade(REVISED, inline('const P = () => <div><Input type="search" onChange={(_, d) => setQ(d.value)} /><div role="toolbar"><Dropdown onOptionSelect={pick} /></div></div>;')));
});

// --- Eval 13: translated text -------------------------------------------------------------------------

const E13 = '13-contact-localization';
const TRANSLATED = 'Phase 5 (Page Builder): All user-visible text goes through a translate() helper — no hardcoded display strings in JSX';

test('eval 13: shown text goes through the translate helper', () => {
  assertPass(grade(TRANSLATED, committed(E13)));
  assertFail(grade(TRANSLATED, withPage(E13, 'page.tsx', ["<Text>{t('empty')}</Text>", '<Text>No contacts.</Text>'])), /hardcoded JSX text "No contacts\."/);
  assertFail(grade(TRANSLATED, withPage(E13, 'page.tsx', ["<Spinner label={t('title')} />", '<Spinner label="Loading" />'])), /hardcoded label "Loading" on <Spinner>/);
  assertFail(grade(TRANSLATED, withPage(E13, 'page.tsx', ["<Text>{t('empty')}</Text>", "<Text>{'No contacts.'}</Text>"])), /hardcoded JSX string/);
  assertFail(grade(TRANSLATED, inline('const P = () => <Text>{label}</Text>;')), /no translate\(\) helper/);
  assertPass(grade(TRANSLATED, inline("const translate = (k: string) => k;\nconst P = () => <Text>{translate('title')} ({count}) &nbsp;</Text>;")));
});

// A generic component's attributes are read like any other's (tsx-structure.js), so an unlabelled control, a hardcoded
// title or a submit written with type arguments of names only is graded. A page with a tag whose type arguments are
// anything else fails every check that reads its elements or its JSX text: what that tag holds is not known for certain.
test('evals 4, 12 and 13: a generic component is graded like any other, and a tag the reader cannot read fails the page', () => {
  const UNREADABLE = /<List> at line 1, column \d+ has type arguments that are not only names/;
  assertFail(grade(LABELS, inline('const P = () => <Input<Row> value={x} />;')), /<Input> has no aria-label, aria-labelledby or label/);
  assertPass(grade(LABELS, inline('const P = () => <Input<Row> aria-label="Title" value={x} />;')));
  assertFail(grade(LABELS, inline('const P = () => <div><Input aria-label="Title" value={x} /><List<() => Row> /></div>;')), UNREADABLE);
  assertFail(grade(LABELS, inline('const P = () => <List<() => Row> />;')), UNREADABLE);
  const translated = (jsx) => inline(`const t = (k: string) => k;\nconst P = () => <div>{t('title')}${jsx}</div>;`);
  const UNREADABLE_2 = /<List> at line 2, column \d+ has type arguments that are not only names/;
  assertFail(grade(TRANSLATED, translated('<DataGridRow<Row> title="Hello" />')), /hardcoded title "Hello" on <DataGridRow>/);
  assertFail(grade(TRANSLATED, translated('<DataGridRow<Row> title="&#72;&#105;" />')), /hardcoded title "Hi" \(written "&#72;&#105;"\) on <DataGridRow>/);
  assertPass(grade(TRANSLATED, translated("<DataGridRow<Row> title={t('row')} />")));
  assertFail(grade(TRANSLATED, translated("<List<() => Row> title={t('row')} />")), UNREADABLE_2);
  const gated = SUBMIT.replace('<Button ', '<Button disabled={step !== 2} ');
  assertPass(grade(REVIEW, twoStepPage(gated)));
  assertFail(grade(REVIEW, twoStepPage(SUBMIT.replace('<Button ', '<Button<Row> '))), /can be pressed when step is 1, not only on the review step/);
  assertFail(grade(REVIEW, twoStepPage(`${gated}<List<() => Row> />`)), /<List> at line \d+, column \d+ has type arguments that are not only names/);
  const revised = '<div><Input type="search" onChange={(_, d) => setQ(d.value)} /><div role="toolbar"><Dropdown onOptionSelect={pick} /></div></div>';
  assertPass(grade(REVISED, inline(`const P = () => ${revised};`)));
  assertPass(grade(REVISED, inline(`const P = () => ${revised.replace('<Dropdown ', '<Dropdown<Row> ')};`)));
  assertFail(grade(REVISED, inline(`const P = () => <div>${revised}<List<() => Row> /></div>;`)), UNREADABLE);
});

// --- Eval 15: choice names ------------------------------------------------------------------------------

const E15 = '15-support-tickets-real';
const CHOICES = 'Phase 5 (Page Builder): Generated .tsx uses the choice enum names from RuntimeTypes.ts (not magic numbers)';

test('eval 15: every choice value is named after the RuntimeTypes.ts member it is', () => {
  assertPass(grade(CHOICES, committed(E15)));
  assertFail(grade(CHOICES, withPage(E15, 'support-tickets.tsx', ['if (status === STATUS_RESOLVED || status === STATUS_CLOSED) return false;', 'if (status === 100000002 || status === STATUS_CLOSED) return false;'])), /magic number 100000002/);
  assertFail(grade(CHOICES, withPage(E15, 'support-tickets.tsx', ['const PRIORITY_HIGH     = 100000002;', 'const PRIORITY_HIGH     = 100000001;'])), /PRIORITY_HIGH = 100000001, but RuntimeTypes\.ts gives High = 100000002/);
  assertFail(grade(CHOICES, withPage(E15, 'support-tickets.tsx', ['const PRIORITY_LOW      = 100000000;', 'const PRIORITY_LOW      = 100000009;'])), /100000009 is not a choice value RuntimeTypes\.ts declares/);
  assertSkip(grade(CHOICES, { ...committed(E15), runtimeTypes: null }), /requires RuntimeTypes\.ts fixture/);
  const runtimeTypes = committed(E15).runtimeTypes;
  assertPass(grade(CHOICES, inline("const OPTIONS = [{ value: 100000000, label: 'Low' }, { value: 100000003, label: 'Critical' }];", { runtimeTypes })));
  assertFail(grade(CHOICES, inline("const OPTIONS = [{ value: 100000000, label: 'Urgent' }];", { runtimeTypes })), /magic number 100000000/);
  assertSkip(grade(CHOICES, inline('const P = () => <Text>{row.cr_name}</Text>;', { runtimeTypes })), /compares no choice value/);
});

// --- Evals 1 and 7: column names verified from RuntimeTypes.ts --------------------------------------------

const E1 = '1-account-cards-verified-columns';
const COLUMNS_5B = 'Phase 5b: Generated .tsx uses only column names verified from RuntimeTypes.ts — no guessed names';
const COLUMNS_7 = 'Phase 5 (Page Builder): Generated code uses ONLY verified column names from RuntimeTypes.ts';

test('evals 1 and 7: every column a dataApi call names is one RuntimeTypes.ts declares', () => {
  assertPass(grade(COLUMNS_5B, committed(E1)));
  assertFail(grade(COLUMNS_5B, withPage(E1, 'account-gallery.tsx', ["select: ['accountid', 'name', 'websiteurl',", "select: ['accountid', 'name', 'website',"])), /queryTable\('account'\) select names website, which RuntimeTypes\.ts does not declare on account/);
  assertFail(grade(COLUMNS_5B, withPage(E1, 'account-gallery.tsx', ["orderBy: 'name asc'", "orderBy: 'accountname asc'"])), /orderBy names accountname/);
  assertFail(grade(COLUMNS_5B, withPage(E1, 'account-gallery.tsx', ["dataApi.queryTable('account', {", "dataApi.queryTable('accounts', {"])), /reads table accounts, which RuntimeTypes\.ts does not register/);
  // Columns every user-owned table has, which the type generator does not write, are no guesses.
  assertPass(grade(COLUMNS_5B, withPage(E1, 'account-gallery.tsx', ["orderBy: 'name asc'", "orderBy: 'createdon desc'"])));
  // The historical eval-1 and eval-7 traces kept no RuntimeTypes.ts: nothing to verify against.
  assertSkip(grade(COLUMNS_5B, committed('1-account-card-gallery')), /column-name verification requires RuntimeTypes\.ts fixture/);
  assertSkip(grade(COLUMNS_7, committed('7-job-candidates-new-entities')), /column-name verification requires RuntimeTypes\.ts fixture/);
});

test('eval 7: the job-candidates run kept the RuntimeTypes.ts it generated, so its page\'s columns are graded', () => {
  const E7 = '7-job-candidates-verified-columns';
  const PAGE = 'job-candidates.tsx';
  assertPass(grade(COLUMNS_7, committed(E7)));
  assertFail(grade(COLUMNS_7, withPage(E7, PAGE, ["'cr_interviewscore', 'cr_recruiter',", "'cr_score', 'cr_recruiter',"])), /queryTable\('cr_candidate'\) select names cr_score, which RuntimeTypes\.ts does not declare on cr_candidate/);
  assertFail(grade(COLUMNS_7, withPage(E7, PAGE, ["'_cr_jobrequisition_value'],", "'_cr_requisition_value'],"])), /select names _cr_requisition_value/);
  assertFail(grade(COLUMNS_7, withPage(E7, PAGE, ["orderBy: 'cr_name asc',", "orderBy: 'cr_fullname asc',"])), /orderBy names cr_fullname/);
  assertFail(grade(COLUMNS_7, withPage(E7, PAGE, ["dataApi.queryTable('cr_candidate', {", "dataApi.queryTable('cr_candidates', {"])), /reads table cr_candidates, which RuntimeTypes\.ts does not register/);
});

test('evals 1 and 7: payload keys, annotations and named options are read; another table\'s expand is not', () => {
  const runtimeTypes = committed(E1).runtimeTypes;
  const page = (body) => inline(`const LIST = { select: SELECT, orderBy: 'name asc' };\nconst SELECT = ['accountid', 'name'] as const;\n${body}`, { runtimeTypes });
  assertPass(grade(COLUMNS_7, page("dataApi.queryTable('account', LIST);")));
  assertFail(grade(COLUMNS_7, page("dataApi.queryTable('account', { ...LIST, filter: \"statecode eq 0 and contains(nickname, 'x')\" });")), /filter names nickname/);
  assertPass(grade(COLUMNS_7, page("dataApi.queryTable('account', { select: ['name'], expand: { _primarycontactid_value: { select: ['fullname'] } } });")));
  assertFail(grade(COLUMNS_7, page("dataApi.createRow('account', { name: 'A', creditlimit: 5, 'parentaccountid@odata.bind': '/accounts(1)' });")), /createRow\('account'\) names creditlimit/);
  assertPass(grade(COLUMNS_7, page("dataApi.updateRow('account', id, { telephone1: phone } as WritableTableRow<account>);")));
  assertPass(grade(COLUMNS_7, page("const label = row['_primarycontactid_value@OData.Community.Display.V1.FormattedValue'];")));
  assertFail(grade(COLUMNS_7, page("const label = row['_parentcustomerid_value@OData.Community.Display.V1.FormattedValue'];")), /FormattedValue of _parentcustomerid_value/);
  assertSkip(grade(COLUMNS_7, inline('const P = () => <Text>static</Text>;', { runtimeTypes })), /name no Dataverse column/);
});

// --- Graded holes the first version let through -------------------------------------------------------------
// Each test below failed on the first version of these checks: a page that breaks the expectation was graded
// PASS, or a correct page FAIL. The checks now read the evidence the expectation is about.

test('columns: a column quoted in a comment is not a column the page names', () => {
  assertPass(grade(COLUMNS_5B, withPage(E1, 'account-gallery.tsx', ["select: ['accountid', 'name',", "select: ['accountid', /* formerly 'retired_name' */ 'name',"])));
  assertPass(grade(COLUMNS_5B, withPage(E1, 'account-gallery.tsx', ["select: ['accountid', 'name',", "select: [\n                    'accountid', // was 'legacy_id'\n                    'name',"])));
  assertPass(grade(COLUMNS_5B, withPage(E1, 'account-gallery.tsx', ["orderBy: 'name asc',", "orderBy: /* was 'createdate desc' */ 'name asc',"])));
  // The real names around the comments are still read.
  assertFail(grade(COLUMNS_5B, withPage(E1, 'account-gallery.tsx', ["select: ['accountid', 'name', 'websiteurl',", "select: ['accountid', /* 'name' */ 'name', 'website',"])), /select names website, which RuntimeTypes\.ts does not declare/);
  assertFail(grade(COLUMNS_5B, withPage(E1, 'account-gallery.tsx', ["orderBy: 'name asc',", "orderBy: /* sort */ 'nickname asc',"])), /orderBy names nickname/);
  // A select list the call names through a constant is read from the constant's declaration, without its comments.
  const declared = (list) => withPage(E1, 'account-gallery.tsx',
    ["select: ['accountid', 'name', 'websiteurl', 'emailaddress1', 'telephone1'],", 'select: ACCOUNT_COLUMNS,'],
    ["const CACHE_KEY = '__ppAccountsGallery_accountCache';", `const ACCOUNT_COLUMNS = ${list};\nconst CACHE_KEY = '__ppAccountsGallery_accountCache';`]);
  assertPass(grade(COLUMNS_5B, declared("['accountid', /* was 'retired_name' */ 'name', 'websiteurl', 'emailaddress1', 'telephone1']")));
  assertFail(grade(COLUMNS_5B, declared("['accountid', /* 'name' */ 'website']")), /select names website, which RuntimeTypes\.ts does not declare/);
});

test('eval 5: a nested utility\'s own locals are not bindings it closes over', () => {
  const insert = (helper) => withPage(E5, 'task-board.tsx', ['    const handleDragEnd = () => {', `${helper}\n    const handleDragEnd = () => {`]);
  assertFail(grade(TOP_LEVEL, insert('    const percent = (n: number) => {\n        const rounded = Math.round(n * 100);\n        return rounded;\n    };')), /utility percent is defined inside another function but reads nothing from it/);
  // A parameter or a local that shadows the component's own names (tasks, hoverCol) reads nothing from it either.
  assertFail(grade(TOP_LEVEL, insert('    const share = (tasks: number) => {\n        const hoverCol = tasks * 100;\n        return hoverCol;\n    };')), /utility share is defined inside another function/);
  // A handler with locals of its own that sets the component's state still closes over it.
  assertPass(grade(TOP_LEVEL, insert('    const clearHover = () => {\n        const none = null;\n        setHoverCol(none);\n    };')));
  // A name a SIBLING declares is not one the component declares: `percent` reads the module's `scale`.
  const sibling = withPage(E5, 'task-board.tsx',
    ['// ---- Status constants', 'const scale = 100;\n\n// ---- Status constants'],
    ['    const handleDragEnd = () => {', '    const handleScale = () => {\n        const scale = 2;\n        setHoverCol(null);\n        return scale;\n    };\n    const percent = (n: number) => Math.round(n * scale);\n    const handleDragEnd = () => {']);
  assertFail(grade(TOP_LEVEL, sibling), /utility percent is defined inside another function but reads nothing from it/);
});

// A two-step page whose review step (step 2) shows the title step 1 enters, with `submit` placed as given.
const twoStepPage = (submit) => inline(`const GeneratedComponent = () => {
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState('');
  return <div>
    {step === 1 && (<Input aria-label="Title" value={title} onChange={(_, d) => setTitle(d.value)} />)}
    {step === 2 && (<Text>{title}</Text>)}
    ${submit}
  </div>;
};`);
const SUBMIT = "<Button onClick={() => dataApi.createRow('incident', { title })}>Submit</Button>";

test('eval 4: every submit is reachable only on the review step', () => {
  assertFail(grade(REVIEW, withPage(E4, 'page.tsx', ['{step < 3 ? (', '{step < 1 ? ('])), /submit button .*not only on the review step/);
  assertFail(grade(REVIEW, withPage(E4, 'page.tsx', ['            <div className={styles.nav}>', '            <Button onClick={handleSubmit}>Submit now</Button>\n            <div className={styles.nav}>'])), /submit button .*not only on the review step/);
  const page = twoStepPage;
  // Disabled on every step but the review is gated too; so is the false side of a boundary that ends at it.
  assertPass(grade(REVIEW, page(SUBMIT.replace('<Button ', '<Button disabled={step !== 2} '))));
  assertPass(grade(REVIEW, page(`{step < 2 ? <Button onClick={() => setStep(step + 1)}>Next</Button> : ${SUBMIT}}`)));
  // With steps 1 and 2, `step !== 1` IS the review step; `step !== 2` is the first step.
  assertPass(grade(REVIEW, page(`{step !== 1 && ${SUBMIT}}`)));
  assertFail(grade(REVIEW, page(`{step !== 2 && ${SUBMIT}}`)), /can be pressed when step is 1, not only on the review step/);
  assertFail(grade(REVIEW, page(`{ready ? ${SUBMIT} : null}`)), /not only on the review step/);
  // A condition read through a declaration counts like the comparison it holds.
  const aliased = inline(page(`{isReview && ${SUBMIT}}`).files[0].content.replace('const [title', 'const isReview = step === 2;\n  const [title'));
  assertPass(grade(REVIEW, aliased));
});

// `a ?? b` falls back to b only when a is null or undefined, so it is not `||`: `false ?? (step !== 3)` is
// false, and the button it disables can be pressed. Literals are read for what they are.
test('eval 4: `??` and literal conditions decide whether a submit can be pressed the way JavaScript evaluates them', () => {
  const extra = (disabled) => withPage(E4, 'page.tsx', ['            <div className={styles.nav}>', `            <Button onClick={handleSubmit} disabled={${disabled}}>Submit now</Button>\n            <div className={styles.nav}>`]);
  assertPass(grade(REVIEW, extra('submitting || (step !== 3)')));
  assertFail(grade(REVIEW, extra('submitting ?? (step !== 3)')), /submit button "Submit now" can be pressed when step is 1 or 2, not only on the review step/);
  // A nullish left side does fall back, and a literal true disables for good ...
  for (const disabled of ['undefined ?? (step !== 3)', 'null ?? (step !== 3)', 'true']) assertPass(grade(REVIEW, extra(disabled)));
  // ... while false, null and undefined disable nothing.
  for (const disabled of ['false', 'null', 'undefined']) assertFail(grade(REVIEW, extra(disabled)), /submit button "Submit now" can be pressed when step is 1 or 2/);
  // The only submit, disabled for good, leaves nothing to press on the review step.
  assertFail(grade(REVIEW, twoStepPage(`{step === 2 && ${SUBMIT.replace('<Button ', '<Button disabled={true} ')}}`)), /no submit button can be pressed on the review step/);
  // In JSX, `x ?? <Submit/>` shows the fallback wherever x may be nullish; inside a step's branch it stays there.
  assertFail(grade(REVIEW, twoStepPage(`{pending ?? ${SUBMIT}}`)), /can be pressed when step is 1, not only on the review step/);
  assertPass(grade(REVIEW, twoStepPage(`{step === 2 && (pending ?? ${SUBMIT})}`)));
  // A comparison is never nullish, so the fallback after it is never shown, on any step.
  assertFail(grade(REVIEW, twoStepPage(`{(step !== 2) ?? ${SUBMIT}}`)), /no submit button can be pressed on the review step/);
});

test('eval 4: an empty label is no label', () => {
  const TITLE = '<Field label="Title">\n                        <Input\n                            aria-label="Title"';
  assertFail(grade(LABELS, withPage(E4, 'page.tsx', [TITLE, '<Field label="">\n                        <Input'])), /<Input> has no aria-label, aria-labelledby or label/);
  assertFail(grade(LABELS, withPage(E4, 'page.tsx', [TITLE, '<Field label={null}>\n                        <Input'])), /<Input> has no aria-label/);
  assertFail(grade(LABELS, withPage(E4, 'page.tsx', [TITLE, "<Field>\n                        <Input\n                            aria-label={''}"])), /<Input> has no aria-label/);
  // A translated or computed label still names the control.
  assertPass(grade(LABELS, withPage(E4, 'page.tsx', [TITLE, "<Field label={translate('title')}>\n                        <Input"])));
});

// A `<label htmlFor>` (or Fluent `<Label htmlFor>`) names its control only if it can show some text: an
// expression that is statically empty (`{null}`, `{''}`, `{undefined}`, `{false}`, a comment) shows nothing,
// at any depth of the markup inside it, and a nested element's attributes are no text. Text, a non-empty
// literal and a computed or translated value do.
test('eval 4: a label element that shows nothing names no control', () => {
  const TITLE = '<Field label="Title">\n                        <Input\n                            aria-label="Title"';
  const labelled = (label) => withPage(E4, 'page.tsx', [TITLE, `<Field>\n                        ${label}\n                        <Input\n                            id="title"`]);
  for (const tag of ['label', 'Label']) {
    for (const nothing of ['{null}', "{''}", '{undefined}', '{false}', '{/* the title */}', '<span>{null}</span>', '<span className={styles.title}>{null}</span>', ' ']) {
      assertFail(grade(LABELS, labelled(`<${tag} htmlFor="title">${nothing}</${tag}>`)), /<Input> has no aria-label, aria-labelledby or label/);
    }
    for (const shown of ['Title', "{'Title'}", "{translate('title')}", '{titleLabel}', '<span>Title</span>']) {
      assertPass(grade(LABELS, labelled(`<${tag} htmlFor="title">${shown}</${tag}>`)));
    }
  }
});

// A comment is no value: an expression that is empty once its comments are left out (`{/* hidden */ null}`,
// `{/* none */ ''}`) names nothing, as an attribute's value and as a label element's child. The comments are the
// ones the plugin's lexer finds, so comment delimiters inside a string are text, and a value beside a comment counts.
test('eval 4: an empty value beside a comment is no label', () => {
  const TITLE = '<Field label="Title">\n                        <Input\n                            aria-label="Title"';
  const fieldLabel = (value) => withPage(E4, 'page.tsx', [TITLE, `<Field label={${value}}>\n                        <Input`]);
  const ariaLabel = (value) => withPage(E4, 'page.tsx', [TITLE, `<Field>\n                        <Input\n                            aria-label={${value}}`]);
  const labelled = (label) => withPage(E4, 'page.tsx', [TITLE, `<Field>\n                        ${label}\n                        <Input\n                            id="title"`]);
  for (const empty of ['/* hidden */ null', "/* none */ ''", 'null /* hidden */', '/* a */ /* b */ undefined', '// none\n false']) {
    assertFail(grade(LABELS, fieldLabel(empty)), /<Input> has no aria-label, aria-labelledby or label/);
    assertFail(grade(LABELS, ariaLabel(empty)), /<Input> has no aria-label, aria-labelledby or label/);
    for (const tag of ['label', 'Label']) {
      assertFail(grade(LABELS, labelled(`<${tag} htmlFor="title">{${empty}}</${tag}>`)), /<Input> has no aria-label, aria-labelledby or label/);
      assertFail(grade(LABELS, labelled(`<${tag} htmlFor="title"><span>{${empty}}</span></${tag}>`)), /<Input> has no aria-label, aria-labelledby or label/);
    }
  }
  // An attribute holding only a comment does not compile (an attribute's expression may not be empty); it names nothing either.
  assertFail(grade(LABELS, ariaLabel('/* none */')), /<Input> has no aria-label, aria-labelledby or label/);
  for (const shown of ["/* shown */ 'Title'", "translate('title') /* shown */", "'/* not a comment */'", '// a note\n titleLabel']) {
    assertPass(grade(LABELS, fieldLabel(shown)));
    assertPass(grade(LABELS, ariaLabel(shown)));
    assertPass(grade(LABELS, labelled(`<label htmlFor="title">{${shown}}</label>`)));
  }
});

// TypeScript and Babel decode a character reference in JSX text and in an attribute's string, so a label written
// only in references shows the characters they stand for. It names its control unless every reference stands for
// white space (`&nbsp;`, `&#32;`): that shows nothing, like a literal non-breaking space. A reference JSX does not
// decode (`&nosuch;`, `&#X54;`) is shown as written.
test('eval 4: a label written in character references names its control; one of white space does not', () => {
  const TITLE = '<Field label="Title">\n                        <Input\n                            aria-label="Title"';
  const labelled = (label) => withPage(E4, 'page.tsx', [TITLE, `<Field>\n                        ${label}\n                        <Input\n                            id="title"`]);
  for (const tag of ['label', 'Label']) {
    for (const shown of ['&#84;&#105;&#116;&#108;&#101;', '&#x54;', '&amp;', '&eacute;', '&nosuch;', '&#X54;', '<span>&#84;</span>', '&#x54;&#x69;tle', '&nbsp;Title']) {
      assertPass(grade(LABELS, labelled(`<${tag} htmlFor="title">${shown}</${tag}>`)));
    }
    for (const blank of ['&nbsp;', '&#32;', '&#x20;&#160;', '&ensp;&emsp;&thinsp;', ' &nbsp; &#10; ', '<span>&nbsp;</span>']) {
      assertFail(grade(LABELS, labelled(`<${tag} htmlFor="title">${blank}</${tag}>`)), /<Input> has no aria-label, aria-labelledby or label/);
    }
  }
  const fieldLabel = (value) => withPage(E4, 'page.tsx', [TITLE, `<Field label="${value}">\n                        <Input`]);
  const ariaLabel = (value) => withPage(E4, 'page.tsx', [TITLE, `<Field>\n                        <Input\n                            aria-label="${value}"`]);
  for (const blank of ['&nbsp;', '&#32;', '&#xA0;', '\u00a0']) {
    assertFail(grade(LABELS, fieldLabel(blank)), /<Input> has no aria-label, aria-labelledby or label/);
    assertFail(grade(LABELS, ariaLabel(blank)), /<Input> has no aria-label, aria-labelledby or label/);
  }
  for (const shown of ['&#84;&#105;&#116;&#108;&#101;', '&amp;', 'R&D', '&#X54;']) {
    assertPass(grade(LABELS, fieldLabel(shown)));
    assertPass(grade(LABELS, ariaLabel(shown)));
  }
});

test('eval 13: literal text in a conditional or a template child is hardcoded too', () => {
  const child = (expression) => withPage(E13, 'page.tsx', ["<Text>{t('empty')}</Text>", `<Text>{${expression}}</Text>`]);
  assertFail(grade(TRANSLATED, child("rows.length ? 'Contacts' : 'No contacts.'")), /hardcoded JSX string '(?:Contacts|No contacts\.)'/);
  assertFail(grade(TRANSLATED, child("rows.length === 0 && 'No contacts.'")), /hardcoded JSX string 'No contacts\.'/);
  assertFail(grade(TRANSLATED, child("error || 'Something went wrong'")), /hardcoded JSX string 'Something went wrong'/);
  assertFail(grade(TRANSLATED, child("error ?? 'Unknown error'")), /hardcoded JSX string 'Unknown error'/);
  assertFail(grade(TRANSLATED, child('`${rows.length} contacts`')), /hardcoded JSX string `/);
  assertFail(grade(TRANSLATED, withPage(E13, 'page.tsx', ["<Spinner label={t('title')} />", "<Spinner label={rows.length ? 'Loading' : t('title')} />"])), /hardcoded label 'Loading' on <Spinner>/);
  // Keys inside the helper's call, and branches that are translated or only numbers, are not text.
  assertPass(grade(TRANSLATED, child("rows.length ? t('title') : t('empty')")));
  assertPass(grade(TRANSLATED, child('error ? t(\'empty\') : `${rows.length}`')));
});

// JSX decodes the character references in its text and in an attribute's string (lib/jsx-references.js, the page compiler's
// own decoding), so a page shows `&#78;&#111;` as "No" and `&eacute;` as "é": text spelled with them is hardcoded exactly as
// its plain spelling is, and what the compiler does not decode (`&nosuch;`, `&#X4E;`) is shown as written, letters and all.
// A reference to white space, punctuation, a symbol or a digit shows no letter, as the plain character shows none; a
// JavaScript string is not decoded; and a key or a value the page does not show (`t('…')`, `className`, `key`) is no text,
// however it is spelled.
test('eval 13: text spelled with character references is held to the rule as the text it renders', () => {
  const text = (written) => withPage(E13, 'page.tsx', ["<Text>{t('empty')}</Text>", `<Text>${written}</Text>`]);
  const label = (written) => withPage(E13, 'page.tsx', ["<Spinner label={t('title')} />", `<Spinner label="${written}" />`]);
  // A problem quotes at most 40 characters of each spelling, as it always has.
  assertFail(grade(TRANSLATED, text('&#78;&#111;&#32;&#99;&#111;&#110;&#116;&#97;&#99;&#116;&#115;&#46;')),
    /hardcoded JSX text "No contacts\." \(written "&#78;&#111;&#32;&#99;&#111;&#110;&#116;&"\)$/);
  assertFail(grade(TRANSLATED, text('&#x4E;&#x6F;')), /hardcoded JSX text "No" \(written "&#x4E;&#x6F;"\)$/);
  assertFail(grade(TRANSLATED, text('&Eacute;&eacute;')), /hardcoded JSX text "Éé" \(written "&Eacute;&eacute;"\)$/);
  assertFail(grade(TRANSLATED, text('&#1575;&#1604;')), /hardcoded JSX text "ال" \(written "&#1575;&#1604;"\)$/);
  assertFail(grade(TRANSLATED, text('&nosuch;')), /hardcoded JSX text "&nosuch;"$/);
  assertFail(grade(TRANSLATED, text('&#X4E;&#X6F;')), /hardcoded JSX text "&#X4E;&#X6F;"$/);
  assertFail(grade(TRANSLATED, label('&#76;&#111;&#97;&#100;&#105;&#110;&#103;')),
    /hardcoded label "Loading" \(written "&#76;&#111;&#97;&#100;&#105;&#110;&#103;"\) on <Spinner>$/);
  assertFail(grade(TRANSLATED, label('&#x4C;oading')), /hardcoded label "Loading" \(written "&#x4C;oading"\) on <Spinner>$/);
  // Plain letters were hardcoded before and still are, quoted as written when no reference changes them.
  assertFail(grade(TRANSLATED, text('No contacts.')), /hardcoded JSX text "No contacts\."$/);
  assertFail(grade(TRANSLATED, text('Save &amp; close')), /hardcoded JSX text "Save & close" \(written "Save &amp; close"\)$/);
  for (const written of ['&nbsp;', '&#32;', '&mdash;', '&#x2014;', '&copy; 2026', '&middot;', '&hellip;', '&#40;3&#41;']) {
    assertPass(grade(TRANSLATED, text(`{t('empty')} ${written}`)));
    assertPass(grade(TRANSLATED, label(written)));
  }
  assertPass(grade(TRANSLATED, text("{'&#78;&#111;'}")));
  assertFail(grade(TRANSLATED, text("{'&amp;'}")), /hardcoded JSX string '&amp;'$/);
  assertPass(grade(TRANSLATED, text("{t('&#78;&#111;')}")));
  assertPass(grade(TRANSLATED, text('<span className="&#78;&#111;" key="&#78;&#111;">{t(\'empty\')}</span>')));
});
