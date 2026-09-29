#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs, validateFlags, readJsonArg } = require('./lib/dataverse-auth.js');
const {
  makePcfSdk,
  findCustomControl,
  findForm,
  readFormXml,
} = require('./lib/pcf-dataverse.js');
const {
  parseOrgControlName,
  validatePublisherPrefix,
  validateNamespace,
  validateControlName,
  validateVersion,
} = require('./lib/pcf-names.js');
const { verifyBinding } = require('./lib/pcf-binding-verify.js');

const USAGE = `Usage:
  node scripts/verify-pcf.js --env <url> --control <prefix_ns.ctor> [--version <x.y.z>] --table <logical> --form <name|guid> (--column <col>|--control-id <id>) [--clients web,phone,tablet] [--param name=column:<col>] [--param name=static:<value>[:<type>]] [--workspace <dir>]
  node scripts/verify-pcf.js --env <url> --control <prefix_ns.ctor> [--version <x.y.z>] --intent @pcf-intent.json [--workspace <dir>]`;

const KNOWN = [
  'env',
  'control',
  'version',
  'table',
  'form',
  'column',
  'control-id',
  'clients',
  'param',
  'intent',
  'workspace',
];
const NEED_VALUE = ['env', 'control', 'version', 'table', 'form', 'column', 'control-id', 'clients', 'param', 'intent', 'workspace'];

function usageError(message) {
  process.stderr.write(`${USAGE}\n${message}\n`);
  process.exit(1);
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: KNOWN,
    needValue: NEED_VALUE,
    hints: {
      clients: 'comma-separated values: web,phone,tablet',
      param: 'name=column:<col> or name=static:<value>[:<type>]',
      intent: '@path-to-json',
    },
  });
  if (flagError) usageError(flagError);

  const { flags } = parsed;
  if (!flags.env) usageError('--env is required');
  if (!flags.control) usageError('--control is required');
  validateControlFlag(String(flags.control));
  if (flags.version) {
    const versionError = validateVersion(String(flags.version));
    if (versionError) usageError(versionError);
  }

  const bindings = readBindings(flags);
  if (bindings.length === 0) usageError('--table and --form are required unless --intent is supplied');
  for (const binding of bindings) {
    if (!binding.table) usageError('--table is required');
    if (!binding.form) usageError('--form is required');
    if (!binding.column && !binding.controlId) usageError('--column or --control-id is required');
  }
  const cliParameters = parseRepeatedParams(argv);

  const env = String(flags.env);
  const workspace = flags.workspace ? String(flags.workspace) : path.resolve('.maker-workspace', 'pcf-verify');
  let registered = { ok: false, version: null, expected: flags.version ? String(flags.version) : null, componentState: null };
  const bindingResults = [];

  try {
    const sdk = await makePcfSdk(env, workspace);
    registered = await registrationResult(sdk, String(flags.control), flags.version ? String(flags.version) : undefined);

    for (const binding of bindings) {
      const form = await findForm(sdk, { table: binding.table, form: binding.form });
      const expected = {
        kind: binding.kind || 'field',
        controlName: String(flags.control),
        column: binding.column,
        controlId: binding.controlId,
        clients: binding.clients || parseClients(flags.clients),
        parameters: binding.parameters || cliParameters,
      };
      const draftXml = await readFormXml(sdk, form.formid, { layer: 'draft' });
      const publishedXml = await readFormXml(sdk, form.formid, { layer: 'published' });
      const draft = verifyBinding(draftXml, expected);
      const published = verifyBinding(publishedXml, expected);
      const entry = {
        table: binding.table,
        form: { id: form.formid, name: form.name || binding.form },
        target: binding.column ? { column: binding.column } : { controlId: binding.controlId },
        draft,
        published,
      };
      if (draft.status === 'bound' && published.status !== 'bound') {
        entry.message = 'bound but not published - publish the form';
      }
      bindingResults.push(entry);
    }
  } catch (err) {
    writeResult(false, {
      ok: false,
      error: errorMessage(err),
      control: { registered },
      bindings: bindingResults,
      runtime: 'not-checked',
    });
    return;
  }

  const ok = !!registered.ok && bindingResults.every((binding) => binding.draft.status === 'bound' && binding.published.status === 'bound');
  writeResult(ok, {
    ok,
    control: { registered },
    bindings: bindingResults,
    runtime: 'not-checked',
  });
}

async function registrationResult(sdk, controlName, expectedVersion) {
  const row = await findCustomControl(sdk, controlName);
  if (!row) {
    return { ok: false, version: null, expected: expectedVersion || null, componentState: null };
  }
  return {
    ok: !expectedVersion || row.version === expectedVersion,
    version: row.version || null,
    expected: expectedVersion || null,
    componentState: row.componentState,
  };
}

function readBindings(flags) {
  if (flags.intent) {
    const intent = readJsonArg(String(flags.intent));
    const rawBindings = Array.isArray(intent) ? intent : (intent && Array.isArray(intent.bindings) ? intent.bindings : []);
    return rawBindings.map((binding) => normalizeBinding(binding));
  }
  return [normalizeBinding({
    table: flags.table,
    form: flags.form,
    column: flags.column,
    controlId: flags['control-id'],
    clients: parseClients(flags.clients),
  })];
}

function normalizeBinding(binding) {
  return {
    kind: binding.kind || 'field',
    table: binding.table,
    form: binding.form,
    column: binding.column,
    controlId: binding.controlId || binding['control-id'],
    clients: Array.isArray(binding.clients) ? binding.clients : parseClients(binding.clients),
    parameters: binding.parameters,
  };
}

function parseClients(value) {
  if (!value) return undefined;
  const clients = String(value).split(',').map((client) => client.trim()).filter(Boolean);
  return clients.length ? clients : undefined;
}

function parseRepeatedParams(argv) {
  const parameters = {};
  // parseArgs intentionally keeps only the last repeated flag. PCF bindings can have many
  // parameters, so this CLI reads raw argv for every --param occurrence after validateFlags has
  // already proved each occurrence carries a value.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let raw = null;
    if (arg === '--param') {
      raw = argv[i + 1];
      i++;
    } else if (typeof arg === 'string' && arg.startsWith('--param=')) {
      raw = arg.slice('--param='.length);
    }
    if (!raw) continue;
    const parsed = parseParam(raw);
    parameters[parsed.name] = parsed.value;
  }
  return parameters;
}

function parseParam(raw) {
  const eq = String(raw).indexOf('=');
  if (eq <= 0) usageError(`invalid --param '${raw}'`);
  const name = String(raw).slice(0, eq);
  const body = String(raw).slice(eq + 1);
  if (body.startsWith('column:')) {
    return { name, value: { column: body.slice('column:'.length) } };
  }
  if (body.startsWith('static:')) {
    const rest = body.slice('static:'.length);
    const colon = rest.lastIndexOf(':');
    if (colon === -1) return { name, value: { static: rest } };
    return { name, value: { static: rest.slice(0, colon), type: rest.slice(colon + 1) } };
  }
  usageError(`invalid --param '${raw}'`);
}

function validateControlFlag(controlName) {
  const parsed = parseOrgControlName(controlName);
  if (!parsed) usageError('--control must be shaped as <publisherPrefix>_<namespace>.<constructor>');
  const prefixError = validatePublisherPrefix(parsed.prefix);
  if (prefixError) usageError(prefixError);
  const namespaceError = validateNamespace(parsed.namespace, parsed.constructor);
  if (namespaceError) usageError(namespaceError);
  const controlError = validateControlName(parsed.constructor, parsed.namespace);
  if (controlError) usageError(controlError);
}

function errorMessage(err) {
  return err && err.message ? String(err.message) : String(err);
}

function writeResult(ok, payload) {
  if (ok) {
    process.stdout.write(JSON.stringify(payload) + '\n');
    process.exit(0);
  }
  if (payload instanceof Error) {
    process.stderr.write(payload.message + '\n');
  } else if (payload && typeof payload === 'object') {
    process.stdout.write(JSON.stringify(payload) + '\n');
    if (typeof payload.error === 'string') process.stderr.write(payload.error.trim() + '\n');
    else process.stderr.write('Operation failed with an unstructured error; see stdout JSON\n');
  } else {
    process.stderr.write(String(payload) + '\n');
  }
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => writeResult(false, err));
}

module.exports = { main };
