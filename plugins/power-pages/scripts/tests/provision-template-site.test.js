'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  copyMissingTemplateFiles,
  findCodeSiteRoot,
  inspectCompiledOutput,
  inspectClonedSiteIdentity,
  isPortalFileContentUploadFailure,
  isRetryManifestName,
  parseArgs,
  provisionTemplateSite,
  removePacManifestsForRetry,
  runNpm,
  runPac,
} = require('../provision-template-site');

const SOURCE_ID = '11111111-1111-1111-1111-111111111111';
const CLONED_ID = '22222222-2222-2222-2222-222222222222';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'provision-template-site-test-'));
}

function createSource(root, { id = SOURCE_ID, name = 'Template Site' } = {}) {
  fs.mkdirSync(path.join(root, '.powerpages-site'), { recursive: true });
  fs.writeFileSync(path.join(root, '.powerpages-site', 'website.yml'), `id: ${id}\nname: ${name}\n`);
  fs.writeFileSync(path.join(root, 'powerpages.config.json'), JSON.stringify({ compiledPath: 'dist' }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
  fs.writeFileSync(path.join(root, '.npmrc'), 'omit-lockfile-registry-resolved=true\n');
}

function portalFileUploadFailure(fileName = 'index.html') {
  return {
    status: 1,
    stdout: '',
    stderr: [
      `Error: Unable to upload webfile name '${fileName}' with record Id ${SOURCE_ID} due to below error(s).`,
      'PortalFileContentUploadFailed',
    ].join('\n'),
  };
}

function runUploadScenario(t, {
  firstUploadResult,
  fsImpl = fs,
  retryUploadResult = { status: 0, stdout: 'uploaded', stderr: '' },
  manifestEntries = [
    { name: 'manifest.yml', kind: 'file', content: 'PAC-generated generic state\n' },
    {
      name: 'target-environment-manifest.yml',
      kind: 'file',
      content: 'PAC-generated environment state\n',
    },
  ],
  portalConfigKind = 'directory',
} = {}) {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  const clonedPath = path.join(output, 'supplier-portal');
  const portalConfigPath = path.join(clonedPath, '.powerpages-site', '.portalconfig');
  const manifestPath = path.join(portalConfigPath, 'manifest.yml');
  const environmentManifestPath = path.join(portalConfigPath, 'target-environment-manifest.yml');
  const englishLanguagePath = path.join(portalConfigPath, 'English.portallanguage.yml');
  const unrelatedYamlPath = path.join(portalConfigPath, 'unrelated.yml');
  createSource(source);
  const uploadCalls = [];

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    fs: fsImpl,
    runPac(args, commandOptions) {
      if (args[1] === 'clone') {
        createSource(clonedPath, { id: CLONED_ID, name: 'Supplier Portal' });
        let manifestDirectory = portalConfigPath;
        if (portalConfigKind === 'symlink') {
          manifestDirectory = path.join(dir, 'outside-portalconfig');
          fs.mkdirSync(manifestDirectory, { recursive: true });
          fs.symlinkSync(
            manifestDirectory,
            portalConfigPath,
            process.platform === 'win32' ? 'junction' : 'dir'
          );
        } else if (portalConfigKind !== 'missing') {
          fs.mkdirSync(portalConfigPath, { recursive: true });
        }
        if (portalConfigKind !== 'missing') {
          for (const entry of manifestEntries) {
            const entryPath = path.join(manifestDirectory, entry.name);
            if (entry.kind === 'directory') {
              fs.mkdirSync(entryPath);
            } else if (entry.kind === 'symlink') {
              const outsideManifest = path.join(dir, `outside-${entry.name}`);
              fs.writeFileSync(outsideManifest, 'outside clone\n');
              fs.symlinkSync(outsideManifest, entryPath, 'file');
            } else {
              fs.writeFileSync(entryPath, entry.content || 'PAC-generated manifest state\n');
            }
          }
          fs.writeFileSync(path.join(manifestDirectory, 'English.portallanguage.yml'), 'language\n');
          fs.writeFileSync(path.join(manifestDirectory, 'unrelated.yml'), 'unrelated\n');
        }
        return { status: 0, stdout: 'cloned', stderr: '' };
      }
      uploadCalls.push({ args, cwd: commandOptions.cwd });
      return uploadCalls.length === 1 ? firstUploadResult : retryUploadResult;
    },
    runNpm(args, cwd) {
      if (args[0] === 'run') {
        fs.mkdirSync(path.join(cwd, 'dist'));
        fs.writeFileSync(path.join(cwd, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  return {
    clonedPath,
    englishLanguagePath,
    environmentManifestPath,
    manifestPath,
    portalConfigPath,
    result,
    unrelatedYamlPath,
    uploadCalls,
  };
}

test('parseArgs accepts source, output, and site name', () => {
  assert.deepEqual(parseArgs([
    '--sourcePath', '/tmp/source',
    '--outputDirectory', '/tmp/output',
    '--siteName', 'Supplier Portal',
  ]), {
    sourcePath: '/tmp/source',
    outputDirectory: '/tmp/output',
    siteName: 'Supplier Portal',
  });
});

test('findCodeSiteRoot resolves one nested PAC clone output and rejects ambiguity', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const site = path.join(dir, 'supplier-portal');
  createSource(site);
  assert.equal(findCodeSiteRoot(dir), site);

  createSource(path.join(dir, 'another-site'));
  assert.throws(() => findCodeSiteRoot(dir), /found 2/);
});

test('inspectClonedSiteIdentity reads the new website record id from cloned metadata', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  createSource(dir, { id: CLONED_ID, name: 'Supplier Portal Clone' });

  assert.deepEqual(inspectClonedSiteIdentity(dir), {
    siteName: 'Supplier Portal Clone',
    websiteRecordId: CLONED_ID,
  });
});

test('inspectCompiledOutput requires the configured build directory to contain a file', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  createSource(dir);
  fs.mkdirSync(path.join(dir, 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'assets', 'index.js'), 'built');

  assert.deepEqual(inspectCompiledOutput(dir), {
    compiledPath: 'dist',
    outputPath: path.join(dir, 'dist'),
  });
});

test('inspectCompiledOutput rejects a project root or parent path as compiled output', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  createSource(dir);

  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({ compiledPath: '.' }));
  assert.throws(() => inspectCompiledOutput(dir), /invalid compiledPath/);

  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), JSON.stringify({ compiledPath: '../dist' }));
  assert.throws(() => inspectCompiledOutput(dir), /invalid compiledPath/);
});

test('inspectCompiledOutput rejects symlinked compiled-path components', (t) => {
  const dir = tempDir();
  const outside = tempDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  createSource(dir);
  fs.mkdirSync(path.join(outside, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'assets', 'index.js'), 'outside');
  try {
    fs.symlinkSync(outside, path.join(dir, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`directory symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  assert.throws(
    () => inspectCompiledOutput(dir),
    /Build output path must contain only real directories/
  );
});

test('inspectCompiledOutput rejects symlinks nested inside compiled output', (t) => {
  const dir = tempDir();
  const outside = tempDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  createSource(dir);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), 'built');
  fs.writeFileSync(path.join(outside, 'secret.js'), 'outside');
  try {
    fs.symlinkSync(
      path.join(outside, 'secret.js'),
      path.join(dir, 'dist', 'secret.js'),
      'file'
    );
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`file symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  assert.throws(
    () => inspectCompiledOutput(dir),
    /Build output must not contain symbolic links/
  );
});

test('provisionTemplateSite clones, installs, builds, validates output, then uploads', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  const pacCalls = [];
  const npmCalls = [];

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args, commandOptions) {
      pacCalls.push({ args, cwd: commandOptions.cwd });
      if (args[1] === 'clone') {
        createSource(path.join(output, 'supplier-portal'), {
          id: CLONED_ID,
          name: 'Supplier Portal',
        });
        fs.writeFileSync(path.join(output, 'supplier-portal', 'package-lock.json'), '{}');
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    runNpm(args, cwd) {
      npmCalls.push([args, cwd]);
      if (args[0] === 'run') {
        fs.mkdirSync(path.join(cwd, 'dist'));
        fs.writeFileSync(path.join(cwd, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  const clonedPath = path.join(output, 'supplier-portal');
  assert.deepEqual(result, {
    ok: true,
    clonedPath,
    siteName: 'Supplier Portal',
    websiteRecordId: CLONED_ID,
    compiledPath: 'dist',
  });
  assert.deepEqual(pacCalls, [
    {
      args: [
        'pages', 'clone',
        '--path', source,
        '--outputDirectory', output,
        '--name', 'Supplier Portal',
        '--overwrite',
      ],
      cwd: fs.realpathSync(dir),
    },
    {
      args: [
        'pages', 'upload-code-site',
        '--rootPath', clonedPath,
        '--siteName', 'Supplier Portal',
      ],
      cwd: fs.realpathSync(dir),
    },
  ]);
  assert.deepEqual(npmCalls, [
    [[
      'ci',
      '--no-audit',
      '--no-fund',
    ], clonedPath],
    [['run', 'build'], clonedPath],
  ]);
});

test('provisionTemplateSite stops after clone failure and reports the failed step', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  let calls = 0;

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: '311 Portal',
  }, {
    runPac() {
      calls++;
      return { status: 1, stdout: '', stderr: 'clone rejected' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'clone');
  assert.equal(result.outputDirectoryRemoved, true);
  assert.match(result.error, /clone rejected/);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(output), false);
});

test('provisionTemplateSite preserves a pre-existing empty output directory after clone failure', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  fs.mkdirSync(output);

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: '311 Portal',
  }, {
    runPac() {
      fs.writeFileSync(path.join(output, 'partial.txt'), 'partial');
      return { status: 1, stdout: '', stderr: 'clone rejected' };
    },
  });

  assert.equal(result.outputDirectoryRemoved, false);
  assert.equal(fs.readFileSync(path.join(output, 'partial.txt'), 'utf8'), 'partial');
});

test('provisionTemplateSite runs PAC from the output parent for a pre-existing current-directory target', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'current-directory');
  createSource(source);
  fs.mkdirSync(output);
  const pacWorkingDirectories = [];

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: '311 Portal',
  }, {
    runPac(args, commandOptions) {
      pacWorkingDirectories.push(commandOptions && commandOptions.cwd);
      return { status: 1, stdout: '', stderr: 'clone rejected' };
    },
  });

  assert.equal(result.step, 'clone');
  assert.deepEqual(pacWorkingDirectories, [fs.realpathSync(dir)]);
});

test('provisionTemplateSite removes a new output directory when clone output cannot be resolved', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: '311 Portal',
  }, {
    runPac() {
      fs.writeFileSync(path.join(output, 'unexpected.txt'), 'not a code site');
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'clone-output');
  assert.equal(result.outputDirectoryRemoved, true);
  assert.equal(fs.existsSync(output), false);
});

test('provisionTemplateSite reports upload failure without retrying', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  let calls = 0;

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      calls++;
      if (args[1] === 'clone') {
        createSource(path.join(output, 'supplier-portal'), {
          id: CLONED_ID,
          name: 'Supplier Portal',
        });
        return { status: 0, stdout: 'cloned', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'upload rejected' };
    },
    runNpm(args, cwd) {
      if (args[0] === 'run') {
        fs.mkdirSync(path.join(cwd, 'dist'));
        fs.writeFileSync(path.join(cwd, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'upload');
  assert.equal(result.clonedPath, path.join(output, 'supplier-portal'));
  assert.equal(result.websiteRecordId, CLONED_ID);
  assert.match(result.error, /upload rejected/);
  assert.equal(calls, 2);
});

test('isPortalFileContentUploadFailure detects the bounded PAC tail token', () => {
  assert.equal(isPortalFileContentUploadFailure(portalFileUploadFailure('index.html')), true);
  assert.equal(isPortalFileContentUploadFailure({
    status: 1,
    stdout: 'pOrTaLfIlEcOnTeNtUpLoAdFaIlEd',
    stderr: '',
  }), true);
  assert.equal(isPortalFileContentUploadFailure({
    status: 1,
    stdout: '',
    stderr: `Entity 'powerpagecomponent' With Id = ${SOURCE_ID} Does Not Exist`,
  }), false);
  assert.equal(isPortalFileContentUploadFailure({
    status: 1,
    stdout: '',
    stderr: 'upload rejected',
  }), false);
});

test('provisionTemplateSite retries once for an arbitrary webfile upload envelope', (t) => {
  const scenario = runUploadScenario(t, {
    firstUploadResult: portalFileUploadFailure("assets/customer's app.8c2f.js"),
  });

  assert.equal(scenario.result.ok, true);
  assert.equal(scenario.uploadCalls.length, 2);
  assert.deepEqual(scenario.uploadCalls[1], scenario.uploadCalls[0]);
  assert.equal(fs.existsSync(scenario.manifestPath), false);
  assert.equal(fs.existsSync(scenario.environmentManifestPath), false);
});

test('provisionTemplateSite retries once when the bounded tail contains only the PAC token', (t) => {
  const scenario = runUploadScenario(t, {
    firstUploadResult: {
      status: 1,
      stdout: '',
      stderr: 'PortalFileContentUploadFailed',
    },
  });

  assert.equal(scenario.result.ok, true);
  assert.equal(scenario.uploadCalls.length, 2);
});

test('provisionTemplateSite deletes generic and environment manifests but preserves other files', (t) => {
  const secondEnvironmentManifest = 'regional-backup-manifest.yml';
  const scenario = runUploadScenario(t, {
    firstUploadResult: portalFileUploadFailure(),
    manifestEntries: [
      { name: 'manifest.yml', kind: 'file' },
      { name: 'target-environment-manifest.yml', kind: 'file' },
      { name: secondEnvironmentManifest, kind: 'file' },
    ],
  });

  assert.equal(scenario.result.ok, true);
  assert.equal(scenario.uploadCalls.length, 2);
  assert.equal(fs.existsSync(scenario.manifestPath), false);
  assert.equal(fs.existsSync(scenario.environmentManifestPath), false);
  assert.equal(
    fs.existsSync(path.join(scenario.portalConfigPath, secondEnvironmentManifest)),
    false
  );
  assert.equal(fs.readFileSync(scenario.englishLanguagePath, 'utf8'), 'language\n');
  assert.equal(fs.readFileSync(scenario.unrelatedYamlPath, 'utf8'), 'unrelated\n');
});

test('provisionTemplateSite retries when PAC manifest files are absent', async (t) => {
  await t.test('empty portalconfig directory', (subtest) => {
    const scenario = runUploadScenario(subtest, {
      firstUploadResult: portalFileUploadFailure(),
      manifestEntries: [],
    });

    assert.equal(scenario.result.ok, true);
    assert.equal(scenario.uploadCalls.length, 2);
    assert.equal(fs.existsSync(scenario.englishLanguagePath), true);
    assert.equal(fs.existsSync(scenario.unrelatedYamlPath), true);
  });

  await t.test('missing portalconfig directory', (subtest) => {
    const scenario = runUploadScenario(subtest, {
      firstUploadResult: portalFileUploadFailure(),
      portalConfigKind: 'missing',
    });

    assert.equal(scenario.result.ok, true);
    assert.equal(scenario.uploadCalls.length, 2);
  });
});

test('provisionTemplateSite does not retry failed output without the PAC token', (t) => {
  const scenario = runUploadScenario(t, {
    firstUploadResult: {
      status: 1,
      stdout: '',
      stderr: `Entity 'powerpagecomponent' With Id = ${SOURCE_ID} Does Not Exist`,
    },
  });

  assert.equal(scenario.result.ok, false);
  assert.equal(scenario.result.step, 'upload');
  assert.equal(scenario.uploadCalls.length, 1);
  assert.equal(fs.existsSync(scenario.manifestPath), true);
  assert.equal(fs.existsSync(scenario.environmentManifestPath), true);
});

test('provisionTemplateSite fails closed when portalconfig is a parent symlink', (t) => {
  let scenario;
  try {
    scenario = runUploadScenario(t, {
      firstUploadResult: portalFileUploadFailure(),
      portalConfigKind: 'symlink',
    });
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`directory symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  assert.equal(scenario.result.ok, false);
  assert.equal(scenario.uploadCalls.length, 1);
  assert.match(scenario.result.error, /PAC manifest cleanup could not continue/);
  assert.match(scenario.result.error, /portal configuration path is not a real directory/);
});

test('provisionTemplateSite fails closed for unsafe matched manifest entries', async (t) => {
  for (const kind of ['symlink', 'directory']) {
    await t.test(kind, (subtest) => {
      let scenario;
      try {
        scenario = runUploadScenario(subtest, {
          firstUploadResult: portalFileUploadFailure(),
          manifestEntries: [{ name: 'manifest.yml', kind }],
        });
      } catch (err) {
        if (kind === 'symlink' && (err.code === 'EPERM' || err.code === 'EACCES')) {
          subtest.skip(`file symlinks are unavailable: ${err.code}`);
          return;
        }
        throw err;
      }

      assert.equal(scenario.result.ok, false);
      assert.equal(scenario.uploadCalls.length, 1);
      assert.match(scenario.result.error, /PAC manifest is not a real regular file/);
    });
  }
});

test('provisionTemplateSite preserves the PAC failure when manifest deletion fails', (t) => {
  const failingFs = {
    ...fs,
    unlinkSync() {
      throw new Error('permission denied');
    },
  };
  const scenario = runUploadScenario(t, {
    firstUploadResult: portalFileUploadFailure(),
    fsImpl: failingFs,
  });

  assert.equal(scenario.result.ok, false);
  assert.equal(scenario.uploadCalls.length, 1);
  assert.match(scenario.result.error, /PAC manifest cleanup could not continue/);
  assert.match(scenario.result.error, /Could not delete PAC manifest/);
  assert.match(scenario.result.error, /permission denied/);
  assert.equal(fs.existsSync(scenario.manifestPath), true);
});

test('provisionTemplateSite fails closed for a redirected canonical portalconfig path', (t) => {
  const redirectedFs = {
    ...fs,
    realpathSync(targetPath) {
      if (targetPath.endsWith(path.join('.powerpages-site', '.portalconfig'))) {
        return path.join(path.dirname(targetPath), 'redirected-portalconfig');
      }
      return fs.realpathSync(targetPath);
    },
  };
  const scenario = runUploadScenario(t, {
    firstUploadResult: portalFileUploadFailure(),
    fsImpl: redirectedFs,
  });

  assert.equal(scenario.result.ok, false);
  assert.equal(scenario.uploadCalls.length, 1);
  assert.match(
    scenario.result.error,
    /portal configuration directory resolves outside its expected path/
  );
  assert.equal(fs.existsSync(scenario.manifestPath), true);
});

test('removePacManifestsForRetry uses Windows case-insensitive names and paths', (t) => {
  const dir = tempDir();
  const clone = path.join(dir, 'SiteClone');
  const portalConfig = path.join(clone, '.powerpages-site', '.portalconfig');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(portalConfig, { recursive: true });
  fs.writeFileSync(path.join(portalConfig, 'MANIFEST.YML'), 'generic\n');
  fs.writeFileSync(path.join(portalConfig, 'WESTUS-MANIFEST.YML'), 'environment\n');
  fs.writeFileSync(path.join(portalConfig, 'English.portallanguage.yml'), 'language\n');
  const caseVariantFs = {
    ...fs,
    realpathSync(targetPath) {
      return fs.realpathSync(targetPath).replace('SiteClone', 'siteclone');
    },
  };

  const removed = removePacManifestsForRetry(clone, {
    platform: 'win32',
    fs: caseVariantFs,
  });

  assert.deepEqual(removed.sort(), ['MANIFEST.YML', 'WESTUS-MANIFEST.YML']);
  assert.equal(fs.existsSync(path.join(portalConfig, 'MANIFEST.YML')), false);
  assert.equal(fs.existsSync(path.join(portalConfig, 'WESTUS-MANIFEST.YML')), false);
  assert.equal(fs.existsSync(path.join(portalConfig, 'English.portallanguage.yml')), true);
  assert.equal(isRetryManifestName('REGION-MANIFEST.YML', 'win32'), true);
  assert.equal(isRetryManifestName('REGION-MANIFEST.YML', 'linux'), false);
});

test('provisionTemplateSite reports a failed retry and stops after two upload calls', (t) => {
  const scenario = runUploadScenario(t, {
    firstUploadResult: portalFileUploadFailure('assets/app.8c2f.js'),
    retryUploadResult: { status: 1, stdout: '', stderr: 'retry still rejected' },
  });

  assert.equal(scenario.result.ok, false);
  assert.equal(scenario.result.step, 'upload');
  assert.equal(scenario.uploadCalls.length, 2);
  assert.match(scenario.result.error, /PAC manifest cleanup was attempted/);
  assert.match(scenario.result.error, /retry still rejected/);
  assert.equal(fs.existsSync(scenario.manifestPath), false);
  assert.equal(fs.existsSync(scenario.environmentManifestPath), false);
});

test('provisionTemplateSite stops before upload when dependency installation fails', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  const pacCalls = [];

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      pacCalls.push(args);
      createSource(path.join(output, 'supplier-portal'), {
        id: CLONED_ID,
        name: 'Supplier Portal',
      });
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    runNpm(args) {
      assert.equal(args[0], 'install');
      return { status: 1, stdout: '', stderr: 'install rejected' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'install');
  assert.match(result.error, /install rejected/);
  assert.equal(pacCalls.length, 1);
});

test('provisionTemplateSite stops before upload when the cloned project build fails', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  const pacCalls = [];
  let npmCalls = 0;

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      pacCalls.push(args);
      createSource(path.join(output, 'supplier-portal'), {
        id: CLONED_ID,
        name: 'Supplier Portal',
      });
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    runNpm(args) {
      npmCalls++;
      return args[0] === 'run'
        ? { status: 1, stdout: '', stderr: 'build rejected' }
        : { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'build');
  assert.match(result.error, /build rejected/);
  assert.equal(npmCalls, 2);
  assert.equal(pacCalls.length, 1);
});

test('provisionTemplateSite stops before upload when build output is missing', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  const pacCalls = [];

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      pacCalls.push(args);
      createSource(path.join(output, 'supplier-portal'), {
        id: CLONED_ID,
        name: 'Supplier Portal',
      });
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    runNpm() {
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'build-output');
  assert.match(result.error, /not a regular directory/);
  assert.equal(pacCalls.length, 1);
});

test('provisionTemplateSite stops before upload when clone metadata has no valid website id', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  let calls = 0;

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: 'Supplier Portal',
  }, {
    runPac(args) {
      calls++;
      if (args[1] === 'clone') {
        createSource(path.join(output, 'supplier-portal'), {
          id: 'not-a-guid',
          name: 'Supplier Portal',
        });
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.step, 'clone-output');
  assert.match(result.error, /missing a valid id/);
  assert.equal(calls, 1);
});

test('provisionTemplateSite rejects non-empty output directories', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'stale.txt'), 'stale');

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: '311 Portal',
  });

  assert.deepEqual(result, { ok: false, step: 'validation', error: 'outputDirectory must be empty' });
});

test('provisionTemplateSite rejects an output path that is a file', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const outputFile = path.join(dir, 'output');
  createSource(source);
  fs.writeFileSync(outputFile, 'not a directory');

  assert.deepEqual(
    provisionTemplateSite({
      sourcePath: source,
      outputDirectory: outputFile,
      siteName: '311 Portal',
    }),
    {
      ok: false,
      step: 'validation',
      error: 'outputDirectory must be a regular directory when it exists',
    }
  );
});

test('provisionTemplateSite rejects case-variant output paths inside the source on Windows', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'TemplateSource');
  createSource(source);

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: path.join(dir, 'templatesource', 'clone'),
    siteName: '311 Portal',
  }, {
    platform: 'win32',
  });

  assert.deepEqual(result, {
    ok: false,
    step: 'validation',
    error: 'outputDirectory must be separate from sourcePath',
  });
});

test('provisionTemplateSite rejects output paths whose existing parent resolves into the source', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  createSource(source);
  const linkedParent = path.join(dir, 'linked-source');
  try {
    fs.symlinkSync(source, linkedParent, 'dir');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`directory symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: path.join(linkedParent, 'clone'),
    siteName: '311 Portal',
  });

  assert.deepEqual(result, {
    ok: false,
    step: 'validation',
    error: 'outputDirectory must be separate from sourcePath',
  });
});

test('provisionTemplateSite requires project-local npm configuration', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  createSource(source);
  fs.rmSync(path.join(source, '.npmrc'));

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: path.join(dir, 'output'),
    siteName: '311 Portal',
  });

  assert.deepEqual(result, {
    ok: false,
    step: 'validation',
    error: 'sourcePath is not a downloaded Power Pages code site',
  });
});

test('provisionTemplateSite restores project files omitted by PAC without replacing cloned identity', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const output = path.join(dir, 'output');
  createSource(source);
  fs.writeFileSync(path.join(source, 'dataverse-choice-values.json'), '{"status":{"Open":100000000}}');
  fs.mkdirSync(path.join(source, 'tests'));
  fs.writeFileSync(path.join(source, 'tests', 'serviceRequests.test.mjs'), 'export {};\n');
  fs.mkdirSync(path.join(source, '.powerpages-site', '.portalconfig'));
  fs.writeFileSync(path.join(source, '.powerpages-site', '.portalconfig', 'manifest.yml'), 'portalVersion: 1\n');
  fs.writeFileSync(
    path.join(source, '.powerpages-site', '.portalconfig', 'source-environment-manifest.yml'),
    'environment: source\n'
  );
  const npmCalls = [];
  let pacCalls = 0;

  const result = provisionTemplateSite({
    sourcePath: source,
    outputDirectory: output,
    siteName: '311 Portal',
  }, {
    runPac(args) {
      pacCalls++;
      if (args[1] === 'clone') {
        const clonedPath = path.join(output, '311-portal');
        createSource(clonedPath, { id: CLONED_ID, name: '311 Portal' });
        fs.rmSync(path.join(clonedPath, '.npmrc'));
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    runNpm(args, cwd) {
      npmCalls.push(args);
      assert.equal(fs.existsSync(path.join(cwd, '.npmrc')), true);
      assert.equal(fs.existsSync(path.join(cwd, 'dataverse-choice-values.json')), true);
      assert.equal(fs.existsSync(path.join(cwd, 'tests', 'serviceRequests.test.mjs')), true);
      assert.equal(fs.existsSync(path.join(cwd, '.powerpages-site', '.portalconfig', 'manifest.yml')), false);
      assert.equal(
        fs.existsSync(
          path.join(cwd, '.powerpages-site', '.portalconfig', 'source-environment-manifest.yml')
        ),
        true
      );
      if (args[0] === 'run') {
        fs.mkdirSync(path.join(cwd, 'dist'));
        fs.writeFileSync(path.join(cwd, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.websiteRecordId, CLONED_ID);
  assert.equal(pacCalls, 2);
  assert.deepEqual(npmCalls.map((args) => args[0]), ['install', 'run']);
  assert.equal(
    fs.readFileSync(path.join(output, '311-portal', '.npmrc'), 'utf8'),
    fs.readFileSync(path.join(source, '.npmrc'), 'utf8')
  );
});

test('copyMissingTemplateFiles skips PAC-owned identity files and restores ordinary files', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const clone = path.join(dir, 'clone');
  createSource(source, { id: SOURCE_ID });
  createSource(clone, { id: CLONED_ID });
  fs.writeFileSync(path.join(source, 'extra.json'), '{}');
  fs.mkdirSync(path.join(source, '.powerpages-site', '.portalconfig'));
  fs.writeFileSync(
    path.join(source, '.powerpages-site', '.portalconfig', 'manifest.yml'),
    'stale clone state\n'
  );

  assert.deepEqual(copyMissingTemplateFiles(source, clone), ['extra.json']);
  assert.match(
    fs.readFileSync(path.join(clone, '.powerpages-site', 'website.yml'), 'utf8'),
    new RegExp(CLONED_ID)
  );
  assert.equal(
    fs.existsSync(path.join(clone, '.powerpages-site', '.portalconfig', 'manifest.yml')),
    false
  );
});

test('copyMissingTemplateFiles rejects source symlinks', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const clone = path.join(dir, 'clone');
  createSource(source);
  createSource(clone);
  const target = path.join(dir, 'outside.json');
  const link = path.join(source, 'linked.json');
  fs.writeFileSync(target, '{}');
  try {
    fs.symlinkSync(target, link);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip(`symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }
  assert.throws(
    () => copyMissingTemplateFiles(source, clone),
    /symbolic link: linked\.json/
  );
});

test('runPac invokes pac.exe directly on Windows without a command shell', () => {
  const calls = [];
  runPac(['pages', 'clone', '--path', 'source'], {
    platform: 'win32',
    cwd: 'C:\\stable-parent',
    runCommand(command, args, options) {
      calls.push([command, args, options]);
      return 'ok';
    },
  });
  assert.equal(calls[0][0], 'pac.exe');
  assert.deepEqual(calls[0][1], ['pages', 'clone', '--path', 'source']);
  assert.equal(calls[0][2].cwd, 'C:\\stable-parent');
  assert.equal(calls[0][2].shell, false);
});

test('runNpm invokes the Windows npm.cmd shim through cmd.exe without a command shell', () => {
  const calls = [];
  runNpm(['run', 'build'], '/tmp/site', {
    platform: 'win32',
    runNpmCommand(command, args, options) {
      calls.push([command, args, options]);
      return 'ok';
    },
  });
  assert.equal(calls[0][0], 'cmd.exe');
  assert.deepEqual(calls[0][1], ['/d', '/s', '/c', 'npm.cmd', 'run', 'build']);
  assert.equal(calls[0][2].cwd, '/tmp/site');
  assert.equal(calls[0][2].shell, false);
});
