'use strict';
// Resolve the option LABELS a view filter names to the option VALUES the platform stores (ADO 6691114).
//
// A view filter may write a Choice option as its label — `{ "attr": "new_tier", "op": "eq", "value": "Gold" }`
// — and the FetchXML condition needs the option's integer. The build used to derive that from the spec
// alone (`choiceValueMap`, app-spec.js): the options a spec column declares inline, or those of a global
// choice the spec declares, numbered 100000000 + index. That is only the right answer when THIS build
// created the option set. It silently was not when
//   1. the filter is on a choice column of an EXISTING table the spec declares no column of — a LOCAL
//      option set (account.industrycode) or one bound to a SYSTEM global choice. The label then reached the
//      FetchXML as the condition's value, passed lint, and Dataverse rejected the saved view mid-build, after
//      the tables and columns had been written;
//   2. a declared global choice already existed with other values — the SDK's createGlobalOptionSet REUSES
//      an existing set unchanged (a re-run with different options returns the existing set), and a maker
//      may have added or renumbered options in the portal since.
// (A column bound to a global choice the spec does NOT declare is a lint error — the build would create it
// with no options — so it never reaches here.)
//
// So a label is resolved against the option metadata the ENVIRONMENT holds whenever it can be read, and
// against the spec only where the environment cannot say. A label that matches nothing is a PROBLEM, never a
// value, and it is found as early as it can be known (one exception, `specNumberStands`: where the spec numbers
// the options and the environment has an option on the number the spec gives the label but calls it something
// else — a maker renamed it — the spec's number is kept, with a warning, unless the environment shows another
// numbering):
//   - `checkViewFilterLabelsBeforeBuild`, before the build writes anything (and in the dry run): only what the
//     environment ALREADY shows, or what the spec alone decides because the build is about to create it. The
//     build skips it when the spec carries a localized label (`preflightViewLabels`, sdk-build.js): these reads
//     carry labels, and a label-bearing read ahead of a create can cost a multi-language label its other languages;
//   - `resolveViewFilterLabels`, in the views phase once the data model exists: the final answer, with values.

const { choiceValueMap, labelText, labelAliases, lookupColumnsFor } = require('./app-spec.js');
const { odataLit } = require('./odata.js');
const { labelsByLcid, readMetadata } = require('./lookup-labels.js');

// A value that is already an option VALUE (or any other number) is not a label, so an integer string — or a
// comma-separated list of them, the form a multi-select's value takes — is never resolved and never read for.
// A numeric option label the SPEC declares ("2024") still resolves as a label, as it always did: that is the
// spec-only rule `viewDef` applies after this, and it asks for nothing from here.
const INTEGER = /^-?\d+(?:\s*,\s*-?\d+)*$/;

// An id or a date is never an option label, so on an attribute the spec does not declare — where it could be
// anything — it is not worth a read of the table's option sets to find that out. (On a declared Choice column
// it is still a label that names no option, and is reported as one.)
const GUID = /^\{?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}?$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

// The operators whose value is compared with an option. `lt`/`ge`… on a choice compare option numbers, which
// no one writes as labels, and `like`/`on`/`this-week`… belong to other column types — so they are left to
// the spec-only rule `viewDef` has always applied to a declared Choice column.
const OPTION_OPS = new Set(['eq', 'ne', 'neq', 'in', 'not-in', 'contain-values', 'not-contain-values']);

// How many valid labels an error lists before it says how many it left out — an option set such as
// industrycode has dozens, and a message that long hides the one line that matters.
const LABELS_SHOWN = 25;

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const keyOf = (entity, attr, label) => `${lc(entity)}|${lc(attr)}|${label}`;

// The spec's table by logical name. Not `_graph.entityByLogical`: lint runs this on a half-typed spec, where
// an entry with no schemaName is a finding for validation to report, and that helper would throw on it.
const entityOf = (spec, logical) => ((spec && spec.entities) || []).find((e) => e && lc(e.schemaName) === logical);

// The labels the spec itself gives a Choice column's options — inline, or those of a global choice it
// declares — in the authoring language. Empty for a column bound to a global choice the spec does not declare
// (a lint error, so not a case a build meets).
function declaredLabels(spec, column) {
  const inline = column && Array.isArray(column.options) && column.options.length ? column.options : null;
  const shared = !inline && column && column.globalChoice
    ? (((spec.globalChoices || []).find((g) => g && lc(g.name) === lc(column.globalChoice)) || {}).options || [])
    : [];
  return (inline || shared).map((o) => labelText(o, spec && spec.languageCode)).filter(Boolean);
}

// What the spec says about an attribute of the view's table: a declared column (its App Spec type), the
// primary name column, or a relationship's lookup — or nothing, which is every system column (statuscode,
// createdon…) and every column of an existing table the spec does not list.
function declaredAttribute(spec, entity, attr) {
  if (!entity) return null;
  const column = (entity.columns || []).find((c) => c && typeof c.schemaName === 'string' && lc(c.schemaName) === attr);
  if (column) return { type: column.type || 'Text', column };
  if (entity.primaryAttribute && lc(entity.primaryAttribute.schemaName) === attr) return { type: 'Text' };
  if (lookupColumnsFor(spec, lc(entity.schemaName)).some((l) => l.logical === attr)) return { type: 'Lookup' };
  return null;
}

// Every place a view filter writes a LABEL: [{ view, viewName, entity, attr, label }].
//
// A label is a string that is not an integer, in the value of an option-comparing operator, on an
// attribute that is not a declared non-choice column. An undeclared attribute is included because the spec
// cannot say it is not a choice — resolving it is what tells (a text column's string is then used as written)
// — unless the value is an id or a date, which no option is labelled with.
function labelUses(spec, view) {
  const out = [];
  const entityLogical = lc(view && view.entity);
  const entity = entityOf(spec, entityLogical);
  for (const f of (view && Array.isArray(view.filters) ? view.filters : [])) {
    if (!f || typeof f.attr !== 'string') continue;
    const op = f.op || 'eq';
    if (!OPTION_OPS.has(op)) continue;
    const attr = lc(f.attr);
    const declared = declaredAttribute(spec || {}, entity, attr);
    if (declared && declared.type !== 'Choice' && declared.type !== 'MultiChoice') continue;
    // in / not-in read values[] and everything else reads value — exactly what viewDef sends.
    const tokens = op === 'in' || op === 'not-in' ? (Array.isArray(f.values) ? f.values : []) : (f.value === undefined ? [] : [f.value]);
    for (const token of tokens) {
      if (typeof token !== 'string' || INTEGER.test(token)) continue;
      if (!declared && (GUID.test(token) || ISO_DATE.test(token))) continue;
      out.push({ view, viewName: view.name, entity: entityLogical, attr, label: token });
    }
  }
  return out;
}

const hasLabelUses = (spec, view) => labelUses(spec, view).length > 0;

// Dataverse sends an option set as:
//   { "value": [ { "LogicalName": "new_tier",
//                  "OptionSet": { "Options": [ { "Value": 227350001,
//                                                "Label": { "LocalizedLabels": [ { "Label": "Gold", "LanguageCode": 1033 },
//                                                                                { "Label": "Oro",  "LanguageCode": 3082 } ],
//                                                           "UserLocalizedLabel": { "Label": "Gold", "LanguageCode": 1033 } } } ] } } ] }
// A column bound to a global choice carries the shared set in `OptionSet`, exactly as an inline one does —
// measured live by the download's option-set read (download-model-app.js `readOptionSets`), where a
// global-bound column returned all of its options through `OptionSet`. `GlobalOptionSet` is deliberately not
// read: it is populated for a LOCAL set too, and then carries only the set's name. `Label` is read by
// language code rather than through `UserLocalizedLabel`, which is only the calling user's language — a
// filter may name a label in any.
function parseOptions(rawOptions, languageCode) {
  const options = [];
  for (const raw of Array.isArray(rawOptions) ? rawOptions : []) {
    if (!raw || !Number.isFinite(Number(raw.Value))) continue;
    const byLcid = labelsByLcid(raw.Label);
    const labels = Object.values(byLcid);
    const user = raw.Label && raw.Label.UserLocalizedLabel && raw.Label.UserLocalizedLabel.Label;
    if (typeof user === 'string' && user.trim() && !labels.includes(user)) labels.push(user);
    options.push({ value: Number(raw.Value), labels, shown: labelText(byLcid, languageCode) || labels[0] || String(raw.Value) });
  }
  return options;
}

// The four attribute kinds a filter can name an option of, each read by its OWN cast: `Attributes` is a
// heterogeneous collection, so `OptionSet` can only be expanded through a cast segment, and one request per
// kind is the narrowest read there is. Boolean is left out on purpose — its two options are true/false, and
// `value="true"` is already what a Two Options filter writes.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-metadata-web-api
//      https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/enumattributemetadata
const OPTION_CASTS = ['Picklist', 'MultiSelectPicklist', 'State', 'Status'];

// The choice attributes of one table, with every option and every language of its label:
//   { state: 'ok', attributes: Map(logicalName -> { kind, options: [{ value, labels, shown }] }), complete, why? }
//   { state: 'absent' }                      — the table is not in the environment (every cast answered 404)
//   { state: 'error', why }                  — nothing could be read
// `complete` is false when a cast failed: what the others returned is usable, but an attribute missing from
// an incomplete read is UNKNOWN, not "not a choice".
//
// Deliberately NOT `sdk.fetchEntityMetadata`: it is the SDK's whole-table read (about eleven requests), it
// WRITES the table into the build's workspace — which a read-only dry run must not do — and its `choices`
// carry only the calling user's language, so a label written in another provisioned language could not match.
// This is the same cast reads it makes for options, kept to the four kinds a filter can name. The download's
// `readOptionSets` reads two of these casts for another purpose — declaring option sets, throwing on a failed
// read — whereas a filter also needs State and Status, and needs `absent` and `complete` told apart from
// "nothing there". Remove this when the SDK offers a read of a column's options that neither writes the
// workspace nor drops languages.
async function readChoiceAttributes(client, entityLogical, { languageCode } = {}) {
  const base = `/EntityDefinitions(LogicalName='${odataLit(lc(entityLogical))}')/Attributes/Microsoft.Dynamics.CRM.`;
  const reads = await Promise.all(OPTION_CASTS.map(async (cast) => {
    try {
      const res = await client.get(`${base}${cast}AttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`);
      return { cast, res };
    } catch (err) {
      return { cast, why: (err && err.message) || String(err) };
    }
  }));
  const rows = [];
  const failures = [];
  let absent = 0;
  for (const read of reads) {
    if (read.why) { failures.push(read.why); continue; }
    const { res } = read;
    if (res && res.status === 404) { absent += 1; continue; }
    if (res && res.status >= 200 && res.status < 300 && res.body && Array.isArray(res.body.value)) { rows.push(read); continue; }
    const message = res && res.body && res.body.error && res.body.error.message;
    failures.push(`HTTP ${res && res.status}${message ? `: ${message}` : ''}`);
  }
  if (absent === reads.length) return { state: 'absent' };
  if (!rows.length) return { state: 'error', why: failures[0] || 'no choice metadata was returned' };
  const attributes = new Map();
  for (const { cast, res } of rows) {
    for (const row of res.body.value) {
      if (!row || typeof row.LogicalName !== 'string') continue;
      attributes.set(lc(row.LogicalName), { kind: cast, options: parseOptions(row.OptionSet && row.OptionSet.Options, languageCode) });
    }
  }
  const complete = failures.length === 0 && absent === 0;
  return { state: 'ok', attributes, complete, ...(failures.length ? { why: failures[0] } : {}) };
}

// One read per table, whoever asks and however often: the answer is memoized as a promise, so concurrent
// callers share the read. A reader that throws becomes an `error` answer — a label that cannot be resolved is
// the caller's to report, and must not abort the build or the verify around it.
function memoizeChoiceReader(read) {
  const cache = new Map();
  return (entityLogical) => {
    const key = lc(entityLogical);
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => read(key)).catch((err) => ({ state: 'error', why: (err && err.message) || String(err) })));
    return cache.get(key);
  };
}

// A reader that asks for each table ONCE per build. Null when there is no client to read with — a test double
// — so a caller resolves from the spec alone, exactly as before, without pretending to have asked.
function makeChoiceReader({ client, languageCode } = {}) {
  if (!client || typeof client.get !== 'function') return null;
  return memoizeChoiceReader((key) => readChoiceAttributes(client, key, { languageCode }));
}

// The options of a GLOBAL option set, by name:
//   GET /GlobalOptionSetDefinitions(Name='new_tierset')
//   -> 200 { "MetadataId": "…", "Name": "new_tierset", "IsGlobal": true, "Options": [ { "Value": 227350001, "Label": <Label> }, … ] }
// Returns { state: 'ok', options } | { state: 'absent' } | { state: 'error', why }, `options` as readChoiceAttributes
// gives them. The name is lower-cased, as the SDK does when it probes and creates the set.
//
// Needed only before the build runs: a declared global choice that already exists is REUSED unchanged
// (createGlobalOptionSet), so a column the build is about to create against it will hold the environment's
// options, not the spec's — which cannot be read from a column that does not exist yet. Once the column exists
// its own `OptionSet` says it, and readChoiceAttributes is enough.
// Not `$select`ed: `Options` belongs to the derived OptionSetMetadata, which a keyed read of the abstract set
// type can only project through a cast, and the set is read whole by its documented URL.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-metadata-web-api
async function readGlobalChoiceOptions(client, name, { languageCode } = {}) {
  const got = await readMetadata(client, `/GlobalOptionSetDefinitions(Name='${odataLit(lc(name))}')`);
  if (got.state !== 'ok') return got;
  if (!Array.isArray(got.body.Options)) return { state: 'error', why: 'the response carried no Options array' };
  return { state: 'ok', options: parseOptions(got.body.Options, languageCode) };
}

// One read per set per build. Null when there is no client, as makeChoiceReader.
function makeGlobalChoiceReader({ client, languageCode } = {}) {
  if (!client || typeof client.get !== 'function') return null;
  return memoizeChoiceReader((key) => readGlobalChoiceOptions(client, key, { languageCode }));
}

// The labels an error offers, in the authoring language, cut off at LABELS_SHOWN.
function showLabels(shownLabels) {
  const head = shownLabels.slice(0, LABELS_SHOWN).join(', ');
  return shownLabels.length > LABELS_SHOWN ? `${head} … and ${shownLabels.length - LABELS_SHOWN} more` : head;
}

// Match one label against live options. Exact text, any language: 0 hits is unknown, 1 value resolves, and
// two DIFFERENT values is refused — one string cannot select two options, and a tie-break would be a coin
// flip dressed up as an answer.
function matchOptions(options, label) {
  const hits = [...new Set(options.filter((o) => o.labels.includes(label)).map((o) => o.value))];
  if (hits.length === 1) return { value: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return {};
}

const problemOf = (use, reason, extra = {}) => ({ view: use.viewName, entity: use.entity, attr: use.attr, label: use.label, reason, ...extra });

// Judge one label against the options a SOURCE holds — the environment's, or the spec's — as a problem, or null
// when it names exactly one of them.
function problemAgainst(use, options) {
  const m = matchOptions(options, use.label);
  if (m.value !== undefined) return null;
  return m.ambiguous ? problemOf(use, 'ambiguous', { values: m.ambiguous }) : problemOf(use, 'unknown', { valid: options.map((o) => o.shown) });
}

// The spec's own number for a label stands in where the environment does not carry the label by name. Builds used it
// always before labels were resolved against the environment (2.13.0), so a spec such a build handled must not start
// to stop where it did not — but the number stands only while nothing in the environment says it is ANOTHER option's.
//
// It applies to a column whose options THE SPEC numbers: inline `options[]`, or a global choice `globalChoices[]`
// declares (`choiceValueMap` holds exactly those, 100000000 + index — what a build writes when it creates them). A
// maker's edit changes a label and leaves the number, so the spec's number still names the option where
//   - a maker renamed it ("Gold" -> "Gold Tier"): the value did not change, only its label;
//   - a localized option's label is in a language the environment never stored (a label-bearing read ahead of its
//     create can cost it every language but the base one): the option is there, the translation is not;
//   - a maker added a second option with the same label: the spec's number says which one it meant.
//
// What it must never do is bind a number the environment shows belongs to a DIFFERENT option. A rebuild never changes
// an existing column's options and does not create a column or a set it finds, so the spec's numbering is the
// environment's only where the column or set was built from this very list. Options inserted, removed or reordered in
// the spec since, a column made elsewhere, or a set another app created in another order leave the two apart, and the
// spec's number then names something else. The environment shows it in one of these ways, and each refuses the number:
//   - it has no option on the spec's number at all;
//   - the option on the spec's number goes by the name of ANOTHER option of the spec;
//   - a label of THIS spec sits only on other numbers, and that says the numbering moved: the label is one of the labels of the
//     filter's own option (any alias, in any language — its option is elsewhere), or it sits on a number the spec gives ANOTHER
//     option (the options shifted). Where two options carry the label, the spec's number must be one of them.
//
// A label that sits on a number the spec does not use proves nothing of the kind: it is an option a maker added or made
// again — one added in the Default solution takes another publisher's range, one deleted and re-created takes the next
// free number — and every number the spec has is where it was. Holding that against the spec would stop a build the
// numbers still serve (2.13.0 built it right) whenever a maker both added an option and renamed another. The price is a
// column made elsewhere, in another order and with options the spec lacks, whose rename of the filtered option hides the
// mismatch: nothing contradicts the number, so it is used as 2.13.0 used it, and the warning — which names the option
// the number landed on — is the trace.
//
// Labels are compared without regard to case HERE and nowhere else (a label still resolves by its exact text): an
// environment whose labels differ from the spec's only in case must not hide that its numbering differs, and refusing
// more is the safe direction, since the option's integer value always works.
//
// Where nothing contradicts the spec's number and nothing confirms it either — a renamed option names nothing the spec
// can compare — the number is the one earlier builds used, and the caller warns that it is an assumption.
//
// Returns { value, option } — `option` is what the environment calls the number — when it stands; { refusal } — the
// sentence a problem carries to say why the spec's number was not used — when the spec numbers the label and the
// environment says no; or null when the spec has no number to offer (a column it does not number, a label it does not
// have: a typo). The label is then the problem `problemAgainst` found.
function specNumberStands(spec, entity, declared, use, options) {
  if (!declared || !declared.column) return null;
  const map = choiceValueMap(entity, spec)[use.attr];
  const value = map && map[use.label];
  if (value === undefined) return null;
  const refuse = (because) => ({ refusal: `The spec numbers "${use.label}" ${value}, but ${because}, so that number is not used.` });
  const option = options.find((o) => o.value === value);
  if (!option) return refuse(`the environment has no option numbered ${value}`);

  // The spec's numbers by label, folded: a label that folds onto two numbers ("Open" and "open") keeps both.
  const numbersOf = new Map();
  for (const [label, number] of Object.entries(map)) {
    if (!numbersOf.has(lc(label))) numbersOf.set(lc(label), new Set());
    numbersOf.get(lc(label)).add(number);
  }
  const specNumbers = new Set(Object.values(map));
  const listed = (numbers) => (numbers.length > 1 ? `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}` : String(numbers[0]));

  // The option on the number goes by another option's name. Every language it has is read: the second-language label of
  // another option gives it away even where every label of the spec is on its own number.
  for (const label of option.labels) {
    const elsewhere = [...(numbersOf.get(lc(label)) || [])].find((n) => n !== value);
    if (elsewhere !== undefined) return refuse(`the environment shows another numbering (the option numbered ${value} there is labelled "${label}", which the spec numbers ${elsewhere})`);
  }
  // A label of the spec that sits only on numbers that are not its own. It counts when it is the filter's own option's
  // (its number IS the one in question) or when it sits on a number the spec gives another option; a number the spec does
  // not use at all is an option added or re-made, which moves nothing (see above).
  for (const label of Object.keys(map)) {
    const own = numbersOf.get(lc(label));
    const carriers = options.filter((o) => o.labels.some((l) => lc(l) === lc(label)));
    if (!carriers.length || carriers.some((o) => own.has(o.value))) continue;
    if (!own.has(value) && !carriers.some((o) => specNumbers.has(o.value))) continue;
    // The environment's own spelling, where it is not the spec's: the label was found through case folding, and the author is
    // told what to look for there.
    const spelled = [...new Set(carriers.flatMap((o) => o.labels.filter((l) => lc(l) === lc(label))))];
    const as = spelled.some((l) => l !== label) ? ` (as ${spelled.map((l) => `"${l}"`).join(' and ')})` : '';
    return refuse(`the environment shows another numbering ("${label}"${as} is numbered ${listed([...new Set(carriers.map((o) => o.value))])} there, ${map[label]} in the spec)`);
  }
  return { value, option };
}

// What the build tells the author when the spec's number stands in for a label the environment does not carry. A
// shared label is one the environment DOES carry on that number; for a missing one the identity of the option is the
// build's assumption, and the message says so and says how to take the choice out of the build's hands.
function describeSpecNumber(use, stands, problem) {
  const where = `'${use.entity}'.'${use.attr}'`;
  if (problem.reason === 'ambiguous') {
    return `the environment lists more than one option labelled "${use.label}" on ${where}; the spec numbers "${use.label}" ${stands.value}, which is one of them, so the filter uses ${stands.value}.`;
  }
  return `the environment lists no option labelled "${use.label}" on ${where}. The spec numbers "${use.label}" ${stands.value} and the environment has an option with that number, labelled "${stands.option.shown}", so the filter uses ${stands.value} on the assumption that it is the same option under another label; if it is not, use the integer value of the option you mean.`;
}

// One label against the options the environment holds for the column (or for the set it is bound to): the label names
// exactly one of them, or — where it names none — the spec's own number stands in for it, or it is a problem. Returns
//   { value }          the environment names it;
//   { value, note }    the spec's number stands in: `note` is what the build says about the assumption;
//   { problem }        the label is a problem — and where the spec had a number for it that the environment refuses, the
//                      problem carries the `refusal` that says why that number was not used.
function judgeLabel(spec, entity, declared, use, options) {
  const problem = problemAgainst(use, options);
  if (!problem) return { value: matchOptions(options, use.label).value };
  const stands = specNumberStands(spec, entity, declared, use, options);
  if (stands && stands.option) return { value: stands.value, note: describeSpecNumber(use, stands, problem) };
  return { problem: stands ? { ...problem, refusal: stands.refusal } : problem };
}

// Resolve every label the views name. `read` is async (entityLogical) => the shape readChoiceAttributes
// returns, or null to resolve from the spec alone. `readGlobalChoice` is async (set name) =>
// readGlobalChoiceOptions' shape, or absent: with it, a column bound to a declared global choice whose own options
// could not be read is resolved from the SET.
//
// Returns { value(entity, attr, label) -> number | undefined, problems, warnings, inconclusive }. `value` answers
// only for a label this call resolved; for anything else `viewDef` keeps its spec-only rule. `inconclusive` lists,
// as problem-shaped records (reason `unreadable`, with the read's `why`), every label whose answer a FAILED or
// PARTIAL read left open — each with the value the build falls back to (`assumed`): the spec's own numbering for
// a column the spec declares, the label as written for one it does not. The build does not halt on these (it must
// write something, and warns); a caller that PROVES things against the environment — verify — must not take the
// assumption for a fact.
//
// This is the FINAL answer, asked in the views phase once the data model exists, so what the build created is
// there to read. `prior` is what the pre-flight already resolved (see checkViewFilterLabelsBeforeBuild): final,
// so it is taken as it is and its tables are not read again.
// Where each answer comes from, in order — the environment first, because it is what the platform holds:
//   1. the environment's option set for the attribute, when it has one;
//   1b. for a column whose options the spec numbers (inline, or a declared global choice) where the environment
//      does not carry the label by name: the spec's own number, when the environment has an option on it and
//      shows no other numbering (specNumberStands), with a warning — otherwise the label is a problem;
//   2. for a column bound to a declared global choice whose own options could not be read: the global choice
//      itself, which the column is bound to — a set the build reuses unchanged — judged exactly as 1 and 1b are;
//   3. the spec's own options (inline, or a declared global choice) for a column the spec declares as a
//      Choice, when the environment cannot say — the table is not there yet, or the read failed. This is a
//      FALLBACK, right only for an option set this build created (100000000 + index), so it is never used
//      silently: a warning names the label, the column and the number it was given;
//   4. otherwise the value is not a label: an attribute the spec does not declare and the environment says
//      is not a choice keeps the string as written.
async function resolveViewFilterLabels(spec, views, { read, prior, readGlobalChoice } = {}) {
  const values = new Map();
  const problems = [];
  const inconclusive = [];
  const warnings = [];
  const warned = new Set();
  const warnOnce = (message) => { if (!warned.has(message)) { warned.add(message); warnings.push(message); } };

  for (const view of views || []) {
    const decided = new Set(); // one problem per label per view, however often the view repeats it
    for (const use of labelUses(spec, view)) {
      const key = keyOf(use.entity, use.attr, use.label);
      if (values.has(key) || decided.has(key)) continue;
      decided.add(key);
      if (prior && prior.has(key)) { values.set(key, prior.get(key)); continue; }

      const entity = entityOf(spec, use.entity);
      const declared = declaredAttribute(spec, entity, use.attr);
      const specMap = declared ? choiceValueMap(entity, spec)[use.attr] : undefined;

      const live = read ? await read(use.entity) : null;
      const liveAttribute = live && live.state === 'ok' ? live.attributes.get(use.attr) : undefined;
      const conclusive = !!live && (live.state === 'absent' || (live.state === 'ok' && live.complete));
      // A read that failed or came back partial: what the environment holds is UNKNOWN, not absent.
      const unread = !!live && !conclusive;

      if (liveAttribute && liveAttribute.options.length) {
        const judged = judgeLabel(spec, entity, declared, use, liveAttribute.options);
        if (judged.problem) problems.push(judged.problem);
        else { values.set(key, judged.value); if (judged.note) warnOnce(judged.note); }
        continue;
      }

      if (declared) {
        // A column bound to a declared global choice, whose own options the environment did not give: the SET
        // holds them (the build reuses an existing one unchanged), so it is read itself instead of guessing at
        // its numbering from the spec.
        const column = declared.column;
        const globalBound = !!column && !!column.globalChoice && !(Array.isArray(column.options) && column.options.length > 0);
        if (globalBound && readGlobalChoice) {
          const set = await readGlobalChoice(column.globalChoice);
          if (set && set.state === 'ok') {
            const judged = judgeLabel(spec, entity, declared, use, set.options);
            if (judged.problem) problems.push(judged.problem);
            else { values.set(key, judged.value); if (judged.note) warnOnce(judged.note); }
            continue;
          }
        }
        // A declared Choice column the environment cannot describe: the spec's own options, which are the
        // values the build writes when it creates the column.
        if (specMap && specMap[use.label] !== undefined) {
          const assumed = specMap[use.label];
          values.set(key, assumed);
          if (live) {
            const why = live.state === 'error' ? `could not be read (${live.why})`
              : unread ? `could not be read completely (${live.why})`
                : live.state === 'absent' ? 'is not there' : `lists no options for '${use.attr}'`;
            warnOnce(`the option metadata of '${use.entity}' ${why}, so the filter value "${use.label}" on '${use.attr}' uses the spec's own numbering (${assumed}), which is right only for an option set this build created.`);
          }
          if (unread) inconclusive.push(problemOf(use, 'unreadable', { why: live.why, assumed }));
          continue;
        }
        problems.push(problemOf(use, conclusive ? 'unknown' : 'unreadable', { valid: declaredLabels(spec, declared.column), ...(live && live.why ? { why: live.why } : {}) }));
        continue;
      }

      // Not declared in the spec. Only the environment can say whether this is a choice.
      if (live && live.state === 'error') warnOnce(`could not read the option metadata of '${use.entity}' (${live.why}), so the filter value "${use.label}" on '${use.attr}' is used as written; if '${use.attr}' is a Choice column its label was not resolved.`);
      else if (live && live.state === 'ok' && !live.complete) warnOnce(`the option metadata of '${use.entity}' could not be read completely (${live.why}), so the filter value "${use.label}" on '${use.attr}' is used as written; if '${use.attr}' is a Choice column its label was not resolved.`);
      if (unread) inconclusive.push(problemOf(use, 'unreadable', { why: live.why, assumed: use.label }));
    }
  }
  return { value: (entity, attr, label) => values.get(keyOf(entity, attr, label)), problems, warnings, inconclusive };
}

// A label on a status reason THE BUILD inserts: statusReasons[] are added to the table's `statuscode` by the
// data-model phase, so until it has run the environment cannot list them.
const insertsStatusReason = (entity, attr, label) => attr === 'statuscode' && !!entity
  && (Array.isArray(entity.statusReasons) ? entity.statusReasons : []).some((s) => s && labelAliases(s.label).includes(label));

// The same question asked BEFORE the build writes anything — by the build's pre-flight (sdk-build.js) and by the
// dry run — so a typo stops the build while nothing has been written, instead of after the data model has been.
// A half-built app is what the old failure left: the tables and columns written, and then Dataverse rejecting
// the view.
//
// Before the build runs, the environment cannot yet hold what the build is about to create, so each label is
// judged by whichever side is AUTHORITATIVE for it, and only a DEFINITE answer is a problem:
//   - the environment already has the column: its options are final — a build leaves an existing column's
//     options alone — so a label it does not list is a problem (except a status reason the build inserts, and
//     a label of a column whose options the spec numbers that the environment carries only under another label,
//     when the spec's own number still names an option there and nothing shows another numbering: the views phase
//     uses that number, with a warning — see specNumberStands);
//   - the spec declares a column the environment lacks: the build creates it, from the spec's own options, or
//     bound to the declared global choice — whose options are the ENVIRONMENT's when that set already exists
//     (createGlobalOptionSet reuses it unchanged, so the same rule as for a column it has applies to it) and the
//     spec's when it does not;
//   - anything else — the table is not there yet, a read failed or was partial — cannot be known now. It is NOT
//     a problem here (a false halt would stop a good build); the views phase asks again after the build has
//     run, and that answer is final.
//
// `read` is async (table) => readChoiceAttributes' shape; `readGlobalChoice` is async (set name) =>
// readGlobalChoiceOptions'. Returns { problems, resolved, notes }. `resolved` maps keyOf(table, column, label) to the
// value of every label whose answer is FINAL: one read straight off a column the environment ALREADY has (the
// build leaves such a column alone), or off the global choice a column the build is about to create will be bound
// to, when that set already exists (the build reuses it unchanged). The views phase takes these as they are and
// asks only about what the build creates. Everything else is the views phase's to compute. `notes` are the
// warnings the views phase will give for the labels the spec's own number stands in for — said by the views
// phase, not here, so a build says them once; a dry run has no views phase, and says them itself.
async function checkViewFilterLabelsBeforeBuild(spec, views, { read, readGlobalChoice } = {}) {
  const problems = [];
  const resolved = new Map();
  const notes = new Set();
  if (!read) return { problems, resolved, notes: [] }; // no environment to ask: nothing to check ahead of the build

  for (const view of views || []) {
    const decided = new Set();
    for (const use of labelUses(spec, view)) {
      const key = keyOf(use.entity, use.attr, use.label);
      if (decided.has(key)) continue;
      decided.add(key);

      const entity = entityOf(spec, use.entity);
      const declared = declaredAttribute(spec, entity, use.attr);
      const live = await read(use.entity);
      const liveAttribute = live && live.state === 'ok' ? live.attributes.get(use.attr) : undefined;
      const conclusive = !!live && (live.state === 'absent' || (live.state === 'ok' && live.complete));

      if (liveAttribute && liveAttribute.options.length) {
        const judged = judgeLabel(spec, entity, declared, use, liveAttribute.options);
        if (judged.problem) {
          // A status reason the build inserts is not a problem yet: the views phase finds it once it has.
          if (!(judged.problem.reason === 'unknown' && insertsStatusReason(entity, use.attr, use.label))) problems.push(judged.problem);
        } else if (judged.note) notes.add(judged.note); // the spec's own number is not handed on as final: its warning is the views phase's
        else resolved.set(key, judged.value);
        continue;
      }
      if (!conclusive || !declared) continue;

      // A declared column the environment does not have, so the build creates it.
      const column = declared.column;
      const inline = !!column && Array.isArray(column.options) && column.options.length > 0;
      if (column && column.globalChoice && !inline) {
        const set = readGlobalChoice ? await readGlobalChoice(column.globalChoice) : null;
        if (!set || set.state === 'error') continue; // cannot tell whether the set exists, so cannot tell whose options it gets
        if (set.state === 'ok') {
          const judged = judgeLabel(spec, entity, declared, use, set.options);
          if (judged.problem) problems.push(judged.problem);
          else if (judged.note) notes.add(judged.note);
          // The set exists, so createGlobalOptionSet reuses it unchanged and the column the build creates
          // holds ITS values. That is final, so it is handed on: were the views phase's own read to fail, it
          // would otherwise fall back to the spec's 100000000 + index, a number this set never had.
          else resolved.set(key, judged.value);
          continue;
        }
        // 'absent': the build creates the set from the spec, so the spec's options decide, below.
      }
      const specMap = choiceValueMap(entity, spec)[use.attr];
      if (specMap && specMap[use.label] === undefined) problems.push(problemOf(use, 'unknown', { valid: declaredLabels(spec, column) }));
    }
  }
  return { problems, resolved, notes: [...notes] };
}

// One line per problem: which view, which column, which label, what is valid — and, where the spec numbers the label
// and the environment refused that number, why it was not used (a label that names no option is a different thing to a
// reader who knows a renamed option keeps its number).
function describeProblem(p) {
  const where = `view "${p.view}" (${p.entity}): filter on ${p.attr}`;
  const refusal = p.refusal ? ` ${p.refusal}` : '';
  if (p.reason === 'ambiguous') {
    return `${where} — "${p.label}" names more than one option (${p.values.join(', ')}), so it cannot choose between them.${refusal} Use the integer value of the one you mean.`;
  }
  if (p.reason === 'unreadable') {
    return `${where} — could not read the options of ${p.entity}.${p.attr} (${p.why || 'the environment did not answer'}), so "${p.label}" cannot be turned into an option value. Use the option's integer value, or try again once ${p.entity} answers metadata reads.`;
  }
  const valid = p.valid && p.valid.length ? ` Valid labels: ${showLabels(p.valid)}.` : '';
  return `${where} — "${p.label}" is not an option of ${p.entity}.${p.attr}.${valid}${refusal} Use ${valid ? 'one of those labels, or ' : ''}the option's integer value.`;
}

const describeProblems = (problems) => problems.map((p) => `  - ${describeProblem(p)}`).join('\n');

// What offline lint can say about the labels one view filters on. It can only check what the spec declares,
// so it says nothing for a label the spec's own options prove, and says so — "checked against the environment
// at build time" — for the two it cannot prove:
//   - a label not among the options the spec declares: the environment may hold more (a maker adds options,
//     or a declared global choice already existed with others);
//   - a column the spec does not declare: only the environment can say whether it is a Choice at all.
// (A column bound to a global choice the spec does not declare is already a lint ERROR — reported once, by the
// column check — so it gets no second word here.)
// The build halts on a label the environment cannot resolve — before it writes anything where the environment
// already shows it, otherwise before any view is written — which is what each message tells the author.
function labelLintWarnings(spec, view) {
  const entity = entityOf(spec, lc(view && view.entity));
  if (!entity) return []; // an unknown table is validation's finding, not another warning here
  const out = [];
  const seen = new Set();
  for (const use of labelUses(spec, view)) {
    const key = `${use.attr}|${use.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const declared = declaredAttribute(spec, entity, use.attr);
    const head = `View '${view.name}' filters ${use.entity}.${use.attr} on the label "${use.label}"`;
    if (declared) {
      const map = choiceValueMap(entity, spec)[use.attr];
      if (map && map[use.label] === undefined) {
        out.push(`${head}, which is not among the options this spec declares for it (${showLabels(declaredLabels(spec, declared.column))}). Offline lint cannot see options added in the environment, so the label is checked against the environment at build time, and the build halts, before any view is written, if there is no such option.`);
      }
      continue; // a label the spec's own options prove needs no word, and an undeclared global choice is the column check's
    }
    out.push(`${head}, but this spec does not declare ${use.attr}. If it is a Choice column the label is checked against the environment at build time, and the build halts, before any view is written, when it names no option; otherwise the value is used as written.`);
  }
  return out;
}

module.exports = {
  labelUses,
  hasLabelUses,
  labelLintWarnings,
  readChoiceAttributes,
  readGlobalChoiceOptions,
  makeChoiceReader,
  makeGlobalChoiceReader,
  memoizeChoiceReader,
  resolveViewFilterLabels,
  checkViewFilterLabelsBeforeBuild,
  describeProblem,
  describeProblems,
  OPTION_OPS,
};
