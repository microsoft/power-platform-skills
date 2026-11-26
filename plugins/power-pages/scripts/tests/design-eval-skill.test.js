'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const collect = require('../../skills/design-eval/scripts/collect');
const grade = require('../../skills/design-eval/scripts/grade');
const { judgmentIds } = require('../lib/design-grade/catalog');
const { page: syntheticPage } = require('./design-grade-synthetic');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-eval-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'powerpages.config.json'), '{"siteName":"Harbor Tide"}');
  fs.mkdirSync(path.join(root, 'src', 'styles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'styles', 'theme.css'), ':root {\n  --color-primary: #0b4f6c;\n}\nbody { font-size: 15px; }\n');
  return root;
}

function runWith(root, evidencePages, stamp = new Date('2026-01-01T10:00:00Z')) {
  const runDir = collect.createRunDir(root, stamp);
  fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify({ baseUrl: 'http://localhost:5173', viewports: { desktop: {}, mobile: {} }, pages: evidencePages }));
  return runDir;
}

const passAll = () => Object.fromEntries(judgmentIds().map((id) => [id, { result: 'pass' }]));

function call(fn, request, options = {}) {
  let out = '';
  let err = '';
  const code = fn(['--input', '-'], { write: (s) => { out += s; }, writeError: (s) => { err += s; }, readStdin: () => JSON.stringify(request), ...options });
  return { code, err, json: out ? JSON.parse(out) : null };
}

test('collect accepts only a Power Pages project, a safe URL, known fields, and at most ten routes', (t) => {
  const root = project(t);
  const parse = (req) => collect.parseArgs(['--input', '-'], { readStdin: () => JSON.stringify(req) });
  assert.deepEqual(parse({ url: 'http://localhost:5173/?x=1', project: root }), { url: 'http://localhost:5173', routes: ['/'], project: root });
  assert.match(parse({ url: 'http://localhost:5173', project: os.tmpdir() }).error, /powerpages\.config\.json/);
  assert.match(parse({ url: 'file:///etc/passwd', project: root }).error, /http/i);
  assert.match(parse({ url: 'http://localhost:5173', project: root, shell: 'x' }).error, /Unknown field/);
  assert.match(parse({ url: 'http://localhost:5173', project: root, routes: Array.from({ length: 11 }, (_, i) => `/p${i}`) }).error, /at most 10/);
  assert.match(collect.parseArgs(['--url', 'http://x']).error, /Usage/);
});

test('each run gets its own folder under docs/design-eval, and evidence URLs are redacted', (t) => {
  const root = project(t);
  const dir = collect.createRunDir(root, new Date('2026-01-01T10:00:00.123Z'));
  assert.equal(path.relative(root, dir).split(path.sep).join('/'), 'docs/design-eval/2026-01-01T10-00-00-123');
  assert.ok(fs.existsSync(path.join(dir, 'shots')));
  const clean = collect.sanitizeDeep({ a: ['see https://cdn.example/a.png?sig=SECRET now'], b: { html: '<a href="/f?token=SECRET">x</a>' } });
  assert.ok(!JSON.stringify(clean).includes('SECRET'));
  // display= and dead links are decided before the query is redacted, so redaction cannot create false issues.
  const evidence = collect.sanitizeDeep(collect.resolveBeforeRedaction({ pages: [{ viewports: { desktop: {
    fonts: { googleFontLinks: ['https://fonts.googleapis.com/css2?family=A&display=swap'] },
    links: [{ href: '#main' }, { href: '#' }],
  } } }] })).pages[0].viewports.desktop;
  assert.deepEqual(evidence.fonts.googleFontLinks, [{ href: 'https://fonts.googleapis.com/css2', hasDisplay: true }]);
  assert.deepEqual(evidence.links.map((l) => l.dead), [false, true]);
});

test('grade only accepts run folders created by collect', (t) => {
  const root = project(t);
  assert.match(grade.resolveRun(root).error, /run folder created by collect/);
  const dir = collect.createRunDir(root);
  assert.match(grade.resolveRun(dir).error, /No evidence\.json/);
  assert.match(grade.parseArgs(['--input', '-'], { readStdin: () => JSON.stringify({ action: 'fix', dir }) }).error, /Usage/);
});

test('candidates, incomplete judgments, then a graded report that opens, with top issues and source hints', (t) => {
  const root = project(t);
  const runDir = runWith(root, [syntheticPage((p) => {
    p.viewports.desktop.document.hasFavicon = false;
    p.viewports.mobile.textBlocks[0].fontSize = 13;
  })]);
  const cands = call(grade.main, { action: 'candidates', dir: runDir });
  assert.equal(cands.code, 0, cands.err);
  assert.deepEqual(cands.json.keys, ['CON-03', 'RES-05']);
  assert.ok(fs.existsSync(path.join(runDir, 'candidates.json')));

  assert.match(call(grade.main, { action: 'grade', dir: runDir }).err, /No judgments\.json/);
  fs.writeFileSync(path.join(runDir, 'judgments.json'), JSON.stringify({ candidates: {}, pages: { '/': {} } }));
  const invalid = call(grade.main, { action: 'grade', dir: runDir });
  assert.equal(invalid.code, 1);
  assert.match(invalid.err, /missing decision for measured issue CON-03/);

  fs.writeFileSync(path.join(runDir, 'judgments.json'), JSON.stringify({
    candidates: { 'CON-03': { decision: 'confirm' }, 'RES-05': { decision: 'confirm' } },
    pages: { '/': { ...passAll(), 'J-02': { result: 'fail', evidence: 'Two filled buttons of equal weight; no primary.', screenshot: 'shots/home-desktop-fold.jpg' } } },
  }));
  const opened = [];
  const graded = call(grade.main, { action: 'grade', dir: runDir }, { open: (target) => opened.push(target) });
  assert.equal(graded.code, 0, graded.err);
  const out = graded.json;
  assert.equal(out.verdict, 'Not ready');
  assert.deepEqual(out.failingGates, ['G1 Unclear offering or primary call to action']);
  assert.deepEqual(out.topIssues.map((i) => i.key), ['J-02', 'RES-05'], 'gates first, then other majors; minors are not top issues');
  assert.ok(out.topIssues.find((i) => i.key === 'RES-05').source.some((s) => s.startsWith('src/styles/theme.css:')), 'source hints point into the project');
  assert.deepEqual(opened, [path.join(runDir, 'report.html')]);
  assert.equal(out.opened, true);
  assert.ok(fs.existsSync(path.join(runDir, 'grade.json')));
  assert.equal(out.previous, null);
});

test('top issues are capped at four, and a later run reports the previous verdict and scores', (t) => {
  const root = project(t);
  const fakeGrade = { issues: Array.from({ length: 6 }, (_, i) => ({ key: `K${i}`, severity: 'major' })).concat([{ key: 'M', severity: 'minor' }]) };
  assert.deepEqual(grade.topIssues(fakeGrade).map((i) => i.key), ['K0', 'K1', 'K2', 'K3']);

  const first = runWith(root, [syntheticPage((p) => { p.viewports.desktop.document.hasFavicon = false; })], new Date('2026-01-01T10:00:00Z'));
  fs.writeFileSync(path.join(first, 'judgments.json'), JSON.stringify({ candidates: { 'CON-03': { decision: 'confirm' } }, pages: { '/': passAll() } }));
  assert.equal(call(grade.main, { action: 'grade', dir: first, open: false }).code, 0);
  const second = runWith(root, [syntheticPage()], new Date('2026-01-01T11:00:00Z'));
  fs.writeFileSync(path.join(second, 'judgments.json'), JSON.stringify({ candidates: {}, pages: { '/': passAll() } }));
  const out = call(grade.main, { action: 'grade', dir: second, open: false }).json;
  assert.equal(out.verdict, 'Ready');
  assert.equal(out.opened, false);
  assert.equal(out.previous.verdict, 'Ready');
  assert.deepEqual(out.previous.keys, ['CON-03']);
  assert.equal(out.previous.categories.find((c) => c.name === 'Visual Craft & Brand').score, 4.8);
});

test('the skill, agent, and create-site offer stay wired together', () => {
  const root = path.resolve(__dirname, '..', '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  const skill = read('skills/design-eval/SKILL.md');
  assert.match(skill, /^name: design-eval$/m);
  assert.match(skill, /allowed-tools: .*AskUserQuestion.*Agent/);
  assert.match(skill, /skills\/design-eval\/scripts\/collect\.js" --input - <<'REQUEST'/);
  assert.match(skill, /Spawn the \*\*design-judge\*\* agent/);
  assert.match(skill, /<!-- gate: design-eval:6\.fix-select/);
  assert.match(skill, /<!-- gate: design-eval:7\.rerun/);
  const agent = read('agents/design-judge.md');
  assert.match(agent, /^name: design-judge$/m);
  assert.doesNotMatch(agent.split('---')[1], /AskUserQuestion|Bash|Edit/, 'the judge is headless and cannot run commands or edit the site');
  const createSite = read('skills/create-site/SKILL.md');
  assert.match(createSite, /<!-- gate: create-site:8\.design-eval/);
  assert.match(createSite, /invoke the `\/design-eval` skill/);
});

test('end to end against a real page (opt-in: set DESIGN_GRADE_PLAYWRIGHT to a playwright-core path)', {
  skip: process.env.DESIGN_GRADE_PLAYWRIGHT ? false : 'needs a Playwright install; CI has none',
  timeout: 240000,
}, async (t) => {
  const http = require('node:http');
  const root = project(t);
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Vite App</title></head><body><nav><a href="#">Home</a></nav><h1>Welcome to your site</h1><div style="width:600px">wide</div></body></html>';
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    let out = '';
    const code = await collect.main(['--input', '-'], {
      readStdin: () => JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, routes: ['/'], project: root }),
      loadPlaywrightFn: () => require(process.env.DESIGN_GRADE_PLAYWRIGHT), channel: () => process.env.DESIGN_GRADE_CHANNEL || undefined,
      loadAxeSourceFn: async () => { throw new Error('offline'); }, write: (s) => { out += s; }, writeError: () => {},
    });
    assert.equal(code, 0);
    const { runDir, screenshots } = JSON.parse(out);
    assert.ok(screenshots.every((f) => fs.existsSync(f)) && screenshots.length === 4);
    const keys = call(grade.main, { action: 'candidates', dir: runDir }).json.keys;
    for (const key of ['RES-01', 'RES-02', 'CON-02', 'INT-02']) assert.ok(keys.includes(key), `${key} in ${keys.join(', ')}`);
  } finally {
    server.close();
  }
});

test('re-runs must re-check previous judgment fails, and report resolved and new issues', (t) => {
  const root = project(t);
  const first = runWith(root, [syntheticPage((p) => { p.viewports.desktop.document.hasFavicon = false; })], new Date('2026-01-01T10:00:00Z'));
  const failJ20 = { result: 'fail', evidence: 'Dashboard says 379 students; the list shows 12.', screenshot: 'shots/home-desktop-fold.jpg' };
  fs.writeFileSync(path.join(first, 'judgments.json'), JSON.stringify({ candidates: { 'CON-03': { decision: 'confirm' } }, pages: { '/': { ...passAll(), 'J-20': failJ20 } } }));
  assert.equal(call(grade.main, { action: 'grade', dir: first, open: false }).code, 0);

  const second = runWith(root, [syntheticPage((p) => { p.viewports.mobile.textBlocks[0].fontSize = 13; })], new Date('2026-01-01T11:00:00Z'));
  const cands = call(grade.main, { action: 'candidates', dir: second }).json;
  assert.deepEqual(cands.recheck, ['/ J-20']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(second, 'recheck.json'), 'utf8')).map((f) => f.id), ['J-20']);

  const silentPass = { candidates: { 'RES-05': { decision: 'confirm' } }, pages: { '/': passAll() } };
  fs.writeFileSync(path.join(second, 'judgments.json'), JSON.stringify(silentPass));
  const rejected = call(grade.main, { action: 'grade', dir: second, open: false });
  assert.equal(rejected.code, 1);
  assert.match(rejected.err, /J-20"\] failed in the previous run; a pass needs evidence/);

  silentPass.pages['/']['J-20'] = { result: 'pass', evidence: 'The dashboard now shows 12 students, matching the list.' };
  fs.writeFileSync(path.join(second, 'judgments.json'), JSON.stringify(silentPass));
  const out = call(grade.main, { action: 'grade', dir: second, open: false }).json;
  assert.deepEqual(out.resolvedSinceLast.sort(), ['CON-03', 'J-20']);
  assert.deepEqual(out.newSinceLast, ['RES-05']);
});
