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
// form submit writes a Dataverse record (and may send email) on a live site.

const fs = require('node:fs');
const { VIEWPORTS } = require('./args');
const { isSubmitLikeDescriptor } = require('./checks/inventory');

const ACTIONS = Object.freeze(['click', 'hover', 'focus', 'blur', 'press', 'wait']);
const LIMITS = Object.freeze({ states: 100, steps: 20, waitMs: 10000, text: 200 });

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

// Runs in the page against a located element.
function describeForSubmitCheck(el) {
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    inForm: Boolean(el.closest('form')),
  };
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

  if (!allowFormSubmit && locator && step.action === 'click') {
    const d = await locator.evaluate(describeForSubmitCheck);
    if (isSubmitLikeDescriptor(d)) {
      throw new Error(`Refusing to click "${step.name}": it would submit a form. Pass --allow-form-submit to permit this.`);
    }
  }
  if (!allowFormSubmit && step.action === 'press' && /^(Enter|NumpadEnter)$/i.test(step.key)) {
    // Enter in a text field submits its form implicitly.
    const inForm = locator
      ? await locator.evaluate((el) => Boolean(el.closest('form')))
      : await page.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('form')));
    if (inForm) throw new Error('Refusing to press Enter inside a form: it may submit. Pass --allow-form-submit to permit this.');
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

module.exports = {
  ACTIONS,
  LIMITS,
  StatesFileError,
  applyState,
  loadStatesFile,
  validateStates,
};
