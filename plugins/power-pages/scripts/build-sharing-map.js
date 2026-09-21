#!/usr/bin/env node
'use strict';

// Renders the SharePoint sharing map: one page answering which SharePoint list
// is reachable from this portal, through which Dataverse table, by whom, and for
// which operations.
//
// Derived state only. It reads the sharing manifest written by
// create-virtual-table.js and the access control committed under
// `.powerpages-site`, then regenerates the page - so it can never disagree with
// the configuration the site actually ships.
//
// Usage:
//   node build-sharing-map.js --projectRoot <path>
//     [--output <path.html>] [--links <links.json>] [--phase <text>] [--data-only]
//
// Output (JSON to stdout):
//   { "status": "ok", "output": "<path>", "sha256": "...", "lists": 3, "findings": { "danger": 0, "warning": 2, "info": 1 } }
//   With --data-only: the report model, for reconciling before a guarded write.
//
// Exit codes: 0 on success, 1 on argument, configuration, or write failure.

const fs = require('node:fs');
const path = require('node:path');
const { buildSharing, loadSiteConfiguration, readSharingManifest } = require('./lib/sharepoint-sharing-map');
const { buildSharingReport } = require('./lib/sharepoint-sharing-report');
const { readArtifact, renderArtifact } = require('./render-sharepoint-artifact');

const DEFAULT_OUTPUT = path.join('docs', 'sharepoint-sharing-map.html');

function getArg(args, name) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const projectRoot = getArg(argv, 'projectRoot');
  if (!projectRoot) fail('Usage: node build-sharing-map.js --projectRoot <path> [--output <path.html>] [--data-only]');
  if (!fs.existsSync(projectRoot)) fail(`Project root not found: ${projectRoot}`);

  const output = path.resolve(getArg(argv, 'output') || path.join(projectRoot, DEFAULT_OUTPUT));
  const linksFile = getArg(argv, 'links');
  const phase = getArg(argv, 'phase');
  const dataOnly = argv.includes('--data-only');

  let manifest;
  let config;
  try {
    manifest = readSharingManifest(projectRoot);
    config = loadSiteConfiguration(projectRoot);
  } catch (error) {
    fail(error.message);
  }

  let links;
  if (linksFile) {
    try {
      links = JSON.parse(fs.readFileSync(linksFile, 'utf8'));
    } catch (error) {
      fail(`Could not read --links ${linksFile}: ${error.message}`);
    }
  }

  const sharing = buildSharing(manifest, config);
  const report = buildSharingReport(sharing, {
    links,
    phase,
    updatedAt: manifest.updatedAt || new Date().toISOString(),
    relativeTo: path.resolve(projectRoot),
  });

  if (dataOnly) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  // The page is regenerated from the manifest and the site YAML on every run, so
  // there is nothing to reconcile - but the current fingerprint is still supplied
  // so a page another writer changed underneath is reported rather than replaced.
  let expectedSha256;
  if (fs.existsSync(output)) {
    let current;
    try {
      current = readArtifact(output);
    } catch (error) {
      fail(`${output} exists but is not a managed report (${error.message}). Move or delete it, then run again.`);
    }
    if (current.integrity !== 'valid') {
      fail(`${output} has manual edits. This page is generated from the manifest and .powerpages-site; move the edited copy aside, then run again.`);
    }
    expectedSha256 = current.sha256;
  }

  let result;
  try {
    result = renderArtifact({ outputPath: output, data: report, expectedSha256 });
  } catch (error) {
    fail(`Could not write the sharing map: ${error.message}`);
  }

  const findings = sharing.rows.flatMap((row) => row.findings);
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    output: result.output,
    sha256: result.sha256,
    lists: sharing.rows.length,
    findings: {
      danger: findings.filter((item) => item.severity === 'danger').length,
      warning: findings.filter((item) => item.severity === 'warning').length,
      info: findings.filter((item) => item.severity === 'info').length,
    },
  }, null, 2)}\n`);
}

main();
