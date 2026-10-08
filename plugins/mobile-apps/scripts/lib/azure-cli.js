'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

class AzureCliLaunchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AzureCliLaunchError';
    this.code = code;
  }
}

function envValue(env, name, platform) {
  if (platform !== 'win32') return env[name];
  // Match Node's choice when a Windows environment contains both PATH and Path.
  const key = Object.keys(env).filter((entry) => entry.toUpperCase() === name).sort()[0];
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

function resolveAzureCli({
  platform = process.platform,
  env = process.env,
  exists = (file) => isRunnable(file, platform),
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  realpath = (file) => fs.realpathSync(file),
} = {}) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const directories = String(envValue(env, 'PATH', platform) || '')
    .split(windows ? ';' : ':')
    .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter((directory) => directory && paths.isAbsolute(directory));
  const extensions = windows ? ['.com', '.exe', '.cmd', '.bat'] : [''];
  let launcher;
  for (const directory of directories) {
    launcher = extensions.map((extension) => paths.join(directory, `az${extension}`)).find(exists);
    if (launcher) break;
  }
  if (!launcher) {
    throw new AzureCliLaunchError(
      'Azure CLI was not found on PATH. Install Azure CLI or correct PATH, then restart the terminal or agent host.',
      'AZURE_CLI_NOT_FOUND',
    );
  }
  if (!windows || !/\.(?:cmd|bat)$/i.test(launcher)) {
    return { file: launcher, prefix: [], env };
  }

  // MSI/ZIP az.cmd starts its adjacent Python with -IBm azure.cli. Use that same
  // runtime without cmd.exe: percent-encoded Graph URLs and shell metacharacters
  // must stay argv data, not batch syntax. Plugins install independently, so this
  // Azure-specific adapter is local rather than importing another plugin's runner.
  // https://github.com/Azure/azure-cli/blob/dev/build_scripts/windows/scripts/az_msi.cmd
  // https://github.com/Azure/azure-cli/blob/dev/build_scripts/windows/scripts/az_zip.cmd
  const resolvedLauncher = realpath(launcher);
  const source = readFile(resolvedLauncher);
  const runtime = source.match(/^\s*"%~dp0[\\/]?((?:\.\.[\\/])?python\.exe)"\s+-(?:IB)?m\s+azure\.cli\s+%\*\s*$/im);
  if (!runtime) {
    throw new AzureCliLaunchError(
      'Azure CLI uses an unsupported Windows batch launcher. Install the official Azure CLI MSI or ZIP distribution and restart the terminal or agent host.',
      'AZURE_CLI_UNSUPPORTED_LAUNCHER',
    );
  }
  const python = paths.resolve(paths.dirname(resolvedLauncher), runtime[1]);
  if (!exists(python)) {
    throw new AzureCliLaunchError(
      'Azure CLI was found, but its Windows Python runtime is missing. Repair the Azure CLI installation and restart the terminal or agent host.',
      'AZURE_CLI_RUNTIME_MISSING',
    );
  }
  const installer = source.match(/^\s*SET\s+AZ_INSTALLER=(MSI|ZIP|PIP)\s*$/im)?.[1].toUpperCase();
  return {
    file: python,
    prefix: ['-IBm', 'azure.cli'],
    env: installer ? { ...env, AZ_INSTALLER: installer } : env,
  };
}

function runAzureCli(args, options = {}, dependencies = {}) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new TypeError('Azure CLI arguments must be strings without NUL characters.');
  }
  try {
    const invocation = resolveAzureCli({ ...dependencies, env: options.env || dependencies.env || process.env });
    return (dependencies.execFileSync || execFileSync)(invocation.file, [...invocation.prefix, ...args], {
      ...options,
      env: invocation.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
    });
  } catch (error) {
    if (error instanceof AzureCliLaunchError || (Number.isInteger(error.status) && error.status > 0)) throw error;
    const code = /^[A-Z_]+$/.test(error.code || '') ? ` (${error.code})` : '';
    // Do not expose argv, stdout, or token-bearing stderr in launcher diagnostics.
    throw new AzureCliLaunchError(
      `Azure CLI could not be started or completed${code}. Check its installation and executable access; signing in again does not repair a launcher failure.`,
      'AZURE_CLI_LAUNCH_FAILED',
    );
  }
}

module.exports = { AzureCliLaunchError, resolveAzureCli, runAzureCli };
