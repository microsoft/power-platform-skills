#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  getTrackedSkillFromToolInput,
  getValidatorScript,
  isAlmPlanSkill,
} = require('../scripts/lib/powerpages-hook-utils');
const { planDataPath } = require('../scripts/lib/alm-paths');

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
    if (isAlmPlanSkill(skillName) && fs.existsSync(planDataPath(cwd))) {
      try {
        const refreshPath = path.join(__dirname, '..', 'scripts', 'lib', 'refresh-alm-plan-data.js');
        const rec = spawnSync(process.execPath, [refreshPath, '--projectRoot', cwd, '--reconcile', '--render'], {
          encoding: 'utf8',
          cwd,
          timeout: 20000,
        });
        // spawnSync surfaces a spawn/timeout failure on rec.error (e.g. ETIMEDOUT)
        // and a non-zero / signalled exit on rec.status / rec.signal — none of which
        // produce parseable stdout. Track those so a broken reconcile is reported
        // rather than silently swallowed by the JSON.parse catch below.
        const spawnFailed = !!rec.error || rec.status !== 0 || !!rec.signal;
        let reconciled = [];
        let failed = [];
        let parsed = false;
        try {
          const out = JSON.parse((rec.stdout || '').trim());
          reconciled = out.reconciled || [];
          failed = out.failed || [];
          parsed = true;
        } catch { /* parsed stays false — surfaced in the spawnFailed/!parsed branch */ }
        if (reconciled.length > 0) {
          process.stdout.write(
            `[power-pages] ALM plan was out of sync with ${reconciled.length} run marker(s) — refreshed automatically (${reconciled.join(', ')}).\n`,
          );
        }
        // Failure reporting goes to STDERR (only on an actual failure, never on the
        // happy path — the hook fires on every Skill use, so clean runs must stay
        // quiet). A swallowed reconcile failure is exactly what makes a stale plan
        // impossible to diagnose, so we forward the child's stderr verbatim — that's
        // where refresh-alm-plan-data.js already writes its per-phase error detail,
        // which is what makes the summary line below actionable.
        if (failed.length > 0) {
          process.stderr.write(
            `[power-pages] ALM plan reconcile could not heal ${failed.length} phase(s): ${failed.map((f) => f.phase).join(', ')}. Details below.\n`,
          );
          if (rec.stderr) process.stderr.write(rec.stderr);
        } else if (spawnFailed || !parsed) {
          // The reconcile didn't even produce a parseable result (spawn error,
          // timeout, non-zero exit, or garbled stdout). Non-blocking, but the user
          // should still see why the auto-heal didn't run.
          const why = rec.error ? rec.error.message : rec.signal ? `signal ${rec.signal}` : `exit ${rec.status}`;
          process.stderr.write(`[power-pages] ALM plan reconcile did not complete (${why}). Details below.\n`);
          if (rec.stderr) process.stderr.write(rec.stderr);
        }
        debug(`[power-pages hook] reconcile reconciled=${JSON.stringify(reconciled)} failed=${JSON.stringify(failed)} spawnFailed=${spawnFailed} parsed=${parsed}\n`);
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
