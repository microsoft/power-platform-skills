'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createSkillPhaseA, createSkillPhaseB, createSkillWorkflow } = require('./helpers/create-skill');

const pluginRoot = path.resolve(__dirname, '..', '..');
const createSkill = createSkillWorkflow();
const planner = fs.readFileSync(
  // The screens-first order's planner; data-model-first keeps native-app-planner, covered by
  // create-mobile-app-data-model-first.test.js.
  path.join(pluginRoot, 'agents', 'architecture-planner.md'),
  'utf8',
);
const architect = fs.readFileSync(
  path.join(pluginRoot, 'agents', 'data-model-architect.md'),
  'utf8',
);
const screenPlanner = fs.readFileSync(
  path.join(pluginRoot, 'agents', 'screen-planner.md'),
  'utf8',
);
const screenBuilder = fs.readFileSync(
  path.join(pluginRoot, 'agents', 'screen-builder.md'),
  'utf8',
);
const universalPatterns = fs.readFileSync(
  path.join(pluginRoot, 'shared', 'references', 'universal-patterns.md'),
  'utf8',
);
const requirementsDiscovery = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'requirements-discovery.md'),
  'utf8',
);
const connectivityOwnership = fs.readFileSync(
  path.join(pluginRoot, 'shared', 'references', 'connectivity-intent-ownership.md'),
  'utf8',
);
const templatePackage = JSON.parse(
  fs.readFileSync(path.join(pluginRoot, 'template', 'package.json'), 'utf8'),
);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('planning contracts contain no unresolved merge markers', () => {
  for (const source of [createSkill, planner, architect, screenPlanner, screenBuilder]) {
    assert.doesNotMatch(source, /^(?:<{7}|={7}|>{7})(?: |$)/m);
  }
});

test('connectivity wording is owned by the post-materialization offline flow', () => {
  // Phase A never needs a Dataverse fact, so the provisional mode is inferred in Phase B,
  // just before the architecture gate.
  const classification = section(createSkill, '### Dataverse planning mode', '### Step 1.7');
  assert.match(classification, /connectivity-intent-ownership\.md/i);
  assert.doesNotMatch(classification, /Dataverse offline data/);
  for (const source of [planner, architect, screenPlanner, screenBuilder, requirementsDiscovery]) {
    assert.match(source, /connectivity-intent-ownership\.md/i);
  }
  assert.match(
    connectivityOwnership,
    /offline-first[\s\S]*limited or[\s\S]*intermittent connectivity[\s\S]*no connectivity/i,
  );
  assert.match(connectivityOwnership, /operating\s+context only/i);
  assert.match(
    connectivityOwnership,
    /must not add offline-specific business tables[\s\S]*services[\s\S]*stores[\s\S]*routes[\s\S]*screens/i,
  );
  assert.equal(
    typeof templatePackage.dependencies['@microsoft/power-apps-native-offline'],
    'string',
  );
  assert.match(
    connectivityOwnership,
    /power-apps-native-host[\s\S]*local SQLite[\s\S]*status overlay/i,
  );
  assert.match(universalPatterns, /approved product requirement.*app-owned sync queue/is);
  assert.doesNotMatch(requirementsDiscovery, /Camera capability \+ image column/);
});

test('the wizard targets iOS and Android without asking a platform question', () => {
  const gatherRequirements = section(
    createSkill,
    '### Step 2 — The setup question',
    '### Step 2b — The requirements brief',
  );
  assert.doesNotMatch(gatherRequirements, /\| (?:Target )?platforms? \|/i);
  assert.match(gatherRequirements, /Every app targets iOS and Android; never ask which/);
  assert.match(createSkill, /"platforms":"iOS and Android"/);
});

test('every setup answer is collected in one question, before the plan exists', () => {
  const setup = section(createSkill, '### Step 2 — The setup question', '### Step 3 —');
  // One question, with the name, environment, look, and (for a thin prompt) the features, so
  // the user answers once and the run goes straight to building.
  assert.equal((setup.match(/AskUserQuestion/g) || []).length, 1);
  for (const header of ['name', 'environment', 'look', 'features']) {
    assert.match(setup, new RegExp(`^\\| \`${header}\` \\|`, 'm'), `the setup question has no ${header} row`);
  }
  // The brief is printed, not confirmed: the screen graph gate is where the user reviews it.
  assert.match(setup, /Print it as a log rather than asking to confirm it/);
  assert.doesNotMatch(createSkill, /Does this look right\?/);
});

test('screens are planned, built, and previewed before any architecture or data-source work', () => {
  const headings = [
    '### Step 3 — Scaffold the app', '### Step 4 — Plan the screens',
    '### Step 5 — Write the navigation shell', '### Step 6 — Build the screens',
    '### Step 7 — Check the whole app', '### Step 8 — The preview gate',
    '### Step 9.0 — Record the preview',
    '### Step 9 — Design system', '### Step 10 — Plan the architecture and data model',
    '### Step 11 — Auth config', '### Step 12 — Apply data model',
    '### Step 13 — Apply native capabilities', '### Step 14 — Connect real data',
    '### Step 15 — Stylistic fix sweep', '### Step 16 — Start the native dev server',
    '### Step 17 — Summary',
  ];
  const positions = headings.map((heading) => createSkill.indexOf(heading));
  positions.forEach((position, index) => assert.ok(position > 0, `missing ${headings[index]}`));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'steps must appear in run order');
  assert.doesNotMatch(createSkill, /### Step 2c|### Step 2d/);

  // Nothing before the preview gate touches Dataverse, connectors, native wrappers, or auth,
  // and SKILL.md holds nothing else: Phase B is only read once the preview is approved.
  const phaseA = createSkillPhaseA();
  for (const outside of ['Invoke skill: /add-', 'create-dataverse-snapshot.js', 'detect-publisher-prefix.js',
    'discover-app-registrations.js', 'mobile-app:architecture-planner', 'auth.config.json` using `Edit`']) {
    assert.ok(!phaseA.includes(outside), `Phase A must not reach ${outside}`);
  }
  assert.doesNotMatch(phaseA, /^### Step (?:9|1[0-7])\b/m, 'Phase B steps belong in references/make-it-real.md');
  assert.match(phaseA, /On `Looks good - continue`[\s\S]*\*\*Continue with Phase B:\*\* read \[`references\/make-it-real\.md`\]\(make-it-real\.md\) in full now/);

  // The screen graph gate is the only screen gate, and specs wait until the screens are built.
  const screens = section(createSkill, '### Step 4 — Plan the screens', '### Step 5 —');
  // The orchestrator drafts the graph itself and a script checks and renders it before the gate.
  const draft = screens.indexOf('references/screen-graph.md');
  const render = screens.indexOf('render-screen-graph.js');
  const gate = screens.indexOf('**Present the screen graph gate**');
  assert.ok(draft > 0 && draft < gate && gate < render);
  assert.match(screens, /never as tables, columns, connectors, or services/);
  assert.doesNotMatch(phaseA, /phase: specs|phase: graph|Spawn agent: mobile-app:screen-planner/);
  const record = section(createSkill, '### Step 9.0 — Record the preview', '### Step 9 —');
  assert.match(record, /phase: specs[\s\S]*built_screens: true/);
  assert.match(record, /specs have no gate of their own/);

  // The data layer is built from the Data Contract and checked while the screens build.
  const dataLayer = section(createSkill, '#### 6.2 — Write the data layer while they build', '#### 6.3');
  assert.match(dataLayer, /preview-data-layer\.md/);
  assert.match(dataLayer, /check-data-layer\.js/);

  // The preview is a real, checked Expo web build, put in front of the user as a gate.
  for (const marker of ['find-free-port.js', 'check-web-preview.js', 'phone --stage live', '#### 8.1 — The preview gate', 'Leave `CI` unset']) {
    assert.ok(phaseA.includes(marker), `Phase A must include ${marker}`);
  }

  // Only the data layer is rewired once real sources exist, and the gate proves nothing stayed fake.
  const wiring = section(createSkill, '### Step 14 — Connect real data', '### Step 15 —');
  assert.match(wiring, /check-data-layer\.js" --project-root '<working_dir>' --require-wired/);
  assert.match(wiring, /phone --stage building/);
  assert.match(wiring, /Data Contract Mapping/);
});

test('the first screen reaches the phone while the rest are still building', () => {
  const phaseA = createSkillPhaseA();
  // The scaffold and the screen graph are independent, so they start in the same message.
  const scaffold = section(phaseA, '### Step 3 — Scaffold the app', '#### 3.1');
  assert.match(scaffold, /three tool calls: the command below, a read of \[`references\/screen-graph\.md`\]/);
  // The graph is written in the same message that starts the preview server.
  assert.match(phaseA, /three tool calls: start Expo web[\s\S]*write Step 4's screen graph/);
  // Expo is started and warmed before the gate, so going live later costs no cold bundle.
  const server = section(phaseA, '#### 3.5 — Start the preview server', '### Step 4 —');
  assert.match(server, /expo start --port <port> --localhost < \/dev\/null/);
  assert.match(server, /check-web-preview\.js/);

  // One builder per screen, in the background, the entry screen first, from the graph alone.
  const spawn = section(phaseA, '#### 6.1 — Spawn the builders', '#### 6.2');
  assert.match(spawn, /Spawn agent: mobile-app:preview-screen-builder/);
  assert.match(spawn, /screens_file: <working_dir>\/\.tmp\/screens\.json/);
  // Completion notices can lag a background builder by a minute, and live runs showed the host's
  // "you will be notified" guidance beating any instruction to block on an agent. Each builder
  // writes a done file instead, and the go-live command waits on the entry screen's.
  assert.match(spawn, /in the background[\s\S]*with `entry` in the first group/);
  assert.match(spawn, /done_file: <working_dir>\/\.tmp\/built\/<screen name, kebab-case>\.done/);
  assert.match(section(phaseA, '#### 6.2', '#### 6.3'), /run 6\.3's command at once/);
  const goLive = section(phaseA, '#### 6.3', '#### 6.4');
  assert.match(goLive, /for i in \$\(seq 1 150\); do \[ -f '\.tmp\/built\/<entry>\.done' \] && break; sleep 2; done/);
  assert.match(goLive, /check-web-preview\.js" --url "http:\/\/localhost:<port>" \|\| exit 1\nnode "\$\{PLUGIN_ROOT\}\/scripts\/app-docs\.js" --working-dir '<working_dir>' phone --stage live/);
  // The navigation shell is mechanical, so a script writes it, alongside the spawns.
  assert.match(section(phaseA, '### Step 5 —', '### Step 6 —'), /scaffold-preview-screens\.js/);

  // The phone goes live on the entry screen, before the remaining builders are collected
  // and before the whole-app check.
  const live = phaseA.indexOf('phone --stage live');
  assert.ok(live > phaseA.indexOf('#### 6.3') && live < phaseA.indexOf('#### 6.4'));
  assert.ok(phaseA.indexOf('#### 6.4') < phaseA.indexOf('### Step 7 —'));
});

test('SKILL.md stays small enough to keep Phase A fast', () => {
  // Every model turn re-reads what the run has loaded, so the orchestrator file's size is paid
  // on every Phase A turn. Phase B detail belongs in references/make-it-real.md.
  const bytes = Buffer.byteLength(createSkillPhaseA(), 'utf8');
  assert.ok(bytes < 60 * 1024, `SKILL.md is ${bytes} bytes; move detail Phase A does not need into references/`);
  assert.ok(createSkillPhaseB().length > 0);
});

test('data platform and integrations are approved before Dataverse modeling', () => {
  const modeQuestion = createSkill.indexOf('**Question header:** `Data platform`');
  const architecturePass = createSkill.indexOf('### Architecture gate');
  const prefixDetection = createSkill.indexOf('Now execute the deferred Step 1.7');
  const snapshot = createSkill.indexOf('### Foreground Dataverse planning snapshot');
  assert.equal(modeQuestion, -1);
  assert.ok(architecturePass > 0 && architecturePass < prefixDetection);
  assert.ok(prefixDetection < snapshot);
  assert.match(
    section(createSkill, '### Architecture gate', '### Foreground Dataverse planning snapshot'),
    /Dataverse planning snapshot: NOT SUPPLIED[\s\S]*approved-architecture\.md/i,
  );
  assert.match(
    section(createSkill, '### Foreground Dataverse planning snapshot', '**Hard rule — planner writes'),
    /`<dataverse_planning_mode>` approved at the architecture gate/i,
  );

  const architectureGate = planner.indexOf(
    '### Architecture gate — Data Platform + Device Capabilities + Integrations',
  );
  const nativePlanning = planner.indexOf('## Step 3 — Plan Native Capabilities Inline');
  const connectorPlanning = planner.indexOf('## Step 4 — Plan Connectors Inline');
  const architectDispatch = planner.indexOf('## Step 5 — Build Data Model');
  const dataModelGate = planner.indexOf('## Step 6 — Data model gate');
  assert.ok(nativePlanning > 0 && nativePlanning < connectorPlanning);
  assert.ok(connectorPlanning < architectureGate);
  const connectorSection = planner.slice(connectorPlanning, architectureGate);
  assert.doesNotMatch(connectorSection, /AskUserQuestion|ask cold/i);
  assert.match(connectorSection, /Approve at the architecture gate/i);
  assert.ok(architectureGate > 0 && architectureGate < architectDispatch);
  assert.ok(architectDispatch < dataModelGate);
  // Screens are planned by the orchestrator before the planner runs, so the planner owns no
  // screen gate and treats the approved screens as its input.
  assert.doesNotMatch(planner, /spawn `screen-planner`|phase: graph|phase: specs/);
  assert.match(planner, /Screens are the input/);
  assert.match(planner, /Approved screens and Data Contract:/);
  assert.match(
    planner,
    /connector-only[\s\S]*data-model-architect/i,
  );
  assert.match(planner, /Approved native capabilities:[\s\S]*Approved connectors:/i);
  assert.match(architect, /approved native capabilities/i);
  assert.match(architect, /approved connectors/i);
  assert.match(architect, /do not create a Dataverse duplicate of a connector-owned entity/i);
  assert.match(architect, /### Data Contract Mapping/);
  assert.match(
    createSkill,
    /architecture-only pass[\s\S]*NEEDS_CONTEXT: dataverse-planning-mode:<required\|connector-only>/i,
  );
  // A connector-only app never reaches the architect, in either the first pass or a revision.
  assert.match(planner, /### Connector-only\s+Do not dispatch `mobile-app:data-model-architect`/);
  assert.match(planner, /in `connector-only` mode, do not enter plan mode, do not\s+dispatch or re-dispatch `data-model-architect`/);
  // Screens-first names its gates. The shared agents also serve data-model-first, whose gates are
  // numbered, so only the text this order owns is checked.
  assert.doesNotMatch(`${planner}\n${createSkill}`, /Gate [1-4]\b|Gate 4a|Gate 4b/);
  assert.match(
    architect,
    /BLOCKED: This step only applies when Dataverse is selected/i,
  );
});

test('screen specs use the canonical approvals heading as their insertion anchor', () => {
  assert.match(planner, /^## Approvals$/m);
  assert.doesNotMatch(planner, /^## Approval Status$/m);
  assert.match(screenPlanner, /immediately before `## Approvals`/);
});

test('deferred design does not create an extra industry question', () => {
  // The orchestrator writes ## Design before screen planning and /design-system owns the choice,
  // so the planner asks nothing about design or industry, and the old early-return is malformed.
  assert.match(planner, /asks no design or industry question/);
  assert.doesNotMatch(planner, /INDUSTRY_CONFIRM_REQUESTED|DESIGN_VIBE_REQUESTED/);
  assert.match(createSkill, /Treat a first line of\s+`INDUSTRY_CONFIRM_REQUESTED:` or `DESIGN_VIBE_REQUESTED:` as malformed/);
  assert.doesNotMatch(planner, /design is reviewed visually at Gate 4/i);
});
test('the live preview replaces plan-time HTML mockups', () => {
  const preferences = section(createSkill, 'Set tentative defaults', '**`--no-design` escape hatch.**');
  assert.match(preferences, /<visual_companion> = yes[^\r\n]*`\/preview-screens`/);
  assert.match(preferences, /one browser surface[\s\S]*the build plan at Step 3\. The live web preview at Step 6\.3 runs inside the plan's phone frame/);
  assert.match(preferences, /skip its static screen mockups/);
  // A legacy planner's preview token is ignored rather than opened.
  assert.match(createSkill, /ignore any\s+`PLAN_PREVIEW_PATH:` line: the live preview replaced plan-time HTML mockups/);
  const design = section(createSkill, '### Step 9 — Design system', '### Step 9.2');
  assert.match(design, /live_preview: http:\/\/localhost:<port>/);
  assert.match(design, /skips\s+its static HTML screen mockups/);
  assert.doesNotMatch(design, /_plan_preview|phone --stage screens/);
  assert.doesNotMatch(design, /xdg-open|Start-Process|open "/);
  const designSystem = fs.readFileSync(path.join(pluginRoot, 'skills/design-system/SKILL.md'), 'utf8');
  assert.match(designSystem, /`live_preview: <url>`[\s\S]*skip this step/);
});
test('offline completion summary reflects the bundled native host runtime', () => {
  const offlineSkill = fs.readFileSync(
    path.join(pluginRoot, 'skills/setup-offline-profile/SKILL.md'), 'utf8',
  );
  const summary = section(offlineSkill, '### Step 10 — Summary', '## Status code');
  assert.match(summary, /@microsoft\/power-apps-native-host[\s\S]*consumes the profile/);
  assert.match(summary, /SQLite[\s\S]*queued synchronization[\s\S]*reconnect[\s\S]*status/);
  assert.doesNotMatch(summary, /does not yet consume|Native runtime support remains deferred/i);
});

test('inline fallback preserves architecture-first conditional modeling', () => {
  const fallback = section(
    createSkill,
    '#### 10.0a — Inline-gate fallback',
    '#### 10.0 — Architecture and Dataverse return signals',
  );
  const architecture = fallback.indexOf('.tmp/approved-architecture.md');
  const architect = fallback.indexOf('spawn `mobile-app:data-model-architect`');
  assert.ok(architecture > 0 && architecture < architect);
  assert.match(fallback, /connector-only[\s\S]*zero-table\/no-Dataverse/i);
  assert.match(fallback, /Approved native capabilities:[\s\S]*Approved connectors:/i);
  assert.match(fallback, /Data Contract Mapping/);
  // Screens were approved before Step 10, so the fallback never plans them again.
  assert.doesNotMatch(fallback, /phase: graph|phase: specs/);
  assert.match(fallback, /missing or malformed, return to the Architecture gate/);
});
test('screen planning persists the approved graph before requesting specs', () => {
  const screens = section(createSkill, '#### 4.2 — Screen graph', '### Step 5 —');
  const write = screens.indexOf('.tmp/screens.json');
  const gate = screens.indexOf('**Present the screen graph gate**');
  const render = screens.indexOf('render-screen-graph.js');
  const ask = screens.indexOf('AskUserQuestion');
  // The graph is rendered into the plan before the user is asked, so the plan shows what they approve.
  assert.ok(write >= 0 && write < gate && gate < render && render < ask);
  assert.match(screens, /fix every problem it lists in one edit of `screens\.json` and rerun the block/);
  assert.match(screens, /On a change request, edit `screens\.json`[\s\S]*present the gate again/);
  // Specs come after the preview, from the approved plan.
  const specs = section(createSkill, '### Step 9.0 — Record the preview', '### Step 9 —');
  assert.match(specs, /plan_path: <working_dir>\/native-app-plan\.md/);
  assert.match(specs, /skip_preview: true/);
});
test('screen specs use the canonical plan and never rewrite graph scratch', () => {
  const specs = section(createSkill, '### Step 9.0 — Record the preview', '### Step 9 —');
  assert.match(specs, /plan_path: <working_dir>\/native-app-plan\.md/);
  assert.match(specs, /locked in plan_path's ## Screens/);
  assert.match(specs, /Replace only the specs-owned subsections in plan_path/);
  assert.doesNotMatch(specs, /locked[^.\n]*_screens_section\.md/);
});
test('screen completeness repair belongs to graph planning before approval', () => {
  const phases = section(screenPlanner, '## Two-phase mode', '**The scaffolded project');
  const graphRow = phases.split(/\r?\n/).find((line) => line.startsWith('| `graph` |'));
  assert.match(graphRow, /Step 5b \(repair\)/);
  const audit = section(screenPlanner, '### Step 5b', '## Step 6');
  assert.match(audit, /`phase: specs`[\s\S]*read-only[\s\S]*before any[\s\S]*write/);
  assert.match(audit, /NEEDS_CONTEXT: graph missing <thing>/);
  assert.match(audit, /`phase: graph`[\s\S]*repair[\s\S]*screen graph gate/);
  assert.doesNotMatch(audit, /add the missing screens NOW/);
  // Create drafts its own graph: the completeness checks run before its gate, in the reference
  // the orchestrator follows, and the renderer enforces the mechanical ones.
  const guide = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'screen-graph.md'), 'utf8');
  assert.match(guide.slice(guide.indexOf('## Before the gate')), /Every brief feature[\s\S]*list and a detail[\s\S]*`opens` target exists/);
});

test('missing screen graph context returns to approval instead of retrying specs', () => {
  const specsDispatch = section(createSkill, '### Step 9.0 — Record the preview', '### Step 9 —');
  assert.match(specsDispatch, /NEEDS_CONTEXT: graph missing[\s\S]*add the missing items to `\.tmp\/screens\.json`[\s\S]*screen graph gate again[\s\S]*before retrying specs/);
});
test('screen specs retries replace owned sections without changing the approved graph', () => {
  const write = section(screenPlanner, '**Write target by phase:**', 'Section format');
  assert.match(write, /replace[\s\S]*all prior copies/i);
  for (const heading of ['Per-Screen Specs', 'Open Questions', 'Open Questions for the User', 'Screen Graph', 'JavaScript Dependencies']) {
    assert.ok(write.includes(`### ${heading}`), `missing owned subsection: ${heading}`);
  }
  assert.match(write, /Navigation Pattern[\s\S]*Screen Map[\s\S]*Navigation Contracts[\s\S]*Shared\s+Conventions[\s\S]*unchanged/);
  assert.match(write, /one[\s\S]*Edit[\s\S]*Write/);
  assert.match(write, /omits an optional subsection[\s\S]*remove/i);
  assert.match(write, /at most one[\s\S]*outside[\s\S]*unchanged/);
  const preview = section(screenPlanner, '## Step 6', '**Otherwise (`skip_preview`');
  assert.match(preview, /same single[\s\S]*replacement/);
  assert.doesNotMatch(preview, /Then append the markdown block/);
  assert.doesNotMatch(screenPlanner, /only the append into `plan_path` is allowed/);
  const specsDispatch = section(createSkill, '### Step 9.0 — Record the preview', '### Step 9 —');
  assert.match(specsDispatch, /Replace only the specs-owned subsections/);
  assert.doesNotMatch(specsDispatch, /Append per-screen specs and Open Questions only/);
});

test('architecture result is validated before generic missing-context retry routing', () => {
  const routing = section(createSkill, '#### 10.0 — Architecture and Dataverse return signals',
    '**Data-model exact-name expansion:**');
  const special = routing.indexOf('**Architecture-gate result');
  const generic = routing.indexOf('For all other first lines');
  assert.ok(special >= 0 && generic > special);
  assert.match(routing, /Architecture phase: gate-only/);
  assert.match(routing, /approved-architecture\.md/);
  assert.match(routing, /does not consume the generic retry budget/);
  assert.match(routing, /mode must match/);
});

test('planner permissions allow required planning artifacts only in their owning phase', () => {
  const permissions = planner.slice(planner.indexOf('## Tool Permissions'));
  assert.match(permissions, /`gate-only`: write `\.tmp\/approved-architecture\.md` only after actual\s+architecture gate acceptance/);
  assert.match(permissions, /`complete`: fill the pending sections of `native-app-plan\.md`[\s\S]*\.tmp\/mobile-plan-status\.json/);
  assert.match(permissions, /normalization[\s\S]*\.tmp\/dataverse-schema-contract\.json/);
  assert.match(permissions, /No app source, app configuration, generated services/);
  assert.doesNotMatch(permissions, /`Write` only to create `native-app-plan\.md`/);
});

test('cross-entity reads come from the canonical plan and belong to the data model gate', () => {
  const audit = section(architect, '## Step 6a — Cross-entity Read Audit',
    '2. **Per entry, branch on');
  assert.match(audit, /mode: cross-entity-audit[\s\S]*native-app-plan\.md/);
  assert.match(audit, /graph-only scratch[\s\S]*not a substitute/);
  assert.doesNotMatch(architect, /addendum to (?:Gate 1|the architecture gate)|Gate 1 view/);
  // The create flow resolves cross-entity reads in its first pass, so the user approves one gate.
  assert.match(architect, /create flow does not need this second pass/);
});

test('architecture revalidates storage and native dependencies without silently dropping requirements', () => {
  const gate = section(planner, '### Architecture gate — Data Platform', '## Step 5 — Build Data Model');
  assert.match(gate, /Before accepting the architecture gate[\s\S]*revalidate every native capability/);
  assert.match(gate, /whenever either choice changes/);
  assert.match(gate, /`geolocation` requires Dataverse/);
  assert.match(gate, /One-shot `location` is not an automatic replacement/);
  assert.match(gate, /Do not silently remove capabilities/);
  assert.match(gate, /Write the approved artifact only after the compatible combination is accepted/);
  const capabilities = section(planner, 'Control planning gate:', '## Step 4 — Plan Connectors');
  assert.match(capabilities, /connector-owned storage[\s\S]*supported upload\/write operation/);
  assert.match(capabilities, /connector name alone is not a storage implementation/);
  assert.doesNotMatch(capabilities, /missing Dataverse storage for a persisted artifact/);
});

test('architecture owns connector confirmation without changing the shared standalone workflow', () => {
  const connectors = section(planner, '## Step 4 — Plan Connectors', '### Architecture gate — Data Platform');
  assert.match(connectors, /Skip its Step 2 standalone confirmation/);
  const shared = fs.readFileSync(path.join(pluginRoot, 'shared/references/connector-planning.md'), 'utf8');
  assert.match(shared, /## Step 2 — Present to User for Confirmation/);
  assert.match(shared, /present using `AskUserQuestion`/);
});

test('reuse-only apps retain a verified materialized inventory without replaying schema writes', () => {
  const addDataverse = fs.readFileSync(path.join(pluginRoot, 'skills/add-dataverse/SKILL.md'), 'utf8');
  const verification = section(addDataverse, '### Step 6c — Verify tables exist', '### Step 6d — Write');
  const materialized = section(addDataverse, '### Step 6d — Write', '### Step 7 — Inspect generated files');
  assert.match(verification, /every table in `SERVICE_REQUIRED_TABLES`, including reused-as-is tables/);
  assert.match(materialized, /reuse-only app must still have a populated manifest/);
  assert.match(materialized, /Include every service-required table[\s\S]*status: "reused"/);
  assert.match(materialized, /Exclude deferred or unverified tables/);
  assert.match(materialized, /not by replaying successful schema writes/);
  assert.match(materialized, /standard-system-table exclusions still apply/);
  assert.doesNotMatch(materialized, /Do NOT include tables reused/);

  const seeding = section(createSkill, '### Step 12.5 — Seed sample data', '### Offline profile');
  assert.ok(seeding.indexOf('Rebuild the local manifest') < seeding.indexOf('Invoke skill: /add-sample-data'));
  assert.match(seeding, /Zero schema writes is a valid reuse-only result/);
  assert.match(seeding, /service.requiredTables/);
  assert.match(seeding, /verify-dataverse-services\.js/);
  const offline = section(createSkill, '### Offline profile', '### Step 13 — Apply native capabilities');
  assert.match(offline, /including reused tables/);
  assert.match(offline, /read-only manifest\s+recovery in Step 12\.5/);
});

test('offline profile opt-in runs after Dataverse materialization and before native wiring', () => {
  assert.equal(createSkill.indexOf('### Step 6.85 — Offline profile'), -1);
  const sampleData = createSkill.indexOf('### Step 12.5 — Seed sample data');
  const offline = createSkill.indexOf('### Offline profile');
  const native = createSkill.indexOf('### Step 13 — Apply native capabilities');
  assert.ok(sampleData > 0 && sampleData < offline);
  assert.ok(offline < native);
  assert.match(createSkill, /→ \[Offline profile\] Asking whether/i);
  assert.doesNotMatch(createSkill, /Step 8\.6 — Offline profile/);
  assert.match(
    createSkill,
    /missing, malformed, or contains no Dataverse[\s\S]*BLOCKED: Dataverse materialization/i,
  );
});

test('the screen preview has exactly one filename, everywhere it is named', () => {
  const designSystem = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'design-system', 'SKILL.md'), 'utf8',
  );

  // `/create-mobile-app` extracts its carousel from this file and the build plan links it, so a
  // path that only some branches write leaves both empty. The default no-brand path wrote
  // `_design_preview.html`, and when that was corrected the message it prints was missed - the
  // user was handed a link to a file the run no longer creates.
  assert.doesNotMatch(designSystem, /_design_preview/,
    'the screen preview is _plan_preview.html on every path');

  // The path written and the path printed must be the same one.
  const written = [...designSystem.matchAll(/Write to `<working_dir>\/([a-z_.]+)`/g)].map((m) => m[1]);
  const printed = [...designSystem.matchAll(/preview ready at file:\/\/<working_dir>\/([a-z_.]+)/g)].map((m) => m[1]);
  assert.ok(written.length > 0 && printed.length > 0, 'the preview must be written and announced');
  assert.deepEqual([...new Set(written.concat(printed))], ['_plan_preview.html']);
});

test('no instruction promises a browser window during an orchestrated run', () => {
  const skill = createSkillWorkflow();
  // A create run opens exactly the build plan, which also hosts the live preview; the Step 2b preference
  // once told the agent that `visual_companion = yes` opens more - a directive it could follow.
  const preference = skill.split('\n').find((l) => l.startsWith('- `<visual_companion> = yes`'));
  assert.ok(preference, 'the preference must be defined');
  assert.doesNotMatch(preference, /automatically open/);
  assert.match(preference, /A create run opens exactly one browser surface, whatever this is set to:/);

  // `/preview-screens` honours this same flag, so the definition must not claim the flag is
  // irrelevant to the project.
  assert.doesNotMatch(preference, /governs only a later standalone/);
  assert.match(preference, /`\/preview-screens` wherever it runs/);

  // And every opener in the nested skill says which runs it applies to - including the style
  // picker's refinement loops, which "re-open" the preview after each hybrid, mix or reject.
  // These are instructions an agent follows, not a runtime branch, so one unqualified "open
  // browser" is enough to put a tab over the build plan. Lines about the plan page itself
  // ("its build plan open in the browser") describe it rather than open anything.
  const OPENER = /\bre-?open\b|\bopens? (the )?browser\b|\bopen (it )?in (the )?browser\b|\bopen the browser\b/i;
  for (const file of ['SKILL.md', path.join('references', 'vibe', 'style-picker.md')]) {
    const text = fs.readFileSync(path.resolve(__dirname, '..', '..', 'skills', 'design-system', file), 'utf8');
    const openers = text.split('\n').filter((l) => OPENER.test(l) && !/build plan open/.test(l));
    assert.ok(openers.length > 0, `${file}: the opener pattern no longer finds anything`);
    for (const line of openers) {
      assert.match(line, /standalone runs only/, `${file}: ungated opener: ${line.trim().slice(0, 70)}`);
    }
  }
});
