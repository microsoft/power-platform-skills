'use strict';
// Does a generated page establish its own scroll context? (AB#6793599)
//
// The generative-page host renders a page inside a container of fixed height and does not scroll it. A page in which no element both has a
// bounded height and scrolls (`overflowY: "auto"`) therefore shows only what fits: everything below the fold is cut off, with no scrollbar,
// silently — the page type-checks, transpiles, deploys and looks fine until it holds more rows than the window. Two independently generated
// dashboards shipped that way. The rule that said otherwise lived only in the dark-mode section of references/rules.md, so a page without
// theming read it as not applying, and nothing checked it. check-griffel-styles.js runs this check on every page the flows check for Griffel
// shorthands (one command, so no flow can skip one of the two).
//
// The model, for the element tree the page's default export returns (top element first):
//   bounded(E)  E's height cannot grow with its content: a definite `height` or `maxHeight` (a percentage, a length or a calc() without a
//               viewport unit), OR E grows (`flex: 1`, `flexGrow` > 0) inside a bounded flex column AND its automatic minimum is removed
//               (`minHeight: 0`, or E is a scroll container: CSS computes `min-height: auto` to 0 for one).
//               https://www.w3.org/TR/css-flexbox-1/#min-size-auto
//   scrolls(E)  bounded(E), and E's computed `overflow-y` is auto, scroll or overlay. A `visible` overflow-y computes to `auto` when
//               overflow-x is anything but visible or clip, so `overflowX: "auto"` alone makes a box scroll both ways.
//               https://www.w3.org/TR/css-overflow-3/#overflow-properties
//   provides(E) scrolls(E), OR bounded(E) and one of E's children provides.
// A page passes when the top element of every return judged provides. That one recursion accepts the three shapes a page uses: a root that
// scrolls; a bounded outer wrapper whose inner root scrolls (the dark-mode two-div wrapper); a bounded root that does not scroll, with a fixed
// header and a flex body (`flex: 1`, `minHeight: 0`, `overflowY: "auto"`) or a `maxHeight` region that scrolls. A scroll region inside an
// element that is NOT bounded does not count: the unbounded element grows past the host's container, and the rest of the page is clipped.
//
// A page that passes can still lose its end: a box on the path to the scroll that fills its container (`height: "100%"`) and has vertical
// padding is, in the default content-box model, taller than the container by that padding, and the host clips the overhang — measured on the
// host, the last 16px of a page with 16px padding stayed below the visible area at both window sizes, while the same page with
// `boxSizing: "border-box"` showed its end. That is `scroll-context-padding`, for every such box on the path (the scrolling root, the wrapper
// around it, and a bounded root around a scrolling body, whose padding pushes the body's end down the same way).
//
// Error directions. A false accept ships the clipped page this check exists for. A false reject costs the agent that is generating the page
// one edit — the remedy every message gives (`height: "100%"`, `overflowY: "auto"`, `boxSizing: "border-box"` on the top element), which is
// safe on every layout (a root whose content already fits shows no scrollbar) and which this check always accepts (page-scroll.test.js
// pins that invariant, for every shape it rejects). So what the check cannot read is never a pass: it is `scroll-context-unproven`, with
// the reason and the remedy, as griffel-styles.js reports a style object it cannot see. A page the plugin did not generate in this run (a
// downloaded page an edit touches) is a different case — refusing a maker's small edit over a defect they did not make would be a regression —
// and the CLI turns the result into a note there (`--existing`).
//
// What it does not see (known limits, plugin AGENTS.md "Page scroll context"): `@media` and selector blocks (only base keys are read, so a
// media query that removes the scroll at one width is missed); whether the bounded boxes' heights add up (a `height: 100%` child under a
// header overflows its parent by the header's height); grid tracks (a grid item is never taken as bounded); and what a library component
// (Fluent) does inside itself — its `className`/`style` are read, as Fluent v9 applies them to the component's root slot, but its children are
// content that never provides the scroll context.
//
// It reads the page with the TypeScript parser the plugin vendors (lib/typescript-compiler.js), not with the source-literals lexer: it needs
// the JSX tree and has to follow one component into another (`GeneratedComponent → PageErrorBoundary → PageBody`), which a lexer cannot.
// Loading the parser costs ~0.2 s, once per command, and only for a file that has a default export.

const { isStackOverflow } = require('./page-nesting.js');

const REMEDY_KEYS = 'height: "100%", overflowY: "auto", boxSizing: "border-box"';
const RULE_REFERENCE = 'references/rules.md, "Page Layout"';

// The keys the decision reads. Anything else in a style object (colours, padding, gap, …) cannot change it.
const DECISIVE = new Set(['height', 'maxHeight', 'minHeight', 'display', 'flexDirection', 'flex', 'flexGrow', 'overflow', 'overflowX', 'overflowY']);
// The keys that decide whether a box that fills its container overhangs it: vertical padding in the default content-box model is added to
// the height, so `height: "100%"` plus 16px of padding is 32px taller than the container (measured on the host: the last 16px of the page
// stay below the visible area). `boxSizing: "border-box"` puts the padding inside the height.
// https://www.w3.org/TR/css-sizing-3/#box-sizing
const PADDING_KEYS = ['padding', 'paddingTop', 'paddingBottom', 'paddingBlock', 'paddingBlockStart', 'paddingBlockEnd'];
const READ_KEYS = new Set([...DECISIVE, 'boxSizing', ...PADDING_KEYS]);
// Keys a page's remedy overwrites on the class it changes; a second class that sets one of these could still win over it.
const OVERFLOW_KEYS = ['overflow', 'overflowX', 'overflowY'];

// Components that render their children and no box of their own.
const TRANSPARENT = /^(?:(?:React\.)?(?:Fragment|StrictMode|Suspense)|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:Provider|Consumer))$/;

// The library components a loading, empty or error state is made of (Fluent UI v9) — a spinner, a progress bar, a skeleton, a message bar,
// or a line of text (`<Text>No accounts found.</Text>`): an alternative that renders only these is a state view,
// and is not judged beside one that scrolls. Inside one only text, values, these parts and inline tags may appear — a `MessageBar` with a
// `MessageBarBody` and an action `Button` is a state view; a `Spinner` beside a `<div>` of rows, or a `Card` / `DataGrid` / imported
// component of any kind, is content and is judged. Matched on the last segment of the tag, so `Fluent.Spinner` counts.
//   loading ? <Spinner label="Loading" /> : <div scrolls/>                      → the Spinner is a state view
//   error ? <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar> : <div scrolls/>  → a state view
//   mode ? <div scrolls/> : <Card>{rows}</Card>                                 → judged (a Card may hold the page's content)
const STATE_VIEWS = /^(?:Spinner|ProgressBar|Skeleton|MessageBar|Text|Caption[12](?:Strong(?:er)?)?|Body[12](?:Strong(?:er)?)?|Subtitle[12]|Title[123]|Label)$/;
const STATE_VIEW_PARTS = /^(?:SkeletonItem|MessageBarBody|MessageBarTitle|MessageBarActions|Button|Link|Text)$/;
const STATE_VIEW_INLINE = /^(?:span|strong|b|em|i|code|br|a)$/;

// What each `reason` of a scroll-context-unproven problem means, for its message.
const REASONS = {
  'string-class': 'the class is a string or a template (a global CSS class, or class names joined into one string), whose styles the check cannot read',
  'computed-class': 'the class is computed by code the check cannot follow',
  'unknown-slot': 'the class names a slot its makeStyles call does not have',
  'unread-styles': 'the makeStyles call or slot is not an object written in place',
  'style-expression': 'the inline style is not an object written in place',
  'spread-attributes': 'a spread of attributes after className or style may replace them',
  'unread-value': 'a height, overflow or flex key is set to a value the check cannot read (a variable, a token or a call)',
  'unread-spread': 'a spread of an object not written in place may set a height, overflow or flex key',
  'computed-key': 'a computed key may set a height, overflow or flex key',
  'conditional-class': 'a class applied under a condition sets a height, overflow or flex key',
  'conditional-spread': 'a spread chosen by a condition sets a height, overflow or flex key',
  'conflicting-keys': 'its classes set both a shorthand and its longhand (`overflow` and `overflowY`, or `flex` and `flexGrow`) to different effect',
  'unresolved-children': 'part of its content is computed by code the check cannot follow (a variable or a call)',
  'unresolved-return': 'the page returns something the check cannot follow (a variable or a call)',
  'unresolved-component': 'the page returns a component that is not written in this file',
  'library-top': 'the page\'s top element is a library component, whose own layout the check cannot see',
  'fragment-top': 'the page returns several elements side by side, which the host lays out in a way the check cannot see',
  portal: 'the page returns a portal',
  recursive: 'the page\'s components render each other in a cycle',
  'children-top': 'the page returns `children` it is never given',
  'partial-alternatives': 'a condition renders content that establishes a scroll context in one alternative and content that does not in another, and each alternative is shown alone',
  'min-height': 'a minHeight may be larger than the height that bounds the element, and a minimum wins over a height',
};

/**
 * The scroll-context problems of one page.
 * @param {string} source - the page's TSX
 * @param {{ ts?: object }} [options] - `ts`: a TypeScript compiler to use instead of the vendored one (tests)
 * @returns {object[]} each `{ code, line, column, element, reason?, fix, message }` — code `no-scroll-context`, `scroll-context-unproven`
 *   (with `reason`) or `scroll-context-padding`; `fix` is `{ kind: 'class', hook, slot }`, `{ kind: 'style' }` or `{ kind: 'wrap', line,
 *   column }`. Empty when the page provides a scroll context or is not
 *   judged — no default export (a fragment, not a page), a parse error (the compile gate reports it), or a page that renders nothing
 */
function pageScrollProblems(source, options) {
  return analyzePageScroll(source, options).problems;
}

/**
 * The scroll-context verdict of one page, with what it was based on.
 * @returns {{ judged: boolean, why?: string, problems: object[], verdicts: { line: number, column: number, element: string, verdict: string, reason?: string }[] }}
 * @throws when the page has a default export and the vendored TypeScript compiler cannot be loaded (`code: 'scroll-compiler-unavailable'`)
 */
function analyzePageScroll(source, { ts = null } = {}) {
  const text = String(source == null ? '' : source);
  // Cheap gate before the parser is loaded: a file with no default export is a fragment, not a page (the Griffel tests check fragments, and so
  // may a flow), and its result must stay what it was before this check existed. `export { Page as default }` is the other way to write one.
  if (!/\bexport\s+default\b|\bas\s+default\b/.test(text)) return notJudged('no default export');
  let compiler = ts;
  if (!compiler) {
    try {
      compiler = require('./typescript-compiler.js').loadVendoredTypeScript();
    } catch (e) {
      // A compiler that is missing, or fails its provenance check, must not read as "this page is fine": the check did not run. It throws, and
      // the CLI turns that into a visible `scroll-check-failed` note (check-griffel-styles.js), leaving the Griffel result as it is. Returning
      // "not judged" here instead made a page with no scroll context exit 0 with nothing said.
      const error = new Error(`the vendored TypeScript compiler could not be loaded: ${(e && e.message) || e}`);
      error.code = 'scroll-compiler-unavailable';
      throw error;
    }
  }
  try {
    return new PageReader(compiler, text).analyze();
  } catch (error) {
    // A page nested deeper than the parser's stack is refused by the compile, with its own message (page-nesting.js); this check adds nothing.
    if (isStackOverflow(error)) return notJudged('nested too deeply');
    throw error;
  }
}

function notJudged(why) {
  return { judged: false, why, problems: [], verdicts: [] };
}

// Three-valued logic: true, false, or unknown ({ v: null, reason, node }). An unknown carries the first thing that made it so, for the message.
const TRUE = { v: true };
const FALSE = { v: false };
const unknownOf = (reason, node) => ({ v: null, reason, node });
function or(...xs) {
  if (xs.some((x) => x.v === true)) return TRUE;
  return xs.find((x) => x.v === null) || FALSE;
}
function and(...xs) {
  if (xs.some((x) => x.v === false)) return FALSE;
  return xs.find((x) => x.v === null) || TRUE;
}

// A value read from a style object: known (`{ known: true, value }`) or not (`{ known: false, reason, node }`).
const known = (value) => ({ known: true, value });
const unread = (reason, node) => ({ known: false, reason, node });

class PageReader {
  constructor(ts, text) {
    this.ts = ts;
    this.sf = ts.createSourceFile('page.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    this.components = new Map();
    this.hooks = new Map();
    this.imported = new Set();
    this.makeStylesNames = new Set(['makeStyles']);
    this.mergeClassesNames = new Set(['mergeClasses']);
    this.shorthandsNames = new Set(['shorthands']);
    this.typographyNames = new Set(['typographyStyles']);
    this.namespaces = new Set();
    this.bindingsCache = new Map();
  }

  analyze() {
    const { ts, sf } = this;
    if (sf.parseDiagnostics.length > 0) return notJudged('parse error');
    const exported = this.collect();
    if (!exported) return notJudged('no default export');
    const tops = exported.kind === 'component'
      ? this.componentCandidates(exported.node, null, [])
      : [{ kind: 'unresolved', reason: 'unresolved-component', node: exported.node }];
    if (!tops.length) return notJudged('renders nothing');
    const problems = [];
    const verdicts = [];
    const seen = new Set();
    const paddedAt = new Set();
    for (const top of tops) {
      const at = top.node.getStart(sf);
      if (seen.has(at)) continue;
      seen.add(at);
      let result = top.kind === 'unresolved' ? unknownOf(top.reason, top.node) : this.provides(top, null, []);
      // A library component at the top that does not itself scroll: its children sit in slots whose layout the check cannot see.
      if (top.kind === 'library' && result.v === false) result = unknownOf('library-top', top.node);
      const place = this.place(top.node);
      const element = this.elementName(top);
      verdicts.push({ ...place, element, verdict: result.v === true ? 'pass' : result.v === false ? 'fail' : 'unproven', ...(result.v === null ? { reason: result.reason } : {}) });
      if (result.v === true) {
        for (const { box, parent } of result.path) {
          const at = box.node.getStart(sf);
          const over = paddedAt.has(at) ? null : this.overhangs(box, parent);
          if (!over) continue;
          paddedAt.add(at);
          const where = this.place(box.node);
          const name = this.elementName(box);
          const fix = this.fixFor(box, 'padding');
          problems.push({ code: 'scroll-context-padding', ...where, element: name, fix, message: paddingMessage(name, where, fix, over) });
        }
        continue;
      }
      const fix = this.fixFor(top, 'scroll');
      problems.push(result.v === false
        ? { code: 'no-scroll-context', ...place, element, fix, message: failMessage(element, place, fix) }
        : { code: 'scroll-context-unproven', ...place, element, reason: result.reason, fix, message: unprovenMessage(element, place, result, this.place(result.node || top.node), fix) });
    }
    return { judged: true, problems, verdicts };
  }

  // ─── The page's top-level declarations ─────────────────────────────────────────────────────────────────────────────────────────────────

  collect() {
    const { ts, sf } = this;
    // The default export is resolved AFTER every declaration is read: a function declaration is hoisted, so `export default Page;` may come
    // before `function Page() {…}`, and resolving it where it is written found no component and called the page unresolved.
    let exported = null;
    const aliases = new Map();
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st)) this.readImport(st);
    }
    for (const st of sf.statements) {
      const isDefault = !!(ts.canHaveModifiers(st) && ts.getModifiers(st) || []).find((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) {
        if (st.name) this.components.set(st.name.text, st);
        if (isDefault) exported = () => ({ kind: 'component', node: st });
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          const init = strip(ts, d.initializer);
          if (this.isMakeStylesCall(init)) this.hooks.set(d.name.text, this.readHook(init));
          const component = this.unwrapComponent(init);
          if (component && component.node) this.components.set(d.name.text, component.node);
          else if (component && component.alias) aliases.set(d.name.text, component.alias);
          else if (ts.isIdentifier(init)) aliases.set(d.name.text, init.text);
        }
      } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
        exported = () => this.exportedFrom(strip(ts, st.expression), aliases);
      } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          if (el.name.text === 'default') exported = () => this.exportedFrom((el.propertyName || el.name), aliases);
        }
      }
    }
    for (const [name, target] of aliases) if (!this.components.has(name) && this.components.has(target)) this.components.set(name, this.components.get(target));
    return exported ? exported() : null;
  }

  readImport(st) {
    const { ts } = this;
    const clause = st.importClause;
    if (!clause) return;
    const from = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : '';
    const styling = /^@fluentui\/react-components$|^@griffel\/(?:react|core)$/.test(from);
    if (clause.name) this.imported.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      this.imported.add(bindings.name.text);
      if (styling) this.namespaces.add(bindings.name.text);
    } else if (bindings) {
      for (const el of bindings.elements) {
        this.imported.add(el.name.text);
        if (!styling) continue;
        const original = (el.propertyName || el.name).text;
        if (original === 'makeStyles') this.makeStylesNames.add(el.name.text);
        if (original === 'mergeClasses') this.mergeClassesNames.add(el.name.text);
        if (original === 'shorthands') this.shorthandsNames.add(el.name.text);
        if (original === 'typographyStyles') this.typographyNames.add(el.name.text);
      }
    }
  }

  // `makeStyles(…)`, an alias of it, or `Fluent.makeStyles(…)` through a namespace import of a styling module.
  isCallTo(node, names, member) {
    const { ts } = this;
    if (!ts.isCallExpression(node)) return false;
    const callee = strip(ts, node.expression);
    if (ts.isIdentifier(callee)) return names.has(callee.text);
    return ts.isPropertyAccessExpression(callee) && callee.name.text === member && ts.isIdentifier(callee.expression) && this.namespaces.has(callee.expression.text);
  }

  isMakeStylesCall(node) {
    return this.isCallTo(node, this.makeStylesNames, 'makeStyles');
  }

  // A component as written: a function, an arrow, a class, or one wrapped in `memo`/`forwardRef` (unwrapped one level).
  unwrapComponent(node) {
    const { ts } = this;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) return { node };
    if (ts.isCallExpression(node) && /^(?:React\.)?(?:memo|forwardRef)$/.test(node.expression.getText(this.sf)) && node.arguments.length) {
      const inner = strip(ts, node.arguments[0]);
      if (ts.isIdentifier(inner)) return { alias: inner.text };
      return this.unwrapComponent(inner);
    }
    return null;
  }

  exportedFrom(node, aliases) {
    const { ts } = this;
    if (ts.isIdentifier(node)) {
      let name = node.text;
      for (let hops = 0; aliases.has(name) && hops < 8; hops += 1) name = aliases.get(name);
      return this.components.has(name) ? { kind: 'component', node: this.components.get(name) } : { kind: 'unresolved', node };
    }
    const component = this.unwrapComponent(node);
    if (component && component.node) return { kind: 'component', node: component.node };
    if (component && component.alias && this.components.has(component.alias)) return { kind: 'component', node: this.components.get(component.alias) };
    return { kind: 'unresolved', node };
  }

  // ─── makeStyles ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  // The slots of one `makeStyles({ … })` call: slot → facts. A call given anything but an object written in place is unread as a whole.
  readHook(call) {
    const { ts } = this;
    const arg = call.arguments[0] && strip(ts, call.arguments[0]);
    const hook = { slots: new Map(), rest: null };
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      hook.rest = unread('unread-styles', call);
      return hook;
    }
    for (const p of arg.properties) {
      if (ts.isSpreadAssignment(p)) {
        // Slots a spread brings in are unknown; slots written after it are read as written.
        hook.slots.clear();
        hook.rest = unread('unread-styles', p);
        continue;
      }
      const name = p.name && propertyName(ts, p.name);
      if (name == null) {
        hook.slots.clear();
        hook.rest = unread('unread-styles', p);
        continue;
      }
      const value = ts.isPropertyAssignment(p) ? strip(ts, p.initializer) : null;
      hook.slots.set(name, value && ts.isObjectLiteralExpression(value) ? this.readStyleObject(value) : { keys: new Map(), rest: unread('unread-styles', p) });
    }
    return hook;
  }

  // The decisive keys of one style object, as JavaScript resolves them: a key's last definition wins. `rest` is set when something the
  // check cannot read (a spread, a computed key) may have set any key not written after it.
  //   { height: '100%', ...shorthands.overflow('hidden', 'auto'), ':hover': { … } }
  //   → height "100%", overflowX "hidden", overflowY "auto"; the selector block is not read (base keys only).
  readStyleObject(obj) {
    const { ts } = this;
    const facts = { keys: new Map(), rest: null };
    let order = 0;
    const set = (key, value) => facts.keys.set(key, { value, order: order++ });
    const unreadAll = (reason, node) => {
      facts.keys.clear();
      facts.rest = unread(reason, node);
    };
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        this.readSpread(strip(ts, p.expression), set, unreadAll);
        continue;
      }
      const name = p.name ? propertyName(ts, p.name) : null;
      if (name == null) {
        unreadAll('computed-key', p);
        continue;
      }
      if (!READ_KEYS.has(name)) continue;
      if (ts.isPropertyAssignment(p)) set(name, readValue(ts, p.initializer));
      else set(name, unread('unread-value', p));
    }
    return facts;
  }

  readSpread(e, set, unreadAll) {
    const { ts } = this;
    if (ts.isObjectLiteralExpression(e)) {
      const inner = this.readStyleObject(e);
      if (inner.rest) unreadAll(inner.rest.reason, inner.rest.node);
      for (const [k, v] of [...inner.keys].sort((a, b) => a[1].order - b[1].order)) set(k, v.value);
      return;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
      const owner = e.expression.expression.text;
      const helper = e.expression.name.text;
      if (this.shorthandsNames.has(owner)) {
        if (e.arguments.some((a) => ts.isSpreadElement(a))) return unreadAll('unread-spread', e);
        // Griffel's shorthands.overflow(overflowX, overflowY = overflowX), shorthands.flex(grow | 'auto' | 'none' | …, shrink?, basis?) and
        // the padding helpers write longhands; every other helper writes keys this check does not read (borders, margins, gaps, inset, …).
        if (helper === 'overflow') {
          const x = e.arguments[0] ? readValue(ts, e.arguments[0]) : unread('unread-value', e);
          set('overflowX', x);
          set('overflowY', e.arguments[1] ? readValue(ts, e.arguments[1]) : x);
        } else if (helper === 'flex') {
          set('flexGrow', e.arguments[0] ? flexGrowOfShorthand(readValue(ts, e.arguments[0])) : unread('unread-value', e));
        } else if (helper === 'padding' || helper === 'paddingBlock') {
          // shorthands.padding(all) / (vertical, horizontal) / (top, horizontal, bottom) / (top, right, bottom, left), and
          // shorthands.paddingBlock(start, end = start): only the vertical sides are kept.
          const a = e.arguments.map((x) => readValue(ts, x));
          if (!a.length) return;
          set(helper === 'padding' ? 'paddingTop' : 'paddingBlockStart', a[0]);
          set(helper === 'padding' ? 'paddingBottom' : 'paddingBlockEnd', helper === 'padding' && a.length >= 3 ? a[2] : helper === 'paddingBlock' && a.length >= 2 ? a[1] : a[0]);
        }
        return;
      }
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && this.typographyNames.has(e.expression.text)) return; // font longhands only
    if (ts.isConditionalExpression(e) || (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind))) {
      const arms = ts.isConditionalExpression(e) ? [e.whenTrue, e.whenFalse] : e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? [e.right] : [e.left, e.right];
      for (const arm of arms.map((a) => strip(ts, a))) {
        if (isNothing(ts, arm)) continue;
        if (!ts.isObjectLiteralExpression(arm)) return unreadAll('unread-spread', arm);
        const inner = this.readStyleObject(arm);
        if (inner.rest) return unreadAll('conditional-spread', arm);
        for (const k of inner.keys.keys()) set(k, unread('conditional-spread', arm));
      }
      return;
    }
    unreadAll('unread-spread', e);
  }

  // ─── Components and what they render ───────────────────────────────────────────────────────────────────────────────────────────────────

  // The expressions a component renders, in source order: an arrow's expression body, or every `return` of its body (not of a function
  // nested in it), or a class's `render()`.
  renderExpressions(component) {
    const { ts } = this;
    if (ts.isClassDeclaration(component) || ts.isClassExpression(component)) {
      const render = component.members.find((m) => ts.isMethodDeclaration(m) && m.name && propertyName(ts, m.name) === 'render' && m.body);
      return render ? returnsOf(ts, render.body) : [];
    }
    if (!component.body) return [];
    if (!ts.isBlock(component.body)) return [component.body];
    return returnsOf(ts, component.body);
  }

  // The top boxes a component renders. Only its FINAL return is judged: earlier returns are early exits — a loading spinner, an error bar, an
  // empty state in a small box — and measured on the shipped pages, judging them refuses pages whose main view scrolls. When the final return
  // renders no element (`if (data) return <Main/>; return <Spinner/>;`), the earlier ones are judged instead. A recognised state view in an
  // arm beside an element (`error ? <MessageBar/> : <div …>`) is not judged; one that is all the component renders is. Any other library
  // component in an arm (`mode ? <div …> : <Card>{rows}</Card>`) is judged as a top of its own (`library-top` when it does not scroll).
  componentCandidates(component, children, stack, site) {
    if (stack.includes(component)) return [{ kind: 'unresolved', reason: 'recursive', node: site || component }];
    const inner = [...stack, component];
    const exprs = this.renderExpressions(component);
    if (!exprs.length) return [];
    const last = this.expandTop(exprs[exprs.length - 1], component, children, inner);
    const pick = (list) => list.filter((c) => c.kind === 'element' || c.kind === 'unresolved' || (c.kind === 'library' && !this.isStateView(c)));
    if (pick(last).length) return pick(last);
    const earlier = exprs.slice(0, -1).flatMap((e) => this.expandTop(e, component, children, inner));
    if (pick(earlier).length) return pick(earlier);
    return [...last, ...earlier];
  }

  // What one rendered expression is, as the single box at the top of what it renders: one candidate per alternative (each arm of a
  // condition). `children` is the call site's children, for a component that renders `children`; `scope` the component it is written in.
  expandTop(expr, scope, children, stack) {
    const { ts } = this;
    const e = strip(ts, expr);
    if (ts.isConditionalExpression(e)) return [...this.expandTop(e.whenTrue, scope, children, stack), ...this.expandTop(e.whenFalse, scope, children, stack)];
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return this.expandTop(e.right, scope, children, stack);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...this.expandTop(e.left, scope, children, stack), ...this.expandTop(e.right, scope, children, stack)];
    }
    if (isNothing(ts, e) || ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || ts.isTemplateExpression(e)) return [];
    if (this.isChildren(e)) return children ? children.top() : [{ kind: 'unresolved', reason: 'children-top', node: e }];
    if (ts.isJsxFragment(e)) return this.singleTop(this.childBoxes(e.children, scope, children, stack), e);
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) {
      const open = ts.isJsxElement(e) ? e.openingElement : e;
      const tag = open.tagName.getText(this.sf);
      if (isIntrinsic(tag)) return [{ kind: 'element', node: e, scope, children }];
      if (TRANSPARENT.test(tag)) return ts.isJsxElement(e) ? this.singleTop(this.childBoxes(e.children, scope, children, stack), e) : [];
      if (this.components.has(tag) && !this.imported.has(tag)) {
        const callChildren = ts.isJsxElement(e) ? this.childrenOf(e, scope, children, stack) : null;
        return this.componentCandidates(this.components.get(tag), callChildren, stack, e);
      }
      return [{ kind: 'library', node: e, scope }];
    }
    if (ts.isCallExpression(e) && /(?:^|\.)createPortal$/.test(e.expression.getText(this.sf))) return [{ kind: 'unresolved', reason: 'portal', node: e }];
    return [{ kind: 'unresolved', reason: 'unresolved-return', node: e }];
  }

  // Several boxes side by side at the top are laid out by the host's container, which the check cannot see; one is that box.
  singleTop(boxes, node) {
    if (boxes.length === 0) return [];
    if (boxes.every((b) => b.alternativeOf === boxes[0].alternativeOf && b.alternativeOf !== undefined)) return boxes;
    if (boxes.length === 1) return boxes;
    return [{ kind: 'unresolved', reason: 'fragment-top', node }];
  }

  // The call site's children of a component, read lazily: as top boxes (a component that returns `children`) and as child boxes (one that
  // renders `{children}` inside an element of its own).
  childrenOf(element, scope, children, stack) {
    return {
      top: () => this.singleTop(this.childBoxes(element.children, scope, children, stack), element),
      boxes: () => this.childBoxes(element.children, scope, children, stack),
      tree: () => this.childTree(element.children, scope, children, stack),
    };
  }

  // Is a library box a recognised state view (STATE_VIEWS), with nothing inside but text, values, its own parts and inline tags?
  isStateView(box) {
    const { ts } = this;
    if (box.kind !== 'library') return false;
    const node = box.node;
    const open = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (!open || !STATE_VIEWS.test(lastSegment(open.tagName.getText(this.sf)))) return false;
    // Every JSX element a value inside renders (`{error && <b>{error}</b>}`) must be small too.
    const small = (n) => {
      if (ts.isJsxText(n)) return true;
      if (ts.isJsxFragment(n)) return n.children.every(small);
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText(this.sf);
        if (!(isIntrinsic(tag) ? STATE_VIEW_INLINE.test(tag) : STATE_VIEW_PARTS.test(lastSegment(tag)))) return false;
        return ts.isJsxSelfClosingElement(n) || n.children.every(small);
      }
      let ok = true;
      const visit = (x) => {
        if (!ok) return;
        if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) ok = small(x);
        else ts.forEachChild(x, visit);
      };
      visit(n);
      return ok;
    };
    return ts.isJsxSelfClosingElement(node) || node.children.every(small);
  }

  isChildren(e) {
    const { ts } = this;
    if (ts.isIdentifier(e)) return e.text === 'children';
    return ts.isPropertyAccessExpression(e) && e.name.text === 'children' && /^(?:this\.)?props$|^[A-Za-z_$][\w$]*$/.test(e.expression.getText(this.sf));
  }

  // Every box an element's children render, flattened through fragments, transparent components, conditions, `.map(…)` callbacks and the
  // components written in this file. Each alternative of one child carries the same `alternativeOf`, so the top can tell "one box, two
  // possible" from "two boxes side by side".
  childBoxes(nodes, scope, children, stack) {
    const { ts } = this;
    const out = [];
    let index = 0;
    for (const child of nodes) {
      if (ts.isJsxText(child)) continue;
      const group = index++;
      const add = (boxes) => {
        for (const b of boxes) out.push(b.alternativeOf === undefined ? { ...b, alternativeOf: group } : b);
      };
      if (ts.isJsxExpression(child)) {
        if (child.expression) add(this.boxesOfExpression(child.expression, scope, children, stack));
      } else {
        add(this.boxesOfExpression(child, scope, children, stack));
      }
    }
    return out;
  }

  boxesOfExpression(expr, scope, children, stack) {
    const { ts } = this;
    const e = strip(ts, expr);
    if (ts.isConditionalExpression(e)) return [...this.boxesOfExpression(e.whenTrue, scope, children, stack), ...this.boxesOfExpression(e.whenFalse, scope, children, stack)];
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return this.boxesOfExpression(e.right, scope, children, stack);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...this.boxesOfExpression(e.left, scope, children, stack), ...this.boxesOfExpression(e.right, scope, children, stack)];
    }
    if (isNothing(ts, e) || ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || ts.isTemplateExpression(e)) return [];
    if (this.isChildren(e)) return children ? children.boxes() : [{ kind: 'unresolved', reason: 'unresolved-children', node: e }];
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((el) => this.boxesOfExpression(el, scope, children, stack));
    if (ts.isJsxFragment(e)) return this.childBoxes(e.children, scope, children, stack).map(({ alternativeOf, ...b }) => b);
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) {
      const open = ts.isJsxElement(e) ? e.openingElement : e;
      const tag = open.tagName.getText(this.sf);
      if (isIntrinsic(tag)) return [{ kind: 'element', node: e, scope, children }];
      if (TRANSPARENT.test(tag)) return ts.isJsxElement(e) ? this.childBoxes(e.children, scope, children, stack).map(({ alternativeOf, ...b }) => b) : [];
      if (this.components.has(tag) && !this.imported.has(tag)) {
        const callChildren = ts.isJsxElement(e) ? this.childrenOf(e, scope, children, stack) : null;
        return this.componentCandidates(this.components.get(tag), callChildren, stack, e);
      }
      return [{ kind: 'library', node: e, scope }];
    }
    if (ts.isCallExpression(e)) {
      const callee = e.expression.getText(this.sf);
      // A portal renders somewhere else, so it is not part of this box's content.
      if (/(?:^|\.)createPortal$/.test(callee)) return [];
      // `items.map((item) => <div …/>)`: the boxes are what the callback returns.
      if (ts.isPropertyAccessExpression(e.expression) && /^(?:map|flatMap)$/.test(e.expression.name.text) && e.arguments.length) {
        const cb = strip(ts, e.arguments[0]);
        if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
          const exprs = ts.isBlock(cb.body) ? returnsOf(ts, cb.body) : [cb.body];
          return exprs.flatMap((x) => this.boxesOfExpression(x, scope, children, stack));
        }
      }
    }
    return [{ kind: 'unresolved', reason: 'unresolved-children', node: e }];
  }

  // What an element's children render, as the decision walks it: `seq` (boxes side by side — one that provides is enough), `alt` (the
  // alternatives of a condition — only one is on screen at a time, so each one must provide) and `leaf` (one box). The flat list of
  // `childBoxes` cannot tell the two apart: `{mode ? <div scrolls/> : <div tall/>}` read as two siblings passed on the arm that scrolls,
  // and the other arm shipped clipped.
  //   <div>{a}{b ? <X/> : <Y/>}{c && <Z/>}</div>   → seq[ a, alt[X, Y], alt[Z, nothing] ]
  childTree(nodes, scope, children, stack) {
    const { ts } = this;
    const items = [];
    for (const child of nodes) {
      if (ts.isJsxText(child)) continue;
      if (ts.isJsxExpression(child)) {
        if (child.expression) items.push(this.treeOf(child.expression, scope, children, stack));
      } else {
        items.push(this.treeOf(child, scope, children, stack));
      }
    }
    return seqOf(items);
  }

  treeOf(expr, scope, children, stack) {
    const { ts } = this;
    const e = strip(ts, expr);
    const tree = (x) => this.treeOf(x, scope, children, stack);
    if (ts.isConditionalExpression(e)) return altOf([tree(e.whenTrue), tree(e.whenFalse)]);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return altOf([tree(e.right), NOTHING]);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return altOf([tree(e.left), tree(e.right)]);
    }
    if (ts.isArrayLiteralExpression(e)) return seqOf(e.elements.map(tree));
    if (ts.isJsxFragment(e)) return this.childTree(e.children, scope, children, stack);
    if (this.isChildren(e) && children) return children.tree();
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) {
      const open = ts.isJsxElement(e) ? e.openingElement : e;
      const tag = open.tagName.getText(this.sf);
      if (!isIntrinsic(tag) && TRANSPARENT.test(tag)) return ts.isJsxElement(e) ? this.childTree(e.children, scope, children, stack) : NOTHING;
      if (!isIntrinsic(tag) && this.components.has(tag) && !this.imported.has(tag)) {
        // What a component renders at its top is one box of several possible (each arm of its final return): alternatives.
        const callChildren = ts.isJsxElement(e) ? this.childrenOf(e, scope, children, stack) : null;
        return altOf(this.componentCandidates(this.components.get(tag), callChildren, stack, e).map(leafOf));
      }
    }
    // `items.map((item) => …)`: each item renders one of what the callback returns.
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && /^(?:map|flatMap)$/.test(e.expression.name.text) && e.arguments.length) {
      const cb = strip(ts, e.arguments[0]);
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) return altOf((ts.isBlock(cb.body) ? returnsOf(ts, cb.body) : [cb.body]).map(tree));
    }
    return seqOf(this.boxesOfExpression(e, scope, children, stack).map(leafOf));
  }

  // ─── The decision ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  // provides(box) for a box under `parent` (`null` at the top of the page; else `{ flexColumn, definite }` of a bounded parent). A pass
  // carries the path of boxes from this one down to the one that scrolls, each with its parent, for the padding check.
  provides(box, parent, stack) {
    if (box.kind === 'unresolved') return unknownOf(box.reason, box.node);
    const style = this.styleOf(box);
    const bounded = this.bounded(style, parent);
    if (bounded.v === false) return FALSE;
    // What the box provides once bounded. With its bound unproven, a box that provably provides nothing even then (an inline overflow of
    // hidden over text) still fails: bounded or not, it does not scroll.
    const once = this.providesIfBounded(box, style, parent, stack);
    if (bounded.v === null) return once.v === false ? FALSE : bounded;
    return once;
  }

  providesIfBounded(box, style, parent, stack) {
    const scrolls = scrollsY(style);
    if (scrolls.v === true) return { v: true, path: [{ box, parent }] };
    // Bounded and not (provably) scrolling: one of its children may. A library component's children sit in slots the check cannot see.
    const { ts } = this;
    if (box.kind !== 'element' || !ts.isJsxElement(box.node)) return scrolls.v === null ? scrolls : FALSE;
    const here = {
      flexColumn: and(oneOf(style.get('display'), ['flex', 'inline-flex']), oneOf(style.get('flexDirection'), ['column', 'column-reverse'])),
      definite: this.definiteOf(style, parent),
    };
    const r = this.providesTree(this.childTree(box.node.children, box.scope, box.children || null, stack), here, stack);
    if (r.v === true) return { v: true, path: [{ box, parent }, ...r.path] };
    if (scrolls.v === null) return scrolls;
    return r.v === null ? r : FALSE;
  }

  // provides() over a tree of children (childTree): side by side, one that provides is enough; of alternatives, each one that is rendered
  // must. An alternative that renders nothing, or only recognised state views (STATE_VIEWS: a Spinner, a MessageBar — a loading, empty or
  // error state), is not judged — the same treatment a state view gets at the top of the page. Any other library component in an
  // alternative (a `Card` holding rows) is judged: its layout is opaque, so beside an alternative that scrolls it is unproven. One alternative that provides beside one that
  // does not is `partial-alternatives`: the check cannot tell whether that condition is ever met, and the one that does not scroll is clipped
  // whenever it is.
  providesTree(node, parent, stack) {
    if (node.t === 'leaf') return this.provides(node.box, parent, stack);
    if (node.t === 'seq') {
      let unproven = null;
      for (const item of node.items) {
        const r = this.providesTree(item, parent, stack);
        if (r.v === true) return r;
        if (r.v === null && !unproven) unproven = r;
      }
      return unproven || FALSE;
    }
    const judged = [];
    for (const arm of node.arms) {
      const r = this.providesTree(arm, parent, stack);
      if (r.v !== true && leavesOf(arm).every((b) => this.isStateView(b))) continue;
      judged.push({ arm, r });
    }
    if (judged.length && judged.every((x) => x.r.v === true)) return { v: true, path: judged.flatMap((x) => x.r.path) };
    const missing = judged.find((x) => x.r.v === false);
    if (missing && judged.some((x) => x.r.v === true)) {
      const first = leavesOf(missing.arm)[0];
      return unknownOf('partial-alternatives', first ? first.node : null);
    }
    const unproven = judged.find((x) => x.r.v === null);
    return unproven ? unproven.r : FALSE;
  }

  // bounded(E): E's height cannot grow with its content. A percentage `height`/`maxHeight` resolves only against a parent of DEFINITE height
  // (`parent.definite`): a parent bounded by `maxHeight` alone bounds itself, but a `height: "100%"` child of it computes to `auto` and grows
  // past it (CSS 2 §10.5, https://www.w3.org/TR/CSS2/visudet.html#the-height-property). A `minHeight` wins over both, so one that may be
  // larger than the bound defeats it (minFits).
  bounded(style, parent) {
    const top = parent === null;
    const resolves = top ? TOP_PERCENT_IS_BOUNDED : parent.definite;
    const height = style.get('height');
    const maxHeight = style.get('maxHeight');
    const direct = and(or(definite(height, resolves), definite(maxHeight, resolves)), minFits(style.get('minHeight'), height !== undefined ? height : maxHeight));
    if (direct.v === true || top) return direct;
    return or(direct, and(parent.flexColumn, growsOf(style), flexMinZero(style)));
  }

  // definite(E): is E's height one a child's percentage resolves against? A definite `height` (not `maxHeight`: a box bounded only by its
  // maximum has an `auto` height), or a flex item that grows in a flex column of definite height, which is definite once flexed
  // (https://www.w3.org/TR/css-flexbox-1/#definite-sizes).
  definiteOf(style, parent) {
    const resolves = parent === null ? TOP_PERCENT_IS_BOUNDED : parent.definite;
    const height = style.get('height');
    const own = and(definite(height, resolves), minFits(style.get('minHeight'), height));
    if (own.v === true || parent === null) return own;
    return or(own, and(parent.flexColumn, parent.definite, growsOf(style), flexMinZero(style)));
  }

  // ─── An element's style: its classes, then its inline style ────────────────────────────────────────────────────────────────────────────

  // The effective decisive keys of one element: `get(key)` → a known value, an unread one, or undefined (not set). An inline style wins over
  // every class; among classes, a later argument of mergeClasses wins; a class applied under a condition makes every key it sets unknown.
  styleOf(box) {
    if (box.style) return box.style;
    const { ts } = this;
    const open = ts.isJsxElement(box.node) ? box.node.openingElement : box.node;
    let classes = { layers: [] };
    let inline = null;
    let classAttr = null;
    let styleAttr = null;
    let spreadAfter = false;
    for (const attr of open.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        classes = { unread: unread('spread-attributes', attr) };
        inline = { keys: new Map(), rest: unread('spread-attributes', attr) };
        spreadAfter = true;
        continue;
      }
      const name = attr.name.getText(this.sf);
      if (name === 'className') {
        classAttr = attr;
        spreadAfter = false;
        const init = attr.initializer;
        if (!init) classes = { unread: unread('computed-class', attr) };
        else if (ts.isStringLiteral(init)) classes = init.text.trim() ? { unread: unread('string-class', init) } : { layers: [] };
        else if (ts.isJsxExpression(init) && init.expression) classes = this.classLayers(init.expression, box.scope, false);
        else classes = { unread: unread('computed-class', attr) };
      } else if (name === 'style') {
        styleAttr = attr;
        spreadAfter = false;
        const init = attr.initializer;
        const e = init && ts.isJsxExpression(init) && init.expression ? strip(ts, init.expression) : null;
        inline = e && ts.isObjectLiteralExpression(e) ? this.readStyleObject(e) : { keys: new Map(), rest: unread('style-expression', attr) };
      }
    }
    const get = (key) => effective(classes, inline, key);
    box.style = { get, classes, inline, classAttr, styleAttr, spreadAfter };
    return box.style;
  }

  classLayers(expr, scope, conditional) {
    const { ts } = this;
    const e = strip(ts, expr);
    if (isNothing(ts, e) || (ts.isStringLiteralLike(e) && !e.text.trim())) return { layers: [] };
    if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e)) return { unread: unread('string-class', e) };
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const slotName = ts.isPropertyAccessExpression(e) ? e.name.text : (ts.isStringLiteralLike(strip(ts, e.argumentExpression)) ? strip(ts, e.argumentExpression).text : null);
      const owner = strip(ts, e.expression);
      const binding = ts.isIdentifier(owner) ? this.bindings(scope).get(owner.text) : null;
      if (binding && binding.hook && slotName != null) return this.slotLayer(binding.hook, slotName, e, conditional);
      return { unread: unread('computed-class', e) };
    }
    if (ts.isIdentifier(e)) {
      const binding = this.bindings(scope).get(e.text);
      if (binding && binding.slot) return this.slotLayer(binding.hook, binding.slot, e, conditional);
      return { unread: unread('computed-class', e) };
    }
    if (this.isCallTo(e, this.mergeClassesNames, 'mergeClasses')) {
      const layers = [];
      for (const arg of e.arguments) {
        if (ts.isSpreadElement(arg)) return { unread: unread('computed-class', arg) };
        const r = this.classLayers(arg, scope, conditional);
        if (r.unread) return r;
        layers.push(...r.layers);
      }
      return { layers };
    }
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
      const arms = e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? [e.right] : [e.left, e.right];
      return this.armsLayers(arms, scope);
    }
    if (ts.isConditionalExpression(e)) return this.armsLayers([e.whenTrue, e.whenFalse], scope);
    return { unread: unread('computed-class', e) };
  }

  armsLayers(arms, scope) {
    const layers = [];
    for (const arm of arms) {
      const r = this.classLayers(arm, scope, true);
      if (r.unread) return r;
      layers.push(...r.layers);
    }
    return { layers };
  }

  slotLayer(hookName, slotName, node, conditional) {
    const hook = this.hooks.get(hookName);
    if (!hook) return { unread: unread('computed-class', node) };
    if (hook.slots.has(slotName)) return { layers: [{ facts: hook.slots.get(slotName), conditional, node, hook: hookName, slot: slotName }] };
    return { unread: hook.rest ? unread(hook.rest.reason, hook.rest.node) : unread('unknown-slot', node) };
  }

  // The names a component binds to its style hooks: `const styles = useStyles();` → styles: { hook }, and
  // `const { root } = useStyles();` → root: { hook, slot: 'root' }. Searched through the whole component, so a render helper nested in it
  // that reads the component's `styles` is read too.
  bindings(scope) {
    if (this.bindingsCache.has(scope)) return this.bindingsCache.get(scope);
    const { ts } = this;
    const map = new Map();
    const visit = (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const init = strip(ts, n.initializer);
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && this.hooks.has(init.expression.text)) {
          const hook = init.expression.text;
          if (ts.isIdentifier(n.name) && !map.has(n.name.text)) map.set(n.name.text, { hook });
          if (ts.isObjectBindingPattern(n.name)) {
            for (const el of n.name.elements) {
              if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
              const slot = el.propertyName ? propertyName(ts, el.propertyName) : el.name.text;
              if (slot != null && !map.has(el.name.text)) map.set(el.name.text, { hook, slot });
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    if (scope) visit(scope);
    this.bindingsCache.set(scope, map);
    return map;
  }

  // ─── The remedy each problem gives ─────────────────────────────────────────────────────────────────────────────────────────────────────

  // Where to write the remedy so that the check then provably accepts the page:
  //   class  — the element's own makeStyles slot, when its classes and inline style are all read and nothing else can override the keys the
  //            remedy writes (no other class sets an overflow key, the inline style sets none of the remedy's keys, no spread of attributes
  //            follows);
  //   style  — otherwise its inline style (an inline style wins over every class, so the keys written there are what the element gets);
  //   wrap   — when the top is not an element of the page (a library component, several elements, a portal, something computed): a <div>
  //            around what the component returns.
  // `mode` is 'scroll' (the remedy is REMEDY_KEYS on the page's top) or 'padding' (it is `boxSizing: "border-box"` on the box that
  // overhangs; a library component takes it too, as Fluent v9 applies className and style to the component's root slot).
  fixFor(box, mode) {
    if (box.kind === 'unresolved' || (mode === 'scroll' && box.kind !== 'element')) return { kind: 'wrap', ...this.place(box.node) };
    const style = this.styleOf(box);
    // A bounded flex column shrinks its items to fit, and an item that clips its own overflow (a Fluent Card is overflow: hidden) has no
    // automatic minimum height, so it is squeezed and its content cut off inside it: the remedy on a flex column says so.
    const column = mode === 'scroll' && and(oneOf(style.get('display'), ['flex', 'inline-flex']), oneOf(style.get('flexDirection'), ['column', 'column-reverse'])).v === true;
    // A minHeight the remedy's `height: "100%"` does not provably win over (a larger one, or one the check cannot compare) is neutralised by
    // the remedy too: `minHeight: 0`.
    const minHeight = mode === 'scroll' && minFits(style.get('minHeight'), known('100%')).v !== true;
    const extra = { ...(column ? { flexColumn: true } : {}), ...(minHeight ? { minHeight: true } : {}) };
    if (canFixOnClass(style, mode, minHeight)) {
      const target = [...style.classes.layers].reverse().find((l) => !l.conditional);
      return { kind: 'class', hook: target.hook, slot: target.slot, ...extra };
    }
    return { kind: 'style', ...extra };
  }

  // Does a box on the path to the scroll provably overhang its container by its vertical padding? Only a box whose height is the whole of its
  // container's can, and only that case is refused: `height` or `maxHeight` of exactly "100%" (measured on the host: the last 16px of a page
  // with 16px padding stayed cut off), or `calc(100% - N)` whose N is smaller than a vertical padding the check can read in px. `50%`, or
  // `calc(100% - 64px)` with 16px padding on each side, leave room for the padding and are not refused; nor is a calc() whose padding is a
  // token, whose overhang the check cannot prove. One sized by flex is laid out with its padding counted, and a fixed length is the size the
  // author chose. A scroll container in a flex column also shrinks to fit (its automatic minimum height is 0).
  // Returns the value that fills the container ("100%", "calc(100% - 8px)") and, when the other of height and maxHeight is a fixed length
  // that caps the box, that bound (`cap`: { key, value }); or null.
  overhangs(box, parent) {
    const style = this.styleOf(box);
    const sizing = style.get('boxSizing');
    if (sizing && sizing.known && String(sizing.value).trim().toLowerCase() === 'border-box') return null;
    if (parent && parent.flexColumn.v === true && scrollContainer(style).v === true) return null;
    if (!PADDING_KEYS.some((key) => verticalPadding(key, style.get(key)))) return null;
    // CSS sizes the box at max(minHeight, min(height, maxHeight)) (CSS 2 §10.7), so a second bound clears the overhang only when that used
    // height is provably smaller than the container by at least the padding. Each key is classed as
    //   fill  — "100%", or calc(100% - N px) with N smaller than the vertical padding in px: the box would overhang at this size;
    //   room  — calc(100% - N px) with N at least that padding: the box ends far enough above the container's end;
    //   maybe — any other known value ("150%", "50%", "400px", a calc() beside token padding): its distance from the container's height is
    //           not known in px, so it neither proves an overhang on its own nor clears one;
    // and the box is refused only when its height or maxHeight fills, as before. Then:
    //   height "100%" + maxHeight "calc(100% - 64px)", 16px padding        → min(fill, room) = room       → not refused
    //   height "100%" + maxHeight "150%"                                   → min(fill, maybe) = maybe     → refused
    //   height "100%" + minHeight "100%" + maxHeight "calc(100% - 64px)"   → max(fill, room) = fill       → refused (the minimum wins)
    // An unread height or maxHeight (from a spread or a token) is passed over, as it was before a second key was weighed; an unread
    // minHeight may be the larger, so it cannot clear the overhang.
    // https://www.w3.org/TR/CSS2/visudet.html#min-max-heights
    const padding = verticalPaddingPx(style);
    const classOf = (v) => {
      if (typeof v.value !== 'string') return 'maybe';
      const s = v.value.trim().toLowerCase().replace(/\s+/g, ' ');
      if (s === '100%') return 'fill';
      const calc = /^calc\( ?100% - (\d+(?:\.\d+)?)px ?\)$/.exec(s);
      if (!calc || padding === null) return 'maybe';
      return padding > Number(calc[1]) ? 'fill' : 'room';
    };
    let fills = null;
    const bounds = [];
    let fixed = null;
    for (const key of ['height', 'maxHeight']) {
      const v = style.get(key);
      if (v === undefined || !v.known || (typeof v.value === 'string' && /^(?:auto|none)$/i.test(v.value.trim()))) continue;
      const c = classOf(v);
      if (c === 'fill') fills = fills || v.value.trim();
      if (c === 'maybe' && fixedLength(v.value)) fixed = { key, value: typeof v.value === 'number' ? `${v.value}px` : v.value.trim() };
      bounds.push(c);
    }
    if (!fills) return null;
    const used = bounds.includes('room') ? 'room' : bounds.includes('maybe') ? 'maybe' : 'fill';
    // A box that fills its container and is capped by a fixed length (height "100%" under maxHeight "400px") is min(container, 400px) tall
    // plus its padding: it overhangs only a container shorter than 400px plus that padding, and the message says so. It is still refused,
    // as the host's height is not known here. A minHeight other than auto or 0 may hold it at the container's height, so then it is not
    // said.
    const min = style.get('minHeight');
    const minFree = min === undefined || (min.known && (isAutoMin(min) || isZero(min).v === true));
    if (used !== 'room') return { fills, cap: used === 'maybe' && fixed && minFree ? fixed : null };
    if (minFree) return null;
    return min.known && classOf(min) === 'room' ? null : { fills, cap: null };
  }

  place(node) {
    const { line, character } = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf));
    return { line: line + 1, column: character + 1 };
  }

  elementName(box) {
    const { ts } = this;
    if (ts.isJsxElement(box.node)) return box.node.openingElement.tagName.getText(this.sf);
    if (ts.isJsxSelfClosingElement(box.node)) return box.node.tagName.getText(this.sf);
    if (ts.isJsxFragment(box.node)) return '<>';
    return box.node.getText(this.sf).split('\n')[0].slice(0, 40);
  }
}

// Can the remedy go on the element's own makeStyles slot and provably win there? The slot must be the last class applied without a condition,
// every class and the inline style must be read, and nothing applied after the slot (a conditional class, the inline style, a spread of
// attributes) may set a key the remedy writes. For the scroll remedy, no other class may set an overflow key either: of a shorthand and its
// longhand on two Griffel classes, which one wins is not visible in the source (see `effective`).
function canFixOnClass(style, mode, minHeight = false) {
  if (style.spreadAfter || style.classes.unread) return false;
  const layers = style.classes.layers;
  const target = [...layers].reverse().find((l) => !l.conditional);
  if (!target || target.facts.rest) return false;
  const writes = mode === 'padding' ? ['boxSizing'] : ['height', ...OVERFLOW_KEYS, 'boxSizing', ...(minHeight ? ['minHeight'] : [])];
  for (const layer of layers) {
    if (layer === target) continue;
    if (layer.facts.rest) return false;
    if (mode !== 'padding' && layer.conditional && [...layer.facts.keys.keys()].some((k) => DECISIVE.has(k) || k === 'boxSizing')) return false;
    if (mode === 'padding' && layer.conditional && layer.facts.keys.has('boxSizing')) return false;
    if (mode !== 'padding' && OVERFLOW_KEYS.some((k) => layer.facts.keys.has(k))) return false;
  }
  if (style.inline) {
    if (style.inline.rest) return false;
    if (writes.some((k) => style.inline.keys.has(k))) return false;
  }
  return true;
}

// ─── Effective values ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function factValue(facts, key) {
  if (facts.keys.has(key)) return facts.keys.get(key).value;
  return facts.rest || undefined;
}

// One key through the class layers: the last layer that sets it wins; a conditional layer that sets it makes it unknown.
function classValue(classes, key) {
  if (classes.unread) return classes.unread;
  for (let i = classes.layers.length - 1; i >= 0; i -= 1) {
    const layer = classes.layers[i];
    const v = factValue(layer.facts, key);
    if (v === undefined) continue;
    if (layer.conditional) return unread(v.known ? 'conditional-class' : v.reason, v.known ? layer.node : v.node);
    return v;
  }
  return undefined;
}

// Pairs of a longhand and the shorthand that also sets it. `derive` turns the shorthand's value into the longhand's.
const PAIRS = {
  overflowY: { shorthand: 'overflow', derive: (v) => String(v).trim().split(/\s+/).pop() },
  overflowX: { shorthand: 'overflow', derive: (v) => String(v).trim().split(/\s+/)[0] },
  flexGrow: { shorthand: 'flex', derive: (v) => flexGrowOfFlex(v) },
};

function effective(classes, inline, key) {
  const pair = PAIRS[key];
  if (inline) {
    // An inline style is one object, so of a shorthand and its longhand the one written last wins (React sets them in order).
    if (!pair) {
      const v = factValue(inline, key);
      if (v !== undefined) return v;
    } else {
      const long = inline.keys.get(key);
      const short = inline.keys.get(pair.shorthand);
      if (long || short) {
        const pick = !short || (long && long.order > short.order) ? long.value : derived(short.value, pair);
        return pick;
      }
      if (inline.rest) return inline.rest;
    }
  }
  if (!pair) return classValue(classes, key);
  const long = classValue(classes, key);
  const short = classValue(classes, pair.shorthand);
  if (short === undefined) return long;
  if (long === undefined) return derived(short, pair);
  // Both set on classes: which one Griffel's atomic classes let win is not something the source shows, so only an agreement is read.
  const fromShort = derived(short, pair);
  if (long.known && fromShort.known && sameEffect(key, long.value, fromShort.value)) return long;
  if (!long.known) return long;
  if (!fromShort.known) return fromShort;
  return unread('conflicting-keys', null);
}

function derived(value, pair) {
  if (!value.known) return value;
  const v = pair.derive(value.value);
  return v && v.known === false ? v : known(v);
}

function sameEffect(key, a, b) {
  if (key === 'flexGrow') return Number(a) > 0 === Number(b) > 0;
  // `overflowY: "var(--Scroll)"` and `overflow: "var(--scroll)"` read two custom properties, so they do not provably agree.
  return foldCss(String(a).trim()) === foldCss(String(b).trim());
}

// `flex: 1` → 1; `flex: "1 1 0"` → 1; `flex: "auto"` → 1; `flex: "none"` / `"initial"` → 0. https://www.w3.org/TR/css-flexbox-1/#flex-common
function flexGrowOfFlex(v) {
  if (typeof v === 'number') return v;
  const first = String(v).trim().toLowerCase().split(/\s+/)[0];
  if (first === 'auto') return 1;
  if (first === 'none' || first === 'initial') return 0;
  const n = Number(first);
  return Number.isFinite(n) ? n : unread('unread-value', null);
}

function flexGrowOfShorthand(value) {
  if (!value.known) return value;
  const g = flexGrowOfFlex(value.value);
  return g && g.known === false ? g : known(g);
}

// ─── The predicates ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Is a height or max-height value definite? A percentage resolves against the parent's height: `resolves` says whether that is definite (at
// the top of the page it is the host's container, which is). A viewport unit is not taken as bounded: the host draws its own header above
// the page, so `100vh` is taller than the container the page gets.
function definite(value, resolves) {
  if (value === undefined) return FALSE;
  if (!value.known) return unknownOf(value.reason, value.node);
  const v = value.value;
  if (typeof v === 'number') return Number.isFinite(v) ? TRUE : FALSE;
  const s = String(v).trim().toLowerCase();
  if (!s || /^(?:auto|none|fit-content|min-content|max-content|unset|initial|inherit|revert|revert-layer)$/.test(s)) return FALSE;
  if (/\d(?:d|s|l)?v(?:h|w|min|max|b|i)\b/.test(s)) return FALSE;
  if (/%/.test(s)) return resolves;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|pt|pc|cm|mm|in|q|ex|ch)?$/.test(s) || /^(?:calc|min|max|clamp)\(/.test(s)) return TRUE;
  return unknownOf('unread-value', null);
}

// `height: "100%"` on the page's top element resolves against the host's container, which has a fixed height.
const TOP_PERCENT_IS_BOUNDED = TRUE;

// A length as a number and its unit, for comparing two of them within that unit: 2000 → 2000 px, "480px" → 480 px, "100%" → 100 %,
// "30rem" → 30 rem. Two values are compared only in the same unit, never converted: a min-height and a height of the same box resolve
// `%` against the same containing block, `em` against the same font size, `rem` and the viewport units against the same root and viewport.
// Anything else (a calc(), a token) is not measured.
function measure(value) {
  if (!value || !value.known) return null;
  if (typeof value.value === 'number') return Number.isFinite(value.value) ? { n: value.value, unit: 'px' } : null;
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|%|rem|em|vh|vw|dvh|svh|lvh)$/.exec(String(value.value).trim().toLowerCase());
  return m ? { n: Number(m[1]), unit: m[2] } : null;
}

// Is a height or maxHeight a fixed length, independent of the container's height? 400, "400px", "30rem". A percentage, a viewport unit (the
// host's container is shorter than the viewport, so "100vh" never caps a box that fills it), a calc() or a keyword is not.
function fixedLength(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0;
  return /^(?:\d+\.?\d*|\.\d+)(?:px|rem|em|pt|pc|cm|mm|in|q|ex|ch)$/i.test(String(v).trim());
}

// The same CSS text, whitespace and case aside: "calc(100% - 64px)" and "CALC(100%  -  64px)" are one value. Only the case of keywords,
// units and function names is ignored: a custom property name is case-sensitive, so "var(--height)" and "var(--HEIGHT)" are two values.
function sameValue(a, b) {
  if (!a || !b || !a.known || !b.known) return false;
  const norm = (v) => (typeof v === 'number' ? `${v}px` : foldCss(String(v).trim().replace(/\s+/g, ' ')));
  return norm(a.value) === norm(b.value);
}

// CSS text in lower case but for its custom property names, for comparing two values: keywords, units and function names are ASCII
// case-insensitive, while `--height` and `--HEIGHT` name two custom properties that may hold different sizes.
//   "CALC(VAR(--Height) - 8PX)" → "calc(var(--Height) - 8px)"
// A `--name` runs to the next space, comma or parenthesis — `var(--a,--B)`, `var(--a, 8px)` — which is all an unescaped name can end at in a
// value; a lone `-` (`100% - 8px`) is not a name. https://www.w3.org/TR/css-variables-1/#defining-variables
function foldCss(text) {
  return text.split(/(--[^\s,()]*)/).map((part, i) => (i % 2 ? part : part.toLowerCase())).join('');
}

// A `minHeight` that is not provably at most the height that bounds the box: CSS applies the minimum over the height and the maximum, so a
// root with `height: "100%"` and `minHeight: 2000` is 2000px tall in a 720px host, scrolls by 40px and keeps the rest cut off.
//   unset, auto, 0                        → fits
//   "100%" under height "100%", 300 ≤ 480 → fits (the same unit, and not larger)
//   "calc(100% - 64px)" under the same    → fits (the same value)
//   "10rem" / "30rem" under "30rem"       → fits (compared in rem)
//   2000 under height 480, "40rem" / "30rem", "60%" vs "50%" → does not fit
//   "400px" under "100%", a token         → cannot tell (`min-height`, or the token's own reason)
// https://www.w3.org/TR/CSS2/visudet.html#min-max-heights
function minFits(min, bound) {
  if (min === undefined || isAutoMin(min)) return TRUE;
  if (!min.known) return unknownOf(min.reason, min.node);
  if (isZero(min).v === true) return TRUE;
  if (sameValue(min, bound)) return TRUE;
  const a = measure(min);
  const b = measure(bound);
  if (a && b && a.unit === b.unit) return a.n <= b.n ? TRUE : FALSE;
  return unknownOf('min-height', null);
}

function isAutoMin(value) {
  return value.known && typeof value.value === 'string' && /^(?:auto|initial|unset|revert|revert-layer)$/.test(value.value.trim().toLowerCase());
}

// Is a flex item's automatic minimum height removed, so that it shrinks to the column it grows in? `minHeight: 0` does, and so does being a
// scroll container (CSS computes `min-height: auto` to 0 for one) — unless a `minHeight` of its own is set, which then is its minimum: one
// that is not zero may be larger than the room the column has left (`min-height`), and on a box that does not clip it is not removed at all.
// https://www.w3.org/TR/css-flexbox-1/#min-size-auto
function flexMinZero(style) {
  const min = style.get('minHeight');
  if (min === undefined || isAutoMin(min)) return scrollContainer(style);
  if (!min.known) return unknownOf(min.reason, min.node);
  if (isZero(min).v === true) return TRUE;
  return scrollContainer(style).v === false ? FALSE : unknownOf('min-height', null);
}

// The tree childTree builds.
const NOTHING = { t: 'seq', items: [] };
const leafOf = (box) => ({ t: 'leaf', box });
const seqOf = (items) => (items.length === 1 ? items[0] : { t: 'seq', items });
const altOf = (arms) => (arms.length === 0 ? NOTHING : arms.length === 1 ? arms[0] : { t: 'alt', arms });
function leavesOf(node) {
  if (node.t === 'leaf') return [node.box];
  return (node.t === 'seq' ? node.items : node.arms).flatMap(leavesOf);
}

// Does one padding key set a vertical padding that is not zero? "Not literally 0" is the test: a token (`tokens.spacingVerticalL`), a variable
// or any other value the check cannot read counts as padding, as `boxSizing: "border-box"` is right whatever the value is. For the
// `padding` / `paddingBlock` shorthands only the vertical parts count:
//   padding: "0 16px"          → top 0, bottom 0           → no vertical padding
//   padding: "8px 16px 0"      → top 8px                   → padding
//   paddingBlock: "0 12px"     → start 0, end 12px         → padding
function verticalPadding(key, value) {
  if (value === undefined) return false;
  if (!value.known) return true;
  const zero = (s) => /^0(?:\.0*)?(?:px|%|rem|em)?$/.test(s);
  if (typeof value.value === 'number') return value.value !== 0;
  const parts = String(value.value).trim().split(/\s+/);
  if (key === 'padding') return [parts[0], parts.length >= 3 ? parts[2] : parts[0]].some((p) => !zero(p));
  if (key === 'paddingBlock') return [parts[0], parts[1] || parts[0]].some((p) => !zero(p));
  return !zero(parts[0]);
}

function isZero(value) {
  if (value === undefined) return FALSE;
  if (!value.known) return unknownOf(value.reason, value.node);
  return /^0(?:\.0*)?(?:px|%|rem|em)?$/.test(String(value.value).trim()) ? TRUE : FALSE;
}

// The least vertical padding (top + bottom, in px) a box has, or null when a padding key is set to something not in px (a token, rem, a
// variable). Of two keys that set one side (`padding` and `paddingTop`), the smaller counts: which one wins is not always visible in the
// source, and a refusal must hold whichever does.
//   padding: "8px 16px"            → 8 + 8
//   padding: 16, paddingBottom: 0  → 16 + 0
//   paddingBlock: tokens.spacingL  → null
function verticalPaddingPx(style) {
  const px = (part) => {
    if (typeof part === 'number') return Number.isFinite(part) ? part : null;
    const s = String(part).trim().toLowerCase();
    if (/^0+(?:\.0*)?$/.test(s)) return 0;
    const m = /^(\d+(?:\.\d+)?)px$/.exec(s);
    return m ? Number(m[1]) : null;
  };
  const sides = { top: [], bottom: [] };
  for (const key of PADDING_KEYS) {
    const value = style.get(key);
    if (value === undefined) continue;
    if (!value.known) return null;
    const parts = typeof value.value === 'number' ? [value.value] : String(value.value).trim().split(/\s+/);
    const [top, bottom] = key === 'padding' ? [parts[0], parts.length >= 3 ? parts[2] : parts[0]]
      : key === 'paddingBlock' ? [parts[0], parts[1] === undefined ? parts[0] : parts[1]]
        : /Top$|Start$/.test(key) ? [parts[0], undefined] : [undefined, parts[0]];
    for (const [side, part] of [['top', top], ['bottom', bottom]]) {
      if (part === undefined) continue;
      const n = px(part);
      if (n === null) return null;
      sides[side].push(n);
    }
  }
  const least = (list) => (list.length ? Math.min(...list) : 0);
  return least(sides.top) + least(sides.bottom);
}

function oneOf(value, options) {
  if (value === undefined) return FALSE;
  if (!value.known) return unknownOf(value.reason, value.node);
  return options.includes(String(value.value).trim().toLowerCase()) ? TRUE : FALSE;
}

function growsOf(style) {
  const g = style.get('flexGrow');
  if (g === undefined) return FALSE;
  if (!g.known) return unknownOf(g.reason, g.node);
  const n = typeof g.value === 'number' ? g.value : Number(String(g.value).trim());
  return Number.isFinite(n) && n > 0 ? TRUE : FALSE;
}

// The computed overflow of each axis: when one axis is neither visible nor clip, a visible other axis computes to auto (and clip to hidden).
function computedOverflow(style) {
  const x = style.get('overflowX');
  const y = style.get('overflowY');
  if ((x && !x.known) || (y && !y.known)) return { unknown: (y && !y.known) ? y : x };
  const norm = (v) => (v === undefined ? 'visible' : String(v.value).trim().toLowerCase());
  let ox = norm(x);
  let oy = norm(y);
  const open = (v) => v === 'visible' || v === 'clip';
  if (!open(ox) || !open(oy)) {
    const fix = (v) => (v === 'visible' ? 'auto' : v === 'clip' ? 'hidden' : v);
    ox = fix(ox);
    oy = fix(oy);
  }
  return { x: ox, y: oy };
}

function scrollsY(style) {
  // An overflow-y of auto or scroll is what the box computes whatever overflow-x is (only a `visible` or `clip` y depends on x), so a known y
  // decides even when x cannot be read — the case of an inline remedy on an element whose classes the check cannot read.
  const y = style.get('overflowY');
  if (y && y.known && ['auto', 'scroll', 'overlay'].includes(String(y.value).trim().toLowerCase())) return TRUE;
  const c = computedOverflow(style);
  if (c.unknown) return unknownOf(c.unknown.reason, c.unknown.node);
  if (['auto', 'scroll', 'overlay'].includes(c.y)) return TRUE;
  if (['visible', 'hidden', 'clip'].includes(c.y)) return FALSE;
  return unknownOf('unread-value', null);
}

function scrollContainer(style) {
  const y = style.get('overflowY');
  if (y && y.known && ['auto', 'scroll', 'overlay', 'hidden'].includes(String(y.value).trim().toLowerCase())) return TRUE;
  const c = computedOverflow(style);
  if (c.unknown) return unknownOf(c.unknown.reason, c.unknown.node);
  return c.x !== 'visible' || c.y !== 'visible' ? (c.x === 'clip' && c.y === 'clip' ? FALSE : TRUE) : FALSE;
}

// ─── Messages ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const WHY = 'The host shows a page in a container of fixed height and does not scroll it, so whatever does not fit is cut off with no scrollbar.';

const SHRINK = ' That element is a flex column, which shrinks its items to fit once its height is bounded: give flexShrink: 0 to each of its items that clips its own content (a Card, or a box with an overflow key), or they are squeezed and cut off inside.';

function fixText(element, place, fix) {
  const shrink = fix.flexColumn ? SHRINK : '';
  // The remedy also writes `minHeight: 0` when the element has a minHeight that may be larger than its container: a minimum wins over a height.
  const keys = fix.minHeight ? `${REMEDY_KEYS}, minHeight: 0` : REMEDY_KEYS;
  if (fix.kind === 'class') {
    return `Add ${keys} to the "${fix.slot}" slot of ${fix.hook} (the class of the page's top <${element}> at line ${place.line}), and delete any overflow key or shorthands.overflow(…) from that slot (${RULE_REFERENCE}).${shrink}`;
  }
  if (fix.kind === 'style') {
    return `Write ${keys} as the last keys of the inline style of the page's top <${element}> at line ${place.line} — style={{ …, ${keys} }}, and a style given as an expression becomes style={{ ...thatExpression, ${keys} }} — and make style its last attribute: an inline style wins over every class, so the check can read it (${RULE_REFERENCE}).${shrink}`;
  }
  return `Wrap what the page returns at line ${place.line} in <div style={{ ${REMEDY_KEYS} }}>…</div> (${RULE_REFERENCE}).`;
}

function failMessage(element, place, fix) {
  return `the page has no scroll context: nothing from its top <${element}> at line ${place.line} down both has a bounded height and scrolls. ${WHY} ${fixText(element, place, fix)}`;
}

function unprovenMessage(element, place, result, at, fix) {
  const where = result.node ? ` (line ${at.line})` : '';
  return `the check cannot prove the page scrolls: ${REASONS[result.reason] || result.reason}${where}. ${WHY} ${fixText(element, place, fix)}`;
}

function paddingMessage(element, place, fix, { fills, cap }) {
  const add = 'boxSizing: "border-box"';
  const how = fix.kind === 'class'
    ? `Add ${add} to the "${fix.slot}" slot of ${fix.hook} (the class of that <${element}>)`
    : `Write ${add} as the last key of the inline style of that <${element}> and make style its last attribute`;
  const effect = cap
    ? `fills its container (${fills}) up to its ${cap.key} (${cap.value}) and has vertical padding in the default content-box model, so in a container shorter than ${cap.value} plus that padding it is taller than its container, and the end of the page may be cut off below the visible area`
    : `fills its container (${fills}) and has vertical padding in the default content-box model, so it is taller than its container by that padding and the end of the page stays cut off below the visible area`;
  return `the page scrolls, but its <${element}> at line ${place.line} ${effect}. ${how} (${RULE_REFERENCE}).`;
}

// ─── Small TypeScript helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function strip(ts, node) {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))) n = n.expression;
  return n;
}

function isNothing(ts, e) {
  return e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword
    || (ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e);
}

function lastSegment(tag) {
  return tag.slice(tag.lastIndexOf('.') + 1);
}

function isIntrinsic(tag) {
  return /^[a-z]/.test(tag) && !tag.includes('.');
}

function propertyName(ts, name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = strip(ts, name.expression);
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return e.text;
  }
  return null;
}

// A value as written: a string or a number. Anything else (a token, a variable, a call, a template with a substitution) is unread.
function readValue(ts, node) {
  const e = strip(ts, node);
  if (ts.isStringLiteralLike(e)) return known(e.text);
  if (ts.isNumericLiteral(e)) return known(Number(e.text));
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return known(-Number(e.operand.text));
  return unread('unread-value', e);
}

// Every `return` of a function body, in source order, not counting functions and classes nested in it.
function returnsOf(ts, body) {
  const out = [];
  const visit = (n) => {
    if (ts.isReturnStatement(n)) {
      if (n.expression) out.push(n.expression);
      return;
    }
    if (n !== body && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}

module.exports = { pageScrollProblems, analyzePageScroll, REMEDY_KEYS };
