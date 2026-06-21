#!/usr/bin/env node

// Selective-merge observability (Wave 5 #2).
//
// Builds a PRIVACY-SAFE metric record for one selective-merge run and appends it
// to the inner-loop metrics journal (docs/inner-loop/skill-metrics.jsonl) via
// append-skill-metric.js. Records ONLY counts, ratios, durations, the accept-path
// that fired, status, and risk-level tallies — NEVER component names, paths, or
// source content — so it is safe for opt-in telemetry.

'use strict';

const { appendSkillMetric } = require('./append-skill-metric');

/**
 * Build a privacy-safe merge metric object from a run's manifest + apply result.
 * @param {object} args
 * @param {object} [args.manifest]    writeMergeWorkspace/build-merge-inputs manifest
 * @param {object} [args.applyResult] applyMergedComponents result
 * @param {string} [args.runId]
 * @param {number} [args.durationMs]
 * @returns {object} metric payload (no PII / no content)
 */
function buildMergeMetrics({ manifest, applyResult, runId, durationMs } = {}) {
  const units = (manifest && Array.isArray(manifest.units)) ? manifest.units : [];
  const components = (manifest && Array.isArray(manifest.components)) ? manifest.components : [];
  const conflictedUnits = units.filter((u) => u.hasConflicts).length;
  const totalConflictRegions = units.reduce((n, u) => n + (Number(u.conflictCount) || 0), 0);
  const autoMergedUnits = units.length - conflictedUnits;

  // Which accept path fired (from apply step results), without any identifiers.
  let acceptVia = null;
  const steps = (applyResult && Array.isArray(applyResult.steps)) ? applyResult.steps : [];
  const acceptStep = steps.find((s) => s.step === 'accept-incoming');
  if (acceptStep && Array.isArray(acceptStep.results)) {
    const vias = new Set(acceptStep.results.map((r) => r.via).filter(Boolean));
    if (acceptStep.portalFallback) acceptVia = 'maker-portal';
    else if (vias.has('useraction')) acceptVia = 'useraction';
    else if (vias.has('resolvegitconflict')) acceptVia = 'resolvegitconflict';
  }

  // Risk-level tally (W4#4) — counts only.
  const riskCounts = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const c of components) {
    const lvl = c && c.risk && c.risk.level;
    if (lvl && riskCounts[lvl] != null) riskCounts[lvl]++;
  }

  // Content-verify outcome counts (W1#5) — counts only.
  const cv = (applyResult && Array.isArray(applyResult.contentVerify)) ? applyResult.contentVerify : [];
  const contentVerify = {
    verified: cv.filter((x) => x.result === 'verified').length,
    mismatch: cv.filter((x) => x.result === 'mismatch').length,
    unverified: cv.filter((x) => x.result === 'unverified').length,
  };

  return {
    runId: runId || (manifest && manifest.runId) || null,
    status: applyResult ? applyResult.status : null,
    mergeUnits: units.length,
    conflictedUnits,
    autoMergedUnits,
    autoMergeRatio: units.length ? Number((autoMergedUnits / units.length).toFixed(3)) : null,
    totalConflictRegions,
    binaryComponents: (manifest && Array.isArray(manifest.binaryComponents)) ? manifest.binaryComponents.length : null,
    deferredUnits: (manifest && Array.isArray(manifest.deferredUnits)) ? manifest.deferredUnits.length : null,
    secretWarnings: (manifest && Array.isArray(manifest.secretWarnings)) ? manifest.secretWarnings.length : null,
    acceptVia,
    remainingConflicts: applyResult && applyResult.marker ? applyResult.marker.remainingConflicts : null,
    adoCommitId: applyResult && applyResult.marker ? applyResult.marker.adoCommitId : null, // an ADO sha, not PII
    riskCounts,
    contentVerify,
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
  };
}

/** Build + append the merge metric. Best-effort: never throws into the caller. */
function recordMergeMetrics({ projectRoot, manifest, applyResult, runId, durationMs, deps = {} } = {}) {
  const payload = buildMergeMetrics({ manifest, applyResult, runId, durationMs });
  const append = deps.appendSkillMetric || appendSkillMetric;
  try {
    return { ok: true, payload, ...append({ projectRoot, skill: 'SelectiveMerge', payload }) };
  } catch (e) {
    return { ok: false, payload, error: e.message };
  }
}

module.exports = { buildMergeMetrics, recordMergeMetrics };
