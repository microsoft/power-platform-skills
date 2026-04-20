#!/usr/bin/env node

// PostToolUse:Skill hook — records which skill was invoked to a session state
// file so the Stop hook can run the validator AFTER the skill has finished
// its work. Running validation here (immediately after the skill loads its
// instructions) fails because the skill hasn't done any work yet.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getTrackedSkillFromToolInput } = require('../scripts/lib/powerpages-hook-utils');

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
  try {
    const input = JSON.parse(inputData);
    const skillName = getTrackedSkillFromToolInput(input.tool_input);
    if (!skillName) {
      debug('[power-pages hook] No tracked skill detected — skipping\n');
      process.exit(0);
    }

    // Record the invoked skill to a session state file. Session ID is derived
    // from the Claude Code session (via env var) or falls back to cwd hash.
    const sessionId = input.session_id || process.env.CLAUDE_SESSION_ID || 'default';
    const stateDir = path.join(os.tmpdir(), 'power-pages-skills');
    const stateFile = path.join(stateDir, `session-${sessionId}.json`);

    try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* ignore */ }

    let state = { skills: [], cwd: input.cwd || process.cwd() };
    if (fs.existsSync(stateFile)) {
      try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* ignore */ }
    }

    if (!state.skills.includes(skillName)) {
      state.skills.push(skillName);
    }
    state.cwd = input.cwd || process.cwd();

    fs.writeFileSync(stateFile, JSON.stringify(state));
    debug(`[power-pages hook] Recorded skill "${skillName}" for session ${sessionId}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[power-pages hook] Unexpected error: ${err.message}\n`);
    process.exit(0);
  }
});
