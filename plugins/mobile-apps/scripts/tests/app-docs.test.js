'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EDIT_ITEM_STATUSES, PHASES, PHONE_STAGES, SECTIONS, applyStep, initState, loadState, outputPath,
  save, setPhone, setSection, summarize, syncPlanToCurrentApp, writeEditProgress, editTempDir,
  prepareEditTempDir,
} = require('../app-docs');

const scriptPath = path.resolve(__dirname, '..', 'app-docs.js');

function project(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function seeded(root) {
  return save(root, initState(root, { appName: 'Field Inspections', dataPlatform: 'dataverse' }));
}

test('init creates docs/ with a plan that carries its own brand mark', () => {
  const root = project('docs-init');
  seeded(root);
  assert.ok(fs.existsSync(path.join(root, 'docs', 'create-app-plan.html')));

  // The mark is inlined rather than copied beside the page. The plan is opened over file://,
  // where the origin is opaque, so a CSP `img-src 'self'` would not reliably match a sibling -
  // and inlining also makes the plan a single shareable file rather than a folder.
  assert.ok(!fs.existsSync(path.join(root, 'docs', 'power-apps-icon.svg')),
    'no sibling asset should be written');
  const html = fs.readFileSync(outputPath(root), 'utf8');
  assert.match(html, /<img class="logo" id="brandLogo" src="data:image\/svg\+xml;base64,/);
});

test('a resumed run keeps the progress already recorded', () => {
  const root = project('docs-resume');
  seeded(root);
  save(root, applyStep(loadState(root), { id: 'requirements', status: 'done' }));

  // init must be safe to call again; it must not reset completed phases.
  const again = initState(root, { appName: 'Field Inspections' });
  assert.equal(again.phases.find((p) => p.id === 'requirements').status, 'done');
});

test('only one phase can be in progress at a time', () => {
  const root = project('docs-active');
  const state = initState(root, { appName: 'App' });
  applyStep(state, { id: 'requirements', status: 'active' });
  applyStep(state, { id: 'architecture', status: 'active' });

  assert.equal(state.phases.find((p) => p.id === 'requirements').status, 'done');
  assert.equal(state.phases.filter((p) => p.status === 'active').length, 1);
});

test('skipped phases leave the percentage honest', () => {
  const root = project('docs-skip');
  const state = initState(root, { appName: 'App' });
  // A connector-only app skips both Dataverse phases; they must not count as outstanding
  // work or the plan would never reach 100%.
  applyStep(state, { id: 'data-model', status: 'skipped' });
  applyStep(state, { id: 'dataverse', status: 'skipped' });
  for (const phase of state.phases.filter((p) => p.status !== 'skipped')) {
    applyStep(state, { id: phase.id, status: 'done' });
  }

  const summary = summarize(state);
  assert.equal(summary.total, PHASES.length - 2);
  assert.equal(summary.percent, 100);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.settled, true, 'a finished plan must stop reloading itself');
});

test('a failed phase settles the page and is counted', () => {
  const root = project('docs-fail');
  const state = initState(root, { appName: 'App' });
  applyStep(state, { id: 'scaffold', status: 'failed' });
  const summary = summarize(state);
  assert.equal(summary.failed, 1);
  assert.equal(summary.settled, true);
});

test('a note does not outlive the status it was written with', () => {
  const root = project('docs-note');
  const state = initState(root, { appName: 'App' });

  // How the gate protocol actually runs: open with an "awaiting" note, close with a bare
  // --status done. The note used to stick, so an approved gate kept asking for approval.
  applyStep(state, { id: 'architecture', status: 'active', note: 'Gate 1 — awaiting your approval' });
  applyStep(state, { id: 'architecture', status: 'done' });
  const architecture = state.phases.find((phase) => phase.id === 'architecture');
  assert.equal(architecture.status, 'done');
  assert.equal(architecture.note, '', 'the awaiting-approval note must not survive approval');

  // An explicit note on the closing call is kept.
  applyStep(state, { id: 'data-model', status: 'active', note: 'Gate 2 — awaiting your approval' });
  applyStep(state, { id: 'data-model', status: 'done', note: 'Gate 2 — 6 tables approved' });
  assert.equal(state.phases.find((p) => p.id === 'data-model').note, 'Gate 2 — 6 tables approved');

  // A repeated status keeps its note, so progress updates survive a refresh.
  applyStep(state, { id: 'screens', status: 'active', note: '3 of 12 screens built' });
  applyStep(state, { id: 'screens', status: 'active' });
  assert.equal(state.phases.find((p) => p.id === 'screens').note, '3 of 12 screens built');

  // Opening the next phase auto-closes the live one, and the note goes with that status too.
  // A gate left open on its awaiting note otherwise kept asking for approval on a phase the plan
  // already showed as done.
  applyStep(state, { id: 'screen-plan', status: 'active', note: 'Gate 3 — awaiting your approval' });
  applyStep(state, { id: 'scaffold', status: 'active' });
  const screenPlan = state.phases.find((p) => p.id === 'screen-plan');
  assert.equal(screenPlan.status, 'done');
  assert.equal(screenPlan.note, '', 'an auto-closed phase must not keep its awaiting note');
});

test('the skill closes every gate with a fresh note', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  const body = skill.slice(skill.indexOf('\n### Step '));
  // Clearing on status change means a gate closed without a note simply goes blank, which is
  // correct but less useful than saying it was approved.
  for (const gate of ['architecture', 'data-model', 'screen-plan']) {
    const closes = [...body.matchAll(new RegExp(`step --id ${gate} --status done([^\n]*)`, 'g'))];
    assert.ok(closes.length > 0, `${gate} must be closed somewhere`);
    for (const [, rest] of closes) {
      assert.match(rest, /--note /, `${gate} is closed without a note`);
    }
  }
});

test('the trust report is written as soon as the gate it depends on closes', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  const body = skill.slice(skill.indexOf('\n### Step '));

  // The tab told the user it would fill after Gate 1 while the skill only wrote it at Step 10,
  // so it sat empty for most of the run. A proposed pass lands with Gate 1 and Step 10 finalises.
  const writes = [...body.matchAll(/set --section trust[^\n]*--state (proposed|approved)/g)].map((m) => m[1]);
  assert.deepEqual(writes, ['proposed', 'approved'],
    'trust must be proposed at the gate that settles capabilities, then approved once wired');

  const proposedAt = body.indexOf('set --section trust');
  const gate1Close = body.indexOf('step --id architecture --status done');
  assert.ok(gate1Close !== -1 && proposedAt > gate1Close, 'the first pass belongs with the Gate 1 batch');
});

test('sections merge so a later step can add to an earlier one', () => {
  const root = project('docs-sections');
  const state = initState(root, { appName: 'App' });
  setSection(state, 'environment', { displayName: 'Contoso Dev' });
  setSection(state, 'environment', { publisherPrefix: 'cr8142a' });

  assert.deepEqual(state.sections.environment, {
    displayName: 'Contoso Dev', publisherPrefix: 'cr8142a',
  });
});

test('unknown phases, statuses and sections are rejected by name', () => {
  const state = initState(project('docs-reject'), { appName: 'App' });
  assert.throws(() => applyStep(state, { id: 'nope', status: 'done' }), /Unknown phase 'nope'/);
  assert.throws(() => applyStep(state, { id: 'requirements', status: 'nope' }), /Unknown status 'nope'/);
  assert.throws(() => setSection(state, 'nope', {}), /Unknown section 'nope'/);
  assert.throws(() => setSection(state, 'environment', ['a']), /must be a JSON object/);
  assert.ok(SECTIONS.has('dataModel'));
});

test('captured choices reach the rendered page', () => {
  const root = project('docs-render');
  const state = initState(root, { appName: 'Field Inspections', dataPlatform: 'dataverse' });
  setSection(state, 'environment', { displayName: 'Contoso Dev', publisherPrefix: 'cr8142a' });
  setSection(state, 'dataModel', { mermaid: 'erDiagram\n  A ||--o{ B : has', tables: [{ name: 'cr8142a_inspection', action: 'create' }] });
  save(root, state);

  const html = fs.readFileSync(outputPath(root), 'utf8');
  for (const value of ['Contoso Dev', 'cr8142a_inspection', 'erDiagram', 'tab-datamodel']) {
    assert.ok(html.includes(value), `missing ${value}`);
  }
  assert.doesNotMatch(html, /__[A-Z][A-Z0-9_]*__/, 'no placeholder may survive rendering');
});

test('a hostile note cannot break out of the JSON script block', () => {
  const root = project('docs-xss');
  const state = initState(root, { appName: 'App' });
  applyStep(state, { id: 'requirements', status: 'done', note: '</script><img src=x onerror=alert(1)>' });
  save(root, state);

  const html = fs.readFileSync(outputPath(root), 'utf8');
  assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /u003c\/script/);
});

test('the CLI refuses a step before init and reports the reason', () => {
  const root = project('docs-cli');
  const early = spawnSync(process.execPath, [scriptPath, '--working-dir', root, 'step', '--id', 'requirements', '--status', 'done'], { encoding: 'utf8' });
  assert.equal(early.status, 1);
  assert.match(early.stderr, /run `init` first/);

  spawnSync(process.execPath, [scriptPath, '--working-dir', root, '--app-name', 'App', 'init'], { encoding: 'utf8' });
  const set = spawnSync(process.execPath, [scriptPath, '--working-dir', root, 'set', '--section', 'auth', '--json', '{"status":"skipped"}'], { encoding: 'utf8' });
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout.trim()).section, 'auth');
});

test('edit temp paths are stable, private, and reject redirected namespaces', (t) => {
  const root = project('docs-edit-temp');
  const directory = prepareEditTempDir(root);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(prepareEditTempDir(root), directory, 'separate invocations must reuse the namespace');
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
  if (process.platform !== 'win32') {
    assert.equal(path.basename(path.dirname(directory)), `power-platform-mobile-app-uid-${process.getuid()}`,
      'shared POSIX temp roots need one private parent per user');
    assert.equal(fs.statSync(directory).mode & 0o077, 0, 'project namespace must be owner-only');
    assert.equal(fs.statSync(path.dirname(directory)).mode & 0o077, 0,
      'stable parent namespace must be owner-only');
  }

  const redirectedTarget = project('docs-edit-temp-target');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.symlinkSync(redirectedTarget, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareEditTempDir(root), /Refusing unsafe temporary directory/);
  fs.rmSync(directory, { force: true });
  fs.rmSync(redirectedTarget, { recursive: true, force: true });
});

test('edit progress renders each operation state and settles when work completes', (t) => {
  const root = project('docs-edit-progress');
  t.after(() => fs.rmSync(editTempDir(root), { recursive: true, force: true }));
  const progress = writeEditProgress(root, {
    phase: 'planning',
    note: 'Waiting for your approval',
    waiting: true,
    changes: [
      {
        kind: 'data-model',
        title: 'Add inspection evidence',
        detail: 'Introduce a child table for captured evidence.',
        rationale: 'Evidence needs its own lifecycle and can contain multiple files per inspection.',
        dataModel: {
          tables: [
            {
              name: 'Inspection',
              columns: [{ name: 'inspectionid', type: 'guid', primaryKey: true }],
            },
            {
              name: 'Evidence',
              columns: [
                { name: 'evidenceid', type: 'guid', primaryKey: true },
                { name: 'inspectionid', type: 'guid', foreignKey: true },
              ],
            },
          ],
          relationships: [
            {
              from: 'Inspection',
              to: 'Evidence',
              cardinality: 'one-to-many',
              label: 'contains',
            },
          ],
        },
      },
      {
        kind: 'screen',
        title: 'Add inspection detail',
        detail: 'Introduce a detail route for each inspection.',
        rationale: 'Inspectors need one place to review findings and open captured evidence.',
        screenGraph: {
          screens: [
            { id: 'list', name: 'Inspections', route: '/inspections' },
            { id: 'detail', name: 'Inspection detail', route: '/inspections/[id]' },
          ],
          edges: [{ from: 'list', to: 'detail', label: 'Select inspection' }],
        },
      },
    ],
    items: [
      { id: 'inspect', label: 'Inspect app', status: 'done' },
      { id: 'approve', label: 'Approve changes', status: 'waiting', note: 'Review the plan delta' },
      { id: 'screens', label: 'Update screens', status: 'pending' },
    ],
  });
  assert.ok(fs.existsSync(progress));
  const html = fs.readFileSync(progress, 'utf8');
  assert.match(html, /Mobile app edit plan/);
  assert.match(html, /data-tab="changes"/);
  assert.match(html, /data-tab="steps"/);
  assert.match(html, /Add inspection detail/);
  assert.match(html, /Why this matters:/);
  assert.match(html, /Evidence needs its own lifecycle/);
  assert.match(html, /class="diagram-canvas" role="img" aria-label="Proposed data model diagram"/);
  assert.match(html, /<pre>erDiagram/);
  assert.match(html, /Inspection \|\|--o\{ Evidence : &quot;contains&quot;/);
  assert.match(html, /aria-label="Proposed screen navigation graph"/);
  assert.match(html, /<pre>flowchart LR/);
  assert.match(html, /S_list --&gt;\|&quot;Select inspection&quot;\| S_detail/);
  assert.match(html, /mermaid@11\.17\.2/);
  assert.match(html, /window\.mermaid\.render/);
  assert.doesNotMatch(html, /<pre class="change-diagram">/);
  assert.match(html, /AI-generated content may be incorrect/);
  assert.match(html, /class="device-rail"/);
  assert.match(html, /Waiting for approval/);
  assert.match(html, /The phone preview follows the current edit step/);
  assert.doesNotMatch(html, /Scan to test the changes/);
  assert.match(html, /Waiting for your input/);
  assert.ok(
    html.indexOf('class="input-banner"') < html.indexOf('<div class="shell">'),
    'the pill must sit outside both tab panels so it stays visible on Build steps',
  );
  assert.match(html, /position:fixed;top:calc\(var\(--topbar-h, 65px\) \+ 13px\);right:24px/);
  assert.match(html, /id="inputBannerClose"/);
  assert.match(html, /class="item done" data-item-id="inspect"/);
  assert.match(html, /class="item waiting" data-item-id="approve"/);
  assert.match(html, /1 of 3 operations complete/);
  assert.match(html, /aria-valuenow="33"/);
  assert.match(html, /location\.replace\(fresh\)/);
  assert.match(html, /sessionStorage\.setItem\(STORE_SCROLL/);
  assert.match(html, /sessionStorage\.getItem\(STORE_SCROLL/);
  assert.match(html, /window\.scrollTo\(0, savedScroll\)/);
  assert.match(html, /Waiting for your approval/);

  seeded(root);
  const state = loadState(root);
  setPhone(state, {
    stage: 'qr',
    qrImage: 'data:image/png;base64,iVBORw0KGgo=',
    qrUrl: 'exp://192.168.1.4:8081',
  });
  save(root, state);
  writeEditProgress(root, {
    phase: 'done',
    status: 'done',
    note: 'Edit verified',
    devicePreviewReady: true,
    items: [
      { id: 'inspect', label: 'Inspect app', status: 'done' },
      { id: 'approve', label: 'Approve changes', status: 'done' },
      { id: 'screens', label: 'Update screens', status: 'done' },
    ],
  });
  const completedHtml = fs.readFileSync(progress, 'utf8');
  assert.doesNotMatch(completedHtml, /location\.replace\(fresh\)/);
  assert.match(completedHtml, /sessionStorage\.getItem\(STORE_SCROLL/);
  assert.match(completedHtml, /window\.scrollTo\(0, savedScroll\)/);
  assert.match(completedHtml, /Scan to test the changes/);
  assert.match(completedHtml, /data:image\/png;base64,iVBORw0KGgo=/);
  assert.match(completedHtml, /exp:\/\/192\.168\.1\.4:8081/);
  assert.match(completedHtml, /Edits hot-reload onto the device/);
  assert.doesNotMatch(completedHtml, /pill-phase">done</);

  writeEditProgress(root, {
    phase: 'done',
    status: 'done',
    note: 'Edit verified without a current device preview',
    devicePreviewReady: false,
    items: [
      { id: 'inspect', label: 'Inspect app', status: 'done' },
      { id: 'approve', label: 'Approve changes', status: 'done' },
      { id: 'screens', label: 'Update screens', status: 'done' },
    ],
  });
  const unavailableHtml = fs.readFileSync(progress, 'utf8');
  assert.match(unavailableHtml, /Device preview unavailable/);
  assert.doesNotMatch(unavailableHtml, /Scan to test the changes/);
  assert.doesNotMatch(unavailableHtml, /data:image\/png;base64,iVBORw0KGgo=/);

  assert.ok(EDIT_ITEM_STATUSES.has('waiting'));
  assert.throws(() => writeEditProgress(root, {
    items: [{ id: 'inspect', label: 'Inspect app', status: 'unknown' }],
  }), /Unknown progress item status/);
  assert.throws(() => writeEditProgress(root, {
    status: 'pending',
    items: [{ id: 'inspect', label: 'Inspect app', status: 'pending' }],
  }), /Unknown edit progress status/);
  assert.throws(() => writeEditProgress(root, {
    changes: [{ detail: 'Missing title' }],
  }), /requires a title/);
  assert.throws(() => writeEditProgress(root, {
    changes: [{ title: 'Missing rationale', kind: 'general' }],
  }), /requires a rationale/);
  assert.throws(() => writeEditProgress(root, {
    changes: [{
      title: 'Disconnected screens',
      rationale: 'Add a detail route.',
      kind: 'screen',
      screenGraph: {
        screens: [{ id: 'list', name: 'List' }, { id: 'detail', name: 'Detail' }],
        edges: [],
      },
    }],
  }), /requires navigation edges/);
  assert.throws(() => writeEditProgress(root, {
    changes: [{
      title: 'Raw diagram',
      rationale: 'Structured data must remain the source of truth.',
      kind: 'screen',
      mermaid: 'flowchart LR\nA --> B',
      screenGraph: {
        screens: [{ id: 'a', name: 'A' }],
      },
    }],
  }), /cannot carry raw diagram or Mermaid source/);
  for (const cardinality of ['constructor', '__proto__']) {
    assert.throws(() => writeEditProgress(root, {
      changes: [{
        title: 'Invalid relationship',
        rationale: 'Only allowlisted relationship shapes can render.',
        kind: 'data-model',
        dataModel: {
          tables: [{ name: 'A' }, { name: 'B' }],
          relationships: [{ from: 'A', to: 'B', cardinality }],
        },
      }],
    }), /Unknown data-model relationship cardinality/);
  }
  assert.throws(() => writeEditProgress(root, {
    changes: [{
      title: 'Nested raw diagram',
      rationale: 'Structured data must remain the source of truth.',
      kind: 'data-model',
      dataModel: {
        mermaid: 'erDiagram\nA ||--o{ B : contains',
        tables: [{ name: 'A' }],
      },
    }],
  }), /cannot carry raw diagram or Mermaid source/);
});

test('coarse progress follows the top-level phase when rows are omitted', (t) => {
  const root = project('docs-coarse-phase');
  t.after(() => fs.rmSync(editTempDir(root), { recursive: true, force: true }));

  const progress = writeEditProgress(root, {
    phase: 'approval',
    status: 'waiting',
    waiting: true,
    note: 'Waiting for approval of the proposed changes.',
  });
  const html = fs.readFileSync(progress, 'utf8');

  assert.match(html, /class="item done" data-item-id="inspect"/);
  assert.match(html, /class="item waiting" data-item-id="plan"/);
  assert.doesNotMatch(html, /class="item active" data-item-id="inspect"/);
  assert.match(html, /1 of 5 operations complete/);
});

test('failed fallback progress marks the failed phase and skips later phases', (t) => {
  const root = project('docs-coarse-failed');
  t.after(() => fs.rmSync(editTempDir(root), { recursive: true, force: true }));

  const progress = writeEditProgress(root, {
    phase: 'verification',
    status: 'failed',
    note: 'Verification failed.',
  });
  const html = fs.readFileSync(progress, 'utf8');

  assert.match(html, /class="item done" data-item-id="inspect"/);
  assert.match(html, /class="item done" data-item-id="plan"/);
  assert.match(html, /class="item done" data-item-id="apply"/);
  assert.match(html, /class="item failed" data-item-id="verify"/);
  assert.match(html, /class="item skipped" data-item-id="preview"/);
  assert.doesNotMatch(html, /class="item active" data-item-id="inspect"/);
});

test('explicit coarse progress preserves skipped operations', (t) => {
  const root = project('docs-explicit-coarse');
  t.after(() => fs.rmSync(editTempDir(root), { recursive: true, force: true }));
  const progress = writeEditProgress(root, {
    phase: 'verification',
    status: 'active',
    items: [
      { id: 'inspect', label: 'Inspect', status: 'done' },
      { id: 'plan', label: 'Plan', status: 'done' },
      { id: 'apply', label: 'Apply', status: 'skipped' },
      { id: 'verify', label: 'Verify', status: 'active' },
      { id: 'preview', label: 'Preview', status: 'skipped' },
    ],
  });
  const html = fs.readFileSync(progress, 'utf8');

  assert.match(html, /class="item skipped" data-item-id="apply"/);
  assert.match(html, /class="item active" data-item-id="verify"/);
  assert.match(html, /class="item skipped" data-item-id="preview"/);
  assert.doesNotMatch(html, /class="item done" data-item-id="apply"/);
});

test('the device preview follows the active checklist operation', (t) => {
  const root = project('docs-device-phase');
  t.after(() => fs.rmSync(editTempDir(root), { recursive: true, force: true }));

  const progress = writeEditProgress(root, {
    phase: 'preview',
    status: 'active',
    items: [
      { id: 'inspect', label: 'Inspect the current app', status: 'done' },
      { id: 'plan', label: 'Plan the requested changes', status: 'done' },
      { id: 'apply', label: 'Apply the approved changes', status: 'done' },
      { id: 'verify', label: 'Verify the edited app', status: 'done' },
      { id: 'preview', label: 'Refresh the preview and app plan', status: 'active' },
    ],
  });
  const html = fs.readFileSync(progress, 'utf8');

  assert.match(html, /Refreshing your preview/);
  assert.match(html, /The live preview and app plan are being updated/);
  assert.doesNotMatch(html, /Applying your changes/);
});

test('edit progress embeds preview screens and links to the full HTML', (t) => {
  const root = project('docs-device-screens');
  t.after(() => fs.rmSync(editTempDir(root), { recursive: true, force: true }));
  const preview = '<!doctype html><html><head><style>.screen{display:none}</style></head>'
    + '<body><button data-screen="screen-home">Home</button>'
    + '<div class="phone"><div class="screen" id="screen-home">Home screen</div></div></body></html>';
  fs.writeFileSync(path.join(root, 'preview.html'), preview);
  const state = initState(root, { appName: 'Field Readings' });
  save(root, setPhone(state, {
    stage: 'screens',
    previewHtml: preview,
    previewHref: '../preview.html',
  }));

  const progress = writeEditProgress(root, {
    phase: 'preview',
    status: 'active',
  });
  const html = fs.readFileSync(progress, 'utf8');

  assert.match(html, /id="devicePreviewFrame"/);
  assert.match(html, /var phonePreviewHtml = /);
  assert.match(html, /Home screen/);
  assert.match(html, /Open screens full size/);
  assert.match(html, /file:\/\/.*preview\.html/);
  assert.match(html, /id="previousScreen"/);
  assert.doesNotMatch(html, /Scan to test the changes/);
});

test('embedded preview skips the untouched starter home when real screens exist', (t) => {
  const root = project('docs-preview-starter-home');
  t.after(() => fs.rmSync(editTempDir(root), { recursive: true, force: true }));
  seeded(root);
  const state = loadState(root);
  setPhone(state, {
    stage: 'screens',
    previewHtml: '<div class="screen" id="screen-home">'
      + '<h1>Power Apps Standalone</h1>'
      + '<p>Build your first screen by connecting data sources</p></div>'
      + '<div class="screen" id="screen-readings"><h1>Field Readings</h1></div>',
  });
  save(root, state);

  const progress = writeEditProgress(root, {
    phase: 'preview',
    status: 'active',
    items: [
      { id: 'inspect', label: 'Inspect', status: 'done' },
      { id: 'plan', label: 'Plan', status: 'done' },
      { id: 'apply', label: 'Apply', status: 'done' },
      { id: 'verify', label: 'Verify', status: 'done' },
      { id: 'preview', label: 'Preview', status: 'active' },
    ],
  });
  const html = fs.readFileSync(progress, 'utf8');

  assert.match(html, /var appScreens = screens\.filter/);
  assert.match(html, /Build your first screen by connecting data sources/);
  assert.match(html, /if \(appScreens\.length\) screens = appScreens/);
});

test('the final QR replaces embedded screens and adds mobile app downloads', (t) => {
  const root = project('docs-device-qr');
  t.after(() => fs.rmSync(editTempDir(root), { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.expo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'preview.html'), '<div class="screen">Preview</div>');
  fs.writeFileSync(path.join(root, '.expo', 'metro-qr.png'), 'qr');
  const state = initState(root, { appName: 'Field Readings' });
  setPhone(state, {
    stage: 'screens',
    previewHtml: '<div class="screen">Preview</div>',
    previewHref: '../preview.html',
  });
  setPhone(state, {
    stage: 'qr',
    qrImage: 'data:image/png;base64,aW1hZ2U=',
    qrHref: '../.expo/metro-qr.png',
    qrUrl: 'exp://192.0.2.1:8081',
  });
  save(root, state);

  const progress = writeEditProgress(root, {
    phase: 'done',
    status: 'done',
    devicePreviewReady: true,
  });
  const html = fs.readFileSync(progress, 'utf8');

  assert.match(html, /Scan to test the changes/);
  assert.doesNotMatch(html, /id="devicePreviewFrame"/);
  assert.match(html, /Open screens full size/);
  assert.match(html, /Open QR code full size/);
  assert.match(html, /Download Power Apps Mobile Preview/);
  assert.match(html, /App Store/);
  assert.match(html, /Google Play/);
  assert.match(html, /5 of 5 operations complete/);
});

test('screen diagram labels keep Expo dynamic route segments', () => {
  // Expo file-based routing names dynamic segments `[id]`, so these brackets are the
  // common case in a screen graph rather than an edge case. Dropping them rewrote the
  // route the maker reads (`/inspections/[id]` became `/inspections/ id`), so the
  // characters are escaped with Mermaid entity codes and must survive to the source.
  const root = project('docs-edit-routes');
  const progress = writeEditProgress(root, {
    changes: [{
      title: 'Add the inspection detail route',
      rationale: 'Inspectors open one record before capturing evidence against it.',
      kind: 'screen',
      screenGraph: {
        screens: [
          { id: 'list', name: 'Inspections', route: '/inspections' },
          { id: 'detail', name: 'Inspection detail', route: '/inspections/[id]' },
        ],
        edges: [{ from: 'list', to: 'detail', label: 'select {row}' }],
      },
    }],
  });
  const html = fs.readFileSync(progress, 'utf8');
  assert.match(html, /\/inspections\/#91;id#93;/);
  assert.match(html, /select #123;row#125;/);
  assert.doesNotMatch(html, /\/inspections\/ id/);
});

test('data-model diagrams do not invent columns when schema details are unknown', () => {
  const root = project('docs-data-model-unknown-columns');
  const progress = writeEditProgress(root, {
    changes: [{
      kind: 'data-model',
      title: 'Reuse account data',
      rationale: 'Use the existing account table.',
      dataModel: {
        tables: [{ logicalName: 'account' }],
      },
    }],
  });
  const html = fs.readFileSync(progress, 'utf8');

  assert.match(html, /account \{\n\n  \}/);
  assert.doesNotMatch(html, /string id PK/);
});

test('diagram node IDs remain distinct when normalized names collide', () => {
  const root = project('docs-edit-id-collisions');
  const progress = writeEditProgress(root, {
    changes: [
      {
        title: 'Connect colliding routes',
        rationale: 'Both routes must remain visible as separate screens.',
        kind: 'screen',
        screenGraph: {
          screens: [
            { name: 'Hyphen route', route: '/a-b' },
            { name: 'Slash route', route: '/a/b' },
          ],
          edges: [{ from: '/a-b', to: '/a/b' }],
        },
      },
      {
        title: 'Relate colliding table names',
        rationale: 'Both tables must remain visible as separate entities.',
        kind: 'data-model',
        dataModel: {
          tables: [{ name: 'a-b' }, { name: 'a/b' }],
          relationships: [{ from: 'a-b', to: 'a/b', cardinality: 'one-to-many' }],
        },
      },
    ],
  });
  const html = fs.readFileSync(progress, 'utf8');
  assert.match(html, /S__a_b\[&quot;Hyphen route · \/a-b&quot;\]/);
  assert.match(html, /S__a_b_2\[&quot;Slash route · \/a\/b&quot;\]/);
  assert.match(html, /S__a_b --&gt; S__a_b_2/);
  assert.match(html, /a_b \{/);
  assert.match(html, /a_b_2 \{/);
  assert.match(html, /a_b \|\|--o\{ a_b_2/);
});

test('edit progress is published atomically for the auto-refreshing browser', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /publishAtomic\(filePath, html\);/);
  assert.doesNotMatch(source, /fs\.writeFileSync\(filePath, html/);
});

test('plan sync creates an inferred full snapshot and replaces changed sections', () => {
  const root = project('docs-edit-sync');
  const inferred = syncPlanToCurrentApp(root, {
    appName: 'Survey app',
    dataPlatform: 'dataverse',
    summary: 'Plan inferred from existing app state because no prior create-run plan was present.',
    sections: {
      architecture: {
        dataPlatform: 'dataverse',
        nativeCapabilities: [{ name: 'camera', reason: 'Capture evidence' }],
        connectors: [{ name: 'Office 365 Users', reason: 'Resolve inspectors' }],
      },
      dataModel: { tables: [{ logicalName: 'contoso_survey', status: 'reuse' }] },
      screens: { navigation: 'tabs', list: [{ name: 'Surveys', route: '/surveys' }] },
      design: { direction: 'Field utility', palette: [] },
    },
  });
  assert.equal(inferred, outputPath(root));
  const state = loadState(root);
  assert.equal(state.sections.requirements.source, 'existing app state');
  assert.equal(state.sectionStates.requirements, 'approved');
  assert.equal(state.sections.architecture.connectors[0].name, 'Office 365 Users');
  assert.equal(state.sections.dataModel.tables[0].logicalName, 'contoso_survey');
  assert.equal(state.sections.screens.list[0].route, '/surveys');
  assert.equal(summarize(state).percent, 100, 'an imported existing app must not look unbuilt');

  syncPlanToCurrentApp(root, {
    summary: 'Replaced the surveys screen with survey detail.',
    sections: {
      screens: { navigation: 'stack', list: [{ name: 'Survey detail', route: '/surveys/[id]' }] },
    },
  });
  const updated = loadState(root);
  assert.deepEqual(updated.sections.screens.list, [
    { name: 'Survey detail', route: '/surveys/[id]' },
  ]);
  assert.equal(updated.sections.architecture.connectors[0].name, 'Office 365 Users',
    'unsupplied sections must remain intact');
  assert.deepEqual(updated.lastEdit.sections, ['screens']);

  const empty = project('docs-edit-sync-empty');
  assert.throws(() => syncPlanToCurrentApp(empty, { summary: 'Generic shell' }),
    /requires structured current-app sections/);
});

test('edit progress and plan sync CLI commands consume JSON files', (t) => {
  const root = project('docs-edit-cli');
  t.after(() => fs.rmSync(editTempDir(root), { recursive: true, force: true }));
  const progressPayload = path.join(root, 'progress.json');
  fs.writeFileSync(progressPayload, JSON.stringify({
    phase: 'verifying',
    status: 'active',
    note: 'Running TypeScript',
    items: [{ id: 'verify', label: 'Verify app', status: 'active' }],
  }));
  const progress = spawnSync(process.execPath, [
    scriptPath, '--working-dir', root, 'progress', '--json-file', progressPayload,
  ], { encoding: 'utf8' });
  assert.equal(progress.status, 0, progress.stderr);
  assert.match(fs.readFileSync(path.join(editTempDir(root), 'edit-app-progress.html'), 'utf8'),
    /Running TypeScript/);

  const syncPayload = path.join(root, 'sync.json');
  fs.writeFileSync(syncPayload, JSON.stringify({
    appName: 'Imported app',
    dataPlatform: 'connector-only',
    sections: {
      architecture: {
        dataPlatform: 'connector-only',
        nativeCapabilities: [],
        connectors: [{ name: 'SharePoint', reason: 'Existing list data' }],
      },
      screens: { navigation: 'tabs', list: [{ name: 'Home', route: '/' }] },
    },
  }));
  const sync = spawnSync(process.execPath, [
    scriptPath, '--working-dir', root, 'sync', '--json-file', syncPayload,
  ], { encoding: 'utf8' });
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(loadState(root).sections.architecture.connectors[0].name, 'SharePoint');
});

test('edit-app wires progress, imported-app inference, and final plan sync into the workflow', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'edit-app', 'SKILL.md'), 'utf8',
  ).replace(/\r\n/g, '\n');
  const previewSkill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'preview-screens', 'SKILL.md'), 'utf8',
  ).replace(/\r\n/g, '\n');
  assert.match(skill, /progress \\\n\s+--json-file '<edit-temp-dir>\/edit-app-progress\.json'/);
  assert.match(skill, /--working-dir '<working_dir>' temp/);
  assert.match(skill, /user's OS temp directory/);
  assert.match(skill, /top-level `changes` array/);
  assert.match(skill, /every entry requires `kind`, `title`, `rationale`/);
  assert.match(skill, /"dataModel": \{/);
  assert.match(skill, /"screenGraph": \{/);
  assert.match(skill, /Do not hand-author Mermaid source/);
  assert.match(skill, /validated normalized contract[\s\S]*updated screen graph/);
  assert.match(skill, /Do not open or focus it during `\/edit-app`/);
  assert.match(skill, /Claim the plan was updated only when the final sync succeeded/);
  assert.match(skill, /living plan refresh failed and include that concern/);
  assert.match(skill, /set `approve: waiting`/i);
  assert.match(skill, /set `verify: active`/i);
  assert.match(skill, /`sync-plan: active`/);
  assert.match(skill, /Inferred current-state baseline/);
  assert.match(skill, /routes\/layouts[\s\S]*generated[\s\S]*src\/native\/[\s\S]*brand\/token/);
  const step4 = skill.slice(skill.indexOf('### Step 4'), skill.indexOf('### Step 5'));
  assert.doesNotMatch(step4, /app-docs\.js sync --json-file/);
  assert.match(step4, /keep `docs\/create-app-plan\.html` unchanged until Step 8 verifies/);
  assert.match(skill, /Step 8[\s\S]*scripts\/app-docs\.js" --working-dir '<working_dir>' sync/);
  assert.match(skill, /\/create-mobile-app` Step 12/);
  assert.match(skill, /MOBILE_APP_ORCHESTRATING=1/);
  assert.match(skill, /MOBILE_APP_EMBED_PREVIEW=1/);
  assert.match(previewSkill, /\| `MOBILE_APP_EMBED_PREVIEW=1` \| Print the link and stop/);
  assert.doesNotMatch(previewSkill, /\| `MOBILE_APP_ORCHESTRATING=1` \|/);
  assert.match(previewSkill, /untouched template `app\/\(app\)\/home\.tsx`/);
  assert.match(previewSkill, /Keep it when it is the only visible screen/);
  assert.match(skill, /phone --stage screens[\s\S]*--preview-file '<working_dir>\/preview\.html'/);
  assert.match(skill, /without opening a separate browser page/);
  assert.match(skill, /phone --stage qr/);
  assert.match(skill, /replaces the screen carousel with the same QR code/);
  assert.match(skill, /App Store and Google Play/);
  assert.match(skill, /Run the final\s+`progress` write with `devicePreviewReady: true` after this command succeeds/);
  assert.doesNotMatch(skill, /If `native-app-plan\.md` is missing → STOP/);
  assert.match(skill, /devicePreviewReady: false[\s\S]*earlier run/);
  assert.match(skill, /`--plan-only`[\s\S]*mark `save-plan: done`[\s\S]*publish one final progress/);
  assert.match(skill, /Keep `docs\/create-app-plan\.html` unchanged because it describes the current app/);
  assert.match(skill, /Every branch that ends the workflow must publish a terminal progress write/);
  assert.match(skill, /configuration-only request[\s\S]*`configure-insights` checklist row/);
  assert.match(skill, /planning-phase handoff[\s\S]*validated proposal was returned to the owning workflow/);
  assert.match(skill, /When exactly one session is live, reuse it/);
  assert.match(skill, /do not run `npm run dev`/);
  assert.match(skill, /When several sessions are live[\s\S]*Do not start another server/);
  const tempAllocation = skill.indexOf('Immediately run the edit documentation protocol');
  const inferredPlanSync = skill.indexOf('Create `<edit-temp-dir>/app-plan-sync.json`');
  assert.ok(tempAllocation > -1 && tempAllocation < inferredPlanSync);
  assert.ok(step4.indexOf('If this is `--plan-only`') < step4.indexOf('For an implementation run'),
    'plan-only must return before implementation work begins');
});

test('the phone CLI carries the full preview, including shared CSS, without rewriting screens', (t) => {
  const root = project('docs-phone-preview');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seeded(root);
  const preview = '<!doctype html><html><head><style>:root{--brand:#0078d4}.card{display:flex}</style>'
    + '</head><body><div class="screen" id="products">Products</div>'
    + '<div class="screen" id="detail">Detail</div></body></html>';
  const previewPath = path.join(root, 'preview.html');
  fs.writeFileSync(previewPath, preview);
  const result = spawnSync(process.execPath, [
    scriptPath, '--working-dir', root, 'phone', '--stage', 'screens', '--preview-file', previewPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadState(root).phone.previewHtml, preview);
  assert.equal(loadState(root).phone.previewHref, '../preview.html');
  const html = fs.readFileSync(outputPath(root), 'utf8');
  const phone = JSON.parse(html.match(/<script id="phoneData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(phone.previewHtml, preview);
  assert.equal(phone.previewHref, '../preview.html');
});

test('replacing a full preview with legacy screens cannot leave stale markup selected', (t) => {
  const root = project('docs-phone-source');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = initState(root, { appName: 'Screens' });
  const screens = [{ name: 'Products', html: '<div>Products</div>' }];
  setPhone(state, { stage: 'screens', previewHtml: '<div class="screen">Old</div>' });
  setPhone(state, { screens });
  assert.equal(state.phone.previewHtml, undefined);
  assert.deepEqual(state.phone.screens, screens);
  setPhone(state, { previewHtml: '<div class="screen">New</div>' });
  assert.deepEqual(state.phone.screens, []);
  assert.match(state.phone.previewHtml, /New/);
});

test('the phone CLI rejects conflicting or empty preview inputs without changing the plan', (t) => {
  const root = project('docs-phone-input');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seeded(root);
  const previewPath = path.join(root, '_plan_preview.html');
  fs.writeFileSync(previewPath, ' \n');
  const previous = loadState(root);
  const run = (...args) => spawnSync(process.execPath, [
    scriptPath, '--working-dir', root, 'phone', '--stage', 'screens', ...args,
  ], { encoding: 'utf8' });
  const empty = run('--preview-file', previewPath);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /preview HTML is empty/);
  const conflicting = run('--preview-file', previewPath, '--screens-file', 'unused.json');
  assert.equal(conflicting.status, 1);
  assert.match(conflicting.stderr, /not both/);
  const missing = run('--preview-file');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires an HTML file path/);
  assert.deepEqual(loadState(root), previous);
});

test('the data model tab carries the power-pages colour vocabulary', () => {
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8',
  );
  // Same three-state legend power-pages uses, so a reader moving between the two plugins
  // reads the same colours: new = accent blue, extended = warn orange, reused = pass green.
  for (const marker of [
    'status-new', 'status-modified', 'status-reused',
    'key-PK', 'key-FK', 'type-chip', 'col-table',
    'er-legend', 'erCompactBtn',
  ]) {
    assert.ok(template.includes(marker), `missing ${marker}`);
  }
  assert.match(template, /#0078d4/);
  assert.match(template, /#ca5010/);
  assert.match(template, /#107c10/);
});

test('erDiagram source strips characters that would abort the mermaid parse', () => {
  const root = project('docs-er');
  const state = initState(root, { appName: 'App' });
  // "Yes/No" is a real Dataverse type name and its slash is invalid in an ATTRIBUTE_WORD;
  // one bad column must not blank the whole diagram.
  setSection(state, 'dataModel', {
    tables: [{
      logicalName: 'cr8142a_inspection',
      status: 'new',
      columns: [{ logicalName: 'cr8142a_flag', type: 'Yes/No', key: 'PK' }],
    }],
  });
  save(root, state);

  const html = fs.readFileSync(outputPath(root), 'utf8');
  // The raw value still appears in the data block; the sanitiser runs at diagram build time.
  assert.match(html, /Yes\/No/);
  assert.match(html, /replace\(\/\[\^A-Za-z0-9_\]\/g, '_'\)/);
});

test('table action verbs from the plan map onto the three visual states', () => {
  const root = project('docs-alias');
  const state = initState(root, { appName: 'App' });
  setSection(state, 'dataModel', {
    tables: [
      { logicalName: 'a', action: 'create' },
      { logicalName: 'b', action: 'reuse' },
      { logicalName: 'c', action: 'extend' },
    ],
  });
  save(root, state);
  const html = fs.readFileSync(outputPath(root), 'utf8');
  // native-app-plan.md says create/reuse/extend; the page says new/reused/modified.
  assert.match(html, /STATUS_ALIAS/);
  assert.match(html, /create: 'new'/);
  assert.match(html, /extend: 'modified'/);
  assert.match(html, /reuse: 'reused'/);
});

test('nav icons come from blocks that actually render', () => {
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8',
  );
  const icons = [...template.matchAll(/<span class="nav-icon">&#(\d+);<\/span>/g)].map((m) => Number(m[1]));
  assert.ok(icons.length >= 6, 'every tab needs an icon');

  // U+2610 BALLOT BOX and U+2637 TRIGRAM FOR EARTH shipped once and rendered as a missing
  // glyph in common Segoe UI stacks. Keep icons inside Geometric Shapes (U+25A0-U+25FF) or
  // the Dingbats/Misc-Symbols characters already proven in the power-pages plans.
  const PROVEN = new Set([0x2600, 0x270E]);
  for (const code of icons) {
    const geometric = code >= 0x25a0 && code <= 0x25ff;
    assert.ok(geometric || PROVEN.has(code), `U+${code.toString(16).toUpperCase()} is not a proven glyph`);
  }
  assert.equal(icons.includes(0x2610), false, 'BALLOT BOX does not render');
  assert.equal(icons.includes(0x2637), false, 'TRIGRAM FOR EARTH does not render');
});

test('an ordinary question raises the banner, not just an approval gate', () => {
  const root = project('docs-waiting');
  const state = initState(root, { appName: 'App' });

  // The first real prompt is the Step 2b setup questions, long before any section is proposed.
  // Matching only /awaiting/ missed it, so the page looked busy while the run was blocked.
  applyStep(state, { id: 'requirements', status: 'active', note: 'Waiting for your answers to the setup questions' });
  assert.equal(summarize(state).awaitingInput, 'Waiting for your answers to the setup questions');

  // A gate's own wording still works.
  applyStep(state, { id: 'architecture', status: 'active', note: 'Gate 1 — awaiting your approval' });
  assert.match(summarize(state).awaitingInput, /awaiting your approval/);

  // Answering clears it, because the note does not outlive its status.
  applyStep(state, { id: 'architecture', status: 'done' });
  assert.equal(summarize(state).awaitingInput, '');

  // An active phase that is merely working must not raise it.
  applyStep(state, { id: 'screens', status: 'active', note: '3 of 12 screens built' });
  assert.equal(summarize(state).awaitingInput, '');
});

test('the skill flags the run as blocked before its first question', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  const open = skill.match(/step --id requirements --status active([^\n]*)/);
  assert.ok(open, 'the requirements phase must be opened');
  assert.match(open[1], /--note "Waiting for your answers/,
    'the first prompt must raise the waiting banner');
});

test('a failed run says so, because that is the last thing the page will ever show', () => {
  const root = project('docs-failed');
  const state = initState(root, { appName: 'Field App' });
  applyStep(state, { id: 'scaffold', status: 'failed' });

  // A failure sets `settled`, which stops the self-refresh - so whatever the page says at that
  // moment is what the user is left looking at. It used to read "Waiting to start" and
  // "Preparing to build", hiding the failure exactly when refreshes stopped.
  const summary = summarize(state);
  assert.equal(summary.failed, 1);
  assert.equal(summary.settled, true);
  assert.match(summary.currentTitle, /^Stopped — /);
  assert.match(summary.currentTitle, /Bring the app online/);
  assert.match(summary.narrative, /stopped during "Bring the app online"\./);
  assert.doesNotMatch(summary.narrative, /Preparing to build/);
});

test('the narrative names the live phase without bending its title into a sentence', () => {
  const root = project('docs-narrative');
  const state = applyStep(initState(root, { appName: 'App' }), { id: 'data-model', status: 'active' });
  assert.equal(summarize(state).narrative, 'In progress: Design the data model. Tables, columns, and relationships.');
});

test('the topbar shows the approved data platform, not the placeholder init was given', () => {
  const root = project('docs-platform');
  let state = initState(root, { appName: 'App', dataPlatform: 'unknown' });
  // `init` runs at Step 2b, before the platform is chosen, and nothing updates the top-level
  // value - so the pill read "Data: unknown" for the whole run. Before Gate 1 it says so in words.
  save(root, state);
  let html = fs.readFileSync(outputPath(root), 'utf8');
  assert.match(html, /Data: not decided yet/);

  state = setSection(state, 'architecture', { dataPlatform: 'Dataverse + connectors' }, 'approved');
  save(root, state);
  html = fs.readFileSync(outputPath(root), 'utf8');
  assert.match(html, /Data: Dataverse \+ connectors/);
  assert.doesNotMatch(html, /Data: unknown/);
});

test('a section nobody is asked to approve does not raise the waiting banner', () => {
  const root = project('docs-trust-banner');
  let state = initState(root, { appName: 'App' });
  // `trust` is written `proposed` at Gate 1 and only finalised at Step 10, but no gate asks the
  // user to answer for it. Treating it as a gate held the banner up for most of the run.
  state = setSection(state, 'trust', { permissions: [] }, 'proposed');
  assert.equal(summarize(state).awaitingInput, '');

  // A section that really is a gate still raises it.
  state = setSection(state, 'dataModel', { tables: [] }, 'proposed');
  assert.match(summarize(state).awaitingInput, /Review the data model/);
});

test('the skill records creation failures without mutating routing exits', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );

  // `failed` settles the page, which stops the self-refresh. Listing the value without ever
  // issuing it left the last phase `active`, so a terminal STOP produced a plan that reloaded
  // forever reporting work in progress on a run that had ended.
  assert.match(skill, /step --id <phase> --status failed/);
  assert.match(skill, /Mark the active creation phase `failed` before stopping on a creation error/);
  assert.match(skill, /Step 0 routing exits leave existing creation history untouched/);

  // And nothing may switch the protocol off: the plan is how an abandoned run explains itself.
  assert.doesNotMatch(skill, /Skip the protocol entirely when/);
  assert.match(skill, /No argument switches this protocol off/);
});

test('an editor link survives a path containing ?, # or %', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-url-#1 100% Done-'));
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), '# plan\n');
  save(root, initState(root, { appName: 'App' }));

  const summary = JSON.parse(
    fs.readFileSync(outputPath(root), 'utf8')
      .match(/<script id="summaryData" type="application\/json">([\s\S]*?)<\/script>/)[1],
  );

  // encodeURI keeps `/` as a separator but leaves `?` and `#` alone, and both are legal in a
  // POSIX path. Unescaped, `/tmp/app#1/plan.md` parses as pathname `/tmp/app` with the rest a
  // fragment, so the editor opens nothing.
  assert.doesNotMatch(summary.planDocEditorHref, /#(?!23)/, 'a # must be percent-encoded');
  const pathname = new URL(summary.planDocEditorHref).pathname;
  assert.match(pathname, /native-app-plan\.md$/, 'the whole path must survive into the URL');

  // A literal `%` starts an escape, so `100% Done` would be an invalid sequence if it were left
  // alone. Decoding must give back exactly the path on disk, in the forward-slashed, rooted form
  // the VS Code URL handler expects.
  assert.match(summary.planDocEditorHref, /100%25%20Done/, 'a literal % must be percent-encoded');
  const onDisk = path.join(root, 'native-app-plan.md').replace(/\\/g, '/');
  assert.equal(decodeURIComponent(pathname), onDisk.startsWith('/') ? onDisk : `/${onDisk}`);
});

test('the skill records a skipped design step instead of leaving it open', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  const design = skill.slice(skill.indexOf('### Step 6.75'), skill.indexOf('### Step 7 '));

  // `--no-design` returns before the `done` call. Opening the phase on that branch left it
  // active through auth and most of Step 8, until opening the next phase auto-closed it as
  // done - reporting a design system that was never built.
  const skipAt = design.indexOf('step --id design --status skipped');
  const openAt = design.indexOf('step --id design --status active');
  assert.ok(skipAt !== -1, 'the skip branch must record itself');
  assert.ok(openAt !== -1, 'the real path must open the phase');
  assert.ok(skipAt < openAt, 'the skip branch comes first, so the phase is only opened when used');
});

test('nested skills are handed the orchestration flag, not just told about it', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  // `/design-system` and its style picker gate every browser opener on this variable. Asserting
  // it was set without passing it made those guards dead code: the nested skill saw a standalone
  // run and opened tabs over the build plan anyway.
  const invocation = skill.slice(skill.indexOf('Invoke skill: /design-system'));
  const block = invocation.slice(0, invocation.indexOf('```'));
  assert.match(block, /Environment:\s*\n\s*CODE_APPS_NATIVE_ORCHESTRATING=1/,
    'the invocation must pass the flag the guards read');
});

test('a section still proposed between two gates does not read as a question', () => {
  const root = project('docs-between-gates');
  const state = initState(root, { appName: 'Field Readings' });

  // `screens` is proposed at Gate 3 and stays proposed until Step 3.9, because one section
  // covers both gates. Between Gate 3's approval and Gate 4 the plan therefore showed "Review
  // the screen plan, then answer in your terminal" while the planner was busy writing specs and
  // nobody had been asked anything.
  setSection(state, 'screens', { list: [] }, 'proposed');

  applyStep(state, { id: 'screen-plan', status: 'active', note: 'Gate 3 — awaiting your approval' });
  assert.match(summarize(state).awaitingInput, /awaiting your approval/);

  applyStep(state, { id: 'screen-plan', status: 'active', note: 'Gate 3 approved — writing per-screen specs' });
  assert.equal(summarize(state).awaitingInput, '', 'a progress note means the run is working, not waiting');

  applyStep(state, { id: 'screen-plan', status: 'active', note: 'Gate 4 — awaiting your approval of the screen specs' });
  assert.match(summarize(state).awaitingInput, /Gate 4/);
});

test('a gate that forgets its note is still not silent', () => {
  const root = project('docs-gate-no-note');
  const state = initState(root, { appName: 'App' });
  // The note is the authority, but a proposed section with nothing said about it is the safety
  // net - otherwise a skill that proposes a section and omits the note blocks in silence.
  setSection(state, 'dataModel', { tables: [] }, 'proposed');
  applyStep(state, { id: 'data-model', status: 'active' });
  assert.match(summarize(state).awaitingInput, /Review the data model/);
});

test('every step that blocks on the user says so in the plan', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  const lines = skill.split('\n');

  const headings = [];
  lines.forEach((line, i) => {
    const m = /^### Step ([0-9a-z.]+) /.exec(line);
    if (m) headings.push([i, m[1]]);
  });
  const stepAt = (i) => {
    let name = '(preamble)';
    for (const [pos, id] of headings) {
      if (pos <= i) name = id; else break;
    }
    return name;
  };

  // Derived from the skill, not listed here. A hard-coded list is what let Step 7 ship asking
  // for an app registration with no phase open at all - the plan showed nothing in progress
  // while the run was blocked, and the test passed because 7 was not on the list.
  const asks = new Set();
  const raises = new Set();
  lines.forEach((line, i) => {
    if (line.includes('AskUserQuestion')) asks.add(stepAt(i));
    if (/--status active[^\n]*--note "[^"]*(?:[Ww]aiting for|awaiting)/.test(line)) raises.add(stepAt(i));
  });
  asks.delete('(preamble)');

  // Step 2 asks before `init` runs at Step 2b, so there is no plan to raise a banner on.
  const EXEMPT = new Set(['2']);
  const silent = [...asks].filter((step) => !raises.has(step) && !EXEMPT.has(step)).sort();
  assert.deepEqual(silent, [], 'these steps ask the user but never raise the waiting banner');

  // The exemption must stay true: the plan is created at 2b.
  assert.match(skill, /### Step 2b[\s\S]{0,1200}init --json-file/, 'the plan is created at Step 2b');

  // Step 3 counts as raising through one generic call, so every gate must be in the table that
  // call is applied to. Step 3 opened on "Planning — approval gates ahead" with no gate ever
  // raising its own note, which also suppressed the proposed-section fallback for all four.
  for (const [gate, id] of [['1', 'architecture'], ['2', 'data-model'], ['3', 'screen-plan'], ['4', 'screen-plan']]) {
    assert.match(skill, new RegExp(`^\\| ${gate} - [^|]+\\| \`${id}\` \\|`, 'm'), `Gate ${gate} has no row in the gate table`);
  }

  // Step 13's menu is not a gate. The build has finished and the plan has settled, so
  // re-opening a phase there would restart the reload loop.
  assert.ok(!raises.has('13'), 'the closing menu must not re-open a phase');
  assert.match(skill, /Do \*\*not\*\* re-open the `run` phase/);
});

test('each phase opens before its first step does any work', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  const lines = skill.split('\n');

  // With no phase open the plan reads "Waiting to start". Step 8 opened `dataverse` only after
  // its tables were created, and `screens` opened at the end of the first wave in Step 11 - so
  // the two longest stretches of the run showed nothing in progress.
  // Step 2 runs before the plan exists, so requirements opens at 2b. The gate phases are opened
  // by Step 3's gate table, which the blocking-step test checks.
  const OPENED_AT = { requirements: '2b' };
  for (const phase of PHASES) {
    if (/Gate/.test(phase.skillSteps)) continue;
    const step = OPENED_AT[phase.id] || phase.skillSteps.split(/[,\s]+/)[0];
    const start = lines.findIndex((line) => line.startsWith(`### Step ${step} `));
    assert.ok(start >= 0, `no heading for Step ${step}`);
    const next = lines.findIndex((line, i) => i > start && line.startsWith('### '));
    const opens = lines.findIndex((line, i) => i > start && i < next
      && line.includes(`step --id ${phase.id} --status active`));
    assert.ok(opens > 0, `'${phase.id}' is not opened in Step ${step}, where its work starts`);

    // Nothing runs before it: every code block above the call is the plan's own, or the JSON it
    // is given.
    let fence = null;
    for (let i = start; i < opens; i += 1) {
      const marker = /^\s*```(\w*)/.exec(lines[i]);
      if (marker) { fence = fence === null ? marker[1] : null; continue; }
      if (fence === null || fence === 'json' || !lines[i].trim()) continue;
      assert.match(lines[i], /app-docs\.js|^\s*#/,
        `Step ${step} runs \`${lines[i].trim().slice(0, 60)}\` before opening '${phase.id}'`);
    }
  }
});

test('a stopped plan names the failed phase by id, and a resume reopens it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-docs-resume-'));
  let state = initState(root, { appName: 'Resume', dataPlatform: 'dataverse' });
  state = applyStep(state, { id: 'scaffold', status: 'failed', note: 'npm install failed' });
  assert.equal(summarize(state).failedPhase, 'scaffold');
  assert.equal(summarize(state).settled, true);

  // Reopening is what takes the plan out of its stopped state, so it reloads again.
  state = applyStep(state, { id: 'scaffold', status: 'active' });
  assert.equal(summarize(state).failedPhase, '');
  assert.equal(summarize(state).settled, false);

  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  const resume = skill.slice(skill.indexOf('### Step 0 '), skill.indexOf('### Step 1 '));
  assert.match(resume, /step --id <failedPhase> --status active/);
  assert.match(resume, /docs\/create-app-plan\.html/, 'a resume skips 2b, so it must reopen the plan');
  assert.match(resume, /Reopen the build plan only after continuation approval/);
  assert.match(resume, /failedPhase` matching the approved continuation/);
  assert.ok(
    resume.indexOf('return without entering Step 1 or modifying creation progress')
      < resume.indexOf('step --id <failedPhase> --status active'),
    'Existing-app routing must return before reopening a creation phase',
  );
});

test('every waiting note is taken down by the step that set it', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  const calls = [...skill.matchAll(/step --id ([a-z-]+) --status ([a-z]+)([^\n]*)/g)].map((m) => ({
    phase: m[1],
    status: m[2],
    waiting: /--note "[^"]*(?:[Ww]aiting for|awaiting)/.test(m[3]),
  }));

  // A note does not outlive its status, so any later call on the same phase clears it. What
  // must not happen is a phase left waiting with nothing after it.
  for (let i = 0; i < calls.length; i += 1) {
    if (!calls[i].waiting) continue;
    const cleared = calls.slice(i + 1).some((c) => c.phase === calls[i].phase);
    assert.ok(cleared, `'${calls[i].phase}' is left waiting with no later call to take it down`);
  }
});

test('phase order matches the order the skill actually runs them', () => {
  const order = PHASES.map((phase) => phase.id);
  const at = (id) => order.indexOf(id);

  // The gates run at Step 3 and the scaffold group at Steps 5-6. These two lists drifted
  // apart once before, and because the test agreed with the stale list it stayed green while
  // a completed "Bring the app online" rendered above three still-pending gates.
  assert.ok(at('architecture') < at('scaffold'), 'the gates are answered before anything is built');
  assert.ok(at('data-model') < at('scaffold'));
  assert.ok(at('screen-plan') < at('scaffold'));

  assert.ok(at('requirements') < at('scaffold'), 'dependencies must land before the app can run');
  assert.ok(at('scaffold') < at('design'), 'the project exists before a design system is written into it');
  assert.ok(at('screen-plan') < at('design'), 'design is locked after the screens are planned');
  assert.ok(at('design') < at('screens'), 'screens are built against a settled design');
  assert.ok(at('dataverse') < at('screens'), 'generated services exist before screens use them');
  assert.equal(order[order.length - 1], 'run', 'running on a device is the last thing that happens');
});

test('phase order is derived from where the skill actually runs each step', () => {
  // The pairwise assertions above encode intent, but they were written by hand and once
  // agreed with a stale PHASES list while contradicting the skill. This check takes the
  // order from SKILL.md itself, using the `step --id` transition calls rather than the
  // `skillSteps` metadata: the metadata records which steps a phase spans, and those spans
  // legitimately interleave (setup's background install is collected long after discovery
  // starts), whereas the transition calls are the moments the plan actually advances.
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );

  // The "Build documentation protocol" preamble shows a worked example of the gate calls.
  // It is documentation, not execution, so start scanning at the first real step heading.
  const firstStep = skill.indexOf('\n### Step ');
  assert.ok(firstStep > 0, 'SKILL.md must have step headings');
  const body = skill.slice(firstStep);

  // e.g. `node "$DOCS" --working-dir "<working_dir>" step --id data-model --status done`
  // `skipped` is excluded: the connector-only branch at Step 3.9 marks both Dataverse
  // phases skipped up front, which is a statement about applicability rather than a point
  // in the execution order.
  const calls = [...body.matchAll(/step --id ([a-z-]+) --status (active|done)\b/g)];
  assert.ok(calls.length > 0, 'the skill must drive the plan with `step --id` calls');

  const firstTransition = new Map();
  for (const call of calls) {
    if (!firstTransition.has(call[1])) firstTransition.set(call[1], call.index);
  }

  let previous = -1;
  let previousPhase = null;
  for (const phase of PHASES) {
    const at = firstTransition.get(phase.id);
    assert.ok(
      at !== undefined,
      `phase '${phase.id}' is never opened or closed by the skill, so it would sit pending ` +
      'in the plan while later phases complete',
    );
    assert.ok(
      at >= previous,
      `phase '${phase.id}' first transitions before phase '${previousPhase}' — PHASES and ` +
      'the skill have drifted apart',
    );
    previous = at;
    previousPhase = phase.id;
  }
});

test('every phase the skill opens is also closed', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  const body = skill.slice(skill.indexOf('\n### Step '));
  const calls = [...body.matchAll(/step --id ([a-z-]+) --status (active|done|skipped)/g)];

  for (const phase of PHASES) {
    const statuses = calls.filter((c) => c[1] === phase.id).map((c) => c[2]);
    // `active` auto-closes the previous phase, so a phase that is only ever opened still
    // resolves - but only if a later phase opens. `run` is last, so it must close itself.
    assert.ok(
      statuses.includes('done') || statuses.includes('skipped'),
      `phase '${phase.id}' is never marked done or skipped`,
    );
  }
});

test('each phase points at skill steps that still exist', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  const headings = new Set(
    [...skill.matchAll(/^### Step ([0-9a-z.]+)/gm)].map((m) => m[1].replace(/\.$/, '')),
  );

  for (const phase of PHASES) {
    // "2e-2h" is a range and "3 / Gate 1" names a gate; take the leading step of each token.
    const referenced = phase.skillSteps
      .split(/[,/]/)
      .map((part) => part.trim().split(/[-\s]/)[0])
      .filter((part) => /^[0-9]/.test(part));
    for (const step of referenced) {
      assert.ok(headings.has(step), `phase '${phase.id}' cites Step ${step}, which no longer exists`);
    }
  }
});

test('no relationship value can produce an unrenderable diagram', () => {
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8',
  );
  // Power Pages guarantees its ER always draws by emitting one of a few hardcoded tokens and
  // never a value from the plan. A single unrecognised token aborts the parse, so passthrough
  // of any kind reintroduces "renders as source".
  assert.doesNotMatch(template, /MERMAID_CARDINALITY/, 'no regex passthrough of plan values');
  assert.doesNotMatch(template, /return raw;/, 'no plan value may reach the mermaid source');
  for (const token of ["'\\|\\|--\\|\\|'", "'\\}o--o\\{'", "'\\}o--\\|\\|'", "'\\|\\|--o\\{'"]) {
    assert.match(template, new RegExp(`return ${token};`), `missing literal ${token}`);
  }
  // Labels end early on a newline, quote or angle bracket, and wrap the box when over-long.
  assert.match(template, /\.replace\(\/\[\\r\\n\]\+\/g, ' '\)/);
  assert.match(template, /\.slice\(0, 40\)/);
  // Both directions of a relationship are one edge.
  assert.match(template, /\[from, to\]\.sort\(\)\.join\('\|'\)/);
  // The diagram itself carries the status colours, not just the legend.
  assert.match(template, /function colorErDiagram/);
  assert.match(template, /#0078d4/);
});

test('build steps sits second, and nav order matches document order', () => {
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8',
  );
  const nav = [...template.matchAll(/<button class="nav-btn[^"]*" data-tab="([a-z]+)"/g)].map((m) => m[1]);
  const sections = [...template.matchAll(/<div class="section[^"]*" id="tab-([a-z]+)"/g)].map((m) => m[1]);

  // Progress is what a user watching a running build wants first, so it leads after Overview.
  assert.deepEqual(nav.slice(0, 2), ['overview', 'steps']);
  // A tab whose section sits elsewhere in the document still works, but reading the file then
  // no longer matches reading the page.
  assert.deepEqual(nav, sections, 'nav order must match section order');
  assert.equal(nav.length, 8,
    'overview, steps, requirements, data model, capabilities, screens, design, trust');
});

test('capabilities, connectors and offline each carry a rationale', () => {
  const root = project('docs-caps');
  const state = initState(root, { appName: 'App', dataPlatform: 'Connectors only' });
  setSection(state, 'architecture', {
    dataPlatform: 'Connectors only',
    nativeCapabilities: [{ name: 'Camera', reason: 'Photograph meter damage on site' }],
    connectors: [{ name: 'SharePoint', reason: 'Site documents already live there' }],
  });
  setSection(state, 'offline', {
    enabled: true, mode: 'related rows', tables: ['Site visit'],
    rationale: 'Readings are taken where there is no signal',
  });
  save(root, state);

  const html = fs.readFileSync(outputPath(root), 'utf8');
  // A bare capability name cannot be approved or rejected; the reason is the decision.
  for (const value of ['Photograph meter damage on site', 'Site documents already live there',
    'Readings are taken where there is no signal', 'tab-capabilities']) {
    assert.ok(html.includes(value), `missing ${value}`);
  }
  // The kind is already the section heading and the border colour; repeating it per row is noise.
  assert.doesNotMatch(html, /cap-kind-connector', ?\n? *kind === 'connector'/);
  assert.match(html, /already says which list this is/);
  // The offline pill stays: sync mode is information the heading does not carry.
  assert.match(html, /offline\.mode\) head\.appendChild/);
});

test('a connector-only app is a first-class shape, not an empty data model', () => {
  const root = project('docs-connector-only');
  const state = initState(root, { appName: 'App', dataPlatform: 'Connectors only' });
  setSection(state, 'dataModel', { connectorOnly: true, tables: [] });
  save(root, state);

  const html = fs.readFileSync(outputPath(root), 'utf8');
  assert.match(html, /runs on connectors/);
  // Offline is still a decision worth recording even with no tables to sync.
  assert.match(html, /Offline has not been decided yet/);
});

test('a plan that recorded bare capability names still renders', () => {
  const root = project('docs-caps-legacy');
  const state = initState(root, { appName: 'App' });
  setSection(state, 'architecture', { nativeCapabilities: ['Camera'], connectors: ['SharePoint'] });
  save(root, state);

  const html = fs.readFileSync(outputPath(root), 'utf8');
  assert.match(html, /typeof entry === 'string'/, 'string entries must be tolerated');
  assert.match(html, /No rationale recorded/);
});

test('every table shows why it is created, reused or extended, without expanding', () => {
  const root = project('docs-table-why');
  const state = initState(root, { appName: 'App', dataPlatform: 'Dataverse' });
  setSection(state, 'dataModel', {
    tables: [
      { logicalName: 'new_sitevisit', status: 'new', reason: 'Nothing models a timed visit' },
      { logicalName: 'account', status: 'reused', reason: 'Sites are maintained there already' },
      { logicalName: 'contact', status: 'extend', reason: 'Only one column is missing' },
    ],
  });
  save(root, state);

  const html = fs.readFileSync(outputPath(root), 'utf8');
  // Each sourcing decision is labelled by its own verb, so the reason reads as an answer.
  assert.match(html, /new: 'Why create it:'/);
  assert.match(html, /reused: 'Why reuse it:'/);
  assert.match(html, /modified: 'Why extend it:'/);
  // The reason sits in entity-summary, outside entity-body, which is display:none until opened.
  // Rationale behind a click is rationale nobody reads before approving.
  assert.match(html, /el\('div', 'entity-summary'\)/);
  assert.match(html, /entity-summary\{[^}]*display:grid/);
  assert.match(html, /\.entity-body\{display:none/);
  const summaryIndex = html.indexOf("summary.appendChild(why)");
  const bodyIndex = html.indexOf("var body = el('div', 'entity-body')");
  assert.ok(summaryIndex > 0 && summaryIndex < bodyIndex, 'the reason must render before the collapsed body');
});

test('the plan never reloads over a reader, and never resets their place', () => {
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8',
  );
  // It reloaded unconditionally every 5s, which flickered and threw the reader back to Overview.
  assert.doesNotMatch(template, /\}, 5000\);/, 'no blind 5s reload');
  assert.doesNotMatch(template, /location\.hash = active/, 'hash juggling lost scroll position');

  // Open tab and scroll survive the reload.
  assert.match(template, /sessionStorage\.setItem\(STORE_TAB/);
  assert.match(template, /sessionStorage\.setItem\(STORE_SCROLL/);
  assert.match(template, /window\.scrollTo\(0, savedScroll\)/);

  // Reading, typing, scrolling or clicking defers the reload; a hidden tab never reloads.
  assert.match(template, /Date\.now\(\) - lastInteraction < QUIET_MS/);
  assert.match(template, /if \(document\.hidden\) return;/);
  // And it stops altogether once the build is finished.
  assert.match(template, /if \(!summary\.settled\)/);

  // A bare reload() may serve the cached copy: a file:// page has no cache headers, and each
  // rewrite lands as a new inode at the same path via an atomic rename. The animation could
  // therefore persist until a hard refresh, so the refresh goes through a changing URL.
  assert.doesNotMatch(template, /(?<!\/\/.*)\blocation\.reload\(\)/,
    'a plain reload can be served from the file:// cache');
  assert.match(template, /location\.replace\(fresh\)/);
  assert.match(template, /\?t=' \+ Date\.now\(\)/, 'the reload URL must differ every time');
  // replace(), not assign(): this fires every few seconds and must not fill the back button.
  assert.doesNotMatch(template, /location\.assign\(/);

  // sessionStorage throws in some privacy modes; the page must still render.
  const guarded = template.match(/sessionStorage\.(get|set)Item/g) || [];
  const tries = template.match(/try \{/g) || [];
  assert.ok(tries.length >= 4, `every sessionStorage access needs a guard (${guarded.length} accesses)`);
});

test('every renderer the page defines is also invoked', () => {
  // A refactor once sliced out the invocation block, leaving the page defining seven renderers
  // and calling none. Grepping the source still passed, because the functions and their data
  // were all present - the page just rendered nothing.
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8',
  );
  // Only zero-argument definitions are top-level renderers; helpers like renderMermaid(id, src)
  // are called with arguments from inside them.
  const defined = [...template.matchAll(/function (render[A-Za-z]+)\(([^)]*)\)/g)]
    .filter((m) => m[2].trim() === '')
    .map((m) => m[1]);
  const called = [...template.matchAll(/^ {2}(render[A-Za-z]+)\(\);/gm)].map((m) => m[1]);

  assert.ok(defined.length >= 8, `expected the full renderer set, found ${defined.length}`);
  for (const fn of defined) {
    assert.ok(called.includes(fn), `${fn} is defined but never called`);
  }
  for (const fn of called) {
    assert.ok(defined.includes(fn), `${fn} is called but never defined`);
  }
});

test('the device rail moves through building, screens and QR', () => {
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8',
  );
  assert.match(template, /\.device\{flex:0 1 620px;min-height:360px;max-height:620px;[^}]*aspect-ratio:300\/620;/);
  assert.match(template, /@media\(max-width:1180px\)[\s\S]*\.device\{flex:none;height:auto;width:min\(300px/);
  assert.match(template, /\.qr img\{flex:0 1 196px;min-height:84px;max-height:196px;[^}]*aspect-ratio:1\/1;/);

  const root = project('docs-rail');
  const state = initState(root, { appName: 'App' });
  const progress = writeEditProgress(root, { phase: 'preview', status: 'active' });
  const html = fs.readFileSync(progress, 'utf8');
  assert.match(html, /\.device-rail\{[^}]*justify-content:safe center;[^}]*overflow-y:auto;/);
  assert.match(html, /\.device\{flex:0 1 620px;min-height:360px;max-height:620px;/);
  assert.match(html, /\.device-screen\{[^}]*container-type:size;/);
  assert.match(html, /\.device-qr img\{flex:0 1 196px;min-height:84px;max-height:196px;/);
  assert.match(html, /@container \(max-height:520px\)\{\.device-qr/);
  assert.equal(state.phone.stage, 'building', 'a new plan starts on the animation');

  setPhone(state, { stage: 'screens', screens: [{ name: 'Home', html: '<div>Home</div>' }] });
  assert.equal(state.phone.stage, 'screens');

  setPhone(state, { stage: 'qr', qrUrl: 'exp://192.168.1.4:8081' });
  assert.equal(state.phone.qrUrl, 'exp://192.168.1.4:8081');
  // Screens survive the move to QR, so the stage is a view choice rather than a data reset.
  assert.equal(state.phone.screens.length, 1);

  assert.throws(() => setPhone(state, { stage: 'nope' }), /Unknown stage 'nope'/);
  assert.ok(PHONE_STAGES.has('building') && PHONE_STAGES.has('screens') && PHONE_STAGES.has('qr'));
});

test('progress is reported as steps, never as a percentage', () => {
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8',
  );
  // Phases differ wildly in duration, so a percentage reads as a time estimate the plan cannot
  // make. The bar still fills proportionally - that is a count of steps, not a claim about time.
  // Only style.width may use percent - that is a fill ratio, not a statement to the reader.
  const textUses = [...template.matchAll(/textContent = [^;]*percent[^;]*;/g)].map((m) => m[0]);
  assert.deepEqual(textUses, [], 'no visible label may be a percentage');
  assert.doesNotMatch(template, /percent \+ '% complete'/);
  assert.match(template, /summary\.done \+ ' of ' \+ summary\.total/);
  assert.match(template, /'Step ' \+ Math\.min\(summary\.done \+ 1, summary\.total\)/);
});

test('both diagrams render through the same path', () => {
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8',
  );
  // The ER called mermaid.render() while the screen graph relied on startOnLoad. Turning
  // startOnLoad off to control the ER silently left the screen graph as raw source.
  assert.match(template, /function renderMermaid\(/);
  assert.doesNotMatch(template, /function diagram\(/, 'the startOnLoad-dependent helper is gone');
  assert.match(template, /renderMermaid\('erContainer'/);
  assert.match(template, /renderMermaid\('graphContainer'/);
  assert.match(template, /startOnLoad: false/);
  // Exactly one place calls mermaid.render, so the two can never diverge again.
  // One call site, so the two diagrams cannot drift apart again. Strip comments first: the
  // explanation above names mermaid.render(), and matching prose would count it twice.
  const code = template.split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n');
  assert.equal((code.match(/mermaid\.render\(/g) || []).length, 1);
});
