'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openJournal } = require('../lib/build-journal.js');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
const lines = (dir) => fs.readFileSync(path.join(dir, 'build-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('openJournal writes run-start, records steps, and closes with run-end', () => {
  const dir = tmpdir();
  const j = openJournal(dir, { app: 'X' });
  j.record({ phase: 'solution', status: 'ok', label: 'sol' });
  j.record({ phase: 'data-model', status: 'skip', label: 'table (exists)' });
  j.close({ status: 'complete', ok: 1, skip: 1, error: 0 });
  const l = lines(dir);
  assert.strictEqual(l[0].event, 'run-start');
  assert.strictEqual(l[0].app, 'X');
  assert.strictEqual(l[1].event, 'step');
  assert.strictEqual(l[1].status, 'ok');
  assert.strictEqual(l[2].status, 'skip');
  assert.strictEqual(l[3].event, 'run-end');
  assert.strictEqual(l[3].status, 'complete');
  assert.strictEqual(l[3].ok, 1);
  assert.ok(l.every((x) => typeof x.ts === 'string'), 'every record is timestamped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('openJournal appends across runs (a second run adds a new block)', () => {
  const dir = tmpdir();
  openJournal(dir).close({ status: 'done' });
  openJournal(dir).close({ status: 'done' });
  assert.strictEqual(lines(dir).length, 4, 'two run-start/run-end blocks');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('journaling never throws when the directory is unwritable', () => {
  const tmp = tmpdir();
  const asFile = path.join(tmp, 'afile');
  fs.writeFileSync(asFile, 'x');
  const j = openJournal(path.join(asFile, 'sub')); // parent is a file -> mkdir fails
  assert.strictEqual(j.path, null);
  assert.doesNotThrow(() => { j.record({ status: 'ok' }); j.close({ status: 'done' }); });
  fs.rmSync(tmp, { recursive: true, force: true });
});
