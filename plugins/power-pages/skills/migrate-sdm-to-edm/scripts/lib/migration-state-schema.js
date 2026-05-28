/**
 * migration-state-schema.js
 *
 * Source of truth for migration-state.json. Three responsibilities:
 *   1. `buildInitialState()` — the skeleton the skill writes at startup, before any
 *      sub-step has run. Defaults to Track A (more common). Matches stage0-initialized.html.
 *   2. Constants for status / kind / track values used by phases, sub-steps, the
 *      approval gate, and the augmented-prompt cards.
 *   3. Canonical phase blueprints per track. Phase 1 and Phase 4 are shared across
 *      tracks; Phase 2 and Phase 3 differ.
 *
 * Track A — mode is `configurationData` or `all`
 *   For Dev / Test / UAT / Single env. Migrates metadata locally, allows a
 *   customization-remediation pass, then activates EDM.
 *
 * Track B — mode is `configurationDataReferences`
 *   For Prod (ALM assumed). Verifies metadata is already in EDM, then migrates
 *   transactional references and activates.
 *
 * Kept deliberately small: no I/O, no rendering, no CLI concerns. Pure data.
 */

const SCHEMA_VERSION = 1;

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
  PHASE_START: 'phase-start',
  IN_PHASE: 'in-phase',
});

const PROMPT_STATUS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
});

const TRACK = Object.freeze({
  A: 'A',
  B: 'B',
});

// Track A defaults to Dev/Test/UAT/Single-env (the most common). Until step 1.7
// runs --set-track, the live report renders against this default.
const DEFAULT_TRACK = TRACK.A;

// ── Phase blueprints ───────────────────────────────────────────────────────
// Phase 1 and Phase 4 are shared across tracks.

const PHASE_1 = {
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
};

const PHASE_4 = {
  id: 4,
  title: 'Post-Migration Validation',
  subSteps: [
    { id: '4.1', label: 'Validation, Optional Rollback, and Final Summary' },
  ],
};

const PHASE_2_TRACK_A = {
  id: 2,
  title: 'Configuration Migration & Customization Remediation',
  subSteps: [
    { id: '2.1', label: 'Migrate Metadata' },
    { id: '2.2', label: 'Locate Customization Report' },
    { id: '2.3', label: 'Remediate Customizations' },
  ],
};

const PHASE_2_TRACK_B = {
  id: 2,
  title: 'Setting Up Metadata',
  subSteps: [
    { id: '2.1', label: 'Verify Site in Target Environment' },
    { id: '2.2', label: 'Import Metadata if Missing' },
    { id: '2.3', label: 'Confirm Metadata Ready' },
  ],
};

// Phase 3 is identical in both tracks (per the unified Phase 3 design): always
// runs migrate refs → locate report → remediate (if findings) → activate → restart.
// In Track A with mode=`all`, step 3.1 is a no-op (refs already migrated in 2.1) —
// SKILL.md instructs the agent to mark it completed with output "Skipped — already
// covered by mode=all in Phase 2.1".
const PHASE_3_UNIFIED = {
  id: 3,
  title: 'Migration & Activation',
  subSteps: [
    { id: '3.1', label: 'Migrate Transactional References' },
    { id: '3.2', label: 'Locate Customization Report' },
    { id: '3.3', label: 'Remediate Customizations' },
    { id: '3.4', label: 'Activate EDM (Update Data Model Version)' },
    { id: '3.5', label: 'Restart Site' },
  ],
};

const PHASE_BLUEPRINTS_BY_TRACK = Object.freeze({
  A: [PHASE_1, PHASE_2_TRACK_A, PHASE_3_UNIFIED, PHASE_4],
  B: [PHASE_1, PHASE_2_TRACK_B, PHASE_3_UNIFIED, PHASE_4],
});

function makePhasesFromBlueprint(blueprints) {
  return blueprints.map((p) => ({
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
  }));
}

/**
 * Build a fresh migration-state.json skeleton. Defaults to Track A; the skill
 * calls `--set-track A|B` at the end of step 1.7 once env type and migration
 * mode are known.
 */
function buildInitialState({ webSiteId, outputDir, track = DEFAULT_TRACK, startedAt = new Date().toISOString() } = {}) {
  if (!webSiteId) throw new Error('buildInitialState: webSiteId is required');
  if (!outputDir) throw new Error('buildInitialState: outputDir is required');
  if (!PHASE_BLUEPRINTS_BY_TRACK[track]) throw new Error(`buildInitialState: unknown track '${track}'`);

  return {
    schemaVersion: SCHEMA_VERSION,
    skillStartedAt: startedAt,
    lastUpdatedAt: startedAt,
    track,
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
    phases: makePhasesFromBlueprint(PHASE_BLUEPRINTS_BY_TRACK[track]),
    approvalGate: {
      phaseId: 1,
      kind: APPROVAL_KIND.PHASE_START,
    },
    augmentedPrompts: {
      plugin: null,
      dme: null,
    },
    currentActivity: null,
  };
}

/**
 * Switch the state's track in place. Preserves Phase 1 and Phase 4 (which are
 * shared between tracks and may contain completed sub-steps). Replaces Phase 2
 * and Phase 3 with the new track's blueprints (pristine).
 *
 * Called by update-state.js --set-track A|B, typically at the end of step 1.7
 * when the user confirms env type + migration mode.
 */
function rebuildPhasesForTrack(state, newTrack) {
  if (!PHASE_BLUEPRINTS_BY_TRACK[newTrack]) {
    throw new Error(`rebuildPhasesForTrack: unknown track '${newTrack}'`);
  }

  const blueprints = PHASE_BLUEPRINTS_BY_TRACK[newTrack];
  state.phases = blueprints.map((blueprint) => {
    // Phase 1 and Phase 4 are shared across tracks — preserve any existing
    // sub-step status / output. Phase 2 and Phase 3 are track-specific —
    // rebuild from blueprint (pristine).
    if (blueprint.id === 1 || blueprint.id === 4) {
      const existing = state.phases?.find((p) => p.id === blueprint.id);
      if (existing) return existing;
    }
    return makePhasesFromBlueprint([blueprint])[0];
  });
  state.track = newTrack;
}

module.exports = {
  SCHEMA_VERSION,
  PHASE_STATUS,
  SUB_STEP_STATUS,
  APPROVAL_KIND,
  PROMPT_STATUS,
  TRACK,
  DEFAULT_TRACK,
  PHASE_BLUEPRINTS_BY_TRACK,
  // Back-compat exports — `PHASE_BLUEPRINT` was the pre-track flat list. We
  // alias it to Track A so any external caller that imported it keeps working.
  PHASE_BLUEPRINT: PHASE_BLUEPRINTS_BY_TRACK.A,
  buildInitialState,
  rebuildPhasesForTrack,
};
