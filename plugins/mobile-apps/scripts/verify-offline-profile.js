#!/usr/bin/env node

// Post-creation verification for /setup-offline-profile.
//
// Re-fetches the Mobile Offline Profile + items + associations from Dataverse
// and asserts the shape matches the project's offline-profile.json. Also
// re-checks IsAvailableOffline + ChangeTrackingEnabled on each referenced
// table to catch silent EntityMetadata reverts (e.g. managed-solution patches).
//
// Called by /setup-offline-profile Step 9 (verification gate) and any time
// the user invokes /preview-offline-scope or /list-connections.
//
// Usage:
//   node verify-offline-profile.js <envUrl> [--project-root <path>]
//
//   <envUrl>           - Dataverse env URL (e.g. https://org123.crm.dynamics.com)
//   --project-root     - Path containing offline-profile.json. Default: cwd.
//
// Output (single-line JSON to stdout):
//   { "status": "ok", "profileId": "...", "checks": [ ... ] }
//   { "status": "drift", "profileId": "...", "drift": [ ... ], "checks": [ ... ] }
//   { "status": "missing", "error": "offline-profile.json not found at <path>" }
//   { "status": "error", "error": "..." }
//
// Exit codes:
//   0 — verification ran (check status field for ok / drift / missing)
//   1 — fatal error (auth, network, bad args)

const fs = require('fs');
const path = require('path');
const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length < 1 || argv[0].startsWith('--')) {
    usage('envUrl is required as the first positional argument');
  }

  const out = {
    envUrl: argv[0].replace(/\/+$/, ''),
    projectRoot: process.cwd(),
  };

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--project-root': out.projectRoot = next; i++; break;
      default:               usage(`Unknown flag: ${flag}`);
    }
  }

  return out;
}

function usage(msg) {
  process.stderr.write(`Error: ${msg}\n\n`);
  process.stderr.write('Usage: node verify-offline-profile.js <envUrl> [--project-root <path>]\n');
  process.exit(1);
}

async function dvGet(envUrl, apiPath, token) {
  const url = `${envUrl}/api/data/v9.2/${apiPath}`;
  const res = await makeRequest({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 30000,
  });

  if (res.error) return { error: res.error };
  if (res.statusCode !== 200) {
    let data = null;
    try { data = JSON.parse(res.body); } catch { data = res.body; }
    return { status: res.statusCode, data };
  }
  return { status: 200, data: JSON.parse(res.body) };
}

async function main() {
  const { envUrl, projectRoot } = parseArgs();

  // Load snapshot
  const snapshotPath = path.join(projectRoot, 'offline-profile.json');
  if (!fs.existsSync(snapshotPath)) {
    console.log(JSON.stringify({
      status: 'missing',
      error: `offline-profile.json not found at ${snapshotPath}`,
    }));
    return;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (e) {
    console.log(JSON.stringify({
      status: 'error',
      error: `offline-profile.json is not valid JSON: ${e.message}`,
    }));
    process.exit(1);
  }

  const token = await getAuthToken(envUrl);
  if (!token) {
    console.log(JSON.stringify({
      status: 'error',
      error: 'Failed to get Azure CLI token. Run `az login` first.',
    }));
    process.exit(1);
  }

  const checks = [];
  const drift = [];

  // Check 1 — profile exists and is published.
  // NOTE: we deliberately do NOT $expand to MobileOfflineProfileItemAssociation here
  // — that nested expand path returns empty even when associations exist
  // (empirical 2026-05-25). We query associations per-item separately below.
  const expand =
    'MobileOfflineProfile_MobileOfflineProfileItem(' +
    '$select=mobileofflineprofileitemid,selectedentitytypecode,recorddistributioncriteria,' +
    'recordsownedbyme,recordsownedbymyteam,recordsownedbymybusinessunit,syncintervalinminutes,' +
    'selectedcolumns)';

  const profilePath =
    `mobileofflineprofiles(${snapshot.profileId})?$select=mobileofflineprofileid,name,publishedon,componentstate,isvalidated&$expand=${encodeURIComponent(expand)}`;

  const profileRes = await dvGet(envUrl, profilePath, token);
  if (profileRes.error || profileRes.status !== 200) {
    console.log(JSON.stringify({
      status: 'error',
      profileId: snapshot.profileId,
      error: `Failed to fetch profile: ${profileRes.error || JSON.stringify(profileRes.data)}`,
    }));
    process.exit(1);
  }

  const profile = profileRes.data;

  checks.push({ name: 'profile exists', ok: true });
  checks.push({
    name: 'profile published',
    ok: profile.publishedon != null,
    detail: profile.publishedon || 'publishedon is null — re-run PublishAllXml',
  });
  checks.push({
    name: 'profile is in published state',
    ok: profile.componentstate === 0,
    detail: `componentstate=${profile.componentstate} (expected 0 Published)`,
  });

  if (!profile.publishedon) drift.push({ type: 'unpublished', profileId: snapshot.profileId });

  // Check 2 — every snapshot table has a matching profile item
  const liveItems = profile.MobileOfflineProfile_MobileOfflineProfileItem || [];
  const liveItemByTable = new Map(liveItems.map((it) => [it.selectedentitytypecode, it]));

  for (const expected of snapshot.tables || []) {
    const live = liveItemByTable.get(expected.logicalName);
    if (!live) {
      drift.push({
        type: 'item-missing',
        logicalName: expected.logicalName,
        expectedItemId: expected.itemId,
      });
      checks.push({
        name: `item ${expected.logicalName} present`,
        ok: false,
        detail: 'no matching mobileofflineprofileitem found',
      });
      continue;
    }
    checks.push({ name: `item ${expected.logicalName} present`, ok: true });

    // Check 2a — recorddistributioncriteria matches
    if (live.recorddistributioncriteria !== expected.recordDistributionCriteria) {
      drift.push({
        type: 'criteria-drift',
        logicalName: expected.logicalName,
        expected: expected.recordDistributionCriteria,
        actual: live.recorddistributioncriteria,
      });
    }

    // Check 2b — sub-flags match
    const flagDrift = [];
    if (live.recordsownedbyme !== expected.recordsOwnedByMe) flagDrift.push('recordsownedbyme');
    if (live.recordsownedbymyteam !== expected.recordsOwnedByMyTeam) flagDrift.push('recordsownedbymyteam');
    if (live.recordsownedbymybusinessunit !== expected.recordsOwnedByMyBusinessUnit) {
      flagDrift.push('recordsownedbymybusinessunit');
    }
    if (flagDrift.length > 0) {
      drift.push({
        type: 'flag-drift',
        logicalName: expected.logicalName,
        flags: flagDrift,
      });
    }

    // Check 2c — sync interval matches
    if (live.syncintervalinminutes !== expected.syncIntervalInMinutes) {
      drift.push({
        type: 'sync-interval-drift',
        logicalName: expected.logicalName,
        expected: expected.syncIntervalInMinutes,
        actual: live.syncintervalinminutes,
      });
    }

    // Check 2d — selectedcolumns superset check (live should contain all expected)
    let liveColumns = [];
    try {
      const parsed = JSON.parse(live.selectedcolumns || '{}');
      liveColumns = parsed.Columns || [];
    } catch {
      liveColumns = [];
    }
    const expectedColumns = new Set(expected.selectedColumns || []);
    const missingColumns = [...expectedColumns].filter((c) => !liveColumns.includes(c));
    if (missingColumns.length > 0) {
      drift.push({
        type: 'columns-drift',
        logicalName: expected.logicalName,
        missing: missingColumns,
      });
    }

    // Check 2e — associations match.
    // Per-item OData GET (NOT expand — that returns empty; empirical 2026-05-25).
    // Compare by relationshipid (stable MetadataId GUID) — NOT relationshipname,
    // which the server sets to a formatted display label like "Regarding (Account)",
    // not the snapshot's SchemaName.
    const assocRes = await dvGet(
      envUrl,
      `mobileofflineprofileitemassociations?$filter=_mobileofflineprofileitemid_value eq ${live.mobileofflineprofileitemid}&$select=mobileofflineprofileitemassociationid,relationshipid,name`,
      token,
    );
    const liveAssocs = (assocRes.status === 200 && assocRes.data.value) || [];
    const liveByRelId = new Map(liveAssocs.map((a) => [a.relationshipid, a]));

    for (const expectedRel of expected.relationships || []) {
      // Compare by relationshipId (canonical) with fallback to associationId for legacy snapshots
      const key = expectedRel.relationshipId || expectedRel.relationshipid;
      if (!key) continue;  // malformed snapshot entry — skip silently
      if (!liveByRelId.has(key)) {
        drift.push({
          type: 'association-missing',
          logicalName: expected.logicalName,
          relationshipId: key,
          schemaName: expectedRel.schemaName || expectedRel.relationshipName,
        });
      }
    }
  }

  // Check 3 — table prerequisites still set (catch silent reverts)
  for (const expected of snapshot.tables || []) {
    const metaRes = await dvGet(
      envUrl,
      `EntityDefinitions(LogicalName='${expected.logicalName}')?$select=IsAvailableOffline,ChangeTrackingEnabled`,
      token,
    );
    if (metaRes.status === 200) {
      const okOffline = metaRes.data.IsAvailableOffline === true;
      const okTracking = metaRes.data.ChangeTrackingEnabled === true;
      checks.push({
        name: `${expected.logicalName} IsAvailableOffline`,
        ok: okOffline,
      });
      checks.push({
        name: `${expected.logicalName} ChangeTrackingEnabled`,
        ok: okTracking,
      });
      if (!okOffline || !okTracking) {
        drift.push({
          type: 'prereq-revert',
          logicalName: expected.logicalName,
          isAvailableOffline: metaRes.data.IsAvailableOffline,
          changeTrackingEnabled: metaRes.data.ChangeTrackingEnabled,
          hint: 'Run /enable-tables-offline to restore.',
        });
      }
    } else {
      drift.push({
        type: 'prereq-check-failed',
        logicalName: expected.logicalName,
        error: metaRes.data || metaRes.error,
      });
    }
  }

  const result = {
    status: drift.length === 0 ? 'ok' : 'drift',
    profileId: snapshot.profileId,
    profileName: profile.name,
    publishedOn: profile.publishedon,
    checks,
  };
  if (drift.length > 0) result.drift = drift;

  console.log(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.stack || err.message}\n`);
  process.exit(1);
});
