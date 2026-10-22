'use strict';

// Layer 2 checks of how a generated page is built, for the per-eval Phase 5 expectations that
// assertions-layer-2.js registers: a wizard's step state and its Next/Back buttons, the review step's
// summary, the labels of form fields, a search box beside a filter toolbar, text that goes through the
// translate helper, and choice values written as the enum names RuntimeTypes.ts declares. Each
// returns a list of problems (empty when the page meets the expectation), or null when the page holds
// nothing the expectation is about; the registrations turn that into pass / fail / skip.
//
// Every check reads structure through lib/tsx-structure.js, so a word in a comment, a string or a
// label never counts as code, and code is never taken for text. What each one does NOT judge is said
// beside it; a person still judges the rest in the Layer 3 rubric.

const { sourceView, jsxElements, jsxTextRuns, declarationSource, matchingClose } = require('./tsx-structure.js');
const { runtimeEnums } = require('./expectation-evidence.js');
const { escapeRe } = require('./source-evidence.js');

const BUTTON_TAGS = /^(?:Button|ToolbarButton|CompoundButton|ToggleButton|MenuButton|SplitButton|button)$/;
// The Fluent UI V9 form controls (and their HTML counterparts) whose value a user enters.
const FORM_CONTROLS = /^(?:Input|Textarea|Dropdown|Combobox|Select|SpinButton|DatePicker|TimePicker|Checkbox|Switch|RadioGroup|Slider|SearchBox|input|textarea|select)$/;
const VALUE_ATTRS = ['value', 'selectedOptions', 'checked', 'selectedKey', 'selectedDate', 'defaultValue'];

const word = (name) => new RegExp(`(?<![.\\w$])${escapeRe(name)}(?![\\w$])`);
const hasLetter = (text) => /\p{L}/u.test(String(text));

// What a button says: its children with tags and expression braces removed, then its aria-label.
// `<Button onClick={…}>Next</Button>` → "Next"; `<Button>{translate('next')}</Button>` → "translate('next')".
function buttonLabel(src, element) {
  const children = src.slice(element.childrenStart, element.childrenEnd).replace(/<[^>]*>/g, ' ');
  const aria = element.attrs.get('aria-label');
  return `${children} ${aria ? aria.value : ''}`.replace(/\s+/g, ' ').trim();
}

// A handler's source followed one level: the attribute's expression, then the declaration of every
// function it calls by name, or of the name it is — `onClick={goNext}` reads `const goNext = () => setStep(…)`
// too. A method (`Math.max(…)`) is not followed.
function handlerSource(content, expression) {
  let out = String(expression || '');
  const code = sourceView(out).code;
  const names = new Set([...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(code);
  if (bare) names.add(bare[1]);
  for (const name of names) {
    const declared = declarationSource(content, name);
    if (declared) out += `\n${declared}`;
  }
  return out;
}

// The step state of a wizard: `const [step, setStep] = useState(…)` (or React.useState), where the
// state's name says it is the step — step, currentStep, activeStep, stepIndex.
function stepStates(content) {
  const { code } = sourceView(content);
  const out = [];
  for (const m of code.matchAll(/\bconst\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*(?:React\s*\.\s*)?useState\b/g)) {
    if (/step/i.test(m[1])) out.push({ value: m[1], setter: m[2] });
  }
  return out;
}

function stepChoosesView(code, step) {
  const name = escapeRe(step);
  return new RegExp(`(?<![.\\w$])${name}\\s*(?:===?|!==?|<=?|>=?)|(?:===?|!==?|<=?|>=?)\\s*${name}(?![\\w$])|\\bswitch\\s*\\(\\s*${name}\\s*\\)|\\[\\s*${name}\\s*\\]`).test(code);
}

// Next/Back buttons that move the step: a button labelled Next (or Continue) whose handler calls the
// step's setter and adds one, and one labelled Back (or Previous) whose handler calls it and subtracts one.
function stepButtons(content, state) {
  const { src } = sourceView(content);
  const found = { next: false, back: false };
  for (const button of jsxElements(content, BUTTON_TAGS)) {
    const label = buttonLabel(src, button);
    const onClick = button.attrs.get('onClick');
    if (!onClick || onClick.kind !== 'expression') continue;
    const handler = sourceView(handlerSource(content, onClick.value)).code;
    if (!word(state.setter).test(handler)) continue;
    if (/\b(?:next|continue)\b/i.test(label) && /\+\s*1\b|\+\+|\+=\s*1\b/.test(handler)) found.next = true;
    if (/\b(?:back|previous|prev)\b/i.test(label) && /-\s*1\b|--|-=\s*1\b/.test(handler)) found.back = true;
  }
  return found;
}

// eval 4: "Generated code includes step state management (current step tracking) and Next/Back navigation".
function wizardNavigationProblems(content) {
  const { code } = sourceView(content);
  const states = stepStates(content);
  if (!states.length) return ['no step state (a useState whose value is the current step, e.g. const [step, setStep] = useState(1))'];
  const problems = [];
  for (const state of states) {
    if (!stepChoosesView(code, state.value)) { problems.push(`${state.value} never chooses what the page renders`); continue; }
    const buttons = stepButtons(content, state);
    if (buttons.next && buttons.back) return [];
    if (!buttons.next) problems.push(`no Next button whose handler advances ${state.setter} by one`);
    if (!buttons.back) problems.push(`no Back button whose handler moves ${state.setter} back by one`);
  }
  return problems;
}

// The JSX shown for each value of the step, as { step, start, end } over the code view:
//   {step === 3 && ( … )}      {step === 3 ? ( … ) : …}      switch (step) { case 3: return ( … ); }
function stepRegions(code, step) {
  const regions = [];
  const name = escapeRe(step);
  for (const m of code.matchAll(new RegExp(`(?<![.\\w$])${name}\\s*===?\\s*(\\d+)\\s*(?:&&|\\?)\\s*\\(`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = matchingClose(code, open);
    if (close > open) regions.push({ step: Number(m[1]), start: open, end: close });
  }
  for (const m of code.matchAll(new RegExp(`\\bswitch\\s*\\(\\s*${name}\\s*\\)\\s*\\{`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = matchingClose(code, open);
    if (close < 0) continue;
    const cases = [...code.slice(open, close).matchAll(/\bcase\s+(\d+)\s*:/g)].map((c) => ({ step: Number(c[1]), start: open + c.index }));
    cases.forEach((c, i) => regions.push({ step: c.step, start: c.start, end: i + 1 < cases.length ? cases[i + 1].start : close }));
  }
  return regions;
}

// The data a form binds: for every form control, the state it shows — `value={form.title}` is the field
// `title` of `form`, `value={title}` the state `title`, `selectedOptions={[String(form.priority)]}` the
// field `priority`. Returned as { label, pattern, at } with a pattern that finds the same data elsewhere
// and the offset of the control that binds it.
function boundFields(content) {
  const fields = new Map();
  for (const control of jsxElements(content, FORM_CONTROLS)) {
    for (const name of VALUE_ATTRS) {
      const attr = control.attrs.get(name);
      if (!attr || attr.kind !== 'expression') continue;
      const code = sourceView(attr.value).code;
      const member = /([A-Za-z_$][\w$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(code);
      const bare = /^\s*!*\s*([A-Za-z_$][\w$]*)\s*$/.exec(code);
      if (member && !fields.has(member[2])) {
        fields.set(member[2], { label: `${member[1]}.${member[2]}`, pattern: new RegExp(`(?<![\\w$])${escapeRe(member[1])}\\s*\\??\\.\\s*${escapeRe(member[2])}(?![\\w$])`), at: control.start });
      } else if (!member && bare && !fields.has(bare[1])) {
        fields.set(bare[1], { label: bare[1], pattern: word(bare[1]), at: control.start });
      }
      break;
    }
  }
  return [...fields.values()];
}

// The nearest `{` around `at` in the code view that is not closed before it.
function enclosingContainer(code, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    if (code[i] === '}') depth += 1;
    else if (code[i] === '{') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

// Whether the element at `at` is rendered from a JSX expression that tests the step: walking out through
// the expression containers around it (`{step < 3 ? … : <Button>Submit</Button>}`) up to the function
// body or block the JSX is returned from (a `{` after `)` or `=>`), one of them names the step.
function renderedForStep(code, at, step) {
  let pos = at;
  for (let open = enclosingContainer(code, pos); open >= 0; open = enclosingContainer(code, pos)) {
    let k = open - 1;
    while (k >= 0 && /\s/.test(code[k])) k -= 1;
    if (code[k] === ')' || (code[k] === '>' && code[k - 1] === '=')) return false;
    if (word(step).test(code.slice(open, at))) return true;
    pos = open;
  }
  return false;
}

// eval 4: "Step 3 (review) shows a summary of entered data before submission". The review step is the
// last step the page renders on its own; it must show every value the earlier steps' form controls
// bind, and the button that submits (labelled Submit/Create/Save/Finish, or whose handler writes with
// createRow/updateRow) must be rendered there, or from an expression that tests the step — so it is
// reached only after the summary. It does not judge how the summary looks.
function reviewSummaryProblems(content) {
  const { src, code } = sourceView(content);
  const [state] = stepStates(content);
  if (!state) return ['no step state, so there is no review step'];
  const regions = stepRegions(code, state.value);
  if (!regions.length) return [`no JSX is rendered for a single value of ${state.value} (e.g. {${state.value} === 3 && (…)})`];
  const review = regions.reduce((last, region) => (region.step > last.step ? region : last));
  const shown = code.slice(review.start, review.end);
  // The fields the EARLIER steps enter: a control on the review step itself (a confirmation box) is not data to summarize.
  const fields = boundFields(content).filter((field) => field.at < review.start || field.at >= review.end);
  if (!fields.length) return ['the form binds no field the review step could summarize'];
  const problems = fields.filter((field) => !field.pattern.test(shown)).map((field) => `the review step (${state.value} === ${review.step}) does not show ${field.label}`);
  const submits = jsxElements(content, BUTTON_TAGS).filter((button) => {
    const onClick = button.attrs.get('onClick');
    const handler = onClick && onClick.kind === 'expression' ? handlerSource(content, onClick.value) : '';
    return /\b(?:submit|create|save|finish)\b/i.test(buttonLabel(src, button)) || /\b(?:createRow|updateRow)\b/.test(handler);
  });
  if (!submits.length) return [...problems, 'no button submits the entered data'];
  const gated = submits.some((button) => (button.start > review.start && button.start < review.end) || renderedForStep(code, button.start, state.value));
  if (!gated) problems.push(`the submit button is rendered on every step, not only after the review (${state.value} === ${review.step})`);
  return problems;
}

// eval 4: "All form fields have aria-labels or aria-labelledby for accessibility". A control is labelled
// by its own aria-label/aria-labelledby, or by what gives it the same accessible name: a Fluent UI
// `<Field label=…>` around it (Field wires its label to the control with aria-labelledby), a `label`
// prop on a Checkbox/Switch/Radio (rendered as its <label>), or an `id` that a `<Label htmlFor>`
// names. A spread (`{...props}`) may carry a label the page does not show, so it is not reported.
// A hidden input (`type="hidden"`) is no field. Returns null when the page has no form control.
function formFieldLabelProblems(content) {
  const controls = jsxElements(content, FORM_CONTROLS).filter((c) => c.attrs.get('type')?.value !== 'hidden');
  if (!controls.length) return null;
  const fields = jsxElements(content, /^Field$/).filter((f) => f.attrs.has('label'));
  const htmlFor = new Set(jsxElements(content, /^(?:Label|label)$/).map((l) => l.attrs.get('htmlFor')?.value).filter((v) => typeof v === 'string' && v));
  const nonEmpty = (attr) => attr && (attr.kind === 'expression' || (attr.kind === 'string' && attr.value.trim()));
  const problems = [];
  for (const control of controls) {
    const { attrs } = control;
    if (nonEmpty(attrs.get('aria-label')) || nonEmpty(attrs.get('aria-labelledby')) || attrs.has('...')) continue;
    if (/^(?:Checkbox|Switch|Radio)$/.test(control.name) && nonEmpty(attrs.get('label'))) continue;
    if (fields.some((field) => control.start >= field.childrenStart && control.start < field.childrenEnd)) continue;
    const id = attrs.get('id');
    if (id && id.kind === 'string' && htmlFor.has(id.value)) continue;
    problems.push(`<${control.name}> has no aria-label, aria-labelledby or label`);
  }
  return problems;
}

// eval 12: "Generated code implements the revised plan (includes BOTH filter toolbar AND search box)".
// A search box is a SearchBox, or an Input of type="search" or one whose placeholder or aria-label says
// search, wired to state by an onChange/onInput handler. A filter toolbar is a Fluent UI Toolbar (or an
// element with role="toolbar") holding at least one control — a Dropdown, Combobox, Select, toggle or
// radio, Checkbox, Switch, MenuButton or TabList — with a handler. Whether the two narrow the same rows
// is not judged.
const FILTER_CONTROLS = /^(?:Dropdown|Combobox|Select|ToggleButton|ToolbarToggleButton|ToolbarRadioButton|ToolbarRadioGroup|Checkbox|Switch|MenuButton|TabList|RadioGroup|select)$/;
const HANDLERS = ['onOptionSelect', 'onChange', 'onClick', 'onCheckedValueChange', 'onTabSelect', 'onSelectionChange', 'onInput'];
function searchAndFilterProblems(content) {
  const searchBoxes = jsxElements(content, /^(?:SearchBox|Input|input)$/).filter((el) => {
    if (el.name !== 'SearchBox') {
      const said = ['type', 'placeholder', 'aria-label'].map((name) => el.attrs.get(name)).filter((a) => a && a.kind === 'string').map((a) => a.value).join(' ');
      if (!/search/i.test(said)) return false;
    }
    return el.attrs.has('onChange') || el.attrs.has('onInput');
  });
  const toolbars = jsxElements(content, /^[A-Za-z][\w.]*$/).filter((el) => el.name === 'Toolbar' || el.attrs.get('role')?.value === 'toolbar');
  const filtering = toolbars.filter((toolbar) => jsxElements(content, FILTER_CONTROLS).some((control) => control.start >= toolbar.childrenStart && control.start < toolbar.childrenEnd
    && HANDLERS.some((name) => control.attrs.has(name))));
  const problems = [];
  if (!searchBoxes.length) problems.push('no search box (a SearchBox, or a search Input) wired to an onChange handler');
  if (!filtering.length) problems.push(toolbars.length ? 'the toolbar holds no filter control with a handler' : 'no filter toolbar (a Toolbar, or role="toolbar") with filter controls');
  return problems;
}

// eval 13: "All user-visible text goes through a translate() helper — no hardcoded display strings in JSX".
// The helper is `translate` (references/localization.md) or its usual short form `t`, declared in the
// page and called. Text is hardcoded when a JSX text run holds a letter (`<Text>Contacts</Text>`), a
// shown attribute is a string with a letter (`placeholder="Search"`, `aria-label={'Contacts'}`), or an
// expression child is only a string (`{'No contacts'}`). Character references are not letters
// (`&nbsp;`), nor are punctuation and digits (`({rows.length})`). NOT read: a string a function returns
// to JSX (`renderHeaderCell: () => 'Name'`) or one inside a longer expression (`{x ? 'Yes' : 'No'}`).
const SHOWN_ATTRIBUTES = new Set(['label', 'placeholder', 'title', 'aria-label', 'aria-description', 'alt', 'header', 'description', 'content', 'hint', 'validationMessage', 'text']);
function translateCoverageProblems(content) {
  const { src, code } = sourceView(content);
  const helper = ['translate', 't'].find((name) => declarationSource(content, name) && new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(code.replace(new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`, 'g'), '')));
  if (!helper) return ['no translate() helper is declared and called'];
  const problems = [];
  for (const run of jsxTextRuns(content)) {
    if (hasLetter(run.text)) problems.push(`hardcoded JSX text "${run.text.trim().slice(0, 40)}"`);
  }
  for (const element of jsxElements(content)) {
    for (const [name, attr] of element.attrs) {
      if (!SHOWN_ATTRIBUTES.has(name)) continue;
      // A string, or an expression that is only a string or a template: `{'Contacts'}`, `{`Step ${n}`}`
      // (the words around an interpolation are text too).
      const literal = attr.kind === 'string' ? attr.value : attr.kind === 'expression' ? /^\s*(['"`])([^]*)\1\s*$/.exec(attr.value)?.[2] : null;
      if (literal && hasLetter(literal.replace(/\$\{[^}]*\}/g, ' '))) problems.push(`hardcoded ${name} "${literal.slice(0, 40)}" on <${element.name}>`);
    }
  }
  for (let i = code.indexOf('{'); i >= 0; i = code.indexOf('{', i + 1)) {
    let k = i - 1;
    while (k >= 0 && /\s/.test(code[k])) k -= 1;
    // A JSX child container follows a tag's `>` or another container's `}` — not an arrow's `=>`.
    if ((code[k] !== '>' && code[k] !== '}') || (code[k] === '>' && code[k - 1] === '=')) continue;
    const close = matchingClose(code, i);
    if (close < 0) continue;
    const inner = /^\s*(['"`])([^]*)\1\s*$/.exec(src.slice(i + 1, close));
    if (inner && /^\s*(['"`])\s*\1\s*$/.test(code.slice(i + 1, close)) && hasLetter(inner[2])) problems.push(`hardcoded JSX string {${inner[1]}${inner[2].slice(0, 40)}${inner[1]}}`);
  }
  return problems;
}

// eval 15: "Generated .tsx uses the choice enum names from RuntimeTypes.ts (not magic numbers)". A choice
// value of a custom column is 100000000 or more (Dataverse's option value floor for a publisher's choices).
// Every such literal in the page's code must be NAMED by the enum member RuntimeTypes.ts declares for it:
//   const PRIORITY_HIGH = 100000002;            the constant's name ends with the member's label (High)
//   { value: 100000002, label: 'High' }         an option row that carries the member's label
// and the value must be that member's. A literal anywhere else (`row.cr_status === 100000002`) is a magic
// number, and a name whose value differs from RuntimeTypes.ts (`HIGH = 100000001`) is a wrong one. Using
// the enum itself (`cr_ticket_cr_priority.High`) needs no literal. Returns null when the page compares
// no choice value at all (nothing to name). Statecode/statuscode values (0, 1, 2…) are not read: below
// the floor a number cannot be told from a count or a size.
const CHOICE_FLOOR = 100000000;
const normalized = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
function choiceEnumProblems(content, runtimeTypes) {
  const { src, code } = sourceView(content);
  const members = [...runtimeEnums(runtimeTypes).enums.values()].flat().filter((m) => m.value >= CHOICE_FLOOR);
  const enumNames = [...runtimeEnums(runtimeTypes).enums.keys()];
  const literals = [...code.matchAll(/(?<![\w$.])(\d{9,})(?![\w$.])/g)].filter((m) => Number(m[1]) >= CHOICE_FLOOR);
  if (!literals.length) return enumNames.some((name) => word(name).test(code)) ? [] : null;
  const problems = [];
  for (const m of literals) {
    const value = Number(m[1]);
    const candidates = members.filter((member) => member.value === value);
    if (!candidates.length) { problems.push(`${value} is not a choice value RuntimeTypes.ts declares`); continue; }
    const before = code.slice(0, m.index);
    const constant = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>[\]|\s]+)?=\s*$/.exec(before) || /(?:^|[,{]\s*)([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before.slice(-200));
    if (constant) {
      const named = members.filter((member) => normalized(constant[1]).endsWith(normalized(member.label)));
      if (!named.length) problems.push(`${constant[1]} = ${value} is not named after a RuntimeTypes.ts choice label`);
      else if (!named.some((member) => member.value === value)) {
        problems.push(`${constant[1]} = ${value}, but RuntimeTypes.ts gives ${named.map((member) => `${member.label} = ${member.value}`).join(', ')}`);
      }
      continue;
    }
    // An option row: the number is a property's value, and the object literal around it carries a label
    // that is the member's (`{ value: 100000002, label: 'High' }`).
    if (/[A-Za-z_$][\w$]*\s*:\s*$/.test(before)) {
      const open = enclosingContainer(code, m.index);
      const close = open >= 0 ? matchingClose(code, open) : -1;
      const row = close > m.index ? src.slice(open, close + 1) : '';
      const labels = [...row.matchAll(/\b(?:label|name|text)\s*:\s*(['"`])([^'"`]*)\1/g)].map((x) => x[2]);
      if (labels.some((label) => candidates.some((member) => normalized(member.label) === normalized(label)))) continue;
    }
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`magic number ${value} on line ${line}: name it after its RuntimeTypes.ts choice label`);
  }
  return problems;
}

module.exports = {
  wizardNavigationProblems, reviewSummaryProblems, formFieldLabelProblems, searchAndFilterProblems,
  translateCoverageProblems, choiceEnumProblems, stepStates, boundFields,
};
