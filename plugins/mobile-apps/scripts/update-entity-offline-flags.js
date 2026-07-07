#!/usr/bin/env node

// Flips IsAvailableOffline and/or ChangeTrackingEnabled on a Dataverse table's
// EntityMetadata via PUT /EntityDefinitions(LogicalName='<x>'). Sends the
// MSCRM.MergeLabels=true header so display labels are preserved.
//
// Companion to /enable-tables-offline Step 4. Sequential per-table use only —
// Dataverse serializes metadata writes via an exclusive lock; concurrent PUTs
// return 429 / MetadataLockHeldException.
//
// Idempotent: if the current state already matches the requested state, no
// PUT is issued and the script returns status 200 with no-op=true.
//
// Usage:
//   node update-entity-offline-flags.js <envUrl> \
//     --table <table_logical_name> \
//     [--offline true|false]   (default: true)
//     [--tracking true|false]  (default: true)
//
// Output (single-line JSON to stdout):
//   No-op:    { "status": 200, "table": "...", "noop": true, "before": {...} }
//   Updated:  { "status": 204, "table": "...", "before": {...}, "after": {...} }
//   Skipped:  { "status": 200, "table": "...", "skipped": "uncustomizable" }
//   Error:    { "status": <code>, "table": "...", "error": "..." }
//
// Exit codes:
//   0 — request completed (check status field)
//   1 — bad args, auth failure, network failure after retries

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length < 1 || argv[0].startsWith('--')) {
    usage('envUrl is required as the first positional argument');
  }

  const out = {
    envUrl: argv[0].replace(/\/+$/, ''),
    table: null,
    offline: true,
    tracking: true,
  };

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--table':    out.table = next; i++; break;
      case '--offline':  out.offline = parseBool('--offline', next); i++; break;
      case '--tracking': out.tracking = parseBool('--tracking', next); i++; break;
      default:           usage(`Unknown flag: ${flag}`);
    }
  }

  if (!out.table) usage('--table is required');
  if (!/^[a-z][a-z0-9_]*$/.test(out.table)) {
    usage(`--table must be a lowercase logical name: got "${out.table}"`);
  }

  return out;
}

function parseBool(flag, value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  usage(`${flag} must be 'true' or 'false', got "${value}"`);
}

function usage(msg) {
  process.stderr.write(`Error: ${msg}\n\n`);
  process.stderr.write(
    'Usage: node update-entity-offline-flags.js <envUrl> --table <name> ' +
      '[--offline true|false] [--tracking true|false]\n'
  );
  process.exit(1);
}

async function getCurrentState(envUrl, table, token) {
  const url = `${envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${table}')?$select=MetadataId,LogicalName,SchemaName,IsAvailableOffline,ChangeTrackingEnabled,IsCustomizable,OwnershipType`;
  const res = await makeRequest({
    url,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  if (res.error) return { error: res.error };
  if (res.statusCode !== 200) {
    let data = null;
    try { data = JSON.parse(res.body); } catch { data = res.body; }
    return { status: res.statusCode, data };
  }

  const meta = JSON.parse(res.body);
  return {
    status: 200,
    metadataId: meta.MetadataId,
    schemaName: meta.SchemaName,
    isAvailableOffline: meta.IsAvailableOffline,
    changeTrackingEnabled: meta.ChangeTrackingEnabled,
    // IsCustomizable is a ManagedProperty: { Value: true|false, CanBeChanged, ManagedPropertyLogicalName }
    isCustomizable: meta.IsCustomizable?.Value !== false,
    ownershipType: meta.OwnershipType,
  };
}

async function putMetadata(envUrl, table, current, desired, token) {
  const url = `${envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${table}')`;
  const body = JSON.stringify({
    '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
    MetadataId: current.metadataId,
    LogicalName: table,
    SchemaName: current.schemaName,
    IsAvailableOffline: desired.offline,
    ChangeTrackingEnabled: desired.tracking,
  });

  const res = await makeRequest({
    url,
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'MSCRM.MergeLabels': 'true',
    },
    body,
    timeout: 60000,
  });

  return res;
}

async function main() {
  const { envUrl, table, offline, tracking } = parseArgs();

  let token = await getAuthToken(envUrl);
  if (!token) {
    process.stderr.write('Failed to get Azure CLI token. Run `az login` first.\n');
    process.exit(1);
  }

  const current = await getCurrentState(envUrl, table, token);
  if (current.error) {
    console.log(JSON.stringify({ status: 0, table, error: current.error }));
    process.exit(1);
  }
  if (current.status !== 200) {
    console.log(JSON.stringify({ status: current.status, table, error: current.data }));
    process.exit(0);
  }

  const before = {
    isAvailableOffline: current.isAvailableOffline,
    changeTrackingEnabled: current.changeTrackingEnabled,
    isCustomizable: current.isCustomizable,
    ownershipType: current.ownershipType,
  };

  // Skip uncustomizable tables — they're system-managed and PUT will return 403
  if (!current.isCustomizable) {
    console.log(JSON.stringify({ status: 200, table, skipped: 'uncustomizable', before }));
    return;
  }

  // No-op check
  if (before.isAvailableOffline === offline && before.changeTrackingEnabled === tracking) {
    console.log(JSON.stringify({ status: 200, table, noop: true, before }));
    return;
  }

  // Retry loop on 401 (token refresh) and 429 (back-off)
  let res = null;
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    res = await putMetadata(envUrl, table, current, { offline, tracking }, token);

    if (res.error) {
      if (attempt < maxRetries) continue;
      console.log(JSON.stringify({ status: 0, table, error: res.error }));
      process.exit(1);
    }

    if (res.statusCode === 401 && attempt < maxRetries) {
      token = await getAuthToken(envUrl);
      if (!token) {
        console.log(JSON.stringify({ status: 401, table, error: 'token refresh failed' }));
        process.exit(1);
      }
      continue;
    }

    if (res.statusCode === 429 && attempt < maxRetries) {
      const retryAfter = res.headers?.['retry-after'];
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 30000;
      process.stderr.write(`429 rate-limited — waiting ${delayMs / 1000}s\n`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    break;
  }

  if (res.statusCode === 204) {
    console.log(JSON.stringify({
      status: 204,
      table,
      before,
      after: {
        isAvailableOffline: offline,
        changeTrackingEnabled: tracking,
      },
    }));
    return;
  }

  // Non-204 error — surface the body
  let data = null;
  try { data = JSON.parse(res.body); } catch { data = res.body; }
  console.log(JSON.stringify({ status: res.statusCode, table, error: data }));
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.stack || err.message}\n`);
  process.exit(1);
});
