#!/usr/bin/env node

/**
 * app-docs.js — own the generated app's `docs/` folder.
 *
 * `/create-mobile-app` runs for 10-20 minutes across ~30 steps, and until now the only
 * record of what it did was scrollback. This writes a living plan to `<app>/docs/` that the
 * user can keep open while the run proceeds and come back to afterwards to understand how
 * their app was put together.
 *
 * Modelled on the power-pages `/create-site` HTML plan artifacts (see that plugin's
 * render scripts and their HTML assets). The template encoder is a physical port
 * at `lib/render-template.js`; the one behavioural change is that this document is
 * re-rendered in place on every update rather than written once.
 *
 * State lives in `docs/.run-plan.json`; the rendered page is `docs/create-app-plan.html`.
 * The JSON is the source of truth so a re-render never has to parse HTML back.
 *
 * Commands:
 *   init  --working-dir <d> --app-name <n> [--data-platform dataverse|connector-only]
 *   step  --working-dir <d> --id <phase-id> --status <pending|active|done|skipped|failed> [--note <t>]
 *   set   --working-dir <d> --section <name> --json <obj> | --json-file <path> [--state proposed|approved]
 *   phone --working-dir <d> --stage building|screens|qr [--screens-file <path>] [--qr-image <png>] [--qr-url <url>]
 *   show  --working-dir <d>
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readJson, writeJsonAtomic } = require('./lib/detached-worker');
const { renderTemplate } = require('./lib/render-template');

const DOCS_DIR = 'docs';
const STATE_FILE = '.run-plan.json';
const OUTPUT_FILE = 'create-app-plan.html';
const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'run-plan.html');

const STATUSES = new Set(['pending', 'active', 'done', 'skipped', 'failed']);

/**
 * Sections the skill records as it learns them. Each is written once by the step that owns
 * the decision, so the finished document explains not just what was built but what the user
 * chose and what environment it landed in.
 *
 *   environment   Step 1/4   resolved env, tenant, publisher prefix
 *   requirements  Step 2/2b  app identity, platforms, aesthetic, confirmed feature brief
 *   architecture  Gate 1     data platform, device capabilities, connectors - each with a reason
 *   offline       Gate 2     whether offline sync is on, which tables, and why
 *   dataModel     Gate 2     tables with reuse/extend/create intent + Mermaid ER source
 *   screens       Gates 3-4  navigation pattern, screen graph source, per-screen specs
 *   design        Step 6.75  direction, typography, palette
 *   auth          Step 7     whether an app registration was supplied or deferred
 */
const SECTIONS = new Set([
  'environment', 'requirements', 'architecture', 'dataModel', 'screens', 'design', 'auth',
  'offline', 'trust',
]);

/**
 * User-facing phases, not the skill's ~30 internal step numbers. A plan the user reads should
 * describe what is happening to their app, so several skill steps collapse into one row here.
 * `skillSteps` records the mapping so a maintainer can trace a phase back to the SKILL.md.
 */
const PHASES = [
  { id: 'setup', title: 'Set up the project', detail: 'Create the app folder and install dependencies', skillSteps: '2a' },
  { id: 'requirements', title: 'Understand what to build', detail: 'Confirm the feature brief', skillSteps: '2, 2b, 2c' },
  // Planning is approved before anything is scaffolded: the gates decide the data platform,
  // capabilities and screen set that Steps 5-6 then materialize. This list is the order the
  // user sees, so it has to match the order the skill runs, or a phase reads as complete
  // while phases above it are still pending.
  { id: 'architecture', title: 'Approve the architecture', detail: 'Device capabilities, connectors, and data platform', skillSteps: '3 / Gate 1' },
  { id: 'data-model', title: 'Design the data model', detail: 'Tables, columns, and relationships', skillSteps: '3 / Gate 2', dataverseOnly: true },
  { id: 'screen-plan', title: 'Plan the screens', detail: 'Screen graph, navigation, and per-screen specs', skillSteps: '3 / Gates 3-4' },
  { id: 'scaffold', title: 'Bring the app online', detail: 'Prepare the template and initialize the Power Apps project', skillSteps: '5, 6' },
  { id: 'design', title: 'Lock the design system', detail: 'Brand tokens, typography, and colour', skillSteps: '6.75, 9b' },
  { id: 'dataverse', title: 'Build the data model', detail: 'Create tables in Dataverse and generate services', skillSteps: '8, 8.5', dataverseOnly: true },
  { id: 'capabilities', title: 'Wire capabilities', detail: 'Device features and connectors', skillSteps: '9, 10' },
  { id: 'screens', title: 'Build the screens', detail: 'Navigation, shared code, and each screen', skillSteps: '10b, 10.8, 11' },
  { id: 'run', title: 'Run it on a device', detail: 'Start Metro and scan the QR code to open the app on your phone', skillSteps: '12, 13' },
];

function docsDir(projectRoot) {
  return path.join(path.resolve(projectRoot), DOCS_DIR);
}

function statePath(projectRoot) {
  return path.join(docsDir(projectRoot), STATE_FILE);
}

function outputPath(projectRoot) {
  return path.join(docsDir(projectRoot), OUTPUT_FILE);
}

function loadState(projectRoot) {
  return readJson(statePath(projectRoot));
}

function initState(projectRoot, { appName, dataPlatform }) {
  const existing = loadState(projectRoot);
  // A resumed run must not lose the progress already recorded.
  if (existing) return existing;

  return {
    appName: appName || 'Your app',
    dataPlatform: dataPlatform || 'unknown',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sections: {},
    phone: { stage: 'building', screens: [] },
    phases: PHASES.map((phase) => ({ ...phase, status: 'pending', note: '' })),
  };
}

const SECTION_STATES = new Set(['proposed', 'approved']);

const PHONE_STAGES = new Set(['building', 'screens', 'qr']);

/**
 * The device rail beside the plan. It moves through three stages as the run proceeds:
 *   building  an animation, from the first phase until the design is locked
 *   screens   a carousel of the plan-time screen previews `/design-system` renders at Step 4,
 *             which exist before any TSX is written
 *   qr        the Metro QR code, so the last thing the plan shows is how to open the real app
 */
function setPhone(state, update) {
  state.phone = state.phone || { stage: 'building', screens: [] };

  if (update.stage !== undefined) {
    if (!PHONE_STAGES.has(update.stage)) {
      throw new Error(`Unknown stage '${update.stage}'. Known: ${[...PHONE_STAGES].join(', ')}`);
    }
    state.phone.stage = update.stage;
  }
  if (update.screens !== undefined) state.phone.screens = update.screens;
  if (update.qrImage !== undefined) state.phone.qrImage = update.qrImage;
  if (update.qrHref !== undefined) state.phone.qrHref = update.qrHref;
  if (update.qrUrl !== undefined) state.phone.qrUrl = update.qrUrl;

  state.updatedAt = new Date().toISOString();
  return state;
}

function setSection(state, name, value, sectionState) {
  if (!SECTIONS.has(name)) {
    throw new Error(`Unknown section '${name}'. Known: ${[...SECTIONS].join(', ')}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Section '${name}' must be a JSON object`);
  }
  state.sections = state.sections || {};
  // Merge so a later step can add to a section without restating what an earlier one wrote
  // (for example Step 4 confirming the environment Step 1 resolved).
  state.sections[name] = { ...(state.sections[name] || {}), ...value };

  // A section is written when it is *proposed*, so the user can read the rendered ER or screen
  // graph while deciding, then flipped to `approved` once they say yes. Kept beside the content
  // rather than inside it so it cannot collide with a content key.
  if (sectionState !== undefined) {
    if (!SECTION_STATES.has(sectionState)) {
      throw new Error(`Unknown state '${sectionState}'. Known: ${[...SECTION_STATES].join(', ')}`);
    }
    state.sectionStates = state.sectionStates || {};
    state.sectionStates[name] = sectionState;
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

function applyStep(state, { id, status, note }) {
  const phase = state.phases.find((entry) => entry.id === id);
  if (!phase) {
    throw new Error(`Unknown phase '${id}'. Known: ${PHASES.map((p) => p.id).join(', ')}`);
  }
  if (!STATUSES.has(status)) {
    throw new Error(`Unknown status '${status}'. Known: ${[...STATUSES].join(', ')}`);
  }

  // A note describes the status it was written with, so it must not outlive it. A gate opens
  // with "Gate 1 — awaiting your approval" and is later closed by a bare `--status done`;
  // without this the approved step kept asking for an approval the user had already given.
  // A repeated status keeps its note, so progress updates like "3 of 12 screens built" survive
  // an `active` -> `active` refresh.
  if (note !== undefined) phase.note = String(note);
  else if (status !== phase.status) phase.note = '';
  phase.status = status;

  // Only one phase is the live one; marking a new phase active resolves any earlier
  // still-active phase so a crashed or skipped step cannot leave two spinners running.
  if (status === 'active') {
    for (const other of state.phases) {
      if (other.id !== id && other.status === 'active') other.status = 'done';
    }
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

const AWAITING_LABEL = {
  architecture: 'the architecture', dataModel: 'the data model', screens: 'the screen plan',
  design: 'the design system', offline: 'the offline profile', trust: 'the trust report',
};

function awaitingInput(state, active) {
  const states = state.sectionStates || {};
  for (const name of Object.keys(AWAITING_LABEL)) {
    if (states[name] === 'proposed') return `Review ${AWAITING_LABEL[name]} above, then answer in your terminal`;
  }
  if (active && /awaiting/i.test(active.note || '')) return active.note;
  return '';
}

function summarize(state) {
  const counted = state.phases.filter((phase) => phase.status !== 'skipped');
  const done = counted.filter((phase) => phase.status === 'done').length;
  const failed = state.phases.filter((phase) => phase.status === 'failed').length;
  const skipped = state.phases.filter((phase) => phase.status === 'skipped').length;
  const active = state.phases.find((phase) => phase.status === 'active');
  const finished = counted.length > 0 && done === counted.length;

  return {
    total: counted.length,
    done,
    failed,
    skipped,
    percent: counted.length === 0 ? 0 : Math.round((done / counted.length) * 100),
    currentTitle: active ? active.title : (finished ? 'Finished' : 'Waiting to start'),
    // The page reloads itself to pick up each rewrite; `settled` stops that once there is
    // nothing left to watch, so a finished plan is not reloading every five seconds forever.
    settled: finished || failed > 0,
    // What the run is blocked on, if anything. A section held at `proposed` means the plan is
    // showing the user something to review while the terminal waits on their answer; an active
    // phase whose note says so covers gates that have no section of their own.
    awaitingInput: awaitingInput(state, active),
    narrative: active
      ? `Currently ${active.title.toLowerCase()}. ${active.detail}.`
      : (finished
        ? `${state.appName} is built. Every phase completed.`
        : `Preparing to build ${state.appName}.`),
  };
}

/**
 * Short labels for the building animation. Uses the approved architecture once it exists so the
 * chips describe *this* app, and falls back to the platform's headline capabilities before then.
 */
function capabilityLabels(state) {
  const architecture = (state.sections || {}).architecture || {};
  const named = [...(architecture.nativeCapabilities || []), ...(architecture.connectors || [])]
    .map((entry) => (typeof entry === 'string' ? entry : (entry && entry.name)))
    .filter(Boolean);
  if (named.length) return named.slice(0, 6);
  return ['Dataverse', 'Works offline', 'Camera', 'Location', 'Push', 'Biometrics'];
}

// The full planner output, with the per-screen specs the tabs only summarise. It sits beside
// the app root and the plan is written into `docs/`, so one level up is the whole path.
const PLAN_DOC = 'native-app-plan.md';

// The full-size screen mockups `/design-system` renders. The carousel shows the same blocks in a
// phone frame; this is the link out to them at full width.
const SCREEN_PREVIEW = '_plan_preview.html';

// Both sit beside the app root and the plan is written into `docs/`, so one level up is the
// whole path. Linked only when really present: each is written partway through the run, so an
// unconditional link would 404 in the user's browser for the phases before it exists.
function siblingHref(projectRoot, fileName) {
  return fs.existsSync(path.join(path.resolve(projectRoot), fileName)) ? `../${fileName}` : '';
}

/**
 * An editor deep-link for a local file.
 *
 * A page opened over `file://` cannot hand a document to the OS default application - browsers
 * deliberately refuse, or any site could launch local apps. A registered URL scheme is the one
 * route that works, and `vscode://file/<path>` is the realistic target here: this plugin is used
 * from editors that register it. The plain relative link stays beside it for anyone without one.
 *
 * Path form per the VS Code URL handler: forward slashes throughout and a leading slash, so a
 * Windows `C:\app\plan.md` becomes `vscode://file/C:/app/plan.md`.
 * https://code.visualstudio.com/docs/configure/command-line#_opening-vs-code-with-urls
 */
function editorHref(projectRoot, fileName) {
  const absolute = path.join(path.resolve(projectRoot), fileName);
  if (!fs.existsSync(absolute)) return '';
  const forwardSlashed = absolute.replace(/\\/g, '/');
  const rooted = forwardSlashed.startsWith('/') ? forwardSlashed : `/${forwardSlashed}`;
  // encodeURI, not encodeURIComponent: the separators must survive as separators.
  return `vscode://file${encodeURI(rooted)}`;
}

function render(projectRoot, state) {
  const summary = summarize(state);
  summary.planDocHref = siblingHref(projectRoot, PLAN_DOC);
  summary.planDocEditorHref = editorHref(projectRoot, PLAN_DOC);
  summary.screenPreviewHref = siblingHref(projectRoot, SCREEN_PREVIEW);
  return renderTemplate({
    templatePath: TEMPLATE_PATH,
    outputPath: outputPath(projectRoot),
    allowOverwrite: true,
    requiredKeys: ['APP_NAME', 'PHASES', 'SUMMARY', 'SECTIONS', 'SECTION_STATES', 'PHONE'],
    dataObject: {
      PLAN_TITLE: 'Mobile app build plan',
      APP_NAME: state.appName,
      GENERATED_AT: new Date().toISOString().replace('T', ' ').slice(0, 16),
      DATA_PLATFORM: state.dataPlatform,
      PHASES: state.phases,
      SUMMARY: summary,
      SECTIONS: state.sections || {},
      SECTION_STATES: state.sectionStates || {},
      PHONE: state.phone || { stage: 'building', screens: [] },
      CAPABILITIES: capabilityLabels(state),
    },
  });
}

/**
 * Put the brand mark next to the rendered page so its `./power-apps-icon.svg` reference
 * resolves when the file is opened straight from disk. Best-effort, matching the sibling
 * power-pages behaviour: a missing icon must not fail a render.
 */
function copyBrandIcon(projectRoot) {
  const source = path.join(__dirname, '..', 'assets', 'power-apps-icon.svg');
  try {
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(docsDir(projectRoot), 'power-apps-icon.svg'));
    }
  } catch {
    // non-fatal
  }
}

function save(projectRoot, state) {
  fs.mkdirSync(docsDir(projectRoot), { recursive: true });
  writeJsonAtomic(statePath(projectRoot), state);
  copyBrandIcon(projectRoot);
  return render(projectRoot, state);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--working-dir') options.workingDir = argv[++index];
    else if (argument === '--app-name') options.appName = argv[++index];
    else if (argument === '--data-platform') options.dataPlatform = argv[++index];
    else if (argument === '--id') options.id = argv[++index];
    else if (argument === '--status') options.status = argv[++index];
    else if (argument === '--note') options.note = argv[++index];
    else if (argument === '--section') options.section = argv[++index];
    else if (argument === '--json') options.json = argv[++index];
    else if (argument === '--json-file') options.jsonFile = argv[++index];
    else if (argument === '--state') options.state = argv[++index];
    else if (argument === '--stage') options.stage = argv[++index];
    else if (argument === '--screens-file') options.screensFile = argv[++index];
    else if (argument === '--qr-image') options.qrImage = argv[++index];
    else if (argument === '--qr-url') options.qrUrl = argv[++index];
    else if (!argument.startsWith('--') && !options.command) options.command = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  options.workingDir = options.workingDir || process.cwd();
  options.command = options.command || 'show';
  if (!['init', 'step', 'show', 'set', 'phone'].includes(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const root = path.resolve(options.workingDir);

    if (options.command === 'show') {
      const state = loadState(root);
      process.stdout.write(`${JSON.stringify(state ? summarize(state) : { total: 0, done: 0 })}\n`);
    } else if (options.command === 'init') {
      const written = save(root, initState(root, options));
      process.stdout.write(`${JSON.stringify({ status: 'ok', plan: written })}\n`);
    } else if (options.command === 'phone') {
      const state = loadState(root);
      if (!state) throw new Error('No run plan yet; run `init` first.');
      const update = { stage: options.stage, qrUrl: options.qrUrl };
      if (options.screensFile) {
        update.screens = JSON.parse(fs.readFileSync(options.screensFile, 'utf8'));
      }
      if (options.qrImage) {
        // Inlined as a data URI: the plan is opened over file://, where a relative <img> works
        // but a moved or deleted PNG leaves a broken image in a document meant to outlive the run.
        update.qrImage = `data:image/png;base64,${fs.readFileSync(options.qrImage).toString('base64')}`;
        // A link to the file as well, for opening the code full size in its own tab. A data:
        // URI cannot be used for that - browsers block top-level navigation to one - so this
        // has to be a real path. It is relative to `docs/`, and disappears once `.expo/` is
        // cleaned, at which point the inlined copy above is still there.
        const qrPath = path.resolve(options.qrImage);
        const relative = path.relative(docsDir(root), qrPath);
        // POSIX separators: this becomes an href, not a filesystem path.
        update.qrHref = relative.split(path.sep).join('/');
      }
      const written = save(root, setPhone(state, update));
      process.stdout.write(`${JSON.stringify({ status: 'ok', stage: state.phone.stage, plan: written })}\n`);
    } else if (options.command === 'set') {
      const state = loadState(root);
      if (!state) throw new Error('No run plan yet; run `init` first.');
      // A large section (a full screen list, an ER diagram) is awkward and fragile to pass as
      // one shell argument, so --json-file is the route for anything non-trivial.
      const raw = options.jsonFile ? fs.readFileSync(options.jsonFile, 'utf8') : options.json;
      if (!raw) throw new Error('Provide --json <object> or --json-file <path>');
      const written = save(root, setSection(state, options.section, JSON.parse(raw), options.state));
      process.stdout.write(`${JSON.stringify({ status: 'ok', section: options.section, plan: written })}\n`);
    } else {
      const state = loadState(root);
      if (!state) throw new Error('No run plan yet; run `init` first.');
      const written = save(root, applyStep(state, options));
      process.stdout.write(`${JSON.stringify({ status: 'ok', plan: written, ...summarize(state) })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  DOCS_DIR,
  OUTPUT_FILE,
  PHASES,
  STATE_FILE,
  applyStep,
  copyBrandIcon,
  docsDir,
  initState,
  loadState,
  outputPath,
  render,
  save,
  SECTION_STATES,
  setPhone,
  setSection,
  summarize,
  PHONE_STAGES,
  SECTIONS,
};
