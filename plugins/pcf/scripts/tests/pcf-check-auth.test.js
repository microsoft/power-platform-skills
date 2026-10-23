'use strict';
// scripts/check-auth.js is model-apps' script, shipped here byte for byte (scripts/validate-plugin-copies.js keeps
// the two equal). Its sign-in text was written for model-apps' flows ("discover connections", "table/column/form/
// view/app/page builds"), and pcf's deploy flow passes --require-pac, so the one run that printed that text was a
// pcf verification or inventory run — which names no connection and builds no table. These tests pin the words
// pcf's runs now get: the one rule that holds in every plugin (only a step that runs `pac` needs the login), and the
// hard blocks pcf's push and package paths rely on, unchanged. The same words are pinned in
// plugins/model-apps/scripts/tests/check-auth.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');

const scriptPath = path.join(__dirname, '..', 'check-auth.js');
const ENVURL = 'https://contoso.crm.dynamics.com';
const AZ_USER = 'maker@contoso.com';

const PLUGIN_FLOW_WORDS = /connection|connector|deployment[- ]setting|table\/column|genpage|app-builder|entity creation|\bSDK\b/i;
const PAC_RULE = 'only a step that runs `pac` needs the login, and so does reading the environment when --env is omitted';

// Starts no real CLI: `az account show` answers AZ_USER, and `pac org who` answers `pacOrg` (null = a pac that is
// not logged in, as a missing binary or an empty login) or never answers in time (`slowPac`).
function execFileAsync({ pacOrg = null, slowPac = false }) {
  return (cmd, args, _opts, cb) => {
    const argvText = (args || []).join(' ');
    const child = { stdin: { end() {} }, kill() {} };
    if (cmd === 'az' && argvText.includes('account show')) {
      process.nextTick(() => cb(null, AZ_USER, ''));
    } else if (cmd === 'pac' && slowPac) {
      process.nextTick(() => cb(Object.assign(new Error('Command failed: pac org who'), { killed: true, signal: 'SIGTERM', code: null }), '', ''));
    } else if (cmd === 'pac') {
      process.nextTick(() => (pacOrg === null ? cb(new Error('spawn pac ENOENT'), '', '') : cb(null, pacOrg, '')));
    } else {
      process.nextTick(() => cb(new Error(`unexpected command: ${cmd} ${argvText}`), '', ''));
    }
    return child;
  };
}

async function run({ argv = ['--env', ENVURL], ...exec } = {}) {
  const real = require('../lib/dataverse-auth.js');
  const cli = loadCli(scriptPath, {
    argv,
    requires: {
      './lib/process-runner': { execFileAsync: execFileAsync(exec), runSync: () => { throw new Error('sync child processes must not be used by check-auth'); } },
      './lib/dataverse-auth': {
        parseArgs: real.parseArgs,
        validateFlags: real.validateFlags,
        getAuthToken: () => { throw new Error('sync token acquisition must not be used by check-auth'); },
        getAuthTokenAsync: async () => 'token-value',
        tokenFailureKind: () => null,
        tokenFailureMessage: (_url, fallback) => fallback,
        dataverseRequest: async () => ({ status: 200, data: { UserId: 'u-1', OrganizationId: 'o-1' } }),
      },
    },
  });
  try {
    await cli.main();
  } catch (e) {
    if (e.exitCode === undefined) throw e;
  }
  return JSON.parse(cli.stdoutText());
}

test('without --require-pac, a missing pac login is a warning that names no model-apps flow', async () => {
  const r = await run({ pacOrg: null });
  assert.equal(r.ok, true);
  assert.equal(r.blocker, null);
  assert.deepEqual(r.warnings, [
    `PAC CLI is not logged in. That does not block a step that signs in with the az token alone: ${PAC_RULE}. Run \`pac auth create --environment <url>\` before such a step.`,
  ]);
  assert.doesNotMatch(r.warnings[0], PLUGIN_FLOW_WORDS);
  assert.equal(r.message, `Ready (az signed in as ${AZ_USER}, env ${ENVURL}). PAC is not logged in — only a step that runs pac needs it.`);
});

test('without --require-pac, a pac probe that ran out of time is reported as unknown, in the same words', async () => {
  const r = await run({ slowPac: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, [
    '`pac org who` did not answer within 60 s — the PAC CLI can be that slow to start on a busy machine, so its login is unknown, not missing. '
      + `That does not block a step that signs in with the az token alone: ${PAC_RULE}.`,
  ]);
  assert.equal(r.message, `Ready (az signed in as ${AZ_USER}, env ${ENVURL}). PAC's login is unknown — \`pac org who\` did not answer in time; only a step that runs pac needs it.`);
  for (const text of [r.warnings[0], r.message]) assert.doesNotMatch(text, PLUGIN_FLOW_WORDS);
});

test('a pac login under a different identity is reported without entity creation or any other model-apps step', async () => {
  const r = await run({ pacOrg: 'Connected as dev@contoso.com\n' });
  assert.equal(r.ok, true);
  assert.equal(r.identitiesMatch, false);
  assert.equal(r.message, 'Ready, but az ("maker@contoso.com") and pac ("dev@contoso.com") use different identities. WhoAmI passed so this works for now — but if a later step returns 403, run `az login --username dev@contoso.com` to align them.');
  assert.doesNotMatch(r.message, PLUGIN_FLOW_WORDS);
});

test('pcf\'s push and package paths pass --require-pac, and a missing or slow pac is still a hard block there', async () => {
  const missing = await run({ argv: ['--env', ENVURL, '--require-pac'], pacOrg: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.blocker, 'pac_not_logged_in');
  assert.equal(missing.message, 'PAC CLI is not logged in. Run `pac auth create --environment <url>` to authenticate.');
  const slow = await run({ argv: ['--env', ENVURL, '--require-pac'], slowPac: true });
  assert.equal(slow.ok, false);
  assert.equal(slow.blocker, 'pac_timeout');
  assert.match(slow.message, /^`pac org who` did not answer within 60 s .* so its login is unknown, not missing\. Retry\.$/);
  const ok = await run({ argv: ['--env', ENVURL, '--require-pac'], pacOrg: `Connected as ${AZ_USER}\n` });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.message, `Ready (az + pac both signed in as ${AZ_USER}, env ${ENVURL}).`);
});

test('every output field a pcf skill reads is still there', async () => {
  const r = await run({ pacOrg: `Connected as ${AZ_USER}\n` });
  assert.deepEqual(Object.keys(r).sort(), ['azUser', 'blocker', 'envUrl', 'identitiesMatch', 'message', 'ok', 'pacUser', 'warnings', 'whoAmI']);
  assert.equal(r.azUser, AZ_USER);
  assert.equal(r.pacUser, AZ_USER);
  assert.equal(r.envUrl, ENVURL);
  assert.equal(r.identitiesMatch, true);
  assert.deepEqual(r.whoAmI, { ok: true, userId: 'u-1', organizationId: 'o-1' });
});

test('this script is model-apps\' check-auth.js, byte for byte, so the words above are the words model-apps prints', (t) => {
  const source = path.join(__dirname, '..', '..', '..', 'model-apps', 'scripts', 'check-auth.js');
  if (!fs.existsSync(source)) {
    t.skip('plugins/model-apps is not present (an installed plugin, not a repo checkout)');
    return;
  }
  assert.ok(fs.readFileSync(scriptPath).equals(fs.readFileSync(source)),
    'copy plugins/model-apps/scripts/check-auth.js over plugins/pcf/scripts/check-auth.js (scripts/validate-plugin-copies.js lists the pair)');
});
