'use strict';

// WCAG 1.4.4 Resize Text: text must stay readable at 200% without loss of content.
//
// Doubling the root font size approximates a user's "text size" browser setting.
// Layouts that use rem/em scale with it; fixed-height containers with overflow
// hidden then clip their text, which is the defect this looks for. Fixed px font
// sizes do not scale with this method at all, so a pass here is not proof of
// conformance — the finding is marked heuristic.

const { makeFinding } = require('../report');

function findClippedTextInPage() {
  const h = window.__ppA11y;
  const root = document.documentElement;
  const previous = root.style.fontSize;
  root.style.fontSize = '200%';
  // Force layout before measuring.
  void root.offsetHeight;
  try {
    const clipped = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (clipped.length >= 10) break;
      if (!h.isRendered(el)) continue;
      const s = getComputedStyle(el);
      const clips = (v) => v === 'hidden' || v === 'clip';
      if (!clips(s.overflowX) && !clips(s.overflowY)) continue;
      // Visually hidden helper text (sr-only) is clipped on purpose.
      if (el.clientWidth <= 1 || el.clientHeight <= 1) continue;
      const overY = clips(s.overflowY) && el.scrollHeight > el.clientHeight + 2;
      const overX = clips(s.overflowX) && el.scrollWidth > el.clientWidth + 2;
      if (!overY && !overX) continue;
      // Ellipsis truncation is a deliberate design choice, not lost content, when the
      // full text is still exposed (title attribute or accessible name).
      if (s.textOverflow === 'ellipsis' && el.title) continue;
      if (!(el.innerText || '').trim()) continue;
      if (clipped.some((c) => c.el.contains(el))) continue;
      clipped.push({ el, overY, overX });
    }
    return clipped.map((c) => ({
      target: h.cssPath(c.el),
      html: h.snippet(c.el),
      axis: c.overY && c.overX ? 'both' : (c.overY ? 'vertical' : 'horizontal'),
    }));
  } finally {
    root.style.fontSize = previous;
  }
}

function analyzeZoom(clipped) {
  if (!clipped.length) return [];
  return [makeFinding({
    id: 'pp-text-clipped-at-200',
    impact: 'moderate',
    wcag: ['1.4.4'],
    heuristic: true,
    description: 'Text is cut off when text size is doubled. Avoid fixed heights with overflow: hidden on text containers; use min-height and rem units.',
    helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html',
    nodes: clipped.map((c) => ({ target: c.target, html: c.html, summary: `Text overflows its container (${c.axis}) at 200% text size` })),
  })];
}

async function runZoomCheck(page) {
  const clipped = await page.evaluate(findClippedTextInPage);
  return { findings: analyzeZoom(clipped) };
}

module.exports = { analyzeZoom, runZoomCheck };
