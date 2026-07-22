#!/usr/bin/env node

// Captures answers to the 3 empirical unknowns called out in the offline-profile
// reference docs:
//
//   1. selectedcolumns JSON shape — sample one mobileofflineprofileitem from
//      an existing profile (maker-portal-created if possible) and dump the
//      selectedcolumns memo verbatim.
//   2. selectedrelationshipsschema picklist values — query the global option
//      set and dump option Value+Label pairs.
//   3. Validate response shape — call Validate with a FetchExpression
//      targeting the most-recent profile and dump the response body verbatim.
//
// Output is a JSON object with one section per unknown. Save the output
// somewhere and paste back to update shared/references/offline-profile-schema.md
// + dataverse-offline-api.md if any answer differs from what those docs assume.
//
// USAGE:
//   node capture-empirical-answers.js <envUrl> [--profile-id <guid>]
//
//   <envUrl>        - Dataverse env URL
//   --profile-id    - Optional. Sample selectedcolumns from THIS profile's items.
//                     If omitted, picks the first profile returned by /mobileofflineprofiles.
//
// EXIT:
//   0 — captures completed (some may be empty if no profile exists yet)
//   1 — auth or network failure

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length < 1 || argv[0].startsWith('--')) {
    usage('envUrl is required as the first positional argument');
  }
  const out = { envUrl: argv[0].replace(/\/+$/, ''), profileId: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--profile-id') { out.profileId = argv[++i]; }
    else usage(`Unknown flag: ${argv[i]}`);
  }
  return out;
}

function usage(msg) {
  process.stderr.write(`Error: ${msg}\nUsage: node capture-empirical-answers.js <envUrl> [--profile-id <guid>]\n`);
  process.exit(1);
}

async function dvGet(envUrl, apiPath, token) {
  const url = `${envUrl}/api/data/v9.2/${apiPath}`;
  const res = await makeRequest({
    url, method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 30000,
  });
  if (res.error) return { error: res.error };
  let data = null;
  try { data = JSON.parse(res.body); } catch { data = res.body; }
  return { status: res.statusCode, data };
}

async function dvPost(envUrl, apiPath, body, token) {
  const url = `${envUrl}/api/data/v9.2/${apiPath}`;
  const res = await makeRequest({
    url, method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    timeout: 30000,
  });
  if (res.error) return { error: res.error };
  let data = null;
  try { data = JSON.parse(res.body); } catch { data = res.body; }
  return { status: res.statusCode, data };
}

async function main() {
  const { envUrl, profileId: argProfileId } = parseArgs();
  const token = await getAuthToken(envUrl);
  if (!token) {
    process.stderr.write('Failed to get Azure CLI token. Run `az login` first.\n');
    process.exit(1);
  }

  const result = {
    capturedAt: new Date().toISOString(),
    envUrl,
    questions: {},
  };

  // ─── Q1: selectedcolumns JSON shape ──────────────────────────────────────
  let profileId = argProfileId;
  if (!profileId) {
    const listRes = await dvGet(
      envUrl,
      'mobileofflineprofiles?$select=mobileofflineprofileid,name&$top=5',
      token,
    );
    if (listRes.status === 200 && (listRes.data.value || []).length > 0) {
      profileId = listRes.data.value[0].mobileofflineprofileid;
      result.questions.q1_selectedcolumns = {
        sampledFromProfileId: profileId,
        sampledFromProfileName: listRes.data.value[0].name,
        profilesInEnv: listRes.data.value.length,
      };
    } else {
      result.questions.q1_selectedcolumns = {
        skipped: 'no profiles in env yet',
        hint: 'Create one (via maker portal or /setup-offline-profile), then re-run',
        listStatus: listRes.status,
      };
    }
  } else {
    result.questions.q1_selectedcolumns = { sampledFromProfileId: profileId };
  }

  if (profileId) {
    const itemsRes = await dvGet(
      envUrl,
      `mobileofflineprofileitems?$filter=_regardingobjectid_value eq ${profileId}&$select=mobileofflineprofileitemid,selectedentitytypecode,selectedcolumns,syncintervalinminutes,recorddistributioncriteria&$top=10`,
      token,
    );
    if (itemsRes.status === 200) {
      const items = itemsRes.data.value || [];
      result.questions.q1_selectedcolumns.itemCount = items.length;
      result.questions.q1_selectedcolumns.rawSamples = items.map((it) => ({
        itemId: it.mobileofflineprofileitemid,
        table: it.selectedentitytypecode,
        recordDistributionCriteria: it.recorddistributioncriteria,
        selectedcolumns_raw: it.selectedcolumns,
        selectedcolumns_parsed: tryParseJson(it.selectedcolumns),
      }));
    } else {
      result.questions.q1_selectedcolumns.error = itemsRes.data;
    }
  }

  // ─── Q2: selectedrelationshipsschema picklist values ─────────────────────
  const optionSetRes = await dvGet(
    envUrl,
    `EntityDefinitions(LogicalName='mobileofflineprofileitemassociation')/Attributes(LogicalName='selectedrelationshipsschema')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName,OptionSet&$expand=OptionSet`,
    token,
  );
  result.questions.q2_selectedrelationshipsschema = {
    httpStatus: optionSetRes.status,
  };
  if (optionSetRes.status === 200 && optionSetRes.data.OptionSet) {
    const options = (optionSetRes.data.OptionSet.Options || []).map((o) => ({
      Value: o.Value,
      Label: o.Label?.UserLocalizedLabel?.Label || o.Label?.LocalizedLabels?.[0]?.Label,
      Description: o.Description?.UserLocalizedLabel?.Label,
    }));
    result.questions.q2_selectedrelationshipsschema.optionCount = options.length;
    result.questions.q2_selectedrelationshipsschema.firstFewOptions = options.slice(0, 20);
    result.questions.q2_selectedrelationshipsschema.note =
      options.length === 0
        ? 'OPTION SET IS EMPTY — picklist is dynamically populated server-side per item; recipe must fall back to null or post-validate'
        : `Static option set with ${options.length} entries — recipe can pre-resolve by Label match`;
  } else {
    result.questions.q2_selectedrelationshipsschema.error = optionSetRes.data || optionSetRes.error;
  }

  // ─── Q3: Validate response shape ─────────────────────────────────────────
  result.questions.q3_validate = {};
  if (profileId) {
    const fetchXml =
      `<fetch top="1"><entity name="mobileofflineprofile">` +
      `<filter><condition attribute="mobileofflineprofileid" operator="eq" value="${profileId}"/></filter>` +
      `</entity></fetch>`;

    const validateRes = await dvPost(
      envUrl,
      'Validate',
      {
        Query: {
          '@odata.type': 'Microsoft.Dynamics.CRM.FetchExpression',
          Query: fetchXml,
        },
      },
      token,
    );
    result.questions.q3_validate = {
      httpStatus: validateRes.status,
      response: validateRes.data,
      requestBodyAttempted: {
        Query: {
          '@odata.type': 'Microsoft.Dynamics.CRM.FetchExpression',
          Query: fetchXml,
        },
      },
      interpretation: interpretValidate(validateRes),
    };
  } else {
    result.questions.q3_validate.skipped = 'no profile to validate (Q1 had no profile)';
  }

  console.log(JSON.stringify(result, null, 2));
}

function tryParseJson(s) {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return { __parse_error: true, raw: s.slice(0, 200) }; }
}

function interpretValidate(res) {
  if (res.error) return 'network/transport failure';
  if (res.status === 404) return 'Validate message not exposed in this org / sovereign cloud — skip in skill';
  if (res.status === 400) return 'Request shape rejected — capture .error.message to refine recipe';
  if (res.status === 200 || res.status === 204) return 'Validate succeeded — recipe shape is correct';
  return `Unexpected status ${res.status}`;
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.stack || err.message}\n`);
  process.exit(1);
});
