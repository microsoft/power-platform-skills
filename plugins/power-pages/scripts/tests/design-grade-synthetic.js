'use strict';

// Synthetic evidence: a clean page that triggers no measured issue. Tests mutate one value at a time.
const para = (over = {}) => ({
  selector: 'main > p', tag: 'p', text: 'Body copy', textLength: 200, fontSize: 18, lineHeightRatio: 1.6, lineHeightNormal: false,
  lines: 3, fontFamily: 'Satoshi', fontWeight: '400', color: 'rgb(20, 20, 20)', charsPerLine: 70, aboveFold: true, opacity: 1,
  inNav: false, inFooter: false, isHeading: false, clipped: false, ...over,
});

function viewport(width, height, over = {}) {
  return {
    viewport: { width, height },
    document: { title: 'Harbor Tide', lang: 'en', metaViewport: 'width=device-width, initial-scale=1', metaDescription: 'A real description.', hasFavicon: true, scrollWidth: width, scrollHeight: 2000, visibleText: 'Row the estuary' },
    textBlocks: [para()],
    overlaps: [], overflowers: [],
    headings: [{ level: 1, text: 'Row the estuary', fontSize: 54, fontFamily: 'Fraunces', selector: 'h1' }],
    fonts: { faces: [], availability: { Satoshi: true, Fraunces: true }, googleFontLinks: [], fontDisplay: [] },
    tokens: { colorTokens: 6, totalTokens: 10, utilityColorClasses: 0 },
    colors: {}, spacing: { 8: 4, 16: 6, 24: 3 }, radii: { 8: 2 }, shadows: {},
    motion: { transitionEls: 3, animationEls: 1 },
    backgrounds: { pageBg: 'rgb(251, 248, 243)', bandBgs: { 'rgb(241, 235, 224)': 1 }, bandCount: 1, bgImageEls: 1, gradients: [] },
    images: [], links: [], fixedBars: [], emptySections: [],
    ...over,
  };
}

function page(mutate = () => {}) {
  const p = {
    route: '/',
    viewports: { desktop: viewport(1440, 900), tablet: viewport(768, 1024), mobile: viewport(375, 812) },
    axe: { desktop: [], mobile: [] },
    focus: { sampled: 6, invisible: [] }, hover: { sampled: 0, noFeedback: [] }, reducedMotion: [],
    errors: [], failedRequests: [], cls: 0, pageWeightByType: {},
  };
  mutate(p);
  return p;
}

module.exports = { para, viewport, page };
