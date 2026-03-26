#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');
const {
  getTrackedSkillFromToolInput,
  getValidatorScript,
} = require('../scripts/lib/powerpages-hook-utils');

let inputData = '';

process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(inputData);
    const skillName = getTrackedSkillFromToolInput(input.tool_input);
    if (!skillName) {
      process.exit(0);
    }

    const validatorScript = getValidatorScript(skillName);
    if (!validatorScript) {
      process.exit(0);
    }

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

    process.exit(result.status ?? 0);
  } catch {
    process.exit(0);
  }
});
