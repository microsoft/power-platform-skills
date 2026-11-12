'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { checkGraph, mergeIntoPlan, renderScreenGraph } = require('../render-screen-graph');

const SCRIPT = path.resolve(__dirname, '..', 'render-screen-graph.js');

function graph() {
  return {
    navigation: 'Stack',
    pattern: 'Today is the landing screen; a row opens the inspection.',
    list: [
      { name: 'Login', route: '/login', file: 'app/login.tsx', source: 'template (keep)', purpose: 'Sign-in', data: '—', capabilities: [] },
      {
        name: 'Today', route: '/(app)/home', file: 'app/(app)/home.tsx', presentation: 'default', source: 'replace template',
        archetype: 'List', purpose: "Today's inspections | what is left", layout: 'Rows with site and status; bottom CTA Open next.',
        data: 'useInspectionList()', capabilities: [], params: [],
        opens: [{ to: '/(app)/inspection', params: ['id'], intent: 'push', from: 'Inspection row' }],
      },
      {
        name: 'Inspection', route: '/(app)/inspection', file: 'app/(app)/inspection.tsx', presentation: 'default', source: 'new',
        archetype: 'Detail', purpose: 'One inspection', layout: 'Status band, details, Take photo, Mark complete.',
        data: 'useInspection(id), useInspectionMutations().update, capturePhoto()', capabilities: ['camera'], params: ['id: string'], opens: [],
      },
    ],
    conventions: ['List rows: status-stripe-card.'],
    contract: {
      entities: [{
        name: 'Inspection', purpose: 'One inspection.',
        fields: ['title: string', "status: 'scheduled' | 'complete'", 'photo?: image', 'siteName: string (from Site)'],
        operations: ['list (cursor; order: title asc)', 'get', 'update'],
        queries: [], sampleRecords: 12,
      }],
      deviceActions: ['`capturePhoto()` → `{ uri: string }` - Inspection "Take photo"; capability: camera'],
    },
  };
}

function project(t, screens, plan) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-graph-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'));
  fs.writeFileSync(path.join(root, '.tmp', 'screens.json'), JSON.stringify(screens));
  if (plan !== undefined) fs.writeFileSync(path.join(root, 'native-app-plan.md'), plan);
  return root;
}

test('a valid graph renders every graph subsection into the plan', (t) => {
  const root = project(t, graph(), '# App\n\n## Screens\n\n## Approvals\n\n- [ ] Screen graph approved\n');
  const result = renderScreenGraph({ workingDir: root });
  assert.equal(result.status, 'ok');
  assert.equal(result.screens, 2, 'template (keep) rows are not screens to build');
  const plan = fs.readFileSync(path.join(root, 'native-app-plan.md'), 'utf8');
  const order = ['### Navigation Pattern', '### Screen Map', '### Navigation Contracts', '### Shared Conventions', '### Data Contract', '## Approvals'];
  const at = order.map((h) => plan.indexOf(h));
  assert.ok(at.every((i) => i > 0), 'every subsection is written');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'subsections appear in the screen-planner order, before Approvals');
  // A `|` in a cell would end the table row early.
  assert.match(plan, /Today's inspections \\\| what is left/);
  assert.match(plan, /\| `\/\(app\)\/inspection` \| `id: string` \| Today \(Inspection row\) - push with id \|/);
  // The Data Contract keeps the format preview-data-layer.md defines, which later steps read.
  assert.match(plan, /#### Inspection\n- \*\*Purpose:\*\* One inspection\.\n- \*\*Fields:\*\* `title: string` · /);
  assert.match(plan, /- \*\*Sample records:\*\* 12\n/);
  assert.match(plan, /#### Device actions\n- `capturePhoto\(\)`/);
});

test('a rerender replaces the graph and keeps sections written after it', () => {
  const plan = [
    '# App', '', '## Screens', '', '### Screen Map', '', 'old map', '', '### Per-Screen Specs', '', 'spec body', '',
    '### Open Questions', '', '- none', '', '## Approvals', '',
  ].join('\n');
  const merged = mergeIntoPlan(plan, {
    'Navigation Pattern': '### Navigation Pattern\n\nnew', 'Screen Map': '### Screen Map\n\nnew map',
    'Navigation Contracts': '### Navigation Contracts', 'Shared Conventions': '### Shared Conventions', 'Data Contract': '### Data Contract',
  });
  assert.doesNotMatch(merged, /old map/);
  assert.match(merged, /new map[\s\S]*### Per-Screen Specs\n\nspec body[\s\S]*### Open Questions[\s\S]*## Approvals/);
  assert.equal((merged.match(/### Screen Map/g) || []).length, 1);
});

test('every problem is reported at once, so one repair pass fixes them all', () => {
  const bad = graph();
  bad.list[1].opens.push({ to: '/(app)/missing', intent: 'push' });
  bad.list[1].opens[0].params.push('editId');
  bad.list[2].archetype = 'Screen';
  bad.contract.entities[0].fields.push('Due Date: date', 'site: Site');
  bad.contract.entities[0].operations.push('archive');
  bad.contract.entities[0].sampleRecords = 0;
  const { problems } = checkGraph(bad);
  for (const expected of [
    /opens \/\(app\)\/missing, which is not a route/,
    /sends 'editId' to \/\(app\)\/inspection, which does not list it/,
    /archetype 'Screen'/,
    /field 'Due Date: date' must read 'name: type'/,
    /field 'site' has type 'Site', which is neither a base type nor a contract entity/,
    /operation 'archive'/,
    /sampleRecords must be a positive whole number/,
  ]) {
    assert.ok(problems.some((p) => expected.test(p)), `missing problem ${expected}`);
  }
});

test('the landing screen is required, and a hook naming no entity is a warning', () => {
  const noEntry = graph();
  noEntry.list[1].file = 'app/(app)/today.tsx';
  noEntry.list[1].route = '/(app)/today';
  assert.ok(checkGraph(noEntry).problems.some((p) => p.includes('app/(app)/home.tsx')));

  const stray = graph();
  stray.list[1].data = 'useInspectionList(), useWeather()';
  const { problems, warnings } = checkGraph(stray);
  assert.deepEqual(problems, []);
  assert.ok(warnings.some((w) => w.includes('useWeather')));
});

test('the CLI exits 1 with problems and leaves the plan untouched', (t) => {
  const bad = graph();
  bad.navigation = 'Carousel';
  const root = project(t, bad, '# App\n\n## Screens\n');
  const run = spawnSync(process.execPath, [SCRIPT, '--working-dir', root], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(JSON.parse(run.stdout).problems[0], /unknown navigation pattern 'Carousel'/);
  assert.equal(fs.readFileSync(path.join(root, 'native-app-plan.md'), 'utf8'), '# App\n\n## Screens\n');

  const malformed = project(t, {}, '');
  fs.writeFileSync(path.join(malformed, '.tmp', 'screens.json'), '{ not json');
  const broken = spawnSync(process.execPath, [SCRIPT, '--working-dir', malformed], { encoding: 'utf8' });
  assert.equal(broken.status, 1);
  assert.equal(JSON.parse(broken.stdout).status, 'blocked');
});
