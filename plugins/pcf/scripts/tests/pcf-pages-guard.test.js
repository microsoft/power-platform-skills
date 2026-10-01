'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { featureCoherence } = require('../lib/pcf-code-gate.js');

const FILE = 'src/pages-control.ts';

function findingsFor(text, feature = 'Device.captureImage', hosts = ['pages']) {
  return featureCoherence({
    features: feature ? [{ name: feature }] : [],
  }, [{ file: FILE, text }], hosts);
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
  ['renamed destructured parameter', `contexts.forEach(({ current: context }) => ${CALL});`, `contexts.forEach(({ context: item }) => ${CALL});`],
  ['array parameter', `contexts.forEach(([context]) => ${CALL});`, `contexts.forEach(([item]) => ${CALL});`],
  ['defaulted parameter', `contexts.forEach((context = nextContext) => ${CALL});`, `contexts.forEach((item = context) => ${CALL});`],
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

for (const [name, shadowed, captured] of shadowingCases) {
  test(`Pages guard distinguishes ${name} from the guarded outer root`, () => {
    assert.deepEqual({
      shadowed: codesFor(withinGuard(shadowed)),
      captured: codesFor(withinGuard(captured)),
    }, {
      shadowed: ['PCF_PAGES_API'],
      captured: [],
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
    unrelatedDestructuring: codesFor(withinGuard(`({ context: item } = next); ${CALL};`)),
  }, {
    destructuredAssignment: ['PCF_PAGES_API'],
    arrayAssignment: ['PCF_PAGES_API'],
    blockDeclaration: ['PCF_PAGES_API'],
    forBinding: ['PCF_PAGES_API'],
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
    assert.match(text, /computed member names/i);
    assert.match(text, /aliasing[^.\n]*`const d = context\.device; d\.captureImage\(\)`/i);
    assert.match(text, /dynamic dispatch/i);
    assert.match(text, /runtime verification on the target Power Pages site[^.\n]*required/i);
  });
}
