#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error.message}`);
  }
}

function loadPreparedDisplayName(projectRoot) {
  const appConfigPath = path.join(projectRoot, 'app.config.js');
  if (!fs.existsSync(appConfigPath)) {
    throw new Error(`Prepared app config is missing: ${appConfigPath}`);
  }

  let exported;
  const previousDisplayName = process.env.APP_DISPLAY_NAME;
  try {
    // Read the prepared fallback, not a caller-machine override. Step 5 owns
    // app identity, while APP_DISPLAY_NAME is only a runtime/build override.
    process.env.APP_DISPLAY_NAME = '';
    delete require.cache[require.resolve(appConfigPath)];
    exported = require(appConfigPath);
  } catch (error) {
    throw new Error(`Could not load ${appConfigPath}: ${error.message}`);
  } finally {
    delete require.cache[require.resolve(appConfigPath)];
    if (previousDisplayName === undefined) delete process.env.APP_DISPLAY_NAME;
    else process.env.APP_DISPLAY_NAME = previousDisplayName;
  }

  const config = typeof exported === 'function'
    ? exported({ config: {} })
    : exported;
  if (!config || typeof config.name !== 'string' || !config.name.trim()) {
    throw new Error('Prepared app.config.js did not produce a non-empty app name');
  }
  return config.name;
}

function validateExistingPowerConfig(projectRoot, environmentId, displayName) {
  const powerConfigPath = path.join(projectRoot, 'power.config.json');
  if (!fs.existsSync(powerConfigPath)) return null;

  const powerConfig = readJson(powerConfigPath);
  const configuredEnvironment = String(powerConfig.environmentId || '').trim();
  if (!configuredEnvironment) {
    throw new Error(
      'power.config.json is an empty placeholder; rerun deterministic template preparation before initialization',
    );
  }
  if (configuredEnvironment.toLowerCase() !== environmentId.toLowerCase()) {
    throw new Error(
      `existing power.config.json targets ${configuredEnvironment}, but the approved environment is ${environmentId}`,
    );
  }

  const configuredDisplayName = String(powerConfig.appDisplayName || '').trim();
  if (configuredDisplayName !== displayName) {
    throw new Error(
      `existing power.config.json identifies app "${configuredDisplayName || '<missing>'}", but the approved display name is "${displayName}"`,
    );
  }
  return powerConfig;
}

function buildInitArgs(displayName, environmentId) {
  return [
    'power-apps',
    'init',
    '-t',
    'MobileApp',
    '--display-name',
    displayName,
    '--environment-id',
    environmentId,
    '--non-interactive',
  ];
}

function initializeMobileApp(options) {
  const projectRoot = path.resolve(options.workingDir);
  const environmentId = String(options.environmentId || '').trim();
  if (!environmentId) throw new Error('environmentId is required');

  const displayName = loadPreparedDisplayName(projectRoot);
  const existing = validateExistingPowerConfig(projectRoot, environmentId, displayName);
  if (existing) {
    return {
      status: 'existing',
      displayName,
      environmentId,
    };
  }

  const command = options.npxCommand || (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const args = buildInitArgs(displayName, environmentId);
  const spawn = options.spawn || spawnSync;
  const result = spawn(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
    stdio: options.spawn ? 'pipe' : 'inherit',
  });
  if (result.error) {
    throw new Error(`Could not start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npx power-apps init failed with exit code ${result.status}`);
  }

  validateExistingPowerConfig(projectRoot, environmentId, displayName);
  return {
    status: 'initialized',
    displayName,
    environmentId,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--working-dir') options.workingDir = argv[++index];
    else if (argument === '--environment-id') options.environmentId = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.workingDir) throw new Error('--working-dir is required');
  if (!options.environmentId) throw new Error('--environment-id is required');
  return options;
}

if (require.main === module) {
  try {
    const result = initializeMobileApp(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  buildInitArgs,
  initializeMobileApp,
  loadPreparedDisplayName,
  validateExistingPowerConfig,
};
