'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const templateRoot = path.join(pluginRoot, 'template');
const supervisor = path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'runtime', 'supervisor.js');
const tsc = path.join(templateRoot, 'node_modules', 'typescript', 'bin', 'tsc');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-supervisor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(templateRoot, root, { recursive: true, filter: (source) => path.basename(source) !== 'node_modules' });
  fs.symlinkSync(path.join(templateRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [supervisor, ...args, root], { encoding: 'utf8' });
}

test('supervisor paints an atomic shell before planning and restores runtime entry', { skip: !fs.existsSync(tsc) }, (t) => {
  const root = project(t);
  const originalIndex = fs.readFileSync(path.join(root, 'app/index.tsx'), 'utf8');
  const started = spawnSync(process.execPath, [supervisor, 'start', root, '--no-metro'], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  assert.match(fs.readFileSync(path.join(root, 'app/index.tsx'), 'utf8'), /Redirect href="\/building"/);
  assert.match(fs.readFileSync(path.join(root, 'app/building.tsx'), 'utf8'), /Building your app/);
  assert.equal(fs.existsSync(path.join(root, '.mobile-build/events.ndjson')), true);
  assert.equal(fs.existsSync(path.join(root, 'brand/tokens.ts')), true);
  assert.equal(fs.readdirSync(path.join(root, '.mobile-build')).some((name) => name.endsWith('.tmp')), false);
  const typecheck = spawnSync(process.execPath, [tsc, '--project', path.join(root, 'tsconfig.json')], { encoding: 'utf8' });
  assert.equal(typecheck.status, 0, `${typecheck.stdout}\n${typecheck.stderr}`);

  const prepared = run(root, 'prepare-runtime');
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'app/index.tsx'), 'utf8'), originalIndex);
});

test('supervisor plans screens, debounces atomic progress, and reports dead Metro as a concern', (t) => {
  const root = project(t);
  assert.equal(spawnSync(process.execPath, [supervisor, 'start', root, '--no-metro'], { encoding: 'utf8' }).status, 0);
  const plan = path.join(root, 'native-app-plan.md');
  fs.writeFileSync(plan, `# Plan\n\n## Screens\n\n### Screen Map\n\n| Screen | File |\n|---|---|\n| Today | app/(app)/home.tsx |\n| Profile | app/(app)/profile.tsx |\n`);
  const planned = spawnSync(process.execPath, [supervisor, 'plan', root, '--plan', plan], { encoding: 'utf8' });
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(spawnSync(process.execPath, [supervisor, 'screen', root, '--id', 'today', '--state', 'building'], { encoding: 'utf8' }).status, 0);
  assert.match(fs.readFileSync(path.join(root, 'src/generated/buildProgress.ts'), 'utf8'), /"state": "building"/);
  assert.match(fs.readFileSync(path.join(root, '.mobile-build/events.ndjson'), 'utf8'), /"kind":"screen"/);

  const statePath = path.join(root, '.mobile-build/supervisor.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.metro = { state: 'ready', pid: 99999999, url: 'exp://test' };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const result = spawnSync(process.execPath, [supervisor, 'status', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'DONE_WITH_CONCERNS');
  assert.match(result.stdout, /text-only mode/);
});

test('supervisor budgets Metro readiness below thirty seconds', () => {
  const source = require(supervisor);
  assert.equal(source.METRO_READY_BUDGET_MS, 30000);
  assert.equal(source.DEBOUNCE_MS, 500);
});

test('prototype workflow starts Track A before planning and never starts Metro in Track B', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills/create-mobile-prototype/SKILL.md'), 'utf8');
  const trackStart = skill.indexOf('runtime/supervisor.js" start');
  const brief = skill.indexOf('### Step 2 - Capture Brief');
  const planning = skill.indexOf('### Step 3 - Plan In Prototype Mode');
  assert.ok(trackStart > 0 && trackStart < brief && brief < planning);
  for (const label of ['Understood:', 'Flow:', 'Records:', 'Inferred:', 'Native:', 'Dropped:', 'Connectors:', 'Assumed:']) {
    assert.match(skill, new RegExp(label));
  }
  assert.match(skill, /configure-prototype-runtime\.js"[\s\S]*prototype "\/building"/);
  for (const state of ['building', 'written', 'checked', 'built']) {
    assert.match(skill, new RegExp(`--state ${state}`));
  }
  const stepTen = skill.slice(skill.indexOf('### Step 10'));
  assert.match(stepTen, /supervisor\.js" release/);
  assert.match(stepTen, /supervisor\.js" status/);
  assert.doesNotMatch(stepTen, /npx expo start|npm run dev/);
  assert.match(stepTen, /DONE_WITH_CONCERNS/);
});