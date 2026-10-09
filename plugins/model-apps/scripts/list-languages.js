#!/usr/bin/env node
'use strict';
// list-languages: the languages an environment has provisioned, each with its culture code and text direction, and
// the environment's base language — what the generative-page planner decides localization from. It is the planner's
// first choice, with `pac model list-languages` as its fallback.
//
// The SDK's `getEnvironmentLanguages()` answers LCIDs only: three read-only GETs through the org client, in the order
// base, provisioned, available — nothing cached, nothing written, no workspace used. Culture codes and the
// right-to-left flag are the host's to map (lib/lcid-cultures.js); an LCID that table does not name stays numeric,
// has no code or direction, and is reported in `unmapped` — never guessed.
//
// The read is strict. An answer the SDK cannot read as a list of languages fails with `ENVIRONMENT_LANGUAGES_UNREADABLE`
// and a failed read with its own error, so a caller never receives an English default in their place.
//
// The planner takes this script as the PREFERRED source of the languages, never the only one. When it exits non-zero —
// whatever the reason, most often the Azure CLI (missing, signed out, slow, or signed in to another tenant), which
// `/genpage` has never needed for a page over existing tables or mock data — the planner runs
// `pac model list-languages --environment '<envUrl>'` instead, which signs in through `pac`. So a failure here must
// stay a LOUD one (exit 1, `ok: false`, nothing on stdout that reads as an answer) and is never the end of a run:
// agents/genpage-planner.md, "Detect Configured Languages".
//
// Like every script here it emits no telemetry of its own (the plugin's hooks do), and it never prints a token.
//
// Usage: node scripts/list-languages.js --env <envUrl>
//   --env  the environment's https origin, e.g. https://contoso.crm.dynamics.com
//
// Output (stdout, one JSON line), exit 0:
//   { "ok": true,
//     "baseLanguage": { "lcid": 1033, "code": "en-US", "name": "English (United States)", "rtl": false },
//     "languages": [ { "lcid": 1033, "code": "en-US", "name": "English (United States)", "rtl": false },
//                    { "lcid": 1025, "code": "ar-SA", "name": "Arabic (Saudi Arabia)", "rtl": true } ],
//     "unmapped": [],
//     "summary": [ "1033 en-US — RTL: No", "1025 ar-SA — RTL: Yes" ] }
//   `languages` are the PROVISIONED languages, in the server's order — the ones labels and pages can be written in.
//   `name` is the English name from this host's Intl and is null when it has none; `code` and `rtl` come from the table.
//   The line is pure ASCII: every other character (the dash in `summary`, an accented name) is a `\uXXXX` escape, which
//   any JSON parser reads back as itself. A raw one is garbled by the code page of the console that captures it —
//   Windows PowerShell 5.1 reads a child's stdout as OEM text — and the planner copies these lines into its plan.
//
// Exit codes: 0 read; 1 usage error (stderr names the flag, stdout stays empty) or a failure to read — stdout then holds
//   { "ok": false, "error": "<message>", "code": "<SDK error code, when it has one>" } and stderr the message.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { describeEnvironmentLanguages } = require('./lib/lcid-cultures.js');

const USAGE = 'Usage: node scripts/list-languages.js --env <envUrl>';

/**
 * Reads the environment's languages through the vendored SDK and describes them in the planner's terms.
 * @param {string} env - a Dataverse https origin
 * @param {object} [httpClient] - the SDK's HttpClient; the az-token one for `env` when omitted (a test seam)
 */
async function readLanguages(env, httpClient) {
  // `createMakerSdk` requires a workspace storage although this read never touches it (the SDK's design: "no
  // workspace, no cache"). So the storage points at a throwaway directory that is removed whichever way the read
  // ends — the same shape ai-preflight.js has, which the temp-workspace lifecycle scan in sdk-async-surface.test.js
  // holds every such script to.
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-languages-'));
  try {
    const { createMakerSdk, createNodeWorkspaceStorage } = require('./vendor/cds-maker-sdk.cjs');
    const sdk = createMakerSdk({
      workspaceStorage: createNodeWorkspaceStorage(workspaceDir),
      instanceUrl: env,
      httpClient: httpClient || createAzHttpClient(env),
    });
    return describeEnvironmentLanguages(await sdk.getEnvironmentLanguages());
  } finally {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // Cleanup of a directory nothing was written to must not turn a successful read into a failure.
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const flagError = validateFlags(argv, { known: ['env'], needValue: ['env'] });
  if (flagError) {
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  if (!flags.env) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }
  let env;
  try {
    env = requireDataverseOrigin(flags.env);
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n${USAGE}\n`);
    process.exit(1);
  }

  // emitResult() ends the process, so the read's outcome is settled first and emitted outside the try: an exit inside
  // it would be caught as a failure of the read.
  let languages;
  let failure;
  try {
    languages = await readLanguages(env);
  } catch (err) {
    failure = err;
  }
  if (failure) {
    const code = failure && typeof failure.code === 'string' ? failure.code : undefined;
    emitResult(false, { ok: false, error: String((failure && failure.message) || failure), ...(code ? { code } : {}) }, { ascii: true });
    return;
  }
  for (const lcid of languages.unmapped) {
    process.stderr.write(`⚠ LCID ${lcid} has no culture code in this plugin's table, so its code and text direction are unknown (reported as null, not guessed).\n`);
  }
  emitResult(true, { ok: true, ...languages }, { ascii: true });
}

module.exports = { readLanguages };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
