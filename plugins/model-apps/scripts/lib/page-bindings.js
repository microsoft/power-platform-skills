'use strict';
// A generative page's connector and Custom API bindings: what an App Spec states of them, and how a rebuild reads what it states against a page that holds more.
//
// A page holds two lists in its config.json beside its data sources and its model — `connectorBindings` (each entry goes through a connection reference, found by its logical name) and `actionBindings` (each
// names a Custom API by its unique name). As a page holds them (references/connectors.md and references/custom-api.md say what each property means):
//   { "connectorBindings": [ { "logicalName": "new_msnweather", "connectorId": "/providers/Microsoft.PowerApps/apis/shared_msnweather", "dataset": "", "operations": ["CurrentWeather"] } ],
//     "actionBindings":    [ { "name": "new_ApproveOrder", "isFunction": false, "boundEntityLogicalName": "salesorder", "displayName": "Approve Order", "parameterKinds": { "Comment": "String" } } ] }
//
// An entry can hold more than that. genpage-upload.js writes any JSON array it is given into the list, so an entry can carry a connection id of the environment it was made in, a credential someone put in a
// connectors.json, or a property a later runtime adds. The App Spec is what is committed, reviewed and shared, so it states an entry by an ALLOWLIST: the properties the two references document, each with the
// kind of value it holds. A value of another kind — an object where a text belongs, a nested list, a map whose values are not Dataverse parameter kinds — is not stated even under a property that is, because that
// is where a credential would ride; and neither is a text that is shaped like one. What a spec does not state is left out and named (by the property's name, never its value), and it stays on the page.
//
// That last part is what `mergeBindings` is for. A spec that states an entry says nothing of the properties it left out, so a rebuild into the environment the page is in must not take them away: it reads the
// entries a spec states as "what the page holds of these properties", writes a list only when that differs, and when it writes, keeps on each entry what the spec could not state.
const { compareText } = require('./compare-text.js');

// Each list of a page, with the property its entries are found by: a connector binding by the logical name of the connection reference it goes through, a Custom API binding by the API's unique name.
const PAGE_BINDINGS = { connectorBindings: 'logicalName', actionBindings: 'name' };

// The DataverseParameterKind strings the runtime reads from `parameterKinds`: the kinds of a Custom API's request parameter (customapirequestparameter.type), as scripts/list-custom-apis.js writes them. A closed
// set, so a value of the map is never free text.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/customapirequestparameter
const PARAMETER_KINDS = ['Boolean', 'DateTime', 'Decimal', 'Entity', 'EntityCollection', 'EntityReference', 'Float', 'Integer', 'Money', 'Picklist', 'String', 'StringArray', 'Guid'];

// What a text or a list may hold. A SharePoint site URL or a SQL dataset is far below the cap; a table list is a handful of GUIDs.
const MAX_TEXT = 2048;
const MAX_LIST = 1000;
// A Custom API request parameter's unique name: letters, digits, `_` and `.`, which is also why a key of `parameterKinds` cannot be a value.
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

// A text that holds a credential by its shape — a second line behind the allowlist, for the one kind of value the allowlist cannot judge by its type: a text. They are the forms a credential takes inside
// a dataset, a name or a label, e.g.
//   https://admin:hunter2@contoso.sharepoint.com/sites/x                  a password in the authority of a URL
//   https://account.blob.core.windows.net/c?sv=2022-11-02&sig=abc123       a shared-access signature in a query
//   Server=sql.contoso.net;Database=Sales;Password=hunter2                a connection string
//   Bearer abcdefgh12345   /   eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc     an Authorization value, a JSON Web Token
// A name=value pair only counts at the start of the text or after one of `?&;,` or a space, so `design=1` is not `sig=`. A text that is flagged is left out and said, so a false positive costs a property in
// the spec — the page keeps it — and a miss is no worse than a spec author who writes a secret by hand.
const CREDENTIAL_SHAPES = [
  /:\/\/[^\s/?#@]*:[^\s/?#@]*@/,
  /(?:^|[?&;,\s])(?:sig|signature|token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|pwd|secret|client[_-]?secret|api[_-]?key|account[_-]?key|shared[_-]?access[_-]?(?:key|signature))\s*=/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
];
const holdsCredential = (text) => CREDENTIAL_SHAPES.some((shape) => shape.test(text));

// Why `value` is not a thing a spec states for a property that holds it — a short code, never the value — or null when it is.
function textProblem(value) {
  if (typeof value !== 'string' || CONTROL.test(value)) return 'not-text';
  if (value.length > MAX_TEXT) return 'too-long';
  return holdsCredential(value) ? 'credential-shaped' : null;
}
function textListProblem(value) {
  if (!Array.isArray(value)) return 'not-text-list';
  if (value.length > MAX_LIST) return 'too-long';
  for (const item of value) {
    const why = textProblem(item);
    // An item that is no text makes the property no list of texts; one that is a text with a problem of its own keeps that problem's name.
    if (why === 'not-text') return 'not-text-list';
    if (why) return why;
  }
  return null;
}
const booleanProblem = (value) => (typeof value === 'boolean' ? null : 'not-boolean');
function parameterKindsProblem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not-parameter-kinds';
  const names = Object.keys(value);
  if (names.length > MAX_LIST) return 'too-long';
  return names.every((name) => PARAMETER_NAME.test(name) && PARAMETER_KINDS.includes(value[name])) ? null : 'not-parameter-kinds';
}

// The properties a spec states of each kind of entry, each with its check. This is the allowlist: a property that is not here is not stated, whatever it holds.
const FIELDS = {
  connectorBindings: { logicalName: textProblem, connectorId: textProblem, dataset: textProblem, tables: textListProblem, tableDisplayNames: textListProblem, operations: textListProblem },
  actionBindings: { name: textProblem, isFunction: booleanProblem, boundEntityLogicalName: textProblem, displayName: textProblem, parameterKinds: parameterKindsProblem },
};
const BINDING_PROPERTIES = Object.fromEntries(Object.entries(FIELDS).map(([kind, fields]) => [kind, Object.keys(fields)]));

// A property is named in a message only when its name is a plain identifier: a name is as free as a value, and one can carry a secret too (`sk-live-…`, `Authorization: Bearer …`).
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const UNUSUAL_NAME = '(a property with an unusual name)';
const shownName = (property) => (PLAIN_NAME.test(property) ? property : UNUSUAL_NAME);

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

// What a spec states of ONE entry (an object): { stated, leftOut }. `stated` holds the allowlisted properties whose value is of the kind the property holds, copied, in the entry's own order. `leftOut` names
// the others — [{ property, why }], by code-unit order of the name — and `why` says whether the property is not one a spec states ('not-stated') or is, with a value it cannot hold ('not-text',
// 'not-text-list', 'not-boolean', 'not-parameter-kinds', 'credential-shaped' or 'too-long'). It is never the value.
function statableBinding(kind, entry) {
  const fields = FIELDS[kind] || {};
  const stated = {};
  const leftOut = [];
  for (const property of Object.keys(entry)) {
    const why = hasOwn(fields, property) ? fields[property](entry[property]) : 'not-stated';
    if (why) leftOut.push({ property: shownName(property), why });
    else put(stated, property, copyOf(entry[property]));
  }
  leftOut.sort((a, b) => compareText(a.property, b.property));
  return { stated, leftOut };
}

// What a spec states of a whole list (one `pageBindingsProblem` finds no fault with): { stated, leftOut, blank }. `leftOut` is one record per entry that left something out — { entry, binding?, properties } —
// with `binding` the entry's own name when a spec states it, so a report can say which one; `blank` the places of the entries in which a spec can state nothing. A list with such an entry cannot be stated whole:
// an entry that is left out of a spec is an entry a rebuild would take off the page.
function statableBindings(kind, list) {
  const identity = PAGE_BINDINGS[kind];
  const stated = [];
  const leftOut = [];
  const blank = [];
  list.forEach((entry, index) => {
    const one = statableBinding(kind, entry);
    stated.push(one.stated);
    if (!Object.keys(one.stated).length) blank.push(index);
    const name = one.stated[identity];
    if (one.leftOut.length) leftOut.push({ entry: index, ...(typeof name === 'string' && name ? { binding: name } : {}), properties: one.leftOut });
  });
  return { stated, leftOut, blank };
}

const WHY_WORDS = {
  'not-text': 'must be a text',
  'not-text-list': 'must be a list of texts',
  'not-boolean': 'must be true or false',
  'not-parameter-kinds': 'must map parameter names to Dataverse parameter kinds',
  'credential-shaped': 'looks like it holds a credential, which an App Spec never states',
  'too-long': 'is longer than an App Spec states',
};

// The words a validator uses for one `leftOut` property of entry `index` of a list: it names the property and never its value.
function bindingProblemText(kind, index, { property, why }) {
  const at = `${kind}[${index}]`;
  if (why !== 'not-stated') return `${at}.${property} ${WHY_WORDS[why]}`;
  return property === UNUSUAL_NAME
    ? `${at} has a property with an unusual name, which an App Spec does not state — remove it`
    : `${at}.${property} is not a property an App Spec states (a binding states only ${BINDING_PROPERTIES[kind].join(', ')}) — remove it`;
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
