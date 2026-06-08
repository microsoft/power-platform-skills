#!/usr/bin/env node

// Removes a single component from a (typically Git-bound) solution via the
// `RemoveSolutionComponent` OData action.
//
// Background:
//   The OData metadata for this action declares its first parameter as
//   `SolutionComponent` of type `mscrm.solutioncomponent`, BUT the server-side
//   processor still expects a `ComponentId` field. The working payload shape
//   was discovered empirically (see references/inner-loop-empirical-findings.md
//   §11). All variants closer to the Microsoft Learn docs fail with one of:
//     - "The parameter 'ComponentId' in the request payload is not a valid parameter"
//     - "Required field 'ComponentId' is missing for RequestName='RemoveSolutionComponent'"
//     - "Cannot find solution component Entity <scid> in solution <solutionid>"
//
// Working payload:
//   {
//     "SolutionComponent": {
//       "@odata.type":         "Microsoft.Dynamics.CRM.solutioncomponent",
//       "solutioncomponentid": "<objectId>",   // ← duplicate the objectid here
//       "objectid":            "<objectId>",
//       "componenttype":       <componentType>
//     },
//     "ComponentType":      <componentType>,
//     "SolutionUniqueName": "<solutionUniqueName>"
//   }
//
// Output (JSON to stdout):
//   { ok: true, objectId, componentType, solutionUniqueName }
//   On error: { error, statusCode?, errorCode? }
//
// Usage:
//   node remove-solution-component.js
//       --envUrl              <url>
//       --objectId            <guid>
//       --componentType       <int>     // 1=Entity, 9=OptionSet, 29=Workflow, 10161=ConnectionReference, etc.
//       --solutionUniqueName  <name>
//       [--token              <dvToken>]

'use strict';

const { getAuthToken, makeRequest } = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, objectId: null, componentType: null, solutionUniqueName: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--objectId' && args[i + 1]) out.objectId = args[++i];
    else if (args[i] === '--componentType' && args[i + 1]) out.componentType = parseInt(args[++i], 10);
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
  }
  return out;
}

async function removeSolutionComponent({ envUrl, token, objectId, componentType, solutionUniqueName } = {}) {
  if (!envUrl) return { error: '--envUrl is required' };
  if (!objectId) return { error: '--objectId is required' };
  if (typeof componentType !== 'number' || Number.isNaN(componentType)) return { error: '--componentType is required (int)' };
  if (!solutionUniqueName) return { error: '--solutionUniqueName is required' };

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  const apiUrl = `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/RemoveSolutionComponent`;
  const body = JSON.stringify({
    SolutionComponent: {
      '@odata.type':         'Microsoft.Dynamics.CRM.solutioncomponent',
      solutioncomponentid:   objectId,
      objectid:              objectId,
      componenttype:         componentType,
    },
    ComponentType:      componentType,
    SolutionUniqueName: solutionUniqueName,
  });

  const res = await makeRequest({
    url: apiUrl,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body,
  });

  if (res.error) return { error: res.error };
  if (res.statusCode !== 200 && res.statusCode !== 204) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try { const p = JSON.parse(res.body); msg = p.error?.message || msg; code = p.error?.code || null; } catch {}
    return { error: msg, statusCode: res.statusCode, errorCode: code };
  }
  return { ok: true, objectId, componentType, solutionUniqueName };
}

if (require.main === module) {
  removeSolutionComponent(parseArgs(process.argv))
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('remove-solution-component: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { removeSolutionComponent };
