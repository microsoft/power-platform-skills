'use strict';

// Pins every numeric threshold documented in catalog.json to the implementation in lib/checks.js.
// Each case starts from a clean synthetic page and moves exactly one measurement across its boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPage } = require('../lib/design-grade/checks');

const { para, page } = require('./design-grade-synthetic');

const issues = (p) => checkPage(p, {});
const find = (p, key) => issues(p).find((i) => (i.variant ? `${i.id}:${i.variant}` : i.id) === key);
const D = (p) => p.viewports.desktop;

test('baseline synthetic page is clean', () => {
  assert.deepEqual(issues(page()).map((i) => i.id), []);
});

test('TYP-02 type scale: <1.6 major, 1.6–2.0 minor, ≥2.0 none', () => {
  const h1 = (size) => page((p) => { D(p).headings[0].fontSize = size; });
  assert.equal(find(h1(18 * 1.59), 'TYP-02').severity, 'major');
  assert.equal(find(h1(18 * 1.6), 'TYP-02').severity, 'minor');
  assert.equal(find(h1(18 * 2.0), 'TYP-02'), undefined);
});

test('TYP-03 desktop body text below 16px', () => {
  const body = (fs) => page((p) => { D(p).textBlocks = [para({ fontSize: fs })]; D(p).headings[0].fontSize = 60; });
  assert.ok(find(body(15.5), 'TYP-03'));
  assert.equal(find(body(16), 'TYP-03'), undefined);
});

test('RES-05 mobile paragraphs below 14px (footer excluded)', () => {
  const mob = (blocks) => page((p) => { p.viewports.mobile.textBlocks = blocks; });
  assert.ok(find(mob([para({ fontSize: 13.9 })]), 'RES-05'));
  assert.equal(find(mob([para({ fontSize: 14 })]), 'RES-05'), undefined);
  assert.equal(find(mob([para({ fontSize: 12, inFooter: true })]), 'RES-05'), undefined);
});

test('TYP-04 line height: <1.3 major, >2.0 minor; needs ≥80 chars and ≥2 lines', () => {
  const lh = (ratio, over = {}) => page((p) => { D(p).textBlocks = [para({ lineHeightRatio: ratio, ...over })]; });
  assert.equal(find(lh(1.29), 'TYP-04').severity, 'major');
  assert.equal(find(lh(1.3), 'TYP-04'), undefined);
  assert.equal(find(lh(2.01), 'TYP-04:loose').severity, 'minor');
  assert.equal(find(lh(1.0, { textLength: 79 }), 'TYP-04'), undefined);
  assert.equal(find(lh(1.0, { lines: 1 }), 'TYP-04'), undefined);
});

test('TYP-05 line length: >90 chars per line on ≥150-char paragraphs', () => {
  const cpl = (n, over = {}) => page((p) => { D(p).textBlocks = [para({ charsPerLine: n, ...over })]; });
  assert.ok(find(cpl(91), 'TYP-05'));
  assert.equal(find(cpl(90), 'TYP-05'), undefined);
  assert.equal(find(cpl(120, { textLength: 149 }), 'TYP-05'), undefined);
});

test('TYP-06 more than 3 font families', () => {
  const fams = (list) => page((p) => { D(p).textBlocks = list.map((f) => para({ fontFamily: f, text: 'Twenty-plus characters of text' })); });
  assert.ok(find(fams(['A', 'B', 'C', 'D']), 'TYP-06'));
  assert.equal(find(fams(['A', 'B', 'C']), 'TYP-06'), undefined);
});

test('TYP-08 more than 10 distinct font sizes', () => {
  const sizes = (n) => page((p) => { D(p).textBlocks = Array.from({ length: n }, (_, i) => para({ fontSize: 18 + i })); D(p).headings[0].fontSize = 80; });
  assert.ok(find(sizes(11), 'TYP-08'));
  assert.equal(find(sizes(10), 'TYP-08'), undefined);
});

test('LAY-02 more than 6 radii, LAY-03 more than 6 shadows', () => {
  const r = (n) => page((p) => { D(p).radii = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 2), 1])); });
  assert.ok(find(r(7), 'LAY-02'));
  assert.equal(find(r(6), 'LAY-02'), undefined);
  const sh = (n) => page((p) => { D(p).shadows = Object.fromEntries(Array.from({ length: n }, (_, i) => [`0 ${i}px 2px black`, 1])); });
  assert.ok(find(sh(7), 'LAY-03'));
  assert.equal(find(sh(6), 'LAY-03'), undefined);
});

test('LAY-01 spacing: >30% off the 4px grid, or >24 values; values >160px ignored', () => {
  const sp = (vals) => page((p) => { D(p).spacing = Object.fromEntries(vals.map((v) => [String(v), 1])); });
  assert.ok(find(sp([4, 8, 12, 16, 24, 32, 6, 10, 14, 18]), 'LAY-01'));
  assert.equal(find(sp([4, 8, 12, 16, 24, 32, 40, 6, 10, 14]), 'LAY-01'), undefined);
  assert.equal(find(sp([4, 8, 16, 332.5, 401]), 'LAY-01'), undefined);
  assert.ok(find(sp(Array.from({ length: 25 }, (_, i) => (i + 1) * 4)), 'LAY-01'));
});

test('RES-06 mobile fixed header taller than 20% of the viewport', () => {
  const bar = (h) => page((p) => { p.viewports.mobile.fixedBars = [{ selector: 'header', height: h, position: 'sticky' }]; });
  assert.ok(find(bar(163), 'RES-06'));
  assert.equal(find(bar(162), 'RES-06'), undefined);
});

test('INT-01 hover: at least half of ≥2 sampled buttons without feedback', () => {
  const hov = (sampled, bad) => page((p) => { p.hover = { sampled, noFeedback: Array.from({ length: bad }, (_, i) => `button${i}`) }; });
  assert.ok(find(hov(4, 2), 'INT-01'));
  assert.equal(find(hov(4, 1), 'INT-01'), undefined);
  assert.equal(find(hov(1, 1), 'INT-01'), undefined);
});

test('PRF-01 CLS: >0.1 minor, >0.25 major', () => {
  const cls = (v) => page((p) => { p.cls = v; });
  assert.equal(find(cls(0.1), 'PRF-01'), undefined);
  assert.equal(find(cls(0.11), 'PRF-01').severity, 'minor');
  assert.equal(find(cls(0.26), 'PRF-01').severity, 'major');
});

test('PRF-03 page weight above 4 MB excluding scripts', () => {
  const w = (byType) => page((p) => { p.pageWeightByType = byType; });
  assert.ok(find(w({ image: 4 * 1048576 + 1 }), 'PRF-03'));
  assert.equal(find(w({ image: 4 * 1048576 }), 'PRF-03'), undefined);
  assert.equal(find(w({ script: 20 * 1048576 }), 'PRF-03'), undefined);
});

test('ACC-01 contrast: major; gate G3 below 2.5:1', () => {
  const axe = (ratio) => page((p) => { p.axe.desktop = [{ id: 'color-contrast', impact: 'serious', tags: ['wcag2aa'], help: 'contrast', helpUrl: '', nodeCount: 1, nodes: [{ target: 'p', html: '<p>', contrastRatio: ratio }] }]; });
  assert.equal(find(axe(2.49), 'ACC-01').gate, 'G3');
  assert.equal(find(axe(2.5), 'ACC-01').gate, null);
  assert.equal(find(axe(2.5), 'ACC-01').severity, 'major');
});

test('gate conditions: overflow/overlap/clipping only at mobile; focus, labels, viewport meta, and fonts always', () => {
  const overflow = (vp) => page((p) => { p.viewports[vp].document.scrollWidth = p.viewports[vp].viewport.width + 50; });
  assert.equal(find(overflow('mobile'), 'RES-01').gate, 'G5');
  assert.equal(find(overflow('tablet'), 'RES-01').gate, null);
  const overlap = (vp) => page((p) => { p.viewports[vp].overlaps = [{ a: 'h1', b: 'p', aText: 'A', bText: 'B', ratio: 0.5, aboveFold: true }]; });
  assert.equal(find(overlap('mobile'), 'RES-03').gate, 'G5');
  assert.equal(find(overlap('desktop'), 'RES-03').gate, null);
  const clip = (vp) => page((p) => { p.viewports[vp].textBlocks = [para({ clipped: true })]; });
  assert.deepEqual([find(clip('mobile'), 'RES-04').severity, find(clip('mobile'), 'RES-04').gate], ['major', 'G5']);
  assert.deepEqual([find(clip('desktop'), 'RES-04').severity, find(clip('desktop'), 'RES-04').gate], ['minor', null]);
  assert.equal(find(page((p) => { p.focus = { sampled: 3, invisible: [{ selector: 'a', label: 'Home' }] }; }), 'ACC-08').gate, 'G3');
  assert.equal(find(page((p) => { p.viewports.desktop.document.metaViewport = null; }), 'RES-02').gate, 'G5');
  assert.equal(find(page((p) => { p.viewports.desktop.fonts.availability = { Satoshi: false, Fraunces: true }; }), 'TYP-07').gate, 'G6');
  const synth = find(page((p) => { p.viewports.desktop.fonts.syntheticWeights = [{ selector: 'h1', family: 'Fraunces', weight: 800, level: 1 }]; }), 'TYP-09');
  assert.deepEqual([synth.severity, synth.gate], ['major', 'G6']);
});

test('ACC-10 target size: 5+ failing targets is major', () => {
  const t = (n) => page((p) => { p.axe.mobile = [{ id: 'target-size', impact: 'serious', tags: ['wcag22aa'], help: 't', helpUrl: '', nodeCount: n, nodes: [{ target: 'a', html: '<a>' }] }]; });
  assert.equal(find(t(4), 'ACC-10').severity, 'minor');
  assert.equal(find(t(5), 'ACC-10').severity, 'major');
});

test('ACC-11 other WCAG rules form one issue; major if any rule is serious/critical; best-practice rules ignored', () => {
  const rules = (list) => page((p) => { p.axe.desktop = list.map(([id, impact, tags]) => ({ id, impact, tags, help: id, helpUrl: '', nodeCount: 1, nodes: [{ target: 'x', html: '<x>' }] })); });
  assert.equal(find(rules([['aria-allowed-attr', 'serious', ['wcag2a']]]), 'ACC-11').severity, 'major');
  const both = rules([['aria-allowed-attr', 'moderate', ['wcag2a']], ['list', 'moderate', ['wcag2a']]]);
  assert.equal(issues(both).filter((i) => i.id === 'ACC-11').length, 1);
  assert.equal(find(both, 'ACC-11').severity, 'minor');
  assert.equal(issues(rules([['some-best-practice', 'serious', ['best-practice']]])).length, 0);
});

test('IMG-01 broken image is major and not a gate', () => {
  const img = (over) => page((p) => { D(p).images = [{ selector: 'img', src: 'http://x/a.png', alt: 'a', complete: true, naturalWidth: 0, naturalHeight: 0, renderedWidth: 120, renderedHeight: 80, objectFit: 'fill', aboveFold: true, ...over }]; });
  assert.deepEqual([find(img({}), 'IMG-01').severity, find(img({}), 'IMG-01').gate], ['major', null]);
});

test('IMG-02 distortion >5%, IMG-03 upscaling ≥150px, IMG-05 oversize >4×', () => {
  const img = (over) => page((p) => { D(p).images = [{ selector: 'img', src: 'http://x/a.png', alt: 'a', complete: true, naturalWidth: 800, naturalHeight: 400, renderedWidth: 400, renderedHeight: 200, objectFit: 'cover', aboveFold: false, ...over }]; });
  assert.equal(issues(img({})).length, 0);
  assert.ok(find(img({ objectFit: 'fill', renderedHeight: 211 }), 'IMG-02'));
  assert.equal(find(img({ objectFit: 'fill', renderedHeight: 209 }), 'IMG-02'), undefined);
  assert.ok(find(img({ naturalWidth: 199, naturalHeight: 100, renderedWidth: 200, renderedHeight: 100 }), 'IMG-03'));
  assert.equal(find(img({ naturalWidth: 100, naturalHeight: 50, renderedWidth: 149, renderedHeight: 75 }), 'IMG-03'), undefined);
  assert.ok(find(img({ naturalWidth: 401, naturalHeight: 200, renderedWidth: 100, renderedHeight: 50 }), 'IMG-05'));
  assert.equal(find(img({ naturalWidth: 400, naturalHeight: 200, renderedWidth: 100, renderedHeight: 50 }), 'IMG-05'), undefined);
});

test('CLR-02 color tokens: suppressed by a utility color system of ≥10 classes', () => {
  const tok = (colorTokens, utility) => page((p) => { D(p).tokens = { colorTokens, totalTokens: colorTokens, utilityColorClasses: utility }; });
  assert.ok(find(tok(0, 9), 'CLR-02'));
  assert.equal(find(tok(0, 10), 'CLR-02'), undefined);
  assert.equal(find(tok(1, 0), 'CLR-02'), undefined);
});

test('AES-01 default fonts: one → minor, both → major', () => {
  const f = (head, body) => page((p) => { D(p).headings[0].fontFamily = head; D(p).textBlocks = [para({ fontFamily: body })]; });
  assert.equal(find(f('Inter', 'Satoshi'), 'AES-01').severity, 'minor');
  assert.equal(find(f('Inter', 'Roboto'), 'AES-01').severity, 'major');
});

test('INT-02 dead links escalate to major in navigation', () => {
  const l = (inNav) => page((p) => { D(p).links = [{ selector: 'a', href: '#', absHref: 'http://x/#', text: 'Home', inNav }]; });
  assert.equal(find(l(false), 'INT-02').severity, 'minor');
  assert.equal(find(l(true), 'INT-02').severity, 'major');
});

test('CON-01/CON-02 text scans', () => {
  const t = (txt) => page((p) => { D(p).document.visibleText = txt; });
  assert.ok(find(t('Price: undefined'), 'CON-01'));
  assert.ok(find(t('Hello __SITE_NAME__'), 'CON-01'));
  assert.equal(find(t('An undefinedness study'), 'CON-01'), undefined);
  assert.ok(find(t('Waiting for your input'), 'CON-02'));
});

test('ACC-09 reduced motion: infinite animation escalates to major', () => {
  const rm = (infinite) => page((p) => { p.reducedMotion = [{ selector: '.x', animation: 'spin', infinite }]; });
  assert.equal(find(rm(false), 'ACC-09').severity, 'minor');
  assert.equal(find(rm(true), 'ACC-09').severity, 'major');
});

test('INT-01 hover sampling skips the current-page link and off-screen skip links', () => {
  const { hoverExempt } = require('../lib/design-grade/interactions');
  const c = (o) => ({ ariaCurrent: null, classes: [], text: 'Apply now', href: '/apply', offscreen: false, ...o });
  assert.equal(hoverExempt(c({})), null, 'an ordinary button-styled link is sampled');
  assert.equal(hoverExempt(c({ ariaCurrent: 'page' })), 'current page');
  assert.equal(hoverExempt(c({ ariaCurrent: 'false' })), null);
  assert.equal(hoverExempt(c({ classes: ['nav-link', 'active'] })), 'current page');
  assert.equal(hoverExempt(c({ classes: ['interactive'] })), null, 'class names are matched whole');
  assert.equal(hoverExempt(c({ text: 'Skip to content', href: '#main', offscreen: true })), 'off-screen');
  assert.equal(hoverExempt(c({ text: 'Skip to content', href: '#main' })), 'skip link');
  assert.equal(hoverExempt(c({ text: 'Skip the queue', href: '/fast-track' })), null, 'only in-page skip links are exempt');
});
