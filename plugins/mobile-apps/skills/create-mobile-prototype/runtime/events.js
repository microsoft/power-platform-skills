#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCREEN_STATES = ['queued', 'building', 'written', 'checked', 'built', 'failed'];
const NEXT_SCREEN_STATES = {
  queued: new Set(['building', 'failed']),
  building: new Set(['written', 'failed']),
  written: new Set(['checked', 'failed']),
  checked: new Set(['built', 'failed']),
  built: new Set(),
  failed: new Set(['building']),
};

function paths(projectDir) {
  const buildDir = path.join(projectDir, '.mobile-build');
  return {
    buildDir,
    events: path.join(buildDir, 'events.ndjson'),
    meta: path.join(buildDir, 'events-meta.json'),
    middleware: path.join(buildDir, 'events-middleware.cjs'),
    progress: path.join(projectDir, 'src', 'generated', 'buildProgress.ts'),
  };
}

function atomicWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, filePath);
}

function initialize(projectDir) {
  const target = paths(projectDir);
  fs.mkdirSync(target.buildDir, { recursive: true });
  if (!fs.existsSync(target.events)) fs.writeFileSync(target.events, '');
  if (!fs.existsSync(target.meta)) atomicWrite(target.meta, `${JSON.stringify({ startedAtMs: Date.now() })}\n`);
  if (!fs.existsSync(target.middleware)) atomicWrite(target.middleware, renderMiddleware());
  writeProgressProjection(projectDir, reduce(readEvents(projectDir)));
  return target;
}

function readEvents(projectDir) {
  const filePath = paths(projectDir).events;
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try { return JSON.parse(line); } catch (error) { throw new Error(`invalid build event line ${index + 1}: ${error.message}`); }
    });
}

function reduce(events) {
  const state = {
    brief: null,
    concerns: [],
    findings: [],
    phases: {},
    plan: null,
    runtime: { state: 'queued', url: null },
    screens: {},
  };
  for (const event of events) {
    if (event.kind === 'phase') state.phases[`${event.track}:${event.id}`] = event;
    else if (event.kind === 'brief') state.brief = event.summary;
    else if (event.kind === 'runtime') state.runtime = { ...state.runtime, ...event };
    else if (event.kind === 'plan') state.plan = event;
    else if (event.kind === 'screen') state.screens[event.id] = { ...(state.screens[event.id] || {}), ...event };
    else if (event.kind === 'finding') state.findings.push(event);
    else if (event.kind === 'concern' && !state.concerns.includes(event.message)) state.concerns.push(event.message);
  }
  return state;
}

function validateEvent(event, currentState) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('event must be an object');
  if (!['phase', 'brief', 'runtime', 'plan', 'screen', 'finding', 'concern'].includes(event.kind)) {
    throw new Error(`unsupported event kind ${event.kind || '<empty>'}`);
  }
  if (event.kind === 'screen') {
    if (!event.id || !SCREEN_STATES.includes(event.state)) throw new Error('screen event requires id and a valid state');
    const prior = currentState.screens[event.id]?.state;
    if (prior && !NEXT_SCREEN_STATES[prior].has(event.state) && prior !== event.state) {
      throw new Error(`screen ${event.id} cannot transition ${prior} -> ${event.state}`);
    }
    if (!prior && event.state !== 'queued') throw new Error(`screen ${event.id} must start queued`);
  }
  if (event.kind === 'phase' && (!event.track || !event.id || !event.state)) throw new Error('phase event requires track, id, and state');
  if (event.kind === 'concern' && !String(event.message || '').trim()) throw new Error('concern event requires message');
}

function append(projectDir, input) {
  const target = initialize(projectDir);
  const existing = readEvents(projectDir);
  const current = reduce(existing);
  validateEvent(input, current);
  const meta = JSON.parse(fs.readFileSync(target.meta, 'utf8'));
  const event = { t: Number(((Date.now() - meta.startedAtMs) / 1000).toFixed(3)), ...input };
  const descriptor = fs.openSync(target.events, 'a');
  try { fs.writeSync(descriptor, `${JSON.stringify(event)}\n`); } finally { fs.closeSync(descriptor); }
  const next = reduce([...existing, event]);
  writeProgressProjection(projectDir, next);
  return event;
}

function progressItems(state) {
  const screens = Object.values(state.screens);
  if (screens.length > 0) return screens.map((screen) => ({ id: screen.id, label: screen.label || screen.id, state: screen.state, file: screen.file }));
  return Object.values(state.phases).map((phase) => ({ id: `${phase.track}-${phase.id}`, label: phase.label || phase.id, state: phase.state === 'complete' ? 'built' : phase.state === 'failed' ? 'failed' : 'building' }));
}

function writeProgressProjection(projectDir, state) {
  const items = progressItems(state);
  atomicWrite(paths(projectDir).progress, `// Reduced from .mobile-build/events.ndjson.\nexport type BuildScreenState = 'queued' | 'building' | 'written' | 'checked' | 'built' | 'failed';\nexport const buildProgress: ReadonlyArray<{ id: string; label: string; state: BuildScreenState; file?: string }> = ${JSON.stringify(items, null, 2)};\n`);
}

function formatTerminal(event) {
  if (event.kind === 'screen') return `[${event.state}] ${event.label || event.id}`;
  if (event.kind === 'runtime') return `[runtime:${event.state}]${event.url ? ` ${event.url}` : ''}`;
  if (event.kind === 'concern') return `[concern] ${event.message}`;
  if (event.kind === 'brief') {
    const summary = event.summary || {};
    const list = (value) => Array.isArray(value) ? value.join('; ') || 'none' : value || 'none';
    return [
      `Understood: ${summary.understood || 'prototype requirements captured'}`,
      `Flow:       ${summary.flow || 'not inferred'}`,
      `Records:    ${list(summary.records)}`,
      `Inferred:   ${list(summary.inferred)}`,
      `Native:     ${list(summary.native)}`,
      `Dropped:    ${list(summary.dropped)}`,
      `Connectors: ${list(summary.connectors)}`,
      `Assumed:    ${summary.assumed || 'no visual assumption'}`,
    ].join('\n');
  }
  return `[${event.kind}] ${event.id || event.state || ''}`.trim();
}

function renderMiddleware() {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const eventsPath = path.join(__dirname, 'events.ndjson');
function events() { return fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8').split('\\n').filter(Boolean).map(JSON.parse) : []; }
function reduce(list) {
  const state = { brief: null, concerns: [], findings: [], phases: {}, plan: null, runtime: { state: 'queued', url: null }, screens: {} };
  for (const event of list) {
    if (event.kind === 'phase') state.phases[event.track + ':' + event.id] = event;
    else if (event.kind === 'brief') state.brief = event.summary;
    else if (event.kind === 'runtime') state.runtime = { ...state.runtime, ...event };
    else if (event.kind === 'plan') state.plan = event;
    else if (event.kind === 'screen') state.screens[event.id] = { ...(state.screens[event.id] || {}), ...event };
    else if (event.kind === 'finding') state.findings.push(event);
    else if (event.kind === 'concern' && !state.concerns.includes(event.message)) state.concerns.push(event.message);
  }
  return state;
}
module.exports = function handleBuildEvents(req, res) {
  const pathname = String(req.url || '').split('?')[0];
  if (pathname === '/build/state') {
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.setHeader('Access-Control-Allow-Origin', '*'); res.end(JSON.stringify(reduce(events()))); return true;
  }
  if (pathname !== '/build/events') return false;
  res.statusCode = 200; res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.setHeader('Access-Control-Allow-Origin', '*');
  let offset = 0;
  const replay = () => { const list = events(); for (const event of list.slice(offset)) res.write('data: ' + JSON.stringify(event) + '\\n\\n'); offset = list.length; };
  replay();
  const watcher = fs.watch(path.dirname(eventsPath), (kind, name) => { if (name === path.basename(eventsPath)) replay(); });
  req.on('close', () => watcher.close());
  return true;
};
`;
}

function parseArgs(argv) {
  const [command, projectArg] = argv;
  if (!command || !projectArg) throw new Error('usage: events.js <init|emit|state|replay> <project-dir> [--json <event>]');
  return { command, projectDir: path.resolve(projectArg), json: argv[argv.indexOf('--json') + 1] };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === 'init') console.log(JSON.stringify(initialize(args.projectDir)));
    else if (args.command === 'emit') {
      const event = append(args.projectDir, JSON.parse(args.json));
      console.log(formatTerminal(event));
    } else if (args.command === 'state') console.log(JSON.stringify(reduce(readEvents(args.projectDir)), null, 2));
    else if (args.command === 'replay') for (const event of readEvents(args.projectDir)) console.log(formatTerminal(event));
    else throw new Error(`unknown events command ${args.command}`);
  } catch (error) {
    console.error(`prototype-events: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { SCREEN_STATES, append, formatTerminal, initialize, paths, progressItems, readEvents, reduce, renderMiddleware, validateEvent, writeProgressProjection };