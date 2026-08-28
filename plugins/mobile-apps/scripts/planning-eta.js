#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  readArtifact,
  summarizePlanningTimings,
} = require('./planning-timings');

const DEFAULT_HISTORY = '.tmp/mobile-planning-history.json';
const MAX_SAMPLES = 20;

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function planningWallMs(summary) {
  const outerPlannerWallMs = Number(summary.outerPlannerWallMs || 0);
  const plannerMs = outerPlannerWallMs > 0
    ? summary.nativePlannerStatus === 'failed' || summary.nativePlannerStatus === 'needs-context'
      ? Math.max(0, outerPlannerWallMs - Number(
        summary.nativePlannerApprovalWaitingMs ?? summary.userApprovalWaitingMs ?? 0,
      ))
        + Number(summary.postPlannerModelArchitectMs || 0)
        + Number(summary.postPlannerScreenPlannerMs || 0)
        + Number(summary.postPlannerRevisionMs || 0)
      : Math.max(0, outerPlannerWallMs - Number(summary.userApprovalWaitingMs || 0))
    : Number(summary.modelArchitectMs || 0)
      + Number(summary.screenPlannerMs || 0)
      + Number(summary.planRevisionMs || 0);
  return [
    summary.environmentResolutionMs,
    summary.publisherPrefixDetectionMs,
    summary.dataverseMetadataNetworkMs,
    summary.localDeterministicProcessingMs,
    plannerMs,
  ].reduce((total, value) => total + Number(value || 0), 0);
}

function readHistory(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, samples: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.samples)) {
    throw new Error('planning history is invalid');
  }
  return parsed;
}

function recordHistory(history, summary, now = () => new Date().toISOString()) {
  const durationMs = planningWallMs(summary);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('planning timings contain no completed duration');
  }
  history.samples.push({ recordedAt: now(), durationMs });
  history.samples = history.samples.slice(-MAX_SAMPLES);
  return history;
}

function estimate(history) {
  const values = history.samples
    .map((sample) => Number(sample.durationMs))
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    sampleCount: values.length,
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    lastMs: values.length ? values[values.length - 1] : null,
  };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--history') args.history = argv[++index];
    else if (argv[index] === '--timings') args.timings = argv[++index];
    else if (argv[index] === '--record') args.record = true;
    else if (argv[index] === '--estimate') args.estimate = true;
  }
  if (!args.projectRoot || Number(Boolean(args.record)) + Number(Boolean(args.estimate)) !== 1) {
    process.stderr.write('Usage: node planning-eta.js --project-root <dir> (--record | --estimate) [--timings <json>] [--history <json>]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const historyFile = path.resolve(root, args.history || DEFAULT_HISTORY);
    const history = readHistory(historyFile);
    if (args.record) {
      const timingsFile = path.resolve(root, args.timings || '.tmp/mobile-planning-timings.json');
      const updated = recordHistory(history, summarizePlanningTimings(readArtifact(timingsFile)));
      atomicWrite(historyFile, updated);
      process.stdout.write(`${JSON.stringify(estimate(updated), null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(estimate(history), null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`planning-eta: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  estimate,
  percentile,
  planningWallMs,
  readHistory,
  recordHistory,
};
