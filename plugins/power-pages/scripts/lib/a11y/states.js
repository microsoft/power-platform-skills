'use strict';

// Interaction states: replay a short list of steps (open the menu, switch a tab,
// open a dialog) and run axe on the result, so content that only exists after a
// click is audited too.
//
// States file format (written by the calling agent from discover-mode candidates):
//   {
//     "states": [
//       { "route": "/", "label": "Mobile menu open", "viewport": "mobile",
//         "steps": [ { "action": "click", "role": "button", "name": "Menu" } ] },
//       { "route": "/contact", "label": "Validation errors",
//         "steps": [ { "action": "focus", "role": "textbox", "name": "Email" },
//                    { "action": "press", "key": "Tab" } ] }
//     ]
//   }
// Elements are located by role + accessible name (getByRole) rather than CSS so a
// state keeps working after unrelated markup changes, and because a control the
// agent cannot name by role is itself an accessibility defect.
//
// Safety: an audit must never change data. Steps that would submit a form are
// refused unless --allow-form-submit is passed explicitly, because a Power Pages
// form submit writes a Dataverse record (and may send email) on a live site. The step
// guard only sees the control a step targets, and page scripts can still send data
// on any click (fetch/XHR, Web API calls), so guardMutations() adds a network-level
// backstop that aborts state-changing requests while a state is replayed.

const fs = require('node:fs');
const { VIEWPORTS } = require('./args');
const { isSubmitLikeDescriptor } = require('./checks/inventory');

const ACTIONS = Object.freeze(['click', 'hover', 'focus', 'blur', 'press', 'wait']);
const LIMITS = Object.freeze({ states: 100, steps: 20, waitMs: 10000, text: 200 });

// RFC 9110 §9.2.1 safe methods: by definition they do not change server state.
// https://www.rfc-editor.org/rfc/rfc9110#section-9.2.1
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Power Pages list (entity grid) controls page and sort through a POST that only
// reads rows, e.g. POST /_services/entity-grid-data.json/<website-id>. Blocking it
// would leave a "next page" or "sort" state empty, so it is the one POST let through.
const READ_ONLY_POST_PATHS = Object.freeze([/^\/_services\/entity-grid-data\.json(\/|$)/i]);
const MAX_BLOCKED_SAMPLES = 20;

class StatesFileError extends Error {}

function str(value, field, where) {
  if (typeof value !== 'string' || !value.trim()) throw new StatesFileError(`${where}: "${field}" must be a non-empty string`);
  if (value.length > LIMITS.text) throw new StatesFileError(`${where}: "${field}" is longer than ${LIMITS.text} characters`);
  return value;
}

function validateStep(step, where) {
  if (!step || typeof step !== 'object') throw new StatesFileError(`${where}: step must be an object`);
  if (!ACTIONS.includes(step.action)) throw new StatesFileError(`${where}: action must be one of ${ACTIONS.join(', ')}`);
  const out = { action: step.action };
  if (step.action === 'wait') {
    const ms = step.ms;
    if (!Number.isInteger(ms) || ms < 0 || ms > LIMITS.waitMs) throw new StatesFileError(`${where}: wait "ms" must be an integer 0-${LIMITS.waitMs}`);
    out.ms = ms;
    return out;
  }
  if (step.action === 'press') {
    out.key = str(step.key, 'key', where);
    // press may target an element or the currently focused one.
    if (step.role === undefined) return out;
  }
  out.role = str(step.role, 'role', where);
  out.name = str(step.name, 'name', where);
  out.exact = step.exact !== false;
  return out;
}

function validateStates(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.states)) {
    throw new StatesFileError('States file must be an object with a "states" array');
  }
  if (data.states.length > LIMITS.states) throw new StatesFileError(`At most ${LIMITS.states} states are allowed`);
  return data.states.map((s, i) => {
    const where = `states[${i}]`;
    if (!s || typeof s !== 'object') throw new StatesFileError(`${where}: must be an object`);
    const route = str(s.route, 'route', where);
    if (!route.startsWith('/')) throw new StatesFileError(`${where}: route must start with "/"`);
    const label = str(s.label, 'label', where);
    if (s.viewport !== undefined && !Object.hasOwn(VIEWPORTS, s.viewport)) {
      throw new StatesFileError(`${where}: viewport must be one of ${Object.keys(VIEWPORTS).join(', ')}`);
    }
    if (!Array.isArray(s.steps) || s.steps.length === 0 || s.steps.length > LIMITS.steps) {
      throw new StatesFileError(`${where}: steps must be an array of 1-${LIMITS.steps} steps`);
    }
    const steps = s.steps.map((st, j) => validateStep(st, `${where}.steps[${j}]`));
    return { route, label, viewport: s.viewport || null, steps };
  });
}

function loadStatesFile(file, { readFile = fs.readFileSync } = {}) {
  let data;
  try {
    data = JSON.parse(readFile(file, 'utf8'));
  } catch (err) {
    throw new StatesFileError(`Cannot read states file ${file}: ${err.message}`);
  }
  return validateStates(data);
}

// Runs in the page against a located element, or (no argument) against the focused
// element for a bare `press`. `el.form` also covers controls associated through the
// form="<id>" attribute that sit outside the <form> element.
function describeForSubmitCheck(el) {
  const t = el || document.activeElement;
  if (!t || t === document.body || t === document.documentElement) return { tag: 'body', type: null, inForm: false };
  return {
    tag: t.tagName.toLowerCase(),
    type: t.getAttribute('type'),
    inForm: Boolean(t.form || t.closest('form')),
  };
}

// Normalizes a Playwright key string to the activation key it ends with. Playwright
// accepts chords ("Shift+Enter", "Control+Space") and either the key name or the
// character (" " and "Space" are both the space bar).
function activationKey(key) {
  const last = key.length > 1 ? key.split('+').pop() : key;
  if (/^(Numpad)?Enter$/i.test(last)) return 'enter';
  if (last === ' ' || /^space$/i.test(last)) return 'space';
  return null;
}

// Pure decision so it can be tested without a browser. Returns the refusal message,
// or null when the step is safe. Activation keys submit just like a click:
//   - Space on a submit button activates it (HTML: button activation behavior)
//   - Enter on a submit button activates it, and Enter in a text field submits the
//     form implicitly (HTML "implicit submission")
// https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#implicit-submission
function submitRefusal(step, target) {
  const submitLike = isSubmitLikeDescriptor(target);
  if (step.action === 'click') {
    return submitLike ? `Refusing to click "${step.name}": it would submit a form.` : null;
  }
  if (step.action !== 'press') return null;
  const key = activationKey(step.key);
  if (key === 'enter' && (submitLike || target.inForm)) return 'Refusing to press Enter inside a form: it may submit.';
  if (key === 'space' && submitLike) return 'Refusing to press Space on a submit button: it would submit a form.';
  return null;
}

async function applyStep(page, step, { allowFormSubmit = false, timeoutMs = 10000 } = {}) {
  if (step.action === 'wait') {
    await page.waitForTimeout(step.ms);
    return;
  }
  const locator = step.role ? page.getByRole(step.role, { name: step.name, exact: step.exact }).first() : null;
  if (locator) {
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      throw new Error(`Could not find a visible ${step.role} named "${step.name}" within ${timeoutMs} ms`);
    }
  }

  if (!allowFormSubmit && (step.action === 'click' || step.action === 'press')) {
    const target = locator ? await locator.evaluate(describeForSubmitCheck) : await page.evaluate(describeForSubmitCheck);
    const refusal = submitRefusal(step, target);
    if (refusal) throw new Error(`${refusal} Pass --allow-form-submit to permit this.`);
  }

  switch (step.action) {
    case 'click': await locator.click({ timeout: timeoutMs }); break;
    case 'hover': await locator.hover({ timeout: timeoutMs }); break;
    case 'focus': await locator.focus({ timeout: timeoutMs }); break;
    case 'blur': await locator.blur({ timeout: timeoutMs }); break;
    case 'press':
      if (locator) await locator.press(step.key, { timeout: timeoutMs });
      else await page.keyboard.press(step.key);
      break;
    default: throw new Error(`Unsupported action ${step.action}`);
  }
}

async function applyState(page, state, opts) {
  for (const step of state.steps) {
    await applyStep(page, step, opts);
  }
  // Let open animations and lazy content settle before axe reads the DOM.
  await page.waitForTimeout(400);
}

function isMutatingRequest(method, url) {
  if (SAFE_METHODS.has(String(method).toUpperCase())) return false;
  if (String(method).toUpperCase() === 'POST') {
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch { /* not a URL: treat as mutating */ }
    if (READ_ONLY_POST_PATHS.some((re) => re.test(pathname))) return false;
  }
  return true;
}

// Aborts state-changing requests (POST/PUT/PATCH/DELETE, including a form POST
// navigation) until dispose() is called. Records the method and path only — never
// the query string or body, which can carry tokens or form data. Analytics beacons
// are blocked too; that is harmless for an audit. Requests from service workers
// bypass page.route, so the audit context is created with serviceWorkers: 'block'.
// https://playwright.dev/docs/api/class-page#page-route
async function guardMutations(page, { allowFormSubmit = false } = {}) {
  const blocked = { count: 0, requests: [] };
  if (allowFormSubmit) return { blocked, dispose: async () => {} };
  const handler = (route) => {
    const request = route.request();
    if (!isMutatingRequest(request.method(), request.url())) return route.continue();
    blocked.count++;
    if (blocked.requests.length < MAX_BLOCKED_SAMPLES) {
      let where = '(unparseable URL)';
      try {
        const u = new URL(request.url());
        where = `${u.origin}${u.pathname}`;
      } catch { /* keep placeholder */ }
      blocked.requests.push({ method: request.method(), url: where });
    }
    return route.abort('blockedbyclient');
  };
  await page.route('**/*', handler);
  return {
    blocked,
    dispose: async () => { await page.unroute('**/*', handler).catch(() => {}); },
  };
}

module.exports = {
  ACTIONS,
  LIMITS,
  StatesFileError,
  activationKey,
  applyState,
  guardMutations,
  isMutatingRequest,
  loadStatesFile,
  submitRefusal,
  validateStates,
};
