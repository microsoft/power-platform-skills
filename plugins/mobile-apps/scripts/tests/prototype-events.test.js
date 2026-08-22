'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const events = require(path.resolve(__dirname, '..', '..', 'skills/create-mobile-prototype/runtime/events.js'));

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-events-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function response() {
  return {
    body: '', headers: {}, statusCode: 0,
    end(value = '') { this.body += value; },
    setHeader(name, value) { this.headers[name] = value; },
    write(value) { this.body += value; },
  };
}

test('event stream reduces exact screen progress and rejects invalid transitions', (t) => {
  const root = project(t);
  events.initialize(root);
  events.append(root, { kind: 'phase', track: 'A', id: 'install', label: 'Install', state: 'start' });
  events.append(root, { kind: 'runtime', state: 'metro-ready', url: 'exp://local' });
  events.append(root, { kind: 'screen', id: 'home', label: 'Home', state: 'queued', file: 'app/(app)/home.tsx' });
  for (const state of ['building', 'written', 'checked', 'built']) events.append(root, { kind: 'screen', id: 'home', state });
  const reduced = events.reduce(events.readEvents(root));
  assert.equal(reduced.runtime.url, 'exp://local');
  assert.equal(reduced.screens.home.state, 'built');
  assert.match(fs.readFileSync(events.paths(root).progress, 'utf8'), /"state": "built"/);
  assert.throws(() => events.append(root, { kind: 'screen', id: 'home', state: 'written' }), /cannot transition/);
});

test('Metro middleware replays events and reproduces cold state', (t) => {
  const root = project(t);
  events.initialize(root);
  events.append(root, { kind: 'brief', summary: { inferred: ['staff'], dropped: ['expo-haptics'] } });
  events.append(root, { kind: 'screen', id: 'requests', label: 'Requests', state: 'queued' });
  const handle = require(events.paths(root).middleware);

  const stateReq = new EventEmitter(); stateReq.url = '/build/state';
  const stateRes = response();
  assert.equal(handle(stateReq, stateRes), true);
  assert.deepEqual(JSON.parse(stateRes.body), events.reduce(events.readEvents(root)));

  const eventReq = new EventEmitter(); eventReq.url = '/build/events';
  const eventRes = response();
  assert.equal(handle(eventReq, eventRes), true);
  assert.match(eventRes.body, /data: .*"kind":"brief"/);
  assert.match(eventRes.body, /data: .*"id":"requests"/);
  eventReq.emit('close');
  const ignoredReq = new EventEmitter(); ignoredReq.url = '/other';
  assert.equal(handle(ignoredReq, response()), false);
});

test('terminal and phone projections consume the same event reduction', (t) => {
  const root = project(t);
  const event = events.append(root, { kind: 'screen', id: 'detail', label: 'Request detail', state: 'queued' });
  assert.equal(events.formatTerminal(event), '[queued] Request detail');
  const projected = events.progressItems(events.reduce(events.readEvents(root)));
  assert.deepEqual(projected, [{ id: 'detail', label: 'Request detail', state: 'queued', file: undefined }]);
  const brief = events.formatTerminal({ kind: 'brief', summary: {
    understood: 'badge access', flow: 'request -> approve -> issue', records: ['request'],
    inferred: ['staff'], native: ['camera'], dropped: ['haptics'], connectors: [], assumed: 'Productivity',
  } });
  for (const label of ['Understood:', 'Flow:', 'Records:', 'Inferred:', 'Native:', 'Dropped:', 'Connectors:', 'Assumed:']) {
    assert.match(brief, new RegExp(label));
  }
});

test('prototype workflow exposes one event source to terminal, phone, and Metro', () => {
  const skill = fs.readFileSync(path.resolve(__dirname, '..', '..', 'skills/create-mobile-prototype/SKILL.md'), 'utf8');
  assert.match(skill, /\.mobile-build\/events\.ndjson/);
  assert.match(skill, /GET \/build\/events/);
  assert.match(skill, /GET \/build\/state/);
  assert.match(skill, /Neither track prints progress directly/);
  assert.match(skill, /"kind":"brief"/);
});