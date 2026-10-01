const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LIMITS, StatesFileError, activationKey, applyState, guardMutations, isMutatingRequest, loadStatesFile, submitRefusal, validateStates,
} = require('../lib/a11y/states');

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
  assert.deepEqual(states[0], { route: '/', label: 'Menu open', viewport: 'mobile', allowFormSubmit: false, steps: [{ action: 'click', role: 'button', name: 'Menu', exact: true }] });
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
  ['protocol-relative route', { states: [{ route: '//example.com/x', label: 'a', steps: [{ action: 'wait', ms: 1 }] }] }, /protocol-relative/],
  ['backslash route', { states: [{ route: '/\\example.com', label: 'a', steps: [{ action: 'wait', ms: 1 }] }] }, /must not contain/],
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
// what the located element (descriptor) and the focused element (active) look like
// for the form-submit guard.
function fakePage({ descriptor = { tag: 'button', type: 'button', inForm: false }, visible = true, active = { tag: 'body', type: null, inForm: false } } = {}) {
  const actions = [];
  const locator = {
    async waitFor() { if (!visible) throw new Error('Timeout 10000ms exceeded'); },
    async evaluate() { return descriptor; },
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
    async evaluate() { return active; },
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
    applyState(fakePage({ active: { tag: 'input', type: 'text', inForm: true } }), state([{ action: 'press', key: 'Enter' }]), {}),
    /Refusing to press Enter/,
  );
  await assert.rejects(
    applyState(fakePage({ descriptor: { tag: 'input', type: 'email', inForm: true } }), state([{ action: 'press', role: 'textbox', name: 'Email', exact: true, key: 'Enter' }]), {}),
    /Refusing to press Enter/,
  );
  const page = fakePage();
  await applyState(page, state([{ action: 'press', key: 'Enter' }]), {});
  assert.deepEqual(page.actions, ['key:Enter'], 'Enter with nothing focused in a form is allowed');
});

test('applyState refuses Space on a focused submit button', async () => {
  const submit = { tag: 'button', type: 'submit', inForm: true };
  for (const key of [' ', 'Space', 'Shift+Space']) {
    await assert.rejects(
      applyState(fakePage({ active: submit }), state([{ action: 'press', key }]), {}),
      /Refusing to press Space on a submit button/,
    );
  }
  await assert.rejects(
    applyState(fakePage({ descriptor: submit }), state([{ action: 'press', role: 'button', name: 'Send', exact: true, key: 'Space' }]), {}),
    /--allow-form-submit/,
  );
  const page = fakePage({ active: submit });
  await applyState(page, state([{ action: 'press', key: 'Space' }]), { allowFormSubmit: true });
  assert.deepEqual(page.actions, ['key:Space']);
});

test('activationKey normalizes key names and chords', () => {
  assert.equal(activationKey('Enter'), 'enter');
  assert.equal(activationKey('NumpadEnter'), 'enter');
  assert.equal(activationKey('Shift+Enter'), 'enter');
  assert.equal(activationKey(' '), 'space');
  assert.equal(activationKey('Control+Space'), 'space');
  assert.equal(activationKey('Tab'), null);
  assert.equal(activationKey('Escape'), null);
  assert.equal(activationKey('+'), null);
});

test('submitRefusal decides per action, key and target', () => {
  const text = { tag: 'input', type: 'text', inForm: true };
  const submit = { tag: 'button', type: null, inForm: true };
  const plain = { tag: 'button', type: 'button', inForm: true };
  assert.match(submitRefusal({ action: 'click', name: 'Go' }, submit), /click "Go"/);
  assert.equal(submitRefusal({ action: 'click', name: 'Menu' }, plain), null);
  assert.match(submitRefusal({ action: 'press', key: 'Enter' }, text), /Enter/);
  assert.equal(submitRefusal({ action: 'press', key: 'Space' }, text), null, 'Space in a text field types a space');
  assert.equal(submitRefusal({ action: 'press', key: 'Space' }, plain), null);
  assert.match(submitRefusal({ action: 'press', key: 'Space' }, submit), /Space/);
  assert.equal(submitRefusal({ action: 'press', key: 'Tab' }, submit), null);
  assert.equal(submitRefusal({ action: 'hover' }, submit), null);
});

test('isMutatingRequest allows reads and the list-grid data POST', () => {
  assert.equal(isMutatingRequest('GET', 'https://contoso.powerappsportals.com/_api/accounts'), false);
  assert.equal(isMutatingRequest('head', 'https://contoso.powerappsportals.com/'), false);
  assert.equal(isMutatingRequest('OPTIONS', 'https://contoso.powerappsportals.com/_api/x'), false);
  const origin = 'https://contoso.powerappsportals.com';
  assert.equal(isMutatingRequest('POST', 'https://contoso.powerappsportals.com/_services/entity-grid-data.json/00000000-0000-0000-0000-000000000000', origin), false);
  // The exemption is bound to the audited origin: the same path on another host, or a
  // call that doesn't say which origin is audited, is still treated as a write.
  assert.equal(isMutatingRequest('POST', 'https://attacker.example/_services/entity-grid-data.json/1', origin), true);
  assert.equal(isMutatingRequest('POST', 'https://contoso.powerappsportals.com/_services/entity-grid-data.json/1'), true);
  assert.equal(isMutatingRequest('POST', 'https://contoso.powerappsportals.com/_api/contacts'), true);
  assert.equal(isMutatingRequest('PATCH', 'https://contoso.powerappsportals.com/_api/contacts(1)'), true);
  assert.equal(isMutatingRequest('DELETE', 'https://contoso.powerappsportals.com/_api/contacts(1)'), true);
  assert.equal(isMutatingRequest('POST', 'not a url'), true);
});

// Fake page.route/unroute that lets a test push requests through the installed handler.
function routingPage() {
  const routes = [];
  return {
    routes,
    async route(pattern, handler) { routes.push({ pattern, handler }); },
    async unroute(pattern, handler) {
      const i = routes.findIndex((r) => r.pattern === pattern && r.handler === handler);
      if (i >= 0) routes.splice(i, 1);
    },
    async send(method, url) {
      let outcome = 'unrouted';
      for (const r of routes) {
        await r.handler({
          request: () => ({ method: () => method, url: () => url }),
          continue: async () => { outcome = 'continued'; },
          abort: async (code) => { outcome = `aborted:${code}`; },
        });
      }
      return outcome;
    },
  };
}

test('guardMutations blocks writes during a state and records only origin + path', async () => {
  const page = routingPage();
  const guard = await guardMutations(page, { origin: 'https://contoso.powerappsportals.com' });
  assert.equal(await page.send('GET', 'https://contoso.powerappsportals.com/page?x=1'), 'continued');
  assert.equal(await page.send('POST', 'https://contoso.powerappsportals.com/_services/entity-grid-data.json/1'), 'continued');
  assert.equal(await page.send('POST', 'https://contoso.powerappsportals.com/contact-us?token=secret'), 'aborted:blockedbyclient');
  assert.equal(await page.send('DELETE', 'https://contoso.powerappsportals.com/_api/contacts(1)'), 'aborted:blockedbyclient');
  assert.equal(guard.blocked.count, 2);
  assert.deepEqual(guard.blocked.requests, [
    { method: 'POST', url: 'https://contoso.powerappsportals.com/contact-us' },
    { method: 'DELETE', url: 'https://contoso.powerappsportals.com/_api/contacts(1)' },
  ]);
  await guard.dispose();
  assert.equal(page.routes.length, 0, 'dispose removes the route');
  assert.equal(await page.send('POST', 'https://contoso.powerappsportals.com/contact-us'), 'unrouted');
});

test('guardMutations caps recorded samples but keeps counting', async () => {
  const page = routingPage();
  const guard = await guardMutations(page, {});
  for (let i = 0; i < 25; i++) await page.send('POST', `https://contoso.powerappsportals.com/p${i}`);
  assert.equal(guard.blocked.count, 25);
  assert.equal(guard.blocked.requests.length, 20);
});

test('guardMutations is a no-op with --allow-form-submit', async () => {
  const page = routingPage();
  const guard = await guardMutations(page, { allowFormSubmit: true });
  assert.equal(page.routes.length, 0);
  assert.deepEqual(guard.blocked, { count: 0, requests: [] });
  await guard.dispose();
});

test('applyState explains a missing control', async () => {
  await assert.rejects(
    applyState(fakePage({ visible: false }), state([{ action: 'click', role: 'button', name: 'Nope', exact: true }]), { timeoutMs: 50 }),
    /Could not find a visible button named "Nope"/,
  );
});

test('validateStates accepts a boolean allowFormSubmit and rejects anything else', () => {
  const state = (extra) => ({ states: [{ route: '/', label: 'a', steps: [{ action: 'wait', ms: 1 }], ...extra }] });
  assert.equal(validateStates(state({}))[0].allowFormSubmit, false);
  assert.equal(validateStates(state({ allowFormSubmit: false }))[0].allowFormSubmit, false);
  assert.equal(validateStates(state({ allowFormSubmit: true }))[0].allowFormSubmit, true);
  for (const value of ['true', 1, null, {}]) {
    assert.throws(() => validateStates(state({ allowFormSubmit: value })), (err) => err instanceof StatesFileError && /allowFormSubmit/.test(err.message));
  }
});

test('guardMutations blocks a cross-origin list-grid POST', async () => {
  const page = routingPage();
  const guard = await guardMutations(page, { origin: 'https://contoso.powerappsportals.com' });
  assert.equal(await page.send('POST', 'https://attacker.example/_services/entity-grid-data.json/1'), 'aborted:blockedbyclient');
  assert.equal(guard.blocked.count, 1);
  await guard.dispose();
});
