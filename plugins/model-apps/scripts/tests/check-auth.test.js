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
    'az_timeout',
    'pac_not_logged_in',
    'pac_timeout',
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
// What execFile hands the callback when `timeout` elapses: the child was killed, with the kill signal.
const timedOut = (cmd) => Object.assign(new Error(`Command failed: ${cmd}`), { killed: true, signal: 'SIGTERM', code: null });

function makeExecFile({ pacOrg = null, azUser = 'maker@contoso.com', azVersion = 'azure-cli 2.60.0', slow = [], notOnPath = [] }, calls) {
  return (cmd, args, opts, cb) => {
    const argv = (args || []).join(' ');
    // Starting a CLI can also THROW instead of calling back — Node's execFile throws synchronously on some launch
    // errors. check-auth must read that throw like any launch failure, never crash on it.
    if (notOnPath.includes(cmd)) {
      calls.push(`not on PATH: ${cmd} ${argv}`);
      throw Object.assign(new Error(`spawn ${cmd} ENOENT: not found on PATH`), { code: 'ENOENT' });
    }
    if (slow.some((what) => `${cmd} ${argv}`.includes(what))) {
      calls.push(`${cmd} ${argv} (timeout ${opts && opts.timeout})`);
      process.nextTick(() => cb(timedOut(`${cmd} ${argv}`), '', ''));
      return { stdin: { end() {} }, kill() { calls.push(`kill ${cmd} ${argv}`); } };
    }
    if (cmd === 'az' && argv.includes('account show')) {
      calls.push(`az ${argv}`);
      process.nextTick(() => {
        if (azVersion === null) cb(new Error('spawn az ENOENT'), '', '');
        else if (azUser === null) cb(new Error('Please run az login'), '', '');
        else cb(null, azUser, '');
      });
      return { stdin: { end() {} }, kill() {} };
    }
    if (cmd === 'az' && argv.includes('--version')) {
      calls.push(`az ${argv}`);
      process.nextTick(() => {
        if (azVersion === null) cb(new Error('spawn az ENOENT'), '', '');
        else cb(null, azVersion, '');
      });
      return { stdin: { end() {} }, kill() {} };
    }
    calls.push(`start ${cmd} ${argv}`);
    setTimeout(() => {
      calls.push(`done ${cmd}`);
      if (cmd !== 'pac' || pacOrg === null) cb(new Error(`spawn ${cmd} ENOENT`), '', '');
      else cb(null, pacOrg, '');
    }, 0);
    return { stdin: { end() {} }, kill() { calls.push(`kill ${cmd} ${argv}`); } };
  };
}

function makeCancelableExecFile({ pacOrg = null, azUser = 'maker@contoso.com', azVersion = 'azure-cli 2.60.0', pacTimer = false, pacDelayMs = null }, calls) {
  return (cmd, args, _opts, cb) => {
    const argv = (args || []).join(' ');
    calls.push(`start ${cmd} ${argv}`);
    const child = {
      killed: false,
      stdin: { end() {} },
      kill() { this.killed = true; calls.push(`kill ${cmd} ${argv}`); },
    };
    if (cmd === 'pac') {
      let settled = false;
      const finish = (fn) => {
        if (settled || child.killed) return;
        settled = true;
        fn();
      };
      if (pacTimer) {
        setTimeout(() => finish(() => {
          calls.push(`timeout ${cmd}`);
          cb(new Error('pac timed out'), '', '');
        }), 5);
      }
      const finishSuccess = () => finish(() => {
        calls.push(`done ${cmd}`);
        if (pacOrg === null) cb(new Error(`spawn ${cmd} ENOENT`), '', '');
        else cb(null, pacOrg, '');
      });
      if (pacDelayMs !== null) setTimeout(finishSuccess, pacDelayMs);
      else setImmediate(finishSuccess);
      return child;
    }
    setImmediate(() => {
      if (child.killed) return;
      calls.push(`done ${cmd}`);
      if (cmd === 'az' && argv.includes('--version')) {
        if (azVersion === null) cb(new Error('spawn az ENOENT'), '', '');
        else cb(null, azVersion, '');
      } else if (cmd === 'az' && argv.includes('account show')) {
        if (azUser === null) cb(new Error('Please run az login'), '', '');
        else cb(null, azUser, '');
      } else {
        cb(new Error(`unexpected command: ${cmd} ${argv}`), '', '');
      }
    });
    return child;
  };
}

async function run({ argv = [], exec = {}, whoAmI, whoAmIThrows, tokenFailure = null }) {
  const calls = [];
  const cli = loadCli(scriptPath, {
    argv,
    requires: {
      // check-auth starts every CLI through the process runner; its execFileAsync keeps execFile's shape.
      './lib/process-runner': { execFileAsync: makeExecFile(exec, calls), runSync: makeExec(exec, calls) },
      './lib/dataverse-auth': {
        parseArgs: require('../lib/dataverse-auth.js').parseArgs,
        validateFlags: require('../lib/dataverse-auth.js').validateFlags,
        getAuthToken: (url) => {
          calls.push(`token ${url}`);
          return 'token-value';
        },
        getAuthTokenAsync: async (url) => {
          calls.push(`token ${url}`);
          return tokenFailure ? null : 'token-value';
        },
        tokenFailureKind: () => tokenFailure,
        tokenFailureMessage: (url, fallback) => (tokenFailure === 'timeout' ? `token for ${url} timed out` : fallback),
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

async function runWithAsyncChildren({ argv = [], exec = {}, token, whoAmI } = {}) {
  const calls = [];
  const cli = loadCli(scriptPath, {
    argv,
    requires: {
      './lib/process-runner': {
        runSync: () => { throw new Error('sync child processes must not be used by check-auth'); },
        execFileAsync: makeCancelableExecFile(exec, calls),
      },
      './lib/dataverse-auth': {
        parseArgs: require('../lib/dataverse-auth.js').parseArgs,
        validateFlags: require('../lib/dataverse-auth.js').validateFlags,
        getAuthToken: () => { throw new Error('sync token acquisition must not be used by check-auth'); },
        getAuthTokenAsync: async (url) => {
          calls.push(`token ${url}`);
          return typeof token === 'function' ? token(calls) : 'token-value';
        },
        tokenFailureKind: () => null,
        tokenFailureMessage: (url, fallback) => fallback,
        dataverseRequest: async () => {
          calls.push('whoami');
          return whoAmI || { status: 200, data: { UserId: 'u-1', OrganizationId: 'o-1' } };
        },
      },
    },
  });
  try {
    await cli.main();
  } catch (e) {
    if (e.exitCode === undefined) throw e;
  }
  const result = JSON.parse(cli.stdoutText());
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

// A launch that THROWS instead of calling back (Node's execFile does, synchronously, for some launch errors) is a verdict
// like any other launch failure — here az_missing — not a crash of the pre-flight.
test('an az launch that throws synchronously still blocks with a verdict (az_missing)', async () => {
  const r = await run({ argv: ['--env', ENVURL], exec: { notOnPath: ['az'] } });
  assert.equal(r.ok, false);
  assert.equal(r.blocker, 'az_missing');
  assert.ok(r.calls.some((c) => c.startsWith('not on PATH: az ')), r.calls.join(' | '));
  assert.ok(!r.calls.some((c) => c.startsWith('token ') || c === 'whoami'), r.calls.join(' | '));
});

test('az installed but logged out blocks with az_not_logged_in', async () => {
  const r = await run({ argv: ['--env', ENVURL], exec: { azUser: null } });
  assert.equal(r.blocker, 'az_not_logged_in');
  assert.match(r.message, /az login/);
  // `az --version` is what tells "logged out" apart from "not installed".
  assert.ok(r.calls.includes('az --version'), r.calls.join(' | '));
});

// A slow Azure CLI is reported as SLOW. A cached-token read was measured at 44.6 s on a busy machine,
// past the old 30 s budget; check-auth then called the installed CLI "not installed" (az_missing), and
// the token path said "run az login" — neither of which fixes anything.
test('an az probe that runs out of time blocks with az_timeout — not az_missing or az_not_logged_in', async () => {
  for (const slow of ['account show', '--version']) {
    const exec = slow === '--version' ? { azUser: null, slow: ['az --version'] } : { slow: ['az account show'] };
    const r = await run({ argv: ['--env', ENVURL], exec });
    assert.equal(r.ok, false, slow);
    assert.equal(r.blocker, 'az_timeout', slow);
    assert.match(r.message, /did not answer within 60 s[\s\S]*POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS=120000/, slow);
    assert.ok(r.calls.some((c) => /\(timeout 60000\)$/.test(c)), `the az budget is 60 s: ${r.calls.join(' | ')}`);
    assert.ok(r.calls.includes('kill pac org who'), `the pac probe is cancelled: ${r.calls.join(' | ')}`);
    assert.ok(!r.calls.some((c) => c.startsWith('token ') || c === 'whoami'), r.calls.join(' | '));
  }
  // An account-show timeout is not followed by `az --version`: nothing it answers changes the verdict.
  const r = await run({ argv: ['--env', ENVURL], exec: { slow: ['az account show'] } });
  assert.ok(!r.calls.includes('az --version'), r.calls.join(' | '));
});

test('POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS sets the az budget', async () => {
  const saved = process.env.POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS;
  process.env.POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS = '90000';
  try {
    const r = await run({ argv: ['--env', ENVURL], exec: { slow: ['az account show'] } });
    assert.ok(r.calls.includes('az account show --query user.name -o tsv (timeout 90000)'), r.calls.join(' | '));
    assert.match(r.message, /within 90 s[\s\S]*=180000/);
  } finally {
    if (saved === undefined) delete process.env.POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS;
    else process.env.POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS = saved;
  }
});

test('a token read that runs out of time is az_timeout, without a second wait inside WhoAmI', async () => {
  const warmed = await run({ argv: ['--env', ENVURL], exec: { pacOrg: 'Connected as maker@contoso.com\n' }, tokenFailure: 'timeout' });
  assert.equal(warmed.blocker, 'az_timeout');
  assert.match(warmed.message, /token for https:\/\/contoso\.crm\.dynamics\.com timed out/);
  assert.ok(!warmed.calls.includes('whoami'), warmed.calls.join(' | '));
  // With the env URL from pac nothing is warmed, and WhoAmI reads the token — a timeout there too is az_timeout.
  const viaPac = await run({ exec: { pacOrg: `Connected as maker@contoso.com\nOrg URL: ${ENVURL}/\n` }, whoAmIThrows: 'token timed out', tokenFailure: 'timeout' });
  assert.equal(viaPac.blocker, 'az_timeout');
  assert.equal(viaPac.message, 'token timed out');
  // Any other token failure is still WhoAmI's to report.
  const other = await run({ argv: ['--env', ENVURL], whoAmIThrows: 'getaddrinfo ENOTFOUND', tokenFailure: 'failed' });
  assert.equal(other.blocker, 'whoami_error');
});

test('a pac probe that runs out of time says so: pac_timeout under --require-pac, a warning otherwise', async () => {
  const required = await run({ argv: ['--env', ENVURL, '--require-pac'], exec: { slow: ['pac org who'] } });
  assert.equal(required.blocker, 'pac_timeout');
  assert.match(required.message, /pac org who` did not answer within 60 s/);
  assert.ok(required.calls.includes('pac org who (timeout 60000)'), required.calls.join(' | '));
  const optional = await run({ argv: ['--env', ENVURL], exec: { slow: ['pac org who'] } });
  assert.equal(optional.ok, true);
  assert.match(optional.warnings[0], /did not answer within 60 s[\s\S]*unknown, not missing/);
  // The ready message agrees with the warning: a slow pac's login is unknown, never "not logged in".
  assert.match(optional.message, /PAC's login is unknown/);
  assert.doesNotMatch(optional.message, /not logged in/);
  const signedOut = await run({ argv: ['--env', ENVURL], exec: {} });
  assert.match(signedOut.message, /PAC is not logged in/, 'a pac that answered without a login is still "not logged in"');
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

test('pac success is delivered even when async az/token work takes longer than pac timeout', async () => {
  const r = await runWithAsyncChildren({
    argv: ['--env', ENVURL, '--require-pac'],
    exec: { pacOrg: 'Connected as maker@contoso.com\n', pacTimer: true },
    token: () => new Promise((resolve) => setTimeout(() => resolve('token-value'), 20)),
  });
  assert.equal(r.ok, true);
  assert.equal(r.pacUser, 'maker@contoso.com');
  assert.notEqual(r.blocker, 'pac_not_logged_in');
});

test('az_missing cancels the pending pac probe before emitting', async () => {
  const r = await runWithAsyncChildren({
    argv: ['--env', ENVURL],
    exec: { azUser: null, azVersion: null, pacOrg: 'Connected as maker@contoso.com\n', pacDelayMs: 50 },
  });
  assert.equal(r.blocker, 'az_missing');
  assert.ok(r.calls.indexOf('kill pac org who') !== -1, r.calls.join(' | '));
  assert.ok(!r.calls.includes('done pac'), r.calls.join(' | '));
});

test('az_not_logged_in cancels the pending pac probe before emitting', async () => {
  const r = await runWithAsyncChildren({
    argv: ['--env', ENVURL],
    exec: { azUser: null, azVersion: 'azure-cli 2.60.0', pacOrg: 'Connected as maker@contoso.com\n', pacDelayMs: 50 },
  });
  assert.equal(r.blocker, 'az_not_logged_in');
  assert.ok(r.calls.includes('kill pac org who'), r.calls.join(' | '));
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