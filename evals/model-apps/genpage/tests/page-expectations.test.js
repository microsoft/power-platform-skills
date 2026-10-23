'use strict';

// Unit tests for the Phase 5 page checks graded from how a generated page is BUILT
// (lib/page-checks.js, lib/tsx-structure.js and lib/column-contract.js, registered in
// lib/assertions-layer-2.js): eval 4's wizard steps, review summary and field labels, eval 5's top-level
// functions, eval 12's search box beside a filter toolbar, eval 13's translated text, eval 15's choice
// names, and the column names evals 1 and 7 verify against RuntimeTypes.ts.
//
// Each check PASSES on the committed fixture it grades, FAILS on an in-memory mutation of that page
// that introduces exactly the regression it exists to catch, and SKIPs only where its evidence is not
// part of a page. Mutations go through `edit`, which asserts the text it replaces is really there, so a
// fixture change cannot silently turn a failing case into a vacuous one. Small inline pages pin the
// equivalent forms a check accepts (a handler followed one level, a Fluent Field's label).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { PHASE5_EXPECTATIONS } = require('../lib/assertions-layer-2.js');
const { loadFixtures } = require('../lib/fixture-loader.js');
const { nestedDefinitionProblems, jsxElements, jsxTextRuns, patternNames } = require('../lib/tsx-structure.js');

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
  assert.deepEqual(jsxTextRuns(page).map((r) => r.text.trim()), ['Hello', 'world   more']);
  assert.deepEqual(patternNames('[{ tasks, loading, error }, setData]'), ['tasks', 'loading', 'error', 'setData']);
  assert.deepEqual(patternNames('(e: React.DragEvent<HTMLDivElement>, id: string)'), ['e', 'id']);
  assert.deepEqual(patternNames('{ dataApi, pageInput: input = null }'), ['dataApi', 'input']);
  assert.deepEqual(patternNames('{ item, dragging }: TaskCardProps'), ['item', 'dragging']);
});

// --- Eval 4: the wizard ----------------------------------------------------------------------------

const E4 = '4-case-wizard';
const WIZARD = 'Phase 5 (Page Builder): Generated code includes step state management (current step tracking) and Next/Back navigation';
const REVIEW = 'Phase 5 (Page Builder): Step 3 (review) shows a summary of entered data before submission';
const LABELS = 'Phase 5 (Page Builder): All form fields have aria-labels or aria-labelledby for accessibility';

test('eval 4: step state chooses the step and Next/Back buttons move it by one', () => {
  assertPass(grade(WIZARD, committed(E4)));
  assertFail(grade(WIZARD, withPage(E4, 'page.tsx', ['onClick={() => setStep((s) => Math.min(3, s + 1))}', 'onClick={() => undefined}'])), /no Next button whose handler advances setStep/);
  assertFail(grade(WIZARD, withPage(E4, 'page.tsx', ['setStep((s) => Math.max(1, s - 1))', 'setStep((s) => s)'])), /no Back button whose handler moves setStep back/);
  assertFail(grade(WIZARD, withPage(E4, 'page.tsx', ['const [step, setStep] = React.useState(1);', 'const [phase, setPhase] = React.useState(1);'])), /no step state/);
});

test('eval 4: a Next handler is followed one level, and step state must choose what renders', () => {
  const page = (body) => `const GeneratedComponent = () => {
  const [currentStep, setCurrentStep] = useState(0);
  const goNext = () => setCurrentStep((s) => s + 1);
  const goBack = () => setCurrentStep(currentStep - 1);
  return <div>${body}<Button onClick={goBack}>Back</Button><Button onClick={() => goNext()}>{translate('next')}</Button></div>;
};`;
  assertPass(grade(WIZARD, inline(page('{currentStep === 0 && <A />}'))));
  assertFail(grade(WIZARD, inline(page('<A />'))), /currentStep never chooses what the page renders/);
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

test('eval 4: Next and Back must give the setter the moved value, not merely mention an increment', () => {
  const NEXT = 'onClick={() => setStep((s) => Math.min(3, s + 1))}';
  const BACK = 'onClick={() => setStep((s) => Math.max(1, s - 1))}';
  const HELPER = ['const handleSubmit = async () => {', 'const goTo = (n: number) => setStep(n);\n\n    const handleSubmit = async () => {'];
  assertFail(grade(WIZARD, withPage(E4, 'page.tsx', [NEXT, 'onClick={() => { const next = step + 1; setStep(step); }}'])), /no Next button whose handler advances setStep/);
  assertFail(grade(WIZARD, withPage(E4, 'page.tsx', [BACK, 'onClick={() => { const prev = step - 1; setStep(step); }}'])), /no Back button whose handler moves setStep back/);
  // The moved value may come through a local, or through a helper's parameter.
  assertPass(grade(WIZARD, withPage(E4, 'page.tsx', [NEXT, 'onClick={() => { const next = step + 1; setStep(next); }}'])));
  assertPass(grade(WIZARD, withPage(E4, 'page.tsx', HELPER, [NEXT, 'onClick={() => goTo(step + 1)}'], [BACK, 'onClick={() => goTo(step - 1)}'])));
  assertFail(grade(WIZARD, withPage(E4, 'page.tsx', HELPER, [NEXT, 'onClick={() => goTo(step)}'])), /no Next button/);
});

test('eval 4: every submit is reachable only on the review step', () => {
  assertFail(grade(REVIEW, withPage(E4, 'page.tsx', ['{step < 3 ? (', '{step < 1 ? ('])), /submit button .*not only on the review step/);
  assertFail(grade(REVIEW, withPage(E4, 'page.tsx', ['            <div className={styles.nav}>', '            <Button onClick={handleSubmit}>Submit now</Button>\n            <div className={styles.nav}>'])), /submit button .*not only on the review step/);
  const page = (submit) => inline(`const GeneratedComponent = () => {
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState('');
  return <div>
    {step === 1 && (<Input aria-label="Title" value={title} onChange={(_, d) => setTitle(d.value)} />)}
    {step === 2 && (<Text>{title}</Text>)}
    ${submit}
  </div>;
};`);
  const SUBMIT = "<Button onClick={() => dataApi.createRow('incident', { title })}>Submit</Button>";
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

test('eval 4: an empty label is no label', () => {
  const TITLE = '<Field label="Title">\n                        <Input\n                            aria-label="Title"';
  assertFail(grade(LABELS, withPage(E4, 'page.tsx', [TITLE, '<Field label="">\n                        <Input'])), /<Input> has no aria-label, aria-labelledby or label/);
  assertFail(grade(LABELS, withPage(E4, 'page.tsx', [TITLE, '<Field label={null}>\n                        <Input'])), /<Input> has no aria-label/);
  assertFail(grade(LABELS, withPage(E4, 'page.tsx', [TITLE, "<Field>\n                        <Input\n                            aria-label={''}"])), /<Input> has no aria-label/);
  // A translated or computed label still names the control.
  assertPass(grade(LABELS, withPage(E4, 'page.tsx', [TITLE, "<Field label={translate('title')}>\n                        <Input"])));
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
