#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  getTrackedSkillFromToolInput,
  getValidatorScript,
  isAlmPlanSkill,
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

  let validatorStatus = 0;
  let skillName = null;
  let input = null;

  try {
    input = JSON.parse(inputData);
    skillName = getTrackedSkillFromToolInput(input.tool_input);
    if (!skillName) {
      debug('[power-pages hook] No tracked skill detected — skipping validation\n');
      process.exit(0);
    }

    const cwd = input.cwd || process.cwd();

    const validatorScript = getValidatorScript(skillName);
    if (validatorScript) {
      const validatorPath = path.join(__dirname, '..', validatorScript);
      const result = spawnSync(process.execPath, [validatorPath], {
        input: inputData,
        encoding: 'utf8',
        cwd,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      validatorStatus = result.status ?? 0;
      debug(`[power-pages hook] Validator exited with code ${validatorStatus}\n`);
    }

    // ALM plan reconcile backstop (auto-heal). The refresh-alm-plan-data.js calls
    // in each SKILL.md are advisory — silently dropped on session fragmentation,
    // manual execution, or oversight. After ANY ALM plan skill completes, reconcile
    // the plan against the marker files: any marker newer than the plan (a skipped
    // refresh) is ingested automatically. Best-effort and NON-blocking — it never
    // changes the hook's exit code (the validator's status stands). Triggering on
    // any ALM skill (not just the marker's writer) catches a skip that surfaces only
    // when the NEXT ALM skill runs. Honors .alm-deferred + no-plan inside reconcile.
    if (isAlmPlanSkill(skillName) && fs.existsSync(path.join(cwd, 'docs', '.alm-plan-data.json'))) {
      try {
        const refreshPath = path.join(__dirname, '..', 'scripts', 'lib', 'refresh-alm-plan-data.js');
        const rec = spawnSync(process.execPath, [refreshPath, '--projectRoot', cwd, '--reconcile', '--render'], {
          encoding: 'utf8',
          cwd,
          timeout: 20000,
        });
        let reconciled = [];
        try { reconciled = (JSON.parse((rec.stdout || '').trim()).reconciled) || []; } catch {}
        if (reconciled.length > 0) {
          process.stdout.write(
            `[power-pages] ALM plan was out of sync with ${reconciled.length} run marker(s) — refreshed automatically (${reconciled.join(', ')}).\n`,
          );
        }
        debug(`[power-pages hook] reconcile reconciled=${JSON.stringify(reconciled)}\n`);
      } catch (e) {
        // Best-effort — a reconcile failure must never break the skill or the hook.
        debug(`[power-pages hook] reconcile error (ignored): ${e.message}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[power-pages hook] Unexpected error: ${err.message}\n`);
    validatorStatus = 0;
  }

  process.exit(validatorStatus);
});
