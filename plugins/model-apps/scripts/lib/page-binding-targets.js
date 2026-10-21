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
//   - a Custom API of the other kind (an Action for a Function) or bound to another table is said by name: the runtime refuses such a call before it is sent, so it is a warning and never a refusal.
// What this cannot say is whether the connector offers the operations a binding lists: that is the connector's own definition, which only the Power Apps service has, and the build has no client for it.
// A read that fails is said — the bindings were not checked — and never read as "nothing is there".
const { odataLit } = require('./odata.js');
const { normalizePageSource } = require('./app-spec.js');
const { PAGE_BINDINGS, statedPageBindings } = require('./page-bindings.js');

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
// Two ids name the same connector when their names are equal. A custom connector's name is `shared_<name>-5f<hash>`, and the hash differs in every environment, so a binding for one never matches across them:
// that is a conflict the author settles by stating the connector this environment has. null when there is no name.
// See: https://learn.microsoft.com/power-platform/admin/connector-reference-in-the-environment
function connectorKey(id) {
  if (typeof id !== 'string') return null;
  const last = id.trim().replace(/\/+$/, '').split('/').pop().toLowerCase();
  return last || null;
}

// The pages a build writes that state a binding: [{ key, name, connectorBindings?, actionBindings? }], with the lists as the spec states them, in the spec's order. A page with no source the build can deploy is not
// written, and a page that states no entry has nothing to check. A changed-only run writes the pages it selected and any page another one navigates to (the build makes an absent target first, from its own
// spec entry, so it may have to write it), and no other.
function pagesStatingBindings(spec, { changedOnly } = {}) {
  const pages = Array.isArray(spec && spec.pages) ? spec.pages : [];
  const selected = changedOnly && Array.isArray(changedOnly.selectedKeys) ? new Set(changedOnly.selectedKeys) : null;
  const navigatedTo = new Set(pages.flatMap((page) => ((page && page.navigatesTo) || []).map((target) => target && target.targetKey)));
  const out = [];
  for (const page of pages) {
    const source = normalizePageSource(page);
    if (!(source && source.kind === 'tsx' && source.codeFile)) continue;
    const key = page.key || page.name;
    if (selected && !selected.has(key) && !navigatedTo.has(key)) continue;
    const lists = statedPageBindings(page);
    if (!Object.values(lists).some((list) => list.length)) continue;
    out.push({ key, name: page.name, ...lists });
  }
  return out;
}

// The names the pages state for one kind of binding: each once, as the first page spells it (the service compares them without regard to case, and the match here is made in lower case).
function namesOf(pages, kind) {
  const identity = PAGE_BINDINGS[kind];
  const names = new Map();
  for (const page of pages) {
    for (const entry of page[kind] || []) {
      const name = entry && typeof entry[identity] === 'string' ? entry[identity].trim() : '';
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
  }
  return [...names.values()];
}

async function readNamed(provision, entity, select, column, names) {
  const rows = [];
  for (let at = 0; at < names.length; at += CHUNK) {
    const filter = names.slice(at, at + CHUNK).map((name) => `${column} eq '${odataLit(name)}'`).join(' or ');
    rows.push(...((await provision.queryRecords(entity, { select, filter, paginate: true })) || []));
  }
  return rows;
}

const text = (value) => (typeof value === 'string' && value.trim() ? value : undefined);

// What the environment has for the names `pages` state: { references, apis, problems }.
//   references  Map<lower-cased logical name, { connectorId }> of the connection references (`connectionreference` rows) — or null when no page states a connector binding, or the read failed
//   apis        Map<lower-cased unique name, { isFunction, boundEntity? }> of the Custom APIs (`customapi` rows) — or null likewise
//   problems    { references?, apis? }: why a read failed, as the service said it. A failed read does not stop the other, and is never an empty answer.
// Only the rows of the names asked for are kept, whatever the service answered.
// A connection reference row as the Web API answers it (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/connectionreference):
//   { "connectionreferencelogicalname": "contoso_msnweather", "connectorid": "/providers/Microsoft.PowerApps/apis/shared_msnweather" }
// and a Custom API row (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/customapi), `bindingtype` 0 Global, 1 Entity, 2 EntityCollection:
//   { "uniquename": "contoso_ApproveOrder", "isfunction": false, "bindingtype": 1, "boundentitylogicalname": "contoso_item" }
async function readBindingTargets(provision, pages) {
  const targets = { references: null, apis: null, problems: {} };
  const reader = provision && typeof provision.queryRecords === 'function' ? provision : null;
  const read = async (kind, entity, select, column, keyOf, valueOf, target) => {
    const names = namesOf(pages, kind);
    if (!names.length) return;
    try {
      if (!reader) throw new Error('the rows cannot be read here');
      const wanted = new Set(names.map((name) => name.toLowerCase()));
      const found = new Map();
      for (const row of await readNamed(reader, entity, select, column, names)) {
        const key = row && typeof keyOf(row) === 'string' ? keyOf(row).trim().toLowerCase() : '';
        if (key && wanted.has(key) && !found.has(key)) found.set(key, valueOf(row));
      }
      targets[target] = found;
    } catch (error) {
      targets.problems[target] = String((error && error.message) || error);
    }
  };
  await read('connectorBindings', 'connectionreference', ['connectionreferencelogicalname', 'connectorid'], 'connectionreferencelogicalname',
    (row) => row.connectionreferencelogicalname, (row) => ({ connectorId: text(row.connectorid) }), 'references');
  await read('actionBindings', 'customapi', ['uniquename', 'isfunction', 'bindingtype', 'boundentitylogicalname'], 'uniquename',
    (row) => row.uniquename,
    (row) => ({ isFunction: row.isfunction === true, ...(text(row.boundentitylogicalname) && Number(row.bindingtype) !== 0 ? { boundEntity: row.boundentitylogicalname } : {}) }), 'apis');
  return targets;
}

const joined = (names) => names.map(shown).join(', ');
const plural = (names, one, many) => (names.length === 1 ? one : many);
const pagesWords = (pages) => `${plural(pages, 'page', 'pages')} ${pages.map((page) => quoted(page.name)).join(', ')}`;

// What `targets` says of the bindings `pages` state: { findings, unchecked }.
//   findings   [{ severity: 'refuse' | 'warn', kind, page: { key, name }, text, … }], a page at a time, in the order a page lists its bindings: its connector conflicts, the references it has none of, the Custom APIs it has none
//              of, the Custom APIs that are not as the binding says. `refuse` is a connector conflict and nothing else.
//   unchecked  [{ what, text }] for each read that failed: what could not be checked, and why
function judgeBindingTargets(pages, targets) {
  const findings = [];
  const unchecked = [];
  const nameOf = (entry, identity) => (entry && typeof entry[identity] === 'string' && entry[identity].trim() ? entry[identity].trim() : undefined);
  for (const page of pages) {
    const at = { key: page.key, name: page.name };
    const connectors = (page.connectorBindings || []).filter((entry) => nameOf(entry, PAGE_BINDINGS.connectorBindings));
    const actions = (page.actionBindings || []).filter((entry) => nameOf(entry, PAGE_BINDINGS.actionBindings));
    const missingReferences = [];
    const missingApis = [];
    const mismatches = [];
    if (targets.references instanceof Map) {
      for (const entry of connectors) {
        const name = nameOf(entry, PAGE_BINDINGS.connectorBindings);
        const reference = targets.references.get(name.toLowerCase());
        if (!reference) {
          if (!missingReferences.some((seen) => seen.toLowerCase() === name.toLowerCase())) missingReferences.push(name);
          continue;
        }
        // A conflict is only ever PROVEN: both sides name a connector, and they are not the same one.
        const expected = connectorKey(entry.connectorId);
        const found = connectorKey(reference.connectorId);
        if (expected && found && expected !== found) {
          findings.push({
            severity: 'refuse', kind: 'connector-conflict', page: at, binding: name, expected, found,
            text: `page ${quoted(page.name)}: connector binding ${quoted(name)} is for connector ${shown(expected)}, but the connection reference of that name in this environment is for connector ${shown(found)}`,
          });
        }
      }
    }
    if (missingReferences.length) {
      findings.push({
        severity: 'warn', kind: 'reference-missing', page: at, names: missingReferences,
        text: `page ${quoted(page.name)}: ${plural(missingReferences, 'connection reference', 'connection references')} ${joined(missingReferences)} ${plural(missingReferences, 'is', 'are')} not in this environment, so the page is written with ${plural(missingReferences, 'a binding', 'bindings')} it cannot resolve yet. A page finds its connector by the ${plural(missingReferences, "reference's logical name", "references' logical names")}: create the ${plural(missingReferences, 'reference', 'references')} here (create-connection-reference.js, or import the solution that holds ${plural(missingReferences, 'it', 'them')}) and the page works without a rebuild`,
      });
    }
    if (targets.apis instanceof Map) {
      for (const entry of actions) {
        const name = nameOf(entry, PAGE_BINDINGS.actionBindings);
        const api = targets.apis.get(name.toLowerCase());
        if (!api) {
          if (!missingApis.some((seen) => seen.toLowerCase() === name.toLowerCase())) missingApis.push(name);
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
  }
  const unread = (what, kind, problem, listed) => {
    if (!problem) return;
    const affected = pages.filter((page) => (page[kind] || []).some((entry) => nameOf(entry, PAGE_BINDINGS[kind])));
    if (affected.length) unchecked.push({ what, text: `could not read this environment's ${what} (${shown(problem)}), so the ${listed} of ${pagesWords(affected)} were not checked against them` });
  };
  unread('connection references', 'connectorBindings', targets.problems && targets.problems.references, 'connector bindings');
  unread('Custom APIs', 'actionBindings', targets.problems && targets.problems.apis, 'Custom API bindings');
  return { findings, unchecked };
}

module.exports = { connectorKey, pagesStatingBindings, readBindingTargets, judgeBindingTargets };
