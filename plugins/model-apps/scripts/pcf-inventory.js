#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs, validateFlags } = require('./lib/dataverse-auth.js');
const {
  WHERE_USED_CAVEAT,
  makePcfSdk,
  findCustomControl,
  listCustomControls,
  dependentsOf,
} = require('./lib/pcf-dataverse.js');

const USAGE = `Usage:
  node scripts/pcf-inventory.js --env <url> [--control <name>] [--include-managed] [--where-used] [--workspace <dir>]`;

const KNOWN = ['env', 'control', 'include-managed', 'where-used', 'workspace'];
const NEED_VALUE = ['env', 'control', 'workspace'];

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
      control: 'registered name, usually <publisherPrefix>_<namespace>.<constructor>',
      workspace: 'directory for Dataverse SDK metadata cache',
    },
  });
  if (flagError) usageError(flagError);

  const { flags } = parsed;
  if (!flags.env) usageError('--env is required');

  const env = String(flags.env);
  const workspace = flags.workspace ? String(flags.workspace) : path.resolve('.maker-workspace', 'pcf-inventory');
  const includeManaged = hasFlag(argv, 'include-managed');
  const withWhereUsed = hasFlag(argv, 'where-used');
  const output = { ok: true, controls: [] };
  if (withWhereUsed) output.whereUsedCaveat = WHERE_USED_CAVEAT;

  try {
    const sdk = await makePcfSdk(env, workspace);
    const controls = flags.control
      ? await readOneControl(sdk, String(flags.control))
      : await readControlList(sdk, includeManaged);

    if (!controls) {
      const controlName = String(flags.control);
      writeResult(false, {
        ok: false,
        error: missingControlMessage(controlName),
        controls: [],
      });
      return;
    }

    for (const control of controls) {
      const entry = inventoryRow(control);
      if (withWhereUsed) {
        entry.whereUsed = control.id
          ? await dependentsOf(sdk, control.id)
          : { ok: false, reason: 'customcontrolid was missing from the customcontrol row' };
      }
      output.controls.push(entry);
    }
  } catch (err) {
    if (err && err.exitCode !== undefined) throw err;
    writeResult(false, { ...output, ok: false, error: errorMessage(err) });
    return;
  }

  writeResult(true, output);
}

async function readOneControl(sdk, controlName) {
  const row = await findCustomControl(sdk, controlName);
  return row ? [row] : null;
}

async function readControlList(sdk, includeManaged) {
  const rows = await listCustomControls(sdk, { includeManaged });
  return includeManaged ? rows : rows.filter(isDefaultInventoryControl);
}

function inventoryRow(control) {
  return {
    name: control.name,
    version: control.version,
    isManaged: control.isManaged,
    componentState: control.componentState,
  };
}

function isDefaultInventoryControl(control) {
  const name = String(control && control.name || '');
  // First-party platform controls exist in every org and drown out the controls a maker usually
  // owns; keep them hidden with the managed-solution rows unless --include-managed asks for the
  // complete platform inventory.
  return control && !control.isManaged && !name.startsWith('MscrmControls.') && !name.startsWith('Microsoft.');
}

function hasFlag(argv, name) {
  return argv.some((arg) => arg === `--${name}` || String(arg).startsWith(`--${name}=`));
}

function missingControlMessage(controlName) {
  const expected = controlName.includes('_') ? '<publisherPrefix>_<namespace>.<constructor>' : `<publisherPrefix>_${controlName}`;
  return `No PCF custom control named '${controlName}' was found. Registered controls use the prefixed form '${expected}' (for example, <publisherPrefix>_<namespace>.<constructor>), not just the manifest namespace and constructor.`;
}

function writeResult(ok, payload) {
  if (ok) {
    process.stdout.write(JSON.stringify(payload) + '\n');
    process.exit(0);
  }
  if (payload instanceof Error) {
    process.stderr.write(payload.message + '\n');
  } else if (payload !== null && typeof payload === 'object') {
    process.stdout.write(JSON.stringify(payload) + '\n');
    if (typeof payload.error === 'string' && payload.error.trim()) process.stderr.write(payload.error.trim() + '\n');
    else process.stderr.write('Operation failed with an unstructured error; see stdout JSON\n');
  } else {
    process.stderr.write(String(payload) + '\n');
  }
  process.exit(1);
}
function errorMessage(err) {
  return err && err.message ? String(err.message) : String(err);
}

if (require.main === module) {
  main().catch((err) => writeResult(false, err));
}

module.exports = { main, isDefaultInventoryControl };


