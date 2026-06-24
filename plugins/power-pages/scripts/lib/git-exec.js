#!/usr/bin/env node

// Thin, testable wrapper around the system `git` CLI for clone-based Power
// Pages conflict resolution helpers.
//
// SECURITY NOTE:
//   When an Azure DevOps bearer token is supplied, it is injected only for the
//   current git invocation with:
//     git -c "http.extraHeader=AUTHORIZATION: bearer <token>" ...
//   This module never writes credentials to .git/config, never embeds them in
//   remote URLs, never configures credential helpers, and never logs tokens.
//   stdout/stderr returned to callers and git-spawn error text are scrubbed via
//   scrubToken(text, token), replacing the token value with "***".
//
// Error contract:
//   runGit returns { ok, code, stdout, stderr } for both successful and failed
//   git executions. Programming errors (for example non-array args) throw
//   scrubbed Error objects. Callers decide how to surface failed git results.
//
// Usage:
//   const { runGit, clone, status } = require('./git-exec');
//   const r = runGit({ cwd, args: ['status', '--porcelain'] });
//   const c = clone({ cwd, repoUrl, dir, token });

'use strict';

const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 25;

const TRANSIENT_RE = /\b(connection|time(?:d)?\s*out|timeout|could not resolve host|failed to connect|connection reset|network is unreachable|http\s+(408|429|500|502|503|504)|tls|ssl)\b|fatal:\s+unable to access/i;
const AUTH_RE = /\b(401|403)\b|authentication failed|authorization failed|access denied|not authorized|auth failed/i;

function scrubToken(text, token) {
  if (text === undefined || text === null) return '';
  const value = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  if (!token) return value;
  return value.split(String(token)).join('***');
}

function scrubbedError(message, token) {
  return new Error(scrubToken(message, token));
}

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function normalizeArgs(args, token) {
  if (!Array.isArray(args)) throw scrubbedError('runGit: args must be an array', token);
  return args.map((arg) => String(arg));
}

function buildGitArgs(args, token) {
  const normalized = normalizeArgs(args, token);
  // Always enable long-path support so deep Power Pages export paths (e.g.
  // solutions/<S>/entities/.../formxml/card/<guid>) check out on Windows
  // (MAX_PATH 260). Harmless elsewhere. Per-invocation, so it covers clone AND
  // every op in the cloned repo without mutating the user's global git config.
  const base = ['-c', 'core.longpaths=true'];
  if (!token) return [...base, ...normalized];
  return [...base, '-c', `http.extraHeader=AUTHORIZATION: bearer ${token}`, ...normalized];
}

function toText(value) {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function isAuthFailure(result) {
  return AUTH_RE.test(`${result.stderr || ''}\n${result.stdout || ''}`);
}

function isTransientFailure(result) {
  if (!result || result.ok || isAuthFailure(result)) return false;
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  return result.code === null || TRANSIENT_RE.test(text);
}

/**
 * Run `git` with optional per-invocation ADO bearer-token config.
 *
 * @param {object} opts
 * @param {string} [opts.cwd] Working directory for git.
 * @param {string[]} opts.args Git arguments, excluding the `git` executable.
 * @param {string} [opts.token] ADO bearer token; scrubbed from all returned text.
 * @param {object} [opts.env] Extra environment variables for this process only.
 * @param {number} [opts.timeoutMs] Per-attempt timeout. Default 30000.
 * @param {number} [opts.retries] Transient retry count after first attempt. Default 2.
 * @param {Function} [opts.spawnImpl] DI seam for tests; defaults to child_process.spawnSync.
 * @param {Function} [opts.sleepImpl] DI seam for tests; defaults to short sync sleep.
 * @returns {{ ok: boolean, code: (number|null), stdout: string, stderr: string }}
 */
function runGit({
  cwd = process.cwd(),
  args,
  token = null,
  env = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  spawnImpl = spawnSync,
  sleepImpl = sleepSync,
} = {}) {
  if (typeof spawnImpl !== 'function') throw scrubbedError('runGit: spawnImpl must be a function', token);

  const gitArgs = buildGitArgs(args, token);
  const attempts = Math.max(0, Number.isFinite(Number(retries)) ? Number(retries) : DEFAULT_RETRIES);
  const timeout = Math.max(1, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS);
  let lastResult = null;

  for (let attempt = 0; attempt <= attempts; attempt++) {
    let raw;
    try {
      raw = spawnImpl('git', gitArgs, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        encoding: 'utf8',
        windowsHide: true,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const message = e && e.message ? e.message : 'git spawn failed';
      raw = { status: null, stdout: '', stderr: message };
    }

    const code = typeof raw.status === 'number' ? raw.status : null;
    const stderr = scrubToken(toText(raw.stderr) || (raw.error && raw.error.message) || '', token);
    const stdout = scrubToken(toText(raw.stdout), token);
    lastResult = { ok: code === 0, code, stdout, stderr };

    if (lastResult.ok || !isTransientFailure(lastResult) || attempt === attempts) return lastResult;
    sleepImpl(DEFAULT_BACKOFF_MS * Math.pow(2, attempt));
  }

  return lastResult;
}

function callRunGit(opts, args) {
  return runGit({ ...opts, args });
}

function clone({ repoUrl, dir = null, branch = null, ...opts } = {}) {
  const args = ['clone'];
  if (branch) args.push('--branch', branch);
  args.push(repoUrl);
  if (dir) args.push(dir);
  return callRunGit(opts, args);
}

function fetch({ remote = 'origin', refspec = null, ...opts } = {}) {
  const args = ['fetch', remote];
  if (Array.isArray(refspec)) args.push(...refspec);
  else if (refspec) args.push(refspec);
  return callRunGit(opts, args);
}

function checkout({ ref = null, newBranch = null, startPoint = null, ...opts } = {}) {
  const args = ['checkout'];
  if (newBranch) {
    args.push('-b', newBranch);
    if (startPoint) args.push(startPoint);
  } else {
    args.push(ref);
  }
  return callRunGit(opts, args);
}

function merge({ ref, ...opts } = {}) {
  return callRunGit(opts, ['merge', ref]);
}

function mergeAbort(opts = {}) {
  return callRunGit(opts, ['merge', '--abort']);
}

function push({ remote = 'origin', refspec = null, ...opts } = {}) {
  const args = ['push', remote];
  if (refspec) args.push(refspec);
  return callRunGit(opts, args);
}

function status(opts = {}) {
  return callRunGit(opts, ['status', '--porcelain']);
}

function revParse({ rev = 'HEAD', ...opts } = {}) {
  return callRunGit(opts, ['rev-parse', rev]);
}

function lsRemote({ remote, refs = [], ...opts } = {}) {
  const args = ['ls-remote', remote];
  if (Array.isArray(refs)) args.push(...refs);
  else if (refs) args.push(refs);
  return callRunGit(opts, args);
}

function add({ paths = ['--all'], ...opts } = {}) {
  const args = ['add'];
  if (Array.isArray(paths)) args.push(...paths);
  else args.push(paths);
  return callRunGit(opts, args);
}

function addAll(opts = {}) {
  return add({ ...opts, paths: ['--all'] });
}

function commit({ message, ...opts } = {}) {
  return callRunGit(opts, ['commit', '-m', message]);
}

module.exports = {
  runGit,
  scrubToken,
  clone,
  fetch,
  checkout,
  merge,
  mergeAbort,
  push,
  status,
  revParse,
  lsRemote,
  add,
  addAll,
  commit,
};
