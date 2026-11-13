'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { seedMemoryBank } = require('../seed-memory-bank');
const { createSkillWorkflow } = require('./helpers/create-skill');

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
    workingDir: root, requirements: REQUIREMENTS, environment: ENVIRONMENT, visualCompanion: 'yes',
    now: new Date('2026-10-14T05:00:00Z'),
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
  // `/preview-screens` greps `^visual_companion:`, so the preference is that line, not a table row,
  // and a blank line keeps Markdown from reading it as one more row of the facts table.
  assert.match(bank, /\| Web preview command \|[^\n]*\|\n\nvisual_companion: yes\n\n## Power Platform context/);
  assert.equal(row(bank, 'Visual companion'), undefined);
  assert.match(row(bank, 'Plugin version that created the project'), /^\| Plugin version that created the project \| \d+\.\d+\.\d+ \|$/);
  // The rest of the template arrives intact.
  assert.match(bank, /## Native capabilities/);
  assert.match(bank, /\| Web preview command \|/);
});

test('a rerun refreshes current facts and keeps creation history, the preference, and appended entries', () => {
  // Scaffold setup and Step 9.0 both seed the bank, and a run can be continued on a later day or
  // after a plugin update.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-bank-'));
  seedMemoryBank({
    workingDir: root, requirements: REQUIREMENTS, environment: ENVIRONMENT, visualCompanion: 'no',
    now: new Date('2026-10-14T05:00:00Z'),
  });
  const file = path.join(root, 'memory-bank.md');
  const versionRow = (bank) => row(bank, 'Plugin version that created the project');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replace(versionRow(fs.readFileSync(file, 'utf8')), '| Plugin version that created the project | 0.1.0 |'));
  fs.appendFileSync(file, '\n## Concerns\n\n- kept\n');

  const again = seedMemoryBank({
    workingDir: root,
    requirements: { ...REQUIREMENTS, appName: 'Rounds' },
    environment: { ...ENVIRONMENT, displayName: 'Contoso Test' },
    visualCompanion: 'yes',
    now: new Date('2026-11-20T05:00:00Z'),
  });
  const bank = fs.readFileSync(file, 'utf8');
  assert.equal(again.created, false);
  assert.deepEqual(again.missingRows, []);
  assert.equal(row(bank, 'Display name'), '| Display name | Rounds |');
  assert.equal(row(bank, 'Active environment name'), '| Active environment name | Contoso Test |');
  assert.equal(row(bank, 'Created'), '| Created | 2026-10-14 |', 'the creation date is history');
  assert.equal(versionRow(bank), '| Plugin version that created the project | 0.1.0 |', 'so is the creating version');
  assert.equal(bank.match(/^visual_companion:.*$/gm).join('|'), 'visual_companion: no',
    'a later default does not reset the recorded preference, and the line is not duplicated');
  assert.match(bank, /- kept\n$/);
});

test('without a preference the seeder leaves visual_companion unset, so readers use their default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-bank-'));
  seedMemoryBank({ workingDir: root, requirements: REQUIREMENTS, environment: ENVIRONMENT });
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'memory-bank.md'), 'utf8'), /^visual_companion:/m);
});

test('both screens-first seeding steps record the run\'s preview preference', () => {
  // `--no-design` sets `<visual_companion> = no` and skips /design-system, so the seeder is the only
  // step that can record it for /preview-screens and /edit-app.
  const calls = createSkillWorkflow().split('\n').filter((line) => line.startsWith('node ') && line.includes('seed-memory-bank.js'));
  assert.equal(calls.length, 2);
  for (const call of calls) assert.match(call, /--visual-companion '<visual_companion>'/);
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
  const args = [SCRIPT, '--working-dir', root, '--requirements', requirements, '--environment', environment, '--cli-binary', 'power-apps'];
  // An unsubstituted placeholder is refused before anything is written.
  const placeholder = spawnSync(process.execPath, [...args, '--visual-companion', '<visual_companion>'], { encoding: 'utf8' });
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.stderr, /--visual-companion must be yes or no/);
  assert.equal(fs.existsSync(path.join(root, 'memory-bank.md')), false);

  const ok = spawnSync(process.execPath, [...args, '--visual-companion', 'no'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).created, true);
  const bank = fs.readFileSync(path.join(root, 'memory-bank.md'), 'utf8');
  assert.equal(row(bank, 'CLI Binary'), '| CLI Binary | power-apps |');
  assert.match(bank, /^visual_companion: no$/m);
});
