'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runCliSync } = require('./process-runner');

/** Keep project npm settings local to the isolated installation, never the scaffold. */
function withNpmContext(sourceRoot, installRoot, operation) {
  const cwd = fs.realpathSync.native(sourceRoot);
  let prefix;
  try {
    const options = { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 };
    prefix = runCliSync('npm', ['prefix', '--silent'], options).trim();
    if (!path.isAbsolute(prefix)) {
      throw new Error('Invalid npm configuration context');
    }
  } catch {
    const error = new Error('Cannot preserve the caller npm configuration. Check the local npm installation and configuration; no isolated install was started.');
    error.code = 'MOBILE_RELEASE_BLOCKED';
    throw error;
  }
  const env = { ...process.env };
  const settings = {
    prefix: path.resolve(installRoot),
    global: 'false',
    workspaces: 'false',
  };
  for (const [key, value] of Object.entries(settings)) {
    for (const name of Object.keys(env)) {
      if (name.toLowerCase() === `npm_config_${key}`) delete env[name];
    }
    env[`npm_config_${key}`] = value;
  }
  const source = path.join(prefix, '.npmrc');
  const destination = path.join(installRoot, '.npmrc');
  let created = false;
  try {
    if (fs.existsSync(source)) {
      const content = fs.readFileSync(source);
      fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o600 });
      created = true;
    }
    // npm's prefix isolates package writes; the original cwd preserves relative TLS/auth paths.
    return operation(env, cwd);
  } finally {
    if (created) fs.unlinkSync(destination);
  }
}

module.exports = { withNpmContext };
