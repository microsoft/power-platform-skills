#!/usr/bin/env node

/**
 * PostToolUse hook for model-apps skills.
 *
 * After a Skill tool call returns, look up whether the invoked skill has a
 * registered validator (skills/<skill>/scripts/validate*.js). If so, run it with
 * the same stdin payload and propagate its stdout/stderr/exit code back.
 *
 * Mirrors the mobile-apps / power-pages validation-only hook. This plugin's
 * version intentionally has NO ALM reconcile branch (genpage has no ALM plan) and
 * no telemetry coupling — telemetry is emitted by the separate PreToolUse /
 * UserPromptSubmit hooks. Adding a new validator = drop a validate*.js under the
 * skill's scripts/ dir; modelapps-hook-utils.js discovers it automatically.
 *
 * Fail-open: any internal error exits 0 so a hook bug can never break a skill run.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  getTrackedSkillFromToolInput,
  getValidatorScript,
} = require('../scripts/lib/modelapps-hook-utils');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function debug(msg) {
  if (DEBUG) process.stderr.write(msg);
}

debug('[model-apps hook] run-skill-posttool-validation.js started\n');

let inputData = '';

process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', () => {
  debug(`[model-apps hook] stdin closed, received ${inputData.length} bytes\n`);
  try {
    const input = JSON.parse(inputData);
    const skillName = getTrackedSkillFromToolInput(input.tool_input);
    if (!skillName) {
      debug('[model-apps hook] No tracked skill detected — skipping validation\n');
      process.exit(0);
    }

    const validatorScript = getValidatorScript(skillName);
    if (!validatorScript) {
      debug(`[model-apps hook] Skill "${skillName}" has no validator — skipping\n`);
      process.exit(0);
    }

    debug(`[model-apps hook] Running validator for skill "${skillName}": ${validatorScript}\n`);

    const validatorPath = path.join(__dirname, '..', validatorScript);
    const result = spawnSync(process.execPath, [validatorPath], {
      input: inputData,
      encoding: 'utf8',
      cwd: input.cwd || process.cwd(),
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    debug(`[model-apps hook] Validator exited with code ${result.status ?? 0}\n`);
    process.exit(result.status ?? 0);
  } catch (err) {
    // Never block on a hook-side bug — the skill already ran.
    process.stderr.write(`[model-apps hook] Unexpected error: ${err.message}\n`);
    process.exit(0);
  }
});
