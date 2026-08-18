'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const EVAL_FILES = [
  'skills/create-push-notification-flow/evals/evals.json',
  'skills/setup-push-wif/evals/evals.json',
  'skills/setup-push-service-account/evals/evals.json',
  'skills/add-dataverse/evals/evals.json',
  'skills/set-app-registration-native/evals/evals.json',
];
const ORCHESTRATION_EVAL_PATH = path.join(
  PLUGIN_ROOT,
  'skills/add-push-notifications/evals/evals.json',
);

test('the handoff regression scenarios are represented exactly once', () => {
  const evals = EVAL_FILES.flatMap((relativePath) => (
    require(path.join(PLUGIN_ROOT, relativePath)).evals
  ));
  const ids = evals.map(({ id }) => id).sort((left, right) => left - right);

  assert.deepStrictEqual(ids, Array.from({ length: 39 }, (_, index) => index + 1));
  for (const evaluation of evals) {
    assert.ok(evaluation.prompt.trim(), `scenario ${evaluation.id} needs a prompt`);
    assert.ok(evaluation.expected_output.trim(), `scenario ${evaluation.id} needs expected output`);
  }
});

test('push orchestration documents independent resumable setup tracks', () => {
  const orchestration = require(ORCHESTRATION_EVAL_PATH);
  assert.strictEqual(orchestration.skill_name, 'add-push-notifications');
  assert.deepStrictEqual(
    orchestration.evals.map(({ id }) => id),
    [1, 2, 3, 4, 5, 6],
  );

  const skill = require('node:fs').readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const readme = require('node:fs').readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const agents = require('node:fs').readFileSync(path.join(PLUGIN_ROOT, 'AGENTS.md'), 'utf8');

  assert.match(skill, /independent,\s+resumable tracks/);
  assert.match(
    skill,
    /Multiple safe exact\s+matches require.*independently for Android\s+and iOS/s,
  );
  assert.match(skill, /run\s+`\/create-push-notification-flow` directly/);
  assert.match(readme, /`\/setup-push-service-account`/);
  assert.match(readme, /Push notification cloud prerequisites/);
  assert.match(readme, /premium connector/);
  assert.match(agents, /WIF is the preferred sender authentication/);
  assert.match(agents, /managed identity reads the existing Firebase JSON from Azure Key Vault/);
});
