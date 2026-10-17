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
 *   init  --working-dir <d> --json-file <path>   ({"appName", "dataPlatform"}; the skill's route)
 *   init  --working-dir <d> --app-name <n> [--data-platform dataverse|connector-only]
 *   step  --working-dir <d> --id <phase-id> --status <pending|active|done|skipped|failed> [--note <t>]
 *   set   --working-dir <d> --section <name> --json <obj> | --json-file <path> [--state proposed|approved]
 *   phone --working-dir <d> --stage building|screens|qr [--preview-file <html> | --screens-file <json>] [--qr-image <png>] [--qr-url <url>]
 *   progress --working-dir <d> --json-file <path>
 *   sync --working-dir <d> --json-file <path>
 *   temp  --working-dir <d>
 *   show  --working-dir <d>
 */

'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { publishAtomic, renderTemplate } = require('./lib/render-template');

/**
 * The plan's state file is read by one process and rewritten by another as the run advances, so
 * it is published with a rename: a reader either sees the previous object or the next one, never
 * a half-written file.
 */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // A missing file and a truncated one are the same to a reader: no plan yet. Callers
    // distinguish the states from which files exist, not from parse failures.
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  publishAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const DOCS_DIR = 'docs';
const STATE_FILE = '.run-plan.json';
const OUTPUT_FILE = 'create-app-plan.html';
const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'run-plan.html');

const STATUSES = new Set(['pending', 'active', 'done', 'skipped', 'failed']);
const EDIT_ITEM_STATUSES = new Set(['pending', 'active', 'waiting', 'done', 'skipped', 'failed']);
const EDIT_PROGRESS_STATUSES = new Set(['active', 'waiting', 'done', 'failed']);

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
  { id: 'auth', title: 'Connect sign-in', detail: 'Entra ID app registration and MSAL config', skillSteps: '7' },
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

function editTempDir(projectRoot) {
  const projectHash = crypto.createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 16);
  const userNamespace = typeof process.getuid === 'function' ? `uid-${process.getuid()}` : 'user';
  return path.join(os.tmpdir(), `power-platform-mobile-app-${userNamespace}`, projectHash);
}

function ensurePrivateDirectory(directory) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing unsafe temporary directory: ${directory}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Temporary directory is owned by another user: ${directory}`);
  }

  // POSIX temp roots such as /tmp are shared between users. Restrict both the stable parent and
  // project namespace so separate CLI invocations can reuse them without exposing payloads.
  // Windows temp directories are already user-scoped, and its chmod mode bits are not POSIX ACLs.
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, 0o700);
    if ((fs.lstatSync(directory).mode & 0o077) !== 0) {
      throw new Error(`Temporary directory permissions are not private: ${directory}`);
    }
  }
}

function prepareEditTempDir(projectRoot) {
  const directory = editTempDir(projectRoot);
  ensurePrivateDirectory(path.dirname(directory));
  ensurePrivateDirectory(directory);
  return directory;
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
 *   screens   a carousel of the plan-time screen previews `/design-system` renders at Step 6.75,
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
  if (update.screens !== undefined) {
    state.phone.screens = update.screens;
    delete state.phone.previewHtml;
  }
  if (update.previewHtml !== undefined) {
    state.phone.previewHtml = update.previewHtml;
    state.phone.screens = [];
  }
  if (update.previewHref !== undefined) state.phone.previewHref = update.previewHref;
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
  // The note goes with the status, as above: a gate left open on "awaiting your approval"
  // would otherwise keep asking for it on a phase the plan now shows as done.
  if (status === 'active') {
    for (const other of state.phases) {
      if (other.id !== id && other.status === 'active') {
        other.status = 'done';
        other.note = '';
      }
    }
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

// Sections the user is actually asked to approve. `trust` is deliberately absent: it is written
// `proposed` at Gate 1 and only finalised at Step 10, but no gate asks the user to answer for it,
// so including it held the banner up for most of the run with no question to answer.
const AWAITING_LABEL = {
  architecture: 'the architecture', dataModel: 'the data model', screens: 'the screen plan',
  design: 'the design system', offline: 'the offline profile',
};

// An active phase announces it is blocked through its note. Both spellings are accepted because
// a gate writes "Gate 2 - awaiting your approval" while an ordinary question reads more naturally
// as "Waiting for your answers"; matching only the first missed every prompt that is not a gate.
const AWAITING_NOTE = /\bawaiting\b|\bwaiting for\b/i;

/**
 * `init` runs at Step 2b, before the data platform is decided, so the top-level value is
 * "unknown" and nothing updates it. Gate 1 records the real answer on the architecture section,
 * so read that once it exists and fall back to whatever `init` was given.
 */
function dataPlatformLabel(state) {
  const approved = ((state.sections || {}).architecture || {}).dataPlatform;
  if (approved) return approved;
  // The placeholder is internal; the pill is read as a fact about the app.
  return state.dataPlatform === 'unknown' ? 'not decided yet' : state.dataPlatform;
}

function failedTitle(state) {
  const failed = state.phases.find((phase) => phase.status === 'failed');
  return failed ? failed.title : '';
}

/**
 * What the run is blocked on, if anything.
 *
 * The active phase's note is the authority, because it is the only signal that distinguishes
 * "a question is open" from "work is in progress". A `proposed` section does not mean a question
 * is open: `screens` is proposed at Gate 3 and stays proposed until Step 3.9, so between Gate 3's
 * approval and Gate 4 the plan showed "Review the screen plan, then answer in your terminal"
 * while the planner was busy writing specs and nobody had been asked anything.
 *
 * A proposed section still raises the banner when the phase says nothing at all, so a gate that
 * forgets its note is not silent.
 */
function awaitingInput(state, active) {
  const note = (active && active.note) || '';
  if (AWAITING_NOTE.test(note)) return note;
  // A note that says something else is a progress report, not a question.
  if (note.trim()) return '';

  const states = state.sectionStates || {};
  for (const name of Object.keys(AWAITING_LABEL)) {
    if (states[name] === 'proposed') return `Review ${AWAITING_LABEL[name]} above, then answer in your terminal`;
  }
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
    currentTitle: failed > 0
      ? `Stopped — ${failedTitle(state) || 'a step failed'}`
      : (active ? active.title : (finished ? 'Finished' : 'Waiting to start')),
    // The page reloads itself to pick up each rewrite; `settled` stops that once there is
    // nothing left to watch, so a finished plan is not reloading forever.
    settled: finished || failed > 0,
    // The id, not the title: a resumed run reopens this phase with `step --id`, and that is what
    // takes the plan out of its stopped state.
    failedPhase: (state.phases.find((phase) => phase.status === 'failed') || {}).id || '',
    // What the run is blocked on, if anything. A section held at `proposed` means the plan is
    // showing the user something to review while the terminal waits on their answer; an active
    // phase whose note says so covers gates that have no section of their own.
    awaitingInput: awaitingInput(state, active),
    narrative: failed > 0
      ? `${state.appName} stopped during ${failedTitle(state) ? `"${failedTitle(state)}"` : 'a step'}. `
        + 'The run does not continue past a failed phase; check your terminal for the error.'
      : (active
        // Phase titles are imperatives ("Design the data model"), so they follow a label rather
        // than complete a sentence - "Currently design the data model" is what that produced.
        ? `In progress: ${active.title}. ${active.detail}.`
        : (finished
          ? `${state.appName} is built. Every phase completed.`
          : `Preparing to build ${state.appName}.`)),
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

// The full-size screen mockups `/design-system` renders at the app root. The carousel shows the
// same blocks in a phone frame; this is the link out to them at full width.
const SCREEN_PREVIEW = '_plan_preview.html';

// Linked only when really present: each is written partway through the run, so an unconditional
// link would 404 in the user's browser for the phases before it exists.

/** A file at the app root. The plan is written into `docs/`, so one level up is the whole path. */
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
  // encodeURI keeps `/` as a separator, which is what this needs, but it also leaves `?` and
  // `#` alone - and both are legal in a POSIX path. `/tmp/app#1/native-app-plan.md` would parse
  // as pathname `/tmp/app` with the rest as a fragment, so the editor opens nothing. Escape
  // those two afterwards; every other character encodeURI already handles. That includes a
  // literal `%` (`100% Done/` becomes `100%25%20Done/`), and because it is escaped first, the
  // `%` in the `%3F` and `%23` added here is never escaped a second time.
  const escaped = encodeURI(rooted).replace(/\?/g, '%3F').replace(/#/g, '%23');
  return `vscode://file${escaped}`;
}

function render(projectRoot, state) {
  const summary = summarize(state);
  const now = new Date();
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
      // Both forms: the page shows the reader's local time and keeps this UTC text as fallback.
      GENERATED_AT: now.toISOString().replace('T', ' ').slice(0, 16),
      GENERATED_ISO: now.toISOString(),
      DATA_PLATFORM: dataPlatformLabel(state),
      PHASES: state.phases,
      SUMMARY: summary,
      SECTIONS: state.sections || {},
      SECTION_STATES: state.sectionStates || {},
      PHONE: state.phone || { stage: 'building', screens: [] },
      CAPABILITIES: capabilityLabels(state),
      BRAND_ICON: brandIconDataUri(),
    },
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inlineJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  })[character]);
}

function normalizeEditItems(options) {
  const supplied = Array.isArray(options.items) ? options.items : null;
  const legacy = Array.isArray(options.checklist)
    ? options.checklist.map((label, index) => ({
      id: `item-${index + 1}`,
      label,
      status: index === 0 ? 'active' : 'pending',
    }))
    : null;
  const items = supplied || legacy || [
    { id: 'inspect', label: 'Inspect the current app', status: 'active' },
    { id: 'plan', label: 'Plan the requested changes', status: 'pending' },
    { id: 'apply', label: 'Apply the approved changes', status: 'pending' },
    { id: 'verify', label: 'Verify the edited app', status: 'pending' },
    { id: 'preview', label: 'Refresh the preview and app plan', status: 'pending' },
  ];
  const ids = new Set();

  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Progress item ${index + 1} must be an object.`);
    }
    const id = String(item.id || '').trim();
    const label = String(item.label || '').trim();
    const status = String(item.status || 'pending');
    if (!id || !label) throw new Error(`Progress item ${index + 1} requires id and label.`);
    if (ids.has(id)) throw new Error(`Duplicate progress item id '${id}'.`);
    if (!EDIT_ITEM_STATUSES.has(status)) {
      throw new Error(
        `Unknown progress item status '${status}'. Known: ${[...EDIT_ITEM_STATUSES].join(', ')}`,
      );
    }
    ids.add(id);
    return { id, label, status, note: item.note ? String(item.note) : '' };
  });
}

function reconcileCoarseEditItems(items, phase, status, waiting, supplied) {
  const coarseIds = ['inspect', 'plan', 'apply', 'verify', 'preview'];
  if (items.length !== coarseIds.length
    || items.some((item, index) => item.id !== coarseIds[index])) {
    return items;
  }

  // An explicit snapshot is authoritative, including skipped and failed rows. Phase inference is
  // only for the five-row fallback generated when the caller omits operation details.
  if (supplied) return items;

  // The five-row fallback combines finer workflow gates such as impact and approval into
  // "Plan". Agents may publish only the new top-level phase and omit a fresh items array; without
  // this reconciliation the fallback restarts at "Inspect" even though planning is already done.
  const phaseToItem = new Map([
    ['review', 'inspect'],
    ['inspect', 'inspect'],
    ['impact', 'plan'],
    ['planning', 'plan'],
    ['plan', 'plan'],
    ['approval', 'plan'],
    ['save-plan', 'apply'],
    ['implementation', 'apply'],
    ['apply', 'apply'],
    ['data', 'apply'],
    ['native', 'apply'],
    ['design', 'apply'],
    ['screens', 'apply'],
    ['verification', 'verify'],
    ['verify', 'verify'],
    ['preview', 'preview'],
    ['device', 'preview'],
    ['sync', 'preview'],
    ['sync-plan', 'preview'],
  ]);
  const currentId = phaseToItem.get(String(phase).toLowerCase());
  if (status === 'done') {
    return items.map((item) => ({ ...item, status: 'done' }));
  }
  if (!currentId) return items;

  const currentIndex = coarseIds.indexOf(currentId);
  if (status === 'failed') {
    return items.map((item, index) => ({
      ...item,
      status: index < currentIndex ? 'done'
        : index === currentIndex ? 'failed'
          : 'skipped',
    }));
  }
  return items.map((item, index) => ({
    ...item,
    status: index < currentIndex ? 'done'
      : index === currentIndex ? (waiting ? 'waiting' : 'active')
        : 'pending',
  }));
}

function normalizeEditChanges(options) {
  const changes = Array.isArray(options.changes) ? options.changes : [];
  return changes.map((change, index) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      throw new Error(`Edit change ${index + 1} must be an object.`);
    }
    const diagramInputs = [change, change.dataModel, change.screenGraph]
      .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
    if (diagramInputs.some(
      (value) => Object.hasOwn(value, 'diagram') || Object.hasOwn(value, 'mermaid'),
    )) {
      throw new Error(
        `Edit change ${index + 1} cannot carry raw diagram or Mermaid source; use structured data.`,
      );
    }
    const title = String(change.title || change.label || '').trim();
    if (!title) throw new Error(`Edit change ${index + 1} requires a title.`);
    const detail = change.detail ? String(change.detail) : '';
    const rationale = change.rationale ? String(change.rationale)
      : change.reason ? String(change.reason) : '';
    if (!rationale.trim()) throw new Error(`Edit change ${index + 1} requires a rationale.`);
    const kind = String(change.kind || '').trim().toLowerCase();
    if (!['general', 'data-model', 'screen'].includes(kind)) {
      throw new Error(
        `Edit change ${index + 1} requires kind general, data-model, or screen.`,
      );
    }
    const diagram = buildEditChangeDiagram(change, kind, index);
    return {
      title,
      detail,
      rationale: rationale.trim(),
      kind,
      diagram,
    };
  });
}

function safeMermaidName(value, fallback) {
  const source = value === undefined || value === null ? fallback : String(value);
  return source.replace(/[^A-Za-z0-9_]/g, '_') || fallback;
}

function uniqueMermaidName(value, fallback, usedNames) {
  const base = safeMermaidName(value, fallback);
  let candidate = base;
  let suffix = 2;
  // Mermaid merges nodes that share an ID, while normalization can map distinct routes or table
  // names to the same token. Preserve the original-value lookup and disambiguate only the ID.
  while (usedNames.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

// Mermaid labels are always emitted inside a quoted string here (`["..."]`,
// `|"..."|`, `: "..."`), so the characters below are escaped with Mermaid's
// decimal entity codes rather than dropped. Stripping them silently rewrote the
// text the user reads: Expo dynamic routes are the common case in this plugin,
// and `/inspections/[id]` came out as `/inspections/ id`.
// `#` is escaped too, and in the same pass, so a literal `#` already in the
// source cannot combine with a code emitted after it.
// See: https://mermaid.js.org/syntax/flowchart.html#entity-codes-to-escape-characters
const MERMAID_LABEL_ESCAPES = {
  '#': '#35;',
  '"': '#quot;',
  '[': '#91;',
  ']': '#93;',
  '{': '#123;',
  '}': '#125;',
  '<': '#60;',
  '>': '#62;',
  '|': '#124;',
};

function safeMermaidLabel(value, fallback = '') {
  const source = value === undefined || value === null ? fallback : String(value);
  const escaped = source
    .replace(/[#"[\]{}<>|]/g, (character) => MERMAID_LABEL_ESCAPES[character])
    .replace(/\s+/g, ' ')
    .trim();
  return escaped || fallback;
}

function relationshipConnector(cardinality) {
  const normalized = String(cardinality || 'one-to-many').toLowerCase();
  const connectors = {
    'one-to-many': '||--o{',
    'many-to-one': '}o--||',
    'one-to-one': '||--||',
    'many-to-many': '}o--o{',
    'optional-to-many': 'o|--o{',
  };
  if (!Object.hasOwn(connectors, normalized)) {
    throw new Error(`Unknown data-model relationship cardinality '${cardinality}'.`);
  }
  return connectors[normalized];
}

function buildDataModelDiagram(change, index) {
  const model = change.dataModel && typeof change.dataModel === 'object'
    ? change.dataModel
    : change;
  const tables = Array.isArray(model.tables) ? model.tables : [];
  if (!tables.length) {
    throw new Error(`Data-model edit change ${index + 1} requires tables.`);
  }
  const ids = new Map();
  const usedNames = new Set();
  const tableLines = tables.map((table, tableIndex) => {
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      throw new Error(`Data-model table ${tableIndex + 1} must be an object.`);
    }
    const name = String(table.name || table.logicalName || '').trim();
    if (!name) throw new Error(`Data-model table ${tableIndex + 1} requires a name.`);
    const id = uniqueMermaidName(name, `Entity${tableIndex + 1}`, usedNames);
    [name, table.logicalName, table.id].filter(Boolean).forEach((key) => ids.set(String(key), id));
    const columns = Array.isArray(table.columns) ? table.columns
      : Array.isArray(table.fields) ? table.fields : [];
    const columnLines = columns.map((column, columnIndex) => {
      const value = column && typeof column === 'object' ? column : { name: column };
      const columnName = safeMermaidName(
        value.name || value.logicalName,
        `field${columnIndex + 1}`,
      );
      const type = safeMermaidName(value.type || value.dataType || 'string', 'string');
      const key = value.primaryKey ? ' PK' : value.foreignKey ? ' FK' : '';
      return `    ${type} ${columnName}${key}`;
    });
    return `  ${id} {\n${columnLines.join('\n')}\n  }`;
  });
  const relationships = Array.isArray(model.relationships) ? model.relationships : [];
  const relationshipLines = relationships.map((relationship, relationshipIndex) => {
    if (!relationship || typeof relationship !== 'object' || Array.isArray(relationship)) {
      throw new Error(`Data-model relationship ${relationshipIndex + 1} must be an object.`);
    }
    const from = ids.get(String(relationship.from || relationship.parent || ''));
    const to = ids.get(String(relationship.to || relationship.child || ''));
    if (!from || !to) {
      throw new Error(
        `Data-model relationship ${relationshipIndex + 1} must reference declared tables.`,
      );
    }
    const label = safeMermaidLabel(
      relationship.label || relationship.name || 'relates to',
      'relates to',
    );
    return `  ${from} ${relationshipConnector(relationship.cardinality)} ${to} : "${label}"`;
  });
  return `erDiagram\n${tableLines.concat(relationshipLines).join('\n')}`;
}

function buildScreenDiagram(change, index) {
  const graph = change.screenGraph && typeof change.screenGraph === 'object'
    ? change.screenGraph
    : change;
  const screens = Array.isArray(graph.screens) ? graph.screens : [];
  if (!screens.length) throw new Error(`Screen edit change ${index + 1} requires screens.`);
  const ids = new Map();
  const usedNames = new Set();
  const nodes = screens.map((screen, screenIndex) => {
    const value = screen && typeof screen === 'object' ? screen : { name: screen };
    const name = String(value.name || value.title || value.route || '').trim();
    if (!name) throw new Error(`Screen ${screenIndex + 1} requires a name or route.`);
    const id = uniqueMermaidName(
      `S_${value.id || value.route || name}`,
      `S_${screenIndex + 1}`,
      usedNames,
    );
    [value.id, value.route, name].filter(Boolean).forEach((key) => ids.set(String(key), id));
    const route = value.route && value.route !== name
      ? ` · ${safeMermaidLabel(value.route)}`
      : '';
    return `  ${id}["${safeMermaidLabel(name)}${route}"]`;
  });
  const edges = Array.isArray(graph.edges) ? graph.edges
    : Array.isArray(graph.navigation) ? graph.navigation : [];
  if (screens.length > 1 && !edges.length) {
    throw new Error(
      `Screen edit change ${index + 1} requires navigation edges for multiple screens.`,
    );
  }
  const links = edges.map((edge, edgeIndex) => {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
      throw new Error(`Screen navigation edge ${edgeIndex + 1} must be an object.`);
    }
    const from = ids.get(String(edge.from || ''));
    const to = ids.get(String(edge.to || ''));
    if (!from || !to) {
      throw new Error(`Screen navigation edge ${edgeIndex + 1} must reference declared screens.`);
    }
    const label = safeMermaidLabel(edge.label || edge.action || '');
    return label ? `  ${from} -->|"${label}"| ${to}` : `  ${from} --> ${to}`;
  });
  return `flowchart LR\n${nodes.concat(links).join('\n')}`;
}

function buildEditChangeDiagram(change, kind, index) {
  if (kind === 'data-model') return buildDataModelDiagram(change, index);
  if (kind === 'screen') return buildScreenDiagram(change, index);
  if (change.dataModel || change.screenGraph || change.tables || change.screens) {
    throw new Error(
      `General edit change ${index + 1} cannot carry data-model or screen graph data.`,
    );
  }
  return '';
}

function writeEditProgress(projectRoot, options = {}) {
  const phase = options.phase || 'review';
  const note = options.note || 'Working on the approved change';
  const waiting = Boolean(options.waiting);
  const status = options.status || (waiting ? 'waiting' : 'active');
  if (!EDIT_PROGRESS_STATUSES.has(status)) {
    throw new Error(
      `Unknown edit progress status '${status}'. Known: ${[...EDIT_PROGRESS_STATUSES].join(', ')}`,
    );
  }
  const suppliedItems = Array.isArray(options.items) || Array.isArray(options.checklist);
  const items = reconcileCoarseEditItems(
    normalizeEditItems(options), phase, status, waiting, suppliedItems,
  );
  const changes = normalizeEditChanges(options);
  const completed = items.filter((item) => ['done', 'skipped'].includes(item.status)).length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const percent = items.length ? Math.round((completed / items.length) * 100) : 0;
  const settled = status === 'done' || status === 'failed';
  const activeItem = items.find((item) => ['active', 'waiting'].includes(item.status));
  const state = loadState(projectRoot);
  const appName = options.appName || (state && state.appName) || path.basename(path.resolve(projectRoot));
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const displayPhase = String(phase).replace(/[-_]+/g, ' ');
  const phasePill = displayPhase.toLowerCase() === status.toLowerCase()
    ? ''
    : `<span class="pill pill-phase">${escapeHtml(displayPhase)}</span>`;
  const nonce = crypto.randomBytes(16).toString('base64');
  const phone = state && state.phone && typeof state.phone === 'object' ? state.phone : {};
  const qrImage = status === 'done'
    && options.devicePreviewReady === true
    && phone.stage === 'qr'
    && typeof phone.qrImage === 'string'
    && phone.qrImage.startsWith('data:image/png;base64,')
    ? phone.qrImage
    : '';
  const qrUrl = qrImage && typeof phone.qrUrl === 'string' ? phone.qrUrl : '';
  const previewHtml = !settled
    && phone.stage === 'screens'
    && typeof phone.previewHtml === 'string'
    ? phone.previewHtml
    : '';
  const previewPath = typeof phone.previewHref === 'string'
    ? path.resolve(docsDir(projectRoot), phone.previewHref)
    : path.resolve(projectRoot, 'preview.html');
  const previewHref = fs.existsSync(previewPath) ? pathToFileURL(previewPath).href : '';
  const qrHref = qrImage && typeof phone.qrHref === 'string'
    ? pathToFileURL(path.resolve(docsDir(projectRoot), phone.qrHref)).href
    : '';
  const activeId = activeItem && activeItem.id;
  const deviceProgress = activeId === 'preview'
    ? {
      title: 'Refreshing your preview',
      copy: 'The live preview and app plan are being updated.',
    }
    : activeId === 'verify'
      ? {
        title: 'Verifying your changes',
        copy: 'The edited app is being checked before the preview is refreshed.',
      }
      : ['apply', 'data', 'native', 'design', 'screens'].includes(activeId)
        ? {
          title: 'Applying your changes',
          copy: 'The approved edits are being written to the app.',
        }
        : ['plan', 'impact', 'approve'].includes(activeId)
          ? {
            title: waiting ? 'Waiting for approval' : 'Planning your changes',
            copy: waiting
              ? 'The preview will update after you approve the proposed edit.'
              : 'The requested edit is being turned into an implementation plan.',
          }
          : {
            title: 'Inspecting your app',
            copy: 'The current app is being inspected before changes are planned.',
          };
  const deviceContent = qrImage
    ? `<div class="device-qr"><img src="${escapeHtml(qrImage)}" alt="Metro QR code" />`
      + `<div class="device-title">Scan to test the changes</div>`
      + `<div class="device-copy">Open Power Apps Mobile Preview and scan this code. `
      + `Your phone and this machine need to be on the same network.</div>`
      + `${qrUrl ? `<div class="device-url">${escapeHtml(qrUrl)}</div>` : ''}</div>`
    : previewHtml
      ? `<div class="device-carousel"><div class="device-carousel-frame">`
        + `<iframe id="devicePreviewFrame" sandbox="" referrerpolicy="no-referrer" `
        + `title="Screen preview"></iframe></div></div>`
      : `<div class="device-building${status === 'failed' ? ' device-failed' : ''}">`
      + `<div class="device-orbit"><span></span><span></span>`
      + `<img src="${brandIconDataUri()}" alt="" /></div>`
      + `<div class="device-title">${status === 'failed' ? 'Edit stopped' : status === 'done'
        ? 'Device preview unavailable' : deviceProgress.title}</div>`
      + `<div class="device-copy">${status === 'failed'
        ? 'Resolve the failed step before testing this edit on a device.'
        : status === 'done'
          ? 'Metro did not provide a QR code. Run the app preview to test this edit on a device.'
          : deviceProgress.copy}</div>`
        + `<div class="device-progress"><span style="width:${percent}%"></span></div></div>`;
  const deviceCaption = qrImage
    ? 'Edits hot-reload onto the device while Metro is running.'
    : status === 'done'
      ? 'The edit is complete, but no active device preview was found.'
      : status === 'failed'
        ? 'No device preview was started.'
        : activeId === 'preview'
          ? 'The phone switches to the live QR code when the preview is ready.'
          : activeId === 'verify'
            ? 'The phone switches to the live QR code after verification.'
            : previewHtml
              ? 'Plan-time screen preview'
              : 'The phone preview follows the current edit step.';
  const previewLink = previewHref
    ? `<a class="rail-link" href="${escapeHtml(previewHref)}" target="_blank" rel="noopener">`
      + `Open screens full size &#8599;</a>`
    : '';
  const qrLink = qrHref
    ? `<a class="rail-link" href="${escapeHtml(qrHref)}" target="_blank" rel="noopener">`
      + `Open QR code full size &#8599;</a>`
    : '';
  const storeButtons = qrImage
    ? `<div class="store-row" aria-label="Download Power Apps Mobile Preview">`
      + `<a class="store-btn" href="https://apps.apple.com/app/id6753083462" target="_blank" `
      + `rel="noopener noreferrer"><span class="store-kicker">Download on the</span>`
      + `<strong>App Store</strong></a>`
      + `<a class="store-btn" href="https://play.google.com/store/apps/details?id=com.microsoft.PreviewApp" `
      + `target="_blank" rel="noopener noreferrer"><span class="store-kicker">GET IT ON</span>`
      + `<strong>Google Play</strong></a></div>`
    : '';

  const filePath = path.join(prepareEditTempDir(projectRoot), 'edit-app-progress.html');

  const rows = items.map((item) => {
    const itemNote = item.note ? `<span class="item-note">${escapeHtml(item.note)}</span>` : '';
    return `  <li class="item ${escapeHtml(item.status)}" data-item-id="${escapeHtml(item.id)}">`
      + `<span class="bullet"></span><span class="item-copy"><span>${escapeHtml(item.label)}</span>`
      + `${itemNote}</span><span class="item-status">${escapeHtml(item.status)}</span></li>`;
  }).join('\n');

  const changeCards = changes.length
    ? changes.map((change) => {
      const detail = change.detail
        ? `<div class="change-detail">${escapeHtml(change.detail)}</div>`
        : '';
      const rationale = change.rationale
        ? `<div class="change-rationale"><strong>Why this matters:</strong> ${escapeHtml(change.rationale)}</div>`
        : '';
      const diagram = change.diagram
        ? `<div class="diagram-block"><div class="diagram-title">`
          + `${change.kind === 'data-model' ? 'Proposed data model' : 'Proposed screen graph'}`
          + `</div><div class="diagram-canvas" role="img" aria-label="`
          + `${change.kind === 'data-model' ? 'Proposed data model diagram' : 'Proposed screen navigation graph'}"></div>`
          + `<div class="diagram-fallback-note">The interactive diagram could not be rendered.</div>`
          + `<details class="diagram-source"><summary>View diagram source</summary>`
          + `<pre>${escapeHtml(change.diagram)}</pre></details></div>`
        : '';
      const kindLabel = change.kind ? `<span class="change-kind">${escapeHtml(change.kind)}</span>` : '';
      return `<article class="change-card"><span class="change-mark"></span><div>`
        + `<div class="change-header"><div class="change-title">${escapeHtml(change.title)}</div>${kindLabel}</div>`
        + `${detail}${rationale}${diagram}</div></article>`;
    }).join('\n')
    : `<div class="empty">Planned changes will appear here after the current app has been inspected.</div>`;
  // Mirror the create-app plan: a small floating pill pinned to the top-right rather than a
  // full-width bar. The answer is wanted in the terminal, so the page only needs a persistent
  // marker that survives a tab switch, not a banner that displaces the content.
  const waitingPrompt = waiting ? (note || 'Review the proposed changes or provide the missing details.') : '';
  const waitingBanner = waiting
    ? `<div class="input-banner" id="inputBanner" role="status" data-prompt="${escapeHtml(waitingPrompt)}">`
      + `<span class="input-banner-icon">&#9679;</span>`
      + `<div class="input-banner-text"><b>Waiting for your input</b>`
      + `<small>${escapeHtml(waitingPrompt)}</small></div>`
      + `<button type="button" class="input-banner-close" id="inputBannerClose" aria-label="Dismiss">&times;</button>`
      + `</div>`
    : '';
  const autoRefresh = settled ? '' : `
    var RELOAD_MS = 2500;
    var QUIET_MS = 10000;
    var lastInteraction = 0;
    ['scroll', 'keydown', 'pointerdown'].forEach(function (event) {
      window.addEventListener(event, function () { lastInteraction = Date.now(); }, { passive: true });
    });
    setInterval(function () {
      if (document.hidden || Date.now() - lastInteraction < QUIET_MS) return;
      try { sessionStorage.setItem(STORE_SCROLL, String(window.scrollY)); } catch (error) { /* private mode */ }
      var fresh = location.href.split('#')[0].split('?')[0] + '?t=' + Date.now();
      location.replace(fresh);
    }, RELOAD_MS);`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none';" />
  <title>Mobile app edit plan - ${escapeHtml(appName)}</title>
  <script nonce="${nonce}"
          src="https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js"
          integrity="sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2"
          crossorigin="anonymous"></script>
  <style>
    :root {
      --bg:#faf9f8; --surface:#fff; --surface2:#f3f2f1; --border:#e1dfdd;
      --border-light:#c8c6c4; --text:#323130; --text-dim:#605e5c; --text-bright:#201f1e;
      --accent:#0078d4; --accent-bg:#0078d40a; --accent-border:#0078d425;
      --pass:#107c10; --pass-bg:#107c100a; --pass-border:#107c1020;
      --warn:#ca5010; --warn-bg:#ca50100a; --warn-border:#ca501020;
      --fail:#a4262c; --fail-bg:#a4262c0a; --fail-border:#a4262c20;
      --footer-h:38px; --radius:8px;
      --shadow:0 1.6px 3.6px rgba(0,0,0,.132),0 .3px .9px rgba(0,0,0,.108);
      --sans:'Segoe UI','Segoe UI Web (West European)',-apple-system,system-ui,sans-serif;
    }
    *{box-sizing:border-box;}
    body{font-family:var(--sans);margin:0;background:var(--bg);color:var(--text);font-size:14px;line-height:1.6;padding-bottom:var(--footer-h);}
    button{font:inherit;}
    .topbar{position:sticky;top:0;z-index:10;background:var(--surface);box-shadow:var(--shadow);padding:14px 28px;display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;}
    .topbar-left{display:flex;align-items:center;gap:14px;min-width:0;}
    .logo{width:36px;height:36px;object-fit:contain;display:block;flex-shrink:0;}
    .topbar-title{font-size:16px;font-weight:700;color:var(--text-bright);}
    .topbar-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--text-dim);}
    .topbar-sep{opacity:.5;}
    .topbar-right{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
    .pill{font-size:11px;padding:4px 10px;border-radius:999px;font-weight:600;letter-spacing:.2px;border:1px solid var(--border);color:var(--text-dim);background:var(--surface2);}
    .pill-phase{background:var(--accent-bg);color:var(--accent);border-color:var(--accent-border);text-transform:capitalize;}
    .pill-done{background:var(--pass-bg);color:var(--pass);border-color:var(--pass-border);}
    .pill-failed{background:var(--fail-bg);color:var(--fail);border-color:var(--fail-border);}
    .shell{display:flex;align-items:flex-start;}
    .layout{display:flex;min-height:calc(100vh - var(--topbar-h, 65px) - var(--footer-h));flex:1;min-width:0;}
    .sidebar{width:240px;flex-shrink:0;background:var(--surface);border-right:1px solid var(--border);padding:20px 0;}
    .nav-label{font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.2px;padding:16px 22px 6px;}
    .nav-btn{display:flex;align-items:center;gap:10px;width:100%;padding:11px 22px;background:none;border:0;border-left:2px solid transparent;color:var(--text-dim);font-size:13px;font-weight:500;cursor:pointer;text-align:left;}
    .nav-btn:hover{color:var(--text);background:var(--surface2);}
    .nav-btn:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;}
    .nav-btn.active{color:var(--accent);font-weight:600;border-left-color:var(--accent);background:var(--accent-bg);}
    .nav-icon{font-size:15px;opacity:.55;width:18px;text-align:center;}
    .content{flex:1;min-width:0;max-width:960px;padding:32px 40px 72px;}
    .section{display:none;}
    .section.active{display:block;}
    h1{font-size:26px;line-height:1.2;letter-spacing:-.3px;margin:0 0 6px;color:var(--text-bright);}
    .section-desc{font-size:13px;color:var(--text-dim);margin-bottom:22px;max-width:72ch;}
    .summary{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px;margin-bottom:22px;box-shadow:var(--shadow);}
    .note{font-size:16px;line-height:1.55;color:var(--text-bright);}
    .status-line{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text-dim);margin-top:16px;}
    .progress-track{height:6px;overflow:hidden;border-radius:999px;background:var(--surface2);border:1px solid var(--border);margin-top:9px;}
    .progress-bar{display:block;height:100%;background:var(--accent);width:${percent}%;}
    .input-banner{position:fixed;top:calc(var(--topbar-h, 65px) + 13px);right:24px;z-index:100;display:flex;align-items:center;gap:12px;background:#fff8f2;border:1px solid var(--warn-border);color:var(--warn);padding:12px 14px 12px 18px;border-radius:999px;font-size:13.5px;max-width:min(380px,calc(100vw - 48px));box-shadow:0 6px 20px rgba(0,0,0,.12);}
    .input-banner[hidden]{display:none;}
    .input-banner-icon{font-size:11px;flex-shrink:0;animation:bannerPulse 1.6s ease-in-out infinite;}
    .input-banner-text{line-height:1.35;flex:1;min-width:0;}
    .input-banner-text b{display:block;font-weight:650;}
    .input-banner-text small{display:block;font-size:12px;opacity:.85;margin-top:2px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .input-banner-close{width:24px;height:24px;border:0;border-radius:50%;background:rgba(202,80,16,.12);color:var(--warn);cursor:pointer;font-size:17px;line-height:1;flex-shrink:0;}
    .input-banner-close:hover{background:rgba(202,80,16,.22);}
    @keyframes bannerPulse{0%,100%{opacity:1;}50%{opacity:.35;}}
    .change-card{display:grid;grid-template-columns:18px 1fr;gap:12px;align-items:start;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:10px;box-shadow:var(--shadow);}
    .change-mark{width:10px;height:10px;border-radius:50%;background:var(--accent);margin-top:6px;}
    .change-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:3px;flex-wrap:wrap;}
    .change-title{font-weight:650;color:var(--text-bright);}
    .change-kind{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);background:var(--accent-bg);border:1px solid var(--accent-border);padding:2px 6px;border-radius:999px;}
    .change-detail{font-size:12.5px;color:var(--text-dim);margin-top:3px;}
    .change-rationale{font-size:12.4px;color:var(--text);margin-top:8px;padding:9px 11px;border:1px solid var(--accent-border);background:var(--accent-bg);border-radius:4px;}
    .change-rationale strong{color:var(--text-bright);}
    .diagram-block{margin-top:14px;padding-top:13px;border-top:1px solid var(--border);}
    .diagram-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin-bottom:8px;}
    .diagram-canvas{display:flex;justify-content:center;overflow:auto;min-height:90px;padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;}
    .diagram-canvas svg{max-width:100%;height:auto;}
    .diagram-source{margin-top:8px;font-size:11px;color:var(--text-dim);}
    .diagram-source summary{cursor:pointer;color:var(--accent);}
    .diagram-source pre{font-size:11px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px;white-space:pre-wrap;word-break:break-word;overflow-x:auto;color:var(--text-bright);}
    .diagram-fallback-note{display:none;margin-top:8px;color:var(--warn);font-size:12px;}
    .diagram-unavailable .diagram-fallback-note{display:block;}
    .empty{color:var(--text-dim);font-size:13px;padding:18px 20px;background:var(--surface);border:1px dashed var(--border);border-radius:var(--radius);}
    ul{list-style:none;padding:0;margin:0;}
    .item{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:12px;align-items:start;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:15px 18px;margin-bottom:10px;box-shadow:var(--shadow);}
    .bullet{width:16px;height:16px;border-radius:50%;border:2px solid var(--border-light);display:inline-block;margin-top:2px;}
    .item-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; }
    .item-note{color:var(--text-dim);font-size:12px;}
    .item-status{color:var(--text-dim);font-size:11px;text-transform:uppercase;font-weight:600;letter-spacing:.3px;white-space:nowrap;}
    .item.active{border-color:var(--accent-border);background:var(--accent-bg);}
    .item.active .bullet{border-color:var(--accent);border-right-color:transparent;animation:spin 1s linear infinite;}
    .item.waiting{border-color:var(--warn-border);background:var(--warn-bg);}
    .item.waiting .bullet{border-color:var(--warn);background:var(--warn);}
    .item.done .bullet{border-color:var(--pass);background:var(--pass);}
    .item.failed{border-color:var(--fail-border);background:var(--fail-bg);}
    .item.failed .bullet{border-color:var(--fail);background:var(--fail);}
    .item.active .item-copy>span:first-child,.item.waiting .item-copy>span:first-child{color:var(--text-bright);font-weight:650;}
    .item.done .item-copy>span:first-child{color:var(--pass);}
    .item.skipped{opacity:.6;}
    @keyframes spin{to{transform:rotate(360deg);}}
    .device-rail{width:420px;flex-shrink:0;position:sticky;top:var(--topbar-h, 65px);height:calc(100vh - var(--topbar-h, 65px) - var(--footer-h));display:flex;flex-direction:column;align-items:center;justify-content:safe center;gap:14px;padding:24px 20px;overflow-y:auto;border-left:1px solid var(--border);background:var(--surface);}
    .device-rail-label{font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.2px;}
    /* The phone gives up height before the other rail items. Below 360px the rail scrolls instead,
       because a smaller frame cannot keep the QR handoff readable. */
    .device{flex:0 1 620px;min-height:360px;max-height:620px;width:auto;max-width:calc(100vw - 44px);aspect-ratio:300/620;border-radius:40px;background:#1f1f1f;border:9px solid #2e2e2e;box-shadow:var(--shadow),0 18px 46px rgba(0,0,0,.22);position:relative;overflow:hidden;}
    .device-notch{position:absolute;top:0;left:50%;transform:translateX(-50%);width:118px;height:22px;background:#2e2e2e;border-radius:0 0 14px 14px;z-index:2;}
    .device-screen{position:absolute;inset:0;background:#faf9f8;overflow:hidden;container-type:size;}
    .device-building,.device-qr{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 26px;}
    .device-carousel,.device-carousel-frame{position:absolute;inset:0;overflow:hidden;background:#fff;}
    .device-carousel-frame iframe{position:absolute;width:375px;height:812px;border:0;transform-origin:top left;}
    .device-controls{width:300px;display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .device-controls[hidden]{display:none;}
    .carousel-btn{width:30px;height:30px;border-radius:50%;border:1px solid var(--border);background:var(--surface);color:var(--text-bright);font-size:18px;cursor:pointer;display:grid;place-items:center;box-shadow:var(--shadow);}
    .carousel-btn:disabled{opacity:.35;cursor:default;}
    .carousel-dots{display:flex;gap:5px;}
    .carousel-dot{width:6px;height:6px;border-radius:50%;background:var(--border-light);}
    .carousel-dot.on{background:var(--accent);}
    .device-building{gap:22px;}
    .device-orbit{position:relative;width:132px;height:132px;display:grid;place-items:center;}
    .device-orbit span{position:absolute;border:1px solid rgba(32,31,30,.14);border-radius:50%;animation:device-spin linear infinite;}
    .device-orbit span:first-child{width:96px;height:96px;animation-duration:9s;}
    .device-orbit span:nth-child(2){width:132px;height:132px;animation-duration:16s;animation-direction:reverse;border-style:dashed;}
    .device-orbit img{width:62px;height:62px;animation:device-float 4s ease-in-out infinite;}
    .device-failed .device-orbit span{border-color:var(--fail-border);animation-play-state:paused;}
    @keyframes device-spin{to{transform:rotate(360deg);}}
    @keyframes device-float{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}
    .device-title{font-size:16px;font-weight:700;color:var(--text-bright);}
    .device-copy{font-size:12.5px;color:var(--text-dim);line-height:1.55;}
    .device-progress{width:100%;height:4px;border-radius:4px;background:#eceaea;overflow:hidden;}
    .device-progress span{display:block;height:100%;background:var(--accent);}
    .device-qr{justify-content:safe center;gap:16px;background:#fff;padding:30px 22px 18px;}
    .device-qr img{flex:0 1 196px;min-height:84px;max-height:196px;width:auto;max-width:100%;aspect-ratio:1/1;object-fit:contain;}
    .device-url{font-family:'Cascadia Code','Consolas',monospace;font-size:11px;color:var(--accent);word-break:break-all;}
    .device-caption{font-size:12px;color:var(--text-dim);text-align:center;max-width:320px;min-height:38px;}
    .rail-actions{display:flex;flex-direction:column;align-items:center;gap:6px;max-width:100%;}
    .rail-link{display:inline-flex;align-items:center;font-size:12.5px;color:var(--accent);text-decoration:none;padding:6px 12px;border-radius:999px;border:1px solid transparent;}
    .rail-link:hover{border-color:var(--accent-border);background:var(--accent-bg);}
    .store-row{display:flex;gap:8px;justify-content:center;}
    .store-btn{display:flex;flex-direction:column;padding:7px 13px;border-radius:9px;background:#000;color:#fff;text-decoration:none;line-height:1.05;border:1px solid rgba(255,255,255,.22);min-width:122px;}
    .store-btn:hover{background:#141414;}
    .store-kicker{font-size:8.5px;letter-spacing:.03em;opacity:.9;}
    .store-btn strong{font-size:14px;font-weight:600;}
    @container (max-height:520px){.device-qr{gap:8px;padding:28px 12px 14px;}.device-qr .device-title{font-size:14px;}.device-qr .device-copy{font-size:11px;line-height:1.4;}.device-url{font-size:10px;}}
    .ai-footer{position:fixed;bottom:0;left:0;right:0;text-align:center;padding:10px;font-size:12px;color:var(--text-dim);border-top:1px solid var(--border);background:var(--surface);z-index:10;}
    @media(max-width:1180px){
      .shell{flex-direction:column;}
      .device-rail{width:100%;position:static;height:auto;border-left:0;border-top:1px solid var(--border);padding-bottom:72px;}
      .device{flex:none;height:auto;min-height:0;width:min(300px,calc(100vw - 44px));}
    }
    @media(max-width:720px){
      .topbar{padding:12px 16px;}
      .layout{flex-direction:column;}
      .sidebar{width:100%;display:flex;padding:8px;border-right:0;border-bottom:1px solid var(--border);position:sticky;top:64px;z-index:9;}
      .nav-label{display:none;}
      .nav-btn{width:auto;border-left:0;border-bottom:2px solid transparent;padding:10px 14px;}
      .nav-btn.active{border-left:0;border-bottom-color:var(--accent);}
      .content{padding:24px 18px 60px;}
      .topbar-right{width:100%;}
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <img class="logo" src="${brandIconDataUri()}" alt="Power Apps" />
      <div>
        <div class="topbar-title">Mobile app edit plan</div>
        <div class="topbar-sub">
          <span>${escapeHtml(appName)}</span><span class="topbar-sep">|</span>
          <span>Updated ${escapeHtml(generatedAt)} UTC</span>
        </div>
      </div>
    </div>
    <div class="topbar-right">
      ${phasePill}
      <span class="pill ${status === 'done' ? 'pill-done' : status === 'failed' ? 'pill-failed' : ''}">${escapeHtml(status)}</span>
      <span class="pill">${completed} of ${items.length} complete</span>
    </div>
  </header>
  ${waitingBanner}
  <div class="shell">
    <div class="layout">
      <nav class="sidebar" aria-label="Edit plan">
        <div class="nav-label">Edit plan</div>
        <button class="nav-btn active" type="button" role="tab" aria-selected="true" data-tab="changes"><span class="nav-icon">&#9998;</span> Changes</button>
        <button class="nav-btn" type="button" role="tab" aria-selected="false" data-tab="steps"><span class="nav-icon">&#9638;</span> Build steps</button>
      </nav>
      <main class="content">
        <section class="section active" id="tab-changes" role="tabpanel">
          <h1>Changes</h1>
          <div class="section-desc">The requested app updates and the activity currently in progress.</div>
          <div class="summary">
            <div class="note">${escapeHtml(note)}</div>
            <div class="status-line">
              <span>Current phase: <strong>${escapeHtml(displayPhase)}</strong></span>
              <span>${completed} of ${items.length} operations complete${failed ? `, ${failed} failed` : ''}</span>
            </div>
            <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
              <span class="progress-bar"></span>
            </div>
          </div>
          ${changeCards}
        </section>
        <section class="section" id="tab-steps" role="tabpanel" hidden>
          <h1>Build steps</h1>
          <div class="section-desc">Live progress for each operation in the approved edit plan.</div>
          <ul>${rows}</ul>
        </section>
      </main>
    </div>
    <aside class="device-rail${previewLink || qrLink || storeButtons ? ' has-actions' : ''}" aria-label="Device preview">
      <div class="device-rail-label">${qrImage ? 'Test the edited app' : previewHtml ? 'Your screens' : 'Device preview'}</div>
      <div class="device">
        <div class="device-notch"></div>
        <div class="device-screen">${deviceContent}</div>
      </div>
      <div class="device-controls" id="deviceControls" ${previewHtml ? '' : 'hidden'}>
        <button class="carousel-btn" id="previousScreen" type="button" aria-label="Previous screen">&#8249;</button>
        <div class="carousel-dots" id="screenDots"></div>
        <button class="carousel-btn" id="nextScreen" type="button" aria-label="Next screen">&#8250;</button>
      </div>
      <div class="device-caption" id="deviceCaption">${escapeHtml(deviceCaption)}</div>
      <div class="rail-actions">${previewLink}${qrLink}${storeButtons}</div>
    </aside>
  </div>
  <footer class="ai-footer">AI-generated content may be incorrect</footer>
  <script nonce="${nonce}">
  (function () {
    var phonePreviewHtml = ${inlineJson(previewHtml)};
    var STORE_TAB = 'mobile-edit-plan-tab';
    var STORE_SCROLL = 'mobile-edit-plan-scroll';
    // The page republishes itself every few seconds, so a dismissal held only in memory would
    // reappear on the next reload. Keying it to the prompt text means closing one gate's pill does
    // not suppress the next gate's.
    var STORE_DISMISSED = 'mobile-edit-plan-dismissed-prompt';
    var banner = document.getElementById('inputBanner');
    var bannerPrompt = banner ? banner.getAttribute('data-prompt') || '' : '';
    // The topbar wraps its pills onto a second row in a narrow window, so a fixed offset would
    // park the pill on top of them. Track the rendered height instead.
    function syncTopbarHeight() {
      var topbar = document.querySelector('.topbar');
      if (!topbar) return;
      document.documentElement.style.setProperty('--topbar-h', topbar.getBoundingClientRect().height + 'px');
    }
    syncTopbarHeight();
    window.addEventListener('resize', syncTopbarHeight, { passive: true });
    try {
      if (!bannerPrompt) {
        sessionStorage.removeItem(STORE_DISMISSED);
      } else if (banner && sessionStorage.getItem(STORE_DISMISSED) === bannerPrompt) {
        banner.hidden = true;
      }
    } catch (error) { /* private mode; the pill simply stays visible */ }
    if (banner) {
      document.getElementById('inputBannerClose').addEventListener('click', function () {
        banner.hidden = true;
        try { sessionStorage.setItem(STORE_DISMISSED, bannerPrompt); } catch (error) { /* private mode */ }
      });
    }
    var MOCKUP_BANNED_TAGS = ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE',
      'FORM', 'STYLE', 'ANIMATE', 'SET'];
    var MOCKUP_BANNED_URL = /^(javascript:|data:text\\/html)/i;
    function sanitizeMockup(markup, options) {
      var source = new DOMParser().parseFromString(String(markup || ''), 'text/html');
      Array.from(source.querySelectorAll('*')).forEach(function (node) {
        var tag = String(node.tagName || '').toUpperCase();
        if (MOCKUP_BANNED_TAGS.indexOf(tag) >= 0 && !(options.keepStyle && tag === 'STYLE')) {
          node.remove();
          return;
        }
        Array.from(node.attributes).forEach(function (attribute) {
          var name = attribute.name;
          var value = attribute.value.replace(/[\\u0000-\\u0020]/g, '');
          if (/^on/i.test(name)
            || (/^(href|xlink:href)$/i.test(name) && value.charAt(0) !== '#')
            || (/^(href|src|xlink:href|action|formaction)$/i.test(name)
              && MOCKUP_BANNED_URL.test(value))) {
            node.removeAttribute(name);
          }
        });
      });
      return source;
    }
    function previewScreens(markup) {
      var source = sanitizeMockup(markup, { keepStyle: true });
      var tabs = Array.from(source.querySelectorAll('[data-screen]'));
      return Array.from(source.querySelectorAll('.screen')).map(function (entry) {
        var root = source.documentElement.cloneNode(false);
        var head = document.createElement('head');
        source.querySelectorAll('style').forEach(function (style) {
          head.appendChild(style.cloneNode(true));
        });
        var body = source.body.cloneNode(false);
        var selected = entry.cloneNode(true);
        selected.classList.add('active');
        selected.removeAttribute('hidden');
        selected.style.setProperty('display', 'flex', 'important');
        for (var ancestor = entry.parentElement; ancestor && ancestor !== source.body;
          ancestor = ancestor.parentElement) {
          var wrapper = ancestor.cloneNode(false);
          wrapper.appendChild(selected);
          selected = wrapper;
        }
        body.appendChild(selected);
        root.appendChild(head);
        root.appendChild(body);
        var reset = document.createElement('style');
        reset.textContent = 'html,body{width:100%;height:100%;margin:0!important;padding:0!important;'
          + 'min-height:0!important;overflow:hidden}.phone{width:100%!important;height:100%!important;'
          + 'margin:0!important;padding:0!important;border:0!important;border-radius:0!important;'
          + 'box-shadow:none!important}.screen-wrap{border-radius:0!important}';
        head.appendChild(reset);
        var policy = document.createElement('meta');
        policy.setAttribute('http-equiv', 'Content-Security-Policy');
        policy.setAttribute('content', "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; "
          + "img-src data:; font-src data:; base-uri 'none'; form-action 'none'");
        head.prepend(policy);
        var tab = tabs.find(function (button) {
          return button.getAttribute('data-screen') === entry.id;
        });
        return {
          name: (tab && tab.textContent.trim()) || entry.getAttribute('data-name')
            || entry.getAttribute('aria-label') || entry.id,
          html: '<!DOCTYPE html>' + root.outerHTML
        };
      });
    }
    function renderScreenCarousel() {
      if (!phonePreviewHtml) return;
      var screens = previewScreens(phonePreviewHtml);
      // Older preview files can include the untouched template home route before the generated
      // app screens. Keep it only when it is the sole screen, otherwise it misrepresents the app.
      var appScreens = screens.filter(function (screen) {
        return !(screen.html.includes('Power Apps Standalone')
          && screen.html.includes('Build your first screen by connecting data sources'));
      });
      if (appScreens.length) screens = appScreens;
      var frame = document.querySelector('.device-carousel-frame');
      var viewport = document.getElementById('devicePreviewFrame');
      var caption = document.getElementById('deviceCaption');
      var controls = document.getElementById('deviceControls');
      if (!frame || !viewport || !screens.length) {
        if (caption) caption.textContent = 'Screen preview unavailable. Regenerate preview.html.';
        if (controls) controls.hidden = true;
        return;
      }
      var index = 0;
      var previous = document.getElementById('previousScreen');
      var next = document.getElementById('nextScreen');
      var dots = document.getElementById('screenDots');
      function fit() {
        var scale = Math.min(frame.clientWidth / 375, frame.clientHeight / 812);
        viewport.style.transform = 'scale(' + scale + ')';
        viewport.style.left = (frame.clientWidth - 375 * scale) / 2 + 'px';
        viewport.style.top = (frame.clientHeight - 812 * scale) / 2 + 'px';
      }
      function show(nextIndex) {
        index = Math.max(0, Math.min(screens.length - 1, nextIndex));
        viewport.title = screens[index].name || 'Screen preview';
        viewport.srcdoc = screens[index].html;
        caption.textContent = (screens[index].name ? screens[index].name + '  ·  ' : '')
          + (index + 1) + ' of ' + screens.length;
        previous.disabled = index === 0;
        next.disabled = index === screens.length - 1;
        dots.textContent = '';
        screens.forEach(function (unused, screenIndex) {
          var dot = document.createElement('span');
          dot.className = 'carousel-dot' + (screenIndex === index ? ' on' : '');
          dots.appendChild(dot);
        });
      }
      previous.addEventListener('click', function () { show(index - 1); });
      next.addEventListener('click', function () { show(index + 1); });
      fit();
      window.addEventListener('resize', fit, { passive: true });
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(frame);
      show(0);
    }
    renderScreenCarousel();
    var diagramBlocks = Array.from(document.querySelectorAll('.diagram-block'));
    function markDiagramUnavailable(block) {
      block.classList.add('diagram-unavailable');
    }
    if (diagramBlocks.length) {
      if (window.mermaid) {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: {
            primaryColor: '#f3f2f1',
            primaryTextColor: '#201f1e',
            primaryBorderColor: '#c8c6c4',
            lineColor: '#605e5c',
            tertiaryColor: '#ffffff',
            fontFamily: 'Segoe UI, sans-serif'
          }
        });
        diagramBlocks.forEach(function (block, index) {
          var canvas = block.querySelector('.diagram-canvas');
          var source = block.querySelector('.diagram-source pre').textContent;
          window.mermaid.render('editDiagram' + index, source).then(function (result) {
            // The source is derived from allowlisted structured fields and Mermaid runs in strict
            // security mode, so its SVG output is the only HTML admitted into this local page.
            canvas.innerHTML = result.svg;
          }).catch(function () {
            markDiagramUnavailable(block);
          });
        });
      } else {
        diagramBlocks.forEach(markDiagramUnavailable);
      }
    }
    function showTab(tab) {
      document.querySelectorAll('.nav-btn').forEach(function (button) {
        var selected = button.dataset.tab === tab;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', String(selected));
      });
      document.querySelectorAll('.section').forEach(function (section) {
        var selected = section.id === 'tab-' + tab;
        section.classList.toggle('active', selected);
        section.hidden = !selected;
      });
    }
    document.querySelectorAll('.nav-btn').forEach(function (button) {
      button.addEventListener('click', function () {
        showTab(button.dataset.tab);
        try { sessionStorage.setItem(STORE_TAB, button.dataset.tab); } catch (error) { /* private mode */ }
      });
    });
    window.addEventListener('beforeunload', function () {
      try { sessionStorage.setItem(STORE_SCROLL, String(window.scrollY)); } catch (error) { /* private mode */ }
    });
    try {
      var savedTab = sessionStorage.getItem(STORE_TAB);
      if (savedTab) showTab(savedTab);
      var savedScroll = Number(sessionStorage.getItem(STORE_SCROLL) || 0);
      if (savedScroll > 0) window.scrollTo(0, savedScroll);
    } catch (error) { /* sessionStorage unavailable; Changes stays selected */ }
    ${autoRefresh}
  }());
  </script>
</body>
</html>`;

  publishAtomic(filePath, html);
  return filePath;
}

function syncPlanToCurrentApp(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const existing = loadState(root);
  const sections = options.sections || (
    options.section && options.value !== undefined ? { [options.section]: options.value } : {}
  );
  const sectionEntries = Object.entries(sections);
  const requestedAppName = options.appName || (sections.requirements || {}).appName;
  const requestedDataPlatform = options.dataPlatform || (sections.architecture || {}).dataPlatform
    || (sections.requirements || {}).dataPlatform;
  if (!existing && sectionEntries.length === 0) {
    throw new Error('A missing plan requires structured current-app sections; refusing a generic shell.');
  }

  const state = existing || initState(root, {
    appName: requestedAppName || 'Your app',
    dataPlatform: requestedDataPlatform || 'unknown',
  });
  if (requestedAppName) state.appName = String(requestedAppName);
  if (requestedDataPlatform) state.dataPlatform = String(requestedDataPlatform);
  state.sections = state.sections || {};
  state.sectionStates = state.sectionStates || {};

  // Each supplied section is a current-state snapshot, not a patch. Replacing it is what lets an
  // edit remove a screen, connector, capability, or table instead of leaving stale rows behind.
  for (const [name, value] of sectionEntries) {
    if (!SECTIONS.has(name)) {
      throw new Error(`Unknown section '${name}'. Known: ${[...SECTIONS].join(', ')}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Section '${name}' must be a JSON object`);
    }
    state.sections[name] = value;
    const requestedState = (options.sectionStates || {})[name] || options.state || 'approved';
    if (!SECTION_STATES.has(requestedState)) {
      throw new Error(`Unknown state '${requestedState}'. Known: ${[...SECTION_STATES].join(', ')}`);
    }
    state.sectionStates[name] = requestedState;
  }

  if (!existing || options.inferred === true) {
    const requirements = state.sections.requirements || {};
    state.sections.requirements = {
      ...requirements,
      appName: requirements.appName || state.appName,
      dataPlatform: requirements.dataPlatform || state.dataPlatform,
      source: requirements.source || 'existing app state',
      inferred: true,
      summary: requirements.summary || options.summary
        || 'Plan inferred from existing app state because no prior create-run plan was present.',
    };
    state.sectionStates.requirements = 'approved';
  }

  if (!existing) {
    for (const phase of state.phases) {
      const notApplicable = state.dataPlatform === 'connector-only'
        && (phase.id === 'data-model' || phase.id === 'dataverse');
      phase.status = notApplicable ? 'skipped' : 'done';
      phase.note = notApplicable ? 'Not used by this app' : 'Inferred from the existing app';
    }
  }

  state.lastEdit = {
    summary: options.summary || '',
    syncedAt: new Date().toISOString(),
    sections: sectionEntries.map(([name]) => name),
  };
  state.updatedAt = new Date().toISOString();
  save(root, state);
  return outputPath(root);
}

/**
 * The brand mark as a `data:` URI.
 *
 * Inlined rather than copied beside the page for two reasons. The page is opened over `file://`,
 * where the origin is opaque, so a CSP `img-src 'self'` would not reliably match a sibling file -
 * and the plan carries a strict CSP precisely so injected mockup markup cannot fetch or execute
 * anything. It also makes the plan a single shareable file rather than a folder.
 */
function brandIconDataUri() {
  const source = path.join(__dirname, '..', 'assets', 'power-apps-icon.svg');
  try {
    return `data:image/svg+xml;base64,${fs.readFileSync(source).toString('base64')}`;
  } catch {
    // A missing mark must not fail a build; the page renders without it.
    return '';
  }
}

function save(projectRoot, state) {
  fs.mkdirSync(docsDir(projectRoot), { recursive: true });
  writeJsonAtomic(statePath(projectRoot), state);
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
    else if (argument === '--phase') options.phase = argv[++index];
    else if (argument === '--summary') options.summary = argv[++index];
    else if (argument === '--waiting') options.waiting = true;
    else if (argument === '--checklist') options.checklist = JSON.parse(argv[++index]);
    else if (argument === '--section') options.section = argv[++index];
    else if (argument === '--value') options.value = JSON.parse(argv[++index]);
    else if (argument === '--json') options.json = argv[++index];
    else if (argument === '--json-file') options.jsonFile = argv[++index];
    else if (argument === '--state') options.state = argv[++index];
    else if (argument === '--stage') options.stage = argv[++index];
    else if (argument === '--screens-file') options.screensFile = argv[++index];
    else if (argument === '--preview-file') {
      options.previewFile = argv[++index];
      if (!options.previewFile || options.previewFile.startsWith('--')) {
        throw new Error('--preview-file requires an HTML file path.');
      }
    }
    else if (argument === '--qr-image') options.qrImage = argv[++index];
    else if (argument === '--qr-url') options.qrUrl = argv[++index];
    else if (!argument.startsWith('--') && !options.command) options.command = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  options.workingDir = options.workingDir || process.cwd();
  options.command = options.command || 'show';
  if (!['init', 'step', 'show', 'set', 'phone', 'progress', 'sync', 'temp'].includes(options.command)) {
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
    } else if (options.command === 'temp') {
      const directory = prepareEditTempDir(root);
      process.stdout.write(`${JSON.stringify({
        directory,
        progress: path.join(directory, 'edit-app-progress.json'),
        progressHtml: path.join(directory, 'edit-app-progress.html'),
        sync: path.join(directory, 'app-plan-sync.json'),
      })}\n`);
    } else if (options.command === 'init') {
      // `--app-name` is the display name the user typed, so it may contain a quote, a backtick
      // or `$(...)`. Passed as a shell argument those break out of the quoting before Node ever
      // sees them, so the skill hands the name over in a file instead - the same channel every
      // section write uses. `--app-name`/`--data-platform` stay for callers whose values are
      // their own, such as tests and tooling.
      const seed = options.jsonFile
        ? JSON.parse(fs.readFileSync(options.jsonFile, 'utf8'))
        : options;
      const written = save(root, initState(root, seed));
      process.stdout.write(`${JSON.stringify({ status: 'ok', plan: written })}\n`);
    } else if (options.command === 'progress') {
      const payload = options.jsonFile
        ? JSON.parse(fs.readFileSync(options.jsonFile, 'utf8'))
        : {
        phase: options.phase,
        status: options.status,
        note: options.note,
        waiting: options.waiting,
        checklist: options.checklist,
        };
      const filePath = writeEditProgress(root, payload);
      process.stdout.write(`${JSON.stringify({ status: 'ok', file: filePath })}\n`);
    } else if (options.command === 'sync') {
      const payload = options.jsonFile
        ? JSON.parse(fs.readFileSync(options.jsonFile, 'utf8'))
        : {
        appName: options.appName,
        dataPlatform: options.dataPlatform,
        summary: options.summary,
        section: options.section,
        value: options.value,
        state: options.state,
        };
      const result = syncPlanToCurrentApp(root, payload);
      process.stdout.write(`${JSON.stringify({ status: 'ok', plan: result })}\n`);
    } else if (options.command === 'phone') {
      const state = loadState(root);
      if (!state) throw new Error('No run plan yet; run `init` first.');
      if (options.previewFile && options.screensFile) {
        throw new Error('Provide --preview-file or --screens-file, not both.');
      }
      const update = { stage: options.stage, qrUrl: options.qrUrl };
      if (options.previewFile) {
        // Retain the whole document: screen fragments alone lose shared CSS, root tokens,
        // and ancestor selectors. The page extracts each .screen inside an isolated viewport.
        update.previewHtml = fs.readFileSync(options.previewFile, 'utf8');
        if (!update.previewHtml.trim()) throw new Error('The screen preview HTML is empty.');
        const previewPath = path.resolve(options.previewFile);
        const relative = path.relative(docsDir(root), previewPath);
        // Keep the living plan portable with a relative link; the temp-hosted edit page converts
        // it back to a file URL because it does not share the project's directory.
        update.previewHref = relative.split(path.sep).join('/');
      }
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
  docsDir,
  editTempDir,
  prepareEditTempDir,
  initState,
  loadState,
  outputPath,
  render,
  save,
  SECTION_STATES,
  setPhone,
  setSection,
  summarize,
  syncPlanToCurrentApp,
  writeEditProgress,
  EDIT_ITEM_STATUSES,
  EDIT_PROGRESS_STATUSES,
  PHONE_STAGES,
  SECTIONS,
};
