const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  createTempProject,
  createTempNonSpaSite,
  writeProjectFile,
} = require('./test-utils');

const pluginRoot = path.resolve(__dirname, '..', '..');
const repositoryRoot = path.resolve(pluginRoot, '..', '..');

function runNode(scriptPath, args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
  });
}

function readSkillBody(content) {
  const marker = '## Core Principles';
  const markerIndex = content.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Missing ${marker} marker`);
  return content.slice(markerIndex).replace(/\r\n/g, '\n');
}

test('create-webroles routes SPA first and preserves the committed SPA workflow body', () => {
  const skillPath = path.join(pluginRoot, 'skills', 'create-webroles', 'SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');
  const committed = spawnSync(
    'git',
    ['show', 'HEAD:plugins/power-pages/skills/create-webroles/SKILL.md'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );

  assert.equal(committed.status, 0, committed.stderr);
  assert.ok(
    skill.indexOf('perform the existing SPA project lookup first')
      < skill.indexOf('node "${PLUGIN_ROOT}/scripts/lib/detect-project-context.js"')
  );
  assert.match(
    skill,
    /Only when that existing SPA lookup finds no `powerpages\.config\.json`, run:/
  );
  assert.match(skill, /siteType: "non-spa"/);
  assert.equal(readSkillBody(skill), readSkillBody(committed.stdout));
});

test('non-SPA workflow reuses gates, deterministic creation, and caller-suppress behavior', () => {
  const reference = fs.readFileSync(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'references',
      'non-spa-site-workflow.md'
    ),
    'utf8'
  );

  assert.match(reference, /create-webroles:3\.role-selection/);
  assert.match(reference, /create-webroles:6\.deploy/);
  assert.match(reference, /create-web-role\.js/);
  assert.match(reference, /Do not write role YAML manually/);
  assert.match(reference, /caller-suppress mode/);
  assert.match(reference, /Do not run the hook script directly/);
  assert.match(reference, /Independently confirm/);
});

test('create-web-role writes to nested SPA and direct non-SPA roots', (t) => {
  const nestedProjectRoot = createTempProject(t);
  const traditionalSiteRoot = createTempNonSpaSite(t);
  const createScript = path.join(
    pluginRoot,
    'skills',
    'create-webroles',
    'scripts',
    'create-web-role.js'
  );

  const nestedResult = runNode(createScript, [
    '--projectRoot', nestedProjectRoot,
    '--name', 'Nested Members',
    '--authenticated',
  ]);
  assert.equal(nestedResult.status, 0, nestedResult.stderr);
  assert.ok(
    JSON.parse(nestedResult.stdout).filePath.startsWith(
      path.join(nestedProjectRoot, '.powerpages-site', 'web-roles')
    )
  );

  const directResult = runNode(createScript, [
    '--projectRoot', traditionalSiteRoot,
    '--name', 'Non-SPA Members',
  ]);
  assert.equal(directResult.status, 0, directResult.stderr);
  assert.ok(
    JSON.parse(directResult.stdout).filePath.startsWith(
      path.join(traditionalSiteRoot, 'web-roles')
    )
  );
});

test('create-web-role initializes missing role storage as per-record metadata', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  fs.rmSync(path.join(siteRoot, 'web-roles'), { recursive: true });

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'scripts',
      'create-web-role.js'
    ),
    ['--projectRoot', siteRoot, '--name', 'Reviewers']
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.storage, 'per-record');
  assert.ok(output.filePath.startsWith(path.join(siteRoot, 'web-roles')));
  assert.equal(fs.existsSync(output.filePath), true);
});

test('create-web-role appends PAC aggregate webrole.yml without rewriting existing roles', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  const aggregatePath = writeProjectFile(
    siteRoot,
    'webrole.yml',
    [
      '- adx_anonymoususersrole: true',
      '  adx_authenticatedusersrole: false',
      '  adx_name: Anonymous Users',
      '  adx_webroleid: 11111111-1111-4111-8111-111111111111',
      '',
    ].join('\n')
  );
  const before = fs.readFileSync(aggregatePath, 'utf8');
  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'scripts',
      'create-web-role.js'
    ),
    ['--projectRoot', siteRoot, '--name', 'Reviewers']
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.filePath, aggregatePath);
  assert.equal(output.storage, 'aggregate');
  const after = fs.readFileSync(aggregatePath, 'utf8');
  assert.ok(after.startsWith(before));
  assert.match(after, /- adx_anonymoususersrole: false/);
  assert.match(after, /  adx_authenticatedusersrole: false/);
  assert.match(after, /  adx_name: Reviewers/);
  assert.match(after, /  adx_webroleid: [0-9a-f-]{36}/);
});

test('create-web-role rejects mixed aggregate and per-record role storage', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'webrole.yml',
    '- adx_name: Existing\n  adx_webroleid: 11111111-1111-4111-8111-111111111111\n'
  );
  writeProjectFile(
    siteRoot,
    'web-roles/existing.webrole.yml',
    'name: Existing Per Record\nid: 22222222-2222-4222-8222-222222222222\n'
  );

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'scripts',
      'create-web-role.js'
    ),
    ['--projectRoot', siteRoot, '--name', 'Reviewers']
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Mixed web-role serialization/);
});

test('web role hook validator accepts valid direct-root metadata', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'web-roles/members.webrole.yml',
    [
      'anonymoususersrole: false',
      'authenticatedusersrole: true',
      'id: 778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444',
      'name: Members',
      '',
    ].join('\n')
  );

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'scripts',
      'validate-webroles.js'
    ),
    [],
    { input: JSON.stringify({ cwd: siteRoot }) }
  );

  assert.equal(result.status, 0, result.stderr);
});

test('web role hook validator accepts aggregate non-SPA metadata', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  fs.rmSync(path.join(siteRoot, 'web-roles'), { recursive: true });
  writeProjectFile(
    siteRoot,
    'webrole.yml',
    [
      '- adx_anonymoususersrole: false',
      '  adx_authenticatedusersrole: true',
      '  adx_name: Members',
      '  adx_webroleid: 778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444',
      '',
    ].join('\n')
  );

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'scripts',
      'validate-webroles.js'
    ),
    [],
    { input: JSON.stringify({ cwd: siteRoot }) }
  );

  assert.equal(result.status, 0, result.stderr);
});

test('web role hook validator blocks invalid aggregate metadata without a web-roles directory', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  fs.rmSync(path.join(siteRoot, 'web-roles'), { recursive: true });
  writeProjectFile(
    siteRoot,
    'webrole.yml',
    [
      '- adx_anonymoususersrole: false',
      '  adx_authenticatedusersrole: true',
      '  adx_name: Invalid',
      '  adx_webroleid: not-a-uuid',
      '',
    ].join('\n')
  );

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'scripts',
      'validate-webroles.js'
    ),
    [],
    { input: JSON.stringify({ cwd: siteRoot }) }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid "id" UUID/);
});

test('web role hook validator blocks mixed aggregate and per-record metadata', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'webrole.yml',
    [
      '- adx_anonymoususersrole: false',
      '  adx_authenticatedusersrole: true',
      '  adx_name: Aggregate Members',
      '  adx_webroleid: 778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444',
      '',
    ].join('\n')
  );
  writeProjectFile(
    siteRoot,
    'web-roles/per-record.webrole.yml',
    [
      'anonymoususersrole: false',
      'authenticatedusersrole: true',
      'id: 928fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444',
      'name: Per-record Members',
      '',
    ].join('\n')
  );

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'scripts',
      'validate-webroles.js'
    ),
    [],
    { input: JSON.stringify({ cwd: siteRoot }) }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Mixed web-role serialization/);
});

test('web role hook validator blocks invalid direct-root metadata', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  writeProjectFile(
    siteRoot,
    'web-roles/invalid.webrole.yml',
    [
      'anonymoususersrole: false',
      'authenticatedusersrole: true',
      'id: not-a-uuid',
      'name: Invalid',
      '',
    ].join('\n')
  );

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'scripts',
      'validate-webroles.js'
    ),
    [],
    { input: JSON.stringify({ cwd: siteRoot }) }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid "id" UUID/);
});

test('web role hook validator preserves the no-op when role metadata is absent', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  fs.rmSync(path.join(siteRoot, 'web-roles'), { recursive: true });

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'scripts',
      'validate-webroles.js'
    ),
    [],
    { input: JSON.stringify({ cwd: siteRoot }) }
  );

  assert.equal(result.status, 0, result.stderr);
});

test('web role hook validator preserves the no-op for empty role storage', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  fs.writeFileSync(path.join(siteRoot, 'webrole.yml'), '', 'utf8');

  const result = runNode(
    path.join(
      pluginRoot,
      'skills',
      'create-webroles',
      'scripts',
      'validate-webroles.js'
    ),
    [],
    { input: JSON.stringify({ cwd: siteRoot }) }
  );

  assert.equal(result.status, 0, result.stderr);
});

test('skill tracking writes counters to a direct non-SPA root', (t) => {
  const siteRoot = createTempNonSpaSite(t);
  const result = runNode(
    path.join(pluginRoot, 'scripts', 'update-skill-tracking.js'),
    [
      '--projectRoot', siteRoot,
      '--skillName', 'CreateWebroles',
      '--authoringTool', 'GitHub Copilot',
    ]
  );

  assert.equal(result.status, 0, result.stderr);
  const settings = fs.readdirSync(path.join(siteRoot, 'site-settings'))
    .map(fileName => fs.readFileSync(path.join(siteRoot, 'site-settings', fileName), 'utf8'));
  assert.ok(settings.some(content =>
    content.includes('name: Site/AI/Skills/CreateWebroles')
      && content.includes('value: 1')
  ));
  assert.ok(settings.some(content =>
    content.includes('name: Site/AI/Tools/AuthoringTool')
      && content.includes('value: GitHubCopilot')
  ));
});
