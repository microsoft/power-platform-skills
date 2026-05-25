#!/usr/bin/env node

// Defensive write-back: strips invalid Secret-reference values from
// deployment-settings.json by setting `Value: ""` (which Dataverse interprets
// as "use the env var definition's default") for specified schema names.
// Used by deploy-pipeline Phase 7.6.4 as the strip-and-retry remediation
// when an import fails with the canonical Secret-reference validation
// error pattern.
//
// The pre-write validator (configure-env-variables Phase 6.1) catches these
// at write time so they shouldn't reach the deploy. This helper is the
// backstop for the cases where:
//   - The user hand-edited deployment-settings.json after configure-env-variables.
//   - A legacy deployment-settings.json was committed before Phase 6.1 existed.
//   - validate-deployment-settings.js's pre-PATCH gate (Phase 5.1b) was bypassed
//     by a transient failure or returned `status: "unknown-type"`.
//
// Empty-string semantics: per the canonical-Secret-format note in
// configure-env-variables Phase 3, `Value: ""` means "use the env var
// definition's default in this stage" — the safest fallback when a stage's
// Secret reference is malformed. The user can update the value to a real
// Key Vault URI later via configure-env-variables.
//
// Usage:
//   node strip-invalid-secret-values.js \
//     --settingsFile ./deployment-settings.json \
//     --schemaNames foo_secret,bar_apikey \
//     [--stageLabel "Deploy to Staging"]
//
// Behavior:
//   - Reads settingsFile, parses JSON, accepts both top-level-stage AND
//     nested-`stages` shapes (matching the schemas accepted by
//     validate-deployment-settings.js and refresh-alm-plan-data.js).
//   - For each entry in EnvironmentVariables[] whose SchemaName matches the
//     --schemaNames CSV, sets Value to "" (preserving the entry's structure).
//   - If --stageLabel is provided, only strips within that stage's
//     EnvironmentVariables[]. Without it, strips across ALL stages.
//   - Atomic tmp+rename to avoid mid-write corruption.
//
// Output (JSON to stdout):
//   {
//     "ok": true,
//     "settingsFile": "<absolute path>",
//     "stripped": [
//       { "stage": "Deploy to Staging", "schemaName": "foo_secret", "previousValue": "@KeyVault(...)" }
//     ],
//     "notFound": ["bar_apikey"],     // schema names that didn't appear in any stage
//     "totalStagesScanned": 2
//   }
//
// Exit 0 on success (including "no matches found"), exit 1 on fatal errors
// (missing args, unparseable settings file, write failure).

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    settingsFile: null,
    schemaNames: null,
    stageLabel: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settingsFile' && args[i + 1]) out.settingsFile = args[++i];
    else if (args[i] === '--schemaNames' && args[i + 1]) out.schemaNames = args[++i];
    else if (args[i] === '--stageLabel' && args[i + 1]) out.stageLabel = args[++i];
  }
  return out;
}

// Pick the right object to iterate stages over — accepts both shapes.
// Same logic as extractPerStageValues in refresh-alm-plan-data.js.
function resolveStagesContainer(deploymentSettings) {
  if (!deploymentSettings || typeof deploymentSettings !== 'object') return null;
  if (deploymentSettings.stages && typeof deploymentSettings.stages === 'object'
      && !Array.isArray(deploymentSettings.stages)) {
    return deploymentSettings.stages;
  }
  return deploymentSettings;
}

// Reserved keys at the root that are NOT stage entries.
const NON_STAGE_KEYS = new Set(['$schema', 'description', 'stages', 'EnvironmentVariables', 'ConnectionReferences']);

function stripInvalidSecretValues({ settingsFile, schemaNames, stageLabel, specs }) {
  if (!settingsFile) throw new Error('--settingsFile is required');
  // schemaNames can be a CSV string (from CLI) or an array (programmatic).
  let nameSet;
  if (Array.isArray(specs) && specs.length > 0) {
    nameSet = new Set(specs.map((s) => String(s).trim()).filter(Boolean));
  } else if (typeof schemaNames === 'string' && schemaNames.trim()) {
    nameSet = new Set(schemaNames.split(',').map((s) => s.trim()).filter(Boolean));
  } else if (Array.isArray(schemaNames) && schemaNames.length > 0) {
    nameSet = new Set(schemaNames.map((s) => String(s).trim()).filter(Boolean));
  } else {
    throw new Error('--schemaNames (or specs[]) must list at least one schema name to strip');
  }

  const absPath = path.resolve(settingsFile);
  if (!fs.existsSync(absPath)) {
    throw new Error(`settings file not found: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, 'utf8');
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    throw new Error(`settings file is not valid JSON: ${e.message}`);
  }

  const stagesContainer = resolveStagesContainer(settings);
  if (!stagesContainer) {
    throw new Error('settings file does not contain a parseable stages container');
  }

  const stripped = [];
  const seenSchemaNames = new Set();
  let totalStagesScanned = 0;

  for (const [maybeStageKey, stageBlock] of Object.entries(stagesContainer)) {
    // Filter out non-stage keys when iterating the root-level shape.
    if (NON_STAGE_KEYS.has(maybeStageKey)) continue;
    if (!stageBlock || typeof stageBlock !== 'object' || Array.isArray(stageBlock)) continue;

    // Scope to a specific stage if --stageLabel was supplied.
    if (stageLabel && maybeStageKey !== stageLabel) continue;
    totalStagesScanned += 1;

    const envVars = stageBlock.EnvironmentVariables || stageBlock.environmentVariables;
    if (!Array.isArray(envVars)) continue;

    for (const ev of envVars) {
      if (!ev || typeof ev !== 'object') continue;
      const evSchemaName = ev.SchemaName || ev.schemaName;
      if (!evSchemaName) continue;
      seenSchemaNames.add(evSchemaName);
      if (!nameSet.has(evSchemaName)) continue;
      const previousValue = ev.Value != null ? ev.Value : ev.value;
      if (previousValue === '' || previousValue == null) continue; // already stripped
      // Preserve whichever key shape the entry was using.
      if ('Value' in ev) ev.Value = '';
      if ('value' in ev) ev.value = '';
      // Cover the case where neither key was present (defensive).
      if (!('Value' in ev) && !('value' in ev)) ev.Value = '';
      stripped.push({ stage: maybeStageKey, schemaName: evSchemaName, previousValue });
    }
  }

  const notFound = Array.from(nameSet).filter((name) => !seenSchemaNames.has(name));

  // Only write if we actually changed something.
  if (stripped.length > 0) {
    const tmpPath = absPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
    fs.renameSync(tmpPath, absPath);
  }

  return {
    ok: true,
    settingsFile: absPath,
    stripped,
    notFound,
    totalStagesScanned,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  try {
    const result = stripInvalidSecretValues(args);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (e) {
    process.stderr.write('strip-invalid-secret-values: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = { stripInvalidSecretValues, resolveStagesContainer, NON_STAGE_KEYS };
