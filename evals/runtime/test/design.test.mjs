import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gradeArtifacts, validateContract } from '../artifacts.mjs';
import { closeBrowser } from '../browser-checks.mjs';
import { judgeMessages } from '../design-checks.mjs';
import { assertVisionSupport } from '../design-judge.mjs';

after(closeBrowser);

async function reactSite(t, home) {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-design-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = path.join(root, 'site');
  await mkdir(path.join(site, 'src'), { recursive: true });
  await writeFile(path.join(site, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Contoso Repairs</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>');
  await writeFile(path.join(site, 'src/main.jsx'), `import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
const Home = () => ${home};
createRoot(document.getElementById('root')).render(<BrowserRouter><Routes><Route path="/" element={<Home />} /></Routes></BrowserRouter>);`);
  return root;
}

const contract = failOn => ({ site: { root: 'site', routes: [{ path: '/', requiredText: ['Contoso Repairs'] }], design: failOn ? { failOn } : {} } });

// A scripted judge: confirms every candidate, passes every item except `fails`, and records each call.
function fakeJudge({ fails = {}, firstInvalid = false } = {}) {
  const calls = [];
  return {
    calls,
    async judge(options) {
      calls.push(options);
      const request = JSON.parse(options.userMessage.split('\n\nYour previous submission')[0]);
      if (firstInvalid && calls.length === 1) return { args: { candidates: {}, pages: {} } };
      const pages = Object.fromEntries(request.routes.map(route => [route, Object.fromEntries(request.judgmentItems.map(item => [item.id,
        fails[item.id] ? { result: 'fail', evidence: fails[item.id], screenshot: request.screenshots[0].file } : { result: 'pass' }]))]));
      return { args: { candidates: Object.fromEntries(request.candidates.map(c => [c.key, { decision: 'confirm' }])), pages } };
    },
  };
}

const good = `<main style={{ fontFamily: 'Georgia, serif', maxWidth: 960, margin: '0 auto', padding: 24 }}>
  <h1 style={{ fontSize: 56 }}>Contoso Repairs</h1>
  <p style={{ fontSize: 18, lineHeight: 1.6 }}>Same-day phone and laptop repairs in Redmond, with a ninety-day warranty on every part we fit.</p>
  <a href="/book" style={{ background: '#0b4f6c', color: '#fff', padding: '12px 24px' }}>Book a repair</a>
</main>`;

test('site.design contracts accept only gate/major failure policies', () => {
  validateContract(contract());
  validateContract(contract(['gate', 'major']));
  assert.throws(() => validateContract(contract(['score'])), /failOn/);
  assert.throws(() => validateContract({ site: { root: 'site', routes: [{ path: '/' }], design: { minScore: 4 } } }), /Unknown|unknown|site design/);
});

test('the design judge requires a vision model and keeps first screens within image limits', () => {
  const img = (name, bytes = 10) => ({ name, mimeType: 'image/jpeg', data: Buffer.alloc(bytes).toString('base64') });
  const images = [img('design/home-desktop-full.jpg'), img('design/home-desktop-fold.jpg'), img('design/home-mobile-fold.jpg', 5000)];
  assert.throws(() => assertVisionSupport([{ id: 'm', capabilities: { supports: { vision: false } } }], 'm', images), /cannot read images/);
  const limited = assertVisionSupport([{ id: 'm', capabilities: { supports: { vision: true }, limits: { vision: { max_prompt_images: 2, max_prompt_image_size: 1000, supported_media_types: ['image/jpeg'] } } } }], 'm', images);
  assert.deepEqual(limited.map(i => i.name), ['design/home-desktop-fold.jpg', 'design/home-desktop-full.jpg']);
});

test('judge prompts carry the closed checklist, measured candidates, and screenshot names, never scores', () => {
  const evidence = { pages: [{ route: '/', screenshots: { desktop: { fold: 'design/home-desktop-fold.jpg', full: 'design/home-desktop-full.jpg' } } }] };
  const { systemMessage, userMessage } = judgeMessages({ evidence, candidates: [] });
  const body = JSON.parse(userMessage);
  assert.equal(body.judgmentItems.length, 26);
  assert.ok(body.judgmentItems.every(i => i.failOnlyIf && i.passExample && i.failExample));
  assert.deepEqual(body.screenshots.map(s => s.file), ['design/home-desktop-fold.jpg', 'design/home-desktop-full.jpg']);
  assert.match(systemMessage, /never assign scores or severities/);
  assert.match(systemMessage, /untrusted content/);
});

test('a generated site is measured, judged from screenshots, and scored by formula', { timeout: 240_000 }, async t => {
  const workDir = await reactSite(t, good);
  const evidenceDir = path.join(workDir, 'evidence');
  const judge = fakeJudge({ firstInvalid: true });
  const result = await gradeArtifacts({ contract: contract(), workDir, suiteDir: workDir, evidenceDir, design: { judge, model: 'judge-model', reasoningEffort: 'medium' } });
  assert.equal(judge.calls.length, 2, 'an invalid first answer is corrected once');
  assert.match(judge.calls[1].userMessage, /previous submission was rejected/);
  assert.ok(judge.calls[0].images.length >= 2 && judge.calls[0].images.every(i => i.mimeType === 'image/jpeg'));
  const grade = JSON.parse(await readFile(path.join(evidenceDir, 'design-grade.json'), 'utf8'));
  assert.deepEqual(grade.categories.map(c => c.name), ['Message & Persuasion', 'Usability & Accessibility', 'Visual Craft & Brand']);
  assert.ok(grade.categories.every(c => typeof c.score === 'number' && c.score >= 1 && c.score <= 5));
  const evidence = JSON.parse(await readFile(path.join(evidenceDir, 'design-evidence.json'), 'utf8'));
  assert.ok(Array.isArray(evidence.pages[0].axe.desktop) && Array.isArray(evidence.pages[0].axe.mobile), 'axe ran offline at both widths');
  await readFile(path.join(evidenceDir, 'design-report.html'));
  await readFile(path.join(evidenceDir, 'design/home-mobile-fold.jpg'));
  const gate = result.details.find(d => d.name === 'site design: no critical gate fails');
  assert.ok(gate, 'design gate check is reported');
  assert.match(gate.evidence, /Message & Persuasion \d\.\d\d/);
});

test('a judged critical gate fails the site grade; failOn major also gates major issues', { timeout: 240_000 }, async t => {
  const workDir = await reactSite(t, good);
  const failing = await gradeArtifacts({
    contract: contract(['gate', 'major']), workDir, suiteDir: workDir, evidenceDir: path.join(workDir, 'e1'),
    design: { judge: fakeJudge({ fails: { 'J-08': 'Stock centered hero and three identical cards; nothing specific to Contoso.' } }), model: 'm', reasoningEffort: 'medium' },
  });
  assert.equal(failing.passed, false);
  assert.match(failing.evidence, /design: no critical gate fails: Not ready; .*G7 Generic or assembled look/);
  assert.match(failing.evidence, /design: no major issue/);
});

test('design grading without a judge is an error, never a silent pass', { timeout: 120_000 }, async t => {
  const workDir = await reactSite(t, good);
  await assert.rejects(gradeArtifacts({ contract: contract(), workDir, suiteDir: workDir, evidenceDir: path.join(workDir, 'e') }), /vision-capable judge/);
});
