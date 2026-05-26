#!/usr/bin/env node
/**
 * update-state.js
 *
 * CLI for managing migration-state.json and re-rendering skill-execution-report.html.
 * Every mutating command (a) loads state.json, (b) applies the change, (c) bumps
 * lastUpdatedAt, (d) writes state.json back, and (e) re-renders the HTML report.
 *
 * USAGE
 *   # initialize a fresh state (writes migration-state.json + skill-execution-report.html)
 *   node update-state.js --init --output-dir <DIR> --website-id <GUID>
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
 *   # free-text current-activity pointer (used during long-running steps)
 *   node update-state.js --output-dir <DIR> --set-activity "Polling migration status (attempt 3/30)"
 *   node update-state.js --output-dir <DIR> --clear-activity
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
  buildInitialState,
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
  return path.join(outputDir, 'skill-execution-report.html');
}

function loadState(outputDir) {
  const p = statePathFor(outputDir);
  if (!fs.existsSync(p)) {
    throw new Error(
      `migration-state.json not found at ${p}. Run \`update-state.js --init --output-dir ${outputDir} --website-id <GUID>\` first.`,
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function persist(state, outputDir) {
  state.lastUpdatedAt = new Date().toISOString();
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(statePathFor(outputDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(reportPathFor(outputDir), renderLiveReport(state), 'utf-8');
}

function cmdInit(args) {
  const outputDir = args['output-dir'];
  const webSiteId = args['website-id'];
  if (!outputDir) throw new Error('--init requires --output-dir');
  if (!webSiteId) throw new Error('--init requires --website-id');
  const state = buildInitialState({ webSiteId, outputDir });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(statePathFor(outputDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(reportPathFor(outputDir), renderLiveReport(state), 'utf-8');
  console.log(`✓ Initialized ${statePathFor(outputDir)}`);
  console.log(`✓ Rendered    ${reportPathFor(outputDir)}`);
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

function cmdRenderOnly(args) {
  const outputDir = args['output-dir'];
  if (!outputDir) throw new Error('--render-only requires --output-dir');
  const state = loadState(outputDir);
  fs.writeFileSync(reportPathFor(outputDir), renderLiveReport(state), 'utf-8');
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
    if (args['set-activity'] !== undefined) return cmdSetActivity(args);
    if (args['clear-activity']) return cmdClearActivity(args);
    if (args['render-only']) return cmdRenderOnly(args);
    console.error('No command given. Run with --help-ish docs at top of update-state.js');
    process.exit(2);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
