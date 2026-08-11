#!/usr/bin/env node

// Lists the Dataverse Custom APIs a GenPage can bind to — Global ones plus those bound to the
// page's table(s) — with each API's declared request-parameter kinds. The genpage-customapi-builder
// agent turns this into actions.json entries ({ name, isFunction, boundEntityLogicalName?,
// displayName, parameterKinds }) that pac persists into the page config.json under `actionBindings`.
//
// Unlike connectors (whose metadata lives outside Dataverse and needs pac verbs), Custom API metadata
// IS in ordinary Dataverse tables, so discovery is a plain Web API query — no new pac verb needed.
//   customapi                  — the API definitions (uniquename, isfunction, bindingtype, bound entity)
//   customapirequestparameter  — each API's request parameters and their declared `type`
// See: https://learn.microsoft.com/power-apps/developer/data-platform/custom-api
//
// Usage:
//   node list-custom-apis.js <envUrl> [--entities <logicalName1,logicalName2>]
//     --entities  Restrict entity-bound results to these table logical names (the page's tables).
//                 When omitted, every Global API plus every entity-bound API is returned.
//
// Output:
//   { "ok": true, "customApis": [ { name, displayName, isFunction, bindingType,
//                                   boundEntityLogicalName?, parameterKinds } ] }

const {
  dataverseRequest,
  ensureOk,
  parseArgs,
  emitResult,
} = require('./lib/dataverse-auth');
const { exitIfCustomApiDisabled } = require('./lib/feature-flags');

// customapi.bindingtype is a Dataverse option set. Only the value→meaning mapping matters here;
// a page invokes a record-bound API via boundTo, so we surface Entity as bound and Global as unbound.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/customapi
const BINDING_TYPE = { 0: 'Global', 1: 'Entity', 2: 'EntityCollection' };

// customapirequestparameter.type is a Dataverse option set whose integer values map to the runtime's
// DataverseParameterKind strings. The runtime reads these from the page manifest (`parameterKinds`)
// and has no other source, so record them exactly — an Integer mis-recorded as Decimal (or a Guid as
// String) changes how the value is serialized on the wire.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/customapirequestparameter
const PARAMETER_KIND_BY_TYPE = {
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

function bindingTypeLabel(bindingtype) {
  return BINDING_TYPE[bindingtype] || 'Global';
}

function mapParameterKind(typeValue) {
  // Unknown/absent type values are dropped rather than guessed: recording a wrong kind is worse than
  // recording none (the runtime then infers the OData type from the JS value at call time).
  return PARAMETER_KIND_BY_TYPE[typeValue];
}

function escapeODataString(value) {
  // OData string literals escape a single quote by doubling it, e.g. O'Brien -> 'O''Brien'.
  return String(value).replace(/'/g, "''");
}

// Builds the $filter for the customapi query: every Global API (bindingtype 0), plus every
// entity-bound API — optionally narrowed to the page's tables when `entities` is non-empty.
function buildCustomApiFilter(entities) {
  const list = (entities || []).map((e) => String(e).trim()).filter(Boolean);
  if (list.length === 0) {
    // No page tables supplied: Global + all entity-bound (let the builder/maker filter).
    return 'bindingtype eq 0 or bindingtype ne 0';
  }
  const bound = list
    .map((e) => `boundentitylogicalname eq '${escapeODataString(e)}'`)
    .join(' or ');
  return `bindingtype eq 0 or (${bound})`;
}

// Groups customapirequestparameter rows by their parent API id into { [customapiid]: { name: kind } },
// dropping parameters whose declared type is unknown (see mapParameterKind).
function groupParameterKinds(rows) {
  const byApi = {};
  for (const row of rows || []) {
    const apiId = row._customapiid_value;
    const name = row.uniquename;
    const kind = mapParameterKind(row.type);
    if (!apiId || !name || !kind) continue;
    (byApi[apiId] = byApi[apiId] || {})[name] = kind;
  }
  return byApi;
}

// Projects one customapi row (+ its parameter kinds) into the discovery shape the builder writes to
// actions.json. `boundEntityLogicalName` is included only for a truly entity-bound API with a table.
function toCustomApiEntry(api, parameterKinds) {
  const bindingType = bindingTypeLabel(api.bindingtype);
  const entry = {
    name: api.uniquename,
    displayName: api.displayname || api.name || api.uniquename,
    isFunction: Boolean(api.isfunction),
    bindingType,
    parameterKinds: parameterKinds || {},
  };
  if (bindingType !== 'Global' && api.boundentitylogicalname) {
    entry.boundEntityLogicalName = api.boundentitylogicalname;
  }
  return entry;
}

async function main() {
  // Feature gate first (fail closed) — see lib/feature-flags.js. Exit 3 = "feature off", distinct
  // from 1 = runtime/usage error, so a caller can tell "not released" from "it broke".
  exitIfCustomApiDisabled();

  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 1) {
    process.stderr.write('Usage: node list-custom-apis.js <envUrl> [--entities <logicalName1,logicalName2>]\n');
    process.exit(1);
  }
  const [envUrl] = positional;
  const entities = (flags.entities || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const filter = encodeURIComponent(buildCustomApiFilter(entities));
    const apisRes = await dataverseRequest(
      envUrl,
      'GET',
      'customapis?$select=customapiid,uniquename,name,displayname,isfunction,bindingtype,boundentitylogicalname' +
        `&$filter=${filter}`
    );
    ensureOk(apisRes, 'List custom APIs');
    const apis = (apisRes.data?.value || []).filter((a) => a.uniquename);

    // Fetch request parameters for exactly the matched APIs in one call (an OR of id equalities),
    // then group by API. Skip entirely when nothing matched so we don't issue an empty `in ()` filter.
    let parameterKindsByApi = {};
    if (apis.length > 0) {
      const idFilter = apis
        .map((a) => `_customapiid_value eq ${a.customapiid}`)
        .join(' or ');
      const paramsRes = await dataverseRequest(
        envUrl,
        'GET',
        'customapirequestparameters?$select=uniquename,type,isoptional,_customapiid_value' +
          `&$filter=${encodeURIComponent(idFilter)}`
      );
      ensureOk(paramsRes, 'List custom API request parameters');
      parameterKindsByApi = groupParameterKinds(paramsRes.data?.value);
    }

    const customApis = apis
      .map((api) => toCustomApiEntry(api, parameterKindsByApi[api.customapiid]))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    emitResult(true, { ok: true, customApis });
  } catch (e) {
    emitResult(false, e);
  }
}

// Only run when invoked directly as a CLI; when required by tests, export the pure helpers so their
// logic can be unit-tested without a live environment or side effects.
if (require.main === module) {
  main();
}

module.exports = {
  BINDING_TYPE,
  PARAMETER_KIND_BY_TYPE,
  bindingTypeLabel,
  mapParameterKind,
  buildCustomApiFilter,
  groupParameterKinds,
  toCustomApiEntry,
  escapeODataString,
};
