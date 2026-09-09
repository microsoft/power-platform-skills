#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { commandError, runPac } = require('./lib/pac-command');
const { readWebsiteYml } = require('./lib/detect-project-context');

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (outputPath === path.resolve(clonedPath)) {
    throw new Error(`powerpages.config.json has an invalid compiledPath: ${compiledPath}`);
  }
  if (
    !fsImpl.existsSync(outputPath) ||
    fsImpl.lstatSync(outputPath).isSymbolicLink() ||
    !fsImpl.statSync(outputPath).isDirectory()
  ) {
    throw new Error(`Build output path is not a regular directory: ${outputPath}`);
  }

  const queue = [outputPath];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fsImpl.readdirSync(current, { withFileTypes: true })) {
      if (entry.isFile()) return { compiledPath, outputPath };
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }
  throw new Error(`Build output directory is empty: ${outputPath}`);
}

function provisionTemplateSite(options, deps = {}) {
  const fsImpl = deps.fs || fs;
  const sourcePath = path.resolve(options.sourcePath || '');
  const outputDirectory = path.resolve(options.outputDirectory || '');
  const siteName = String(options.siteName || '').trim();
  if (!options.sourcePath || !options.outputDirectory || !siteName) {
    return { ok: false, step: 'validation', error: 'sourcePath, outputDirectory, and siteName are required' };
  }
  if (!fsImpl.existsSync(path.join(sourcePath, 'powerpages.config.json')) ||
      !fsImpl.existsSync(path.join(sourcePath, 'package.json')) ||
      !fsImpl.existsSync(path.join(sourcePath, '.npmrc')) ||
      !fsImpl.existsSync(path.join(sourcePath, '.powerpages-site'))) {
    return { ok: false, step: 'validation', error: 'sourcePath is not a downloaded Power Pages code site' };
  }
  if (
    sourcePath === outputDirectory ||
    outputDirectory.startsWith(`${sourcePath}${path.sep}`) ||
    sourcePath.startsWith(`${outputDirectory}${path.sep}`)
  ) {
    return { ok: false, step: 'validation', error: 'outputDirectory must be separate from sourcePath' };
  }
  if (fsImpl.existsSync(outputDirectory)) {
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

  const pac = deps.runPac || ((args) => runPac(args, deps));
  const cloneResult = pac([
    'pages', 'clone',
    '--path', sourcePath,
    '--outputDirectory', outputDirectory,
    '--name', siteName,
    '--overwrite',
  ]);
  if (cloneResult.status !== 0) {
    return { ok: false, step: 'clone', error: commandError('pac pages clone', cloneResult) };
  }

  let clonedPath;
  try {
    clonedPath = findCodeSiteRoot(outputDirectory, fsImpl);
  } catch (err) {
    return { ok: false, step: 'clone-output', error: err.message };
  }

  let clonedIdentity;
  try {
    clonedIdentity = inspectClonedSiteIdentity(clonedPath, deps);
  } catch (err) {
    return { ok: false, step: 'clone-output', clonedPath, error: err.message };
  }
  if (!fsImpl.existsSync(path.join(clonedPath, '.npmrc'))) {
    return {
      ok: false,
      step: 'clone-output',
      clonedPath,
      ...clonedIdentity,
      error: `Cloned site is missing ${path.join(clonedPath, '.npmrc')}`,
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
  ]);
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
  findCodeSiteRoot,
  inspectCompiledOutput,
  inspectClonedSiteIdentity,
  parseArgs,
  provisionTemplateSite,
  runNpm,
  runPac,
};
