'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { scanSource, featureCoherence, gateSources } = require('../lib/pcf-code-gate.js');

const FILE = 'src/pages-control.ts';

function findingsFor(text, feature = 'Device.captureImage', hosts = ['pages'], options = {}) {
  return featureCoherence({
    features: feature ? [{ name: feature }] : [],
  }, [{ file: FILE, text }], hosts, options);
}

function codesFor(text, feature, hosts) {
  return findingsFor(text, feature, hosts).map((finding) => finding.code).sort();
}

const memberSpellings = [
  ['double-quoted method', 'context.device["captureImage"]()'],
  ['single-quoted method', "context.device['captureImage']()"],
  ['bracket namespace and method', "context['device']['captureImage']()"],
  ['optional root', 'context?.device.captureImage()'],
  ['optional root and method', 'context?.device?.captureImage()'],
  ['optional root and call', 'context?.device?.captureImage?.()'],
  ['optional brackets', 'context?.["device"]?.["captureImage"]?.()'],
  ['spaced members', 'context . device . captureImage ()'],
  ['multiline members', 'context\n . device\n . captureImage\n ()'],
  ['comment-separated members', 'context /* root */ . device [ /* method */ "captureImage" ] ()'],
  ['utility bracket method', 'context.utils["lookupObjects"]()', 'Utility', 'utils', 'lookupObjects'],
  ['utility optional root', 'context?.utils.lookupObjects()', 'Utility', 'utils', 'lookupObjects'],
  ['utility spaced members', 'context . utils . lookupObjects ()', 'Utility', 'utils', 'lookupObjects'],
];

for (const [name, call, feature = 'Device.captureImage', namespace = 'device', method = 'captureImage'] of memberSpellings) {
  test(`Pages detection recognizes ${name} without weakening the guard`, () => {
    const guarded = `if (typeof context.${namespace}?.${method} === "function") { ${call}; }`;
    const invalidGuard = `if (ready || typeof context.${namespace}?.${method} === "function") { ${call}; }`;
    const results = {
      unguarded: codesFor(call, feature),
      guarded: codesFor(guarded, feature),
      invalidGuard: codesFor(invalidGuard, feature),
      undeclared: codesFor(call, null, ['model']),
      textOnly: codesFor(`// ${call}\nconst note = ${JSON.stringify(call)};`, null),
    };
    assert.deepEqual(results, {
      unguarded: ['PCF_PAGES_API'],
      guarded: [],
      invalidGuard: ['PCF_PAGES_API'],
      undeclared: ['PCF_FEATURE_UNDECLARED'],
      textOnly: [],
    });
    const finding = findingsFor(`// header\n${call};`, feature).find((item) => item.code === 'PCF_PAGES_API');
    assert.equal(finding.severity, 'error');
    assert.equal(finding.file, FILE);
    assert.equal(finding.line, 2);
  });
}

for (const [name, expression] of [
  ['bracket namespace', 'context["webAPI"].retrieveRecord("account", id)'],
  ['optional root', 'context?.webAPI.retrieveRecord("account", id)'],
  ['spaced members', 'context . webAPI . retrieveRecord("account", id)'],
]) {
  test(`Feature discovery recognizes WebAPI ${name}`, () => {
    assert.deepEqual({
      declared: codesFor(expression, 'WebAPI', ['model']),
      undeclared: codesFor(expression, null, ['model']),
      textOnly: codesFor(`const note = ${JSON.stringify(expression)};`, null, ['model']),
    }, {
      declared: [],
      undeclared: ['PCF_FEATURE_UNDECLARED'],
      textOnly: [],
    });
  });
}

const CALL = 'context.device.captureImage()';
const PROOF = 'typeof context.device?.captureImage === "function"';

function withinGuard(body) {
  return `if (${PROOF}) { ${body} }`;
}

const shadowingCases = [
  ['single arrow parameter', `contexts.forEach(context => ${CALL});`, `contexts.forEach(item => ${CALL});`],
  ['parenthesized arrow parameter', `contexts.forEach((context) => ${CALL});`, `contexts.forEach((item) => ${CALL});`],
  ['destructured arrow parameter', `contexts.forEach(({ context }) => ${CALL});`, `contexts.forEach(({ item }) => ${CALL});`],
  ['renamed destructured parameter', `contexts.forEach(({ current: context }) => ${CALL});`, `contexts.forEach(({ context: item }) => ${CALL});`, ['PCF_PAGES_API']],
  ['array parameter', `contexts.forEach(([context]) => ${CALL});`, `contexts.forEach(([item]) => ${CALL});`],
  ['defaulted parameter', `contexts.forEach((context = nextContext) => ${CALL});`, `contexts.forEach((item = context) => ${CALL});`, ['PCF_PAGES_API']],
  ['block arrow parameter', `contexts.forEach(context => { ${CALL}; });`, `contexts.forEach(item => { ${CALL}; });`],
  ['function expression parameter', `button.onclick = function(context) { ${CALL}; };`, `button.onclick = function(event) { ${CALL}; };`],
  ['function declaration parameter', `function handle(context) { ${CALL}; }`, `function handle(event) { ${CALL}; }`],
  ['object method parameter', `const handlers = { click(context) { ${CALL}; } };`, `const handlers = { click(event) { ${CALL}; } };`],
  ['class method parameter', `class Handler { click(context) { ${CALL}; } }`, `class Handler { click(event) { ${CALL}; } }`],
  ['typed method parameter', `class Handler { click(context: Context): void { ${CALL}; } }`, `class Handler { click(event: Event): void { ${CALL}; } }`],
  ['destructured local', `button.onclick = () => { const { context } = next; ${CALL}; };`, `button.onclick = () => { const { item } = next; ${CALL}; };`],
  ['second local declarator', `button.onclick = () => { const item = next, context = nextContext; ${CALL}; };`, `button.onclick = () => { const item = next, event = nextEvent; ${CALL}; };`],
  ['local captured by a nested closure', `button.onclick = () => { const context = next; button.onchange = () => ${CALL}; };`, `button.onclick = () => { const item = next; button.onchange = () => ${CALL}; };`],
  ...['let', 'const', 'var'].flatMap((kind) => [
    [`${kind} local before call`, `button.onclick = () => { ${kind} context = next; ${CALL}; };`, `button.onclick = () => { ${kind} item = next; ${CALL}; };`],
    [`${kind} local after call`, `button.onclick = () => { ${CALL}; ${kind} context = next; };`, `button.onclick = () => { ${CALL}; ${kind} item = next; };`],
  ]),
];

for (const [name, shadowed, captured, capturedCodes = []] of shadowingCases) {
  test(`Pages guard distinguishes ${name} from the guarded outer root`, () => {
    assert.deepEqual({
      shadowed: codesFor(withinGuard(shadowed)),
      captured: codesFor(withinGuard(captured)),
    }, {
      shadowed: ['PCF_PAGES_API'],
      captured: capturedCodes,
    });
  });
}

const writes = [
  ['root assignment', 'context = nextContext;'],
  ['assignment in an if condition', 'if (context = nextContext) { $CALL; }'],
  ['namespace assignment', 'context.device = nextDevice;'],
  ['bracket namespace assignment', 'context["device"] = nextDevice;'],
  ['namespace deletion', 'delete context.device;'],
  ['bracket namespace deletion', 'delete context["device"];'],
  ['method replacement', 'context.device.captureImage = nextMethod;'],
  ['bracket method deletion', 'delete context.device["captureImage"];'],
  ...['+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']
    .map((operator) => [`root compound ${operator}`, `context ${operator} nextContext;`]),
  ['namespace compound assignment', 'context.device ??= nextDevice;'],
  ['captured root assignment', 'button.onclick = () => { context = nextContext; $CALL; };'],
];

for (const [name, write] of writes) {
  test(`Pages guard expires after ${name} but not unrelated writes`, () => {
    const body = write.includes('$CALL') ? write.replace('$CALL', CALL) : `${write} ${CALL};`;
    assert.deepEqual({
      changed: codesFor(withinGuard(body)),
      unrelated: codesFor(withinGuard(`other = nextContext; context.other = nextValue; ${CALL};`)),
      comparisons: codesFor(withinGuard(`if (context === nextContext && context.device !== nextDevice) { ${CALL}; }`)),
      eventHandler: codesFor(withinGuard(`button.onclick = () => ${CALL};`)),
      differentParameter: codesFor(withinGuard(`contexts.forEach(item => ${CALL});`)),
    }, {
      changed: ['PCF_PAGES_API'],
      unrelated: [],
      comparisons: [],
      eventHandler: [],
      differentParameter: [],
    });
  });
}

test('Pages guard invalidates only subsequent calls and allows a new proof', () => {
  assert.deepEqual({
    beforeAndAfter: codesFor(withinGuard(`${CALL}; context = next; ${CALL};`)),
    afterNestedWrite: codesFor(withinGuard(`if (ready) { context.device = next; } ${CALL};`)),
    afterUnrelatedBlock: codesFor(withinGuard(`if (ready) { other = next; } ${CALL};`)),
    reproved: codesFor(withinGuard(`context = next; if (${PROOF}) { ${CALL}; }`)),
    independentCallbacks: codesFor(withinGuard(`button.onclick = (item) => { consume(item); }; button.onchange = () => ${CALL};`)),
  }, {
    beforeAndAfter: ['PCF_PAGES_API'],
    afterNestedWrite: ['PCF_PAGES_API'],
    afterUnrelatedBlock: [],
    reproved: [],
    independentCallbacks: [],
  });
});

test('Pages guard confines callback-local bindings and writes to that callback', () => {
  assert.deepEqual({
    parameter: codesFor(withinGuard(`contexts.forEach(context => { context = next; ${CALL}; }); ${CALL};`)),
    local: codesFor(withinGuard(`button.onclick = () => { const context = next; ${CALL}; }; ${CALL};`)),
    unrelatedNestedLocal: codesFor(withinGuard(`button.onclick = () => { const context = next; consume(context); }; button.onchange = () => ${CALL};`)),
    reprovedParameter: codesFor(withinGuard(`button.onclick = (context) => { if (${PROOF}) { ${CALL}; } };`)),
    reprovedFunction: codesFor(withinGuard(`button.onclick = function(context) { if (${PROOF}) { ${CALL}; } };`)),
    reprovedLocal: codesFor(withinGuard(`button.onclick = () => { const context = next; if (${PROOF}) { ${CALL}; } };`)),
    reprovedDestructuring: codesFor(withinGuard(`button.onclick = ({ context }) => { if (${PROOF}) { ${CALL}; } };`)),
  }, {
    parameter: ['PCF_PAGES_API'],
    local: ['PCF_PAGES_API'],
    unrelatedNestedLocal: [],
    reprovedParameter: [],
    reprovedFunction: [],
    reprovedLocal: [],
    reprovedDestructuring: [],
  });
});

test('Pages guard keeps callback parameter defaults local to that callback', () => {
  assert.deepEqual({
    arrow: codesFor(withinGuard(`contexts.forEach((context = next) => { ${CALL}; }); ${CALL};`)),
    destructured: codesFor(withinGuard(`contexts.forEach(({ context = next }) => { ${CALL}; }); ${CALL};`)),
    functionExpression: codesFor(withinGuard(`contexts.forEach(function(context = next) { ${CALL}; }); ${CALL};`)),
  }, {
    arrow: ['PCF_PAGES_API'],
    destructured: ['PCF_PAGES_API'],
    functionExpression: ['PCF_PAGES_API'],
  });
});

test('Pages utility guard expires after a protected prefix changes', () => {
  const proof = 'typeof context.utils?.lookupObjects === "function"';
  assert.deepEqual({
    changed: codesFor(`if (${proof}) { context.utils = next; context.utils.lookupObjects(); }`, 'Utility'),
    captured: codesFor(`if (${proof}) { button.onclick = () => context.utils.lookupObjects(); }`, 'Utility'),
  }, {
    changed: ['PCF_PAGES_API'],
    captured: [],
  });
});

for (const [name, parameters] of [
  ['typed arrow', '(context: Context): void'],
  ['typed async arrow', '(context: Context): Promise<void>'],
  ['generic typed arrow', '<T>(context: Context<T>): void'],
]) {
  test(`Pages guard rejects ${name} shadowing while retaining a captured root`, () => {
    assert.deepEqual({
      shadowed: codesFor(withinGuard(`button.onclick = ${parameters} => { ${CALL}; };`)),
      captured: codesFor(withinGuard(`button.onclick = ${parameters.replace('context:', 'event:')} => { ${CALL}; };`)),
    }, {
      shadowed: ['PCF_PAGES_API'],
      captured: [],
    });
  });
}

test('Pages guard rejects destructured and uninitialized root declarations', () => {
  assert.deepEqual({
    destructuredAssignment: codesFor(withinGuard(`({ context } = next); ${CALL};`)),
    arrayAssignment: codesFor(withinGuard(`[context] = next; ${CALL};`)),
    blockDeclaration: codesFor(withinGuard(`{ let context; ${CALL}; }`)),
    forBinding: codesFor(withinGuard(`for (const context of contexts) { ${CALL}; }`)),
    destructuredDeclaration: codesFor(withinGuard(`const { context } = holder; ${CALL};`)),
    unrelatedDestructuring: codesFor(withinGuard(`({ context: item } = next); ${CALL};`)),
  }, {
    destructuredAssignment: ['PCF_PAGES_API'],
    arrayAssignment: ['PCF_PAGES_API'],
    blockDeclaration: ['PCF_PAGES_API'],
    forBinding: ['PCF_PAGES_API'],
    destructuredDeclaration: ['PCF_PAGES_API'],
    unrelatedDestructuring: [],
  });
});

test('Pages guard ignores writes to a member named like the root', () => {
  assert.deepEqual({
    assignment: codesFor(withinGuard(`state.context = next; holder.context.device = next; ${CALL};`)),
    deletion: codesFor(withinGuard(`delete state.context; delete holder.context.device; ${CALL};`)),
  }, {
    assignment: [],
    deletion: [],
  });
});

test('Pages guard expires after destructured protected-prefix writes', () => {
  for (const write of [
    '({ current: context.device } = next);',
    '[context.device] = next;',
    '({ current: context["device"] } = next);',
    '({ current: context.device.captureImage } = next);',
  ]) {
    assert.deepEqual(codesFor(withinGuard(`${write} ${CALL};`)), ['PCF_PAGES_API'], write);
  }
  assert.deepEqual(codesFor(withinGuard(`({ current: state.context } = next); ${CALL};`)), []);
});

for (const [name, head] of [
  ['member if', 'helper.if'],
  ['optional member if', 'obj?.if'],
  ['spaced member if', 'obj . if'],
  ['comment-separated member if', 'obj /* member */ . /* name */ if'],
  ['dollar-prefixed identifier', '$if'],
]) {
  test(`Pages guard rejects ${name} rather than impersonating a statement`, () => {
    assert.deepEqual({
      impersonated: codesFor(`${head}(context.device?.captureImage)\n{ ${CALL}; }`),
      longerIdentifier: codesFor(`verifyIf(context.device?.captureImage)\n{ ${CALL}; }`),
      realIf: codesFor(withinGuard(`${CALL};`)),
      realElseIf: codesFor(`if (ready) { consume(); } else if (${PROOF}) { ${CALL}; }`),
      realElse: codesFor(`if (${PROOF}) { consume(); } else { ${CALL}; }`),
      innerElse: codesFor(withinGuard(`if (ready) { consume(); } else { ${CALL}; }`)),
    }, {
      impersonated: ['PCF_PAGES_API'],
      longerIdentifier: ['PCF_PAGES_API'],
      realIf: [],
      realElseIf: [],
      realElse: ['PCF_PAGES_API'],
      innerElse: [],
    });
  });
}

for (const [name, relative] of [
  ['development guide', 'AGENTS.md'],
  ['testing reference', path.join('references', 'pcf-testing.md')],
]) {
  test(`Pages ${name} states the static guard limits and required runtime evidence`, () => {
    const text = fs.readFileSync(path.resolve(__dirname, '..', '..', relative), 'utf8');
    assert.match(text, /static heuristic/i);
    assert.match(text, /source text/i);
    assert.match(text, /not a JavaScript parser/i);
    assert.match(text, /conservative/i);
    assert.match(text, /cannot prove[^.\n]*report/i);
    assert.match(text, /nested callbacks[^.\n]*rebind/i);
    assert.match(text, /shadowing[^.\n]*writing[^.\n]*ends the proof/i);
    assert.match(text, /unrecognized forms[^.\n]*reported[^.\n]*fail closed/i);
    assert.match(text, /computed member names/i);
    assert.match(text, /template-literal member names/i);
    assert.match(text, /aliasing[^.\n]*`const d = context\.device; d\.captureImage\(\)`/i);
    assert.match(text, /dynamic dispatch/i);
    assert.match(text, /parenthesized receivers/i);
    assert.match(text, /runtime verification on the target Power Pages site[^.\n]*required/i);
  });
}

for (const relative of [
  'AGENTS.md', path.join('references', 'pcf-testing.md'), path.join('references', 'pcf-best-practices.md'),
]) {
  test(`Pages documentation states context receivers, lexical proof expiry and fallback: ${relative}`, () => {
    const text = fs.readFileSync(path.resolve(__dirname, '..', '..', relative), 'utf8');
    assert.match(text, /this\._context/);
    assert.match(text, /props\.context/);
    assert.match(text, /\bctx\b/);
    assert.match(text, /pcfContext/);
    assert.match(text, /true-branch[^.\n]*positive method-level guard/i);
    assert.match(text, /early-return guards[^.\n]*reported/i);
    assert.match(text, /writ(?:e|ing)[^.\n]*before the call[^.\n]*ends the proof/i);
    assert.match(text, /PCF_CODE_UNPARSEABLE[^.\n]*warning/);
    assert.match(text, /Pages API calls[^.\n]*unguarded/i);
    assert.match(text, /aliases?[^\n]*may evade|aliasing[^\n]*may evade/i);
    assert.match(text, /computed[^.\n]*template-literal member names/i);
    assert.match(text, /dynamic dispatch/);
    assert.match(text, /parenthesized receivers/);
    assert.match(text, /runtime verification on the target Power Pages site[^.\n]*required/i);
  });
}

for (const [name, body, captured] of [
  ['catch parameter', `try { throw next; } catch (context) { ${CALL}; }`, `try { throw next; } catch (event) { ${CALL}; }`],
  ['destructured catch parameter', `try { throw next; } catch ({ context }) { ${CALL}; }`, `try { throw next; } catch ({ event }) { ${CALL}; }`],
  ['generator parameter', `const f = function*(context) { yield ${CALL}; };`, `const f = function*(event) { yield ${CALL}; };`],
  ['generic function parameter', `function f<T>(context: Context<T>) { ${CALL}; }`, `function f<T>(event: Event<T>) { ${CALL}; }`],
  ['string-named method parameter', `const h = { "click"(context) { ${CALL}; } };`, `const h = { "click"(event) { ${CALL}; } };`],
  ['generic class method parameter', `class H { click<T>(context: Context<T>) { ${CALL}; } }`, `class H { click<T>(event: Event<T>) { ${CALL}; } }`],
  ['object-return-typed arrow parameter', `const f = (context: Context): { done: boolean } => { ${CALL}; return { done: true }; };`, `const f = (event: Event): { done: boolean } => { ${CALL}; return { done: true }; };`],
  ['ASI local declaration', `button.onclick = () => { let context\n${CALL}; };`, `button.onclick = () => { let item\n${CALL}; };`],
  ['hoisted function declaration', `function context() {} ${CALL};`, `function handle() {} ${CALL};`],
  ['block-scoped class declaration', `class context {} ${CALL};`, `class Handler {} ${CALL};`],
  ['for-of root target', `for (context of contexts) { ${CALL}; }`, `for (item of items) { ${CALL}; }`],
  ['for-of var target', `for (var context of contexts) { ${CALL}; }`, `for (var item of items) { ${CALL}; }`],
  ['for-of protected prefix target', `for (context.device of devices) { ${CALL}; }`, `for (context.other of items) { ${CALL}; }`],
  ['postfix protected prefix decrement', `context.device--; ${CALL};`, `context.other--; ${CALL};`],
  ['prefix protected prefix increment', `++context.device; ${CALL};`, `++context.other; ${CALL};`],
]) {
  test(`Pages proof fails closed for ${name} and keeps unrelated bindings clean`, () => {
    assert.deepEqual({
      rebound: codesFor(withinGuard(body)),
      captured: codesFor(withinGuard(captured)),
    }, { rebound: ['PCF_PAGES_API'], captured: [] });
  });
}

test('Pages proof keeps a dollar-prefixed root assignment unrelated', () => {
  assert.deepEqual(codesFor(withinGuard(`$context = next; ${CALL};`)), []);
});

test('Pages proof limits a later loop-header declaration to its own statement', () => {
  assert.deepEqual(codesFor(withinGuard(`${CALL}; for (const context of contexts) { consume(context); }`)), []);
});

test('Pages proof uses Unicode identifier boundaries for roots and keywords', () => {
  const pi = '\u03c0';
  assert.deepEqual(codesFor(`${pi}if(context.device?.captureImage)\n{ ${CALL}; }`), ['PCF_PAGES_API']);
  for (const other of ['$context', '_context', 'context2', 'contextX', `${pi}context`, 'context\u200c', 'context\u200d', 'ctx.context']) {
    assert.deepEqual(codesFor(withinGuard(`${other} = next; ${CALL};`)), [], other);
    const detected = ['_context', 'ctx.context'].includes(other);
    assert.deepEqual(codesFor(`${other}.device.captureImage()`, null),
      detected ? ['PCF_FEATURE_UNDECLARED', 'PCF_PAGES_API'] : [], other);
  }
  for (const method of [`captureImage${pi}`, 'captureImage\u200c', 'captureImage\u200d', 'captureImage\u{10400}']) {
    assert.deepEqual(codesFor(`context.device.${method}()`, `Device.${method}`), ['PCF_PAGES_API'], method);
    assert.deepEqual(codesFor(`if (typeof context.device?.${method} === "function") { context.device.${method}(); }`, `Device.${method}`), [], method);
  }
});

const extraMemberSpellings = [
  ['root non-null assertion', 'context!.device.captureImage()'],
  ['namespace non-null assertion', 'context.device!.captureImage()'],
  ['method non-null assertion', 'context.device.captureImage!()'],
  ['non-null assertion before brackets', 'context!.device!["captureImage"]!()'],
  ['fixed Unicode escape', String.raw`context.device["capture\u0049mage"]()`],
  ['braced Unicode escape', String.raw`context.device["capture\u{49}mage"]()`],
  ['hex namespace escape', String.raw`context["\x64evice"].captureImage()`],
  ['escaped single-quoted key', String.raw`context.device['capture\u0049mage']()`],
  ['identity escape', String.raw`context.device["\captureImage"]()`],
  ['string line continuation', 'context.device["capture\\\nImage"]()'],
  ['fixed escape at key end', String.raw`context.device["captureImag\u0065"]()`],
  ['hex escape at key end', String.raw`context.device["captureImag\x65"]()`],
];

for (const [name, call] of extraMemberSpellings) {
  test(`Pages detection recognizes ${name} only for detection, not as a proof`, () => {
    assert.deepEqual({
      unguarded: codesFor(call),
      guarded: codesFor(withinGuard(`${call};`)),
      invalidGuard: codesFor(`if (ready || ${PROOF}) { ${call}; }`),
      undeclared: codesFor(call, null, ['model']),
      textOnly: codesFor(`// ${call.replace(/\n/g, '\n// ')}\nconst note = ${JSON.stringify(call)};`, null),
    }, {
      unguarded: ['PCF_PAGES_API'],
      guarded: [],
      invalidGuard: ['PCF_PAGES_API'],
      undeclared: ['PCF_FEATURE_UNDECLARED'],
      textOnly: [],
    });
  });
}

test('Pages detection never promotes non-null assertions or escaped keys into guard proofs', () => {
  for (const condition of [
    'typeof context!.device?.captureImage === "function"',
    'typeof context.device!?.captureImage === "function"',
    String.raw`typeof context.device["capture\u0049mage"] === "function"`,
  ]) {
    assert.deepEqual(codesFor(`if (${condition}) { ${CALL}; }`), ['PCF_PAGES_API'], condition);
  }
  for (const comparison of ['context.device.captureImage != other', 'context.device.captureImage !== other']) {
    assert.deepEqual(codesFor(withinGuard(`${comparison}; ${CALL};`)), [], comparison);
  }
  assert.deepEqual(codesFor(`if (!context.device?.captureImage) { ${CALL}; }`), ['PCF_PAGES_API']);
});

test('Pages detection decodes escapes without evaluating malformed or non-identifier keys', () => {
  for (const key of [
    String.raw`"capture\uZZZZImage"`, String.raw`"capture\u{110000}Image"`,
    String.raw`"capture\xZZImage"`, String.raw`"capture\nImage"`,
    String.raw`"capture\tImage"`, String.raw`"capture\\Image"`,
    String.raw`"capture\"Image"`, String.raw`"capture\0Image"`,
  ]) {
    assert.deepEqual(codesFor(`context.device[${key}]()`, null), [], key);
  }
});

test('Pages proof treats every root occurrence in a recognized head as a barrier', () => {
  for (const body of [
    `const f = (event = context) => { ${CALL}; };`,
    `const f = (event: context) => { ${CALL}; };`,
    `const f = <context>(event) => { ${CALL}; };`,
    `const h = { [context.name](event) { ${CALL}; } };`,
    `const h = { get value(): context { ${CALL}; } };`,
    `const f = function named(event = context) { ${CALL}; };`,
  ]) {
    assert.deepEqual(codesFor(withinGuard(body)), ['PCF_PAGES_API'], body);
  }
});

test('Pages proof crosses recognized root-free callbacks, methods and accessors', () => {
  for (const body of [
    `button.onclick = () => ${CALL};`,
    `items.forEach((item) => { ${CALL}; });`,
    `items.forEach(async (item: Item): Promise<void> => { await ${CALL}; });`,
    `const f = <T>(item: T): { done: boolean } => { ${CALL}; return { done: true }; };`,
    `const f = async item => ${CALL};`,
    `const h = { [key](event) { ${CALL}; }, 1(event) { ${CALL}; } };`,
    `const h = { get value() { ${CALL}; }, set value(item) { ${CALL}; } };`,
    `const h = { async *click<T>(event: Event<T>): Promise<void> { ${CALL}; } };`,
    `helper(context); ${CALL};`,
    `const other = context; ${CALL};`,
  ]) {
    assert.deepEqual(codesFor(withinGuard(body)), [], body);
  }
});

test('Pages proof rejects an unrecognized nested head instead of assuming capture', () => {
  const body = `handler ??? (event) { ${CALL}; }`;
  assert.deepEqual(codesFor(withinGuard(body)), ['PCF_PAGES_API']);
});

test('Pages proof indexes hoisted and lexical declarations before and after calls', () => {
  for (const body of [
    `${CALL}; function context() {}`,
    `${CALL}; class context {}`,
    `{ ${CALL}; let context\n}`,
    `button.onclick = () => { ${CALL}; if (ready) { var context = next; } };`,
    `${CALL}; for (var context of contexts) { consume(context); }`,
  ]) {
    assert.deepEqual(codesFor(withinGuard(body)), ['PCF_PAGES_API'], body);
  }
  for (const body of [
    `for (let context of contexts) { consume(context); } ${CALL};`,
    `for (const context of contexts) consume(context); ${CALL};`,
    `if (ready) { const context = next; consume(context); } ${CALL};`,
  ]) {
    assert.deepEqual(codesFor(withinGuard(body)), [], body);
  }
});

test('Pages proof tracks writes by function and preserves fresh proofs', () => {
  for (const write of [
    'context++', '--context', 'context.device++', '--context.device', 'context.device.captureImage--',
    'for (context in contexts) {}', 'for (context.device in devices) {}',
    String.raw`context["\x64evice"] = next`,
  ]) {
    assert.deepEqual(codesFor(withinGuard(`${CALL}; ${write}; ${CALL};`)), ['PCF_PAGES_API'], write);
    assert.deepEqual(codesFor(withinGuard(`${write}; button.onclick = () => ${CALL};`)), ['PCF_PAGES_API'], write);
    assert.deepEqual(codesFor(withinGuard(`${write}; if (${PROOF}) { ${CALL}; }`)), [], write);
  }
  assert.deepEqual(codesFor(withinGuard(`button.onclick = () => { context = next; }; ${CALL};`)), ['PCF_PAGES_API']);
});

test('Pages proof classifies wrapped assignment and update targets instead of assuming reads', () => {
  for (const write of [
    '(context) = next', '((context.device)) = next', '++(context.device)',
    '(context.device)--', 'delete ((context.device))', 'context.device! = next',
    '(context as Context) = next',
  ]) {
    assert.deepEqual(codesFor(withinGuard(`${CALL}; ${write}; ${CALL};`)), ['PCF_PAGES_API'], write);
    assert.deepEqual(codesFor(withinGuard(`${write}; if (${PROOF}) { ${CALL}; }`)), [], write);
  }
  for (const read of ['helper(context)', 'helper((context.device))', 'const other = (context)', 'const other = context.device!']) {
    assert.deepEqual(codesFor(withinGuard(`${read}; ${CALL};`)), [], read);
  }
});

test('Pages proof shares binding-pattern classification with loop targets', () => {
  assert.deepEqual(codesFor(withinGuard(`for ({ context } of contexts) {} ${CALL};`)), ['PCF_PAGES_API']);
  assert.deepEqual(codesFor(withinGuard(`for ({ current: context.device } of devices) {} ${CALL};`)), ['PCF_PAGES_API']);
  assert.deepEqual(codesFor(withinGuard(`for ({ context: item } of contexts) { consume(item); } ${CALL};`)), []);
});

test('Pages proof indexes root declarations even when their heads are unfamiliar', () => {
  for (const declaration of [
    'declare function context(): void;',
    '@decorate class context {}',
    'const item: Pair<A, B> = next, context = nextContext;',
  ]) {
    assert.deepEqual(codesFor(withinGuard(`${CALL}; ${declaration}`)), ['PCF_PAGES_API'], declaration);
  }
});

test('Pages proof recognizes root-free generic defaults and object-stored function expressions', () => {
  for (const body of [
    `const f = <T = Item>(event: T) => { ${CALL}; };`,
    `function f<T = Item>(event: T) { ${CALL}; }`,
    `const h = { click<T = Item>(event: T) { ${CALL}; } };`,
    `const h = { click: function(event) { ${CALL}; } };`,
    `const h = { click: function*(event) { yield ${CALL}; } };`,
  ]) {
    assert.deepEqual(codesFor(withinGuard(body)), [], body);
  }
});

test('Pages proof keeps block and catch-local writes away from the outer binding', () => {
  assert.deepEqual(codesFor(withinGuard(`try { throw next; } catch (context) { context = next; } ${CALL};`)), []);
  assert.deepEqual(codesFor(withinGuard(`{ let context = next; context.device = nextDevice; } ${CALL};`)), []);
});

test('Pages proof distinguishes postfix updates from a following ASI-separated call', () => {
  assert.deepEqual(codesFor(withinGuard(`other++\n${CALL}; ${CALL};`)), []);
  assert.deepEqual(codesFor(withinGuard(`other--\n${CALL}; ${CALL};`)), []);
});

test('Pages proof ends expression callback scopes at ASI boundaries', () => {
  assert.deepEqual(codesFor(withinGuard(`button.onclick = context => ${CALL}\n${CALL};`)), ['PCF_PAGES_API']);
  assert.deepEqual(codesFor(withinGuard(`button.onclick = () => context = next\n${CALL};`)), ['PCF_PAGES_API']);
});

test('Pages proof requires a recognized read or binding role for every root occurrence', () => {
  for (const body of [
    `${CALL}; await using context = holder;`,
    `context @ next; ${CALL};`,
  ]) {
    assert.deepEqual(codesFor(withinGuard(body)), ['PCF_PAGES_API'], body);
  }
  for (const read of ['helper(context)', 'const other = context', 'typeof context', 'void context', 'const other = context.device!']) {
    assert.deepEqual(codesFor(withinGuard(`${read}; ${CALL};`)), [], read);
  }
  assert.deepEqual(codesFor(withinGuard(`const h = { context: holder }; ${CALL};`)), []);
  assert.deepEqual(codesFor(withinGuard(`class H { private context: Context; click(item) { ${CALL}; } }`)), []);
  assert.deepEqual(codesFor(withinGuard(`const h = { if(item) { ${CALL}; } };`)), []);
});

for (const [name, body] of [
  ['function parameter', String.raw`const f = function(\u0063ontext) { ${CALL}; };`],
  ['method parameter', String.raw`const h = { "click"(\u0063ontext) { ${CALL}; } };`],
  ['catch parameter', String.raw`try { throw next; } catch (\u0063ontext) { ${CALL}; }`],
  ['future lexical declaration', String.raw`${CALL}; let \u0063ontext = next;`],
  ['assignment target', String.raw`\u0063ontext = next; ${CALL};`],
  ['hoisted declaration name', String.raw`function \u0063ontext() {} ${CALL};`],
]) {
  test(`Pages proof fails closed for unrecognized ${name} identifier syntax`, () => {
    assert.deepEqual(codesFor(withinGuard(body)), ['PCF_PAGES_API']);
  });
}

const THIS_CALL = 'this._ctx.device.captureImage()';
const THIS_PROOF = 'typeof this._ctx?.device?.captureImage === "function"';
test('Pages proof keeps lexical this in arrows but not rebinding functions or classes', () => {
  assert.deepEqual(codesFor(`if (${THIS_PROOF}) { el.addEventListener("click", function () { ${THIS_CALL}; }); }`), ['PCF_PAGES_API']);
  for (const body of [
    `${THIS_CALL};`,
    `el.addEventListener("click", () => ${THIS_CALL});`,
    `items.forEach(async (item: Item): Promise<void> => { await ${THIS_CALL}; });`,
  ]) {
    assert.deepEqual(codesFor(`if (${THIS_PROOF}) { ${body} }`), [], body);
  }
  for (const body of [
    `const h = { click() { ${THIS_CALL}; } };`,
    `const h = { get value() { ${THIS_CALL}; } };`,
    `class H { click = () => ${THIS_CALL}; }`,
    `this._ctx = next; ${THIS_CALL};`,
  ]) {
    assert.deepEqual(codesFor(`if (${THIS_PROOF}) { ${body} }`), ['PCF_PAGES_API'], body);
  }
  assert.match(findingsFor(THIS_CALL).find((finding) => finding.code === 'PCF_PAGES_API').message, /this\._ctx\?\.device\?\.captureImage/);
});

// These generous CI bounds distinguish indexed lookup from repeatedly scanning a guard's
// deeply nested body. The smaller realistic fixture also catches per-call scope rescans.
const NESTED_SCAN_LIMIT_MS = 1500;
const CONTROL_SCAN_LIMIT_MS = 500;

function timedScan(text) {
  const started = performance.now();
  const findings = [...scanSource(FILE, text), ...findingsFor(text)];
  return { elapsed: performance.now() - started, findings };
}

test('Pages proof indexes the 5000-line nested fixture without quadratic rescans', (t) => {
  const text = [
    `if (${PROOF}) {`,
    ...Array(8).fill(`${CALL};`),
    ...Array(2495).fill('run(() => {'),
    ...Array(2495).fill('});'),
    '}',
  ].join('\n');
  assert.equal(text.split('\n').length, 5000);
  const { elapsed, findings } = timedScan(text);
  t.diagnostic(`nested timing: ${elapsed.toFixed(3)} ms; ${Buffer.byteLength(text)} bytes`);
  assert.ok(elapsed < NESTED_SCAN_LIMIT_MS, `${elapsed.toFixed(3)} ms exceeds ${NESTED_SCAN_LIMIT_MS} ms`);
  assert.deepEqual(findings, []);
});

test('Pages proof indexes a 3000-line realistic control with 40 guarded calls', (t) => {
  const lines = ['class Control {', 'init(context: Context) {', `if (${PROOF}) {`];
  for (let i = 0; i < 40; i += 1) {
    lines.push('this.handlers.push((item: Item) => {', ...Array(70).fill('consume(item);'), `${CALL};`, '});');
  }
  while (lines.length < 2997) lines.push('consume(null);');
  lines.push('}', '}', '}');
  const text = lines.join('\n');
  assert.equal(lines.length, 3000);
  const { elapsed, findings } = timedScan(text);
  t.diagnostic(`control timing: ${elapsed.toFixed(3)} ms; 40 guarded calls`);
  assert.ok(elapsed < CONTROL_SCAN_LIMIT_MS, `${elapsed.toFixed(3)} ms exceeds ${CONTROL_SCAN_LIMIT_MS} ms`);
  assert.deepEqual(findings, []);
});

const DEFAULT_CALLBACK = 'function render(cb = () => { if (true) { return 1; } }) { return cb(); }';
const FOR_CHAIN = 'for(;;)'.repeat(8000) + 'consume(1);';
const EMPTY_MANIFEST = { features: [] };

for (const [name, text] of [
  ['parameter-default arrow with a nested block', DEFAULT_CALLBACK],
  ['deep for-statement chain', FOR_CHAIN],
  ['parameter-default function expression', 'function render(cb = function () { if (true) { return 1; } }) { return cb(); }'],
  ['parameter-default object method', 'function render(h = { click() { if (true) { return 1; } } }) { return h; }'],
  ['parameter-default class expression', 'function render(H = class { static { if (true) {} } }) { return H; }'],
  ['destructuring-default executable body', 'function render({ cb = () => { if (true) { return 1; } } } = {}) { return cb(); }'],
  ['computed-key executable body', 'const h = { [(() => { if (true) { return 1; } })()]() {} };'],
  ['extends-clause executable body', 'class H extends (() => { if (true) { return Base; } })() {}'],
  ['static-block executable body', 'class H { static { if (true) { consume(1); } } }'],
  ['field-initializer executable body', 'class H { field = (() => { if (true) { return 1; } })(); }'],
]) {
  for (const host of ['model', 'pages']) {
    test(`Source analysis never throws for ${name} on ${host}`, () => {
      assert.deepEqual(scanSource(FILE, text), []);
      assert.deepEqual(findingsFor(text, null, [host]), []);
      assert.deepEqual(gateSources({ manifestModel: EMPTY_MANIFEST, sources: [{ file: FILE, text }], hosts: [host] }),
        { ok: true, errors: [], warnings: [] });
    });
  }
}

test('Source analysis scopes parameter-default bodies without losing a separate valid guard', () => {
  const text = `${DEFAULT_CALLBACK}\n${withinGuard(`${CALL};`)}`;
  assert.deepEqual(scanSource(FILE, text), []);
  assert.deepEqual(findingsFor(text), []);
});

function throwingIndexer() {
  throw new Error('injected analyzer failure');
}

for (const host of ['model', 'pages']) {
  test(`Source analysis fails closed after an internal error on ${host}`, () => {
    const text = `${CALL};`;
    const options = { indexer: throwingIndexer };
    const sourceFindings = scanSource(FILE, text, options);
    assert.deepEqual(sourceFindings.map((finding) => finding.code), ['PCF_CODE_UNPARSEABLE']);
    assert.equal(sourceFindings[0].severity, 'warning');
    assert.equal(sourceFindings[0].file, FILE);
    assert.equal(sourceFindings[0].line, 1);
    assert.match(sourceFindings[0].message, /could not finish analyzing/i);
    assert.match(sourceFindings[0].message, /checks[^.]*analysis[^.]*skipped/i);
    assert.match(sourceFindings[0].message, /Pages API calls[^.]*unguarded/i);
    const featureFindings = findingsFor(text, 'Device.captureImage', [host], options);
    assert.deepEqual(featureFindings.map((finding) => finding.code), host === 'pages' ? ['PCF_PAGES_API'] : []);
    if (host === 'pages') {
      assert.equal(featureFindings[0].severity, 'error');
      assert.match(featureFindings[0].message, /guard could not be analyzed/i);
    }
    const gated = gateSources({ manifestModel: { features: [{ name: 'Device.captureImage' }] },
      sources: [{ file: FILE, text }], hosts: [host] }, options);
    assert.equal(gated.ok, host !== 'pages');
    assert.deepEqual(gated.warnings.map((finding) => finding.code), ['PCF_CODE_UNPARSEABLE']);
    assert.deepEqual(gated.errors.map((finding) => finding.code), host === 'pages' ? ['PCF_PAGES_API'] : []);
  });

  test(`API-free source emits only the scan warning after an internal error on ${host}`, () => {
    const text = 'const value = 1; consume(value);';
    const options = { indexer: throwingIndexer };
    assert.deepEqual(scanSource(FILE, text, options).map((finding) => finding.code), ['PCF_CODE_UNPARSEABLE']);
    assert.deepEqual(findingsFor(text, null, [host], options), []);
  });
}

test('Source analysis keeps every index-independent rule after an internal error', () => {
  const text = [
    'Xrm.Page(); window.parent; eval("x"); context.parameters.value.raw = 1;',
    'document.body; container.innerHTML = "x"; localStorage; context.page;',
    'const url = "/api/data/v9.2/accounts"; el.id = "fixed"; createRoot(container);',
  ].join('\n');
  assert.deepEqual(scanSource(FILE, text, { indexer: throwingIndexer, controlType: 'virtual' })
    .map((finding) => finding.code).sort(), [
    'PCF_CODE_DIRECT_API', 'PCF_CODE_EVAL', 'PCF_CODE_FIXED_ELEMENT_ID', 'PCF_CODE_HOST_DOM',
    'PCF_CODE_INNERHTML', 'PCF_CODE_INTERNAL_CONTEXT', 'PCF_CODE_PARENT_WINDOW',
    'PCF_CODE_RAW_ASSIGN', 'PCF_CODE_STORAGE', 'PCF_CODE_UNPARSEABLE', 'PCF_CODE_XRM', 'PCF_VIRTUAL_OWN_ROOT',
  ]);
});

test('Source fallback retains all used features and does not warn twice per file', () => {
  const text = 'props.context.device.captureImage(); this._ctx.utils.lookupObjects(); ctx.webAPI.retrieveRecord();';
  const options = { indexer: throwingIndexer };
  const manifestModel = { features: ['Device.captureImage', 'Utility', 'WebAPI'].map((name) => ({ name })) };
  const sources = [{ file: FILE, text }];
  const findings = featureCoherence(manifestModel, sources, ['pages'], options);
  assert.deepEqual(findings.map((finding) => finding.code), ['PCF_PAGES_API', 'PCF_PAGES_API']);
  assert.deepEqual(featureCoherence(EMPTY_MANIFEST, sources, ['model'], options)
    .map((finding) => finding.code), Array(3).fill('PCF_FEATURE_UNDECLARED'));
  assert.deepEqual(featureCoherence(manifestModel, sources, ['model'], options), []);
  const gated = gateSources({ manifestModel, sources, hosts: ['pages'] }, options);
  assert.equal(gated.warnings.length, 1);
  assert.equal(gated.errors.length, 2);
});

test('Source fallback uses only executable recognized references, including normalized static members', () => {
  const text = [
    `// ${CALL};`,
    `const note = ${JSON.stringify(`${CALL};`)};`,
    String.raw`props["context"]?.["device"]["capture\u0049mage"]!!();`,
    String.raw`cont\u0065xt.utils["lookupObjects"]();`,
    'const label = `${ctx.webAPI.retrieveRecord()}`;',
    'helpers.utils.lookupObjects(); this.device.captureImage();',
  ].join('\n');
  const manifestModel = { features: ['Device.captureImage', 'Utility', 'WebAPI'].map((name) => ({ name })) };
  const findings = featureCoherence(manifestModel, [{ file: FILE, text }], ['pages'], { indexer: throwingIndexer });
  assert.deepEqual(findings.map((finding) => finding.code), ['PCF_PAGES_API', 'PCF_PAGES_API']);
  assert.deepEqual(findings.map((finding) => finding.line), [3, 4]);
});

for (const call of [
  'this.utils.formatLabel();',
  'this.device.captureImage();',
  'this.state.device.formatLabel();',
  'this.props.utils.lookupObjects();',
  'helpers.utils.lookupObjects();',
]) {
  for (const host of ['model', 'pages']) {
    test(`Non-context receiver stays clean on ${host}: ${call}`, () => {
      assert.deepEqual(findingsFor(call, null, [host]), []);
      assert.deepEqual(findingsFor(call, null, [host], { indexer: throwingIndexer }), []);
    });
  }
}

for (const receiver of [
  'props.context', 'this.props.context', 'this._context', 'this._ctx', 'this.pcfContext', 'ctx',
  '_pcfContext', '__PCFCTX', 'holder.CTX', 'props["context"]', 'this["_ctx"]',
]) {
  test(`Context receiver is detected with its own same-path guard: ${receiver}`, () => {
    const call = `${receiver}.device.captureImage()`;
    assert.deepEqual(codesFor(`${call};`), ['PCF_PAGES_API']);
    const proofReceiver = receiver.replace(/\["(\w+)"\]/g, '.$1');
    const guarded = `if (typeof ${proofReceiver}.device?.captureImage === "function") { ${call}; }`;
    assert.deepEqual(codesFor(guarded), []);
    const fallback = findingsFor(guarded, 'Device.captureImage', ['pages'], { indexer: throwingIndexer });
    assert.deepEqual(fallback.map((finding) => finding.code), ['PCF_PAGES_API']);
  });
}

test('Context receiver preserves namespace and arbitrary method feature detection', () => {
  assert.deepEqual(codesFor('props.context.utils.lookupObjects();', null, ['model']), ['PCF_FEATURE_UNDECLARED']);
  assert.deepEqual(codesFor('context.device.formatLabel();', null, ['model']), ['PCF_FEATURE_UNDECLARED']);
  assert.deepEqual(codesFor('props.context.webAPI.retrieveRecord();', null, ['model']), ['PCF_FEATURE_UNDECLARED']);
});

test('Context guards prove only the same complete receiver path', () => {
  assert.deepEqual(codesFor(withinGuard('this._context.device.captureImage();')), ['PCF_PAGES_API']);
});

for (const [name, body] of [
  ['root write', 'props = next; props.context.device.captureImage();'],
  ['intermediate prefix write', 'props.context = next; props.context.device.captureImage();'],
  ['namespace write', 'props.context.device = next; props.context.device.captureImage();'],
  ['shadowed parameter', 'items.forEach(props => { props.context.device.captureImage(); });'],
  ['shadowed declaration', 'items.forEach(() => { let props = next; props.context.device.captureImage(); });'],
]) {
  test(`Context guard tracks a generalized root ${name}`, () => {
    assert.deepEqual(codesFor(`if (typeof props.context.device?.captureImage === "function") { ${body} }`), ['PCF_PAGES_API']);
  });
}

for (const [name, body] of [
  ['destructuring default', `const { image = (context.device = {}) } = {}; ${CALL};`],
  ['assignment-pattern default', `({ image = (context.device = {}) } = {}); ${CALL};`],
  ['computed method key', `const h = { [context.device = {}]() {} }; ${CALL};`],
  ['computed property key', `const h = { [context.device = {}]: value }; ${CALL};`],
  ['class extends clause', `class H extends (context.device = {}, Base) {} ${CALL};`],
  ['class static block', `class H { static { context.device = {}; } } ${CALL};`],
  ['class field initializer', `class H { field = (context.device = {}); } ${CALL};`],
  ['sibling callback prefix', `items.forEach(() => { context.device = undefined; }); ${CALL};`],
  ['sibling callback root', `const reset = () => { context = next; }; ${CALL};`],
  ['function parameter default', `function f(x = (context = next)) {} ${CALL};`],
  ['arrow parameter default', `const f = (x = (context.device = next)) => {}; ${CALL};`],
  ['destructured function parameter default', `function f({ x = (context = next) } = {}) {} ${CALL};`],
]) {
  test(`Pages proof expires after a same-binding write in a ${name}`, () => {
    assert.deepEqual(codesFor(withinGuard(body)), ['PCF_PAGES_API']);
  });
}

for (const [name, body] of [
  ['declaration pattern default read', `const { image = ${CALL} } = {};`],
  ['assignment pattern default read', `({ image = ${CALL} } = {});`],
  ['shadowed callback parameter write', `button.onclick = (context) => { context = next; }; ${CALL};`],
  ['shadowed callback local write', `items.forEach(() => { let context = other; context = next; }); ${CALL};`],
  ['shadowed callback var write', `items.forEach(() => { context = next; var context; }); ${CALL};`],
  ['shadowed catch pattern default write', `try {} catch ({ context }) { context = next; } ${CALL};`],
  ['shadowed function parameter default write', `function f(context = (context = next)) {} ${CALL};`],
  ['shadowed nested function name write', `function f() { function context() {} context = next; } ${CALL};`],
  ['shadowed nested class name write', `{ class context {} context = next; } ${CALL};`],
  ['shadowed static-block var write', `class H { static { var context = other; context = next; } } ${CALL};`],
  ['shadowed static-block function name write', `class H { static { function context() {} context = next; } } ${CALL};`],
  ['private class name write in its heritage', `const H = class context extends (context = next, Base) {}; ${CALL};`],
  ['private class name captured in its heritage', `const H = class context extends (() => { context = next; return Base; })() {}; ${CALL};`],
  ['dollar-prefixed name write', `$context = next; ${CALL};`],
  ['member names like the guarded root', `state.context = next; holder.context.device = next; ${CALL};`],
  ['root argument and alias reads', `helper(context); const other = context; ${CALL};`],
]) {
  test(`Pages proof retains a guard for ${name}`, () => {
    assert.deepEqual(codesFor(withinGuard(body)), []);
  });
}

for (const [name, call, plainCall = CALL, proof = PROOF] of [
  ['method non-null run', 'context.device.captureImage!!()'],
  ['root and namespace non-null runs', 'context!!!.device!!?.captureImage!!()'],
  ['fixed member identifier escape', String.raw`context.device.capture\u0049mage()`],
  ['braced member identifier escape', String.raw`context.device.capture\u{49}mage()`],
  ['fixed root identifier escape', String.raw`cont\u0065xt.device.captureImage()`],
  ['braced root identifier escape', String.raw`cont\u{65}xt.device.captureImage()`],
  ['escaped generalized receiver', String.raw`props.cont\u0065xt.device.captureImage()`,
    'props.context.device.captureImage()', 'typeof props.context.device?.captureImage === "function"'],
]) {
  test(`Pages detection normalizes ${name} without granting new proof syntax`, () => {
    const guarded = `if (${proof}) { ${call}; }`;
    assert.deepEqual(codesFor(`${call};`), ['PCF_PAGES_API']);
    assert.deepEqual(codesFor(guarded), []);
    assert.deepEqual(codesFor(`${call};`, null, ['model']), ['PCF_FEATURE_UNDECLARED']);
    assert.deepEqual(findingsFor(guarded, 'Device.captureImage', ['pages'], { indexer: throwingIndexer })
      .map((finding) => finding.code), ['PCF_PAGES_API']);
    const condition = `typeof ${call.replace(/\(\)$/, '')} === "function"`;
    assert.deepEqual(codesFor(`if (${condition}) { ${plainCall}; }`), ['PCF_PAGES_API']);
  });
}

test('Pages detection ignores invalid identifier escapes without throwing', () => {
  for (const call of [
    String.raw`context.device.capture\uZZZZmage()`,
    String.raw`context.device.capture\u{110000}mage()`,
    String.raw`cont\uZZZZxt.device.captureImage()`,
    String.raw`cont\u{D800}xt.device.captureImage()`,
  ]) {
    assert.deepEqual(findingsFor(call, null), [], call);
    assert.deepEqual(scanSource(FILE, call), [], call);
  }
});

for (const [name, separator] of [['line separator', '\u2028'], ['paragraph separator', '\u2029']]) {
  test(`Pages proof recognizes ${name} as ASI after a declaration`, () => {
    assert.deepEqual(codesFor(withinGuard(`let context${separator}${CALL};`)), ['PCF_PAGES_API']);
  });
  test(`Pages proof recognizes ${name} before a prefix update`, () => {
    assert.deepEqual(codesFor(withinGuard(`counter${separator}++context.device; ${CALL};`)), ['PCF_PAGES_API']);
    assert.deepEqual(codesFor(withinGuard(`counter${separator}++total; ${CALL};`)), []);
  });
}

test('Source findings count all ECMAScript line terminators without double-counting CRLF', () => {
  for (const separator of ['\n', '\r', '\r' + '\n', '\u2028', '\u2029']) {
    const text = `consume(1);${separator}Xrm.Page(); ${CALL};`;
    assert.equal(scanSource(FILE, text)[0].line, 2);
    assert.equal(findingsFor(text)[0].line, 2);
  }
});

test('Source analysis never throws on truncated plugin source and unbalanced guards', (t) => {
  const plugin = path.resolve(__dirname, '..', '..');
  const pending = [plugin];
  const errors = [];
  let variants = 0;
  const check = (file, text) => {
    for (const host of ['model', 'pages']) {
      for (const [label, analyze] of [
        ['scanSource', () => scanSource(file, text)],
        ['featureCoherence', () => featureCoherence(EMPTY_MANIFEST, [{ file, text }], [host])],
        ['gateSources', () => gateSources({ manifestModel: EMPTY_MANIFEST, sources: [{ file, text }], hosts: [host] })],
      ]) {
        try { analyze(); } catch (err) { errors.push(`${file} ${host} ${label}: ${err.stack}`); }
      }
    }
    variants += 1;
  };
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') pending.push(file);
      else if (entry.isFile() && /\.(?:tsx?|tmpl)$/.test(entry.name)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const fraction of [0.25, 0.5, 0.75]) check(file, text.slice(0, Math.floor(text.length * fraction)));
      }
    }
  }
  for (const opener of ['{', '(', '[', '`', '/*']) {
    check(`unbalanced-${JSON.stringify(opener)}.ts`, opener + withinGuard(`${CALL};`));
    check(`truncated-${JSON.stringify(opener)}.ts`, withinGuard(opener + `${CALL};`));
  }
  t.diagnostic(`robustness sweep: ${variants} source variants, ${variants * 6} entry-point/host checks`);
  assert.deepEqual(errors, []);
});

test('Pages proof traverses input-sized positive conjunction nesting iteratively', () => {
  const text = `if (${'ready && ('.repeat(8000)}${PROOF}${')'.repeat(8000)}) { ${CALL}; }`;
  assert.deepEqual(scanSource(FILE, text), []);
  assert.deepEqual(findingsFor(text), []);
});

test('Fixed-id detection keeps later JSX after unmatched braces and inside template expressions', () => {
  for (const text of [
    'const value = a<{ broken; const node = <div id="fixed" />;',
    'const note = `prefix ${<div id="fixed" />} suffix`;',
    '<div title={">"} id="fixed" />',
    '<div title={"\\\" >"} id="fixed" />',
  ]) {
    assert.deepEqual(scanSource(FILE, text).map((finding) => finding.code), ['PCF_CODE_FIXED_ELEMENT_ID'], text);
  }
});

// Pathological but finite input should stay bounded; CI runners can be much slower
// than the local median target, so this catches rescans without enforcing machine speed.
const PATHOLOGICAL_SCAN_LIMIT_MS = 1500;

test('Pages diagnostics index line locations instead of rescanning per call', (t) => {
  const count = 4000;
  const text = `${CALL};\n`.repeat(count);
  const { elapsed, findings } = timedScan(text);
  t.diagnostic(`line-location timing: ${elapsed.toFixed(3)} ms; ${count} calls`);
  assert.ok(elapsed < PATHOLOGICAL_SCAN_LIMIT_MS, `${elapsed.toFixed(3)} ms exceeds ${PATHOLOGICAL_SCAN_LIMIT_MS} ms`);
  assert.equal(findings.length, count);
  assert.ok(findings.every((finding, i) => finding.code === 'PCF_PAGES_API' && finding.line === i + 1));
});

for (const [name, text, feature] of [
  ['10000 unmatched angles', 'const value = ' + 'a<'.repeat(10000), null],
  ['8000 guard parentheses', `if (${'('.repeat(8000)}${PROOF}${')'.repeat(8000)}) { ${CALL}; }`, 'Device.captureImage'],
  ['8000 nested for statements', FOR_CHAIN, null],
]) {
  test(`Source analysis bounds ${name}`, (t) => {
    const started = performance.now();
    const findings = [...scanSource(FILE, text), ...findingsFor(text, feature)];
    const elapsed = performance.now() - started;
    t.diagnostic(`${name} timing: ${elapsed.toFixed(3)} ms`);
    assert.ok(elapsed < PATHOLOGICAL_SCAN_LIMIT_MS, `${elapsed.toFixed(3)} ms exceeds ${PATHOLOGICAL_SCAN_LIMIT_MS} ms`);
    assert.deepEqual(findings, []);
  });
}
