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
 * State lives in `docs/.run-plan.json`; the rendered page is `docs/create-app-plan.html`, and
 * `docs/create-app-plan.version.js` beside it tells an open page whether it is stale.
 * The JSON is the source of truth so a re-render never has to parse HTML back.
 *
 * Commands:
 *   init  --working-dir <d> --json-file <path>   ({"appName", "dataPlatform"}; the skill's route)
 *   init  --working-dir <d> --app-name <n> [--data-platform dataverse|connector-only]
 *   step  --working-dir <d> --id <phase-id> --status <pending|active|done|skipped|failed> [--note <t>]
 *   set   --working-dir <d> --section <name> --json <obj> | --json-file <path> [--state proposed|approved]
 *   phone --working-dir <d> --stage building|live|screens|qr [--preview-url <http://localhost:port>]
 *         [--preview-file <html> | --screens-file <json>] [--qr-image <png>] [--qr-url <url>]
 *   show  --working-dir <d>
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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
// Beside the page: the open plan loads it to learn whether it is stale (see `render`).
const VERSION_FILE = 'create-app-plan.version.js';
const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'run-plan.html');

const STATUSES = new Set(['pending', 'active', 'done', 'skipped', 'failed']);

/**
 * Sections the skill records as it learns them. Each is written once by the step that owns
 * the decision, so the finished document explains not just what was built but what the user
 * chose and what environment it landed in.
 *
 *   environment   Steps 1/3                     resolved env, tenant, publisher prefix
 *   requirements  Steps 2/2b                    app identity, platforms, aesthetic, confirmed brief
 *   screens       screen graph gate (Step 4)    navigation pattern, screen graph source, per-screen specs
 *   design        Step 9                        direction, typography, palette
 *   architecture  architecture gate (Step 10)   data platform, device capabilities, connectors - each
 *                                               with a reason
 *   dataModel     data model gate (Step 10)     tables with reuse/extend/create intent + Mermaid ER source
 *   offline       data model gate (Step 10)     whether offline sync is on, which tables, and why
 *   auth          Step 11                       whether an app registration was supplied or deferred
 *   trust         architecture gate, Step 13    drafted from the approved architecture, finalised once
 *                                               the capabilities are wired
 */
const SECTIONS = new Set([
  'environment', 'requirements', 'architecture', 'dataModel', 'screens', 'design', 'auth',
  'offline', 'trust',
]);

/**
 * User-facing phases, not the skill's internal step numbers. A plan the user reads should
 * describe what is happening to their app, so several skill steps collapse into one row here.
 * `skillSteps` records the mapping so a maintainer can trace a phase back to the SKILL.md; a
 * gate is named rather than numbered, because gates are no longer a contiguous block.
 *
 * The run is preview-first: the app is scaffolded and its screens are built against sample data
 * straight after the screen graph gate, so the user can try it in a live web preview before the
 * design, architecture and data model are settled. Everything those later gates decide is then
 * wired in, and the last step before the device swaps the sample data for the real services.
 *
 * This list is the order the user sees, so it has to match the order the skill runs. If the two
 * drift, a phase reads as complete while phases above it are still pending.
 */
const PHASES = [
  { id: 'requirements', title: 'Understand what to build', detail: 'One setup question and the feature brief', skillSteps: '2, 2b' },
  { id: 'scaffold', title: 'Bring the app online', detail: 'Prepare the template and initialize the Power Apps project', skillSteps: '3' },
  { id: 'screen-plan', title: 'Plan the screens', detail: 'Screens, navigation, and the data each one shows', skillSteps: '4 / screen graph gate' },
  { id: 'screens', title: 'Build the screens', detail: 'Navigation, sample data, and every screen in parallel', skillSteps: '5, 6, 7' },
  { id: 'preview', title: 'Try the running app', detail: 'Live preview in the phone on this page, with sample data - confirm it or ask for changes', skillSteps: '8 / preview gate' },
  { id: 'design', title: 'Lock the design system', detail: 'Brand tokens, typography, and colour', skillSteps: '9' },
  { id: 'architecture', title: 'Approve the architecture', detail: 'Device capabilities, connectors, and data platform', skillSteps: '10 / architecture gate' },
  { id: 'data-model', title: 'Design the data model', detail: 'Tables, columns, and relationships', skillSteps: '10 / data model gate', dataverseOnly: true },
  { id: 'auth', title: 'Connect sign-in', detail: 'Entra ID app registration and MSAL config', skillSteps: '11' },
  { id: 'dataverse', title: 'Build the data model', detail: 'Create tables in Dataverse and generate services', skillSteps: '12', dataverseOnly: true },
  { id: 'capabilities', title: 'Wire capabilities', detail: 'Device features and connectors', skillSteps: '13' },
  { id: 'wiring', title: 'Connect real data', detail: 'Swap the sample data for Dataverse, connectors, and device features', skillSteps: '14' },
  { id: 'run', title: 'Run it on a device', detail: 'Final checks, then start Metro and scan the QR code', skillSteps: '15, 16, 17' },
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

const PHONE_STAGES = new Set(['building', 'live', 'screens', 'qr']);

// The only hosts the live preview may name. They are the same two the page's CSP `frame-src`
// admits, and the two lists must stay in step: a host accepted here but not there renders a
// blocked frame, and one admitted there but not here is a hole nothing uses.
const PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Validate the live-preview address and return it in one canonical form.
 *
 * The page embeds this URL in a frame, so it must only ever point at the local Expo web server
 * the skill started with `npx --no-install expo start` (for example `http://localhost:8082`). Keeping it
 * loopback-only stops the plan, which also carries the environment URL, tenant id and the whole
 * app plan, from framing arbitrary remote content. Anything else is refused rather than repaired:
 * a value that needs repairing did not come from the skill.
 *
 * The checks run on the parsed URL, never on the string. `http://localhost:8082@example.com/`
 * starts with the right prefix, but everything before `@` is userinfo and its host is
 * example.com. Parsing follows the WHATWG URL Standard, the same parser the browser uses:
 * https://url.spec.whatwg.org/#concept-basic-url-parser
 *
 * The result is rebuilt from the parsed host, port and path, so nothing the checks did not look
 * at can reach the page.
 */
function normalizePreviewUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const reject = (reason) => new Error(
    `Invalid --preview-url '${raw}': ${reason}. Pass the local Expo web server, e.g. http://localhost:8082.`,
  );

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw reject('not a URL');
  }
  if (url.protocol !== 'http:') throw reject('only http: is allowed');
  if (!PREVIEW_HOSTS.has(url.hostname)) throw reject('the host must be localhost or 127.0.0.1');
  if (url.username || url.password) throw reject('credentials are not allowed');
  // `URL` drops a scheme's default port, so `http://localhost:80` parses with an empty port and is
  // refused along with a URL that names none. Expo never serves on 80, and the explicit port is
  // what identifies the server the skill started.
  if (!url.port || Number(url.port) < 1) throw reject('an explicit port is required');
  // A bare trailing `?` or `#` parses to an empty search or hash, so the raw text is checked too.
  if (url.search || url.hash || /[?#]/.test(raw)) throw reject('a query or fragment is not allowed');

  return `http://${url.hostname}:${url.port}${url.pathname}`;
}

/**
 * The device rail beside the plan. It moves through these stages as the run proceeds:
 *   building  an animation, from the first phase until the preview step starts the web server
 *   live      the app itself, running on sample data in the local Expo web server the skill
 *             starts at the preview step (Step 8), so the user can try each change as it
 *             hot-reloads. Needs `previewUrl`; see normalizePreviewUrl
 *   building  again from Step 14, when the skill stops that server to connect real data: plain
 *             Expo web cannot sign in to Dataverse, so the wired app would only show errors.
 *             `previewUrl` is deliberately kept, because it is how the page tells this stretch
 *             from the first one; it neither frames nor links the stopped server
 *   qr        the Metro QR code, so the last thing the plan shows is how to open the real app
 *   screens   a carousel of the plan-time mockups `/design-system` renders into
 *             `_plan_preview.html`. Kept for the legacy `/design-system` mockup flow; the
 *             preview-first `/create-mobile-app` shows `live` instead
 */
function setPhone(state, update) {
  state.phone = state.phone || { stage: 'building', screens: [] };

  // Validated before anything is written, so a rejected URL or stage leaves the phone as it was.
  const previewUrl = update.previewUrl === undefined ? undefined : normalizePreviewUrl(update.previewUrl);
  if (update.stage !== undefined) {
    if (!PHONE_STAGES.has(update.stage)) {
      throw new Error(`Unknown stage '${update.stage}'. Known: ${[...PHONE_STAGES].join(', ')}`);
    }
    if (update.stage === 'live' && !previewUrl && !state.phone.previewUrl) {
      throw new Error("Stage 'live' needs --preview-url, the address of the local Expo web server.");
    }
    state.phone.stage = update.stage;
  }
  if (previewUrl !== undefined) state.phone.previewUrl = previewUrl;
  if (update.screens !== undefined) {
    state.phone.screens = update.screens;
    delete state.phone.previewHtml;
  }
  if (update.previewHtml !== undefined) {
    state.phone.previewHtml = update.previewHtml;
    state.phone.screens = [];
  }
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
  // (for example Step 3 confirming the environment Step 1 resolved).
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

/**
 * Find a phase in the plan, adding it first if this version of PHASES knows it and the plan does
 * not.
 *
 * `initState` hands back an existing plan unchanged so a resumed run keeps its progress, but a
 * plan written by an older version of the skill was seeded from an older PHASES list and lacks
 * any phase added since (the preview-first order added `preview` and `wiring`). Without this the
 * resumed run's first `step --id preview` failed as an unknown phase. Ids no version of PHASES
 * knows still return nothing, so a typo is still reported by name.
 *
 * The new phase goes straight after the last phase already in the plan that PHASES runs before
 * it. An older plan may hold its phases in an older order, so this cannot always reproduce PHASES
 * exactly, but it never lists the new phase above work that has to happen first.
 */
function ensurePhase(state, id) {
  const existing = state.phases.find((entry) => entry.id === id);
  if (existing) return existing;

  const order = PHASES.findIndex((phase) => phase.id === id);
  if (order === -1) return null;

  const earlier = new Set(PHASES.slice(0, order).map((phase) => phase.id));
  let insertAt = 0;
  state.phases.forEach((entry, index) => {
    if (earlier.has(entry.id)) insertAt = index + 1;
  });
  const added = { ...PHASES[order], status: 'pending', note: '' };
  state.phases.splice(insertAt, 0, added);
  return added;
}

function applyStep(state, { id, status, note }) {
  // Status first, so a bad call cannot leave a phase inserted into the plan it then refuses.
  if (!STATUSES.has(status)) {
    throw new Error(`Unknown status '${status}'. Known: ${[...STATUSES].join(', ')}`);
  }
  const phase = ensurePhase(state, id);
  if (!phase) {
    throw new Error(`Unknown phase '${id}'. Known: ${PHASES.map((p) => p.id).join(', ')}`);
  }

  // A note describes the status it was written with, so it must not outlive it. A gate opens
  // with "Architecture gate - awaiting your approval" and is later closed by a bare
  // `--status done`; without this the approved step kept asking for an approval the user had
  // already given.
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
// `proposed` at the architecture gate and only finalised at Step 13, but no gate asks the user to
// answer for it, so including it held the banner up for most of the run with no question to answer.
const AWAITING_LABEL = {
  architecture: 'the architecture', dataModel: 'the data model', screens: 'the screen plan',
  design: 'the design system', offline: 'the offline profile',
};

// An active phase announces it is blocked through its note. Both spellings are accepted because
// a gate writes "Data model gate - awaiting your approval" while an ordinary question reads more
// naturally as "Waiting for your answers"; matching only the first missed every prompt that is
// not a gate.
const AWAITING_NOTE = /\bawaiting\b|\bwaiting for\b/i;

/**
 * `init` runs at Step 2b, before the data platform is decided, so the top-level value is
 * "unknown" and nothing updates it. The architecture gate (Step 10) records the real answer on
 * the architecture section, so read that once it exists and fall back to whatever `init` was
 * given.
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
 * is open: `screens` is proposed at the screen graph gate and stays proposed while the planner
 * writes the per-screen specs into it, so once the graph was approved the plan still showed
 * "Review the screen plan, then answer in your terminal" while the planner was busy and nobody
 * had been asked anything.
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

// The full-size screen mockups `/design-system` renders at the app root. The legacy `screens`
// carousel shows the same blocks in a phone frame; this is the link out to them at full width.
// A preview-first run shows the live app instead and may never write this file.
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
  // A fingerprint of everything the page shows, minus the render time. The open page compares it
  // with the sidecar below and reloads only when they differ, because every reload restarts the
  // live app in the phone. A command that leaves the plan as it was leaves the version as it was.
  summary.version = crypto.createHash('sha256')
    .update(JSON.stringify([state.appName, state.phases, summary, state.sections || {},
      state.sectionStates || {}, state.phone || null, dataPlatformLabel(state), capabilityLabels(state)]))
    .digest('hex').slice(0, 16);
  const published = renderTemplate({
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
  // Published after the page, so a reader that sees the new version reloads into the new page.
  // A file:// page may load a classic script but not fetch, which is why this is JavaScript.
  publishAtomic(
    path.join(docsDir(projectRoot), VERSION_FILE),
    `// Written by app-docs.js on every render. create-app-plan.html loads it to see if it is stale.\n`
      + `window.__planVersion && window.__planVersion(${JSON.stringify(summary.version)});\n`,
  );
  return published;
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
    else if (argument === '--section') options.section = argv[++index];
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
    else if (argument === '--preview-url') {
      options.previewUrl = argv[++index];
      if (!options.previewUrl || options.previewUrl.startsWith('--')) {
        throw new Error('--preview-url requires the local Expo web server URL, e.g. http://localhost:8082.');
      }
    }
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
    } else if (options.command === 'phone') {
      const state = loadState(root);
      if (!state) throw new Error('No run plan yet; run `init` first.');
      if (options.previewFile && options.screensFile) {
        throw new Error('Provide --preview-file or --screens-file, not both.');
      }
      const update = { stage: options.stage, qrUrl: options.qrUrl, previewUrl: options.previewUrl };
      if (options.previewFile) {
        // Retain the whole document: screen fragments alone lose shared CSS, root tokens,
        // and ancestor selectors. The page extracts each .screen inside an isolated viewport.
        update.previewHtml = fs.readFileSync(options.previewFile, 'utf8');
        if (!update.previewHtml.trim()) throw new Error('The screen preview HTML is empty.');
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
  VERSION_FILE,
  PHASES,
  STATE_FILE,
  applyStep,
  docsDir,
  initState,
  loadState,
  normalizePreviewUrl,
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
