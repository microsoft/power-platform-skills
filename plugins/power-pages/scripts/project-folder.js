#!/usr/bin/env node

// Runs the two commands a design review needs inside a user's project folder, taking the
// folder from a JSON request on stdin so its path never becomes shell text:
//
//   node project-folder.js --input - <<'REQUEST'
//   {"action": "status", "projectRoot": "C:\\Sites\\Contoso & Co"}
//   REQUEST
//
// - "status" prints {"git": true, "entries": [...]} with the lines of
//   `git status --porcelain --ignored`, or {"git": false} for a folder outside Git.
// - "dev" runs the project's `npm run dev` in the foreground until it is stopped, passing its
//   output through, so the caller starts it as a background command and reads the local URL
//   from the output. It refuses a folder without a `dev` script or without node_modules,
//   because installing dependencies is the user's call.
//
// Both run with an argv array and shell: false. npm runs through Node and npm's JavaScript
// entry point rather than the `npm` / `npm.cmd` shim, which needs a shell on Windows.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { resolveNpmCli } = require('./lib/playwright-mcp-package');
const { isString, parseRequest } = require('./lib/review-navigation');

const REQUEST_FIELDS = { action: (v) => v === 'status' || v === 'dev', projectRoot: isString };
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

function readRequest(text) {
  const { request, error } = parseRequest(text, REQUEST_FIELDS);
  if (error) return { error };
  if (!request.action || !request.projectRoot) return { error: 'The request needs "action" ("status" or "dev") and "projectRoot".' };
  const projectRoot = path.resolve(request.projectRoot);
  let stat;
  try {
    stat = fs.statSync(projectRoot);
  } catch {
    return { error: `Project folder not found: ${projectRoot}` };
  }
  if (!stat.isDirectory()) return { error: `Not a folder: ${projectRoot}` };
  return { action: request.action, projectRoot };
}

// `git status --porcelain` lines look like "?? src/new.css" or "!! node_modules/"; they are
// returned as-is so two snapshots can be compared line by line.
function folderStatus(projectRoot, { spawnSyncFn = spawnSync } = {}) {
  const result = spawnSyncFn('git', ['status', '--porcelain', '--ignored'], { cwd: projectRoot, encoding: 'utf8', shell: false });
  if (!result || result.status !== 0) return { git: false };
  return { git: true, entries: result.stdout.split(/\r?\n/).filter(Boolean) };
}

function devScriptProblem(projectRoot) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch {
    return 'The folder has no readable package.json.';
  }
  if (!manifest.scripts || !manifest.scripts.dev) return 'package.json has no "dev" script.';
  if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) return 'Dependencies are not installed (no node_modules); run npm install first.';
  return null;
}

function startDevServer(projectRoot, { spawnFn = spawn, resolveNpmCliFn = resolveNpmCli, processRef = process } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(process.execPath, [resolveNpmCliFn(), 'run', 'dev'], { cwd: projectRoot, stdio: 'inherit', shell: false });
    // The caller stops this background command with a signal; pass it on so the dev server
    // and its watchers exit with it instead of holding the port.
    const forward = (signal) => child.kill(signal);
    for (const signal of FORWARDED_SIGNALS) processRef.on(signal, forward);
    child.on('error', (error) => {
      processRef.stderr.write(`Could not start the dev server: ${error.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      for (const s of FORWARDED_SIGNALS) processRef.off(s, forward);
      resolve(code === null ? (signal ? 0 : 1) : code);
    });
  });
}

async function main(argv = process.argv.slice(2), {
  readStdin = () => fs.readFileSync(0, 'utf8'),
  write = (s) => process.stdout.write(s),
  writeError = (s) => process.stderr.write(s),
  spawnSyncFn,
  startDevServerFn = startDevServer,
} = {}) {
  if (argv[0] !== '--input' || argv[1] !== '-') {
    writeError('Usage: node project-folder.js --input -   (JSON request on stdin: {"action": "status" | "dev", "projectRoot": "<path>"})\n');
    return 1;
  }
  const request = readRequest(readStdin());
  if (request.error) {
    writeError(`${request.error}\n`);
    return 1;
  }
  if (request.action === 'status') {
    write(`${JSON.stringify(folderStatus(request.projectRoot, { spawnSyncFn }))}\n`);
    return 0;
  }
  const problem = devScriptProblem(request.projectRoot);
  if (problem) {
    writeError(`${problem}\n`);
    return 1;
  }
  return startDevServerFn(request.projectRoot);
}

module.exports = { devScriptProblem, folderStatus, main, readRequest, startDevServer };

if (require.main === module) {
  main().then((code) => process.exit(code));
}
