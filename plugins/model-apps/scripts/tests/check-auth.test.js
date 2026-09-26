'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'check-auth.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('check-auth.js enumerates all blocker codes', () => {
  for (const code of [
    'az_missing',
    'az_not_logged_in',
    'pac_not_logged_in',
    'no_env_url',
    'whoami_403',
    'whoami_401',
    'whoami_error',
  ]) {
    assert.match(scriptSrc, new RegExp(`['"]${code}['"]`), `missing blocker code: ${code}`);
  }
});

test('check-auth.js: a missing PAC login blocks only under --require-pac (genpage); otherwise it is a warning', () => {
  // Gap 4: the app-builder build/verify/teardown flow authenticates to Dataverse with the az token,
  // so a missing pac login must NOT block it. Genpage (which uploads pages via `pac model genpage`)
  // opts back into the hard block with --require-pac.
  assert.match(scriptSrc, /requirePac/, 'pac requirement is gated behind a --require-pac flag');
  assert.match(scriptSrc, /argv\.includes\('--require-pac'\)/);
  assert.match(scriptSrc, /warnings\.push\(/, 'a missing pac login is surfaced as a warning when not required');
});

const { parseEnvUrl } = require(scriptPath);

test('parseEnvUrl accepts --env <url> (the flag the build/verify/teardown scripts use)', () => {
  assert.equal(parseEnvUrl(['--env', 'https://org.crm.dynamics.com/']), 'https://org.crm.dynamics.com/');
});

test('parseEnvUrl accepts a positional url', () => {
  assert.equal(parseEnvUrl(['https://org.crm.dynamics.com/']), 'https://org.crm.dynamics.com/');
});

test('parseEnvUrl never mistakes the literal "--env" for the URL (the prior positional-only bug)', () => {
  // `check-auth.js --env <url>` used to set envUrl = "--env"; the flag must win and a bare flag
  // with no value must not leak the flag string as the URL.
  assert.equal(parseEnvUrl(['--env']), null);
  assert.notEqual(parseEnvUrl(['--env', 'https://org.crm.dynamics.com/']), '--env');
});

test('parseEnvUrl returns null when no url is given', () => {
  assert.equal(parseEnvUrl([]), null);
  assert.equal(parseEnvUrl(['--apply']), null);
});

test('a positional url survives a preceding boolean --require-pac', () => {
  // parseArgs has no flag contract, so it treats the token after the boolean `--require-pac` as its
  // value. Reading the fallback from parseArgs' `positional` array therefore LOST the URL and fell
  // back to `pac org who` — silently probing a different environment than the caller named. The
  // header documents both orderings and callers do not control argument order.
  assert.equal(parseEnvUrl(['--require-pac', 'https://contoso.crm.dynamics.com']), 'https://contoso.crm.dynamics.com');
  assert.equal(parseEnvUrl(['https://contoso.crm.dynamics.com', '--require-pac']), 'https://contoso.crm.dynamics.com');
});

test('a mistyped flag is a structured blocker, not a silently weaker check', () => {
  // `--requir-pac` used to be dropped in silence, which quietly downgraded genpage's HARD pac
  // requirement to a warning. It must be reported — but still on exit 0, because every caller of
  // this tool gates on the parsed stdout rather than the exit code.
  const out = execFileSync(process.execPath, [scriptPath, '--env', 'https://contoso.crm.dynamics.com', '--requir-pac'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const payload = JSON.parse(out);
  assert.equal(payload.ok, false);
  assert.equal(payload.blocker, 'usage');
  assert.match(payload.message, /did you mean --require-pac\?/);
});

test('a bare --env is reported rather than treated as "no environment given"', () => {
  const out = execFileSync(process.execPath, [scriptPath, '--env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const payload = JSON.parse(out);
  assert.equal(payload.blocker, 'usage');
  assert.match(payload.message, /--env requires a value/);
});

test('check-auth.js exits 0 even on failure (output drives gating)', () => {
  // The emit() helper always exits 0.
  assert.match(scriptSrc, /process\.exit\(0\)/);
  assert.doesNotMatch(scriptSrc, /process\.exit\(1\)/);
});

test('check-auth.js calls az account show and pac org who', () => {
  assert.match(scriptSrc, /'account', 'show'/);
  assert.match(scriptSrc, /'org', 'who'/);
});

test('check-auth.js runs WhoAmI through dataverseRequest', () => {
  assert.match(scriptSrc, /dataverseRequest\([^,]+,\s*'GET',\s*'WhoAmI'/);
});

test('check-auth.js compares identities case-insensitively', () => {
  assert.match(scriptSrc, /normalizeUser/);
  assert.match(scriptSrc, /toLowerCase/);
});

test('check-auth.js: 403 hint mentions az login --username when identities differ', () => {
  assert.match(scriptSrc, /az login --username \$\{pacUser\}/);
});

// --- Decision tree: blocker classification ----------------------------------
//
// check-auth is the FIRST thing both skills run, and every downstream failure is interpreted
// through its verdict. Each branch below produces a different operator instruction, so a wrong
// classification sends the user to fix the wrong thing (e.g. "run az login" when the real problem
// is that their identity has no access to the environment).

const { loadCli } = require('./helpers/cli-harness.js');

const ENVURL = 'https://contoso.crm.dynamics.com';

// runQuiet() shells out via execFileSync and treats a throw as "absent". These stubs therefore
// model each CLI as either returning stdout or throwing, exactly as a missing binary would — and a
// missing binary fails EVERY invocation, not only `--version`. Each call is recorded in order.
function makeExec({ azVersion = 'azure-cli 2.60.0', azUser = 'maker@contoso.com' }, calls) {
  return (cmd, args) => {
    const argv = (args || []).join(' ');
    calls.push(`${cmd} ${argv}`);
    if (cmd === 'az' && azVersion === null) throw new Error('spawn az ENOENT');
    if (cmd === 'az' && argv.includes('--version')) return azVersion;
    if (cmd === 'az' && argv.includes('account show')) {
      if (azUser === null) throw new Error('Please run az login');
      return azUser;
    }
    throw new Error(`unexpected command: ${cmd} ${argv}`);
  };
}

// `pac org who` runs through the async execFile so its cold start overlaps the az probes. The
// callback is deferred with setImmediate, like a real child that exits while the synchronous az
// calls hold the event loop.
function makeExecFile({ pacOrg = null }, calls) {
  return (cmd, args, _opts, cb) => {
    calls.push(`start ${cmd} ${(args || []).join(' ')}`);
    setImmediate(() => {
      calls.push(`done ${cmd}`);
      if (cmd !== 'pac' || pacOrg === null) cb(new Error(`spawn ${cmd} ENOENT`), '', '');
      else cb(null, pacOrg, '');
    });
    return { stdin: { end() {} } };
  };
}

async function run({ argv = [], exec = {}, whoAmI, whoAmIThrows }) {
  const calls = [];
  const cli = loadCli(scriptPath, {
    argv,
    requires: {
      'child_process': { execFileSync: makeExec(exec, calls), execFile: makeExecFile(exec, calls) },
      './lib/dataverse-auth': {
        parseArgs: require('../lib/dataverse-auth.js').parseArgs,
        validateFlags: require('../lib/dataverse-auth.js').validateFlags,
        getAuthToken: (url) => {
          calls.push(`token ${url}`);
          return 'token-value';
        },
        dataverseRequest: async () => {
          calls.push('whoami');
          if (whoAmIThrows) throw new Error(whoAmIThrows);
          return whoAmI || { status: 200, data: { UserId: 'u-1', OrganizationId: 'o-1' } };
        },
      },
    },
  });
  // emit() always exits 0 so callers can parse stdout; the harness turns that into a throw.
  try {
    await cli.main();
  } catch (e) {
    if (e.exitCode === undefined) throw e;
  }
  const result = JSON.parse(cli.stdoutText());
  // Non-enumerable, so assertions on the emitted payload never see it.
  Object.defineProperty(result, 'calls', { value: calls });
  return result;
}

test('a missing az CLI blocks with az_missing, and no token or WhoAmI is attempted', async () => {
  const r = await run({ argv: ['--env', ENVURL], exec: { azVersion: null } });
  assert.equal(r.ok, false);
  assert.equal(r.blocker, 'az_missing');
  assert.match(r.message, /aka\.ms\/azure-cli/);
  assert.ok(!r.calls.some((c) => c.startsWith('token ') || c === 'whoami'), r.calls.join(' | '));
});

test('az installed but logged out blocks with az_not_logged_in', async () => {
  const r = await run({ argv: ['--env', ENVURL], exec: { azUser: null } });
  assert.equal(r.blocker, 'az_not_logged_in');
  assert.match(r.message, /az login/);
  // `az --version` is what tells "logged out" apart from "not installed".
  assert.ok(r.calls.includes('az --version'), r.calls.join(' | '));
});

test('a working az login costs ONE az call before WhoAmI: `az --version` only classifies a failure', async () => {
  const r = await run({ argv: ['--env', ENVURL], exec: { pacOrg: 'Connected as maker@contoso.com\n' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.calls.filter((c) => c.startsWith('az ')), ['az account show --query user.name -o tsv']);
});

test('pac org who starts before the az probes, and the WhoAmI token is warmed while it runs', async () => {
  // Measured cold starts on Windows: pac org who ~7 s, each az call ~3-5 s. Run one after another the
  // preflight cost ~19 s at the start of every run; overlapped it costs about the slower branch.
  const r = await run({ argv: ['--env', ENVURL], exec: { pacOrg: 'Connected as maker@contoso.com\n' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.calls, [
    'start pac org who',
    'az account show --query user.name -o tsv',
    `token ${ENVURL}`,
    'done pac',
    'whoami',
  ]);
});

test('without --env the token is not warmed early, because the env URL comes from pac', async () => {
  const r = await run({ exec: { pacOrg: `Connected as maker@contoso.com\nOrg URL: ${ENVURL}/\n` } });
  assert.equal(r.ok, true);
  assert.ok(!r.calls.some((c) => c.startsWith('token ')), r.calls.join(' | '));
});

test('a missing pac login is a WARNING for the app-builder path, not a blocker', async () => {
  // The build/verify/teardown flow authenticates with the az token; only the genpage pages phase
  // shells out to pac. Blocking here would stop a build that would have worked.
  const r = await run({ argv: ['--env', ENVURL], exec: { pacOrg: null } });
  assert.equal(r.ok, true);
  assert.equal(r.blocker, null);
  assert.equal(r.pacUser, null);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /genpage/i);
});

test('--require-pac turns the same missing pac login into a hard block', async () => {
  const r = await run({ argv: ['--env', ENVURL, '--require-pac'], exec: { pacOrg: null } });
  assert.equal(r.ok, false);
  assert.equal(r.blocker, 'pac_not_logged_in');
  assert.match(r.message, /pac auth create/);
});

test('the env URL is recovered from `pac org who` when --env is omitted', async () => {
  // Parses the pac banner:  Connected as maker@contoso.com  /  Org URL: https://contoso.crm.dynamics.com/
  const r = await run({
    exec: { pacOrg: `Connected as maker@contoso.com\nOrg URL: ${ENVURL}/\n` },
  });
  assert.equal(r.ok, true);
  assert.equal(r.envUrl, ENVURL, 'the trailing slash is stripped');
  assert.equal(r.pacUser, 'maker@contoso.com');
  assert.equal(r.identitiesMatch, true);
});

test('no --env and no pac Org URL blocks with no_env_url', async () => {
  const r = await run({ exec: { pacOrg: 'Connected as maker@contoso.com\n' } });
  assert.equal(r.blocker, 'no_env_url');
  assert.match(r.message, /--env/);
});

test('a WhoAmI transport failure is whoami_error, not a 401', async () => {
  // Distinct because the operator action differs: a transport failure is a network/URL problem,
  // a 401 is a stale token.
  const r = await run({ argv: ['--env', ENVURL], whoAmIThrows: 'getaddrinfo ENOTFOUND' });
  assert.equal(r.blocker, 'whoami_error');
  assert.match(r.message, /ENOTFOUND/);
});

test('WhoAmI 401 says refresh the token; 403 says fix access', async () => {
  const r401 = await run({ argv: ['--env', ENVURL], whoAmI: { status: 401, data: {} } });
  assert.equal(r401.blocker, 'whoami_401');
  assert.match(r401.message, /az login/);

  const r403 = await run({ argv: ['--env', ENVURL], whoAmI: { status: 403, data: {} } });
  assert.equal(r403.blocker, 'whoami_403');
});

test('the 403 hint names the identity mismatch when az and pac differ', async () => {
  // This is the single most common real cause, and the hint must name BOTH identities and the
  // exact command to align them — a generic "access denied" sends the user to an admin instead.
  const r = await run({
    argv: ['--env', ENVURL],
    exec: { azUser: 'dev@contoso.com', pacOrg: 'Connected as maker@contoso.com\n' },
    whoAmI: { status: 403, data: {} },
  });
  assert.equal(r.identitiesMatch, false);
  assert.match(r.message, /dev@contoso\.com/);
  assert.match(r.message, /az login --username maker@contoso\.com/);
});

test('a 403 with MATCHING identities points at environment access, not at re-login', async () => {
  const r = await run({
    argv: ['--env', ENVURL],
    exec: { azUser: 'maker@contoso.com', pacOrg: 'Connected as maker@contoso.com\n' },
    whoAmI: { status: 403, data: {} },
  });
  assert.equal(r.identitiesMatch, true);
  assert.match(r.message, /added to the env/i);
  assert.doesNotMatch(r.message, /az login --username/);
});

test('an unexpected non-2xx status is reported with its status code', async () => {
  const r = await run({ argv: ['--env', ENVURL], whoAmI: { status: 500, data: {} } });
  assert.equal(r.blocker, 'whoami_error');
  assert.match(r.message, /500/);
  assert.equal(r.whoAmI.ok, false);
});

test('a clean run reports ok with the WhoAmI identity ids', async () => {
  const r = await run({
    argv: ['--env', ENVURL],
    exec: { pacOrg: 'Connected as maker@contoso.com\n' },
    whoAmI: { status: 200, data: { UserId: 'u-1', OrganizationId: 'o-1' } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.blocker, null);
  assert.deepEqual(r.whoAmI, { ok: true, userId: 'u-1', organizationId: 'o-1' });
  assert.match(r.message, /Ready \(az \+ pac both signed in/);
});

test('a mismatched-but-working identity is reported as ready WITH the caveat', async () => {
  // WhoAmI passed, so this is not a blocker — but entity creation can still 403 later, and the
  // message has to carry that forward or the user has no way to connect the two events.
  const r = await run({
    argv: ['--env', ENVURL],
    exec: { azUser: 'dev@contoso.com', pacOrg: 'Connected as maker@contoso.com\n' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.identitiesMatch, false);
  assert.match(r.message, /different identities/);
  assert.match(r.message, /403/);
});