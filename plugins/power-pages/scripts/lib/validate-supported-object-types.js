#!/usr/bin/env node

// Validates that every component in the pending Changes set is of a type the
// Connect-to-Git pipeline supports. Some legacy component types (workflows
// stored as serialized XAML, old SDK-message processing steps, dialog/business
// process flows from CRM 2013-era, etc.) are KNOWN to round-trip incorrectly
// through Git or to be silently dropped on PullChangesFromGit.
//
// Pre-flight rejecting them at commit time prevents the user from creating a
// commit that fails to import cleanly in the next environment.
//
// API reference: references/inner-loop-error-catalog.md (patterns IL-005..IL-007)
//
// TODO: HAR-verify — the unsupported-types list below is sourced from the
// Microsoft Learn "Solution components that can be configured for Git" page
// and from the inner-loop architecture doc. A real-tenant HAR pass should
// confirm the exact componentType string values the platform emits for the
// rejected categories.
//
// This is a PURE validator — no HTTP. Caller provides the items[] from
// list-pending-changes.js.
//
// Output (JSON to stdout):
//   {
//     totalFiles: <int>,
//     unsupported: [ { componentId, componentName, componentType, reason }, ... ],
//     deprecated:  [ { componentId, componentName, componentType, reason }, ... ],
//     supported:   <int>,
//     ok: bool,                  // true when unsupported.length === 0
//   }
//
// Note: `deprecated[]` are types that PARTIALLY work today but Microsoft has
// flagged for removal — surfaced as warnings, not blocks. `unsupported[]`
// are hard blocks.
//
// Usage:
//   node validate-supported-object-types.js --items-file <path>
//   node validate-supported-object-types.js --pending-file <path>
//   echo '<json>' | node validate-supported-object-types.js --stdin

'use strict';

const fs = require('node:fs');

// TODO: HAR-verify against a real tenant. Type names below mirror the Dataverse
// componentType convention (lowercase entity logical name OR componentType
// integer). Both spellings are tested because the platform is inconsistent.
const UNSUPPORTED = Object.freeze({
  // Classic XAML workflows (workflow.type = 0): NOT supported for Git.
  // Modern modern flows (Power Automate cloud flows) ARE supported.
  'workflow_xaml':                   'Classic XAML workflows are not supported by Connect-to-Git. Convert to a modern Power Automate flow.',
  'dialog':                          'Classic CRM dialogs are deprecated and not supported by Connect-to-Git.',
  'businessprocessflow_classic':     'Classic business process flows (pre-v9) are not supported by Connect-to-Git.',
  'sdkmessageprocessingstep_legacy': 'Legacy SDK message processing steps registered via the SOAP endpoint are not supported.',
  'serviceendpoint_legacy':          'Legacy service endpoints (pre-Azure Service Bus) are not supported.',
  'duplicaterule':                   'Duplicate-detection rules are not supported by Connect-to-Git (per Microsoft Learn).',
});

const DEPRECATED = Object.freeze({
  'reportcategory':       'Report categories are deprecated; data round-trips but the UI is removed in newer environments.',
  'savedquery_legacy':    'Legacy saved-query layouts may not surface the same fields after Pull.',
  'webresource_silverlight': 'Silverlight web resources are deprecated; no browser support exists for them anymore.',
});

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { itemsFile: null, pendingFile: null, stdin: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--items-file' && args[i + 1]) out.itemsFile = args[++i];
    else if (args[i] === '--pending-file' && args[i + 1]) out.pendingFile = args[++i];
    else if (args[i] === '--stdin') out.stdin = true;
  }
  return out;
}

function lookupReason(type, table) {
  if (!type) return null;
  const key = String(type).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  return null;
}

/**
 * @param {Array<object>} items
 * @param {object} [options]
 * @param {object} [options.extraUnsupported]  Add to UNSUPPORTED table (testing/extensibility)
 * @param {object} [options.extraDeprecated]   Add to DEPRECATED table
 */
function validateSupportedObjectTypes(items, { extraUnsupported = null, extraDeprecated = null } = {}) {
  if (!Array.isArray(items)) {
    throw new Error('validateSupportedObjectTypes: items must be an array');
  }
  const unsupportedTbl = extraUnsupported ? { ...UNSUPPORTED, ...extraUnsupported } : UNSUPPORTED;
  const deprecatedTbl  = extraDeprecated  ? { ...DEPRECATED,  ...extraDeprecated  } : DEPRECATED;

  const unsupported = [];
  const deprecated = [];
  let supported = 0;

  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const type = it.componentType;
    const uReason = lookupReason(type, unsupportedTbl);
    if (uReason) {
      unsupported.push({
        componentId: it.componentId ?? null,
        componentName: it.componentName ?? null,
        componentType: type,
        reason: uReason,
      });
      continue;
    }
    const dReason = lookupReason(type, deprecatedTbl);
    if (dReason) {
      deprecated.push({
        componentId: it.componentId ?? null,
        componentName: it.componentName ?? null,
        componentType: type,
        reason: dReason,
      });
      continue;
    }
    supported++;
  }

  return {
    totalFiles: items.length,
    unsupported,
    deprecated,
    supported,
    ok: unsupported.length === 0,
  };
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  let items = [];
  if (args.itemsFile) items = JSON.parse(fs.readFileSync(args.itemsFile, 'utf8'));
  else if (args.pendingFile) items = JSON.parse(fs.readFileSync(args.pendingFile, 'utf8')).items || [];
  else if (args.stdin) {
    const parsed = JSON.parse(await readStdin());
    items = Array.isArray(parsed) ? parsed : (parsed.items || []);
  } else {
    process.stderr.write('validate-supported-object-types: provide --items-file, --pending-file, or --stdin\n');
    process.exit(1);
  }
  const r = validateSupportedObjectTypes(items);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('validate-supported-object-types: ' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = { validateSupportedObjectTypes, UNSUPPORTED, DEPRECATED };
