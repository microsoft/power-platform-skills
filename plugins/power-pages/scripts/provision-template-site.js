#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

function runPac(args, deps = {}) {
  const options = {
    encoding: 'utf8',
    timeout: deps.timeoutMs || 900000,
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  };
  try {
    let stdout;
    if (deps.runCommand) {
      const command = (deps.platform || process.platform) === 'win32' ? 'pac.exe' : 'pac';
      const commandArgs = args;
      stdout = deps.runCommand(command, commandArgs, options);
    } else if ((deps.platform || process.platform) === 'win32') {
      // PAC ships as an executable on Windows, so invoke it directly. Routing user
      // paths and site names through `cmd.exe /c` would give shell metacharacters
      // another parsing pass even though Node's own `shell` option is disabled.
      stdout = execFileSync('pac.exe', args, {
        encoding: 'utf8',
        timeout: deps.timeoutMs || 900000,
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
      });
    } else {
      stdout = execFileSync('pac', args, {
        encoding: 'utf8',
        timeout: deps.timeoutMs || 900000,
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
      });
    }
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

function commandError(step, result) {
  if (result.error) return `${step} failed: ${result.error.message}`;
  const detail = String(result.stderr || result.stdout || '').trim();
  return `${step} failed${detail ? `: ${detail}` : ` with exit code ${result.status}`}`;
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
  if (fsImpl.existsSync(outputDirectory) && fsImpl.readdirSync(outputDirectory).length > 0) {
    return { ok: false, step: 'validation', error: 'outputDirectory must be empty' };
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

  const uploadResult = pac([
    'pages', 'upload-code-site',
    '--rootPath', clonedPath,
    '--siteName', siteName,
  ]);
  if (uploadResult.status !== 0) {
    return { ok: false, step: 'upload', clonedPath, error: commandError('pac pages upload-code-site', uploadResult) };
  }
  return { ok: true, clonedPath };
}

function main() {
  const result = provisionTemplateSite(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = { commandError, findCodeSiteRoot, parseArgs, provisionTemplateSite, runPac };
