'use strict';

// Build-plan contract tests for /create-mobile-app's data-model-first build order: SKILL.md's
// shared Step 0 plus references/data-model-first.md, the original workflow. They are the tests
// that pinned that workflow before build orders existed, so a change that drifts it from its
// established behavior fails here. Screens-first's equivalents live in app-docs.test.js and
// run-plan-page.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PHASES_BY_BUILD_ORDER, applyStep, initState, summarize } = require('../app-docs');
const { createSkillDataModelFirst, createSkillDataModelFirstExecution } = require('./helpers/create-skill');

const PHASES = PHASES_BY_BUILD_ORDER['data-model-first'];

test('the skill closes every gate with a fresh note', () => {
  const skill = createSkillDataModelFirst();
  const body = createSkillDataModelFirstExecution();
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
  const skill = createSkillDataModelFirst();
  const body = createSkillDataModelFirstExecution();

  // The tab told the user it would fill after Gate 1 while the skill only wrote it at Step 10,
  // so it sat empty for most of the run. A proposed pass lands with Gate 1 and Step 10 finalises.
  const writes = [...body.matchAll(/set --section trust[^\n]*--state (proposed|approved)/g)].map((m) => m[1]);
  assert.deepEqual(writes, ['proposed', 'approved'],
    'trust must be proposed at the gate that settles capabilities, then approved once wired');

  const proposedAt = body.indexOf('set --section trust');
  const gate1Close = body.indexOf('step --id architecture --status done');
  assert.ok(gate1Close !== -1 && proposedAt > gate1Close, 'the first pass belongs with the Gate 1 batch');
});

test('the skill flags the run as blocked before its first question', () => {
  const skill = createSkillDataModelFirst();
  const open = skill.match(/step --id requirements --status active([^\n]*)/);
  assert.ok(open, 'the requirements phase must be opened');
  assert.match(open[1], /--note "Waiting for your answers/,
    'the first prompt must raise the waiting banner');
});


test('the skill records a skipped design step instead of leaving it open', () => {
  const skill = createSkillDataModelFirst();
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
  const skill = createSkillDataModelFirst();
  // `/design-system` and its style picker gate every browser opener on this variable. Asserting
  // it was set without passing it made those guards dead code: the nested skill saw a standalone
  // run and opened tabs over the build plan anyway.
  const invocation = skill.slice(skill.indexOf('Invoke skill: /design-system'));
  const block = invocation.slice(0, invocation.indexOf('```'));
  assert.match(block, /Environment:\s*\n\s*CODE_APPS_NATIVE_ORCHESTRATING=1/,
    'the invocation must pass the flag the guards read');
});

test('every step that blocks on the user says so in the plan', () => {
  const skill = createSkillDataModelFirst();
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
  const skill = createSkillDataModelFirst();
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

  const skill = createSkillDataModelFirst();
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
  const skill = createSkillDataModelFirst();
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

test('phase order is derived from where the skill actually runs each step', () => {
  // The pairwise assertions above encode intent, but they were written by hand and once
  // agreed with a stale PHASES list while contradicting the skill. This check takes the
  // order from SKILL.md itself, using the `step --id` transition calls rather than the
  // `skillSteps` metadata: the metadata records which steps a phase spans, and those spans
  // legitimately interleave (setup's background install is collected long after discovery
  // starts), whereas the transition calls are the moments the plan actually advances.
  const skill = createSkillDataModelFirst();

  // The "Build documentation protocol" preamble shows a worked example of the gate calls.
  // It is documentation, not execution, so start scanning at the first real step heading.
  const body = createSkillDataModelFirstExecution();
  assert.match(skill, /\n### Step /, 'the skill must have step headings');

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
  const skill = createSkillDataModelFirst();
  const body = createSkillDataModelFirstExecution();
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
  const skill = createSkillDataModelFirst();
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

test('the create skill renders the screen preview but never opens it', () => {
  const skill = createSkillDataModelFirst();

  // The plan shows these screens in its phone frame and links out to the file, so a browser tab
  // opening mid-run interrupts a user who is already watching the plan.
  for (const block of skill.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
    assert.ok(
      !/_plan_preview\.html/.test(block[1])
        || /app-docs\.js"[^\n]*phone --stage screens --preview-file/.test(block[1]),
      `a command opens the preview instead of embedding it: ${block[1].trim().slice(0, 80)}`,
    );
  }
  // It must still be rendered - the carousel takes its markup from those blocks - and it is
  // written into docs/ with every other artifact the user is asked to look at.
  assert.match(skill, /Render `_plan_preview\.html`/);
  assert.match(skill, /phone --stage screens --preview-file '<working_dir>\/_plan_preview\.html'/);
  assert.doesNotMatch(skill, /screens-preview\.json/);
});

test('the skill points at the plan instead of opening the QR in a window', () => {
  const skill = createSkillDataModelFirst();
  // The plan draws the QR and links it, so a window opening over a run the user is watching
  // adds nothing. Asserted on runnable commands, not prose - the prose states the rule and
  // would trip a naive whole-file match.
  for (const block of skill.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
    assert.ok(
      !/(open|xdg-open|Start-Process|start "")\s+"?\$METRO_QR/.test(block[1]),
      `a runnable command still opens the QR: ${block[1].trim().slice(0, 70)}`,
    );
  }
  assert.match(skill, /do \*\*not\*\* open the PNG/);
});
