#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  getTrackedSkillFromToolInput,
  getValidatorScript,
} = require('../scripts/lib/powerpages-hook-utils');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'telemetry');
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function debug(msg) {
  if (DEBUG) process.stderr.write(msg);
}

debug('[power-pages hook] run-skill-posttool-validation.js started\n');

let inputData = '';

process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', async () => {
  debug(`[power-pages hook] stdin closed, received ${inputData.length} bytes\n`);

  const startTs = Date.now();
  let validatorStatus = 0;
  let skillName = null;
  let validatorRan = false;

  try {
    const input = JSON.parse(inputData);
    skillName = getTrackedSkillFromToolInput(input.tool_input);
    if (!skillName) {
      debug('[power-pages hook] No tracked skill detected — skipping validation\n');
      process.exit(0);
    }

    const validatorScript = getValidatorScript(skillName);
    if (validatorScript) {
      validatorRan = true;
      const validatorPath = path.join(__dirname, '..', validatorScript);
      const result = spawnSync(process.execPath, [validatorPath], {
        input: inputData,
        encoding: 'utf8',
        cwd: input.cwd || process.cwd(),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      validatorStatus = result.status ?? 0;
      debug(`[power-pages hook] Validator exited with code ${validatorStatus}\n`);
    }
  } catch (err) {
    process.stderr.write(`[power-pages hook] Unexpected error: ${err.message}\n`);
    validatorStatus = 0;
  }

  // Telemetry emission: fail-closed, never changes exit code.
  try {
    const emitSpawn = require(path.join(TELEMETRY_DIR, 'lib', 'emit-spawn'));
    const eventsLib = require(path.join(TELEMETRY_DIR, 'lib', 'events'));
    const correlationLib = require(path.join(TELEMETRY_DIR, 'lib', 'correlation'));
    const sessionLib = require(path.join(TELEMETRY_DIR, 'lib', 'session'));

    const ikeyCfg = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(TELEMETRY_DIR, 'ikey.json'), 'utf8')
        );
      } catch {
        return { ikey: '', collector_url: '' };
      }
    })();

    const pluginVersion = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
        ).version || 'unknown';
      } catch {
        return 'unknown';
      }
    })();

    const corr = correlationLib.read({ skillName }) || {
      correlation_id: require('crypto').randomUUID(),
      start_ts: startTs,
    };

    const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || '';
    const outcome =
      !validatorRan || validatorStatus === 0 ? 'success' : 'failure';

    emitSpawn.fireAndForget(
      eventsLib.buildSkillCompleted({
        plugin_name: 'power-pages',
        plugin_version: pluginVersion,
        session_id: sessionLib.getSessionId(),
        os_family: process.platform,
        node_version: 'v' + String(process.versions.node).split('.')[0],
        skill_name: skillName,
        correlation_id: corr.correlation_id,
        outcome,
        duration_ms: Date.now() - (corr.start_ts || startTs),
        error_class: '',
      }),
      { iKey: ikeyCfg.ikey, collectorUrl: ikeyCfg.collector_url, configDir }
    );

    correlationLib.clear({ skillName });
  } catch {
    // fail closed: telemetry never affects skill outcome
  }

  process.exit(validatorStatus);
});
