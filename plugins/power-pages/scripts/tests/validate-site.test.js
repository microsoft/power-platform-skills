'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTempProject, writeProjectFile } = require('./test-utils');

const VALIDATOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'create-site',
  'scripts',
  'validate-site.js'
);

function createProject(t, html) {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    $schema: 'https://www.schemastore.org/powerpages.config.json',
    compiledPath: 'dist',
    siteName: 'Contoso Customer Portal',
    defaultLandingPage: 'index.html',
  }));
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    scripts: { build: 'vite build', dev: 'vite' },
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
  }));
  writeProjectFile(projectRoot, '.gitignore', 'node_modules\n');
  writeProjectFile(projectRoot, 'index.html', html);
  writeProjectFile(projectRoot, 'src/main.tsx', 'export {};');
  writeProjectFile(projectRoot, '.git/HEAD', 'ref: refs/heads/main\n');
  return projectRoot;
}

function runValidator(projectRoot) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
  });
}

test('create-site validator accepts a canonical non-English document language', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="es-ES" dir="ltr"><body><div id="root"></div></body></html>'
  );
  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('create-site validator blocks a direction mismatch', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="ar-SA" dir="ltr"><body><div id="root"></div></body></html>'
  );
  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /resolves to "rtl"/);
});

test('create-site validator blocks direction-sensitive physical CSS', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="en-US" dir="ltr"><body><div id="root"></div></body></html>'
  );
  writeProjectFile(projectRoot, 'src/theme.css', '.callout { padding-left: 1rem; }');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Bidirectional readiness.*directional-physical-css/);
});
