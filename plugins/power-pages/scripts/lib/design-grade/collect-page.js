'use strict';

// One route at one width: screenshots, measurements, axe, and (desktop) focus and hover probes.
// Shared by skills/design-eval/scripts/collect.js and the evaluation runtime (evals/runtime/design-checks.mjs).
// The caller navigates and owns network rules; every probe here is isolated so a failure becomes a
// coverage gap instead of losing the page.

const path = require('node:path');
const { measurePage } = require('./measure-page');
const { waitForStableLayout, freezeMotion, focusCheck, hoverCheck, readCls } = require('./interactions');

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const FULL_PAGE_MAX = 4000;

const slugOf = (route) => (route === '/' ? 'home' : route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'page');

async function scrollThrough(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(innerHeight * 0.8));
    const max = Math.min(document.documentElement.scrollHeight, 20000);
    for (let y = 0; y < max; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
    scrollTo(0, 0);
  });
}

async function runAxe(page, axeSource) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async (tags) => {
    const res = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return res.violations.map((v) => ({
      id: v.id, impact: v.impact, tags: v.tags, help: v.help, helpUrl: v.helpUrl, nodeCount: v.nodes.length,
      nodes: v.nodes.slice(0, 15).map((n) => {
        const data = (n.any && n.any[0] && n.any[0].data) || {};
        return { target: n.target.join(' '), html: n.html.slice(0, 200), contrastRatio: data.contrastRatio, fgColor: data.fgColor, bgColor: data.bgColor, fontSize: data.fontSize };
      }),
    }));
  }, AXE_TAGS);
}

// `record` is the evidence page entry ({ viewports, axe, screenshots, collectionErrors, cls, focus, hover }).
// `rootDir` is the evidence directory that screenshot paths are made relative to.
async function measureLoadedPage(page, { record, width, viewport, shotsDir, rootDir, axeSource }) {
  const gap = (step, error) => record.collectionErrors.push({ viewport: width, step, error: String((error && error.message) || error).split('\n')[0].slice(0, 300) });
  const rel = (file) => path.relative(rootDir, file).split(path.sep).join('/');
  await waitForStableLayout(page);
  if (width === 'desktop') record.cls = await readCls(page);
  const base = `${slugOf(record.route)}-${width}`;
  const fold = path.join(shotsDir, `${base}-fold.jpg`);
  await page.screenshot({ path: fold, type: 'jpeg', quality: 70 });
  await scrollThrough(page);
  await freezeMotion(page);
  record.viewports[width] = await page.evaluate(measurePage);
  const full = path.join(shotsDir, `${base}-full.jpg`);
  try {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: full, type: 'jpeg', quality: 60, fullPage: true, ...(height > FULL_PAGE_MAX ? { clip: { x: 0, y: 0, width: viewport.width, height: FULL_PAGE_MAX } } : {}) });
    record.screenshots[width] = { fold: rel(fold), full: rel(full) };
  } catch (error) {
    record.screenshots[width] = { fold: rel(fold), full: rel(fold) };
    gap('screenshot', error);
  }
  if (axeSource) {
    try { record.axe[width] = await runAxe(page, axeSource); } catch (error) { gap('axe', error); }
  } else {
    gap('axe', 'accessibility audit unavailable (axe-core could not be loaded)');
  }
  if (width === 'desktop') {
    record.focus = await focusCheck(page).catch((error) => { gap('focus', error); return null; });
    record.hover = await hoverCheck(page).catch((error) => { gap('hover', error); return null; });
  }
}

function emptyRecord(route) {
  return {
    route, url: route, viewports: {}, axe: {}, screenshots: {}, collectionErrors: [],
    errors: [], failedRequests: [], pageWeightByType: {}, cls: null, focus: null, hover: null, reducedMotion: null,
  };
}

module.exports = { measureLoadedPage, emptyRecord, slugOf, FULL_PAGE_MAX };
