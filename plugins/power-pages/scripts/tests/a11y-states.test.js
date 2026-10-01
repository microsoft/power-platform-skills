const assert = require('node:assert/strict');
const test = require('node:test');

const { LIMITS, StatesFileError, applyState, loadStatesFile, validateStates } = require('../lib/a11y/states');

test('validateStates normalizes a valid file', () => {
  const states = validateStates({
    states: [
      { route: '/', label: 'Menu open', viewport: 'mobile', steps: [{ action: 'click', role: 'button', name: 'Menu' }] },
      { route: '/contact', label: 'Errors', steps: [
        { action: 'focus', role: 'textbox', name: 'Email', exact: false },
        { action: 'press', key: 'Tab' },
        { action: 'wait', ms: 200 },
      ] },
    ],
  });
  assert.deepEqual(states[0], { route: '/', label: 'Menu open', viewport: 'mobile', steps: [{ action: 'click', role: 'button', name: 'Menu', exact: true }] });
  assert.equal(states[1].viewport, null);
  assert.deepEqual(states[1].steps, [
    { action: 'focus', role: 'textbox', name: 'Email', exact: false },
    { action: 'press', key: 'Tab' },
    { action: 'wait', ms: 200 },
  ]);
});

for (const [name, data, pattern] of [
  ['non-object', null, /"states" array/],
  ['no states array', { states: {} }, /"states" array/],
  ['route without slash', { states: [{ route: 'x', label: 'a', steps: [{ action: 'wait', ms: 1 }] }] }, /route must start/],
  ['missing label', { states: [{ route: '/', steps: [{ action: 'wait', ms: 1 }] }] }, /"label"/],
  ['bad viewport', { states: [{ route: '/', label: 'a', viewport: 'tv', steps: [{ action: 'wait', ms: 1 }] }] }, /viewport/],
  ['no steps', { states: [{ route: '/', label: 'a', steps: [] }] }, /steps must be/],
  ['unknown action', { states: [{ route: '/', label: 'a', steps: [{ action: 'type', role: 'textbox', name: 'x' }] }] }, /action must be/],
  ['long wait', { states: [{ route: '/', label: 'a', steps: [{ action: 'wait', ms: LIMITS.waitMs + 1 }] }] }, /wait "ms"/],
  ['click without name', { states: [{ route: '/', label: 'a', steps: [{ action: 'click', role: 'button' }] }] }, /"name"/],
  ['press without key', { states: [{ route: '/', label: 'a', steps: [{ action: 'press' }] }] }, /"key"/],
  ['too many states', { states: Array.from({ length: LIMITS.states + 1 }, () => ({})) }, /At most/],
]) {
  test(`validateStates rejects ${name}`, () => {
    assert.throws(() => validateStates(data), (err) => err instanceof StatesFileError && pattern.test(err.message));
  });
}

test('loadStatesFile wraps JSON errors', () => {
  assert.throws(() => loadStatesFile('x.json', { readFile: () => '{nope' }), StatesFileError);
});

// Minimal Playwright page/locator fake that records actions and lets each test choose
// what the located element looks like for the form-submit guard.
function fakePage({ descriptor = { tag: 'button', type: 'button', inForm: false }, visible = true, activeInForm = false } = {}) {
  const actions = [];
  const locator = {
    async waitFor() { if (!visible) throw new Error('Timeout 10000ms exceeded'); },
    async evaluate(fn) {
      return fn.toString().includes('closest') && !fn.toString().includes('tagName') ? descriptor.inForm : descriptor;
    },
    async click() { actions.push('click'); },
    async hover() { actions.push('hover'); },
    async focus() { actions.push('focus'); },
    async blur() { actions.push('blur'); },
    async press(key) { actions.push(`press:${key}`); },
  };
  return {
    actions,
    getByRole(role, opts) { actions.push(`find:${role}:${opts.name}:${opts.exact}`); return { first: () => locator }; },
    keyboard: { async press(key) { actions.push(`key:${key}`); } },
    async evaluate() { return activeInForm; },
    async waitForTimeout() {},
  };
}

const state = (steps) => ({ route: '/', label: 's', viewport: null, steps });

test('applyState performs steps in order', async () => {
  const page = fakePage();
  await applyState(page, state([
    { action: 'click', role: 'button', name: 'Menu', exact: true },
    { action: 'press', key: 'Escape' },
  ]), {});
  assert.deepEqual(page.actions, ['find:button:Menu:true', 'click', 'key:Escape']);
});

test('applyState refuses to click a submit button unless allowed', async () => {
  const submit = { tag: 'button', type: null, inForm: true };
  await assert.rejects(
    applyState(fakePage({ descriptor: submit }), state([{ action: 'click', role: 'button', name: 'Send', exact: true }]), {}),
    /Refusing to click "Send"/,
  );
  const page = fakePage({ descriptor: submit });
  await applyState(page, state([{ action: 'click', role: 'button', name: 'Send', exact: true }]), { allowFormSubmit: true });
  assert.ok(page.actions.includes('click'));
});

test('applyState refuses Enter inside a form', async () => {
  await assert.rejects(
    applyState(fakePage({ activeInForm: true }), state([{ action: 'press', key: 'Enter' }]), {}),
    /Refusing to press Enter/,
  );
  await assert.rejects(
    applyState(fakePage({ descriptor: { tag: 'input', type: 'email', inForm: true } }), state([{ action: 'press', role: 'textbox', name: 'Email', exact: true, key: 'Enter' }]), {}),
    /Refusing to press Enter/,
  );
});

test('applyState explains a missing control', async () => {
  await assert.rejects(
    applyState(fakePage({ visible: false }), state([{ action: 'click', role: 'button', name: 'Nope', exact: true }]), { timeoutMs: 50 }),
    /Could not find a visible button named "Nope"/,
  );
});
