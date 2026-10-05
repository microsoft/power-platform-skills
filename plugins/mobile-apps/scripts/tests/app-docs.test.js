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

test('the skill marks a phase failed before it stops', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );

  // `failed` settles the page, which stops the self-refresh. Listing the value without ever
  // issuing it left the last phase `active`, so a terminal STOP produced a plan that reloaded
  // forever reporting work in progress on a run that had ended.
  assert.match(skill, /step --id <phase> --status failed/);
  assert.match(skill, /Mark the phase `failed` before you stop/);

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
