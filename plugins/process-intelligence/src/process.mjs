// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import { BridgeError } from './errors.mjs';

const processError = (message, code = 'CLI_EXECUTION_FAILED') => new BridgeError(message, 3, code);

class ProcessOutput {
  constructor(code, stdout, stderr) {
    Object.assign(this, { code, stdout, stderr });
  }

  toString() {
    return `[process output redacted; exit ${this.code}]`;
  }

  toJSON() {
    return this.toString();
  }

  [inspect.custom]() {
    return this.toString();
  }
}

export function windowsUtility(name) {
  if (!['taskkill.exe', 'icacls.exe', 'whoami.exe', 'cmd.exe', 'powershell.exe'].includes(name)) {
    throw processError('Unsupported Windows utility.');
  }
  const root = process.env.SystemRoot;
  if (!root || !path.win32.isAbsolute(root)) {
    throw processError('Windows system directory is unavailable.');
  }
  if (name === 'powershell.exe') {
    return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', name);
  }
  return path.win32.join(root, 'System32', name);
}

async function terminate(child) {
  if (!child.pid) {
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw processError(
          'Could not terminate the owned process group.',
          'PROCESS_CLEANUP_FAILED'
        );
      }
    }
    return;
  }
  // taskkill targets only this owned PID and descendants; never a process name.
  await new Promise((resolve, reject) => {
    const killer = spawn(windowsUtility('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
    const timer = setTimeout(() => {
      killer.kill();
      reject(processError('Owned process cleanup timed out.', 'PROCESS_CLEANUP_FAILED'));
    }, 5000);
    killer.once('error', () => {
      clearTimeout(timer);
      reject(processError('Could not start owned process cleanup.', 'PROCESS_CLEANUP_FAILED'));
    });
    killer.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0 && child.exitCode === null && child.signalCode === null) {
        reject(
          processError('Could not terminate the owned process tree.', 'PROCESS_CLEANUP_FAILED')
        );
      } else {
        resolve();
      }
    });
  });
}

/** Safe argv invocation used by Azure CLI and narrowly scoped built-in OS utilities. */
export async function runProcess(
  executable,
  args,
  {
    signal,
    timeout = 45000,
    outputLimit = 262144,
    env = process.env,
    windowsVerbatimArguments = false
  } = {}
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });
    let stdout = [];
    let stderr = [];
    let outSize = 0;
    let errSize = 0;
    let failure;
    let cleanup;
    let settled = false;

    const stop = error => {
      if (failure) {
        return;
      }
      failure = error;
      cleanup = terminate(child)
        .catch(e => {
          failure = e;
        })
        .finally(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        });
    };

    const abort = () => stop(signal.reason);
    const timer = setTimeout(
      () =>
        stop(
          processError(
            'Azure CLI/process timed out. Run interactive sign-in directly in a normal terminal if needed.',
            'CLI_TIMEOUT'
          )
        ),
      timeout
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
    }

    const collect = (chunk, isError) => {
      if (failure) {
        return;
      }
      if (isError) {
        errSize += chunk.length;
      } else {
        outSize += chunk.length;
      }
      if ((isError ? errSize : outSize) > outputLimit) {
        stdout = [];
        stderr = [];
        stop(
          processError(
            'Process output exceeded the safe size limit; output was discarded.',
            'CLI_OUTPUT_LIMIT'
          )
        );
      } else {
        (isError ? stderr : stdout).push(chunk);
      }
    };

    child.stdout.on('data', chunk => collect(chunk, false));
    child.stderr.on('data', chunk => collect(chunk, true));
    child.stdout.on('error', () => stop(processError('Process output I/O failed.')));
    child.stderr.on('error', () => stop(processError('Process output I/O failed.')));

    const finish = async code => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await cleanup;
      if (failure) {
        reject(failure);
      } else {
        resolve(
          new ProcessOutput(
            code ?? 1,
            Buffer.concat(stdout).toString('utf8'),
            Buffer.concat(stderr).toString('utf8')
          )
        );
      }
    };

    child.once('error', () => {
      failure = processError(
        'Executable is missing or could not start; check installation and permissions.'
      );
      void finish(1);
    });
    child.once('close', code => {
      void finish(code);
    });
  });
}

export class AzureCliProcess {
  constructor(options = {}) {
    this.options = options;
  }

  async run(args, { signal, interactive = false } = {}) {
    signal?.throwIfAborted();
    if (
      !Array.isArray(args) ||
      !args.length ||
      args.some(a => typeof a !== 'string' || !/^[a-zA-Z0-9:/._+=-]+$/.test(a) || a.includes('\n'))
    ) {
      throw processError('Azure CLI invocation contains unsupported argument characters.');
    }
    let executable = this.options.executable;
    if (!executable) {
      for (const directory of (this.options.path ?? process.env.PATH ?? '').split(path.delimiter)) {
        const clean = directory.replace(/^"|"$/g, '');
        if (!path.isAbsolute(clean)) {
          continue;
        }
        for (const name of process.platform === 'win32' ? ['az.exe', 'az.cmd'] : ['az']) {
          const candidate = path.join(clean, name);
          try {
            await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
            executable = candidate;
            break;
          } catch (error) {
            if (!['ENOENT', 'EACCES'].includes(error.code)) {
              throw processError('Azure CLI PATH could not be inspected.');
            }
          }
        }
        if (executable) {
          break;
        }
      }
    }
    const missing = () =>
      processError(
        'Azure CLI executable is missing or could not start. Install Azure CLI 2.54+ and put az on PATH.',
        'AZ_CLI_NOT_FOUND'
      );
    if (!executable || !path.isAbsolute(executable)) {
      throw missing();
    }
    try {
      await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    } catch {
      throw missing();
    }
    let verbatim = false;
    if (process.platform === 'win32' && path.extname(executable).toLowerCase() === '.cmd') {
      if (/[%!"\r\n]/.test(executable)) {
        throw processError('Azure CLI launcher path contains unsafe expansion characters.');
      }
      const command = `""${executable}" ${args.map(a => `"${a}"`).join(' ')}"`;
      if (command.length > 7500) {
        throw processError(
          'Azure CLI claims/command exceeds the Windows launcher limit; no claims were omitted.'
        );
      }
      executable = windowsUtility('cmd.exe');
      args = ['/d', '/s', '/v:off', '/c', command];
      verbatim = true;
    }
    return runProcess(executable, args, {
      ...this.options,
      signal,
      timeout: this.options.timeout ?? (interactive ? 300000 : 45000),
      windowsVerbatimArguments: verbatim,
      env: { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_CORE_NO_COLOR: 'true' }
    });
  }
}
