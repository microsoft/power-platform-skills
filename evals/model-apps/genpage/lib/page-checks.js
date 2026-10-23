'use strict';

// Layer 2 checks of how a generated page is built, for the per-eval Phase 5 expectations that
// assertions-layer-2.js registers: the review step of a wizard and its submit, the labels of form fields,
// a search box beside a filter toolbar, text that goes through the translate helper, and choice values
// written as the enum names RuntimeTypes.ts declares. Each returns a list of problems (empty when the page
// meets the expectation), or null when the page holds nothing the expectation is about; the registrations
// turn that into pass / fail / skip.
//
// A wizard's Next/Back navigation is NOT graded here: whether a button moves the step is the value the
// step's setter receives — an updater's return value, a local, a helper's argument — and a scan of the
// handler's text cannot prove it (`setStep((s) => { const next = s + 1; return s; })` mentions the
// increment and never moves). It needs data-flow analysis, so tests/eval-coverage-baseline.json records it
// as unscored instead.
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

// The top-level pieces of `code` between `start` and `end` split at `separator` (a comma or an operator
// such as `&&`), as [start, end) ranges; brackets nest, and strings are already blank in the code view.
function splitTopLevel(code, start, end, separator) {
  const parts = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && code.startsWith(separator, i)) {
      parts.push([from, i]);
      i += separator.length - 1;
      from = i + 1;
    }
  }
  parts.push([from, end]);
  return parts;
}

// The JSX shown for each value of the step, as { step, start, end, kind } over the code view:
//   {step === 3 && ( … )}      {step === 3 ? ( … ) : …}      switch (step) { case 3: return ( … ); }
function stepRegions(code, step) {
  const regions = [];
  const name = escapeRe(step);
  for (const m of code.matchAll(new RegExp(`(?<![.\\w$])${name}\\s*===?\\s*(\\d+)\\s*(?:&&|\\?)\\s*\\(`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = matchingClose(code, open);
    if (close > open) regions.push({ step: Number(m[1]), start: open, end: close, kind: 'branch' });
  }
  for (const m of code.matchAll(new RegExp(`\\bswitch\\s*\\(\\s*${name}\\s*\\)\\s*\\{`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = matchingClose(code, open);
    if (close < 0) continue;
    const cases = [...code.slice(open, close).matchAll(/\bcase\s+(\d+)\s*:/g)].map((c) => ({ step: Number(c[1]), start: open + c.index }));
    cases.forEach((c, i) => regions.push({ step: c.step, start: c.start, end: i + 1 < cases.length ? cases[i + 1].start : close, kind: 'case' }));
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

// --- Which step values render an element -----------------------------------------------------------------
// A condition is read, over the values the step takes, for where its value MAY be truthy and where it MUST be
// (`may`, `must`), and likewise where it may and must be null or undefined (`mayNull`, `mustNull`). Both are
// needed because `??` is not `||`: `a ?? b` falls back to b only where a is nullish, so `false ?? (step !== 3)`
// is false and disables nothing, while `false || (step !== 3)` is the comparison. Comparisons of the step with
// a whole number are exact (a boolean, never nullish); the literals true, false, null, undefined, a number
// and a plain string are what they are; `&&`, `||`, `??` and `!` combine them as JavaScript evaluates them;
// a name declared as a condition (`const isReview = step === 3;`) is read through its declaration. Anything
// else may be truthy or not, and nullish or not, on every value, so it proves nothing.
const COMPARE = { '===': (a, b) => a === b, '==': (a, b) => a === b, '!==': (a, b) => a !== b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };
const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
const setOf = (values) => new Set(values);
const intersect = (a, b) => setOf([...a].filter((v) => b.has(v)));
const minus = (a, b) => setOf([...a].filter((v) => !b.has(v)));
const union = (a, b) => setOf([...a, ...b]);

function trimRange(code, start, end) {
  while (start < end && /\s/.test(code[start])) start += 1;
  while (end > start && /\s/.test(code[end - 1])) end -= 1;
  return [start, end];
}

// How each operator combines what is known of its two sides, a and b (JavaScript's own rules):
//   a || b   a if a is truthy, else b: truthy where either is; nullish only where a is falsy and b nullish
//   a ?? b   a unless a is nullish, else b: truthy where a is, or where a is nullish and b truthy
//   a && b   a if a is falsy, else b: truthy where both are; nullish where a is, or a is truthy and b nullish
const COMBINE = {
  '||': (all, a, b) => ({
    may: union(a.may, b.may), must: union(a.must, b.must),
    mayNull: intersect(minus(all, a.must), b.mayNull), mustNull: intersect(minus(all, a.may), b.mustNull),
  }),
  '??': (all, a, b) => ({
    may: union(a.may, intersect(a.mayNull, b.may)), must: union(a.must, intersect(a.mustNull, b.must)),
    mayNull: intersect(a.mayNull, b.mayNull), mustNull: intersect(a.mustNull, b.mustNull),
  }),
  '&&': (all, a, b) => ({
    may: intersect(a.may, b.may), must: intersect(a.must, b.must),
    mayNull: union(a.mayNull, intersect(a.may, b.mayNull)), mustNull: union(a.mustNull, intersect(a.must, b.mustNull)),
  }),
};

function conditionValues(content, text, state, domain, depth = 0) {
  const all = setOf(domain);
  const none = setOf([]);
  const unknown = { may: all, must: none, mayNull: all, mustNull: none };
  const constant = (truthy, nullish = false) => ({ may: truthy ? all : none, must: truthy ? all : none, mayNull: nullish ? all : none, mustNull: nullish ? all : none });
  const { code } = sourceView(text);
  const [start, end] = trimRange(code, 0, code.length);
  if (start >= end) return unknown;
  if (code[start] === '(' && matchingClose(code, start) === end - 1) return conditionValues(content, text.slice(start + 1, end - 1), state, domain, depth);
  // `||` and `??` cannot be mixed without parentheses, so the first that splits the condition is its loosest operator.
  for (const operator of ['||', '??', '&&']) {
    const parts = splitTopLevel(code, start, end, operator);
    if (parts.length > 1) {
      return parts.map(([s, e]) => conditionValues(content, text.slice(s, e), state, domain, depth))
        .reduce((a, b) => COMBINE[operator](all, a, b));
    }
  }
  const bare = code.slice(start, end);
  if (bare[0] === '!' && bare[1] !== '=') {
    const inner = conditionValues(content, text.slice(start + 1, end), state, domain, depth);
    return { may: minus(all, inner.must), must: minus(all, inner.may), mayNull: none, mustNull: none };
  }
  if (bare === 'true' || bare === 'false') return constant(bare === 'true');
  if (bare === 'null' || bare === 'undefined') return constant(false, true);
  if (/^\d+(?:\.\d+)?$/.test(bare)) return constant(Number(bare) !== 0);
  // A plain string literal, read from the source (the code view blanks its text): '' is falsy, anything else truthy.
  const literal = /^(['"])([^'"\\]*)\1$/.exec(text.slice(start, end));
  if (literal) return constant(literal[2] !== '');
  const name = escapeRe(state.value);
  const forward = new RegExp(`^${name}\\s*(===|!==|==|!=|<=|>=|<|>)\\s*(\\d+)$`).exec(bare);
  const backward = new RegExp(`^(\\d+)\\s*(===|!==|==|!=|<=|>=|<|>)\\s*${name}$`).exec(bare);
  if (forward || backward) {
    const op = forward ? forward[1] : FLIP[backward[2]] || backward[2];
    const n = Number(forward ? forward[2] : backward[1]);
    const holds = setOf(domain.filter((v) => COMPARE[op](v, n)));
    return { may: holds, must: holds, mayNull: none, mustNull: none };
  }
  const alias = /^[A-Za-z_$][\w$]*$/.test(bare) && depth < 2 ? declarationSource(content, bare) : null;
  const value = alias && /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*([\s\S]*?);?\s*$/.exec(alias);
  if (value && !/=>/.test(value[1])) return conditionValues(content, value[1], state, domain, depth + 1);
  return unknown;
}

// The step values for which the branch of an expression `[start, end)` that holds `at` is rendered:
//   cond ? A : B      A on what cond may hold for, B on what it need not hold for
//   a && b && X       X on what every condition may hold for
//   a || X            X on what a need not hold for (a may be falsy)
//   a ?? X            X on what a may be null or undefined for — a comparison never is, so X never shows
// read down to the element (a JSX element or anything else restricts nothing further).
function branchValues(content, code, start, end, at, state, domain) {
  const all = setOf(domain);
  [start, end] = trimRange(code, start, end);
  if (start >= end) return all;
  if (code[start] === '(' && matchingClose(code, start) === end - 1) return branchValues(content, code, start + 1, end - 1, at, state, domain);
  const src = content;
  // The top-level `?` of a conditional (not `?.` or `??`) and its `:`.
  let depth = 0;
  let question = -1;
  for (let i = start; i < end; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && c === '?' && code[i + 1] !== '?' && code[i - 1] !== '?' && !(code[i + 1] === '.' && !/\d/.test(code[i + 2] || ''))) { question = i; break; }
  }
  if (question > 0) {
    let nested = 0;
    let colon = -1;
    depth = 0;
    for (let i = question + 1; i < end; i += 1) {
      const c = code[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (depth === 0 && c === '?' && code[i + 1] !== '?' && code[i - 1] !== '?' && !(code[i + 1] === '.' && !/\d/.test(code[i + 2] || ''))) nested += 1;
      else if (depth === 0 && c === ':') {
        if (nested === 0) { colon = i; break; }
        nested -= 1;
      }
    }
    if (colon > 0) {
      const cond = conditionValues(content, src.slice(start, question), state, domain);
      if (at > question && at < colon) return intersect(cond.may, branchValues(content, code, question + 1, colon, at, state, domain));
      if (at > colon) return intersect(minus(all, cond.must), branchValues(content, code, colon + 1, end, at, state, domain));
      return all;
    }
  }
  for (const operator of ['||', '??']) {
    const parts = splitTopLevel(code, start, end, operator);
    if (parts.length > 1) {
      const holder = parts.findIndex(([s, e]) => at >= s && at < e);
      if (holder < 0) return all;
      const before = parts.slice(0, holder).map(([s, e]) => conditionValues(content, src.slice(s, e), state, domain));
      const reached = before.reduce((acc, c) => intersect(acc, operator === '??' ? c.mayNull : minus(all, c.must)), all);
      return intersect(reached, branchValues(content, code, parts[holder][0], parts[holder][1], at, state, domain));
    }
  }
  const ands = splitTopLevel(code, start, end, '&&');
  if (ands.length > 1) {
    const holder = ands.findIndex(([s, e]) => at >= s && at < e);
    if (holder !== ands.length - 1) return all;
    const conditions = ands.slice(0, -1).map(([s, e]) => conditionValues(content, src.slice(s, e), state, domain));
    const reached = conditions.reduce((acc, c) => intersect(acc, c.may), all);
    return intersect(reached, branchValues(content, code, ands[holder][0], ands[holder][1], at, state, domain));
  }
  return all;
}

// The step values on which the element at `at` is rendered AND can be pressed: the switch case it sits
// in, every JSX expression around it up to the function body the JSX is returned from (a `{` after `)`
// or `=>`), and its own `disabled` (disabled for good, or on the values where the condition must hold).
function reachableSteps(content, code, element, state, domain, regions) {
  let values = setOf(domain);
  const cases = regions.filter((r) => r.kind === 'case' && r.start <= element.start && element.start < r.end);
  if (cases.length) values = intersect(values, setOf(cases.map((r) => r.step)));
  let pos = element.start;
  for (let open = enclosingContainer(code, pos); open >= 0; open = enclosingContainer(code, pos)) {
    let k = open - 1;
    while (k >= 0 && /\s/.test(code[k])) k -= 1;
    if (code[k] === ')' || (code[k] === '>' && code[k - 1] === '=')) break;
    const close = matchingClose(code, open);
    if (close > open) values = intersect(values, branchValues(content, code, open + 1, close, element.start, state, domain));
    pos = open;
  }
  const disabled = element.attrs.get('disabled');
  if (disabled?.kind === 'flag' || (disabled?.kind === 'string' && disabled.value !== 'false')) return setOf([]);
  if (disabled?.kind === 'expression') values = minus(values, conditionValues(content, disabled.value, state, domain).must);
  return values;
}

// The values the step takes: each value the page renders on its own, and the step state's initial value.
function stepDomain(code, state, regions) {
  const values = setOf(regions.map((r) => r.step));
  const init = new RegExp(`\\[\\s*${escapeRe(state.value)}\\s*,\\s*${escapeRe(state.setter)}\\s*\\]\\s*=\\s*(?:React\\s*\\.\\s*)?useState(?:<[^>()]*>)?\\s*\\(\\s*(\\d+)\\s*\\)`).exec(code);
  if (init) values.add(Number(init[1]));
  return [...values].sort((a, b) => a - b);
}

// eval 4: "Step 3 (review) shows a summary of entered data before submission". The review step is the
// last step the page renders on its own; it must show every value the earlier steps' form controls
// bind, and EVERY button that submits (labelled Submit/Create/Save/Finish, or whose handler writes with
// createRow/updateRow) must be reachable only on the review step: rendered and enabled for no other value
// of the step (reachableSteps), so the summary is always seen first. A second, unconditional submit, or a
// boundary that lets the submit show on an earlier step (`step < 1 ? Next : Submit`), fails it. A condition
// the reader cannot tie to the step (`ready ? Submit : null`) proves nothing and fails it too. It does not
// judge how the summary looks.
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
  const domain = stepDomain(code, state, regions);
  for (const button of submits) {
    const reached = [...reachableSteps(content, code, button, state, domain, regions)];
    if (reached.some((value) => value !== review.step)) {
      problems.push(`the submit button "${buttonLabel(src, button)}" can be pressed when ${state.value} is ${reached.filter((v) => v !== review.step).join(' or ')}, not only on the review step (${state.value} === ${review.step})`);
    }
  }
  if (!submits.some((button) => reachableSteps(content, code, button, state, domain, regions).has(review.step))) {
    problems.push(`no submit button can be pressed on the review step (${state.value} === ${review.step})`);
  }
  return problems;
}

// eval 4: "All form fields have aria-labels or aria-labelledby for accessibility". A control is labelled
// by its own aria-label/aria-labelledby, or by what gives it the same accessible name: a Fluent UI
// `<Field label=…>` around it (Field wires its label to the control with aria-labelledby), a `label`
// prop on a Checkbox/Switch/Radio (rendered as its <label>), or an `id` that a `<label htmlFor>` (or
// Fluent `<Label htmlFor>`) that can show some text names. A label only counts when it can name something:
// an empty string, `{''}`, `{null}`, `{undefined}` or `{false}` is no label, whereas a computed one
// (`label={translate('title')}`) is; the same goes for the children of a label element (childrenShowText).
// A spread (`{...props}`) may carry a label the page does not show, so it is not reported. A hidden input
// (`type="hidden"`) is no field. Returns null when the page has no form control.
const STATIC_EMPTY = /^\s*(?:(['"`])\s*\1|null|undefined|false)\s*$/;
const names = (attr) => Boolean(attr) && ((attr.kind === 'string' && attr.value.trim() !== '')
  || (attr.kind === 'expression' && attr.value.trim() !== '' && !STATIC_EMPTY.test(attr.value)));

// Whether an element's children can show any text: a run of JSX text that is not blank, or an expression
// container that is not statically empty, at any depth of the markup inside it. `{null}`, `{''}`,
// `{undefined}`, `{false}` and a container holding only a comment (`{/* … */}`, blank in the code view)
// show nothing, and the tags and attributes of nested elements are no text:
//   <label htmlFor="t">Title</label>                  shows text
//   <label htmlFor="t">{translate('title')}</label>   may show text (a computed value is not judged)
//   <label htmlFor="t"><span>{null}</span></label>    shows nothing
function childrenShowText(content, element) {
  const { src, code } = sourceView(content);
  const from = element.childrenStart;
  const to = element.childrenEnd;
  if (jsxTextRuns(content).some((run) => run.start >= from && run.end <= to && run.text.trim() !== '')) return true;
  const nested = jsxElements(content).filter((e) => e.start >= from && e.start < to);
  const inTag = (i) => nested.some((e) => (i >= e.start && i < e.openEnd) || (!e.selfClosing && i >= e.childrenEnd && i < e.end));
  for (let i = from; i < to; i += 1) {
    if (code[i] !== '{' || inTag(i)) continue;
    const close = matchingClose(code, i);
    if (close < 0 || close > to) return true;
    if (code.slice(i + 1, close).trim() !== '' && !STATIC_EMPTY.test(src.slice(i + 1, close))) return true;
    i = close;
  }
  return false;
}

function formFieldLabelProblems(content) {
  const controls = jsxElements(content, FORM_CONTROLS).filter((c) => c.attrs.get('type')?.value !== 'hidden');
  if (!controls.length) return null;
  const fields = jsxElements(content, /^Field$/).filter((f) => names(f.attrs.get('label')));
  const htmlFor = new Set(jsxElements(content, /^(?:Label|label)$/)
    .filter((l) => childrenShowText(content, l))
    .map((l) => l.attrs.get('htmlFor')?.value).filter((v) => typeof v === 'string' && v));
  const problems = [];
  for (const control of controls) {
    const { attrs } = control;
    if (names(attrs.get('aria-label')) || names(attrs.get('aria-labelledby')) || attrs.has('...')) continue;
    if (/^(?:Checkbox|Switch|Radio)$/.test(control.name) && names(attrs.get('label'))) continue;
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
// shown attribute is a string with a letter (`placeholder="Search"`), or a JSX expression — a child
// `{…}` or a shown attribute's value — can RESULT in a string or template with a letter
// (displayedLiterals): `{'No contacts'}`, `{rows.length ? 'Contacts' : t('empty')}`, `{error || 'Failed'}`,
// `{`${n} contacts`}`. A string passed to a call (`t('empty')`) is a key, not a result. Character
// references are not letters (`&nbsp;`), nor are punctuation and digits (`({rows.length})`, `{`${n}`}`).
// NOT read: a string a function returns to JSX (`renderHeaderCell: () => 'Name'`) or a variable holding one.
const SHOWN_ATTRIBUTES = new Set(['label', 'placeholder', 'title', 'aria-label', 'aria-description', 'alt', 'header', 'description', 'content', 'hint', 'validationMessage', 'text']);

// The string and template literals an expression can evaluate to, as { quote, text }: the expression
// itself, both sides of a conditional, the right side of `&&`, and every side of `||` and `??`, through
// parentheses. Anything else — a call, a name, a member, a JSX element — results in no literal.
function displayedLiterals(text) {
  const { code } = sourceView(text);
  const out = [];
  const visit = (from, to) => {
    let [start, end] = trimRange(code, from, to);
    if (start >= end) return;
    if (code[start] === '(' && matchingClose(code, start) === end - 1) { visit(start + 1, end - 1); return; }
    let depth = 0;
    for (let i = start; i < end; i += 1) {
      const c = code[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (depth === 0 && c === '?' && code[i + 1] !== '?' && code[i - 1] !== '?' && !(code[i + 1] === '.' && !/\d/.test(code[i + 2] || ''))) {
        let nested = 0;
        let inner = 0;
        for (let j = i + 1; j < end; j += 1) {
          const d = code[j];
          if (d === '(' || d === '[' || d === '{') inner += 1;
          else if (d === ')' || d === ']' || d === '}') inner -= 1;
          else if (inner === 0 && d === '?' && code[j + 1] !== '?' && code[j - 1] !== '?' && !(code[j + 1] === '.' && !/\d/.test(code[j + 2] || ''))) nested += 1;
          else if (inner === 0 && d === ':') {
            if (nested === 0) { visit(i + 1, j); visit(j + 1, end); return; }
            nested -= 1;
          }
        }
        return;
      }
    }
    for (const operator of ['||', '??']) {
      const parts = splitTopLevel(code, start, end, operator);
      if (parts.length > 1) { for (const [s, e] of parts) visit(s, e); return; }
    }
    const ands = splitTopLevel(code, start, end, '&&');
    if (ands.length > 1) { visit(...ands.at(-1)); return; }
    const quote = code[start];
    if (/['"`]/.test(quote) && code[end - 1] === quote && !code.slice(start + 1, end - 1).trim()) out.push({ quote, text: text.slice(start + 1, end - 1) });
  };
  visit(0, text.length);
  return out;
}

// Letters a literal shows: a template's `${…}` parts are values, not text.
const shownLetters = ({ quote, text }) => hasLetter(quote === '`' ? text.replace(/\$\{[^}]*\}/g, ' ') : text);

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
      const literals = attr.kind === 'string' ? [{ quote: '"', text: attr.value }] : attr.kind === 'expression' ? displayedLiterals(attr.value) : [];
      for (const literal of literals.filter(shownLetters)) problems.push(`hardcoded ${name} ${literal.quote}${literal.text.slice(0, 40)}${literal.quote} on <${element.name}>`);
    }
  }
  for (let i = code.indexOf('{'); i >= 0; i = code.indexOf('{', i + 1)) {
    let k = i - 1;
    while (k >= 0 && /\s/.test(code[k])) k -= 1;
    // A JSX child container follows a tag's `>` or another container's `}` — not an arrow's `=>`.
    if ((code[k] !== '>' && code[k] !== '}') || (code[k] === '>' && code[k - 1] === '=')) continue;
    const close = matchingClose(code, i);
    if (close < 0) continue;
    for (const literal of displayedLiterals(src.slice(i + 1, close)).filter(shownLetters)) {
      problems.push(`hardcoded JSX string ${literal.quote}${literal.text.slice(0, 40)}${literal.quote}`);
    }
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
  reviewSummaryProblems, formFieldLabelProblems, searchAndFilterProblems,
  translateCoverageProblems, choiceEnumProblems, stepStates, boundFields,
};
