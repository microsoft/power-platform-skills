'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const { loadMatrix, dependencySet } = require('../lib/pcf-matrix.js');
const { planScaffold } = require('../lib/pcf-scaffold.js');

const {
  checkToolchain,
  checkProject,
  collectProject,
  dependencyFamily,
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

test('pcfprojBuildMode ignores comments and lets the last unconditioned post-import value win', () => {
  const pcfproj = renderedPcfproj()
    .replace('<PcfBuildMode>production</PcfBuildMode>', '<PcfBuildMode>development</PcfBuildMode>')
    .replace(
      '</PropertyGroup>',
      '</PropertyGroup>\n  <!-- <PropertyGroup><PcfBuildMode>production</PcfBuildMode></PropertyGroup> -->\n'
        + '  <PropertyGroup>\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>\n'
        + '  <PropertyGroup>\n    <PcfBuildMode>development</PcfBuildMode>\n  </PropertyGroup>',
    );

  const result = pcfprojBuildMode(pcfproj);
  assert.equal(result.status, 'development');
  assert.equal(result.value, 'development');
  assert.ok(result.occurrences.every((item) => item.endOffset > item.offset));
  assert.equal(result.occurrences.some((item) => item.value === 'production'), true);
  assert.ok(result.importEndOffset > result.importOffset);
});

test('pcfprojBuildMode treats conditioned values as ineffective because pac pcf push builds Debug', () => {
  const conditionedOnly = renderedPcfproj().replace(
    /<PropertyGroup>\s*<Name>/,
    '<PropertyGroup Condition="\'$(Configuration)|$(Platform)\'==\'Release|AnyCPU\'">\n    <Name>',
  );
  const conditionedAfterProduction = renderedPcfproj().replace(
    /<\/PropertyGroup>\s*<PropertyGroup>\s*<TargetFrameworkVersion>/,
    '</PropertyGroup>\n  <PropertyGroup Condition="\'$(Configuration)\'==\'Release\'">\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>\n\n  <PropertyGroup>\n    <TargetFrameworkVersion>',
  );

  assert.deepEqual(
    pickMode(pcfprojBuildMode(conditionedOnly)),
    { status: 'ineffective', reason: 'conditioned', value: 'production' },
  );
  assert.deepEqual(
    pickMode(pcfprojBuildMode(conditionedAfterProduction)),
    { status: 'ineffective', reason: 'conditioned', value: 'production' },
  );
});

test('pcfprojBuildMode accepts single-quoted Condition attributes on groups and elements', () => {
  const singleQuotedGroup = renderedPcfproj().replace(
    /<PropertyGroup>\s*<Name>/,
    '<PropertyGroup Condition=\'"$(Configuration)" == "Release"\'>\n    <Name>',
  );
  const singleQuotedElement = renderedPcfproj().replace(
    '<PcfBuildMode>production</PcfBuildMode>',
    '<PcfBuildMode Condition=\'"$(Configuration)" == "Release"\'>production</PcfBuildMode>',
  );

  assert.deepEqual(
    pickMode(pcfprojBuildMode(singleQuotedGroup)),
    { status: 'ineffective', reason: 'conditioned', value: 'production' },
  );
  assert.deepEqual(
    pickMode(pcfprojBuildMode(singleQuotedElement)),
    { status: 'ineffective', reason: 'conditioned', value: 'production' },
  );
});

test('pcfprojBuildMode accepts double-quoted Condition values containing single quotes', () => {
  const doubleQuotedWithSingles = renderedPcfproj().replace(
    /<PropertyGroup>\s*<Name>/,
    '<PropertyGroup Condition="\'$(Configuration)\' == \'Release\'">\n    <Name>',
  );

  assert.deepEqual(
    pickMode(pcfprojBuildMode(doubleQuotedWithSingles)),
    { status: 'ineffective', reason: 'conditioned', value: 'production' },
  );
});

test('pcfprojBuildMode reports conditioned overrides after unconditioned production as ineffective', () => {
  const conditionedAfterProduction = renderedPcfproj().replace(
    /<\/PropertyGroup>\s*<PropertyGroup>\s*<TargetFrameworkVersion>/,
    '</PropertyGroup>\n  <PropertyGroup Condition="\'$(Configuration)\'==\'Release\'">\n    <PcfBuildMode>development</PcfBuildMode>\n  </PropertyGroup>\n\n  <PropertyGroup>\n    <TargetFrameworkVersion>',
  );

  assert.deepEqual(
    pickMode(pcfprojBuildMode(conditionedAfterProduction)),
    { status: 'ineffective', reason: 'conditioned', value: 'development' },
  );
});

test('pcfprojBuildMode treats conditioned PcfBuildMode attributes as ineffective', () => {
  const conditionedProperty = renderedPcfproj().replace(
    '<PcfBuildMode>production</PcfBuildMode>',
    '<PcfBuildMode Condition="\'$(Configuration)\'==\'Release\'">production</PcfBuildMode>',
  );

  assert.deepEqual(
    pickMode(pcfprojBuildMode(conditionedProperty)),
    { status: 'ineffective', reason: 'conditioned', value: 'production' },
  );
});

test('pcfprojBuildMode ignores commented-out production before reporting missing', () => {
  const commented = renderedPcfproj().replace(
    /\s*<PcfBuildMode>production<\/PcfBuildMode>\r?\n/,
    '\n    <!-- <PcfBuildMode>production</PcfBuildMode> -->\n',
  );

  assert.equal(pcfprojBuildMode(commented).status, 'missing');
});

test('pcfprojBuildMode reports before-import production with a reason', () => {
  const beforeImport = renderedPcfproj()
    .replace(/\s*<PcfBuildMode>production<\/PcfBuildMode>\r?\n/, '\n')
    .replace(
      /(\s*<Import Project="\$\(MSBuildExtensionsPath\)\\\$\(MSBuildToolsVersion\)\\Microsoft\.Common\.props" \/>)/,
      '  <PropertyGroup>\n    <PcfBuildMode>production</PcfBuildMode>\n  </PropertyGroup>\n$1',
    );

  assert.deepEqual(
    pickMode(pcfprojBuildMode(beforeImport)),
    { status: 'ineffective', reason: 'before-import', value: 'production' },
  );
});

test('pcfprojBuildMode treats an unconditioned production after a conditioned one as effective', () => {
  const pcfproj = renderedPcfproj().replace(
    '<PcfBuildMode>production</PcfBuildMode>',
    '<PcfBuildMode Condition="\'$(Configuration)\'==\'Release\'">development</PcfBuildMode>\n    <PcfBuildMode>production</PcfBuildMode>',
  );

  assert.equal(pcfprojBuildMode(pcfproj).status, 'production');
});

test('pcfprojBuildMode keeps conditioned findings when there is no unconditioned value after import', () => {
  const conditionedOnly = renderedPcfproj().replace(
    /<PropertyGroup>\s*<Name>/,
    '<PropertyGroup Condition="\'$(Configuration)|$(Platform)\'==\'Release|AnyCPU\'">',
  );

  assert.deepEqual(
    pickMode(pcfprojBuildMode(conditionedOnly)),
    { status: 'ineffective', reason: 'conditioned', value: 'production' },
  );
});

function pickMode(result) {
  return { status: result.status, reason: result.reason, value: result.value };
}

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
  assert.equal(parsePacHelpVersion('Microsoft PowerPlatform CLI\nVersion: 1.51.1+gabcdef\nUsage: pac [admin]'), '1.51.1+gabcdef');
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

test('checkProject distinguishes conditioned PcfBuildMode and reads MSBuild Pcf child Version elements', () => {
  const pcfproj = renderedPcfproj()
    .replace(/<PropertyGroup>\s*<Name>/, '<PropertyGroup Condition="\'$(Configuration)\'==\'Release\'">\n    <Name>')
    .replace(/<PackageReference Include="Microsoft\.PowerApps\.MSBuild\.Pcf" Version="[^"]+" \/>/, '<PackageReference Include="Microsoft.PowerApps.MSBuild.Pcf">\n      <Version>1.*</Version>\n    </PackageReference>');

  const findings = checkProject(standardState({ pcfprojText: pcfproj }), MATRIX, { hosts: ['model'], needs: ['build'] });

  assert.match(byId(findings, 'PROJ_BUILDMODE_NOT_PRODUCTION').message, /make it unconditional/i);
  assert.ok(byId(findings, 'PROJ_MSBUILD_PCF_FLOATING'));
});

test('checkProject reads single-quoted MSBuild Pcf PackageReference attributes', () => {
  const pcfproj = renderedPcfproj().replace(
    /<PackageReference Include="Microsoft\.PowerApps\.MSBuild\.Pcf" Version="[^"]+" \/>/,
    "<PackageReference Include='Microsoft.PowerApps.MSBuild.Pcf' Version='1.*' />",
  );

  const findings = checkProject(standardState({ pcfprojText: pcfproj }), MATRIX, { hosts: ['model'], needs: ['build'] });

  assert.ok(byId(findings, 'PROJ_MSBUILD_PCF_FLOATING'));
});

test('checkProject ignores commented-out MSBuild Pcf PackageReference examples', () => {
  const pcfproj = renderedPcfproj().replace(
    /<PackageReference Include="Microsoft\.PowerApps\.MSBuild\.Pcf" Version="[^"]+" \/>/,
    '<!-- <PackageReference Include="Microsoft.PowerApps.MSBuild.Pcf" Version="1.*" /> -->',
  );

  const findings = checkProject(standardState({ pcfprojText: pcfproj }), MATRIX, { hosts: ['model'], needs: ['build'] });

  assert.equal(byId(findings, 'PROJ_MSBUILD_PCF_FLOATING'), undefined);
  assert.equal(byId(findings, 'PROJ_DEP_DRIFT'), undefined);
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

test('dependencyFamily derives the PCF dependency set from manifest control types', () => {
  assert.equal(dependencyFamily([manifestModel('standard')]), 'standard');
  assert.equal(dependencyFamily([manifestModel('standard'), manifestModel('virtual')]), 'virtual');
  assert.equal(dependencyFamily([]), 'standard');
  assert.equal(dependencyFamily(null), 'standard');
});

test('checkProject is clean for a matrix-aligned scaffold state', () => {
  assert.deepEqual(checkProject(standardState(), MATRIX, { hosts: ['model'], needs: ['build'] }), []);
});

test('collectProject reports unsafe pcfconfig outDir through resolveOutRoot without touching outside paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-doctor-unsafe-'));
  try {
    const controlDir = path.join(dir, 'Star');
    fs.mkdirSync(controlDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Star.pcfproj'), renderedPcfproj());
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(standardState().packageJson));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'pcfconfig.json'), JSON.stringify({ outDir: '..' }));
    fs.writeFileSync(path.join(controlDir, 'ControlManifest.Input.xml'), '<?xml version="1.0"?><manifest><control namespace="Contoso.Controls" constructor="Star" version="1.0.0" display-name-key="Star" description-key="Star"><resources><code path="index.ts" /></resources></control></manifest>');

    const state = collectProject(dir);
    const findings = checkProject(state, MATRIX, { hosts: ['model'], needs: ['build'] });

    assert.equal(byId(findings, 'PROJ_OUT_UNSAFE').severity, 'error');
    assert.match(byId(findings, 'PROJ_OUT_UNSAFE').fix, /pcfconfig\.json/);
    assert.match(byId(findings, 'PROJ_OUT_UNSAFE').fix, /out\/controls/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('required doctor finding ids have the expected severity and a concrete fix', () => {
  const toolFindings = checkToolchain({
    node: '18.0.0',
    npm: null,
    pac: null,
    dotnet: null,
    platform: 'win32',
  }, MATRIX, { needs: ['push'] });
  toolFindings.push(...checkToolchain({
    node: '22.13.1',
    npm: '10.9.9',
    pac: '1.36.0',
    dotnet: '1.0.0',
    platform: 'win32',
  }, MATRIX, { needs: ['push'] }));
  toolFindings.push(...checkToolchain({
    node: '22.13.1',
    npm: '10.9.9',
    pac: '0.1.0-dev',
    dotnet: '8.0.100',
    platform: 'win32',
  }, MATRIX, { needs: ['push'] }));

  const deps = dependencySet(MATRIX, 'standard');
  const projectFindings = checkProject(standardState({
    projectPath: 'C:\\Users\\maker\\OneDrive - Contoso\\' + 'a'.repeat(190),
    packageJson: {
      dependencies: { ...deps.dependencies },
      devDependencies: { ...deps.devDependencies, 'pcf-scripts': '^0.0.1' },
    },
    hasLockfile: false,
    hasNodeModules: false,
    pcfprojText: renderedPcfproj()
      .replace('<PcfBuildMode>production</PcfBuildMode>', '<PcfBuildMode>development</PcfBuildMode>')
      .replace(/Microsoft\.PowerApps\.MSBuild\.Pcf" Version="[^"]+"/, 'Microsoft.PowerApps.MSBuild.Pcf" Version="1.*"'),
    eslintFiles: ['.eslintrc.json'],
    manifestModels: [manifestModel('virtual', [{ name: 'Fluent', version: '9.68.0' }])],
    outStray: ['out\\controls\\Star\\debug.map'],
    outUnsafe: 'pcfconfig.json outDir must resolve inside the project',
  }), MATRIX, { hosts: ['model', 'pages'], needs: ['build'], platform: 'win32' });

  const all = [...toolFindings, ...projectFindings];
  const expected = new Map([
    ['TOOL_NODE_OLD', 'error'],
    ['TOOL_NPM_MISSING', 'error'],
    ['TOOL_PAC_MISSING', 'error'],
    ['TOOL_PAC_OLD', 'error'],
    ['TOOL_PAC_DEV_BUILD', 'warning'],
    ['TOOL_DOTNET_MISSING', 'error'],
    ['TOOL_DOTNET_OLD', 'error'],
    ['PROJ_NO_LOCKFILE', 'warning'],
    ['PROJ_NODE_MODULES_MISSING', 'error'],
    ['PROJ_DEP_DRIFT', 'warning'],
    ['PROJ_FLOATING_RANGE', 'warning'],
    ['PROJ_ESLINT_LEGACY', 'warning'],
    ['PROJ_BUILDMODE_NOT_PRODUCTION', 'warning'],
    ['PROJ_MSBUILD_PCF_FLOATING', 'warning'],
    ['PROJ_PLATFORM_LIB', 'error'],
    ['PROJ_HOST_CONFLICT', 'error'],
    ['PROJ_OUT_STALE', 'warning'],
    ['PROJ_OUT_UNSAFE', 'error'],
    ['PROJ_PATH_ONEDRIVE', 'warning'],
    ['PROJ_PATH_LONG', 'warning'],
  ]);

  for (const [id, severity] of expected) {
    const item = byId(all, id);
    assert.ok(item, `${id} should be produced by coverage fixtures`);
    assert.equal(item.severity, severity, id);
    assert.match(item.fix, /\S/, `${id} fix should be non-empty`);
    assert.match(item.fix, /(?:npm|Install|[Uu]pdate|Run|Edit|Move|Target|Delete|Remove|Use|Manual|pcf-upgrade|pcfconfig)/, `${id} fix should be concrete`);
  }
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
