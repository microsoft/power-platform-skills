#!/usr/bin/env node
/**
 * update-state.js
 *
 * CLI for managing migration-state.json and re-rendering sdm-to-edm-migration-report.html.
 * Every mutating command (a) loads state.json, (b) applies the change, (c) bumps
 * lastUpdatedAt, (d) writes state.json back, and (e) re-renders the HTML report.
 *
 * USAGE
 *   # initialize a fresh state inside a per-migration subfolder
 *   # (writes migration-state.json + sdm-to-edm-migration-report.html into
 *   #  <PARENT_DIR>/<sanitized-env>--<sanitized-slug>/)
 *   node update-state.js --init --output-dir <PARENT_DIR> \
 *       --website-id <GUID> --env-name "<NAME>" --slug "<SLUG>"
 *   # add --force to overwrite an existing migration in the same subfolder.
 *   # Without --force, --init re-uses the existing state (resume mode).
 *   # The command prints the resolved subfolder path on success \u2014 use that
 *   # subfolder as --output-dir for every subsequent command below.
 *
 *   # update site card fields (any subset of name, portalId, slug, currentDataModel,
 *   #                          template, environment, migrationMode, siteRoot)
 *   node update-state.js --output-dir <DIR> --set-site '{"name":"Contoso","slug":"contoso"}'
 *
 *   # mark a sub-step's status / output
 *   node update-state.js --output-dir <DIR> --set-step 1.1 --status completed \
 *       --output "PAC CLI v1.47.1 · environment Ashmigration"
 *
 *   # mark a phase's status (in-progress / completed / blocked)
 *   node update-state.js --output-dir <DIR> --set-phase 1 --status completed
 *
 *   # set / clear approval gate
 *   node update-state.js --output-dir <DIR> --set-approval 2 phase-start
 *   node update-state.js --output-dir <DIR> --set-approval 2 in-phase
 *   node update-state.js --output-dir <DIR> --clear-approval
 *
 *   # set augmented-prompt card (kind: plugin | dme)
 *   node update-state.js --output-dir <DIR> --set-prompt plugin --status ready \
 *       --path "./migration-reports/plugin-remediation-prompt.txt" \
 *       --summary "4 custom plugins on adx_* entities..."
 *
 *   # set customization-report findings card (call once after the CSV is parsed)
 *   node update-state.js --output-dir <DIR> --set-customization-report \
 *       '{"path":"./migration-reports/customization-report.html","csvPath":"./migration-reports/SiteCustomization.csv","totalFindings":14,"breakdown":{"fetchxml":3,"liquid":8,"dme":2,"plugins":1}}'
 *
 *   # set transactional refs migration tracker card (call once after `pac pages migrate-datamodel -s -v` returns)
 *   node update-state.js --output-dir <DIR> --set-refs-migration \
 *       '{"status":"Completed","currentStep":"StatusUpdated","createdAt":"2026-06-22T07:20:16Z","modifiedAt":"2026-06-22T07:29:19Z","stepHistory":[{"step":"ConfigurationDataReferencesStarted","at":"2026-06-22T07:27:21Z"},{"step":"ConfigurationDataReferencesCompleted","at":"2026-06-22T07:29:17Z"}],"runs":[{"name":"Run on 6/22/2026 7:27:27 AM","chunkTotal":3,"completed":3,"succeeded":3,"chunks":[{"name":"adx_blog_webrole...","runStatus":1,"outcome":1,"errorType":null,"errorDetails":null}]}]}'
 *
 *   # free-text current-activity pointer (used during long-running steps)
 *   node update-state.js --output-dir <DIR> --set-activity "Polling migration status (attempt 3/30)"
 *   node update-state.js --output-dir <DIR> --clear-activity
 *
 *   # set migration track (called at end of step 1.7 once env type + mode known)
 *   # A = Authoring Track  (mode configurationData|all — Dev/Test/UAT/Single env)
 *   # B = Downstream Track (mode configurationDataReferences — Prod, ALM assumed)
 *   node update-state.js --output-dir <DIR> --set-track A
 *   node update-state.js --output-dir <DIR> --set-track B
 *
 *   # re-render without state change (useful after manual edits)
 *   node update-state.js --output-dir <DIR> --render-only
 */

const fs = require('fs');
const path = require('path');

const {
  PHASE_STATUS,
  SUB_STEP_STATUS,
  APPROVAL_KIND,
  PROMPT_STATUS,
  TRACK,
  buildInitialState,
  rebuildPhasesForTrack,
} = require('./lib/migration-state-schema');
const { renderLiveReport } = require('./lib/render-live-report');

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        result[key] = true;
      } else {
        result[key] = next;
        i += 1;
      }
    } else {
      result._.push(a);
    }
  }
  return result;
}

function statePathFor(outputDir) {
  return path.join(outputDir, 'migration-state.json');
}

function reportPathFor(outputDir) {
  return path.join(outputDir, 'sdm-to-edm-migration-report.html');
}

// Sanitize a free-text segment (env name or website slug) into a safe path component.
// Lowercase, replace non-[a-z0-9] runs with '-', trim leading/trailing '-', cap at 60 chars.
function sanitizeForPath(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Build the per-migration subdirectory name from env name + slug.
// Falls back to the first 8 chars of websiteId if both sanitized segments are empty.
function buildMigrationSubdir({ envName, slug, webSiteId }) {
  const envPart = sanitizeForPath(envName);
  const slugPart = sanitizeForPath(slug);
  if (envPart && slugPart) return `${envPart}--${slugPart}`;
  if (envPart) return envPart;
  if (slugPart) return slugPart;
  // Both sanitized away — fall back to a short site id so we never produce an empty subdir.
  const idFallback = typeof webSiteId === 'string' ? webSiteId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() : '';
  return idFallback || 'migration';
}

function trackName(track) {
  if (track === TRACK.A) return 'Authoring Track';
  if (track === TRACK.B) return 'Downstream Track';
  return `Unknown (${track})`;
}

function loadState(outputDir) {
  const p = statePathFor(outputDir);
  if (!fs.existsSync(p)) {
    throw new Error(
      `migration-state.json not found at ${p}. Run \`update-state.js --init --output-dir <PARENT_DIR> --website-id <GUID> --env-name <NAME> --slug <SLUG>\` first (the init command creates a per-migration subfolder and prints its path — use that subfolder as --output-dir for all subsequent commands).`,
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function loadSnapshotIfExists(outputDir, label) {
  const p = path.join(outputDir, `${label}-snapshot.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    // Don't fail the report write if a snapshot is malformed — just skip it.
    console.warn(`Warning: could not parse ${label} snapshot at ${p}: ${e.message}`);
    return null;
  }
}

function loadRemediationDiffIfExists(outputDir) {
  const p = path.join(outputDir, 'remediation-diff.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Inject the manifest's own absolute path so the renderer can build the
    // PP-VSCode import URL (vscode://...metadataDiffImport?filePath=<this>).
    data.manifestPath = path.resolve(p);
    return data;
  } catch (e) {
    console.warn(`Warning: could not parse remediation-diff.json at ${p}: ${e.message}`);
    return null;
  }
}

function loadRenderOpts(outputDir) {
  return {
    sdmSnapshot: loadSnapshotIfExists(outputDir, 'sdm'),
    edmSnapshot: loadSnapshotIfExists(outputDir, 'edm'),
    remediationDiff: loadRemediationDiffIfExists(outputDir),
  };
}

function persist(state, outputDir) {
  state.lastUpdatedAt = new Date().toISOString();
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(statePathFor(outputDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(reportPathFor(outputDir), renderLiveReport(state, loadRenderOpts(outputDir)), 'utf-8');
}

function cmdInit(args) {
  const parentDir = args['output-dir'];
  const webSiteId = args['website-id'];
  const envName = args['env-name'];
  const slug = args['slug'];
  const force = !!args['force'];
  if (!parentDir) throw new Error('--init requires --output-dir (the parent directory; a per-migration subfolder is created inside it)');
  if (!webSiteId) throw new Error('--init requires --website-id');
  if (typeof envName !== 'string' || envName.trim() === '') {
    throw new Error('--init requires --env-name "<NAME>" (the Dataverse environment display name, used to namespace the migration subfolder)');
  }
  if (typeof slug !== 'string' || slug.trim() === '') {
    throw new Error('--init requires --slug "<SLUG>" (the website slug from `pac pages list -v`, used to namespace the migration subfolder)');
  }

  const subdirName = buildMigrationSubdir({ envName, slug, webSiteId });
  const outputDir = path.join(parentDir, subdirName);
  const statePath = statePathFor(outputDir);

  if (fs.existsSync(statePath) && !force) {
    console.log(`⚠ Existing migration found at ${statePath}`);
    console.log('  Re-using existing state (resume mode). Pass --force to reset and start fresh.');
    return;
  }

  const state = buildInitialState({ webSiteId, outputDir });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(reportPathFor(outputDir), renderLiveReport(state, loadRenderOpts(outputDir)), 'utf-8');
  console.log(`✓ Migration subfolder: ${outputDir}`);
  console.log(`✓ Initialized ${statePath}`);
  console.log(`✓ Rendered    ${reportPathFor(outputDir)}`);
  console.log('');
  console.log(`Use --output-dir "${outputDir}" for every subsequent update-state.js call.`);
}

function cmdSetSite(args) {
  const outputDir = args['output-dir'];
  const raw = args['set-site'];
  if (!outputDir) throw new Error('--set-site requires --output-dir');
  if (typeof raw !== 'string') throw new Error('--set-site expects a JSON string');
  let patch;
  try {
    patch = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--set-site: could not parse JSON: ${e.message}`);
  }
  const state = loadState(outputDir);
  const allowed = [
    'name',
    'portalId',
    'slug',
    'currentDataModel',
    'template',
    'environment',
    'migrationMode',
    'siteRoot',
  ];
  for (const k of Object.keys(patch)) {
    if (!allowed.includes(k)) {
      throw new Error(`--set-site: unknown field '${k}'. Allowed: ${allowed.join(', ')}`);
    }
    state.site[k] = patch[k];
  }
  persist(state, outputDir);
  console.log(`✓ Site updated: ${Object.keys(patch).join(', ')}`);
}

function cmdSetStep(args) {
  const outputDir = args['output-dir'];
  const stepId = args['set-step'];
  const status = args['status'];
  const output = args['output'];
  if (!outputDir) throw new Error('--set-step requires --output-dir');
  if (typeof stepId !== 'string') throw new Error('--set-step requires a sub-step id like 1.1');
  if (!status) throw new Error('--set-step requires --status <pending|in-progress|completed|blocked>');
  if (!Object.values(SUB_STEP_STATUS).includes(status)) {
    throw new Error(`Invalid sub-step status '${status}'. Allowed: ${Object.values(SUB_STEP_STATUS).join(', ')}`);
  }
  const state = loadState(outputDir);
  let sub = null;
  for (const p of state.phases) {
    sub = p.subSteps.find((s) => s.id === stepId);
    if (sub) break;
  }
  if (!sub) throw new Error(`Unknown sub-step id '${stepId}'`);
  sub.status = status;
  if (output !== undefined) sub.output = typeof output === 'string' ? output : null;
  persist(state, outputDir);
  console.log(`✓ Step ${stepId} → ${status}${output ? ` · ${String(output).slice(0, 60)}${String(output).length > 60 ? '…' : ''}` : ''}`);
}

function cmdSetPhase(args) {
  const outputDir = args['output-dir'];
  const phaseId = Number(args['set-phase']);
  const status = args['status'];
  if (!outputDir) throw new Error('--set-phase requires --output-dir');
  if (!Number.isFinite(phaseId)) throw new Error('--set-phase requires a phase number');
  if (!status) throw new Error('--set-phase requires --status');
  if (!Object.values(PHASE_STATUS).includes(status)) {
    throw new Error(`Invalid phase status '${status}'. Allowed: ${Object.values(PHASE_STATUS).join(', ')}`);
  }
  const state = loadState(outputDir);
  const phase = state.phases.find((p) => p.id === phaseId);
  if (!phase) throw new Error(`Unknown phase id '${phaseId}'`);
  const now = new Date().toISOString();
  if (status === PHASE_STATUS.IN_PROGRESS && !phase.startedAt) phase.startedAt = now;
  if (status === PHASE_STATUS.COMPLETED) {
    if (!phase.startedAt) phase.startedAt = now;
    phase.completedAt = now;
  }
  phase.status = status;
  persist(state, outputDir);
  console.log(`✓ Phase ${phaseId} → ${status}`);
}

function cmdSetApproval(args) {
  const outputDir = args['output-dir'];
  const value = args['set-approval'];
  if (!outputDir) throw new Error('--set-approval requires --output-dir');
  // --set-approval <phaseId> <kind>  (kind is in positional _ array)
  const phaseId = Number(value);
  const kind = args._[0];
  if (!Number.isFinite(phaseId)) {
    throw new Error('--set-approval requires a phase id (e.g. --set-approval 2 phase-start)');
  }
  if (!kind || !Object.values(APPROVAL_KIND).includes(kind)) {
    throw new Error(`--set-approval requires kind: ${Object.values(APPROVAL_KIND).join(' | ')}`);
  }
  const state = loadState(outputDir);
  state.approvalGate = { phaseId, kind };
  persist(state, outputDir);
  console.log(`✓ Approval gate → phase ${phaseId} (${kind})`);
}

function cmdClearApproval(args) {
  const outputDir = args['output-dir'];
  if (!outputDir) throw new Error('--clear-approval requires --output-dir');
  const state = loadState(outputDir);
  state.approvalGate = null;
  persist(state, outputDir);
  console.log('✓ Approval gate cleared');
}

function cmdSetPrompt(args) {
  const outputDir = args['output-dir'];
  const kind = args['set-prompt'];
  if (!outputDir) throw new Error('--set-prompt requires --output-dir');
  if (kind !== 'plugin' && kind !== 'dme') {
    throw new Error(`--set-prompt requires kind 'plugin' or 'dme', got '${kind}'`);
  }
  const status = args['status'] || PROMPT_STATUS.READY;
  if (!Object.values(PROMPT_STATUS).includes(status)) {
    throw new Error(`Invalid prompt status '${status}'`);
  }
  const state = loadState(outputDir);
  state.augmentedPrompts[kind] = {
    status,
    path: typeof args['path'] === 'string' ? args['path'] : null,
    summary: typeof args['summary'] === 'string' ? args['summary'] : null,
  };
  persist(state, outputDir);
  console.log(`✓ Prompt '${kind}' → ${status}`);
}

function cmdSetCustomizationReport(args) {
  const outputDir = args['output-dir'];
  const raw = args['set-customization-report'];
  if (!outputDir) throw new Error('--set-customization-report requires --output-dir');
  if (typeof raw !== 'string') throw new Error('--set-customization-report expects a JSON string');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--set-customization-report: could not parse JSON: ${e.message}`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('--set-customization-report expects a JSON object');
  }
  const allowed = ['path', 'csvPath', 'totalFindings', 'breakdown', 'scannedAt'];
  for (const k of Object.keys(payload)) {
    if (!allowed.includes(k)) {
      throw new Error(`--set-customization-report: unknown field '${k}'. Allowed: ${allowed.join(', ')}`);
    }
  }
  if (payload.totalFindings !== undefined && !Number.isFinite(payload.totalFindings)) {
    throw new Error('--set-customization-report: totalFindings must be a number');
  }
  if (payload.breakdown !== undefined && (payload.breakdown === null || typeof payload.breakdown !== 'object' || Array.isArray(payload.breakdown))) {
    throw new Error('--set-customization-report: breakdown must be an object of { category: count }');
  }
  const state = loadState(outputDir);
  state.customizationReport = {
    path: typeof payload.path === 'string' ? payload.path : null,
    csvPath: typeof payload.csvPath === 'string' ? payload.csvPath : null,
    totalFindings: Number.isFinite(payload.totalFindings) ? payload.totalFindings : 0,
    breakdown: payload.breakdown || {},
    scannedAt: typeof payload.scannedAt === 'string' ? payload.scannedAt : new Date().toISOString(),
  };
  persist(state, outputDir);
  console.log(`✓ Customization report → ${state.customizationReport.totalFindings} finding${state.customizationReport.totalFindings === 1 ? '' : 's'}`);
}

const REFS_MIGRATION_STATUSES = new Set(['NotStarted', 'Running', 'Completed', 'Failed', 'Reverted', 'Unknown']);

function cmdSetRefsMigration(args) {
  const outputDir = args['output-dir'];
  const raw = args['set-refs-migration'];
  if (!outputDir) throw new Error('--set-refs-migration requires --output-dir');
  if (typeof raw !== 'string') throw new Error('--set-refs-migration expects a JSON string');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--set-refs-migration: could not parse JSON: ${e.message}`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('--set-refs-migration expects a JSON object');
  }
  const allowed = ['status', 'currentStep', 'createdAt', 'modifiedAt', 'stepHistory', 'runs', 'capturedAt'];
  for (const k of Object.keys(payload)) {
    if (!allowed.includes(k)) {
      throw new Error(`--set-refs-migration: unknown field '${k}'. Allowed: ${allowed.join(', ')}`);
    }
  }
  if (payload.status !== undefined && !REFS_MIGRATION_STATUSES.has(payload.status)) {
    throw new Error(`--set-refs-migration: status must be one of ${[...REFS_MIGRATION_STATUSES].join(', ')}`);
  }
  if (payload.stepHistory !== undefined && !Array.isArray(payload.stepHistory)) {
    throw new Error('--set-refs-migration: stepHistory must be an array');
  }
  if (payload.runs !== undefined && !Array.isArray(payload.runs)) {
    throw new Error('--set-refs-migration: runs must be an array');
  }
  const state = loadState(outputDir);
  state.refsMigration = {
    status: typeof payload.status === 'string' ? payload.status : 'Unknown',
    currentStep: typeof payload.currentStep === 'string' ? payload.currentStep : null,
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : null,
    modifiedAt: typeof payload.modifiedAt === 'string' ? payload.modifiedAt : null,
    stepHistory: Array.isArray(payload.stepHistory) ? payload.stepHistory : [],
    runs: Array.isArray(payload.runs) ? payload.runs : [],
    capturedAt: typeof payload.capturedAt === 'string' ? payload.capturedAt : new Date().toISOString(),
  };
  persist(state, outputDir);
  const r = state.refsMigration;
  const totalChunks = r.runs.reduce((a, run) => a + (Number.isFinite(run.chunkTotal) ? run.chunkTotal : 0), 0);
  const totalSucceeded = r.runs.reduce((a, run) => a + (Number.isFinite(run.succeeded) ? run.succeeded : 0), 0);
  console.log(`✓ Refs migration → status=${r.status} · step=${r.currentStep || '?'} · chunks ${totalSucceeded}/${totalChunks}`);
}

function cmdSetActivity(args) {
  const outputDir = args['output-dir'];
  if (!outputDir) throw new Error('--set-activity requires --output-dir');
  const text = args['set-activity'];
  if (typeof text !== 'string') throw new Error('--set-activity requires a string value');
  const state = loadState(outputDir);
  state.currentActivity = text;
  persist(state, outputDir);
  console.log(`✓ Activity: ${text}`);
}

function cmdClearActivity(args) {
  const outputDir = args['output-dir'];
  if (!outputDir) throw new Error('--clear-activity requires --output-dir');
  const state = loadState(outputDir);
  state.currentActivity = null;
  persist(state, outputDir);
  console.log('✓ Activity cleared');
}

function cmdSetTrack(args) {
  const outputDir = args['output-dir'];
  const track = args['set-track'];
  if (!outputDir) throw new Error('--set-track requires --output-dir');
  if (!Object.values(TRACK).includes(track)) {
    throw new Error(`--set-track requires one of: ${Object.values(TRACK).join(', ')}`);
  }
  const state = loadState(outputDir);
  if (state.track === track) {
    console.log(`✓ Track already set to ${track} (${trackName(track)}); no change`);
    return;
  }
  rebuildPhasesForTrack(state, track);
  persist(state, outputDir);
  console.log(`✓ Track set to ${track} (${trackName(track)}); Phase 2 + Phase 3 rebuilt from blueprint`);
}

function cmdRenderOnly(args) {
  const outputDir = args['output-dir'];
  if (!outputDir) throw new Error('--render-only requires --output-dir');
  const state = loadState(outputDir);
  fs.writeFileSync(reportPathFor(outputDir), renderLiveReport(state, loadRenderOpts(outputDir)), 'utf-8');
  console.log(`✓ Re-rendered ${reportPathFor(outputDir)}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.init) return cmdInit(args);
    if (args['set-site'] !== undefined) return cmdSetSite(args);
    if (args['set-step'] !== undefined) return cmdSetStep(args);
    if (args['set-phase'] !== undefined) return cmdSetPhase(args);
    if (args['set-approval'] !== undefined) return cmdSetApproval(args);
    if (args['clear-approval']) return cmdClearApproval(args);
    if (args['set-prompt'] !== undefined) return cmdSetPrompt(args);
    if (args['set-customization-report'] !== undefined) return cmdSetCustomizationReport(args);
    if (args['set-refs-migration'] !== undefined) return cmdSetRefsMigration(args);
    if (args['set-activity'] !== undefined) return cmdSetActivity(args);
    if (args['clear-activity']) return cmdClearActivity(args);
    if (args['set-track'] !== undefined) return cmdSetTrack(args);
    if (args['render-only']) return cmdRenderOnly(args);
    console.error('No command given. Run with --help-ish docs at top of update-state.js');
    process.exit(2);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
