#!/usr/bin/env node

// Stop hook — runs validators for any Power Pages skills that were invoked
// during the session. Validators are recorded by the PostToolUse:Skill hook
// (run-skill-posttool-validation.js). Running validation here (at session end)
// instead of at skill-load time ensures the skill has finished its work.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getValidatorScript } = require('../scripts/lib/powerpages-hook-utils');

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function debug(msg) {
  if (DEBUG) process.stderr.write(msg);
}

let inputData = '';

process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', () => {
  try {
    const input = inputData ? JSON.parse(inputData) : {};
    const sessionId = input.session_id || process.env.CLAUDE_SESSION_ID || 'default';
    const stateFile = path.join(os.tmpdir(), 'power-pages-skills', `session-${sessionId}.json`);

    if (!fs.existsSync(stateFile)) {
      debug(`[power-pages hook] No session state — no skills to validate\n`);
      process.exit(0);
    }

    let state;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      process.exit(0);
    }

    if (!state.skills || state.skills.length === 0) {
      process.exit(0);
    }

    const cwd = state.cwd || process.cwd();
    const errors = [];

    for (const skillName of state.skills) {
      const validatorScript = getValidatorScript(skillName);
      if (!validatorScript) continue;

      const validatorPath = path.join(__dirname, '..', validatorScript);
      if (!fs.existsSync(validatorPath)) continue;

      debug(`[power-pages hook] Running validator for "${skillName}"\n`);

      const result = spawnSync(process.execPath, [validatorPath], {
        input: JSON.stringify({ cwd }),
        encoding: 'utf8',
        cwd,
      });

      if (result.status && result.status !== 0) {
        if (result.stderr) errors.push(`[${skillName}] ${result.stderr.trim()}`);
        if (result.stdout) {
          // Validator wrote to stdout via block() — forward it
          process.stdout.write(result.stdout);
        }
      }
    }

    // Clean up session state file
    try { fs.unlinkSync(stateFile); } catch { /* ignore */ }

    if (errors.length > 0) {
      process.stderr.write(errors.join('\n') + '\n');
      process.exit(2); // blocking exit code for Stop hook
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`[power-pages hook] Unexpected error: ${err.message}\n`);
    process.exit(0);
  }
});
