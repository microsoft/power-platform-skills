#!/usr/bin/env node

// Lists Power Automate cloud flows that have a PowerPages trigger, matching
// how Power Pages Studio discovers flows via the Flow RP API.
//
// The studio calls:
//   GET https://{flow-rp}/providers/Microsoft.ProcessSimple/environments/{environmentId}/flows
//       ?api-version=2016-11-01-beta
//       &$filter=properties/definitionSummary/triggers/any(t: t/kind eq 'powerpages')
//       &$top=50
//       &include=includeSolutionCloudFlows
// with pagination via nextLink.
//
// Usage:
//   node list-cloud-flows.js
//
// Output (JSON to stdout):
//   { "flows": [ { "id": "<guid>", "flowRpName": "<string>", "displayName": "<string>", "description": "<string>", "state": "Active|Draft" } ] }
//
// Exits with code 1 on errors (messages to stderr).

const path = require('path');
const { getAuthToken, makeRequest, getPacAuthInfo } = require(
  path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'validation-helpers')
);

// Flow RP base URL by cloud region (mirrors studio's KnownServiceNames.Flow resolution)
const CLOUD_TO_FLOW_RP = {
  'Public':    'https://api.flow.microsoft.com',
  'UsGov':     'https://gov.api.flow.microsoft.us',
  'UsGovHigh': 'https://high.gov.api.flow.microsoft.us',
  'UsGovDod':  'https://dod.api.flow.microsoft.us',
  'China':     'https://api.flow.microsoft.cn',
};

// OAuth resource URL for the Flow service by cloud
const CLOUD_TO_FLOW_RESOURCE = {
  'Public':    'https://service.flow.microsoft.com/',
  'UsGov':     'https://gov.service.flow.microsoft.us/',
  'UsGovHigh': 'https://high.gov.service.flow.microsoft.us/',
  'UsGovDod':  'https://dod.service.flow.microsoft.us/',
  'China':     'https://service.flow.microsoft.cn/',
};

(async () => {
  const authInfo = getPacAuthInfo();
  if (!authInfo) {
    process.stderr.write(
      'Error: Unable to determine environment. Run `pac auth who` to verify PAC CLI is authenticated.\n'
    );
    process.exit(1);
  }

  const { environmentId, cloud } = authInfo;

  const flowRpBase = CLOUD_TO_FLOW_RP[cloud] || CLOUD_TO_FLOW_RP['Public'];
  const flowResource = CLOUD_TO_FLOW_RESOURCE[cloud] || CLOUD_TO_FLOW_RESOURCE['Public'];

  const token = getAuthToken(flowResource);
  if (!token) {
    process.stderr.write(
      'Error: Unable to obtain access token for the Power Automate service.\n' +
      'Run `az login` and ensure your account has access to the environment.\n'
    );
    process.exit(1);
  }

  const API_VERSION = '2016-11-01-beta';
  const FILTER = "properties/definitionSummary/triggers/any(t: t/kind eq 'powerpages')";

  const baseUrl =
    `${flowRpBase}/providers/Microsoft.ProcessSimple/environments/${environmentId}/flows` +
    `?api-version=${encodeURIComponent(API_VERSION)}` +
    `&$filter=${encodeURIComponent(FILTER)}` +
    `&$top=50` +
    `&include=includeSolutionCloudFlows`;

  const flows = [];
  let nextUrl = baseUrl;

  while (nextUrl) {
    const response = await makeRequest({
      url: nextUrl,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 20000,
    });

    if (response.error) {
      process.stderr.write(`Error calling Flow RP API: ${response.error}\n`);
      process.exit(1);
    }

    if (response.statusCode === 401) {
      process.stderr.write(
        'Error: Unauthorized. Ensure your Azure CLI token is valid and has access to Power Automate.\n'
      );
      process.exit(1);
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      process.stderr.write(
        `Error: Flow RP API returned HTTP ${response.statusCode}.\n${response.body}\n`
      );
      process.exit(1);
    }

    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      process.stderr.write(`Error: Invalid JSON response from Flow RP API.\n${response.body}\n`);
      process.exit(1);
    }

    for (const flow of parsed.value || []) {
      const props = flow.properties || {};
      const statecode = props.state === 'Started' ? 'Active' : 'Draft';
      flows.push({
        id: props.workflowEntityId,  // Dataverse workflow entity ID — used as processid in YAML
        flowRpName: flow.name,       // Flow RP identifier — used when calling installFlow API
        displayName: props.displayName || flow.name,
        description: props.description || '',
        state: statecode,
      });
    }

    // Follow pagination link if present
    nextUrl = parsed.nextLink || null;
  }

  if (flows.length === 0) {
    process.stderr.write(
      'No Power Automate flows with a PowerPages trigger were found in this environment.\n' +
      'Create a flow in Power Automate with a "When a Power Pages flow step is run" trigger, then run this skill again.\n'
    );
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ flows }, null, 2));
})();
