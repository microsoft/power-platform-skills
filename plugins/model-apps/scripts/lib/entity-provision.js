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
  relationshipSchemaName,
  manyToManySchemaName,
  quickCreateEnabledFor,
  normalizeLanguageCode,
} = require('./app-spec.js');
const { topoOrderEntities, entityByLogical } = require('./_graph.js');
// OData string-literal escaping for spec-controlled values interpolated into $filter (a solution
// uniquename / publisher prefix with a `'` would otherwise break the query or inject a clause).
const { odataLit } = require('./odata.js');
// Transport-level language reads. Needed here because `MakerSdkOptions.languageCode` is a
// construction-time option, so the LCID must be known before the SDK that would normally read it.
const { readOrgLanguageCode, readProvisionedLanguages } = require('./dataverse-auth.js');

// App Spec column type -> SDK ColumnType. Lookup is omitted (side effect of a OneToMany
// relationship); Customer is handled specially (createCustomerColumn).
const SDK_COLUMN_TYPE = {
  Text: 'string', Memo: 'memo', Choice: 'choice', MultiChoice: 'multiChoice',
  Boolean: 'boolean', Money: 'money', DateTime: 'dateTime',
  Integer: 'integer', BigInt: 'bigint', Decimal: 'decimal', Double: 'double',
  File: 'file', Image: 'image', AutoNumber: 'autonumber',
};
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
    { phase: 'data-model', code: 'language-not-provisioned', recoverable: false }
  );
}

// Dataverse label payloads must use an LCID the org actually has provisioned. Resolve an explicit
// CLI override first, then an App Spec override, then the org's base `organization.languagecode`,
// and only fall back to 1033 if discovery itself fails so an unrelated read error does not block
// the whole build.
async function resolveLanguageCode({ provision, spec, languageCode, warn, provisionedLanguages }) {
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
  switch (c.type) {
    case 'Text': if (c.maxLength) o.maxLength = c.maxLength; if (c.format) o.stringFormat = c.format; break;
    case 'Memo': if (c.maxLength) o.maxLength = c.maxLength; break;
    case 'Integer': case 'BigInt': case 'Decimal': case 'Double': case 'Money':
      if (c.minValue !== undefined) o.minValue = c.minValue;
      if (c.maxValue !== undefined) o.maxValue = c.maxValue;
      if (c.precision !== undefined) o.precision = c.precision; break;
    case 'DateTime': if (c.dateFormat) o.dateFormat = c.dateFormat; break;
    case 'Boolean': if (c.trueLabel) o.trueLabel = c.trueLabel; if (c.falseLabel) o.falseLabel = c.falseLabel; break;
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
  return o;
}

function choiceOptions(col) {
  return (col.options || []).map((label, i) => ({ value: 100000000 + i, label }));
}

const STATE_CODE = { Active: 0, Inactive: 1 };

class BuildHalt extends Error {
  constructor(message, { phase, code, recoverable = false, cause } = {}) {
    super(message);
    this.name = 'BuildHalt';
    this.phase = phase;
    this.code = code;
    this.recoverable = recoverable;
    this.cause = cause;
  }
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

// Bounded-concurrency map — parallelize independent ops without flooding Dataverse (which
// raises SQL-deadlock risk). Preserves input order in the result.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// A Runner owns the emit/counter/BuildHalt machinery so both consumers produce the
// identical { phase, status, label, n, total } event stream. `total` is supplied by the
// consumer (each computes its own plan length), so counting stays consumer-scoped.
function makeRunner({ emit, total }) {
  let n = 0;
  const run = async (phase, label, fn, { recoverable = false, skipIf } = {}) => {
    const myN = (n += 1);
    emit({ phase, status: 'start', label, n: myN, total });
    try {
      const out = await fn();
      emit({ phase, status: 'ok', label, n: myN, total });
      return out;
    } catch (err) {
      // Idempotency escape hatch: a create that fails only because the component already
      // exists is a skip, not a halt (used where the SDK offers no check-first lister).
      if (skipIf && skipIf(err)) { emit({ phase, status: 'skip', label: `${label} (exists)`, n: myN, total }); return undefined; }
      emit({ phase, status: 'error', label, n: myN, total, detail: String((err && err.message) || err) });
      throw new BuildHalt(`${phase} failed: ${(err && err.message) || err}`, { phase, code: (err && err.code) || 'sdk-error', recoverable, cause: err });
    }
  };
  const skip = (phase, label) => { emit({ phase, status: 'skip', label, n: (n += 1), total }); };
  return { run, mapLimit, skip, emit, total };
}

// Route every artifact push (form/view/chart/app/command/dashboard) through this. The SDK's
// pushArtifact RESOLVES (it does NOT throw) with a failed PushResult on a 412 — the artifact changed
// in Maker since our last fetch — and on an ARTIFACT_ALREADY_EXISTS collision. The engine previously
// ignored push results, so a conflict silently reported success while DROPPING the edit. Halt loudly
// and require a fresh download instead of auto refetch-and-overlay (which would clobber a concurrent
// Maker edit and violates the SDK's rebuild-from-model tenet, architecture-spec T6). Those two are
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
  const committed = result.saved !== undefined ? result.saved : result.success;
  if (committed === false || (committed === undefined && result.error)) {
    // Two DIFFERENT by-value failures reach here, and they need different remedies. Reporting an
    // already-exists collision as a concurrent edit tells the operator to re-download when nothing
    // changed under them, and hides the actual cause.
    const alreadyExists = result.error && result.error.code === 'ARTIFACT_ALREADY_EXISTS';
    const detail = (result.error && result.error.message) || 'version conflict (412)';
    throw new BuildHalt(
      alreadyExists
        ? `push ${what || result.type || 'artifact'} failed: ${detail} — a row already exists at that id and no duplicate was created; adopt it (fetchArtifact) instead of re-creating it`
        : `push ${what || result.type || 'artifact'} failed: ${detail} — the artifact changed in Maker since it was fetched; re-download the app and rebuild (never overwrite a concurrent edit)`,
      { phase: 'push', code: alreadyExists ? 'already-exists' : 'version-conflict', recoverable: true, cause: result.error }
    );
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
    await provision.createSolution({ uniqueName: solution.uniqueName, friendlyName: solution.displayName || solution.uniqueName, publisherId });
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
  return resolveLanguageCode({
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
async function provisionDataModel({ sdk, provision, runner, spec, apply, languageCode, warn, provisionedLanguages, preResolvedLanguageCode }) {
  const result = { entities: {}, globalChoiceIds: {}, statusReasonValues: {}, columns: {}, relationships: [] };
  // The CLI resolves the authoring LCID BEFORE constructing the SDK, because
  // `MakerSdkOptions.languageCode` is a construction-time option (#455) — the App/Form/Dashboard
  // adapters bake it in. Re-resolving here would repeat the org read and the provisioned-languages
  // probe, and could disagree with the value the SDK is already stamping into FormXML and sitemap
  // titles. So an already-resolved value wins outright. The self-resolving path stays for callers
  // that construct the SDK themselves and for the existing unit tests.
  const resolvedLanguageCode = preResolvedLanguageCode
    || await resolveLanguageCode({ provision, spec, languageCode, warn, provisionedLanguages });
  
  const globalChoiceIds = result.globalChoiceIds;
  const statusReasonValues = result.statusReasonValues;
  
  // 2a. Global option sets (shared choices) — built before columns that bind to them. The SDK's
  // createGlobalOptionSet is now IDEMPOTENT: it probes by Name and REUSES an existing set (returning
  // its MetadataId) instead of failing a duplicate-Name POST. So a rerun captures the existing set's
  // id here — fixing the old bug where the catch swallowed "already exists" and left the id undefined,
  // which forced every column on a rebuild to fall back to inline options (roadmap: global-choice
  // find-by-name). A GENUINE failure (400 validation / auth) now surfaces as a clean phase failure via
  // runner.run instead of being silently swallowed.
  for (const gc of spec.globalChoices || []) {
    await runner.run('data-model', `global choice ${gc.name}`, async () => {
      const r = await sdk.createGlobalOptionSet({ name: gc.name, displayName: gc.displayName || gc.name, languageCode: resolvedLanguageCode, options: (gc.options || []).map((label, i) => ({ value: 100000000 + i, label })) });
      globalChoiceIds[gc.name] = r.metadataId;
    });
  }
  
  // 2b. Tables -> columns (all types + customer) -> status reasons -> alternate keys.
  for (const e of spec.entities) {
    const logical = e.schemaName.toLowerCase();
    const hits = await provision.findTables(e.schemaName, { top: 50 });
    const existingTable = (hits || []).find((t) => t.logicalName === logical);
    let existingCols = new Set();
    if (existingTable) {
      runner.skip('data-model', `table ${e.schemaName} (exists — reuse)`);
      result.entities[e.schemaName] = { logicalName: logical, entitySetName: existingTable.entitySetName };
      existingCols = new Set(((await provision.findColumns(logical)) || []).map((c) => c.logicalName));
    } else {
      await runner.run('data-model', `table ${e.schemaName}`, async () => {
        const createOpts = { schemaName: e.schemaName, displayName: e.displayName, pluralName: e.pluralName || `${e.displayName}s`,
          primaryColumnSchemaName: e.primaryAttribute.schemaName, primaryColumnDisplayName: e.primaryAttribute.displayName || 'Name', hasNotes: e.hasNotes === true, languageCode: resolvedLanguageCode };
        // AutoNumber the primary/title column when requested (the order number IS the identity).
        if (e.primaryAttribute.autoNumberFormat) createOpts.primaryColumnAutoNumberFormat = e.primaryAttribute.autoNumberFormat;
        try {
          const t = await sdk.createTable(createOpts);
          result.entities[e.schemaName] = { logicalName: (t.logicalName || logical), entitySetName: t.entitySetName, metadataId: t.metadataId };
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
          // First POST likely succeeded server-side; a transient-network retry hit "already exists".
          // Rediscover to capture entitySetName (required by later phases).
          const rehits = await provision.findTables(e.schemaName, { top: 50 });
          const found = (rehits || []).find((x) => x.logicalName === logical);
          if (!found) throw err;
          result.entities[e.schemaName] = { logicalName: logical, entitySetName: found.entitySetName };
        }
      }, { recoverable: true });
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
    // columns: every buildable column (all scalar types + Customer; Lookup comes from a
    // relationship). Existing ones emit a skip; missing ones are created SERIALLY: Dataverse
    // takes a per-entity exclusive [EntityCustomization] lock, so two Attribute POSTs on the
    // same table collide with HTTP 429 ("Cannot start another [EntityCustomization]..."). The
    // outer entity loop is already sequential, so serial columns here means one metadata
    // customization is in flight per entity at a time — the only order Dataverse permits.
    const buildable = (e.columns || []).filter((c) => SDK_COLUMN_TYPE[c.type || 'Text'] || c.type === 'Customer');
    for (const c of buildable) if (existingCols.has(c.schemaName.toLowerCase())) runner.skip('data-model', `column ${e.schemaName}.${c.schemaName} (exists)`);
    const toCreate = buildable.filter((c) => !existingCols.has(c.schemaName.toLowerCase()));
    const colResults = await runner.mapLimit(toCreate, 1, (c) => runner.run('data-model', `column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`,
      () => c.type === 'Customer'
        ? sdk.createCustomerColumn(logical, { schemaName: c.schemaName, displayName: c.displayName || c.schemaName, required: REQUIRED(c), languageCode: resolvedLanguageCode })
        : sdk.createColumn(logical, columnOptions(c, globalChoiceIds, spec.globalChoices, resolvedLanguageCode)),
      { skipIf: isAlreadyExists }));
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
    for (const k of e.alternateKeys || []) {
      await runner.run('data-model', `alt key ${e.schemaName}.${k.schemaName}`,
        () => sdk.createAlternateKey(logical, { schemaName: k.schemaName, displayName: k.displayName || k.schemaName, keyAttributes: (k.columns || []).map((x) => x.toLowerCase()), languageCode: resolvedLanguageCode }),
        { recoverable: true, skipIf: isAlreadyExists });
    }
  }
  
  // 2c. Relationships — 1:N and N:N; skip those already present. The publisher prefix is threaded
  //     into the schema-name defaulting so a relationship to a standard/system table gets a valid,
  //     prefixed name Dataverse accepts (see prefixedRelationshipName).
  const publisherPrefix = spec.solution && spec.solution.publisherPrefix;
  for (const rel of spec.relationships || []) {
    if (rel.type === 'OneToMany') {
      const schema = relationshipSchemaName(rel, publisherPrefix);
      let exists = false;
      try { exists = ((await provision.fetchEntityMetadata(rel.referenced.toLowerCase())).relationships || []).some((r) => r.schemaName.toLowerCase() === schema.toLowerCase()); } catch { /* just created */ }
      if (exists) { runner.skip('data-model', `relationship ${schema} (exists)`); continue; }
      await runner.run('data-model', `relationship 1:N ${rel.referenced}->${rel.referencing}`, async () => {
        const res = await sdk.createRelationship({ type: 'OneToMany', schemaName: schema, referencedEntity: rel.referenced.toLowerCase(), referencingEntity: rel.referencing.toLowerCase(), lookupSchemaName: rel.lookup.schemaName, lookupDisplayName: rel.lookup.displayName, languageCode: resolvedLanguageCode });
        result.relationships.push({
          schemaName: res.schemaName || schema,
          metadataId: res.metadataId,
          kind: '1n',
          lookupLogicalName: res.lookupLogicalName
        });
      }, { skipIf: isAlreadyExists });
    } else if (rel.type === 'ManyToMany') {
      const schema = manyToManySchemaName(rel, publisherPrefix);
      let exists = false;
      try { exists = ((await provision.fetchEntityMetadata(rel.entity1.toLowerCase())).relationships || []).some((r) => r.schemaName.toLowerCase() === schema.toLowerCase()); } catch { /* just created */ }
      if (exists) { runner.skip('data-model', `relationship ${schema} (exists)`); continue; }
      await runner.run('data-model', `relationship N:N ${rel.entity1}<->${rel.entity2}`, async () => {
        const res = await sdk.createRelationship({ type: 'ManyToMany', schemaName: schema, entity1: rel.entity1.toLowerCase(), entity2: rel.entity2.toLowerCase(), intersectEntityName: rel.intersectEntityName, languageCode: resolvedLanguageCode });
        result.relationships.push({
          schemaName: res.schemaName || schema,
          metadataId: res.metadataId,
          kind: 'nn'
        });
      }, { skipIf: isAlreadyExists });
    }
  }
  
  return result;
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
// Choose the seedRecordGraph idempotency key (matchOn) for an entity's sample rows. The SDK dedups /
// reuses an existing row ONLY when matchOn is supplied, and it NEVER falls back to the primary
// display name — Dataverse permits duplicate names, so name-based resolve is a silent-wrong-id bug
// (see types/recordGraph.ts `SeedEntityGroup.matchOn`). To keep the old resolve-by-name idempotency
// WITHOUT regressing correctness:
//   1. prefer a single-column ALTERNATE KEY (Dataverse enforces its uniqueness — a safe key);
//   2. else fall back to the primary NAME column (the key the retired `primaryAttribute` used), which
//      carries the documented duplicate-name risk but preserves prior behavior;
// and in BOTH cases only when EVERY seeded record has a non-empty value for the chosen key — otherwise
// omit matchOn (insert every record, no dedup) rather than resolve on a partially-empty key, which
// would collapse or mis-bind rows. `body` values are the resolved Web-API values the SDK will filter on.
function chooseMatchOn(e, seedRecords) {
  const hasNonEmpty = (attr) =>
    seedRecords.length > 0 &&
    seedRecords.every((r) => { const v = r.body[attr]; return v !== undefined && v !== null && v !== ''; });
  for (const k of e.alternateKeys || []) {
    const cols = (k.columns || []).map((c) => String(c).toLowerCase());
    if (cols.length === 1 && hasNonEmpty(cols[0])) return cols[0];
  }
  const primary = e.primaryAttribute.schemaName.toLowerCase();
  if (hasNonEmpty(primary)) return primary;
  return undefined;
}

function buildSeedGroup({ spec, e, records, statusReasonValues }) {
  const resolved = resolveSampleRecords(e, records, spec);
  const seedRecords = [];
  for (let i = 0; i < resolved.length; i++) {
    const raw = records[i];
    const body = Object.assign({}, resolved[i]);
    delete body.$parent; delete body.$parents; delete body.statusReason;
    // Parent lookups — one (`$parent`) or many (`$parents`, e.g. a junction row binding both
    // sides). Each resolves to the parent's index within its own sample-record list; the SDK maps
    // that index to the created id and emits `<lookup>@odata.bind`.
    const binds = [];
    const parents = [].concat(raw && raw.$parent ? [raw.$parent] : [], (raw && raw.$parents) || []);
    for (const parent of parents) {
      if (!parent || !parent.entity || !parent.match) continue;
      const rel = relationshipFor(spec, parent.entity, e.schemaName);
      const parentEntity = entityByLogical(spec, parent.entity);
      // #1: fail loud on a bind that can't be formed instead of silently dropping it (which created
      // the child with the lookup UNSET and still reported success). validateAppSpec catches these at
      // lint time; this is the runtime backstop for a build that skipped validation. runner.run (the
      // caller) turns the throw into a clean sample-data phase failure.
      if (!rel || !parentEntity) {
        throw new Error(`sample data for '${e.schemaName}' declares a parent on '${parent.entity}' with no OneToMany relationship to it — fix the spec's $parent/$parents`);
      }
      const parentIndex = sampleRecordsFor(spec, parentEntity).findIndex((pr) => matchesRecord(pr, parent.match));
      if (parentIndex < 0) {
        throw new Error(`sample data for '${e.schemaName}': parent match ${JSON.stringify(parent.match)} found no '${String(parent.entity).toLowerCase()}' sample record — the '${rel.lookup.schemaName}' lookup would be left unset`);
      }
      binds.push({ navProperty: rel.lookup.schemaName, parentEntity: parent.entity.toLowerCase(), parentIndex });
    }
    // Custom status reason -> statecode + the captured statuscode option value. The value is
    // captured during the data-model phase (insertStatusValue); if that phase was skipped this run
    // the value is unknown — halt loudly instead of silently inserting a default status.
    if (raw && raw.statusReason) {
      const sv = (statusReasonValues[e.schemaName.toLowerCase()] || {})[raw.statusReason];
      if (!sv) throw new Error(`record sets statusReason '${raw.statusReason}' on ${e.schemaName}, but its status value wasn't captured — include the data-model phase (don't --skip data-model) so the custom status reason is created and its option value captured`);
      body.statuscode = sv.value; body.statecode = sv.stateCode;
    }
    seedRecords.push({ body, binds });
  }
  // matchOn (opt-in) replaces the retired `primaryAttribute`; see chooseMatchOn for the key policy.
  const matchOn = chooseMatchOn(e, seedRecords);
  return { entityLogical: e.schemaName.toLowerCase(), ...(matchOn ? { matchOn } : {}), records: seedRecords };
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
      // F9: seeding is idempotent ONLY when a matchOn key is chosen (chooseMatchOn). Without one the SDK
      // inserts every row, so a re-run — or a POST retried after a commit — DUPLICATES the sample data,
      // violating the build's "full rerun is safe" contract. A fresh build is fine; warn (non-fatal, to
      // stderr — same pattern as download-model-app) so the maker can add a single-column alternate key or
      // unique <primary> values before relying on re-runs. This is additive: it does NOT change the seed
      // group, the create call, or the error/halt path — only emits a warning line for a keyless group.
      if (!group.matchOn && group.records.length > 0) {
        process.stderr.write(`WARNING: sample rows for ${e.schemaName} have no idempotency key (no single-column alternate key, and not every row has a non-empty ${e.primaryAttribute.schemaName}) — a re-run or a retried insert will DUPLICATE these ${group.records.length} row(s). Add a single-column alternate key or give every row a unique ${e.primaryAttribute.schemaName} value.\n`);
      }
      const { createdIds: made } = await sdk.seedRecordGraph([group], { entitySetFor, createdIds });
      Object.assign(createdIds, made);
      result.records[e.schemaName] = made[e.schemaName.toLowerCase()];
    });
  }

  // Return entitySetFor closure so later phases can resolve entity-set names
  return { records: result.records, entitySetFor };
}

module.exports = { makeRunner, requireSuccessfulPush, reportPartialPush, makeEntitySetResolver, resolveLanguageCode, resolveAuthoringLanguage, provisionSolution, provisionDataModel, provisionSampleData, buildSeedGroup, BuildHalt, SDK_COLUMN_TYPE };
