#!/usr/bin/env node
'use strict';
// Creates — or finds and keeps — a Dataverse connection reference: the environment-portable binding a generative page's
// config.json connectorBindings[].logicalName resolves at run time. The runtime looks the reference up by logical name
// to reach the environment's own connection, so the page travels between environments and the connection stays local.
// See: https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference
//
// The write goes through the vendored SDK and the plugin's configuration helper (lib/configuration-artifacts.js), the
// same path the App Spec build takes for `connectionReferences`, never a raw POST:
//   - the logical name is the identity, so a reference that already exists is reused (its display name updated when
//     one is given), never duplicated;
//   - a reference that exists for a DIFFERENT connector is refused before anything is written: its connector cannot
//     change, and a page bound to it would fail only when it calls the connector;
//   - rebinding a reference that is already bound to another connection replaces a working binding, so it is done only
//     with `--authorize connectionReference:<logicalName>:connectionId` (the refusal names the exact token);
//   - with --solution the create is made in that solution (the SDK sends MSCRM.SolutionUniqueName), and a reference
//     that already exists is added to that solution when it is not in it, so it ships with the app's solution;
//   - every write is sent once (lib/configuration-transport.js): the HTTP client never sends a create again after a
//     lost answer, which could make a second row, so a lost answer is reported as an unknown outcome to inspect.
//
// Usage:
//   node create-connection-reference.js <envUrl> <logicalName> <connectorId>
//     [--connection-id <connectionId>]   (bind to an existing connection now)
//     [--display-name <name>]
//     [--solution <solutionUniqueName>]
//     [--authorize <token>]              (repeatable; consent to one destructive change the refusal names)
//
// <envUrl> is the environment's https origin, e.g. https://contoso.crm.dynamics.com
// <connectorId> is the API id, e.g. /providers/Microsoft.PowerApps/apis/shared_sharepointonline
//
// Without --connection-id the binding is left as it is — never sent as null: an ALM import fills the target
// environment's connection through deployment settings (ConnectionReferences[].ConnectionId), and an explicit null
// would clear it.
//
// Output: { "ok": true, "connectionReferenceId": "...", "logicalName": "..." } on stdout, exit 0.
// Any failure: exit 1, nothing on stdout, one message on stderr. A refusal by the server keeps the established text
//   Create connection reference <logicalName> failed: HTTP <status> — <the server's error message>
// (only Dataverse's own error.message is quoted, never the SDK's wording around it, which can carry a request URL).
// A write whose answer was lost says so, names the row id the create was sent with, and asks for the environment to be
// checked before the command is run again.

const { parseArgs, validateFlags, emitResult, ensureOk, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { withThrowawaySdk } = require('./lib/throwaway-sdk.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const {
  validateConfiguration, readDeploymentBindings, planConfiguration, applyConfiguration, configurationAuthorizationKeys, configurationContext,
} = require('./lib/configuration-artifacts.js');
const { configurationSendOnce } = require('./lib/configuration-transport.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');
const { tokenLike } = require('./lib/page-bindings.js');

const USAGE = 'Usage: node create-connection-reference.js <envUrl> <logicalName> <connectorId> [--connection-id <id>] [--display-name <name>] [--solution <uniqueName>] [--authorize <token>]';

const MESSAGES = {
  CONNECTION_REFERENCE_CONNECTOR_MISMATCH: 'a connection reference with this logical name already exists for a different connector, and its connector cannot be changed (choose another logical name)',
};

// The server's refusal of the last write, kept as the established refusal line. The client hands a non-2xx answer to
// the SDK as `{ status, headers, body }`, the body parsed when it is JSON, e.g.
//   { status: 400, body: { error: { code: '0x80040203', message: 'Invalid connector id' } } }
// Only `body.error.message` is kept: the SDK's own error text around it can quote the request URL. ensureOk formats the
// line exactly as the raw POST this script used to send did, the 401 identity advice included.
function refusalLine(logicalName, answer) {
  const message = safeServerMessage(answer && answer.body && answer.body.error ? answer.body.error.message : null);
  try {
    ensureOk({ status: answer.status, data: message ? { error: { message } } : null }, `Create connection reference ${logicalName}`);
  } catch (err) {
    return err.message;
  }
  return `Create connection reference ${logicalName} failed: HTTP ${answer.status}`;
}

// The server's own message is quoted only when it reads as a plain sentence. Dataverse can echo a request header, a URL
// or a submitted value back in error.message, e.g.
//   { error: { code: '0x80048d19', message: 'Invalid header: Authorization: Bearer <token>' } }
// and stderr is captured into build logs and transcripts. So a message shaped like a credential (lib/page-bindings.js
// tokenLike: a known token prefix, an authorization scheme with a value, a long run of letters and digits), an address
// (`://`, `www.`, an `@`), a `name=value` pair, or one holding a control character (a second, forged line) or longer than
// a sentence is replaced by fixed text. A plain message (`Invalid connector id`) is kept byte for byte.
const UNSAFE_SERVER_MESSAGE = 'the server refused the request; its message is not shown because it may quote a credential or an address';
function safeServerMessage(message) {
  if (typeof message !== 'string' || !message) return null;
  if (message.length > 300 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(message) || /:\/\/|www\.|@|[A-Za-z0-9_]=\S/i.test(message) || tokenLike(message)) {
    return UNSAFE_SERVER_MESSAGE;
  }
  return message;
}

// The HTTP client the SDK writes through, noting the last non-2xx answer to a write (a GET is a read, not a refusal).
function noting(client, seen) {
  const wrapped = {};
  for (const [name, value] of Object.entries(client)) {
    wrapped[name] = typeof value !== 'function' ? value : async (...args) => {
      const answer = await value(...args);
      if (name !== 'get' && answer && typeof answer.status === 'number' && (answer.status < 200 || answer.status >= 300)) seen.refusal = answer;
      return answer;
    };
  }
  return wrapped;
}

// One message for the maker from the helper's result for this one reference.
function settle(plan, result, logicalName, seen) {
  const what = `Create connection reference ${logicalName}`;
  // A failed lookup comes back in the plan, before any write: this run sent nothing, which says nothing about an
  // earlier run whose answer was lost. A create port's resolver that stopped at the identity's own id names it.
  const unread = plan.unknown[0];
  if (unread) return new Error(`${what} failed: it could not be read (${unread.code}), so this run sent nothing. A write an earlier run made may still have been saved${unread.id ? ` as connectionreferences(${unread.id})` : ''}: check the environment for connection reference ${logicalName} before running this again.`);
  const unknown = result.unknown[0];
  if (unknown) {
    const id = (unknown.handle && unknown.handle.ids && unknown.handle.ids.id) || unknown.id;
    const cause = unknown.cause ? `, ${unknown.cause}` : '';
    return new Error(`${what} failed: the outcome is unknown (${unknown.code}${cause}). The write may have been saved${id ? ` as connectionreferences(${id})` : ''}. Check the environment for connection reference ${logicalName} before running this again.`);
  }
  const refused = result.refused[0];
  if (refused) {
    if (refused.code === 'DESTRUCTIVE_CHANGE_UNAUTHORIZED' && refused.authorize) {
      return new Error(`${what} failed: it is bound to another connection, and rebinding it replaces that binding. To rebind it, run this again with ${refused.authorize.map((t) => `--authorize ${t}`).join(' ')}. Nothing was written.`);
    }
    if (MESSAGES[refused.code]) return new Error(`${what} failed: ${MESSAGES[refused.code]}. Nothing was written.`);
    if (seen.refusal) return new Error(refusalLine(logicalName, seen.refusal));
    return new Error(`${what} failed (${refused.code}). Nothing was written.`);
  }
  const done = [...result.saved, ...result.unchanged].find((line) => line.kind === 'connectionReference' && line.id);
  if (!done) return new Error(`${what} failed: the reference could not be confirmed (UNEXPECTED_ERROR).`);
  return { ok: true, connectionReferenceId: done.id, logicalName };
}

/**
 * Creates or keeps the connection reference through the SDK.
 * @param {object} request - { env, logicalName, connectorId, connectionId?, displayName?, solution?, authorized? (Set) }
 * @param {object} [httpClient] - the SDK's HttpClient; the az-token one for `env` when omitted (a test seam)
 * @param {object} [deps] - { creates }: the create port; the plain pass-through (lib/creates-passthrough.js) when omitted
 * @returns {Promise<object|Error>} the success payload, or the Error to report
 */
async function createConnectionReference({ env, logicalName, connectorId, connectionId, displayName, solution, authorized }, httpClient, deps = {}) {
  const entry = { logicalName, connectorId, ...(displayName ? { name: displayName } : {}) };
  const spec = { connectionReferences: [entry] };
  const bindings = readDeploymentBindings(connectionId ? { ConnectionReferences: [{ LogicalName: logicalName, ConnectionId: connectionId }] } : undefined, spec);
  const seen = {};
  // Send-once for the configuration writes: the client's retry loop would re-send a create whose answer was lost.
  const client = noting(httpClient || createAzHttpClient(env, { sendOnce: configurationSendOnce }), seen);
  return withThrowawaySdk({ env, httpClient: client, prefix: 'create-connection-reference-' }, async (make) => {
    const sdk = make(solution ? { solutionUniqueName: solution } : {});
    // The SDK writes an artifact to its workspace before pushing it, so the throwaway workspace is initialised first.
    await sdk.initWorkspace();
    // Without a create port the helper creates through the plain pass-through (lib/creates-passthrough.js): the logical
    // name is the identity. A port with a resolver (`deps.creates`) makes the create's id stable across runs.
    const ctx = configurationContext({ sdk, creates: deps.creates, bindings, solutionUniqueName: solution, authorizedDestructive: authorized });
    const plan = await planConfiguration(spec, ctx);
    if (plan.unknown.length) return settle(plan, { saved: [], unchanged: [], refused: [], unknown: [] }, logicalName, seen);
    return settle(plan, await applyConfiguration(plan, ctx), logicalName, seen);
  });
}

function usageError(message) {
  makeWritesBlocking(process.stdout, process.stderr);
  process.stderr.write(`✗ ${message}\n${USAGE}\n`);
  process.exit(1);
}

// parseArgs keeps only the last value of a repeated flag, so the --authorize tokens are read from argv
// (`--authorize <token>` or `--authorize=<token>`), as build-model-app.js reads its own.
function authorizeTokens(argv) {
  const raw = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--authorize') { raw.push(argv[i + 1]); i += 1; } else if (typeof argv[i] === 'string' && argv[i].startsWith('--authorize=')) raw.push(argv[i].slice('--authorize='.length));
  }
  return raw;
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: ['connection-id', 'display-name', 'solution', 'authorize'],
    needValue: ['connection-id', 'display-name', 'solution', 'authorize'],
  });
  if (flagError) usageError(flagError);
  if (positional.length < 3) {
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }
  const [envArg, logicalName, connectorId] = positional;
  let env;
  try {
    env = requireDataverseOrigin(envArg);
  } catch (err) {
    usageError(err.message);
  }
  // The same rules the App Spec's `connectionReferences` are held to: a logical name Dataverse accepts and a connector
  // API id, checked before any workspace is made or request sent.
  const entry = { logicalName, connectorId, ...(flags['display-name'] ? { name: flags['display-name'] } : {}) };
  const { errors } = validateConfiguration({ connectionReferences: [entry] });
  if (errors.length) usageError(errors.map((e) => e.replace(/^connectionReferences\[0\][.:]\s*/, '')).join('; '));
  // A token must name this reference and a field a plan can ask for; anything else would consent to nothing.
  const { keys, problems, unclaimed } = configurationAuthorizationKeys(authorizeTokens(argv), { connectionReferences: [entry] });
  const wrong = [...problems.map((p) => p.token), ...unclaimed];
  if (wrong.length) usageError(`--authorize: ${wrong.map((t) => `'${t}'`).join(', ')} is not a token for connection reference ${logicalName} (connectionReference:${logicalName}:connectionId)`);

  // emitResult() ends the process, so the outcome is settled first and emitted outside the try: an exit inside it would
  // be caught as a failure of the write.
  let outcome;
  try {
    outcome = await createConnectionReference({
      env, logicalName, connectorId, connectionId: flags['connection-id'], displayName: flags['display-name'], solution: flags.solution, authorized: keys,
    });
  } catch (err) {
    // The helper reports what it knows by value; a throw here is unexpected, and its own text can quote a URL.
    outcome = new Error(`Create connection reference ${logicalName} failed (${err && typeof err.code === 'string' ? err.code : 'UNEXPECTED_ERROR'}). Check the environment for connection reference ${logicalName} before running this again.`);
  }
  if (outcome instanceof Error) emitResult(false, outcome);
  else emitResult(true, outcome);
}

module.exports = { main, createConnectionReference };

// Only run when invoked directly as a CLI; requiring the module (e.g. from tests) must not execute main() and its exits.
if (require.main === module) {
  main().catch((err) => {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
