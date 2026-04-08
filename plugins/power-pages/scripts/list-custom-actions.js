#!/usr/bin/env node

// Lists Dataverse custom actions (Custom APIs and Custom Process Actions).
// Usage: node list-custom-actions.js <environmentUrl>
//
// Queries both:
//   1. Custom APIs (modern) — customapis table with expanded request/response parameters
//   2. Custom Process Actions (legacy) — workflows table with category=3, activated only
//
// Output (JSON to stdout):
//   {
//     "customApis": [ { name, displayName, description, type, binding, boundEntity, source,
//                        requestParameters: [{ name, displayName, description, type, required }],
//                        responseProperties: [{ name, displayName, description, type }] } ],
//     "customProcessActions": [ { name, displayName, description, type, binding, boundEntity, source } ],
//     "total": <number>
//   }
//
// Exit codes:
//   0 - Success (check total field — 0 means none found)
//   1 - Fatal error (no token, invalid args, network failure)

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

const PARAM_TYPES = {
  0: 'Boolean',
  1: 'DateTime',
  2: 'Decimal',
  3: 'Entity',
  4: 'EntityCollection',
  5: 'EntityReference',
  6: 'Float',
  7: 'Integer',
  8: 'Money',
  9: 'Picklist',
  10: 'String',
  11: 'StringArray',
  12: 'Guid',
};

const BINDING_TYPES = {
  0: 'unbound',
  1: 'entity',
  2: 'entityCollection',
};

async function fetchCustomApis(envUrl, token) {
  const apiPath =
    'customapis?' +
    '$select=uniquename,name,displayname,description,bindingtype,boundentitylogicalname,isfunction' +
    '&$expand=CustomAPIRequestParameters($select=uniquename,name,displayname,description,type,isoptional),' +
    'CustomAPIResponseProperties($select=uniquename,name,displayname,description,type)' +
    '&$orderby=name asc';

  const res = await makeRequest({
    url: `${envUrl}/api/data/v9.2/${apiPath}`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 30000,
  });

  if (res.error) {
    process.stderr.write(`Warning: Failed to fetch Custom APIs: ${res.error}\n`);
    return [];
  }
  if (res.statusCode !== 200) {
    process.stderr.write(
      `Warning: Custom APIs query returned ${res.statusCode}. Skipping.\n`
    );
    return [];
  }

  const data = JSON.parse(res.body);
  return (data.value || []).map((api) => ({
    name: api.uniquename || api.name,
    displayName: api.displayname || api.name,
    description: api.description || '',
    type: api.isfunction ? 'function' : 'action',
    binding: BINDING_TYPES[api.bindingtype] || 'unbound',
    boundEntity: api.boundentitylogicalname || null,
    source: 'customApi',
    requestParameters: (api.CustomAPIRequestParameters || []).map((p) => ({
      name: p.uniquename || p.name,
      displayName: p.displayname || p.name,
      description: p.description || '',
      type: PARAM_TYPES[p.type] || 'Unknown',
      required: !p.isoptional,
    })),
    responseProperties: (api.CustomAPIResponseProperties || []).map((p) => ({
      name: p.uniquename || p.name,
      displayName: p.displayname || p.name,
      description: p.description || '',
      type: PARAM_TYPES[p.type] || 'Unknown',
    })),
  }));
}

async function fetchCustomProcessActions(envUrl, token) {
  const apiPath =
    'workflows?' +
    '$filter=category eq 3 and statecode eq 1' +
    '&$select=name,uniquename,description,primaryentity' +
    '&$orderby=name asc';

  const res = await makeRequest({
    url: `${envUrl}/api/data/v9.2/${apiPath}`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 30000,
  });

  if (res.error) {
    process.stderr.write(
      `Warning: Failed to fetch Custom Process Actions: ${res.error}\n`
    );
    return [];
  }
  if (res.statusCode !== 200) {
    process.stderr.write(
      `Warning: Custom Process Actions query returned ${res.statusCode}. Skipping.\n`
    );
    return [];
  }

  const data = JSON.parse(res.body);
  return (data.value || []).map((wf) => ({
    name: wf.uniquename || wf.name,
    displayName: wf.name,
    description: wf.description || '',
    type: 'action',
    binding:
      !wf.primaryentity || wf.primaryentity === 'none'
        ? 'unbound'
        : 'entity',
    boundEntity:
      !wf.primaryentity || wf.primaryentity === 'none'
        ? null
        : wf.primaryentity,
    source: 'customProcessAction',
    requestParameters: [],
    responseProperties: [],
  }));
}

async function main() {
  const envUrl = process.argv[2];
  if (!envUrl) {
    process.stderr.write(
      'Usage: node list-custom-actions.js <environmentUrl>\n'
    );
    process.exit(1);
  }

  const cleanUrl = envUrl.replace(/\/+$/, '');

  // Validate the URL is a strict HTTPS URL to prevent shell injection via getAuthToken
  try {
    const parsed = new URL(cleanUrl);
    if (parsed.protocol !== 'https:') {
      process.stderr.write('Error: environmentUrl must use HTTPS.\n');
      process.exit(1);
    }
  } catch {
    process.stderr.write(`Error: Invalid URL: "${cleanUrl}"\n`);
    process.exit(1);
  }

  const token = getAuthToken(cleanUrl);
  if (!token) {
    process.stderr.write(
      'Failed to get Azure CLI token. Run `az login` first.\n'
    );
    process.exit(1);
  }

  const [customApis, customProcessActions] = await Promise.all([
    fetchCustomApis(cleanUrl, token),
    fetchCustomProcessActions(cleanUrl, token),
  ]);

  console.log(
    JSON.stringify({
      customApis,
      customProcessActions,
      total: customApis.length + customProcessActions.length,
    })
  );
}

main();
