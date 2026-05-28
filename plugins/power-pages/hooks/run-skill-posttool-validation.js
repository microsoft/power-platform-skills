#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');
const {
  getTrackedSkillFromToolInput,
  getValidatorScript,
} = require('../scripts/lib/powerpages-hook-utils');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function debug(msg) {
  if (DEBUG) process.stderr.write(msg);
}

debug('[power-pages hook] run-skill-posttool-validation.js started\n');

let inputData = '';

process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', () => {
  debug(`[power-pages hook] stdin closed, received ${inputData.length} bytes\n`);
  try {
    const input = JSON.parse(inputData);
    const skillName = getTrackedSkillFromToolInput(input.tool_input);
    if (!skillName) {
      debug('[power-pages hook] No tracked skill detected — skipping validation\n');
      process.exit(0);
    }

    const validatorScript = getValidatorScript(skillName);
    if (!validatorScript) {
      debug(`[power-pages hook] Skill "${skillName}" has no validator — skipping\n`);
      process.exit(0);
    }

    debug(`[power-pages hook] Running validator for skill "${skillName}": ${validatorScript}\n`);

    const validatorPath = path.join(__dirname, '..', validatorScript);
    const result = spawnSync(process.execPath, [validatorPath], {
      input: inputData,
      encoding: 'utf8',
      cwd: input.cwd || process.cwd(),
    });

    if (result.stdout) {
      process.stdout.write(result.stdout);
    }

    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    debug(`[power-pages hook] Validator exited with code ${result.status ?? 0}\n`);
    process.exit(result.status ?? 0);
  } catch (err) {
    process.stderr.write(`[power-pages hook] Unexpected error: ${err.message}\n`);
    process.exit(0);
  }
});
