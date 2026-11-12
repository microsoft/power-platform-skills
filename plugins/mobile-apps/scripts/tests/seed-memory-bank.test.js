'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { seedMemoryBank } = require('../seed-memory-bank');

const SCRIPT = path.resolve(__dirname, '..', 'seed-memory-bank.js');
const REQUIREMENTS = { appName: "Dave's | Rounds", slug: 'daves-rounds' };
const ENVIRONMENT = {
  environmentId: '00000000-0000-4000-8000-000000000000',
  displayName: 'Contoso Dev',
  environmentUrl: 'https://contoso.crm.dynamics.com',
};

const row = (markdown, key) => markdown.split('\n').find((line) => line.startsWith(`| ${key} |`));

test('a new bank carries the app and environment facts the run already knows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-bank-'));
  const result = seedMemoryBank({
    workingDir: root, requirements: REQUIREMENTS, environment: ENVIRONMENT, now: new Date('2026-10-14T05:00:00Z'),
  });
  assert.equal(result.created, true);
  assert.deepEqual(result.missingRows, [], 'every fact row exists in the template');

  const bank = fs.readFileSync(path.join(root, 'memory-bank.md'), 'utf8');
  // A `|` in a user's app name would otherwise split the table cell.
  assert.equal(row(bank, 'Display name'), "| Display name | Dave's \\| Rounds |");
  assert.equal(row(bank, 'Slug'), '| Slug | daves-rounds |');
  assert.equal(row(bank, 'Created'), '| Created | 2026-10-14 |');
  assert.equal(row(bank, 'Active environment ID'), `| Active environment ID | ${ENVIRONMENT.environmentId} |`);
  assert.equal(row(bank, 'Environment URL'), '| Environment URL | https://contoso.crm.dynamics.com |');
  assert.equal(row(bank, 'CLI Binary'), '| CLI Binary | pa |');
  assert.equal(row(bank, 'Visual companion'), '| Visual companion | yes |');
  assert.match(row(bank, 'Plugin version that created the project'), /^\| Plugin version that created the project \| \d+\.\d+\.\d+ \|$/);
  // The rest of the template arrives intact.
  assert.match(bank, /## Native capabilities/);
  assert.match(bank, /\| Web preview command \|/);
});

test('a rerun refreshes the facts and keeps what later steps appended', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-bank-'));
  seedMemoryBank({ workingDir: root, requirements: REQUIREMENTS, environment: ENVIRONMENT });
  const file = path.join(root, 'memory-bank.md');
  fs.appendFileSync(file, '\n## Concerns\n\n- kept\n');

  const again = seedMemoryBank({ workingDir: root, requirements: { ...REQUIREMENTS, appName: 'Rounds' }, environment: ENVIRONMENT });
  const bank = fs.readFileSync(file, 'utf8');
  assert.equal(again.created, false);
  assert.equal(row(bank, 'Display name'), '| Display name | Rounds |');
  assert.match(bank, /- kept\n$/);
  assert.equal(bank.split('| Visual companion |').length, 2, 'the added fact row is not duplicated');
});

test('the CLI reads its inputs from files and refuses an incomplete environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-bank-'));
  const requirements = path.join(root, 'requirements.json');
  const environment = path.join(root, 'environment.json');
  fs.writeFileSync(requirements, JSON.stringify(REQUIREMENTS));
  fs.writeFileSync(environment, JSON.stringify({ displayName: 'No id' }));
  const failed = spawnSync(process.execPath, [SCRIPT, '--working-dir', root, '--requirements', requirements, '--environment', environment], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /no environmentId/);
  assert.equal(fs.existsSync(path.join(root, 'memory-bank.md')), false);

  fs.writeFileSync(environment, JSON.stringify(ENVIRONMENT));
  const ok = spawnSync(process.execPath, [SCRIPT, '--working-dir', root, '--requirements', requirements, '--environment', environment, '--cli-binary', 'power-apps'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).created, true);
  assert.equal(row(fs.readFileSync(path.join(root, 'memory-bank.md'), 'utf8'), 'CLI Binary'), '| CLI Binary | power-apps |');
});
