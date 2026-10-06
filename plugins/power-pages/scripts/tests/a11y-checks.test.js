const assert = require('node:assert/strict');
const test = require('node:test');

const { TRAP_REPEAT, analyzeFocusSequence } = require('../lib/a11y/checks/keyboard');
const { analyzeReflow } = require('../lib/a11y/checks/reflow');
const { runKeyboardCheck } = require('../lib/a11y/checks/keyboard');
const { analyzeZoom } = require('../lib/a11y/checks/zoom');
const { analyzeMotion, videoCriteria } = require('../lib/a11y/checks/motion');
const { analyzeTitles } = require('../lib/a11y/checks/titles');
const { isSubmitLikeDescriptor, stateCandidates } = require('../lib/a11y/checks/inventory');

const el = (selector, extra = {}) => ({ selector, tag: 'a', name: selector, html: `<a>${selector}</a>`, inIframe: false, indicator: true, offscreen: false, ...extra });

test('analyzeFocusSequence reports nothing for a healthy tab order', () => {
  assert.deepEqual(analyzeFocusSequence([el('a1'), el('a2'), el('a3')]), []);
});

test('analyzeFocusSequence detects a keyboard trap once', () => {
  const seq = [el('a1'), ...Array.from({ length: TRAP_REPEAT + 2 }, () => el('input#t', { tag: 'input' }))];
  const findings = analyzeFocusSequence(seq);
  const traps = findings.filter((f) => f.id === 'pp-keyboard-trap');
  assert.equal(traps.length, 1);
  assert.equal(traps[0].impact, 'critical');
  assert.deepEqual(traps[0].wcag, ['2.1.2']);
  assert.equal(traps[0].heuristic, false);
  assert.equal(traps[0].nodes[0].target, 'input#t');
});

test('analyzeFocusSequence does not treat an iframe holding focus as a trap', () => {
  const seq = Array.from({ length: TRAP_REPEAT + 1 }, () => el('iframe#map', { inIframe: true }));
  assert.equal(analyzeFocusSequence(seq).filter((f) => f.id === 'pp-keyboard-trap').length, 0);
});

test('analyzeFocusSequence flags missing focus indicators and offscreen focus as heuristics', () => {
  const findings = analyzeFocusSequence([
    el('a1'),
    el('button.plain', { indicator: false }),
    el('button.plain', { indicator: false }),
    el('a.hidden-menu', { offscreen: true, indicator: false }),
  ]);
  const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
  assert.equal(byId['pp-focus-not-visible'].nodes.length, 1, 'deduped by selector, offscreen excluded');
  assert.equal(byId['pp-focus-not-visible'].heuristic, true);
  assert.deepEqual(byId['pp-focus-not-visible'].wcag, ['2.4.7']);
  assert.equal(byId['pp-focus-offscreen'].nodes[0].target, 'a.hidden-menu');
});

// Minimal page stand-in for walkFocus: the first evaluate() resets focus, each later
// one describes the element the Tab press landed on. The tab-stop gap query (run when
// focus returns to the start) is answered by `gap`, which defaults to "nothing missed".
function fakeFocusPage(describe, gap = () => ({ modal: false, total: 0, missed: [] })) {
  let calls = 0;
  return {
    keyboard: { press: async () => {} },
    evaluate: async (fn, arg) => {
      if (fn.name === 'focusCycleGapInPage') return gap(arg);
      return calls++ === 0 ? undefined : describe(calls - 1);
    },
  };
}
const focusInfo = (n) => ({ selector: `#e${n}`, tag: 'a', name: `e${n}`, html: '<a>', inIframe: false, indicator: true, offscreen: false });

test('runKeyboardCheck reports an incomplete walk when the Tab limit runs out first', async () => {
  const capped = await runKeyboardCheck(fakeFocusPage((i) => focusInfo(i)), { maxTabs: 5 });
  assert.match(capped.incomplete, /within 5 Tab presses/);
  assert.equal(capped.focusOrder.length, 5, 'what was walked is still reported');

  const wrapped = await runKeyboardCheck(fakeFocusPage((i) => focusInfo(i % 3)), { maxTabs: 50 });
  assert.equal(wrapped.incomplete, null);
  assert.equal(wrapped.focusOrder.length, 3);

  const empty = await runKeyboardCheck(fakeFocusPage(() => null), { maxTabs: 5 });
  assert.equal(empty.incomplete, null, 'a page with nothing focusable is fully covered');
});

test('runKeyboardCheck keeps walking while focus is inside an iframe', async () => {
  // e0, then 8 presses inside the iframe, then e2: the controls after the frame count.
  // The fake numbers Tab presses from 1.
  const order = (i) => (i === 1 ? focusInfo(0) : i <= 9 ? { ...focusInfo(1), tag: 'iframe', inIframe: true } : i === 10 ? focusInfo(2) : focusInfo(0));
  const r = await runKeyboardCheck(fakeFocusPage(order), { maxTabs: 50 });
  assert.equal(r.incomplete, null);
  assert.ok(r.focusOrder.some((s) => s.selector === '#e2'), 'the control after the iframe was reached');
  assert.ok(!r.findings.some((f) => f.id === 'pp-keyboard-trap'));

  // Focus that never leaves the frame isn't reported as covered.
  const stuck = await runKeyboardCheck(fakeFocusPage((i) => (i === 1 ? focusInfo(0) : { ...focusInfo(1), inIframe: true })), { maxTabs: 20 });
  assert.match(stuck.incomplete, /within 20 Tab presses/);
});

test('runKeyboardCheck tells a local focus cycle from a full wrap', async () => {
  // e0 -> e1 -> e0: back at the start, but e2 and e3 were never reached.
  const missed = [{ selector: '#e2', tag: 'a', name: 'e2', html: '<a>' }, { selector: '#e3', tag: 'a', name: 'e3', html: '<a>' }];
  let asked = null;
  const r = await runKeyboardCheck(fakeFocusPage((i) => focusInfo((i - 1) % 2), (visited) => {
    asked = visited;
    return { modal: false, total: 2, missed };
  }), { maxTabs: 50 });
  assert.deepEqual(asked, ['#e0', '#e1'], 'the gap query gets the visited selectors');
  assert.match(r.incomplete, /without reaching 2 other focusable control/);
  const cycle = r.findings.find((f) => f.id === 'pp-keyboard-focus-cycle');
  assert.ok(cycle);
  assert.equal(cycle.heuristic, true);
  assert.deepEqual(cycle.wcag, ['2.1.2']);
  assert.deepEqual(cycle.nodes.map((n) => n.target), ['#e2', '#e3']);

  // The same cycle inside an open modal dialog is expected focus containment.
  const modal = await runKeyboardCheck(fakeFocusPage((i) => focusInfo((i - 1) % 2), () => ({ modal: true, total: 0, missed: [] })), { maxTabs: 50 });
  assert.equal(modal.incomplete, null);
  assert.ok(!modal.findings.some((f) => f.id === 'pp-keyboard-focus-cycle'));
});

test('analyzeReflow flags a horizontally scrolling container even when the page fits', () => {
  const findings = analyzeReflow({
    overflow: false, scrollWidth: 320, viewportWidth: 320, offenders: [],
    scrollContainers: [{ target: 'div.scroller', html: '<div>', scrollWidth: 900, clientWidth: 300 }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'pp-reflow-scroll-container');
  assert.equal(findings[0].heuristic, true, 'whether the content needs 2D layout is a judgment call');
  assert.match(findings[0].nodes[0].summary, /900px wide in a 300px scroll area/);
});

test('analyzeReflow reports outermost offenders or the page', () => {
  assert.deepEqual(analyzeReflow({ overflow: false, offenders: [] }), []);
  const [f] = analyzeReflow({ overflow: true, scrollWidth: 808, viewportWidth: 320, offenders: [{ target: 'div.wide', html: '<div>', width: 800, right: 808 }] });
  assert.equal(f.id, 'pp-reflow-horizontal-scroll');
  assert.deepEqual(f.wcag, ['1.4.10']);
  assert.match(f.nodes[0].summary, /808px in a 320px viewport/);
  const [page] = analyzeReflow({ overflow: true, scrollWidth: 400, viewportWidth: 320, offenders: [] });
  assert.equal(page.nodes[0].target, 'html');
  // Overflow that comes only from exempt 2D content (a bare wide table) passes.
  assert.deepEqual(analyzeReflow({ overflow: true, scrollWidth: 900, viewportWidth: 320, offenders: [], twoDOffenders: 1 }), []);
  const [mixed] = analyzeReflow({ overflow: true, scrollWidth: 900, viewportWidth: 320, twoDOffenders: 1, offenders: [{ target: 'p.nw', html: '<p>', width: 600, right: 608 }] });
  assert.deepEqual(mixed.nodes.map((n) => n.target), ['p.nw']);
});

test('analyzeZoom reports clipped text as a heuristic 1.4.4 finding', () => {
  assert.deepEqual(analyzeZoom([]), []);
  const [f] = analyzeZoom([{ target: 'div.clip', html: '<div>', axis: 'vertical' }]);
  assert.equal(f.id, 'pp-text-clipped-at-200');
  assert.deepEqual(f.wcag, ['1.4.4']);
  assert.equal(f.heuristic, true);
});

test('analyzeMotion separates animations from autoplay video and adds 1.4.2 for sound', () => {
  assert.deepEqual(analyzeMotion({ running: [], videos: [] }), []);
  const findings = analyzeMotion({
    running: [{ target: 'div.spin', html: '', infinite: true, name: 'spin' }],
    videos: [{ target: 'video', html: '', muted: false, playing: true }],
  });
  const [motion, video] = findings;
  assert.equal(motion.id, 'pp-motion-ignores-reduced-motion');
  assert.equal(motion.heuristic, true);
  assert.match(motion.nodes[0].summary, /Infinite animation "spin"/);
  assert.equal(video.id, 'pp-autoplay-video-no-controls');
  assert.equal(video.kind, 'violation');
  // A custom pause button can't be ruled out, so this is reviewed, not blocking.
  assert.equal(video.heuristic, true);
  assert.deepEqual(video.wcag, ['1.4.2', '2.2.2']);
  const [mutedOnly] = analyzeMotion({ running: [], videos: [{ target: 'video', html: '', muted: true, playing: true }] });
  assert.deepEqual(mutedOnly.wcag, ['2.2.2']);
});

test('analyzeMotion only asks for review when an autoplay video did not play', () => {
  const findings = analyzeMotion({
    running: [],
    videos: [
      { target: 'video#hero', html: '', muted: true, playing: false },
      { target: 'video#promo', html: '', muted: false, playing: true },
    ],
  });
  assert.deepEqual(findings.map((f) => [f.kind, f.nodes.map((n) => n.target)]), [
    ['violation', ['video#promo']],
    ['needsReview', ['video#hero']],
  ]);
  const [review] = analyzeMotion({ running: [], videos: [{ target: 'video', html: '', muted: true, playing: false }] });
  assert.equal(review.kind, 'needsReview');
  assert.equal(review.heuristic, true);
  assert.deepEqual(review.wcag, ['2.2.2']);
});

test('analyzeTitles reports missing titles and titles shared by several routes', () => {
  const results = analyzeTitles([
    { route: '/', title: 'Contoso' },
    { route: '/about', title: ' contoso ' },
    { route: '/contact', title: 'Contact us | Contoso' },
    { route: '/blank', title: '' },
  ]);
  const missing = results.filter((r) => r.finding.id === 'pp-page-title-missing');
  const dupes = results.filter((r) => r.finding.id === 'pp-page-title-duplicate');
  assert.deepEqual(missing.map((r) => r.route), ['/blank']);
  assert.equal(missing[0].finding.impact, 'serious');
  assert.deepEqual(dupes.map((r) => r.route), ['/', '/about']);
  assert.equal(dupes[0].finding.heuristic, true);
});

test('isSubmitLikeDescriptor follows HTML default button types', () => {
  assert.equal(isSubmitLikeDescriptor({ tag: 'button', type: null, inForm: true }), true);
  assert.equal(isSubmitLikeDescriptor({ tag: 'button', type: null, inForm: false }), false);
  assert.equal(isSubmitLikeDescriptor({ tag: 'button', type: 'button', inForm: true }), false);
  assert.equal(isSubmitLikeDescriptor({ tag: 'button', type: 'SUBMIT', inForm: false }), true);
  assert.equal(isSubmitLikeDescriptor({ tag: 'input', type: 'submit', inForm: true }), true);
  assert.equal(isSubmitLikeDescriptor({ tag: 'input', type: 'image', inForm: true }), true);
  assert.equal(isSubmitLikeDescriptor({ tag: 'input', type: 'text', inForm: true }), false);
  assert.equal(isSubmitLikeDescriptor({ tag: 'a', type: null, inForm: true }), false);
});

test('stateCandidates keeps named popups, disclosures and tabs, deduped, never submit buttons', () => {
  const candidates = stateCandidates([
    { role: 'button', name: 'Menu', kind: 'disclosure', expanded: false, tag: 'button', type: 'button', inForm: false },
    { role: 'button', name: 'menu', kind: 'disclosure', expanded: false, tag: 'button', type: 'button', inForm: false },
    { role: 'tab', name: 'Details', kind: 'tab', expanded: null, tag: 'div', type: null, inForm: false },
    { role: 'button', name: 'Filters', kind: 'popup', expanded: null, tag: 'button', type: null, inForm: true },
    { role: 'button', name: '', kind: 'popup', expanded: null, tag: 'button', type: 'button', inForm: false },
    { role: 'link', name: 'About', kind: 'link', expanded: null, tag: 'a', type: null, inForm: false },
  ]);
  assert.deepEqual(candidates.map((c) => c.label), ['disclosure: Menu', 'tab: Details']);
  assert.deepEqual(candidates[0].steps, [{ action: 'click', role: 'button', name: 'Menu', exact: true }]);
});

test('videoCriteria applies 1.4.2 and 2.2.2 thresholds per video', () => {
  assert.deepEqual(videoCriteria({ muted: true, loop: false, duration: 4 }), []);
  assert.deepEqual(videoCriteria({ muted: false, loop: false, duration: 2 }), []);
  assert.deepEqual(videoCriteria({ muted: false, loop: false, duration: 4 }), ['1.4.2']);
  assert.deepEqual(videoCriteria({ muted: true, loop: false, duration: 6 }), ['2.2.2']);
  assert.deepEqual(videoCriteria({ muted: false, loop: false, duration: 6 }), ['1.4.2', '2.2.2']);
  assert.deepEqual(videoCriteria({ muted: true, loop: true, duration: 1 }), ['2.2.2']);
  // Unknown length (live stream, metadata not loaded) is treated as long.
  assert.deepEqual(videoCriteria({ muted: false, loop: false, duration: null }), ['1.4.2', '2.2.2']);
});

test('analyzeTitles leaves missing titles to axe when asked', () => {
  const pages = [{ route: '/', viewport: 'desktop', title: '' }, { route: '/a', viewport: 'desktop', title: 'Same' }, { route: '/b', viewport: 'desktop', title: 'Same' }];
  const ids = (results) => [...new Set(results.map((r) => r.finding.id))].sort();
  assert.deepEqual(ids(analyzeTitles(pages)), ['pp-page-title-duplicate', 'pp-page-title-missing']);
  assert.deepEqual(ids(analyzeTitles(pages, { includeMissing: false })), ['pp-page-title-duplicate']);
});
