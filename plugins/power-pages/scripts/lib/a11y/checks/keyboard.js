'use strict';

// Keyboard walk: presses Tab through the page and records where focus lands.
//
// Covers what axe cannot, because axe inspects a static DOM and never moves focus:
//   - 2.1.2 No Keyboard Trap: focus stops advancing (a modal or widget swallows Tab)
//   - 2.4.7 Focus Visible: the focused element looks identical to its unfocused self
//   - focus moving to elements that are off screen (often hidden menus left tabbable)
//
// The focus-visible test compares computed styles of the element while focused and
// after blur. It cannot see focus indicators drawn by a parent or a sibling, so it is
// marked heuristic and never fails the run on its own.
//
// The walk stops when focus wraps back to the start, leaves the document, or sticks on
// one element. An iframe is the exception to sticking: while Tab moves through the
// frame's own controls, the top document's activeElement stays the iframe, so repeats
// there are expected and the walk keeps pressing Tab until focus leaves the frame.
// Coming back to the start isn't proof of a full wrap: a widget that cycles focus
// among its own controls (A -> B -> A) also returns there. So on a return the walk
// lists the visible tab stops it never reached (focusCycleGapInPage). None missed is a
// wrap; otherwise the cycle is reported as a heuristic 2.1.2 finding and a coverage
// gap. A cycle inside an open modal dialog is the expected pattern (Escape closes it),
// so it counts as a wrap.
// If it reaches MAX_TABS first, the controls after that point were never
// checked, so the result carries an `incomplete` reason and the audit reports a check
// error (exit 3) instead of passing on partial coverage. The cap is generous because a
// Power Pages header with a large navigation menu can easily hold 100+ tab stops.

const { makeFinding } = require('../report');

const MAX_TABS = 250;
const TRAP_REPEAT = 5;

// Runs in the page. Describes document.activeElement after a Tab press.
function describeActiveElementInPage() {
  const h = window.__ppA11y;
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;

  const props = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor', 'color',
    'borderTopColor', 'borderBottomColor', 'borderBottomWidth', 'textDecorationLine'];
  const snap = (target, pseudo) => {
    const s = getComputedStyle(target, pseudo);
    return props.map((p) => s[p]).join('|');
  };
  const read = () => [snap(el), snap(el, '::before'), snap(el, '::after')].join('#');

  const focused = read();
  // Compare against the unfocused look, then restore focus without scrolling so the
  // next Tab continues from the same element.
  el.blur();
  const blurred = read();
  el.focus({ preventScroll: true });

  // An outline with width 0 or style none is not a visible indicator even though
  // the style string changed (for example 'outline: none' replaced on focus).
  const fs = getComputedStyle(el);
  const outlineVisible = fs.outlineStyle !== 'none' && parseFloat(fs.outlineWidth) > 0;

  // Rect is viewport-relative; convert to document coordinates so an element below
  // the fold (reachable by scrolling) is not mistaken for one positioned off screen.
  const r = el.getBoundingClientRect();
  const top = r.top + window.scrollY;
  const left = r.left + window.scrollX;
  const doc = document.documentElement;
  const offscreen = r.width <= 1 || r.height <= 1 || top + r.height < 0 || left + r.width < 0
    || top > doc.scrollHeight || left > doc.scrollWidth;

  return {
    selector: h.cssPath(el),
    tag: el.tagName.toLowerCase(),
    name: h.accessibleName(el),
    html: h.snippet(el),
    inIframe: el.tagName === 'IFRAME',
    indicator: focused !== blurred || outlineVisible,
    offscreen,
  };
}

// Runs in the page after focus returned to the first element of the walk. Returns the
// tab stops the walk never reached, so a local focus cycle isn't mistaken for a wrap.
// Approximates the browser's sequential focus navigation: natively focusable or
// [tabindex] elements with tabIndex >= 0 that aren't disabled, inert, or invisible.
// Two cases need care so a real wrap isn't flagged:
//   - only one radio per named group is a tab stop, so a group counts as reached when
//     any of its radios was;
//   - controls inside iframes or shadow roots aren't in this document's query, so they
//     can't be reported as missed (the walk can't see into them either).
// Returns at most MAX_MISSED samples plus the total.
function focusCycleGapInPage(visited) {
  const h = window.__ppA11y;
  const MAX_MISSED = 10;
  const active = document.activeElement;
  // A native modal makes everything outside it inert; aria-modal declares the same.
  if (active && active.closest('dialog:modal, [aria-modal="true"]')) return { modal: true, total: 0, missed: [] };
  const seen = new Set(visited);
  const radioKey = (el) => `${el.form ? h.cssPath(el.form) : ''}|${el.name}`;
  const reachedGroups = new Set();
  for (const sel of visited) {
    let el = null;
    try { el = document.querySelector(sel); } catch { /* not a valid selector */ }
    if (el && el.type === 'radio' && el.name) reachedGroups.add(radioKey(el));
  }
  const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,iframe,summary,audio[controls],video[controls],'
    + '[tabindex],[contenteditable=""],[contenteditable="true"]';
  const missed = [];
  let total = 0;
  for (const el of document.querySelectorAll(FOCUSABLE)) {
    if (el.tabIndex < 0 || el.disabled || el.type === 'hidden' || el.closest('[inert]')) continue;
    const visible = typeof el.checkVisibility === 'function'
      ? el.checkVisibility({ visibilityProperty: true })
      : el.getClientRects().length > 0;
    if (!visible) continue;
    if (el.type === 'radio' && el.name && reachedGroups.has(radioKey(el))) continue;
    const selector = h.cssPath(el);
    if (seen.has(selector)) continue;
    total++;
    if (missed.length < MAX_MISSED) missed.push({ selector, tag: el.tagName.toLowerCase(), name: h.accessibleName(el), html: h.snippet(el) });
  }
  return { modal: false, total, missed };
}

async function walkFocus(page, { maxTabs = MAX_TABS } = {}) {
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  const sequence = [];
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(describeActiveElementInPage);
    if (!info) {
      // Focus left the document (browser chrome) — the cycle is complete.
      if (sequence.length) return { sequence, complete: true };
      continue;
    }
    const last = sequence[sequence.length - 1];
    // Back at the first element after visiting others = the tab cycle wrapped.
    // Landing on the same element as last time is not a wrap; it may be a trap.
    if (sequence.length > 1 && info.selector === sequence[0].selector && last.selector !== info.selector) {
      const gap = await page.evaluate(focusCycleGapInPage, [...new Set(sequence.map((s) => s.selector))]);
      if (!gap || gap.modal || gap.total === 0) return { sequence, complete: true };
      return { sequence, complete: false, cycle: gap };
    }
    sequence.push(info);
    // Stopping on an iframe would skip every control after it and, because iframe
    // repeats aren't reported as traps, hide that gap. Keep walking instead: focus
    // either leaves the frame or the cap marks the walk incomplete.
    const tail = sequence.slice(-TRAP_REPEAT);
    if (!info.inIframe && tail.length === TRAP_REPEAT && tail.every((s) => s.selector === info.selector)) {
      return { sequence, complete: true };
    }
  }
  // A page with no focusable element never moves focus off the body: nothing was missed.
  return { sequence, complete: sequence.length === 0 };
}

// Pure analysis of a focus sequence so it can be unit tested without a browser.
function analyzeFocusSequence(sequence) {
  const findings = [];

  let run = 1;
  for (let i = 1; i < sequence.length; i++) {
    const cur = sequence[i];
    run = cur.selector === sequence[i - 1].selector ? run + 1 : 1;
    // Iframes legitimately hold focus while Tab moves through their own content,
    // which this walk cannot see into.
    if (run === TRAP_REPEAT && !cur.inIframe) {
      findings.push(makeFinding({
        id: 'pp-keyboard-trap',
        impact: 'critical',
        wcag: ['2.1.2'],
        description: 'Keyboard focus stops moving when pressing Tab. Users who cannot use a mouse are stuck.',
        helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html',
        nodes: [{ target: cur.selector, html: cur.html, summary: `Focus stayed on this element for ${TRAP_REPEAT} Tab presses` }],
      }));
    }
  }

  const seen = new Set();
  const unique = sequence.filter((s) => (seen.has(s.selector) ? false : seen.add(s.selector)));

  const noIndicator = unique.filter((s) => !s.indicator && !s.offscreen);
  if (noIndicator.length) {
    findings.push(makeFinding({
      id: 'pp-focus-not-visible',
      impact: 'serious',
      wcag: ['2.4.7'],
      heuristic: true,
      description: 'Element shows no visible change when it receives keyboard focus. Add a :focus-visible style such as an outline.',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html',
      nodes: noIndicator.map((s) => ({ target: s.selector, html: s.html, summary: `No style change on focus (${s.tag} "${s.name}")` })),
    }));
  }

  const offscreen = unique.filter((s) => s.offscreen);
  if (offscreen.length) {
    findings.push(makeFinding({
      id: 'pp-focus-offscreen',
      impact: 'moderate',
      wcag: ['2.4.7'],
      heuristic: true,
      description: 'Keyboard focus moves to an element that is not visible. Hidden menus or panels may still be in the tab order; use the hidden attribute, display:none or inert.',
      nodes: offscreen.map((s) => ({ target: s.selector, html: s.html, summary: `Focused element is off screen or has no size (${s.tag} "${s.name}")` })),
    }));
  }

  return findings;
}

// A focus cycle that skips other tab stops. Heuristic, because the list of expected tab
// stops is an approximation of the browser's own (see focusCycleGapInPage).
function focusCycleFinding(sequence, cycle) {
  const loop = [...new Set(sequence.map((s) => s.selector))];
  return makeFinding({
    id: 'pp-keyboard-focus-cycle',
    impact: 'serious',
    wcag: ['2.1.2'],
    heuristic: true,
    description: `Pressing Tab cycles through ${loop.length} control(s) and never reaches ${cycle.total} other focusable control(s) on the page. Users who can't use a mouse may be stuck in this region.`,
    helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html',
    nodes: cycle.missed.map((m) => ({ target: m.selector, html: m.html, summary: `Never reached with Tab (${m.tag} "${m.name}")` })),
  });
}

async function runKeyboardCheck(page, opts = {}) {
  const maxTabs = opts.maxTabs || MAX_TABS;
  const { sequence, complete, cycle } = await walkFocus(page, { maxTabs });
  const findings = analyzeFocusSequence(sequence);
  if (cycle) findings.push(focusCycleFinding(sequence, cycle));
  let incomplete = null;
  if (cycle) {
    incomplete = `focus cycled back to the start without reaching ${cycle.total} other focusable control(s); they weren't checked`;
  } else if (!complete) {
    incomplete = `focus didn't cycle back to the start within ${maxTabs} Tab presses (more tab stops than the limit, or focus loops inside one region); later controls weren't checked`;
  }
  return {
    findings,
    focusOrder: sequence.map((s) => ({ selector: s.selector, name: s.name })),
    // Findings up to the cap or the cycle are still real, so they are kept; the reason
    // makes the run report a check error instead of a pass.
    incomplete,
  };
}

module.exports = {
  MAX_TABS,
  TRAP_REPEAT,
  analyzeFocusSequence,
  runKeyboardCheck,
};
