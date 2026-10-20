#!/usr/bin/env node
'use strict';
// connector: what a connector offers, so a generative page can be bound to it — the operations of a REST/action connector, the
// parameters and response of one operation, and the columns of a tabular connector's table. Replaces the three `pac model genpage`
// commands the connector agent used to run (`list-connector-operations`, `get-connector-schema --operation`, `get-connector-schema
// --dataset --table`), with the same flags and the same JSON.
//
// Where each form is answered from:
//   operations, schema --operation   the bundled SDK first, for an environment in the Public cloud (the Power Apps connectors API through the
//                                    Business Application Platform, with an Azure CLI token for the Power Apps service; measured identical to
//                                    pac's answer on real connectors). A connector's path-level parameters
//                                    (a Swagger path item's own `parameters`, which its operations share) are in the SDK's answer, merged with
//                                    each operation's own, the operation's winning. As the SDK documents the difference, pac's answer leaves a path
//                                    item's parameters out, so for a connector that has them the SDK's `parameters` list is pac's plus exactly those.
//                                    When the SDK has no route — an environment in the Test
//                                    cloud or any other (decided from the host, before the SDK is asked: lib/sdk-first.js says why the SDK is
//                                    given no client for the Test cloud), a service that has been switched off (HTTP 410), a token the service
//                                    refused (401 or 403), a connector definition it does not project, no Power Apps token to be had — the
//                                    same question goes to pac, and the output says so (`source` and `fallback`). Any other failure of the
//                                    SDK's read is a failure of this script, never answered by pac (lib/sdk-first.js holds the rule and its codes).
//   schema --dataset --table         pac directly: a connector's tables are read by the SDK only through the Power Platform API and a connector
//                                    runtime client, neither of which the plugin can build on an Azure CLI token (lib/sdk-first.js).
// `--connection-id` is required for every form because pac requires it; the SDK route does not use it (the connector's definition is the
// same whichever connection asks), so there it is only checked for shape.
//
// Usage:
//   node scripts/connector.js operations --env <envUrl> --connector-id <connector> --connection-id <connectionId>
//   node scripts/connector.js schema --env <envUrl> --connector-id <connector> --connection-id <connectionId> --operation <operationId>
//   node scripts/connector.js schema --env <envUrl> --connector-id <connector> --connection-id <connectionId> --dataset <dataset> --table <table>
//   --env            the environment's https origin, e.g. https://contoso.crm.dynamics.com
//   --connector-id   the connector's short name (`shared_office365users`) or its full API id (`/providers/Microsoft.PowerApps/apis/shared_office365users`)
//   --connection-id  the connection's id, as list-connections.js prints it
//
// Output (stdout, one pure-ASCII JSON line), exit 0 — pac's own JSON, plus `ok`, `source` and, when pac answered because the SDK refused, `fallback`:
//   { "ok": true, "operations": [ { "name": "MyProfile_V2", "summary": "Get my profile (V2)" } ], "source": "sdk" }
//   { "ok": true, "operation": "MyProfile_V2", "parameters": [ { "name": "id", "required": true } ], "response": { … }, "source": "sdk" }
//   { "ok": true, "table": "…", "columns": [ { "name": "Title", "type": "string", "required": false } ], "source": "pac" }
//   { "ok": true, "operations": […], "source": "pac", "fallback": { "code": "CONNECTIVITY_NOT_CONFIGURED", "message": "…" } }
//   `schema --operation`'s `response` is the schema of the operation's 200 response, `{}` when it has none.
// The line is pure ASCII — every other character is a `\uXXXX` escape, which any JSON parser reads back as itself — because a raw one is garbled
// by the code page of the console that captures it (Windows PowerShell 5.1 reads a child's stdout as OEM text).
//
// Exit codes: 0 answered; 1 usage error (stderr names the flag, stdout stays empty) or a failure — stdout then holds
//   { "ok": false, "error": "<message>", "code": "<the SDK's or the PAC step's code, when it has one>", "fallback": { … } } and stderr the message.
const { parseArgs, validateFlags, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { sdkFirst, connectivity } = require('./lib/sdk-first.js');
const { runPac, pacPayload } = require('./lib/pac-fallback.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');

const USAGE = [
  'Usage:',
  '  node scripts/connector.js operations --env <envUrl> --connector-id <connector> --connection-id <connectionId>',
  '  node scripts/connector.js schema --env <envUrl> --connector-id <connector> --connection-id <connectionId> --operation <operationId>',
  '  node scripts/connector.js schema --env <envUrl> --connector-id <connector> --connection-id <connectionId> --dataset <dataset> --table <table>',
].join('\n');

const FLAGS = ['env', 'connector-id', 'connection-id', 'operation', 'dataset', 'table'];

const CONNECTOR_PREFIX = '/providers/Microsoft.PowerApps/apis/';
// A connector's short name as the SDK accepts it (api/ConnectivityApi.ts connectorShortName), and `.`/`..` are never one: the name becomes a path
// segment of a URL, and a dot segment would be resolved away by any HTTP stack, naming another resource of the same host.
const CONNECTOR_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
// A connection id as the plugin meets them — 32 hex digits, a GUID, `shared-<connector>-<guid>` or a full resource path — and nothing a
// command line would read as more than one value.
const CONNECTION_ID = /^[A-Za-z0-9/][A-Za-z0-9_./:@-]{0,299}$/;

// A value that is text to be passed on as one argument: not empty, not a flag (pac would read a leading dash as an option), no control
// characters (a line break ends a command) and not unreasonably long.
function plainValue(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max && !value.startsWith('-') && !/[\u0000-\u001f\u007f]/.test(value);
}

function connectorShortName(value) {
  const text = String(value);
  const short = text.slice(0, CONNECTOR_PREFIX.length).toLowerCase() === CONNECTOR_PREFIX.toLowerCase() ? text.slice(CONNECTOR_PREFIX.length) : text;
  return CONNECTOR_NAME.test(short) && !/^\.{1,2}$/.test(short) ? short : null;
}

/**
 * The request an argv asks for, or `{ error }` naming what is wrong with it — before any process is started or request sent.
 * `form` is which of the three questions it is: 'operations', 'operation' (one operation's schema) or 'table' (a tabular connector's columns).
 */
function readRequest(argv) {
  const [command, ...rest] = argv;
  if (command !== 'operations' && command !== 'schema') {
    return { error: command === undefined ? 'a command is required: operations or schema' : `unknown command '${command}': use operations or schema` };
  }
  const flagError = validateFlags(rest, { known: FLAGS, needValue: FLAGS });
  if (flagError) return { error: flagError };
  const { positional, flags } = parseArgs(rest);
  if (positional.length > 0) return { error: `unexpected argument '${positional[0]}'` };
  const need = (name) => (flags[name] === undefined ? `--${name} is required` : null);
  const problem = ['env', 'connector-id', 'connection-id'].map(need).find(Boolean);
  if (problem) return { error: problem };

  let env;
  try {
    env = requireDataverseOrigin(flags.env);
  } catch (err) {
    return { error: err.message };
  }
  const connector = connectorShortName(flags['connector-id']);
  if (!connector) {
    return { error: `--connector-id must be a connector's short name ('shared_office365users') or its full API id ('${CONNECTOR_PREFIX}shared_office365users'): letters, digits, '_', '.' or '-', up to 128 characters` };
  }
  const connectionId = flags['connection-id'];
  if (!CONNECTION_ID.test(connectionId)) {
    return { error: "--connection-id must be a connection's id as list-connections.js prints it: letters, digits and _ . / : @ -, up to 300 characters" };
  }
  const base = { env, connector, connectionId };

  if (command === 'operations') {
    const extra = ['operation', 'dataset', 'table'].find((name) => flags[name] !== undefined);
    return extra ? { error: `--${extra} does not apply to operations` } : { request: { ...base, form: 'operations' } };
  }
  const { operation, dataset, table } = flags;
  if (operation !== undefined && (dataset !== undefined || table !== undefined)) {
    return { error: '--operation cannot be combined with --dataset or --table: schema reads either one operation or one table' };
  }
  if (operation !== undefined) {
    if (!plainValue(operation, 256)) return { error: '--operation must be an operation id: text with no line break and no leading dash, up to 256 characters' };
    return { request: { ...base, form: 'operation', operation } };
  }
  if (dataset === undefined || table === undefined) {
    return { error: dataset !== undefined || table !== undefined ? '--dataset and --table go together' : 'schema needs --operation, or --dataset with --table' };
  }
  if (!plainValue(dataset, 1000)) return { error: '--dataset must be text with no line break and no leading dash, up to 1000 characters' };
  if (!plainValue(table, 1000)) return { error: '--table must be text with no line break and no leading dash, up to 1000 characters' };
  return { request: { ...base, form: 'table', dataset, table } };
}

// The `pac model genpage` command a form is, pinned to the environment the script was given (without `--environment` pac answers for the
// active organization of its auth profile, which is not necessarily the one asked about). Only these two verbs are run here.
function pacArgs(request) {
  const common = ['--environment', request.env, '--connector-id', request.connector, '--connection-id', request.connectionId];
  if (request.form === 'operations') return ['model', 'genpage', 'list-connector-operations', ...common];
  if (request.form === 'operation') return ['model', 'genpage', 'get-connector-schema', ...common, '--operation', request.operation];
  return ['model', 'genpage', 'get-connector-schema', ...common, '--dataset', request.dataset, '--table', request.table];
}

// What each form's JSON must hold to be the answer it is — pac's own shapes. An error printed as JSON, or a changed layout, is refused.
const SHAPES = {
  operations: [(p) => Array.isArray(p.operations), 'an "operations" list'],
  operation: [(p) => typeof p.operation === 'string' && Array.isArray(p.parameters), 'an "operation" and a "parameters" list'],
  table: [(p) => Array.isArray(p.columns), 'a "columns" list'],
};

function pacError(code, message, refusal) {
  const error = new Error(message);
  error.code = code;
  if (refusal) error.fallback = refusal;
  return error;
}

/**
 * The answer through pac: its JSON after the sign-in banner, refused unless it is the shape the form's answer has.
 * `refusal` is why pac was asked instead of the SDK (null for the form the SDK does not serve).
 */
async function readThroughPac(request, refusal, deps = {}) {
  const args = pacArgs(request);
  const label = `pac ${args.slice(0, 3).join(' ')}`;
  const run = await runPac(args, { label, ...(deps.pac || {}) });
  if (!run.ok) throw pacError(`PAC_${run.failure.toUpperCase()}`, run.message, refusal);
  let payload;
  try {
    payload = pacPayload(run.stdout, label);
  } catch (err) {
    throw pacError('PAC_OUTPUT_UNREADABLE', err.message, refusal);
  }
  const [holds, expected] = SHAPES[request.form];
  if (!holds(payload)) throw pacError('PAC_OUTPUT_UNREADABLE', `\`${label}\` printed JSON without ${expected}, which is not an answer to this question.`, refusal);
  return payload;
}

/** The answer to a request: `{ source, value, fallback? }`. The tabular form is pac's alone; the other two ask the SDK first. */
async function answer(request, deps = {}) {
  if (request.form === 'table') return { source: 'pac', value: await readThroughPac(request, null, deps) };
  return (deps.sdkFirst || sdkFirst)(request.env, {
    ...connectivity,
    fromSdk: (sdk) => (request.form === 'operations'
      ? sdk.listConnectorOperations(request.connector)
      : sdk.getConnectorOperationSchema(request.connector, request.operation)),
    fromPac: async (refusal) => readThroughPac(request, refusal, deps),
  }, deps);
}

// The failure a run prints: the message, and the SDK's or the PAC step's code and the reason pac was asked, when it has them.
function describeFailure(error) {
  const code = error && typeof error.code === 'string' ? error.code : undefined;
  return {
    ok: false,
    error: String((error && error.message) || error),
    ...(code ? { code } : {}),
    ...(error && error.fallback ? { fallback: error.fallback } : {}),
  };
}

async function main() {
  const { request, error } = readRequest(process.argv.slice(2));
  if (error) {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`✗ ${error}\n${USAGE}\n`);
    process.exit(1);
  }
  // emitResult() ends the process, so the answer is settled first and emitted outside the try: an exit inside it would be caught as a failure.
  let outcome;
  let failure;
  try {
    outcome = await answer(request);
  } catch (err) {
    failure = err;
  }
  if (failure) {
    emitResult(false, describeFailure(failure), { ascii: true });
    return;
  }
  emitResult(true, answerLine(outcome), { ascii: true });
}

// What a successful run prints: pac's own JSON — `ok`, `source` and `fallback` are this script's words, so a pac payload that happened to carry
// one of those keys cannot change what they say.
function answerLine(outcome) {
  const { ok: _ok, source: _source, fallback: _fallback, ...payload } = outcome.value;
  return { ok: true, ...payload, source: outcome.source, ...(outcome.fallback ? { fallback: outcome.fallback } : {}) };
}

module.exports = { readRequest, pacArgs, answer, answerLine, describeFailure, connectorShortName };

if (require.main === module) {
  main().catch((err) => {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
