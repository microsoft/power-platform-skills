#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { commandError, runPac } = require('./lib/pac-command');
const { readWebsiteYml } = require('./lib/detect-project-context');

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLONED_IDENTITY_PATH = path.join('.powerpages-site', 'website.yml');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sourcePath') args.sourcePath = argv[++i];
    else if (argv[i] === '--outputDirectory') args.outputDirectory = argv[++i];
    else if (argv[i] === '--siteName') args.siteName = argv[++i];
  }
  return args;
}

function findCodeSiteRoot(outputDirectory, fsImpl = fs) {
  const queue = [{ dir: outputDirectory, depth: 0 }];
  const matches = [];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (fsImpl.existsSync(path.join(dir, 'powerpages.config.json'))) matches.push(dir);
    if (depth >= 3) continue;
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one cloned code-site root under ${outputDirectory}, found ${matches.length}`);
  }
  return matches[0];
}

function inspectClonedSiteIdentity(clonedPath, deps = {}) {
  const readWebsite = deps.readWebsiteYml || readWebsiteYml;
  const websiteMetadataPath = path.join(clonedPath, '.powerpages-site', 'website.yml');
  const website = readWebsite(websiteMetadataPath);
  if (!website || !GUID_PATTERN.test(website.id || '')) {
    throw new Error(`Cloned site metadata is missing a valid id in ${websiteMetadataPath}`);
  }
  return {
    siteName: website.name || null,
    websiteRecordId: website.id,
  };
}

function copyMissingTemplateFiles(sourcePath, clonedPath, fsImpl = fs) {
  const restoredFiles = [];
  const queue = [''];
  while (queue.length > 0) {
    const relativeDir = queue.shift();
    const sourceDir = path.join(sourcePath, relativeDir);
    for (const entry of fsImpl.readdirSync(sourceDir, { withFileTypes: true })) {
      const relativePath = path.join(relativeDir, entry.name);
      if (relativePath === CLONED_IDENTITY_PATH) continue;
      const sourceEntryPath = path.join(sourcePath, relativePath);
      const clonedEntryPath = path.join(clonedPath, relativePath);
      const sourceStat = fsImpl.lstatSync(sourceEntryPath);
      if (sourceStat.isSymbolicLink()) {
        throw new Error(`Template source contains a symbolic link: ${relativePath}`);
      }

      if (sourceStat.isDirectory()) {
        if (fsImpl.existsSync(clonedEntryPath)) {
          const clonedStat = fsImpl.lstatSync(clonedEntryPath);
          if (clonedStat.isSymbolicLink() || !clonedStat.isDirectory()) {
            throw new Error(`Clone path conflicts with template directory: ${relativePath}`);
          }
        } else {
          fsImpl.mkdirSync(clonedEntryPath, { recursive: true });
        }
        queue.push(relativePath);
        continue;
      }

      if (!sourceStat.isFile()) {
        throw new Error(`Template source contains an unsupported entry: ${relativePath}`);
      }
      if (fsImpl.existsSync(clonedEntryPath)) {
        const clonedStat = fsImpl.lstatSync(clonedEntryPath);
        if (clonedStat.isSymbolicLink() || !clonedStat.isFile()) {
          throw new Error(`Clone path conflicts with template file: ${relativePath}`);
        }
        continue;
      }
      fsImpl.copyFileSync(sourceEntryPath, clonedEntryPath);
      restoredFiles.push(relativePath);
    }
  }
  return restoredFiles;
}

function runNpm(args, cwd, deps = {}) {
  const isWindows = (deps.platform || process.platform) === 'win32';
  // npm is installed as npm.cmd on Windows, and Node cannot execute .cmd files
  // directly with execFile. Route the fixed argument array through cmd.exe while
  // keeping shell:false so no user-controlled command string is reparsed.
  // See: https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
  const command = isWindows ? 'cmd.exe' : 'npm';
  const commandArgs = isWindows ? ['/d', '/s', '/c', 'npm.cmd', ...args] : args;
  const options = {
    cwd,
    encoding: 'utf8',
    timeout: deps.timeoutMs || 900000,
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  };
  try {
    const stdout = (deps.runNpmCommand || execFileSync)(command, commandArgs, options);
    return { status: 0, stdout: String(stdout || ''), stderr: '' };
  } catch (err) {
    return {
      status: Number.isInteger(err.status) ? err.status : 1,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
      error: err,
    };
  }
}

function inspectCompiledOutput(clonedPath, fsImpl = fs) {
  const configPath = path.join(clonedPath, 'powerpages.config.json');
  let config;
  try {
    config = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read compiledPath from ${configPath}: ${err.message}`);
  }
  // Power Pages code sites declare build output as, for example, { "compiledPath": "dist" }.
  // Keep inspection inside the cloned project so a malformed template cannot make this
  // pre-upload check accept source files or follow an output directory outside the clone.
  const compiledPath = String(config.compiledPath || '').trim();
  if (!compiledPath || path.isAbsolute(compiledPath) || compiledPath.split(/[\\/]+/).includes('..')) {
    throw new Error(`powerpages.config.json has an invalid compiledPath: ${compiledPath || '<empty>'}`);
  }
  const outputPath = path.resolve(clonedPath, compiledPath);
  const resolvedClonedPath = path.resolve(clonedPath);
  if (outputPath === resolvedClonedPath) {
    throw new Error(`powerpages.config.json has an invalid compiledPath: ${compiledPath}`);
  }

  const clonedStat = fsImpl.lstatSync(resolvedClonedPath);
  if (clonedStat.isSymbolicLink() || !clonedStat.isDirectory()) {
    throw new Error(`Cloned project path is not a regular directory: ${resolvedClonedPath}`);
  }
  const canonicalClonedPath = fsImpl.realpathSync(resolvedClonedPath);
  let currentPath = resolvedClonedPath;
  for (const segment of compiledPath.split(/[\\/]+/)) {
    currentPath = path.join(currentPath, segment);
    if (!fsImpl.existsSync(currentPath)) {
      throw new Error(`Build output path is not a regular directory: ${outputPath}`);
    }
    const currentStat = fsImpl.lstatSync(currentPath);
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new Error(`Build output path must contain only real directories: ${currentPath}`);
    }
  }
  const canonicalOutputPath = fsImpl.realpathSync(outputPath);
  if (!pathContains(canonicalClonedPath, canonicalOutputPath)) {
    throw new Error(`Build output path resolves outside the cloned project: ${outputPath}`);
  }

  const queue = [outputPath];
  let containsFile = false;
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fsImpl.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Build output must not contain symbolic links: ${entryPath}`);
      }
      if (entry.isFile()) {
        containsFile = true;
      } else if (entry.isDirectory()) {
        queue.push(entryPath);
      } else {
        throw new Error(`Build output contains an unsupported entry: ${entryPath}`);
      }
    }
  }
  if (containsFile) return { compiledPath, outputPath };
  throw new Error(`Build output directory is empty: ${outputPath}`);
}

function canonicalPathForCreation(targetPath, fsImpl = fs) {
  let current = path.resolve(targetPath);
  const missingSegments = [];
  while (!fsImpl.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
  const canonicalParent = fsImpl.realpathSync(current);
  return path.join(canonicalParent, ...missingSegments);
}

function pathContains(parentPath, childPath, platform = process.platform) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const parent = normalize(parentPath);
  const child = normalize(childPath);
  return child === parent || child.startsWith(parent + path.sep);
}

function validateSeparateProjectPaths(sourcePath, outputDirectory, deps = {}) {
  const fsImpl = deps.fs || fs;
  const platform = deps.platform || process.platform;
  try {
    const sourceStat = fsImpl.lstatSync(sourcePath);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      return 'sourcePath must be a regular directory';
    }
    const canonicalSource = fsImpl.realpathSync(sourcePath);
    const canonicalOutput = canonicalPathForCreation(outputDirectory, fsImpl);
    if (
      pathContains(canonicalSource, canonicalOutput, platform) ||
      pathContains(canonicalOutput, canonicalSource, platform)
    ) {
      return 'outputDirectory must be separate from sourcePath';
    }
  } catch (err) {
    return `Could not validate sourcePath and outputDirectory: ${err.message}`;
  }
  return null;
}

function removeScriptCreatedOutputDirectory(outputDirectory, existedBeforeRun, fsImpl = fs) {
  if (existedBeforeRun || !fsImpl.existsSync(outputDirectory)) return false;
  try {
    // PAC may have written partial content before failing. Remove only a root
    // this invocation created, and refuse if another process replaced it with
    // a symlink or non-directory entry.
    const outputStat = fsImpl.lstatSync(outputDirectory);
    if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) return false;
    fsImpl.rmSync(outputDirectory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function provisionTemplateSite(options, deps = {}) {
  const fsImpl = deps.fs || fs;
  const sourcePath = path.resolve(options.sourcePath || '');
  const outputDirectory = path.resolve(options.outputDirectory || '');
  const siteName = String(options.siteName || '').trim();
  const sourceNpmConfigPath = path.join(sourcePath, '.npmrc');
  if (!options.sourcePath || !options.outputDirectory || !siteName) {
    return { ok: false, step: 'validation', error: 'sourcePath, outputDirectory, and siteName are required' };
  }
  if (!fsImpl.existsSync(path.join(sourcePath, 'powerpages.config.json')) ||
      !fsImpl.existsSync(path.join(sourcePath, 'package.json')) ||
      !fsImpl.existsSync(sourceNpmConfigPath) ||
      !fsImpl.existsSync(path.join(sourcePath, '.powerpages-site'))) {
    return { ok: false, step: 'validation', error: 'sourcePath is not a downloaded Power Pages code site' };
  }
  let sourceNpmConfigStat;
  try {
    sourceNpmConfigStat = fsImpl.lstatSync(sourceNpmConfigPath);
  } catch (err) {
    return { ok: false, step: 'validation', error: `Could not inspect sourcePath .npmrc: ${err.message}` };
  }
  if (sourceNpmConfigStat.isSymbolicLink() || !sourceNpmConfigStat.isFile()) {
    return { ok: false, step: 'validation', error: 'sourcePath .npmrc must be a regular file' };
  }
  const separationError = validateSeparateProjectPaths(sourcePath, outputDirectory, deps);
  if (separationError) return { ok: false, step: 'validation', error: separationError };
  const outputDirectoryExisted = fsImpl.existsSync(outputDirectory);
  if (outputDirectoryExisted) {
    let outputStat;
    try {
      outputStat = fsImpl.lstatSync(outputDirectory);
    } catch (err) {
      return { ok: false, step: 'validation', error: `Could not inspect outputDirectory: ${err.message}` };
    }
    if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
      return { ok: false, step: 'validation', error: 'outputDirectory must be a regular directory when it exists' };
    }
    try {
      if (fsImpl.readdirSync(outputDirectory).length > 0) {
        return { ok: false, step: 'validation', error: 'outputDirectory must be empty' };
      }
    } catch (err) {
      return { ok: false, step: 'validation', error: `Could not read outputDirectory: ${err.message}` };
    }
  }
  fsImpl.mkdirSync(outputDirectory, { recursive: true });

  let pacWorkingDirectory;
  try {
    // `pac pages clone --overwrite` can replace the selected output directory.
    // When that directory is also the wrapper's inherited CWD, later PAC calls
    // can fail because the process still holds a stale directory handle. Run
    // every PAC command from the canonical parent, which clone never replaces.
    pacWorkingDirectory = fsImpl.realpathSync(path.dirname(outputDirectory));
  } catch (err) {
    return { ok: false, step: 'validation', error: `Could not resolve a stable PAC working directory: ${err.message}` };
  }
  const pacCommandOptions = { cwd: pacWorkingDirectory };
  const pac = deps.runPac || ((args, commandOptions = {}) => runPac(args, { ...deps, ...commandOptions }));
  const cloneResult = pac([
    'pages', 'clone',
    '--path', sourcePath,
    '--outputDirectory', outputDirectory,
    '--name', siteName,
    '--overwrite',
  ], pacCommandOptions);
  if (cloneResult.status !== 0) {
    return {
      ok: false,
      step: 'clone',
      outputDirectoryRemoved: removeScriptCreatedOutputDirectory(outputDirectory, outputDirectoryExisted, fsImpl),
      error: commandError('pac pages clone', cloneResult),
    };
  }

  let clonedPath;
  try {
    clonedPath = findCodeSiteRoot(outputDirectory, fsImpl);
  } catch (err) {
    return {
      ok: false,
      step: 'clone-output',
      outputDirectoryRemoved: removeScriptCreatedOutputDirectory(outputDirectory, outputDirectoryExisted, fsImpl),
      error: err.message,
    };
  }

  let clonedIdentity;
  try {
    clonedIdentity = inspectClonedSiteIdentity(clonedPath, deps);
  } catch (err) {
    return { ok: false, step: 'clone-output', clonedPath, error: err.message };
  }
  try {
    // `pac pages clone` reconstructs a known code-site file set and can omit
    // valid project extras such as .npmrc, tests, and imported JSON contracts.
    // Restore only missing source files so the clone's new website identity and
    // any files rewritten by PAC remain authoritative.
    copyMissingTemplateFiles(sourcePath, clonedPath, fsImpl);
  } catch (err) {
    return {
      ok: false,
      step: 'clone-output',
      clonedPath,
      ...clonedIdentity,
      error: `Could not restore template project files: ${err.message}`,
    };
  }

  const npm = deps.runNpm || ((args, cwd) => runNpm(args, cwd, deps));
  const installArgs = [
    fsImpl.existsSync(path.join(clonedPath, 'package-lock.json')) ? 'ci' : 'install',
    '--no-audit',
    '--no-fund',
  ];
  const installResult = npm(installArgs, clonedPath);
  if (installResult.status !== 0) {
    return {
      ok: false,
      step: 'install',
      clonedPath,
      ...clonedIdentity,
      error: commandError(`npm ${installArgs[0]}`, installResult),
    };
  }

  const buildResult = npm(['run', 'build'], clonedPath);
  if (buildResult.status !== 0) {
    return {
      ok: false,
      step: 'build',
      clonedPath,
      ...clonedIdentity,
      error: commandError('npm run build', buildResult),
    };
  }

  let compiledOutput;
  try {
    compiledOutput = inspectCompiledOutput(clonedPath, fsImpl);
  } catch (err) {
    return {
      ok: false,
      step: 'build-output',
      clonedPath,
      ...clonedIdentity,
      error: err.message,
    };
  }

  const uploadResult = pac([
    'pages', 'upload-code-site',
    '--rootPath', clonedPath,
    '--siteName', siteName,
  ], pacCommandOptions);
  if (uploadResult.status !== 0) {
    return {
      ok: false,
      step: 'upload',
      clonedPath,
      ...clonedIdentity,
      error: commandError('pac pages upload-code-site', uploadResult),
    };
  }
  return {
    ok: true,
    clonedPath,
    siteName: clonedIdentity.siteName || siteName,
    websiteRecordId: clonedIdentity.websiteRecordId,
    compiledPath: compiledOutput.compiledPath,
  };
}

function main() {
  const result = provisionTemplateSite(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  commandError,
  copyMissingTemplateFiles,
  findCodeSiteRoot,
  inspectCompiledOutput,
  inspectClonedSiteIdentity,
  parseArgs,
  pathContains,
  provisionTemplateSite,
  removeScriptCreatedOutputDirectory,
  runNpm,
  runPac,
  validateSeparateProjectPaths,
};
