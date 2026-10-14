'use strict';
// Shared PCF PAC adapter. `process-runner.js` owns executable resolution, shell:false, and the
// Windows `pac.cmd` cmd.exe wrapper/argument checks; this file keeps the PCF result shape stable.
const processRunner = require('./process-runner.js');

const cleanPacArgs = (args) => args.map((a) => String(a).replace(/\r\n|[\r\n]/g, ' '));

function runnerDeps(opts = {}) {
  const deps = {};
  if (opts.platform) deps.platform = opts.platform;
  if (opts.env) deps.env = opts.env;
  if (opts.exists) deps.exists = opts.exists;
  if (opts.readFile) deps.readFile = opts.readFile;
  return deps;
}

function buildPacInvocation(args, opts = {}) {
  const invoke = opts.invocation || processRunner.invocation;
  return invoke('pac', cleanPacArgs(args), runnerDeps(opts));
}

function runPac(args, opts = {}) {
  const run = opts.spawnResultSync || processRunner.spawnResultSync;
  const options = { encoding: 'utf8' };
  if (opts.cwd) options.cwd = opts.cwd;
  if (opts.env) options.env = opts.env;
  if (opts.timeoutMs) options.timeout = opts.timeoutMs;
  const r = run('pac', cleanPacArgs(args), options, runnerDeps(opts));
  const errorMessage = r && r.error ? String(r.error.message || r.error) : '';
  return {
    status: r.status == null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || errorMessage,
    error: r.error,
    signal: r.signal,
  };
}

module.exports = { buildPacInvocation, runPac };
