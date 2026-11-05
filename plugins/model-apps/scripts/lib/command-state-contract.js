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
//   other-app           the row is scoped to another app
//   scope-mismatch      the row is scoped otherwise than declared (table or app)
//   not-standard-button  a drop-down, split button or group, not a plain button (`type` 0)
//   nested              the button sits inside another (it has a parent)
//   not-default-origin  migrated from the classic ribbon (`origin` is not 0, Default)
//   inactive            the row is deactivated
//   managed             the row came with a managed solution
//   not-customizable    the row is marked not customizable
//   flags-unreadable    `hidden` or `isdisabled` is not a true or a false
//   visibility-formula  the button's visibility is a Power Fx formula or classic rules
//   formula-action      its on-click is a Power Fx formula
//   version-unavailable  no usable row version: optimistic concurrency is off for the table of commands, or the row came without its version
const REASONS = Object.freeze([
  'shape-unreadable', 'id-mismatch', 'context-not-table', 'context-mismatch', 'table-not-in-app', 'location-unsupported', 'location-mismatch',
  'other-app', 'scope-mismatch', 'not-standard-button', 'nested', 'not-default-origin', 'inactive', 'managed', 'not-customizable',
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
  'other-app': 'command-state-target-mismatch',
  'scope-mismatch': 'command-state-target-mismatch',
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
// Unreadable outranks mismatch, mismatch outranks unsupported: a row that cannot be read cannot be said to be the wrong one.
const CODE_ORDER = ['command-state-row-unreadable', 'command-state-context-unverified', 'command-state-target-mismatch', 'command-state-target-unsupported', 'command-state-version-unavailable'];

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

module.exports = {
  LOCATION_BY_BAR, BAR_BY_LOCATION, UNSUPPORTED_BAR, ROW_VERSION, ROW_SELECT, REASONS, CODE_BY_REASON,
  codeForReasons, canonicalRowId, guidOf, CommandStateError,
};
