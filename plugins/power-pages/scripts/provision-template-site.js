#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { commandError, runPac } = require('./lib/pac-command');

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
