'use strict';

// WCAG 1.4.10 Reflow: content must work at 320 CSS px wide without scrolling in two
// directions. 320px is the width of a 1280px window zoomed to 400%, which is what the
// criterion actually asks for; resizing the viewport is the standard automated proxy.
//
// The check temporarily resizes the page and always restores the original size so
// later checks on the same page see the layout they expect.

const { makeFinding } = require('../report');

const REFLOW_VIEWPORT = Object.freeze({ width: 320, height: 256 });

// Runs in the page. Returns the outermost elements wider than the viewport, skipping
// content that is allowed to scroll on its own (data tables, code blocks, maps):
// 1.4.10 exempts "parts of the content which require two-dimensional layout".
function findOverflowInPage() {
  const h = window.__ppA11y;
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  if (doc.scrollWidth <= vw + 1) return { overflow: false, offenders: [] };

  const scrollsItself = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };

  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (offenders.length >= 10) break;
    const r = el.getBoundingClientRect();
    if (r.right <= vw + 1 || r.width === 0) continue;
    if (!h.isRendered(el) || scrollsItself(el)) continue;
    // Keep only the outermost offender; its children overflow because it does.
    if (offenders.some((o) => o.el.contains(el))) continue;
    offenders.push({ el, width: Math.round(r.width), right: Math.round(r.right) });
  }
  return {
    overflow: true,
    scrollWidth: doc.scrollWidth,
    viewportWidth: vw,
    offenders: offenders.map((o) => ({ target: h.cssPath(o.el), html: h.snippet(o.el), width: o.width, right: o.right })),
  };
}

async function runReflowCheck(page, { settleMs = 300 } = {}) {
  const original = page.viewportSize();
  try {
    await page.setViewportSize(REFLOW_VIEWPORT);
    await page.waitForTimeout(settleMs);
    const result = await page.evaluate(findOverflowInPage);
    return { findings: analyzeReflow(result) };
  } finally {
    if (original) await page.setViewportSize(original);
  }
}

function analyzeReflow(result) {
  if (!result.overflow) return [];
  const nodes = result.offenders.length
    ? result.offenders.map((o) => ({ target: o.target, html: o.html, summary: `Element extends to ${o.right}px in a ${result.viewportWidth}px viewport` }))
    : [{ target: 'html', html: '', summary: `Page is ${result.scrollWidth}px wide in a ${result.viewportWidth}px viewport` }];
  return [makeFinding({
    id: 'pp-reflow-horizontal-scroll',
    impact: 'serious',
    wcag: ['1.4.10'],
    description: 'Page scrolls horizontally at 320px wide (equivalent to 400% zoom). Use responsive widths (max-width: 100%, flex-wrap, min-width: 0) so content reflows.',
    helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/reflow.html',
    nodes,
  })];
}

module.exports = { REFLOW_VIEWPORT, analyzeReflow, runReflowCheck };
