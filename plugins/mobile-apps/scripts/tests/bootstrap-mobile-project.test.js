'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertBundledTemplate,
  bootstrapMobileProject,
  classifyTarget,
  copyTemplate,
  resolveTargetDir,
} = require('../bootstrap-mobile-project');
const { REQUIRED_FILES } = require('../prepare-mobile-template');

const pluginRoot = path.resolve(__dirname, '..', '..');
const bundledTemplate = path.join(pluginRoot, 'template');
const scriptPath = path.join(pluginRoot, 'scripts', 'bootstrap-mobile-project.js');

function tempDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** A minimal stand-in for the bundled snapshot, so copy tests stay fast and hermetic. */
function fakeTemplate() {
  const root = tempDirectory('fake-template');
  for (const relativePath of REQUIRED_FILES) {
    write(path.join(root, relativePath), `// ${relativePath}\n`);
  }
  return root;
}

test('the bundled snapshot is a complete template', () => {
  assertBundledTemplate(bundledTemplate);
});

test('an incomplete bundled snapshot fails loudly instead of producing a half app', () => {
  const broken = fakeTemplate();
  fs.rmSync(path.join(broken, 'app.config.js'));
  assert.throws(() => assertBundledTemplate(broken), /incomplete; missing: app\.config\.js/);
});

test('a missing or empty folder is a valid create target', () => {
  const parent = tempDirectory('bootstrap-target');
  assert.equal(classifyTarget(path.join(parent, 'not-created-yet')).state, 'missing');
  assert.equal(classifyTarget(parent).state, 'empty');
});

test('incidental git and OS files do not make a new folder look occupied', () => {
  const target = tempDirectory('bootstrap-incidental');
  fs.mkdirSync(path.join(target, '.git'));
  write(path.join(target, '.DS_Store'), 'finder');
  assert.equal(classifyTarget(target).state, 'empty');
});

test('a materialized template is recognized rather than copied over', () => {
  const target = fakeTemplate();
  assert.equal(classifyTarget(target).state, 'template');

  const result = bootstrapMobileProject({ workingDir: target, templateRoot: fakeTemplate() });
  assert.equal(result.state, 'existing-template');
  assert.equal(result.templateSource, 'existing');
  assert.deepEqual(result.copiedFiles, []);
  assert.equal(result.dependenciesInstalled, false);
});

test('a folder with installed dependencies reports them so no second install starts', () => {
  const target = fakeTemplate();
  fs.mkdirSync(path.join(target, 'node_modules', 'expo'), { recursive: true });
  const result = bootstrapMobileProject({ workingDir: target, templateRoot: fakeTemplate() });
  assert.equal(result.dependenciesInstalled, true);
});

test('an app this plugin already created is never a create target', () => {
  for (const marker of ['memory-bank.md', 'native-app-plan.md', '.datamodel-manifest.json']) {
    const target = fakeTemplate();
    write(path.join(target, marker), 'existing app\n');

    const classification = classifyTarget(target);
    assert.equal(classification.state, 'created-app');
    assert.deepEqual(classification.createdMarkers, [marker]);
    assert.throws(
      () => bootstrapMobileProject({ workingDir: target, templateRoot: fakeTemplate() }),
      /already contains an app created by this plugin[\s\S]*\/edit-app/,
    );
  }
});

test('generated services alone identify a created app', () => {
  const target = fakeTemplate();
  write(path.join(target, 'src', 'generated', 'services', 'Accounts.ts'), 'export {};\n');
  assert.deepEqual(classifyTarget(target).createdMarkers, ['src/generated/services/*.ts']);
});

test('an unrelated non-empty folder is refused with the files that are missing', () => {
  const target = tempDirectory('bootstrap-occupied');
  write(path.join(target, 'README.md'), '# someone else\n');

  const classification = classifyTarget(target);
  assert.equal(classification.state, 'occupied');
  assert.ok(classification.missingTemplateFiles.includes('package.json'));
  assert.throws(
    () => bootstrapMobileProject({ workingDir: target, templateRoot: fakeTemplate() }),
    /is not empty and is not a Power Apps mobile template/,
  );
});

test('bootstrapping an empty folder copies every template file', () => {
  const templateRoot = fakeTemplate();
  const target = path.join(tempDirectory('bootstrap-copy'), 'my-mobile-app');

  const result = bootstrapMobileProject({ workingDir: target, templateRoot });
  assert.equal(result.state, 'created');
  assert.equal(result.templateSource, 'bundled');
  assert.equal(result.dependenciesInstalled, false);
  for (const relativePath of REQUIRED_FILES) {
    assert.ok(fs.existsSync(path.join(target, relativePath)), `missing ${relativePath}`);
    assert.ok(result.copiedFiles.includes(relativePath.split(path.sep).join('/')));
  }
  assert.equal(classifyTarget(target).state, 'template');
});

test('machine-specific directories are never copied into a new app', () => {
  const templateRoot = fakeTemplate();
  // CI installs dependencies directly in plugins/mobile-apps/template, so a maintainer
  // checkout can genuinely carry these directories next to the snapshot.
  write(path.join(templateRoot, 'node_modules', 'expo', 'package.json'), '{}\n');
  write(path.join(templateRoot, '.expo', 'devices.json'), '{}\n');
  write(path.join(templateRoot, '.powernative', 'metro-logs', 'metro.log'), 'log\n');

  const target = path.join(tempDirectory('bootstrap-exclude'), 'app');
  const result = bootstrapMobileProject({ workingDir: target, templateRoot });

  for (const excluded of ['node_modules', '.expo', '.powernative']) {
    assert.equal(fs.existsSync(path.join(target, excluded)), false, `copied ${excluded}`);
    assert.equal(result.copiedFiles.some((file) => file.startsWith(`${excluded}/`)), false);
  }
});

test('copying refuses to overwrite a file that is already there', () => {
  const templateRoot = fakeTemplate();
  const target = tempDirectory('bootstrap-overwrite');
  write(path.join(target, 'package.json'), '{"name":"mine"}\n');

  assert.throws(() => copyTemplate(templateRoot, target), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), '{"name":"mine"}\n');
});

test('the app folder defaults to a new slug folder unless the cwd is already a template', () => {
  const plainParent = tempDirectory('bootstrap-parent');
  assert.equal(
    resolveTargetDir({ parentDir: plainParent, slug: 'field-inspections' }),
    path.join(plainParent, 'field-inspections'),
  );

  const templateParent = fakeTemplate();
  assert.equal(
    resolveTargetDir({ parentDir: templateParent, slug: 'field-inspections' }),
    templateParent,
  );

  const explicit = path.join(plainParent, 'explicit');
  assert.equal(resolveTargetDir({ workingDir: explicit, slug: 'ignored' }), explicit);
});

test('the CLI prints one JSON line and exits 2 on an actionable refusal', () => {
  const templateRoot = fakeTemplate();
  const parent = tempDirectory('bootstrap-cli');

  const created = spawnSync(process.execPath, [
    scriptPath,
    '--parent-dir', parent,
    '--slug', 'cli-app',
    '--template-root', templateRoot,
  ], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const result = JSON.parse(created.stdout.trim());
  assert.equal(result.targetDir, path.join(parent, 'cli-app'));
  assert.equal(result.state, 'created');

  write(path.join(parent, 'cli-app', 'memory-bank.md'), 'created\n');
  const refused = spawnSync(process.execPath, [
    scriptPath,
    '--working-dir', path.join(parent, 'cli-app'),
    '--template-root', templateRoot,
  ], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /already contains an app created by this plugin/);
  assert.equal(refused.stdout, '');
});

test('the CLI rejects a call with neither a working dir nor a slug', () => {
  const usage = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Provide --working-dir <path>, or --slug <slug>/);
});

test('a slug can never relocate the app outside the folder the skill ran in', () => {
  const parent = tempDirectory('bootstrap-escape');
  for (const slug of ['../evil', 'nested/app', '..', '.']) {
    assert.throws(
      () => resolveTargetDir({ parentDir: parent, slug }),
      /--slug must be a single folder name/,
    );
  }
});
