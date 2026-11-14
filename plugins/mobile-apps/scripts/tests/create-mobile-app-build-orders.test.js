'use strict';

// /create-mobile-app offers two build orders. SKILL.md routes the request, asks for the order at
// Step 0, and loads only that order's flow file; these tests pin that routing. Each flow's own
// steps are covered by its contract tests.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { shellBlocks } = require('./helpers/markdown-shell-blocks');

const skillDir = path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app');
const read = (file) => fs.readFileSync(path.join(skillDir, file), 'utf8').replace(/\r\n?/g, '\n');
const entry = read('SKILL.md');
const screensFirst = read('references/screens-first.md');
const makeItReal = read('references/make-it-real.md');
const dataModelFirst = read('references/data-model-first.md');

test('SKILL.md holds only the shared entry, and links each build order to its flow files', () => {
  // The unchosen flow must never be in context, so no flow step lives in the entry file.
  assert.doesNotMatch(entry, /^### Step [1-9]/m);
  const orders = entry.slice(entry.indexOf('## Build orders'), entry.indexOf('## Fresh-template working-directory mode'));
  assert.match(orders, /\*\*Screens first\*\* \(recommended\) \| \[`references\/screens-first\.md`\]\(references\/screens-first\.md\)[^|]*\[`references\/make-it-real\.md`\]\(references\/make-it-real\.md\)/);
  assert.match(orders, /\*\*Data model first\*\* \| \[`references\/data-model-first\.md`\]\(references\/data-model-first\.md\)/);
  assert.match(orders, /Read only the chosen flow/);

  // Each flow starts at Step 1, right after the shared Step 0.
  assert.match(screensFirst, /^### Step 1 — /m);
  assert.match(dataModelFirst, /^### Step 1 — /m);
  assert.doesNotMatch(`${screensFirst}\n${dataModelFirst}`, /^### Step 0 /m);
});

test('the build order is asked once, after routing confirms a fresh creation', () => {
  const step0 = entry.slice(entry.indexOf('### Step 0 '));
  const fresh = step0.indexOf('#### Fresh run');
  const choose = step0.indexOf('#### Choose the build order');
  const continuation = step0.indexOf('#### Creation continuation');
  assert.ok(fresh > 0 && fresh < choose && choose < continuation,
    'the question belongs to a fresh run, after its freshness conditions');
  // Existing-app requests leave the skill before any build-order question.
  assert.ok(step0.indexOf('**Existing-app changes leave this skill before resume handling.**') < choose);

  // The user says what to build before choosing how: the requirements come first, and the
  // question opens with the brief they produced.
  const gather = step0.indexOf('#### Gather the requirements');
  assert.ok(fresh < gather && gather < choose, 'the requirements are gathered before the build order');
  assert.match(step0.slice(gather, choose), /<working_dir>\/\.tmp\/requirements\.json/);

  const question = step0.slice(choose, continuation);
  assert.match(question, /"Here's what I'll build:", the brief's bullets/);
  assert.match(question, /`--screens-first` or `--data-model-first` in `\$ARGUMENTS` chooses without asking/);
  assert.match(question, /one `AskUserQuestion`/);
  // Screens first is the recommended, first option, and says what the user gets from it.
  const options = question.split('\n').find((line) => line.startsWith('| `build order` |'));
  assert.ok(options, 'the question row is missing');
  assert.ok(options.indexOf('**Screens first (recommended)**') < options.indexOf('**Data model first**'));
  assert.match(options, /run live in the build plan's phone within minutes/);
  assert.match(options, /set up afterwards while the app stays on screen/);
  assert.match(options, /The app first runs at the end/);
  assert.match(question, /read the chosen flow file and continue at its Step 1/);
});

test('a connector-only brief builds data model first without asking', () => {
  // Screens first previews on sample data, which has nothing to offer when every record lives in a
  // connector: its shape comes from the connector's own interface. The classification happens once,
  // in SKILL.md, and both flows read it instead of inferring their own.
  const step0 = entry.slice(entry.indexOf('### Step 0 '));
  const classify = step0.indexOf('**Classify where the data lives**');
  const choose = step0.indexOf('#### Choose the build order');
  assert.ok(classify > 0 && classify < choose, 'the data source is classified before the build order');
  assert.match(step0.slice(classify, choose), /"dataPlanningMode"/);
  const question = step0.slice(choose, step0.indexOf('#### Creation continuation'));
  const routing = question.indexOf('**A `connector-only` brief builds data model first, and is not asked.**');
  assert.ok(routing >= 0 && routing < question.indexOf('one `AskUserQuestion`'), 'the route comes before the question');
  assert.match(question, /`--screens-first` does not override this/);
  for (const flow of [screensFirst + makeItReal, dataModelFirst]) {
    assert.doesNotMatch(flow, /infer a provisional Dataverse planning mode/i, 'flows read the classification, not re-derive it');
    assert.match(flow, /dataPlanningMode/);
  }
});

test('each flow records its build order in the plan, and a continuation keeps it', () => {
  assert.match(screensFirst, /`\{"appName","dataPlatform":"unknown","buildOrder":"screens-first"\}`/);
  assert.match(dataModelFirst, /\{"appName":"<displayName>","dataPlatform":"unknown","buildOrder":"data-model-first"\}/);

  const continuation = entry.slice(entry.indexOf('#### Creation continuation'));
  assert.match(continuation, /never switch orders mid-creation/);
  assert.match(continuation, /`skillSteps`/);
  assert.match(screensFirst, /## Continuing a creation[\s\S]*`preview` → Step 7/);
});

test('Step 0 reports the recorded build order, reading an unrecorded plan as data model first', (t) => {
  const command = shellBlocks(entry.slice(entry.indexOf('### Step 0 '), entry.indexOf('#### Fresh run')))
    .find((block) => block.includes('BUILD_ORDER='));
  assert.ok(command, 'Step 0 must print BUILD_ORDER');
  // Only the probe itself: the rest of the block checks the template and the plugin version.
  const probe = command.split('\n').find((line) => line.includes('BUILD_ORDER='));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = () => spawnSync('bash', ['-c', probe], { cwd: root, encoding: 'utf8' }).stdout.trim();

  assert.equal(run(), 'BUILD_ORDER=', 'no plan yet');
  fs.mkdirSync(path.join(root, 'docs'));
  const planPath = path.join(root, 'docs', '.run-plan.json');
  fs.writeFileSync(planPath, JSON.stringify({ appName: 'Older run', phases: [] }));
  assert.equal(run(), 'BUILD_ORDER=data-model-first', 'plans from before build orders');
  fs.writeFileSync(planPath, JSON.stringify({ appName: 'App', buildOrder: 'screens-first', phases: [] }));
  assert.equal(run(), 'BUILD_ORDER=screens-first');
});

test('only screens first prepares the template for the sample-data preview', () => {
  const prepare = (text) => text.split('\n').filter((line) => line.includes('prepare-mobile-template.js'));
  assert.ok(prepare(screensFirst).some((line) => line.includes('--screens-first')));
  assert.ok(prepare(dataModelFirst).length > 0);
  assert.ok(prepare(dataModelFirst).every((line) => !line.includes('--screens-first')));
});

test('each build order spawns its own planner', () => {
  assert.match(makeItReal, /Spawn agent: mobile-app:architecture-planner/);
  assert.doesNotMatch(`${screensFirst}\n${makeItReal}`, /native-app-planner/);
  assert.match(dataModelFirst, /native-app-planner/);
  assert.doesNotMatch(dataModelFirst, /architecture-planner|preview-screen-builder/);
});

test('an app without connectors still closes the capabilities phase and finalises the trust report', () => {
  // Both orders run the shared connectors step, and most Dataverse-only apps have no connectors. The
  // native capabilities step opens the phase this step closes, and the architecture gate's first-pass
  // trust report lacks handles[] and notCollected[], so "None" may skip only the connector calls.
  const { createSkillDataModelFirst, createSkillWorkflow } = require('./helpers/create-skill');
  for (const [order, flow] of [['screens first', createSkillWorkflow()], ['data model first', createSkillDataModelFirst()]]) {
    const none = flow.indexOf('If it says "None"');
    const step = flow.slice(none, flow.indexOf('`trust.json` has four keys', none));
    assert.ok(none > 0, `${order} reads the connectors section`);
    assert.doesNotMatch(step, /skip this step entirely/, order);
    assert.match(step, /skip only the connector invocations below, and continue at \*\*Close the capabilities phase\*\*/, order);
    const close = step.indexOf('**Close the capabilities phase.**');
    assert.ok(close > step.indexOf('| `sharepointonline` |'), `${order} closes the phase after the invocations`);
    assert.ok(step.indexOf('step --id capabilities --status done', close) > close, order);
    assert.ok(step.indexOf('--section trust', close) > close, `${order} finalises the trust report`);
  }
});
