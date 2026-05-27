#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const os = require('os');
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

function osFriendlyName(platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'Mac';
  if (platform === 'linux') return 'Linux';
  return platform;
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
    // Fast-path opt-out / kill-switch: cheap checks BEFORE the pac
    // shell-outs (`pac auth who` ~3s + `pac --version` ~2s) so disabled /
    // opted-out invocations don't pay the latency.
    if (process.env.POWER_PLATFORM_SKILLS_TELEMETRY === '0') {
      process.exit(validatorStatus);
    }
    const ikeyCfg = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(TELEMETRY_DIR, 'ikey.json'), 'utf8')
        );
      } catch {
        return {
          event_stream_name: '',
          disabled: false,
          default_region: 'us',
          regions: {},
        };
      }
    })();
    if (ikeyCfg.disabled === true) process.exit(validatorStatus);
    const defaultRegion = ikeyCfg.default_region || 'us';
    const defaultEntry =
      (ikeyCfg.regions && ikeyCfg.regions[defaultRegion]) || null;
    if (!defaultEntry || !defaultEntry.instrumentation_key) {
      process.exit(validatorStatus);
    }

    const emitSpawn = require(path.join(TELEMETRY_DIR, 'lib', 'emit-spawn'));
    const eventsLib = require(path.join(TELEMETRY_DIR, 'lib', 'events'));
    const correlationLib = require(path.join(TELEMETRY_DIR, 'lib', 'correlation'));
    const sessionLib = require(path.join(TELEMETRY_DIR, 'lib', 'session'));
    const pacAuthLib = require(path.join(TELEMETRY_DIR, 'lib', 'pac-auth'));
    const agentInfoLib = require(path.join(TELEMETRY_DIR, 'lib', 'agent-info'));

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
    const fakeProbe = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || '';
    const outcome =
      !validatorRan || validatorStatus === 0 ? 'success' : 'failure';

    let pacAuth = null;
    try {
      pacAuth = pacAuthLib.readPacAuth();
    } catch {
      pacAuth = null;
    }

    let agentInfo = {};
    try {
      agentInfo = {
        ...agentInfoLib.readAiAgent(),
        pacCliVersion: agentInfoLib.readPacCliVersion(),
      };
    } catch {
      agentInfo = {};
    }

    const fields = {
      pluginName: 'power-pages',
      pluginVersion,
      sessionId: sessionLib.getSessionId(),
      correlationId: corr.correlation_id,
      osName: osFriendlyName(process.platform),
      osVersion: os.release(),
      nodeVersion: 'v' + String(process.versions.node).split('.')[0],
      skillName,
      outcome,
      durationMs: Date.now() - (corr.start_ts || startTs),
      errorClass: '',
      errorDescription: '',
    };
    if (pacAuth && pacAuth.orgId) fields.orgId = pacAuth.orgId;
    if (pacAuth && pacAuth.tenantId) fields.tenantId = pacAuth.tenantId;
    if (agentInfo.aiAgentName) fields.aiAgentName = agentInfo.aiAgentName;
    if (agentInfo.aiAgentVersion) fields.aiAgentVersion = agentInfo.aiAgentVersion;
    if (agentInfo.pacCliVersion) fields.pacCliVersion = agentInfo.pacCliVersion;

    emitSpawn.fireAndForget(
      eventsLib.buildSkillCompleted(
        ikeyCfg.event_stream_name || '',
        fields
      ),
      {
        cloud: (pacAuth && pacAuth.cloud) || '',
        configDir,
        fakeProbe,
      }
    );

    correlationLib.clear({ skillName });
  } catch {
    // fail closed: telemetry never affects skill outcome
  }

  process.exit(validatorStatus);
});
