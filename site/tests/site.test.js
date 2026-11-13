'use strict';

// Tests for the showcase site: the shared install links, catalog validation, the static build,
// the browser launcher, and the README links that are built from the same templates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const links = require('../lib/install-links.js');
const { loadCatalog } = require('../lib/catalog.js');
const render = require('../lib/render.js');
const { build, parseArgs, MARKER } = require('../build.js');
const media = require('../lib/media.js');
const installer = require('../../scripts/install.js');
const evaluations = require('../lib/evaluations.js');
const { renderEvaluations } = require('../lib/render-evaluations.js');
const { hashFile, hashTree } = require('../../scripts/lib/eval-evidence.js');

const MARKETPLACE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'marketplace.json'), 'utf8'));
const MARKETPLACE_NAMES = MARKETPLACE.plugins.map((plugin) => plugin.name).sort();

// Names that must never reach a prompt, a shell command, or a URL. Mirrors the installer's
// injection corpus. Prototype keys such as "constructor" are valid names, so the launcher's
// allowlist test covers them instead.
const BAD_NAMES = [
  'power-pages$(echo REVIEW_ONLY)',
  'power-pages`echo REVIEW_ONLY`',
  'power-pages" & echo REVIEW_ONLY & rem "',
  'power-pages;echo REVIEW_ONLY',
  'power-pages|echo REVIEW_ONLY',
  'power-pages\n',
  'power-pages --scope project',
  '../power-pages',
  'Power-Pages',
  '__proto__',
  '',
  'a--b',
  '-power-pages',
  'x'.repeat(65),
  null,
  42,
];

const TEMP_DIRS = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// These tiny, synthetic summaries exist only in tests. Production builds ship no
// example scores or model responses.
function evidenceFixture() {
  const root = tempDir('pps-evidence-');
  const pluginDir = path.join(root, 'plugins', 'sample');
  const skillFile = path.join(pluginDir, 'skills', 'write-docs', 'SKILL.md');
  const suiteFile = path.join(root, 'evals', 'sample', 'write-docs', 'eval.yaml');
  const runtimeDir = path.join(root, 'evals', 'runtime');
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.mkdirSync(path.dirname(suiteFile), { recursive: true });
  fs.writeFileSync(skillFile, 'Test skill');
  fs.writeFileSync(suiteFile, 'name: test-suite\n');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'grader.js'), '// Test-only runtime\n');
  writeJson(path.join(root, 'marketplace.json'), { plugins: [{ name: 'sample', source: './plugins/sample' }] });
  const cases = [{ name: 'documentation', kind: 'capability' }, { name: 'diagram', kind: 'capability' }, { name: 'unrelated request', kind: 'dormancy' }];
  const summary = {
    schemaVersion: 1, plugin: 'sample', commit: 'a'.repeat(40), generatedAt: '2026-01-15T12:00:00Z',
    model: 'test-model', judgeModel: 'test-judge', runUrl: 'https://github.com/example/project/actions/runs/123',
    pluginHash: hashTree(pluginDir), runtimeHash: hashTree(runtimeDir),
    suites: [{
      skill: 'write-docs', skillHash: hashFile(skillFile), suiteHash: hashTree(path.dirname(suiteFile)), runs: 2,
      expectedCases: cases,
      results: cases.flatMap((item) => ['baseline', 'skilled'].flatMap((variant) => [0, 1].map((trial) => ({
        ...item, variant, trial, status: variant === 'baseline' && item.kind === 'capability' ? 'failed' : 'passed',
        score: variant === 'baseline' && item.kind === 'capability' ? 0 : 1,
        checks: [{ name: 'artifact-quality', passed: !(variant === 'baseline' && item.kind === 'capability') }],
        tokens: 100, durationMs: 2000, error: null,
      })))),
    }],
  };
  const catalog = { plugins: [{ name: 'sample', title: 'Sample plugin', docsUrl: 'https://github.com/example/project' }] };
  const summaryFile = path.join(root, 'summary.json');
  function load(value = summary, options = {}) {
    writeJson(summaryFile, value);
    return evaluations.loadEvaluations({ repoRoot: root, catalog, evalResults: summaryFile, now: new Date('2026-01-16T12:00:00Z'), ...options });
  }
  return { root, pluginDir, skillFile, suiteFile, runtimeDir, summary, summaryFile, catalog, load };
}

test('evaluation inventory discovers every real skill, not only featured catalog entries', () => {
  const catalog = loadCatalog(REPO_ROOT);
  const data = evaluations.loadEvaluations({ repoRoot: REPO_ROOT, catalog });
  assert.deepEqual(data.plugins.map((plugin) => plugin.name).sort(), MARKETPLACE_NAMES);
  for (const entry of MARKETPLACE.plugins.filter((plugin) => typeof plugin.source === 'string')) {
    const skillDir = path.join(REPO_ROOT, entry.source, 'skills');
    const expected = fs.existsSync(skillDir) ? fs.readdirSync(skillDir, { withFileTypes: true })
      .filter((item) => item.isDirectory() && fs.existsSync(path.join(skillDir, item.name, 'SKILL.md'))).map((item) => item.name).sort() : [];
    assert.deepEqual(data.plugins.find((plugin) => plugin.name === entry.name).skills.map((skill) => skill.name).sort(), expected);
  }
  const html = renderEvaluations(data);
  assert.match(html, /No evaluation results published yet/);
  assert.match(html, /Not evaluated/);
  assert.match(html, /skill inventory is unavailable/);
  assert.doesNotMatch(html, /test-model|percentage points with skill|Consistent offline evidence<\/span>/);
});

test('evaluations use the showcase layout, navigation and color theme', () => {
  const catalog = loadCatalog(REPO_ROOT);
  const html = renderEvaluations(evaluations.loadEvaluations({ repoRoot: REPO_ROOT, catalog }));
  assert.match(html, /<header class="site-header">/);
  assert.match(html, /<footer class="site-footer">/);
  assert.match(html, /href="\.\.\/evaluations\/" aria-current="page"/);
  assert.match(html, /<script src="\.\.\/assets\/theme\.js"><\/script>/);
  assert.match(html, /<script src="\.\.\/assets\/site\.js" defer><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/assets\/styles\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/assets\/evaluations\.css">/);
  for (const choice of ['system', 'light', 'dark']) {
    assert.match(html, new RegExp(`data-theme-choice="${choice}"`));
  }
  assert.doesNotMatch(html, /evaluations-theme\.js/);
  assert.doesNotMatch(fs.readFileSync(path.join(REPO_ROOT, 'site/assets/evaluations.css'), 'utf8'), /--cp-/);
});

test('token dashboard aggregates retained runs and labels incomplete usage', () => {
  const fixture = evidenceFixture();
  const first = structuredClone(fixture.summary);
  first.schemaVersion = 2;
  const suite = first.suites[0];
  suite.runs = 1;
  suite.expectedCases = [suite.expectedCases[0]];
  suite.results = suite.results.filter((item) => item.name === suite.expectedCases[0].name && item.trial === 0);
  Object.assign(suite.results[0], {
    tokens: 100,
    agentUsage: { inputTokens: 70, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: null },
    judgeUsage: { calls: 1, reportedCalls: 1, inputTokens: 10, outputTokens: 5 },
  });
  Object.assign(suite.results[1], {
    tokens: null, agentUsage: null,
    judgeUsage: { calls: 1, reportedCalls: 0, inputTokens: 0, outputTokens: 0 },
  });
  const second = structuredClone(first);
  second.generatedAt = '2026-01-16T00:00:00Z';
  second.runUrl = 'https://github.com/example/project/actions/runs/124';
  Object.assign(second.suites[0].results[0], {
    tokens: 30,
    agentUsage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    judgeUsage: { calls: 0, reportedCalls: 0, inputTokens: 0, outputTokens: 0 },
  });
  Object.assign(second.suites[0].results[1], {
    tokens: 10,
    agentUsage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null },
    judgeUsage: { calls: 2, reportedCalls: 1, inputTokens: 7, outputTokens: 3 },
  });
  const secondFile = path.join(fixture.root, 'second.json');
  writeJson(secondFile, second);
  const html = renderEvaluations(fixture.load(first, { evalResults: [fixture.summaryFile, secondFile] }));
  assert.match(html, /Token usage/);
  assert.match(html, /Reported total<\/h3><strong>At least 165/);
  assert.match(html, /At least 140/);
  assert.match(html, /At least 25/);
  assert.match(html, /Judge input<\/h3><strong>At least 17/);
  assert.match(html, /Judge output<\/h3><strong>At least 8/);
  assert.match(html, /3 of 4 recorded trials/);
  assert.match(html, /2 of 4 judge calls/);
  assert.match(html, /2026-01-15/);
  assert.match(html, /2026-01-16/);
});

test('complete evidence separates capability, dormancy, baseline and distinct tasks', () => {
  const fixture = evidenceFixture();
  const item = fixture.load().plugins[0].skills[0].evidence[0];
  assert.equal(item.category, 'Consistent offline evidence');
  assert.equal(item.capability.passed, 4);
  assert.equal(item.capability.expected, 4);
  assert.equal(item.capability.tasks, 2);
  assert.equal(item.capability.allRunsPassed, 2);
  assert.equal(item.dormancy.expected, 2);
  assert.equal(item.baseline.passed, 0);
  assert.equal(item.delta, 1);
  assert.match(renderEvaluations(fixture.load()), /4\/4<\/strong> passed/);
  fixture.summary.suites[0].results[0].score = 0.123456789;
  const html = renderEvaluations(fixture.load());
  assert.match(html, /<td>0\.123<\/td>/);
  assert.doesNotMatch(html, /0\.123456789/);
});

test('reasoning effort is validated, displayed and kept separate from older or different-effort evidence', () => {
  const fixture = evidenceFixture();
  const medium = structuredClone(fixture.summary);
  Object.assign(medium, { schemaVersion: 3, reasoningEffort: 'medium', judgeReasoningEffort: 'medium' });
  for (const result of medium.suites[0].results) {
    result.agentUsage = { inputTokens: 70, outputTokens: 30, cacheReadTokens: null, cacheWriteTokens: null };
    result.judgeUsage = { calls: 1, reportedCalls: 1, inputTokens: 10, outputTokens: 5 };
  }
  assert.equal(evaluations.validateSummary(medium), medium);
  const high = { ...medium, reasoningEffort: 'high' };
  const highJudge = { ...medium, judgeReasoningEffort: 'high' };
  writeJson(path.join(fixture.root, 'medium.summary.json'), medium);
  writeJson(path.join(fixture.root, 'high.summary.json'), high);
  writeJson(path.join(fixture.root, 'high-judge.summary.json'), highJudge);
  const data = fixture.load(fixture.summary, { evalResults: fixture.root });
  const items = data.plugins[0].skills[0].evidence;
  assert.equal(items.length, 4, 'legacy, agent effort and judge effort cannot overwrite each other');
  const html = renderEvaluations(data);
  assert.match(html, /test-model \(medium effort\)/);
  assert.match(html, /test-model \(high effort\)/);
  assert.match(html, /test-model \(unreported effort\)/);
  assert.match(html, /Judge: test-judge \(high effort\)/);
  for (const patch of [
    { reasoningEffort: 'auto' }, { judgeReasoningEffort: undefined }, { judgeModel: medium.model },
  ]) {
    assert.throws(() => evaluations.validateSummary({ ...medium, ...patch }), /Invalid evaluation summary/);
  }
});

test('missing role/trial records stay incomplete and never receive a positive category', () => {
  const fixture = evidenceFixture();
  fixture.summary.suites[0].results.pop();
  const item = fixture.load().plugins[0].skills[0].evidence[0];
  assert.equal(item.complete, false);
  assert.equal(item.category, 'Limited evidence');
  assert.equal(item.dormancy.expected, 2);
  assert.equal(item.dormancy.recorded, 1);
  assert.equal(item.dormancy.missing, 1);
  assert.equal(item.delta, null);
  assert.match(renderEvaluations(fixture.load()), /1 missing records/);
});

test('summary directories discover nested summaries without reading private JSON artifacts', () => {
  const fixture = evidenceFixture();
  const results = path.join(fixture.root, 'results');
  writeJson(path.join(results, 'run-one', 'summary.json'), fixture.summary);
  writeJson(path.join(results, 'private-artifact.json'), { transcript: 'not a summary' });
  const loaded = evaluations.readSummaries(results);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].model, 'test-model');
  assert.throws(() => evaluations.readSummaries(path.join(results, 'private-artifact.json')), /Invalid evaluation summary/);
  assert.throws(() => evaluations.readSummaries(tempDir('pps-evidence-empty-')), /no JSON summaries/);
});

test('errors remain in the denominator and repeated passes are not independent tasks', () => {
  const fixture = evidenceFixture();
  const result = fixture.summary.suites[0].results.find((item) => item.variant === 'skilled');
  Object.assign(result, { status: 'error', score: null, error: 'GRADER_ERROR', checks: [] });
  const item = fixture.load().plugins[0].skills[0].evidence[0];
  assert.equal(item.category, 'Mixed results');
  assert.equal(item.capability.passed, 3);
  assert.equal(item.capability.expected, 4);
  assert.equal(item.capability.errors, 1);
  assert.equal(item.capability.allRunsPassed, 1);
  assert.equal(item.delta, .75);
});

test('changed plugin, skill, suite inputs and runtime invalidate current evidence', () => {
  for (const target of ['plugin', 'skill', 'suite', 'fixture', 'hidden-check', 'runtime']) {
    const fixture = evidenceFixture();
    const file = {
      plugin: path.join(fixture.pluginDir, 'helper.js'),
      skill: fixture.skillFile,
      suite: fixture.suiteFile,
      fixture: path.join(path.dirname(fixture.suiteFile), 'fixture.txt'),
      'hidden-check': path.join(path.dirname(fixture.suiteFile), 'hidden-check.js'),
      runtime: path.join(fixture.runtimeDir, 'grader.js'),
    }[target];
    fs.appendFileSync(file, '\nchanged');
    const item = fixture.load().plugins[0].skills[0].evidence[0];
    assert.equal(item.changed, true, target);
    assert.equal(item.category, 'Limited evidence', target);
    if (target === 'runtime') {
      assert.equal(item.runtimeChanged, true);
      assert.match(renderEvaluations(fixture.load()), /Source mismatch - evaluation runtime changed/);
    }
  }
  const fixture = evidenceFixture();
  fs.rmSync(fixture.suiteFile);
  assert.equal(fixture.load().plugins[0].skills[0].evidence[0].changed, true);
  const runtimeFixture = evidenceFixture();
  fs.rmSync(runtimeFixture.runtimeDir, { recursive: true });
  assert.equal(runtimeFixture.load().plugins[0].skills[0].evidence[0].runtimeChanged, true);
  const cached = evidenceFixture();
  for (const dir of [cached.runtimeDir, path.dirname(cached.suiteFile)]) {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'test-only-cache'), 'ignored');
  }
  assert.equal(cached.load().plugins[0].skills[0].evidence[0].category, 'Consistent offline evidence');
});

test('old evidence and narrow task coverage stay limited even when all trials pass', () => {
  const fixture = evidenceFixture();
  const old = fixture.load(fixture.summary, { now: new Date('2026-03-01T12:00:00Z') }).plugins[0].skills[0].evidence[0];
  assert.equal(old.fresh, false);
  assert.equal(old.category, 'Limited evidence');
  const suite = fixture.summary.suites[0];
  suite.expectedCases = suite.expectedCases.filter((item) => item.name !== 'diagram');
  suite.results = suite.results.filter((item) => item.name !== 'diagram');
  assert.equal(fixture.load().plugins[0].skills[0].evidence[0].category, 'Limited evidence');
});

test('summary validation rejects malformed, duplicate, contradictory and unsafe evidence', () => {
  const fixture = evidenceFixture();
  const mutations = [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.output = 'raw output must not publish'; },
    (value) => { value.plugin = 1; },
    (value) => { value.pluginHash = 'wrong'; },
    (value) => { delete value.runtimeHash; },
    (value) => { value.runtimeHash = 'wrong'; },
    (value) => { value.generatedAt = 'not a date'; },
    (value) => { value.generatedAt = '2026-02-30T12:00:00Z'; },
    (value) => { value.suites[0].runs = 0; },
    (value) => { value.suites[0].expectedCases.push(value.suites[0].expectedCases[0]); },
    (value) => { value.suites[0].results.push(value.suites[0].results[0]); },
    (value) => { value.suites[0].results[0].trial = 2; },
    (value) => { value.suites[0].results[0].variant = 'unknown'; },
    (value) => { value.suites[0].results[0].score = 1.1; },
    (value) => { value.suites[0].results[0].status = 'passed'; },
    (value) => { value.suites[0].results[0].checks = [{ name: '<script>', passed: true }]; },
    (value) => { value.suites[0].results[0].error = 'raw private error text'; },
    (value) => { value.suites[0].results[0].tokens = -1; },
    (value) => { value.runUrl = 'javascript:alert(1)'; },
    (value) => { value.runUrl = 'https://github.com.evil.example/a/b/actions/runs/1'; },
    (value) => { value.runUrl = 'https://github.com@evil.example/a/b/actions/runs/1'; },
    (value) => { value.runUrl += '?token=private'; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(fixture.summary);
    mutate(value);
    assert.throws(() => evaluations.validateSummary(value), /Invalid evaluation summary/, mutate.toString());
  }
  assert.throws(() => fixture.load({ ...fixture.summary, plugin: 'unknown' }), /unknown/);
  assert.throws(() => fixture.load({ ...fixture.summary, generatedAt: '2027-01-01T00:00:00Z' }), /future/);
});

test('usage summaries reject invalid counts and private nested fields', () => {
  const fixture = evidenceFixture();
  const summary = structuredClone(fixture.summary);
  summary.schemaVersion = 2;
  for (const result of summary.suites[0].results) {
    result.agentUsage = { inputTokens: 70, outputTokens: 30, cacheReadTokens: null, cacheWriteTokens: null };
    result.judgeUsage = { calls: 1, reportedCalls: 1, inputTokens: 10, outputTokens: 5 };
  }
  assert.equal(evaluations.validateSummary(summary), summary);
  const mutations = [
    (result) => { result.agentUsage.prompt = 'private'; },
    (result) => { result.judgeUsage.reasoning = 'private'; },
    (result) => { result.agentUsage.inputTokens = -1; },
    (result) => { result.tokens = 99; },
    (result) => { result.judgeUsage.reportedCalls = 2; },
    (result) => { result.judgeUsage.reportedCalls = 0; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(summary);
    mutate(invalid.suites[0].results[0]);
    assert.throws(() => evaluations.validateSummary(invalid), /Invalid evaluation summary/);
  }
});

test('legacy zero usage remains unknown rather than becoming a reported zero', () => {
  const fixture = evidenceFixture();
  for (const result of fixture.summary.suites[0].results) result.tokens = 0;
  const html = renderEvaluations(fixture.load());
  assert.match(html, /0 of 12 recorded trials reported totals/);
  assert.match(html, /12 older trials have no judge data/);
  assert.match(html, /Unknown tokens/);
});

test('HTML-sensitive case names and model labels are escaped, never rendered as HTML', () => {
  const fixture = evidenceFixture();
  const hostile = '</summary><script>alert("x")</script>';
  fixture.summary.model = hostile;
  fixture.summary.suites[0].expectedCases[0].name = hostile;
  fixture.summary.suites[0].results.filter((item) => item.name === 'documentation').forEach((item) => { item.name = hostile; });
  const html = renderEvaluations(fixture.load());
  assert.doesNotMatch(html, /<script>alert|<\/summary><script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script(?! src=)/);
});

test('newest evidence is selected per skill, model and judge without backfilling missing trials', () => {
  const fixture = evidenceFixture();
  const secondSkill = path.join(fixture.pluginDir, 'skills', 'other-skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(secondSkill), { recursive: true });
  fs.writeFileSync(secondSkill, 'Another test skill');
  fixture.summary.pluginHash = hashTree(fixture.pluginDir);
  const omittedSuite = structuredClone(fixture.summary.suites[0]);
  omittedSuite.skill = 'other-skill';
  omittedSuite.skillHash = hashFile(secondSkill);
  fixture.summary.suites.push(omittedSuite);
  const second = structuredClone(fixture.summary);
  second.model = 'other-test-model';
  const newer = structuredClone(fixture.summary);
  newer.generatedAt = '2026-01-16T00:00:00Z';
  newer.suites.pop();
  newer.suites[0].results.pop();
  writeJson(path.join(fixture.root, 'newer.json'), newer);
  writeJson(path.join(fixture.root, 'other.json'), second);
  writeJson(fixture.summaryFile, fixture.summary);
  const inputs = [fixture.summaryFile, path.join(fixture.root, 'other.json'), path.join(fixture.root, 'newer.json')];
  const data = fixture.load(fixture.summary, { evalResults: inputs });
  const items = data.plugins[0].skills.find((skill) => skill.name === 'write-docs').evidence;
  assert.equal(items.length, 2);
  assert.equal(items.find((item) => item.model === 'test-model').complete, false);
  assert.equal(items.find((item) => item.model === 'other-test-model').complete, true);
  const differentJudge = structuredClone(fixture.summary);
  differentJudge.judgeModel = 'other-judge';
  writeJson(path.join(fixture.root, 'judge.json'), differentJudge);
  const retained = data.plugins[0].skills.find((skill) => skill.name === 'other-skill').evidence.find((item) => item.model === 'test-model');
  assert.equal(retained.generatedAt, fixture.summary.generatedAt);
  assert.equal(retained.complete, true);
  assert.equal(fixture.load(fixture.summary, { evalResults: [...inputs, path.join(fixture.root, 'judge.json')] }).plugins[0].skills.find((skill) => skill.name === 'write-docs').evidence.length, 3);
  assert.throws(() => fixture.load(fixture.summary, { evalResults: [fixture.summaryFile, fixture.summaryFile] }), /ambiguous/);
});

test('test-only split matrix summaries preserve per-skill coverage and whole-run provenance', () => {
  const fixture = evidenceFixture();
  const otherFile = path.join(fixture.pluginDir, 'skills', 'other-skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(otherFile), { recursive: true });
  fs.writeFileSync(otherFile, 'Test-only matrix skill');
  const otherSuiteFile = path.join(fixture.root, 'evals', 'sample', 'other-skill', 'eval.yaml');
  fs.mkdirSync(path.dirname(otherSuiteFile), { recursive: true });
  fs.writeFileSync(otherSuiteFile, 'name: test-only-matrix-suite\n');
  fixture.summary.pluginHash = hashTree(fixture.pluginDir);
  const split = structuredClone(fixture.summary);
  split.suites[0].skill = 'other-skill';
  split.suites[0].skillHash = hashFile(otherFile);
  split.suites[0].suiteHash = hashTree(path.dirname(otherSuiteFile));
  const results = path.join(fixture.root, 'matrix');
  const firstFile = path.join(results, 'first', 'summary.json');
  const secondFile = path.join(results, 'second', 'summary.json');
  writeJson(firstFile, fixture.summary);
  writeJson(secondFile, split);
  const load = () => fixture.load(fixture.summary, { evalResults: results });
  const skills = load().plugins[0].skills;
  assert.equal(skills.length, 2);
  assert.match(renderEvaluations(load()), /1 linked Actions run \/ 2 summaries/);
  for (const skill of skills) {
    assert.equal(skill.evidence.length, 1);
    assert.equal(skill.evidence[0].complete, true);
    assert.equal(skill.evidence[0].category, 'Consistent offline evidence');
  }
  const newest = structuredClone(split);
  newest.generatedAt = '2026-01-16T00:00:00Z';
  newest.commit = 'b'.repeat(40);
  newest.pluginHash = 'c'.repeat(64);
  newest.suites[0].results.pop();
  writeJson(path.join(results, 'newest', 'summary.json'), newest);
  const selected = load().plugins[0].skills;
  const other = selected.find((skill) => skill.name === 'other-skill').evidence[0];
  assert.equal(other.commit, newest.commit);
  assert.equal(other.complete, false);
  assert.equal(other.changed, true);
  assert.equal(other.dormancy.recorded, 1);
  assert.equal(other.delta, null);
  assert.equal(selected.find((skill) => skill.name === 'write-docs').evidence[0].commit, fixture.summary.commit);
  writeJson(path.join(results, 'duplicate', 'summary.json'), split);
  assert.throws(load, /ambiguous same-date skill\/model summaries/, 'duplicates are rejected even when a newer suite exists');
});

test('evidence tree hashes use sorted normalized paths and raw bytes, skipping build caches', () => {
  const root = tempDir('pps-evidence-hash-');
  fs.writeFileSync(path.join(root, 'b'), 'B');
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'a', 'c'), 'C');
  const expected = require('node:crypto').createHash('sha256').update('a/c\0C\0b\0B\0').digest('hex');
  assert.equal(hashTree(root), expected);
  for (const name of ['dist', '.git', '__pycache__', 'node_modules']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'ignored'), 'ignored');
  }
  fs.writeFileSync(path.join(root, '.DS_Store'), 'ignored');
  assert.equal(hashTree(root), expected);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'link'));
    assert.throws(() => hashTree(root), /symlinks/);
    assert.throws(() => hashFile(path.join(root, 'link')), /regular files/);
  }
});

test('dashboard model and evidence filters apply together and reset restores inventory', () => {
  const listeners = {};
  const controls = Object.fromEntries(['search', 'plugin', 'model', 'evidence', 'result-count', 'no-results', 'theme'].map((id) => [id, { value: '', hidden: false, addEventListener() {} }]));
  const good = { dataset: { evidenceModel: 'good', current: 'true', attention: 'false' }, hidden: false };
  const bad = { dataset: { evidenceModel: 'bad', current: 'false', attention: 'true' }, hidden: false };
  const tested = { dataset: { search: 'write-docs' }, hidden: false, querySelectorAll: () => [good, bad] };
  const untested = { dataset: { search: 'create-site' }, hidden: false, querySelectorAll: () => [] };
  const group = { dataset: { plugin: 'sample', pluginSearch: 'sample plugin' }, hidden: false, querySelectorAll: () => [tested, untested] };
  const form = { hidden: true, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const themeControl = { hidden: true };
  const document = {
    querySelector: (selector) => selector === '[data-filters]' ? form : themeControl,
    querySelectorAll: () => [group],
    getElementById: (id) => controls[id],
    documentElement: { setAttribute() {} },
  };
  const window = { location: { search: '' }, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null }, setTimeout: (fn) => fn() };
  vm.runInNewContext(fs.readFileSync(path.join(REPO_ROOT, 'site/assets/evaluations.js'), 'utf8'), { document, window, URLSearchParams });
  assert.equal(form.hidden, false);
  controls.model.value = 'bad';
  controls.evidence.value = 'current';
  listeners.input();
  assert.equal(group.hidden, true, 'a different model cannot supply current evidence');
  controls.model.value = 'good';
  listeners.change();
  assert.equal(tested.hidden, false);
  assert.equal(bad.hidden, true);
  assert.equal(untested.hidden, true);
  controls.search.value = 'nothing';
  listeners.input();
  assert.equal(controls['no-results'].hidden, false);
  for (const id of ['search', 'plugin', 'model', 'evidence']) controls[id].value = '';
  listeners.reset();
  assert.equal(tested.hidden, false);
  assert.equal(untested.hidden, false);
  assert.match(controls['result-count'].textContent, /2 skills across 1 plugin/);
});

test('site build includes a linked evaluations page without depending on media or results', () => {
  const outDir = path.join(tempDir('pps-evidence-build-'), 'dist');
  const result = build({ repoRoot: REPO_ROOT, outDir, basePath: '/' });
  assert.ok(result.files.includes('evaluations/index.html'));
  assert.match(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), /href="evaluations\/"/);
  assert.match(fs.readFileSync(path.join(outDir, 'evaluations/index.html'), 'utf8'), /Offline only/);
  assert.ok(fs.existsSync(path.join(outDir, 'assets', 'evaluations.css')));
  const args = parseArgs(['--eval-results', 'a.json', '--eval-results', 'results']);
  assert.deepEqual(args.evalResults, [path.resolve('a.json'), path.resolve('results')]);
  const fixture = evidenceFixture();
  const local = MARKETPLACE.plugins.find((entry) => entry.name === 'power-pages');
  const pluginDir = path.join(REPO_ROOT, local.source);
  const skill = fs.readdirSync(path.join(pluginDir, 'skills'), { withFileTypes: true })
    .find((entry) => entry.isDirectory() && fs.existsSync(path.join(pluginDir, 'skills', entry.name, 'SKILL.md')));
  const summary = fixture.summary;
  summary.plugin = 'power-pages';
  summary.generatedAt = new Date().toISOString();
  summary.pluginHash = hashTree(pluginDir);
  summary.suites[0].skill = skill.name;
  summary.suites[0].skillHash = hashFile(path.join(pluginDir, 'skills', skill.name, 'SKILL.md'));
  writeJson(fixture.summaryFile, summary);
  build({ repoRoot: REPO_ROOT, outDir, basePath: '/', evalResults: fixture.summaryFile });
  assert.match(fs.readFileSync(path.join(outDir, 'evaluations/index.html'), 'utf8'), /test-model/);
  assert.ok(!fs.existsSync(path.join(outDir, 'summary.json')), 'input evidence must not be copied wholesale');
  writeJson(fixture.summaryFile, { ...summary, transcript: 'private' });
  assert.throws(() => build({ repoRoot: REPO_ROOT, outDir, basePath: '/', evalResults: fixture.summaryFile }), /Invalid evaluation summary/);
  assert.match(fs.readFileSync(path.join(outDir, 'evaluations/index.html'), 'utf8'), /test-model/, 'invalid input cannot clear a previous build');
});

test('published site builds an untested dashboard when no retained summaries exist', () => {
  const root = tempDir('pps-empty-publication-');
  const results = path.join(root, 'published');
  const outDir = path.join(root, 'site');
  fs.mkdirSync(results);
  const options = { evalResults: results, allowEmptyEvalResults: true };
  build({ ...options, repoRoot: REPO_ROOT, outDir, basePath: '/' });
  const html = fs.readFileSync(path.join(outDir, 'evaluations/index.html'), 'utf8');
  assert.match(html, /No evaluation results published yet/);
  assert.match(html, /No token usage published yet/);
  assert.equal(parseArgs(['--eval-results', results, '--allow-empty-eval-results']).allowEmptyEvalResults, true);
  assert.equal(parseArgs(['--allow-empty-eval-results', '--eval-results', results]).allowEmptyEvalResults, true);
  assert.throws(() => parseArgs(['--allow-empty-eval-results']), /requires --eval-results/);
  assert.throws(() => build({ repoRoot: REPO_ROOT, outDir, basePath: '/', evalResults: results }), /no JSON summaries/);
  writeJson(path.join(results, 'unsafe.summary.json'), { transcript: 'private' });
  assert.throws(() => build({ ...options, repoRoot: REPO_ROOT, outDir, basePath: '/' }), /Invalid evaluation summary/);
});

// ── Install links ───────────────────────────────────────────────

test('Claude Code links pre-fill the documented one-step install prompt', () => {
  assert.equal(links.claudeCodePrompt('power-pages'), '/plugin install power-pages --marketplace microsoft/power-platform-skills');
  assert.equal(links.claudeCodeShellCommand('power-pages'), 'claude plugin install power-pages --marketplace microsoft/power-platform-skills');
  const deepLink = new URL(links.claudeCodeDeepLink('power-pages'));
  assert.equal(deepLink.protocol, 'claude-cli:');
  assert.equal(deepLink.host, 'open');
  assert.equal(deepLink.searchParams.get('q'), links.claudeCodePrompt('power-pages'));
  assert.deepEqual([...deepLink.searchParams.keys()], ['q']);
});

test('Copilot app links wrap a ghapp:// plugin link in the GitHub launcher', () => {
  const install = new URL(links.copilotAppInstallUrl('power-pages'));
  assert.equal(install.origin + install.pathname, 'https://github.com/copilot/app/launch');
  const appLink = install.searchParams.get('open');
  assert.equal(appLink, 'ghapp://plugins/install?source=power-pages%40power-platform-skills');
  assert.equal(new URL(appLink).searchParams.get('source'), 'power-pages@power-platform-skills');

  const marketplace = new URL(links.copilotAppMarketplaceUrl()).searchParams.get('open');
  assert.equal(marketplace, 'ghapp://plugins/marketplace/add?source=microsoft%2Fpower-platform-skills');
  assert.equal(new URL(marketplace).searchParams.get('source'), 'microsoft/power-platform-skills');
});

test('Copilot CLI commands add the marketplace, then install from it', () => {
  assert.deepEqual(links.copilotCliCommands('mobile-app'), [
    'copilot plugin marketplace add microsoft/power-platform-skills',
    'copilot plugin install mobile-app@power-platform-skills',
  ]);
});

test('the copied Copilot CLI command is one line that installs even when the marketplace exists', () => {
  const command = links.copilotCliCommand('pcf');
  assert.equal(command, 'copilot plugin marketplace add microsoft/power-platform-skills; copilot plugin install pcf@power-platform-skills');
  assert.ok(!/[\r\n]/.test(command), 'two pasted lines do not run as one command');

  // Run the line in each POSIX shell available here against a fake copilot whose
  // "marketplace add" fails the way the real CLI does when the marketplace is registered.
  const bin = tempDir('pps-fake-copilot-');
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'copilot'), [
    '#!/bin/sh',
    `echo "$*" >> "${log}"`,
    'if [ "$2" = "marketplace" ]; then echo \'Marketplace "power-platform-skills" already registered\' >&2; exit 1; fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  const shells = ['sh', 'bash', 'zsh'].filter((shell) => spawnSync('which', [shell]).status === 0);
  if (process.platform === 'win32' || shells.length === 0) return;
  for (const shell of shells) {
    fs.rmSync(log, { force: true });
    const result = spawnSync(shell, ['-c', command], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8' });
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
      'plugin marketplace add microsoft/power-platform-skills',
      'plugin install pcf@power-platform-skills',
    ], shell);
  }
});

test('detectOs picks the computer from what each browser reports', () => {
  const cases = [
    ['Chrome on Windows', { userAgentData: { platform: 'Windows', mobile: false }, platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0' }, 'windows'],
    ['Firefox on Windows', { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Firefox/132.0' }, 'windows'],
    ['Edge on macOS', { userAgentData: { platform: 'macOS', mobile: false }, platform: 'MacIntel', maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Edg/131.0' }, 'macos'],
    ['Safari on macOS', { platform: 'MacIntel', maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15' }, 'macos'],
    ['Firefox on Linux', { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Firefox/132.0' }, 'linux'],
    ['Chrome on ChromeOS', { userAgentData: { platform: 'Chrome OS', mobile: false }, platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/131.0' }, 'linux'],
    ['Safari on iPad, which reports a Mac', { platform: 'MacIntel', maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15' }, null],
    ['Safari on iPhone', { platform: 'iPhone', maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148' }, null],
    ['Chrome on Android', { userAgentData: { platform: 'Android', mobile: true }, platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131.0 Mobile' }, null],
    ['an unknown browser', { platform: '', userAgent: '' }, null],
    ['no navigator', undefined, null],
  ];
  for (const [label, nav, expected] of cases) {
    assert.equal(links.detectOs(nav), expected, label);
  }
});

test('each computer gets the install command that works there', () => {
  assert.equal(links.installAllCommand('windows'), links.INSTALL_ALL.windows);
  assert.equal(links.installAllCommand('macos'), links.INSTALL_ALL.unix);
  assert.equal(links.installAllCommand('linux'), links.INSTALL_ALL.unix);
  assert.equal(links.installAllCommand('windows', { dataverse: true }), links.INSTALL_ALL_WITH_DATAVERSE.windows);
  assert.equal(links.installAllCommand('linux', { dataverse: true }), links.INSTALL_ALL_WITH_DATAVERSE.unix);
  assert.throws(() => links.installAllCommand('android'), /Unknown operating system/);
});

test('launcher URLs accept only known apps and keep the base the caller passes', () => {
  assert.equal(links.launcherUrl('../../', 'claude-code', 'pcf'), '../../install/?app=claude-code&plugin=pcf');
  assert.equal(
    links.launcherUrl(links.SITE_URL, 'claude-code', 'pcf'),
    'https://microsoft.github.io/power-platform-skills/install/?app=claude-code&plugin=pcf',
  );
  assert.throws(() => links.launcherUrl('', 'copilot-cli', 'pcf'), /Unsupported launcher app/);
  assert.throws(() => links.launcherUrl('', 'claude-code"><script>', 'pcf'), /Unsupported launcher app/);
});

test('every link builder rejects names outside the Open Plugins grammar', () => {
  const builders = [
    links.claudeCodePrompt,
    links.claudeCodeShellCommand,
    links.claudeCodeDeepLink,
    links.copilotAppInstallUrl,
    links.copilotCliCommands,
    (name) => links.launcherUrl('', 'claude-code', name),
  ];
  for (const name of BAD_NAMES) {
    assert.equal(links.isValidPluginName(name), false, JSON.stringify(name));
    for (const builder of builders) {
      assert.throws(() => builder(name), /Invalid plugin name/, `${builder.name || 'launcherUrl'}(${JSON.stringify(name)})`);
    }
  }
});

test('the browser name check agrees with the installer', () => {
  const names = [...BAD_NAMES, ...MARKETPLACE_NAMES, 'a', 'a.b', 'a-b', 'a..b', 'a.-b', '1', 'x'.repeat(64)];
  for (const name of names) {
    assert.equal(links.isValidPluginName(name), installer.isValidPluginName(name), JSON.stringify(name));
  }
});

test('the install-everything commands match the installer usage', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'install.js'), 'utf8');
  assert.ok(source.includes(links.INSTALL_ALL.unix), 'scripts/install.js usage no longer shows the curl one-liner');
  assert.ok(source.includes(links.INSTALL_ALL_WITH_DATAVERSE.unix), 'scripts/install.js usage no longer shows the Dataverse one-liner');
  assert.ok(links.INSTALL_ALL.windows.startsWith(`iwr ${links.INSTALLER_URL} -OutFile install.js;`));
});

test('the Dataverse flag reaches the installer, not node or del', () => {
  // Appending the flag to either one-liner breaks it, so the position is pinned here.
  assert.match(links.INSTALL_ALL_WITH_DATAVERSE.windows, /; node install\.js --include-dataverse; del install\.js$/);
  assert.match(links.INSTALL_ALL_WITH_DATAVERSE.unix, /\| node - --include-dataverse$/);
  // `node -` runs the piped script and passes the rest of the arguments to it.
  const piped = spawnSync(process.execPath, ['-', '--include-dataverse'], {
    input: 'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
    encoding: 'utf8',
  });
  assert.equal(piped.status, 0, piped.stderr);
  assert.deepEqual(JSON.parse(piped.stdout), ['--include-dataverse']);
});

// ── Catalog ─────────────────────────────────────────────────────

test('the real catalog covers exactly the marketplace plugins', () => {
  const catalog = loadCatalog(REPO_ROOT);
  assert.deepEqual(catalog.plugins.map((plugin) => plugin.name).sort(), MARKETPLACE_NAMES);
  for (const plugin of catalog.plugins) {
    assert.match(plugin.docsUrl, /^https:\/\//, plugin.name);
  }
});

// A two-plugin repository: one plugin in the repo and one external, like dataverse.
function fixtureRepo({ catalog: edit = (value) => value, skills = ['make-thing'] } = {}) {
  const root = tempDir('pps-site-repo-');
  writeJson(path.join(root, 'marketplace.json'), {
    name: 'power-platform-skills',
    plugins: [
      { name: 'alpha', source: './plugins/alpha' },
      { name: 'beta', source: { source: 'github', repo: 'example/beta', path: 'plugin' } },
    ],
  });
  writeJson(path.join(root, 'plugins', 'alpha', '.plugin', 'plugin.json'), { name: 'alpha', version: '1.2.3' });
  for (const skill of skills) {
    fs.mkdirSync(path.join(root, 'plugins', 'alpha', 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins', 'alpha', 'skills', skill, 'SKILL.md'), '---\nname: x\n---\n');
  }
  const entry = (name, extra) => ({
    name,
    title: name.toUpperCase(),
    goal: 'build',
    product: 'power-apps',
    audience: 'makers',
    status: null,
    summary: `${name} summary`,
    prompts: [`Ask ${name}`],
    requirements: ['Node.js'],
    skills: [{ name: 'make-thing', description: 'Makes a thing.' }],
    notes: [],
    learn: [{ title: 'Docs', url: 'https://learn.microsoft.com/' }],
    ...extra,
  });
  const catalog = {
    goals: [{ id: 'build', title: 'Build', summary: 'Build things.' }],
    plugins: [entry('alpha'), entry('beta', { external: 'https://github.com/example/beta' })],
    faq: [{ question: 'Q?', answer: 'A.' }],
    showcase: [{ plugin: 'alpha', prompt: 'Ask alpha', steps: ['One', 'Two'], waiting: 'Waits' }],
    video: { transcript: [{ spoken: 'Said aloud.', shown: 'On screen.' }] },
  };
  writeJson(path.join(root, 'site', 'catalog.json'), edit(catalog));
  return root;
}

test('a valid fixture catalog loads with versions from the plugin manifest', () => {
  const catalog = loadCatalog(fixtureRepo());
  const alpha = catalog.plugins.find((plugin) => plugin.name === 'alpha');
  const beta = catalog.plugins.find((plugin) => plugin.name === 'beta');
  assert.equal(alpha.version, '1.2.3');
  assert.equal(alpha.docsUrl, 'https://github.com/microsoft/power-platform-skills/tree/main/plugins/alpha');
  assert.equal(beta.version, null);
  assert.equal(beta.external, true);
});

test('catalog validation reports every drift from the marketplace', () => {
  const cases = [
    ['a marketplace plugin with no entry', (c) => ({ ...c, plugins: c.plugins.filter((p) => p.name !== 'beta') }), /marketplace plugin beta has no entry/],
    ['an entry not in the marketplace', (c) => ({ ...c, plugins: [...c.plugins, { ...c.plugins[0], name: 'gamma' }] }), /gamma.*not in marketplace\.json/],
    ['a skill with no SKILL.md', (c) => { c.plugins[0].skills = [{ name: 'missing', description: 'x' }]; return c; }, /skill "missing"/],
    ['an unknown goal', (c) => { c.plugins[0].goal = 'nope'; return c; }, /unknown goal "nope"/],
    ['an unknown audience', (c) => { c.plugins[0].audience = 'everyone'; return c; }, /unknown audience/],
    ['an http learn link', (c) => { c.plugins[0].learn = [{ title: 'x', url: 'http://example.com' }]; return c; }, /https url/],
    ['an external plugin with no url', (c) => { delete c.plugins[1].external; return c; }, /needs an https external url/],
    ['an in-repo plugin marked external', (c) => { c.plugins[0].external = 'https://example.com'; return c; }, /must not set external/],
    ['a goal with no plugins', (c) => { c.goals.push({ id: 'empty', title: 'E', summary: 'E.' }); return c; }, /goal empty has no plugins/],
    ['too many prompts', (c) => { c.plugins[0].prompts = ['1', '2', '3', '4', '5', '6']; return c; }, /1 to 5 example prompts/],
    ['an unknown product', (c) => { c.plugins[0].product = 'power-bi'; return c; }, /unknown product "power-bi"/],
    ['a showcase prompt the plugin does not list', (c) => { c.showcase[0].prompt = 'Something else'; return c; }, /not one of alpha's prompts/],
    ['a showcase with one step', (c) => { c.showcase[0].steps = ['Only']; return c; }, /2 to 5 steps/],
    ['no showcase', (c) => { c.showcase = []; return c; }, /1 to 6 example sessions/],
    ['a video transcript paragraph with no description', (c) => { c.video.transcript[0].shown = ''; return c; }, /video\.transcript needs/],
    ['no video transcript', (c) => { delete c.video; return c; }, /video\.transcript needs/],
  ];
  for (const [label, edit, pattern] of cases) {
    assert.throws(() => loadCatalog(fixtureRepo({ catalog: edit })), pattern, label);
  }
});

// ── Build ───────────────────────────────────────────────────────

function readOut(outDir, relative) {
  return fs.readFileSync(path.join(outDir, relative), 'utf8');
}

function pageData(html) {
  const match = /<script type="application\/json" id="page-data">(.*?)<\/script>/s.exec(html);
  assert.ok(match, 'page-data block missing');
  return JSON.parse(match[1]);
}

test('the build writes a page for every marketplace plugin plus the launcher and 404', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  const { files } = build({ outDir, basePath: '/power-platform-skills/' });
  for (const name of MARKETPLACE_NAMES) {
    assert.ok(files.includes(`plugins/${name}/index.html`), name);
  }
  for (const file of [
    'index.html', 'install/index.html', '404.html', 'assets/styles.css', 'assets/site.js', 'assets/theme.js',
    'assets/launcher.js', 'assets/install-links.js', 'assets/brand/power-platform.svg', 'assets/brand/favicon-32.png',
    'assets/fonts/schibsted-grotesk-latin.woff2', 'assets/fonts/OFL-schibsted-grotesk.txt',
  ]) {
    assert.ok(fs.existsSync(path.join(outDir, file)), file);
  }
  // The browser copy of the link builders is the module the build and tests use.
  assert.equal(readOut(outDir, 'assets/install-links.js'), fs.readFileSync(path.join(REPO_ROOT, 'site', 'lib', 'install-links.js'), 'utf8'));
});

test('every page loads only same-origin assets under a strict content security policy', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  const { files } = build({ outDir, basePath: '/power-platform-skills/' });
  for (const file of files.filter((name) => name.endsWith('.html'))) {
    const html = readOut(outDir, file);
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self';/, file);
    for (const [, attr, value] of html.matchAll(/<(?:script|link|video|source|track)\b[^>]*\b(src|href|poster)="([^"]*)"/g)) {
      if (attr === 'href' && file === '404.html') {
        assert.ok(value.startsWith('/power-platform-skills/'), `${file}: ${value}`);
      } else {
        assert.doesNotMatch(value, /^(?:[a-z]+:)?\/\//i, `${file} loads ${value} from another origin`);
      }
    }
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/, `${file} has an inline script`);
  }
});

test('the home page leads with Install everything and shows steps for each computer', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  build({ outDir, basePath: '/power-platform-skills/' });
  const html = readOut(outDir, 'index.html');
  const hero = html.slice(html.indexOf('class="hero-actions"'), html.indexOf('class="proof-list"'));
  assert.match(hero, /button-primary[^>]*href="#install-everything">Install everything</);
  assert.match(hero, /button-secondary[^>]*href="#plugins">Choose a plugin</);
  assert.match(html, /nav-cta" href="#install-everything">Install everything</);
  assert.ok(html.indexOf('id="install-everything"') < html.indexOf('id="plugins"'), 'install section should come before the catalog');
  for (const os of links.OPERATING_SYSTEMS) {
    const start = html.indexOf(`data-os="${os}"`);
    assert.ok(start > -1, os);
    const panel = html.slice(start, html.indexOf('</details>', start));
    assert.ok(panel.includes(`data-copy="${links.installAllCommand(os).replace(/&/g, '&amp;')}"`), `${os} command`);
    assert.ok(panel.includes(`data-copy="${links.installAllCommand(os, { dataverse: true }).replace(/&/g, '&amp;')}"`), `${os} Dataverse command`);
  }
});

test('the launcher allowlist is exactly the marketplace', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  build({ outDir, basePath: '/power-platform-skills/' });
  const data = pageData(readOut(outDir, 'install/index.html'));
  assert.deepEqual(Object.keys(data.plugins).sort(), MARKETPLACE_NAMES);
});

test('plugin pages link each assistant to its install path', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  build({ outDir, basePath: '/power-platform-skills/' });
  const html = readOut(outDir, 'plugins/power-automate/index.html');
  const decode = (value) => value.replace(/&amp;/g, '&');
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => decode(match[1]));
  assert.ok(hrefs.includes(links.launcherUrl('../../', 'claude-code', 'power-automate')));
  assert.ok(hrefs.includes(links.copilotAppInstallUrl('power-automate')));
  assert.ok(hrefs.includes(links.copilotAppMarketplaceUrl()));
  // Copilot CLI has no URL handler, so its install path is a copy button with both commands.
  assert.ok(html.includes(`data-copy="${links.copilotCliCommand('power-automate')}"`));
});

test('every product icon on the site sits beside its product name', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  const { files } = build({ outDir, basePath: '/power-platform-skills/' });
  const { PRODUCTS } = require('../lib/catalog.js');
  const labelFor = Object.fromEntries(Object.values(PRODUCTS).map((product) => [path.basename(product.icon), product.label]));
  for (const file of files.filter((name) => name.endsWith('.html'))) {
    const html = readOut(outDir, file);
    // An icon's parent element is the unit a reader sees together with it.
    for (const match of html.matchAll(/<img[^>]*src="[^"]*brand\/([a-z-]+\.svg)"[^>]*>/g)) {
      const icon = match[1];
      const label = icon === 'power-platform.svg' ? 'Power Platform' : labelFor[icon];
      const after = html.slice(match.index, match.index + 600).replace(/<[^>]+>/g, ' ');
      assert.ok(after.includes(label), `${file}: ${icon} has no "${label}" label beside it`);
    }
  }
});

test('catalog text is escaped in every page', () => {
  const hostile = '<script>alert(1)</script>"\'&';
  const root = fixtureRepo({
    catalog: (c) => {
      c.plugins[0].summary = hostile;
      c.plugins[0].prompts = [hostile];
      c.plugins[0].title = hostile;
      c.faq[0].answer = hostile;
      c.showcase[0].prompt = hostile;
      c.showcase[0].steps = [hostile, hostile];
      return c;
    },
  });
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  const { files } = build({ repoRoot: root, outDir, basePath: '/' });
  for (const file of files.filter((name) => name.endsWith('.html'))) {
    const html = readOut(outDir, file);
    assert.ok(!html.includes('<script>alert(1)'), `${file} contains unescaped catalog text`);
  }
  assert.ok(readOut(outDir, 'plugins/alpha/index.html').includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'));
  // The title also lands in the launcher's JSON data block, which must not close the element.
  assert.equal(pageData(readOut(outDir, 'install/index.html')).plugins.alpha, hostile);
});

test('jsonForScript keeps </script> inside a JSON data block', () => {
  const json = render.jsonForScript({ text: '</script><script>alert(1)</script>' });
  assert.ok(!json.includes('</script'));
  assert.deepEqual(JSON.parse(json), { text: '</script><script>alert(1)</script>' });
});

test('the build clears only folders it created', () => {
  const parent = tempDir('pps-site-out-');
  const unrelated = path.join(parent, 'unrelated');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  assert.throws(() => build({ outDir: unrelated, basePath: '/' }), /Refusing to clear/);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');

  const outDir = path.join(parent, 'dist');
  build({ outDir, basePath: '/' });
  fs.writeFileSync(path.join(outDir, 'stale.html'), 'old');
  build({ outDir, basePath: '/' });
  assert.ok(!fs.existsSync(path.join(outDir, 'stale.html')));
  assert.ok(fs.existsSync(path.join(outDir, MARKER)));
});

test('build arguments are strict and the base path is normalized', () => {
  assert.equal(parseArgs([]).basePath, '/power-platform-skills/');
  assert.equal(parseArgs(['--base-path', 'docs']).basePath, '/docs/');
  assert.equal(parseArgs(['--base-path', '/']).basePath, '/');
  assert.throws(() => parseArgs(['--outdir', 'x']), /Unknown or incomplete argument/);
  assert.throws(() => parseArgs(['--out']), /Unknown or incomplete argument/);
});

// ── Launcher page ───────────────────────────────────────────────

// Runs assets/launcher.js against a stub DOM. It records where the page would navigate,
// so no test ever hands a claude-cli: link to the operating system.
function runLauncher(search, { touchOnly = false } = {}) {
  const element = () => ({ hidden: true, textContent: '', href: '#', dataset: {} });
  const ready = element();
  const invalid = element();
  const parts = {
    '[data-launcher-plugin]': element(),
    '[data-launcher-prompt]': element(),
    '[data-launcher-shell]': element(),
    '[data-launcher-copy]': element(),
    '[data-launcher-open]': element(),
    '[data-launcher-touch]': element(),
    '[data-launcher-desktop]': { ...element(), hidden: false },
  };
  ready.querySelector = (selector) => parts[selector];
  const catalog = loadCatalog(REPO_ROOT);
  const data = { plugins: Object.fromEntries(catalog.plugins.map((plugin) => [plugin.name, plugin.title])) };
  const navigations = [];
  const document = {
    title: '',
    getElementById: (id) => (id === 'page-data' ? { textContent: JSON.stringify(data) } : null),
    querySelector: (selector) => ({
      '[data-launcher-state="ready"]': ready,
      '[data-launcher-state="invalid"]': invalid,
    })[selector],
  };
  const window = {
    PowerPlatformSkillsInstallLinks: links,
    location: {
      search,
      set href(value) {
        navigations.push(value);
      },
    },
    setTimeout: (fn) => fn(),
    matchMedia: (query) => ({ matches: touchOnly && query === '(hover: none) and (pointer: coarse)' }),
  };
  const source = fs.readFileSync(path.join(REPO_ROOT, 'site', 'assets', 'launcher.js'), 'utf8');
  vm.runInNewContext(source, { window, document, URLSearchParams });
  return { ready, invalid, parts, navigations, document };
}

test('the launcher opens Claude Code for a known plugin', () => {
  const { ready, invalid, parts, navigations, document } = runLauncher('?app=claude-code&plugin=process-intelligence');
  assert.equal(ready.hidden, false);
  assert.equal(invalid.hidden, true);
  assert.equal(parts['[data-launcher-open]'].href, links.claudeCodeDeepLink('process-intelligence'));
  assert.equal(parts['[data-launcher-prompt]'].textContent, links.claudeCodePrompt('process-intelligence'));
  assert.equal(parts['[data-launcher-copy]'].dataset.copy, links.claudeCodeShellCommand('process-intelligence'));
  assert.equal(parts['[data-launcher-plugin]'].textContent, 'Process Intelligence');
  assert.deepEqual(navigations, [links.claudeCodeDeepLink('process-intelligence')]);
  assert.match(document.title, /Install Process Intelligence in Claude Code/);
});

test('the launcher does not try to open Claude Code on a phone or tablet', () => {
  const { ready, parts, navigations } = runLauncher('?app=claude-code&plugin=pcf', { touchOnly: true });
  assert.equal(ready.hidden, false);
  assert.equal(parts['[data-launcher-open]'].href, links.claudeCodeDeepLink('pcf'));
  assert.equal(parts['[data-launcher-touch]'].hidden, false);
  assert.equal(parts['[data-launcher-desktop]'].hidden, true);
  assert.deepEqual(navigations, []);
});

test('the launcher refuses anything outside its allowlist and never navigates', () => {
  const searches = [
    '',
    '?app=claude-code',
    '?plugin=pcf',
    '?app=copilot-cli&plugin=pcf',
    '?app=claude-code&plugin=unknown-plugin',
    '?app=claude-code&plugin=__proto__',
    '?app=claude-code&plugin=constructor',
    '?app=claude-code&plugin=pcf&plugin=power-pages',
    '?app=claude-code&app=claude-code&plugin=pcf',
    `?app=claude-code&plugin=${encodeURIComponent('pcf --scope project')}`,
    `?app=claude-code&plugin=${encodeURIComponent('pcf\n/help')}`,
  ];
  for (const search of searches) {
    const { ready, invalid, navigations } = runLauncher(search);
    assert.equal(invalid.hidden, false, search);
    assert.equal(ready.hidden, true, search);
    assert.deepEqual(navigations, [], search);
  }
});

// ── Pages deployment ────────────────────────────────────────────

test('every Pages deploy carries the repo stats report', () => {
  // GitHub Pages serves one artifact, so a deploy without the stats branch's microsoft/ folder
  // takes https://microsoft.github.io/power-platform-skills/microsoft/... offline.
  const site = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'showcase-site.yml'), 'utf8');
  const stats = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'github-repo-stats.yml'), 'utf8');
  const statsName = /^name: (.+)$/m.exec(stats)[1].trim();
  assert.match(site, new RegExp(`workflow_run:\\n\\s+workflows:\\n\\s+- ${statsName}\\n`), 'site must republish after the stats workflow');
  assert.match(site, /- name: build preview\n\s+if: github\.event_name == 'pull_request' \|\| github\.ref != 'refs\/heads\/main'/);
  assert.match(site, /- name: build published site\n\s+if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.match(site, /ref: github-repo-stats\n\s+path: repo-stats\n\s+sparse-checkout: microsoft\n/);
  assert.match(site, /run: cp -R repo-stats\/microsoft site\/dist\/microsoft\n/);
  assert.ok(site.indexOf('cp -R repo-stats/microsoft') < site.indexOf('upload-pages-artifact'), 'stats must be copied before the upload');
  // The report's links are built from this prefix, so it must be the site the workflow deploys.
  assert.match(stats, new RegExp(`ghpagesprefix: ${links.SITE_URL.replace(/\/$/, '').replace(/[.]/g, '\\.')}\\n`));
  assert.match(stats, /databranch: github-repo-stats\n/);
});

// ── Explainer video ─────────────────────────────────────────────

// The spoken words of a WebVTT file: a "WEBVTT" header block, then blank-line-separated cues,
// each a "start --> end" timing line followed by one or more lines of text.
// https://www.w3.org/TR/webvtt1/#file-structure
function vttText(vtt) {
  return vtt.trim().split(/\r?\n\r?\n/).slice(1)
    .map((cue) => cue.split(/\r?\n/).filter((line) => !line.includes('-->')).join(' '))
    .join(' ');
}

function questionsSection(html) {
  const start = html.indexOf('id="questions"');
  return html.slice(start, html.indexOf('</section>', start));
}

test('the explainer video plays only on request, with captions on, from this site', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  build({ outDir, basePath: '/power-platform-skills/' });
  const faq = questionsSection(readOut(outDir, 'index.html'));
  const video = /<video\b[^>]*>/.exec(faq);
  assert.ok(video, 'no video in the Questions section');
  // Native controls are the no-JavaScript fallback; site.js swaps in the play button.
  assert.match(video[0], /\bcontrols\b/);
  // A 3 MB file must not download, or start, until the visitor asks for it.
  assert.match(video[0], /\bpreload="none"/);
  assert.doesNotMatch(video[0], /\b(?:autoplay|loop)\b/);
  assert.match(faq, /<track kind="captions" src="[^"]+" srclang="en" label="English" default>/);
  assert.match(faq, /<button type="button" class="explainer-play" data-explainer-play hidden>/);
  const files = [...faq.matchAll(/\b(?:src|poster)="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(files.sort(), [
    'assets/video/plugins-and-skills-poster.webp',
    'assets/video/plugins-and-skills.mp4',
    'assets/video/plugins-and-skills.vtt',
  ]);
  // The captions are committed with the site; the video and poster come from site-media, pinned
  // in site/media.json, and CI checks them with build --require-media.
  const pinned = media.loadMediaManifest(path.join(REPO_ROOT, 'site', 'media.json')).files.map((entry) => entry.path);
  assert.deepEqual(pinned.sort(), ['assets/video/plugins-and-skills-poster.webp', 'assets/video/plugins-and-skills.mp4']);
  assert.ok(fs.existsSync(path.join(outDir, 'assets/video/plugins-and-skills.vtt')), 'captions are not in the build');
});

// ── Site media (site-media branch) ──────────────────────────────

function mediaFixture(files) {
  const dir = tempDir('pps-site-media-');
  const entries = Object.entries(files).map(([name, text]) => {
    const data = Buffer.from(text);
    fs.mkdirSync(path.join(dir, 'video'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'video', name), data);
    return { path: `assets/video/${name}`, source: `video/${name}`, sha256: media.sha256(data), bytes: data.length };
  });
  return { dir, manifest: { branch: 'site-media', files: entries } };
}

test('pinned media is copied into the site only when its hash matches', () => {
  const { dir, manifest } = mediaFixture({ 'a.mp4': 'video bytes', 'b.webp': 'poster bytes' });
  const outDir = tempDir('pps-site-out-');
  assert.deepEqual(media.copyMedia({ manifest, mediaDir: dir, outDir }), {
    written: ['assets/video/a.mp4', 'assets/video/b.webp'], missing: [],
  });
  assert.equal(fs.readFileSync(path.join(outDir, 'assets/video/a.mp4'), 'utf8'), 'video bytes');

  fs.rmSync(path.join(dir, 'video', 'b.webp'));
  assert.deepEqual(media.copyMedia({ manifest, mediaDir: dir, outDir: tempDir('pps-site-out-') }).missing, ['video/b.webp']);
  assert.deepEqual(media.copyMedia({ manifest, mediaDir: null, outDir: tempDir('pps-site-out-') }).missing, ['video/a.mp4', 'video/b.webp']);

  fs.writeFileSync(path.join(dir, 'video', 'a.mp4'), 'video bytes, re-encoded');
  assert.throws(() => media.copyMedia({ manifest, mediaDir: dir, outDir: tempDir('pps-site-out-') }), /not the version site\/media\.json pins/);
});

test('a build that requires media fails without it, and one that does not says what it left out', () => {
  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  const empty = tempDir('pps-site-media-');
  assert.throws(() => build({ outDir, basePath: '/power-platform-skills/', mediaDir: empty, requireMedia: true }), /Run node site\/fetch-media\.js/);
  const { missingMedia } = build({ outDir, basePath: '/power-platform-skills/', mediaDir: empty });
  const pinned = media.loadMediaManifest(path.join(REPO_ROOT, 'site', 'media.json')).files.map((entry) => entry.source);
  assert.deepEqual(missingMedia, pinned);
  assert.deepEqual(parseArgs(['--media', empty, '--require-media']).requireMedia, true);
});

test('the media manifest only accepts files under assets/ with safe paths and a hash', () => {
  const good = { path: 'assets/video/a.mp4', source: 'video/a-0123456789ab.mp4', sha256: 'a'.repeat(64), bytes: 1 };
  const write = (value) => {
    const file = path.join(tempDir('pps-site-manifest-'), 'media.json');
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  assert.doesNotThrow(() => media.loadMediaManifest(write({ branch: 'site-media', files: [good] })));
  for (const [label, value] of [
    ['wrong branch', { branch: 'main', files: [good] }],
    ['no files', { branch: 'site-media', files: [] }],
    ['outside assets', { branch: 'site-media', files: [{ ...good, path: 'index.html' }] }],
    ['climbs out', { branch: 'site-media', files: [{ ...good, path: 'assets/../../x' }] }],
    ['absolute source', { branch: 'site-media', files: [{ ...good, source: '/etc/passwd' }] }],
    ['source climbs out', { branch: 'site-media', files: [{ ...good, source: '../x' }] }],
    ['bad hash', { branch: 'site-media', files: [{ ...good, sha256: 'xyz' }] }],
    ['no size', { branch: 'site-media', files: [{ ...good, bytes: 0 }] }],
    ['duplicate', { branch: 'site-media', files: [good, good] }],
  ]) {
    assert.throws(() => media.loadMediaManifest(write(value)), Error, label);
  }
});

function git(args, cwd) {
  // Fixture repositories ignore the developer's global hooks and signing settings.
  return spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' });
}

test('fetch-media takes exactly the pinned files from the site-media branch', (t) => {
  if (git(['--version']).status !== 0) {
    t.skip('git is not installed');
    return;
  }
  const { dir: content, manifest } = mediaFixture({ 'a.mp4': 'video bytes', 'b.webp': 'poster bytes' });
  const upstream = tempDir('pps-site-upstream-');
  assert.equal(git(['init', '--quiet', '--initial-branch', 'site-media'], upstream).status, 0);
  fs.cpSync(content, upstream, { recursive: true });
  fs.writeFileSync(path.join(upstream, 'video', 'unpinned.mp4'), 'an older render');
  assert.equal(git(['add', '.'], upstream).status, 0);
  const commit = git(['-c', 'user.name=Site test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--no-verify', '-m', 'media'], upstream);
  assert.equal(commit.status, 0, commit.stderr);

  const clone = tempDir('pps-site-clone-');
  assert.equal(git(['init', '--quiet'], clone).status, 0);
  const mediaDir = path.join(clone, 'site', 'media');
  assert.deepEqual(media.fetchMedia({ manifest, mediaDir, from: upstream, cwd: clone }).fetched, ['video/a.mp4', 'video/b.webp']);
  assert.equal(fs.readFileSync(path.join(mediaDir, 'video', 'b.webp'), 'utf8'), 'poster bytes');
  assert.ok(!fs.existsSync(path.join(mediaDir, 'video', 'unpinned.mp4')), 'only pinned files are fetched');
  // Nothing to do the second time.
  assert.deepEqual(media.fetchMedia({ manifest, mediaDir, from: upstream, cwd: clone }).fetched, []);
  // The fetch never touches the contributor's clone: a --depth fetch there would mark the whole
  // clone shallow, and FETCH_HEAD or a branch would show that it ran.
  for (const name of ['shallow', 'FETCH_HEAD']) {
    assert.ok(!fs.existsSync(path.join(clone, '.git', name)), `the fetch wrote .git/${name} in the clone`);
  }
  assert.equal(git(['branch', '--list'], clone).stdout.trim(), '');

  // A remote name of the clone, and a subfolder of the upstream repository, both work as --from.
  assert.equal(git(['remote', 'add', 'media-source', upstream], clone).status, 0);
  assert.deepEqual(media.fetchMedia({ manifest, mediaDir: tempDir('pps-site-media-'), from: 'media-source', cwd: clone }).fetched.length, 2);
  assert.deepEqual(media.fetchMedia({ manifest, mediaDir: tempDir('pps-site-media-'), from: 'video', cwd: upstream }).fetched.length, 2);
  // A relative folder is relative to where the command was run (pathBase), not to cwd, while a
  // remote name still resolves in cwd's repository.
  const relative = path.relative(path.dirname(upstream), upstream);
  assert.deepEqual(media.fetchMedia({ manifest, mediaDir: tempDir('pps-site-media-'), from: relative, cwd: clone, pathBase: path.dirname(upstream) }).fetched.length, 2);
  assert.throws(() => media.fetchMedia({ manifest, mediaDir: tempDir('pps-site-media-'), from: relative, cwd: clone }), /is not a URL, a Git remote, or a folder/);
  assert.deepEqual(media.fetchMedia({ manifest, mediaDir: tempDir('pps-site-media-'), from: 'media-source', cwd: clone, pathBase: os.tmpdir() }).fetched.length, 2);

  const unknown = { branch: 'site-media', files: [{ ...manifest.files[0], source: 'video/missing.mp4' }] };
  assert.throws(() => media.fetchMedia({ manifest: unknown, mediaDir: tempDir('pps-site-media-'), from: upstream, cwd: clone }), /has no video\/missing\.mp4/);
  const tampered = { branch: 'site-media', files: [{ ...manifest.files[0], sha256: 'b'.repeat(64) }] };
  assert.throws(() => media.fetchMedia({ manifest: tampered, mediaDir: tempDir('pps-site-media-'), from: upstream, cwd: clone }), /not the version/);
  assert.throws(() => media.fetchMedia({ manifest, mediaDir: tempDir('pps-site-media-'), from: tempDir('pps-site-empty-'), cwd: clone }), /is not a URL, a Git remote, or a folder in a Git repository/);
  const noBranch = tempDir('pps-site-nobranch-');
  assert.equal(git(['init', '--quiet', '--initial-branch', 'main'], noBranch).status, 0);
  assert.throws(() => media.fetchMedia({ manifest, mediaDir: tempDir('pps-site-media-'), from: noBranch, cwd: clone }), /site-media branch is not on/);
});

test('no audio, video, or large file is committed under site/', (t) => {
  // Every marketplace install clones main, so the site's media lives on the site-media branch.
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'site'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (listed.status !== 0) {
    t.skip('not a Git checkout');
    return;
  }
  const LIMIT = 256 * 1024;
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    assert.doesNotMatch(file, /\.(?:mp4|m4v|mov|webm|mkv|avi|wav|mp3|m4a|ogg|flac)$/i, `${file}: put media on the site-media branch (see site/lib/media.js)`);
    const full = path.join(REPO_ROOT, file);
    if (fs.existsSync(full)) {
      assert.ok(fs.statSync(full).size <= LIMIT, `${file} is over ${LIMIT / 1024} KB: put it on the site-media branch (see site/lib/media.js)`);
    }
  }
});

test('the transcript says the same words as the captions', () => {
  const { video } = loadCatalog(REPO_ROOT);
  const spokenText = video.transcript.map((paragraph) => paragraph.spoken).join(' ');
  const vtt = fs.readFileSync(path.join(REPO_ROOT, 'site', 'assets', 'video', 'plugins-and-skills.vtt'), 'utf8');
  assert.equal(vttText(vtt), spokenText, 'video.transcript in site/catalog.json and the captions disagree');

  const outDir = path.join(tempDir('pps-site-out-'), 'dist');
  build({ outDir, basePath: '/power-platform-skills/' });
  const faq = questionsSection(readOut(outDir, 'index.html'));
  const transcript = /<details class="transcript">([\s\S]*?)<\/details>/.exec(faq);
  assert.ok(transcript, 'no transcript');
  const spoken = [...transcript[1].matchAll(/<p>(.*?)<\/p>/g)].map((match) => match[1]);
  const shown = [...transcript[1].matchAll(/<p class="transcript-visual"><strong>On screen:<\/strong> (.*?)<\/p>/g)];
  assert.equal(spoken.length, video.transcript.length);
  assert.equal(shown.length, video.transcript.length, 'every part of the narration needs its on-screen description');
  assert.equal(spoken.join(' '), render.escapeHtml(spokenText));
});

test('every skill the explainer video shows is a real Power Pages skill', () => {
  // The transcript describes the skills the video shows, such as "/create-site, Start a new site".
  // A Power Pages skill that is renamed or removed makes the video wrong, so this fails until the
  // video is replaced.
  const { video } = loadCatalog(REPO_ROOT);
  const text = video.transcript.map((paragraph) => `${paragraph.spoken} ${paragraph.shown}`).join(' ');
  const names = new Set([...text.matchAll(/(?<![\w.])\/([a-z][a-z0-9-]+)/g)].map((match) => match[1]));
  assert.ok(names.size >= 5, `found only ${[...names].join(', ')}`);
  for (const name of names) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'plugins', 'power-pages', 'skills', name, 'SKILL.md')), `the video shows /${name}, which Power Pages no longer has`);
  }
});

// ── README ──────────────────────────────────────────────────────

test('the README install links come from the same templates as the site', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(links.SITE_URL), 'README does not link to the site');
  assert.ok(readme.includes(links.INSTALL_ALL.windows), 'README Windows install command drifted');
  assert.ok(readme.includes(links.INSTALL_ALL.unix), 'README macOS/Linux install command drifted');
  assert.ok(readme.includes(links.INSTALL_ALL_WITH_DATAVERSE.windows), 'README Windows Dataverse command drifted');
  assert.ok(readme.includes(links.INSTALL_ALL_WITH_DATAVERSE.unix), 'README macOS/Linux Dataverse command drifted');
  assert.ok(readme.includes(`](${links.copilotAppMarketplaceUrl()})`), 'README Copilot app marketplace link drifted');
  for (const name of MARKETPLACE_NAMES) {
    assert.ok(readme.includes(`](${links.launcherUrl(links.SITE_URL, 'claude-code', name)})`), `README Claude Code link for ${name}`);
    assert.ok(readme.includes(`](${links.copilotAppInstallUrl(name)})`), `README Copilot app link for ${name}`);
    assert.ok(readme.includes(`/plugin install ${name}@power-platform-skills`), `README manual install for ${name}`);
  }
});
