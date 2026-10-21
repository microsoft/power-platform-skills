'use strict';
// A generative page's connector and Custom API bindings: what an App Spec states of them, and how a rebuild reads what it states against a page that holds more.
//
// A page holds two lists in its config.json beside its data sources and its model — `connectorBindings` (each entry goes through a connection reference, found by its logical name) and `actionBindings` (each
// names a Custom API by its unique name). As a page holds them (references/connectors.md and references/custom-api.md say what each property means):
//   { "connectorBindings": [ { "logicalName": "new_msnweather", "connectorId": "/providers/Microsoft.PowerApps/apis/shared_msnweather", "dataset": "", "operations": ["CurrentWeather"] } ],
//     "actionBindings":    [ { "name": "new_ApproveOrder", "isFunction": false, "boundEntityLogicalName": "salesorder", "displayName": "Approve Order", "parameterKinds": { "Comment": "String" } } ] }
//
// THREAT MODEL. An entry can hold more than that, and anything at all in it: genpage-upload.js writes any JSON array it is given into the list, so an entry can carry a connection id of the environment it was
// made in, a credential someone put in a connectors.json — as a property, as the NAME of a property, inside a URL's user-info, query or fragment, percent-encoded, in a map's keys — or a property a later runtime
// adds. The App Spec is what is committed, reviewed and shared, and a download's stderr and JSON result go to a terminal, a log and an agent's context. So nothing of a binding reaches any of them unless it is
// KNOWN to be safe, and the rule fails closed:
//   - a key is stated only when it is one of the properties the two references document (FIELDS), and a key of `parameterKinds` only when it is shaped like a request parameter's unique name and not like a token;
//   - a value is stated only when it has a conservative shape that is positively known (SHAPES): an identifier, a GUID, a plain name or label, or a URL whose PARSED form (`new URL`) has no user-info, no query and
//     no fragment and whose decoded path is plain names. A value that merely does not look like a credential is not enough — a credential has more forms than any list of them (a token alone in a URL's
//     user-info, `api%5Fkey=` in a query, `#access_token=` in a fragment, a bare token as a key);
//   - a list in which ANY entry holds anything else is left out of the spec WHOLE. Nothing is projected out of it, because an entry stated without what it was found by (`logicalName`, `name`) or without a
//     property it held would make a rebuild REPLACE the page's entry with less (mergeBindings matches entries by that identity). A list that is left out is a list a rebuild does not send, and the page keeps
//     its own as it is: no write and no publish.
// SINKS — every place a binding's text can go, and what goes there:
//   app-spec.json (download-model-app.js, through hydrateSpec)  only a list every entry of which is stated whole (statableBindings);
//   the download's stderr and JSON result (pageBindingsNote, pageBindingsReport: `pages`, `neededInTarget`, `notCarried`)  the names of the bindings of a list that is stated (identifiers, by SHAPES), and for a list
//       left out its kind, the place of the entry and the vetted name of the property — or "an unrecognized property" — never a value and never an unrecognized key (listProblemText);
//   validateAppSpec's errors and warnings (lib/app-spec.js)  the same words (bindingProblemText);
//   the build's warnings and halt (lib/page-binding-targets.js, lib/sdk-build.js)  binding names of a spec that passed validateAppSpec, so of the shapes above.
// The page folder's own config.json is the page as the environment holds it, written before the spec and not by these rules: it holds everything, and the download's note says so.
//
// That is why `mergeBindings` still matters. A spec that states an entry says nothing of the properties it does not state (an author who writes a list by hand, or a page that gains a property after it was
// downloaded), so a rebuild into the environment the page is in must not take them away: it reads the entries a spec states as "what the page holds of these properties", writes a list only when that differs,
// and when it writes, keeps on each entry what the spec does not state.
const { compareText } = require('./compare-text.js');

// Each list of a page, with the property its entries are found by: a connector binding by the logical name of the connection reference it goes through, a Custom API binding by the API's unique name.
const PAGE_BINDINGS = { connectorBindings: 'logicalName', actionBindings: 'name' };

// The DataverseParameterKind strings the runtime reads from `parameterKinds`: the kinds of a Custom API's request parameter (customapirequestparameter.type), as scripts/list-custom-apis.js writes them. A closed
// set, so a value of the map is never free text.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/customapirequestparameter
const PARAMETER_KINDS = ['Boolean', 'DateTime', 'Decimal', 'Entity', 'EntityCollection', 'EntityReference', 'Float', 'Integer', 'Money', 'Picklist', 'String', 'StringArray', 'Guid'];

const MAX_LIST = 1000;

// A text that is shaped like a token, wherever it stands — a name, a label, a key, a path segment. A conservative shape alone would let a token through when it happens to fit one (`ghp_` + 36 letters is an
// identifier), so every shape below is also held to this:
//   - the prefixes of the token formats that announce themselves: `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_` (GitHub), `xoxb-`… (Slack), `sk-`/`sk_live_`/`pk_live_`/`rk_live_` (API keys),
//     `AKIA`/`ASIA` (AWS access keys), `AIza` (Google), `ya29.` (OAuth), `eyJ` (the base64 of `{"`, which opens every JSON Web Token), an `npm_` token;
//   - an authorization scheme followed by a credential: `Bearer …`, `Basic …`;
//   - a run of 32 or more letters and digits that holds both — a hex digest, a key, a GUID written without its dashes. A connector's or reference's own random suffix is far shorter (`-5f6a8c`), and a
//     word of 32 letters has no digit.
// A label that is flagged leaves its list out of the spec: a false positive costs the page's list its portability, and the page keeps it.
const TOKEN_PREFIX = /(?:^|[^A-Za-z0-9])(?:gh[pousr]_|github_pat_|xox[abposr]-|sk-|sk_(?:live|test)_|pk_(?:live|test)_|rk_(?:live|test)_|AKIA|ASIA|AIza|ya29\.|eyJ|npm_)/;
const AUTH_SCHEME = /(?:^|\s)(?:bearer|basic|negotiate|digest)\s+\S/i;
const tokenLike = (text) => TOKEN_PREFIX.test(text) || AUTH_SCHEME.test(text) || (text.match(/[A-Za-z0-9]{32,}/g) || []).some((run) => /[0-9]/.test(run) && /[A-Za-z]/.test(run));

// The conservative shapes a value may have. Each is a positive description of what the value IS; anything outside it is not stated.
//   identifier  a connection reference's logical name, a table's logical name, a Custom API's unique name, an operation id: a letter, then letters, digits, `_`, `.` and `-` (up to 128)
//   guid        a SharePoint list id, a table id: 8-4-4-4-12 hex digits
//   name        a SQL dataset (`server,database`), a table name (`[dbo].[Orders]`), a dataset key (`default`): letters, digits, space and `_ . , : - [ ] ( )` (up to 256), opening with a letter, a digit or `[`
//   label       what a person reads — a display name: letters (any script), marks, digits, dashes, space and `_ . , ; : ' ( ) & + !` (up to 256). No `/`, `@`, `=`, `?`, `#`, `%` or quote, so no URL and no key=value
//   url         a SharePoint site and the like: `new URL` parses it as http(s), with no user-info (`user@`, `user:pass@`), no query and no fragment — the raw text holds no `?`, `#` or `@` at all — a host of DNS
//               labels, an optional port, and a path whose segments, decoded, are labels
// An empty text is a value only where the reference documents one: a connector binding's `dataset` is `""` for a REST connector.
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NAME = /^[A-Za-z0-9[][A-Za-z0-9 _.,:\-[\]()]{0,255}$/;
const LABEL = /^[\p{L}\p{M}\p{N}\p{Pd} _.,;:'()&+!]{1,256}$/u;
const DNS_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const isIdentifier = (value) => typeof value === 'string' && IDENTIFIER.test(value) && !tokenLike(value);
const isGuid = (value) => typeof value === 'string' && GUID.test(value);
const isName = (value) => typeof value === 'string' && NAME.test(value) && !tokenLike(value);
const isLabel = (value) => typeof value === 'string' && LABEL.test(value) && !tokenLike(value);
// The `new URL` of a WHATWG parser is what decides, not a pattern: it is what a browser and the runtime read the text as. The raw text is held to having no `?`, `#` and `@` first, because a parser that drops an
// empty query (`https://x/?`) or reads a `@` in the path as data would hide one.
function isSafeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[?#@\\\s]/.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password || url.search || url.hash || !DNS_HOST.test(url.hostname)) return false;
  for (const segment of url.pathname.split('/').filter(Boolean)) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (!LABEL.test(decoded) || tokenLike(decoded)) return false;
  }
  return !tokenLike(url.hostname);
}
// A connector's id as a binding and a reference write it — `/providers/Microsoft.PowerApps/apis/<connector name>` — or the bare name.
const CONNECTOR_PATH = /^\/providers\/Microsoft\.PowerApps\/apis\//i;
const isConnectorId = (value) => typeof value === 'string' && isIdentifier(value.replace(CONNECTOR_PATH, ''));
const isDataset = (value) => value === '' || isName(value) || isSafeUrl(value);
const isTableId = (value) => isGuid(value) || isName(value);
const listOf = (check) => (value) => Array.isArray(value) && value.length <= MAX_LIST && value.every(check);
const isBoolean = (value) => typeof value === 'boolean';
// A Custom API request parameter's unique name: a letter or `_`, then letters, digits and `_` — and never a token-shaped one: a key is as free as a value.
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
function isParameterKinds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const names = Object.keys(value);
  return names.length <= MAX_LIST && names.every((name) => PARAMETER_NAME.test(name) && !tokenLike(name) && PARAMETER_KINDS.includes(value[name]));
}

// The properties a spec states of each kind of entry, each with the shape its value must have, and the words that say what that shape is. This is the allowlist: a key that is not here is not stated, and a
// value that does not have its shape is not stated either.
const FIELDS = {
  connectorBindings: {
    logicalName: [isIdentifier, 'identifier'],
    connectorId: [isConnectorId, 'connector-id'],
    dataset: [isDataset, 'dataset'],
    tables: [listOf(isTableId), 'table-ids'],
    tableDisplayNames: [listOf(isLabel), 'labels'],
    operations: [listOf(isIdentifier), 'identifiers'],
  },
  actionBindings: {
    name: [isIdentifier, 'identifier'],
    isFunction: [isBoolean, 'boolean'],
    boundEntityLogicalName: [isIdentifier, 'identifier'],
    displayName: [isLabel, 'label'],
    parameterKinds: [isParameterKinds, 'parameter-kinds'],
  },
};
const BINDING_PROPERTIES = Object.fromEntries(Object.entries(FIELDS).map(([kind, fields]) => [kind, Object.keys(fields)]));

// What a message says instead of a key that is not one of FIELDS: the key itself can be the secret (a token used as a property name), so it is never echoed.
const UNUSUAL_NAME = 'an unrecognized property';

const hasOwn = (object, property) => Object.prototype.hasOwnProperty.call(object, property);
// Own-property writes that never run a setter: a config.json is parsed JSON, and `__proto__` in it is an own property like any other.
const put = (object, property, value) => Object.defineProperty(object, property, { value, enumerable: true, writable: true, configurable: true });
const copyOf = (value) => (Array.isArray(value) ? [...value] : (value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : value));
const isEntry = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Why `value` cannot be a page's `<kind>` in an App Spec — it is not a list, or one entry is not an object — or null when it can. validateAppSpec holds a spec to the same rule, so a download that asks before it
// writes a page's bindings into a spec never writes what the spec's own validation refuses.
function pageBindingsProblem(kind, value) {
  if (!Array.isArray(value)) return `${kind} is present but is not an array`;
  const at = value.findIndex((entry) => !isEntry(entry));
  return at === -1 ? null : `${kind}[${at}] is not an object`;
}

// The binding lists a spec page states, as the page backend takes them: { connectorBindings?, actionBindings? }. A list the page does not state is left out — the backend writes only what it
// is given, so the page keeps the bindings it holds — and a list it states, `[]` too, is the page's own from then on, as its `dataSources` are.
function statedPageBindings(page) {
  const out = {};
  for (const kind of Object.keys(PAGE_BINDINGS)) if (page && Array.isArray(page[kind])) out[kind] = page[kind];
  return out;
}

// What a spec states of ONE entry (an object): { stated, leftOut }. `stated` holds the properties of FIELDS whose value has its shape, copied, in the entry's own order. `leftOut` says what is not stated —
// [{ property, why }], the vetted properties first by code-unit order, then the unrecognized ones — where `property` is the vetted name, or UNUSUAL_NAME for a key that is not one (never the key), and `why` is 'not-stated' for such a key or the shape the value
// lacks ('identifier', 'connector-id', 'dataset', 'table-ids', 'labels', 'identifiers', 'boolean', 'label', 'parameter-kinds'). It is never the value.
function statableBinding(kind, entry) {
  const fields = FIELDS[kind] || {};
  const stated = {};
  const leftOut = [];
  for (const property of Object.keys(entry)) {
    if (!hasOwn(fields, property)) {
      leftOut.push({ property: UNUSUAL_NAME, why: 'not-stated' });
      continue;
    }
    const [holds, shape] = fields[property];
    if (holds(entry[property])) put(stated, property, copyOf(entry[property]));
    else leftOut.push({ property, why: shape });
  }
  // A vetted property first, by name — its words say more (a list left out because of its identity says so) — then the unrecognized ones, which all read alike.
  leftOut.sort((a, b) => Number(a.why === 'not-stated') - Number(b.why === 'not-stated') || compareText(a.property, b.property) || compareText(a.why, b.why));
  return { stated, leftOut };
}

// What a spec states of a whole list (one `pageBindingsProblem` finds no fault with): { stated, problem }. `stated` is the list as the spec states it — every entry whole — and `problem` null; or `stated` is null
// and `problem` is { entry, property, why } for the FIRST entry that holds anything a spec does not state (statableBinding): the list is then left out of the spec whole, because a spec that stated part of
// it would make a rebuild replace the page's entries with less (see the header). `property` is a vetted name or UNUSUAL_NAME, never the key or the value.
function statableBindings(kind, list) {
  const stated = [];
  for (let index = 0; index < list.length; index += 1) {
    const one = statableBinding(kind, list[index]);
    if (one.leftOut.length) return { stated: null, problem: { entry: index, property: one.leftOut[0].property, why: one.leftOut[0].why } };
    stated.push(one.stated);
  }
  return { stated, problem: null };
}

const WHY_WORDS = {
  identifier: 'must be an identifier (a letter, then letters, digits, _ . -)',
  'connector-id': "must be a connector's id (/providers/Microsoft.PowerApps/apis/<name>, or the name)",
  dataset: 'must be empty, a plain name, or an http(s) URL with no user-info, no query and no fragment',
  'table-ids': 'must be a list of GUIDs or plain names',
  labels: 'must be a list of plain labels',
  identifiers: 'must be a list of identifiers',
  boolean: 'must be true or false',
  label: 'must be a plain label (letters, digits, spaces and simple punctuation; no URL)',
  'parameter-kinds': 'must map parameter names to Dataverse parameter kinds',
};

// The words for one property of entry `index` of a list that is not stated (statableBinding's `leftOut`, statableBindings' `problem`): the vetted property's name and the shape its value lacks, or — for a key
// that is not one of FIELDS — that the entry holds an unrecognized property. Never the value, never the key.
function bindingProblemText(kind, index, { property, why }) {
  const at = `${kind}[${index}]`;
  if (why === 'not-stated') return `${at} holds ${UNUSUAL_NAME}, which an App Spec does not state (a binding states only ${BINDING_PROPERTIES[kind].join(', ')})`;
  return `${at}.${property} ${WHY_WORDS[why] || 'does not have the shape an App Spec states'}`;
}

// The list a rebuild writes for a spec that states `stated`, onto a page that holds `held`: each stated entry on the held entry of the same name (matched in order when a name is repeated; by place when neither side
// has one), with the properties the held entry has and the spec could not state — a connection id, a credential, a property a later runtime adds — kept, and every property a spec CAN state taken from the spec,
// including the removal of one it no longer states. An entry the page does not hold is as the spec states it, and a held entry the spec does not state is not in the result. The order is the spec's.
//
// So a spec that states the entries as the page holds them (a download writes exactly that) merges into the page's own list, and a rebuild that finds it equal writes nothing; and an edit changes what it names and
// nothing else. `held` that is no list (the page holds none) gives `stated` as it is.
function mergeBindings(kind, stated, held) {
  if (!Array.isArray(stated) || !Array.isArray(held)) return stated;
  const identity = PAGE_BINDINGS[kind];
  const taken = new Set();
  return stated.map((entry, index) => {
    if (!isEntry(entry)) return entry;
    const name = entry[identity];
    const at = typeof name === 'string'
      ? held.findIndex((own, i) => !taken.has(i) && isEntry(own) && own[identity] === name)
      : (isEntry(held[index]) && !taken.has(index) && typeof held[index][identity] !== 'string' ? index : -1);
    if (at === -1) return entry;
    taken.add(at);
    const own = held[at];
    const stateable = statableBinding(kind, own).stated;
    // The held entry's own order first, so an entry the edit left as it was is written as it was; then what the spec adds.
    const merged = {};
    for (const property of Object.keys(own)) {
      if (hasOwn(entry, property)) put(merged, property, entry[property]);
      else if (!hasOwn(stateable, property)) put(merged, property, own[property]);
    }
    for (const property of Object.keys(entry)) if (!hasOwn(merged, property)) put(merged, property, entry[property]);
    return merged;
  });
}

module.exports = {
  PAGE_BINDINGS,
  BINDING_PROPERTIES,
  PARAMETER_KINDS,
  UNUSUAL_NAME,
  WHY_WORDS,
  pageBindingsProblem,
  statedPageBindings,
  statableBinding,
  statableBindings,
  bindingProblemText,
  mergeBindings,
};
