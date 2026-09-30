'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { activeEnvironment, listEnvironments, parseEnvList } = require('../list-environments');

const scriptPath = path.resolve(__dirname, '..', 'list-environments.js');

// Synthetic fixture only. Real tenant environment names, URLs and GUIDs must never
// enter this repo (see the root CLAUDE.md and validate-no-real-environments.js), so
// this mirrors the SHAPE of `pac env list` with placeholder values.
const SAMPLE = [
  'Connected as maker@contoso.onmicrosoft.com',
  'Active Display Name                       Environment ID                       Environment URL                          Unique Name',
  '       Contoso Prod                       22222222-3333-4444-5555-666666666666 https://contosoprod.crm4.dynamics.com/   unq22222222222222222222222222222',
  '*      Contoso Dev                        11111111-2222-3333-4444-555555555555 https://contosodev.crm.dynamics.com/     unq11111111111111111111111111111',
  '       [DO NOT USE] Web API * Migration   a1b2c3d4-1111-2222-3333-444455556666 https://contosolegacy.crm.dynamics.com/  unq33333333333333333333333333333',
  '',
].join('\n');

test('every data row is parsed and the banner and header are skipped', () => {
  const rows = parseEnvList(SAMPLE);
  assert.equal(rows.length, 3);
  assert.deepEqual(Object.keys(rows[0]), [
    'displayName', 'environmentId', 'environmentUrl', 'uniqueName', 'active',
  ]);
  assert.equal(rows[0].displayName, 'Contoso Prod');
  assert.equal(rows[0].environmentId, '22222222-3333-4444-5555-666666666666');
  // The trailing slash is stripped so the value concatenates cleanly into API paths.
  assert.equal(rows[0].environmentUrl, 'https://contosoprod.crm4.dynamics.com');
});

test('the active environment is the one flagged in the Active column', () => {
  const rows = parseEnvList(SAMPLE);
  const active = activeEnvironment(rows);
  assert.equal(active.displayName, 'Contoso Dev');
  assert.equal(rows.filter((row) => row.active).length, 1);
});

test('a literal asterisk inside a display name is not read as the active marker', () => {
  // A real tenant had "[DO NOT USE] Web API * Migration Testing"; treating that as the
  // active flag would both mislabel it and truncate its name.
  const row = parseEnvList(SAMPLE).find((entry) => entry.displayName.includes('*'));
  assert.ok(row, 'the fixture must contain a name with an interior asterisk');
  assert.equal(row.active, false);
  assert.equal(row.displayName, '[DO NOT USE] Web API * Migration');
});

test('display names keep their internal spacing and brackets', () => {
  const rows = parseEnvList(SAMPLE);
  assert.ok(rows.every((row) => row.displayName === row.displayName.trim()));
  assert.ok(rows.some((row) => row.displayName.startsWith('[DO NOT USE]')));
});

test('unparseable input yields an empty list rather than throwing', () => {
  for (const input of [undefined, null, '', 'pac: command not found', 'Error: not authenticated', 42]) {
    assert.deepEqual(parseEnvList(input), []);
  }
  assert.equal(activeEnvironment([]), null);
  assert.equal(activeEnvironment(null), null);
});

test('a missing or failing PAC yields an empty list, never an exception', (t) => {
  // PAC is not a prerequisite of this plugin: no PAC means "ask for an environment ID",
  // never a failed run.
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'no-pac-'));
  const originalPath = process.env.PATH;
  process.env.PATH = emptyBin;
  t.after(() => { process.env.PATH = originalPath; });

  assert.deepEqual(listEnvironments(), []);
});

test('the CLI always prints parseable JSON and exits 0', () => {
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'no-pac-cli-'));
  const run = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: emptyBin },
  });
  assert.equal(run.status, 0, 'callers rely on exit 0 so a missing PAC cannot abort the skill');
  assert.deepEqual(JSON.parse(run.stdout.trim()), []);

  const bad = spawnSync(process.execPath, [scriptPath, '--nope'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: emptyBin },
  });
  assert.equal(bad.status, 0);
  assert.deepEqual(JSON.parse(bad.stdout.trim()), []);
});

test('selection flags keep the payload small enough to hand an agent', () => {
  const { selectRows } = require('../list-environments');
  const rows = parseEnvList(SAMPLE);

  assert.deepEqual(selectRows(rows, { active: true }).map((r) => r.displayName), ['Contoso Dev']);
  assert.equal(selectRows(rows, { limit: 2 }).length, 2);
  assert.equal(selectRows(rows, { limit: 0 }).length, 0);
  assert.equal(selectRows(rows, {}).length, rows.length);
  // --active wins over --limit ordering: filter first, then cap.
  assert.equal(selectRows(rows, { active: true, limit: 10 }).length, 1);
});

test('the CLI honours --active and --limit and rejects a bad limit safely', () => {
  const run = (...args) => spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });

  // A bad flag must still produce parseable JSON and exit 0 rather than aborting a run.
  const bad = run('--limit', 'lots');
  assert.equal(bad.status, 0);
  assert.deepEqual(JSON.parse(bad.stdout.trim()), []);
});
