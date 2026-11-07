'use strict';
// The fixed vocabulary of a modern command button's row state: which command bars a row can sit on, what a row id and a row version look like,
// and why a row is or is not a candidate for a row-state edit. Pure: no request, no file, no clock.
//
// A modern command is an `appaction` row. Its `location` is a choice whose public values are
//   0 Form, 1 Main Grid, 2 Sub Grid, 3 Associated Grid, 4 Quick Form, 5 Global Header, 6 Dashboard
// (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appaction). The App Spec names the first three the way
// `commands[].location` already does — MainTab, HomeTab, ContextualTab — and no other: a row on another bar is shown by its number and is
// never mapped onto a supported one.

const { FORM_GUID_RE } = require('./app-spec.js');

// The App Spec's name of a bar -> the row's `location` value, and back.
const LOCATION_BY_BAR = Object.freeze({ MainTab: 0, HomeTab: 1, ContextualTab: 2 });
const BAR_BY_LOCATION = Object.freeze({ 0: 'MainTab', 1: 'HomeTab', 2: 'ContextualTab' });
const UNSUPPORTED_BAR = 'unsupported';

// A row's version is the weak entity tag the platform sends with the row, e.g.
//   "@odata.etag": "W/\"4893215\""
// It is used exactly as it came; a version is never built from `versionnumber`, compared as a number or replaced by "*".
// See https://learn.microsoft.com/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api
const ROW_VERSION = /^W\/"\d+"$/;

// A row id as the App Spec and the listing write it: lower case, hyphenated, no braces, not all zeros.
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

// The columns a row is read with. Every one of them must be in the answer: a column the platform left out is not a null, and a null is not a false.
const ROW_SELECT = Object.freeze([
  'appactionid', 'name', 'uniquename', 'buttonlabeltext', 'context', 'contextvalue', '_contextentity_value', '_appmoduleid_value', 'location',
  'type', 'origin', 'statecode', 'statuscode', 'ismanaged', 'iscustomizable', '_parentappactionid_value', 'hidden', 'isdisabled', 'visibilitytype',
  'visibilityformulacomponentlibrary', '_visibilityformulacomponentlibraryid_value', 'visibilityformulacomponentname', 'visibilityformulafunctionname',
  'onclickeventtype',
]);

// Why a row is not a candidate, one word each, in the order a listing shows them. A row that is a candidate has none.
//   shape-unreadable    a selected column is missing, or holds a value of the wrong kind (a number as text, a null where a number belongs)
//   id-mismatch         the answer is another row than the one asked for
//   context-not-table   the command is not bound to a table (`context` is not 1, Entity)
//   context-mismatch    its table (by logical name or by the table's metadata id) is not the one asked for
//   table-not-in-app    the table is not a component of the app
//   location-unsupported  the bar is none of MainTab, HomeTab, ContextualTab
//   location-mismatch   the bar is another one than the declared one
//   app-scoped          the row is scoped to an app (this one or another), not to its table: only table-scoped rows are edited in this version
//   not-standard-button  a drop-down, split button or group, not a plain button (`type` 0)
//   nested              the button sits inside another (it has a parent)
//   not-default-origin  migrated from the classic ribbon (`origin` is not 0, Default)
//   inactive            the row is deactivated
//   managed             the row came with a managed solution
//   not-customizable    the row is marked not customizable
//   flags-unreadable    `hidden` or `isdisabled` is not a true or a false
//   visibility-formula  the button's visibility is a Power Fx formula or classic rules (`visibilitytype` other than null or 0, or a formula field set)
//   formula-action      its on-click is a Power Fx formula
//   version-unavailable  no usable row version: optimistic concurrency is off for the table of commands, or the row came without its version
const REASONS = Object.freeze([
  'shape-unreadable', 'id-mismatch', 'context-not-table', 'context-mismatch', 'table-not-in-app', 'location-unsupported', 'location-mismatch',
  'app-scoped', 'not-standard-button', 'nested', 'not-default-origin', 'inactive', 'managed', 'not-customizable',
  'flags-unreadable', 'visibility-formula', 'formula-action', 'version-unavailable',
]);

// The refusal a reason stands for, when a row-state edit meets it: the first reason that applies decides.
const CODE_BY_REASON = Object.freeze({
  'shape-unreadable': 'command-state-row-unreadable',
  'flags-unreadable': 'command-state-row-unreadable',
  'id-mismatch': 'command-state-target-mismatch',
  'context-not-table': 'command-state-target-mismatch',
  'context-mismatch': 'command-state-target-mismatch',
  'location-mismatch': 'command-state-target-mismatch',
  'location-unsupported': 'command-state-target-mismatch',
  'app-scoped': 'command-state-app-scope-unverified',
  'table-not-in-app': 'command-state-context-unverified',
  'not-standard-button': 'command-state-target-unsupported',
  nested: 'command-state-target-unsupported',
  'not-default-origin': 'command-state-target-unsupported',
  inactive: 'command-state-target-unsupported',
  managed: 'command-state-target-unsupported',
  'not-customizable': 'command-state-target-unsupported',
  'visibility-formula': 'command-state-target-unsupported',
  'formula-action': 'command-state-target-unsupported',
  'version-unavailable': 'command-state-version-unavailable',
});
// Unreadable outranks mismatch, mismatch outranks unsupported: a row that cannot be read cannot be said to be the wrong one. An app-scoped row is
// refused for its scope before anything else is said about it: app scope is not supported in this version, whichever app the row belongs to.
const CODE_ORDER = ['command-state-row-unreadable', 'command-state-context-unverified', 'command-state-app-scope-unverified', 'command-state-target-mismatch', 'command-state-target-unsupported', 'command-state-version-unavailable'];

function codeForReasons(reasons) {
  const codes = new Set((reasons || []).map((reason) => CODE_BY_REASON[reason]).filter(Boolean));
  return CODE_ORDER.find((code) => codes.has(code)) || null;
}

// A row id in the one spelling this feature uses, or null when the text is not one: braces are not taken off here, because the App Spec
// writes ids without them and a listing prints them without them; the platform's answers are normalised with `guidOf`.
function canonicalRowId(text) {
  if (typeof text !== 'string' || text !== text.toLowerCase() || !FORM_GUID_RE.test(text) || text === ZERO_GUID) return null;
  return text;
}

// A GUID the platform answered, in lower case without braces, or null when the value is no GUID.
//   "_appmoduleid_value": "{5F0D3A2B-...}"  or  "5f0d3a2b-..."  or  null
function guidOf(value) {
  if (typeof value !== 'string') return null;
  const key = value.replace(/^\{|\}$/g, '').toLowerCase();
  return FORM_GUID_RE.test(key) ? key : null;
}

class CommandStateError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'CommandStateError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The one way this feature says what was wrong with an answer of the service: a failed read, a refused write, an answer it could not use.
// The design of row-state edits does not let ETags, digests, handlers or raw responses into a halt, a journal or a verify detail, and the
// service's free text can carry any of them. A refusal is answered as, e.g.
//   HTTP 403  { "error": { "code": "0x80040220", "message": "Principal user (Id=...) is missing prvReadAppAction privilege ..." } }
// and a malformed answer can hold anything in any field (a row id that is no GUID, a next-page link to anywhere). So the text below is built
// only from values that are checked here, each dropped when it is not of its shape, and fixed words:
//   status         an HTTP status, an integer
//   dataverseCode  `0x` and 8 hex digits, said in lower case: https://learn.microsoft.com/power-apps/developer/data-platform/reference/web-service-error-codes
//   systemCode     a system error code of a read with no answer at all (ECONNRESET), upper case letters, digits and `_`
//   field          the NAME of a field the answer got wrong, one of SERVICE_FIELDS — never its value
//   problem        one of SERVICE_PROBLEMS
// Every CommandStateError that says something about an answer is worded here; every other one is fixed text and values the feature checked
// itself (a row id, a table name, a bar), so a CommandStateError's message is safe to journal. tests/command-state-taint.test.js plants a
// marker in every service string a build, a listing and a verify read, and proves it reaches none of them.
const DATAVERSE_CODE = /^0x[0-9a-f]{8}$/i;
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const SERVICE_FIELDS = new Set([
  ...ROW_SELECT, '@odata.etag', '@odata.nextLink', 'value', 'appmoduleid', 'appmoduleidunique', 'componentstate', 'objectid', 'componenttype',
  'MetadataId', 'EntitySetName', 'LogicalName', 'IsOptimisticConcurrencyEnabled',
]);
const RUN_AGAIN = 'run it again, and if it persists check the environment\'s answer for this read';
const SERVICE_PROBLEMS = Object.freeze({
  // A read that was answered with an error status, or not answered: said by the facts alone (see serviceAnswerText).
  failed: null,
  'write-refused': null,
  // A table publication (PublishXml) that was refused or not answered: said by the facts alone, like a refused write.
  'publish-refused': null,
  'not-a-list': `the answer is not a list of rows; ${RUN_AGAIN}`,
  'not-a-record': `the answer holds something that is not a record; ${RUN_AGAIN}`,
  'repeated-link': `the answer repeated a next-page link; ${RUN_AGAIN}`,
  'malformed-link': `the answer's next-page link is not a link; ${RUN_AGAIN}`,
  'link-outside': 'the next-page link pointed outside the expected API and was not followed',
  'malformed-field': `the answer holds an unreadable value; ${RUN_AGAIN}`,
  unplaceable: `the answer holds a row that cannot be placed; ${RUN_AGAIN}`,
  'layer-ambiguous': `the answer does not name exactly one current layer of the app; ${RUN_AGAIN}`,
  unexpected: `the answer could not be read; ${RUN_AGAIN}`,
});

/**
 * @param {{ problem?: string, status?: number, dataverseCode?: string, systemCode?: string, field?: string|string[] }} facts
 * @returns {string} e.g. "HTTP 403, Dataverse error 0x80040220; check that the signed-in account can read it, and look the error code up"
 *   or "no usable answer (ECONNRESET); check the connection and run it again"
 *   or "the answer holds an unreadable value (objectid); run it again, ..."
 *   or, for 'publish-refused', "PublishXml answered HTTP 503, Dataverse error 0x80040220" (the warning around it says the remedy)
 */
function serviceAnswerText({ problem = 'failed', status, dataverseCode, systemCode, field } = {}) {
  const facts = [];
  if (Number.isInteger(status)) facts.push(`HTTP ${status}`);
  if (typeof dataverseCode === 'string' && DATAVERSE_CODE.test(dataverseCode)) facts.push(`Dataverse error ${dataverseCode.toLowerCase()}`);
  const said = facts.join(', ');
  if (problem === 'write-refused') return said ? `the platform refused the write (${said})` : 'the platform refused the write';
  const system = typeof systemCode === 'string' && SYSTEM_CODE.test(systemCode) ? ` (${systemCode})` : '';
  if (problem === 'publish-refused') return said ? `PublishXml answered ${said}` : `PublishXml got no usable answer${system}`;
  if (!Object.prototype.hasOwnProperty.call(SERVICE_PROBLEMS, problem)) problem = 'unexpected';
  if (problem === 'failed') {
    if (said) return `${said}; check that the signed-in account can read it, and look the error code up`;
    return `no usable answer${system}; check the connection and run it again`;
  }
  const fields = (Array.isArray(field) ? field : [field]).filter((name) => typeof name === 'string' && SERVICE_FIELDS.has(name));
  const [what, remedy] = SERVICE_PROBLEMS[problem].split('; ');
  return `${what}${fields.length ? ` (${fields.join(', ')})` : ''}${remedy ? `; ${remedy}` : ''}`;
}

// What a halt says about an error a build with commandStates caught at a table publication (sdk-build.js createTablePublication) and
// threw on unchanged. The error stays the one thrown — its message, code, cause and status are what decide a retry (retry-policy.js
// judgeFailure reads its words), so none of them is rewritten — and this mark beside it is what the runner that turns it into a halt
// (entity-provision.js makeRunner) says instead: the checked text (serviceAnswerText) and a code that is the error's own only when it has a
// system code's shape (an SDK's CONNECTION_ERROR, ARTIFACT_NOT_FOUND), else the runner's own `sdk-error`. An error carries no mark in a
// build without commandStates, so there the halt is the one 2.23.0 made. Non-enumerable, so nothing that copies or serialises the error
// carries it; an error that cannot take it (frozen, or not an object) keeps its own words.
const CHECKED_DISPLAY = Symbol.for('model-apps.command-state.checked-display');
function withCheckedDisplay(error, text) {
  if (!error || typeof error !== 'object') return error;
  const code = typeof error.code === 'string' && SYSTEM_CODE.test(error.code) ? error.code : 'sdk-error';
  try { Object.defineProperty(error, CHECKED_DISPLAY, { value: { text: String(text), code }, enumerable: false, configurable: true }); } catch { /* keeps its own words */ }
  return error;
}
/** @returns {{ text: string, code: string }} what a halt says of `error`: its checked mark, else its own message and code. */
function checkedDisplay(error) {
  const mark = error && typeof error === 'object' ? error[CHECKED_DISPLAY] : undefined;
  if (mark) return mark;
  return { text: String((error && error.message) || error), code: (error && error.code) || 'sdk-error' };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The App Spec's `commandStates[]`: the hidden / disabled state of an EXISTING table-scoped modern command, named by its row id.
//   { "entity": "contoso_order", "location": "MainTab", "scope": "table", "rowId": "11111111-1111-4111-8111-111111111111", "hidden": true }
// The first four keys are required, and at least one of `hidden` / `disabled`. A flag left out keeps what the row stores; `false` is an
// instruction. `disabled` is the row's `isdisabled` column.

const COMMAND_STATES_MIN_VERSION = '2.24.0';
const SPEC_INVALID = 'command-state-spec-invalid';
const APP_SCOPE_UNVERIFIED = 'command-state-app-scope-unverified';
const ENTRY_KEYS = Object.freeze(['entity', 'location', 'scope', 'rowId', 'hidden', 'disabled']);
// The App Spec's flag name -> the row's column.
const WIRE_FLAG = Object.freeze({ hidden: 'hidden', disabled: 'isdisabled' });
const SPEC_FLAG = Object.freeze({ hidden: 'hidden', isdisabled: 'disabled' });
// Keys an author may reach for from `commands[]` or the row itself. Each is an unknown field here; `isdisabled` names its spelling.
const FIELD_HINTS = Object.freeze({ isdisabled: 'use disabled' });

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const show = (value) => {
  try { return JSON.stringify(value); } catch { return String(value); }
};

/** True when the spec declares at least one command state. Absent and `[]` are the feature switched off. */
function usesCommandStates(spec) {
  return !!spec && typeof spec === 'object' && Array.isArray(spec.commandStates) && spec.commandStates.length > 0;
}

// A row id an author wrote, in the one spelling this feature uses: hex in either case is taken and lower-cased; braces, whitespace and the
// all-zero id are not.
const authoredRowId = (value) => (typeof value === 'string' ? canonicalRowId(value.toLowerCase()) : null);

/**
 * Offline checks of `spec.commandStates`. Absent: nothing to check. Every finding is one line that starts with its stable code and names the
 * entry and the reason:
 *   command-state-spec-invalid: commandStates[1].location (location-invalid): ...
 *   command-state-app-scope-unverified: commandStates[0].scope: ...
 * @returns {{ errors: string[], findings: { code: string, subreason: string|null, path: string, message: string }[] }}
 */
function validateCommandStates(spec) {
  const findings = [];
  const add = (code, subreason, path, message) => findings.push({ code, subreason, path, message });
  const invalid = (subreason, path, message) => add(SPEC_INVALID, subreason, path, message);
  const out = () => ({
    findings,
    errors: findings.map((f) => `${f.code}: ${f.path}${f.subreason ? ` (${f.subreason})` : ''}: ${f.message}`),
  });
  if (!spec || typeof spec !== 'object' || !own(spec, 'commandStates') || spec.commandStates === undefined) return out();
  const states = spec.commandStates;
  if (!Array.isArray(states)) {
    invalid('array-required', 'commandStates', `must be an array of command states (or left out); got ${show(states)}`);
    return out();
  }
  if (!states.length) return out();
  // The App Spec's declared tables by logical name (the schema name in lower case), the way commands[] and the build name them.
  const declared = new Set();
  for (const e of Array.isArray(spec.entities) ? spec.entities : []) {
    if (e && typeof e.schemaName === 'string' && e.schemaName.trim()) declared.add(e.schemaName.toLowerCase());
  }
  const seen = new Map();
  states.forEach((entry, i) => {
    const at = `commandStates[${i}]`;
    if (!isRecord(entry)) {
      invalid('object-required', at, `must be an object; got ${Array.isArray(entry) ? 'an array' : show(entry)}`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (ENTRY_KEYS.includes(key)) continue;
      const hint = FIELD_HINTS[key] ? ` (${FIELD_HINTS[key]})` : '';
      invalid('unknown-field', `${at}.${key}`, `is not a command-state field${hint}; a command state takes only ${ENTRY_KEYS.join(', ')}. `
        + 'It changes the hidden or disabled state of an existing button and nothing else about it');
    }
    if (typeof entry.entity !== 'string' || !declared.has(entry.entity.toLowerCase())) {
      invalid('entity-undeclared', `${at}.entity`, `must name a table declared in entities[]; got ${show(entry.entity)}`);
    }
    if (typeof entry.location !== 'string' || !own(LOCATION_BY_BAR, entry.location)) {
      invalid('location-invalid', `${at}.location`, `must be exactly MainTab, HomeTab or ContextualTab; got ${show(entry.location)}`);
    }
    if (entry.scope === 'app') {
      add(APP_SCOPE_UNVERIFIED, null, `${at}.scope`, 'app-scoped command rows are not supported in this version; only scope "table" is');
    } else if (entry.scope !== 'table') {
      invalid('scope-invalid', `${at}.scope`, `must be exactly "table"; got ${show(entry.scope)}`);
    }
    const rowId = authoredRowId(entry.rowId);
    if (!rowId) {
      invalid('row-id-invalid', `${at}.rowId`, `must be a row id like 11111111-1111-4111-8111-111111111111 (no braces, not all zeros); got ${show(entry.rowId)}. `
        + 'List the app\'s buttons with list-command-states.js to find it');
    } else if (seen.has(rowId)) {
      invalid('row-id-duplicate', `${at}.rowId`, `names the same row as commandStates[${seen.get(rowId)}]; give each row one entry with all its flags`);
    } else {
      seen.set(rowId, i);
    }
    for (const flag of ['hidden', 'disabled']) {
      if (own(entry, flag) && typeof entry[flag] !== 'boolean') invalid('boolean-required', `${at}.${flag}`, `must be true or false; got ${show(entry[flag])}`);
    }
    if (!own(entry, 'hidden') && !own(entry, 'disabled')) invalid('flags-required', at, 'must set hidden, disabled or both');
  });
  if (!spec.app || typeof spec.app.uniqueName !== 'string' || !spec.app.uniqueName.trim()) {
    invalid('app-unique-name-required', 'app.uniqueName', 'commandStates needs the app\'s unique name, which is how the build finds the app the buttons are checked against');
  }
  // Required here, not at the top: app-spec.js loads this module lazily from inside validateAppSpec, so its exports are complete by now.
  const { isPluginVersion, compareVersions } = require('./app-spec.js');
  const floor = spec.minimumPluginVersion;
  if (!isPluginVersion(floor) || compareVersions(floor, COMMAND_STATES_MIN_VERSION) < 0) {
    invalid('version-floor-required', 'minimumPluginVersion', `must be '${COMMAND_STATES_MIN_VERSION}' or newer when commandStates is used, so an older plugin refuses the spec rather than ignoring it`);
  }
  return out();
}

/**
 * One valid entry in the form the build uses. Call only on a spec validateCommandStates found nothing wrong with.
 * @returns {{ entity: string, bar: string, location: number, scope: 'table', rowId: string, desired: { hidden?: boolean, isdisabled?: boolean } }}
 */
function normalizeCommandState(entry) {
  return {
    entity: entry.entity.toLowerCase(),
    bar: entry.location,
    location: LOCATION_BY_BAR[entry.location],
    scope: 'table',
    rowId: authoredRowId(entry.rowId),
    desired: wireDesired(entry),
  };
}

/** Every entry, normalized, in the spec's order; [] when the feature is off. */
function normalizeCommandStates(spec) {
  return usesCommandStates(spec) ? spec.commandStates.map(normalizeCommandState) : [];
}

/** The flags an entry sets, by the row's column name: { hidden?: boolean, isdisabled?: boolean }. A flag left out is not in it. */
function wireDesired(entry) {
  const desired = {};
  for (const flag of ['hidden', 'disabled']) if (own(entry, flag) && typeof entry[flag] === 'boolean') desired[WIRE_FLAG[flag]] = entry[flag];
  return desired;
}

/**
 * The PATCH body: only the declared flags whose stored value differs, by column name. `false` is kept: it is an instruction.
 * @param {{ hidden?: boolean, isdisabled?: boolean }} desired
 * @param {{ hidden: boolean, isdisabled: boolean }} stored
 */
function diffCommandFlags(desired, stored) {
  const delta = {};
  for (const key of ['hidden', 'isdisabled']) if (own(desired, key) && desired[key] !== stored[key]) delta[key] = desired[key];
  return delta;
}

// The environment's origin as an approval names it: https and the host in lower case, no path. Anything else is no origin.
function canonicalOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  return url.protocol === 'https:' ? url.origin.toLowerCase() : null;
}

function digest(value) {
  const { canonicalJson } = require('./reconcile-common.js');
  const { sha256 } = require('./hash.js');
  return sha256(canonicalJson(value));
}

const ROW_TOKEN_PREFIX = 'overwrite:command-state:';
const TABLE_TOKEN_PREFIX = 'publish:command-state-table:';

/**
 * The approval for one row-state change: one observed version of one row under one intent.
 *   overwrite:command-state:<entity>/<bar>/<rowId>/<sha256>
 * The digest is the SHA-256 of the canonical JSON of
 *   { contract: "command-state-v1", origin, appId, tableId, entity, location: 0|1|2, scope: "table", rowId, ifMatch, desired }
 * so a new version of the row, another environment, app or table incarnation, or another intent each needs a new approval.
 */
function commandStateApprovalKey({ origin, appId, tableId, entity, location, rowId, ifMatch, desired }) {
  const hash = digest({
    contract: 'command-state-v1',
    origin: canonicalOrigin(origin),
    appId: guidOf(appId),
    tableId: guidOf(tableId),
    entity: String(entity).toLowerCase(),
    location,
    scope: 'table',
    rowId: guidOf(rowId),
    ifMatch,
    desired: { ...desired },
  });
  return `${ROW_TOKEN_PREFIX}${String(entity).toLowerCase()}/${BAR_BY_LOCATION[location]}/${guidOf(rowId)}/${hash}`;
}

/**
 * The approval to publish a table's saved customizations — ALL of them, not one row:
 *   publish:command-state-table:<entity>/<sha256 of { contract: "command-table-publish-v1", origin, appId, tableId, entity }>
 */
function commandTablePublishApprovalKey({ origin, appId, tableId, entity }) {
  const hash = digest({
    contract: 'command-table-publish-v1', origin: canonicalOrigin(origin), appId: guidOf(appId), tableId: guidOf(tableId), entity: String(entity).toLowerCase(),
  });
  return `${TABLE_TOKEN_PREFIX}${String(entity).toLowerCase()}/${hash}`;
}

const ROW_TOKEN = /^overwrite:command-state:([a-z][a-z0-9_]*)\/(MainTab|HomeTab|ContextualTab)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})$/;
const TABLE_TOKEN = /^publish:command-state-table:([a-z][a-z0-9_]*)\/([0-9a-f]{64})$/;

/** True for a `--authorize` value this feature claims: the two families above, spelled any way, so a malformed one is refused rather than read as a view's. */
const isCommandStateToken = (token) => typeof token === 'string'
  && (token.toLowerCase().startsWith(ROW_TOKEN_PREFIX) || token.toLowerCase().startsWith(TABLE_TOKEN_PREFIX));

/**
 * Claims this feature's `--authorize` values out of `raw` and checks each one's grammar against the spec's declarations. Exact tokens only:
 * no wildcard, no blanket approval, no token that names no declared row or table.
 * @returns {{ rows: Set<string>, tables: Set<string>, rest: string[], problems: string[] }}
 */
function commandStateAuthorizationKeys(raw, spec) {
  const rows = new Set();
  const tables = new Set();
  const rest = [];
  const problems = [];
  const states = (validateCommandStates(spec).errors.length ? [] : normalizeCommandStates(spec));
  const declaredRows = new Set(states.map((s) => `${s.entity}/${s.bar}/${s.rowId}`));
  const declaredTables = new Set(states.map((s) => s.entity));
  for (const token of raw) {
    if (!isCommandStateToken(token)) { rest.push(token); continue; }
    const row = ROW_TOKEN.exec(token);
    const table = row ? null : TABLE_TOKEN.exec(token);
    if (row) {
      if (!declaredRows.has(`${row[1]}/${row[2]}/${row[3]}`)) problems.push(`'${token}' names a command row that no commandStates entry declares`);
      else rows.add(token);
    } else if (table) {
      if (!declaredTables.has(table[1])) problems.push(`'${token}' names a table that no commandStates entry declares`);
      else tables.add(token);
    } else {
      problems.push(`'${token}' is not overwrite:command-state:<table>/<bar>/<row id>/<64 hex> or publish:command-state-table:<table>/<64 hex>, exactly as the build prints it`);
    }
  }
  return { rows, tables, rest, problems };
}

module.exports = {
  LOCATION_BY_BAR, BAR_BY_LOCATION, UNSUPPORTED_BAR, ROW_VERSION, ROW_SELECT, REASONS, CODE_BY_REASON,
  codeForReasons, canonicalRowId, guidOf, CommandStateError, serviceAnswerText, SERVICE_PROBLEMS, SERVICE_FIELDS, withCheckedDisplay, checkedDisplay,
  COMMAND_STATES_MIN_VERSION, WIRE_FLAG, SPEC_FLAG,
  usesCommandStates, validateCommandStates, normalizeCommandState, normalizeCommandStates, wireDesired, diffCommandFlags, canonicalOrigin,
  commandStateApprovalKey, commandTablePublishApprovalKey, commandStateAuthorizationKeys, isCommandStateToken,
};
