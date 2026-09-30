'use strict';
// PCF tools are launched as `process.execPath <bin.js>` instead of `npm run`/`npx`: PowerShell can
// drop the `--` separator before native commands, turning `npm run build -- --buildMode production`
// into `pcf-scripts build production` (`[pcf-1041] Not a valid sub-command 'production'`). The
// package `.cmd` shims have the same Windows shell dependency as pac.cmd, so resolving the JS entry
// point lets callers stay shell-free and keep argv boundaries exact.
const { spawnSync: defaultSpawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function fileExists(fsDep, filePath) {
  try {
    return fsDep.existsSync(filePath);
  } catch {
    return false;
  }
}

function resolvePackageBin(projectDir, pkgName, binName, deps = { fs, path }) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const pkgDir = pathDep.join(projectDir, 'node_modules', ...String(pkgName).split('/'));
  const pkgJson = pathDep.join(pkgDir, 'package.json');
  if (!fileExists(fsDep, pkgJson)) return null;
  let pkg;
  try {
    pkg = JSON.parse(fsDep.readFileSync(pkgJson, 'utf8'));
  } catch {
    return null;
  }
  let rel;
  if (typeof pkg.bin === 'string') {
    rel = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    const defaultBin = binName || String(pkgName).split('/').pop();
    rel = pkg.bin[defaultBin];
  }
  if (typeof rel !== 'string' || !rel) return null;
  const binPath = pathDep.resolve(pkgDir, rel);
  return fileExists(fsDep, binPath) ? binPath : null;
}

function resolveNpmCli(deps = { env: process.env, execPath: process.execPath, platform: process.platform, fs }) {
  const env = deps.env || process.env;
  const execPath = deps.execPath || process.execPath;
  const platform = deps.platform || process.platform;
  const fsDep = deps.fs || fs;
  const fromEnv = env.npm_execpath;
  // npm_execpath is set by npm itself and can point at alternate package managers, so require the
  // canonical npm CLI filename before trusting it as the JS entrypoint we can execute with node.
  if (fromEnv && String(fromEnv).endsWith('npm-cli.js') && fileExists(fsDep, fromEnv)) {
    return { cliPath: fromEnv };
  }
  // Node installers place npm next to node differently by platform: the Windows distribution carries
  // node_modules under the node.exe directory, while POSIX layouts put npm under ../lib/node_modules.
  // Try only those deterministic layouts so a missing npm is explicit and can be fixed with --npm-cli.
  const nodeDir = path.dirname(execPath);
  const candidate = platform === 'win32'
    ? path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fileExists(fsDep, candidate)) return { cliPath: candidate };
  return { error: `npm not found next to node (${execPath}). Pass --npm-cli <path to npm-cli.js>.` };
}

function normalizeSpawnResult(r) {
  return {
    status: r.status == null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    ...(r.error ? { error: r.error } : {}),
  };
}

function runNodeScript(scriptPath, args, opts = {}) {
  const run = opts.spawnSync || defaultSpawnSync;
  const r = run(process.execPath, [scriptPath, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
    shell: false,
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return normalizeSpawnResult(r);
}

function runNpm(args, opts = {}) {
  const cliPath = opts.npmCli || (resolveNpmCli({ env: opts.env || process.env, execPath: process.execPath, platform: process.platform, fs }).cliPath);
  if (!cliPath) {
    const resolved = resolveNpmCli({ env: opts.env || process.env, execPath: process.execPath, platform: process.platform, fs });
    return { status: 1, stdout: '', stderr: resolved.error || 'npm not found', error: resolved.error || 'npm not found' };
  }
  return runNodeScript(cliPath, args, opts);
}

module.exports = { resolvePackageBin, resolveNpmCli, runNodeScript, runNpm };
