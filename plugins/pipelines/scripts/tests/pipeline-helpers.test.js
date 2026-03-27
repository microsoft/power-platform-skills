const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractEntityId,
  UUID_REGEX,
  stageRunStatusName,
  TERMINAL_STATUSES,
  STAGE_RUN_STATUS,
  ENV_TYPE
} = require('../lib/pipeline-helpers');

// --- extractEntityId ---

test('extractEntityId returns GUID from valid OData-EntityId header', () => {
  const header = 'https://org.crm.dynamics.com/api/data/v9.2/deploymentpipelines(a1b2c3d4-e5f6-7890-abcd-ef1234567890)';
  assert.equal(extractEntityId(header), 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
});

test('extractEntityId returns null for null input', () => {
  assert.equal(extractEntityId(null), null);
});

test('extractEntityId returns null for undefined input', () => {
  assert.equal(extractEntityId(undefined), null);
});

test('extractEntityId returns null when no GUID match', () => {
  assert.equal(extractEntityId('https://org.crm.dynamics.com/api/data/v9.2/entities(not-a-guid)'), null);
});

test('extractEntityId works with different entity paths', () => {
  const envHeader = 'https://org.crm.dynamics.com/api/data/v9.2/deploymentenvironments(11111111-2222-3333-4444-555555555555)';
  assert.equal(extractEntityId(envHeader), '11111111-2222-3333-4444-555555555555');

  const stageHeader = 'https://org.crm.dynamics.com/api/data/v9.2/deploymentstages(aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)';
  assert.equal(extractEntityId(stageHeader), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

// --- UUID_REGEX ---

test('UUID_REGEX matches valid lowercase GUID', () => {
  assert.ok(UUID_REGEX.test('a1b2c3d4-e5f6-7890-abcd-ef1234567890'));
});

test('UUID_REGEX matches valid uppercase GUID', () => {
  assert.ok(UUID_REGEX.test('A1B2C3D4-E5F6-7890-ABCD-EF1234567890'));
});

test('UUID_REGEX matches all-zeros GUID', () => {
  assert.ok(UUID_REGEX.test('00000000-0000-0000-0000-000000000000'));
});

test('UUID_REGEX rejects string that is too short', () => {
  assert.ok(!UUID_REGEX.test('a1b2c3d4-e5f6-7890-abcd'));
});

test('UUID_REGEX rejects string without dashes', () => {
  assert.ok(!UUID_REGEX.test('a1b2c3d4e5f67890abcdef1234567890'));
});

test('UUID_REGEX rejects empty string', () => {
  assert.ok(!UUID_REGEX.test(''));
});

test('UUID_REGEX rejects non-hex characters', () => {
  assert.ok(!UUID_REGEX.test('g1b2c3d4-e5f6-7890-abcd-ef1234567890'));
});

// --- stageRunStatusName ---

test('stageRunStatusName returns correct name for known codes', () => {
  assert.equal(stageRunStatusName(200000000), 'NotStarted');
  assert.equal(stageRunStatusName(200000002), 'Succeeded');
  assert.equal(stageRunStatusName(200000003), 'Failed');
  assert.equal(stageRunStatusName(200000004), 'Canceled');
  assert.equal(stageRunStatusName(200000006), 'Validating');
  assert.equal(stageRunStatusName(200000007), 'ValidationSucceeded');
  assert.equal(stageRunStatusName(200000010), 'Deploying');
});

test('stageRunStatusName returns Unknown(code) for unknown code', () => {
  assert.equal(stageRunStatusName(999999), 'Unknown(999999)');
});

// --- TERMINAL_STATUSES ---

test('TERMINAL_STATUSES contains Succeeded, Failed, Canceled', () => {
  assert.deepEqual(TERMINAL_STATUSES, [
    STAGE_RUN_STATUS.SUCCEEDED,
    STAGE_RUN_STATUS.FAILED,
    STAGE_RUN_STATUS.CANCELED
  ]);
});

// --- STAGE_RUN_STATUS ---

test('STAGE_RUN_STATUS has all 11 values', () => {
  const keys = Object.keys(STAGE_RUN_STATUS);
  assert.equal(keys.length, 11);
  assert.ok(keys.includes('NOT_STARTED'));
  assert.ok(keys.includes('STARTED'));
  assert.ok(keys.includes('SUCCEEDED'));
  assert.ok(keys.includes('FAILED'));
  assert.ok(keys.includes('CANCELED'));
  assert.ok(keys.includes('SCHEDULED'));
  assert.ok(keys.includes('VALIDATING'));
  assert.ok(keys.includes('VALIDATION_SUCCEEDED'));
  assert.ok(keys.includes('PRE_DEPLOY_IN_PROGRESS'));
  assert.ok(keys.includes('PRE_DEPLOY_SUCCEEDED'));
  assert.ok(keys.includes('DEPLOYING'));
});

// --- ENV_TYPE ---

test('ENV_TYPE has correct development and target values', () => {
  assert.equal(ENV_TYPE.DEVELOPMENT, 200000000);
  assert.equal(ENV_TYPE.TARGET, 200000001);
});
