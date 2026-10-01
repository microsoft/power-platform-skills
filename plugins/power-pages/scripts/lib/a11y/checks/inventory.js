'use strict';

// Discover mode: lists the interactive controls on a page so the calling agent can
// decide which interaction states (open menus, dialogs, tabs, accordions) are worth
// auditing. axe only sees the DOM as it is at load time, so content hidden behind a
// click is otherwise never checked.
//
// The script proposes candidates; the agent chooses. That split keeps judgement
// ("is this the mobile nav or a cookie banner?") out of the script and keeps the
// script deterministic.

const MAX_CONTROLS = 150;

function collectControlsInPage(maxControls) {
  const h = window.__ppA11y;
  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'search') return 'searchbox';
      if (t === 'hidden') return null;
      return 'textbox';
    }
    return null;
  };

  const selector = 'a[href], button, summary, select, textarea, input, [role], [tabindex]:not([tabindex="-1"]), [aria-expanded], [aria-haspopup]';
  const controls = [];
  for (const el of document.querySelectorAll(selector)) {
    if (controls.length >= maxControls) break;
    if (!h.isRendered(el)) continue;
    const role = el.getAttribute('role') || implicitRole(el);
    if (!role || ['presentation', 'none', 'img', 'heading', 'list', 'listitem', 'region', 'navigation', 'main', 'banner', 'contentinfo'].includes(role)) continue;

    const form = el.closest('form');
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const expanded = el.getAttribute('aria-expanded');
    const popup = el.getAttribute('aria-haspopup');

    let kind = 'other';
    if (role === 'tab') kind = 'tab';
    else if (popup && popup !== 'false') kind = 'popup';
    else if (expanded !== null || tag === 'summary') kind = 'disclosure';
    else if (['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider', 'switch'].includes(role)) kind = 'form-field';
    else if (role === 'link') kind = 'link';
    else if (role === 'button') kind = 'button';

    controls.push({
      role,
      name: h.accessibleName(el),
      kind,
      expanded: expanded === null ? null : expanded === 'true',
      controls: el.getAttribute('aria-controls') || null,
      tag,
      type: type || null,
      inForm: Boolean(form),
    });
  }
  return controls;
}

// Same rule as states.js uses to block clicks: anything that would submit a form.
// Kept here as a pure function over a descriptor so both modules and the tests share it.
function isSubmitLikeDescriptor({ tag, type, inForm }) {
  const t = (type || '').toLowerCase();
  if (tag === 'input') return t === 'submit' || t === 'image';
  if (tag === 'button') {
    if (t === 'submit') return true;
    // A <button> with no type inside a form defaults to type=submit (HTML spec).
    return inForm && !t;
  }
  return false;
}

// Picks the controls worth turning into states: things that reveal hidden content.
// Deduplicated by role+name so the same header menu found on every page is proposed
// once, which also matches how states are later replayed (getByRole + name).
function stateCandidates(controls) {
  const seen = new Set();
  const out = [];
  for (const c of controls) {
    if (!['popup', 'disclosure', 'tab'].includes(c.kind)) continue;
    if (!c.name) continue;
    if (isSubmitLikeDescriptor(c)) continue;
    const key = `${c.role}:${c.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: `${c.kind}: ${c.name}`,
      steps: [{ action: 'click', role: c.role, name: c.name, exact: true }],
      expanded: c.expanded,
    });
  }
  return out;
}

async function collectInventory(page) {
  const controls = await page.evaluate(collectControlsInPage, MAX_CONTROLS);
  return { controls, stateCandidates: stateCandidates(controls) };
}

// Playwright >= 1.49 exposes the accessibility tree as YAML. Older versions (from a
// user's project) simply produce no snapshot rather than failing discovery.
async function ariaSnapshot(page) {
  const locator = page.locator('body');
  if (typeof locator.ariaSnapshot !== 'function') return null;
  try {
    return await locator.ariaSnapshot();
  } catch {
    return null;
  }
}

module.exports = {
  MAX_CONTROLS,
  ariaSnapshot,
  collectInventory,
  isSubmitLikeDescriptor,
  stateCandidates,
};
