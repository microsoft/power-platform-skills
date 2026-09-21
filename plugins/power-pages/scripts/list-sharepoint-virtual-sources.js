#!/usr/bin/env node
'use strict';

// Reports what a Dataverse environment already has for SharePoint-backed virtual
// tables, so provisioning never has to guess a provider id or a data source shape.
//
// Read-only. It touches Dataverse only, never SharePoint: source discovery in this
// workflow happens through the maker's browser (references/sharepoint-migration.md).
//
// Usage:
//   node list-sharepoint-virtual-sources.js --envUrl <https://org.crm.dynamics.com>
//                                           [--dataSourceId <guid>] [--environmentId <guid>]
//
// Output (JSON to stdout):
//   {
//     "ready": true,
//     "providers":     [{ "dataProviderId": "...", "name": "..." }],
//     "dataSources":   [{ "dataSourceId": "...", "name": "VCP_DS_...", "connectorType": "...", "dataset": "..." }],
//     "virtualTables": [{ "logicalName": "...", "dataSourceId": "...", "externalName": "..." }],
//     "seedTable":     { "logicalName": "...", "dataProviderId": "...", "dataSourceId": "..." },
//     "wizard":        { "url": "https://make.powerapps.com/environments/<id>/solutions", "breadcrumbs": {...}, "docs": {...} },
//     "nextAction":    "..."
//   }
//
// `wizard.url` is the page to OPEN FOR THE MAKER when `ready` is false. Maker-portal
// routing below the host is product UI rather than a documented API, so treat the
// link as a convenience: confirm the wizard actually ran by running this script
// again and checking `ready`, never by assuming the page loaded.
//
// Exit codes: 0 when the environment was read (check `ready`), 1 on argument or
// network failure.

const {
  getAuthToken,
  getEnvironmentUrl,
  getPacAuthInfo,
  validateDataverseEnvironmentUrl,
  UUID_REGEX,
} = require('./lib/validation-helpers');
const {
  WIZARD_BREADCRUMBS,
  WIZARD_DOCS,
  findSeedTable,
  isSharePointDataSource,
  listConnectorDataProviders,
  listConnectorDataSources,
  listVirtualTables,
  makerPortalWizardUrl,
} = require('./lib/sharepoint-virtual-tables');

function getArg(args, name) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const envUrlArg = getArg(args, 'envUrl');
  const dataSourceId = getArg(args, 'dataSourceId');
  const environmentIdArg = getArg(args, 'environmentId');

  if (!envUrlArg) {
    fail('Usage: node list-sharepoint-virtual-sources.js --envUrl <https://org.crm.dynamics.com> [--dataSourceId <guid>]');
  }
  if (dataSourceId && !UUID_REGEX.test(dataSourceId)) fail(`--dataSourceId is not a GUID: ${dataSourceId}`);
  if (environmentIdArg && !UUID_REGEX.test(environmentIdArg)) fail(`--environmentId is not a GUID: ${environmentIdArg}`);

  const envUrl = validateDataverseEnvironmentUrl(envUrlArg);
  const token = getAuthToken(envUrl);
  if (!token) fail('Could not get a Dataverse token. Run `az login --allow-no-subscriptions` first.');

  const [providers, allDataSources, virtualTables] = await Promise.all([
    listConnectorDataProviders(envUrl, token),
    listConnectorDataSources(envUrl, token),
    listVirtualTables(envUrl, token),
  ]);

  const dataSources = allDataSources.filter(isSharePointDataSource);
  const knownIds = new Set(dataSources.map((source) => source.dataSourceId));
  const sharePointTables = virtualTables.filter((table) => knownIds.has(table.dataSourceId));
  const seedTable = findSeedTable(sharePointTables, { dataSourceId });
  const wizard = resolveWizardTarget(envUrl, environmentIdArg);

  const result = {
    ready: Boolean(seedTable),
    providers,
    dataSources,
    virtualTables: sharePointTables,
    seedTable,
    wizard,
    nextAction: nextAction({ providers, dataSources, seedTable, wizard }),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/**
 * Resolves the maker-portal page to open for the wizard.
 *
 * `pac auth who` reports the environment PAC currently points at, which is not
 * necessarily the one being provisioned, so its id is used only when `pac env who`
 * agrees with `--envUrl`. A mismatch drops to the portal root rather than deep
 * linking the maker into the wrong environment.
 */
function resolveWizardTarget(envUrl, environmentIdArg) {
  let environmentId = environmentIdArg;
  let cloud = 'Public';
  const pac = getPacAuthInfo();
  if (pac) {
    cloud = pac.cloud || 'Public';
    if (!environmentId && getEnvironmentUrl() === envUrl) environmentId = pac.environmentId;
  }
  return {
    ...makerPortalWizardUrl({ cloud, environmentId }),
    environmentId: environmentId || null,
    breadcrumbs: WIZARD_BREADCRUMBS,
    docs: WIZARD_DOCS,
  };
}

function nextAction({ providers, dataSources, seedTable, wizard }) {
  if (seedTable) {
    return `Reuse dataProviderId ${seedTable.dataProviderId} and dataSourceId ${seedTable.dataSourceId} `
      + `(copied from the existing virtual table ${seedTable.logicalName}) when provisioning the remaining lists.`;
  }
  const open = `Open ${wizard.url} for the maker`
    + (wizard.environmentScoped ? '' : ' and have them select the approved environment')
    + `, then follow: ${WIZARD_BREADCRUMBS.powerApps}. Run this script again and check \`ready\` afterwards.`;
  if (providers.length === 0) {
    return `This environment has no virtual connector data provider. Install the Virtual Connector Provider solution first. ${open}`;
  }
  if (dataSources.length === 0) {
    return `This environment has a virtual connector provider but no SharePoint data source. ${open}`;
  }
  return `A SharePoint data source exists but no virtual table uses it yet. ${open}`;
}

main().catch((error) => fail(`Failed to read the environment: ${error.message}`));
