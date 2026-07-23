#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getAuthToken, makeRequest, getEnvironmentUrl } = require('./lib/validation-helpers');
const { buildCriticalObligations } = require('./lib/critical-obligations');
const { resolvePackageViews } = require('./lib/saved-view-resolution');

const VIEW_SELECT = 'name,fetchxml,layoutxml,querytype,returnedtypecode';

function parseArgs(argv) {
  const args = { dir: null, environmentUrl: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dir' && argv[index + 1]) args.dir = path.resolve(argv[++index]);
    else if (argv[index] === '--environment-url' && argv[index + 1]) args.environmentUrl = argv[++index].replace(/\/+$/, '');
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  if (!args.dir) throw new Error('Usage: node resolve-saved-views.js --dir <adapted-package-dir> [--environment-url <dataverse-url>]');
  args.environmentUrl = args.environmentUrl || getEnvironmentUrl();
  if (!args.environmentUrl || !/^https:\/\//i.test(args.environmentUrl)) throw new Error('A target Dataverse --environment-url is required');
  return args;
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`Required file not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function fetchCollection(environmentUrl, entitySet, idField, token) {
  const base = new URL(environmentUrl);
  let nextUrl = `${environmentUrl}/api/data/v9.2/${entitySet}?$select=${encodeURIComponent(`${idField},${VIEW_SELECT}`)}`;
  const records = [];
  let page = 0;
  while (nextUrl) {
    if (++page > 100) throw new Error(`${entitySet} exceeded 100 response pages`);
    const current = new URL(nextUrl);
    if (current.origin !== base.origin || !current.pathname.startsWith('/api/data/v9.2/')) throw new Error(`${entitySet} returned an unsafe nextLink`);
    const response = await makeRequest({
      url: current.toString(),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        Prefer: 'odata.maxpagesize=5000',
      },
      timeout: 30000,
    });
    if (response.error) throw new Error(`${entitySet} request failed: ${response.error}`);
    if (response.statusCode !== 200) throw new Error(`${entitySet} request returned HTTP ${response.statusCode}`);
    let body;
    try {
      body = JSON.parse(response.body);
    } catch (error) {
      throw new Error(`${entitySet} returned invalid JSON: ${error.message}`);
    }
    if (!Array.isArray(body.value)) throw new Error(`${entitySet} response is missing value[]`);
    records.push(...body.value);
    nextUrl = body['@odata.nextLink'] || null;
  }
  return records;
}

function rebuildCritical(input, behaviors, previous) {
  return buildCriticalObligations({
    generatedAt: previous.generatedAt,
    sourceTreeSha256: input.source?.powerAppsYamlSchemaValidation?.sourceTreeSha256,
    sourceInputSha256: input.source?.powerAppsYamlSchemaValidation?.sourceInputSha256,
    migrationMode: input.migrationMode,
    componentCommands: behaviors.componentCommands,
    app: {
      startScreen: input.app?.startScreen,
      sourceDesignBaseline: input.app?.sourceDesignBaseline,
    },
    screens: input.screenPlan?.screens,
    navigationEdges: input.screenPlan?.navigationEdges,
    tables: input.dataModelPlan?.dataverseTables,
  });
}

function writePairAtomically(entries) {
  const staged = entries.map(({ file, value }) => ({
    file,
    value,
    previous: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
    temp: `${file}.${process.pid}.tmp`,
  }));
  for (const entry of staged) fs.writeFileSync(entry.temp, entry.value, { flag: 'wx' });
  const replaced = [];
  try {
    for (const entry of staged) {
      fs.renameSync(entry.temp, entry.file);
      replaced.push(entry);
    }
  } catch (error) {
    for (const entry of replaced.reverse()) {
      if (entry.previous === null) fs.rmSync(entry.file, { force: true });
      else fs.writeFileSync(entry.file, entry.previous);
    }
    throw error;
  } finally {
    for (const entry of staged) fs.rmSync(entry.temp, { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputFile = path.join(args.dir, 'mobile-plugin-input.json');
  const behaviorsFile = path.join(args.dir, 'behaviors.json');
  const criticalFile = path.join(args.dir, 'critical-obligations.json');
  const input = readJson(inputFile);
  const behaviors = readJson(behaviorsFile);
  const previousCritical = readJson(criticalFile);
  const targetViews = (input.dataModelPlan?.dataverseTables || []).reduce((count, table) => count + (table.views || []).length, 0);
  if (!targetViews) {
    process.stdout.write(`${JSON.stringify({ ok: true, resolved: 0, message: 'No source-used saved views require resolution.' }, null, 2)}\n`);
    return;
  }
  const token = await getAuthToken(args.environmentUrl);
  if (!token) throw new Error('Failed to get a Dataverse token. Run `az login --tenant <environment-tenant>` first.');
  const [savedqueries, userqueries] = await Promise.all([
    fetchCollection(args.environmentUrl, 'savedqueries', 'savedqueryid', token),
    fetchCollection(args.environmentUrl, 'userqueries', 'userqueryid', token),
  ]);
  const resolved = resolvePackageViews(input, { savedqueries, userqueries });
  if (resolved.resolved !== targetViews) throw new Error(`Resolved ${resolved.resolved}/${targetViews} saved views`);
  const critical = rebuildCritical(resolved.input, behaviors, previousCritical);
  const unresolved = critical.obligations.filter((obligation) => obligation.category === 'saved-view-semantics' && obligation.requirement.requiresLiveResolution);
  if (unresolved.length) throw new Error(`${unresolved.length} saved-view obligations remain unresolved`);
  resolved.input.criticalObligations = {
    ...resolved.input.criticalObligations,
    sourceDigest: critical.sourceDigest,
    stats: critical.stats,
  };
  writePairAtomically([
    { file: inputFile, value: `${JSON.stringify(resolved.input, null, 2)}\n` },
    { file: criticalFile, value: `${JSON.stringify(critical, null, 2)}\n` },
  ]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    resolved: resolved.resolved,
    sourceDigest: critical.sourceDigest,
    environmentUrl: args.environmentUrl,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Saved-view resolution failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchCollection,
  parseArgs,
  rebuildCritical,
  writePairAtomically,
};
