'use strict';

const fs = require('node:fs');
const path = require('node:path');

function unquotePath(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

function findEnvironmentKey(env, name) {
  const normalized = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === normalized) || null;
}

function readEnvironmentValue(env, name) {
  const key = findEnvironmentKey(env, name);
  return key ? env[key] : undefined;
}

function setEnvironmentValue(env, name, value) {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  }
  env[name] = value;
}

function deleteEnvironmentValue(env, name) {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  }
}

function resolveOnWindowsPath(fileName, env, existsSync) {
  for (const entry of String(readEnvironmentValue(env, 'PATH') || '').split(';')) {
    const directory = unquotePath(entry);
    if (!directory) continue;
    const candidate = path.win32.join(directory, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveWindowsPython(value, env, existsSync) {
  const configured = unquotePath(value);
  if (!configured) return null;
  if (path.win32.isAbsolute(configured)) {
    return existsSync(configured) ? configured : null;
  }
  return resolveOnWindowsPath(configured, env, existsSync)
    || (
      path.win32.extname(configured)
        ? null
        : resolveOnWindowsPath(`${configured}.exe`, env, existsSync)
    );
}

function resolveWindowsGcloud(options = {}) {
  const env = options.env || process.env;
  const existsSync = options.existsSync || fs.existsSync;
  const nativeExecutable = resolveOnWindowsPath('gcloud.exe', env, existsSync);
  if (nativeExecutable) return { command: nativeExecutable, argsPrefix: [] };

  const commandScript = resolveOnWindowsPath('gcloud.cmd', env, existsSync);
  if (!commandScript) {
    throw new Error('gcloud.cmd was not found on PATH.');
  }

  const sdkRoot = path.win32.dirname(path.win32.dirname(commandScript));
  const gcloudPython = path.win32.join(sdkRoot, 'lib', 'gcloud.py');
  const configuredPython = resolveWindowsPython(
    readEnvironmentValue(env, 'CLOUDSDK_PYTHON'),
    env,
    existsSync,
  );
  const bundledPython = path.win32.join(
    sdkRoot,
    'platform',
    'bundledpython',
    'python.exe',
  );
  const pathPython = resolveOnWindowsPath('python.exe', env, existsSync)
    || resolveOnWindowsPath('python3.exe', env, existsSync);
  const python = configuredPython
    || (existsSync(bundledPython) ? bundledPython : null)
    || pathPython;

  if (!python || !existsSync(gcloudPython)) {
    throw new Error(
      'The Google Cloud CLI Python runtime or lib/gcloud.py was not found.',
    );
  }

  // Mirror the SDK launcher default without evaluating CLOUDSDK_PYTHON_ARGS.
  // A direct argv array avoids the command-string reparsing performed by
  // gcloud.cmd and therefore preserves IAM conditions and other metacharacters.
  const pythonArgs = readEnvironmentValue(env, 'CLOUDSDK_PYTHON_SITEPACKAGES')
    ? []
    : ['-S'];
  setEnvironmentValue(env, 'CLOUDSDK_ROOT_DIR', sdkRoot);
  setEnvironmentValue(env, 'CLOUDSDK_PYTHON', python);
  if (!readEnvironmentValue(env, 'CLOUDSDK_GSUTIL_PYTHON')) {
    setEnvironmentValue(env, 'CLOUDSDK_GSUTIL_PYTHON', python);
  }
  if (!readEnvironmentValue(env, 'CLOUDSDK_BQ_PYTHON')) {
    setEnvironmentValue(env, 'CLOUDSDK_BQ_PYTHON', python);
  }
  const encoding = readEnvironmentValue(env, 'CLOUDSDK_ENCODING') || 'UTF-8';
  setEnvironmentValue(env, 'CLOUDSDK_ENCODING', encoding);
  if (!readEnvironmentValue(env, 'PYTHONIOENCODING')) {
    setEnvironmentValue(env, 'PYTHONIOENCODING', encoding);
  }
  deleteEnvironmentValue(env, 'PYTHONHOME');
  return {
    command: python,
    argsPrefix: [...pythonArgs, gcloudPython],
  };
}

function buildGcloudProcessInvocation(args, options = {}) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('gcloud arguments must be an array of strings.');
  }

  const platform = options.platform || process.platform;
  const env = {
    ...(options.env || process.env),
  };
  setEnvironmentValue(env, 'CLOUDSDK_CORE_DISABLE_PROMPTS', '1');

  if (platform !== 'win32') {
    return {
      command: 'gcloud',
      args,
      env,
    };
  }

  // Windows installs expose gcloud.cmd, which Node cannot execute directly
  // with shell:false and which reparses dynamic values through cmd.exe. Resolve
  // that installation, then invoke its Python entry point with tokenized argv.
  const resolved = resolveWindowsGcloud({ ...options, env });
  return {
    command: resolved.command,
    args: [...resolved.argsPrefix, ...args],
    env,
  };
}

module.exports = {
  buildGcloudProcessInvocation,
  resolveWindowsGcloud,
};
