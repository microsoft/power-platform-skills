'use strict';
// A table's STATUS REASONS and ALTERNATE KEYS as the environment holds them, and how the ones a spec declares
// (`entities[].statusReasons[]`, `entities[].alternateKeys[]`) compare with them — what verify checks (verify-spec.js, each declared one a
// check of its own), with one read of each made only for a table that declares any.
//
// Both reads are narrow ones on the SDK's own client (`sdk.dataverse`), as lookup-labels.js and view-filter-labels.js read, and for their
// reasons: the SDK's whole-table read (`fetchEntityMetadata`) costs about eleven requests, writes the table into the workspace, and
// carries neither a status reason's state nor any key; and the SDK has no read of a table's keys at all (its key surface is create and
// delete). Neither read throws: like readChoiceAttributes, each answers `{ state: 'ok', … }`, `{ state: 'absent' }` (the table answered
// 404) or `{ state: 'error', why }`, so a read that failed is reported as one, never as "nothing there".

const { odataLit } = require('./odata.js');
const { labelText, labelAliases } = require('./app-spec.js');
const { readMetadata } = require('./lookup-labels.js');
const { optionCastUrl, parseOptions } = require('./view-filter-labels.js');
const { statusReasonTargets } = require('./entity-provision.js');

const lc = (s) => String(s == null ? '' : s).toLowerCase();

// The two states a status reason of a table the App Spec builds can belong to (statecode 0 and 1). Another number — a system table's third
// state — is named by its number.
const STATE_NAME = { 0: 'Active', 1: 'Inactive' };
const stateName = (state) => STATE_NAME[state] || `state ${state}`;

// The status reasons of a table: the options of its Status attribute (`statuscode`), each with its value, the state it belongs to and its
// label in every language. ONE read, the cast read the view filter's label resolution makes for the same column (optionCastUrl):
//   GET /EntityDefinitions(LogicalName='contoso_project')/Attributes/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)
//   -> { "value": [ { "LogicalName": "statuscode", "MetadataId": "<guid>", "OptionSet": { "Options": [
//          { "Value": 1, "State": 0, "Label": { "LocalizedLabels": [ { "Label": "Active", "LanguageCode": 1033 } ], … } },
//          { "Value": 2, "State": 1, "Label": { … "Inactive" … } },
//          { "Value": 100000000, "State": 0, "Label": { … "In Review" … } } ] } } ] }
// A table has one Status attribute, so the list holds one row. Answers { state: 'ok', options: [{ value, state, labels, shown }] }.
// A metadata read answers the SAVED definition: measured live for a column's label, which a read returned right after its PUT, before any
// publish (entity-provision.js, publishRelabelledTables). So a reason a build inserted without --publish is expected to be found here,
// as the build's own views phase finds it to resolve a view filter's label; whether the app shows it yet is a publish's business.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/statusattributemetadata
async function readStatusReasons(client, entityLogical, { languageCode } = {}) {
  const got = await readMetadata(client, optionCastUrl(entityLogical, 'Status'));
  if (got.state !== 'ok') return got;
  if (!Array.isArray(got.body.value)) return { state: 'error', why: 'the answer carried no list of status columns' };
  const row = got.body.value.find((r) => r && lc(r.LogicalName) === 'statuscode');
  const options = row && row.OptionSet && Array.isArray(row.OptionSet.Options) ? row.OptionSet.Options : null;
  if (!options) return { state: 'error', why: 'the answer carried no status reasons' };
  return { state: 'ok', options: parseOptions(options, languageCode) };
}

// The alternate keys of a table, each with its name and its columns. ONE read:
//   GET /EntityDefinitions(LogicalName='contoso_project')/Keys?$select=LogicalName,SchemaName,KeyAttributes
//   -> { "value": [ { "LogicalName": "contoso_emailkey", "SchemaName": "contoso_emailkey", "KeyAttributes": [ "contoso_email" ], "MetadataId": "<guid>" } ] }
// Live, a key read back answered its columns in an order of its own (a key made over a name and a code column answered code, name), so the
// columns are compared as a set. Right after its create a key's index is still being built (`EntityKeyIndexStatus` "Pending", measured
// live), which is why the index status is not read: a key of the declared name over the declared columns is the key the spec declares.
// A row without its columns cannot be compared, so the whole answer is not used. Answers { state: 'ok', keys: [{ logicalName, schemaName, columns }] }.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/entitykeymetadata
async function readAlternateKeys(client, entityLogical) {
  const got = await readMetadata(client, `/EntityDefinitions(LogicalName='${odataLit(lc(entityLogical))}')/Keys?$select=LogicalName,SchemaName,KeyAttributes`);
  if (got.state !== 'ok') return got;
  if (!Array.isArray(got.body.value)) return { state: 'error', why: 'the answer carried no list of keys' };
  const keys = [];
  for (const row of got.body.value) {
    const name = row && (row.LogicalName || row.SchemaName);
    if (typeof name !== 'string' || !name) continue;
    if (!Array.isArray(row.KeyAttributes)) return { state: 'error', why: `the key '${name}' was answered without its columns` };
    keys.push({ logicalName: lc(name), schemaName: String(row.SchemaName || name), columns: row.KeyAttributes.map(lc) });
  }
  return { state: 'ok', keys };
}

// What a reader answered, made into one of the three answers above: a reader that throws, or answers nothing a check can use, is a read that
// failed — reported on each check it was for, with the reason, and never the end of the verification pass.
async function answerOf(read) {
  try {
    const answer = await read();
    return answer && typeof answer === 'object' && typeof answer.state === 'string' ? answer : { state: 'error', why: 'no answer' };
  } catch (err) {
    return { state: 'error', why: (err && err.message) || String(err) };
  }
}
const unreadable = (answer) => `could not be read: ${answer.state === 'absent' ? 'the environment answered that the table is not there' : answer.why || 'no answer'}`;

// The checks of a table's declared status reasons against what readStatusReasons answered — one per reason, in the spec's order, each
// named `<table>.<label>` (its label in the spec's language) and held to what the build gives it (statusReasonTargets, entity-provision.js):
//   present    one of the table's status reasons carries the label, in any language it is written in, under that state — and at the value
//              the spec pins, when it pins one
//   different  the label is there, under the other state or at another value than the pinned one: said, with both
//   missing    no status reason carries the label. When the value the build gives it is another label's, that is said too: a rebuild inserts
//              the reason at that value again, which the platform refuses as already there, so a reason renamed in the environment stays so
// An option's missing/non-integer state is not proof of the requested state: report it as unreadable rather than guessing a match.
function statusReasonChecks(entity, answer, { languageCode } = {}) {
  return statusReasonTargets(entity).map(({ statusReason, stateCode, value }) => {
    const name = `${entity.schemaName}.${labelText(statusReason.label, languageCode)}`;
    if (answer.state !== 'ok') return { name, present: false, detail: unreadable(answer) };
    const aliases = labelAliases(statusReason.label);
    const named = answer.options.filter((o) => o.labels.some((l) => aliases.includes(l)));
    const pinned = typeof statusReason.value === 'number';
    const atValue = (o) => !pinned || o.value === value;
    const inState = (o) => Number.isInteger(o.state) && o.state === stateCode;
    if (named.some((o) => atValue(o) && inState(o))) return { name, present: true, detail: '' };
    if (named.some((o) => atValue(o) && !Number.isInteger(o.state))) return { name, present: false, detail: `its state could not be read; the spec declares it under ${stateName(stateCode)}` };
    const otherState = named.find(atValue);
    if (otherState) return { name, present: false, detail: `a status reason of the ${stateName(otherState.state)} state; the spec declares it under ${stateName(stateCode)}` };
    if (named.length) return { name, present: false, detail: `its value is ${named[0].value}; the spec pins ${value}` };
    const holder = answer.options.find((o) => o.value === value);
    return { name, present: false, detail: holder ? `its value, ${value}, is the status reason '${holder.shown}' in the environment, and a build does not rename one` : '' };
  });
}

// The checks of a table's declared alternate keys against what readAlternateKeys answered — one per key, in the spec's order, each named
// `<table>.<schemaName>`:
//   present    the table has a key of that name (the platform's logical name is the schema name in lower case) over exactly the declared
//              columns, in any order
//   different  the key is there over other columns: said, with both
//   missing    no key has the name — and when a key of another name is over exactly those columns, that is said too
function alternateKeyChecks(entity, answer) {
  const columnsOf = (list) => [...new Set((list || []).map(lc))].sort();
  return ((entity && entity.alternateKeys) || []).map((key) => {
    const name = `${entity.schemaName}.${key.schemaName}`;
    if (answer.state !== 'ok') return { name, present: false, detail: unreadable(answer) };
    const want = columnsOf(key.columns);
    const same = (k) => columnsOf(k.columns).join('\n') === want.join('\n');
    const found = answer.keys.find((k) => k.logicalName === lc(key.schemaName));
    if (found) return same(found) ? { name, present: true, detail: '' } : { name, present: false, detail: `its columns are ${columnsOf(found.columns).join(', ')}; the spec declares ${want.join(', ')}` };
    const twin = answer.keys.find(same);
    return { name, present: false, detail: twin ? `a key over the same columns is there as '${twin.schemaName}'` : '' };
  });
}

module.exports = { readStatusReasons, readAlternateKeys, answerOf, statusReasonChecks, alternateKeyChecks };
