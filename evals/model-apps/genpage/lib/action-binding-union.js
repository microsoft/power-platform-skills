'use strict';
// The union of a page's two kinds of `actionBindings` entry, as the evaluators of a Custom API lifecycle compare an `actions.json`, a plan and a page's config.
//
// A page holds ONE `actionBindings` array, written whole by `genpage-upload.js --actions` (a full replace: an entry the file leaves out is deleted), and genpage-customapi-builder is
// its one writer. It holds two partitions:
//   - Custom API rows, from the plan's `## Custom API Bindings` and `list-custom-apis.js` discovery (custom-api-contract.js);
//   - the reviewed built-in Dataverse operations — exactly WhoAmI and RetrieveVersion (plugins/model-apps/scripts/lib/dataverse-operations.js) — from the plan's OPTIONAL
//     `## Dataverse Operations` section and `list-dataverse-operations.js` (this file).
// A desired array is the Custom API rows first, in their own order, then the built-in projections in catalogue order. Comparing a mixed array with the Custom API partition alone fails
// it, and passing it by dropping either partition would hide a binding the upload is about to delete — so what is compared is always the whole union.
//
// The section, when present, is the exact sentinel `No Dataverse operations.` or the table below — anything else halts:
//   ## Dataverse Operations
//   Verification: environment not-checked, runtime not-checked, privileges not-checked.
//   | Name | Kind | Bound Entity | Display Name | Parameters | Response fields | Invoke |
//   |------|------|--------------|--------------|------------|-----------------|--------|
//   | WhoAmI | Function | (Global) | Current Dataverse identity | (none) | BusinessUnitId, UserId, OrganizationId | button |
// Every cell is the catalogue's own, so a row is checked against the catalogue and projected by it (toActionBinding), never re-derived from the text.
const { isDeepStrictEqual } = require('node:util');
const {
  AUTHORING_CODES, getDataverseOperationCatalogue, getReviewedDataverseOperation, toActionBinding,
} = require('../../../../plugins/model-apps/scripts/lib/dataverse-operations.js');
const { planSection, parseMarkdownRows } = require('./plan-evidence.js');
const { isGeneration, isUpload, resultObject } = require('./workflow-evidence.js');
const { uploadChoiceLines, consumedChoice } = require('./upload-contract.js');
const { actionCalls, groupEnd, literalString, escapeRe, callSites, expressionEnd, forwardedPageBodyOf } = require('./source-evidence.js');
const { blankNonCodePreservingTemplateExpressions } = require('../../../../plugins/model-apps/scripts/lib/source-literals.js');

const SECTION = 'Dataverse Operations';
const SENTINEL = 'No Dataverse operations.';
const VERIFICATION_LINE = 'Verification: environment not-checked, runtime not-checked, privileges not-checked.';
const COLUMNS = ['Name', 'Kind', 'Bound Entity', 'Display Name', 'Parameters', 'Response fields', 'Invoke'];
const CATALOGUE_ORDER = getDataverseOperationCatalogue().operations.map((operation) => operation.name);

// The output names each built-in operation's response declares — what a page may read from `res.outputs` of that call.
const BUILT_IN_OUTPUTS = Object.freeze(Object.fromEntries(getDataverseOperationCatalogue().operations.map((operation) => [operation.name, Object.keys(operation.response.properties)])));

// An entry that names a built-in operation, by its EXACT name (as the catalogue matches it: `whoami` is a Custom API name).
const isBuiltInBinding = (entry) => Boolean(entry && typeof entry === 'object' && getReviewedDataverseOperation(entry.name));

const isBuiltInGate = (command) => /\bfeature-flags\.js\b[^\n]*\bdataverse-operations\b/.test(command);
const isBuiltInListing = (command) => /\blist-dataverse-operations\.js\b/.test(command);
const gateValue = (call) => {
  const raw = typeof call.result === 'string' ? call.result.trim() : '';
  return raw === 'enabled' || raw === 'disabled' ? raw : null;
};

// { customApis, builtIns } of a list, each in the list's own order.
function partitionBindings(list) {
  const customApis = [];
  const builtIns = [];
  for (const entry of list || []) (isBuiltInBinding(entry) ? builtIns : customApis).push(entry);
  return { customApis, builtIns };
}

// The built-in rows a plan authors this run: null when the plan has no `## Dataverse Operations` section (nothing new is authored), [] for the exact sentinel, otherwise the wire rows of
// its table, in catalogue order. A section that is anything else throws: an evaluator must not read an unreadable selection as "none".
function plannedBuiltIns(plan) {
  const body = planSection(plan, SECTION);
  if (body === null) return null;
  if (body === SENTINEL) return [];
  if (body.split(/\r?\n/)[0].trim() !== VERIFICATION_LINE) throw new Error('Dataverse Operations must open with the not-checked verification line or be the exact sentinel');
  const rows = parseMarkdownRows(body, COLUMNS);
  if (!rows.length) throw new Error('Dataverse Operations must be the built-in operation table or the exact sentinel');
  const seen = new Set();
  const out = rows.map((row) => {
    const operation = getReviewedDataverseOperation(row.name);
    if (!operation) throw new Error(AUTHORING_CODES.not_in_catalogue);
    if (seen.has(operation.name)) throw new Error(AUTHORING_CODES.duplicate_operation);
    seen.add(operation.name);
    const expected = {
      kind: 'Function', 'bound entity': '(Global)', 'display name': operation.displayName, parameters: '(none)',
      'response fields': Object.keys(operation.response.properties).join(', '), invoke: 'button',
    };
    for (const [cell, value] of Object.entries(expected)) {
      if (row[cell] !== value) throw new Error(`${operation.name}: the ${cell} cell is not the catalogue's (${AUTHORING_CODES.invalid_operation_contract})`);
    }
    return toActionBinding(operation);
  });
  const order = out.map((entry) => CATALOGUE_ORDER.indexOf(entry.name));
  if (order.some((at, i) => i > 0 && at < order[i - 1])) throw new Error('Dataverse Operations rows must be in catalogue order (WhoAmI, then RetrieveVersion)');
  return out;
}

// The one desired array: the Custom API rows, then the built-in rows. A name in both, or twice, is no union at all.
function unionBindings(customApis, builtIns) {
  const names = new Set();
  for (const entry of [...customApis, ...builtIns]) {
    if (names.has(entry.name)) throw new Error(AUTHORING_CODES.duplicate_operation);
    names.add(entry.name);
  }
  return [...customApis, ...builtIns];
}

// What `list-dataverse-operations.js` offered, by name: the wire projection of each descriptor it listed. A listing that failed, or listed anything but the reviewed pair exactly, offers
// nothing, and is a problem: an evaluator never projects a row from an altered descriptor (toActionBinding refuses one).
function listedBuiltIns(calls) {
  const offered = new Map();
  const problems = [];
  for (const call of calls.filter((entry) => isBuiltInListing(entry.command))) {
    const result = resultObject(call);
    if (result?.ok !== true || !Array.isArray(result.operations)) {
      problems.push('built-in operation listing failed or returned an unreadable catalogue');
      continue;
    }
    // Exactly the documented envelope: a field such as `eligible` would claim a check the command does not make.
    const { ok, catalogueVersion, verification, operations, ...rest } = result;
    if (ok !== true || catalogueVersion !== 1 || Object.keys(rest).length || verification?.mode !== 'catalogue-only'
      || ['environment', 'runtime', 'privileges'].some((key) => verification[key] !== 'not-checked')) {
      problems.push('built-in operation listing claims more than a catalogue-only offer');
      continue;
    }
    if (!isDeepStrictEqual(operations.map((operation) => operation && operation.name), CATALOGUE_ORDER)) {
      problems.push('built-in operation listing is not exactly the reviewed pair');
      continue;
    }
    for (const operation of operations) {
      // toActionBinding accepts a listed descriptor only when it is structurally the catalogue's own.
      try {
        offered.set(operation.name, toActionBinding(operation));
      } catch (error) {
        problems.push(`${operation.name}: listed descriptor is not the reviewed contract (${error.code})`);
      }
    }
  }
  return { offered, problems };
}

// The order a NEW actions file keeps: every Custom API row before the first built-in row, and the built-ins in catalogue order.
function unionOrderProblems(list, label) {
  const problems = [];
  const kinds = (list || []).map(isBuiltInBinding);
  const firstBuiltIn = kinds.indexOf(true);
  if (firstBuiltIn !== -1 && kinds.slice(firstBuiltIn).includes(false)) problems.push(`${label}: built-in operation rows must follow every Custom API row`);
  const order = (list || []).filter(isBuiltInBinding).map((entry) => CATALOGUE_ORDER.indexOf(entry.name));
  if (order.some((at, i) => i > 0 && at <= order[i - 1])) problems.push(`${label}: built-in operation rows must be in catalogue order, each once`);
  return problems;
}

// The gate of built-in authoring: `list-dataverse-operations.js` runs only after an ENABLED `dataverse-operations` probe, and a stage that authors a built-in row (`authoring`: the
// upload ids of the stages that add or replace one) generates and uploads only after a re-probe that is enabled and comes after the listing. A stage that only preserves the rows a page
// already holds does not consult this gate (a page keeps its bindings whatever the flag says).
function builtInGateProblems(calls, authoring) {
  const problems = [];
  let latest = null;
  for (const call of calls) {
    if (isBuiltInGate(call.command)) latest = gateValue(call);
    else if (isBuiltInListing(call.command) && latest !== 'enabled') problems.push('built-in operation listing ran before an enabled dataverse-operations gate');
  }
  const lastBefore = (end, predicate) => {
    for (let index = end - 1; index >= 0; index -= 1) if (predicate(calls[index].command)) return index;
    return -1;
  };
  for (const uploadId of authoring) {
    const uploadIndex = calls.findIndex((call) => call.id === uploadId && isUpload(call.command));
    if (uploadIndex === -1) continue;
    const gate = lastBefore(uploadIndex, isBuiltInGate);
    const listing = lastBefore(uploadIndex, isBuiltInListing);
    const generation = lastBefore(uploadIndex, isGeneration);
    if (listing === -1) problems.push(`${uploadId}: built-in operation rows were authored without a listing that offered them`);
    if (gate === -1 || gateValue(calls[gate]) !== 'enabled') problems.push(`${uploadId}: a disabled or unreadable dataverse-operations gate must halt built-in authoring before generation or upload`);
    else if (gate < listing) problems.push(`${uploadId}: built-in authoring must re-probe the dataverse-operations gate after the listing`);
    else if (generation !== -1 && gate > generation) problems.push(`${uploadId}: the dataverse-operations re-probe must come before generation`);
  }
  return problems;
}

// A clear (`change: { clear: true }`, an upload of `[]`) empties the WHOLE array. On a page whose before-config holds a built-in row, removing the
// Custom APIs is not that — it keeps the built-in rows — so a clear needs the maker's clear choice (edit-flow.md, Edit Phase 6), recorded as its
// own workflow-log line right before the upload it covers:
//   Clear choice: Clear every action binding of page <page-id>, removing WhoAmI and RetrieveVersion
// <page-id> is that upload's `--page-id` (any case), and the names are exactly the built-ins the page holds, in catalogue order. It is read the
// way an overwrite choice is (upload-contract.js): a `Clear choice:` line sets the pending answer, a later one replaces it, and the next log line
// that carries an upload command consumes it. So the answer that counts is the last one before this upload's own log line, it covers that one
// upload (a retry needs it again), and a choice logged after the upload, for another page, for another set of built-ins, or with anything
// added to it is no permission. AskUserQuestion exchanges are not read at all: a yes to adding or keeping WhoAmI never authorizes deleting it.
const CLEAR_CHOICE = 'Clear choice:';
function clearConfirmationProblems({ workflowLog, uploads, call, pageId, before, label }) {
  const held = new Set(partitionBindings(before).builtIns.map((entry) => entry.name));
  if (!held.size) return [];
  const removed = CATALOGUE_ORDER.filter((name) => held.has(name)).join(' and ');
  const expected = `${CLEAR_CHOICE} Clear every action binding of page ${pageId}, removing ${removed}`;
  // Every upload consumes its own log entry, in order, so an entry an earlier upload used can never be reached by this one.
  const entries = uploadChoiceLines(workflowLog, CLEAR_CHOICE);
  let consumed = null;
  for (const upload of uploads) {
    const choice = consumedChoice(entries, upload.command);
    if (upload === call) {
      consumed = choice;
      break;
    }
  }
  const choice = /^Clear choice: Clear every action binding of page (\S+), removing (.+)$/.exec(consumed || '');
  const accepted = Boolean(choice) && typeof pageId === 'string' && choice[1].toLowerCase() === pageId.toLowerCase() && choice[2] === removed;
  return accepted ? [] : [`${label}: clearing every action binding removes ${removed.replace(' and ', ', ')} — only with the maker's clear choice recorded right before this upload: ${expected}`];
}

// ── The generated call of a NEWLY authored built-in operation (references/dataverse-operations.md, "Generated call") ─────────────────────────────
// The page source is read, never run (source-evidence.js). A call is held to what the reference requires of it, beside the order every action call
// keeps (custom-api-contract.js runtimeProblems: presence check on the page's dataApi, failure returned before `res.outputs` is read, sanitized
// error.message only):
//   - the request is exactly `{ name: 'WhoAmI' }` / `{ name: 'RetrieveVersion' }`, and a presence check that fails RETURNS: no request at all;
//   - the call is user-triggered: its helper is reached only from a button's onClick, through named handlers (or constants that name them) —
//     never from an effect, a memo, a timer or the render itself, never handed to one (`setTimeout(showIdentity, 0)`), a ref or a child, and
//     never by calling itself again;
//   - the button that triggers it is disabled while its call is pending, a separate state per operation; its handler ignores a stale request (a
//     `.current` counter it increments and compares after the await) and catches a rejected promise;
//   - outputs are read only after a non-null, non-array object check, through own-property reads, never from the result root, by a literal member,
//     by a spread, an iteration or JSON.stringify, and nothing of the result is logged, stored, copied, put in a URL or sent — not by the helper or
//     its handlers, and not from the state, ref or variable that keeps it, anywhere on the page (a render, an effect, another handler);
//   - WhoAmI shows all three identifiers or none: one guard that returns tests every one of them with the GUID pattern; RetrieveVersion shows a
//     Version of 1 to 128 characters or nothing; an unexpected shape says the fixed sentence;
//   - a status is never read out of the message's words, and nothing says to deploy a Custom API.
const GUID_SOURCE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const UNEXPECTED = 'The operation returned an unexpected response. No result was displayed.';
const UNAVAILABLE = 'The selected operation is unavailable in this environment or player. No fallback was attempted.';
const IDENTITY_FIELDS = ['UserId', 'BusinessUnitId', 'OrganizationId'];
const DTO = 'BusinessUnitId|UserId|OrganizationId|Version';
// What a page must never do with an operation's result: log it, keep it, copy it, put it in a URL, hash it or send it anywhere. LEAKS finds one in
// a text; SINKS finds each one of a page.
const LEAK_SOURCE = String.raw`\bconsole\s*\.|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bclipboard\b|\bappInsights\b|\.track(?:Event|Metric|Trace|Exception|Dependency|PageView)\s*\(|\bURLSearchParams\b|\bhistory\s*\.\s*(?:push|replace)State\b|\blocation\s*\.\s*(?:assign|replace)\s*\(|\blocation\s*\.\s*(?:href|search|hash)\s*=(?!=)|\bwindow\s*\.\s*open\s*\(|\bdocument\s*\.\s*cookie\b|\bfetch\s*\(|\bsendBeacon\b|\bXMLHttpRequest\b|\bWebSocket\b|\bpostMessage\s*\(|\bcrypto\s*\.\s*subtle\b`;
const LEAKS = new RegExp(LEAK_SOURCE);
const SINKS = new RegExp(LEAK_SOURCE, 'g');
// Where a call is not a user's: an effect, a memo, a timer, a frame or a microtask (a hook's type argument list, `useMemo<string>(…)`, included).
const NOT_A_USER = /\b(?:useEffect|useLayoutEffect|useInsertionEffect|useMemo|setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\s*(?:<(?:[^<>()]|<[^<>()]*>)*>\s*)?\(/g;

// The `if (…)` guards of a text that end in a return: [{ condition }], the condition as raw text.
function returningGuards(text, mask) {
  const guards = [];
  for (const match of mask.matchAll(/\bif\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let close;
    try { close = groupEnd(mask, open); } catch { continue; }
    if (/^\s*(?:return\b|\{[^}]*\breturn\b)/.test(mask.slice(close + 1))) guards.push({ condition: text.slice(open + 1, close) });
  }
  return guards;
}

// The declarations a call can sit in: named functions and constants initialized with a function (an arrow, `function`, or a hook that wraps one).
function functionDeclarations(mask) {
  const out = [];
  for (const match of mask.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    try {
      const paramsEnd = groupEnd(mask, match.index + match[0].length - 1);
      const body = mask.indexOf('{', paramsEnd);
      if (body !== -1) out.push({ name: match[1], start: match.index, end: groupEnd(mask, body) });
    } catch { /* not gradeable here; actionCalls refuses it */ }
  }
  for (const match of mask.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=(?!=)\s*/g)) {
    const start = match.index + match[0].length;
    let end;
    try { end = expressionEnd(mask, start); } catch { continue; }
    if (/=>|^\s*(?:async\s+)?function\b/.test(mask.slice(start, end))) out.push({ name: match[1], start: match.index, end });
  }
  return out;
}

// The constants initialized with something other than a function — `const run = showIdentity;`, `const onIdentity = useCallback(showIdentity, [])`.
// [{ name, init, end }], `init` where the initializer starts. Which of them only rename a function is decided where a mention is read (aliasAt).
function aliasDeclarations(mask) {
  const out = [];
  for (const match of mask.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=(?!=)\s*/g)) {
    const init = match.index + match[0].length;
    let end;
    try { end = expressionEnd(mask, init); } catch { continue; }
    if (!/=>|^\s*(?:async\s+)?function\b/.test(mask.slice(init, end))) out.push({ name: match[1], init, end });
  }
  return out;
}

// Every place a function is named without being called: `setTimeout(fn, 0)`, `onClick={fn}`, `ref={fn}`, `const run = fn`. Not a call `fn(…)`
// (callSites follows those), not its own declaration, not a member (`x.fn`) and not an object key (`{ fn: … }`).
function mentions(mask, name) {
  const out = [];
  for (const match of mask.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`, 'g'))) {
    const before = mask.slice(Math.max(0, match.index - 40), match.index);
    const after = mask.slice(match.index + name.length);
    if (/^\s*\(/.test(after)) continue;
    if (/\b(?:function\s*\*?|const|let|var)\s*$/.test(before)) continue;
    if (/^\s*:(?!:)/.test(after) && /[{,]\s*$/.test(before)) continue;
    out.push(match.index);
  }
  return out;
}

// The dependency list of a hook — the `[a, b]` of `useEffect(fn, [a, b])`: naming a function there calls nothing. [[open, close]] of each list.
function dependencyLists(mask) {
  const out = [];
  for (const match of mask.matchAll(/\buse(?:Effect|LayoutEffect|InsertionEffect|Memo|Callback)\s*(?:<(?:[^<>()]|<[^<>()]*>)*>\s*)?\(/g)) {
    const open = match.index + match[0].length - 1;
    try {
      const close = groupEnd(mask, open);
      let comma = -1;
      for (let i = open + 1; i < close && comma === -1; i += 1) {
        if ('({['.includes(mask[i])) i = groupEnd(mask, i);
        else if (mask[i] === ',') comma = i;
      }
      if (comma === -1) continue;
      const start = comma + 1 + mask.slice(comma + 1, close).search(/\S/);
      if (mask[start] === '[') out.push([start, groupEnd(mask, start)]);
    } catch { /* not gradeable here; actionCalls refuses it */ }
  }
  return out;
}

// The `{ … }` blocks of a source, [open, close]. A declaration is visible in the innermost one around it (the whole file at the top level).
function braceBlocks(mask) {
  const out = [];
  const stack = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === '{') stack.push(i);
    else if (mask[i] === '}' && stack.length) out.push([stack.pop(), i]);
  }
  return out;
}

// The names that keep a built-in operation's result once its call answers, each with the block it is visible in ({ name, start, end }):
//   - `seeds` — the variable the call's answer is assigned to (`res`);
//   - a variable initialized from a call of the helper or a handler (`const view = await readIdentity(api)`);
//   - the state its setter stores one in (`setIdentity(view)`, with `const [identity, setIdentity] = useState(…)`);
//   - a declared ref or variable one is assigned to (`last.current = view`);
//   - every variable initialized from any of those (`const shown = version.version`) — until nothing new is found.
// Scoped by block, so a same-named variable of another function holds nothing. A name passed on to a function this does not follow (a prop
// callback) is not tracked: the page component is the root of what a generated page renders.
function resultHolders(mask, reached, seeds) {
  const blocks = braceBlocks(mask);
  const scopeOf = (at) => blocks.filter(([a, b]) => a < at && at < b).reduce((best, block) => (!best || block[0] > best[0] ? block : best), null) || [0, mask.length];
  const declarations = [];
  // `const view = …`, `let last;`, `const [identity, setIdentity] = …`, `const { a, b: c } = …` — each declared local name, and its initializer.
  for (const match of mask.matchAll(/\b(const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)/g)) {
    const pattern = match[2];
    const names = /^[[{]/.test(pattern)
      ? pattern.slice(1, -1).split(',').map((part) => /^\s*(?:\.\.\.)?\s*(?:[A-Za-z_$][\w$]*\s*:\s*)?([A-Za-z_$][\w$]*)/.exec(part)?.[1]).filter(Boolean)
      : [pattern];
    const assigned = /^\s*(?::[^=;]+)?=(?!=)\s*/.exec(mask.slice(match.index + match[0].length));
    let init = -1;
    let end = -1;
    if (assigned) {
      init = match.index + match[0].length + assigned[0].length;
      try { end = expressionEnd(mask, init); } catch { continue; }
    }
    const text = assigned ? mask.slice(init, end) : '';
    declarations.push({
      kind: match[1], names, init, end, scope: scopeOf(match.index),
      isFunction: /=>|^\s*(?:async\s+)?function\b/.test(text),
      setter: pattern.startsWith('[') && /^\s*(?:React\s*\.\s*)?useState\b/.test(text) ? names[1] || null : null,
    });
  }
  const declared = new Set(declarations.flatMap((d) => d.names));
  // A JSX attribute (`onClick={…}`) is not an assignment, so a plain name is followed only when `let` or `var` declares it.
  const reassignable = new Set(declarations.filter((d) => d.kind !== 'const').flatMap((d) => d.names));
  const scopeOfName = (name, at) => declarations
    .filter((d) => d.names.includes(name) && d.scope[0] <= at && at <= d.scope[1])
    .reduce((best, d) => (!best || d.scope[0] > best[0] ? d.scope : best), null) || [0, mask.length];
  const reachedCalls = [...reached].flatMap((fn) => callSites(mask, fn).map((site) => site.at));
  const cache = new Map();
  const mentionsOf = (name) => {
    if (!cache.has(name)) cache.set(name, mentions(mask, name));
    return cache.get(name);
  };
  const held = [];
  const carries = (from, to) => reachedCalls.some((at) => at >= from && at < to)
    || held.some(({ name, start, end }) => mentionsOf(name).some((at) => at >= from && at < to && start < at && at < end));
  const hold = (name, [start, end]) => {
    if (held.some((h) => h.name === name && h.start === start && h.end === end)) return false;
    held.push({ name, start, end });
    return true;
  };
  for (const { name, at } of seeds) hold(name, scopeOf(at));
  for (let grew = true; grew;) {
    grew = false;
    for (const d of declarations) {
      if (d.init !== -1 && !d.isFunction && !d.setter && carries(d.init, d.end)) for (const name of d.names) grew = hold(name, d.scope) || grew;
    }
    for (const d of declarations.filter((entry) => entry.setter)) {
      for (const site of callSites(mask, d.setter)) {
        const open = mask.indexOf('(', site.at);
        let close;
        try { close = groupEnd(mask, open); } catch { continue; }
        if (carries(open, close)) grew = hold(d.names[0], d.scope) || grew;
      }
    }
    // An assignment to a ref's `.current`, or to a name `let` or `var` declares (`last = view`).
    for (const match of mask.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(\s*\.\s*current)?\s*=(?![=>])/g)) {
      if (!(match[2] ? declared : reassignable).has(match[1]) || /\b(?:const|let|var)\s+$/.test(mask.slice(Math.max(0, match.index - 12), match.index))) continue;
      const from = match.index + match[0].length;
      let end;
      try { end = expressionEnd(mask, from); } catch { continue; }
      if (carries(from, end)) grew = hold(match[1], scopeOfName(match[1], match.index)) || grew;
    }
  }
  return held;
}

function builtInRuntimeProblems(code, names) {
  const problems = [];
  if (!names.length) return problems;
  let calls;
  try { calls = actionCalls(code); } catch (error) { return [`built-in operation calls are not gradeable (${error.message})`]; }
  const mask = blankNonCodePreservingTemplateExpressions(code);
  const decls = functionDeclarations(mask);
  const exported = /\bexport\s+default\s+(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)/.exec(mask)?.[1];
  // Where the page renders: the default export, and — under the canonical boundary wrapper, whose default export only renders
  // `<PageErrorBoundary><PageBody {...props} /></PageErrorBoundary>` — the PageBody it forwards its props to (source-evidence.js).
  // Unproven, PageBody is followed like any other caller, which still refuses a render-time call, under another message.
  const renderRoots = new Set([exported, (() => { try { return forwardedPageBodyOf(code)?.scope?.name; } catch { return undefined; } })()].filter(Boolean));
  const enclosing = (at) => decls.filter((d) => d.start < at && at < d.end).reduce((best, d) => (!best || d.start > best.start ? d : best), null);
  const ranges = (pattern) => [...mask.matchAll(pattern)].map((m) => {
    const open = m.index + m[0].length - 1;
    try { return [open, groupEnd(mask, open)]; } catch { return [open, mask.length]; }
  });
  const notAUser = ranges(NOT_A_USER);
  const clicks = ranges(/\bonClick\s*=\s*\{/g);
  const dependencies = dependencyLists(mask);
  const aliases = aliasDeclarations(mask);
  const within = (list, at) => list.some(([a, b]) => a < at && at < b);
  // The constant a mention of `fn` names: `const run = fn;` (a cast or `!` allowed) or `const run = useCallback(fn, […])`. Any other initializer
  // — `store.subscribe(fn)`, `{ go: fn }`, a function that hands it on later — passes it to code this check does not follow.
  const aliasAt = (at, fn) => {
    const alias = aliases.filter((d) => d.init <= at && at < d.end).reduce((best, d) => (!best || d.init > best.init ? d : best), null);
    const holder = enclosing(at);
    if (!alias || (holder && holder.start > alias.init)) return null;
    const head = mask.slice(alias.init, at);
    const tail = mask.slice(at + fn.length, alias.end);
    const renamed = /^\s*$/.test(head) && /^\s*(?:!\s*)?(?:(?:as|satisfies)\b[\s\S]*)?$/.test(tail);
    const memoized = /^\s*(?:React\s*\.\s*)?useCallback\s*(?:<(?:[^<>()]|<[^<>()]*>)*>\s*)?\(\s*$/.test(head) && /^\s*[,)]/.test(tail);
    return renamed || memoized ? alias.name : null;
  };
  // A page-wide rule: nothing of a built-in operation's failure tells the maker to deploy a Custom API, and no stack is shown.
  for (const literal of code.match(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`[^`]*`/g) || []) {
    if (/unavailable|not found|not available|\b404\b/i.test(literal) && /deploy|custom api/i.test(literal)) problems.push('a built-in operation message must not tell the maker to deploy a Custom API');
  }
  if (/\.\s*stack\b/.test(mask)) problems.push('a built-in operation failure must not show a stack');
  const disabledBy = new Map();
  for (const name of names) {
    const own = calls.filter((call) => literalString(call.fields.get('name') || '') === name);
    if (!own.length) continue;
    for (const call of own) {
      const at = `${name}`;
      const helper = call.scope;
      const result = call.resultName;
      const prefix = code.slice(helper.start, call.start);
      const prefixMask = mask.slice(helper.start, call.start);
      const post = code.slice(call.end + 1, helper.end);
      const postMask = mask.slice(call.end + 1, helper.end);
      if ([...call.fields.keys()].join(',') !== 'name') problems.push(`${at}: the request must be exactly { name } — no parameters and no boundTo`);
      // The presence check must return before the call: a page whose player lacks executeFunction sends nothing.
      const receiver = call.receiver ? call.receiver.split('.').map(escapeRe).join('\\s*\\??\\.\\s*') : '(?!)';
      const guard = new RegExp(`\\bif\\s*\\(\\s*typeof\\s+${receiver}\\s*\\??\\.\\s*executeFunction\\s*!==?\\s*(['"])`).exec(prefixMask);
      let returns = false;
      if (guard && /^['"]function['"]/.test(prefix.slice(guard.index + guard[0].length - 1))) {
        try { returns = /^\s*(?:return\b|\{[^}]*\breturn\b)/.test(prefixMask.slice(groupEnd(prefixMask, prefixMask.indexOf('(', guard.index)) + 1)); } catch { returns = false; }
      }
      if (!returns) problems.push(`${at}: a failed presence check must return before any request is made`);
      // User-triggered: every way to the helper starts at a button's onClick. A function is reached by a call (`fn(…)`) or by a mention that hands
      // it on (`setTimeout(fn, 0)`, `ref={fn}`, `const run = fn`). A mention in a button's onClick is the user's; one in an effect, a memo, a
      // timer, a frame or a microtask is not, whatever else also calls it; one in a hook's dependency list calls nothing; one that initializes a
      // constant makes that constant another name for it, followed the same way. Any other mention hands it to code that could call it unclicked.
      const reached = new Set();
      const handlers = [];
      const queue = [helper.name];
      while (queue.length) {
        const fn = queue.shift();
        if (reached.has(fn)) continue;
        reached.add(fn);
        const sites = [];
        for (const site of callSites(mask, fn)) {
          if (fn === helper.name && site.at > helper.start && site.at < helper.end) problems.push(`${at}: the helper calls itself (an automatic retry)`);
          else sites.push(site);
        }
        let referenced = false;
        let aliased = false;
        for (const mention of mentions(mask, fn)) {
          if (within(dependencies, mention)) continue;
          if (within(notAUser, mention)) { problems.push(`${at}: handed to an effect, a memo or a timer — a built-in operation is called only when the user clicks its button`); continue; }
          if (within(clicks, mention)) { referenced = true; continue; }
          const alias = aliasAt(mention, fn);
          if (alias) { aliased = true; queue.push(alias); continue; }
          problems.push(`${at}: ${fn} is handed somewhere other than its button's onClick — a ref, a child or a timer could call it without a click`);
        }
        if (!sites.length && !referenced && !aliased) problems.push(`${at}: ${fn} is not reached from a button's onClick`);
        for (const site of sites) {
          if (within(notAUser, site.at)) { problems.push(`${at}: called from an effect, a memo or a timer — a built-in operation is called only when the user clicks its button`); continue; }
          if (within(clicks, site.at)) continue;
          const outer = enclosing(site.at);
          if (!outer || renderRoots.has(outer.name)) { problems.push(`${at}: called while the page renders — a built-in operation is called only when the user clicks its button`); continue; }
          if (outer.name !== helper.name) { handlers.push(outer); queue.push(outer.name); }
        }
      }
      // The button: disabled while pending; a state of its own per operation.
      for (const [open] of clicks) {
        const region = mask.slice(open, groupEnd(mask, open));
        if (![...reached].some((fn) => new RegExp(`(?<![\\w$.])${escapeRe(fn)}(?![\\w$])`).test(region))) continue;
        const tagStart = mask.lastIndexOf('<', open);
        let depth = 0;
        let tagEnd = mask.length;
        for (let i = tagStart; i < mask.length; i += 1) {
          if (mask[i] === '{') depth += 1;
          else if (mask[i] === '}') depth -= 1;
          else if (mask[i] === '>' && depth === 0 && mask[i - 1] !== '=') { tagEnd = i; break; }
        }
        const disabled = /\bdisabled\s*=\s*\{([^}]*)\}/.exec(code.slice(tagStart, tagEnd));
        if (!disabled) problems.push(`${at}: its button is not disabled while the call is pending`);
        else disabledBy.set(name, disabled[1].replace(/\s+/g, ''));
      }
      const handlerText = handlers.map((h) => code.slice(h.start, h.end)).join('\n');
      if (!/\+\+\s*[\w$.]+\.current\b|[\w$.]+\.current\s*(?:\+\+|\+=\s*1\b)/.test(handlerText) || !/[!=]==?\s*[\w$.]+\.current\b|[\w$.]+\.current\s*[!=]==?/.test(handlerText)) {
        problems.push(`${at}: the handler does not ignore a stale request (a .current counter incremented before the call and compared after it)`);
      }
      if (!/\bcatch\b/.test(handlerText + prefix + post)) problems.push(`${at}: a rejected call is not caught`);
      if (LEAKS.test(mask.slice(helper.start, helper.end)) || LEAKS.test(handlers.map((h) => mask.slice(h.start, h.end)).join('\n'))) {
        problems.push(`${at}: the result must not be logged, stored, copied or sent`);
      }
      // …nor anything that keeps it, wherever the page uses that: the state rendered from it, a ref, a variable — at render, in an effect, in
      // another handler. A sink is the expression a LEAKS match starts, so what it is handed is what it logs, stores, copies or sends.
      const holders = resultHolders(mask, reached, call.resultName ? [{ name: call.resultName, at: call.start }] : []);
      for (const sink of mask.matchAll(SINKS)) {
        let end;
        try { end = expressionEnd(mask, sink.index); } catch { end = mask.length; }
        const holder = holders.find(({ name: held, start, end: scopeEnd }) => mentions(mask, held).some((spot) => spot > sink.index && spot < end && start < spot && spot < scopeEnd));
        if (holder) problems.push(`${at}: a value kept from its result (${holder.name}) must not be logged, stored, copied or sent`);
      }
      // Outputs: an object check, own-property reads, never a literal member, the root, a spread, an iteration or a serialization.
      if (!/\bArray\s*\.\s*isArray\s*\(/.test(postMask) || !/\btypeof\s+[\w$.?]+\s*!==?\s*(['"])object\1/.test(post)) {
        problems.push(`${at}: res.outputs must be checked to be a non-null, non-array object before it is read (an empty or 204 answer)`);
      }
      if (!/\bObject\s*\.\s*prototype\s*\.\s*hasOwnProperty\s*\.\s*call\s*\(|\bObject\s*\.\s*hasOwn\s*\(/.test(mask)) problems.push(`${at}: outputs must be read through own-property checks`);
      const sources = `(?:${escapeRe(result)}|[\\w$]*[oO]utputs)`;
      if (new RegExp(`\\b[\\w$]*[oO]utputs\\s*(?:\\?\\.|\\.)\\s*(?:${DTO})\\b`).test(mask)
        || new RegExp(`\\b[\\w$]*[oO]utputs\\s*(?:\\?\\.)?\\s*\\[\\s*(['"])(?:${DTO})\\1\\s*\\]`).test(code)
        || new RegExp(`\\{[^{}]*\\b(?:${DTO})\\b[^{}]*\\}\\s*=\\s*[\\w$.?]*[oO]utputs\\b`).test(mask)) {
        problems.push(`${at}: an output is read as a member instead of through an own-property check`);
      }
      if (new RegExp(`\\b${escapeRe(result)}\\s*\\??\\.\\s*(?:${DTO})\\b`).test(mask)
        || new RegExp(`\\.\\s*(?:${DTO})\\b`).test(mask.slice(helper.start, helper.end))) {
        problems.push(`${at}: a DTO field is read as a member — from the result root, res.value or a cast — instead of through an own-property check of res.outputs`);
      }
      if (new RegExp(`\\.\\.\\.\\s*${sources}\\b|JSON\\s*\\.\\s*stringify\\s*\\(\\s*${sources}\\b|Object\\s*\\.\\s*(?:keys|values|entries)\\s*\\(\\s*${sources}\\b|Object\\s*\\.\\s*assign\\s*\\([^)]*\\b${sources}\\b|\\bfor\\s*\\([^)]*\\bin\\s+${sources}\\b`).test(mask)) {
        problems.push(`${at}: outputs are spread, iterated or serialized — read the named properties only`);
      }
      if (/\.\s*message\s*\??\.\s*(?:includes|match|search|indexOf|startsWith|endsWith|toLowerCase)\s*\(|\.\s*test\s*\(\s*[\w$.?]*\.\s*message\b/.test(postMask)) {
        problems.push(`${at}: a status must never be read out of the message's words`);
      }
      if (!code.includes(UNEXPECTED)) problems.push(`${at}: an unexpected shape must say "${UNEXPECTED}"`);
      if (/\b404\b/.test(postMask) && !code.includes(UNAVAILABLE)) problems.push(`${at}: an actual 404 must say "${UNAVAILABLE}"`);
      const guards = returningGuards(post, postMask);
      if (name === 'WhoAmI') {
        // All or nothing: the three own-property reads, and ONE returning guard that tests every one of them with the GUID pattern.
        if (!code.includes(`/${GUID_SOURCE}/`)) problems.push(`${at}: the GUID pattern ${GUID_SOURCE} is not used`);
        const locals = new Map();
        for (const field of IDENTITY_FIELDS) {
          if (!new RegExp(`(['"])${field}\\1`).test(post)) problems.push(`${at}: ${field} is not read`);
          const local = new RegExp(`\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;\\n]*(['"])${field}\\2`).exec(post);
          locals.set(field, local ? local[1] : field);
        }
        const tested = (condition) => (/\.every\s*\(/.test(condition) && /\.test\s*\(/.test(condition)) || (condition.match(/\.test\s*\(/g) || []).length >= IDENTITY_FIELDS.length;
        const allOrNothing = guards.some(({ condition }) => tested(condition)
          && [...locals.values()].every((local) => new RegExp(`(?<![\\w$])${escapeRe(local)}(?![\\w$])`).test(condition)));
        if (!allOrNothing) problems.push(`${at}: the three identifiers must be shown all or none — one guard that returns must test every one with the GUID pattern`);
      }
      if (name === 'RetrieveVersion') {
        if (!/(['"])Version\1/.test(post)) problems.push(`${at}: Version is not read`);
        const bounded = guards.some(({ condition }) => /\b128\b/.test(condition) && (/!\s*[A-Za-z_$]/.test(condition) || /\.length\s*(?:<\s*1\b|===?\s*0\b|>=?\s*1\b|>\s*0\b)/.test(condition)));
        if (!bounded) problems.push(`${at}: Version must be a string of 1 to 128 characters, or nothing is shown`);
      }
    }
  }
  if (disabledBy.size === 2 && new Set(disabledBy.values()).size === 1) problems.push('each built-in operation needs a pending state of its own: one call must not disable the other\'s button');
  return [...new Set(problems)];
}

module.exports = {
  SECTION, SENTINEL, VERIFICATION_LINE, BUILT_IN_OUTPUTS,
  isBuiltInBinding, partitionBindings, plannedBuiltIns, unionBindings, listedBuiltIns, unionOrderProblems, builtInGateProblems,
  clearConfirmationProblems, builtInRuntimeProblems,
};
