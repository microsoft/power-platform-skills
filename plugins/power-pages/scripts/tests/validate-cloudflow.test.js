const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const { createTempProject, writeProjectFile } = require('./test-utils');

const VALIDATOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'add-cloud-flow',
  'scripts',
  'validate-cloudflow.js'
);

function runValidator(projectRoot) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
  });
}

function writeFlowFile(projectRoot, slug, content) {
  writeProjectFile(
    projectRoot,
    `.powerpages-site/cloud-flow-consumer/${slug}.cloudflowconsumer.yml`,
    content
  );
}

const VALID_YML = `adx_CloudFlowConsumer_adx_webrole:
  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
flowapiurl: /_api/cloudflow/v1.0/trigger/11111111-2222-3333-4444-555555555555
flowtriggerurl: ''
id: 66666666-7777-8888-9999-aaaaaaaaaaaa
metadata: Send email notification
name: PowerPages -> Send an email notification (V3)
processid: 11111111-2222-3333-4444-555555555555
`;

test('approves when no cloud-flow-consumer directory exists', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('approves when cloud-flow-consumer directory is empty', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, '.powerpages-site/cloud-flow-consumer/.gitkeep', '');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('valid YAML passes validation', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('missing id is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML.replace(/^id:.*\n/m, ''));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing 'id' field/);
});

test('invalid id UUID is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML.replace(/^id: .+$/m, 'id: not-a-uuid'));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /'id' is not a valid UUID/);
});

test('missing processid is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML.replace(/^processid:.*\n/m, ''));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing 'processid' field/);
});

test('invalid processid UUID is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML.replace(/^processid: .+$/m, 'processid: bad-uuid'));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /'processid' is not a valid UUID/);
});

test('missing name is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML.replace(/^name:.*\n/m, ''));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing or empty 'name' field/);
});

test('missing flowapiurl is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML.replace(/^flowapiurl:.*\n/m, ''));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing 'flowapiurl' field/);
});

test('missing flowtriggerurl is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML.replace(/^flowtriggerurl:.*\n/m, ''));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing 'flowtriggerurl' field/);
});

test('empty flowapiurl is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML.replace(/^flowapiurl: .+$/m, "flowapiurl: ''"));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /'flowapiurl' is empty/);
});

test('empty flowtriggerurl passes (always empty in Power Pages)', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('missing web role section is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(
    projectRoot,
    'send-email',
    VALID_YML.replace(/^adx_CloudFlowConsumer_adx_webrole:.*\n  - .*\n/m, '')
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing 'adx_CloudFlowConsumer_adx_webrole'/);
});

test('empty web role array is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(
    projectRoot,
    'send-email',
    VALID_YML.replace(/^  - aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n/m, '')
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /array is empty/);
});

test('invalid web role UUID is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(
    projectRoot,
    'send-email',
    VALID_YML.replace('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'not-a-uuid')
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /web role 'not-a-uuid' is not a valid UUID/);
});

test('adx_-prefixed scalar field is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML + 'adx_websiteid: some-value\n');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unexpected adx_-prefixed fields/);
});

test('statecode presence is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'send-email', VALID_YML + 'statecode: 0\n');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /statecode.*statuscode.*must not be present/);
});

test('validates multiple flow files and reports all errors', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeFlowFile(projectRoot, 'flow-one', VALID_YML.replace(/^id:.*\n/m, ''));
  writeFlowFile(projectRoot, 'flow-two', VALID_YML.replace(/^processid: .+$/m, 'processid: bad'));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /flow-one\.cloudflowconsumer\.yml/);
  assert.match(result.stderr, /flow-two\.cloudflowconsumer\.yml/);
});
