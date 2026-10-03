'use strict';

// WCAG 1.4.10 Reflow: content must work at 320 CSS px wide without scrolling in two
// directions. 320px is the width of a 1280px window zoomed to 400%, which is what the
// criterion actually asks for; resizing the viewport is the standard automated proxy.
//
// The check temporarily resizes the page and always restores the original size so
// later checks on the same page see the layout they expect.

const { makeFinding } = require('../report');

const REFLOW_VIEWPORT = Object.freeze({ width: 320, height: 256 });

// Runs in the page. Looks for two kinds of horizontal scrolling at 320px:
//   - the page itself scrolls: returns the outermost elements wider than the viewport.
//     Elements inside their own scroll container are skipped here, because they make
//     that container scroll, not the page.
//   - a scroll container inside the page scrolls sideways (a wrapper with
//     overflow-x: auto around wide content). The page can fit while text in such a
//     wrapper still needs scrolling in two directions, so these are checked even when
//     the page itself fits.
// 1.4.10 exempts "parts of the content which require two-dimensional layout" (data
// tables, images, maps, diagrams, video, code). A container is exempt only when every
// element that overflows it is, or sits inside, such content. Telling that apart from
// ordinary text is a judgment call, so a non-exempt container is a heuristic finding
// for review rather than a blocking failure.
// https://www.w3.org/WAI/WCAG22/Understanding/reflow.html
function findOverflowInPage() {
  const h = window.__ppA11y;
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const pageOverflows = doc.scrollWidth > vw + 1;
  const TWO_D = 'table,pre,code,canvas,svg,img,picture,video,iframe,embed,object,math,'
    + '[role="table"],[role="grid"],[role="treegrid"],[role="application"],[role="img"],[role="math"]';
  const MAX = 10;

  const scrollsX = (el) => {
    const ox = getComputedStyle(el).overflowX;
    return ox === 'auto' || ox === 'scroll';
  };
  const insideScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (scrollsX(p)) return true;
    }
    return false;
  };
  // True when everything wider than the container's visible box is 2D content. A
  // container that scrolls but has no measurable overflowing element (the overflow
  // comes from padding or a pseudo-element) is not exempt.
  const needsTwoD = (c) => {
    // Form fields scroll their own value by design; that isn't page content reflowing.
    if (c.matches(TWO_D) || c.matches('input,textarea,select')) return true;
    const edge = c.getBoundingClientRect().left + c.clientLeft + c.clientWidth;
    let wide = 0;
    for (const d of c.querySelectorAll('*')) {
      const r = d.getBoundingClientRect();
      if (r.width === 0 || r.right <= edge + 1) continue;
      const twoD = d.closest(TWO_D);
      if (!twoD || !c.contains(twoD)) return false;
      wide++;
    }
    return wide > 0;
  };

  const offenders = [];
  const containers = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (offenders.length >= MAX && containers.length >= MAX) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (containers.length < MAX && el.scrollWidth > el.clientWidth + 1 && scrollsX(el)
      && h.isRendered(el) && !containers.some((c) => c.el.contains(el)) && !needsTwoD(el)) {
      containers.push({ el, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }
    if (!pageOverflows || offenders.length >= MAX || r.right <= vw + 1) continue;
    if (!h.isRendered(el) || insideScroller(el)) continue;
    // Keep only the outermost offender; its children overflow because it does.
    if (offenders.some((o) => o.el.contains(el))) continue;
    offenders.push({ el, width: Math.round(r.width), right: Math.round(r.right) });
  }
  return {
    overflow: pageOverflows,
    scrollWidth: doc.scrollWidth,
    viewportWidth: vw,
    offenders: offenders.map((o) => ({ target: h.cssPath(o.el), html: h.snippet(o.el), width: o.width, right: o.right })),
    scrollContainers: containers.map((c) => ({ target: h.cssPath(c.el), html: h.snippet(c.el), scrollWidth: c.scrollWidth, clientWidth: c.clientWidth })),
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
  const findings = [];
  if (result.overflow) {
    const nodes = result.offenders.length
      ? result.offenders.map((o) => ({ target: o.target, html: o.html, summary: `Element extends to ${o.right}px in a ${result.viewportWidth}px viewport` }))
      : [{ target: 'html', html: '', summary: `Page is ${result.scrollWidth}px wide in a ${result.viewportWidth}px viewport` }];
    findings.push(makeFinding({
      id: 'pp-reflow-horizontal-scroll',
      impact: 'serious',
      wcag: ['1.4.10'],
      description: 'Page scrolls horizontally at 320px wide (equivalent to 400% zoom). Use responsive widths (max-width: 100%, flex-wrap, min-width: 0) so content reflows.',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/reflow.html',
      nodes,
    }));
  }
  const containers = result.scrollContainers || [];
  if (containers.length) {
    findings.push(makeFinding({
      id: 'pp-reflow-scroll-container',
      impact: 'serious',
      wcag: ['1.4.10'],
      heuristic: true,
      description: 'Content inside this container scrolls horizontally at 320px wide. Unless it needs a two-dimensional layout (a data table, image, map, or code), make it wrap so users don\'t scroll in two directions.',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/reflow.html',
      nodes: containers.map((c) => ({ target: c.target, html: c.html, summary: `Content is ${c.scrollWidth}px wide in a ${c.clientWidth}px scroll area` })),
    }));
  }
  return findings;
}

module.exports = { REFLOW_VIEWPORT, analyzeReflow, runReflowCheck };
