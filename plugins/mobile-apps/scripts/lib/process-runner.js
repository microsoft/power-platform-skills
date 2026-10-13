'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Windows argument escaping is adapted from cross-spawn's MIT-licensed
// lib/util/escape.js. Keep the notice with these bundled functions.
//
// Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeArgument(value, doubleEscape) {
  let result = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  result = result.replace(/(?=(\\+?)?)\1$/, '$1$1');
  result = `"${result}"`.replace(CMD_META, '^$1');
  return doubleEscape ? result.replace(CMD_META, '^$1') : result;
}

class CliLaunchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CliLaunchError';
    this.code = code;
  }
}

function envValue(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).filter((entry) => entry.toUpperCase() === name.toUpperCase()).sort()[0];
  return key === undefined ? undefined : env[key];
}

function isRunnable(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return false;
    throw error;
  }
}

function resolveExecutable(command, {
  platform = process.platform, env = process.env,
  exists = (file) => isRunnable(file, platform),
} = {}) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  if (typeof command !== 'string' || !command || /[\u0000-\u001f\u007f]/.test(command)) {
    throw new TypeError('CLI command must be an executable name or absolute path.');
  }
  if (paths.isAbsolute(command)) return exists(command) ? command : null;
  if (/[\\/]/.test(command) || !/^[\w.-]+$/.test(command)) {
    throw new TypeError('Relative executable paths and shell command strings are not supported.');
  }
  const directories = String(envValue(env, 'PATH', platform) || '')
    .split(windows ? ';' : ':')
    .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter((directory) => directory && paths.isAbsolute(directory));
  const extensions = windows
    ? String(envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD')
      .split(';').map((extension) => extension.toLowerCase())
      .filter((extension) => /^\.(?:com|exe|bat|cmd)$/.test(extension))
    : [''];
  const explicitExtension = windows && /\.(?:com|exe|bat|cmd)$/i.test(command);
  for (const directory of directories) {
    for (const extension of explicitExtension ? [''] : extensions) {
      const candidate = paths.join(directory, command + extension);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function cliInvocation(command, args, dependencies = {}) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new TypeError('CLI arguments must be strings without NUL characters.');
  }
  const { platform = process.platform, env = process.env } = dependencies;
  const file = resolveExecutable(command, { ...dependencies, platform, env });
  if (!file) {
    throw new CliLaunchError(
      `CLI ${command} was not found on PATH. Install it or correct PATH, then restart the terminal or agent host.`,
      'CLI_NOT_FOUND',
    );
  }
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) {
    return { file, args, env, windowsVerbatimArguments: false };
  }
  if (args.some((argument) => /[\u0000-\u001f\u007f]/.test(argument))) {
    throw new CliLaunchError('Windows batch arguments cannot contain control characters.', 'CLI_UNSAFE_ARGUMENT');
  }
  if (args.some((argument) => argument.includes('!'))) {
    const readFile = dependencies.readFile || ((filename) => fs.readFileSync(filename, 'utf8'));
    if (/enabledelayedexpansion/i.test(readFile(file))) {
      throw new CliLaunchError(
        'This batch launcher enables delayed expansion and cannot preserve literal exclamation marks.',
        'CLI_UNSAFE_ARGUMENT',
      );
    }
  }
  const comspec = envValue(env, 'ComSpec', platform) || '';
  const systemRoot = envValue(env, 'SystemRoot', platform) || envValue(env, 'windir', platform) || '';
  const interpreter = path.win32.isAbsolute(comspec) && /(?:^|[\\/])cmd\.exe$/i.test(comspec)
    ? comspec
    : path.win32.isAbsolute(systemRoot) ? path.win32.join(systemRoot, 'System32', 'cmd.exe') : null;
  if (!interpreter) throw new CliLaunchError('Windows cmd.exe could not be resolved to an absolute path.', 'CLI_LAUNCH_FAILED');

  // Batch shims need cmd.exe, not shell:true (which concatenates unescaped argv).
  // npm .bin shims parse forwarded arguments again; cross-spawn escapes that extra layer.
  // /d disables AutoRun, /v:off disables inherited delayed expansion, and absolute
  // executable paths avoid Windows' implicit current-directory command lookup.
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const escapedCommand = path.win32.normalize(file).replace(CMD_META, '^$1');
  const line = [escapedCommand, ...args.map((argument) => escapeArgument(argument, doubleEscape))].join(' ');
  return {
    file: interpreter,
    args: ['/d', '/s', '/v:off', '/c', `"${line}"`],
    env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' },
    windowsVerbatimArguments: true,
  };
}

function runCliSync(command, args, options = {}, dependencies = {}) {
  try {
    const invocation = cliInvocation(command, args, {
      ...dependencies, env: options.env || dependencies.env || process.env,
    });
    return (dependencies.execFileSync || execFileSync)(invocation.file, invocation.args, {
      ...options,
      env: invocation.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch (error) {
    if (error instanceof CliLaunchError || error instanceof TypeError ||
        (Number.isInteger(error.status) && error.status > 0)) throw error;
    const code = /^[A-Z_]+$/.test(error.code || '') ? ` (${error.code})` : '';
    throw new CliLaunchError(
      `CLI could not be started or completed${code}. Check its installation and executable access; signing in again does not repair a launcher failure.`,
      'CLI_LAUNCH_FAILED',
    );
  }
}

module.exports = { CliLaunchError, cliInvocation, resolveExecutable, runCliSync };
