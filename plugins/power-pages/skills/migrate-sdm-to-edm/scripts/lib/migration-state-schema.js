/**
 * migration-state-schema.js
 *
 * Source of truth for migration-state.json. Two responsibilities:
 *   1. `buildInitialState()` — the skeleton the skill writes at startup, before any
 *      sub-step has run. Matches stage0-initialized.html when rendered.
 *   2. Constants for status/kind values used by phases, sub-steps, and the approval
 *      gate, plus the canonical phase + sub-step structure (titles, ids, order).
 *
 * Kept deliberately small: no I/O, no rendering, no CLI concerns. Pure data.
 */

const SCHEMA_VERSION = 1;

// Phase / sub-step status values. Phases use the full set; sub-steps use a subset
// (no 'pending-approval' — that's modeled by the approval gate, not the sub-step).
const PHASE_STATUS = Object.freeze({
  PENDING: 'pending',
  PENDING_APPROVAL: 'pending-approval',
  IN_PROGRESS: 'in-progress',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
});

const SUB_STEP_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in-progress',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
});

const APPROVAL_KIND = Object.freeze({
  PHASE_START: 'phase-start', // gate appears before a whole phase begins
  IN_PHASE: 'in-phase', // gate appears mid-phase (e.g., diff review before upload)
});

const PROMPT_STATUS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
});

// Canonical phase + sub-step structure. The order here is the order rendered in
// the report. Sub-step labels match the headings in SKILL.md.
const PHASE_BLUEPRINT = [
  {
    id: 1,
    title: 'Site Discovery & Pre-checks',
    subSteps: [
      { id: '1.1', label: 'Establish CLI Context' },
      { id: '1.2', label: 'Identify Site Context' },
      { id: '1.3', label: 'Site Discovery and Validate Data Model' },
      { id: '1.4', label: 'Check Existing Migration Status' },
      { id: '1.5', label: 'Validate Required Dependencies' },
      { id: '1.6', label: 'Validate Site Template and V2 Package' },
      { id: '1.7', label: 'Determine Environment Type and Migration Mode' },
    ],
  },
  {
    id: 2,
    title: 'Customization Remediation',
    subSteps: [
      { id: '2.1', label: 'Generate Customization Report' },
      { id: '2.2', label: 'Remediate Customizations' },
    ],
  },
  {
    id: 3,
    title: 'Migration Execution',
    subSteps: [
      { id: '3.1', label: 'Migrate Site Data Model' },
      { id: '3.2', label: 'Update Data Model Version' },
    ],
  },
  {
    id: 4,
    title: 'Post-Migration Validation',
    subSteps: [
      { id: '4.1', label: 'Validation, Optional Rollback, and Final Summary' },
    ],
  },
];

const TOTAL_SUB_STEPS = PHASE_BLUEPRINT.reduce((n, p) => n + p.subSteps.length, 0);

/**
 * Build a fresh migration-state.json skeleton. Called by `update-state.js --init`.
 *
 * Required input:
 *   webSiteId   — the only field we know at skill launch (from $ARGUMENTS or 1.2 cwd scan)
 *   outputDir   — where reports + state.json live, captured in step 1.2
 *
 * Everything else starts null/pending. Rendering this state produces a report
 * structurally equivalent to stage0-initialized.html with the Phase 1 approval gate
 * already in place.
 */
function buildInitialState({ webSiteId, outputDir, startedAt = new Date().toISOString() } = {}) {
  if (!webSiteId) throw new Error('buildInitialState: webSiteId is required');
  if (!outputDir) throw new Error('buildInitialState: outputDir is required');

  return {
    schemaVersion: SCHEMA_VERSION,
    skillStartedAt: startedAt,
    lastUpdatedAt: startedAt,
    site: {
      name: null,
      webSiteId,
      portalId: null,
      slug: null,
      currentDataModel: null,
      template: null,
      environment: null,
      migrationMode: null,
      siteRoot: null,
      outputDir,
    },
    phases: PHASE_BLUEPRINT.map((p) => ({
      id: p.id,
      title: p.title,
      status: PHASE_STATUS.PENDING,
      startedAt: null,
      completedAt: null,
      subSteps: p.subSteps.map((s) => ({
        id: s.id,
        label: s.label,
        status: SUB_STEP_STATUS.PENDING,
        output: null,
      })),
    })),
    approvalGate: {
      // On init we're awaiting approval to start Phase 1. SKILL.md will clear/replace
      // this gate as it progresses.
      phaseId: 1,
      kind: APPROVAL_KIND.PHASE_START,
    },
    augmentedPrompts: {
      plugin: null, // { status: 'ready', path: '...', summary: '...' }
      dme: null,
    },
    currentActivity: null, // optional free-text pointer used during long-running steps
  };
}

module.exports = {
  SCHEMA_VERSION,
  PHASE_STATUS,
  SUB_STEP_STATUS,
  APPROVAL_KIND,
  PROMPT_STATUS,
  PHASE_BLUEPRINT,
  TOTAL_SUB_STEPS,
  buildInitialState,
};
