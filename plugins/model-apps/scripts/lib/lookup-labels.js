'use strict';
// The environment-facing half of the lookup label default (ADO 6691205).
//
// The RULE lives in app-spec.js (`lookupLabelFor`) so every offline surface shares it. What is here
// is only what needs Dataverse: reading the display name of a parent table the spec cannot name, and the
// current labels of a table's lookup columns (so a rebuild can tell the build's old default from a maker's
// label).
//
// These are deliberately NARROW reads on the SDK's own client (`sdk.dataverse`) — one keyed read of a
// table's DisplayName, one `Attributes` read of a table's lookup columns — not
// `fetchEntityMetadata`/`findTables`: those are the broad reads documented on `relationshipExists`
// (entity-provision.js) as the ones that make Dataverse keep only the base-language label of the create
// that follows, they write the fetched table into the build's workspace, and `fetchEntityMetadata` costs
// ~11 requests for the one property needed here. Remove this once the SDK offers a label-only read.

const { odataLit } = require('./odata.js');
const { labelText } = require('./app-spec.js');

// Dataverse sends a Label as:
//   { "LocalizedLabels": [ { "Label": "Account", "LanguageCode": 1033, "IsManaged": true, ... },
//                          { "Label": "Compte",  "LanguageCode": 1036, ... } ],
//     "UserLocalizedLabel": { "Label": "Compte", "LanguageCode": 1036, ... } }
// `UserLocalizedLabel` is the label in the CALLING USER's language, which is not necessarily the
// language the build stamps on the label it writes — so the labels are read by language code instead.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/label
function labelsByLcid(label) {
  const out = {};
  const rows = label && Array.isArray(label.LocalizedLabels) ? label.LocalizedLabels : [];
  for (const row of rows) {
    const lcid = Number(row && row.LanguageCode);
    if (Number.isInteger(lcid) && lcid > 0 && typeof row.Label === 'string' && row.Label.trim()) out[String(lcid)] = row.Label;
  }
  return out;
}

// One label to write as a plain string: the entry for the authoring language, then 1033, then the
// lowest-numbered language (labelText's own order, so an offline surface and a live read agree on a
// fallback), and only then the calling user's.
function pickLabel(label, languageCode) {
  const map = labelsByLcid(label);
  const picked = labelText(map, languageCode);
  if (picked) return picked;
  const user = label && label.UserLocalizedLabel && label.UserLocalizedLabel.Label;
  return typeof user === 'string' && user.trim() ? user : null;
}

function describe(res, thrown) {
  if (thrown) return (thrown && thrown.message) || String(thrown);
  const envelope = res && res.body && typeof res.body === 'object' && (res.body.error || res.body.Error);
  return envelope && envelope.message ? `HTTP ${res.status}: ${envelope.message}` : `HTTP ${res && res.status}`;
}

// `dataverse.get` RESOLVES with `{ status }` on a non-2xx instead of throwing, and rejects only on a
// transport failure; both are folded into one discriminated answer so no caller can mistake "could not
// read" for "absent".
async function read(client, url) {
  let res;
  try {
    res = await client.get(url);
  } catch (err) {
    return { state: 'error', why: describe(null, err) };
  }
  if (res && res.status === 404) return { state: 'absent' };
  if (!res || res.status < 200 || res.status >= 300 || !res.body || typeof res.body !== 'object') {
    return { state: 'error', why: describe(res) };
  }
  return { state: 'ok', body: res.body };
}

// The display name of a table, as one string in the authoring language.
//   GET /EntityDefinitions(LogicalName='account')?$select=LogicalName,DisplayName
//   -> 200 { "LogicalName": "account", "DisplayName": <Label> }      (see labelsByLcid)
// Returns { state: 'ok', label } | { state: 'absent' } | { state: 'error', why }.
// `label` is null when the table carries none (a table every label of which is blank).
async function readTableLabel(client, logical, languageCode) {
  const got = await read(client, `/EntityDefinitions(LogicalName='${odataLit(logical)}')?$select=LogicalName,DisplayName`);
  if (got.state !== 'ok') return got;
  return { state: 'ok', label: pickLabel(got.body.DisplayName, languageCode) };
}

// The labels of some columns of ONE table, each in EVERY language it carries:
//   GET /EntityDefinitions(LogicalName='contoso_task')/Attributes?$select=LogicalName,DisplayName
//       &$filter=LogicalName eq 'contoso_projectid' or LogicalName eq 'contoso_ownerid'
//   -> 200 { "value": [ { "LogicalName": "contoso_projectid", "DisplayName": <Label> }, … ] }     (see labelsByLcid)
// This is the read the vendored SDK itself makes for column hints (`readColumnHints`: one `Attributes`
// request filtered by logical name, in batches of 40), so one request covers every lookup of a table where
// a keyed read per lookup cost one each on every rebuild. `DisplayName` is declared on the base
// AttributeMetadata type, so no cast is needed, and a column the table lacks is simply absent from `value`.
// All languages, not one: the rebuild repair applies only to a label written in a single language — the old
// default was — and must be able to see that a second one is there.
// Returns { state: 'ok', byColumn: Map(logical -> { "1033": "…" }) } | { state: 'absent' } (the TABLE is not
// there) | { state: 'error', why }.
const COLUMN_READ_BATCH = 40;
async function readColumnLabels(client, entityLogical, columnLogicals) {
  const names = [...new Set((columnLogicals || []).map((c) => String(c).toLowerCase()).filter(Boolean))];
  const byColumn = new Map();
  for (let i = 0; i < names.length; i += COLUMN_READ_BATCH) {
    const filter = names.slice(i, i + COLUMN_READ_BATCH).map((n) => `LogicalName eq '${odataLit(n)}'`).join(' or ');
    const got = await read(client, `/EntityDefinitions(LogicalName='${odataLit(entityLogical)}')/Attributes?$select=LogicalName,DisplayName&$filter=${filter}`);
    if (got.state !== 'ok') return got;
    if (!Array.isArray(got.body.value)) return { state: 'error', why: 'the response carried no value array' };
    for (const row of got.body.value) {
      if (row && typeof row.LogicalName === 'string') byColumn.set(row.LogicalName.toLowerCase(), labelsByLcid(row.DisplayName));
    }
  }
  return { state: 'ok', byColumn };
}

// A memoizing reader for the display names of parent tables the spec cannot name (see
// lookupParentNeedsEnvironment, app-spec.js). One read per table per build however many lookups point at
// it. Returns null when there is no raw client to read with (a test double), so callers fall back to the
// humanized name without pretending to have asked.
//
// A failed read is reported ONCE per table through `warn` and cached as "no label", so a lookup to a
// table the environment would not answer for falls back to a humanized name rather than failing a
// build over a label.
function makeTableLabelReader({ provision, languageCode, warn }) {
  const client = provision && provision.dataverse;
  if (!client || typeof client.get !== 'function') return null;
  const cache = new Map();
  return (logical) => {
    const key = String(logical).toLowerCase();
    if (!cache.has(key)) {
      cache.set(key, readTableLabel(client, key, languageCode).then((got) => {
        if (got.state === 'ok') return got.label;
        if (got.state === 'error' && typeof warn === 'function') {
          warn(`could not read the display name of table '${key}' (${got.why}), so a lookup to it that sets no lookup.displayName is labelled with the table's name instead. Set lookup.displayName, or rename the column in Maker.`);
        }
        return null;
      }));
    }
    return cache.get(key);
  };
}

// `<referencing>|<lookup logical>`, the identity a lookup column has across the data-model result, the
// rebuild repair and the forms phase.
function lookupKey(rel) {
  return `${String(rel.referencing).toLowerCase()}|${String((rel.lookup && rel.lookup.schemaName) || '').toLowerCase()}`;
}

// Are two spec labels the same label? A string equals a string; an LCID map equals a map with the same
// languages and text. A string and a map never are: a rebuild writes them differently (one language vs
// several), which is the difference the download must not erase.
function sameLabel(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
  }
  return false;
}

module.exports = { labelsByLcid, pickLabel, readMetadata: read, readTableLabel, readColumnLabels, makeTableLabelReader, lookupKey, sameLabel };
