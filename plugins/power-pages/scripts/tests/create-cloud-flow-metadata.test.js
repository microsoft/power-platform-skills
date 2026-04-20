const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTempProject } = require('./test-utils');

function runCreateCloudFlowMetadata(args) {
  const cliPath = path.join(
    __dirname,
    '..',
    '..',
    'skills',
    'add-cloud-flow',
    'scripts',
    'create-cloud-flow-metadata.js'
  );
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

const VALID_FLOW_ID   = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VALID_ROLE_ID_1 = 'ffffffff-0000-1111-2222-333333333333';
const VALID_ROLE_ID_2 = '44444444-5555-6666-7777-888888888888';

test('writes correctly-structured YAML with display name and no websiteid', (t) => {
  const projectRoot = createTempProject(t);

  const result = runCreateCloudFlowMetadata([
    '--projectRoot',    projectRoot,
    '--fileSlug',       'send-email-notification',
    '--flowName',       'PowerPages -> Send an email notification (V3)',
    '--flowId',         VALID_FLOW_ID,
    '--flowTriggerUrl', 'https://prod-01.westus.logic.azure.com/workflows/trigger/manual/run',
    '--flowApiUrl',     '/_api/cloudflow/v1.0/trigger/' + VALID_FLOW_ID,
    '--webRoleIds',     [VALID_ROLE_ID_1, VALID_ROLE_ID_2].join(','),
    '--metadata',       'Send email notification',
  ]);

  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.filePath, /send-email-notification\.cloudflowconsumer\.yml$/);
  assert.match(parsed.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  const yaml = fs.readFileSync(parsed.filePath, 'utf8');

  // M2M relationship — full name kept (adx_ NOT stripped per PAPortalCommon.cs)
  assert.match(yaml, /^adx_CloudFlowConsumer_adx_webrole:\n  - ffffffff-0000-1111-2222-333333333333\n  - 44444444-5555-6666-7777-888888888888$/m);

  // name = flow display name, not a slug (always single-quoted for safe YAML)
  assert.match(yaml, /^name: 'PowerPages -> Send an email notification \(V3\)'$/m);
  assert.match(yaml, /^processid: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee$/m);
  assert.match(yaml, /^flowapiurl: '\/_api\/cloudflow\/v1\.0\/trigger\//m);
  assert.match(yaml, /^flowtriggerurl: 'https:\/\//m);
  assert.match(yaml, /^id: [0-9a-f-]{36}$/m);
  assert.match(yaml, /^metadata: 'Send email notification'$/m);

  // websiteid must NOT be present
  assert.doesNotMatch(yaml, /^websiteid:/m);

  // statecode/statuscode must NOT be present
  assert.doesNotMatch(yaml, /^statecode:/m);
  assert.doesNotMatch(yaml, /^statuscode:/m);
});

test('empty strings serialized as quoted empty string', (t) => {
  const projectRoot = createTempProject(t);

  const result = runCreateCloudFlowMetadata([
    '--projectRoot',    projectRoot,
    '--fileSlug',       'my-flow',
    '--flowName',       'My Flow',
    '--flowId',         VALID_FLOW_ID,
    '--flowTriggerUrl', '',
    '--flowApiUrl',     '',
    '--webRoleIds',     VALID_ROLE_ID_1,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const yaml = fs.readFileSync(JSON.parse(result.stdout).filePath, 'utf8');

  assert.match(yaml, /^flowtriggerurl: ''$/m);
  assert.match(yaml, /^flowapiurl: ''$/m);
  assert.match(yaml, /^metadata: ''$/m);
});

test('creates cloud-flow-consumer directory if absent', (t) => {
  const projectRoot = createTempProject(t);

  const result = runCreateCloudFlowMetadata([
    '--projectRoot', projectRoot,
    '--fileSlug',    'my-flow',
    '--flowName',    'My Flow',
    '--flowId',      VALID_FLOW_ID,
    '--webRoleIds',  VALID_ROLE_ID_1,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(projectRoot, '.powerpages-site', 'cloud-flow-consumer')));
});

test('rejects invalid flow UUID', (t) => {
  const projectRoot = createTempProject(t);

  const result = runCreateCloudFlowMetadata([
    '--projectRoot', projectRoot,
    '--fileSlug',    'my-flow',
    '--flowName',    'My Flow',
    '--flowId',      'not-a-uuid',
    '--webRoleIds',  VALID_ROLE_ID_1,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /flowId must be a valid UUID/);
});

test('rejects invalid web role UUID', (t) => {
  const projectRoot = createTempProject(t);

  const result = runCreateCloudFlowMetadata([
    '--projectRoot', projectRoot,
    '--fileSlug',    'my-flow',
    '--flowName',    'My Flow',
    '--flowId',      VALID_FLOW_ID,
    '--webRoleIds',  'bad-role-id',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid UUID in --webRoleIds/);
});

test('rejects unsafe file slug (path traversal)', (t) => {
  const projectRoot = createTempProject(t);

  const result = runCreateCloudFlowMetadata([
    '--projectRoot', projectRoot,
    '--fileSlug',    '../evil',
    '--flowName',    'Evil Flow',
    '--flowId',      VALID_FLOW_ID,
    '--webRoleIds',  VALID_ROLE_ID_1,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /lowercase alphanumeric with hyphens/);
});

test('rejects uppercase file slug', (t) => {
  const projectRoot = createTempProject(t);

  const result = runCreateCloudFlowMetadata([
    '--projectRoot', projectRoot,
    '--fileSlug',    'My-Flow',
    '--flowName',    'My Flow',
    '--flowId',      VALID_FLOW_ID,
    '--webRoleIds',  VALID_ROLE_ID_1,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /lowercase alphanumeric with hyphens/);
});

test('rejects file slug with underscores', (t) => {
  const projectRoot = createTempProject(t);

  const result = runCreateCloudFlowMetadata([
    '--projectRoot', projectRoot,
    '--fileSlug',    'my_flow',
    '--flowName',    'My Flow',
    '--flowId',      VALID_FLOW_ID,
    '--webRoleIds',  VALID_ROLE_ID_1,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /lowercase alphanumeric with hyphens/);
});

test('rejects file slug exceeding 50 characters', (t) => {
  const projectRoot = createTempProject(t);

  const result = runCreateCloudFlowMetadata([
    '--projectRoot', projectRoot,
    '--fileSlug',    'a'.repeat(51),
    '--flowName',    'Long Flow',
    '--flowId',      VALID_FLOW_ID,
    '--webRoleIds',  VALID_ROLE_ID_1,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most 50 characters/);
});

test('errors when file already exists', (t) => {
  const projectRoot = createTempProject(t);
  const cloudFlowDir = path.join(projectRoot, '.powerpages-site', 'cloud-flow-consumer');
  fs.mkdirSync(cloudFlowDir, { recursive: true });
  fs.writeFileSync(path.join(cloudFlowDir, 'existing-flow.cloudflowconsumer.yml'), 'id: x\n', 'utf8');

  const result = runCreateCloudFlowMetadata([
    '--projectRoot', projectRoot,
    '--fileSlug',    'existing-flow',
    '--flowName',    'Existing Flow',
    '--flowId',      VALID_FLOW_ID,
    '--webRoleIds',  VALID_ROLE_ID_1,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
});
