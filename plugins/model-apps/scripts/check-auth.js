#!/usr/bin/env node

// Consolidated auth + connectivity pre-flight for the entity-creation flow.
// Runs every check the orchestrator needs in Phase 2a so the agent gets one
// structured result instead of stringing together shell commands.
//
// Usage:
//   node check-auth.js [--env <envUrl>] [<envUrl>] [--require-pac]
//
// The env URL may be passed as `--env <url>` (the flag build/verify/teardown use) or positionally;
// if omitted, the script tries to read it from `pac org who`. Pass `--require-pac` (genpage) to make
// a missing pac login a hard blocker; without it (app-builder), pac is only a warning.
//
// Output (stdout JSON, exit 0 even on auth failure — failures are in the fields):
//   {
//     "ok": true|false,
//     "blocker": null | "az_missing" | "az_not_logged_in" | "pac_not_logged_in"
//                     | "no_env_url" | "whoami_403" | "whoami_401" | "whoami_error",
//     "message": "human-readable next step",
//     "warnings": ["..."],
//     "azUser": "...",
//     "pacUser": "...",
//     "envUrl": "...",
//     "identitiesMatch": true|false,
//     "whoAmI": { "ok": true, "userId": "...", "organizationId": "..." }
//   }
//
// PAC login is NOT required to pass: the app-builder build/verify/teardown flow authenticates to
// Dataverse with the `az` token (the SDK's az-token HttpClient), and WhoAmI below is the
// authoritative test. PAC is only needed for the genpage `pages` phase (`pac model genpage ...`),
// so a missing/for-different-identity pac login is surfaced as a WARNING, not a hard blocker.
//
// Exit code 0 always (so callers can parse stdout). Use `ok` field to gate.

const { execFileSync } = require('child_process');
const { dataverseRequest } = require('./lib/dataverse-auth');

// Read the env URL from either `--env <url>` (the flag the build/verify/teardown scripts use) or
// the first positional arg, so a caller can copy the `--env` form here without silently passing
// the literal string "--env" as the URL (the prior positional-only parse did exactly that).
function parseEnvUrl(argv) {
  const flagIdx = argv.indexOf('--env');
  if (flagIdx !== -1) {
    const value = argv[flagIdx + 1];
    // `--env --require-pac` used to treat the next flag as the URL, sending a bogus Dataverse
    // request to a flag string. A value-bearing flag must have a following non-flag token.
    if (value && !value.startsWith('--')) return value;
    return null;
  }
  const positional = argv.find((a) => !a.startsWith('--'));
  return positional || null;
}

function runQuiet(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }).trim();
  } catch {
    return null;
  }
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

function buildResult(partial) {
  const base = {
    ok: false,
    blocker: null,
    message: '',
    warnings: [],
    azUser: null,
    pacUser: null,
    envUrl: null,
    identitiesMatch: false,
    whoAmI: null,
  };
  return Object.assign(base, partial);
}

function normalizeUser(u) {
  return (u || '').trim().toLowerCase();
}

async function main() {
  const argv = process.argv.slice(2);
  let envUrl = parseEnvUrl(argv);
  // Genpage deploys pages via `pac model genpage ...`, so its callers pass --require-pac to keep a
  // missing pac login a hard blocker. The app-builder build path only needs the az token, so it
  // omits the flag and a missing pac login is downgraded to a warning.
  const requirePac = argv.includes('--require-pac');
  const warnings = [];

  // 1) az presence + login
  const azVersion = runQuiet('az', ['--version']);
  if (azVersion == null) {
    return emit(
      buildResult({
        blocker: 'az_missing',
        message: 'Azure CLI (`az`) is not installed. Install it from https://aka.ms/azure-cli and run `az login`.',
      })
    );
  }
  const azUser = runQuiet('az', ['account', 'show', '--query', 'user.name', '-o', 'tsv']);
  if (!azUser) {
    return emit(
      buildResult({
        blocker: 'az_not_logged_in',
        message: 'Azure CLI is installed but not logged in. Run `az login` with the same identity as your active `pac auth` profile.',
      })
    );
  }

  // 2) pac user + env URL (best-effort — pac is NOT required for the Dataverse build path)
  const pacOrg = runQuiet('pac', ['org', 'who']);
  let pacUser = null;
  if (pacOrg) {
    const m = pacOrg.match(/Connected as\s+([^\s\r\n]+)/i);
    if (m) pacUser = m[1];
    if (!envUrl) {
      const urlMatch = pacOrg.match(/Org URL:\s*(https:\/\/[^\s]+)/i);
      if (urlMatch) envUrl = urlMatch[1].replace(/\/+$/, '');
    }
  }
  if (!pacUser) {
    if (requirePac) {
      // Genpage caller (--require-pac): pac is genuinely required to upload pages, so keep the hard block.
      return emit(
        buildResult({
          azUser,
          envUrl,
          warnings,
          blocker: 'pac_not_logged_in',
          message: 'PAC CLI is not logged in. Run `pac auth create --environment <url>` to authenticate.',
        })
      );
    }
    // App-builder path: not a blocker — the build/verify/teardown flow uses the az token, not pac.
    // Only the genpage `pages` phase shells out to `pac model genpage`. Warn so a genpage run isn't surprised.
    warnings.push(
      'PAC CLI is not logged in. This is only required for the genpage `pages` phase (`pac model genpage ...`); ' +
        'table/column/form/view/app builds authenticate with the az token. Run `pac auth create --environment <url>` if you need genpage.'
    );
  }
  if (!envUrl) {
    return emit(
      buildResult({
        azUser,
        pacUser,
        warnings,
        blocker: 'no_env_url',
        message: 'Could not determine the Dataverse environment URL. Pass it as `--env <url>` (or the first argument), or set the active pac profile to an env.',
      })
    );
  }

  // Identity match only applies when pac is actually logged in.
  const identitiesMatch = pacUser ? normalizeUser(azUser) === normalizeUser(pacUser) : false;

  // 3) WhoAmI — authoritative test
  let whoRes;
  try {
    whoRes = await dataverseRequest(envUrl, 'GET', 'WhoAmI', null, { timeout: 30000 });
  } catch (e) {
    return emit(
      buildResult({
        azUser,
        pacUser,
        envUrl,
        identitiesMatch,
        warnings,
        blocker: 'whoami_error',
        message: `WhoAmI probe failed: ${e.message}`,
      })
    );
  }

  if (whoRes.status === 401) {
    return emit(
      buildResult({
        azUser,
        pacUser,
        envUrl,
        identitiesMatch,
        warnings,
        blocker: 'whoami_401',
        message: 'Dataverse rejected the token (401). Run `az login` again to refresh.',
      })
    );
  }
  if (whoRes.status === 403) {
    const hint = identitiesMatch
      ? `WhoAmI returned 403 even though az and pac identities match (${azUser}). The user may need to be added to the env directly.`
      : pacUser
        ? `WhoAmI returned 403. az is signed in as "${azUser}" but pac is using "${pacUser}". Run \`az login --username ${pacUser}\` so both clients use the same identity.`
        : `WhoAmI returned 403. az is signed in as "${azUser}" but that identity lacks access to ${envUrl}. Sign in with an identity that has access, or ask an admin to add it to the environment.`;
    return emit(
      buildResult({
        azUser,
        pacUser,
        envUrl,
        identitiesMatch,
        warnings,
        whoAmI: { ok: false, status: 403, message: whoRes.data?.error?.message || '' },
        blocker: 'whoami_403',
        message: hint,
      })
    );
  }
  if (whoRes.status < 200 || whoRes.status >= 300) {
    return emit(
      buildResult({
        azUser,
        pacUser,
        envUrl,
        identitiesMatch,
        warnings,
        whoAmI: { ok: false, status: whoRes.status, message: whoRes.data?.error?.message || '' },
        blocker: 'whoami_error',
        message: `WhoAmI returned unexpected status ${whoRes.status}.`,
      })
    );
  }

  const readyMessage = !pacUser
    ? `Ready (az signed in as ${azUser}, env ${envUrl}). PAC is not logged in — only needed for the genpage pages phase.`
    : identitiesMatch
      ? `Ready (az + pac both signed in as ${azUser}, env ${envUrl}).`
      : `Ready, but az ("${azUser}") and pac ("${pacUser}") use different identities. WhoAmI passed so this works for now — but if entity creation later returns 403, run \`az login --username ${pacUser}\` to align them.`;
  return emit({
    ok: true,
    blocker: null,
    message: readyMessage,
    warnings,
    azUser,
    pacUser,
    envUrl,
    identitiesMatch,
    whoAmI: {
      ok: true,
      userId: whoRes.data?.UserId,
      organizationId: whoRes.data?.OrganizationId,
    },
  });
}

// Run only as a CLI; when required from a test, expose the pure helpers instead.
if (require.main === module) {
  main();
}

module.exports = { parseEnvUrl };
