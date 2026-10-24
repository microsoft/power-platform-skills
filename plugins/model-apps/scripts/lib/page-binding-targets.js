'use strict';
// What a rebuild checks of the environment it writes a page's bindings into.
//
// A binding names what it goes through — a connection reference by the logical name a page calls it by, a Custom API by its unique name — and the spec can state the name and the connector the binding was made for
// (`connectorId`) but cannot make the reference: a connection holds a user's sign-in, and a Custom API is a solution component. So before a rebuild writes a binding it reads what the environment has for the names
// the spec states (readBindingTargets) and judges it (judgeBindingTargets):
//   - a reference that exists for ANOTHER connector is refused. The page calls a binding through the reference's logical name, so it would call that connector's operation under this name, with the signed-in user's
//     connection to it, and the name cannot tell the two apart. Nothing is guessed or made: the author gives the binding a name that is the right reference's, or states the connector this environment has;
//   - a reference or a Custom API that is not there is said by name. The page is written with its binding all the same: the page finds the reference by name when it runs, so one made afterwards makes the page work
//     without a rebuild;
//   - a Custom API of the other kind (an Action for a Function) or bound to another table is said by name: the runtime refuses such a call before it is sent, so it is a warning and never a refusal;
//   - a reference of the right connector that has NO connection is said by name — what a solution import leaves when no settings file gives one: the page's calls through it fail until it has one;
//   - an operation a binding calls that the connector there does not define is said by name, where the environment holds the connector's definition. A connector the platform publishes — every connector that is
//     not a custom one — has one definition for every environment of its cloud, the one the binding's operations were read from (connector.js), so a reference for the same connector offers them, and nothing is
//     read for it. A CUSTOM connector's definition is a row of the environment it is in (the `connector` table's `openapidefinition`, which the reference points at through `customconnectorid`), and the copy
//     there can be another version than the page was made with: that one is read, and an operation it does not define is a warning — the call fails, it does not reach another service.
// A read that fails is said — the bindings were not checked — and never read as "nothing is there"; a row that answers without a column the check needs (successful but incomplete) is said the same way, as
// not checked, and never read as "compatible". Nothing is refused without evidence that contradicts the binding.
//
// BUILT-IN OPERATIONS. Two `actionBindings` names are not Custom APIs at all: WhoAmI and RetrieveVersion, the reviewed built-in Dataverse operations (lib/dataverse-operations.js). They are
// messages the platform defines, not rows of `customapi`, so reading `customapi` for them could only answer "not there" and send the author to deploy what cannot be deployed. A binding whose name
// is EXACTLY one of them leaves the Custom API read — before the names are folded in case and cut into requests, so `whoami` beside `WhoAmI` is still read under its own spelling — and nothing is
// read in its place: whether the environment or its page player offers the operation, and whether the signed-in user may call it, is said as NOT CHECKED, never as "compatible". A binding of that
// name whose own declarations do not explicitly say "an unbound Function with no inputs" is a warning, and it is written as the spec states it: never repaired, and never refused. Any other
// spelling (`whoami`, `Microsoft.Dynamics.CRM.WhoAmI`) and any other operation is a Custom API name, read and judged as one.
const { odataLit } = require('./odata.js');
const { normalizePageSource } = require('./app-spec.js');
const { PAGE_BINDINGS, statedPageBindings } = require('./page-bindings.js');
const { getReviewedDataverseOperation } = require('./dataverse-operations.js');

// A filter is bounded: the names of a long list are read in requests of this many, not in one URL.
const CHUNK = 25;
// A name is quoted in a message as far as a reader needs to find it, not as far as it goes on.
const MAX_SHOWN = 80;
const shown = (name) => {
  const text = String(name);
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 3)}...` : text;
};
const quoted = (name) => JSON.stringify(shown(name));

// The name of a connector, whatever form its id is written in: the last segment of its path, lower-cased.
//   /providers/Microsoft.PowerApps/apis/shared_msnweather   a connection reference's `connectorid`, and what the planner writes into a binding
//   shared_msnweather                                       the bare name
// Two ids name the same connector when their names are equal. A custom connector's name is `shared_<name>-5f<hash>`, and the same connector made separately in two environments has another hash in each, so a
// binding made with one does not match the other: that is a conflict the author settles by stating the connector this environment has. null when there is no name.
// See: https://learn.microsoft.com/power-platform/admin/connector-reference-in-the-environment
function connectorKey(id) {
  if (typeof id !== 'string') return null;
  const last = id.trim().replace(/\/+$/, '').split('/').pop().toLowerCase();
  return last || null;
}

// The connector ids that are COMPARED, each checked for its syntax first — a value of another shape is evidence of nothing, so it is never compared, and so never a conflict (it is reported as not checked).
//   a reference row's `connectorid`  exactly the API id Dataverse writes: `/providers/Microsoft.PowerApps/apis/shared_<name>` — a standard connector (`shared_msnweather`) or a custom one
//                                    (`shared_contoso-5fwidgets-5f6a8c`, whose own identity is the `_customconnectorid_value` lookup). `***`, a bare name, a number or an object is not one.
//   a binding's `connectorId`        that API id, or its bare `shared_<name>` (both are what a spec may state; references/connectors.md)
// Each answers the lower-cased connector name, or null.
const CONNECTOR_API_ID = /^\/providers\/Microsoft\.PowerApps\/apis\/(shared_[A-Za-z0-9_.-]{1,128})$/i;
const CONNECTOR_NAME = /^(shared_[A-Za-z0-9_.-]{1,128})$/i;
const referenceConnectorKey = (id) => (typeof id === 'string' && CONNECTOR_API_ID.test(id) ? id.match(CONNECTOR_API_ID)[1].toLowerCase() : null);
const bindingConnectorKey = (id) => (typeof id === 'string' && (CONNECTOR_API_ID.test(id) || CONNECTOR_NAME.test(id)) ? connectorKey(id) : null);

// The pages a build writes that state a binding: [{ key, name, connectorBindings?, actionBindings? }], with the lists as the spec states them, in the spec's order. A page with no source the build can deploy is not
// written, and a page that states no entry has nothing to check.
// A changed-only run (`changedOnly.selectedKeys`) writes the pages it selected, and a page another one navigates to only when that page is ABSENT: the pages phase makes an absent target first, from its own spec
// entry, bindings and all, and leaves one that exists as it is (sdk-build.js, `uploadedThisRun`). Which targets exist is settled by the pages phase, after this check has run, so the run may be told which of its
// pages are deployed (`changedOnly.deployedKeys`: the changed-only flow passes the pages its last verified apply recorded). A target it is told of is left out; one it is not told of may be absent, so it is checked —
// what is not known is never read as "it exists". A target it was told of and that the pages phase finds absent after all (deleted in Maker since) is checked there, before it is made (pagesMadeUnchecked).
function pagesStatingBindings(spec, { changedOnly } = {}) {
  const pages = Array.isArray(spec && spec.pages) ? spec.pages : [];
  const selected = changedOnly && Array.isArray(changedOnly.selectedKeys) ? new Set(changedOnly.selectedKeys) : null;
  const deployed = new Set(selected && Array.isArray(changedOnly.deployedKeys) ? changedOnly.deployedKeys : []);
  const navigatedTo = new Set(pages.flatMap((page) => ((page && page.navigatesTo) || []).map((target) => target && target.targetKey)));
  const out = [];
  for (const page of pages) {
    const source = normalizePageSource(page);
    if (!(source && source.kind === 'tsx' && source.codeFile)) continue;
    const key = page.key || page.name;
    if (selected && !selected.has(key) && !(navigatedTo.has(key) && !deployed.has(key))) continue;
    const lists = statedPageBindings(page);
    if (!Object.values(lists).some((list) => list.length)) continue;
    out.push({ key, name: page.name, ...lists });
  }
  return out;
}

// The pages the pages phase is about to MAKE (`made`: the keys of the absent navigation targets it creates) that state a binding the check before writing did not judge, because the run was told the page
// is deployed (pagesStatingBindings): each is checked before the first is made, as that check would have checked it, and by what the attempt has already read (bindingReads). Every other page the run
// writes was checked before it wrote anything, so this is [] for a run that was told nothing, and for a full build.
function pagesMadeUnchecked(spec, { changedOnly, made }) {
  const checked = new Set(pagesStatingBindings(spec, { changedOnly }).map((page) => page.key));
  return pagesStatingBindings(spec).filter((page) => made.has(page.key) && !checked.has(page.key));
}

// The pages that state a binding and that the check before writing leaves out only because the run was told they are deployed (pagesStatingBindings): what a dry run, which has no pages phase to
// find one absent, asks the environment about before it leaves them out (sdk-build.js, confirmDeployedTargets). [] for a run told nothing, and for a full build.
function pagesLeftOutAsDeployed(spec, changedOnly) {
  if (!changedOnly || !Array.isArray(changedOnly.deployedKeys)) return [];
  const checked = new Set(pagesStatingBindings(spec, { changedOnly }).map((page) => page.key));
  return pagesStatingBindings(spec, { changedOnly: { ...changedOnly, deployedKeys: undefined } }).filter((page) => !checked.has(page.key));
}

// The names the pages state for one kind of binding: each once, as the first page spells it (the service compares them without regard to case, and the match here is made in lower case).
// A built-in operation's binding names no `customapi` row (see the header), so it is left out of the Custom API names — first, before the folding: WhoAmI and whoami would otherwise fold to one
// name, and the one read would be WhoAmI's, leaving whoami unread.
function namesOf(pages, kind) {
  const identity = PAGE_BINDINGS[kind];
  const names = new Map();
  for (const page of pages) {
    for (const entry of page[kind] || []) {
      if (kind === 'actionBindings' && isBuiltInOperation(entry)) continue;
      const name = entry && typeof entry[identity] === 'string' ? entry[identity].trim() : '';
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
  }
  return [...names.values()];
}

// Whether an `actionBindings` entry names a reviewed built-in operation — by its EXACT name, as the catalogue matches it: `whoami` is a Custom API name.
const isBuiltInOperation = (entry) => Boolean(entry && typeof entry === 'object' && getReviewedDataverseOperation(entry[PAGE_BINDINGS.actionBindings]));

async function readNamed(provision, entity, select, column, names) {
  const rows = [];
  for (let at = 0; at < names.length; at += CHUNK) {
    const filter = names.slice(at, at + CHUNK).map((name) => `${column} eq '${odataLit(name)}'`).join(' or ');
    rows.push(...((await provision.queryRecords(entity, { select, filter, paginate: true })) || []));
  }
  return rows;
}

const text = (value) => (typeof value === 'string' && value.trim() ? value : undefined);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The operations a binding calls (`operations`, the operation ids `executeConnectorOperation` is given), each once, in its order.
function operationsOf(entry) {
  const listed = entry && Array.isArray(entry.operations) ? entry.operations : [];
  return [...new Set(listed.filter((operation) => typeof operation === 'string' && operation !== ''))];
}

// The HTTP methods under which a Swagger 2.0 path item holds an operation. Its other members — `parameters` (shared by its operations), `$ref`, an `x-ms-…` extension — are not operations.
// See: https://swagger.io/specification/v2/#path-item-object
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

// The operation ids a custom connector's definition declares — its `openapidefinition`, the Swagger 2.0 document the connector was made from, as text:
//   { "swagger": "2.0", "info": { … }, "host": "widgets.contoso.example",
//     "paths": { "/widgets": { "parameters": [ … ], "get": { "operationId": "ListWidgets", … }, "post": { "operationId": "AddWidget", … } }, "/widgets/{id}": { "get": { "operationId": "GetWidget", … } } } }
// as a Set, matched exactly — case included — as the bundled SDK matches a connector's operation ids (projectConnectorOperations, which is how connector.js lists the ids a binding's `operations` hold).
// null when the text is not such a document, or holds a path item it cannot see into (a `$ref` to one elsewhere): its operations are then NOT checked, which is never "it defines none".
function definedOperations(definition) {
  let document;
  try {
    document = typeof definition === 'string' ? JSON.parse(definition.replace(/^\uFEFF/, '')) : null;
  } catch {
    return null;
  }
  const paths = document && typeof document === 'object' && !Array.isArray(document) ? document.paths : null;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return null;
  const ids = new Set();
  for (const item of Object.values(paths)) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.prototype.hasOwnProperty.call(item, '$ref')) return null;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation && typeof operation === 'object' && typeof operation.operationId === 'string' && operation.operationId !== '') ids.add(operation.operationId);
    }
  }
  return ids;
}

// The definitions of the custom connectors `ids` names (lower-cased `connector` ids): Map<id, Set<operation id> | { problem }>. A connector the read does not return, a definition that is not a document
// this reads (definedOperations), and a read that fails are each a `problem` of the connectors it concerns — never an empty definition.
// A `connector` row as the Web API answers it (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/connector):
//   { "connectorid": "c0000000-0000-4000-8000-0000000000a1", "openapidefinition": "{\"swagger\":\"2.0\",\"paths\":{…}}" }
async function readDefinitions(reader, ids) {
  const definitions = new Map();
  try {
    if (!reader) throw new Error('the rows cannot be read here');
    for (let at = 0; at < ids.length; at += CHUNK) {
      const filter = ids.slice(at, at + CHUNK).map((id) => `connectorid eq ${id}`).join(' or ');
      for (const row of (await reader.queryRecords('connector', { select: ['connectorid', 'openapidefinition'], filter, paginate: true })) || []) {
        const id = row && typeof row.connectorid === 'string' ? row.connectorid.toLowerCase() : '';
        if (!ids.includes(id) || definitions.has(id)) continue;
        const defined = definedOperations(row.openapidefinition);
        definitions.set(id, defined || { problem: 'its definition is not a Swagger document this build can read' });
      }
    }
    for (const id of ids) if (!definitions.has(id)) definitions.set(id, { problem: 'no connector row of that id was found' });
  } catch (error) {
    for (const id of ids) definitions.set(id, { problem: String((error && error.message) || error) });
  }
  return definitions;
}

// What one attempt of a build has read of what the pages' bindings name, for readBindingTargets: per kind, Map<lower-cased name, { row } | { none: true } | { problem }>, and the custom connectors'
// definitions by id. The check before writing and the pages phase's check of a navigation target it finds it has to make (sdk-build.js) share one, so a name is read ONCE per attempt, and what
// that read answered — a row, no row, a failure — stands for every check of the attempt. A later check never asks again: it adds no request, and a second read that fails can never turn what
// the first one proved (a reference for another connector) into "not checked". A new attempt (the build's re-run of a halt) starts a new one, and reads again.
function bindingReads() {
  return { references: new Map(), apis: new Map(), definitions: new Map() };
}

// What the environment has for the names `pages` state: { references, apis, definitions, problems }.
//   references   Map<lower-cased logical name, { connectorId, connected?, customConnectorId? }> of the connection references (`connectionreference` rows) — or null when no page states a connector binding, or
//                the read failed. Each piece is kept only as the row PROVES it, and anything else is left out — which judgeBindingTargets reads as "not known", never as "fine":
//                  connectorId        the row's `connectorid` when it is a connector's API id (referenceConnectorKey); absent, null, blank or of any other shape leaves it out (the connector is then not compared)
//                  connected          true or false when the row's `connectionid` is a text or null (null or blank: no connection); absent, or a value of another type, leaves it out (whether it has one is then
//                                     not checked)
//                  customConnectorId  the lower-cased GUID in `_customconnectorid_value`; absent, null or not a GUID leaves it out. A null lookup is NOT proof that the connector is not a custom one — a reference
//                                     made through the Web API can leave it unset — so the operations through such a reference are reported as not checked, not as defined
// SUCCESSFUL BUT INCOMPLETE: a read that answers 200 with a row that lacks a column is as much "not known" as a read that fails. Nothing here infers compatibility from a value that is not there.
//   apis         Map<lower-cased unique name, { isFunction, boundEntity? }> of the Custom APIs (`customapi` rows) — or null likewise, and null when every action binding names a built-in operation,
//                which is not read (see the header)
//   definitions  Map<custom connector id, Set<operation id> | { problem }> (readDefinitions) of the custom connectors a binding that calls operations goes through — or null when there is none
//   problems     { references?, apis? }: why a read failed, as the service said it. A failed read does not stop the other, and is never an empty answer.
//   unread       { references?, apis? }: Map<lower-cased name, why> — present only beside answered names, which only an attempt's LATER check meets (below): the names an earlier read of the attempt could not
//                read. They are not checked and are said so, by name, while the names that were read are judged.
// Only the rows of the names asked for are kept, whatever the service answered.
// `seen` (bindingReads) is what the attempt has read so far: a name it holds is not asked for again, and its answer — a row, no row, a failure — is the one this check is given. One check alone (a
// fresh `seen`) reads every name once and answers exactly as a single read always did: the rows found, or null and why the read failed.
// A connection reference row as the Web API answers it (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/connectionreference); `connectionid` is null while it has no
// connection, and `_customconnectorid_value` null when no custom connector is recorded for it:
//   { "connectionreferencelogicalname": "contoso_msnweather", "connectorid": "/providers/Microsoft.PowerApps/apis/shared_msnweather", "connectionid": "shared-msnweather-…", "_customconnectorid_value": null }
// and a Custom API row (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/customapi), `bindingtype` 0 Global, 1 Entity, 2 EntityCollection:
//   { "uniquename": "contoso_ApproveOrder", "isfunction": false, "bindingtype": 1, "boundentitylogicalname": "contoso_item" }
async function readBindingTargets(provision, pages, seen = bindingReads()) {
  const targets = { references: null, apis: null, definitions: null, problems: {} };
  const reader = provision && typeof provision.queryRecords === 'function' ? provision : null;
  const read = async (kind, entity, select, column, keyOf, valueOf, target) => {
    const names = namesOf(pages, kind);
    if (!names.length) return;
    const known = seen[target];
    const fresh = names.filter((name) => !known.has(name.toLowerCase()));
    if (fresh.length) {
      try {
        if (!reader) throw new Error('the rows cannot be read here');
        const wanted = new Set(fresh.map((name) => name.toLowerCase()));
        const found = new Map();
        for (const row of await readNamed(reader, entity, select, column, fresh)) {
          const key = row && typeof keyOf(row) === 'string' ? keyOf(row).trim().toLowerCase() : '';
          if (key && wanted.has(key) && !found.has(key)) found.set(key, valueOf(row));
        }
        for (const name of wanted) known.set(name, found.has(name) ? { row: found.get(name) } : { none: true });
      } catch (error) {
        const problem = String((error && error.message) || error);
        for (const name of fresh) known.set(name.toLowerCase(), { problem });
      }
    }
    const answers = names.map((name) => [name.toLowerCase(), known.get(name.toLowerCase())]);
    const why = [...new Set(answers.map(([, answer]) => answer.problem))];
    // Every name unread for one reason — the one read failed, as a single read's failure always read: null, and why.
    if (why.length === 1 && why[0] !== undefined) {
      targets.problems[target] = why[0];
      return;
    }
    const rows = new Map();
    for (const [name, answer] of answers) {
      if (answer.row) rows.set(name, answer.row);
      else if (answer.problem !== undefined) {
        if (!targets.unread) targets.unread = {};
        if (!targets.unread[target]) targets.unread[target] = new Map();
        targets.unread[target].set(name, answer.problem);
      }
    }
    targets[target] = rows;
  };
  await read('connectorBindings', 'connectionreference', ['connectionreferencelogicalname', 'connectorid', 'connectionid', '_customconnectorid_value'], 'connectionreferencelogicalname',
    (row) => row.connectionreferencelogicalname,
    (row) => ({
      // Only a connector id of the shape Dataverse writes is kept (referenceConnectorKey): a malformed one is left out, and so read as not known — never as a connector to refuse a binding over.
      ...(referenceConnectorKey(row.connectorid) ? { connectorId: row.connectorid } : {}),
      // A text is the connection (blank: none), and null is none; any other value — a number, an object — says nothing, and is left out like an absent column.
      ...(row.connectionid === null || typeof row.connectionid === 'string' ? { connected: Boolean(text(row.connectionid)) } : {}),
      ...(typeof row._customconnectorid_value === 'string' && GUID.test(row._customconnectorid_value) ? { customConnectorId: row._customconnectorid_value.toLowerCase() } : {}),
    }), 'references');
  // The definitions of the custom connectors the bindings that call operations go through — each once, by id. A binding that calls none needs none, and one whose reference names no custom connector cannot
  // be given one: its operations are reported as not checked (judgeBindingTargets).
  if (targets.references instanceof Map) {
    const ids = [];
    for (const page of pages) {
      for (const entry of page.connectorBindings || []) {
        const name = entry && typeof entry[PAGE_BINDINGS.connectorBindings] === 'string' ? entry[PAGE_BINDINGS.connectorBindings].trim().toLowerCase() : '';
        const reference = name ? targets.references.get(name) : undefined;
        if (reference && reference.customConnectorId && operationsOf(entry).length && !ids.includes(reference.customConnectorId)) ids.push(reference.customConnectorId);
      }
    }
    if (ids.length) {
      const fresh = ids.filter((id) => !seen.definitions.has(id));
      if (fresh.length) for (const [id, definition] of await readDefinitions(reader, fresh)) seen.definitions.set(id, definition);
      targets.definitions = new Map(ids.map((id) => [id, seen.definitions.get(id)]));
    }
  }
  await read('actionBindings', 'customapi', ['uniquename', 'isfunction', 'bindingtype', 'boundentitylogicalname'], 'uniquename',
    (row) => row.uniquename,
    (row) => ({ isFunction: row.isfunction === true, ...(text(row.boundentitylogicalname) && Number(row.bindingtype) !== 0 ? { boundEntity: row.boundentitylogicalname } : {}) }), 'apis');
  return targets;
}

const joined = (names) => names.map(shown).join(', ');
const plural = (names, one, many) => (names.length === 1 ? one : many);
const pagesWords = (pages) => `${plural(pages, 'page', 'pages')} ${pages.map((page) => quoted(page.name)).join(', ')}`;

// What is said of every built-in operation a page binds, after its name: nothing in the environment was read for it (see the header).
const BUILT_IN_UNCHECKED = 'These are reviewed built-in operation names; their availability in this environment or player and the signed-in user\'s permissions were not checked.';
// What is said of one whose declarations do not explicitly match the reviewed contract. It promises no runtime answer: whatever the player does with such a binding is the player's.
const BUILT_IN_SHAPE = 'This binding does not explicitly match the reviewed unbound, zero-input Function contract. It was preserved; invocation may fail.';

// How a built-in operation's binding departs from "an unbound Function with no inputs", or null when it states exactly that. The binding is a spec's, held to the shapes a spec states
// (lib/page-bindings.js): `isFunction` a boolean, `boundEntityLogicalName` an identifier, `parameterKinds` a map of primitive kinds — or absent. An ABSENT declaration is what a binding written
// before the declarations were required looks like (`{ "name": "WhoAmI" }`), and it is said apart from a declaration that CONTRADICTS the contract — an Action, a bound table, inputs.
//   { declaration: 'omitted' | 'contradicted', words }   e.g. words: "declares inputs (Target, Depth)"
function builtInShape(entry) {
  const contradicted = [];
  const omitted = [];
  if (entry.isFunction === undefined) omitted.push(['its kind', 'isFunction']);
  else if (entry.isFunction === false) contradicted.push('an Action (isFunction: false)');
  else if (entry.isFunction !== true) contradicted.push('a kind that is not a Function');
  if (text(entry.boundEntityLogicalName)) contradicted.push(`a bound table (${shown(entry.boundEntityLogicalName)})`);
  const kinds = entry.parameterKinds;
  if (kinds === undefined) omitted.push(['its inputs', 'parameterKinds']);
  else if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) contradicted.push('inputs');
  else if (Object.keys(kinds).length) contradicted.push(`inputs (${joined(Object.keys(kinds))})`);
  if (!contradicted.length && !omitted.length) return null;
  const and = (parts) => (parts.length < 3 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);
  const said = [];
  if (contradicted.length) said.push(`declares ${and(contradicted)}`);
  if (omitted.length) said.push(`does not declare ${omitted.map(([what]) => what).join(' or ')} (${omitted.map(([, key]) => key).join(', ')})`);
  return { declaration: contradicted.length ? 'contradicted' : 'omitted', words: said.join(', and ') };
}

// What `targets` says of the bindings `pages` state: { findings, unchecked }.
//   findings   [{ severity: 'refuse' | 'warn', kind, page: { key, name }, text, … }], a page at a time, in the order a page lists its bindings: its connector conflicts, the references it has none of, the references it
//              has with no connection, the operations a custom connector there does not define, the Custom APIs it has none of, the Custom APIs that are not as the binding says, and the built-in
//              operations whose declarations do not explicitly match their contract (`dataverse-operation-shape`, with `binding` and `declaration`: 'omitted' or 'contradicted'). `refuse` is a connector
//              conflict and nothing else: a binding that is refused is not judged further.
//   unchecked  [{ what, text }] for what could not be checked, and why: a page at a time, what its references' rows did not say (their connector, whether they have a connection, which custom connector they
//              are for), then the operations of a binding whose custom connector's definition could not be read, and the names of its bindings an earlier read of the attempt could not read (`unread`),
//              then the built-in operations it binds ({ what: 'Dataverse operations', page, names, text }: nothing is read for them);
//              then each read that failed. Missing evidence is never a finding and never "compatible".
function judgeBindingTargets(pages, targets) {
  const findings = [];
  const unchecked = [];
  const nameOf = (entry, identity) => (entry && typeof entry[identity] === 'string' && entry[identity].trim() ? entry[identity].trim() : undefined);
  const sameName = (names, name) => names.some((seen) => seen.toLowerCase() === name.toLowerCase());
  // Why a name was not read, when an earlier read of the attempt could not read it while other names were read (readBindingTargets `unread`) — undefined for a name that was read.
  const unreadWhy = (target, name) => (targets.unread && targets.unread[target] ? targets.unread[target].get(name.toLowerCase()) : undefined);
  const noteUnread = (byWhy, why, name) => {
    const names = byWhy.get(why) || [];
    if (!sameName(names, name)) names.push(name);
    byWhy.set(why, names);
  };
  for (const page of pages) {
    const at = { key: page.key, name: page.name };
    const connectors = (page.connectorBindings || []).filter((entry) => nameOf(entry, PAGE_BINDINGS.connectorBindings));
    const named = (page.actionBindings || []).filter((entry) => nameOf(entry, PAGE_BINDINGS.actionBindings));
    // A built-in operation's binding is judged apart: no row was read for it (readBindingTargets), so it is never "missing" and never compared with one.
    const builtIns = named.filter(isBuiltInOperation);
    const actions = named.filter((entry) => !isBuiltInOperation(entry));
    const missingReferences = [];
    const disconnected = [];
    const undefinedOperations = [];
    // What the rows did not say (readBindingTargets keeps a piece only as a row proves it): kept apart from what they said, and reported as not checked.
    const connectorUnknown = [];
    const connectionUnknown = [];
    const customUnknown = [];
    // The names that were not read at all, by why: not checked, and said so by name — never "not there".
    const referencesUnread = new Map();
    const apisUnread = new Map();
    const missingApis = [];
    const mismatches = [];
    if (targets.references instanceof Map) {
      for (const entry of connectors) {
        const name = nameOf(entry, PAGE_BINDINGS.connectorBindings);
        const notRead = unreadWhy('references', name);
        if (notRead !== undefined) {
          noteUnread(referencesUnread, notRead, name);
          continue;
        }
        const reference = targets.references.get(name.toLowerCase());
        if (!reference) {
          if (!sameName(missingReferences, name)) missingReferences.push(name);
          continue;
        }
        // A conflict is only ever PROVEN: both sides name a connector, and they are not the same one.
        const expected = bindingConnectorKey(entry.connectorId);
        const found = referenceConnectorKey(reference.connectorId);
        if (expected && found && expected !== found) {
          findings.push({
            severity: 'refuse', kind: 'connector-conflict', page: at, binding: name, expected, found,
            text: `page ${quoted(page.name)}: connector binding ${quoted(name)} is for connector ${shown(expected)}, but the connection reference of that name in this environment is for connector ${shown(found)}`,
          });
          continue;
        }
        // The binding names a connector and the row did not say which one the reference is for: nothing contradicts the binding, and nothing proves it either.
        if (expected && !found && !sameName(connectorUnknown, name)) connectorUnknown.push(name);
        // Only a row that says it has no connection is one with none; a row that does not carry the column says nothing (readBindingTargets).
        if (reference.connected === false && !sameName(disconnected, name)) disconnected.push(name);
        if (reference.connected === undefined && !sameName(connectionUnknown, name)) connectionUnknown.push(name);
        // The operations of a custom connector, whose definition is the environment's own (see the header). A reference that names no custom connector — the lookup absent, null or not a GUID — is not
        // proven to be for a connector the platform publishes, so its operations are not checked, and that is said.
        const operations = operationsOf(entry);
        if (!operations.length) continue;
        if (!reference.customConnectorId) {
          if (!sameName(customUnknown, name)) customUnknown.push(name);
          continue;
        }
        const defined = targets.definitions instanceof Map ? targets.definitions.get(reference.customConnectorId) : undefined;
        if (!(defined instanceof Set)) {
          const why = defined && defined.problem ? defined.problem : 'its definition was not read';
          const said = `could not read the definition of the custom connector that connection reference ${shown(name)} is for in this environment (${shown(why)}), so the operations connector binding ${quoted(name)} of page ${quoted(page.name)} calls were not checked against it`;
          if (!unchecked.some((u) => u.text === said)) unchecked.push({ what: 'custom connector definitions', text: said });
          continue;
        }
        const absent = operations.filter((operation) => !defined.has(operation));
        if (!absent.length) continue;
        const said = `page ${quoted(page.name)}: connector binding ${quoted(name)} calls ${plural(absent, 'operation', 'operations')} ${joined(absent)}, which the custom connector that connection reference is for in this environment does not define, so the page's ${plural(absent, 'call to it fails', 'calls to them fail')} there until it does (import the solution that holds the connector as the page was made with it)`;
        if (!undefinedOperations.some((u) => u.text === said)) undefinedOperations.push({ binding: name, operations: absent, text: said });
      }
    }
    if (missingReferences.length) {
      findings.push({
        severity: 'warn', kind: 'reference-missing', page: at, names: missingReferences,
        text: `page ${quoted(page.name)}: ${plural(missingReferences, 'connection reference', 'connection references')} ${joined(missingReferences)} ${plural(missingReferences, 'is', 'are')} not in this environment, so the page is written with ${plural(missingReferences, 'a binding', 'bindings')} it cannot resolve yet. A page finds its connector by the ${plural(missingReferences, "reference's logical name", "references' logical names")}: create the ${plural(missingReferences, 'reference', 'references')} here (create-connection-reference.js, or import the solution that holds ${plural(missingReferences, 'it', 'them')}) and the page works without a rebuild`,
      });
    }
    if (disconnected.length) {
      const them = plural(disconnected, 'it', 'them');
      findings.push({
        severity: 'warn', kind: 'connection-missing', page: at, names: disconnected,
        text: `page ${quoted(page.name)}: ${plural(disconnected, 'connection reference', 'connection references')} ${joined(disconnected)} ${plural(disconnected, 'is', 'are')} in this environment but ${plural(disconnected, 'has', 'have')} no connection, so the page's calls through ${them} fail until ${plural(disconnected, 'it has', 'they have')} one. Give ${them} a connection (import the solution that holds ${them} with a settings file that does: solution-settings.js, or set ${them} in Power Apps, in the solution's connection references) and the page works without a rebuild`,
      });
    }
    for (const missing of undefinedOperations) findings.push({ severity: 'warn', kind: 'operation-missing', page: at, binding: missing.binding, operations: missing.operations, text: missing.text });
    // What the rows did not say, a page at a time and by name: never "fine", never a refusal.
    const bindingsWords = (names) => `${plural(names, 'connector binding', 'connector bindings')} ${names.map(quoted).join(', ')} of page ${quoted(page.name)}`;
    if (connectorUnknown.length) unchecked.push({ what: 'reference connectors', text: `this environment's ${plural(connectorUnknown, 'row', 'rows')} for connection ${plural(connectorUnknown, 'reference', 'references')} ${joined(connectorUnknown)} did not give a connector id this build can read (absent, or not of the form /providers/Microsoft.PowerApps/apis/shared_<name>), so whether ${bindingsWords(connectorUnknown)} ${plural(connectorUnknown, 'goes', 'go')} through the connector ${plural(connectorUnknown, 'it was', 'they were')} made for was not checked` });
    if (connectionUnknown.length) unchecked.push({ what: 'reference connections', text: `this environment's ${plural(connectionUnknown, 'row', 'rows')} for connection ${plural(connectionUnknown, 'reference', 'references')} ${joined(connectionUnknown)} did not say, in a form this build can read, whether ${plural(connectionUnknown, 'it has', 'they have')} a connection, so that was not checked for page ${quoted(page.name)}` });
    if (customUnknown.length) unchecked.push({ what: 'custom connector definitions', text: `the operations that ${bindingsWords(customUnknown)} call were not checked: this environment does not name a custom connector for ${plural(customUnknown, 'its connection reference', 'their connection references')}, and only a custom connector's definition is read here (a connector the platform publishes defines the same operations in every environment of its cloud)` });
    for (const [why, names] of referencesUnread) unchecked.push({ what: 'connection references', text: `could not read this environment's connection references (${shown(why)}), so ${bindingsWords(names)} ${plural(names, 'was', 'were')} not checked against them` });
    if (targets.apis instanceof Map) {
      for (const entry of actions) {
        const name = nameOf(entry, PAGE_BINDINGS.actionBindings);
        const notRead = unreadWhy('apis', name);
        if (notRead !== undefined) {
          noteUnread(apisUnread, notRead, name);
          continue;
        }
        const api = targets.apis.get(name.toLowerCase());
        if (!api) {
          if (!sameName(missingApis, name)) missingApis.push(name);
          continue;
        }
        // `isFunction` that is not stated is an Action, as references/custom-api.md says; `boundEntityLogicalName` that is not stated is a Global operation.
        const refused = (what) => `the runtime refuses the call (${what})`;
        if (Boolean(entry.isFunction) !== api.isFunction) {
          mismatches.push({
            binding: name,
            text: `page ${quoted(page.name)}: Custom API binding ${quoted(name)} says it is ${entry.isFunction ? 'a Function' : 'an Action'}, but the Custom API of that name in this environment is ${api.isFunction ? 'a Function' : 'an Action'} — ${refused('wrong_operation_kind')}`,
          });
        }
        const wantsTable = text(entry.boundEntityLogicalName);
        if ((wantsTable || '').toLowerCase() !== (api.boundEntity || '').toLowerCase()) {
          const says = wantsTable ? `is bound to table ${shown(wantsTable)}` : 'is for a Global operation';
          const finds = api.boundEntity ? `is bound to table ${shown(api.boundEntity)}` : 'is Global';
          mismatches.push({ binding: name, text: `page ${quoted(page.name)}: Custom API binding ${quoted(name)} ${says}, but the Custom API of that name in this environment ${finds} — ${refused('invalid_bound_to')}` });
        }
      }
    }
    if (missingApis.length) {
      findings.push({
        severity: 'warn', kind: 'api-missing', page: at, names: missingApis,
        text: `page ${quoted(page.name)}: ${plural(missingApis, 'Custom API', 'Custom APIs')} ${joined(missingApis)} ${plural(missingApis, 'is', 'are')} not in this environment (list-custom-apis.js lists what it has), so a call through ${plural(missingApis, 'the binding is', 'a binding is')} refused until ${plural(missingApis, 'it is', 'they are')} deployed here`,
      });
    }
    for (const mismatch of mismatches) findings.push({ severity: 'warn', kind: 'api-mismatch', page: at, binding: mismatch.binding, text: mismatch.text });
    for (const [why, names] of apisUnread) unchecked.push({ what: 'Custom APIs', text: `could not read this environment's Custom APIs (${shown(why)}), so ${plural(names, 'Custom API binding', 'Custom API bindings')} ${names.map(quoted).join(', ')} of page ${quoted(page.name)} ${plural(names, 'was', 'were')} not checked against them` });
    if (builtIns.length) {
      for (const entry of builtIns) {
        const shape = builtInShape(entry);
        if (shape) {
          findings.push({
            severity: 'warn', kind: 'dataverse-operation-shape', page: at, binding: entry.name, declaration: shape.declaration,
            text: `page ${quoted(page.name)}: built-in operation binding ${quoted(entry.name)} ${shape.words}. ${BUILT_IN_SHAPE}`,
          });
        }
      }
      const names = [...new Set(builtIns.map((entry) => entry.name))];
      unchecked.push({ what: 'Dataverse operations', page: at, names, text: `page ${quoted(page.name)} binds the built-in ${plural(names, 'operation', 'operations')} ${joined(names)}. ${BUILT_IN_UNCHECKED}` });
    }
  }
  const unread = (what, kind, problem, listed) => {
    if (!problem) return;
    // A page whose action bindings are all built-in operations had nothing in the Custom API read, so a failed read is not said of it.
    const read = (entry) => nameOf(entry, PAGE_BINDINGS[kind]) && !(kind === 'actionBindings' && isBuiltInOperation(entry));
    const affected = pages.filter((page) => (page[kind] || []).some(read));
    if (affected.length) unchecked.push({ what, text: `could not read this environment's ${what} (${shown(problem)}), so the ${listed} of ${pagesWords(affected)} were not checked against them` });
  };
  unread('connection references', 'connectorBindings', targets.problems && targets.problems.references, 'connector bindings');
  unread('Custom APIs', 'actionBindings', targets.problems && targets.problems.apis, 'Custom API bindings');
  return { findings, unchecked };
}

// What a dry run says of the pages it was told are deployed when it cannot find out whether they still are (sdk-build.js, confirmDeployedTargets): it checks them, as if the build will make them.
function unconfirmedDeployedText(pages, why) {
  return `could not tell whether ${pagesWords(pages)}, recorded as deployed, ${plural(pages, 'is', 'are')} still in this environment (${shown(why)}), so ${plural(pages, 'its', 'their')} bindings are checked as if the build will make ${plural(pages, 'it', 'them')}`;
}

module.exports = { connectorKey, pagesStatingBindings, pagesMadeUnchecked, pagesLeftOutAsDeployed, bindingReads, readBindingTargets, judgeBindingTargets, unconfirmedDeployedText, definedOperations };
