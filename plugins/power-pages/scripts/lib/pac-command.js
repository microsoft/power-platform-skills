'use strict';

const { execFileSync } = require('child_process');

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
      stdout = deps.runCommand(command, args, options);
    } else if ((deps.platform || process.platform) === 'win32') {
      // PAC ships as an executable on Windows, so invoke it directly. Routing
      // paths through cmd.exe would give shell metacharacters another parsing pass.
      stdout = execFileSync('pac.exe', args, options);
    } else {
      stdout = execFileSync('pac', args, options);
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

module.exports = { commandError, runPac };
