#!/usr/bin/env node

// Consolidated auth + connectivity pre-flight for the entity-creation flow.
// Runs every check the orchestrator needs in Phase 2a so the agent gets one
// structured result instead of stringing together shell commands.
//
// Usage:
//   node check-auth.js [<envUrl>]
//
// If <envUrl> is omitted, the script tries to read it from `pac org who`.
//
// Output (stdout JSON, exit 0 even on auth failure — failures are in the fields):
//   {
//     "ok": true|false,
//     "blocker": null | "az_missing" | "az_not_logged_in" | "pac_not_logged_in"
//                     | "no_env_url" | "whoami_403" | "whoami_401" | "whoami_error",
//     "message": "human-readable next step",
//     "azUser": "...",
//     "pacUser": "...",
//     "envUrl": "...",
//     "identitiesMatch": true|false,
//     "whoAmI": { "ok": true, "userId": "...", "organizationId": "..." }
//   }
//
// Exit code 0 always (so callers can parse stdout). Use `ok` field to gate.

const { execFileSync } = require('child_process');
const { dataverseRequest } = require('./lib/dataverse-auth');

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
  let envUrl = process.argv[2] || null;

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

  // 2) pac user + env URL
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
    return emit(
      buildResult({
        azUser,
        envUrl,
        blocker: 'pac_not_logged_in',
        message: 'PAC CLI is not logged in. Run `pac auth create --environment <url>` to authenticate.',
      })
    );
  }
  if (!envUrl) {
    return emit(
      buildResult({
        azUser,
        pacUser,
        blocker: 'no_env_url',
        message: 'Could not determine the Dataverse environment URL. Pass it as the first argument or set the active pac profile to an env.',
      })
    );
  }

  const identitiesMatch = normalizeUser(azUser) === normalizeUser(pacUser);

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
        blocker: 'whoami_401',
        message: 'Dataverse rejected the token (401). Run `az login` again to refresh.',
      })
    );
  }
  if (whoRes.status === 403) {
    const hint = identitiesMatch
      ? `WhoAmI returned 403 even though az and pac identities match (${azUser}). The user may need to be added to the env directly.`
      : `WhoAmI returned 403. az is signed in as "${azUser}" but pac is using "${pacUser}". Run \`az login --username ${pacUser}\` so both clients use the same identity.`;
    return emit(
      buildResult({
        azUser,
        pacUser,
        envUrl,
        identitiesMatch,
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
        whoAmI: { ok: false, status: whoRes.status, message: whoRes.data?.error?.message || '' },
        blocker: 'whoami_error',
        message: `WhoAmI returned unexpected status ${whoRes.status}.`,
      })
    );
  }

  return emit({
    ok: true,
    blocker: null,
    message: identitiesMatch
      ? `Ready (az + pac both signed in as ${azUser}, env ${envUrl}).`
      : `Ready, but az ("${azUser}") and pac ("${pacUser}") use different identities. WhoAmI passed so this works for now — but if entity creation later returns 403, run \`az login --username ${pacUser}\` to align them.`,
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

main();
