#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const TELEMETRY_CLI = path.join(__dirname, 'telemetry', 'lib', 'telemetry-config.js');
const GENERIC_DISCLOSURE =
  '\u2139\ufe0f  Usage telemetry records skill, plugin, PAC, agent, OS, Node, session,\n' +
  '   and correlation fields, plus Dataverse organization and Entra tenant IDs\n' +
  '   when PAC is signed in.';
const MOBILE_DISCLOSURE =
  '\u2139\ufe0f  Usage telemetry records skill, plugin, agent, OS, Node, session, and\n' +
  '   event/run/span IDs, measured durations, outcomes, and fixed error classes.\n' +
  '   It can include verified environment, tenant, and Dataverse organization IDs,\n' +
  '   plus a random app instance ID and invocation source. It does not collect an\n' +
  '   Entra user/object ID, Dataverse user ID, username, or email address.\n' +
  '   No business records, file contents, emails, tokens, or raw errors are sent.';

function run(args = process.argv.slice(2), env = process.env) {
  const result = spawnSync(
    process.execPath,
    [TELEMETRY_CLI, ...args, '--plugin', 'mobile-app'],
    { encoding: 'utf8', env },
  );

  if (result.error) throw result.error;
  const stdout = result.stdout.replace(GENERIC_DISCLOSURE, MOBILE_DISCLOSURE);
  return { ...result, stdout };
}

if (require.main === module) {
  try {
    const result = run();
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status === null ? 1 : result.status);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { run };