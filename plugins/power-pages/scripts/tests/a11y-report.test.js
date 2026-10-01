const assert = require('node:assert/strict');
const test = require('node:test');

const { EXIT } = require('../lib/a11y/args');
const { ReportBuilder, exitCodeFor, isBlocking, makeFinding } = require('../lib/a11y/report');

const builder = () => new ReportBuilder({ baseUrl: 'http://localhost:5173/', viewports: ['desktop', 'mobile'], checks: ['axe'], bestPractice: true, tool: { name: 't' } });

test('makeFinding infers bestPractice from missing WCAG criteria', () => {
  assert.equal(makeFinding({ id: 'x', impact: 'minor', description: 'd' }).bestPractice, true);
  assert.equal(makeFinding({ id: 'x', impact: 'minor', wcag: ['1.1.1'], description: 'd' }).bestPractice, false);
  assert.equal(makeFinding({ id: 'x', impact: 'minor', description: 'd' }).source, 'extended');
});

test('isBlocking only counts critical/serious WCAG violations that are not heuristic', () => {
  const base = { kind: 'violation', impact: 'serious', bestPractice: false, heuristic: false };
  assert.equal(isBlocking(base), true);
  assert.equal(isBlocking({ ...base, impact: 'critical' }), true);
  assert.equal(isBlocking({ ...base, impact: 'moderate' }), false);
  assert.equal(isBlocking({ ...base, bestPractice: true }), false);
  assert.equal(isBlocking({ ...base, heuristic: true }), false);
  assert.equal(isBlocking({ ...base, kind: 'needsReview' }), false);
});

test('ReportBuilder groups by rule then node and records every occurrence', () => {
  const b = builder();
  const contrast = (impact) => ({ id: 'color-contrast', source: 'axe', kind: 'violation', impact, wcag: ['1.4.3'], bestPractice: false, heuristic: false, description: 'c', helpUrl: null, nodes: [{ target: 'header a', html: '<a>', summary: 's' }] });
  b.addPage({ route: '/', viewport: 'desktop', url: 'u' });
  b.addFindings([contrast('moderate')], { route: '/', viewport: 'desktop' });
  b.addFindings([contrast('serious')], { route: '/about', viewport: 'mobile' });
  b.addFindings([makeFinding({ id: 'pp-page-title-missing', impact: 'serious', wcag: ['2.4.2'], description: 'd' })], { route: '/x', viewport: 'desktop' });
  b.addFindings([{ ...contrast('serious'), kind: 'needsReview' }], { route: '/', viewport: 'desktop', state: 'Menu open' });

  const report = b.build({ crawl: { queued: 1 } });
  assert.equal(report.violations.length, 2);
  assert.equal(report.needsReview.length, 1);
  const c = report.violations.find((v) => v.id === 'color-contrast');
  assert.equal(c.impact, 'serious', 'keeps the most severe impact');
  assert.equal(c.nodes.length, 1);
  assert.deepEqual(c.nodes[0].occurrences, [
    { route: '/', viewport: 'desktop', state: null },
    { route: '/about', viewport: 'mobile', state: null },
  ]);
  const t = report.violations.find((v) => v.id === 'pp-page-title-missing');
  assert.equal(t.nodes[0].target, '(page)', 'nodeless findings get a page placeholder');
  assert.equal(report.needsReview[0].nodes[0].occurrences[0].state, 'Menu open');
  assert.deepEqual(report.summary, {
    pagesAudited: 1, pageLayoutsAudited: 1, pageErrors: 0, statesAudited: 0, stateErrors: 0, checkErrors: 0, blockedRequests: 0,
    violations: 2, blocking: 2, needsReview: 1,
    byImpact: { critical: 0, serious: 2, moderate: 0, minor: 0 },
  });
  assert.deepEqual(report.crawl, { queued: 1 });
});

test('ReportBuilder counts pages by route, not by route and layout', () => {
  const b = builder();
  for (const route of ['/', '/about']) {
    for (const viewport of ['desktop', 'mobile']) b.addPage({ route, viewport, url: 'u' });
  }
  b.addPage({ route: '/contact', viewport: 'desktop', url: 'u' });
  b.addPage({ route: '/contact', viewport: 'mobile', url: 'u', error: 'HTTP 500' });
  b.addPage({ route: '/broken', viewport: 'desktop', url: 'u', error: 'HTTP 500' });
  const { summary } = b.build();
  assert.equal(summary.pagesAudited, 3, '/, /about, and /contact loaded on at least one layout');
  assert.equal(summary.pageLayoutsAudited, 5);
  assert.equal(summary.pageErrors, 2);
});

test('ReportBuilder keeps different elements that share a positional selector apart', () => {
  const b = builder();
  const finding = (html) => makeFinding({ id: 'pp-text-clipped-at-200', impact: 'serious', wcag: ['1.4.4'], description: 'd', nodes: [{ target: 'main > p:nth-of-type(2)', html, summary: 's' }] });
  b.addFindings([finding('<p>Our services</p>')], { route: '/about', viewport: 'desktop' });
  b.addFindings([finding('<p>Opening hours</p>')], { route: '/contact', viewport: 'desktop' });
  b.addFindings([finding('<p>Our services</p>')], { route: '/about', viewport: 'mobile' });
  const [f] = b.build().violations;
  assert.equal(f.nodes.length, 2);
  assert.deepEqual(f.nodes.map((n) => [n.html, n.occurrences.length]), [['<p>Our services</p>', 2], ['<p>Opening hours</p>', 1]]);
});

test('exitCodeFor puts incomplete audits ahead of violations', () => {
  const s = (o) => ({ summary: { pageErrors: 0, stateErrors: 0, checkErrors: 0, blocking: 0, ...o } });
  assert.equal(exitCodeFor(s({})), EXIT.PASS);
  assert.equal(exitCodeFor(s({ blocking: 3 })), EXIT.VIOLATIONS);
  assert.equal(exitCodeFor(s({ blocking: 3, pageErrors: 1 })), EXIT.LOAD_FAILURE);
  assert.equal(exitCodeFor(s({ stateErrors: 1 })), EXIT.LOAD_FAILURE);
  assert.equal(exitCodeFor(s({ blocking: 3, checkErrors: 1 })), EXIT.LOAD_FAILURE);
  assert.equal(exitCodeFor(s({ blockedRequests: 4 })), EXIT.PASS, 'the safety guard working is not a failure');
});

test('check errors from pages and states make the audit incomplete', () => {
  const b = builder();
  b.addPage({ route: '/', viewport: 'desktop', url: 'u', checkErrors: [{ check: 'zoom', message: 'boom' }] });
  b.addState({ label: 'Menu', route: '/', viewport: 'desktop', checkErrors: [{ check: 'keyboard', message: 'boom' }], blockedRequests: { count: 2, requests: [] } });
  b.addState({ label: 'Dialog', route: '/', viewport: 'desktop' });
  const report = b.build();
  assert.equal(report.summary.checkErrors, 2);
  assert.equal(report.summary.statesAudited, 2);
  assert.equal(report.summary.blockedRequests, 2);
  assert.deepEqual(report.states[1], { label: 'Dialog', route: '/', viewport: 'desktop', error: null, checkErrors: [], blockedRequests: null });
  assert.equal(exitCodeFor(report), EXIT.LOAD_FAILURE);
});
