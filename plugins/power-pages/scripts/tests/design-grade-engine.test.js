'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreFromIssues, rankIssues, verdictFor } = require('../lib/design-grade/scoring');
const { validateJudgments } = require('../lib/design-grade/grade');
const { loadCatalog, judgmentIds } = require('../lib/design-grade/catalog');

const iss = (severity, extra = {}) => ({ severity, key: extra.key || severity, routes: ['/'], aboveFold: false, effort: 'S', dimension: 'RA', gate: null, ...extra });

test('catalog is well-formed', () => {
  const cat = loadCatalog();
  const ids = new Set();
  for (const i of cat.issues) {
    assert.ok(!ids.has(i.id), `duplicate id ${i.id}`);
    ids.add(i.id);
    assert.ok(cat.dimensions[i.dimension], `${i.id} has unknown dimension`);
    assert.ok(cat.severities[i.severity], `${i.id} has unknown severity`);
    assert.ok(['S', 'M', 'L'].includes(i.effort), `${i.id} has bad effort`);
    assert.ok(Array.isArray(i.fix) && i.fix.length, `${i.id} needs a fix path`);
    assert.ok(i.trigger, `${i.id} needs a trigger`);
    if (i.detection === 'judgment') assert.ok(i.pass_anchor, `${i.id} needs a pass anchor`);
  }
  const allDims = cat.categories.flatMap((c) => c.dimensions);
  assert.deepEqual([...allDims].sort(), Object.keys(cat.dimensions).sort());
  assert.deepEqual(cat.categories.map((c) => c.name), ['Message & Persuasion', 'Usability & Accessibility', 'Visual Craft & Brand']);
  assert.deepEqual(Object.keys(cat.severities), ['major', 'minor']);
});

test('every one of the 10 sub-dimensions and 7 gates has checklist items', () => {
  const cat = loadCatalog();
  assert.equal(Object.keys(cat.dimensions).length, 10);
  for (const d of Object.keys(cat.dimensions)) assert.ok(cat.issues.some((i) => i.dimension === d), `${d} has no checklist item`);
  for (const g of Object.keys(cat.gates)) assert.ok(cat.issues.some((i) => i.gate === g), `${g} has no checklist item`);
  for (const i of cat.issues.filter((x) => x.gate)) {
    assert.equal(i.severity === 'major' || i.id === 'RES-04', true, `${i.id} is a gate item and must be major (RES-04 escalates at mobile)`);
    assert.ok(i.gateWhen, `${i.id} needs gateWhen`);
  }
  for (const i of cat.issues.filter((x) => x.detection === 'judgment')) assert.ok(i.fail_example, `${i.id} needs a FAIL example`);
});

test('score formula: load = majors + 0.25 * minors; score = 5 - 4 * tanh(0.2 * load)', () => {
  assert.equal(scoreFromIssues([]), 5);
  assert.equal(scoreFromIssues([iss('minor')]), 4.8);
  assert.equal(scoreFromIssues([iss('major')]), 4.21);
  assert.equal(scoreFromIssues([iss('minor'), iss('minor'), iss('minor'), iss('minor')]), 4.21);
  assert.equal(scoreFromIssues([iss('major'), iss('major')]), 3.48);
  assert.equal(scoreFromIssues([iss('major'), iss('major'), iss('major')]), 2.85);
  assert.equal(scoreFromIssues(Array.from({ length: 5 }, () => iss('major'))), 1.95);
});

test('verdict: gate → Not ready; incomplete → Incomplete; major → Needs revision; else Ready', () => {
  assert.equal(verdictFor({ major: 1, minor: 0, gates: 1 }).verdict, 'Not ready');
  assert.equal(verdictFor({ major: 2, minor: 9, gates: 0 }).verdict, 'Needs revision');
  assert.equal(verdictFor({ major: 0, minor: 9, gates: 0 }).verdict, 'Ready');
});

test('scores are per category with no overall score', () => {
  const { scoreAll } = require('../lib/design-grade/scoring');
  const r = scoreAll([iss('major', { key: 'a', dimension: 'RA' }), iss('minor', { key: 'b', dimension: 'FI' }), iss('major', { key: 'c', dimension: 'BC', gate: 'G7' })]);
  assert.deepEqual(r.categories.map((c) => [c.id, c.score]), [['message', 4.8], ['usability', 4.21], ['craft', 4.21]]);
  assert.equal('overall' in r, false);
  assert.deepEqual(r.failingGates.map((g) => g.id), ['G7']);
  assert.equal(r.verdict.verdict, 'Not ready');
});

test('ranking is deterministic: gate, severity, breadth, fold, effort, dimension, key', () => {
  const ranked = rankIssues([
    iss('minor', { key: 'Z' }),
    iss('major', { key: 'B', effort: 'L' }),
    iss('major', { key: 'A', effort: 'S' }),
    iss('major', { key: 'C', routes: ['/', '/a'] }),
    iss('major', { key: 'D', gate: 'G5' }),
  ]);
  assert.deepEqual(ranked.map((i) => i.key), ['D', 'C', 'A', 'B', 'Z']);
  assert.equal(ranked[2].quickWin, true);
});

test('judgments must decide every candidate and answer every J-check with evidence', () => {
  const { page } = require('./design-grade-synthetic');
  const evidence = { baseUrl: 'http://x', viewports: { desktop: {} }, pages: [page((p) => { p.viewports.desktop.document.hasFavicon = false; })] };
  const passAll = () => Object.fromEntries(judgmentIds().map((id) => [id, { result: 'pass' }]));
  const errs = validateJudgments(evidence, { pages: { '/': { 'J-01': { result: 'fail' } } } });
  assert.ok(errs.some((e) => e.includes('J-01') && e.includes('no evidence')));
  assert.ok(errs.some((e) => e.includes('J-02')));
  assert.ok(errs.some((e) => e.includes('missing decision for measured issue CON-03')));
  const ok = { candidates: { 'CON-03': { decision: 'confirm' } }, pages: { '/': passAll() } };
  assert.deepEqual(validateJudgments(evidence, ok), []);
  const shortDismiss = { ...ok, candidates: { 'CON-03': { decision: 'dismiss', reason: 'nah' } } };
  assert.ok(validateJudgments(evidence, shortDismiss).some((e) => e.includes('needs a reason')));
  const unknown = { ...ok, candidates: { ...ok.candidates, 'ACC-01': { decision: 'confirm' } } };
  assert.ok(validateJudgments(evidence, unknown).some((e) => e.includes('ACC-01 is not a measured issue')));
  const override = { ...ok, pages: { '/': { ...passAll(), 'J-01': { result: 'fail', evidence: 'x', severity: 'minor' } } } };
  assert.ok(validateJudgments(evidence, override).some((e) => e.includes('severity is fixed')));
});

test('dismissed candidates leave the score and are listed with their reason; judgment gates count', () => {
  const { page } = require('./design-grade-synthetic');
  const { buildGrade } = require('../lib/design-grade/grade');
  const evidence = { baseUrl: 'http://x', viewports: { desktop: {} }, pages: [page((p) => { p.viewports.desktop.document.hasFavicon = false; })] };
  const pages = { '/': Object.fromEntries(judgmentIds().map((id) => [id, { result: 'pass' }])) };
  const confirmed = buildGrade(evidence, { candidates: { 'CON-03': { decision: 'confirm' } }, pages }, {});
  assert.deepEqual(confirmed.issues.map((i) => i.key), ['CON-03']);
  assert.equal(confirmed.categories.find((c) => c.id === 'craft').score, 4.8);
  const reason = 'The favicon is injected at runtime by the host page; the screenshot tab shows it.';
  const dismissed = buildGrade(evidence, { candidates: { 'CON-03': { decision: 'dismiss', reason } }, pages }, {});
  assert.deepEqual(dismissed.issues, []);
  assert.deepEqual(dismissed.dismissed.map((d) => [d.key, d.reason]), [['CON-03', reason]]);
  assert.equal(dismissed.verdict.verdict, 'Ready');
  pages['/']['J-08'] = { result: 'fail', evidence: 'Stock gradient hero and three icon cards; nothing specific to the club.', screenshot: 'shots/home-desktop-full.png' };
  const gated = buildGrade(evidence, { candidates: { 'CON-03': { decision: 'dismiss', reason } }, pages }, {});
  assert.equal(gated.issues[0].gate, 'G7');
  assert.equal(gated.verdict.verdict, 'Not ready');
});

test('missing evidence can never produce "Ready"', () => {
  assert.equal(verdictFor({ major: 0, minor: 0, gates: 0 }, true).verdict, 'Incomplete');
  assert.equal(verdictFor({ major: 1, minor: 0, gates: 1 }, true).verdict, 'Not ready');
  const { buildGrade } = require('../lib/design-grade/grade');
  const g = buildGrade({ baseUrl: 'http://x', viewports: { desktop: {}, mobile: {} }, pages: [{ route: '/', viewports: { desktop: { error: 'net::ERR_CONNECTION_REFUSED' } } }] }, null, { autoOnly: true });
  assert.equal(g.verdict.verdict, 'Incomplete');
  assert.ok(g.categories.every((c) => c.score === null));
  assert.equal(g.coverage.complete, false);
});


test('design-rubric-checks.md is generated from the current catalog', () => {
  const fs = require('fs');
  const { render, OUT } = require('../lib/design-grade/render-rubric');
  assert.equal(fs.readFileSync(OUT, 'utf8'), render(), 'run: node scripts/lib/design-grade/render-rubric.js');
});

test('first-impression profile judges only its items on the start page and gives no category scores', () => {
  const { page } = require('./design-grade-synthetic');
  const { buildGrade } = require('../lib/design-grade/grade');
  const evidence = { baseUrl: 'http://x', viewports: { desktop: {} }, pages: [
    page((p) => { p.viewports.desktop.document.hasFavicon = false; }),
    { ...page(), route: '/about' },
  ] };
  assert.deepEqual(judgmentIds('first-impression'), ['J-01', 'J-02', 'J-14', 'J-15']);
  const pass = Object.fromEntries(judgmentIds('first-impression').map((id) => [id, { result: 'pass' }]));
  assert.deepEqual(validateJudgments(evidence, { candidates: {}, pages: { '/': pass } }, 'first-impression'), [], 'CON-03 is outside the profile, so no candidate decision is needed');
  const extra = { candidates: {}, pages: { '/': { ...pass, 'J-08': { result: 'pass' } } } };
  assert.ok(validateJudgments(evidence, extra, 'first-impression').some((e) => e.includes('J-08 is not a judgment item of the "first-impression" review')));
  const g = buildGrade(evidence, { candidates: {}, pages: { '/': pass } }, { profile: 'first-impression' });
  assert.equal(g.verdict.verdict, 'First impression passes');
  assert.ok(g.categories.every((c) => c.score === null));
  assert.deepEqual(g.coverage.pagesGraded, ['/']);
  const fail = buildGrade(evidence, { candidates: {}, pages: { '/': { ...pass, 'J-14': { result: 'fail', evidence: 'No headline states the offering.', screenshot: 'home-desktop.png' } } } }, { profile: 'first-impression' });
  assert.equal(fail.verdict.verdict, 'First impression fails');
  assert.equal(fail.failingGates[0].id, 'G1');
});

test('the design rubric method is its own reference; the shared review rubric is untouched', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const read = (rel) => fs.readFileSync(path.join(pluginRoot, rel), 'utf8').replace(/\r\n/g, '\n');
  const method = read('references/design-rubric.md');
  for (const heading of ['## What is judged: 3 categories, 10 sub-dimensions', '## Severity and critical gates', '## Finding issues consistently', '## Scores and verdict']) {
    assert.ok(method.includes(`\n${heading}\n`), heading);
  }
  assert.match(method, /score = 5 - 4 \* tanh\(0\.2 \* load\)/);
  assert.match(read('references/design-rubric-checks.md'), /\[design-rubric\.md\]\(design-rubric\.md\)/);
  const critique = read('references/design-critique.md');
  assert.doesNotMatch(critique, /design-rubric|grade-design-review|"measure"/, 'create-site and exceptional-web-design keep their existing review');
  assert.match(critique, /\n## Rubric\n\nScore each category from 0 to 4\./);
});

test('a judgment item covered by a confirmed measured issue on the same page is counted once', () => {
  const { page } = require('./design-grade-synthetic');
  const { buildGrade } = require('../lib/design-grade/grade');
  const evidence = { baseUrl: 'http://x', viewports: { desktop: {}, mobile: {} }, pages: [page((p) => { p.viewports.mobile.document.scrollWidth = 600; })] };
  const fail = { result: 'fail', evidence: 'Table columns cut off on mobile.', screenshot: 'shots/home-mobile-fold.jpg' };
  const pages = { '/': { ...Object.fromEntries(judgmentIds().map((id) => [id, { result: 'pass' }])), 'J-06': fail } };
  const g = buildGrade(evidence, { candidates: { 'RES-01': { decision: 'confirm' } }, pages }, {});
  assert.deepEqual(g.issues.map((i) => i.key), ['RES-01']);
  assert.deepEqual(g.merged.map((m) => [m.key, m.coveredBy]), [['J-06', 'RES-01']]);
  assert.equal(g.categories.find((c) => c.id === 'usability').score, 4.21, 'scored once');
  const reason = 'The page uses an intentional horizontally scrolling gallery that is fully reachable.';
  const kept = buildGrade(evidence, { candidates: { 'RES-01': { decision: 'dismiss', reason } }, pages }, {});
  assert.deepEqual(kept.issues.map((i) => i.key), ['J-06'], 'a dismissed measurement does not cover the judgment');
  assert.deepEqual(kept.merged, []);
});

test('form pages are judged by J-25, not the landing-page call-to-action items', () => {
  const cat = loadCatalog();
  const item = (id) => cat.issues.find((i) => i.id === id);
  for (const id of ['J-02', 'J-15']) assert.match(item(id).applies, /n\/a for pages whose main content is a form/, `${id} excludes form pages`);
  const j25 = item('J-25');
  assert.equal(j25.severity, 'minor');
  assert.equal(j25.gate, undefined, 'a form-page item never fails a critical gate');
  assert.match(j25.trigger, /below the first screen is not a failure/);
  assert.ok(judgmentIds().includes('J-25'));
});

test('cramped mobile layouts are a minor item; only concrete breakage fails gate G5', () => {
  const cat = loadCatalog();
  const item = (id) => cat.issues.find((i) => i.id === id);
  const j06 = item('J-06');
  assert.equal(j06.gate, 'G5');
  assert.match(j06.trigger, /Cramped but readable layouts .* are not breakage; judge them with J-26/);
  const j26 = item('J-26');
  assert.equal(j26.severity, 'minor');
  assert.equal(j26.gate, undefined, 'a cramped layout never fails a critical gate');
  assert.equal(j26.dimension, 'RA');
  assert.ok(judgmentIds().includes('J-26'));
});
