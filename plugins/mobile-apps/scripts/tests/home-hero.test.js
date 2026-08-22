'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const harness = path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'harness');
const checks = [
  require(path.join(harness, 'checks', 'hero-ground-distinct.js')),
  require(path.join(harness, 'checks', 'hero-metric-object.js')),
  require(path.join(harness, 'checks', 'hero-layering.js')),
  require(path.join(harness, 'checks', 'hero-image-is-record.js')),
];
const { heroContract } = require(path.join(harness, 'run.js'));

test('layered seed-backed Home hero satisfies all four contracts', () => {
  const snapshot = { elements: [
    { id: 1, parentId: null, visible: true, testId: 'screen:home', style: { ownBackgroundColor: 'rgb(255,255,255)' } },
    { id: 2, parentId: 1, visible: true, testId: 'hero:state-hero', style: { ownBackgroundColor: 'rgb(10,79,143)' }, rect: { top: 0, bottom: 300 } },
    { id: 3, parentId: 2, visible: true, text: '12', style: { fontSize: '32px' }, rect: { top: 20, bottom: 70 } },
    { id: 4, parentId: 2, visible: true, text: 'North Dock inspection', style: { fontSize: '28px' }, rect: { top: 280, bottom: 330 } },
  ] };
  const context = { heroContract: { key: 'state-hero' }, seedTexts: ['North Dock inspection'] };
  for (const check of checks) assert.equal(check.run(snapshot, context).pass, true);
});

test('slogan headline and unrelated media fail at least two hero checks', () => {
  const snapshot = { elements: [
    { id: 1, parentId: null, visible: true, testId: 'screen:home', style: { ownBackgroundColor: 'white' } },
    { id: 2, parentId: 1, visible: true, testId: 'hero:media-hero', style: { ownBackgroundColor: 'white' }, rect: { top: 0, bottom: 300 } },
    { id: 3, parentId: 2, visible: true, text: 'Big finds. Sky-high style.', style: { fontSize: '32px' }, rect: { top: 20, bottom: 70 } },
    { id: 4, parentId: 2, visible: true, tag: 'img', src: 'mood.jpg', rect: { top: 80, bottom: 250 } },
  ] };
  const context = { heroContract: { key: 'media-hero' }, seedTexts: ['record.jpg'] };
  assert.ok(checks.filter((check) => !check.run(snapshot, context).pass).length >= 2);
});

test('planner requires an exact Home hero key and harness parses it', (t) => {
  const planner = fs.readFileSync(path.join(pluginRoot, 'agents', 'screen-planner.md'), 'utf8');
  for (const key of ['state-hero', 'metric-hero', 'media-hero', 'queue-hero']) assert.match(planner, new RegExp(key));
  assert.match(planner, /Hero.*REQUIRED on every Home\/dashboard Tab-root/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app', '(app)'), { recursive: true });
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), `## Screens\n\n### Per-Screen Specs\n\n#### Screen 1 - Home (\`/(app)/home\`)\n\n- **File:** \`app/(app)/home.tsx\`\n- **Hero:** queue-hero\n\n## Approvals\n`);
  assert.deepEqual(heroContract(root, 'app/(app)/home.tsx'), { key: 'queue-hero' });
});