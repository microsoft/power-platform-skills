'use strict';

const { odataLit } = require('./odata.js');
const { compareText } = require('./compare-text.js');
const { labelsByLcid } = require('./lookup-labels.js');

// StatusOptionMetadata carries the State as well as Value, Label and Color. The SDK's choices
// projection drops State, so it cannot tell an inactive reason from an active one.
//   .../StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)
//   -> { "value": [{ "LogicalName": "statuscode", "OptionSet": { "Options": [
//        { "Value": 100000042, "State": 1, "Label": { "LocalizedLabels": [...] }, "Color": "#336699" }
//      ] } }] }
// A failed/incomplete answer is unknown, never proof of an empty list.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/statusoptionmetadata
async function readStatusOptions(client, logical) {
  try {
    if (!client || typeof client.get !== 'function') return { failed: 'no metadata client' };
    const res = await client.get(`/EntityDefinitions(LogicalName='${odataLit(logical)}')/Attributes/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`);
    if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status}`);
    const rows = res.body && res.body.value;
    const status = Array.isArray(rows) && rows.find((a) => a && String(a.LogicalName).toLowerCase() === 'statuscode');
    if (!status || !status.OptionSet || !Array.isArray(status.OptionSet.Options)) throw new Error('the response carried no statuscode options');
    return { options: status.OptionSet.Options };
  } catch (err) {
    return { failed: (err && err.message) ? String(err.message).slice(0, 200) : 'read failed' };
  }
}

function statusReasonsFromOptions(options, { customTable = true, languageCode, omitted = [] } = {}) {
  const usable = [];
  for (const option of options || []) {
    if (!option || option.IsManaged === true || option.Value === 1 || option.Value === 2) continue;
    // Stock tables have other built-in reasons; only the publisher range identifies an addition.
    if (!customTable && option.Value < 100000000) continue;
    if (!Number.isInteger(option.Value) || ![0, 1].includes(option.State)) {
      omitted.push(`status reason ${option.Value}: its value, Active/Inactive state or label cannot be expressed`);
      continue;
    }
    // A string status label is rebuilt in the resolved authoring LCID, not the caller's UI
    // language. Another LCID (even UserLocalizedLabel) cannot prove that label round-trips.
    const label = labelsByLcid(option.Label)[languageCode];
    if (!label) {
      omitted.push(`status reason ${option.Value}: its label in authoring language ${languageCode || '(unresolved)'} could not be read`);
      continue;
    }
    usable.push({ option, label });
  }
  usable.sort((a, b) => a.option.Value - b.option.Value);
  return usable.map(({ option, label }, index) => ({
    label, state: option.State === 0 ? 'Active' : 'Inactive',
    // The build assigns this range by index. Keep any other number explicitly so a download
    // never reassigns rows to another reason when reasons were inserted or reordered in Maker.
    ...(option.Value !== 100000000 + index ? { value: option.Value } : {}),
    ...(typeof option.Color === 'string' && option.Color.trim() ? { color: option.Color } : {}),
  }));
}

function alternateKeysFromMetadata(keys, labelOf, omitted = []) {
  const out = [];
  // A malformed optional expansion (e.g. Keys: {}) is already diagnosed by the reader.
  // It says nothing about the table's independently recovered primary name or typed columns.
  for (const key of Array.isArray(keys) ? keys : []) {
    if (!key || key.IsManaged === true) continue;
    if (typeof key.SchemaName !== 'string' || !key.SchemaName.trim()
      || !Array.isArray(key.KeyAttributes) || !key.KeyAttributes.length
      || key.KeyAttributes.some((name) => typeof name !== 'string' || !name.trim())) {
      omitted.push(`alternate key ${key && key.SchemaName || '(unnamed)'}: its name or columns could not be read`);
      continue;
    }
    const displayName = labelOf(key.DisplayName);
    out.push({
      schemaName: key.SchemaName,
      ...(displayName !== undefined ? { displayName } : {}),
      columns: [...key.KeyAttributes],
    });
  }
  return out.sort((a, b) => compareText(a.schemaName, b.schemaName));
}

function alternateKeyMatches(keys, key) {
  const names = (values) => Array.isArray(values) && values.every((v) => typeof v === 'string' && v)
    ? values.map((v) => v.toLowerCase()).sort(compareText) : null;
  const wanted = names(key.columns);
  return !!wanted && wanted.length > 0 && Array.isArray(keys) && keys.some((candidate) => {
    if (!candidate || String(candidate.SchemaName).toLowerCase() !== String(key.schemaName).toLowerCase()) return false;
    const found = names(candidate.KeyAttributes);
    return found && found.length === wanted.length && found.every((v, i) => v === wanted[i]);
  });
}

module.exports = { readStatusOptions, statusReasonsFromOptions, alternateKeysFromMetadata, alternateKeyMatches };
