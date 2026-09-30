'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnResultSync: defaultSpawnResultSync } = require('./process-runner.js');
const { loadMatrix, dependencySet, compareVersions, platformLibraryFindings } = require('./pcf-matrix.js');
const { parseManifest } = require('./pcf-manifest.js');
const { findControlProject, resolveOutRoot, classifyOutputDirectory, isProcessedManifestOutput } = require('./pcf-build.js');

const FLOATING_DEP_PACKAGES = new Set(['pcf-scripts', 'pcf-start']);
const MSBUILD_PCF = 'Microsoft.PowerApps.MSBuild.Pcf';
const MSBUILD_REFERENCE = 'https://learn.microsoft.com/power-apps/developer/component-framework/code-components-best-practices#avoid-deploying-development-builds-to-dataverse';
const PLATFORM_REFERENCE = 'https://learn.microsoft.com/power-apps/developer/component-framework/react-controls-platform-libraries';

function finding(id, severity, message, fix) {
  return { id, severity, message, fix };
}

function hasErrors(findings) {
  return findings.some((item) => item.severity === 'error');
}

function normalizeVersionSpec(value) {
  return String(value || '').trim().replace(/^[~^=]\s*/, '');
}

function isFloatingRange(value) {
  return /(?:^[~^]|[*xX]|\blatest\b)/.test(String(value || '').trim());
}

function versionMinimum(entry) {
  if (entry && entry.historicalMinimum && entry.historicalMinimum.version) return entry.historicalMinimum.version;
  if (entry && entry.recommended && entry.recommended.version) return entry.recommended.version;
  return null;
}

function recommendedVersion(entry) {
  return entry && entry.recommended && entry.recommended.version ? entry.recommended.version : versionMinimum(entry);
}

function compareTool(version, minimum) {
  if (!version || !minimum) return 0;
  return compareVersions(version, minimum);
}

function checkToolchain(probes, matrix = loadMatrix(), options = {}) {
  const needs = new Set(options.needs || ['build']);
  const toolchain = matrix.toolchain || {};
  const findings = [];

  checkRequiredVersion(findings, 'node', normalizeRuntimeVersion(probes.node), toolchain.node, {
    oldId: 'TOOL_NODE_OLD',
    missingId: 'TOOL_NODE_MISSING',
    missingSeverity: 'error',
    oldSeverity: 'error',
    installName: 'Node.js',
  });

  checkRequiredVersion(findings, 'npm', normalizeRuntimeVersion(probes.npm), toolchain.npm, {
    oldId: 'TOOL_NPM_OLD',
    missingId: 'TOOL_NPM_MISSING',
    missingSeverity: 'error',
    oldSeverity: 'error',
    installName: 'npm',
  });

  const pacSeverity = needs.has('push') ? 'error' : 'info';
  if (!probes.pac) {
    findings.push(finding(
      'TOOL_PAC_MISSING',
      pacSeverity,
      'Power Platform CLI (pac) was not found, so push-time checks cannot be verified.',
      `Install or update pac to ${recommendedVersion(toolchain.pac)} before running pcf push.`,
    ));
  } else if (isDevelopmentPacVersion(probes.pac)) {
    findings.push(finding(
      'TOOL_PAC_DEV_BUILD',
      'warning',
      `pac reports development build '${probes.pac}', so the doctor cannot verify it against the minimum supported CLI version.`,
      `Use a released pac version ${recommendedVersion(toolchain.pac)} or newer before relying on push diagnostics.`,
    ));
  } else {
    checkRequiredVersion(findings, 'pac', normalizeRuntimeVersion(probes.pac), toolchain.pac, {
      oldId: 'TOOL_PAC_OLD',
      missingId: 'TOOL_PAC_MISSING',
      missingSeverity: pacSeverity,
      oldSeverity: pacSeverity,
      installName: 'Power Platform CLI (pac)',
    });
  }

  const dotnetSeverity = needs.has('push') ? 'error' : 'info';
  checkRequiredVersion(findings, 'dotnet', normalizeRuntimeVersion(probes.dotnet), toolchain.dotnet, {
    oldId: 'TOOL_DOTNET_OLD',
    missingId: 'TOOL_DOTNET_MISSING',
    missingSeverity: dotnetSeverity,
    oldSeverity: dotnetSeverity,
    installName: '.NET SDK',
  });

  return findings;
}

function checkRequiredVersion(findings, tool, actual, entry, labels) {
  const minimum = versionMinimum(entry);
  const recommended = recommendedVersion(entry);
  if (!actual) {
    findings.push(finding(
      labels.missingId,
      labels.missingSeverity,
      `${labels.installName} was not found.`,
      `Install ${labels.installName} ${recommended || minimum || 'from the compatibility matrix'} or newer, then retry.`,
    ));
    return;
  }

  if (minimum && compareTool(actual, minimum) < 0) {
    findings.push(finding(
      labels.oldId,
      labels.oldSeverity,
      `${labels.installName} ${actual} is below the PCF compatibility minimum ${minimum}.`,
      `Update ${tool} to the recommended version ${recommended || minimum} or newer.`,
    ));
  }
}

function isDevelopmentPacVersion(version) {
  return /(?:^0\.|[-+](?:dev|alpha|beta|preview|prerelease))/i.test(String(version || ''));
}

function normalizeRuntimeVersion(value) {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(value || '').trim());
  return match ? match[1] : null;
}

function checkProject(state, matrix = loadMatrix(), options = {}) {
  const hosts = options.hosts || ['model'];
  const needs = new Set(options.needs || ['build']);
  const platform = options.platform || state.platform || process.platform;
  const findings = [];
  const family = dependencyFamily(state.manifestModels);

  if (!state.hasLockfile) {
    findings.push(finding(
      'PROJ_NO_LOCKFILE',
      'warning',
      'The PCF project has no package-lock.json, so dependency restores can drift from the compatibility matrix.',
      'Run npm install once from the PCF project and commit package-lock.json.',
    ));
  }

  if (!state.hasNodeModules && (needs.has('build') || needs.has('push'))) {
    findings.push(finding(
      'PROJ_NODE_MODULES_MISSING',
      'error',
      'node_modules is missing, so PCF build and lint commands cannot run.',
      'Run npm ci in the PCF project before building.',
    ));
  }

  findings.push(...dependencyFindings(state, matrix, family));
  findings.push(...eslintFindings(state));
  findings.push(...pcfprojFindings(state, matrix));
  findings.push(...platformFindings(state, matrix, hosts));
  findings.push(...hostFindings(state, hosts));
  findings.push(...outFindings(state));
  findings.push(...pathFindings(state.projectPath, platform));
  return findings;
}

function dependencyFamily(manifestModels) {
  return (manifestModels || []).some((model) => model && model.control && model.control.controlType === 'virtual')
    ? 'virtual'
    : 'standard';
}

function dependencyFindings(state, matrix, family) {
  const findings = [];
  const expected = dependencySet(matrix, family);
  // package.json dependency specs arrive as ordinary npm ranges, for example:
  //   devDependencies: { pcf-scripts: "^<matrix version>", pcf-start: "<matrix version>" }
  // Unknown app dependencies are intentionally ignored: the doctor owns drift against the PCF
  // matrix, not the user's component runtime choices. For matrix packages, a leading ^/~/= is
  // normalized for drift comparison while still producing PROJ_FLOATING_RANGE for PCF tool packages
  // because those tools alter generated output between restores.
  const declared = {
    ...((state.packageJson && state.packageJson.dependencies) || {}),
    ...((state.packageJson && state.packageJson.devDependencies) || {}),
  };
  const expectedAll = {
    ...(expected.dependencies || {}),
    ...(expected.devDependencies || {}),
  };

  for (const name of Object.keys(expectedAll).sort()) {
    if (!Object.hasOwn(declared, name)) continue;
    const actualSpec = String(declared[name]);
    if (FLOATING_DEP_PACKAGES.has(name) && isFloatingRange(actualSpec)) {
      findings.push(finding(
        'PROJ_FLOATING_RANGE',
        'warning',
        `${name} uses floating range '${actualSpec}', so PCF tooling can drift between restores.`,
        'Run pcf-upgrade.js --apply --steps DEPS_TO_MATRIX to pin PCF tooling to the compatibility matrix.',
      ));
    }
    if (normalizeVersionSpec(actualSpec) !== normalizeVersionSpec(expectedAll[name])) {
      findings.push(finding(
        'PROJ_DEP_DRIFT',
        'warning',
        `${name} is declared as '${actualSpec}' but the ${family} compatibility matrix pins '${expectedAll[name]}'.`,
        'Run pcf-upgrade.js --apply --steps DEPS_TO_MATRIX to align package.json and package-lock.json.',
      ));
    }
  }

  return findings;
}

function eslintFindings(state) {
  const files = state.eslintFiles || [];
  const hasLegacy = files.some((file) => /^\.eslintrc(?:\..+)?$/i.test(path.basename(file)));
  const hasFlat = files.some((file) => path.basename(file) === 'eslint.config.mjs');
  if (!hasLegacy || hasFlat) return [];
  return [finding(
    'PROJ_ESLINT_LEGACY',
    'warning',
    'The project still uses legacy .eslintrc configuration and has no eslint.config.mjs flat config.',
    'Manual this release: add eslint.config.mjs following the generated template, then remove legacy .eslintrc after verifying lint.',
  )];
}

function pcfprojFindings(state, matrix) {
  const findings = [];
  if (!state.pcfprojText) return findings;
  const mode = pcfprojBuildMode(state.pcfprojText);
  if (mode.status !== 'production') {
    const detail = buildModeFindingMessage(mode);
    findings.push(finding(
      'PROJ_BUILDMODE_NOT_PRODUCTION',
      'warning',
      detail,
      `Run pcf-upgrade.js --apply --steps BUILDMODE_PRODUCTION, or edit the .pcfproj so <PcfBuildMode>production</PcfBuildMode> appears after Microsoft.Common.props. See ${MSBUILD_REFERENCE}`,
    ));
  }

  const msbuild = msbuildPcfReference(state.pcfprojText);
  if (msbuild && isFloatingRange(msbuild.version)) {
    findings.push(finding(
      'PROJ_MSBUILD_PCF_FLOATING',
      'warning',
      `${MSBUILD_PCF} uses floating version '${msbuild.version}'.`,
      `Edit the .pcfproj PackageReference to Version="${matrix.toolchain.msbuildPcf.version}".`,
    ));
  } else if (msbuild && normalizeVersionSpec(msbuild.version) !== matrix.toolchain.msbuildPcf.version) {
    findings.push(finding(
      'PROJ_DEP_DRIFT',
      'warning',
      `${MSBUILD_PCF} is '${msbuild.version}' but the compatibility matrix pins '${matrix.toolchain.msbuildPcf.version}'.`,
      `Edit the .pcfproj PackageReference to Version="${matrix.toolchain.msbuildPcf.version}".`,
    ));
  }
  return findings;
}

function buildModeFindingMessage(mode) {
  if (mode.status === 'ineffective' && mode.reason === 'conditioned') {
    return 'PcfBuildMode is set but ineffective — make it unconditional because pac pcf push builds Debug and this doctor does not evaluate MSBuild Condition attributes.';
  }
  if (mode.status === 'ineffective') {
    return 'PcfBuildMode is set but ineffective — move it below the Microsoft.Common.props import.';
  }
  return `PcfBuildMode is ${mode.status === 'missing' ? 'missing' : `'${mode.value}'`}, so Debug builds can produce development bundles.`;
}

/**
 * Detects whether `PcfBuildMode` is effective in a `.pcfproj`.
 *
 * Raw project shapes this detector must distinguish:
 *   <Import Project="$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props" />
 *   <PropertyGroup>
 *     <Name>StarRating</Name>
 *     <PcfBuildMode>production</PcfBuildMode>
 *   </PropertyGroup>
 *   <!-- <PcfBuildMode>production</PcfBuildMode> -->                 (ignored)
 *   <PropertyGroup Condition="'$(Configuration)'=='Release'">        (conditioned)
 *     <PcfBuildMode>production</PcfBuildMode>
 *   </PropertyGroup>
 *   <PcfBuildMode Condition="'$(Configuration)'=='Release'">production</PcfBuildMode>
 *   <PropertyGroup Condition='"$(Configuration)" == "Release"'>      (single-quoted attr)
 *
 * WHY the offset matters: Microsoft.PowerApps.MSBuild.Pcf 1.52.1 imports props through
 * Microsoft.Common.props and unconditionally sets Debug|AnyCPU to development. A local Debug build
 * measured the template as development when the property was in the first PropertyGroup, and as
 * production only when the property appeared after the Microsoft.Common.props import. `pac pcf push`
 * builds Debug, so "present" is not enough. Conditioned values are also not trusted: evaluating
 * arbitrary MSBuild Condition expressions would require running MSBuild, and a Release-only
 * production setting does not help the Debug build used by `pac pcf push`.
 */
function pcfprojBuildMode(pcfprojText) {
  const text = stripXmlCommentsPreserveOffsets(String(pcfprojText || ''));
  const occurrences = pcfBuildModeOccurrences(text);
  const importMatch = /<Import\b[^>]*\bProject\s*=\s*["'][^"']*Microsoft\.Common\.props["'][^>]*>/i.exec(text);
  const importOffset = importMatch ? importMatch.index : -1;
  const importEndOffset = importMatch ? importMatch.index + importMatch[0].length : -1;
  if (occurrences.length === 0) {
    return {
      status: 'missing',
      importOffset,
      importEndOffset,
      modeOffset: -1,
      occurrences,
    };
  }
  const afterImport = occurrences.filter((item) => importOffset === -1 || item.offset > importOffset);
  const unconditionedAfter = afterImport.filter((item) => !item.conditioned);
  const effective = unconditionedAfter[unconditionedAfter.length - 1];
  if (effective) {
    const conditionedAfterEffective = afterImport.filter((item) => item.conditioned && item.offset > effective.offset);
    if (conditionedAfterEffective.length > 0) {
      const lastConditioned = conditionedAfterEffective[conditionedAfterEffective.length - 1];
      return {
        status: 'ineffective',
        reason: 'conditioned',
        value: lastConditioned.value,
        effectiveValue: effective.value,
        modeOffset: lastConditioned.offset,
        importOffset,
        importEndOffset,
        occurrences,
      };
    }
    if (/^production$/i.test(effective.value)) {
      return { status: 'production', value: effective.value, modeOffset: effective.offset, importOffset, importEndOffset, occurrences };
    }
    return { status: 'development', value: effective.value, modeOffset: effective.offset, importOffset, importEndOffset, occurrences };
  }

  const conditionedAfter = afterImport.filter((item) => item.conditioned);
  if (conditionedAfter.length > 0) {
    const lastConditioned = conditionedAfter[conditionedAfter.length - 1];
    return {
      status: 'ineffective',
      reason: 'conditioned',
      value: lastConditioned.value,
      modeOffset: lastConditioned.offset,
      importOffset,
      importEndOffset,
      occurrences,
    };
  }

  const lastBefore = occurrences[occurrences.length - 1];
  if (lastBefore && importOffset !== -1 && lastBefore.offset < importOffset) {
    return {
      status: 'ineffective',
      reason: 'before-import',
      value: lastBefore.value,
      modeOffset: lastBefore.offset,
      importOffset,
      importEndOffset,
      occurrences,
    };
  }
  return { status: 'missing', importOffset, importEndOffset, modeOffset: -1, occurrences };
}

function pcfBuildModeOccurrences(text) {
  const occurrences = [];
  const modeRe = /<PcfBuildMode\b([^>]*)>([\s\S]*?)<\/PcfBuildMode>/gi;
  for (const match of text.matchAll(modeRe)) {
    const tagAttrs = xmlAttrs(match[1] || '');
    const ancestors = xmlAncestors(text, match.index);
    occurrences.push({
      value: match[2].trim(),
      offset: match.index,
      endOffset: match.index + match[0].length,
      conditioned: Object.hasOwn(tagAttrs, 'Condition') || ancestors.some((ancestor) => Object.hasOwn(ancestor.attrs, 'Condition') || ['Choose', 'When', 'Otherwise', 'Target'].includes(ancestor.name)),
    });
  }
  return occurrences;
}

function xmlAncestors(text, offset) {
  const stack = [];
  const tagRe = /<\s*(\/?)([A-Za-z_][-A-Za-z0-9_:.]*)([^>]*)>/g;
  let match;
  while ((match = tagRe.exec(text)) && match.index < offset) {
    if (match[0].startsWith('<?') || match[0].startsWith('<!')) continue;
    const closing = !!match[1];
    const name = match[2];
    const selfClosing = /\/\s*>$/.test(match[0]);
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) {
          stack.splice(i);
          break;
        }
      }
    } else if (!selfClosing) {
      stack.push({ name, attrs: xmlAttrs(match[3] || '') });
    }
  }
  return stack;
}

function msbuildPcfReference(pcfprojText) {
  const text = stripXmlCommentsPreserveOffsets(String(pcfprojText || ''));
  // The SDK-style project keeps NuGet references as self-closing XML tags, for example:
  //   <PackageReference Include="Microsoft.PowerApps.MSBuild.Pcf" Version="1.52.1" />
  //   <PackageReference Include='Microsoft.PowerApps.MSBuild.Pcf' Version='1.*' />
  // or as a paired element with a child version:
  //   <PackageReference Include="Microsoft.PowerApps.MSBuild.Pcf">
  //     <Version>1.52.1</Version>
  //   </PackageReference>
  // XML comments are stripped before matching so disabled examples do not become findings.
  // Attribute order is not part of the XML contract, so read all attributes from each tag before
  // checking Include/Update and Version.
  const pairRe = /<PackageReference\b([^>]*)>([\s\S]*?)<\/PackageReference>/gi;
  for (const match of text.matchAll(pairRe)) {
    const attrs = xmlAttrs(match[1] || '');
    if (attrs.Include === MSBUILD_PCF || attrs.Update === MSBUILD_PCF) {
      const childVersion = /<Version\b[^>]*>\s*([^<]+?)\s*<\/Version>/i.exec(match[2]);
      return { version: attrs.Version || (childVersion ? childVersion[1].trim() : ''), tag: match[0] };
    }
  }
  for (const match of text.matchAll(/<PackageReference\b([^>]*)\/>/gi)) {
    const attrs = xmlAttrs(match[1] || '');
    if (attrs.Include === MSBUILD_PCF || attrs.Update === MSBUILD_PCF) {
      return { version: attrs.Version || '', tag: match[0] };
    }
  }
  return null;
}

function xmlAttrs(tag) {
  const attrs = {};
  // MSBuild project XML commonly uses both quote styles:
  //   <PropertyGroup Condition="'$(Configuration)' == 'Release'">
  //   <PropertyGroup Condition='"$(Configuration)" == "Release"'>
  //   <PackageReference Include='Microsoft.PowerApps.MSBuild.Pcf' Version='1.*' />
  // Match the opening quote and read until the same quote so the other quote character can appear
  // inside the value. This is intentionally a tag-fragment parser; full XML parsing would lose the
  // source offsets `pcfprojBuildMode` exports for Tasks 10 and 13.
  for (const match of String(tag || '').matchAll(/\s([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    attrs[match[1]] = match[3];
  }
  return attrs;
}

function stripXmlCommentsPreserveOffsets(text) {
  return String(text || '').replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, ' '));
}

function platformFindings(state, matrix, hosts) {
  const findings = [];
  for (const model of state.manifestModels || []) {
    // Platform libraries are a model-driven app feature; Power Pages documents PCF support without
    // platform-library declarations, so the shared matrix helper supplies the version and host
    // policy findings from Learn evidence.
    // See: https://learn.microsoft.com/power-apps/developer/component-framework/react-controls-platform-libraries
    // See: https://learn.microsoft.com/power-pages/configure/component-framework
    for (const item of platformLibraryFindings(matrix, ((model.resources || {}).platformLibraries || []), hosts)) {
      findings.push(finding(
        'PROJ_PLATFORM_LIB',
        item.severity,
        item.message,
        platformFix(item),
      ));
    }
  }
  return findings;
}

function platformFix(item) {
  if (/Power Pages/.test(item.message)) return `Remove platform-library declarations for Power Pages targets. See ${PLATFORM_REFERENCE}`;
  return `Run pcf-upgrade.js --apply --steps PLATFORM_LIB_VERSION to align platform-library declarations${item.fix ? ` (${item.fix})` : ''}.`;
}

function hostFindings(state, hosts) {
  if (!hosts.includes('pages') || dependencyFamily(state.manifestModels) !== 'virtual') return [];
  // Power Pages PCF support is documented for standard controls and does not support the
  // model-driven platform-library path required by virtual React controls.
  // See: https://learn.microsoft.com/power-pages/configure/component-framework
  return [finding(
    'PROJ_HOST_CONFLICT',
    'error',
    'Virtual PCF controls target model-driven apps; Power Pages supports standard controls and does not support platform-library declarations.',
    'Target hosts=model for this control, or create a standard PCF control for Power Pages.',
  )];
}

function outFindings(state) {
  const findings = [];
  if (state.outUnsafe) {
    findings.push(finding(
      'PROJ_OUT_UNSAFE',
      'error',
      state.outUnsafe,
      "Edit pcfconfig.json so outDir is a strict child directory such as 'out/controls'.",
    ));
  }
  if ((state.outStray || []).length) {
    findings.push(finding(
      'PROJ_OUT_STALE',
      'warning',
      `The existing PCF output contains files not declared by the manifest: ${state.outStray.join(', ')}.`,
      'Delete the out directory or rebuild with a clean production PCF build before packaging.',
    ));
  }
  return findings;
}

function pathFindings(projectPath, platform = process.platform) {
  const findings = [];
  const text = String(projectPath || '');
  if (/\\OneDrive(?:\s+-\s+[^\\]+)?\\/i.test(text) || /\/OneDrive(?:\s+-\s+[^/]+)?\//i.test(text)) {
    findings.push(finding(
      'PROJ_PATH_ONEDRIVE',
      'warning',
      'The project is under OneDrive, which can lock generated PCF files while npm and MSBuild are writing them.',
      'Move the PCF project to a local development folder outside OneDrive before building.',
    ));
  }
  if (platform === 'win32' && text.length > 180) {
    findings.push(finding(
      'PROJ_PATH_LONG',
      'warning',
      `The project path is ${text.length} characters; PCF restore and MSBuild paths can exceed Windows path limits.`,
      'Move the PCF project closer to the drive root, for example C:\\src\\pcf-control.',
    ));
  }
  return findings;
}

function collectProject(projectDir, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const findProject = deps.findControlProject || findControlProject;
  const found = findProject(projectDir, deps);
  if (found.error) throw new Error(found.error);
  const packageJson = JSON.parse(fsDep.readFileSync(found.packageJson, 'utf8'));
  const projectPath = found.projectDir;
  const manifestModels = found.manifests.map((file) => parseManifest(fsDep.readFileSync(file, 'utf8')).model);
  const eslintFiles = safeReaddir(fsDep, projectPath)
    .filter((entry) => entry.isFile() && (/^\.eslintrc(?:\..+)?$/i.test(entry.name) || entry.name === 'eslint.config.mjs'))
    .map((entry) => entry.name);
  const state = {
    projectPath,
    packageJson,
    hasLockfile: fileExists(fsDep, pathDep.join(projectPath, 'package-lock.json')),
    hasNodeModules: dirExists(fsDep, pathDep.join(projectPath, 'node_modules')),
    pcfprojText: fsDep.readFileSync(found.pcfproj, 'utf8'),
    eslintFiles,
    manifestModels,
    outStray: [],
  };

  try {
    const outRoot = resolveOutRoot(projectPath, deps);
    state.outStray = outputStrays(outRoot, deps);
  } catch (err) {
    state.outUnsafe = String(err && err.message ? err.message : err);
  }
  return state;
}

function outputStrays(outRoot, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const strays = [];
  for (const entry of safeReaddir(fsDep, outRoot)) {
    if (!entry.isDirectory()) continue;
    const controlDir = pathDep.join(outRoot, entry.name);
    const manifest = pathDep.join(controlDir, 'ControlManifest.xml');
    if (!fileExists(fsDep, manifest)) continue;
    const parsed = parseManifest(fsDep.readFileSync(manifest, 'utf8'));
    for (const item of classifyOutputDirectory(controlDir, parsed.model.resources, deps)) {
      if (isProcessedManifestOutput(item.path)) continue;
      if (item.classification === 'unexplained') strays.push(pathDep.join(controlDir, item.path));
    }
  }
  return strays;
}

function safeReaddir(fsDep, dir) {
  try {
    return fsDep.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

function fileExists(fsDep, file) {
  try {
    return fsDep.existsSync(file) && fsDep.statSync(file).isFile();
  } catch {
    return false;
  }
}

function dirExists(fsDep, dir) {
  try {
    return fsDep.existsSync(dir) && fsDep.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function collectToolchain(options = {}, deps = {}) {
  const runNpm = deps.runNpm;
  const runPac = deps.runPac;
  const spawnResultSync = deps.spawnResultSync || defaultSpawnResultSync;
  const npm = runNpm(['--version'], { npmCli: options.npmCli });
  const pac = runPac(['help']);
  const dotnet = spawnResultSync('dotnet', ['--version'], { encoding: 'utf8' });
  return {
    node: process.version,
    npm: npm && npm.status === 0 ? normalizeRuntimeVersion(npm.stdout) : null,
    pac: pac && pac.status === 0 ? parsePacHelpVersion(pac.stdout) : null,
    dotnet: dotnet && dotnet.status === 0 ? normalizeRuntimeVersion(dotnet.stdout) : null,
    platform: process.platform,
  };
}

function parsePacHelpVersion(text) {
  // `pac help` emits a banner before usage text, for example:
  //   Microsoft PowerPlatform CLI
  //   Version: 1.51.1+gabcdef
  //   Usage: pac [admin] [application] ...
  // Keep an optional prerelease suffix so local development builds such as `0.1.0-dev` can be
  // reported as TOOL_PAC_DEV_BUILD instead of compared to released CLI baselines.
  const match = /^\s*Version:\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/im.exec(String(text || ''));
  return match ? match[1] : null;
}

module.exports = {
  checkToolchain,
  checkProject,
  collectProject,
  collectToolchain,
  dependencyFamily,
  pcfprojBuildMode,
  parsePacHelpVersion,
  hasErrors,
};
