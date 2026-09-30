'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const { loadMatrix, dependencySet } = require('../lib/pcf-matrix.js');
const { planScaffold, writeScaffold } = require('../lib/pcf-scaffold.js');
const { pcfprojBuildMode } = require('../lib/pcf-doctor.js');

const MATRIX = loadMatrix();
const cliPath = path.join(__dirname, '..', 'pcf-upgrade.js');

function renderedProject() {
  return planScaffold({
    template: 'field-standard',
    namespace: 'Contoso.Controls',
    name: 'StarRating',
  });
}

function renderedPcfproj() {
  return renderedProject().files.find((file) => file.relPath === 'StarRating.pcfproj').content;
}

function renderedManifest() {
  return planScaffold({
    template: 'field-virtual',
    namespace: 'Contoso.Controls',
    name: 'StarRating',
  }).files.find((file) => file.relPath === path.join('StarRating', 'ControlManifest.Input.xml')).content;
}

function packageText(kind = 'standard') {
  const deps = dependencySet(MATRIX, kind);
  return `${JSON.stringify({
    name: 'star-rating',
    version: '1.0.0',
    dependencies: kind === 'virtual'
      ? {
        '@fluentui/react-components': '^9.68.0',
        react: '^18.2.0',
        'left-pad': '1.3.0',
        'react-dom': '~18.2.0',
      }
      : {
        'left-pad': '1.3.0',
      },
    devDependencies: {
      'pcf-scripts': '^0.0.1',
      'pcf-start': '~0.0.2',
      '@types/powerapps-component-framework': '0.0.1',
      'custom-tool': '4.5.6',
      ...(kind === 'virtual' ? { '@types/react': '0.0.1', 'eslint-plugin-react': '0.0.1' } : {}),
    },
    scripts: { build: 'pcf-scripts build' },
  }, null, 2)}\n`;
}

function withCrLf(text) {
  return text.replace(/\n/g, '\r\n');
}

function state(overrides = {}) {
  const packageJsonText = overrides.packageJsonText || packageText('standard');
  const manifestText = overrides.manifestText || renderedManifest().replace('control-type="virtual"', 'control-type="standard"')
    .replace(/\s*<platform-library name="React" version="[^"]+" \/>\r?\n/g, '\n')
    .replace(/\s*<platform-library name="Fluent" version="[^"]+" \/>\r?\n/g, '\n');
  return {
    projectPath: 'D:\\Projects\\controls\\StarRating',
    packageJson: JSON.parse(packageJsonText),
    packageJsonText,
    packageJsonPath: 'D:\\Projects\\controls\\StarRating\\package.json',
    pcfprojText: overrides.pcfprojText || renderedPcfproj(),
    pcfprojPath: 'D:\\Projects\\controls\\StarRating\\StarRating.pcfproj',
    manifestModels: [
      {
        control: { controlType: /control-type="virtual"/.test(manifestText) ? 'virtual' : 'standard' },
        resources: {
          platformLibraries: [...manifestText.matchAll(/<platform-library\b[^>]*\bname="([^"]+)"[^>]*\bversion="([^"]+)"/g)]
            .map((match) => ({ name: match[1], version: match[2] })),
        },
      },
    ],
    manifestFiles: [{ path: 'D:\\Projects\\controls\\StarRating\\StarRating\\ControlManifest.Input.xml', text: manifestText }],
    hasLockfile: true,
    hasNodeModules: true,
    eslintFiles: ['eslint.config.mjs'],
    outStray: [],
    ...overrides,
  };
}

function step(plan, id) {
  const found = plan.steps.find((item) => item.id === id);
  assert.ok(found, `expected step ${id}`);
  return found;
}

test('planUpgrade returns no steps for a matrix-clean project', () => {
  const { planUpgrade } = require('../lib/pcf-upgrade.js');
  const clean = state({ packageJsonText: `${JSON.stringify({
    name: 'star-rating',
    version: '1.0.0',
    dependencies: { 'left-pad': '1.3.0' },
    devDependencies: { ...dependencySet(MATRIX, 'standard').devDependencies, 'custom-tool': '4.5.6' },
    scripts: { build: 'pcf-scripts build' },
  }, null, 2)}\n` });

  assert.deepEqual(planUpgrade(clean, MATRIX, { hosts: ['model'] }), { steps: [], manual: [] });
});

test('DEPS_TO_MATRIX pins only existing matrix packages in place and preserves user dependencies', () => {
  const { planUpgrade } = require('../lib/pcf-upgrade.js');
  const before = packageText('virtual');
  const after = step(planUpgrade(state({ packageJsonText: before, manifestText: renderedManifest() }), MATRIX, { hosts: ['model'] }), 'DEPS_TO_MATRIX').apply(before);

  const expected = JSON.parse(before);
  const matrixSet = dependencySet(MATRIX, 'virtual');
  expected.dependencies['@fluentui/react-components'] = matrixSet.dependencies['@fluentui/react-components'];
  expected.dependencies.react = matrixSet.dependencies.react;
  expected.dependencies['react-dom'] = matrixSet.dependencies['react-dom'];
  expected.devDependencies['pcf-scripts'] = matrixSet.devDependencies['pcf-scripts'];
  expected.devDependencies['pcf-start'] = matrixSet.devDependencies['pcf-start'];
  expected.devDependencies['@types/powerapps-component-framework'] = matrixSet.devDependencies['@types/powerapps-component-framework'];
  expected.devDependencies['@types/react'] = matrixSet.devDependencies['@types/react'];
  expected.devDependencies['eslint-plugin-react'] = matrixSet.devDependencies['eslint-plugin-react'];
  assert.equal(after, `${JSON.stringify(expected, null, 2)}\n`);
  assert.deepEqual(Object.keys(JSON.parse(after).dependencies), ['@fluentui/react-components', 'react', 'left-pad', 'react-dom']);
  assert.equal(JSON.parse(after).devDependencies['custom-tool'], '4.5.6');
});

test('DEPS_TO_MATRIX preserves UTF-8 BOM and dominant CRLF newlines', () => {
  const { rewritePackageJson } = require('../lib/pcf-upgrade.js');
  const before = `\uFEFF${withCrLf(packageText('standard'))}`;
  const after = rewritePackageJson(before, dependencySet(MATRIX, 'standard'));

  assert.equal(after.charCodeAt(0), 0xFEFF);
  assert.match(after, /\r\n/);
  assert.doesNotMatch(after.replace(/\r\n/g, ''), /\n/);
  assert.equal(JSON.parse(after.slice(1)).devDependencies['pcf-scripts'], dependencySet(MATRIX, 'standard').devDependencies['pcf-scripts']);
});

test('DEPS_TO_MATRIX repairs matrix packages in their existing package.json section', () => {
  const { rewritePackageJson } = require('../lib/pcf-upgrade.js');
  const before = `${JSON.stringify({
    name: 'star-rating',
    version: '1.0.0',
    dependencies: { 'pcf-scripts': '^0.0.1' },
    devDependencies: { 'pcf-start': '^0.0.2' },
  }, null, 2)}\n`;
  const after = JSON.parse(rewritePackageJson(before, dependencySet(MATRIX, 'standard')));

  assert.equal(after.dependencies['pcf-scripts'], dependencySet(MATRIX, 'standard').devDependencies['pcf-scripts']);
  assert.equal(Object.hasOwn(after.devDependencies, 'pcf-scripts'), false);
  assert.equal(after.devDependencies['pcf-start'], dependencySet(MATRIX, 'standard').devDependencies['pcf-start']);
});

test('BUILDMODE_PRODUCTION moves an ineffective property below Microsoft.Common.props', () => {
  const { planUpgrade } = require('../lib/pcf-upgrade.js');
  const before = renderedPcfproj()
    .replace(/\s*    <!-- pac pcf push otherwise builds[\s\S]*?<PcfBuildMode>production<\/PcfBuildMode>\r?\n/, '\n')
    .replace(
      /(\s*<Import Project="\$\(MSBuildExtensionsPath\)\\\$\(MSBuildToolsVersion\)\\Microsoft\.Common\.props" \/>)/,
      '  <PropertyGroup>\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>\n$1',
    );
  assert.equal(pcfprojBuildMode(before).status, 'ineffective');

  const after = step(planUpgrade(state({ pcfprojText: before }), MATRIX, { hosts: ['model'] }), 'BUILDMODE_PRODUCTION').apply(before);

  assert.equal(pcfprojBuildMode(after).status, 'production');
  assert.equal((after.match(/<PcfBuildMode>production<\/PcfBuildMode>/g) || []).length, 1);
  assert.ok(after.indexOf('<PcfBuildMode>production</PcfBuildMode>') > after.indexOf('Microsoft.Common.props'));
  assert.match(after, /<Name>StarRating<\/Name>\r?\n    <PcfBuildMode>production<\/PcfBuildMode>\r?\n    <ProjectGuid>/);
});

test('BUILDMODE_PRODUCTION removes conditioned overrides and leaves commented examples untouched', () => {
  const { rewritePcfBuildMode } = require('../lib/pcf-upgrade.js');
  const before = renderedPcfproj()
    .replace(/\s*    <!-- pac pcf push otherwise builds[\s\S]*?<PcfBuildMode>production<\/PcfBuildMode>\r?\n/, '\n')
    .replace(
      /(\s*<Import Project="\$\(MSBuildExtensionsPath\)\\\$\(MSBuildToolsVersion\)\\Microsoft\.Common\.props" \/>)/,
      '  <PropertyGroup>\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>\n$1',
    )
    .replace(
      /<\/PropertyGroup>\s*<PropertyGroup>\s*<TargetFrameworkVersion>/,
      '</PropertyGroup>\n  <!-- <PcfBuildMode>development</PcfBuildMode> -->\n  <PropertyGroup Condition="\'$(Configuration)\'==\'Release\'">\n    <PcfBuildMode>development</PcfBuildMode>\n  </PropertyGroup>\n  <PropertyGroup Condition=\'"$(Configuration)" == "Release"\'>\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>\n\n  <PropertyGroup>\n    <TargetFrameworkVersion>',
    );

  const after = rewritePcfBuildMode(before);

  assert.equal(pcfprojBuildMode(after).status, 'production');
  assert.equal((after.match(/<PcfBuildMode>production<\/PcfBuildMode>/g) || []).length, 1);
  assert.match(after, /<!-- <PcfBuildMode>development<\/PcfBuildMode> -->/);
  assert.doesNotMatch(after, /<PropertyGroup\b[^>]*Condition=[\s\S]*?<PcfBuildMode>/);
});

test('BUILDMODE_PRODUCTION removes Choose/Target conditioned values and inserts an unconditioned production setting', () => {
  const { rewritePcfBuildMode } = require('../lib/pcf-upgrade.js');
  const before = renderedPcfproj()
    .replace(/\s*    <!-- pac pcf push otherwise builds[\s\S]*?<PcfBuildMode>production<\/PcfBuildMode>\r?\n/, '\n')
    .replace(
      /<\/Project>/,
      '  <Choose>\n    <When Condition="\'$(Configuration)\'==\'Release\'">\n      <PropertyGroup>\n        <PcfBuildMode>production</PcfBuildMode>\n      </PropertyGroup>\n    </When>\n    <Otherwise>\n      <PropertyGroup>\n        <PcfBuildMode>development</PcfBuildMode>\n      </PropertyGroup>\n    </Otherwise>\n  </Choose>\n  <Target Name="AfterBuild">\n    <PropertyGroup>\n      <PcfBuildMode>production</PcfBuildMode>\n    </PropertyGroup>\n  </Target>\n</Project>',
    );

  const after = rewritePcfBuildMode(before);

  assert.equal(pcfprojBuildMode(after).status, 'production');
  assert.equal((after.match(/<PcfBuildMode>production<\/PcfBuildMode>/g) || []).length, 1);
  assert.equal((after.match(/<PcfBuildMode>development<\/PcfBuildMode>/g) || []).length, 0);
});

test('BUILDMODE_PRODUCTION uses doctor occurrences so comments between real values are untouched', () => {
  const { rewritePcfBuildMode } = require('../lib/pcf-upgrade.js');
  const before = renderedPcfproj()
    .replace('<PcfBuildMode>production</PcfBuildMode>', '<PcfBuildMode>development</PcfBuildMode>')
    .replace(
      /<\/PropertyGroup>\s*<PropertyGroup>\s*<TargetFrameworkVersion>/,
      '</PropertyGroup>\n  <!-- <PcfBuildMode>commented</PcfBuildMode> -->\n  <PropertyGroup Condition="\'$(Configuration)\'==\'Release\'">\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>\n\n  <PropertyGroup>\n    <TargetFrameworkVersion>',
    );

  const after = rewritePcfBuildMode(before);

  assert.equal(pcfprojBuildMode(after).status, 'production');
  assert.match(after, /<!-- <PcfBuildMode>commented<\/PcfBuildMode> -->/);
  assert.equal((after.match(/<PcfBuildMode>/g) || []).length, 2);
  assert.doesNotMatch(after, /<PcfBuildMode>development<\/PcfBuildMode>/);
});

test('BUILDMODE_PRODUCTION preserves CRLF newlines', () => {
  const { rewritePcfBuildMode } = require('../lib/pcf-upgrade.js');
  const before = withCrLf(renderedPcfproj().replace('<PcfBuildMode>production</PcfBuildMode>', '<PcfBuildMode>development</PcfBuildMode>'));
  const after = rewritePcfBuildMode(before);

  assert.match(after, /\r\n/);
  assert.doesNotMatch(after.replace(/\r\n/g, ''), /\n/);
  assert.equal(pcfprojBuildMode(after).status, 'production');
});

test('PLATFORM_LIB_VERSION changes only React and Fluent version attributes', () => {
  const { planUpgrade } = require('../lib/pcf-upgrade.js');
  const before = renderedManifest()
    .replace('name="React" version="16.14.0"', 'name="React" version="18.2.0"')
    .replace('name="Fluent" version="9.46.2"', 'name="Fluent" version="9.68.0"');

  const after = step(planUpgrade(state({ manifestText: before, packageJsonText: packageText('virtual') }), MATRIX, { hosts: ['model'] }), 'PLATFORM_LIB_VERSION').apply(before);

  const expected = before
    .replace('name="React" version="18.2.0"', 'name="React" version="16.14.0"')
    .replace('name="Fluent" version="9.68.0"', 'name="Fluent" version="9.46.2"');
  assert.equal(after, expected);
});

test('PLATFORM_LIB_VERSION supports single-quoted versions and preserves CRLF newlines', () => {
  const { rewritePlatformLibraries } = require('../lib/pcf-upgrade.js');
  const before = withCrLf(renderedManifest()
    .replace('name="React" version="16.14.0"', 'name="React" version=\'18.2.0\'')
    .replace('name="Fluent" version="9.46.2"', 'name="Fluent" version=\'9.68.0\''));

  const after = rewritePlatformLibraries(before, MATRIX);

  assert.match(after, /name="React" version='16\.14\.0'/);
  assert.match(after, /name="Fluent" version='9\.46\.2'/);
  assert.match(after, /\r\n/);
  assert.doesNotMatch(after.replace(/\r\n/g, ''), /\n/);
});

test('planUpgrade prints legacy ESLint and feature declarations as manual steps only', () => {
  const { planUpgrade } = require('../lib/pcf-upgrade.js');
  const plan = planUpgrade(state({ eslintFiles: ['.eslintrc.json'] }), MATRIX, { hosts: ['model'] });

  assert.equal(plan.steps.some((item) => item.id === 'ESLINT_FLAT_CONFIG'), false);
  assert.ok(plan.manual.find((item) => item.id === 'ESLINT_FLAT_CONFIG'));
  assert.match(plan.manual.find((item) => item.id === 'ESLINT_FLAT_CONFIG').why, /never replaces or deletes/i);
});

test('CLI refuses to apply when the project has git changes', async () => {
  const realAuth = require('../lib/dataverse-auth.js');
  const emitted = { stdout: '', stderr: '', exitCode: null };
  const cli = loadCli(cliPath, {
    argv: ['--project', 'D:\\Projects\\controls\\StarRating', '--apply'],
    requires: {
      './lib/dataverse-auth': {
        parseArgs: realAuth.parseArgs,
        validateFlags: realAuth.validateFlags,
        emitResult: (ok, payload) => {
          if (payload && typeof payload === 'object') emitted.stdout += `${JSON.stringify(payload)}\n`;
          else emitted.stderr += `${String(payload)}\n`;
          emitted.exitCode = ok ? 0 : 1;
          const err = new Error(`process.exit(${emitted.exitCode})`);
          err.exitCode = emitted.exitCode;
          throw err;
        },
      },
      './lib/pcf-upgrade': {
        runUpgrade: () => ({ ok: false, error: 'Refusing to apply because the project has uncommitted changes. Commit, stash, or pass --allow-dirty.' }),
      },
    },
  });

  try {
    await cli.main(['--project', 'D:\\Projects\\controls\\StarRating', '--apply']);
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }

  assert.equal(emitted.exitCode, 1);
  assert.match(emitted.stdout, /Refusing to apply/);
});

test('CLI passes --steps to runUpgrade and rejects a value on boolean --apply', async () => {
  const realAuth = require('../lib/dataverse-auth.js');
  const calls = [];
  const runWithSteps = loadCli(cliPath, {
    argv: ['--project', 'D:\\Projects\\controls\\StarRating', '--apply', '--allow-dirty', '--steps', 'PLATFORM_LIB_VERSION'],
    requires: {
      './lib/dataverse-auth': {
        parseArgs: realAuth.parseArgs,
        validateFlags: realAuth.validateFlags,
        emitResult: (ok, payload) => {
          calls.push(['emit', ok, payload]);
          const err = new Error(`process.exit(${ok ? 0 : 1})`);
          err.exitCode = ok ? 0 : 1;
          throw err;
        },
      },
      './lib/pcf-upgrade': {
        runUpgrade: (options) => {
          calls.push(['runUpgrade', options]);
          return { ok: true };
        },
      },
    },
  });
  try {
    await runWithSteps.main();
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }
  assert.deepEqual(calls.find((call) => call[0] === 'runUpgrade')[1].steps, ['PLATFORM_LIB_VERSION']);

  const applyValue = loadCli(cliPath, {
    argv: ['--project', 'D:\\Projects\\controls\\StarRating', '--apply=PLATFORM_LIB_VERSION'],
    requires: {
      './lib/dataverse-auth': realAuth,
      './lib/pcf-upgrade': { runUpgrade: () => { throw new Error('runUpgrade should not run'); } },
    },
  });
  try {
    await applyValue.main();
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }
  assert.equal(applyValue.exitCode, 1);
  assert.match(applyValue.stderrText(), /--apply does not take a value/);
});

test('runUpgrade limits apply to selected steps and rejects unknown step ids', () => {
  const { runUpgrade } = require('../lib/pcf-upgrade.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-upgrade-steps-'));
  try {
    const projectDir = path.join(tmp, 'StarRating');
    writeScaffold(renderedProject(), projectDir);
    fs.writeFileSync(path.join(projectDir, 'package.json'), packageText('standard'));
    fs.writeFileSync(path.join(projectDir, 'StarRating.pcfproj'), renderedPcfproj().replace('<PcfBuildMode>production</PcfBuildMode>', '<PcfBuildMode>development</PcfBuildMode>'));

    const limited = runUpgrade({ project: projectDir, apply: true, allowDirty: true, steps: ['BUILDMODE_PRODUCTION'], noInstall: true });
    assert.equal(limited.ok, false);
    assert.deepEqual(limited.applied, ['BUILDMODE_PRODUCTION']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).devDependencies['pcf-scripts'], '^0.0.1');
    assert.equal(pcfprojBuildMode(fs.readFileSync(path.join(projectDir, 'StarRating.pcfproj'), 'utf8')).status, 'production');

    const unknown = runUpgrade({ project: projectDir, apply: true, allowDirty: true, steps: ['UNKNOWN_STEP'] });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /Unknown --steps value 'UNKNOWN_STEP'/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runUpgrade refuses a dirty git tree before applying changes', () => {
  const { runUpgrade } = require('../lib/pcf-upgrade.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-upgrade-dirty-'));
  try {
    const projectDir = path.join(tmp, 'StarRating');
    writeScaffold(renderedProject(), projectDir);
    fs.writeFileSync(path.join(projectDir, 'package.json'), packageText('standard'));
    fs.appendFileSync(path.join(projectDir, 'README.md'), '\nlocal note\n');

    const result = runUpgrade({ project: projectDir, apply: true }, {
      runNpm: () => { throw new Error('npm install should not run on a dirty tree'); },
      spawnResultSync: (name, args, options) => {
        assert.equal(name, 'git');
        assert.deepEqual(args, ['status', '--porcelain', '--', projectDir]);
        assert.deepEqual(options, { cwd: projectDir, encoding: 'utf8' });
        return { status: 0, stdout: ' M README.md\n', stderr: '' };
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /uncommitted changes/);
    assert.deepEqual(result.applied, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('dirtyTreeStatus probes git through process-runner with a fixed argv array', () => {
  const calls = [];
  const { dirtyTreeStatus } = require('../lib/pcf-upgrade.js');
  const result = dirtyTreeStatus('D:\\Projects\\controls\\StarRating', {
    spawnResultSync: (name, args, options) => {
      calls.push({ name, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    name: 'git',
    args: ['status', '--porcelain', '--', 'D:\\Projects\\controls\\StarRating'],
    options: { cwd: 'D:\\Projects\\controls\\StarRating', encoding: 'utf8' },
  }]);
});

test('runUpgrade refuses apply outside a git work tree unless allowDirty is passed', () => {
  const { runUpgrade } = require('../lib/pcf-upgrade.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-upgrade-outside-git-'));
  try {
    const projectDir = path.join(tmp, 'StarRating');
    writeScaffold(renderedProject(), projectDir);
    fs.writeFileSync(path.join(projectDir, 'package.json'), packageText('standard'));
    fs.mkdirSync(path.join(projectDir, 'node_modules'), { recursive: true });

    const refused = runUpgrade({ project: projectDir, apply: true }, { runNpm: () => ({ status: 0, stdout: '', stderr: '' }) });
    const allowed = runUpgrade({ project: projectDir, apply: true, allowDirty: true }, { runNpm: () => ({ status: 0, stdout: '', stderr: '' }) });

    assert.equal(refused.ok, false);
    assert.match(refused.error, /not inside a readable git work tree/);
    assert.equal(allowed.ok, true);
    assert.ok(allowed.applied.includes('DEPS_TO_MATRIX'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runUpgrade reports a failing transform without writing earlier computed files', () => {
  const { runUpgrade } = require('../lib/pcf-upgrade.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-upgrade-transform-fail-'));
  try {
    const projectDir = path.join(tmp, 'StarRating');
    writeScaffold(renderedProject(), projectDir);
    const pkg = path.join(projectDir, 'package.json');
    const proj = path.join(projectDir, 'StarRating.pcfproj');
    fs.writeFileSync(pkg, packageText('standard'));
    fs.writeFileSync(proj, '<Project></Project>\n');
    const beforePackage = fs.readFileSync(pkg, 'utf8');

    const result = runUpgrade({ project: projectDir, apply: true, allowDirty: true }, {
      runNpm: () => { throw new Error('npm install should not run after a transform failure'); },
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /PcfBuildMode transform/);
    assert.deepEqual(result.changedFiles, []);
    assert.equal(result.after, null);
    assert.equal(fs.readFileSync(pkg, 'utf8'), beforePackage);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyUpgrade computes all transforms before writing any file', () => {
  const { applyUpgrade } = require('../lib/pcf-upgrade.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-upgrade-atomic-'));
  try {
    const projectDir = path.join(tmp, 'StarRating');
    fs.mkdirSync(projectDir, { recursive: true });
    const pkg = path.join(projectDir, 'package.json');
    const proj = path.join(projectDir, 'StarRating.pcfproj');
    fs.writeFileSync(pkg, '{"name":"before"}\n');
    fs.writeFileSync(proj, '<Project />\n');

    assert.throws(() => applyUpgrade({
      steps: [
        { id: 'DEPS_TO_MATRIX', file: pkg, apply: () => '{"name":"after"}\n' },
        { id: 'BUILDMODE_PRODUCTION', file: proj, apply: () => { throw new Error('boom'); } },
      ],
    }, projectDir), /boom/);

    assert.equal(fs.readFileSync(pkg, 'utf8'), '{"name":"before"}\n');
    assert.equal(fs.readFileSync(proj, 'utf8'), '<Project />\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyUpgrade refuses a project file symlink that resolves outside the project', () => {
  const { applyUpgrade } = require('../lib/pcf-upgrade.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-upgrade-link-'));
  try {
    const projectDir = path.join(tmp, 'StarRating');
    const outsideDir = path.join(tmp, 'outside');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsidePackage = path.join(outsideDir, 'package.json');
    fs.writeFileSync(outsidePackage, '{"name":"outside"}\n');
    const linkedPackage = path.join(projectDir, 'package.json');
    try {
      fs.symlinkSync(outsidePackage, linkedPackage, 'file');
    } catch (err) {
      assert.match(String(err && err.code ? err.code : err), /EPERM|EACCES|privilege|operation/i);
      return;
    }

    assert.throws(() => applyUpgrade({
      steps: [{ id: 'DEPS_TO_MATRIX', file: linkedPackage, apply: () => '{"name":"changed"}\n' }],
    }, projectDir), /outside the PCF project/);
    assert.equal(fs.readFileSync(outsidePackage, 'utf8'), '{"name":"outside"}\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runUpgrade reports changedFiles when reinstall fails after safe writes', () => {
  const { runUpgrade } = require('../lib/pcf-upgrade.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-upgrade-install-fail-'));
  try {
    const projectDir = path.join(tmp, 'StarRating');
    writeScaffold(renderedProject(), projectDir);
    fs.writeFileSync(path.join(projectDir, 'package.json'), packageText('standard'));

    const result = runUpgrade({ project: projectDir, apply: true, allowDirty: true }, {
      runNpm: () => ({ status: 1, stdout: 'nope', stderr: 'install failed' }),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /npm install failed/);
    assert.deepEqual(result.changedFiles.map((file) => path.basename(file)), ['package.json']);
    assert.equal(result.after, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyUpgrade writes safe files, runs npm install, and skips install when requested', () => {
  const { planUpgrade, applyUpgrade } = require('../lib/pcf-upgrade.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-upgrade-test-'));
  try {
    const projectDir = path.join(tmp, 'StarRating');
    writeScaffold(renderedProject(), projectDir);
    const pkg = path.join(projectDir, 'package.json');
    const proj = path.join(projectDir, 'StarRating.pcfproj');
    fs.writeFileSync(pkg, packageText('standard'));
    fs.writeFileSync(proj, renderedPcfproj().replace('<PcfBuildMode>production</PcfBuildMode>', '<PcfBuildMode>development</PcfBuildMode>'));
    const plan = planUpgrade({
      ...state({ packageJsonText: fs.readFileSync(pkg, 'utf8'), pcfprojText: fs.readFileSync(proj, 'utf8') }),
      projectPath: projectDir,
      packageJsonPath: pkg,
      pcfprojPath: proj,
    }, MATRIX, { hosts: ['model'] });
    const calls = [];

    const result = applyUpgrade(plan, projectDir, {
      runNpm: (args, opts) => {
        calls.push({ args, cwd: opts.cwd, npmCli: opts.npmCli });
        return { status: 0, stdout: 'installed', stderr: '' };
      },
      npmCli: 'C:\\node\\npm-cli.js',
    });

    assert.deepEqual(result.skipped, []);
    assert.ok(result.applied.includes('DEPS_TO_MATRIX'));
    assert.ok(result.applied.includes('BUILDMODE_PRODUCTION'));
    assert.deepEqual(calls, [{ args: ['install'], cwd: projectDir, npmCli: 'C:\\node\\npm-cli.js' }]);

    const skipped = applyUpgrade({ steps: [{ id: 'REINSTALL' }] }, projectDir, { noInstall: true });
    assert.deepEqual(skipped.skipped, ['REINSTALL: run npm install in the PCF project']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
