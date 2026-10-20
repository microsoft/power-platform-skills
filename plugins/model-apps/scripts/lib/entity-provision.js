'use strict';
// Shared entity-provisioning core: solution + data-model + sample-data phase logic
// extracted from sdk-build.js for reuse by /genpage and /app-builder.
//
// makeRunner() owns the emit/counter/BuildHalt machinery so both consumers produce
// identical { phase, status, label, n, total } event streams.

const {
  sampleRecordsFor,
  resolveSampleRecords,
  relationshipFor,
  resolveParentRelationship,
  relationshipSchemaName,
  manyToManySchemaName,
  quickCreateEnabledFor,
  normalizeLanguageCode,
  labelText,
  isLocalizedLabelMap,
  localizedLabelLcids,
  sampleKeyIdentity,
  lookupLabelFor,
  lookupParentNeedsEnvironment,
  isOldLookupColumnLabel,
  askedPrimaryNameLength,
  keyNeedsNameLength,
  keyWaitsForNameLength,
  keyHasRoomOnlyAfterLength,
  keyCannotFitAt,
  keyBytesAtLeast,
  KEY_BYTES_LIMIT,
  maxLengthSent,
  PRIMARY_NAME_MAX_LENGTH,
} = require('./app-spec.js');
const { readColumnLabels, makeTableLabelReader, lookupKey } = require('./lookup-labels.js');
const { topoOrderEntities, entityByLogical } = require('./_graph.js');
// OData string-literal escaping for spec-controlled values interpolated into $filter (a solution
// uniquename / publisher prefix with a `'` would otherwise break the query or inject a clause).
const { odataLit } = require('./odata.js');
// The one PublishXml that publishes tables by name (also the pre-app publish of sdk-build.js).
const { publishTablesXml } = require('./table-publish.js');
const { unreadableAnswer } = require('./collection-answers.js');
const { readRelationshipsOf, findRelationshipHolder, compareRelationship, describeRelationship, describeIncomplete, intersectRemedy, pickProjectionRow, projectionHolder } = require('./relationship-metadata.js');
// Transport-level language reads. Needed here because `MakerSdkOptions.languageCode` is a
// construction-time option, so the LCID must be known before the SDK that would normally read it.
const { readOrgLanguageCode, readProvisionedLanguages } = require('./dataverse-auth.js');
// The build's retry policy (see the header of retry-policy.js): every halt below says what a run again may do, decided where it is raised, and every failure this engine raises itself is made by
// refusal() (deterministic) or serviceFailure() (the plugin's words around a failure of the service) — never a bare `new Error`, whose message the build's retry would read.
const { RETRY, retryPolicyFor, refusal, serviceFailure } = require('./retry-policy.js');
// What the run's throttle budget says when it refuses a wait (the words of the build's own halt for it), for the step guard in makeRunner.
const { waitDoesNotFit } = require('./throttle-budget.js');

// App Spec column type -> SDK ColumnType. Lookup is omitted (side effect of a OneToMany
// relationship); Customer is handled specially (createCustomerColumn).
const SDK_COLUMN_TYPE = {
  Text: 'string', Memo: 'memo', Choice: 'choice', MultiChoice: 'multiChoice',
  Boolean: 'boolean', Money: 'money', DateTime: 'dateTime',
  Integer: 'integer', BigInt: 'bigint', Decimal: 'decimal', Double: 'double',
  File: 'file', Image: 'image', AutoNumber: 'autonumber',
};
// The level a spec's `required` asks for: true, "recommended" or false (None). Those are the only values the spec gate lets through
// (requiredValueProblem, lib/app-spec.js) — it refuses the rest instead of having them read as None here.
const REQUIRED = (c) => (c.required === true ? 'ApplicationRequired' : c.required === 'recommended' ? 'Recommended' : 'None');
const DEFAULT_LANGUAGE_CODE = 1033;

// Halt on an EXPLICIT language choice the organization cannot serve, naming what it does have.
//
// Live-verified: Dataverse handles an unprovisioned label LCID INCONSISTENTLY, which is why doing
// nothing is not an option and why a warning is not enough. Against a 1033-only org, writing labels
// at LanguageCode 1036:
//   * EntityDefinitions create      -> HTTP 204, label silently stored at 1033
//   * GlobalOptionSetDefinitions    -> HTTP 204, label silently stored at 1033
//   * DateTime / Memo column create -> HTTP 400 "The language code 1036 is not a valid language
//                                      for this organization"
// So the build does not fail cleanly and it does not succeed either: the table is created with
// silently wrong labels, then it dies on the first DateTime or Memo column. That leaves a
// half-provisioned data model, and the error surfaces phases away from the flag that caused it —
// it reads like an environment fault.
//
// Warning instead of halting would not help: by the time a warning is read the table already exists
// and has to be torn down. Halting costs the user one flag before any LABEL is written. Note this is
// deliberately not "before any write at all" — `provisionSolution` runs first in `runSdkBuild` and
// may create the publisher and solution — but those carry no language, so nothing lands mislabelled.
//
// Only an explicit override is checked; the org's own base language is provisioned by definition, so
// probing it would cost a round trip to learn nothing.
//
// `provisionedLanguages` is injected rather than called directly so this module stays free of transport.
// Best-effort: an unavailable probe must NOT block a build, because it is a diagnostic — if it cannot
// answer, the build proceeds exactly as it did before.
async function checkProvisioned(lcid, source, provisionedLanguages) {
  if (typeof provisionedLanguages !== 'function') return lcid;
  let list;
  try {
    list = await provisionedLanguages();
  } catch {
    return lcid; // the probe is a nicety; never let it fail a build
  }
  if (!Array.isArray(list) || !list.length) return lcid;
  if (list.includes(lcid)) return lcid;
  throw new BuildHalt(
    `${source} ${lcid} is not provisioned in this organization, so the data model cannot be built in `
    + 'that language. Dataverse fails inconsistently here: table and choice labels are accepted and '
    + "silently stored under the organization's base language, while DateTime and Memo columns are "
    + `rejected outright — so the build would create the table, label it wrong, then stop partway `
    + `through the columns. Provisioned languages: ${list.join(', ')}. Pick one of those, provision `
    + `${lcid} in the organization first, or omit the override to use the base language.`,
    { phase: 'data-model', code: 'language-not-provisioned', recoverable: false, retry: RETRY.NEVER }
  );
}

// Every LCID the spec's LOCALIZED labels ask for, deduped and sorted, with an example of where each
// was declared so the halt below can name one. AB#6686428.
function localizedLabelLcidsInSpec(spec) {
  const byLcid = new Map(); // lcid -> a human-readable "where" for the first site that used it
  const note = (value, where) => {
    for (const lcid of localizedLabelLcids(value)) if (!byLcid.has(lcid)) byLcid.set(lcid, where);
  };
  for (const e of (spec && spec.entities) || []) {
    const at = `entity ${e && e.schemaName}`;
    note(e && e.displayName, `${at} displayName`);
    note(e && e.pluralName, `${at} pluralName`);
    note(e && e.primaryAttribute && e.primaryAttribute.displayName, `${at} primaryAttribute.displayName`);
    for (const c of (e && e.columns) || []) {
      note(c && c.displayName, `${at} column ${c && c.schemaName} displayName`);
      for (const o of (c && c.options) || []) note(o, `${at} column ${c && c.schemaName} option`);
    }
    for (const k of (e && e.alternateKeys) || []) note(k && k.displayName, `${at} alternate key ${k && k.schemaName}`);
  }
  for (const r of (spec && spec.relationships) || []) note(r && r.lookup && r.lookup.displayName, `relationship lookup ${r && r.lookup && r.lookup.schemaName}`);
  for (const g of (spec && spec.globalChoices) || []) {
    note(g && g.displayName, `globalChoice ${g && g.name} displayName`);
    for (const o of (g && g.options) || []) note(o, `globalChoice ${g && g.name} option`);
  }
  return [...byLcid.entries()].sort(([a], [b]) => a - b).map(([lcid, where]) => ({ lcid, where }));
}

// Halt when a LOCALIZED label names a language the organization has not provisioned. AB#6686428.
//
// This is NOT a validation nicety — it is the difference between the feature working and the feature
// re-creating the exact bug it fixes. LIVE-MEASURED against a 1033-only organization: `createTable`
// with `DisplayName: { 1033, 3082 }` returns SUCCESS and stores ONLY the 1033 label. Dataverse does
// not warn, error, or report the drop anywhere. So without this check an author labels a table in
// Spanish, gets a green build, and the Spanish is simply gone — "a successful build with the request
// gone and nothing reporting the loss", which is the failure this whole feature exists to end.
//
// Distinct from `checkProvisioned` above, which guards the single build-wide authoring language: that
// one can also fail LOUDLY later (a DateTime/Memo column is rejected outright), whereas a dropped
// localized label has no downstream symptom at all.
//
// Best-effort in exactly the same way: an unreadable probe leaves the build unchanged, because a
// diagnostic that cannot answer must not block work that would otherwise succeed.
async function checkLocalizedLabelLanguages(spec, provisionedLanguages) {
  const wanted = localizedLabelLcidsInSpec(spec);
  if (!wanted.length || typeof provisionedLanguages !== 'function') return;
  let list;
  try {
    list = await provisionedLanguages();
  } catch {
    return;
  }
  if (!Array.isArray(list) || !list.length) return;
  const missing = wanted.filter((w) => !list.includes(w.lcid));
  if (!missing.length) return;
  throw new BuildHalt(
    `${missing.length} localized label language(s) are not provisioned in this organization: `
    + `${missing.map((m) => `${m.lcid} (first used by ${m.where})`).join('; ')}. `
    + 'Dataverse would ACCEPT those labels and silently store only the provisioned one — live-measured: '
    + 'a create carrying an unprovisioned LCID returns success and the label is simply absent afterwards, '
    + 'with nothing reporting the loss. Provisioned languages: '
    + `${list.join(', ')}. Provision the language in the organization first, or drop it from the labels.`,
    { phase: 'data-model', code: 'localized-label-language-not-provisioned', recoverable: false, retry: RETRY.NEVER }
  );
}

// Dataverse label payloads must use an LCID the org actually has provisioned. Resolve an explicit
// CLI override first, then an App Spec override, then the org's base `organization.languagecode`,
// and only fall back to 1033 if discovery itself fails so an unrelated read error does not block
// the whole build.
//
// `undetermined(reason)` replaces that fallback for a caller that has to KNOW the language instead of
// choosing one — `--verify`, which holds an existing deployment to the language its labels were
// written in. For it a 1033 picked because the organization could not be read is an assumption about
// what was built, not evidence of it: it would pass a stale caption as readily as it fails a correct
// one. The hook is told why, and whatever it answers is what comes back; only a failure to determine
// reaches it, never a language the caller was given or the organization reported.
async function resolveLanguageCode({ provision, spec, languageCode, warn, provisionedLanguages, undetermined }) {
  // A supplied-but-invalid value is DISCARDED, not honoured — but it must not be discarded in
  // silence. "You gave me nothing" and "you gave me something I could not use" are different facts,
  // and only the second means the caller believes they pinned a language and is wrong. The CLI flags
  // hard-error before reaching here; this covers the programmatic seam and any caller that skips the
  // validation gate. Nobody's build breaks by being told their explicit input was rejected.
  const rejected = (label, value) => {
    if (typeof warn === 'function') {
      warn(`ignoring ${label} '${value}' — not a valid LCID (expected a positive integer up to 65535); `
        + 'falling back to the next source.');
    }
  };

  const explicit = normalizeLanguageCode(languageCode);
  if (explicit) return await checkProvisioned(explicit, '--language-code', provisionedLanguages);
  if (languageCode !== undefined && languageCode !== null) rejected('--language-code', languageCode);

  const specLanguage = normalizeLanguageCode(spec?.languageCode);
  if (specLanguage) return await checkProvisioned(specLanguage, 'languageCode', provisionedLanguages);
  if (spec && spec.languageCode !== undefined && spec.languageCode !== null) rejected('languageCode', spec.languageCode);

  // EVERY fallback to the default is announced, not just the read-threw case. 1033 is precisely the
  // value that breaks a non-English organization (#447), so a build that silently lands here fails
  // later in the data-model phase with an opaque "The language code 1033 is not a valid language for
  // this organization" and nothing connecting it back to language resolution — which is exactly the
  // confusing failure this change exists to remove.
  const fallback = (reason) => {
    if (typeof undetermined === 'function') return undetermined(reason);
    if (typeof warn === 'function') {
      warn(`could not determine the organization's base language (${reason}); using ${DEFAULT_LANGUAGE_CODE}. `
        + `If this organization does not have ${DEFAULT_LANGUAGE_CODE} provisioned, pass `
        + '--language-code (or --languageCode) <lcid>, or set "languageCode" in the App Spec.');
    }
    return DEFAULT_LANGUAGE_CODE;
  };

  if (!provision || typeof provision.queryRecords !== 'function') {
    return fallback('no Dataverse reader was supplied');
  }

  try {
    const rows = await provision.queryRecords('organization', { select: ['languagecode'], top: 1 });
    const orgLanguage = normalizeLanguageCode(rows && rows[0] && rows[0].languagecode);
    if (orgLanguage) return orgLanguage;
    return fallback('organization.languagecode was missing or not a valid LCID');
  } catch (err) {
    return fallback(`the organization read failed: ${(err && err.message) || err}`);
  }
}

// Map an App Spec column to SDK CreateColumnOptions. `globalChoiceIds` maps a global-choice
// name -> its metadataId (so a column can bind to a shared option set).
function columnOptions(c, globalChoiceIds, globalChoices, languageCode) {
  const o = { schemaName: c.schemaName, displayName: c.displayName || c.schemaName, type: SDK_COLUMN_TYPE[c.type || 'Text'], required: REQUIRED(c), languageCode };
  // Description is the maker-facing "what is this column for". Written at CREATE time rather than
  // backfilled: `createColumn` accepts it, and a later PATCH is a second round trip that is easy to
  // skip and easy to forget — so the only reliable moment is the one where the column is authored.
  // Omitted when absent, so an existing column's description is never blanked by a rebuild.
  if (c.description) o.description = String(c.description);
  // Which columns carry a `maxLength`, and what, is the ONE rule maxLengthSent (lib/app-spec.js) states: the build counts a key over a column at the
  // length this creates the column with (keyBytesAtLeast), so the two must not disagree.
  const maxLength = maxLengthSent(c);
  switch (c.type) {
    case 'Text': if (maxLength !== undefined) o.maxLength = maxLength; if (c.format) o.stringFormat = c.format; break;
    case 'Memo': if (maxLength !== undefined) o.maxLength = maxLength; break;
    case 'Integer': case 'BigInt': case 'Decimal': case 'Double': case 'Money':
      if (c.minValue !== undefined) o.minValue = c.minValue;
      if (c.maxValue !== undefined) o.maxValue = c.maxValue;
      if (c.precision !== undefined) o.precision = c.precision;
      // AB#6648522: Whole Number display Format (e.g. a raw integer count of minutes rendered as a
      // Duration picker). Gated on the EXACT 'Integer' type, not the whole shared case: BigInt/
      // Decimal/Double/Money share this case only for min/max/precision, but the SDK's `integerFormat`
      // option is Integer-only and throws InvalidArgumentError for any of the others (app-spec.js's
      // spec-gate validation rejects that combination earlier, so this should never fire in practice —
      // but the gate is Integer-only for the same reason, so keep both narrow together).
      if (c.type === 'Integer' && c.integerFormat !== undefined) o.integerFormat = c.integerFormat;
      break;
    case 'DateTime': if (c.dateFormat) o.dateFormat = c.dateFormat; break;
    case 'Boolean':
      if (c.trueLabel) o.trueLabel = c.trueLabel;
      if (c.falseLabel) o.falseLabel = c.falseLabel;
      // AB#6648523: an explicit `false` must reach the SDK exactly like an explicit `true` does.
      // `!== undefined`, NOT a truthy check — `if (c.defaultValue)` would silently drop the one value
      // (`false`) a maker-authored spec is most likely to set on purpose. Measured against the
      // vendored bundle: omitting the option sends no `DefaultValue` key different from an explicit
      // `false` (both resolve to the SDK's own `?? false`), so passing it through has no wire-visible
      // effect on create today — but the SAME `!== undefined` guard is reused for the update reconcile
      // below, where a bare truthy check would be an outright bug (see the reconcile block).
      if (c.defaultValue !== undefined) o.defaultValue = c.defaultValue;
      break;
    case 'Choice': case 'MultiChoice':
      if (c.globalChoice && globalChoiceIds[c.globalChoice]) { o.globalChoiceMetadataId = globalChoiceIds[c.globalChoice]; }
      // Defensive fallback: the global choice exists but its metadataId wasn't captured. With the now
      // IDEMPOTENT createGlobalOptionSet (probe-then-reuse returns the existing id), the primary branch
      // above normally fires on both a fresh build AND a re-run — a real create failure halts the phase
      // before we get here. This branch is a belt-and-suspenders guard (e.g. a success that somehow
      // returned no id): a globalChoice column carries no inline options of its own, so fall back to the
      // global choice's DECLARED options (same values the engine assigns) so the column still builds.
      else if (c.globalChoice) { const gc = (globalChoices || []).find((g) => g.name === c.globalChoice); o.options = choiceOptions(gc ? { options: gc.options } : c); }
      else o.options = choiceOptions(c); break;
    case 'File': case 'Image': if (c.maxSizeKb) o.maxSizeKb = c.maxSizeKb; if (c.type === 'Image' && c.isPrimaryImage) o.isPrimaryImage = true; break;
    case 'AutoNumber': if (c.autoNumberFormat) o.autoNumberFormat = c.autoNumberFormat; break;
  }
  if (c.source === 'Calculated' || c.source === 'Rollup') { o.sourceType = c.source; if (c.formula) o.formulaDefinition = c.formula; }
  // AB#6651276: per-verb write/read permissions. Lives after the per-type switch, not inside it,
  // because the SDK accepts these on every buildable column type — this function is simply never
  // called for a Customer column (its caller routes those through createCustomerColumn instead,
  // whose options have no such fields; see the call site in provisionDataModel).
  //
  // `!== undefined`, NOT a truthy check, for each flag: measured against the vendored bundle, the
  // wire key is only sent when the option is explicitly set (unlike DefaultValue/Format above, which
  // the SDK always sends with its own default). `isValidForUpdate: false` — making a column read-only
  // after creation — is the ENTIRE POINT of this feature, so a naive `if (c.isValidForUpdate)` guard
  // would silently make every "lock this down" spec a no-op.
  if (c.isValidForCreate !== undefined) o.isValidForCreate = c.isValidForCreate;
  if (c.isValidForUpdate !== undefined) o.isValidForUpdate = c.isValidForUpdate;
  if (c.isValidForRead !== undefined) o.isValidForRead = c.isValidForRead;
  return o;
}

function choiceOptions(col) {
  return (col.options || []).map((label, i) => ({ value: 100000000 + i, label }));
}

// What the table's create asks for as its primary name column's length when the spec gives none: 100 — what the previous release
// always sent, for a plain and an auto-numbered name column alike. It is the SDK's own default for the option, sent explicitly here
// so that a later change of that default cannot change what a spec without `primaryAttribute.maxLength` gets.
//
// What the platform makes of the length it is asked for depends on the environment. Measured on two, as the `MaxLength` of the
// primary `StringAttributeMetadata` in the request that creates the table:
//   a create with only the primary name attribute, plain text   one environment keeps the length asked (100 came back as 100);
//                                                               another IGNORES it — 100 and 120 both came back as 850
//                                                               characters (DatabaseLength 1700)
//   the same, with an auto-numbered primary                     the length asked is kept — 100 came back as 100 (200)
//   a create that also carries other columns                    the length asked is kept, even on the environment that ignores it
//                                                               for a create with only the primary attribute — 120 came back as 120
//   more than 850 (in a create that carried other columns)      refused, HTTP 400: "The maximum length of Primary attribute
//                                                               'new_name' is 4000. The maximum allowed limit is 850."
//   a PUT of the finished column (the SDK's updateColumn)       honored — 850 -> 120 -> 850, each answered 204; the
//                                                               DatabaseLength stays 1700
// So the table is created exactly as the previous release created it — one request that carries ONLY the primary name attribute,
// asking for 100 — which gives the previous release's result on every environment, whichever of the two behaviours it has; the
// table's ordinary columns follow in a request of their own (createColumnsInOneRequest). A length the spec asks for is asked in that
// same create; once the data-model phase has made its last labelled create, it is confirmed with one typed read and set with
// updateColumn where the environment did not keep it (alignPrimaryNameLength, run last by provisionDataModel).
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api#create-table-definitions
const DEFAULT_PRIMARY_NAME_LENGTH = 100;

// What the table's create asks for as the primary name column's length: the spec's `primaryAttribute.maxLength`, else the default
// above. Applied when the table is CREATED (an existing table's column is never rewritten).
function primaryNameLength(primaryAttribute) {
  const asked = askedPrimaryNameLength({ primaryAttribute });
  return asked !== undefined ? asked : DEFAULT_PRIMARY_NAME_LENGTH;
}

// A MetadataId as Dataverse writes one, in lower case — or undefined for anything else. The ids a debt is held to are compared in this form.
const GUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const guidOf = (value) => (typeof value === 'string' && GUID_RE.test(value) ? value.toLowerCase() : undefined);

// How an answer that is not a success reads in a message: its status and, when the platform gave one, its own message.
function answerWhy(res) {
  if (!res) return 'no answer';
  const detail = res.body && res.body.error && res.body.error.message;
  return `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
}

// An answer that is not a success, as an error that carries what the SDK's own errors carry of it — made by serviceFailure (lib/retry-policy.js), the engine's maker of the plugin's
// words around a failure of the service: the status, and the OData `error` of the answer (`answered`, recorded only when the body has one as an object), e.g.
//   HTTP 500  { "error": { "code": "0x80044151", "message": "SQL timeout expired." } }   ->   could not read the column's length (HTTP 500: SQL timeout expired.)
// The build's retry reads them as it reads the same answer through the SDK's ConnectionError: a 429, 502, 503 or 504 is run again, and so is a condition the service names by
// that code on any status (a customization or solution lock, SQL giving up waiting, a concurrent request, a SQL deadlock victim); any other status is final, whatever the
// answer's words say. A step that waits for the request (an alternate key, see provisionDataModel) hands both on. Only a request that got no answer has neither, and then the
// words (`no answer`) are all there is to read.
function statusError(what, res) {
  const why = answerWhy(res);
  return serviceFailure(`${what} (${why})`, { status: res && res.status, words: why, answered: res && res.body && res.body.error });
}

// How a table or a column is named in a metadata path: by its MetadataId, the primary key, when the caller holds the id of the one it means,
// and otherwise by logical name, the alternate key. An id answers for the object it was made for and for no other: once the table is deleted
// it answers 404, whatever is made under its name afterwards.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/retrieve-metadata-name-metadataid
const metadataKey = (id, logical) => id || `LogicalName='${odataLit(logical)}'`;

// The MaxLength of one text column — and the column's MetadataId, which the same answer carries — from ONE typed request: MaxLength is a
// member of StringAttributeMetadata, so the attribute is addressed through that cast and nothing else is selected — no labels, the kind of
// narrow read the build keeps ahead of its labelled writes (findExistingColumns). Dataverse answers
//   { "@odata.context": "...", "MaxLength": 850, "MetadataId": "..." }
// The attribute of a table created a moment ago can trail the table (the lag confirmInlineColumns also waits out), so a 404 is
// asked again, twice; any other answer will not change by asking again. Throws, with the reason, when the length cannot be read.
//
// `bound` is `{ tableId, columnId? }`, the MetadataIds a debt an earlier attempt carried records, which the table was proved to have: the
// request is then addressed by them (the column by name only where its id was not recorded, inside the table the id names), because nothing
// may be resolved by name once the table is proved — a table made again under the name would answer to it (updateTextColumnLengthById). A 404 is
// then no lag, since the table is proved to have been there: it is the table or the column that is gone, and it is not asked again.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-metadata-web-api#retrieve-attributes
async function readTextColumn(provision, tableLogical, columnLogical, { sleep, bound = null } = {}) {
  const raw = provision && provision.dataverse;
  if (!raw || typeof raw.get !== 'function') throw refusal('there is no Dataverse client to read the column with');
  const wait = typeof sleep === 'function' ? sleep : ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const url = `/EntityDefinitions(${metadataKey(bound && bound.tableId, tableLogical)})/Attributes(${metadataKey(bound && bound.columnId, columnLogical)})/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=MaxLength`;
  let last;
  for (let attempt = 0; attempt < (bound ? 1 : 3); attempt += 1) {
    if (attempt > 0) await wait(1000);
    const res = await raw.get(url);
    if (res && res.status >= 200 && res.status < 300) {
      if (res.body && Number.isInteger(res.body.MaxLength)) return { maxLength: res.body.MaxLength, metadataId: guidOf(res.body.MetadataId) };
      throw refusal('the answer to the read of the column\'s length carries no MaxLength');
    }
    last = res;
    if (!res || res.status !== 404) break;
  }
  // The status travels with the error, as it does on the SDK's own: a step that waits for this read — an alternate key, see
  // provisionDataModel — stops the build the way this read failed, and the build retries a halt only when its status is a throttle or a timeout.
  throw statusError('could not read the column\'s length', last);
}

// Sets the MaxLength of a text column that is addressed by the MetadataIds of its table and of itself — what the SDK's updateColumn does, with
// one difference that is the point of it. updateColumn resolves the column BY NAME (a read of `Attributes(LogicalName='…')`, whose answer's id
// the two requests that follow use), so a build that proved the table by its MetadataId and then called it would write to whichever table
// answers to the name at that moment: another maker can delete the table and make it again in the few requests between the check and the
// write, and the build must never shorten a column of a table it did not create — it may hold data. Here nothing is resolved by name: the
// definition is read, and written back, at `EntityDefinitions(<table id>)/Attributes(<column id>)`, and a table made again has other ids, so
// the read and the update answer 404 and nothing is written.
//
// The rest is the documented update of a column, as updateColumn sends it. Metadata is replaced, not patched: the whole definition is `PUT`
// back with the one member changed. The typed read answers the definition the way the platform stores it, with the labels of every language
//   { "@odata.context": "https://contoso.crm.dynamics.com/api/data/v9.2/$metadata#...", "MetadataId": "...", "LogicalName": "new_name",
//     "MaxLength": 850, "DisplayName": { "LocalizedLabels": [ { "Label": "Name", "LanguageCode": 1033, ... } ] }, ... }
// of which `@odata.context` is dropped, as the SDK drops every `@odata.*` member, `@odata.type` is set, and `MSCRM.MergeLabels: true` keeps the
// labels already stored in the languages the body does not name. The request goes through the SDK's own client (`sdk.dataverse`), as
// updateColumn's does, so an SDK made with a solution adds the solution header to this write as it does to every one. Throws, with the status of
// the answer, when a request is not answered with a success; a 404 means the table or the column is gone, which the caller tells from the
// other failures.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api#update-table-definitions
async function updateTextColumnLengthById(sdk, { tableId, columnId, maxLength }) {
  const raw = sdk && sdk.dataverse;
  if (!raw || typeof raw.get !== 'function' || typeof raw.put !== 'function') throw refusal('there is no Dataverse client to update the column with');
  const path = `/EntityDefinitions(${tableId})/Attributes(${columnId})`;
  const type = 'Microsoft.Dynamics.CRM.StringAttributeMetadata';
  const read = await raw.get(`${path}/${type}`);
  if (!read || read.status < 200 || read.status >= 300) throw statusError('could not read the column\'s definition', read);
  const definition = { ...read.body };
  for (const member of Object.keys(definition)) if (member.startsWith('@odata.')) delete definition[member];
  definition['@odata.type'] = type;
  definition.MaxLength = maxLength;
  const wrote = await raw.put(path, definition, { headers: { 'MSCRM.MergeLabels': 'true' } });
  if (!wrote || wrote.status < 200 || wrote.status >= 300) throw statusError('the update of the column was refused', wrote);
}

// After every write of its own the SDK forgets what it cached of the table (`schemaWrite`, which each of its methods that changes the schema
// runs in), so that a later read does not serve a definition older than the write. A write made through its raw client is not one of those, so
// it is run inside the same call where the SDK has one — which is how the SDK's updateColumn, that updateTextColumnLengthById stands in for,
// leaves the cache. An SDK without it (a test double) has no cache to forget.
const inSchemaWrite = (sdk, logical, write) => (sdk && typeof sdk.schemaWrite === 'function' ? sdk.schemaWrite([logical], write) : write());

// Which table answers to a logical name right now: its MetadataId and its primary name column, from ONE narrow request by name. Dataverse answers
//   { "@odata.context": "...", "MetadataId": "00000000-0000-0000-0000-000000000000", "PrimaryNameAttribute": "new_name" }
// and 404 when no table has the name, which is the answer `null`. Any other answer is an error that carries its status, the way a read
// of the column's length does (readTextColumn). Not asked again on a 404, unlike that read: it is made only for a table an earlier attempt
// created, and a build retries after pausing for at least three seconds (build-model-app.js), which is longer than a table created
// a moment ago takes to show.
//
// This is the one request that names the table by its NAME — the question is which table answers to it — and it is a check, not a guard: the
// table can be replaced right after it answers. What the debt is paid with afterwards is addressed by the MetadataIds it records, which a
// replacement cannot answer to (updateTextColumnLengthById), so the check's job is to say why a table is left alone in the common case, where
// the replacement is already there.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-metadata-web-api#query-the-entitymetadata-entity-type
async function readTableIdentity(provision, tableLogical) {
  const raw = provision && provision.dataverse;
  if (!raw || typeof raw.get !== 'function') throw refusal('there is no Dataverse client to read the table with');
  const res = await raw.get(`/EntityDefinitions(LogicalName='${odataLit(tableLogical)}')?$select=MetadataId,PrimaryNameAttribute`);
  if (res && res.status >= 200 && res.status < 300) {
    const metadataId = guidOf(res.body && res.body.MetadataId);
    if (!metadataId) throw refusal('the answer to the read of the table carries no MetadataId');
    return { metadataId, primaryName: String((res.body && res.body.PrimaryNameAttribute) || '').toLowerCase() };
  }
  if (res && res.status === 404) return null;
  throw statusError('could not read the table', res);
}

// What the narrated step of a name column length says when an earlier attempt created the table and left the length unset (see
// alignPrimaryNameLength): the step runs for a table that exists, which the build otherwise leaves as it finds it.
const OWED_LENGTH = 'owed by the attempt that created the table';

// The warning for a length the build owed and does not set, because it must not write to the table that answers to the name now
// (checkOwedTable). `debt` is what was recorded: the column and the length asked, which is what the warning is about.
const keptWarning = (logical, debt, why) => `did not set the length of the primary name column ${logical}.${debt.column} to ${debt.asked} — ${why}, so the column is left as it is (change it in Maker if the length matters)`;

// Whether the table that answers to a debt's name now is the table the debt was recorded for. A debt is paid to that table and to no other.
// It records the names of the table and of its name column and the length asked, and the MetadataId of the table the attempt created (and
// of its name column, when that attempt read it), because the same logical name can come to answer for another table: the build pauses
// between two attempts, another maker can delete the table and make it again in that time, and the build never writes to the name column
// of a table it did not create — a rebuild must not shorten a column that may hold data. A table that is not the one is left as it is.
//
// The answer is `{}` when the table is proved to be the one; `{ left: { step, why } }` when it is proved not to be — or cannot be: nothing
// records which table the build created, or the spec no longer asks what the debt records — and the column is then left alone; and
// `{ unread }` when the read that would prove it failed: nothing is written, and it is a failed step, as an unreadable length is. The
// column's own id is checked by the caller, once it has read the column, which carries it.
//
// This is the one extra request a debt costs, made only for a debt an earlier attempt carried: the attempt that created the table has
// just made it, and a build that owes nothing asks nothing.
async function checkOwedTable({ provision, debt, logical, primaryLogical, asked }) {
  const left = (step, why) => ({ left: { step, why } });
  if (!debt || debt.column !== primaryLogical || debt.asked !== asked) {
    return left('no longer what the spec asks', `the spec no longer asks what the build owed (${debt && debt.column} at ${debt && debt.asked} characters; it now asks ${primaryLogical} at ${asked})`);
  }
  const owedId = guidOf(debt.tableId);
  if (!owedId) return left('nothing shows which table the build created', 'nothing shows which table this build created, and it never writes to a table it did not create');
  let seen;
  try { seen = await readTableIdentity(provision, logical); } catch (err) { return { unread: err }; }
  if (!seen) return left('the table the build created is gone', `the table ${logical} this build created is no longer there`);
  if (seen.metadataId !== owedId) {
    return left('not the table the build created', `the table ${logical} is not the one this build created (it was deleted and created again, or replaced, after the build created it), and the build never writes to a table it did not create`);
  }
  if (seen.primaryName !== primaryLogical) return left('not the name column the build created', `the primary name column of table ${logical} is ${seen.primaryName || 'not known'} now, not ${primaryLogical}`);
  return {};
}

// Sets the primary name column of a table THIS build created — in this attempt, or in an earlier attempt of the same build that did
// not finish the step (`carried`, see provisionDataModel) — to the length the spec asks for. The table is created with a
// request that carries nothing but that column, and some environments ignore the length asked of a plain text name column in
// such a request (see DEFAULT_PRIMARY_NAME_LENGTH), so the length is read back — one typed request — and only a column that is not
// already the asked length is updated, with the SDK's updateColumn (the documented PUT of the typed column). Exactly one narrated
// step, a skip when nothing needed changing (an environment that keeps the length asked). A read or an update that fails is a
// FAILED step that names the table, the length asked and the length the platform made, plus a warning, the way a failed column
// update is reported elsewhere in this file: the build goes on, and the column is never left at the wrong length without saying so.
// The answer is `{ ok: true }` when the column has the length now; `{ ok: false, error, columnId? }` when it could not be read or set —
// which an alternate key over the column needs to know (provisionDataModel creates it only after a step that succeeded) — with the id of
// the column when the read before the update answered it, for the debt to keep; and `{ ok: false, left: true }` when the table is not
// the one the debt was recorded for (checkOwedTable, or a request addressed by its ids that answered 404), which is left alone. A step the runner stopped before it began (`notStarted: true`, with the stop as `error`, and the column's
// id as above) is neither a length that was set nor an update that failed: nothing was sent, and the table is owed the length as it was.
//
// It is the LAST thing the data-model phase does (provisionDataModel calls it once every table, column, status reason, alternate
// key and relationship has been created), not the first thing after the table. The SDK's updateColumn starts by reading the column
// WITH its labels, and a label-bearing metadata read ahead of a labelled create is what makes Dataverse keep only the base-language
// label of what is created (measured live — see findExistingColumns, which is why the reads that precede a create in this file are
// narrow). That read is inside the SDK and cannot be narrowed, so it goes where nothing labelled is created after it — within one
// attempt. The build runs a phase that halts on a transient answer (a 429, a lock) again (build-model-app.js): the attempt that
// created the table sets its length by then, because this runs after a halt too. When that step fails as well — the lock that
// stopped the phase can still be held — the table is OWED its length: the halt carries a record of it (`owedLengths`, see
// runSdkBuild) the way it carries the publishes an attempt owes for the views it saved, and the retry, which finds the table, sets
// the length at the end of its own phase and says why. What the retry creates — a column or a relationship the halt kept the
// first attempt from — comes after the read of the attempt that set the length; the loss was measured only for a create straight
// after the read, so whether it reaches across the pause between two attempts is not known.
//
// `debt` is the record of what is owed for the table (see provisionDataModel). `carried` says an earlier attempt created the table: its
// step is worded so, because a reader would otherwise take the length of a table that exists for one the build had no business to touch,
// and the table is proved to be the one the debt was recorded for before anything is written. The proof is not a guard, because the table
// can be replaced between the request that makes it and the one that writes: so what follows it is addressed by the MetadataIds the debt
// records (`bound`) — the read of the length, the read of the definition and the update — and a table made again, whose ids are others,
// cannot be the target of any of them; an id no table has any more answers 404, which leaves the column alone like the proof does. The SDK's
// updateColumn is not used for that update because it resolves the column by name (updateTextColumnLengthById).
// `halted` says the phase stopped before this step: the warning for a length that could not be set then cannot promise that the build
// continues, and says what a re-run does instead (it finds the table and leaves an existing table's name column as it is).
// `keys` are the alternate keys that wait for this step: where there are any, the warning is worded from them — the build does not
// continue past a key it cannot create (createWaitingKeys) — and not from the best-effort case, where the rest of the build does.
async function alignPrimaryNameLength({ runner, sdk, provision, entity, logical, asked, warn, sleep, halted = false, debt = null, carried = false, keys = [] }) {
  const primaryLogical = String(entity.primaryAttribute.schemaName).toLowerCase();
  const label = `primary column length ${entity.schemaName}.${entity.primaryAttribute.schemaName}`;
  const owedNote = carried ? `; ${OWED_LENGTH}` : '';
  const warnKept = (why) => {
    if (typeof warn === 'function') warn(keptWarning(logical, { column: (debt && debt.column) || primaryLogical, asked: (debt && debt.asked) || asked }, why));
  };
  const leave = ({ step, why }) => {
    runner.skip('data-model', `${label} (${step} — kept)`);
    warnKept(why);
    return { ok: false, left: true };
  };
  // What a request addressed by the debt's ids says by answering 404: the table (and with it its name column) the build created is gone —
  // deleted, or deleted and made again, which has other ids — since the build proved it a moment ago. A table's primary name column is not
  // deleted on its own, so there is no telling the two apart, and none is needed: either way it is not the build's to write to.
  const gone = {
    step: 'the table the build created changed',
    why: `the table ${logical} this build created (or its name column) was deleted, or deleted and created again, while the build was setting its length, and the build never writes to a table it did not create`,
  };
  let unconfirmed;
  let bound = null;
  if (carried) {
    const checked = await checkOwedTable({ provision, debt, logical, primaryLogical, asked });
    if (checked.left) return leave(checked.left);
    unconfirmed = checked.unread;
    // The table is the one its recorded id names, or could not be told (`unconfirmed`, and nothing is read then): the id is what every
    // request that follows is addressed by. The column's, where the debt recorded it; where it did not, the read below finds the column by
    // name inside that table and answers its id, which the update is addressed by.
    bound = { tableId: guidOf(debt.tableId), columnId: guidOf(debt.columnId) };
  }
  let read;
  let unread = unconfirmed;
  if (!unread) {
    try {
      read = await readTextColumn(provision, logical, primaryLogical, { sleep, bound });
    } catch (err) {
      if (bound && err && err.statusCode === 404) return leave(gone);
      unread = err;
    }
  }
  // The column the debt recorded, once the table is proved: the read of the column carries its id. A column whose id is not the one
  // recorded — or cannot be read, so that it cannot be told — is not one the build may write to.
  if (read && carried && debt && debt.columnId !== undefined && (!read.metadataId || read.metadataId !== guidOf(debt.columnId))) {
    return leave({ step: 'not the name column the build created', why: `${primaryLogical} is not the column this build created in ${logical}` });
  }
  if (read && read.maxLength === asked) {
    runner.skip('data-model', `${label} (already ${asked}${owedNote})`);
    return { ok: true };
  }
  const actual = read && read.maxLength;
  // The update of a debt is addressed by the id of the column: the recorded one, or the one the read answered inside the table the debt names.
  const columnId = bound && (bound.columnId || (read && read.metadataId));
  if (read && bound && !columnId) {
    return leave({ step: 'nothing shows which column the build created', why: `the answer to the read of ${primaryLogical} carries no MetadataId, so nothing shows which column an update would write to, and the build never writes to a column it cannot name` });
  }
  const waiting = keys.length ? `alt key${keys.length > 1 ? 's' : ''} ${keys.map((k) => `${entity.schemaName}.${k}`).join(', ')}` : '';
  const be = keys.length > 1 ? 'are' : 'is';
  const afterwards = halted
    ? `because the data-model phase stopped, and a run that finds the table already there leaves its name column as it is, change the length in Maker if it matters${waiting ? ` — it does for ${waiting}, which ${be} over that column and ${be} refused while the column is that long` : ''}`
    : waiting
      ? `the build stops at ${waiting}, which ${be} over that column and cannot be created while the column is that long`
      : 'the rest of the build continues';
  let failure;
  let vanished = false;
  // `runner.run` can stop a step before it calls the function (the budget's guard does, for the steps of a phase it stops) and runBestEffort swallows that stop like any failure. Nothing is recorded inside the function then, which is also
  // how a step that succeeded looks, so whether the step began is recorded: a step that did not is neither a length that was set nor an update that failed, and must never be taken for the first.
  let began = false;
  let stopped;
  await runBestEffort(
    runner,
    'data-model',
    `${label} -> ${asked}${carried ? ` (${OWED_LENGTH})` : ''}`,
    async () => {
      began = true;
      try {
        if (unread) {
          const what = unconfirmed ? 'it could not be confirmed that the table is the one this build created' : 'the length the platform made is unknown';
          throw serviceFailure(`asked ${asked}, ${what}: ${(unread && unread.message) || unread}`, { cause: unread });
        }
        try {
          if (bound) await inSchemaWrite(sdk, logical, () => updateTextColumnLengthById(sdk, { tableId: bound.tableId, columnId, maxLength: asked }));
          else await sdk.updateColumn(logical, primaryLogical, { maxLength: asked });
        } catch (err) {
          // Nothing was written: the request that answered 404 is the one that was refused. The step is a skip, as the proof's refusal is.
          if (bound && err && err.statusCode === 404) {
            vanished = true;
            throw refusal(gone.why, { leftAlone: true });
          }
          throw serviceFailure(`asked ${asked}, the platform made ${actual}: ${(err && err.message) || err}`, { cause: err });
        }
      } catch (err) {
        // runBestEffort reports the failure and swallows it; what failed is kept for the caller, which may have a key waiting.
        failure = err;
        throw err;
      }
    },
    warn,
    `could not set the length of the primary name column ${logical}.${primaryLogical} to ${asked} — it keeps the length the platform gave it, and ${afterwards}`,
    // This step pays what the build owes for a table it created, which no later run can pay (a run that finds the table leaves its name column as it is), so it is never a step a refused budget stops (makeRunner): not in the settlement
    // of a halted phase, and not in the pass that completes one, where the refusal of one table's update must not keep the next table's from being set.
    { skipIf: (err) => (err && err.leftAlone ? `${gone.step} — kept` : false), settling: true, onFailure: (err) => { stopped = err; } }
  );
  if (vanished) {
    warnKept(gone.why);
    return { ok: false, left: true };
  }
  const readColumn = read && read.metadataId ? { columnId: read.metadataId } : {};
  if (!began) return { ok: false, notStarted: true, error: stopped || serviceFailure(`asked ${asked}, the step was not run`), ...readColumn };
  return failure ? { ok: false, error: failure, ...readColumn } : { ok: true };
}

// The primary name column of a table that was found after the create that made it: the answer to that create was lost, or somebody
// else created the table first. Nothing shows that THIS build made it, so its column is never written — but the length the spec
// asks for is compared with the one the table has, from one typed read, and a difference is said out loud instead of passing as a
// bare skip. (Some environments make a plain text name column created with only that column 850 characters long whatever length
// was asked, see DEFAULT_PRIMARY_NAME_LENGTH, which is the likely cause.) A read that fails is said too. One narrated step, always
// a skip, and never a failure of the build: it changes nothing.
async function reportFoundPrimaryNameLength({ runner, provision, entity, logical, asked, warn, sleep }) {
  const primaryLogical = String(entity.primaryAttribute.schemaName).toLowerCase();
  const label = `primary column length ${entity.schemaName}.${entity.primaryAttribute.schemaName}`;
  const found = 'table found after its create — kept';
  const why = 'the answer to that create was lost or another maker created the table first, so nothing shows that this build made it and its name column is left alone';
  let actual;
  try {
    actual = (await readTextColumn(provision, logical, primaryLogical, { sleep })).maxLength;
  } catch (err) {
    runner.skip('data-model', `${label} (${found}; its length could not be read)`);
    if (typeof warn === 'function') warn(`could not read the length of the primary name column ${logical}.${primaryLogical} (${(err && err.message) || err}), so the ${asked} the spec asks for is not confirmed — the table was found after its create, and ${why}`);
    return;
  }
  if (actual === asked) {
    runner.skip('data-model', `${label} (already ${asked})`);
    return;
  }
  runner.skip('data-model', `${label} (${found} at ${actual}, asked ${asked})`);
  if (typeof warn === 'function') warn(`the primary name column ${logical}.${primaryLogical} is ${actual} characters long, not the ${asked} the spec asks for — the table was found after its create, and ${why}. Change the column in Maker if the length matters`);
}

// The ordinary columns of a NEW table are created together, in ONE atomic change set, right after the table — instead of one
// request per column. A change set is an OData `$batch` whose operations are all POSTs to the table's `Attributes` collection (the
// vendored SDK's createColumns): Dataverse runs them in the order given, and if any operation fails it rolls back the ones already
// done, so a refused request has created nothing and the build can take the one-request-per-column path it always had. A batch may
// hold up to 1,000 requests.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#change-sets
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#handling-errors
//
// Why a request of its own and not the table's create request, which Dataverse also accepts — columns may be posted in the
// `Attributes` array beside the primary name attribute
// (https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-column-definitions-using-web-api#create-columns)?
// Because a table create that carries columns is not a request the previous release ever sent, and what the platform makes of it is
// not what it makes of the previous release's: an environment that ignores the length asked of a primary name column created alone
// keeps it when the same create also carries other columns (DEFAULT_PRIMARY_NAME_LENGTH), so no one length asked of such a create
// gives the previous release's result on every environment. The table is created exactly as before; only these columns are new.
// Each operation's body is the SAME body createColumn posts — the SDK builds both with one function — and the
// table-columns-in-create test compares them column by column, so a column comes out as it always did.
//
// Only a column whose whole definition is ONE such body qualifies. Left to the per-column path, as they have always been, because
// each needs something a request of its own provides:
//   Customer               a lookup plus two relationships, made by their own action — not an `Attributes` POST at all
//   File, Image            each makes companion columns of its own (see inlineColumnsOf), and an Image column is checked against
//                          the table's one-primary-image rule
//   Calculated, Rollup     a formula may name a column that has not been created yet, so they are made in spec order
//   a choice bound to a global option set   the binding refers to a separate record, not to the body
// A type is in this set only while the platform is not known to create anything beside it that COLUMN_COMPANIONS does not list:
// Text, Memo, the number types, DateTime and AutoNumber have no companion column at all, and the rest are listed there. (The order
// rules in inlineColumnsOf do not rely on that list being complete.)
const INLINE_COLUMN_TYPES = new Set(['Text', 'Memo', 'Integer', 'BigInt', 'Decimal', 'Double', 'Money', 'DateTime', 'Boolean', 'Choice', 'MultiChoice', 'AutoNumber']);
// At most this many columns go in one change set, so the request — and the one-request-per-column fallback a refusal costs — stays
// bounded however large a table is; the rest take the per-column path. (The platform allows 1,000 operations in a batch; this is the
// build's own bound.)
const INLINE_COLUMN_LIMIT = 25;

// What the platform creates beside a column of the change set, as the suffixes of the column's own name: a Money column's
// base-currency twin, and the `<name>name` shadow of a Choice, a MultiChoice or a Boolean column. Each companion is a column of its
// own on the table, marked `AttributeOf` the column it extends. A column of one of these names IN the change set would make the
// platform refuse the whole of it (see inlineColumnsOf), so the build keeps such a name out up front. A Map, because its key is
// the spec's column type: an object would answer `constructor` for a spec that says so.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/attributemetadata ("AttributeOf: The name of the attribute that this attribute extends.")
const COLUMN_COMPANIONS = new Map([
  ['Money', ['_base']],
  ['Choice', ['name']],
  ['MultiChoice', ['name']],
  ['Boolean', ['name']],
]);

// Whether a column can be created in the change set at all (INLINE_COLUMN_TYPES, and none of the exceptions listed there).
const isOrdinaryColumn = (c) => INLINE_COLUMN_TYPES.has(c.type || 'Text') && c.source !== 'Calculated' && c.source !== 'Rollup' && !c.globalChoice;

// The ordinary columns of a NEW table that go in the change set, in spec order.
//
// A change set that creates an attribute twice is refused as a whole by the platform — error 0x80060304,
// "Attribute {0} already exists for entity {1}." — where the one-by-one path meets the same collision in ONE column's
// own request and skips it. So a column stays out of the change set, and takes that path, when its name is one the
// platform creates itself or an earlier column already has. Names compare without regard to case, because Dataverse
// lower-cases logical names:
//   the primary name column     the table already has it
//   `<table>id`                 the table's own primary key
//   a companion                 a name COLUMN_COMPANIONS lists for a column of the table — for EVERY such column, even one that
//                               is past the limit or takes the per-column path (a choice bound to a global option set, a
//                               Calculated Money column). Money: `<name>_base`, the hidden twin holding its value in the base
//                               currency (download emits that twin as a column of its own when it could not read the Money
//                               column). Choice, MultiChoice, Boolean: `<name>name`.
//   a repeat of an earlier name in any case spelling — whatever type the earlier column is, because in spec order it
//                               would have created the name first
//   a name that EXTENDS the name of a column made by its own request   see below
// and a column stays out when an EARLIER column has a name that extends its own — the last rule below.
//
// The extends rule cannot be a list. A column that takes the per-column path — Customer, File, Image, a Calculated or Rollup column,
// a choice bound to a global option set — is made AFTER the change set, and the platform makes its companions at that moment,
// each named after it: `<name>name`, `<name>yominame` and `<name>idtype` beside a Customer column (measured on a polymorphic lookup:
// each is a stored column marked `AttributeOf` the lookup), `<name>_name` beside a File column, `<name>id`, `<name>_timestamp` and
// `<name>_url` beside an Image column, `<name>_date` and `<name>_state` beside a rollup column. A column of such a name inside the
// change set would be made BEFORE its owner, and the owner's own create would then meet it: refused with "already exists",
// which the build reads as a skip — the owner would vanish from the table without a word, where one by one the owner is made
// first and the twin is the skip. The build does not claim to know everything the platform makes beside a column, so a column
// whose name extends such an owner's stays out and is made in spec order, as it always was; for a column that merely happens to
// start like its neighbour's name (`new_file` and `new_filename`) that costs one request. A column past the limit, or kept out by
// another rule, is not an owner in this sense: its type has no companion that COLUMN_COMPANIONS does not list.
//
// The last rule is the mirror of those two, for the columns that go in the change set themselves. One by one, in spec order, the
// first column to name something creates it and the next is skipped as already existing — so when a twin is listed BEFORE the column
// that creates its name as a companion, the twin is the one that is kept and the OWNER is skipped. The change set runs before every
// per-column create, so an owner in it would be made first and the twin skipped instead: the other column of the pair would vanish
// from the table, without a word. So a column stays out of the change set when an earlier column of the table has a name that
// EXTENDS its own — every name creating a column can take is named after it, the ones COLUMN_COMPANIONS lists (a Choice,
// MultiChoice, Boolean or Money column's) and the ones the platform may make that the build does not know — and is made after that
// column, in spec order. For a twin listed AFTER its owner nothing changes: the owner goes first either way, and the twin stays out
// by the rules above. A column kept out for this is made by its own request like any other owner, so a LATER column whose name
// extends its own stays out too; an earlier one is created before it either way and need not. Where an earlier column merely starts
// like a later one's name, that costs one request.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/attributemetadata
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/file-column-data#file-name-column
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/image-column-data#download-url
// See: https://learn.microsoft.com/en-us/power-apps/maker/data-platform/define-rollup-fields
function inlineColumnsOf(buildable, { primaryName, tableLogical }) {
  const names = buildable.map((c) => c.schemaName.toLowerCase());
  const taken = new Set([String(primaryName || '').toLowerCase(), `${tableLogical}id`]);
  // The names of the columns made by their own request, each with the position after which a name that extends it stays out: any
  // position (-1) for a column that cannot go in the change set at all, only a later one for a column kept out by the last rule.
  const ownRequest = [];
  const lateOwners = new Set();
  buildable.forEach((c, i) => {
    const name = names[i];
    for (const suffix of COLUMN_COMPANIONS.get(c.type) || []) taken.add(`${name}${suffix}`);
    if (!isOrdinaryColumn(c)) {
      ownRequest.push({ name, after: -1 });
      return;
    }
    // Every name a column's creation can take — a companion listed for it, or one the build does not know — is named after the column,
    // so one test covers them all: an earlier column whose name extends this one's.
    if (names.slice(0, i).some((earlier) => earlier.length > name.length && earlier.startsWith(name))) {
      lateOwners.add(c);
      ownRequest.push({ name, after: i });
    }
  });
  const seen = new Set();
  const inline = [];
  buildable.forEach((c, i) => {
    const name = names[i];
    const repeat = seen.has(name);
    seen.add(name);
    const extendsOwner = ownRequest.some((owner) => i > owner.after && name.length > owner.name.length && name.startsWith(owner.name));
    if (!repeat && !taken.has(name) && !extendsOwner && !lateOwners.has(c) && isOrdinaryColumn(c) && inline.length < INLINE_COLUMN_LIMIT) inline.push(c);
  });
  return inline;
}

// Creates the table with the primary name attribute and nothing else — the request the previous release sent. Its ordinary columns
// follow in a change set of their own (createColumnsInOneRequest).
//
// TABLE_METADATA_NOT_VISIBLE is the SDK's own statement that the table WAS created and must not be created again, so it is the
// caller's. A length the spec asked for is reported as unconfirmed before the build stops (`askedLength`): some environments make
// a plain text name column created this way 850 characters long whatever length is asked (DEFAULT_PRIMARY_NAME_LENGTH), and the
// re-run that follows leaves an existing table's name column as it is. Nothing is said for an auto-numbered name column, which
// keeps the length asked, or for the longest length there is (850), which the column comes out as either way.
//
// PRIMARY_COLUMN_REQUIRED_NOT_APPLIED is the same statement about a table whose name column was asked to be required
// (`primaryColumnRequired`, sent only when the spec states a `required` for that column). The create ignores the level on a plain text
// name column (measured on Dataverse 9.2.26101), so the SDK reads the level back after the create and sets it with an update; when it
// cannot confirm the level, the table exists with a name column that may not be required. The build stops and says so; the re-run finds
// the table and sets the level on the name column the way it does for any existing column with an explicit `required`.
const nameLengthMayBeIgnored = (createOpts, askedLength) => askedLength !== undefined && askedLength !== PRIMARY_NAME_MAX_LENGTH
  && !createOpts.primaryColumnAutoNumberFormat;

async function createNewTable(sdk, createOpts, { warn, askedLength } = {}) {
  try {
    return await sdk.createTable(createOpts);
  } catch (err) {
    if (typeof warn === 'function') {
      const primaryLogical = String(createOpts.primaryColumnSchemaName).toLowerCase();
      if (err && err.code === 'TABLE_METADATA_NOT_VISIBLE' && nameLengthMayBeIgnored(createOpts, askedLength)) {
        warn(`table ${createOpts.schemaName} was created, but its metadata could not be read back yet, so the build stops here — the spec asks for a primary name column length of ${askedLength}, which may not have been applied (some environments make a name column created this way ${PRIMARY_NAME_MAX_LENGTH} characters long), and a re-run leaves an existing table's name column as it is: after the re-run, check ${primaryLogical} in Maker and set its length there if it matters`);
      } else if (err && err.code === 'PRIMARY_COLUMN_REQUIRED_NOT_APPLIED') {
        const length = nameLengthMayBeIgnored(createOpts, askedLength)
          ? `; the spec also asks for a name column length of ${askedLength}, which may not have been applied either (some environments make a name column created this way ${PRIMARY_NAME_MAX_LENGTH} characters long) and a re-run leaves an existing table's name column length as it is: after the re-run, check it in Maker and set it there if it matters`
          : '';
        warn(`table ${createOpts.schemaName} was created, but the required level (${createOpts.primaryColumnRequired}) of its primary name column ${primaryLogical} could not be confirmed, so the build stops here — the table exists: run the build again, which finds it, does not create it again, and sets that level on the column${length}`);
      }
    }
    throw err;
  }
}

// One line saying why a request failed. When the platform answers a `$batch` with its multipart envelope, the SDK's error carries
// that whole answer as its message, e.g. (line breaks shown as \r\n)
//   HTTP 400 from https://contoso.crm.dynamics.com/api/data/v9.2/$batch: --batchresponse_1\r\nContent-Type: multipart/mixed; boundary=changesetresponse_1\r\n\r\n--changesetresponse_1\r\nContent-Type: application/http\r\nContent-ID: 3\r\n\r\nHTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"error":{"code":"0x80060304","message":"Attribute createdon already exists for entity new_ticket."}}\r\n--changesetresponse_1--\r\n--batchresponse_1--
// so the platform's own message is taken out of it when there is one (with the status that opens the SDK's), and anything else
// is cut to a line.
function briefReason(err) {
  const text = String((err && err.message) || err);
  const status = /^HTTP (\d{3})\b/.exec(text);
  const platform = /"message"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
  let reason = text;
  if (platform) {
    try { reason = `${status ? `HTTP ${status[1]}: ` : ''}${JSON.parse(platform[1])}`; } catch { /* keep the whole text */ }
  }
  reason = reason.replace(/\s+/g, ' ').trim();
  return reason.length > 300 ? `${reason.slice(0, 297)}...` : reason;
}

// Whether an error from the change set leaves what it did UNKNOWN, rather than saying it was refused: the answer never arrived (a
// transport failure, which the SDK reports as a ConnectionError with status 0), was a server error, or could not be read although the
// platform answered with a success status ("cannot be confirmed"). A change set can commit behind each of those. A 4xx is a refusal —
// nothing was created — and so is anything the SDK raises before it sends (an error that is not a ConnectionError).
function outcomeUnknown(err) {
  if (!err || err.code !== 'CONNECTION_ERROR') return false;
  const status = err.statusCode;
  return !status || status >= 500 || (status >= 200 && status < 300);
}

// Creates a new table's ordinary columns in ONE atomic change set (the SDK's createColumns) and answers the ones the table is then
// confirmed to have (confirmInlineColumns). `table` is `{ metadataId, logicalName }` as the SDK answered the create of the table.
//
// The change set is all or nothing, so an error means the request was refused and no column was created — and the build goes on the
// way it always did, one request per column, with `warn` saying why. The SDK itself refuses a transport that cannot send the body of
// a change set verbatim (HttpClient.postRaw, which DataverseClient.supportsAtomicBatch reports; lib/sdk-http-client.js has it),
// before anything is sent: one more refusal of the same kind. An error is not always a refusal — a request whose answer was lost or
// could not be read may have created the columns after all (outcomeUnknown) — so the table is read before anything is assumed: when
// it has every column the change set committed, and each column is answered as it would have been had the answer arrived, with its
// id. A table that lacks any of them is treated as a refusal, and the one-by-one path covers every other case: a column that is
// already there answers "already exists" and is skipped, so a lost answer costs requests, never a column or a duplicate.
// The HTTP client sends this change set again only when the answer is a 429 — the platform refused it, so nothing in it committed (the
// change set is atomic)
// (isColumnCreateBatch, lib/sdk-http-client.js) — on the schedule of any other throttled write, honouring `Retry-After`: the table
// was created a moment ago, and its customization lock can still be held, which one column's own POST rides out the same way. It
// never sends it again after another transient status or a lost answer, because a change set can commit behind those. A change set
// still refused with a 429 when that schedule is spent was not a defect of the request, so the warning says the table was throttled
// instead of blaming the request, and the one-by-one path then takes its own turn at the lock.
//
// One more refusal is not the platform's: a run's throttle budget (lib/throttle-budget.js) that had no room for the wait a throttled change set asks. The HTTP client hands the 429 back as it came
// and tells the budget; the service has asked the run to hold back, so the columns are NOT then created one by one — each would be one more request to a service that said to wait — and the phase stops
// with the budget's halt. `stop`, when there is a budget, is the check that says so (the runner's `stopIfRefused`): it throws when the budget has refused, and does nothing otherwise, so a change
// set that was refused by anything else, or whose sends ran out while the budget still had room, falls back exactly as it always did.
async function createColumnsInOneRequest({ sdk, provision, table, tableSchemaName, columns, optionsFor, warn, sleep, stop }) {
  try {
    // The options are built inside the try: a column the options cannot be built for fails the way it always did, in its own step
    // on the per-column path, instead of failing the phase from here.
    await sdk.createColumns(table.logicalName, columns.map(optionsFor));
  } catch (err) {
    if (typeof stop === 'function') stop();
    if (outcomeUnknown(err)) {
      // ONE read, and only an answer that shows EVERY column counts: the change set is atomic, so a table that has only some of them
      // did not get them from it (a column the platform makes itself under the name of one the spec asks for is there either way).
      const found = await confirmInlineColumns(provision, table, columns, { sleep, attempts: 1 });
      if (found.size === columns.length) {
        if (typeof warn === 'function') warn(`the answer to the request that creates the ${columns.length} ordinary column(s) of table ${tableSchemaName} was lost or could not be read (${briefReason(err)}), but the table has every one of them`);
        return found;
      }
    }
    if (typeof warn === 'function') {
      // A ConnectionError carries `.statusCode`; any other error may wrap one as its `cause`.
      const status = err && (err.statusCode || err.status || (err.cause && (err.cause.statusCode || err.cause.status)));
      warn(status === 429
        ? `table ${tableSchemaName} was throttled (${briefReason(err)}), so its ${columns.length} ordinary column(s) are created one by one instead of in one request`
        : `could not create the ${columns.length} ordinary column(s) of table ${tableSchemaName} in one request (${briefReason(err)}) — creating them one by one`);
    }
    return new Map();
  }
  return confirmInlineColumns(provision, table, columns, { warn, sleep });
}

// Which of a new table's columns that went in the change set the table really has, with the MetadataId each createColumn answer
// would have carried (a change set answers none), from ONE read of the table's `Attributes`, keyed by the column object — never
// by its name, because two columns of a spec can share one and only the one that went in the request was created by it. `table` is
// `{ metadataId, logicalName }`: a created table is read by its id, or by its logical name when the SDK's answer carries no id.
// Only ids and names are selected — no labels, the kind of narrow read that already precedes labelled creates in this file
// (findExistingColumns) because a label-bearing metadata read is what strips non-base languages.
//
// Nothing is assumed: a column this read does not show — it failed, or the answer lags the create, or the platform
// ignored a posted column — is left out of the result and made by the column loop the per-column way, where an
// "already exists" answer is a skip. So a lagging read costs requests, never a missing column. Never throws.
// A short answer is read again, up to `attempts` times (3 unless told otherwise, 1 second apart).
async function confirmInlineColumns(provision, table, columns, { warn, sleep, attempts = 3 } = {}) {
  const confirmed = new Map();
  const raw = provision && provision.dataverse;
  const byId = GUID_RE.test(String(table && table.metadataId));
  if (!columns.length || !raw || typeof raw.get !== 'function' || (!byId && !(table && table.logicalName))) return confirmed;
  const tableKey = byId ? `(${table.metadataId})` : `(LogicalName='${odataLit(table.logicalName)}')`;
  const wait = typeof sleep === 'function' ? sleep : ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const idByLogical = new Map();
  // The table is readable as soon as it exists; its attribute collection can trail it by a moment
  // (the metadata-read lag the relationship create also waits out), so a short answer is read again.
  for (let attempt = 0; attempt < attempts && columns.some((c) => !idByLogical.has(c.schemaName.toLowerCase())); attempt += 1) {
    if (attempt > 0) await wait(1000);
    try {
      const res = await raw.get(`/EntityDefinitions${tableKey}/Attributes?$select=MetadataId,LogicalName`);
      if (res && res.status >= 200 && res.status < 300 && res.body && Array.isArray(res.body.value)) {
        for (const a of res.body.value) {
          if (a && a.LogicalName && a.MetadataId) idByLogical.set(String(a.LogicalName).toLowerCase(), String(a.MetadataId));
        }
      }
    } catch { /* read again, then fall back to the per-column path */ }
  }
  for (const c of columns) {
    const logicalName = c.schemaName.toLowerCase();
    if (idByLogical.has(logicalName)) confirmed.set(c, { logicalName, metadataId: idByLogical.get(logicalName) });
  }
  if (confirmed.size < columns.length && typeof warn === 'function') {
    warn(`${columns.length} column(s) were created in one request, but ${confirmed.size} could be read back — creating the other ${columns.length - confirmed.size} one by one`);
  }
  return confirmed;
}

const STATE_CODE = { Active: 0, Inactive: 1 };

// A halt the build stops with. `retry` is the halt's policy for the build's own re-run (retry-policy.js), decided where it is raised: RETRY.NEVER (a run again cannot change it — marks the halt
// `transient: false`, which the retry check has always read) or RETRY.SERVICE (it wraps a failure of the service: the status and words of that failure decide, never this halt's message, which quotes
// what the maker named). `retryText` is what the halt declares as the service's own words, `statusCode` the status the service answered, when a halt has no failure to carry them as its `cause`.
// A halt raised with no policy is judged by the failure it wraps and nothing else: its own message is never read.
class BuildHalt extends Error {
  constructor(message, { phase, code, recoverable = false, cause, retry, retryText, statusCode } = {}) {
    super(message);
    this.name = 'BuildHalt';
    this.phase = phase;
    this.code = code;
    this.recoverable = recoverable;
    this.cause = cause;
    if (retry !== undefined) {
      if (retry !== RETRY.NEVER && retry !== RETRY.SERVICE) throw new TypeError(`BuildHalt: unknown retry policy ${JSON.stringify(retry)} (halt ${code}): use RETRY.NEVER or RETRY.SERVICE (lib/retry-policy.js)`);
      this.retry = retry;
      if (retry === RETRY.NEVER) this.transient = false;
    }
    if (retryText !== undefined) this.retryText = String(retryText);
    if (statusCode !== undefined) this.statusCode = statusCode;
  }
}

// The halt a run's throttle budget makes when it has refused to wait for a throttled request (lib/throttle-budget.js, `declined`): the service asked for longer than the run may wait, so the run ends here and a later one goes on from where it stopped —
// a transient halt, which is what the build's retry loop reports as `throttle-budget-exhausted` (build-model-app.js) in the same words, instead of running the phases again to meet the same answer. See makeRunner.
function budgetStop(throttle, phase) {
  return new BuildHalt(`${phase ? `${phase} stopped` : 'the build stopped'}: ${waitDoesNotFit(throttle, throttle.declined())}`, { phase, code: 'throttle-budget-exhausted', recoverable: true, retry: RETRY.SERVICE, statusCode: 429 });
}

// Collect every `code` along an error's `cause` chain, outermost first.
//
// A phase-level `skipIf` predicate is handed whatever reached the runner, and that is NOT always the
// SDK's own error: a failure the SDK reports BY VALUE goes through `requireSuccessfulPush`, which
// wraps it in a `BuildHalt` carrying the SdkError as `cause`. A predicate that only reads `err.code`
// therefore matches the thrown form and silently misses the returned form of the SAME condition —
// which is exactly how a preview-gated capability turned from a clean skip into a build halt when
// the SDK moved it from a throw to a return.
//
// Depth is bounded so a self-referential `cause` (seen in the wild when an error is re-wrapped with
// itself) cannot spin here.
function errorCodeChain(err, maxDepth = 5) {
  const codes = [];
  const seen = new Set();
  let e = err;
  for (let i = 0; e && typeof e === 'object' && i < maxDepth && !seen.has(e); i += 1) {
    seen.add(e);
    if (e.code) codes.push(e.code);
    e = e.cause;
  }
  return codes;
}

// An error and what it was made from, outermost first — the chain `cause` links, which a step wraps an SDK error in once or twice
// (a BuildHalt around the Error a step threw around the SDK's own, which carries the HTTP status). Bounded for the reason
// errorCodeChain is.
function causeChain(err, maxDepth = 6) {
  const chain = [];
  for (let e = err; e && typeof e === 'object' && chain.length < maxDepth && !chain.includes(e); e = e.cause) chain.push(e);
  return chain;
}

// A metadata create that fails because the component already exists (the classic re-run
// case). Dataverse answers 409, or 400 with a duplicate-name message. Used to make
// otherwise non-idempotent creates (e.g. alternate keys — the SDK has no key lister) safe
// to re-run: the build skips instead of halting. Kept deliberately narrow so a genuine
// failure (bad key attribute, etc.) still surfaces.
function isAlreadyExists(err) {
  if (!err) return false;
  const status = err.statusCode || err.status || (err.cause && (err.cause.statusCode || err.cause.status));
  if (status === 409) return true;
  const msg = String((err && err.message) || '').toLowerCase();
  // "already exist" (no trailing 's') also catches the plural table-create message
  // "Entities already exist: <name>" that Dataverse returns on a transient-retry duplicate.
  return /already exist|duplicate|with the (?:specified|same) name|a key with/.test(msg);
}

// The grid data-visualization preview is not provisioned on every environment. When it is absent,
// Dataverse answers the `controlconfigurations` set with a raw 404 naming the segment — the SDK
// deliberately propagates that rather than reporting 'None', so "cannot inspect here" is never
// confused with "plain text on purpose" (see getColumnVisualization in the SDK's SchemaApi).
// Treat it as a SKIP, not a build failure: the table, its columns and every other artifact are
// fine, and failing the whole data-model phase over an optional rendering flourish would strand
// an otherwise-complete app. Anything else (403, 500, a bad column name) still halts.
function isVisualizationUnsupported(err) {
  if (!err) return false;
  const status = err.statusCode || err.status || (err.cause && (err.cause.statusCode || err.cause.status));
  if (status !== 404) return false;
  const msg = String((err && err.message) || '');
  // Match the SEGMENT-missing phrasing specifically, not merely the word "controlconfigurations".
  // The SDK's message embeds the full request URL, which ALWAYS contains that word — so a plain
  // substring test would also swallow a row-level 404 (e.g. `controlconfigurations(<id>)` deleted
  // concurrently), silently reporting "preview unavailable" and leaving the renderer unset on an
  // org that supports it. The server's actual response when the table is absent is:
  //   {"error":{"code":"0x80060888","message":"Resource not found for the segment
  //    'controlconfigurations'."}}
  return /not found for the segment\s+'?controlconfigurations/i.test(msg);
}

function hasExplicitRequired(c) {
  // `undefined` states nothing, like a missing key — validateAppSpec reads it that way (requiredValueProblem). A bare own-property test took it for an
  // explicit None, which on an existing column writes None over a level a maker set. JSON cannot carry an undefined; a spec built in code can.
  return !!c && c.required !== undefined;
}

function requiredLevelValue(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.Value === 'string') return raw.Value;
  if (raw && typeof raw.value === 'string') return raw.value;
  return undefined;
}

function columnRequiredLevel(c) {
  if (!c) return undefined;
  return requiredLevelValue(c.RequiredLevel) || requiredLevelValue(c.requiredLevel);
}

// The columns a table already has, as `[{ logicalName, RequiredLevel }]`.
//
// Same reason as `findExistingTable` above, and the same measurement: calling the SDK's
// `findColumns` immediately before `createColumn` makes Dataverse store ONLY the base-language
// label of a multi-language column name. Order-controlled, 8 columns, sequence C,F,F,C,C,F,F,C:
// `createColumn` alone kept both languages 4/4; `findColumns` then `createColumn` kept both 0/4.
//
// This path matters MORE than the table one, not less: it is the table-REUSE branch, i.e. adding a
// column to a table that already exists — which is exactly the scenario AB#6686428 was reported
// against ("adding a table to an existing app"). A fresh-table build never reaches it, which is why
// the first round of this fix missed it and why the end-to-end verification did not catch it.
//
// The projection deliberately matches `readAttributeRequiredLevels` below, so the rows still answer
// `columnRequiredLevel`.
//
// ON THE FAILURE PATH, and this is the subtle part: when the raw client is PRESENT but the read
// fails or returns a non-2xx, we return `[]` rather than falling back to `findColumns`. Falling back
// would re-introduce the exact poisoning this function exists to remove, silently, on the very
// branch it targets — `createColumn` is guaranteed to run here for every column that looks new. An
// empty list instead makes every column look new, and `createColumn`'s `skipIf: isAlreadyExists`
// de-duplicates the ones that already exist WITHOUT a poisoning pre-read. The cost is that the
// required/capability reconcile degrades to best-effort for this table, which is the same
// degradation a `readAttributeRequiredLevels` failure already produces — and it is warned about,
// because a silent degradation is what this whole line of fixes is about.
//
// `findColumns` is therefore reserved for the one case where it cannot poison anything: no raw
// client at all, which in practice means a unit-test double.
async function findExistingColumns(provision, logical, warn) {
  const raw = provision && provision.dataverse;
  if (raw && typeof raw.get === 'function') {
    let res = null;
    let err = null;
    try {
      res = await raw.get(`/EntityDefinitions(LogicalName='${odataLit(logical)}')/Attributes?$select=LogicalName,RequiredLevel`);
    } catch (e) { err = e; }
    if (res && res.status >= 200 && res.status < 300 && res.body && Array.isArray(res.body.value)) {
      return res.body.value.map((a) => ({ logicalName: String(a.LogicalName || '').toLowerCase(), RequiredLevel: a.RequiredLevel }));
    }
    const why = err ? ((err && err.message) || String(err)) : `HTTP ${res && res.status}`;
    if (typeof warn === 'function') {
      warn(`could not read existing columns for ${logical} (${why}) — treating every declared column as new. `
        + 'Existing ones are de-duplicated by the create\'s already-exists handling; required-level reconciliation '
        + 'is skipped for this table this run.');
    }
    return [];
  }
  if (typeof (provision && provision.findColumns) !== 'function') return [];
  return (await provision.findColumns(logical)) || [];
}

// Does a relationship with this schema name already exist on the entity?
//
// A NARROW relationship read, for the third time and the same measured reason: the plugin used to
// answer this with `provision.fetchEntityMetadata(...)`, and any broad metadata read immediately
// before a labelled create makes Dataverse store ONLY the base-language label. Order-controlled
// (C,F,F,C): `createRelationship` alone kept a bilingual `lookupDisplayName` 2/2;
// `fetchEntityMetadata` then `createRelationship` kept it 0/2.
//
// The collection select is SchemaName plus the endpoint scalars (readRelationshipsOf). Still no
// labels — a label-bearing select here is what strips every non-base language. Falls back to
// `fetchEntityMetadata` when the raw client is unavailable (unit-test doubles).
//
// Without `declared`, returns `true`/`false`/`null` (name-only; the live plan). With `declared`, a
// name whose type or endpoints differ returns `{ mismatch: true, holder }` so the build halts
// instead of skipping. `null` is still "could not tell" — the caller treats it as absent and lets
// the create's own already-exists handling deal with it, because a table created moments ago
// legitimately 404s here.
//
// A row that carries the name but does not state its whole identity (a collection row without its
// referencing table or lookup, an N:N row without its intersect table, a projection row with an empty value —
// and the SDK's projection of an N:N always, which has no intersect table to state) is `null` too: it is not the
// declared relationship and it is not another's, so nothing is skipped on its name. The create then
// collides, and its already-exists handling reads the relationship ITSELF — which is where it is
// reused, once that read states everything, or where the build halts (see compareRelationship).
//
// `hasLocalizedLabels` closes the same hole `findExistingTable` documents, for the same reason and
// with the same rule. `fetchEntityMetadata` → `createRelationship` is one of the three broad-read →
// create pairs that makes Dataverse keep ONLY the base-language label (AB#6686428), so falling back
// to it after an inconclusive narrow probe would silently reintroduce the bug on a transient 5xx —
// invisibly, because the request body is byte-identical either way and the relationship is still
// created. For a localized lookup label the fallback is therefore skipped and `null` is returned:
// "assume absent" costs at most a redundant create that already-exists handling absorbs, whereas the
// poisoning read costs a label nobody can see is wrong until a user switches language.
// A relationship with a plain-string label keeps the fallback exactly as before.
async function relationshipExists(provision, entityLogical, schemaName, type, opts = {}) {
  const hasLocalizedLabels = opts.hasLocalizedLabels === true;
  const declared = opts.declared;
  const collectionKind = type === 'ManyToMany' ? 'ManyToMany' : 'OneToMany';
  const raw = provision && provision.dataverse;
  let probed = null;
  if (raw && typeof raw.get === 'function') {
    // Same narrow collection read as before, now selecting the endpoint scalars too. Scalars only —
    // readRelationshipsOf documents why a label-bearing select must not precede createRelationship.
    const read = await readRelationshipsOf(raw, entityLogical, collectionKind, opts.cache);
    if (read.ok) {
      const want = String(schemaName).toLowerCase();
      const hit = (read.rows || []).find((r) => String(r.schemaName || '').toLowerCase() === want);
      probed = hit ? { state: 'present', holder: hit } : { state: 'absent' };
    } else if (hasLocalizedLabels) {
      // Inconclusive AND localized: never resolve it with the broad read.
      probed = { state: 'unknown' };
    }
  }
  if (!probed && typeof (provision && provision.fetchEntityMetadata) === 'function') {
    try {
      const meta = await provision.fetchEntityMetadata(entityLogical);
      const hit = pickProjectionRow(meta && meta.relationships, schemaName);
      // A ManyToOne projection has no lookup (relatedAttribute is the parent key). Two
      // self-references can share a name and differ only by lookup, so an unknown lookup is not
      // a match — return null and let the create's holder classification read the cast, which has it.
      // Only an OneToMany projection row can decide a 1:N match from this fallback.
      const lookupUnknown = hit && hit.type === 'ManyToOne' && declared && declared.lookup && declared.lookup.schemaName;
      probed = !hit
        ? { state: 'absent' }
        : lookupUnknown
          ? { state: 'unknown' }
          : { state: 'present', holder: projectionHolder(hit, entityLogical) };
    } catch {
      probed = { state: 'unknown' };
    }
  }
  if (!probed) probed = { state: 'unknown' };
  // Callers that do not pass the declared relationship (the live plan) keep the name-only answer.
  if (!declared) {
    if (probed.state === 'unknown') return null;
    return probed.state === 'present';
  }
  if (probed.state === 'unknown') return null;
  if (probed.state === 'absent') return false;
  const declaredWithName = Object.assign({}, declared, { schemaName: declared.schemaName || schemaName });
  const verdict = compareRelationship(declaredWithName, probed.holder);
  if (verdict.state === 'same') return true;
  if (verdict.state === 'incomplete') return null;
  return { mismatch: true, holder: probed.holder };
}


async function readAttributeRequiredLevels({ sdk, provision, logical }) {
  const client = (provision && provision.dataverse) || (sdk && sdk.dataverse);
  if (!client || typeof client.get !== 'function') return new Map();

  // The public SDK discovery methods currently project RequiredLevel away: `findColumns` returns
  // name/type/display fields, and `fetchEntityMetadata` returns its cached `attributes[]` in the
  // same reduced shape. `updateColumn` can write RequiredLevel but does not expose its internal GET,
  // so this is the narrow transport read that lets us avoid a blind metadata PUT. Dataverse returns:
  //   {
  //     "value": [{
  //       "LogicalName": "contoso_title",
  //       "RequiredLevel": { "Value": "ApplicationRequired", "CanBeChanged": true, ... }
  //     }]
  //   }
  // `RequiredLevel.Value` is the same AttributeRequiredLevelManagedProperty enum value accepted by
  // the SDK (`ApplicationRequired` | `Recommended` | `None`).
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/attributerequiredlevelmanagedproperty
  const path = `/EntityDefinitions(LogicalName='${odataLit(logical)}')/Attributes?$select=LogicalName,RequiredLevel`;
  const res = await client.get(path);
  if (!res || res.status < 200 || res.status >= 300) {
    const msg = res && res.body && res.body.error && res.body.error.message
      ? res.body.error.message
      : `HTTP ${res && res.status}`;
    // The answer's OData error goes with it, as statusError's does: a lock or a SQL timeout the service names by its code is run again on any status.
    throw serviceFailure(`could not read RequiredLevel for ${logical}: ${msg}`, { status: res && res.status, words: msg, answered: res && res.body && res.body.error });
  }
  const out = new Map();
  for (const a of (res.body && res.body.value) || []) {
    const name = a && (a.LogicalName || a.logicalName);
    const level = columnRequiredLevel(a);
    if (name && level) out.set(String(name).toLowerCase(), level);
  }
  return out;
}

// `options` are the options of runner.run (`skipIf`, for a step that turns out to be a skip once it has started, and `settling`) and `onFailure`, which is told what the step failed with: the halt the runner made of what `fn` threw, or the stop
// the runner raised before it called `fn` (the budget's guard, makeRunner). Both are swallowed here, so a caller that records what the step came to inside `fn` cannot tell a step that ran and succeeded from one that never began without it.
async function runBestEffort(runner, phase, label, fn, warn, warning, options = {}) {
  const { onFailure, ...runOptions } = options;
  try {
    return await runner.run(phase, label, fn, { recoverable: true, ...runOptions });
  } catch (err) {
    if (typeof onFailure === 'function') onFailure(err);
    if (typeof warn === 'function') {
      const cause = err && err.cause ? err.cause : err;
      warn(`${warning}: ${(cause && cause.message) || cause}`);
    }
    return undefined;
  }
}

// Bounded-concurrency map — parallelize independent ops without flooding Dataverse (which
// raises SQL-deadlock risk). Preserves input order in the result.
//
// On the first failure, no further item is STARTED, and the failure is reported only after every
// item already in flight has settled. Rejecting at once (a plain Promise.all over the workers) left
// the other workers running — still writing — after the phase had already failed. The build's
// transient retry then re-ran the phase while one of those writes was still pending; its discovery
// found no row yet and created the same view a second time under a new id, which the next fetch
// then refused as an ambiguous match. Only the first error is rethrown; a later in-flight failure is
// the same phase failing again and adds nothing the first did not already report.
//
// `firstInOrder` picks WHICH failure is reported when several in-flight items fail: the one of the
// lowest-indexed item rather than the first to settle. Items start in index order, so every item below
// a failed one has already started, and once they have drained the reported error is the one a
// sequential loop over the same items would have met first — independent of response timing. Read-only
// fan-outs whose report must not depend on which request answered first (verify, download) opt in; the
// build's write fan-outs keep the first failure in time, which is the one that stopped the phase.
async function mapLimit(items, limit, fn, { firstInOrder = false } = {}) {
  const out = new Array(items.length);
  let i = 0;
  let failed = false;
  let firstError;
  let firstErrorIndex = -1;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        if (!failed) { failed = true; firstError = err; firstErrorIndex = idx; }
        else if (firstInOrder && idx < firstErrorIndex) { firstError = err; firstErrorIndex = idx; }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
  return out;
}

// A Runner owns the emit/counter/BuildHalt machinery so both consumers produce the
// identical { phase, status, label, n, total } event stream. `total` is supplied by the
// consumer (each computes its own plan length), so counting stays consumer-scoped.
//
// `throttle` is the run's throttle budget (lib/throttle-budget.js), for the runner of a build. Once it has refused to wait for a throttled request (`declined`) the run is over — the build's
// retry loop stops with `throttle-budget-exhausted` rather than run the phases again to meet the same answer — but the refusal can be swallowed on its way up: a best-effort step reports a failure
// and goes on, and a fallback answers a refused request with others (createColumnsInOneRequest). The run would then keep sending requests to a service that asked it to hold back, and could even end as a
// success. So after a refusal no step STARTS: `run` and each item of `mapLimit` stop the phase with the budget's halt (budgetStop), and `stopIfRefused` is the same check for code that must decide before it
// writes. A step that is already running finishes (a request is never cut off), and the step that pays what the run owes is let through (`settling`: the name column's length of a table the run created, in the settlement of a halted phase and in the
// pass that completes one — no later run can set it, because a run that finds the table leaves its name column as it is, so a stop would leave the table at the platform's default for good). One runner is one run of the phases (runSdkBuild makes one for each), so only
// refusals made after it was made count; a runner given no budget — or one that cannot say what it refused — never stops, as before.
function makeRunner({ emit, total, throttle }) {
  let n = 0;
  const budgeted = Boolean(throttle) && typeof throttle.declined === 'function';
  const refusals = () => (budgeted ? throttle.declined().count : 0);
  const refusedBefore = refusals();
  const stopIfRefused = (phase) => { if (refusals() > refusedBefore) throw budgetStop(throttle, phase); };
  const run = async (phase, label, fn, { recoverable = false, skipIf, settling = false } = {}) => {
    if (!settling) stopIfRefused(phase);
    const myN = (n += 1);
    emit({ phase, status: 'start', label, n: myN, total });
    try {
      const out = await fn();
      emit({ phase, status: 'ok', label, n: myN, total });
      return out;
    } catch (err) {
      // Idempotency escape hatch: a create that fails only because the component already
      // exists is a skip, not a halt (used where the SDK offers no check-first lister).
      //
      // `skipIf` may answer `true` (the original contract — the reason is "exists") or a REASON
      // STRING. The string form exists because not every recoverable skip is an already-exists
      // collision: an environment that does not declare a platform member cannot host the artifact
      // at all, and labelling that "(exists)" would tell the operator the exact opposite of what
      // happened. Boolean callers are unaffected.
      const why = skipIf && skipIf(err);
      if (why) {
        emit({ phase, status: 'skip', label: `${label} (${typeof why === 'string' ? why : 'exists'})`, n: myN, total });
        return undefined;
      }
      emit({ phase, status: 'error', label, n: myN, total, detail: String((err && err.message) || err) });
      throw new BuildHalt(`${phase} failed: ${(err && err.message) || err}${operatorRemedy(err)}`, { phase, code: (err && err.code) || 'sdk-error', recoverable, cause: err, retry: retryPolicyFor(err) });
    }
  };
  const skip = (phase, label) => { emit({ phase, status: 'skip', label, n: (n += 1), total }); };
  // The one limiter, with each item's start guarded when there is a budget to ask: a runner without one is handed the module's own function, as it always was.
  const limited = budgeted ? (items, limit, fn, options) => mapLimit(items, limit, (item, index) => { stopIfRefused(); return fn(item, index); }, options) : mapLimit;
  return { run, mapLimit: limited, skip, emit, total, stopIfRefused };
}

// How an operator resets a workspace by hand, where the build cannot do it itself. Most of `.maker-workspace`
// is state a re-run rebuilds — the SDK's copies are re-read from the environment, and without the
// changed-only snapshot the next `--changed-only` run just does a full build — but three kinds of file record
// things the environment cannot give back:
//   - last-applied.json, what was last applied or downloaded: the baseline that keeps a nav change made in
//     the designer from being reverted by a stale spec (AB#6726727);
//   - destructive-approval.json, the removals a maker approved: without it the next --allow-destructive
//     authorizes whatever that run finds, not what was shown;
//   - page-ownership.*.json, the receipts of the pages this app created, the records of pages a teardown is
//     deleting, and the `pending` records of page creates that were started and never answered. A pending
//     record is the only trace of a page that may still land: without it the next build creates a second page
//     for the spec entry, or nothing ever finds the page that lands late — what the record exists to prevent.
//     (`teardown-model-app.js --clear-workspace` refuses to clear a workspace that holds one, for the same reason.)
// And the changed-only snapshot can hold a RUNNING teardown's registration and a build's lease, which are
// that run's guard against a concurrent one: deleting them under a live run removes it. Every remedy that
// resets the workspace says exactly this.
const RESET_WORKSPACE = 'stop any other build or teardown using the .maker-workspace directory (or the --workspace one), then delete everything in it except last-applied.json, destructive-approval.json and the page-ownership.*.json records (the receipts and pending records of the pages the app created: nothing else can find them)';

// Some SDK refusals end with the SDK call that fixes them — `fetchArtifact(...)` — which an operator of this
// plugin cannot make. Where the operator's step is known, the halt names it too.
//
// ARTIFACT_PROJECTION_STALE: the SDK refuses to push a workspace copy projected by a different version of its
// parsers — one an earlier version of this plugin saved. The build's plain fetch re-reads every CLEAN copy
// before it edits one, so the refusal is reached only by a copy still holding edits an earlier build never
// pushed (an interrupted build, say): a plain fetch keeps those while the server has not moved. The edits
// were projected from the spec, so the re-run after a reset re-applies them.
//
// The build does NOT reset the copy itself, although `fetchArtifact(..., { overwrite: true })` would. The
// SDK's per-artifact lock is per process, so an overwrite here could replace the copy a second build on
// the same workspace has just re-read and edited, and that build would then push without its edit —
// reporting success. The manual reset starts by stopping every other run, which is what makes it safe.
//
// LOCAL_EDITS_WOULD_BE_LOST: a plain fetch keeps a copy holding unpushed edits only while the environment's
// copy has NOT moved; once it has, the fetch refuses rather than discard the edits, and the SDK's advice —
// "Push or discard your edits first, or pass { overwrite: true }" — is again an API call. Two things leave
// such a copy: an interrupted build (measured live on a 2.10.0 workspace, where the build then stopped at a
// form's fetch, not its push), and a push refused as a concurrent edit (VERSION_CONFLICT), after which the
// copy is KEPT on purpose as the fence that stops a blind re-run (see discardUnrecordedEdits, sdk-build.js).
// Either way the environment has changed since, maybe by a maker, so clearing the copy and rebuilding the
// same spec could overwrite that change: the navigation baseline covers nav chrome only, and not a field the
// spec changed too. So the halt asks for the one step only a person can take first — look at the change and
// put into the spec what should stay — and then the usual reset. A re-download is no substitute: it does not
// capture forms, views or charts, and the artifact may predate the app (an interrupted FIRST build leaves
// views and forms before the app exists). Both codes are pinned against the real bundle in
// workspace-projection-real-bundle.test.js.
//
// PRIMARY_COLUMN_REQUIRED_NOT_APPLIED: the table WAS created, but the required level asked of its name column could not be confirmed, and the
// message ends with "Do NOT re-run the create" and the SDK call that sets the level. Running this build again is the fix: it finds the table (it
// is not created twice) and sets the level the way it does for any existing column with an explicit `required`.
function operatorRemedy(err) {
  if (err && err.code === 'PRIMARY_COLUMN_REQUIRED_NOT_APPLIED') {
    return ' — the table exists. Run the build again: it finds the table, does not create it again, and sets the required level of its primary name column (the call the message names is made for you).';
  }
  if (err && err.code === 'ARTIFACT_PROJECTION_STALE') {
    return ` — the workspace copy was saved by an earlier version of this plugin and still holds edits no build pushed (an interrupted build, say). To reset it, ${RESET_WORKSPACE}, and re-run: the build re-reads the copies and re-applies every edit from the spec.`;
  }
  if (err && err.code === 'LOCAL_EDITS_WOULD_BE_LOST') {
    return ` — the environment's copy changed after this workspace copy was fetched, and the workspace copy holds edits no build pushed (an interrupted build, or one halted by a concurrent edit). A re-run applies the spec over that change, so first look at it in Maker and put into the spec anything that should stay; then ${RESET_WORKSPACE}, and re-run.`;
  }
  return '';
}

// Whether a push RESULT is a failure. The SDK reports some failures by value instead of throwing (see
// requireSuccessfulPush below for which, and why both spellings of the commit flag are read). Shared so
// every caller that reacts to a failed push decides "failed" exactly as the halt does.
function pushFailed(result) {
  if (!result) return false;
  // `createRecovery: 'adoptExact'` (build-model-app.js): a create whose answer was lost had already
  // committed, and the SDK proved the row is exactly what this push would have written, so it adopted it
  // locally. It says `saved: false` because THIS attempt wrote nothing — but nothing failed. Only the
  // boolean the SDK sets, and only with no error beside it.
  if (result.adoptedExisting === true && !result.error) return false;
  const committed = result.saved !== undefined ? result.saved : result.success;
  return committed === false || (committed === undefined && Boolean(result.error));
}

// Route every artifact push (form/view/chart/app/command/dashboard) through this. The SDK's
// pushArtifact RESOLVES (it does NOT throw) with a failed PushResult on a 412 — the artifact changed
// in Maker since our last fetch — and on an ARTIFACT_ALREADY_EXISTS collision. The engine previously
// ignored push results, so a conflict silently reported success while DROPPING the edit. Halt loudly
// and require a fresh download instead of auto refetch-and-overlay (which would clobber a concurrent
// Maker edit and violates the SDK's rebuild-from-model tenet). Those two are
// the failures signalled by return value; every other failure still throws.
//
// The SDK renamed `PushResult.success` to `saved`, DELIBERATELY, to force every call site to be
// re-read once: `saved` means the write committed, NOT that the runtime serves it (that is
// `shipped`, true only when the publish was verified). Both spellings are accepted here because the
// rename is invisible at runtime — a bundle that still returns `success` would otherwise sail past
// a `saved === false` check, and a bundle that returns `saved` sails past a `success === false`
// check. Either mismatch silently disarms this guard, which is the one thing it must never do, so
// the check is written to fail CLOSED against both bundle generations rather than assume one.
function requireSuccessfulPush(result, what, warn) {
  if (!result) return result;
  if (pushFailed(result)) {
    // SEVERAL different by-value failures reach here and they need different remedies, so the
    // diagnosis is SELECTED from the SDK's own error code rather than assumed.
    //
    // The set is open and it grows: the SDK keeps moving failures from a throw to a return, and
    // every newly-returned one landed on the "changed in Maker" wording below — telling the operator
    // to re-download an app nobody had touched, over a cause that wording cannot describe. (Measured
    // on the business-rule preview gate: an environment without the bound member now RESOLVES with
    // `saved:false` where it used to throw.) So an unrecognised code is reported VERBATIM and
    // propagated as the halt's own `code`, which also lets a phase-level `skipIf` match on it.
    const label = what || result.type || 'artifact';
    const sdkCode = (result.error && result.error.code) || null;
    const detail = (result.error && result.error.message) || 'version conflict (412)';
    const opts = { phase: 'push', recoverable: true, cause: result.error };
    // Reporting an already-exists collision as a concurrent edit tells the operator to re-download
    // when nothing changed under them, and hides the actual cause.
    //
    // The remedy is NOT "re-run" and NOT a plain `fetchArtifact`. The collision means an earlier push
    // committed but the workspace never recorded it, so it still holds a local copy marked never-
    // pushed at that id. A plain fetch KEEPS such a copy and adopts nothing — and the build's
    // existing-artifact path is exactly a plain fetch — so a re-run on the same workspace re-issues
    // the create and halts here again. Measured against the vendored bundle: same workspace → the
    // same ARTIFACT_ALREADY_EXISTS; a fresh workspace → the fetch adopts the row and the push is a
    // conditional update. The SDK's own advice (`fetchArtifact(..., { overwrite: true })`) is an API
    // call an operator of this plugin cannot make, so this names the step they can.
    if (sdkCode === 'ARTIFACT_ALREADY_EXISTS') {
      throw new BuildHalt(`push ${label} failed: ${detail} — a row already exists at that id and no duplicate was created. The workspace still holds the local copy that push never recorded, and a re-run keeps it and halts here again. To reset it, ${RESET_WORKSPACE}, and re-run the build to adopt the existing row.`, { ...opts, code: 'already-exists', retry: RETRY.NEVER });
    }
    // No code at all is the bare 412 this guard was originally written for, and `VERSION_CONFLICT`
    // is the code the SDK actually attaches to one — both mean the artifact moved under us, and
    // re-downloading genuinely IS the remedy.
    //
    // `VERSION_CONFLICT` has to be named explicitly. Routing it to the generic branch below silently
    // DROPPED the re-download instruction from a real 412, and nothing caught that: the unit
    // fixtures here use a code-less error, and the real-bundle test never routes its result through
    // this function.
    if (!sdkCode || sdkCode === 'VERSION_CONFLICT') {
      throw new BuildHalt(`push ${label} failed: ${detail} — the artifact changed in Maker since it was fetched; re-download the app and rebuild (never overwrite a concurrent edit)`, { ...opts, code: 'version-conflict', retry: RETRY.NEVER });
    }
    // The SDK's own code is the halt's, and the halt follows the failure: a typed refusal (VALIDATION_ERROR, …) is final, a failure of the service (a 503 behind CONNECTION_ERROR) is run again.
    throw new BuildHalt(`push ${label} failed: ${detail}`, { ...opts, code: sdkCode, retry: retryPolicyFor(result.error) });
  }
  // A push can COMMIT and still be partially wrong, and the SDK reports that by value rather than
  // failing: an app whose components could not all be pinned, whose system-admin role assignment
  // failed (which yields an app nobody can open), or which saved but did not publish. The SDK's own
  // comment says these exist "so a create that produced an UNOPENABLE app is not read as a clean
  // success" — which is precisely what dropping them on the floor does.
  reportPartialPush(result, what, warn);
  return result;
}

// Surface the non-fatal half of a push/publish outcome. Never throws and never halts: the primary
// write committed, so the build should continue — but silence here turns a partial success into a
// reported clean one.
//
// The remediation hint is deliberately NOT "re-run with --publish". This runs for three different
// callers and that advice is only right for one of them: an explicit `publishArtifact` has already
// attempted the publish, and an app CREATE publishes inside the SDK, so telling either to pass a
// flag they effectively already used sends the operator in a circle. What is true for all three is
// that the save survived and the publish did not, so a re-run once the cause clears is the fix.
function reportPartialPush(result, what, warn) {
  if (!result || typeof warn !== 'function') return result;
  const label = what || result.type || 'artifact';
  const st = result.publish;
  // An adoption writes nothing, so there is nothing to confirm — but a build that quietly took over a row it
  // did not create this attempt would leave the operator unable to tell why the create was never logged.
  if (result.adoptedExisting === true) {
    warn(`${label} was already created by an earlier attempt whose answer was lost, and the row is exactly what this build would have written, so it was adopted — nothing was written again`);
  }
  if (st && st.kind === 'failed') {
    warn(`publish ${label} FAILED: ${(st.error && st.error.message) || 'unknown error'} — the change is SAVED but the runtime still serves the previously published copy; the build is idempotent, so re-run it once the cause is cleared`);
  } else if (st && st.kind === 'unverifiable') {
    warn(`publish ${label} could not be CONFIRMED (${st.reason}) — the publish call succeeded but the published projection was not read back, so treat "live" as unproven`);
  }
  for (const w of result.warnings || []) warn(`${label}: ${w}`);
  return result;
}

// Discover-then-create the solution + publisher (idempotent). No-op emit-wise if present.
async function provisionSolution({ sdk, provision, runner, solution }) {
  await runner.run('solution', `solution ${solution.uniqueName}`, async () => {
    const existing = await provision.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${odataLit(solution.uniqueName)}'`, top: 1 });
    if (existing && existing[0]) return;
    let publisherId;
    const pubs = await provision.queryRecords('publisher', { select: ['publisherid'], filter: `customizationprefix eq '${odataLit(solution.publisherPrefix)}'`, top: 1 });
    if (pubs && pubs[0] && pubs[0].publisherid) publisherId = pubs[0].publisherid;
    else publisherId = (await provision.createPublisher({ uniqueName: `${solution.publisherPrefix}publisher`, friendlyName: `${solution.publisherPrefix} publisher`, prefix: solution.publisherPrefix })).id;
    await provision.createSolution({ uniqueName: solution.uniqueName, friendlyName: solution.displayName || solution.uniqueName, publisherId, ...(solution.description ? { description: solution.description } : {}) });
  }, { recoverable: true });
}

// Resolve the AUTHORING language once, at transport level, before the maker SDK is constructed.
//
// #455: `MakerSdkOptions.languageCode` is a construction-time option — the App, Form and Dashboard
// adapters bake it in, so it must be known before `createMakerSdk`. But the default source for it is
// `organization.languagecode`, which the SDK itself would normally read. That circularity is why
// this reads over the transport hatch instead.
//
// Same precedence as `resolveLanguageCode`, and deliberately so: an explicit CLI flag, then the App
// Spec field, then the organization's base language, then 1033. The explicit branches are also
// checked against the provisioned set here, so the halt happens once — before the SDK exists and
// long before any label is written.
//
// `readOrg` / `provisionedLanguages` are injected for tests.
async function resolveAuthoringLanguage({ envUrl, languageCode, spec, warn, readOrg, provisionedLanguages }) {
  const readOrgLcid = readOrg || ((url) => readOrgLanguageCode(url));
  const probe = provisionedLanguages || (() => readProvisionedLanguages(envUrl));
  return await resolveLanguageCode({
    // resolveLanguageCode only needs `.queryRecords('organization', …)`; adapt the transport read to
    // that shape rather than duplicating the precedence ladder, so the two paths cannot drift.
    provision: {
      queryRecords: async (set) => {
        if (set !== 'organization') return [];
        const lcid = await readOrgLcid(envUrl);
        return lcid ? [{ languagecode: lcid }] : [];
      },
    },
    spec,
    languageCode,
    warn,
    provisionedLanguages: probe,
  });
}

// Discover-then-create global choices, tables, columns, status reasons, alternate keys,
// and relationships (idempotent). Returns captured maps used by sample data + later phases.
// Does this table already exist? Returns { logicalName, entitySetName } or null.
//
// Deliberately a NARROW `EntityDefinitions(LogicalName=…)` read rather than the SDK's `findTables`,
// and this is a correctness requirement rather than an optimisation. LIVE-MEASURED, order-controlled
// (8 tables, sequence C,F,F,C,C,F,F,C so each arm appears early and late): calling `findTables`
// before `createTable` makes Dataverse store ONLY the base-language label of a multi-language name —
// `create only` kept both languages 4/4, `findTables + create` kept both 0/4. The outgoing
// EntityDefinitions body is byte-identical in both cases, so the loss is caused by the preceding
// unfiltered metadata read, not by the create payload.
//
// Without this the localized-label feature silently degrades to English-only on the real build path
// while every unit test (which never issues the preceding read) passes — the exact silent-drop class
// of failure AB#6686428 exists to end.
//
// `dataverse.get` RESOLVES with `{ status }` on a 404 instead of throwing, so the status is checked
// explicitly. Falls back to `findTables` when the raw client is unavailable (older callers and
// unit-test doubles) or when the narrow read is INCONCLUSIVE — with one exception, below.
//
// `hasLocalizedLabels` closes the gap that fallback would otherwise leave open. `findTables` can
// safely prove PRESENCE (a hit means we reuse the table and no create follows, so nothing is
// poisoned), but a MISS is followed immediately by `createTable` — with the poisoning read already
// on the wire. So for an entity whose labels ARE localized, an inconclusive probe is never resolved
// by `findTables`: the narrow read is retried, and if it stays inconclusive the build HALTS rather
// than silently shipping an English-only table. Same fail-closed rule as the unprovisioned-language
// check above, and for the same reason: by the time a warning is read the table already exists, and
// fixing a label after the fact is a manual job.
async function findExistingTable(provision, schemaName, { hasLocalizedLabels = false, attempts = 3 } = {}) {
  const logical = String(schemaName).toLowerCase();
  const raw = provision && provision.dataverse;
  if (raw && typeof raw.get === 'function') {
    const escaped = logical.replace(/'/g, "''");
    const url = `/EntityDefinitions(LogicalName='${escaped}')?$select=LogicalName,EntitySetName`;
    // Retried only for a LOCALIZED entity, where the alternative to a conclusive answer is a halt.
    // For everything else one attempt then `findTables` is both cheaper and exactly the old
    // behaviour.
    const tries = hasLocalizedLabels ? Math.max(1, attempts) : 1;
    let lastWhy = 'unknown';
    // What the last read was: the error it threw, or the status it answered. The halt below follows it — a 429 or a 503 is the service's to ride out, a refusal is not.
    let lastFailure;
    let lastStatus;
    for (let i = 0; i < tries; i += 1) {
      // Wrapped like its `findExistingColumns` sibling. The client resolves `{status}` for a 404 and
      // even a persistent 5xx, and throws only on a persistent TRANSPORT error; letting that
      // propagate here would abort the build on a blip the fallback might well survive.
      let res = null;
      lastFailure = undefined;
      try { res = await raw.get(url); } catch (err) { res = null; lastFailure = err; lastWhy = (err && err.message) || String(err); }
      if (res && res.status >= 200 && res.status < 300 && res.body && res.body.LogicalName) {
        return { logicalName: String(res.body.LogicalName).toLowerCase(), entitySetName: res.body.EntitySetName };
      }
      if (res && res.status === 404) return null;
      if (res) { lastWhy = `HTTP ${res.status}${res.body && res.body.LogicalName === undefined && res.status < 300 ? ' with no LogicalName in the body' : ''}`; lastStatus = res.status; }
    }
    if (hasLocalizedLabels) {
      throw new BuildHalt(
        `could not determine whether table '${logical}' already exists (${lastWhy}), and its labels are localized. `
        + 'Resolving this by the broad metadata read the build normally falls back to is what makes Dataverse store '
        + 'ONLY the base-language label (live-measured, 0/4 vs 4/4), so the build stops here instead of silently '
        + 'creating an English-only table. Re-run once the environment answers metadata reads.',
        {
          phase: 'data-model',
          code: 'table-probe-inconclusive',
          recoverable: true,
          // The halt quotes the table's name and the last read's words; what decides is the read: the error it threw, or the status and the words of the answer.
          ...(lastFailure ? { cause: lastFailure, retry: retryPolicyFor(lastFailure) } : { retry: RETRY.SERVICE, retryText: lastWhy, ...(lastStatus ? { statusCode: lastStatus } : {}) }),
        },
      );
    }
    // Any other status is inconclusive — fall through to findTables rather than assume "absent",
    // because assuming absent turns a transient read failure into a duplicate-create attempt.
  }
  if (typeof (provision && provision.findTables) !== 'function') return null;
  // The fallback is a read of the whole table list, and its answer decides between "reuse" and "create": `findTables`
  // reads a 2xx that is no list of tables (a sign-in or proxy page, `{}`, `null`) as "no tables", so — the narrow read
  // having been inconclusive too — a table that exists would be created again. lib/maker-sdk.js refuses such an answer
  // (TABLES_UNREADABLE), and that is as inconclusive as the narrow read was: the build stops here, before any create, as
  // it does for a localized table above; a plan reads it as `unknown`. Any other failure of the read is the read's own.
  let hits;
  try {
    hits = await provision.findTables(schemaName, { top: 50 });
  } catch (err) {
    if (!unreadableAnswer(err)) throw err;
    // `retry: NEVER`: the platform answered with a success that is no list of tables (a sign-in or proxy page, `{}`, `null`) — a verdict a run again a few seconds later reads
    // the same way, and the remedy, signing in again, is the maker's (the failure says so). The table's name is in the message, and is not what decides.
    throw new BuildHalt(`could not determine whether table '${logical}' already exists: ${err.message}`, { phase: 'data-model', code: 'table-list-unreadable', recoverable: true, cause: err, retry: RETRY.NEVER });
  }
  return (hits || []).find((t) => t.logicalName === logical) || null;
}

// The data-model phase (provisionDataModelSteps) and then — whatever the steps did, a halt included — the step that has to come after
// every labelled create of it: setting the primary name column's length of each table the phase owes one (payOwedLengths) and, when
// the steps did not halt, creating the alternate keys that were waiting for those lengths (createWaitingKeys).
//
// Last, because that step's read carries labels, and nothing labelled in more than one language may be created after a read like that
// (see alignPrimaryNameLength). A key that waits goes out with ONE label, in one language (keyWaitsForNameLength), which a read has nothing to strip.
//
// What the phase owes is `owedLengths`, a Map from a table's logical name to
//   { table, column, asked, tried, tableId, columnId? }
// — the names, the length asked, and the MetadataId of the table the attempt created and, when that attempt read the column before its step
// failed, of the column. The ids are what tell the table that was created from another that comes to answer to the same name: the build
// pauses between two attempts, and another maker can replace the table in that time, which the build must not shorten. A debt an earlier attempt
// carried is therefore proved to be this table's (checkOwedTable) and paid by requests addressed with those ids (alignPrimaryNameLength), which
// a table made again under the name cannot answer to.
// A table THIS run creates whose spec asks for a length goes in the Map the moment it exists and comes out once its length is right; a table
// an earlier attempt of the same build created and did not finish is in it when the phase starts (runSdkBuild reads it from the halt of that
// attempt, and the build's retry hands it on — the way what an attempt owes for the views it saved is carried, see build-model-app.js).
// `tried` says that this attempt's step ran for the table and did not come right, so a build that stops for good does not try it
// again (settleOwedLengths). A caller that passes no Map gets one of its own and throws it away: one attempt, and nothing to carry.
//
// Also on a halt, because the length is set only for a table the build created: a run in a new process finds the table and leaves an
// existing table's name column as it is (a rebuild must not shorten a column that may hold data), so a table created by a run that
// then halted — a relationship refused, a column rejected, a lock that outlasted the retries — would keep the length the environment
// made of the create for good. A table this run did not create, or found after a create whose answer was lost, is never owed
// (provisionDataModelSteps). alignPrimaryNameLength does not throw — a step that cannot set the length is a failed, warned step — so
// it cannot replace the error that stopped the phase.
async function provisionDataModel(args) {
  const owed = args.owedLengths instanceof Map ? args.owedLengths : new Map();
  // The tables an EARLIER attempt left unset, as the phase found them: one this attempt creates again is not among them.
  const carriedIn = new Set(owed.keys());
  const waitingKeys = [];
  let result;
  try {
    result = await provisionDataModelSteps(args, { owed, carriedIn, waitingKeys });
  } catch (err) {
    await payOwedLengths(args, owed, carriedIn, { halted: true, waitingKeys });
    throw err;
  }
  const outcomes = await payOwedLengths(args, owed, carriedIn, { halted: false, waitingKeys });
  await createWaitingKeys(args, waitingKeys, outcomes);
  return result;
}

// Sets the primary name column length of every table the phase owes one, in table order — the length steps are the last the phase
// takes — and answers what each came to: `Map<logical name, { ok, error?, left? }>`, for the keys that wait for them. A table whose length
// is right comes out of `owed`; so does one that turned out not to be the table the debt was recorded for (`left`: it is left alone, see
// checkOwedTable — only a debt an earlier attempt carried is held to that); one whose step failed stays in it, marked `tried`, with the
// id of the column when the step read it — and so does one whose step the runner stopped before it began, which is not `tried`: nothing has run for it. A debt for a table whose spec asks for no length (the spec cannot change within one build, so
// this is a record that does not match it) is dropped, and said if it was carried; one for a table the spec does not declare is left
// alone: it is not this phase's. `waitingKeys` are the keys that wait for the steps, which the warning of a step that fails names.
async function payOwedLengths({ runner, sdk, provision, spec, warn, sleep }, owed, carriedIn, { halted, waitingKeys }) {
  const outcomes = new Map();
  for (const entity of (spec && spec.entities) || []) {
    const logical = entity.schemaName.toLowerCase();
    const debt = owed.get(logical);
    if (!debt) continue;
    const carried = carriedIn.has(logical);
    const asked = askedPrimaryNameLength(entity);
    if (asked === undefined) {
      owed.delete(logical);
      if (carried && typeof warn === 'function') warn(keptWarning(logical, debt, 'the spec no longer asks the table\'s name column for a length'));
      continue;
    }
    debt.tried = true;
    const keys = waitingKeys.filter((waiting) => waiting.logical === logical).map((waiting) => waiting.key.schemaName);
    const outcome = await alignPrimaryNameLength({ runner, sdk, provision, entity, logical, asked, warn, sleep, halted, debt, carried, keys });
    if (outcome.ok || outcome.left) owed.delete(logical);
    else {
      if (outcome.columnId) debt.columnId = outcome.columnId;
      // A step the runner stopped before it began has tried nothing, so the debt is still one that a build which stops for good pays (settleOwedLengths repeats no step that has run and said what became of it).
      if (outcome.notStarted) debt.tried = false;
    }
    outcomes.set(logical, outcome);
  }
  return outcomes;
}

// One alternate key: a narrated step. The SDK has no key lister, so a re-run that finds the key already there gets an
// already-exists answer, which is a skip and not a halt. The same step wherever the key is made — with its table, or after the
// length of the table's name column (createWaitingKeys).
function alternateKeyStep({ runner, sdk, entity, logical, key, languageCode }) {
  return runner.run('data-model', `alt key ${entity.schemaName}.${key.schemaName}`,
    () => sdk.createAlternateKey(logical, { schemaName: key.schemaName, displayName: key.displayName || key.schemaName, keyAttributes: (key.columns || []).map((x) => x.toLowerCase()), languageCode }),
    { recoverable: true, skipIf: isAlreadyExists });
}

// An alternate key over the name column of a table whose length is still to be set that cannot wait for it, because its label goes out in
// several languages (keyWaitsForNameLength): it is made where it always was, ahead of the length step, so that the read that carries
// labels, which setting the length starts with, does not come before a create that carries several languages. Where the platform then
// refuses it — a key may hold at most 1,700 bytes, which a name column of the 850 characters some environments give a new table fills by
// itself — the build says why this key was made first and what to do, because the platform's refusal says nothing of the length. The build
// sets the length as the last step before it stops (provisionDataModel), so the run that follows finds the table with it, and makes the key
// where that length leaves room for it.
// Said only when the key fails: where the environment keeps the length asked the key is made, and nothing is wrong. What reaches here is
// a key that was not known to be too large — a key over the name column alone fits even at 850 characters, and a read of the length that
// failed leaves a key that would not fit as undecided (keyMustWaitForShorterNameColumn) — or one the platform refused for another reason.
// What the warning tells the reader to do follows from the size the key has at the length the spec asks, counted from its columns as the build
// creates them (keyBytesAtLeast) — a floor. Where even the floor is over what a key may hold, the key is proven too large: setting the length makes
// no room for it — which is why it was not made after the step (keyHasRoomOnlyAfterLength) — and the run that follows is refused as this one was,
// so the warning says that, with the bytes. Where the floor is within the limit, nothing is proven either way: the floor counts a column that is
// not text, or that the spec does not describe, at one byte, which the platform may exceed (a name column of 849 characters beside an Integer
// column counts 1,699 bytes, and is refused), and an environment may allow less than the 1,700 bytes measured. So the warning promises nothing
// there: a run again may create the key, if the length the spec asks leaves room for it, and where that run is refused the same way, the
// platform's error and the sizes of the key's columns say why. A label in one language is not offered as a way out: it changes where a key is
// made, not its size.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/define-alternate-keys-entity#create-alternate-keys
async function alternateKeyAheadOfLength({ runner, sdk, entity, logical, key, languageCode, warn }) {
  try {
    await alternateKeyStep({ runner, sdk, entity, logical, key, languageCode });
  } catch (err) {
    if (typeof warn === 'function') {
      const column = String(entity.primaryAttribute.schemaName).toLowerCase();
      const asked = askedPrimaryNameLength(entity);
      // Said from the languages the label goes out in, which is what keeps the key from waiting. A key that does not wait is a map that does not
      // name exactly one language, and only one that names several can get here: the SDK refuses an empty map before it sends anything.
      const languages = Object.keys(key.displayName);
      const named = languages.length > 1 ? `in several languages (${languages.join(', ')})` : 'a language map that does not name exactly one language';
      const atAsked = keyBytesAtLeast(entity, key, asked);
      const limit = KEY_BYTES_LIMIT.toLocaleString('en-US');
      const whatToDo = atAsked > KEY_BYTES_LIMIT
        ? `It cannot fit at that length either: with ${column} at ${asked} characters the key's columns take at least ${atAsked.toLocaleString('en-US')} bytes, `
          + `and a key may hold at most ${limit}, 2 for each character of text — so running the build again does not create it. `
          + 'Take a column out of the key, or make its text columns shorter.'
        : 'If the platform refused it for its size — a key may hold '
          + 'at most 1,700 bytes, 2 for each character of text, so the 850 characters some environments make of a new name column fill it by themselves, and no other column fits beside it — '
          + `the length is set as the build stops, so running the build again may create the key: it does if ${column} at ${asked} characters leaves room for it. `
          + `That is not certain: the build counts at least ${atAsked.toLocaleString('en-US')} bytes for the key at that length — one byte for a column that is not text, `
          + `or that the spec does not describe — and the platform may count more, or allow less than the ${limit} bytes measured. `
          + 'If the next run is refused the same way, compare the platform\'s error with the sizes of the key\'s columns, and take a column out of the key or make its text columns shorter.';
      warn(
        `alt key ${entity.schemaName}.${key.schemaName} was not created. It is over the name column ${column} of a table this build created, and its label is ${named}, `
        + `so the build creates it before it sets that column to ${asked} characters `
        + `(setting the length reads the column with its labels, which would keep only one of the languages). ${whatToDo}`,
      );
    }
    throw err;
  }
}

// Whether a key labelled in several languages over the name column of a table whose length is still to be set must wait for that step all the
// same: the environment made the column too long for the key to fit beside the others, so the platform would refuse it ahead of the step, and
// shortening the column is the one thing that changes its answer. The platform's refusal is HTTP 400, code 0x80060895, "Index size exceeded the size
// limit of 1700 bytes" (KEY_BYTES_LIMIT, lib/app-spec.js), and it stopped the first build at the key, for the run that followed to make it.
//
// Decided from the length the environment made of the column — 850 characters where it ignores the length asked of the table's create
// (DEFAULT_PRIMARY_NAME_LENGTH), which is every byte a key may hold, the length asked where it keeps it — read with one typed request that selects MaxLength
// and nothing else (readTextColumn): no labels, the kind of read this build keeps ahead of its labelled creates, which does not do to the key what the read that
// carries labels, at the length step, would. A read is made only for a key that the spec shows can be in that position at all (keyHasRoomOnlyAfterLength): a
// key over the name column alone fits even at 850 characters, and a key that cannot fit at the length asked either would be refused after the step as well.
//
// Nothing else changes for such a key: it is the one key labelled in several languages that is made after a read that carries labels, which is what the rule that
// keeps the others ahead of the step avoids — and it is made there only because the platform leaves no other way to make it. Measured live, a key made right after
// that read keeps both of its labels (the SDK's update of the column, then its create of the key).
//
// A read that fails answers no: the key is asked for where it always was, and the platform decides, as it did before the build read the column.
async function keyMustWaitForShorterNameColumn({ provision, entity, logical, key, sleep }) {
  if (!keyHasRoomOnlyAfterLength(entity, key)) return false;
  try {
    const { maxLength } = await readTextColumn(provision, logical, String(entity.primaryAttribute.schemaName).toLowerCase(), { sleep });
    return keyCannotFitAt(entity, key, maxLength);
  } catch {
    return false;
  }
}

// The alternate keys that waited for their table's name column length (keyWaitsForNameLength, keyMustWaitForShorterNameColumn), in the order the phase met them, made
// once every length step has run. A key whose table's step did not come right is not asked for: the platform may refuse it for the
// length it is left at — a key may hold at most 1,700 bytes, which a name column of 850 characters fills by itself — in words that say
// nothing of the length, and the step that failed has already said why in its own. So the key is a failed step of its own, naming
// both, and the build stops there as it does for a key the platform refuses. A table that turned out not to be the one the length was
// owed for (`left`, see checkOwedTable) is not one the build set the length of at all: its key is made as the key on any table the build
// found is, and the platform decides.
//
// That stop is retried when the step failed the way a build's retry rides out (a 429, a lock, a 503) and not otherwise: it is a halt
// raised with the step's failure as its cause and the policy that failure gives (`retry: retryPolicyFor(…)`, lib/retry-policy.js), so the
// build's check (isTransientHalt, build-model-app.js) judges the failure of the step — the status it carries (and the status the step
// failed with, which the halt declares), the code of the service's answer, a reset, an explicit "never retry" — and never the halt's own
// words or code. The retry then finds the length still owed (`owedLengths`), sets it, and makes the key.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/define-alternate-keys-entity#create-alternate-keys
async function createWaitingKeys({ runner, sdk }, waitingKeys, outcomes) {
  for (const { entity, logical, key, languageCode } of waitingKeys) {
    const outcome = outcomes.get(logical);
    if (outcome && !outcome.ok && !outcome.left) {
      const column = String(entity.primaryAttribute.schemaName).toLowerCase();
      const asked = askedPrimaryNameLength(entity);
      const why = (outcome.error && outcome.error.message) || String(outcome.error);
      // A halt, not an error with a code of its own: the build's retry takes an error's `code` for a refusal of that kind and reads nothing under it
      // (lib/retry-policy.js), while a halt's code only names it. So the stop follows the step's failure, which it carries as its cause.
      const chain = causeChain(outcome.error);
      const status = chain.map((e) => e.statusCode || e.status).find(Boolean);
      const halt = new BuildHalt(
        `alt key ${entity.schemaName}.${key.schemaName} was not created: it is over the name column ${column}, whose length the build could not set to ${asked} (${why}) — `
        + 'a key may hold at most 1,700 bytes, 2 for each character of text, and a name column left at the 850 characters some environments give a new table fills that by itself, so Dataverse refuses a key that holds any other column beside it. '
        + `Nothing was sent for the key. Set ${column} to ${asked} characters in Maker, or clear the cause above, then run the build again: it creates the key.`,
        { phase: 'data-model', code: 'alt-key-name-length-not-set', recoverable: true, cause: outcome.error, retry: retryPolicyFor(outcome.error), ...(Number.isInteger(status) ? { statusCode: status } : {}) },
      );
      await runner.run('data-model', `alt key ${entity.schemaName}.${key.schemaName}`, async () => { throw halt; }, { recoverable: true });
    }
    await alternateKeyStep({ runner, sdk, entity, logical, key, languageCode });
  }
}

// What a build that stops for good — no retry follows — still owes for name column lengths: the tables its attempts created, whose
// length no attempt got as far as setting (`debts`: the records a halt carries, see provisionDataModel; one with `tried` was set about
// by an attempt, whose step has said what became of it, and is not repeated). One more try, best-effort: a step that cannot set the
// length is a warning, the way it is in the phase, and never replaces the halt the caller is about to report. Not narrated, like the
// publishes settled in the same place (settleOwedPublishes, sdk-build.js). Each debt is paid like the one the retry pays — to the table
// it was recorded for and to no other (checkOwedTable): a table that turned out not to be that one is left as it is, and said.
async function settleOwedLengths({ sdk, provision, spec, owed, warn, sleep } = {}) {
  const debts = (Array.isArray(owed) ? owed : []).filter((debt) => debt && typeof debt === 'object' && typeof debt.table === 'string' && debt.tried !== true);
  if (!debts.length) return;
  const runner = makeRunner({ emit: () => undefined, total: 0 });
  for (const debt of debts) {
    const entity = entityByLogical(spec || {}, debt.table);
    const asked = askedPrimaryNameLength(entity);
    if (!entity || asked === undefined) continue;
    try {
      await alignPrimaryNameLength({ runner, sdk, provision, entity, logical: debt.table.toLowerCase(), asked, warn, sleep, halted: true, debt, carried: true });
    } catch { /* alignPrimaryNameLength does not throw; and nothing here may replace the halt */ }
  }
}

// `owed` is the Map provisionDataModel keeps (see there): this attempt's tables whose length is to be set, and those an earlier attempt
// left unset. `carriedIn` is the set of the second kind as the phase found them; `waitingKeys` collects the alternate keys that wait for
// a length step, for createWaitingKeys to make once the steps have run.
async function provisionDataModelSteps({ sdk, provision, runner, spec, apply, languageCode, warn, provisionedLanguages, preResolvedLanguageCode, sleep, reconcileLookupLabels = false, inlineColumns = true }, { owed, carriedIn, waitingKeys }) {
  // `lookupLabels` records the label each spec lookup column carries once this phase is done
  // (`<referencing>|<lookup logical>` -> { label }), so a later phase that repairs something derived
  // from it — an existing form's cell label — repairs it to what the column now says.
  const result = { entities: {}, globalChoiceIds: {}, statusReasonValues: {}, columns: {}, relationships: [], lookupLabels: {} };
  // The CLI resolves the authoring LCID BEFORE constructing the SDK, because
  // `MakerSdkOptions.languageCode` is a construction-time option (#455) — the App/Form/Dashboard
  // adapters bake it in. Re-resolving here would repeat the org read and the provisioned-languages
  // probe, and could disagree with the value the SDK is already stamping into FormXML and sitemap
  // titles. So an already-resolved value wins outright. The self-resolving path stays for callers
  // that construct the SDK themselves and for the existing unit tests.
  const resolvedLanguageCode = preResolvedLanguageCode
    || await resolveLanguageCode({ provision, spec, languageCode, warn, provisionedLanguages });

  // Before any write: refuse a localized label naming a language this org has not provisioned.
  // Dataverse would accept it and silently keep only the provisioned label (live-measured), so this
  // must run ahead of the first createTable rather than as a post-hoc verify.
  await checkLocalizedLabelLanguages(spec, provisionedLanguages);

  const globalChoiceIds = result.globalChoiceIds;
  const statusReasonValues = result.statusReasonValues;
  // The declared tables (lower-case logical names) this run found already in the environment, as opposed
  // to the ones it created. A lookup to one that sets no displayName of its own is named by the
  // environment (lookupParentNeedsEnvironment), which only the table loop below can know.
  const reusedTables = new Set();

  // 2a. Global option sets (shared choices) — built before columns that bind to them. The SDK's
  // createGlobalOptionSet is now IDEMPOTENT: it probes by Name and REUSES an existing set (returning
  // its MetadataId) instead of failing a duplicate-Name POST. So a rerun captures the existing set's
  // id here — fixing the old bug where the catch swallowed "already exists" and left the id undefined,
  // which forced every column on a rebuild to fall back to inline options (roadmap: global-choice
  // find-by-name). A GENUINE failure (400 validation / auth) now surfaces as a clean phase failure via
  // runner.run instead of being silently swallowed.
  for (const gc of spec.globalChoices || []) {
    await runner.run('data-model', `global choice ${gc.name}`, async () => {
      const r = await sdk.createGlobalOptionSet({ name: gc.name, displayName: gc.displayName || gc.name, languageCode: resolvedLanguageCode, ...(gc.description ? { description: gc.description } : {}), options: (gc.options || []).map((label, i) => ({ value: 100000000 + i, label })) });
      globalChoiceIds[gc.name] = r.metadataId;
    });
  }

  // 2b. Tables -> columns (all types + customer) -> status reasons -> alternate keys.
  for (const e of spec.entities) {
    const logical = e.schemaName.toLowerCase();
    // Whether THIS entity carries any localized label. It decides whether an inconclusive existence
    // probe may be resolved by the broad `findTables` read — safe for a plain-label entity, poisoning
    // for a localized one. See findExistingTable.
    const entityIsLocalized = localizedLabelLcidsInSpec({ entities: [e] }).length > 0;
    const hits = await findExistingTable(provision, e.schemaName, { hasLocalizedLabels: entityIsLocalized });
    const existingTable = hits;
    // Every buildable column: all scalar types + Customer (a Lookup comes from a relationship).
    const buildable = (e.columns || []).filter((c) => SDK_COLUMN_TYPE[c.type || 'Text'] || c.type === 'Customer');
    // The new table's ordinary columns are created together, in ONE change set right after the table, when the SDK has
    // `createColumns` and a read can confirm them afterwards (createColumnsInOneRequest). `inlineColumns: false` is the
    // one-request-per-column path, which is also the oracle the table-columns-in-create tests compare to.
    const inlineEnabled = inlineColumns !== false && !!sdk && typeof sdk.createColumns === 'function'
      && !!provision && !!provision.dataverse && typeof provision.dataverse.get === 'function';
    // Which of the columns that went in the change set the table was then confirmed to have, keyed by the column object (never
    // by its name: two columns of a spec can share one, and only the one that went in the request was created by it), each with
    // the id createColumn would have returned.
    let inlineConfirmed = new Map();
    let existingCols = new Set();
    let existingColRows = [];
    // The spec's primary name column length is asked in the table's own create. For a table THIS build creates (`createdTable`) it
    // is then read back and set where the environment did not keep it — at the end of the phase, once nothing labelled is left to
    // create (provisionDataModel, alignPrimaryNameLength) — and the table is owed that step until it is done, across the attempts
    // of a build that retries (`owed`, `carriedIn`). It is never WRITTEN for a table the build did not create: an existing
    // table's column is left as it is, and so is one found after a create whose answer was lost, where nothing shows that this
    // build, and not someone else, made it — but the length of that one is read, and a difference from the spec's is reported
    // (reportFoundPrimaryNameLength).
    let createdTable = null;
    let foundAfterCreate = false;
    const askedLength = askedPrimaryNameLength(e);
    if (existingTable) {
      runner.skip('data-model', `table ${e.schemaName} (exists — reuse)`);
      reusedTables.add(logical);
      result.entities[e.schemaName] = { logicalName: logical, entitySetName: existingTable.entitySetName };
      existingColRows = await findExistingColumns(provision, logical, warn);
      existingCols = new Set(existingColRows.map((c) => String(c.logicalName || c.schemaName || '').toLowerCase()));
    } else {
      await runner.run('data-model', `table ${e.schemaName}`, async () => {
        // `displayName` / `pluralName` / `primaryColumnDisplayName` are passed THROUGH unflattened: a
        // plain string emits one label at `resolvedLanguageCode`, and an LCID map emits one per
        // language (AB#6686428 — measured on the wire against the vendored bundle). The English
        // plural fallback is only reachable for a STRING displayName; validateAppSpec requires an
        // explicit `pluralName` beside a localized one, because appending "s" is not a plural rule
        // outside English and would write "Línea base del proyectos" into Dataverse.
        //
        // The schema-name fallback is NOT cosmetic. `displayName` is optional in the App Spec — the
        // validator accepts an omitted or blank one, exactly as it does for a column — and every
        // other create site here already falls back (`c.displayName || c.schemaName` for columns,
        // customer columns and alternate keys). The table was the one that did not, and handing the
        // SDK `undefined` throws inside its label builder with `Cannot convert undefined or null to
        // object` BEFORE any request is issued — an opaque failure with nothing naming the table or
        // the field. MEASURED against the real vendored bundle; `''` gets past it but would label the
        // table blank. A localized MAP must pass through untouched, so it is never routed through
        // `labelText`, which would flatten it to one language.
        const tableDisplayName = isLocalizedLabelMap(e.displayName)
          ? e.displayName
          : (labelText(e.displayName, resolvedLanguageCode) || e.schemaName);
        const createOpts = { schemaName: e.schemaName, displayName: tableDisplayName, pluralName: e.pluralName || `${labelText(tableDisplayName, resolvedLanguageCode) || e.schemaName}s`,
          primaryColumnSchemaName: e.primaryAttribute.schemaName, primaryColumnDisplayName: e.primaryAttribute.displayName || 'Name', hasNotes: e.hasNotes === true, languageCode: resolvedLanguageCode,
          // Always sent, so a later change of the SDK's own default cannot change what a spec without a length gets — see
          // DEFAULT_PRIMARY_NAME_LENGTH.
          primaryColumnMaxLength: primaryNameLength(e.primaryAttribute) };
        // AutoNumber the primary/title column when requested (the order number IS the identity).
        if (e.primaryAttribute.autoNumberFormat) createOpts.primaryColumnAutoNumberFormat = e.primaryAttribute.autoNumberFormat;
        // The name column's requirement level, when the spec states one (an omitted `required` sends nothing, as before). The create alone
        // does not keep it on a plain text name column (measured on Dataverse 9.2.26101: stored not required whatever is sent, while an
        // auto-numbered one keeps it), so the SDK reads the level back after the create, sets it with one update where it differs, reads it
        // again and answers it as `primaryColumnRequired`; a level it cannot confirm is PRIMARY_COLUMN_REQUIRED_NOT_APPLIED (createNewTable).
        // The update is a PUT, which the SDK refuses to leave unmade: without one on the HTTP client it refuses before it creates anything.
        if (hasExplicitRequired(e.primaryAttribute)) createOpts.primaryColumnRequired = REQUIRED(e.primaryAttribute);
        // Same reasoning as columns: set the description at CREATE time, and omit it when absent so
        // a rebuild never blanks a description someone added in the maker.
        if (e.description) createOpts.description = String(e.description);
        try {
          const t = await createNewTable(sdk, createOpts, { warn, askedLength });
          result.entities[e.schemaName] = { logicalName: (t.logicalName || logical), entitySetName: t.entitySetName, metadataId: t.metadataId };
          createdTable = t;
        } catch (err) {
          // The SDK says of this refusal that the table WAS created. What its cause carries — a 409 from the update, a word in the platform's reason —
          // is no sign that the table's name is taken, so it is never taken for an already-exists answer and "rediscovered".
          if (err && err.code === 'PRIMARY_COLUMN_REQUIRED_NOT_APPLIED') throw err;
          if (!isAlreadyExists(err)) throw err;
          // First POST likely succeeded server-side; a transient-network retry hit "already exists".
          // Rediscover to capture entitySetName (required by later phases). No poisoning concern
          // here whatever the labels are — the table now EXISTS, so no create follows this read.
          const found = await findExistingTable(provision, e.schemaName);
          if (!found) throw err;
          result.entities[e.schemaName] = { logicalName: logical, entitySetName: found.entitySetName };
          foundAfterCreate = true;
        }
      }, { recoverable: true });
    }
    // The primary name column's length, when the spec asks for one: one narrated step in every case (the plan counts it). For a
    // table this build created the step is queued here and runs at the end of the phase (provisionDataModel) — a label-bearing
    // read must not come before a labelled create. The same for a table an EARLIER attempt of this build created and left
    // unset (`carriedIn`): the length is owed, and the step is the same one, said to be owed. For a table found after its create the
    // length is read and compared here, and for a table that existed before the step is a skip.
    //
    // `lengthPending` says the step is still to run for the table, which is what makes its alternate keys over the name column wait.
    let lengthPending = false;
    if (askedLength !== undefined) {
      if (createdTable) {
        // The table this attempt made owes its length from now on, whatever an earlier attempt owed for a table of that name. The record
        // keeps the MetadataId the create answered, which tells this table from another that comes to answer to the same name (checkOwedTable);
        // the column's id is added by the step, if it reads the column and cannot finish.
        carriedIn.delete(logical);
        const tableId = guidOf(createdTable.metadataId);
        owed.set(logical, { table: logical, column: String(e.primaryAttribute.schemaName).toLowerCase(), asked: askedLength, tried: false, ...(tableId ? { tableId } : {}) });
        lengthPending = true;
      } else if (carriedIn.has(logical)) {
        lengthPending = true;
      } else if (foundAfterCreate) await reportFoundPrimaryNameLength({ runner, provision, entity: e, logical, asked: askedLength, warn, sleep });
      else runner.skip('data-model', `primary column length ${e.schemaName}.${e.primaryAttribute.schemaName} (table exists — kept)`);
    }
    // Enable "Allow quick create" on the table when the spec opts in (explicit `entities[].quickCreate`
    // OR an authored `formType: 'QuickCreate'` form — see quickCreateEnabledFor). Runs for BOTH a fresh
    // and an existing table and is idempotent: `IsQuickCreateEnabled` is a plain Edm.Boolean flag, so
    // re-PUTting the same value is a Dataverse no-op. The flag alone does NOT author a form — a table
    // with a Quick Create form (the build authors those via formType) needs this flag for the inline
    // "+ New" (from a lookup / sub-grid) to surface that form instead of coming up empty.
    if (quickCreateEnabledFor(spec, e)) {
      await runner.run('data-model', `enable quick create on ${logical}`, async () => {
        await sdk.updateTable(logical, { quickCreateEnabled: true });
      });
    }
    // A table THIS build created gets its ordinary columns in one change set (createColumnsInOneRequest). A table found after its
    // create is not given one: nothing shows what it already holds, and the per-column path below skips what exists.
    if (createdTable && inlineEnabled) {
      const inlineSet = inlineColumnsOf(buildable, { primaryName: e.primaryAttribute && e.primaryAttribute.schemaName, tableLogical: logical });
      if (inlineSet.length) {
        inlineConfirmed = await createColumnsInOneRequest({
          sdk,
          provision,
          table: { metadataId: createdTable.metadataId, logicalName: createdTable.logicalName || logical },
          tableSchemaName: e.schemaName,
          columns: inlineSet,
          optionsFor: (c) => columnOptions(c, globalChoiceIds, spec.globalChoices, resolvedLanguageCode),
          warn,
          sleep,
          // A runner without the check (a stand-in for one) never stops here.
          stop: typeof runner.stopIfRefused === 'function' ? () => runner.stopIfRefused('data-model') : undefined,
        });
      }
    }
    // columns: every buildable column (all scalar types + Customer; Lookup comes from a
    // relationship). Existing ones emit a skip; missing ones are created SERIALLY: Dataverse
    // takes a per-entity exclusive [EntityCustomization] lock, so two Attribute POSTs on the
    // same table collide with HTTP 429 ("Cannot start another [EntityCustomization]..."). The
    // outer entity loop is already sequential, so serial columns here means one metadata
    // customization is in flight per entity at a time — the only order Dataverse permits. A column the change set above
    // created needs no request of its own: its step is narrated here, in spec order, with the id the read-back gave it.
    const requiredDeclared = [
      e.primaryAttribute,
      ...buildable,
    ].filter((c) => c && c.schemaName && hasExplicitRequired(c));
    const capabilityDeclared = buildable.filter((c) => c.type !== 'Customer'
      && (c.defaultValue !== undefined || c.integerFormat !== undefined
        || c.isValidForCreate !== undefined || c.isValidForUpdate !== undefined || c.isValidForRead !== undefined));
    for (const c of buildable) if (existingCols.has(c.schemaName.toLowerCase())) runner.skip('data-model', `column ${e.schemaName}.${c.schemaName} (exists)`);
    const toCreate = buildable.filter((c) => !existingCols.has(c.schemaName.toLowerCase()));
    const colResults = await runner.mapLimit(toCreate, 1, (c) => runner.run('data-model', `column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`,
      () => inlineConfirmed.get(c) || (c.type === 'Customer'
        ? sdk.createCustomerColumn(logical, { schemaName: c.schemaName, displayName: c.displayName || c.schemaName, required: REQUIRED(c), languageCode: resolvedLanguageCode })
        : sdk.createColumn(logical, columnOptions(c, globalChoiceIds, spec.globalChoices, resolvedLanguageCode))),
      { skipIf: isAlreadyExists }));
    if (existingTable) {
      const existingColMeta = new Map(existingColRows.map((c) => [String(c.logicalName || c.schemaName || '').toLowerCase(), c]));
      const requiredTargets = requiredDeclared.filter((c) => existingCols.has(c.schemaName.toLowerCase()));
      const requiredLevels = new Map();
      for (const c of requiredTargets) {
        const current = columnRequiredLevel(existingColMeta.get(c.schemaName.toLowerCase()));
        if (current) requiredLevels.set(c.schemaName.toLowerCase(), current);
      }
      const missingLevels = requiredTargets.filter((c) => !requiredLevels.has(c.schemaName.toLowerCase()));
      if (missingLevels.length) {
        try {
          for (const [name, level] of await readAttributeRequiredLevels({ sdk, provision, logical })) {
            requiredLevels.set(name, level);
          }
        } catch (err) {
          if (typeof warn === 'function') {
            warn(`could not read required levels for ${logical}: ${(err && err.message) || err} — existing columns with explicit required values were left unchanged`);
          }
        }
      }
      const toUpdateRequired = [];
      for (const c of requiredTargets) {
        const columnLogical = c.schemaName.toLowerCase();
        const desired = REQUIRED(c);
        const current = requiredLevels.get(columnLogical);
        // Omitted `required` is intentionally NOT reconciled. REQUIRED(c) maps an absent property to
        // `None` for the CREATE payload, but applying that same default to an existing column would
        // demote a maker-authored Business Required field on a rebuild — a destructive surprise. Only
        // an explicit spec value owns the existing column's RequiredLevel.
        if (!current) {
          runner.skip('data-model', `required ${e.schemaName}.${c.schemaName} (current level unknown — skipped)`);
        } else if (current === desired) {
          runner.skip('data-model', `required ${e.schemaName}.${c.schemaName} (already ${desired})`);
        } else {
          toUpdateRequired.push({ schemaName: c.schemaName, logicalName: columnLogical, required: desired });
        }
      }
      await runner.mapLimit(toUpdateRequired, 1, (c) => runBestEffort(
        runner,
        'data-model',
        `required ${e.schemaName}.${c.schemaName} -> ${c.required}`,
        () => sdk.updateColumn(logical, c.logicalName, { required: c.required }),
        warn,
        `could not update required level for ${logical}.${c.logicalName} to ${c.required} — the rest of the build continues`
      ));
      // AB#6648523 / AB#6648522 / AB#6651276: reconcile the three new column capabilities
      // (defaultValue, integerFormat, isValidForCreate/Update/Read) on an EXISTING table, so a
      // rebuild converges a column that already exists, not only one just created above.
      //
      // Deliberately a SEPARATE block from the `required` reconcile above rather than folded into
      // it, and with a DIFFERENT strategy: `required` reads the column's CURRENT level first so it
      // can skip a no-op update and, more importantly, avoid demoting an omitted value (a maker may
      // have set Business Required by hand, and the spec staying silent must not undo that). These
      // three have no equivalent maker-authored surface to protect, and `updateColumn` performs its
      // own GET-mutate-PUT round trip per call (measured against the vendored bundle — replaying an
      // already-correct value is a harmless no-op on the wire), so they are simply RE-ASSERTED
      // whenever the spec sets them explicitly — the same no-pre-read-diff strategy already used by
      // `setColumnVisualization` below for the same reason.
      //
      // Customer columns are excluded outright, not merely skipped for these three fields:
      // `updateColumn` refuses ANY change to a Customer column (measured — it throws "type
      // 'Customer' not supported"), because Customer has no entry in the SDK's attribute-type ->
      // OData-cast table (it is created through the wholly separate createCustomerColumn instead).
      const capabilityTargets = capabilityDeclared.filter((c) => existingCols.has(c.schemaName.toLowerCase()));
      await runner.mapLimit(capabilityTargets, 1, (c) => {
        const columnLogical = c.schemaName.toLowerCase();
        const opts = {};
        // Same type gates as columnOptions() above (Boolean-only / Integer-only): the SDK's update
        // path throws the identical InvalidArgumentError as create for a type mismatch, and
        // app-spec.js's validation already rejects an impossible combination at the spec gate — this
        // just keeps the two call sites from drifting off that shared rule.
        if (c.type === 'Boolean' && c.defaultValue !== undefined) opts.defaultValue = c.defaultValue;
        if (c.type === 'Integer' && c.integerFormat !== undefined) opts.integerFormat = c.integerFormat;
        // `!== undefined`, not truthy — same reasoning as columnOptions(): an explicit `false` is the
        // whole point of isValidForUpdate/Create/Read, and of `defaultValue` too.
        if (c.isValidForCreate !== undefined) opts.isValidForCreate = c.isValidForCreate;
        if (c.isValidForUpdate !== undefined) opts.isValidForUpdate = c.isValidForUpdate;
        if (c.isValidForRead !== undefined) opts.isValidForRead = c.isValidForRead;
        return runBestEffort(
          runner,
          'data-model',
          `column capabilities ${e.schemaName}.${c.schemaName}`,
          () => sdk.updateColumn(logical, columnLogical, opts),
          warn,
          `could not update column capabilities for ${logical}.${columnLogical} — the rest of the build continues`
        );
      });
    }
    for (const c of requiredDeclared) {
      if (existingTable && existingCols.has(c.schemaName.toLowerCase())) continue;
      // A column's level is part of its own create request — except the primary name column's: it is asked in the table's create, which
      // does not keep it on a plain text name column, so a level other than None is applied only when the SDK says it read the level back
      // (`primaryColumnRequired`). None has nothing to read back, so what shows it is the create itself — one this build saw succeed. A table
      // the build did not see made (found after its create, the answer being lost, or existing with columns that could not be read) shows
      // nothing about the level, None included: a maker may have set Business Required there. Neither that nor an SDK that answers nothing is
      // reported as applied; the re-run reconciles the level as it does an existing column's. Nothing is written blind.
      const desired = REQUIRED(c);
      if (c === e.primaryAttribute && !(createdTable && (desired === 'None' || createdTable.primaryColumnRequired === desired))) {
        const confirmed = createdTable && createdTable.primaryColumnRequired;
        const why = createdTable
          ? `the SDK confirmed ${confirmed ? `'${confirmed}'` : 'no level'} for the name column of the table it created`
          : existingTable
            ? 'the table exists but its columns could not be read, so its current level is unknown'
            : 'the table was found after its create, so nothing shows that the level was applied';
        await runBestEffort(runner, 'data-model', `required ${e.schemaName}.${c.schemaName} -> ${desired}`, async () => { throw refusal(why); },
          warn, `could not confirm the required level of ${logical}.${String(c.schemaName).toLowerCase()} (${desired}) — a re-run sets it, and the rest of the build continues`);
        continue;
      }
      runner.skip('data-model', `required ${e.schemaName}.${c.schemaName} (applied on create)`);
    }
    for (const c of capabilityDeclared) {
      if (!existingTable || !existingCols.has(c.schemaName.toLowerCase())) {
        runner.skip('data-model', `column capabilities ${e.schemaName}.${c.schemaName} (applied on create)`);
      }
    }
    // Capture real column results (logicalName + metadataId)
    toCreate.forEach((c, i) => {
      const res = colResults[i];
      if (res) {
        (result.columns[e.schemaName] = result.columns[e.schemaName] || []).push({
          schemaName: c.schemaName,
          logicalName: res.logicalName || c.schemaName.toLowerCase(),
          metadataId: res.metadataId
        });
      }
    });
    // Grid data visualization (preview) — render a column's value as a radial dial / line chart /
    // heat map / star rating instead of text. Applied HERE, with the columns, and not with views:
    // it is per-COLUMN metadata (a `controlconfiguration` row bound to the attribute), so the
    // platform honours it in EVERY grid and view that shows the column.
    //
    // Runs for pre-existing columns as well as freshly created ones. `setColumnVisualization` is
    // idempotent — it PATCHes the single config row it finds and prunes duplicates — so re-asserting
    // the spec on a rebuild converges rather than piling up rows. Serial for the same reason the
    // column loop is: these writes touch the same table's customizations.
    //
    // Deliberately a SEPARATE call rather than `createColumn`'s inline `visualization` option, for
    // two reasons: (1) the inline option only ever fires for a column being created, so a rebuild —
    // where every column already exists — would never re-assert the spec; (2) when the binding
    // fails, createColumn raises its own `..._BIND_FAILED` error wrapping the cause, which the
    // absent-preview check below cannot cleanly recognise. Calling it separately yields the raw 404
    // and lets an unprovisioned environment skip instead of halting.
    const withVisualization = (e.columns || []).filter((c) => c && c.schemaName && c.visualization !== undefined);
    for (const c of withVisualization) {
      // Prefer the logical name the create call actually returned; fall back to the conventional
      // lower-cased schema name for a column that already existed (Dataverse lower-cases logical
      // names, so `cfo_Rating` is always `cfo_rating`).
      const created = (result.columns[e.schemaName] || []).find((x) => x.schemaName === c.schemaName);
      const columnLogical = (created && created.logicalName) || String(c.schemaName).toLowerCase();
      await runner.run('data-model', `visualization ${e.schemaName}.${c.schemaName} (${c.visualization})`,
        () => sdk.setColumnVisualization(logical, columnLogical, c.visualization),
        { recoverable: true, skipIf: isVisualizationUnsupported });
    }
    // custom status reasons — capture the option value so sample data can set them. IDEMPOTENT:
    // insertStatusValue itself is not (with no explicit Value, Dataverse auto-assigns a NEW value
    // every call, duplicating the reason on a data-model re-run). So we PIN a deterministic value
    // (publisher range 100000000+i, matching how the engine assigns choice/global option values;
    // authors may override via sr.value) and pass it explicitly: a re-run then hits an already-exists
    // error that skipIf turns into a skip (no duplicate), while the value stays captured for sample
    // data. On a fresh insert we overwrite with the server-returned value (authoritative).
    let srIdx = 0;
    for (const sr of e.statusReasons || []) {
      const stateCode = STATE_CODE[sr.state] !== undefined ? STATE_CODE[sr.state] : 0;
      const pinned = typeof sr.value === 'number' ? sr.value : 100000000 + srIdx;
      srIdx += 1;
      (statusReasonValues[logical] = statusReasonValues[logical] || {})[sr.label] = { value: pinned, stateCode };
      await runner.run('data-model', `status reason ${e.schemaName}: ${sr.label}`, async () => {
        const v = await sdk.insertStatusValue(logical, { label: sr.label, stateCode, color: sr.color, value: pinned, languageCode: resolvedLanguageCode });
        statusReasonValues[logical][sr.label] = { value: typeof v === 'number' ? v : pinned, stateCode };
      }, { recoverable: true, skipIf: isAlreadyExists });
    }
    // alternate keys — idempotent: the SDK has no key lister, so a re-run that hits an
    // already-exists error is treated as a skip (not a halt) via skipIf.
    //
    // A key over the name column of a table whose length is still to be set waits for that step when its label goes out in ONE language
    // (keyWaitsForNameLength): it is made at the end of the phase, once the length is right. A key over that column whose label goes out in
    // several languages cannot wait — the read that sets the length carries labels — and is made here, ahead of the step, where the build says
    // what to do if the platform refuses it (alternateKeyAheadOfLength) — unless the environment made the column too long for the key to fit
    // beside the others: the platform would refuse it here, so it waits too, whatever its label (keyMustWaitForShorterNameColumn).
    // Every other key is made here, with its table, as it always was.
    for (const k of e.alternateKeys || []) {
      if (lengthPending && keyWaitsForNameLength(e, k)) {
        waitingKeys.push({ entity: e, logical, key: k, languageCode: resolvedLanguageCode });
        continue;
      }
      if (lengthPending && keyNeedsNameLength(e, k)) {
        if (await keyMustWaitForShorterNameColumn({ provision, entity: e, logical, key: k, sleep })) {
          waitingKeys.push({ entity: e, logical, key: k, languageCode: resolvedLanguageCode });
          continue;
        }
        await alternateKeyAheadOfLength({ runner, sdk, entity: e, logical, key: k, languageCode: resolvedLanguageCode, warn });
        continue;
      }
      await alternateKeyStep({ runner, sdk, entity: e, logical, key: k, languageCode: resolvedLanguageCode });
    }
  }

  // 2c. Relationships — 1:N and N:N; skip those already present. The publisher prefix is threaded
  //     into the schema-name defaulting so a relationship to a standard/system table gets a valid,
  //     prefixed name Dataverse accepts (see prefixedRelationshipName).
  //     A name that already exists is not enough to skip: Dataverse allows one relationship per
  //     schema name, so a second 1:N on the same pair, or an N:N that derived the 1:N's name, must
  //     halt rather than be reported as already created.
  const publisherPrefix = spec.solution && spec.solution.publisherPrefix;
  // Reads the display name of a parent table the spec cannot name, once per table (ADO 6691205). Null when
  // there is no raw client to read with — callers then use the humanized name without pretending to have asked.
  const readParentLabel = makeTableLabelReader({ provision, languageCode: resolvedLanguageCode, warn });
  // Lookups this run CREATED, `<referencing>|<lookup logical>`: the rebuild repair below must not touch
  // (or even read) a column that was just given the right label.
  const createdLookups = new Set();
  // In the order relationshipsInCreateOrder gives: every relationship whose lookup label is LOCALIZED before any
  // other. The parent-label read below carries labels — the read documented on relationshipExists as making
  // Dataverse keep only the base-language label of a multi-language create that FOLLOWS it. Each read sits right
  // before its own single-language create, which is the create it can only harm harmlessly; but a localized create
  // later in this loop would still have a label-bearing read ahead of it. With every localized lookup created first,
  // nothing localized follows any such read, whichever order the spec declared the relationships in. Order is
  // otherwise free: a relationship needs only its two tables, which the loops above have already made.
  for (const rel of relationshipsInCreateOrder(spec)) {
    const schema = rel.type === 'OneToMany' ? relationshipSchemaName(rel, publisherPrefix) : manyToManySchemaName(rel, publisherPrefix);
    const entityLogical = (rel.type === 'OneToMany' ? rel.referenced : rel.entity1).toLowerCase();
    const label = rel.type === 'OneToMany'
      ? `relationship 1:N ${rel.referenced}->${rel.referencing}`
      : `relationship N:N ${rel.entity1}<->${rel.entity2}`;
    const declared = Object.assign({}, rel, { schemaName: rel.schemaName || schema });
    // What the lookup column will be labelled. Decided BEFORE the existence probe because it decides how
    // that probe may fall back: a LOCALIZED label — authored, or inherited from a localized parent table —
    // must never be preceded by the broad metadata read (see relationshipExists).
    const lookupLabel = rel.type === 'OneToMany' ? lookupLabelFor(spec, rel) : null;
    const exists = await relationshipExists(provision, entityLogical, schema, rel.type, {
      hasLocalizedLabels: !!lookupLabel && localizedLabelLcids(lookupLabel.label).length > 0,
      declared,
    });
    if (exists === true) { runner.skip('data-model', `relationship ${schema} (exists)`); continue; }
    if (exists && exists.mismatch) {
      throw new BuildHalt(
        `relationship schema name '${schema}' is already used by ${describeRelationship(exists.holder)}; the spec declares ${describeRelationship(declared)}. ${intersectRemedy(declared, exists.holder) || 'Give it an explicit "schemaName".'}`,
        { phase: 'data-model', code: 'relationship-name-taken', recoverable: false, retry: RETRY.NEVER },
      );
    }
    // A parent whose name the spec cannot give — a table it does not declare (account, contact,
    // systemuser…), or one it declares without a displayName that the build did not create (an
    // `existing: true` incident is "Case", not "Incident") — is asked of the environment rather than
    // guessed from the table's logical name. The read is made HERE — after the probe, immediately before
    // the create it feeds, and only when a create is going to happen. It is label-bearing, which is the
    // read documented on relationshipExists as making Dataverse keep only the base-language label of the
    // create that follows; that create carries one single-language label, so nothing can be stripped, and
    // it must stay next to it rather than drift into the middle of a localized one.
    let createLabel = lookupLabel;
    if (createLabel && createLabel.source === 'derived' && readParentLabel && lookupParentNeedsEnvironment(spec, rel, { reused: reusedTables })) {
      const live = await readParentLabel(rel.referenced);
      if (live) createLabel = lookupLabelFor(spec, rel, { liveReferencedLabel: live });
    }
    const createOpts = rel.type === 'OneToMany'
      ? { type: 'OneToMany', schemaName: schema, referencedEntity: rel.referenced.toLowerCase(), referencingEntity: rel.referencing.toLowerCase(), lookupSchemaName: rel.lookup.schemaName, lookupDisplayName: createLabel.label, languageCode: resolvedLanguageCode }
      : { type: 'ManyToMany', schemaName: schema, entity1: rel.entity1.toLowerCase(), entity2: rel.entity2.toLowerCase(), intersectEntityName: rel.intersectEntityName, languageCode: resolvedLanguageCode };
    await runner.run('data-model', label, async () => {
      try {
        const res = await sdk.createRelationship(createOpts);
        result.relationships.push(rel.type === 'OneToMany'
          ? { schemaName: res.schemaName || schema, metadataId: res.metadataId, kind: '1n', lookupLogicalName: res.lookupLogicalName }
          : { schemaName: res.schemaName || schema, metadataId: res.metadataId, kind: 'nn' });
        if (rel.type === 'OneToMany') {
          const key = lookupKey(rel);
          createdLookups.add(key);
          result.lookupLabels[key] = { label: labelText(createLabel.label, resolvedLanguageCode) };
        }
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        // What the relationship held under this name says of itself decides the step. It is the declared one only when it states its whole
        // identity (compareRelationship): the create's own error is then rethrown, marked, which is how skipIf turns the step into a skip. One
        // it contradicts is another relationship's, and the name has to change. One that leaves a part out is neither — it has not been shown
        // to be the declared relationship, so nothing is skipped on its name, and the build stops.
        const unprovenHolder = (verdict) => refusal(`relationship schema name '${schema}' already exists, but ${describeIncomplete(verdict.missing)}, so the build cannot tell it from the declared ${describeRelationship(declared)} and does not reuse it. It was left as it is: run the build again, and if the answer stays incomplete, check this relationship in Power Apps (Solutions > the table > Relationships).`);
        const settle = (heldBy) => {
          const verdict = compareRelationship(declared, heldBy);
          if (verdict.state === 'same') {
            err.sameRelationshipExists = true;
            throw err;
          }
          if (verdict.state === 'incomplete') throw unprovenHolder(verdict);
          throw refusal(`relationship schema name '${schema}' is already used by ${describeRelationship(heldBy)}; the spec declares ${describeRelationship(declared)}. ${intersectRemedy(declared, heldBy) || 'Give it an explicit "schemaName".'}`);
        };
        // skipIf is synchronous, so classify the holder here and rethrow a marked error. The
        // SchemaName key is case-sensitive; findRelationshipHolder falls back to the declared
        // endpoints when the exact spelling 404s.
        let holder = await findRelationshipHolder(provision && provision.dataverse, schema, {
          candidates: rel.type === 'ManyToMany' ? [rel.entity1, rel.entity2] : [rel.referenced, rel.referencing],
        });
        if (holder.found === true) settle(holder.holder);
        if (holder.found === false) {
          // The generated name is free, but the lookup column may already belong to a relationship
          // under a different name (a download that omitted the deployed name, or an authored spec
          // that derived one). That is not lag: say which name to set.
          if (rel.type === 'OneToMany' && rel.lookup && rel.lookup.schemaName) {
            const owned = await readRelationshipsOf(provision && provision.dataverse, rel.referencing, 'ManyToOne');
            const wantLookup = String(rel.lookup.schemaName).toLowerCase();
            const owner = owned.ok && (owned.rows || []).find((row) => String(row.referencingAttribute || '').toLowerCase() === wantLookup);
            if (owner) {
              // The row may have become visible on this read — the lag case. If it is the
              // relationship we declared, skip. Only a different owner (same lookup, other name) halts.
              // A row that holds the lookup but does not state enough to be called the declared relationship
              // is neither: it is not skipped, and it is not another relationship's to name.
              const verdict = compareRelationship(declared, owner);
              if (verdict.state === 'same') {
                err.sameRelationshipExists = true;
                throw err;
              }
              if (verdict.state === 'incomplete') throw unprovenHolder(verdict);
              const at = (spec.relationships || []).indexOf(rel);
              throw refusal(`lookup '${wantLookup}' on '${String(rel.referencing).toLowerCase()}' already belongs to relationship '${owner.schemaName}' (${describeRelationship(owner)}); set relationships[${at}].schemaName to '${owner.schemaName}' to reuse it`);
            }
          }
          // The create said the name is taken, but neither the case-sensitive key nor the endpoint
          // collections showed a row. A create the SDK retried after the server had already created
          // it looks exactly like this until the metadata read catches up — the same lag family as
          // the view retry. Two more reads, ~2s then ~4s, before calling the name unidentified.
          const wait = typeof sleep === 'function' ? sleep : ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
          const candidates = rel.type === 'ManyToMany' ? [rel.entity1, rel.entity2] : [rel.referenced, rel.referencing];
          for (const delay of [2000, 4000]) {
            await wait(delay);
            holder = await findRelationshipHolder(provision && provision.dataverse, schema, { candidates });
            if (holder.found === true) settle(holder.holder);
            if (holder.found !== false) break;
          }
          if (holder.found === false) {
            throw refusal(`relationship schema name '${schema}' is already used by a relationship the build could not identify. Give it an explicit "schemaName".`);
          }
        }
        // What the read of the holder said — its status, the code of its answer (`answered`, which lib/relationship-metadata.js carries beside the result) and its words — is what decides whether a
        // run again can help; the create's own refusal, and the name, do not.
        throw serviceFailure(`could not identify the relationship that already uses schema name '${schema}' (${holder.error || 'read failed'}); the create failed because it already exists: ${(err && err.message) || err}`, { status: holder.status, words: holder.error || '', answered: holder.answered });
      }
    }, { skipIf: (e) => isAlreadyExists(e) && e.sameRelationshipExists === true });
  }

  // A rebuild repairs a lookup column an older build labelled with its old default (opt-in: only the app
  // build budgets the steps this emits — see planFor).
  if (reconcileLookupLabels) {
    await reconcileLookupLabelsPass({ spec, sdk, provision, runner, warn, languageCode: resolvedLanguageCode, createdLookups, readParentLabel, reusedTables, result });
  }

  return result;
}

// The lookups whose label the build owns — the spec sets none (ADO 6691205). One predicate shared by
// the repair pass and planFor, so the steps the pass emits are exactly the steps the plan budgets.
function lookupsWithDefaultLabel(spec) {
  return ((spec && spec.relationships) || []).filter((rel) => rel && rel.type === 'OneToMany' && rel.lookup && rel.lookup.schemaName
    && lookupLabelFor(spec, rel).source !== 'explicit');
}

// The relationships, in the order the data-model phase creates them: those whose lookup label is LOCALIZED —
// an LCID map, authored or inherited from a localized parent table — first, every other relationship after
// them, each group in declared order. A label that needs a read of the parent's name is never localized (it is
// the environment's one string), so the reads that precede a create all belong to the second group — see the
// loop in provisionDataModel for why that matters. planFor lists the relationships in this order too, so the
// plan shows what the build does.
function relationshipsInCreateOrder(spec) {
  const relationships = ((spec && spec.relationships) || []).filter((rel) => rel && (rel.type === 'OneToMany' || rel.type === 'ManyToMany'));
  const localized = (rel) => {
    const lookupLabel = rel.type === 'OneToMany' ? lookupLabelFor(spec, rel) : null;
    return !!lookupLabel && localizedLabelLcids(lookupLabel.label).length > 0;
  };
  return [...relationships.filter(localized), ...relationships.filter((rel) => !localized(rel))];
}

// Repair, on a REBUILD, a lookup column an older build labelled with the vendored SDK's default — the
// referenced table's logical name (ADO 6691205).
//
// Only when ALL of these hold, so a label a maker chose is never touched:
//   * the spec sets no `lookup.displayName` (an explicit label is the author's, and is never reapplied);
//   * the relationship already existed (a column created this run already has the right label);
//   * the column carries exactly ONE label — the old default was written in one language, so a second
//     means somebody edited it since — and that language is the BUILD's own. An old default in another
//     language is left alone: the write below would add the build's language next to it, leaving two
//     languages of which one is still an identifier, and every later rebuild would then see "several
//     languages" and skip the column for good;
//   * that label is exactly the old default: the lower-case logical name of the referenced table, case-sensitive
//     (isOldLookupColumnLabel) — the only label a build ever wrote on a COLUMN.
// The new label is the one a fresh build would write — lookupLabelFor — but written in ONE language
// (the authoring one) even when the parent's name is localized: this is an UPDATE preceded by a
// label-bearing read, and a multi-language write there is exactly the shape the documented base-language
// hazard strips, so it is not risked for a repair. The other languages of a localized parent come with
// a fresh build or Maker.
//
// Exactly one event per lookup the build owns, so the [n/total] the plan promised holds: planFor budgets
// the same predicate (lookupsWithDefaultLabel). The labels are read once per CHILD TABLE, not once per
// lookup, and only for the lookups this run did not just create.
async function reconcileLookupLabelsPass({ spec, sdk, provision, runner, warn, languageCode, createdLookups, readParentLabel, reusedTables, result }) {
  const client = provision && provision.dataverse;
  const owned = lookupsWithDefaultLabel(spec);
  // child -> the lookup columns of it that need reading, so one request answers for all of them.
  const toRead = new Map();
  for (const rel of owned) {
    if (createdLookups.has(lookupKey(rel))) continue;
    const child = String(rel.referencing).toLowerCase();
    if (!toRead.has(child)) toRead.set(child, []);
    toRead.get(child).push(String(rel.lookup.schemaName).toLowerCase());
  }
  const reads = new Map();
  const labelsOfChild = (child) => {
    if (!reads.has(child)) {
      reads.set(child, readColumnLabels(client, child, toRead.get(child)).then((got) => {
        if (got.state === 'error' && typeof warn === 'function') {
          warn(`could not read the label of lookup(s) ${toRead.get(child).map((c) => `'${child}.${c}'`).join(', ')} (${got.why}), so a label an older build left on them was not checked. Re-run to retry.`);
        }
        return got;
      }));
    }
    return reads.get(child);
  };
  const buildLanguage = String(languageCode);
  // The tables whose lookups this pass relabelled, published below in one envelope.
  const relabelled = new Set();

  for (const rel of owned) {
    const child = String(rel.referencing).toLowerCase();
    const lookupLogical = String(rel.lookup.schemaName).toLowerCase();
    const step = `lookup label ${child}.${rel.lookup.schemaName}`;
    const key = lookupKey(rel);
    if (createdLookups.has(key)) { runner.skip('data-model', `${step} (set when the relationship was created)`); continue; }
    if (!client || typeof client.get !== 'function') { runner.skip('data-model', `${step} (no metadata client — left as it is)`); continue; }
    const read = await labelsOfChild(child);
    if (read.state === 'error') { runner.skip('data-model', `${step} (could not be read — left as it is)`); continue; }
    const labels = read.state === 'ok' ? read.byColumn.get(lookupLogical) : undefined;
    if (!labels) { runner.skip('data-model', `${step} (column not found — left as it is)`); continue; }

    const languages = Object.keys(labels);
    const only = languages.length === 1 ? languages[0] : null;
    const current = only ? labels[only] : undefined;
    const shown = labelText(labels, languageCode);
    if (current === undefined || !isOldLookupColumnLabel(rel, current)) {
      runner.skip('data-model', `${step} (${languages.length > 1 ? 'labelled in several languages' : `labelled "${shown}"`} — left as it is)`);
      if (shown) result.lookupLabels[key] = { label: shown };
      continue;
    }
    if (only !== buildLanguage) {
      runner.skip('data-model', `${step} (the old default "${current}" is in language ${only}, not the build's ${buildLanguage} — left as it is)`);
      if (typeof warn === 'function') {
        warn(`lookup '${child}.${lookupLogical}' still carries the old default label "${current}" in language ${only}, and this build writes language ${buildLanguage}: relabelling it would leave two languages side by side, one of them still the old default, so it was left as it is. Rename the column in Maker to relabel it: a build changes an existing lookup's label only where it is the old default in the build's own language, and lookup.displayName names only a lookup the build creates.`);
      }
      result.lookupLabels[key] = { label: current };
      continue;
    }
    let want = lookupLabelFor(spec, rel);
    if (want.source === 'derived' && readParentLabel && lookupParentNeedsEnvironment(spec, rel, { reused: reusedTables })) {
      const parentLabel = await readParentLabel(rel.referenced);
      if (parentLabel) want = lookupLabelFor(spec, rel, { liveReferencedLabel: parentLabel });
    }
    const next = labelText(want.label, languageCode);
    if (!next || next === current) {
      runner.skip('data-model', `${step} (already "${current}")`);
      result.lookupLabels[key] = { label: current };
      continue;
    }
    await runBestEffort(runner, 'data-model', `${step}: "${current}" -> "${next}"`, async () => {
      await sdk.updateColumn(child, lookupLogical, { displayName: next, languageCode });
      result.lookupLabels[key] = { label: next };
      relabelled.add(child);
    }, warn, `could not relabel lookup '${child}.${lookupLogical}' from its old default "${current}" to "${next}" — the rest of the build continues`);
  }
  if (relabelled.size) await publishRelabelledTables(client, [...relabelled], warn);
}

// A column's label is part of its table's definition, and a table or column definition change reaches model-driven apps
// only once it is published: "When you update a table or column definition, use the PublishXml Action before the
// changes you make are applied to the model-driven applications"
// (https://learn.microsoft.com/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api#update-table-definitions).
// No metadata read shows the difference: measured live, RetrieveEntity returns the new label right after the PUT even
// with RetrieveAsIfPublished=false, so a live check of this publish has to trace the request, not read the label.
// Nothing else in the build is sure to publish the child table. Its other table publishes follow from what the spec
// puts on a table — a form, view, chart or icon, or its enriched default views — and a downloaded spec, whose lookups
// the download leaves without a label precisely so that this pass repairs them, carries no forms, views, charts or
// table icons and marks every table existing: true, whose default views the build leaves alone. A rebuild of one would
// save the new label and leave it to whatever publishes that table next, while reporting the repair done; a re-run
// finds the label already changed. So the pass publishes the tables it relabelled itself, in ONE envelope, at once —
// with or without --publish, as the reconcile paths publish what they change — and in the data-model phase, before
// anything publishes the app: a PublishXml naming only the app, sent after a form's label change and before its table's
// own publish, leaves the form's labels unpublished for good (measured for forms; see publishReconciledTables,
// sdk-build.js), and a relabelled table is published first here for the same reason.
// The request is `publishTablesXml`'s (lib/table-publish.js), the one that publishes tables by name.
// Best-effort: the labels are saved whatever it answers, so a failure is a warning that says how to show them.
async function publishRelabelledTables(client, tables, warn) {
  const notLive = (why) => {
    if (typeof warn !== 'function') return;
    const which = tables.length > 1 ? `tables ${tables.join(', ')}` : `table ${tables[0]}`;
    warn(`the new lookup label(s) on ${which} are saved but not published (${why}), so the app still shows the old ones: publish ${tables.length > 1 ? 'those tables' : 'that table'} in Power Apps`);
  };
  const outcome = await publishTablesXml(client, tables);
  if (!outcome.ok) notLive(outcome.reason);
}

// Factory for entity-set resolver: fresh tables cached in `entities` (from data-model
// phase); existing ones via fetchEntityMetadata. Returns async (logical) => entitySetName.
function makeEntitySetResolver({ spec, entities, provision }) {
  const entitySetCache = {};
  return async (logical) => {
    const ent = entityByLogical(spec, logical);
    const cached = ent && entities[ent.schemaName] && entities[ent.schemaName].entitySetName;
    if (cached) return cached;
    if (!entitySetCache[logical]) entitySetCache[logical] = (await provision.fetchEntityMetadata(logical)).entitySetName;
    return entitySetCache[logical];
  };
}

// Case-insensitive key/value match of a parent sample record against a $parent.match criteria.
function matchesRecord(rec, match) {
  return Object.entries(match).every(([k, val]) => {
    const rk = Object.keys(rec).find((x) => x.toLowerCase() === k.toLowerCase());
    return rk !== undefined && rec[rk] === val;
  });
}

// Translate an entity's author-friendly sample records into a seedRecordGraph group: resolve
// choice labels to option ints (resolveSampleRecords), strip the $parent/$parents/statusReason
// sentinels from the body, translate each $parent/$parents.match into a parentIndex bind on the
// relationship's lookup nav property, and resolve a custom statusReason into statuscode/statecode
// (halting if its option value wasn't captured during the data-model phase). The SDK's
// seedRecordGraph owns the @odata.bind URL formation and resolve-by-name idempotency.
function firstDuplicateNonEmpty(seedRecords, attr) {
  const seen = new Set();
  for (const r of seedRecords) {
    const v = r.body[attr];
    if (v === undefined || v === null || v === '') continue;
    // SHARED with validateAppSpec's author-time gate (app-spec.js) so the two cannot drift: that
    // gate exists only to move this refusal earlier, and a different notion of "duplicate" there
    // would reject a spec this accepts, or accept one this refuses.
    const key = sampleKeyIdentity(v);
    if (seen.has(key)) return v;
    seen.add(key);
  }
  return undefined;
}

// Choose the seedRecordGraph idempotency key (matchOn) for an entity's sample rows. The SDK dedups /
// reuses an existing row ONLY when matchOn is supplied, and it NEVER falls back to the primary
// display name — Dataverse permits duplicate names, so name-based resolve is a silent-wrong-id bug
// (see types/recordGraph.ts `SeedEntityGroup.matchOn`). To keep the old resolve-by-name idempotency
// WITHOUT regressing correctness:
//   1. prefer a single-column ALTERNATE KEY (Dataverse enforces its uniqueness — a safe key);
//   2. else fall back to the primary NAME column (the key the retired `primaryAttribute` used), but
//      only if the sample rows are unique on that column;
// and in BOTH cases only when EVERY seeded record has a non-empty value for the chosen key — otherwise
// omit matchOn (insert every record, no dedup) rather than resolve on a partially-empty key, which
// would collapse or mis-bind rows. `body` values are the resolved Web-API values the SDK will filter on.
function chooseMatchOn(e, seedRecords) {
  const hasNonEmpty = (attr) =>
    seedRecords.length > 0 &&
    seedRecords.every((r) => { const v = r.body[attr]; return v !== undefined && v !== null && v !== ''; });
  for (const k of e.alternateKeys || []) {
    const cols = (k.columns || []).map((c) => String(c).toLowerCase());
    // An alternate key is enforced-unique by Dataverse, but the SAMPLE ROWS are not checked by
    // anything before they are sent. Two rows sharing the key value resolve to the same record — the
    // same wrong-row resolve the primary-name fallback below rejects — and the failure would land
    // mid-seed rather than here. So the duplicate rule applies to whichever column becomes matchOn.
    if (cols.length === 1 && hasNonEmpty(cols[0])) {
      const duplicate = firstDuplicateNonEmpty(seedRecords, cols[0]);
      if (duplicate !== undefined) {
        throw refusal(`sample data for '${e.schemaName}' has duplicate ${cols[0]} value '${String(duplicate)}'; ${cols[0]} is the single-column alternate key used as matchOn, so Dataverse could resolve or deduplicate the wrong row. Make ${cols[0]} unique across the sample rows.`);
      }
      return cols[0];
    }
  }
  const primary = e.primaryAttribute.schemaName.toLowerCase();
  if (hasNonEmpty(primary)) {
    const duplicate = firstDuplicateNonEmpty(seedRecords, primary);
    if (duplicate !== undefined) {
      throw refusal(`sample data for '${e.schemaName}' has duplicate ${primary} value '${String(duplicate)}'; without a single-column alternate key, ${primary} would be used as matchOn and Dataverse could resolve or deduplicate the wrong row. Add a single-column alternate key with unique values, or make ${primary} unique across the sample rows.`);
    }
    return primary;
  }
  return undefined;
}

// Resolve WHICH 1:N relationship a `$parent` binds through, throwing the shared message.
// `resolveParentRelationship` (app-spec.js) owns the rule and the wording so the lint-time gate and
// this runtime backstop cannot drift; validateAppSpec normally catches these first. #544.
function relationshipForParent(spec, parentEntity, childEntity, wanted) {
  const { rel, error } = resolveParentRelationship(spec, parentEntity, childEntity, wanted);
  if (error) throw refusal(`sample data for '${childEntity}' ${error}`);
  return rel;
}

function buildSeedGroup({ spec, e, records, statusReasonValues }) {
  const resolved = resolveSampleRecords(e, records, spec);
  const seedRecords = [];
  for (let i = 0; i < resolved.length; i++) {
    const raw = records[i];
    // Sample rows are otherwise free-form Dataverse attribute bags, so an undocumented sentinel-like
    // key is more likely an authoring mistake than a safe instruction. Rejecting it prevents a
    // payload like `{ "new_name": "T1", "_seedKey": "ticket-1" }` from reaching Dataverse
    // as a non-existent attribute while avoiding a silent drop of data the author may expect to use.
    if (raw && Object.prototype.hasOwnProperty.call(raw, '_seedKey')) {
      throw refusal(`sample data for '${e.schemaName}' record ${i} uses _seedKey, but _seedKey is not supported by this App Spec version. Remove it, or declare a real single-column alternate key and put the stable seed identifier in that column.`);
    }
    const body = Object.assign({}, resolved[i]);
    delete body.$parent; delete body.$parents; delete body.statusReason;
    // Parent lookups — one (`$parent`) or many (`$parents`, e.g. a junction row binding both
    // sides). Each resolves to the parent's index within its own sample-record list; the SDK maps
    // that index to the created id and emits `<lookup>@odata.bind`.
    const binds = [];
    const parents = [].concat(raw && raw.$parent ? [raw.$parent] : [], (raw && raw.$parents) || []);
    for (const parent of parents) {
      if (!parent || !parent.entity || !parent.match) continue;
      const rel = relationshipForParent(spec, parent.entity, e.schemaName, parent.lookup);
      const parentEntity = entityByLogical(spec, parent.entity);
      // #1: fail loud on a bind that can't be formed instead of silently dropping it (which created
      // the child with the lookup UNSET and still reported success). validateAppSpec catches these at
      // lint time; this is the runtime backstop for a build that skipped validation. runner.run (the
      // caller) turns the throw into a clean sample-data phase failure.
      if (!rel || !parentEntity) {
        throw refusal(`sample data for '${e.schemaName}' declares a parent on '${parent.entity}' with no OneToMany relationship to it — fix the spec's $parent/$parents`);
      }
      const parentRecords = sampleRecordsFor(spec, parentEntity);
      const matchingParentIndexes = [];
      for (let j = 0; j < parentRecords.length; j++) {
        if (matchesRecord(parentRecords[j], parent.match)) matchingParentIndexes.push(j);
      }
      if (matchingParentIndexes.length === 0) {
        throw refusal(`sample data for '${e.schemaName}': parent match ${JSON.stringify(parent.match)} found no '${String(parent.entity).toLowerCase()}' sample record — the '${rel.lookup.schemaName}' lookup would be left unset`);
      }
      if (matchingParentIndexes.length > 1) {
        throw refusal(`sample data for '${e.schemaName}': parent match ${JSON.stringify(parent.match)} matched ${matchingParentIndexes.length} '${String(parent.entity).toLowerCase()}' sample records, so '${rel.lookup.schemaName}' is ambiguous. Make the match unique (for example by matching an alternate-key column) or change the sample data.`);
      }
      const parentIndex = matchingParentIndexes[0];
      binds.push({ navProperty: rel.lookup.schemaName, parentEntity: parent.entity.toLowerCase(), parentIndex });
    }
    // Custom status reason -> statecode + the captured statuscode option value. The value is
    // captured during the data-model phase (insertStatusValue); if that phase was skipped this run
    // the value is unknown — halt loudly instead of silently inserting a default status.
    if (raw && raw.statusReason) {
      const sv = (statusReasonValues[e.schemaName.toLowerCase()] || {})[raw.statusReason];
      if (!sv) throw refusal(`record sets statusReason '${raw.statusReason}' on ${e.schemaName}, but its status value wasn't captured — include the data-model phase (don't --skip data-model) so the custom status reason is created and its option value captured`);
      body.statuscode = sv.value; body.statecode = sv.stateCode;
    }
    seedRecords.push({ body, binds });
  }
  // matchOn (opt-in) replaces the retired `primaryAttribute`; see chooseMatchOn for the key policy.
  const matchOn = chooseMatchOn(e, seedRecords);
  return { entityLogical: e.schemaName.toLowerCase(), ...(matchOn ? { matchOn } : {}), records: seedRecords };
}

// Order one entity's sample rows into WAVES by their SELF-references. #544.
//
// `seedRecordGraph` resolves EVERY bind in a group before creating ANY of that group's rows, and
// publishes the group's ids only once it completes. Topological ordering BETWEEN entities (which
// provisionSampleData already does) therefore cannot help WITHIN one: a `$parent` pointing at the
// row's own entity always resolves against an id that does not exist yet, and the whole sample-data
// phase halts — several phases into a build that has already written data. The App Spec cannot work
// around it either, because the plugin, not the author, decides the grouping.
//
// So the plugin splits the group: wave N holds the rows whose self-parents all landed in an earlier
// wave. Returns an array of waves, each an array of ORIGINAL record indices — original, because a
// bind's `parentIndex` is an index into the entity's full sample list and that is what the SDK looks
// up as `createdIds[entity][parentIndex]`.
//
// Returns a single wave when nothing self-references, which is the overwhelmingly common case and
// must stay byte-identical to the previous one-call-per-entity behaviour.
function selfReferenceWaves(entityLogical, records, labelFor) {
  const selfParents = records.map((r) =>
    (r.binds || []).filter((b) => b.parentEntity === entityLogical).map((b) => b.parentIndex));
  if (!selfParents.some((p) => p.length)) return [records.map((_, i) => i)];

  const waveOf = new Array(records.length).fill(-1);
  const waves = [];
  let remaining = records.map((_, i) => i);
  while (remaining.length) {
    const ready = remaining.filter((i) => selfParents[i].every((p) => waveOf[p] >= 0));
    if (!ready.length) {
      // Every remaining row is waiting on another remaining row: a cycle (including a row that is
      // its own parent). Name the rows — "a cycle exists" is not actionable, and the author needs
      // to know WHICH records to break. Failing here also beats looping forever.
      const involved = remaining.map((i) => labelFor(i)).join(', ');
      throw refusal(`sample data for '${entityLogical}' has a $parent cycle among its own rows (${involved}) — a row cannot be created before its parent. Break the cycle, or set the lookup after the build.`);
    }
    const readySet = new Set(ready);
    for (const i of ready) waveOf[i] = waves.length;
    waves.push(ready);
    remaining = remaining.filter((i) => !readySet.has(i));
  }
  return waves;
}

// Create sample rows topologically via the SDK's record-graph seeder. The plugin owns the App
// Spec translation (buildSeedGroup); the SDK owns @odata.bind formation and resolve-by-name
// idempotency. Groups are seeded one entity at a time (preserving the per-entity progress emit),
// with the accumulated createdIds threaded through so a child can bind to an already-seeded parent.
async function provisionSampleData({ sdk, provision, runner, spec, dataModel }) {
  const result = { records: {} };
  const entities = dataModel.entities;
  const statusReasonValues = dataModel.statusReasonValues;

  // entity-set resolver: fresh tables cached above; existing ones via fetchEntityMetadata.
  const entitySetFor = makeEntitySetResolver({ spec, entities, provision });

  const createdIds = {}; // logical -> ids (accumulator across entities for parent-bind resolution)
  for (const e of topoOrderEntities(spec)) {
    const records = sampleRecordsFor(spec, e);
    if (!records.length) continue;
    await runner.run('sample-data', `${records.length} record(s) -> ${e.schemaName}`, async () => {
      const group = buildSeedGroup({ spec, e, records, statusReasonValues });
      // Seeding is idempotent ONLY when a matchOn key is chosen (chooseMatchOn). Without one the SDK
      // inserts every row, so a re-run — or a POST retried after a commit — DUPLICATES the sample data,
      // violating the build's "full rerun is safe" contract. A fresh build is fine; warn (non-fatal, to
      // stderr — same pattern as download-model-app) so the maker can add a single-column alternate key or
      // unique <primary> values before relying on re-runs. This is additive: it does NOT change the seed
      // group, the create call, or the error/halt path — only emits a warning line for a keyless group.
      if (!group.matchOn && group.records.length > 0) {
        process.stderr.write(`WARNING: sample rows for ${e.schemaName} have no idempotency key (no single-column alternate key, and not every row has a non-empty ${e.primaryAttribute.schemaName}) — a re-run or a retried insert will DUPLICATE these ${group.records.length} row(s). Add a single-column alternate key or give every row a unique ${e.primaryAttribute.schemaName} value.\n`);
      }
      const logical = e.schemaName.toLowerCase();
      // #544: seed in waves when rows reference their OWN entity. `waves` is [[0,1,2,...]] — one
      // wave holding every row in order — unless a self-reference exists, so the common path below
      // is exactly the single call it has always been.
      const waves = selfReferenceWaves(logical, group.records, (i) => {
        const name = records[i] && records[i][e.primaryAttribute.schemaName];
        return name ? `'${name}'` : `record[${i}]`;
      });

      if (waves.length === 1) {
        const { createdIds: made } = await sdk.seedRecordGraph([group], { entitySetFor, createdIds });
        Object.assign(createdIds, made);
        result.records[e.schemaName] = made[logical];
        return;
      }

      // Ids indexed by ORIGINAL record position — the index a bind's `parentIndex` carries, and the
      // index the SDK reads as createdIds[entity][parentIndex]. A wave-local array would misresolve
      // every self-bind, silently linking rows to the wrong parents.
      const idsByIndex = new Array(group.records.length);
      for (const wave of waves) {
        const waveGroup = { ...group, records: wave.map((i) => group.records[i]) };
        const { createdIds: made } = await sdk.seedRecordGraph([waveGroup], {
          entitySetFor,
          // The SDK prefers ids created in the CURRENT call over these, but it publishes those only
          // after a group completes — so during bind resolution this array is what a self-bind sees.
          createdIds: { ...createdIds, [logical]: idsByIndex },
        });
        const madeIds = made[logical] || [];
        wave.forEach((original, k) => { idsByIndex[original] = madeIds[k]; });
        // A group only ever creates its own entity, but merge anything else the SDK reports rather
        // than dropping it on the floor.
        for (const [k, v] of Object.entries(made)) if (k !== logical) createdIds[k] = v;
      }
      createdIds[logical] = idsByIndex;
      result.records[e.schemaName] = idsByIndex;
    });
  }
  // Return entitySetFor closure so later phases can resolve entity-set names
  return { records: result.records, entitySetFor };
}

module.exports = { makeRunner, mapLimit, runBestEffort, requireSuccessfulPush, pushFailed, reportPartialPush, errorCodeChain, RESET_WORKSPACE, makeEntitySetResolver, resolveLanguageCode, resolveAuthoringLanguage, provisionSolution, provisionDataModel, settleOwedLengths, provisionSampleData, buildSeedGroup, BuildHalt, SDK_COLUMN_TYPE, isVisualizationUnsupported, localizedLabelLcidsInSpec, checkLocalizedLabelLanguages, findExistingTable, findExistingColumns, relationshipExists, lookupsWithDefaultLabel, relationshipsInCreateOrder };
