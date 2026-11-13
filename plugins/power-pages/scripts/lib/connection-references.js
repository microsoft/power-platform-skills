#!/usr/bin/env node

// Connection reference binding for ALM deploys: which connection references a solution
// carries, which target connections can satisfy them, the per-stage bindings stored in
// deployment-settings.json, and (for direct imports) writing those bindings onto the
// imported connection references.
//
// Why: connection references import UNBOUND unless the deploy supplies a connection
// for each one. A site connection whose connection reference has no connection fails at
// runtime ("connector configuration was not found"), so every deploy path must bind them.
// Pipelines take the bindings in `deploymentsettingsjson.ConnectionReferences`; direct
// imports (import-solution) bind afterwards with a PATCH of connectionreference.connectionid.
// Deployment settings file format (ConnectionReferences entries are
// { LogicalName, ConnectionId, ConnectorId }):
// https://learn.microsoft.com/en-us/power-platform/alm/conn-ref-env-variables-build-tools#deployment-settings-file
//
// Usage:
//   node connection-references.js list-solution    --envUrl <src> --solutionIds <guid,guid> [--token t]
//   node connection-references.js list-connections --environmentId <target env guid> --connector <name|id>
//                                                  [--cloud Public] [--token <Power Platform API token>]
//   node connection-references.js check-settings   --envUrl <src> --solutionIds <guid,guid>
//                                                  --settingsFile <path> --stageLabel <stage>
//                                                  [--targetEnvUrl <target> [--targetToken t]] [--token t]
//        With --targetEnvUrl, each required reference also gets `targetConnectorId` — custom
//        connectors have a different internal name in every environment (see mapConnectorsToTarget).
//   node connection-references.js save-settings    --settingsFile <path> --stageLabel <stage> --entriesFile <path>
//   node connection-references.js bind             --envUrl <target> --settingsFile <path> --stageLabel <stage> [--token t]
//
// All subcommands print JSON to stdout. Exit 0 when the command ran (inspect the JSON —
// e.g. `unbound` for check-settings, per-entry `status` for bind); exit 1 on usage,
// auth, file or request errors.

'use strict';

const fs = require('fs');
const helpers = require('./validation-helpers');
const connectivity = require('./connectivity-api');
const siteConnections = require('./site-connections');
const { normalizeStageLabel } = require('./refresh-alm-plan-data');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stageKey(label) {
  return normalizeStageLabel(String(label || '')).toLowerCase();
}

function toEntries(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e === 'object' && e.LogicalName)
    .map((e) => ({ LogicalName: e.LogicalName, ConnectionId: e.ConnectionId || '', ConnectorId: e.ConnectorId || '' }));
}

/**
 * Locates the settings block for a stage. Supports the same shapes as
 * verify-env-var-values.js#readSettingsFile, plus the stage-keyed top-level object
 * that deploy-pipeline's template writes:
 *   1. { "ConnectionReferences": [...] }                          (single stage)
 *   2. { "Stages": [{ "Name": "Staging", "ConnectionReferences": [...] }] }
 *   3. { "stages": { "Staging": { "ConnectionReferences": [...] } } }
 *   4. { "Staging": { "EnvironmentVariables": [...], "ConnectionReferences": [...] } }
 * Stage names match after normalization ("Deploy to Staging" ↔ "Staging").
 * Every stage shape is searched before falling back to the single-stage block, so a
 * file that mixes shapes (e.g. a `stages` object added next to top-level stage keys)
 * never hides a stage. Returns { container, key|index, block, singleStage } or null.
 */
function isSettingsBlock(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && (Array.isArray(v.ConnectionReferences) || Array.isArray(v.EnvironmentVariables));
}

function stagesObjectOf(parsed) {
  for (const k of ['stages', 'Stages', 'STAGES']) {
    const v = parsed[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

function locateStageBlock(parsed, stageLabel) {
  if (!parsed || typeof parsed !== 'object') return null;
  const wanted = stageLabel ? stageKey(stageLabel) : null;
  if (wanted) {
    if (Array.isArray(parsed.Stages)) {
      const index = parsed.Stages.findIndex((s) => s && stageKey(s.Name) === wanted);
      if (index >= 0) return { container: parsed.Stages, key: index, block: parsed.Stages[index], singleStage: false };
    }
    const stagesObj = stagesObjectOf(parsed);
    if (stagesObj) {
      const key = Object.keys(stagesObj).find((k) => stageKey(k) === wanted);
      if (key) return { container: stagesObj, key, block: stagesObj[key], singleStage: false };
    }
    const key = Object.keys(parsed).find((k) => stageKey(k) === wanted && isSettingsBlock(parsed[k]));
    if (key) return { container: parsed, key, block: parsed[key], singleStage: false };
  }
  if (isSettingsBlock(parsed)) {
    return { container: null, key: null, block: parsed, singleStage: true };
  }
  return null;
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`could not read ${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${err.message}`);
  }
}

/** Returns the stage's ConnectionReferences entries ([] when absent). */
function readConnectionReferenceSettings(filePath, stageLabel) {
  const parsed = readJsonFile(filePath);
  const located = locateStageBlock(parsed, stageLabel);
  return located ? toEntries(located.block.ConnectionReferences) : [];
}

/**
 * Merges entries (by LogicalName, case-insensitive) into the stage's
 * ConnectionReferences and writes the file back, preserving every other key. A stage
 * with no block yet is added to whichever per-stage container the file already uses
 * (`Stages[]`, a `stages`/`Stages` object, or top-level stage keys); a new file gets
 * `stages.{stageLabel}` (the shape deploy-pipeline reads).
 *
 * A single-stage file (top-level ConnectionReferences/EnvironmentVariables, the shape
 * `pac solution create-settings` writes) is refused: connection ids are
 * environment-specific, and writing one stage's choice into a block every stage reads
 * would silently send that connection to the next stage's deploy.
 */
function upsertConnectionReferenceSettings(filePath, stageLabel, entries) {
  if (!stageLabel) throw new Error('--stageLabel is required to save connection reference settings.');
  const parsed = readJsonFile(filePath) || {};
  let located = locateStageBlock(parsed, stageLabel);
  if (located && located.singleStage) {
    throw new Error(
      `${filePath} is a single-stage settings file (top-level ConnectionReferences/EnvironmentVariables), ` +
      `so a binding for stage "${stageLabel}" would apply to every stage. Move its contents under ` +
      `"stages": { "<stage>": { ... } } or pass a different --settingsFile.`
    );
  }
  if (!located) {
    const block = { EnvironmentVariables: [], ConnectionReferences: [] };
    const stagesObj = stagesObjectOf(parsed);
    const hasTopLevelStages = Object.keys(parsed).some((k) => isSettingsBlock(parsed[k]));
    if (Array.isArray(parsed.Stages)) {
      parsed.Stages.push({ Name: stageLabel, ...block });
    } else if (stagesObj) {
      stagesObj[stageLabel] = block;
    } else if (hasTopLevelStages) {
      parsed[stageLabel] = block;
    } else {
      parsed.stages = { [stageLabel]: block };
    }
    located = locateStageBlock(parsed, stageLabel);
  }
  const merged = toEntries(located.block.ConnectionReferences);
  for (const entry of toEntries(entries)) {
    const i = merged.findIndex((m) => m.LogicalName.toLowerCase() === entry.LogicalName.toLowerCase());
    if (i >= 0) merged[i] = entry;
    else merged.push(entry);
  }
  located.block.ConnectionReferences = merged;
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n');
  return merged;
}

/** Connection references that are components of any of the given solutions (source env). */
async function listSolutionConnectionReferences({ envUrl, token, solutionIds, makeRequest = helpers.makeRequest }) {
  const base = helpers.validateDataverseEnvironmentUrl(envUrl);
  const componentType = await siteConnections.resolveComponentType({
    envUrl: base, token, entityName: 'connectionreference', makeRequest,
  });
  if (componentType === null) return [];
  const ids = new Set();
  for (const solutionId of solutionIds || []) {
    if (!GUID_RE.test(String(solutionId))) throw new Error(`Invalid solutionId "${solutionId}".`);
    const url =
      `${base}/api/data/v9.2/solutioncomponents` +
      `?$filter=_solutionid_value eq ${solutionId} and componenttype eq ${componentType}&$select=objectid`;
    for (const row of await helpers.odataGetAll(url, token, makeRequest)) {
      if (row.objectid) ids.add(String(row.objectid).toLowerCase());
    }
  }
  if (ids.size === 0) return [];
  return siteConnections.fetchConnectionReferences({ envUrl: base, token, ids: [...ids], makeRequest });
}

/**
 * Maps source connector ids to the TARGET environment's connector ids.
 *
 * Certified connectors keep the same id everywhere. A custom connector's internal name
 * changes in every environment it is imported into, e.g.
 *   source: /providers/Microsoft.PowerApps/apis/shared_contosoapi-0123456789abcdef01-fedcba9876543210fe
 *   target: /providers/Microsoft.PowerApps/apis/shared_cr123-5fcontosoapi-0a1b2c3d4e5f6a7b8c
 * so it is matched through the Dataverse `connector` row's schema name (`cr123_contosoapi`),
 * which the solution carries unchanged. Target connections must be listed — and
 * `ConnectorId` written — against the target id.
 *
 * Returns Map(sourceConnectorId(lowercased) → { targetConnectorId, isCustom, schemaName, found, reason }).
 */
async function mapConnectorsToTarget({
  sourceEnvUrl, sourceToken, targetEnvUrl, targetToken, connectorIds, makeRequest = helpers.makeRequest,
}) {
  const ids = [...new Set((connectorIds || []).filter(Boolean))];
  const names = ids.map((id) => connectivity.connectorNameFromId(id));
  const sourceRows = (await siteConnections.fetchDataverseConnectors({
    envUrl: sourceEnvUrl, token: sourceToken, connectorNames: names, makeRequest,
  })) || [];
  const sourceByName = new Map(sourceRows.map((r) => [String(r.connectorName).toLowerCase(), r]));
  const schemaNames = sourceRows.map((r) => r.schemaName).filter(Boolean);
  const targetRows = schemaNames.length
    ? (await siteConnections.fetchDataverseConnectors({ envUrl: targetEnvUrl, token: targetToken, schemaNames, makeRequest })) || []
    : [];
  const targetBySchema = new Map(targetRows.map((r) => [String(r.schemaName).toLowerCase(), r]));

  const out = new Map();
  ids.forEach((id, i) => {
    const name = names[i];
    const src = sourceByName.get(name.toLowerCase());
    if (!src) {
      const isCustom = connectivity.looksLikeCustomConnector(name);
      out.set(id.toLowerCase(), isCustom
        ? { targetConnectorId: null, isCustom, schemaName: null, found: false, reason: 'Custom connector is not solution-aware in the source.' }
        : { targetConnectorId: connectivity.connectorIdFromName(name), isCustom, schemaName: null, found: true, reason: null });
      return;
    }
    const tgt = targetBySchema.get(String(src.schemaName).toLowerCase());
    out.set(id.toLowerCase(), tgt
      ? { targetConnectorId: connectivity.connectorIdFromName(tgt.connectorName), isCustom: true, schemaName: src.schemaName, found: true, reason: null }
      : {
        targetConnectorId: null, isCustom: true, schemaName: src.schemaName, found: false,
        reason: `Custom connector ${src.schemaName} is not in the target yet — deploy the connectors solution first.`,
      });
  });
  return out;
}

/**
 * Compares the connection references a deploy carries with the stage's bindings.
 * `unbound` lists every required reference without a non-empty ConnectionId. A
 * configured entry with no ConnectorId gets the reference's target connector id when
 * known (see mapConnectorsToTarget), else its source connector id.
 */
function findUnboundConnectionReferences(required, settingsEntries) {
  const byName = new Map(toEntries(settingsEntries).map((e) => [e.LogicalName.toLowerCase(), e]));
  const unbound = [];
  const configured = [];
  for (const ref of required) {
    const entry = byName.get(String(ref.logicalName).toLowerCase());
    if (entry && entry.ConnectionId) {
      configured.push({ ...entry, ConnectorId: entry.ConnectorId || ref.targetConnectorId || ref.connectorId || '' });
    } else {
      unbound.push(ref);
    }
  }
  return { configured, unbound };
}

/**
 * Binds connection references in the TARGET environment by logical name (ids differ
 * from the source). Used after a direct solution import; Pipelines binds through
 * deploymentsettingsjson instead.
 */
async function bindConnectionReferences({ envUrl, token, entries, makeRequest = helpers.makeRequest }) {
  const base = helpers.validateDataverseEnvironmentUrl(envUrl);
  const list = toEntries(entries);
  const found = await siteConnections.fetchConnectionReferences({
    envUrl: base, token, logicalNames: list.map((e) => e.LogicalName), makeRequest,
  });
  const byName = new Map(found.map((r) => [String(r.logicalName).toLowerCase(), r]));
  const results = [];
  for (const entry of list) {
    const ref = byName.get(entry.LogicalName.toLowerCase());
    if (!entry.ConnectionId) {
      results.push({ logicalName: entry.LogicalName, status: 'skipped', message: 'No ConnectionId configured.' });
    } else if (!ref) {
      results.push({ logicalName: entry.LogicalName, status: 'not-found', message: 'No connection reference with this logical name in the target.' });
    } else if (ref.connectionId === entry.ConnectionId) {
      results.push({ logicalName: entry.LogicalName, status: 'unchanged', connectionReferenceId: ref.id });
    } else {
      const res = await makeRequest({
        url: `${base}/api/data/v9.2/connectionreferences(${ref.id})`,
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          'If-Match': '*',
        },
        body: JSON.stringify({ connectionid: entry.ConnectionId }),
        timeout: 30000,
      });
      const ok = !res.error && res.statusCode >= 200 && res.statusCode < 300;
      results.push({
        logicalName: entry.LogicalName,
        connectionReferenceId: ref.id,
        status: ok ? 'bound' : 'failed',
        ...(ok ? {} : { message: res.error || `HTTP ${res.statusCode}: ${String(res.body || '').slice(0, 300)}` }),
      });
    }
  }
  return { ok: results.every((r) => r.status === 'bound' || r.status === 'unchanged'), results };
}

function parseArgs(argv) {
  const [command, ...rest] = argv.slice(2);
  const out = { command, solutionIds: [] };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag.startsWith('--') || value === undefined) continue;
    const key = flag.slice(2);
    if (key === 'solutionIds') out.solutionIds = value.split(',').map((s) => s.trim()).filter(Boolean);
    else out[key] = value;
    i++;
  }
  return out;
}

function dataverseToken(envUrl, token) {
  const resolved = token || helpers.getAuthToken(envUrl);
  if (!resolved) throw new Error('Failed to acquire a Dataverse token. Run `az login` or pass --token.');
  return resolved;
}

async function main() {
  const args = parseArgs(process.argv);
  let result;
  switch (args.command) {
    case 'list-solution': {
      const envUrl = helpers.validateDataverseEnvironmentUrl(args.envUrl);
      const refs = await listSolutionConnectionReferences({
        envUrl, token: dataverseToken(envUrl, args.token), solutionIds: args.solutionIds,
      });
      result = { connectionReferences: refs };
      break;
    }
    case 'list-connections': {
      const cloud = args.cloud || (helpers.getPacAuthInfo() || {}).cloud || 'Public';
      const token = args.token || helpers.getAuthToken(connectivity.tokenResourceForCloud(cloud));
      if (!token) throw new Error('Failed to acquire a Power Platform API token. Run `az login` or pass --token.');
      const connections = await connectivity.listConnections({
        environmentId: args.environmentId, connectorName: args.connector, cloud, token,
      });
      result = { connector: connectivity.connectorNameFromId(args.connector), connections };
      break;
    }
    case 'check-settings': {
      const envUrl = helpers.validateDataverseEnvironmentUrl(args.envUrl);
      const token = dataverseToken(envUrl, args.token);
      let required = await listSolutionConnectionReferences({ envUrl, token, solutionIds: args.solutionIds });
      if (args.targetEnvUrl) {
        const targetEnvUrl = helpers.validateDataverseEnvironmentUrl(args.targetEnvUrl);
        const mapping = await mapConnectorsToTarget({
          sourceEnvUrl: envUrl, sourceToken: token,
          targetEnvUrl, targetToken: dataverseToken(targetEnvUrl, args.targetToken),
          connectorIds: required.map((r) => r.connectorId),
        });
        required = required.map((r) => {
          const m = mapping.get(String(r.connectorId || '').toLowerCase()) || {};
          return { ...r, targetConnectorId: m.targetConnectorId || null, targetConnectorFound: m.found === true, targetConnectorReason: m.reason || null };
        });
      }
      const settings = args.settingsFile ? readConnectionReferenceSettings(args.settingsFile, args.stageLabel) : [];
      result = { required, ...findUnboundConnectionReferences(required, settings) };
      break;
    }
    case 'save-settings': {
      const entries = readJsonFile(args.entriesFile);
      if (!Array.isArray(entries)) throw new Error('--entriesFile must contain a JSON array of { LogicalName, ConnectionId, ConnectorId }.');
      result = { saved: upsertConnectionReferenceSettings(args.settingsFile, args.stageLabel, entries) };
      break;
    }
    case 'bind': {
      const envUrl = helpers.validateDataverseEnvironmentUrl(args.envUrl);
      const entries = readConnectionReferenceSettings(args.settingsFile, args.stageLabel);
      result = await bindConnectionReferences({ envUrl, token: dataverseToken(envUrl, args.token), entries });
      break;
    }
    default:
      throw new Error('Usage: connection-references.js <list-solution|list-connections|check-settings|save-settings|bind> [flags]');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  locateStageBlock,
  readConnectionReferenceSettings,
  upsertConnectionReferenceSettings,
  listSolutionConnectionReferences,
  mapConnectorsToTarget,
  findUnboundConnectionReferences,
  bindConnectionReferences,
  parseArgs,
};
