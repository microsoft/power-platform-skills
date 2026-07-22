#!/usr/bin/env node

// Verifies that environment variable VALUE records actually landed on a target
// environment after deploy, import, or configure. Read-only; no Dataverse
// writes, no filesystem writes (the caller decides what to do with the JSON
// result).
//
// Why this exists: deploy-pipeline Phase 5.2 PATCHes `deploymentsettingsjson`
// onto a stage run; the Power Platform Pipelines handler then writes
// `environmentvariablevalues` records on the target as part of the import.
// **But** the handler does not always write values for every definition in
// `deploymentsettingsjson` — definitions that aren't bound to an
// `mspp_sitesetting` (or another consumer the platform recognizes) can land
// as zero-value on the target even when the stage run reports success. This
// helper closes the verification gap.
//
// Usage:
//   node verify-env-var-values.js
//          --envUrl <target>                          (required — Dataverse target URL)
//          [--schemaNames <comma-list>]               (verify these schemas; OR --settingsFile)
//          [--settingsFile <path>]                    (read EnvironmentVariables[] from a
//                                                       Microsoft-standard deployment-settings.json)
//          [--stageLabel <label>]                     (when --settingsFile is provided, filter
//                                                       to this stage's entries — Foundation /
//                                                       Staging / Production / etc.)
//          [--expectedValues <json>]                  (optional JSON map { schemaName: value }
//                                                       — when present, every landed value
//                                                       must match; mismatches surface as
//                                                       `status: "value-mismatch"`)
//          [--token <bearer>]                         (otherwise acquired via Azure CLI for envUrl)
//
// Inputs are mutually-exclusive for the schema source: either pass
// `--schemaNames` directly, or pass `--settingsFile` and we'll read the
// list. If neither is provided, exit 1 with a usage error.
//
// Output (JSON to stdout):
//   {
//     "ok": true,
//     "target": { "envUrl": "<envUrl>", "stageLabel": "<stageLabel|null>" },
//     "summary": { "total": N, "landed": K, "missing": M, "mismatched": L, "error": E },
//     "results": [
//       {
//         "schemaName": "<name>",
//         "definitionId": "<guid|null>",
//         "valueId": "<guid|null>",
//         "value": "<value|null>",
//         "expected": "<value|undefined>",            // present only when --expectedValues used
//         "status": "landed" | "missing-value-record" | "missing-definition" |
//                   "value-mismatch" | "query-error"
//       },
//       ...
//     ]
//   }
//
// Exit codes:
//   0  Check ran cleanly (regardless of how many entries missed). The caller
//      decides whether to block on `summary.missing > 0`.
//   1  Could not reach the target env, auth failed, or a usage error — the
//      run is INCONCLUSIVE, not "deploy failed". Surface to the user
//      accordingly.

'use strict';

const fs = require('fs');
const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;
// Reuse the single "Deploy to {label}" → "{label}" normalizer so this helper
// matches the caller's --stageLabel against deployment-settings.json stage keys
// the SAME way the rest of the ALM stage consumers do. Without it, deploy-pipeline
// passing `--stageLabel "Deploy to Staging"` (the pipeline stage name) failed to
// match a settings file keyed by "Staging" → readSchemaNamesFromSettings returned
// [] → the whole verify reported total:0 (a silent no-op that gave false
// reassurance the overrides had landed).
const { normalizeStageLabel } = require('./refresh-alm-plan-data');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null,
    token: null,
    schemaNames: null,
    settingsFile: null,
    stageLabel: null,
    expectedValues: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--schemaNames' && args[i + 1]) out.schemaNames = args[++i];
    else if (args[i] === '--settingsFile' && args[i + 1]) out.settingsFile = args[++i];
    else if (args[i] === '--stageLabel' && args[i + 1]) out.stageLabel = args[++i];
    else if (args[i] === '--expectedValues' && args[i + 1]) out.expectedValues = args[++i];
  }
  return out;
}

// Read EnvironmentVariables[] from a Microsoft-standard deployment-settings.json.
// Supports three shapes that appear in the wild:
//   1. Top-level `EnvironmentVariables: [{ SchemaName, Value }, ...]` (single-stage file)
//   2. Per-stage array: `Stages: [{ Name, EnvironmentVariables: [...] }, ...]`
//      (capital-S, used by some hand-authored files)
//   3. Per-stage keyed object: `stages: { "<stage name>": { EnvironmentVariables: [...] } }`
//      (lowercase-s, the actual schema emitted by configure-env-variables and
//      consumed by Power Platform Pipelines — see schemas.microsoft.com/
//      power-platform/deployment-settings/2024. Discovered as a real-world gap
//      against the Citizens portal site, 2026-05-26.)
//
// Options:
//   stageLabel       — narrows the result to a single stage's entries (matched
//                      case-insensitively against `Name` for shape 2 or the
//                      keyed-object's key for shape 3).
//   preserveAllStages — when true, returns EVERY entry verbatim without
//                      dedupe — critical for validators that must inspect
//                      each stage's value independently. Default false
//                      (matches the old single-source-of-truth semantics for
//                      legacy callers like verify-env-var-values that report
//                      a single value per schema).
//
// Returns `[{ schemaName, value, stageLabel }]`.
// stageLabel is the stage name for shape 2/3 entries; null for shape 1.
function readSettingsFile(filePath, stageLabel, options = {}) {
  const preserveAllStages = options.preserveAllStages === true;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`could not read --settingsFile ${filePath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--settingsFile ${filePath} is not valid JSON: ${err.message}`);
  }

  // Normalize the requested label ("Deploy to Staging" → "staging") so it lines up
  // with however the settings file names its stages — see the require comment above.
  const lowerLabel = stageLabel ? normalizeStageLabel(stageLabel).toLowerCase() : null;

  // Shape 2: per-stage array (`Stages: []`)
  if (Array.isArray(parsed.Stages)) {
    if (!lowerLabel) {
      const all = [];
      for (const stage of parsed.Stages) {
        if (Array.isArray(stage.EnvironmentVariables)) {
          for (const ev of stage.EnvironmentVariables) {
            all.push({
              schemaName: ev.SchemaName,
              value: ev.Value,
              stageLabel: stage.Name || null,
            });
          }
        }
      }
      return preserveAllStages ? all : dedupeBySchemaName(all);
    }
    const stage = parsed.Stages.find(
      (s) => normalizeStageLabel(s.Name || '').toLowerCase() === lowerLabel
    );
    if (!stage || !Array.isArray(stage.EnvironmentVariables)) return [];
    return stage.EnvironmentVariables.map((ev) => ({
      schemaName: ev.SchemaName,
      value: ev.Value,
      stageLabel: stage.Name || null,
    }));
  }

  // Shape 3: per-stage keyed object (e.g. `stages: { "<name>": {...} }`).
  // This is the schema emitted by configure-env-variables and the one
  // Power Platform Pipelines actually accepts. Accept any common casing of
  // the top-level key (`stages`, `Stages`, `STAGES`) so hand-authored files
  // with mixed casing still resolve. (The shape 2 array check above only
  // matches when `parsed.Stages` is an Array; if it's a plain object, this
  // branch picks it up.)
  const stagesObj =
    parsed.stages || parsed.Stages || parsed.STAGES || null;
  if (
    stagesObj &&
    typeof stagesObj === 'object' &&
    !Array.isArray(stagesObj)
  ) {
    if (!lowerLabel) {
      const all = [];
      for (const [name, stage] of Object.entries(stagesObj)) {
        if (stage && Array.isArray(stage.EnvironmentVariables)) {
          for (const ev of stage.EnvironmentVariables) {
            all.push({
              schemaName: ev.SchemaName,
              value: ev.Value,
              stageLabel: name,
            });
          }
        }
      }
      return preserveAllStages ? all : dedupeBySchemaName(all);
    }
    // Case-insensitive key match (normalized so "Deploy to Staging" ↔ "Staging")
    const matchKey = Object.keys(stagesObj).find(
      (k) => normalizeStageLabel(k).toLowerCase() === lowerLabel
    );
    if (!matchKey) return [];
    const stage = stagesObj[matchKey];
    if (!stage || !Array.isArray(stage.EnvironmentVariables)) return [];
    return stage.EnvironmentVariables.map((ev) => ({
      schemaName: ev.SchemaName,
      value: ev.Value,
      stageLabel: matchKey,
    }));
  }

  // Shape 1: top-level `EnvironmentVariables: []` (single-stage file)
  if (Array.isArray(parsed.EnvironmentVariables)) {
    return parsed.EnvironmentVariables.map((ev) => ({
      schemaName: ev.SchemaName,
      value: ev.Value,
      stageLabel: null,
    }));
  }
  return [];
}

function dedupeBySchemaName(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (!e.schemaName || seen.has(e.schemaName)) continue;
    seen.add(e.schemaName);
    out.push(e);
  }
  return out;
}

async function odataGet(envUrl, token, path) {
  const base = envUrl.replace(/\/+$/, '');
  const res = await helpers.makeRequest({
    url: `${base}${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    timeout: 20000,
  });
  if (!res || res.error || res.statusCode !== 200 || !res.body) {
    return { ok: false, error: res && res.error ? res.error : `HTTP ${res && res.statusCode}` };
  }
  try {
    return { ok: true, body: JSON.parse(res.body) };
  } catch (err) {
    return { ok: false, error: `JSON parse: ${err.message}` };
  }
}

// Encode an OData string literal — escape single-quotes per OData spec by
// doubling them. Defensive against schema names that pass validation but
// contain unusual characters in user-coined slugs.
function odataString(s) {
  return String(s).replace(/'/g, "''");
}

async function verifyOne(envUrl, token, schemaName, expectedValue) {
  // Pass 1 — find the definition by schemaname.
  const defResp = await odataGet(
    envUrl,
    token,
    `/api/data/v9.2/environmentvariabledefinitions` +
      `?$filter=schemaname eq '${odataString(schemaName)}'` +
      `&$select=environmentvariabledefinitionid,schemaname,type`
  );
  if (!defResp.ok) {
    return {
      schemaName,
      definitionId: null,
      valueId: null,
      value: null,
      ...(expectedValue !== undefined ? { expected: expectedValue } : {}),
      status: 'query-error',
      error: defResp.error,
    };
  }
  const defs = defResp.body && Array.isArray(defResp.body.value) ? defResp.body.value : [];
  if (defs.length === 0) {
    return {
      schemaName,
      definitionId: null,
      valueId: null,
      value: null,
      ...(expectedValue !== undefined ? { expected: expectedValue } : {}),
      status: 'missing-definition',
    };
  }
  const definitionId = defs[0].environmentvariabledefinitionid;

  // Pass 2 — find the value record linked to that definition.
  const valResp = await odataGet(
    envUrl,
    token,
    `/api/data/v9.2/environmentvariablevalues` +
      `?$filter=_environmentvariabledefinitionid_value eq ${definitionId}` +
      `&$select=environmentvariablevalueid,value`
  );
  if (!valResp.ok) {
    return {
      schemaName,
      definitionId,
      valueId: null,
      value: null,
      ...(expectedValue !== undefined ? { expected: expectedValue } : {}),
      status: 'query-error',
      error: valResp.error,
    };
  }
  const vals = valResp.body && Array.isArray(valResp.body.value) ? valResp.body.value : [];
  if (vals.length === 0) {
    return {
      schemaName,
      definitionId,
      valueId: null,
      value: null,
      ...(expectedValue !== undefined ? { expected: expectedValue } : {}),
      status: 'missing-value-record',
    };
  }
  const valueRow = vals[0];
  const result = {
    schemaName,
    definitionId,
    valueId: valueRow.environmentvariablevalueid,
    value: valueRow.value === undefined ? null : valueRow.value,
    status: 'landed',
  };
  if (expectedValue !== undefined) {
    result.expected = expectedValue;
    if (String(result.value) !== String(expectedValue)) {
      result.status = 'value-mismatch';
    }
  }
  return result;
}

async function verifyEnvVarValues({ envUrl, token, schemaNames, expectedValuesMap, stageLabel }) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!Array.isArray(schemaNames) || schemaNames.length === 0) {
    throw new Error('schemaNames must be a non-empty array (use --schemaNames or --settingsFile)');
  }
  const results = [];
  for (const schemaName of schemaNames) {
    const expected = expectedValuesMap ? expectedValuesMap[schemaName] : undefined;
    // eslint-disable-next-line no-await-in-loop
    const r = await verifyOne(envUrl, token, schemaName, expected);
    results.push(r);
  }
  const summary = {
    total: results.length,
    landed: results.filter((r) => r.status === 'landed').length,
    missing: results.filter(
      (r) => r.status === 'missing-value-record' || r.status === 'missing-definition'
    ).length,
    mismatched: results.filter((r) => r.status === 'value-mismatch').length,
    error: results.filter((r) => r.status === 'query-error').length,
  };
  return {
    ok: true,
    target: { envUrl, stageLabel: stageLabel || null },
    summary,
    results,
  };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    return 1;
  }
  if (!args.envUrl) {
    process.stderr.write('Error: --envUrl is required\n');
    return 1;
  }
  if (!args.schemaNames && !args.settingsFile) {
    process.stderr.write('Error: provide either --schemaNames or --settingsFile\n');
    return 1;
  }

  // Resolve schemaNames + optional expectedValues map.
  let schemaNames = [];
  let expectedValuesMap = null;
  if (args.schemaNames) {
    schemaNames = args.schemaNames
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    try {
      const entries = readSettingsFile(args.settingsFile, args.stageLabel);
      schemaNames = entries.map((e) => e.schemaName).filter(Boolean);
      // When a settings file provides values, build a default expectedValues map
      // — callers wanting to disable the value-match check should pass
      // --schemaNames directly instead.
      expectedValuesMap = {};
      for (const e of entries) {
        if (e.schemaName) expectedValuesMap[e.schemaName] = e.value;
      }
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      return 1;
    }
  }
  if (args.expectedValues) {
    try {
      const override = JSON.parse(args.expectedValues);
      expectedValuesMap = expectedValuesMap || {};
      Object.assign(expectedValuesMap, override);
    } catch (err) {
      process.stderr.write(`Error: --expectedValues is not valid JSON: ${err.message}\n`);
      return 1;
    }
  }

  if (schemaNames.length === 0) {
    // Nothing to verify — emit an ok-but-empty result instead of failing.
    // Caller (deploy-pipeline Phase 7.6.5) treats this as "no env vars were
    // overridden this run, nothing to check".
    const out = {
      ok: true,
      target: { envUrl: args.envUrl, stageLabel: args.stageLabel || null },
      summary: { total: 0, landed: 0, missing: 0, mismatched: 0, error: 0 },
      results: [],
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  // Resolve auth token.
  let token = args.token;
  if (!token) {
    try {
      token = getAuthToken(args.envUrl);
    } catch (err) {
      process.stderr.write(`Failed to acquire token for ${args.envUrl}: ${err.message}\n`);
      return 1;
    }
    if (!token) {
      process.stderr.write(`Failed to acquire token for ${args.envUrl}\n`);
      return 1;
    }
  }

  try {
    const result = await verifyEnvVarValues({
      envUrl: args.envUrl,
      token,
      schemaNames,
      expectedValuesMap,
      stageLabel: args.stageLabel,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`Verification failed: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code));
}

module.exports = {
  verifyEnvVarValues,
  verifyOne,
  readSettingsFile,
  dedupeBySchemaName,
  odataString,
};
