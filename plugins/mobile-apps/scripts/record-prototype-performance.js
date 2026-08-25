#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EVENTS_PATH = '.tmp/prototype-performance-events.json';
const EVIDENCE_PATH = '.tmp/prototype-performance-evidence.json';
const PHASES = new Set(['workflow', 'planning', 'domain', 'design', 'canary', 'metro']);

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function emptyEvents() {
  return { schemaVersion: 1, kind: 'prototype-performance-events', phases: {}, counters: { foregroundToolCalls: 0 } };
}

function markPerformanceEvent(projectRoot, phase, event, now = new Date()) {
  if (!PHASES.has(phase)) throw new Error(`unknown performance phase: ${phase}`);
  if (!['start', 'end'].includes(event)) throw new Error(`unknown performance event: ${event}`);
  const root = fs.realpathSync(path.resolve(projectRoot));
  const target = path.join(root, EVENTS_PATH);
  const value = fs.existsSync(target) ? readJson(target, 'Prototype performance events') : emptyEvents();
  const current = value.phases[phase] || {};
  if (event === 'start') {
    if (current.start) throw new Error(`${phase} start is already recorded`);
    current.start = now.toISOString();
  } else {
    if (!current.start) throw new Error(`${phase} cannot end before start`);
    if (current.end) throw new Error(`${phase} end is already recorded`);
    current.end = now.toISOString();
    current.durationMs = Math.max(0, now.getTime() - new Date(current.start).getTime());
  }
  value.phases[phase] = current;
  writeAtomic(target, value);
  return value;
}

function countPerformanceEvent(projectRoot, counter, amount = 1) {
  if (counter !== 'foregroundToolCalls' || !Number.isInteger(amount) || amount < 0) throw new Error('only a non-negative integer foregroundToolCalls counter is supported');
  const root = fs.realpathSync(path.resolve(projectRoot));
  const target = path.join(root, EVENTS_PATH);
  const value = fs.existsSync(target) ? readJson(target, 'Prototype performance events') : emptyEvents();
  value.counters[counter] = (value.counters[counter] || 0) + amount;
  writeAtomic(target, value);
  return value;
}

function optionalJson(root, relativePath) {
  const filePath = path.join(root, relativePath);
  return fs.existsSync(filePath) ? readJson(filePath, relativePath) : null;
}

function durationBetween(start, end) {
  if (!start || !end) return null;
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

function compilePerformanceEvidence(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const events = optionalJson(root, EVENTS_PATH);
  const transport = optionalJson(root, '.tmp/planner-transport.json');
  const design = optionalJson(root, '.tmp/design-instruction-manifest.json');
  const canary = optionalJson(root, '.tmp/native-canary-validation.json');
  const metro = optionalJson(root, '.tmp/prototype-metro-evidence.json');
  const missing = [];
  if (!events) missing.push(EVENTS_PATH);
  if (!transport) missing.push('.tmp/planner-transport.json');
  if (!design) missing.push('.tmp/design-instruction-manifest.json');
  if (!canary?.valid) missing.push('.tmp/native-canary-validation.json');
  if (missing.length) throw new Error(`performance evidence prerequisites are missing: ${missing.join(', ')}`);
  for (const phase of ['workflow', 'planning', 'domain', 'design', 'canary']) if (!events.phases?.[phase]?.end) missing.push(`phase:${phase}`);
  if (missing.length) throw new Error(`performance phase evidence is incomplete: ${missing.join(', ')}`);
  const workflowStart = events.phases.workflow.start;
  const metroReadyAt = metro?.status === 'metro-ready' ? metro.readyAt : null;
  const report = {
    schemaVersion: 1,
    kind: 'prototype-performance-evidence',
    planner: {
      requestBytes: transport.requestBytes,
      responseBytes: transport.responseBytes,
      attempts: transport.plannerAttempts,
      repairCount: transport.plannerRepairAttempts,
      modelCalls: transport.plannerAttempts,
      toolCalls: 0,
    },
    design: {
      mode: design.mode,
      loadedFiles: design.loadedFiles,
      loadedBytes: design.loadedBytes,
      modelCalls: design.modelCalls,
      optionalReferencesLoaded: design.optionalReferencesLoaded,
    },
    canary: {
      screenIds: canary.screenIds,
      sourceBytes: Object.values(canary.sources || {}).reduce((total, source) => total + source.bytes, 0),
      builderModelCalls: canary.screenIds.length,
      validatedAt: canary.validatedAt,
    },
    calls: {
      modelCalls: transport.plannerAttempts + design.modelCalls + canary.screenIds.length,
      foregroundToolCalls: events.counters?.foregroundToolCalls || 0,
    },
    phaseDurationsMs: Object.fromEntries(Object.entries(events.phases).filter(([, value]) => value.durationMs !== undefined).map(([phase, value]) => [phase, value.durationMs])),
    timeToValidatedHomeMs: durationBetween(workflowStart, canary.validatedAt),
    timeToMetroReadyKeyFlowMs: durationBetween(workflowStart, metroReadyAt),
    previewStatus: metroReadyAt ? 'statically validated + Metro ready' : 'statically validated; manual Metro command required',
    metro: metroReadyAt ? { port: metro.port, command: metro.command, readyAt: metro.readyAt, startupDurationMs: metro.startupDurationMs } : null,
  };
  writeAtomic(path.join(root, EVIDENCE_PATH), report);
  return report;
}

function main(argv) {
  const args = { amount: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--action') args.action = argv[++index];
    else if (argv[index] === '--phase') args.phase = argv[++index];
    else if (argv[index] === '--event') args.event = argv[++index];
    else if (argv[index] === '--counter') args.counter = argv[++index];
    else if (argv[index] === '--amount') args.amount = Number(argv[++index]);
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot || !['mark', 'count', 'finalize'].includes(args.action)) {
    process.stderr.write('Usage: node record-prototype-performance.js --project-root <dir> --action mark|count|finalize [--phase <phase> --event start|end] [--counter foregroundToolCalls --amount N] [--json]\n');
    return 2;
  }
  try {
    const result = args.action === 'mark' ? markPerformanceEvent(args.projectRoot, args.phase, args.event)
      : args.action === 'count' ? countPerformanceEvent(args.projectRoot, args.counter, args.amount)
        : compilePerformanceEvidence(args.projectRoot);
    process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : `Prototype performance ${args.action} recorded.`}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`record-prototype-performance: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { EVIDENCE_PATH, EVENTS_PATH, compilePerformanceEvidence, countPerformanceEvent, durationBetween, markPerformanceEvent };
