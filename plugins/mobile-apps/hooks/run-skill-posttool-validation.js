#!/usr/bin/env node

/**
 * PostToolUse hook for mobile-app skills.
 *
 * After a Skill tool call returns, look up whether the skill has a registered
 * validator. If so, run the validator with the same stdin payload and propagate
 * stdout/stderr/exit code back to the caller.
 *
 * Mirrors the power-pages hook pattern. Adding a new validator = update
 * TRACKED_SKILLS in scripts/lib/mobile-app-hook-utils.js and ship a
 * validator script under the skill's directory.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  getTrackedSkillFromToolInput,
  getValidatorScript,
} = require('../scripts/lib/mobile-app-hook-utils');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function debug(msg) {
  if (DEBUG) process.stderr.write(msg);
}

debug('[mobile-app hook] run-skill-posttool-validation.js started\n');

let inputData = '';

process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', () => {
  debug(`[mobile-app hook] stdin closed, received ${inputData.length} bytes\n`);
  try {
    const input = JSON.parse(inputData);
    const skillName = getTrackedSkillFromToolInput(input.tool_input);
    if (!skillName) {
      debug('[mobile-app hook] No tracked skill detected — skipping validation\n');
      process.exit(0);
    }

    const validatorScript = getValidatorScript(skillName);
    if (!validatorScript) {
      debug(`[mobile-app hook] Skill "${skillName}" has no validator — skipping\n`);
      process.exit(0);
    }

    debug(`[mobile-app hook] Running validator for skill "${skillName}": ${validatorScript}\n`);

    const validatorPath = path.join(__dirname, '..', validatorScript);
    const result = spawnSync(process.execPath, [validatorPath], {
      input: inputData,
      encoding: 'utf8',
      cwd: input.cwd || process.cwd(),
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    debug(`[mobile-app hook] Validator exited with code ${result.status ?? 0}\n`);
    process.exit(result.status ?? 0);
  } catch (err) {
    process.stderr.write(`[mobile-app hook] Unexpected error: ${err.message}\n`);
    process.exit(0);
  }
});
