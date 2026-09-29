'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const { loadMatrix, dependencySet } = require('../lib/pcf-matrix.js');
const { planScaffold } = require('../lib/pcf-scaffold.js');

const {
  checkToolchain,
  checkProject,
  pcfprojBuildMode,
  parsePacHelpVersion,
} = require('../lib/pcf-doctor.js');

const ROOT = path.join(__dirname, '..', '..');
const MATRIX = loadMatrix();
const cliPath = path.join(__dirname, '..', 'pcf-doctor.js');

function renderedPcfproj() {
  const plan = planScaffold({
    template: 'field-standard',
    namespace: 'Contoso.Controls',
    name: 'StarRating',
  });
  return plan.files.find((file) => file.relPath === 'StarRating.pcfproj').content;
}

function manifestModel(controlType = 'standard', platformLibraries = []) {
  return {
    control: { controlType },
    resources: { platformLibraries },
  };
}

function standardState(overrides = {}) {
  const deps = dependencySet(MATRIX, 'standard');
  return {
    projectPath: 'D:\\Projects\\controls\\StarRating',
    packageJson: {
      dependencies: { ...deps.dependencies },
      devDependencies: { ...deps.devDependencies },
    },
    hasLockfile: true,
    hasNodeModules: true,
    pcfprojText: renderedPcfproj(),
    eslintFiles: ['eslint.config.mjs'],
    manifestModels: [manifestModel()],
    outStray: [],
    ...overrides,
  };
}

function ids(findings) {
  return findings.map((finding) => finding.id);
}

function byId(findings, id) {
  return findings.find((finding) => finding.id === id);
}

test('pcfprojBuildMode reports production only when the property is after Microsoft.Common.props', () => {
  const production = renderedPcfproj();
  const missing = production.replace(/\s*<PcfBuildMode>production<\/PcfBuildMode>\r?\n/, '\n');
  const development = production.replace('<PcfBuildMode>production</PcfBuildMode>', '<PcfBuildMode>development</PcfBuildMode>');
  const beforeImport = production
    .replace(/\s*<PcfBuildMode>production<\/PcfBuildMode>\r?\n/, '\n')
    .replace(
      /(\s*<Import Project="\$\(MSBuildExtensionsPath\)\\\$\(MSBuildToolsVersion\)\\Microsoft\.Common\.props" \/>)/,
      '  <PropertyGroup>\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>\n$1',
    );

  assert.equal(pcfprojBuildMode(production).status, 'production');
  assert.equal(pcfprojBuildMode(missing).status, 'missing');
  assert.equal(pcfprojBuildMode(development).status, 'development');
  assert.equal(pcfprojBuildMode(beforeImport).status, 'ineffective');
  assert.ok(pcfprojBuildMode(beforeImport).modeOffset < pcfprojBuildMode(beforeImport).importOffset);
});

test('checkToolchain uses matrix thresholds and downgrades optional push tools when only build is needed', () => {
  const buildOnly = checkToolchain({
    node: '18.19.0',
    npm: null,
    pac: null,
    dotnet: null,
    platform: 'win32',
  }, MATRIX, { needs: ['build'] });

  assert.equal(byId(buildOnly, 'TOOL_NODE_OLD').severity, 'error');
  assert.equal(byId(buildOnly, 'TOOL_NPM_MISSING').severity, 'error');
  assert.equal(byId(buildOnly, 'TOOL_PAC_MISSING').severity, 'info');
  assert.equal(byId(buildOnly, 'TOOL_DOTNET_MISSING').severity, 'info');
  assert.match(byId(buildOnly, 'TOOL_NODE_OLD').fix, /20\.0\.0/);

  const push = checkToolchain({
    node: '22.13.1',
    npm: '10.9.9',
    pac: '1.36.0',
    dotnet: null,
    platform: 'win32',
  }, MATRIX, { needs: ['push'] });

  assert.equal(byId(push, 'TOOL_PAC_OLD').severity, 'error');
  assert.equal(byId(push, 'TOOL_DOTNET_MISSING').severity, 'error');
});

test('checkToolchain reports pac development builds without blocking on minimum comparison', () => {
  const findings = checkToolchain({
    node: '22.13.1',
    npm: '10.9.9',
    pac: '0.1.0-dev',
    dotnet: '8.0.100',
    platform: 'linux',
  }, MATRIX, { needs: ['push'] });

  assert.deepEqual(ids(findings), ['TOOL_PAC_DEV_BUILD']);
  assert.equal(findings[0].severity, 'warning');
  assert.match(findings[0].message, /development build/i);
});

test('parsePacHelpVersion reads the Version line from pac help defensively', () => {
  assert.equal(parsePacHelpVersion('Microsoft PowerPlatform CLI\nVersion: 1.51.1-dev\nUsage: pac [admin]'), '1.51.1-dev');
  assert.equal(parsePacHelpVersion('Usage only'), null);
});

test('checkProject reports dependency, lockfile, node_modules, eslint, build mode, out, and path findings', () => {
  const deps = dependencySet(MATRIX, 'standard');
  const packageJson = {
    dependencies: { ...deps.dependencies },
    devDependencies: { ...deps.devDependencies },
  };
  packageJson.devDependencies['pcf-scripts'] = `^0.0.1`;

  const pcfproj = renderedPcfproj()
    .replace('<PcfBuildMode>production</PcfBuildMode>', '<PcfBuildMode>development</PcfBuildMode>')
    .replace(/Microsoft\.PowerApps\.MSBuild\.Pcf" Version="[^"]+"/, 'Microsoft.PowerApps.MSBuild.Pcf" Version="1.*"');

  const findings = checkProject(standardState({
    projectPath: 'C:\\Users\\maker\\OneDrive - Contoso\\' + 'a'.repeat(190),
    packageJson,
    hasLockfile: false,
    hasNodeModules: false,
    pcfprojText: pcfproj,
    eslintFiles: ['.eslintrc.json'],
    outStray: ['out\\controls\\StarRating\\debug.map'],
  }), MATRIX, { hosts: ['model'], needs: ['build'], platform: 'win32' });

  assert.ok(byId(findings, 'PROJ_NO_LOCKFILE'));
  assert.equal(byId(findings, 'PROJ_NODE_MODULES_MISSING').severity, 'error');
  assert.ok(byId(findings, 'PROJ_DEP_DRIFT'));
  assert.ok(byId(findings, 'PROJ_FLOATING_RANGE'));
  assert.ok(byId(findings, 'PROJ_ESLINT_LEGACY'));
  assert.ok(byId(findings, 'PROJ_BUILDMODE_NOT_PRODUCTION'));
  assert.ok(byId(findings, 'PROJ_MSBUILD_PCF_FLOATING'));
  assert.ok(byId(findings, 'PROJ_OUT_STALE'));
  assert.ok(byId(findings, 'PROJ_PATH_ONEDRIVE'));
  assert.ok(byId(findings, 'PROJ_PATH_LONG'));
});

test('checkProject reports ineffective PcfBuildMode and pinned MSBuild package drift separately', () => {
  const pcfproj = renderedPcfproj()
    .replace(/\s*<PcfBuildMode>production<\/PcfBuildMode>\r?\n/, '\n')
    .replace(
      /(\s*<Import Project="\$\(MSBuildExtensionsPath\)\\\$\(MSBuildToolsVersion\)\\Microsoft\.Common\.props" \/>)/,
      '  <PropertyGroup>\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>\n$1',
    )
    .replace(/Microsoft\.PowerApps\.MSBuild\.Pcf" Version="[^"]+"/, 'Microsoft.PowerApps.MSBuild.Pcf" Version="1.0.0"');

  const findings = checkProject(standardState({ pcfprojText: pcfproj }), MATRIX, { hosts: ['model'], needs: ['build'] });

  assert.match(byId(findings, 'PROJ_BUILDMODE_NOT_PRODUCTION').message, /set but ineffective — move it below the Microsoft\.Common\.props import/);
  assert.match(byId(findings, 'PROJ_DEP_DRIFT').message, /Microsoft\.PowerApps\.MSBuild\.Pcf/);
});

test('checkProject chooses the virtual dependency family and reports platform-library and Pages conflicts', () => {
  const deps = dependencySet(MATRIX, 'virtual');
  const packageJson = {
    dependencies: { ...deps.dependencies, react: '0.0.1' },
    devDependencies: { ...deps.devDependencies },
  };
  const findings = checkProject(standardState({
    packageJson,
    manifestModels: [manifestModel('virtual', [{ name: 'Fluent', version: '9.68.0' }])],
  }), MATRIX, { hosts: ['model', 'pages'], needs: ['build'] });

  assert.ok(byId(findings, 'PROJ_DEP_DRIFT'));
  assert.ok(byId(findings, 'PROJ_PLATFORM_LIB'));
  assert.equal(byId(findings, 'PROJ_HOST_CONFLICT').severity, 'error');
  assert.match(byId(findings, 'PROJ_PLATFORM_LIB').fix, /PLATFORM_LIB_VERSION|Remove platform-library/);
});

test('checkProject is clean for a matrix-aligned scaffold state', () => {
  assert.deepEqual(checkProject(standardState(), MATRIX, { hosts: ['model'], needs: ['build'] }), []);
});

async function runCli(argv, stubs) {
  const emitted = { stdout: '', stderr: '', exitCode: null };
  const realAuth = require('../lib/dataverse-auth.js');
  const cli = loadCli(cliPath, {
    argv,
    requires: {
      './lib/dataverse-auth': {
        parseArgs: realAuth.parseArgs,
        validateFlags: realAuth.validateFlags,
        emitResult: (ok, payload) => {
          if (ok) emitted.stdout += `${JSON.stringify(payload)}\n`;
          else if (payload && typeof payload === 'object') emitted.stdout += `${JSON.stringify(payload)}\n`;
          else emitted.stderr += `${String(payload)}\n`;
          emitted.exitCode = ok ? 0 : 1;
          const err = new Error(`process.exit(${emitted.exitCode})`);
          err.exitCode = emitted.exitCode;
          throw err;
        },
      },
      ...stubs,
    },
  });
  cli.emitted = emitted;
  assert.equal(typeof cli.main, 'function');
  try {
    await cli.main(argv);
  } catch (err) {
    if (!String(err && err.message).startsWith('process.exit(')) throw err;
  }
  return cli;
}

test('CLI validates flags before probing and prints usage on errors', async () => {
  const cli = await runCli(['--need', 'push'], {});

  assert.equal(cli.exitCode, 1);
  assert.equal(cli.stdoutText(), '');
  assert.match(cli.stderrText(), /node scripts[/\\]pcf-doctor\.js/);
  assert.match(cli.stderrText(), /did you mean --needs/i);
});

test('CLI emits JSON and makes pac optional for build but required for push', async () => {
  const stubs = {
    './lib/node-tool': {
      runNpm: (args, opts) => {
        assert.deepEqual(args, ['--version']);
        assert.equal(opts.npmCli, 'D:\\tools\\npm-cli.js');
        return { status: 0, stdout: '10.9.9\n', stderr: '' };
      },
    },
    './lib/pac-exec': {
      runPac: () => ({ status: 1, stdout: '', stderr: 'pac missing' }),
    },
    'node:child_process': {
      spawnSync: () => ({ status: 0, stdout: '8.0.100\n', stderr: '' }),
    },
  };

  const buildOnly = await runCli(['--needs', 'build', '--npm-cli', 'D:\\tools\\npm-cli.js'], stubs);
  assert.equal(buildOnly.emitted.exitCode, 0);
  const buildPayload = JSON.parse(buildOnly.emitted.stdout);
  assert.equal(buildPayload.ok, true);
  assert.equal(byId(buildPayload.toolchain, 'TOOL_PAC_MISSING').severity, 'info');

  const push = await runCli(['--needs', 'push', '--npm-cli', 'D:\\tools\\npm-cli.js'], stubs);
  assert.equal(push.emitted.exitCode, 1);
  const pushPayload = JSON.parse(push.emitted.stdout);
  assert.equal(pushPayload.ok, false);
  assert.equal(byId(pushPayload.toolchain, 'TOOL_PAC_MISSING').severity, 'error');
});
