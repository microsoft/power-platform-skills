#!/usr/bin/env node
'use strict';
// solution-settings: the deployment settings of a solution — the file that says which connection each connection reference binds to and
// which value each environment variable takes in the environment a solution is imported into — and the import that applies it. Replaces
// `pac solution create-settings` and `pac solution import --settings-file` (skills/genpage/SKILL.md, Phase 6.7: the deployer supplies each
// ConnectionId at import).
//
//   template  writes the settings file for a solution package: every environment variable (`SchemaName`, an empty `Value`, and pac's
//             informational `DefaultValue`, `TypeId`, `IsRequired`) and every connection reference (`LogicalName`, an empty `ConnectionId`,
//             `ConnectorId`) the package holds, sorted by name, in pac's own format — so a settings file pac wrote, and one this wrote, are
//             read alike by both. The package is read the way the platform reads it: staged in the environment (`StageSolution`; nothing is
//             imported, and the staging copy is deleted), so `--env` is the environment to stage in — the one the solution was exported
//             from, when it can be, because a package with a missing dependency does not stage. With `--solution` the script exports the
//             solution from `--env` first; with `--package` it reads a zip you already have. Without `--env` there is nothing to stage in,
//             and the zip is read by pac, offline (`pac solution create-settings --solution-zip`).
//   import    imports a package into `--env` and applies the settings file IN the import (`ComponentParameters`), after checking that every
//             filled entry names a variable or connection reference of the package (the platform would otherwise apply it to whatever the
//             environment holds under that name). An entry left empty overrides nothing.
//
// pac's defaults, for the flags `pac solution import` takes: a plain synchronous import that overwrites no unmanaged customizations
// (--force-overwrite off), activates no plug-ins or workflows (--activate-plugins off), skips no dependency check, is not a holding
// solution or an upgrade, does not publish the changes afterwards, and skips nothing for a lower version. None of them is a flag here.
//
// SDK first, pac as the fallback — only where the SDK REFUSES (lib/sdk-first.js is the rule):
//   template  SOLUTION_STAGING_FAILED, SOLUTION_STAGING_UNREADABLE: the platform's staging would not take, or answered what the SDK cannot
//             read with certainty. pac reads the zip itself, offline.
//   import    SOLUTION_STAGING_UNREADABLE, and a settings file with a feature pac applies and the SDK does not (a non-empty Workflows,
//             CanvasApps or CopilotAgents list, a ConnectionInstance): pac imports it. The feature is found in the FILE, and the SDK's error
//             is taken for this refusal only when it is exactly the sentence the SDK words for that feature — a settings key or a name that
//             merely contains the phrase is a failure, not a feature. A package that did not pass staging
//             (SOLUTION_STAGING_FAILED, with the dependencies it is missing) is NOT retried by pac — the platform has said it cannot be
//             imported there.
//             What pac is given of the settings is a PRIVATE COPY of the bytes this run read (importThroughPac), in a folder of the run's own that is removed afterwards — never the path: the staging that
//             comes before the SDK's refusal takes as long as the platform takes, and a file saved in that time is one the sanitizer was not built from. An edit made during the run is neither applied nor
//             printed; `applied` names the entries of the file that was read, which is the file pac imported.
// Any other failure is reported with the SDK's own code and is never answered by pac.
//
// ExportSolution, StageSolution and ImportSolution are sent EXACTLY ONCE (solutionHttpClient): they are long-running, a gateway can answer 502, 504 or 401
// for work the platform accepted and is still doing, and a second send is a second import of the same job, a second staging copy, or a refusal that hides what the
// first one did. The first answer is the SDK's, with its status and code. When it does not say how the import ended (no answer, 401, 408, any 5xx) the failure says
// the import was sent once and names its job, and the job's log is read once for the platform's own reason (never failing the report if it cannot be read).
//
// The one exception is an ImportSolution the platform REFUSED TO START: HTTP 429 with the Dataverse error code of "Cannot start the requested operation … because there is another … running at this
// moment" (LOCK_REFUSAL_CODES) — a publish, or another import, holds the environment's customization lock. Such an import is sent again, under a NEW job id, but only after `GET importjobs(<id>)` for the
// id the refused send carried answers 404, which proves it never started: at most five sends in all, after 10, 20, 40 and 60 s (or the platform's Retry-After, when that asks for longer). Any other
// answer — another status, another kind of 429, a gateway's 5xx, no answer, a job that exists or a read that fails — is the first and the last send, as above. See `sendImport`.
//
// What the output holds of the settings file: entry NAMES, and what the sanitizer lets through of a text that quotes a value — which is less than every value, as follows. The file is read from
// and written to disk only, and every text another party wrote — the SDK's, the platform's, pac's, a job log's — goes through `sanitizer`, WHOLE, before it is shown. What it does with a value depends
// on what is KNOWN of the variable (secrecyOf): the package's own definition — the type the staging reply the SDK reads gives it — decides, never the file's optional `TypeId`, which can only add secrecy.
//   - a SECRET (the package says so, or the file's TypeId does): a text that quotes the value, at any length, as it is or in any form decoding it gives (JSON string escapes, XML character
//     references, percent-encoding), in any case, is withheld whole;
//   - a variable the package was not read for (the pac fallback, a staging reply that could not be read, a name the package does not define): the same from six characters on — what a Secret-type
//     variable holds is the location of a Key Vault secret, far longer — and, for a shorter value, a text that has it as a WHOLE WORD is withheld (edges that are letters, digits, marks or
//     underscores must not touch another one: a one-letter value would otherwise withhold every message that holds the letter);
//   - a variable the package says is not a secret, and a connection id: replaced by `<redacted>` where the text spells it as it is (the text is withheld whole when only a decoded form holds it).
//     A value of that kind shorter than six characters is NOT hidden: it is a word as much as a value, and by the package's own definition there is nothing in it to protect.
// A token is never printed. What remains is stated, not hidden: a value of the second kind that is shorter than six characters is printed when a text quotes it glued to word characters or inside an
// escape the decoders do not read (`\042`, `%u0022`, `&#x22` without its `;`), and any value is printed when a text quotes only part of it, hashes or base64-encodes it, writes it as a named HTML
// entity beyond XML's five, normalizes its Unicode or nests the encodings more than three deep (a text of more than 1 MiB is withheld, not read). The whole-word rule has a cost too: a short value of the
// second kind that is itself a whole word of the SDK's own sentence about an entry (`none`, `is`, `the`) still withholds that sentence, and with it which entry is wrong — its status and code stay. A sentence
// the plugin builds itself — pac's label
// and exit status, the feature sentence that sends a file to pac — is not another party's text and is not looked at again. An import's failure is rebuilt from its parts (message, status, code, job),
// so nothing attached to the SDK's own error object travels with it.
//
// Usage:
//   node scripts/solution-settings.js template --env <envUrl> --solution <uniqueName> --out <settings.json> [--force]
//   node scripts/solution-settings.js template --package <solution.zip> --out <settings.json> [--env <envUrl>] [--force]
//   node scripts/solution-settings.js import --env <envUrl> --package <solution.zip> --settings <settings.json>
//   --env       the environment's https origin, e.g. https://contoso.crm.dynamics.com
//   --solution  the unique name of an unmanaged solution in --env
//   --package   a solution .zip
//   --out       where the settings file is written; an existing file is not replaced unless --force is given (pac replaced it silently,
//               and with it every value already filled in)
//   --settings  the settings file to apply
//
// Output (stdout, one pure-ASCII JSON line), exit 0:
//   template  { "ok": true, "source": "sdk", "out": "<absolute path>", "environmentVariables": 2, "connectionReferences": 1 }
//   import    { "ok": true, "source": "sdk", "importJobId": "<guid>", "applied": { "environmentVariables": ["new_Url"], "connectionReferences": ["new_Dataverse"] } }
//   and, when the platform refused the import (another operation held its lock) and it was sent again: the same, with `importJobId` the job of the send that ran, "importAttempts": <sends>, and
//   "importRefusals": [ { "importJobId": "<guid>", "status": 429, "code": "0x80071151", "waitedMs": 10000 } ] — each refused send and the wait the run made after it. A first send that is taken
//   prints none of these two.
//   and, when pac answered because the SDK refused, "source": "pac" and "fallback": { "code": "<the SDK's code>", "message": "…" } — the SDK's own words, so
//   the "Nothing was imported" in one is about the SDK's attempt, which stopped before any request; pac then did the work;
//   "warnings": [...] when something the run made could not be cleaned up: the SDK could not delete the staged copy of the package it made, or `template` could not remove the temporary name its
//   file was written under (the file is complete; until that name is removed the file has two names, and writing it again is refused as a hard link), or the folder a pac fallback worked in
//   could not be removed (after the bounded retry a Windows lock needs; the warning names its path and what is in it — the package the SDK exported, pac's template, the copy of the settings file pac
//   was given, which is emptied first so that it keeps no value — to delete). For pac `applied` lists the entries the file filled (pac does not report what it applied).
//
// Exit codes: 0 done; 1 usage error (stderr names the flag, stdout stays empty) or a failure — stdout then holds
//   { "ok": false, "error": "<message>", "code": "<the SDK's or the PAC step's code>" [, "status": <HTTP status of the answer>] [, "fallback": { … }, "importJobId": "<guid>"]
//     [, "importAttempts": <sends>, "importRefusals": [ … ] — when the import was sent again after a refusal, the same two fields as on success; the failure is then the platform's own refusal or the
//     failure of the last send, with the count added] [, "warnings": [...]] } and stderr the message. `warnings` is the same cleanup note as on success: a failed run that staged a copy and could not delete it says so.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs, validateFlags, emitResult, requireDataverseOrigin, makeRequest, webApiUrl } = require('./lib/dataverse-auth.js');
const { createAzHttpClient, retryAfterMs, scrubBearer } = require('./lib/sdk-http-client.js');
const { sdkFirst } = require('./lib/sdk-first.js');
const { runPac } = require('./lib/pac-fallback.js');
const { assertPlainFileTarget, assertSafeOutputDir, writeFileSafe, removeTreeWithRetry } = require('./lib/safe-fs.js');
const { makeTempWorkspace } = require('./lib/temp-workspace.js');

const USAGE = [
  'Usage:',
  '  node scripts/solution-settings.js template --env <envUrl> --solution <uniqueName> --out <settings.json> [--force]',
  '  node scripts/solution-settings.js template --package <solution.zip> --out <settings.json> [--env <envUrl>] [--force]',
  '  node scripts/solution-settings.js import --env <envUrl> --package <solution.zip> --settings <settings.json>',
].join('\n');

const COMMAND_FLAGS = {
  template: { known: ['env', 'solution', 'package', 'out', 'force'], needValue: ['env', 'solution', 'package', 'out'] },
  import: { known: ['env', 'package', 'settings'], needValue: ['env', 'package', 'settings'] },
};

// A solution's unique name: a letter, then letters, digits and underscores (what the platform accepts; scripts/provision-solution.js enforces it too).
const SOLUTION_UNIQUE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,64}$/;
// A guard against reading an unexpectedly large file into memory, not a limit of the service: the package is held, then held again as base64.
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 5 * 1024 * 1024;
// Every ZIP's first entry starts with a local file header, `PK\x03\x04`: a file that does not is not a solution package.
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// How long ExportSolution, StageSolution and ImportSolution may stay silent. They are the platform's long-running actions: an import of a
// real solution takes minutes, and the HTTP client's usual five-minute limit would end the wait — and, were they not sent once (solutionHttpClient), SEND IT
// AGAIN: a second import of the same job id, or a second staging copy left behind. pac's own longest wait for an import is 60 minutes (`--max-async-wait-time`).
const ACTION_TIMEOUT_MS = 60 * 60 * 1000;
const LONG_ACTION = /\/(ExportSolution|StageSolution|ImportSolution)$/;

// The ONE exception to "sent exactly once" (solutionHttpClient): an ImportSolution that the platform REFUSED TO START is sent again, under a new import job id. The refusal is HTTP 429 with one of
// these Dataverse error codes — matched as the code the Web API gives, never as English text. The answer has the Web API's error shape, with the words the platform reported for an import sent during a publish:
//   { "error": { "code": "0x80071151", "message": "Cannot start the requested operation [Import] because there is another [Publish] running at this moment. Use Solution History for more details.
//                                                  -- The solution installation or removal failed due to the installation or removal of another solution at the same time. Please try again later." } }
// The platform's error reference names them (https://learn.microsoft.com/power-apps/developer/data-platform/reference/web-service-error-codes):
//   0x80071151  SolutionConcurrencyFailure — the code the whole two-part message above carries on the live answers it was captured from (a solution uninstall refused while a table delete's customization was
//               still running; a delete in a change set). An ImportSolution refused during a publish gets the same words, and its code is taken to be the same: one that is not listed is sent once, as every answer was.
//   0x8004F061  CustomizationLockEx_BothUnknown, 0x8004F062 _BlockedUnknown, 0x8004F063 _BothKnownSame ("Cannot start another [{0}] because there is a previous [{1}] running at this moment"),
//   0x8004F064  _BothKnownDifferent ("Cannot start the requested operation [{0}] because there is another [{1}] running at this moment"), 0x8004F067 _BlockingUnknown — the lock's own refusals
// Left out on purpose: 0x80071154 ConcurrentOperationFailure ("The current {0} operation FAILED due to another concurrent operation": an operation that failed had started), the customization lock of
// other services (0x8004F077, 0x80090412) and the service protection limits (0x80072321, 0x80072322, 0x80072326), a 429 of another kind with another remedy: those are sent once, as every answer was.
// A code in this list says the import was refused; it is the job that proves it (importJobIsAbsent), because a refusal is what the platform SAYS and a gateway can say a good deal.
const LOCK_REFUSAL_CODES = Object.freeze(['0x80071151', '0x8004F061', '0x8004F062', '0x8004F063', '0x8004F064', '0x8004F067']);
// How many times one import is sent in all — the first send and up to four more — and how long the run waits before each of those: 10 s, 20 s, 40 s and 60 s, two and a half minutes in all, or the
// platform's `Retry-After` when that is longer (retryAfterMs caps it at a minute; see https://learn.microsoft.com/power-apps/developer/data-platform/api-limits#retry-operations). A publish of all
// customizations, the usual holder of the lock, is over in a minute or two; an import that holds it can run much longer, and the run then ends as it always did, with the platform's refusal.
const IMPORT_MAX_SENDS = 5;
const IMPORT_RESEND_WAITS_MS = Object.freeze([10 * 1000, 20 * 1000, 40 * 1000, 60 * 1000]);

const REDACTED = '<redacted>';
// The length from which a value is looked for as text. A value that is KNOWN not to be a secret and is shorter than this is not hidden from a message: it would be taken out of ordinary words
// ("1", "true"), and a message with every digit blanked explains nothing — by the package's own definition there is nothing in it to protect. A value whose type is NOT known is looked for as a
// secret from this length on (what a Secret-type variable holds is the location of a Key Vault secret — a subscription id, a resource group, a vault and a secret name — never a short string; and a text of
// plain words does not hold a string of six characters or more that it does not quote) and, below it, as a whole word. A SECRET is hidden whatever its length (secrecyOf), and so is every connection id
// (every id there is, is longer than this).
// See: https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables-azure-key-vault-secrets
const MIN_HIDDEN_LENGTH = 6;
// The most of one text the sanitizer reads — a message, a few lines of a log; pac's own stderr can be megabytes. A text longer than this is withheld whole, not cut: a value that
// straddled the cut would leave its first half in what is shown.
const MAX_SANITIZED_CHARS = 1024 * 1024;
// `environmentvariabledefinition.type` option 100000005, "Secret" — what pac and the SDK write as `TypeId` in a settings file for a variable that holds a secret.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/environmentvariabledefinition (the `type` choices)
const SECRET_TYPE_ID = 100000005;
// How long a failed import waits for its job's log before reporting without it: the log only explains a failure that is already known.
const JOB_LOG_TIMEOUT_MS = 20 * 1000;

// ---------------------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The request an argv asks for, or `{ error }` naming what is wrong with it — before any file is written, process started or request sent.
 */
function readRequest(argv) {
  const [command, ...rest] = argv;
  if (command !== 'template' && command !== 'import') {
    return { error: command === undefined ? 'a command is required: template or import' : `unknown command '${command}': use template or import` };
  }
  const contract = COMMAND_FLAGS[command];
  const flagError = validateFlags(rest, contract);
  if (flagError) return { error: flagError };
  const { positional, flags } = parseArgs(rest);
  if (positional.length > 0) return { error: `unexpected argument '${positional[0]}'` };
  // A boolean flag takes no value, and parseArgs gives one to whatever follows it: `--force --out x` is fine, `--force x` is not.
  if (flags.force !== undefined && flags.force !== true) return { error: `--force takes no value (got '${flags.force}')` };

  let env;
  if (flags.env !== undefined) {
    try {
      env = requireDataverseOrigin(flags.env);
    } catch (err) {
      return { error: err.message };
    }
  }
  if (command === 'import') {
    const missing = ['env', 'package', 'settings'].find((name) => flags[name] === undefined);
    if (missing) return { error: `--${missing} is required` };
    return { request: { command, env, packagePath: path.resolve(flags.package), settingsPath: path.resolve(flags.settings) } };
  }

  if (flags.out === undefined) return { error: '--out is required' };
  if ((flags.solution === undefined) === (flags.package === undefined)) return { error: 'name the solution to export with --solution, or a package with --package — one of the two' };
  if (flags.solution !== undefined) {
    if (!env) return { error: '--solution needs --env: the solution is exported from that environment' };
    if (!SOLUTION_UNIQUE_NAME.test(flags.solution)) return { error: `--solution must be a solution's unique name: a letter, then letters, digits and underscores (got '${flags.solution}')` };
  }
  return {
    request: {
      command,
      env,
      solution: flags.solution,
      packagePath: flags.package === undefined ? undefined : path.resolve(flags.package),
      outPath: path.resolve(flags.out),
      force: flags.force === true,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------------

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The package, checked as far as a file can be: a regular file, not empty, not absurdly large, and a ZIP by its first bytes. The whole file is
// read only for a caller that sends it (`withBytes`). `maxBytes` is a seam for the test of the limit, which a 128 MiB file would otherwise need.
function inspectPackage(packagePath, { withBytes, maxBytes = MAX_PACKAGE_BYTES }) {
  let stat;
  try {
    stat = fs.statSync(packagePath);
  } catch (err) {
    throw fail('PACKAGE_UNREADABLE', `--package: ${packagePath} could not be read (${err.code || err.message}).`);
  }
  if (!stat.isFile()) throw fail('PACKAGE_UNREADABLE', `--package: ${packagePath} is not a file.`);
  if (stat.size === 0) throw fail('PACKAGE_UNREADABLE', `--package: ${packagePath} is empty.`);
  if (stat.size > maxBytes) throw fail('PACKAGE_UNREADABLE', `--package: ${packagePath} is larger than ${maxBytes / (1024 * 1024)} MiB, which this script does not read into memory.`);
  let bytes;
  let head;
  try {
    if (withBytes) {
      bytes = fs.readFileSync(packagePath);
      head = bytes.subarray(0, ZIP_SIGNATURE.length);
    } else {
      const fd = fs.openSync(packagePath, 'r');
      try {
        head = Buffer.alloc(ZIP_SIGNATURE.length);
        fs.readSync(fd, head, 0, head.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    throw fail('PACKAGE_UNREADABLE', `--package: ${packagePath} could not be read (${err.code || err.message}).`);
  }
  if (!head.equals(ZIP_SIGNATURE)) {
    throw fail('PACKAGE_UNREADABLE', `--package: ${packagePath} is not a solution package: it is not a .zip file (it does not begin with PK).`);
  }
  return withBytes ? { bytes, base64: bytes.toString('base64') } : {};
}

// The problem with a settings object, naming the entry and the field and never the value: a file may hold a secret and this text is printed.
// Only the shape a deployment-settings file has is checked here (pac's: lists of entries with a name and a value); which keys it may carry, and
// whether each entry is one of the package's, is the SDK's check (and pac's), so a feature of the format that appears later is not refused by this copy.
function settingsProblem(settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return 'the file must hold one JSON object, { "EnvironmentVariables": [...], "ConnectionReferences": [...] }';
  if (settings.EnvironmentVariables === undefined && settings.ConnectionReferences === undefined) return 'the file has neither an "EnvironmentVariables" nor a "ConnectionReferences" list';
  const lists = [
    // [list, the key that names an entry, the key that fills it, whether what fills it is an identifier]
    ['EnvironmentVariables', 'SchemaName', 'Value', false],
    ['ConnectionReferences', 'LogicalName', 'ConnectionId', true],
  ];
  for (const [list, nameKey, valueKey, valueIsIdentifier] of lists) {
    const entries = settings[list];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) return `"${list}" must be a list`;
    for (let i = 0; i < entries.length; i += 1) {
      const at = `${list}[${i}]`;
      const entry = entries[i];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return `${at} must be an object`;
      const name = entry[nameKey];
      if (typeof name !== 'string' || name === '') return `${at}.${nameKey} must be a non-empty string`;
      if (name.trim() !== name) return `${at}.${nameKey} must not begin or end with white space`;
      const value = entry[valueKey];
      if (typeof value !== 'string') return `${at}.${valueKey} must be a string — empty to leave the entry unset`;
      // A connection id is an identifier, and the SDK refuses white space around one. An environment variable's value is TEXT — a JSON document that ends in a
      // newline, a string with leading spaces, one made of white space alone — and the SDK sends it as it is (api/SolutionApi.ts readOverrides checks only that it is
      // a string), so it is passed through byte for byte: what the file holds is what the environment gets.
      if (valueIsIdentifier && value.trim() !== value) return `${at}.${valueKey} must not begin or end with white space`;
    }
  }
  return null;
}

// A parsed settings file, or a failure naming the problem. UTF-8, with the byte order mark Windows tools add taken off (JSON.parse refuses it).
function parseSettings(text, where) {
  let settings;
  try {
    settings = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    throw fail('SETTINGS_INVALID', `${where} is not valid JSON.`);
  }
  const problem = settingsProblem(settings);
  if (problem) throw fail('SETTINGS_INVALID', `${where} is not a deployment-settings file: ${problem}.`);
  return settings;
}

// The settings file as the run reads it, ONCE: the parsed object and the BYTES it was parsed from. Everything later — the SDK's import, the sanitizer, `applied`, and the copy pac is given — is bound to this one
// reading, never to the path, which a maker or a deployment may save again while the run waits for the platform.
function readSettingsFile(settingsPath) {
  let stat;
  try {
    stat = fs.statSync(settingsPath);
  } catch (err) {
    throw fail('SETTINGS_UNREADABLE', `--settings: ${settingsPath} could not be read (${err.code || err.message}).`);
  }
  if (!stat.isFile()) throw fail('SETTINGS_UNREADABLE', `--settings: ${settingsPath} is not a file.`);
  if (stat.size > MAX_SETTINGS_BYTES) throw fail('SETTINGS_UNREADABLE', `--settings: ${settingsPath} is larger than ${MAX_SETTINGS_BYTES / (1024 * 1024)} MiB.`);
  const bytes = fs.readFileSync(settingsPath);
  return { settings: parseSettings(bytes.toString('utf8'), `--settings ${settingsPath}`), bytes };
}

/** The names of the entries a settings object FILLS in — a value or a connection id that is not empty — never what they are filled with. */
function filledNames(settings) {
  const names = (list, nameKey, valueKey) => (settings[list] || []).filter((entry) => entry[valueKey] !== '').map((entry) => entry[nameKey]);
  return {
    environmentVariables: names('EnvironmentVariables', 'SchemaName', 'Value'),
    connectionReferences: names('ConnectionReferences', 'LogicalName', 'ConnectionId'),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What may be printed
// ---------------------------------------------------------------------------------------------------------------------

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A variable's type as a number: the number itself, or its decimal text — the two forms the settings file's `TypeId` and a staged definition's `type` come in
// (api/SolutionApi.ts readTypeId of the vendored SDK) — else undefined.
function typeIdOf(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value);
  return undefined;
}

/**
 * What is KNOWN of whether a filled variable holds a secret — `'secret'`, `'plain'` or `'unknown'` — and so how a text that quotes its value is treated (sanitizer). The PACKAGE's own definition is the
 * evidence: the `type` it has in the StageSolution reply the SDK reads (`packageType`, recorded by recordStagedTypes). The file's `TypeId` is only informational: the SDK accepts it and ignores it
 * (api/SolutionApi.ts, VARIABLE_KEYS), a file may leave it out, and nothing checks it, so a value that is a secret must not depend on it. The file can therefore only ADD secrecy — a `TypeId` of Secret
 * where the package says another type, or says nothing — and never take it away; evidence only ever raises it.
 *   'secret'   the package's definition says Secret, or the file's `TypeId` does.
 *   'plain'    the package's definition says another type, and the file does not say Secret.
 *   'unknown'  no definition was read for it: the pac fallback (pac reads the package itself and tells the plugin nothing of its types), a staging reply the plugin could not read, a name the package does
 *              not define (the SDK refuses such an entry before it sends anything), or a name the reply lists twice with types that differ and none Secret (recordStagedTypes). It is not known to be
 *              anything else, so it is not treated as a value to ignore: see sanitizer for what that costs and what it leaves.
 */
function secrecyOf(entry, packageType) {
  if (packageType === SECRET_TYPE_ID || typeIdOf(entry.TypeId) === SECRET_TYPE_ID) return 'secret';
  return packageType === undefined ? 'unknown' : 'plain';
}

// What the StageSolution reply says each environment variable of the package is, by lower-cased schema name — the reply the SDK stages the package with before an import that fills
// anything in (api/SolutionApi.ts readStagedPackage), recorded as it passes through solutionHttpClient. Its shape, as the SDK reads it (measured):
//   { "StageSolutionResults": { "StageSolutionStatus": "Passed", "SolutionComponentsDetails": [
//       { "ComponentTypeName": "EnvironmentVariableDefinition",
//         "Attributes": { "Count": 3, "Keys": ["schemaname", "type", "defaultvalue"], "Values": ["new_Secret", "100000005", ""] } }, … ] } }
// Read leniently and never thrown from — what cannot be read is simply not recorded, and a variable with no recorded type is one the package's definition is not known for (secrecyOf) — and whatever the
// status: the types a failed staging still lists are as true as a passed one's. The SDK matches a settings entry to a definition by the lower-cased schema name too, so a name is recorded that way.
// A name the reply lists more than once is the one case where a reply contradicts itself. The SDK refuses such a reply (SOLUTION_STAGING_UNREADABLE, "listed twice") and pac imports instead, so this
// reader is the one whose record decides how pac's echo of a value is treated. Evidence only ever RAISES secrecy: Secret wins whatever else is said of the name, and when the types differ and none is
// Secret nothing is known of it — it is kept in the map with no type, which reads as 'unknown', and stays so if a later reply lists it again.
function recordStagedTypes(definitions, body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return;
  }
  const details = parsed && parsed.StageSolutionResults && parsed.StageSolutionResults.SolutionComponentsDetails;
  if (!Array.isArray(details)) return;
  const listed = new Map(); // lower-cased name -> the type each listing of it gives, `undefined` for one that cannot be read
  for (const element of details) {
    if (!element || typeof element.ComponentTypeName !== 'string' || element.ComponentTypeName.toLowerCase() !== 'environmentvariabledefinition') continue;
    const attributes = element.Attributes;
    if (!attributes || !Array.isArray(attributes.Keys) || !Array.isArray(attributes.Values) || attributes.Keys.length !== attributes.Values.length) continue;
    const valueOf = (key) => {
      const at = attributes.Keys.findIndex((candidate) => typeof candidate === 'string' && candidate.toLowerCase() === key);
      return at === -1 ? undefined : attributes.Values[at];
    };
    const name = valueOf('schemaname');
    if (typeof name !== 'string' || name === '') continue;
    const key = name.toLowerCase();
    listed.set(key, [...(listed.get(key) || []), typeIdOf(valueOf('type'))]);
  }
  for (const [name, types] of listed) {
    const votes = definitions.has(name) ? [definitions.get(name), ...types] : types;
    const type = mergedType(votes);
    // One listing whose type cannot be read records nothing; a name listed more than once is always recorded, if only as "not known".
    if (votes.length > 1 || type !== undefined) definitions.set(name, type);
  }
}

// The one type the listings of a name add up to: Secret when any of them says so, the type they all give when they agree, else nothing (undefined).
function mergedType(types) {
  if (types.includes(SECRET_TYPE_ID)) return SECRET_TYPE_ID;
  return types.every((type) => type === types[0]) ? types[0] : undefined;
}

// ---- Decoded views of a text -----------------------------------------------------------------------------------------
// A message that quotes a value rarely quotes it as it is: an error that includes JSON.stringify(value) writes a quote as `\"` — or, as any JSON encoder may, `\u0022` —, an XML log
// writes it `&quot;`, a URL `%22`, and any of these can sit inside another. A finite list of the spellings a value can take is a list whose missing entry someone finds (`\u0022`, the standard
// JSON escape of a double quote, is easy to leave out), so the TEXT is decoded instead and looked at in each decoded form — JSON string escapes, XML character references,
// percent-encoding — and in every combination of them a few levels deep; a value found in any of those views is found.

// A JSON string's escapes (https://www.rfc-editor.org/rfc/rfc8259#section-7): `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t` and `\uXXXX` in either hex case (Newtonsoft writes `\u003c`,
// System.Text.Json `\u003C`; a surrogate pair is two escapes, which joined are the character). `\'` and `\xHH` are not JSON but are how other serializers write a quote and a byte.
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(["'\\/bfnrt]))/g;
const JSON_SIMPLE_ESCAPES = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
function jsonUnescape(text) {
  return text.replace(JSON_ESCAPE, (whole, unicode, hex, simple) => (simple !== undefined ? JSON_SIMPLE_ESCAPES[simple] : String.fromCharCode(parseInt(unicode !== undefined ? unicode : hex, 16))));
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
// `&lt;`, `&amp;`, `&#39;` and `&#x27;`: what an XML attribute value holds in place of the characters it may not contain.
const decodeXml = (text) => text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));/gi, (whole, decimal, hex, name) => {
  if (name) return XML_ENTITIES[name.toLowerCase()];
  try {
    return String.fromCodePoint(decimal !== undefined ? Number(decimal) : parseInt(hex, 16));
  } catch {
    return whole; // not a character
  }
});

// `%XX` runs read as UTF-8 bytes. Leniently: a run that is not valid UTF-8 has its valid parts decoded all the same (the invalid bytes become U+FFFD), where decodeURIComponent throws for
// the whole run and would leave a `%22` standing beside a stray `%FF`. `plus` also reads `+` as a space, as a form encoding (application/x-www-form-urlencoded) writes one.
function percentDecode(text, plus) {
  const source = plus ? text.replace(/\+/g, ' ') : text;
  return source.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));
}

const VIEW_DECODERS = [jsonUnescape, decodeXml, (text) => percentDecode(text, false), (text) => percentDecode(text, true)];
// Four decoders three levels deep are at most 1 + 4 + 16 + 64 views, so the closure always fits and none is dropped; a text that is only plain has one.
const MAX_VIEW_DEPTH = 3;
const MAX_VIEWS = 100;

/** `text` itself, then each distinct text the decoders make of it, and of what they made, up to MAX_VIEW_DEPTH levels. */
function decodedViews(text) {
  const views = [text];
  const seen = new Set(views);
  let frontier = [text];
  for (let level = 0; level < MAX_VIEW_DEPTH && frontier.length > 0 && views.length < MAX_VIEWS; level += 1) {
    const next = [];
    for (const view of frontier) {
      for (const decode of VIEW_DECODERS) {
        const decoded = decode(view);
        if (seen.has(decoded)) continue;
        seen.add(decoded);
        views.push(decoded);
        next.push(decoded);
      }
    }
    frontier = next;
  }
  return views;
}

const collapseWhite = (text) => text.replace(/\s+/g, ' ');

// The characters of a WORD: letters, digits, combining marks and connector punctuation (so `_` is part of one) — the Unicode general categories L, N, M and Pc, which is what `\w` and `\b` are for a
// pattern that knows more than ASCII. A mark counts so that `e` is not found in `é` written as `e` and a combining accent.
// See: https://www.unicode.org/reports/tr44/#General_Category_Values and https://tc39.es/ecma262/#sec-runtime-semantics-unicodematchproperty-p (the `\p{…}` escapes)
const WORD_CLASS = '\\p{L}\\p{N}\\p{M}\\p{Pc}';
const WORD_CHARACTER = new RegExp(`^[${WORD_CLASS}]$`, 'u');

// The pattern that finds `needle` — in the case the views are in — only where it is a whole word, in the sense a word boundary has: a side needs a non-word neighbour (or the end of the text) only
// where the needle's OWN edge character is a word character. So `x` is not in `new_Text` or `box` but is in `'x'` and in `a x b`, and `-x-` IS in `a-x-b`: its edges are not word characters, so the
// text around it cannot glue it to a word. `u` makes the pattern read code points, so a letter outside the Basic Multilingual Plane is one character and not two halves.
function wholeWordPattern(needle) {
  const edges = Array.from(needle);
  const before = WORD_CHARACTER.test(edges[0]) ? `(?<![${WORD_CLASS}])` : '';
  const after = WORD_CHARACTER.test(edges[edges.length - 1]) ? `(?![${WORD_CLASS}])` : '';
  return new RegExp(`${before}${escapeRegExp(needle)}${after}`, 'u');
}

// Whether a value is in any of `views`, as a substring (`substring`) or only as a whole word (`token`: see wholeWordPattern). Case does not matter — a service may normalise it (a GUID is quoted
// in lower case, an identifier in the case it is stored in), and a value is not less a secret for being written in another case: both look in the same lower-cased views — and, for a value that
// holds white space, runs of white space are made one on both sides (a service may join the lines of a value or collapse its spaces).
function quoter(views) {
  const lower = views.map((view) => view.toLowerCase());
  let collapsed = null;
  // `finder(needle)` makes the function that says whether a view holds `needle`.
  const search = (value, finder) => {
    const needle = value.toLowerCase();
    if (lower.some(finder(needle))) return true;
    if (!/\s/.test(value)) return false;
    if (collapsed === null) collapsed = lower.map(collapseWhite);
    return collapsed.some(finder(collapseWhite(needle)));
  };
  return {
    substring: (value) => search(value, (needle) => (view) => view.includes(needle)),
    token: (value) => search(value, (needle) => {
      const pattern = wholeWordPattern(needle);
      return (view) => view.includes(needle) && pattern.test(view);
    }),
  };
}

// The strings to look for, in three sets, by what is known of the variable (secrecyOf) and how long the value is:
//   secrets  looked for as a SUBSTRING of a text, in every decoded view; a text that holds one is withheld whole. A secret, at any length; a value whose type is not known, from MIN_HIDDEN_LENGTH on.
//   tokens   looked for as a WHOLE WORD, in the same views; a text that holds one is withheld whole. A value whose type is not known and is shorter than MIN_HIDDEN_LENGTH: a substring test would find "x"
//            in every message that has an x in it, and withhold the SDK's own account of which entry is wrong; the whole-word test finds it where it stands alone. (A secret that is not known to be one and
//            is that short is rare — a Key Vault reference, which a secret holds, is long — and this is what protects it.)
//   others   REPLACED by `<redacted>` where a text spells them: a connection id and a value that is known not to be a secret, from MIN_HIDDEN_LENGTH on; a shorter value of that kind is left to ordinary words.
// A value is looked for as it is and trimmed (a service may trim it); one of white space alone has nothing in it to repeat.
function filledValues(settings, definitions) {
  const secrets = new Set();
  const tokens = new Set();
  const others = new Set();
  const take = (value, secrecy) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const trimmed = value.trim();
    const long = trimmed.length >= MIN_HIDDEN_LENGTH;
    if (secrecy === 'unknown' && !long) {
      tokens.add(trimmed);
      return;
    }
    if (secrecy === 'plain' && !long) return;
    for (const form of new Set([value, trimmed])) (secrecy === 'plain' ? others : secrets).add(form);
  };
  for (const entry of (settings && settings.EnvironmentVariables) || []) {
    if (entry === null || typeof entry !== 'object') continue;
    const packageType = typeof entry.SchemaName === 'string' ? definitions.get(entry.SchemaName.toLowerCase()) : undefined;
    take(entry.Value, secrecyOf(entry, packageType));
  }
  for (const entry of (settings && settings.ConnectionReferences) || []) {
    if (entry !== null && typeof entry === 'object') take(entry.ConnectionId, 'plain');
  }
  return { secrets, tokens, others };
}

/**
 * A function that takes what the settings file holds out of a text before anything shows it. The file may hold a secret (an environment variable of a secret type carries its secret as
 * its value), and every text a run prints that another party wrote comes from the SDK, the platform, pac or a job's log, which can quote what they were given — in the shape they were given it or in
 * another (see "Decoded views"). So nothing they say is shown without this, and the WHOLE text is read: no part of it is taken to be trusted because of how it looks. A text that begins like
 * the SDK's own "HTTP 400 from <url>:" has said nothing about where it came from, so the one piece of text kept in front of a withheld one — the SDK's status line — is the caller's
 * `lead`, built from the SDK error's own fields (see sdkLead), and is used only when the text really begins with it. What is done depends on what is KNOWN of each variable (secrecyOf):
 *   - a text that quotes a SECRET value, in any decoded view and in any case, is not shown at all — what takes its place says it was withheld. Complete scrubbing of another party's text cannot be
 *     guaranteed, and what such a text is evidence of is that the service quotes its input, so the rest of it is not trusted either. The status and the code of a failure are separate
 *     fields and stay. The same for a variable whose type is NOT known (the pac fallback, a reply that could not be read, a name the package does not define) from MIN_HIDDEN_LENGTH characters on;
 *   - a value of that kind SHORTER than that is looked for as a whole word only (filledValues): "x" is withheld from `'x'` and from `a x b` and not from `new_Text`, so a one-letter value does
 *     not withhold every message with that letter in it, and a message that says which entry is wrong stays readable;
 *   - a connection id and a variable that is known not to be a secret are replaced by `<redacted>` where the text spells them as it is (in any case); one found only in a decoded view cannot be taken
 *     out of the text it was decoded from, so that text is withheld as well. (A value of that kind shorter than MIN_HIDDEN_LENGTH is left alone — see there.)
 * What this leaves, stated: a value shorter than MIN_HIDDEN_LENGTH whose type is not known is printed when a text quotes it glued to word characters (`ValuePIN42was`, `key_PIN42`) or inside an escape the decoders
 * do not read (`\042PIN42\042`, `%u0022PIN42%u0022`, `&#x22PIN42&#x22` with no `;`) — a Secret-type value is long, so this is a gap for a value that is not known to be a secret, not for one that is — and
 * a value that is known not to be a secret and is shorter than MIN_HIDDEN_LENGTH is printed wherever a text quotes it. What the whole-word rule costs: a value shorter than MIN_HIDDEN_LENGTH whose type is not
 * known that is itself a whole word of the SDK's own sentence about an entry (`none`, `is`, `the`) still withholds that sentence — it is a word as much as a value — while the status and the code stay.
 * Which variables are secrets is decided by `definitions`: a Map of lower-cased schema name to the type of the package's own definition, which the import fills in as the SDK reads it
 * (recordStagedTypes) — looked at on every call, so a text sanitized after the package was read is judged by it. `what` names the text in the sentence that takes its place.
 * A sanitizer is for text ANOTHER PARTY wrote. A sentence the plugin builds itself from parts that were already looked at (pac's label and exit status around its redacted text; the "got no answer"
 * sentence around the transport's cleaned words) or from the file's keys (the feature sentence that sends a file to pac) holds no value and is not given to it: looking at a plugin's own words
 * again would withhold "(exit 1)" for a value of `1`.
 */
function sanitizer(settings, definitions = new Map()) {
  return function sanitize(text, what = 'text', lead = '') {
    const whole = String(text == null ? '' : text);
    const { secrets, tokens, others } = filledValues(settings, definitions);
    if (secrets.size === 0 && tokens.size === 0 && others.size === 0) return whole;
    const kept = lead && whole.startsWith(lead) ? lead : '';
    const withheld = (why) => `${kept}<${what} withheld: ${why}>`;
    if (whole.length > MAX_SANITIZED_CHARS) return withheld('it is too long to check against the settings file');
    const quoted = quoter(decodedViews(whole));
    if ([...secrets].some(quoted.substring) || [...tokens].some(quoted.token)) return withheld('it repeated a value from the settings file');
    if (others.size === 0) return whole;
    // Longest first inside one alternation, so a value that contains another is taken out whole; and one pass, so what replaces a value is never searched again; in either case, as the
    // search above is. `split` leaves the text between the values: joined by the marker it is what is shown; joined by a NUL, which stands in for a removed value without being able to
    // complete another one, it is what is checked again in its decoded views — so the marker (a value may be a piece of the word "redacted") is never taken for a value that was left behind.
    const alternation = [...others].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    const between = whole.split(new RegExp(alternation, 'i'));
    if ([...others].some(quoter(decodedViews(between.join('\u0000'))).substring)) return withheld('it repeated a value from the settings file');
    return between.join(REDACTED);
  };
}

// ConnectionError's own words for an answer that is not a success, and for a request that got none (errors/index.ts of the SDK):
//   HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.0/ImportSolution: <what the service said>
//   Transport failure reaching https://contoso.crm.dynamics.com/api/data/v9.0/ImportSolution: <what the transport said>
// What comes before the colon is made of the request the SDK sent — the status and the URL, which are fields of the error — so it holds nothing from the file; what follows is another
// party's text. The lead is REBUILT from the error's own `statusCode` and `url` and kept only when the message really begins with it; it is never read out of the message's text,
// so no text — a job log's, pac's, a warning, or the rest of the message itself — can declare a piece of itself to be the SDK's.
function sdkLead(error) {
  if (!(error instanceof Error) || typeof error.url !== 'string' || !Number.isInteger(error.statusCode) || typeof error.message !== 'string') return '';
  const lead = error.statusCode > 0 ? `HTTP ${error.statusCode} from ${error.url}: ` : `Transport failure reaching ${error.url}: `;
  return error.message.startsWith(lead) ? lead : '';
}

const outExists = (outPath, leftoverNote) => fail('OUT_EXISTS', `--out: ${outPath} already exists. Choose another file, or pass --force to replace it (a replaced file loses every value already filled in).${leftoverNote ? ` ${leftoverNote}` : ''}`);

// Where a run's settings file is written: checked BEFORE anything is read from the environment, so a refusal costs nothing. (The check is repeated at the
// moment the file is installed — see writeTemplate — because the work in between takes minutes and the file can appear meanwhile.)
function checkOutTarget(outPath, force) {
  assertSafeOutputDir(path.dirname(outPath));
  assertPlainFileTarget(outPath);
  if (fs.existsSync(outPath) && !force) throw outExists(outPath);
}

// ---------------------------------------------------------------------------------------------------------------------
// The SDK's refusals
// ---------------------------------------------------------------------------------------------------------------------

const refusalOf = (error) => ({ code: error.code, message: String(error.message) });

// What the SDK throws for a package it cannot read in this environment (api/SolutionApi.ts of the vendored SDK):
//   SOLUTION_STAGING_FAILED      StageSolution answered that the package did not pass here (missing dependencies, validation): pac, which reads
//                                the zip itself, can still make the template. An import is not retried: the platform has said it cannot go in.
//   SOLUTION_STAGING_UNREADABLE  StageSolution's reply was of a shape the SDK will not guess at.
function templateRefusal(error) {
  return error && (error.code === 'SOLUTION_STAGING_FAILED' || error.code === 'SOLUTION_STAGING_UNREADABLE') ? refusalOf(error) : null;
}

// The features of pac's settings file that the SDK does not apply (api/SolutionApi.ts: UNAPPLIED_LISTS and readOverrides). It accepts `Workflows`, `CanvasApps` and
// `CopilotAgents` only as EMPTY lists — which is what pac itself writes into a template, so an ordinary file passes — and refuses a `ConnectionInstance`
// in a connection reference. A file that holds one is one pac can import and the SDK cannot, and the SDK finds it before it sends anything ("Nothing was imported").
const PAC_LIST_FEATURES = ['Workflows', 'CanvasApps', 'CopilotAgents'];
const FEATURE_LIST_PROBLEM = 'is a pac feature this SDK does not apply: only an empty list is accepted';
const FEATURE_INSTANCE_PROBLEM = "is pac's connection-instance feature, which this SDK does not apply";
const featureSentence = (where, problem) => `importSolution: deploymentSettings is not a deployment-settings file this SDK applies — deploymentSettings.${where} ${problem}. Nothing was imported.`;

/**
 * The sentences the SDK refuses `settings` with, one for each feature of pac's that the FILE holds — a non-empty list under `Workflows`, `CanvasApps` or
 * `CopilotAgents`, or a `ConnectionInstance` in a connection reference — and none for any other fault of a file. Built here, from the file and the SDK's own
 * wording, so that what decides whether pac is asked is the file's content, and an error is taken for this refusal only when it IS this sentence: input can put a
 * phrase into a message (a settings key or a name the SDK quotes in another complaint) but cannot make that complaint read as this one.
 */
function pacOnlyFeatureMessages(settings) {
  const sentences = [];
  if (settings === null || typeof settings !== 'object') return sentences;
  for (const key of PAC_LIST_FEATURES) {
    if (Array.isArray(settings[key]) && settings[key].length > 0) sentences.push(featureSentence(key, FEATURE_LIST_PROBLEM));
  }
  const references = Array.isArray(settings.ConnectionReferences) ? settings.ConnectionReferences : [];
  references.forEach((entry, index) => {
    if (entry !== null && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'ConnectionInstance')) {
      sentences.push(featureSentence(`ConnectionReferences[${index}].ConnectionInstance`, FEATURE_INSTANCE_PROBLEM));
    }
  });
  return sentences;
}

// Why `error` is not the end of an import: `{ code, message }` when the SDK could not read the package's staging reply (SOLUTION_STAGING_UNREADABLE), or refused a
// feature that the `settings` file holds and pac applies. Anything else — the package did not pass staging (the platform said it cannot go in there, and pac would
// not import it either), a settings file that is merely wrong, a failed request — is a failure of the import.
// The wording is pinned against the real bundle in tests/solution-settings-real-bundle.test.js, so a re-vendored SDK that rephrases it fails there.
function importRefusal(error, settings) {
  if (!error) return null;
  if (error.code === 'SOLUTION_STAGING_UNREADABLE') return refusalOf(error);
  if (error.code === 'INVALID_ARGUMENT' && pacOnlyFeatureMessages(settings).includes(String(error.message))) return refusalOf(error);
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The org's HttpClient for the long-running solution actions
// ---------------------------------------------------------------------------------------------------------------------

// The sentence that sends a reader to the one place that says what became of an import whose answer was lost or not trustworthy.
const lookUpJob = (id) => ` Look up import job ${id} (importjobs(${id}) in the Web API, or the solution history in Maker) before importing again.`;

// The errors whose message the plugin composed itself, from text that was already looked at: a pac failure's message (importThroughPac) and the "got no answer" error of the long-action client
// (solutionHttpClient). `importFailure` does not give such a message to the sanitizer again: see there.
const COMPOSED_MESSAGE = new WeakSet();

// A client for ONE read: `sendOnce`, so a read that fails is not read again and the 401 refresh is not attempted. Both reads of an import job — the proof that a refused send did not start
// (importJobIsAbsent) and the log of a failed one (readImportJobFailure) — are made through it, over the same seams as the import's own client (`http`: getToken, request, sleep, now).
const readOnceClient = (env, http = {}) => createAzHttpClient(env, { ...http, sendOnce: () => true });

/**
 * The platform's refusal to START an import, from a raw transport answer: `{ status: 429, code }` — the code spelled as the error reference spells it — when the answer is HTTP 429 and its Dataverse
 * error body (`{ "error": { "code": "0x80071151", "message": "…" } }`) carries one of LOCK_REFUSAL_CODES, in either case of its hex digits; else null. Anything that does not say so — another status,
 * another code, a body that is not JSON or has no `error.code` text, the lock's English words under another code — is not a refusal to start, and the import is not sent again.
 */
function lockRefusalOf(res) {
  if (!res || res.error || res.statusCode !== 429) return null;
  let body = res.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body);
  } catch {
    return null;
  }
  const code = body && body.error && typeof body.error.code === 'string' ? body.error.code : null;
  const known = code === null ? undefined : LOCK_REFUSAL_CODES.find((candidate) => candidate.toLowerCase() === code.toLowerCase());
  return known ? { status: 429, code: known } : null;
}

// The job id an ImportSolution request carries, and the same request under another one. The body is the SDK's JSON text, and the package — a base64 string, up to ~170 MB — is nearly all of it, so the id is
// found and swapped as TEXT: parsing that body and writing it again would hold it twice more in memory. Every other byte stays what it was. The key appears once — the package is base64, and every other
// string in the body has its quotes escaped, so no text can spell `"ImportJobId":"` — and a body that has it any other number of times has no id, and so is never sent again.
const IMPORT_JOB_ID = /"ImportJobId":"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/g;
function importJobIdOf(body) {
  if (typeof body !== 'string') return null;
  const found = [...body.matchAll(IMPORT_JOB_ID)];
  return found.length === 1 ? found[0][1] : null;
}
const withImportJobId = (body, from, to) => body.replace(`"ImportJobId":"${from}"`, () => `"ImportJobId":"${to}"`);

/**
 * Whether the platform has NO import job with this id: `GET importjobs(<id>)` answered 404. "The ID of the import job that will be created to perform the import" is what the action's parameter is
 * (https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/importsolution), so an import that started has a job under the id it carried, and one that was refused has none.
 * ANY other answer is not proof and is `false`: the job exists, the read was refused (401, 403), it failed (5xx), it was throttled, it got no answer, no token could be had.
 */
async function importJobIsAbsent(env, importJobId, http) {
  try {
    const answer = await readOnceClient(env, http).get(webApiUrl(env, `importjobs(${importJobId})?$select=importjobid`));
    return answer.status === 404;
  } catch {
    return false;
  }
}

/**
 * Sends one ImportSolution request — and sends it AGAIN, under a NEW import job id, only while the platform's answer PROVES the import did not start. An import the platform may have accepted is
 * never sent twice (a gateway answers 502, 504 or 401 for an import it accepted and is running: the rule of solutionHttpClient); what is sent again is the one answer that says the platform
 * did not start it: its refusal because another operation holds the environment's customization lock (lockRefusalOf — the status and the Dataverse error code, not words), together with the
 * import job the refused send carried not existing (importJobIsAbsent), read after the wait, so that it is the latest evidence before a second copy leaves. Then, for at most IMPORT_MAX_SENDS sends:
 *   wait the step of IMPORT_RESEND_WAITS_MS, or the platform's `Retry-After` when that asks for longer  →  read the job  →  tell the listener  →  send again with a job id that was never used.
 * Whatever else answers — any other status, a 429 of another kind, a gateway's 5xx, no answer, a job that exists or cannot be read — is returned as it came, and the send is the last.
 * Returns `{ res, sent }`: the last answer, and the request that got it, whose job id is the one to look up.
 */
async function sendImport(send, options, { env, http, sleep, onRefused }) {
  let sent = options;
  for (let sends = 1; ; sends += 1) {
    const res = await send({ ...sent, timeout: ACTION_TIMEOUT_MS });
    const refusal = sends < IMPORT_MAX_SENDS ? lockRefusalOf(res) : null;
    const refusedId = refusal && importJobIdOf(sent.body);
    if (!refusedId) return { res, sent };
    const waitedMs = Math.max(IMPORT_RESEND_WAITS_MS[sends - 1], retryAfterMs(res.headers, (http.now || Date.now)()));
    await sleep(waitedMs);
    if (!(await importJobIsAbsent(env, refusedId, http))) return { res, sent };
    const nextImportJobId = crypto.randomUUID();
    onRefused({ importJobId: refusedId, status: refusal.status, code: refusal.code, waitedMs, nextImportJobId });
    sent = { ...sent, body: withImportJobId(sent.body, refusedId, nextImportJobId) };
  }
}

/**
 * The az-token client of `env`, with the three solution actions given an hour to answer and sent EXACTLY ONCE — but for the one answer that proves an import did not start (below).
 * The plain client re-sends a POST that got no answer after five minutes, and one whose answer was a 401 or a transient status (429, 500, 502, 503, 504).
 * For these actions every one of those is wrong (see ACTION_TIMEOUT_MS): a gateway answers 504 or 502 for an import the platform has accepted and is still
 * running, and a second send is a second import of the same job, a second staging copy left behind, or a refusal that hides what the first one did. So the
 * policy sits where the client decides to send again (`sendOnce`): the first answer is the SDK's — its status and its code survive — and an import whose
 * outcome is unknown is looked up, not repeated. A request that never got an answer is thrown here, naming the import job when there is one.
 * `observe.onStageReply(body)` is told the raw text of a StageSolution answer that arrived, before the SDK reads it: the package's own definitions (what type each environment
 * variable is) are in it, and an import needs them to know what is a secret (secrecyOf). It only listens — the answer goes on to the SDK untouched.
 * `observe.sanitize(text, what)` is given the transport's own words in the error of a request that got no answer ("Request timed out", a socket error): they are another party's text, so they are
 * looked at where they are read, and the sentence the plugin puts around them is its own and is marked as composed (COMPOSED_MESSAGE) so that it is not looked at again.
 * `observe.onImportRefused({ importJobId, status, code, waitedMs, nextImportJobId })` is what turns the one exception on, and the only caller that gives it is the import, which reports what it hears:
 * an ImportSolution the platform REFUSED TO START — HTTP 429 with a lock code (LOCK_REFUSAL_CODES) — is sent again when the import job its refused send carried does not exist (sendImport), and the
 * listener is told of each such send before it is made. Every other answer to ImportSolution, and every answer to the other two actions, is the first and the last send.
 */
function solutionHttpClient(env, deps = {}, observe = {}) {
  const send = deps.request || makeRequest;
  const sleep = deps.sleep || delay;
  return createAzHttpClient(env, {
    ...deps,
    sendOnce: (method, url) => method === 'POST' && LONG_ACTION.test(new URL(url).pathname),
    request: async (options) => {
      const action = LONG_ACTION.exec(new URL(options.url).pathname);
      if (!action) return send(options);
      const { res, sent } = action[1] === 'ImportSolution' && typeof observe.onImportRefused === 'function'
        ? await sendImport(send, options, { env, http: deps, sleep, onRefused: observe.onImportRefused })
        : { res: await send({ ...options, timeout: ACTION_TIMEOUT_MS }), sent: options };
      if (!res.error) {
        if (action[1] === 'StageSolution' && observe.onStageReply) observe.onStageReply(res.body);
        return res;
      }
      let job = '';
      try {
        // The job of the send that got no answer: after a refusal sent again, that is not the first one's.
        const id = action[1] === 'ImportSolution' ? JSON.parse(sent.body).ImportJobId : undefined;
        job = id ? lookUpJob(id) : '';
      } catch {
        // The body is the SDK's own JSON; had it not parsed there would be no id to name.
      }
      // The transport's words (`res.error`: "Request timed out", a socket error) are another party's text and are looked at here, where they are read; the sentence around them is the plugin's own.
      // They may repeat the request that failed — a socket error that holds its `Authorization` header — so the access token is taken out first, as the client does for a failure it handles itself:
      // this function throws for the client, so what the client scrubs never reaches it.
      // The SDK wraps what a client throws and keeps it as the `cause` of its own error, which is how importFailure knows this message again (isComposed) without reading it.
      const words = scrubBearer(String(res.error), sent.headers);
      const transport = observe.sanitize ? observe.sanitize(words, 'transport text') : words;
      const error = new Error(`${action[1]} got no answer (${transport}). It was not sent again: the environment may still be working on it, or may have finished.${job}`);
      COMPOSED_MESSAGE.add(error);
      throw error;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// pac, the fallback
// ---------------------------------------------------------------------------------------------------------------------

function pacError(code, message, refusal) {
  const error = fail(code, message);
  if (refusal) error.fallback = refusal;
  return error;
}

// A folder of this run's own under the temp directory — for what pac reads or writes — removed however `work(dir)` ends: its value, or its failure, which is rethrown. The removal has the bounded retry a
// Windows lock needs (a scanner or a sync client holding a file pac has just written: removeTreeWithRetry), and a folder that STILL stays is never left unsaid. What it holds — pac's template, the package the SDK
// exported, the copy of the settings file pac was given — is not worth keeping and can be sensitive (a template's defaults can be values; a settings file's values are), so a leftover is reported with its path: as
// `leftover` beside the value of a run that worked, and on the error (`leftoverWarnings`, see withLeftover) of one that did not. `holds` says what is in the folder, for that note. The folder is made by
// lib/temp-workspace.js in the plugin's own temp folder, named `solution-settings-<pid>-` and six characters.
// pac is another process and is given paths in this folder (the zip it reads, the file it writes, the settings copy it imports with). On POSIX it outlives a run that is killed (SIGKILL, an agent's timeout),
// and a sweep that takes the folder because this run is gone would remove it from under pac. So the folder is made LENT — recorded as such once, when it is made — and a sweep keeps it for as long as it is
// young, whether or not this run is still going (lib/temp-workspace.js). Nothing is recorded about pac itself, and nothing about the folder is changed after pac has started.
// `empty` names the files (relative to the folder) that hold values: when the folder cannot be removed they are EMPTIED, so that what stays on disk is at least not the values, and the note says whether that worked.
async function inWorkFolder(holds, work, { empty = [] } = {}) {
  const dir = makeTempWorkspace('solution-settings-', { lent: true });
  let value;
  let failure;
  let failed = false;
  try {
    value = await work(dir);
  } catch (err) {
    failed = true;
    failure = err;
  }
  const stopped = removeTreeWithRetry(dir);
  let leftover = null;
  if (stopped) {
    const emptied = empty.map((name) => {
      try {
        fs.writeFileSync(path.join(dir, name), '');
        return true;
      } catch {
        return false;
      }
    });
    const kept = empty.length === 0 ? '' : emptied.every(Boolean) ? ' (emptied, so it keeps no value)' : " (it could not be emptied either, so it may still hold the settings file's values)";
    leftover = `The folder ${dir} could not be removed (${stopped}); it holds ${holds}${kept}. Delete it.`;
  }
  if (failed) throw leftover ? withLeftover(failure, leftover) : failure;
  return { value, leftover };
}

// The note of a folder that stayed, on the error of a run that failed. It is the plugin's own sentence — a path and a code — so no sanitizer looks at it, and it is kept apart from the SDK's cleanup
// warnings, which are another party's text and are looked at (describeFailure puts the two together).
function withLeftover(error, text) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.leftoverWarnings = [...(failure.leftoverWarnings || []), text];
  return failure;
}

// `pac solution create-settings` reads the zip offline and writes the settings file; here it writes into a throwaway folder, and what it wrote is
// read back and checked before it goes anywhere, so a failed or odd run cannot leave a half-made file at --out. `packageBytes` is the package when
// only its bytes are at hand (it was exported by the SDK); pac needs a file. Answers `{ text, settings }`, and `warnings` when the folder stayed.
async function templateThroughPac({ packagePath, packageBytes }, refusal, deps = {}) {
  const { value, leftover } = await inWorkFolder(`${packageBytes ? 'the solution package this run exported and ' : ''}the settings template pac wrote`, async (dir) => {
    let zip = packagePath;
    if (!zip) {
      zip = path.join(dir, 'solution.zip');
      fs.writeFileSync(zip, packageBytes);
    }
    const file = path.join(dir, 'settings.json');
    const label = 'pac solution create-settings';
    const run = await runPac(['solution', 'create-settings', '--solution-zip', zip, '--settings-file', file], { label, ...(deps.pac || {}) });
    if (!run.ok) throw pacError(`PAC_${run.failure.toUpperCase()}`, run.message, refusal);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw pacError('PAC_OUTPUT_UNREADABLE', `\`${label}\` exited 0 but wrote no settings file.`, refusal);
    }
    try {
      return { text, settings: parseSettings(text, `The file \`${label}\` wrote`) };
    } catch (err) {
      throw pacError('PAC_OUTPUT_UNREADABLE', err.message, refusal);
    }
  });
  return leftover ? { ...value, warnings: [leftover] } : value;
}

// `pac solution import` is given the settings the run READ, never the path they were read from. The SDK's refusal comes after the staging, which takes as long as the platform takes, and a file a maker or a
// deployment saves in that time is a file the sanitizer was not built from and `applied` does not describe: read by its path, its values would reach pac — and pac's own words about them, which are
// printed — with nothing that knows them. So pac gets a private copy of the BYTES already read (`settingsBytes`: byte order mark and line ends as they were) in a folder of the run's own. The folder is
// made by mkdtemp — the owner's alone (mode 0700) on POSIX; on Windows it inherits the access list of the user's temp folder — and the file is created exclusively (`wx`) with mode 0600, which Windows
// reads as "not read-only", so the removal below still works. A copy was chosen over refusing a file that changed: the import still happens, of what the run checked, and an edit made meanwhile is
// neither applied nor printed. The package is still read by pac from its path: it is not a secret, and the run checked it without keeping it.
// The folder goes however pac ends, with the bounded retry (inWorkFolder); one that stays is emptied of the values and said — `warnings` on the answer, `leftoverWarnings` on the error.
async function importThroughPac({ env, packagePath, settingsBytes }, redact, refusal, deps = {}) {
  const label = 'pac solution import';
  const { leftover } = await inWorkFolder('the copy of the settings file that pac was given, which can hold secrets', async (dir) => {
    const copy = path.join(dir, 'settings.json');
    try {
      fs.writeFileSync(copy, settingsBytes, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      // The system's code alone (EACCES, ENOSPC, …): the error's own text is not the plugin's sentence, and this message is marked as composed, so no sanitizer looks at it again.
      const error = pacError('PAC_SETTINGS_COPY_FAILED', `\`${label}\` was not run: a private copy of the settings file could not be made (${(err && (err.code || err.name)) || 'Error'}).`, refusal);
      COMPOSED_MESSAGE.add(error);
      throw error;
    }
    const run = await runPac(
      ['solution', 'import', '--path', packagePath, '--environment', env, '--settings-file', copy],
      { label, kind: 'import', redact, ...(deps.pac || {}) }
    );
    if (!run.ok) {
      const error = pacError(`PAC_${run.failure.toUpperCase()}`, run.message, refusal);
      // `run.message` is the plugin's own sentence — the command, its exit status, how a timeout ended — around the only text pac wrote, which `runPac` has already given to `redact`, where it is
      // read. So it holds nothing that was not looked at, and it is not looked at again: for a value of `1` the "(exit 1)" of the plugin's own words would be found and withheld, and with it the
      // one thing that says how pac failed.
      COMPOSED_MESSAGE.add(error);
      throw error;
    }
  }, { empty: ['settings.json'] });
  return leftover ? { warnings: [leftover] } : {};
}

// The reason pac was asked, as it is shown. The sentence for a feature of pac's that the file holds is the plugin's own: pacOnlyFeatureMessages builds it from the file's KEYS and the SDK's wording, and
// importRefusal sent the file to pac only because the SDK's error was exactly it. It holds no value, so it is shown as it is; looked at by the sanitizer, "en" would be found in "deployment" and the
// reason pac was asked withheld, on a successful import too. Any other reason is the SDK's own account of a staging reply it could not read — another party's text — and is sanitized like any other.
function shownRefusal(refusal, settings, sanitize) {
  const own = pacOnlyFeatureMessages(settings).includes(refusal.message);
  return { ...refusal, message: own ? refusal.message : sanitize(refusal.message, 'message') };
}

// ---------------------------------------------------------------------------------------------------------------------
// The two commands
// ---------------------------------------------------------------------------------------------------------------------

const countOf = (settings, list) => (Array.isArray(settings[list]) ? settings[list].length : 0);

// Writes the settings file and describes it: where, and how many entries — never what they hold.
function writeTemplate(request, text, settings, extra) {
  const writeWarnings = [];
  try {
    // Without --force the file must still be absent when it is INSTALLED, not only when the run began: the export, staging or pac work in between takes minutes, and a
    // file a maker started filling in meanwhile — or another run's — is exactly what the refusal at the start protects. The file system decides, in one step
    // (writeFileSafe's `exclusive`), so there is no gap between a look and a write.
    writeFileSafe(request.outPath, text, { encoding: 'utf8', exclusive: !request.force, onWarning: (warning) => writeWarnings.push(warning) });
  } catch (err) {
    if (err && err.code === 'IO_ERROR' && err.reason === 'exists') throw outExists(request.outPath, err.leftoverNote);
    // The exclusive write needs a hard link (lib/safe-fs.js), which a FAT or exFAT volume and some network shares do not have. --force does not: it renames a finished copy over the target, which
    // is also what lets it replace a file, so it works there — and a file system that cannot link says so only to a run that did not ask for that.
    if (err && err.code === 'IO_ERROR' && err.reason === 'no-hard-links') err.message += ' Or pass --force: it replaces the file at --out by renaming a finished copy over it, which needs no hard link.';
    throw err;
  }
  // The file is written and complete. What could not be cleaned up beside it — the SDK's staging copy, the write's temporary name — is said with it, as a warning: the run did what was asked.
  const warnings = [...((extra && extra.warnings) || []), ...writeWarnings];
  return {
    out: request.outPath,
    environmentVariables: countOf(settings, 'EnvironmentVariables'),
    connectionReferences: countOf(settings, 'ConnectionReferences'),
    ...extra,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** `template`: the settings file for a package, written to `--out`. */
async function runTemplate(request, deps = {}) {
  checkOutTarget(request.outPath, request.force);
  if (request.packagePath) inspectPackage(request.packagePath, { withBytes: false });

  // No environment, nothing to stage a package in: pac reads the zip, offline.
  if (!request.env) {
    const made = await templateThroughPac({ packagePath: request.packagePath }, null, deps);
    return { source: 'pac', ...writeTemplate(request, made.text, made.settings, made.warnings ? { warnings: made.warnings } : undefined) };
  }

  let exported; // the package as the SDK exported it, when it did: pac needs it should the SDK refuse to stage it
  const outcome = await (deps.sdkFirst || sdkFirst)(request.env, {
    refusal: templateRefusal,
    httpClient: (env) => solutionHttpClient(env, deps.http),
    fromSdk: async (sdk) => {
      let base64;
      if (request.packagePath) {
        base64 = inspectPackage(request.packagePath, { withBytes: true }).base64;
      } else {
        // Unmanaged: an installed managed solution cannot be exported, and the settings are the same either way.
        base64 = (await sdk.exportSolution({ solutionName: request.solution, managed: false })).base64;
        exported = base64;
      }
      return sdk.getDeploymentSettingsTemplate({ base64 });
    },
    fromPac: async (refusal) => templateThroughPac(
      request.packagePath ? { packagePath: request.packagePath } : { packageBytes: Buffer.from(exported, 'base64') },
      refusal,
      deps
    ),
  }, deps);

  if (outcome.source === 'sdk') {
    const { settings, warnings } = outcome.value;
    return {
      source: 'sdk',
      ...writeTemplate(request, `${JSON.stringify(settings, null, 2)}\n`, settings, warnings && warnings.length ? { warnings } : {}),
    };
  }
  // The SDK's cleanup warnings of the attempt it refused (carried across the fallback: lib/sdk-first.js) come first, then the note of the folder pac worked in, should it have stayed.
  const warnings = [...(outcome.warnings || []), ...(outcome.value.warnings || [])];
  return { source: 'pac', ...writeTemplate(request, outcome.value.text, outcome.value.settings, warnings.length ? { warnings } : undefined), fallback: outcome.fallback };
}

// ---------------------------------------------------------------------------------------------------------------------
// What became of an import
// ---------------------------------------------------------------------------------------------------------------------

// Whether `error` is the answer to the ImportSolution request itself — or the lack of one — and not a refusal made before it was sent (the settings checked, the
// package staged): the SDK's ConnectionError names the URL it was reaching.
function importRequestFailed(error) {
  if (!error || error.code !== 'CONNECTION_ERROR' || typeof error.url !== 'string') return false;
  try {
    return /\/ImportSolution$/.test(new URL(error.url).pathname);
  } catch {
    return false;
  }
}

// An answer that does not say the import was refused: one that reached a gateway or a server that did not serve it (408, 5xx — a gateway answers 502, 503 or 504 for work the
// platform has accepted and is running), or an authentication answer (401), which is not trusted to mean the work never started. No answer at all (status 0) is
// reported by solutionHttpClient with its own sentence, which names the job; a status 0 without it is a failure before the request left (no token could be had), which says
// nothing about the import.
const outcomeUnknown = (status) => status === 401 || status === 408 || status >= 500;

// The attributes in the text of one start tag — ` result="failure" errortext="…"` — by lower-case name, in either quote, their XML character references decoded.
function xmlAttributes(tagText) {
  const attributes = {};
  for (const match of tagText.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1].toLowerCase()] = decodeXml(match[2] !== undefined ? match[2] : match[3]);
  }
  return attributes;
}
/**
 * One line, cut to what a message can carry: a job's log is written for a table, and its text can hold line breaks and run long. This is the LAST thing done to a text that
 * has been through the sanitizer, never the first: collapsing white space changes what a value that holds white space looks like, and a cut can fall inside a value — either
 * would let a secret past a search that ran on what was left.
 */
function oneLine(text, max = 600) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * What an import job's log says went wrong: the COMPLETE text of the FIRST failing result's `errortext` (its character references decoded), else `its status is <the status of
 * the document's root>`, else null. Nothing is collapsed or cut here — the caller sanitizes this whole text first and only then makes it one line (importFailure, oneLine).
 * The log is the XML of the `data` column of the job (`importjobs(<id>)?$select=data`); a failed import's holds, abridged:
 *   <importexportxml start="…" stop="…" progress="…" processed="true" succeeded="failure" status="…">
 *     <solutionManifests><solutionManifest> … <result result="failure" errorcode="0x80048d19" errortext="Could not find connection '…' for API 'shared_sharepointonline'" /> …
 *     </solutionManifest></solutionManifests> …
 *   </importexportxml>
 * The log is read as text, not parsed as a document: its shape varies by component, and all that is looked for is the attribute a failure's words sit in. A root that
 * says the job succeeded is not a failure's status (the log is only read for an import that failed, but it must never be quoted against what it says itself).
 */
function jobLogFailure(log) {
  const text = String(log == null ? '' : log);
  for (const tag of text.matchAll(/<result\b([^>]*)>/gi)) {
    const attributes = xmlAttributes(tag[1]);
    if (/^failure$/i.test(attributes.result || '') && (attributes.errortext || '').trim() !== '') return attributes.errortext;
  }
  const root = /<importexportxml\b([^>]*)>/i.exec(text);
  if (root) {
    const attributes = xmlAttributes(root[1]);
    const failed = attributes.succeeded === undefined || /^failure$/i.test(attributes.succeeded);
    if (failed && (attributes.status || '').trim() !== '') return `its status is ${attributes.status}`;
  }
  return null;
}

/**
 * The reason a failed import's job log gives — read once, never retried, and never a failure of its own: the log only explains a failure that is already known,
 * so a log that cannot be read (the job does not exist, the answer is not what it should be, the environment is slow) is null and the failure stands as it was.
 * `deps.readJobLog(env, id)` stands in for the read in a test; `deps.http` is the client's own seam; `deps.jobLogTimeoutMs` shortens the wait.
 */
async function readImportJobFailure(env, importJobId, deps = {}) {
  let timer;
  try {
    if (deps.readJobLog) return jobLogFailure(await deps.readJobLog(env, importJobId));
    // `sendOnce`: a read that fails is not read again, and the 401 refresh is not attempted — one request, on the failure path.
    const client = readOnceClient(env, deps.http);
    const answer = await Promise.race([
      client.get(webApiUrl(env, `importjobs(${importJobId})?$select=data`)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), Number.isFinite(deps.jobLogTimeoutMs) ? deps.jobLogTimeoutMs : JOB_LOG_TIMEOUT_MS);
      }),
    ]);
    const data = answer && answer.status === 200 && answer.body && typeof answer.body === 'object' ? answer.body.data : undefined;
    return typeof data === 'string' ? jobLogFailure(data) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Whether `error`'s message is entirely the plugin's own composition — and so holds no text of another party that has not been looked at: a message it composed and marked (importThroughPac), or the
// SDK's status line followed by the message of an error the plugin's action client threw (solutionHttpClient). The SDK keeps what a client threw as the `cause` of its transport failure and writes
// `<status line><cause's message>`; the second case is believed only when the message IS exactly that — the status line built from the error's own fields (sdkLead), then the marked error's own
// message — so nothing the SDK or the platform added can be passed as the plugin's.
function isComposed(error) {
  if (COMPOSED_MESSAGE.has(error)) return true;
  const cause = error.cause;
  return cause instanceof Error && COMPOSED_MESSAGE.has(cause) && error.message === `${sdkLead(error)}${cause.message}`;
}

/**
 * The error an import leaves this module with: a NEW error whose every text another party wrote has been through `sanitize` — the message, the reason pac was asked, the SDK's cleanup
 * warnings, the job log's words — so nothing the SDK, the platform or pac said reaches an output with a filled value in it. (The SDK's own error is not passed on: its `cause`
 * holds the raw answer of the service and its attached warnings are unfiltered.) It keeps the code, the status and the reason pac was asked, and — for a failure of the SDK path —
 * names the import job. For a request that was SENT, the job's log is read once for the real reason (the platform's own answer is often only "An unexpected error
 * occurred"), and an outcome that is not known (see outcomeUnknown) says that the request was not repeated and where to look.
 * Every text is sanitized WHOLE, ONCE, and only text that another party wrote. The one thing kept in front of a text that is withheld is the SDK's own status line, built from the SDK error's
 * `statusCode` and `url` (sdkLead) — never found by looking at how a text begins, because the text of a job log, a warning or pac can begin with anything. What the plugin composed itself is not looked
 * at again: a pac failure's message (the command and exit status around pac's text, which runPac redacted where it read it; COMPOSED_MESSAGE), the sentence for a feature of pac's (shownRefusal) and the
 * "got no answer" sentence of the action client (solutionHttpClient), whose transport words were cleaned where they were read.
 * What this function sanitizes: the SDK's own message (it quotes names, and can quote what the platform said), the SDK's staging-reply reason, its cleanup warnings, and a job log's reason (which is
 * appended to the plugin's own sentence AFTER it is sanitized, and the sentence around it is not looked at).
 */
async function importFailure(err, { sanitize, settings, importJobId, env, deps, sends }) {
  const original = err instanceof Error ? err : new Error(String(err));
  const failure = new Error(isComposed(original) ? original.message : sanitize(original.message, 'message', sdkLead(original)));
  if (typeof original.code === 'string') failure.code = original.code;
  if (Number.isInteger(original.statusCode)) failure.statusCode = original.statusCode;
  if (original.fallback) failure.fallback = shownRefusal(original.fallback, settings, sanitize);
  const warnings = (deps.readCleanupWarnings || require('./lib/maker-sdk.js').readCleanupWarnings)(original);
  if (warnings && warnings.length) failure.warnings = warnings.map((warning) => sanitize(warning, 'warning'));
  // The notes of a folder this run made and could not remove (withLeftover) are the plugin's own sentences — a path and a code — so they are carried as they are, beside the cleaned warnings.
  if (Array.isArray(original.leftoverWarnings) && original.leftoverWarnings.length) failure.leftoverWarnings = [...original.leftoverWarnings];
  // The job is the SDK's: pac mints its own and never sees this one, so a failure of the pac import (it carries the reason pac was asked) names none.
  if (original.fallback) return failure;
  // After a refusal that was sent again `importJobId` is the LAST send's, the one whose outcome there is to look up; the sends before it are listed, each with the wait that followed it.
  const resent = sends && sends.refusals.length > 0;
  failure.importJobId = importJobId;
  if (resent) Object.assign(failure, resendReport(sends));
  if (importRequestFailed(original)) {
    const reason = await readImportJobFailure(env, importJobId, deps);
    if (reason) {
      failure.message += ` The import job's log (importjobs(${importJobId})) says: ${oneLine(sanitize(reason, "the job log's text"))}`;
    } else if (outcomeUnknown(original.statusCode)) {
      failure.message += `${resent ? ' The last send was not sent again' : ' The request was sent once and was not sent again'}: the environment may have accepted it.${lookUpJob(importJobId)}`;
    }
  }
  // The plugin's own sentences, appended after the platform's words were sanitized and, like the ones above, not looked at again: they hold counts, ids it minted and the code it matched — no value.
  if (resent) failure.message += ` ${resendSentence(sends)}${original.statusCode === 429 && sends.refusals.length + 1 === IMPORT_MAX_SENDS ? ` It sends at most ${IMPORT_MAX_SENDS} times: run the import again when the other operation has finished.` : ''}`;
  return failure;
}

// What a run that sent its import again reports, in the output: how many sends it took (`importAttempts`), and each send that was refused and waited out (`importRefusals`) — the job it carried,
// the status and the code of the refusal, and how long the run waited before the next send. The last send is the output's own `importJobId`. Nothing but numbers, ids the plugin minted and the
// code it matched: no word of the platform's, so nothing in it needs the sanitizer.
const resendReport = (sends) => (sends.refusals.length > 0 ? { importAttempts: sends.refusals.length + 1, importRefusals: sends.refusals } : {});
const secondsOf = (ms) => `${Math.round(ms / 100) / 10} s`;
const resendSentence = (sends) => `ImportSolution was sent ${sends.refusals.length + 1} times. Each send before the last was refused before it started (HTTP 429, code ${[...new Set(sends.refusals.map((refusal) => refusal.code))].join(', ')}: another operation held the environment's customization lock) and the job it named did not exist (importjobs(<id>) answered 404). The run waited ${sends.refusals.map((refusal) => secondsOf(refusal.waitedMs)).join(', ')} before sending again.`;

/** `import`: the package into `--env`, with the settings file applied in the same import. */
async function runImport(asked, deps = {}) {
  // The settings file is read ONCE, as bytes: the sanitizer, the SDK's import, `applied` and — should the SDK refuse — the copy pac is given (importThroughPac) all come from this one reading, so
  // nothing that reaches an output or pac is a value the sanitizer was not built from. The path is never read again.
  const { settings, bytes } = readSettingsFile(asked.settingsPath);
  const request = { ...asked, settingsBytes: bytes };
  // What the package's own definitions say each variable is: filled in as the SDK reads the package (the StageSolution reply that passes through the client below), and looked at
  // by the sanitizer each time it is asked — see secrecyOf for why the file's `TypeId` is not what decides whether a value is a secret.
  const definitions = new Map();
  const sanitize = sanitizer(settings, definitions);
  const { base64 } = inspectPackage(request.packagePath, { withBytes: true });
  const importJobId = deps.importJobId || crypto.randomUUID();
  // The import's sends, as the client tells of them (solutionHttpClient's `onImportRefused`): `jobId` is the job the last send carried — the first send's until a refusal is sent again.
  const sends = { jobId: importJobId, refusals: [] };
  const onImportRefused = ({ importJobId: refused, status, code, waitedMs, nextImportJobId }) => {
    sends.refusals.push({ importJobId: refused, status, code, waitedMs });
    sends.jobId = nextImportJobId;
  };
  try {
    const outcome = await (deps.sdkFirst || sdkFirst)(request.env, {
      refusal: (error) => importRefusal(error, settings),
      httpClient: (env) => solutionHttpClient(env, deps.http, { onStageReply: (body) => recordStagedTypes(definitions, body), sanitize, onImportRefused }),
      fromSdk: (sdk) => sdk.importSolution({
        base64,
        // pac's defaults: --force-overwrite and --activate-plugins are off. Both are required by the SDK, which no longer defaults them.
        overwriteUnmanagedCustomizations: false,
        publishWorkflows: false,
        importJobId,
        deploymentSettings: settings,
      }),
      fromPac: async (refusal) => importThroughPac(request, sanitize, refusal, deps),
    }, deps);
    if (outcome.source === 'sdk') {
      const { appliedSettings, warnings } = outcome.value;
      return {
        source: 'sdk',
        importJobId: sends.jobId,
        applied: appliedSettings || { environmentVariables: [], connectionReferences: [] },
        ...(warnings && warnings.length ? { warnings: warnings.map((warning) => sanitize(warning, 'warning')) } : {}),
        ...resendReport(sends),
      };
    }
    // pac did the work, and the SDK's refused attempt may have left something behind it (a staged copy it could not delete): its cleanup warnings were carried across the fallback (lib/sdk-first.js) and
    // are cleaned here, ONCE, like the ones of an SDK run — they are another party's text. After them comes the note of the folder pac's copy of the settings was in, should it have stayed: the plugin's
    // own sentence, a path and a code, which no sanitizer looks at. A pac run that succeeded stays a success.
    const warnings = [
      ...(outcome.warnings || []).map((warning) => sanitize(warning, 'warning')),
      ...((outcome.value && outcome.value.warnings) || []),
    ];
    return { source: 'pac', applied: filledNames(settings), fallback: shownRefusal(outcome.fallback, settings, sanitize), ...(warnings.length ? { warnings } : {}) };
  } catch (err) {
    throw await importFailure(err, { sanitize, settings, importJobId: sends.jobId, env: request.env, deps, sends });
  }
}

// The failure a run prints: the message, the SDK's or the PAC step's code, the HTTP status of the answer that failed it, the reason pac was asked, the import job, how many times the import was
// sent when it was sent again (and each refused send), and the warnings the SDK attached about what it could not clean up (a staged copy of the package) — each only when there is one. An import's
// error arrives with its warnings already read and cleaned (importFailure); any other reads them here.
function describeFailure(error, readWarnings = () => undefined) {
  const code = error && typeof error.code === 'string' ? error.code : undefined;
  // The SDK's cleanup warnings (read from the error, or already read and cleaned — an import's) and, after them, the notes of a folder this run made and could not remove (withLeftover).
  const warnings = [
    ...((error && Array.isArray(error.warnings) ? error.warnings : readWarnings(error)) || []),
    ...(error && Array.isArray(error.leftoverWarnings) ? error.leftoverWarnings : []),
  ];
  return {
    ok: false,
    error: String((error && error.message) || error),
    ...(code ? { code } : {}),
    ...(error && Number.isInteger(error.statusCode) && error.statusCode > 0 ? { status: error.statusCode } : {}),
    ...(error && error.fallback ? { fallback: error.fallback } : {}),
    ...(error && error.importJobId ? { importJobId: error.importJobId } : {}),
    ...(error && Number.isInteger(error.importAttempts) ? { importAttempts: error.importAttempts, importRefusals: error.importRefusals } : {}),
    ...(warnings && warnings.length ? { warnings } : {}),
  };
}

async function main() {
  const { request, error } = readRequest(process.argv.slice(2));
  if (error) {
    process.stderr.write(`✗ ${error}\n${USAGE}\n`);
    process.exit(1);
  }
  // emitResult() ends the process, so the outcome is settled first and emitted outside the try: an exit inside it would be caught as a failure.
  let outcome;
  let failure;
  try {
    outcome = request.command === 'template' ? await runTemplate(request) : await runImport(request);
  } catch (err) {
    failure = err;
  }
  if (failure) {
    const { readCleanupWarnings } = require('./lib/maker-sdk.js');
    emitResult(false, describeFailure(failure, readCleanupWarnings), { ascii: true });
    return;
  }
  emitResult(true, { ok: true, ...outcome }, { ascii: true });
}

module.exports = {
  readRequest,
  settingsProblem,
  parseSettings,
  filledNames,
  sanitizer,
  decodedViews,
  secrecyOf,
  recordStagedTypes,
  sdkLead,
  oneLine,
  inspectPackage,
  MAX_PACKAGE_BYTES,
  MAX_SETTINGS_BYTES,
  MAX_SANITIZED_CHARS,
  MIN_HIDDEN_LENGTH,
  SECRET_TYPE_ID,
  templateRefusal,
  importRefusal,
  pacOnlyFeatureMessages,
  solutionHttpClient,
  lockRefusalOf,
  LOCK_REFUSAL_CODES,
  IMPORT_MAX_SENDS,
  IMPORT_RESEND_WAITS_MS,
  jobLogFailure,
  readImportJobFailure,
  lookUpJob,
  runTemplate,
  runImport,
  describeFailure,
};

if (require.main === module) {
  main().catch((err) => {
    // Only the kind of failure: the message of an unexpected one is not known to be free of what the settings file holds, and this runs where no sanitizer exists.
    process.stderr.write(`Error: solution-settings.js failed unexpectedly (${(err && err.name) || 'Error'}).\n`);
    process.exit(1);
  });
}
