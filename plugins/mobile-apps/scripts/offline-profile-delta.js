#!/usr/bin/env node

// Schema ↔ offline-profile coverage delta for Power Apps mobile apps.
//
// Compares the Dataverse data-model manifest (`.datamodel-manifest.json` — the app's
// authored schema) against the offline-profile snapshot (`offline-profile.json` — the
// tables and columns actually included in the Mobile Offline Profile) and reports what
// schema is NOT yet covered offline. It answers ONE question: "did a table or column
// get added to the data model that the offline profile hasn't picked up yet?"
//
// This is a purely LOCAL, deterministic, no-network comparison — it never reads a token
// and never calls Dataverse — so it is cheap enough to run as a gate before `/deploy`
// and after any schema change (`/add-dataverse`, `/edit-app`, `/setup-datamodel`).
//
// It is deliberately DISTINCT from verify-offline-profile.js, which makes a NETWORK call
// to Dataverse to detect DRIFT between the local snapshot and the live published profile
// (unpublished, criteria/sync/flag drift, prereq reverts). This script instead detects
// the SCHEMA-COVERAGE DELTA between two local files and needs no auth.
//
// Column-level delta is only computed for a table when the profile snapshot records a
// `schemaColumns` baseline for that table (the set of schema column logical names that
// existed when the table was last reconciled into the profile — written by
// /setup-offline-profile, /add-table-to-offline-profile, and /edit-offline-profile).
// Without that baseline we cannot tell a genuinely-new column apart from one the offline
// architect deliberately EXCLUDED from `selectedColumns`, so comparing against
// `selectedColumns` would emit a false positive on every curated exclusion. When the
// baseline is absent we therefore skip column delta for that table and surface it under
// `columnBaselineMissing` instead of guessing.
//
// Usage:
//   node offline-profile-delta.js [--project-root <path>] [--manifest <path>] [--profile <path>]
//
//   --project-root  Directory holding offline-profile.json + .datamodel-manifest.json.
//                   Default: cwd.
//   --manifest      Explicit path to the data-model manifest (overrides auto-locate).
//   --profile       Explicit path to offline-profile.json (overrides auto-locate).
//
// Output (single-line JSON to stdout):
//   { "status": "in-sync",     "profileId": "...", "columnBaselineMissing": [...], ... }
//   { "status": "delta",       "missingTables": [...], "tablesWithNewColumns": [...], ... }
//   { "status": "no-profile",  "manifestPath": "...", "tables": [...] }   // schema exists, no profile
//   { "status": "no-manifest" }                                           // no Dataverse schema to compare
//   { "status": "error",       "error": "..." }
//
// Exit codes:
//   0 — comparison ran; branch on the `status` field (in-sync / delta / no-profile / no-manifest)
//   1 — fatal error (bad args, an explicit --manifest/--profile path that doesn't exist,
//       an unreadable file, or invalid JSON)

const fs = require('fs');
const path = require('path');

function usage(msg) {
  process.stderr.write(`Error: ${msg}\n\n`);
  process.stderr.write(
    'Usage: node offline-profile-delta.js [--project-root <path>] [--manifest <path>] [--profile <path>]\n',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = { projectRoot: process.cwd(), manifest: null, profile: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--project-root': out.projectRoot = next; i++; break;
      case '--manifest':     out.manifest = next;     i++; break;
      case '--profile':      out.profile = next;      i++; break;
      default:               usage(`Unknown flag: ${flag}`);
    }
  }
  return out;
}

// The manifest lives at either the project root (legacy) or docs/plan-artifacts/
// (newer scaffolds) — mirror the dual-location probe used across the offline skills,
// e.g. /setup-offline-profile Step 1 and /add-table-to-offline-profile Step 1.
function locateManifest(projectRoot, explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const candidates = [
    path.join(projectRoot, '.datamodel-manifest.json'),
    path.join(projectRoot, 'docs', 'plan-artifacts', '.datamodel-manifest.json'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function locateProfile(projectRoot, explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const p = path.join(projectRoot, 'offline-profile.json');
  return fs.existsSync(p) ? p : null;
}

// Normalize a manifest table's columns to a flat list of logical names. Manifest
// column entries are objects — { "logicalName": "cr123_total", "type": "Money" } — but
// tolerate bare-string entries too so a hand-edited manifest doesn't crash the gate.
function manifestColumnNames(table) {
  const cols = Array.isArray(table && table.columns) ? table.columns : [];
  return cols
    .map((c) => (typeof c === 'string' ? c : c && c.logicalName))
    .filter(Boolean);
}

/**
 * Pure comparison: given a parsed manifest and profile, return the coverage delta.
 * Exported for reuse/tests — the CLI below is a thin wrapper that locates + reads files.
 *
 * @param {object} manifest - parsed .datamodel-manifest.json ({ tables: [...] })
 * @param {object} profile  - parsed offline-profile.json ({ profileId, tables: [...] })
 */
function computeOfflineProfileDelta(manifest, profile) {
  const manifestTables = Array.isArray(manifest && manifest.tables) ? manifest.tables : [];
  const profileTables = Array.isArray(profile && profile.tables) ? profile.tables : [];
  const profileByName = new Map(
    profileTables.filter((t) => t && t.logicalName).map((t) => [t.logicalName, t]),
  );

  const missingTables = [];
  const tablesWithNewColumns = [];
  const columnBaselineMissing = [];

  for (const mt of manifestTables) {
    const name = mt && mt.logicalName;
    if (!name) continue; // malformed manifest entry — skip rather than crash the gate

    const pt = profileByName.get(name);
    if (!pt) {
      // A table exists in the data model but not in the offline profile at all — the
      // strongest, always-computable delta. /add-table-to-offline-profile fixes it.
      missingTables.push({
        logicalName: name,
        displayName: mt.displayName || name,
        status: mt.status || 'unknown',
      });
      continue;
    }

    const manifestCols = manifestColumnNames(mt);
    if (manifestCols.length === 0) continue; // nothing to compare (e.g. reused table)

    // `schemaColumns` is the reconciliation baseline. Absent it we cannot distinguish a
    // new column from a deliberately-excluded one, so we report the gap instead of a
    // false-positive column delta. See the header note.
    if (!Array.isArray(pt.schemaColumns)) {
      columnBaselineMissing.push(name);
      continue;
    }

    const baseline = new Set(pt.schemaColumns);
    const newColumns = manifestCols.filter((c) => !baseline.has(c));
    if (newColumns.length > 0) {
      tablesWithNewColumns.push({ logicalName: name, itemId: pt.itemId, newColumns });
    }
  }

  const hasDelta = missingTables.length > 0 || tablesWithNewColumns.length > 0;
  return {
    status: hasDelta ? 'delta' : 'in-sync',
    profileId: profile && profile.profileId,
    missingTables,
    tablesWithNewColumns,
    columnBaselineMissing,
    summary: {
      missingTableCount: missingTables.length,
      newColumnTableCount: tablesWithNewColumns.length,
      newColumnCount: tablesWithNewColumns.reduce((n, t) => n + t.newColumns.length, 0),
      columnBaselineMissingCount: columnBaselineMissing.length,
    },
  };
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function main() {
  const { projectRoot, manifest: manifestFlag, profile: profileFlag } = parseArgs(
    process.argv.slice(2),
  );

  // An explicit --manifest / --profile that doesn't exist is a bad invocation, not an
  // absent artifact. Fail loudly (exit 1) so a typo'd path can't masquerade as
  // `no-manifest` / `no-profile` and make a caller silently skip reconciliation. The
  // auto-locate path (no flag) legitimately returns null → no-manifest / no-profile.
  if (manifestFlag && !fs.existsSync(manifestFlag)) usage(`--manifest path not found: ${manifestFlag}`);
  if (profileFlag && !fs.existsSync(profileFlag)) usage(`--profile path not found: ${profileFlag}`);

  const manifestPath = locateManifest(projectRoot, manifestFlag);
  if (!manifestPath) {
    // No Dataverse schema in this project (connectors-only app, or data model not yet
    // applied). There is nothing to reconcile against an offline profile.
    console.log(JSON.stringify({ status: 'no-manifest' }));
    return;
  }

  const profilePath = locateProfile(projectRoot, profileFlag);
  if (!profilePath) {
    // The app HAS a data model but no offline profile. This is not a delta to patch —
    // it means offline was never set up. Callers should offer /setup-offline-profile
    // (or skip silently when the app opted out of offline), never auto-run an edit.
    let tables = [];
    try {
      const manifest = readJson(manifestPath);
      tables = (Array.isArray(manifest.tables) ? manifest.tables : [])
        .map((t) => t && t.logicalName)
        .filter(Boolean);
    } catch (e) {
      console.log(JSON.stringify({ status: 'error', error: `Failed to read manifest: ${e.message}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ status: 'no-profile', manifestPath, tables }));
    return;
  }

  let manifest;
  let profile;
  try {
    manifest = readJson(manifestPath);
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', error: `.datamodel-manifest.json is not valid JSON: ${e.message}` }));
    process.exit(1);
  }
  try {
    profile = readJson(profilePath);
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', error: `offline-profile.json is not valid JSON: ${e.message}` }));
    process.exit(1);
  }

  const result = computeOfflineProfileDelta(manifest, profile);
  result.manifestPath = manifestPath;
  result.profilePath = profilePath;
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`Unexpected error: ${(err && err.stack) || err}\n`);
    process.exit(1);
  }
}

module.exports = {
  computeOfflineProfileDelta,
  locateManifest,
  locateProfile,
  manifestColumnNames,
};
