#!/usr/bin/env node
'use strict';
// list-languages: the languages an environment has provisioned, each with its culture code and text direction, and
// the environment's base language — what the generative-page planner decides localization from. It is the planner's
// only source of them: there is no `pac model list-languages` fallback behind it, because every /genpage page operation
// goes through the SDK and needs the Azure CLI this script reads with.
//
// The SDK's `getEnvironmentLanguages()` answers LCIDs only: three read-only GETs through the org client, in the order
// base, provisioned, available — nothing cached, nothing written, no workspace used. Culture codes and the
// right-to-left flag are the host's to map (lib/lcid-cultures.js); an LCID that table does not name stays numeric,
// has no code or direction, and is reported in `unmapped` — never guessed.
//
// The read is strict. An answer the SDK cannot read as a list of languages fails with `ENVIRONMENT_LANGUAGES_UNREADABLE`
// and a failure of the read with its own error, so a caller never receives an English default in their place.
//
// A failure is therefore a LOUD one — exit 1, `ok: false`, nothing on stdout that reads as an answer — and it ends the
// language detection: the planner reports why and stops, and never assumes the environment is English-only. The most
// common cause is the Azure CLI (missing, signed out, slow, or signed in to another tenant); the message says which.
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

const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { withThrowawaySdk } = require('./lib/throwaway-sdk.js');
const { describeEnvironmentLanguages } = require('./lib/lcid-cultures.js');

const USAGE = 'Usage: node scripts/list-languages.js --env <envUrl>';

/**
 * Reads the environment's languages through the vendored SDK and describes them in the planner's terms.
 * @param {string} env - a Dataverse https origin
 * @param {object} [httpClient] - the SDK's HttpClient; the az-token one for `env` when omitted (a test seam)
 */
async function readLanguages(env, httpClient) {
  // The SDK needs a workspace although this read never touches it; the throwaway one is lib/throwaway-sdk.js's.
  return withThrowawaySdk({ env, httpClient, prefix: 'list-languages-' }, async (make) => describeEnvironmentLanguages(await make().getEnvironmentLanguages()));
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
