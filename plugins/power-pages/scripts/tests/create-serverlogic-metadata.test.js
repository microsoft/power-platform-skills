const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTempProject } = require('./test-utils');

function runCreateServerlogicMetadata(args) {
  const cliPath = path.join(
    __dirname,
    '..',
    '..',
    'skills',
    'add-server-logic',
    'scripts',
    'create-serverlogic-metadata.js'
  );

  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
  });
}

test('create-serverlogic-metadata writes sorted metadata YAML', (t) => {
  const projectRoot = createTempProject(t);
  const endpointDir = path.join(projectRoot, '.powerpages-site', 'server-logic', 'ticket-dashboard');
  fs.mkdirSync(endpointDir, { recursive: true });
  fs.writeFileSync(path.join(endpointDir, 'ticket-dashboard.js'), 'function get() { return "{}"; }\n', 'utf8');

  const roleIds = [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
  ];

  const result = runCreateServerlogicMetadata([
    '--projectRoot', projectRoot,
    '--name', 'ticket-dashboard',
    '--displayName', 'Ticket Dashboard',
    '--description', 'Server-side dashboard aggregation',
    '--webRoleIds', roleIds.join(','),
  ]);

  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  const yaml = fs.readFileSync(parsed.filePath, 'utf8');

  assert.match(parsed.filePath, /ticket-dashboard\.serverlogic\.yml$/);
  assert.match(yaml, /^adx_serverlogic_adx_webrole:\n  - 11111111-1111-1111-1111-111111111111\n  - 22222222-2222-2222-2222-222222222222$/m);
  assert.match(yaml, /^description: 'Server-side dashboard aggregation'$/m);
  assert.match(yaml, /^display_name: 'Ticket Dashboard'$/m);
  assert.match(yaml, /^id: [0-9a-f-]{36}$/m);
  assert.match(yaml, /^name: ticket-dashboard$/m);
});

test('create-serverlogic-metadata rejects invalid web role ids', (t) => {
  const projectRoot = createTempProject(t);
  const endpointDir = path.join(projectRoot, '.powerpages-site', 'server-logic', 'ticket-dashboard');
  fs.mkdirSync(endpointDir, { recursive: true });

  const result = runCreateServerlogicMetadata([
    '--projectRoot', projectRoot,
    '--name', 'ticket-dashboard',
    '--displayName', 'Ticket Dashboard',
    '--description', 'Server-side dashboard aggregation',
    '--webRoleIds', 'not-a-uuid',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid UUID in --webRoleIds/);
});
