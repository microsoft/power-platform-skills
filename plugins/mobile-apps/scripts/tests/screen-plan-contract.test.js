'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '..', 'compile-screen-plan.js');
const compiler = require(scriptPath);
const schema = JSON.parse(fs.readFileSync(compiler.SCHEMA_PATH, 'utf8'));

function spec(number, id, name, archetype, pattern, options = {}) {
  const route = `/(app)/${id}`;
  return `#### Screen ${number} - ${name} (\`${route}\`)

- **Components:** ${options.components || 'ScreenHeader, DataList'}
- **Binding:** ${options.binding || 'PreviewService -> name, status'}
- **States:** ${options.states || 'loading, empty, error, populated'}
- **Derived:** ${options.derived || 'none'}
${options.hero ? `- **Hero:** ${options.hero}\n` : ''}- **Archetype:** ${archetype}
- **Purpose:** ${name}
- **Route:** \`${route}\`
- **File:** \`app/(app)/${id}.tsx\`
- **Presentation:** \`default\`
- **Data:** PreviewService.getAll
- **Navigation:** none
- **Navigation intent:** navigate
- **State delta:** standard
- **Key user actions:** open
- **Idempotency guards:** isNavigating
`;
}

function plan({ thin = false, count = 4 } = {}) {
  const definitions = [
    ['home', 'Home', 'Tab-root', 'home-dashboard', { hero: 'metric-hero' }],
    ['items', 'Items', 'List', 'plain-list', {}],
    ['detail', 'Detail', 'Detail', 'record-detail', {}],
    ['profile', 'Profile', 'Tab-root', 'profile-settings', {}],
  ].slice(0, count);
  const rows = definitions.map(([id, name, archetype, pattern]) => `| ${thin ? '' : id} | ${name} | \`/(app)/${id}\` | \`app/(app)/${id}.tsx\` | default | ${archetype} | ${thin ? '' : pattern} | ${name} | PreviewService |`).join('\n');
  const specs = definitions.map(([id, name, archetype, pattern, options], index) => thin && index === 0
    ? spec(index + 1, id, name, archetype, pattern, { components: '', binding: '', states: '', derived: '' }).replace(/^- \*\*(?:Components|Binding|States|Derived):\*\*.*\n/gm, '')
    : spec(index + 1, id, name, archetype, pattern, options)).join('\n');
  return `# Plan

## Screens

### Screen Map

| ID | Screen | Route | File | Presentation | Archetype | Pattern | Purpose | Data |
|---|---|---|---|---|---|---|---|---|
${rows}

### Per-Screen Specs

${specs}
`;
}

function project(t, markdown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-plan-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), markdown);
  return root;
}

test('JSON schema requires structured fields and Home hero', () => {
  assert.deepEqual(schema.$defs.screen.required, ['id', 'route', 'archetype', 'pattern', 'components', 'binding', 'states', 'derived']);
  assert.equal(schema.$defs.screen.allOf[0].then.required.includes('hero'), true);
});

test('complete plan compiles to three-wide build waves', () => {
  const result = compiler.compile(plan());
  assert.equal(result.assessment.mode, 'complete');
  assert.equal(result.assessment.concurrency, 3);
  assert.deepEqual(result.assessment.waves.map((wave) => wave.length), [3, 1]);
  assert.equal(result.plan.screens[0].hero, 'metric-hero');
  assert.deepEqual(Object.keys(result.plan.screens[0]), ['id', 'route', 'archetype', 'pattern', 'components', 'binding', 'states', 'derived', 'hero']);
});

test('thin plan falls back to serial waves and no structured artifact', (t) => {
  const root = project(t, plan({ thin: true, count: 2 }));
  const result = spawnSync(process.execPath, [scriptPath, '--project', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.split('\n')[0], /^DONE_WITH_CONCERNS: thin screen plan; using serial builds/);
  const assessment = JSON.parse(fs.readFileSync(path.join(root, '.mobile-build/screen-plan-assessment.json'), 'utf8'));
  const schedule = JSON.parse(fs.readFileSync(path.join(root, '.mobile-build/screen-build-schedule.json'), 'utf8'));
  assert.equal(assessment.mode, 'thin');
  assert.equal(assessment.concurrency, 1);
  assert.deepEqual(schedule.waves.map((wave) => wave.length), [1, 1]);
  assert.equal(fs.existsSync(path.join(root, '.mobile-build/screen-plan.json')), false);
});

test('complete CLI emits DONE and writes schema-shaped plan', (t) => {
  const root = project(t, plan({ count: 2 }));
  const result = spawnSync(process.execPath, [scriptPath, '--project', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n')[0], 'DONE');
  const structured = JSON.parse(fs.readFileSync(path.join(root, '.mobile-build/screen-plan.json'), 'utf8'));
  assert.equal(structured.schemaVersion, 1);
  assert.equal(structured.screens.length, 2);
});

test('planner and both build workflows consume the structured schedule', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const planner = fs.readFileSync(path.join(pluginRoot, 'agents/screen-planner.md'), 'utf8');
  const prototype = fs.readFileSync(path.join(pluginRoot, 'skills/create-mobile-prototype/SKILL.md'), 'utf8');
  const production = fs.readFileSync(path.join(pluginRoot, 'skills/create-mobile-app/SKILL.md'), 'utf8');
  for (const fieldName of ['ID', 'Components', 'Binding', 'States', 'Derived']) assert.match(planner, new RegExp(`\\*\\*${fieldName}`));
  assert.match(planner, /Home\/dashboard Tab-root/);
  for (const workflow of [prototype, production]) {
    assert.match(workflow, /compile-screen-plan\.js/);
    assert.match(workflow, /screen-build-schedule\.json/);
    assert.match(workflow, /concurrency: 3|at most 3/);
    assert.match(workflow, /thin plan/);
  }
});
