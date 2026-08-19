'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const validator = path.resolve(__dirname, '..', '..', 'hooks', 'validate-dataverse-payload.js');
const dispatcher = path.resolve(__dirname, '..', 'validate-mobile-files.js');

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-dataverse-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(root, '.datamodel-manifest.json'), JSON.stringify({
    tables: [{
      logicalName: 'new_event',
      columns: [
        { logicalName: 'new_name', type: 'StringType' },
        { logicalName: 'new_venueid', type: 'LookupType' },
      ],
    }],
  }));
  return root;
}

function runValidator(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return spawnSync(process.execPath, [validator], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify({
      cwd: root,
      tool_name: 'Write',
      tool_input: { file_path: filePath, content },
    }),
  });
}

test('rejects lookup navigation properties in selects for app screens and shared hooks', (t) => {
  const root = makeProject(t);
  const content = "Service.getAll({ select: ['new_eventid', 'new_venueid'] });\n";

  for (const relativePath of ['app/events.tsx', 'src/hooks/useEvents.ts']) {
    const result = runValidator(root, relativePath, content);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /new_venueid/);
    assert.match(result.stderr, /_\<lookup\>_value/);
  }
});

test('accepts the generated lookup read property and ignores generated files', (t) => {
  const root = makeProject(t);
  const valid = runValidator(
    root,
    'app/events.tsx',
    "Service.getAll({ select: ['new_eventid', '_new_venueid_value'] });\n",
  );
  assert.equal(valid.status, 0, valid.stderr);

  const generated = runValidator(
    root,
    'src/generated/services/New_eventsService.ts',
    "Service.getAll({ select: ['new_venueid'] });\n",
  );
  assert.equal(generated.status, 0, generated.stderr);
});

test('full-source dispatcher catches stale shared Dataverse bindings', (t) => {
  const root = makeProject(t);
  fs.writeFileSync(
    path.join(root, 'src', 'hooks', 'useEvents.ts'),
    "Service.getAll({ select: ['new_eventid', 'new_venueid'] });\n",
  );
  fs.writeFileSync(
    path.join(root, 'src', 'generated', 'owned.ts'),
    "Service.getAll({ select: ['new_venueid'] });\n",
  );

  const result = spawnSync(
    process.execPath,
    [dispatcher, '--project-root', root, '--all-source'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /new_venueid/);
  assert.doesNotMatch(result.stderr, /src\/generated\/owned/);
});
