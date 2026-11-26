'use strict';

// Interaction probes for the design grade, run by the evaluation runtime (evals/runtime/design-checks.mjs).
// Each takes a Playwright page that is already loaded and returns plain data.

async function waitForStableLayout(page) {
  await page.evaluate(async () => {
    const sample = () => {
      const imgs = [...document.images];
      return [document.getElementsByTagName('*').length, document.documentElement.scrollHeight, document.documentElement.scrollWidth, imgs.filter((i) => i.complete).length, imgs.length].join('|');
    };
    let last = sample(), stable = 0;
    for (let i = 0; i < 30 && stable < 3; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const now = sample();
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
  }).catch(() => {});
}

// Finish finite animations and park infinite ones at t=0, so measurements do not depend on timing.
async function freezeMotion(page) {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      try {
        if (a.effect && a.effect.getTiming().iterations === Infinity) { a.pause(); a.currentTime = 0; } else a.finish();
      } catch (_) { /* ignore */ }
    }
  }).catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

// Cumulative Layout Shift, observed from the first paint (install before navigation, read after load).
const CLS_INIT_SCRIPT = `window.__dgCLS = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__dgCLS += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (_) {}`;
async function readCls(page) {
  return page.evaluate(() => Math.round((window.__dgCLS || 0) * 1000) / 1000).catch(() => null);
}

const FOCUS_PROPS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'backgroundColor', 'color', 'textDecorationLine', 'transform', 'opacity'];

async function focusCheck(page) {
  await page.evaluate((props) => {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
    window.__dgFocus = [];
    [...document.querySelectorAll(sel)].slice(0, 400).forEach((el, i) => {
      el.setAttribute('data-dg-f', String(i));
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      window.__dgFocus[i] = { style: props.map((p) => s[p]).join('|'), pos: `${Math.round(r.left + window.scrollX)},${Math.round(r.top + window.scrollY)}` };
    });
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }, FOCUS_PROPS);
  const results = [];
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    const r = await page.evaluate((props) => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const idx = el.getAttribute('data-dg-f');
      if (idx === null) return { idx: null };
      const s = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const before = window.__dgFocus[+idx];
      const now = { style: props.map((p) => s[p]).join('|'), pos: `${Math.round(rect.left + window.scrollX)},${Math.round(rect.top + window.scrollY)}` };
      const outlineVisible = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
      const tag = el.tagName.toLowerCase();
      const label = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      let path = tag + (el.id ? '#' + el.id : '') + ([...el.classList].slice(0, 2).map((c) => '.' + c).join(''));
      return { idx: +idx, changed: before.style !== now.style || before.pos !== now.pos || outlineVisible, selector: path, label };
    }, FOCUS_PROPS);
    if (!r) continue;
    if (r.idx === null) continue;
    if (seen.has(r.idx)) break;
    seen.add(r.idx);
    results.push(r);
  }
  return { sampled: results.length, invisible: results.filter((r) => !r.changed).map(({ selector, label }) => ({ selector, label })) };
}

const HOVER_PROPS = ['backgroundColor', 'color', 'borderTopColor', 'boxShadow', 'transform', 'textDecorationLine', 'opacity', 'filter', 'backgroundImage'];

const CURRENT_CLASS = /^(active|is-active|current|is-current|selected|is-selected)$/i;

// Elements that are not expected to react to hover: the link for the current page (it is already
// highlighted), and skip links or other controls kept off-screen until they receive keyboard focus.
function hoverExempt(c) {
  if (c.ariaCurrent && c.ariaCurrent !== 'false') return 'current page';
  if (c.classes.some((k) => CURRENT_CLASS.test(k))) return 'current page';
  if (c.offscreen) return 'off-screen';
  if (/^#/.test(c.href || '') && /^skip\b/i.test(c.text)) return 'skip link';
  return null;
}

async function hoverCheck(page) {
  const cands = await page.evaluate(() => [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')].filter((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') return false;
    if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'INPUT') return true;
    const hasBg = !/rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor);
    const hasBorder = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none';
    return (hasBg || hasBorder) && parseFloat(s.paddingLeft) >= 8;
  }).map((el, i) => {
    el.setAttribute('data-dg-h', String(i));
    const r = el.getBoundingClientRect();
    const fixed = getComputedStyle(el).position === 'fixed';
    const top = r.bottom + (fixed ? 0 : window.scrollY);
    const left = r.right + (fixed ? 0 : window.scrollX);
    return {
      i,
      ariaCurrent: el.getAttribute('aria-current'),
      classes: [...el.classList],
      text: (el.innerText || el.value || '').trim().slice(0, 40),
      href: el.getAttribute('href'),
      offscreen: top <= 0 || left <= 0,
    };
  }));
  const picked = cands.filter((c) => !hoverExempt(c)).slice(0, 8);
  const results = [];
  for (const { i } of picked) {
    const loc = page.locator(`[data-dg-h="${i}"]`);
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      await page.mouse.move(1, 1);
      await page.waitForTimeout(120);
      const snap = (props) => loc.evaluate((el, p) => { const s = getComputedStyle(el); return p.map((k) => s[k]).join('|'); }, props);
      const before = await snap(HOVER_PROPS);
      await loc.hover({ timeout: 2000, force: true });
      await page.waitForTimeout(260);
      const after = await snap(HOVER_PROPS);
      const desc = await loc.evaluate((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join('') + ` "${(el.innerText || '').trim().slice(0, 30)}"`);
      results.push({ selector: desc, changed: before !== after });
    } catch (_) { /* element detached or covered — skip */ }
  }
  await page.mouse.move(1, 1);
  return { sampled: results.length, noFeedback: results.filter((r) => !r.changed).map((r) => r.selector) };
}

// Run on a page loaded in a context with reducedMotion: 'reduce'.
async function reducedMotionProbe(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (s.display === 'none') continue;
      if (s.animationName !== 'none' && s.animationDuration.split(',').some((d) => parseFloat(d) > 0.01)) {
        out.push({ selector: el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((c) => '.' + c).join(''), animation: s.animationName, infinite: s.animationIterationCount.includes('infinite') });
      }
    }
    for (const a of document.getAnimations()) {
      if (a instanceof CSSAnimation || a instanceof CSSTransition) continue;
      const t = a.effect && a.effect.getTiming();
      if (a.playState === 'running' && t && t.duration > 10) out.push({ selector: 'web-animation', animation: a.id || 'WAAPI', infinite: t.iterations === Infinity });
    }
    return out.slice(0, 30);
  });
}

module.exports = { waitForStableLayout, freezeMotion, CLS_INIT_SCRIPT, readCls, focusCheck, hoverCheck, hoverExempt, reducedMotionProbe };
