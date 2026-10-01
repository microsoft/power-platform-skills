'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PHASES, PHONE_STAGES, SECTIONS, applyStep, initState, loadState, outputPath, save, setPhone,
  setSection, summarize,
} = require('../app-docs');

const scriptPath = path.resolve(__dirname, '..', 'app-docs.js');

function project(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function seeded(root) {
  return save(root, initState(root, { appName: 'Field Inspections', dataPlatform: 'dataverse' }));
}

test('init creates docs/ with the plan and the brand mark beside it', () => {
  const root = project('docs-init');
  seeded(root);
  // The page references ./power-apps-icon.svg, so it has to travel with the HTML.
  assert.ok(fs.existsSync(path.join(root, 'docs', 'create-app-plan.html')));
  assert.ok(fs.existsSync(path.join(root, 'docs', 'power-apps-icon.svg')));
  assert.ok(fs.existsSync(path.join(root, 'docs', '.run-plan.json')));
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
  assert.match(summary.narrative, /stopped at bring the app online/i);
  assert.doesNotMatch(summary.narrative, /Preparing to build/);
});

test('the topbar shows the approved data platform, not the placeholder init was given', () => {
  const root = project('docs-platform');
  let state = initState(root, { appName: 'App', dataPlatform: 'unknown' });
  // `init` runs at Step 2b, before the platform is chosen, and nothing updates the top-level
  // value - so the pill read "Data: unknown" for the whole run.
  save(root, state);
  let html = fs.readFileSync(outputPath(root), 'utf8');
  assert.match(html, /Data: unknown/);

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
  const root = project('docs-rail');
  const state = initState(root, { appName: 'App' });
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
