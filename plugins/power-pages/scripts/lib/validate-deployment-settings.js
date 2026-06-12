#!/usr/bin/env node

// Pre-deploy validator for deployment-settings.json. Classifies each
// EnvironmentVariables[] entry by value format and (when --envUrl is
// provided) cross-checks the value against the env var's declared type
// on the dev environment.
//
// Why this exists: the Power Platform Pipelines handler validates the
// `deploymentsettingsjson` PATCH at import time, AFTER the stage run has
// been queued and potentially after a long wait behind serialized imports.
// A bad Secret reference value (placeholder like `@KeyVault(vaultName=...)`,
// raw secret value, malformed URI) fails the import with:
//
//   ImportAsHolding failed: The value provided as a secret reference does
//   not match a valid secret reference format.
//
// This can sit in the host's serialized import queue for hours before
// failing. Catching the bad reference upfront — at Phase 5 before the
// PATCH — turns a multi-hour wait-then-fail into a sub-second hard stop
// with a precise remediation pointer.
//
// Usage:
//   node validate-deployment-settings.js
//          --settingsFile <path>                 (required)
//          [--envUrl <url>]                      (optional — looks up env var
//                                                  types on the dev env to
//                                                  enforce Secret-format
//                                                  rules; without it, only
//                                                  structural checks run)
//          [--stageLabel <label>]                (optional — filters to one
//                                                  stage in a Stages[]-shaped
//                                                  file; same semantics as
//                                                  verify-env-var-values.js)
//          [--token <bearer>]                    (otherwise acquired via az
//                                                  CLI for envUrl)
//
// Output (JSON to stdout):
//   {
//     "ok": true,
//     "settingsFile": "<path>",
//     "stageLabel": "<label|null>",
//     "summary": {
//       "total": N,
//       "valid": K,
//       "invalid": M,
//       "unknown-type": U,
//       "skipped": S
//     },
//     "findings": [
//       {
//         "schemaName": "<name>",
//         "stageLabel": "<stage|null>",
//         "value": "<value>",
//         "type": "Secret" | "String" | "Number" | "Boolean" | "JSON" | "DataSource" | "unknown",
//         "valueFormat": "kv-uri" | "kv-resource-id" | "kv-placeholder" |
//                        "empty" | "plain-text" | "invalid-uri" | "non-secret",
//         "status": "valid" | "invalid" | "unknown-type" | "skipped",
//         "severity": "error" | "warning" | "info",
//         "message": "<human-readable explanation>"
//       },
//       ...
//     ]
//   }
//
// Exit codes:
//   0  Validation ran cleanly. Caller decides whether to block on
//      `summary.invalid > 0`. The helper does NOT exit 1 for findings —
//      this preserves the contract used by verify-env-var-values.js and
//      keeps "run failed" separate from "run found problems."
//   1  Couldn't read settings file, couldn't parse JSON, or usage error.

'use strict';

const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;
const { readSettingsFile } = require('./verify-env-var-values');

// ───────────────────────────────────────────────────────────────────────────
// Canonical Secret reference format detection
// ───────────────────────────────────────────────────────────────────────────
//
// Three formats Dataverse accepts for a Secret-type env var value:
//
//   1. Key Vault Secret Identifier URI
//      https://<vault>.vault.azure.net/secrets/<name>[/<version>]
//
//   2. Azure resource ID
//      /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/
//        vaults/<vault>/secrets/<name>
//
//   3. keyVaultReference JSON (less common at the .value level; this validator
//      treats it as out-of-scope — Phase 5.2 doesn't PATCH JSON envelopes
//      today)
//
// Everything else either fails ImportAsHolding ("invalid secret reference
// format") or — worse — gets accepted as a literal string and silently
// stores a placeholder where the maker thought they had a vault reference.

const KV_URI_PATTERN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])?\.vault\.azure\.net\/secrets\/[A-Za-z0-9-]+(?:\/[a-f0-9]{32})?$/i;

const KV_RESOURCE_ID_PATTERN =
  /^\/subscriptions\/[a-f0-9-]{8,}\/resource[Gg]roups\/[^/]+\/providers\/Microsoft\.KeyVault\/vaults\/[^/]+\/secrets\/[^/]+$/;

// Placeholder patterns we've seen in the wild — surface them with a
// specific, actionable remediation message rather than the generic
// "doesn't match a valid Secret reference format." These are NOT
// recognized by Dataverse / the Pipelines handler.
const KV_PLACEHOLDER_PATTERNS = [
  /^@KeyVault\b/i,            // @KeyVault(vaultName=...;secretName=...)
  /^<.*KEY.*VAULT.*>$/i,      // <KEY_VAULT_URI>, <KeyVault-...>, etc.
  /^<TODO>$/i,                // explicit TODO placeholder
  /^<.*PLACEHOLDER.*>$/i,
  /^\$\{[A-Z_]+\}$/,          // bash-style ${ENV_VAR} expansion (not resolved by handler)
];

function classifyValueFormat(value) {
  if (value === null || value === undefined || value === '') return 'empty';
  const str = String(value);
  if (KV_URI_PATTERN.test(str)) return 'kv-uri';
  if (KV_RESOURCE_ID_PATTERN.test(str)) return 'kv-resource-id';
  for (const p of KV_PLACEHOLDER_PATTERNS) {
    if (p.test(str)) return 'kv-placeholder';
  }
  // Heuristic: if it looks like an HTTPS URL but didn't match the strict
  // KV-URI pattern, flag specifically as invalid-uri so the user sees
  // "URI is close but not right" rather than "not a Secret reference at
  // all." A common case: missing /secrets/ segment, or wrong host suffix.
  if (/^https:\/\//i.test(str)) return 'invalid-uri';
  return 'plain-text';
}

// ───────────────────────────────────────────────────────────────────────────
// Per-entry classification
// ───────────────────────────────────────────────────────────────────────────

function classifyEntry({ schemaName, value, type, stageLabel }) {
  const valueFormat = classifyValueFormat(value);
  const base = { schemaName, stageLabel: stageLabel || null, value, type };

  // Empty value is always valid — "use default" or "not set this stage."
  // Per-stage values can legitimately be empty when the env var has a
  // sensible default-value baked into the definition (common for Strings).
  if (valueFormat === 'empty') {
    return {
      ...base,
      valueFormat: 'empty',
      status: 'valid',
      severity: 'info',
      message: 'Empty value — runtime falls back to the env var definition default.',
    };
  }

  // Secret type: strict format enforcement.
  if (type === 'Secret') {
    if (valueFormat === 'kv-uri') {
      return {
        ...base,
        valueFormat,
        status: 'valid',
        severity: 'info',
        message: 'Valid Key Vault Secret Identifier URI.',
      };
    }
    if (valueFormat === 'kv-resource-id') {
      return {
        ...base,
        valueFormat,
        status: 'valid',
        severity: 'info',
        message: 'Valid Azure Key Vault resource ID.',
      };
    }
    if (valueFormat === 'kv-placeholder') {
      return {
        ...base,
        valueFormat,
        status: 'invalid',
        severity: 'error',
        message:
          `Secret env var \`${schemaName}\` has a placeholder value. ` +
          `Dataverse / the Pipelines handler does NOT recognize template patterns like \`@KeyVault(...)\` or \`<KEY_VAULT_URI>\`. ` +
          `Replace with a Key Vault Secret Identifier URI (e.g. https://<vault>.vault.azure.net/secrets/<name>) ` +
          `or an Azure resource ID. See configure-env-variables Phase 3.B and add-server-logic Phase 7.2a for the canonical formats.`,
      };
    }
    if (valueFormat === 'invalid-uri') {
      return {
        ...base,
        valueFormat,
        status: 'invalid',
        severity: 'error',
        message:
          `Secret env var \`${schemaName}\` value looks like an HTTPS URL but is not a valid Key Vault Secret Identifier ` +
          `(expected shape: https://<vault>.vault.azure.net/secrets/<name>[/<version>], all lowercase host, ` +
          `optional 32-char hex version suffix). Check the host, the /secrets/ segment, and the version format.`,
      };
    }
    // plain-text — could be a raw secret value that landed here by accident
    // (typing the actual API key into deployment-settings.json). That's a
    // security concern AND a deploy failure — Dataverse won't accept it as
    // a Secret reference. Strong error.
    return {
      ...base,
      valueFormat: 'plain-text',
      status: 'invalid',
      severity: 'error',
      message:
        `Secret env var \`${schemaName}\` has a plain-text value where a Key Vault reference is expected. ` +
        `If this is a real secret, REMOVE it from deployment-settings.json (the file is committed to git!) and ` +
        `store the secret in Azure Key Vault via store-keyvault-secret.js, then use the resulting Secret Identifier URI here. ` +
        `If you intended plain text, the env var type should be String (100000000), not Secret (100000005).`,
    };
  }

  // Unknown type (envUrl not provided or lookup failed): structural-only
  // check. We can still flag obvious placeholders even without knowing the
  // type, since `@KeyVault(...)` and friends aren't valid for ANY env var
  // type — they're not recognized syntax anywhere.
  if (type === 'unknown') {
    if (valueFormat === 'kv-placeholder') {
      return {
        ...base,
        valueFormat,
        status: 'invalid',
        severity: 'error',
        message:
          `\`${schemaName}\` has a placeholder value (\`${value}\`). ` +
          `This is not a recognized syntax for any env var type. ` +
          `If it's intended as a Key Vault reference, use the Secret Identifier URI or Azure resource ID format ` +
          `(see configure-env-variables Phase 3.B). If the env var type is String, write the literal value.`,
      };
    }
    return {
      ...base,
      valueFormat,
      status: 'unknown-type',
      severity: 'info',
      message:
        `Type unknown (envUrl not provided or lookup failed). ` +
        `Value format is "${valueFormat}". Cannot enforce type-specific rules — re-run with --envUrl for full validation.`,
    };
  }

  // String / Number / Boolean / JSON / DataSource: no format constraint we
  // can validate offline. Anything non-empty is structurally valid.
  return {
    ...base,
    valueFormat: valueFormat === 'plain-text' ? 'non-secret' : valueFormat,
    status: 'valid',
    severity: 'info',
    message: `${type} value — no format constraint enforced.`,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Env var type lookup (only used when --envUrl is provided)
// ───────────────────────────────────────────────────────────────────────────

const TYPE_LABELS = {
  100000000: 'String',
  100000001: 'Number',
  100000002: 'Boolean',
  100000003: 'JSON',
  100000004: 'DataSource',
  100000005: 'Secret',
};

async function lookupTypes(envUrl, token, schemaNames) {
  const types = new Map(); // schemaName → 'String' | 'Secret' | ...
  if (!envUrl || !token || schemaNames.length === 0) return types;
  const base = envUrl.replace(/\/+$/, '');
  // Single query per schema is fine for small lists (typical
  // deployment-settings.json has 1–10 entries). For larger files an
  // `in` filter or a single startswith would be faster — out of scope.
  for (const schemaName of schemaNames) {
    const escaped = String(schemaName).replace(/'/g, "''");
    const url =
      `${base}/api/data/v9.2/environmentvariabledefinitions` +
      `?$filter=schemaname eq '${escaped}'` +
      `&$select=schemaname,type`;
    // eslint-disable-next-line no-await-in-loop
    const res = await helpers.makeRequest({
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
      },
      timeout: 20000,
    });
    if (!res || res.error || res.statusCode !== 200 || !res.body) {
      // Don't propagate — fall through to "unknown" for this schema only.
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      continue;
    }
    const rows = Array.isArray(parsed.value) ? parsed.value : [];
    if (rows.length > 0) {
      const code = rows[0].type;
      const label = TYPE_LABELS[code] || 'unknown';
      types.set(schemaName, label);
    }
  }
  return types;
}

// ───────────────────────────────────────────────────────────────────────────
// Orchestration
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { settingsFile: null, envUrl: null, stageLabel: null, token: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settingsFile' && args[i + 1]) out.settingsFile = args[++i];
    else if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--stageLabel' && args[i + 1]) out.stageLabel = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
  }
  return out;
}

// Entry reader: delegates to verify-env-var-values.js#readSettingsFile,
// which handles all three deployment-settings.json shapes and returns
// `{ schemaName, value, stageLabel }` on each entry.
//
// `preserveAllStages: true` is critical here — without it, the default
// readSettingsFile path dedupes by schemaName (keeping only the first
// stage's value for each env var). For VALIDATION we must inspect every
// stage's value independently: the same schema can be valid in Staging
// and invalid in Production, and the validator must catch both.
async function validateSettings({ settingsFile, envUrl, stageLabel, token }) {
  if (!settingsFile) throw new Error('--settingsFile is required');
  const entries = readSettingsFile(settingsFile, stageLabel, {
    preserveAllStages: true,
  });

  // Collect unique schema names for the type lookup pass.
  const uniqueSchemas = Array.from(new Set(entries.map((e) => e.schemaName).filter(Boolean)));

  let typeMap = new Map();
  if (envUrl && uniqueSchemas.length > 0) {
    let bearer = token;
    if (!bearer) {
      try {
        bearer = getAuthToken(envUrl);
      } catch {
        // swallow — entries fall through to unknown-type
      }
    }
    if (bearer) {
      typeMap = await lookupTypes(envUrl, bearer, uniqueSchemas);
    }
  }

  const findings = [];
  for (const e of entries) {
    if (!e.schemaName) {
      findings.push({
        schemaName: null,
        stageLabel: e.stageLabel,
        value: e.value,
        type: 'unknown',
        valueFormat: 'invalid',
        status: 'invalid',
        severity: 'error',
        message: 'Entry has no SchemaName — missing or empty field in deployment-settings.json.',
      });
      continue;
    }
    const type = typeMap.get(e.schemaName) || 'unknown';
    findings.push(
      classifyEntry({
        schemaName: e.schemaName,
        value: e.value,
        type,
        stageLabel: e.stageLabel,
      })
    );
  }

  const summary = {
    total: findings.length,
    valid: findings.filter((f) => f.status === 'valid').length,
    invalid: findings.filter((f) => f.status === 'invalid').length,
    'unknown-type': findings.filter((f) => f.status === 'unknown-type').length,
    skipped: findings.filter((f) => f.status === 'skipped').length,
  };

  return {
    ok: true,
    settingsFile,
    stageLabel: stageLabel || null,
    summary,
    findings,
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.settingsFile) {
    process.stderr.write('Error: --settingsFile is required\n');
    return 1;
  }
  try {
    const result = await validateSettings(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`Validation failed: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code));
}

module.exports = {
  validateSettings,
  classifyEntry,
  classifyValueFormat,
  lookupTypes,
  KV_URI_PATTERN,
  KV_RESOURCE_ID_PATTERN,
  KV_PLACEHOLDER_PATTERNS,
  TYPE_LABELS,
};
