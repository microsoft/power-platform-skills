#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const {
  setTelemetryChoice, effectiveTelemetryChoice, readTelemetryEnvOptOut,
} = require('./lib/telemetry/lib/user-config.js');
const { pluginLogDir, latestSessionLog } = require('./lib/telemetry/lib/local-log.js');
const { isProvisioned } = require('./lib/telemetry/resolver.js');

const USAGE = 'USAGE: node scripts/telemetry-config.js [--action <on|off|status>]';

function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const flagError = validateFlags(argv, { known: ['action'], needValue: ['action'] });
  const action = flags.action || 'status';
  if (flagError || positional.length || !['on', 'off', 'status'].includes(action)) {
    process.stderr.write(`${flagError || 'Action must be on, off or status.'}\n${USAGE}\n`);
    process.exit(1);
  }

  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || path.join(os.homedir(), '.power-platform-skills');
  const override = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const ikeyPath = override && override.trim() ? override : path.join(__dirname, 'lib', 'telemetry', 'ikey.json');
  const cfg = JSON.parse(fs.readFileSync(ikeyPath, 'utf8'));
  if (action !== 'status') {
    if (!setTelemetryChoice(configDir, 'pcf', action)) {
      throw new Error('Could not update the PCF telemetry setting (config dir not writable).');
    }
    console.log(`Saved transmission preference (pcf): ${action.toUpperCase()}.`);
  }

  // The shared CLI reports the user's transmission preference, not the committed
  // build's provisioning state. Keep the shared library verbatim and use its
  // config/log helpers here so /pcf:telemetry reports the actual build state.
  const provisioned = isProvisioned(cfg);
  const off = effectiveTelemetryChoice(configDir, 'pcf') === 'off';
  if (cfg.disabled === true) {
    console.log('Telemetry (pcf): DISABLED in this build - nothing is sent or logged until a provisioned release.');
    console.log(`Transmission preference: ${off ? 'OFF' : 'ON'}; it cannot override the build hard-off.`);
  } else if (!provisioned) {
    console.log('Telemetry (pcf): UNPROVISIONED - nothing is sent or logged.');
  } else {
    console.log(`Telemetry (pcf): ${off ? 'OFF - nothing is transmitted.' : 'ON'}`);
    if (readTelemetryEnvOptOut('pcf')) {
      console.log('An environment opt-out takes precedence over the saved preference.');
    }
    console.log('The local diagnostic mirror is still written when transmission is off.');
    console.log(`Logs directory: ${pluginLogDir(configDir, 'pcf')}`);
    const latest = latestSessionLog(configDir, 'pcf');
    if (latest) console.log(`Most recent session: ${latest}`);
  }
  console.log('An enabled, provisioned release records only skill_started base fields: skill, plugin, PAC, agent, OS and Node versions, session and correlation IDs, plus orgId and tenantId when PAC is signed in; no user object ID or eventInfo fields.');
  console.log('Never sent: file paths, cwd, environment variables, prompts, arguments, tool inputs, site names, Dataverse URLs, stack traces, error messages, credentials, usernames or hostnames.');
  console.log('Opt out: /pcf:telemetry off or POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT=1 (highest precedence).');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    emitResult(false, error);
  }
}

module.exports = { main };
