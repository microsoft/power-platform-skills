'use strict';
// The managed binding store: the one local file that records which service rows a build manages for a declared form,
// dashboard, business rule or process flow, as whole groups (a root and every child the build placed under it).
//
// WHY A GROUP, AND WHY AN ATTEMPT. A declared form is one root row plus children (sections, cells, controls) that only
// mean something together. Recording them one by one (reconcile-common.js createFeatureSettlement, which records each
// binding in its own write) leaves a window where the file holds the old root and only part of the new children; a
// later build would then trust a set the service never had. Here a group is replaced whole, in one atomic write, and
// only after a fresh read proved it. Before anything is sent, an ATTEMPT is written: what the build is about to do and
// what the result must look like (`expected`). A build that dies after the service accepted the change and before the
// group was committed leaves that attempt behind; the next build must prove `expected` against a fresh read before it
// may use, replace or publish anything under that root. While an attempt is pending, `lookup` refuses to answer, so an
// older root can never authorize a plan that ignores an interrupted change.
//
// FAIL CLOSED. A missing file is an empty store (it is not evidence that nothing was ever sent). A file that cannot be
// read whole and valid — corrupt JSON, a foreign header, an unexpected key, a link or hard-link alias, an over-size file
// — is `managed-binding-store-unreadable`: the build stops before a protected write, and the file is never replaced
// with an empty store. One invalid group makes only that group unusable (`managed-binding-group-invalid`); it is kept
// on disk exactly as it was.
//
// RETIREMENT AND A NEW INCARNATION. A group whose root row was proved gone is retired (retireAbsentGroup). The same
// write gives its key a fresh random root id (`incarnations`), so a key declared again later is created as a new row
// under a new id, never under the deterministic id that was just retired; the catalog takes that id from the store, so
// every retry and recovery of the new create keeps it.
//
// WRITES. Every change takes the record lease (record-lease.js), rereads the file from disk, applies one change, and
// replaces the file atomically (apply-snapshot-store.js writeFileAtomic), then reads it back and compares the canonical
// hash: the writer redacts token-shaped text, and a write that changed an authoritative field must fail, not report
// success. Unlike the recovery hints that use the same lease, a lease that cannot be taken is fatal here
// (`managed-binding-store-busy`). Writes happen only inside a build step, never from an exit handler.
//
// Nothing in the shipped build calls this module yet: a build whose spec has no managed feature never opens it.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, normalizeGuid } = require('./reconcile-common.js');
const { environmentFingerprint, workspaceRoot } = require('./page-ownership-records.js');
const { writeFileAtomic } = require('./apply-snapshot-store.js');
const { withRecordLease } = require('./record-lease.js');
const { redactOutput } = require('./output-redaction.js');

const PREFIX = 'managed-bindings.';
// The envelope version. A store that holds only the original families stays at 1, exactly as an older build writes
// it; the first write that adds a group or attempt of a ROW_FAMILY (the configuration families, `configurationIdentity:
// "stable-v1"`) writes 2 in the same atomic change, and a version-2 store stays at 2. An older build refuses a
// version-2 file at this boundary, so it never reads a row protocol it does not know; resetting or deleting the file
// is not a downgrade (its bindings and pending obligations would be lost).
const SCHEMA_VERSION = 1;
const SCHEMA_VERSION_ROWS = 2;
// The whole file, as written (indented JSON). A larger file is refused, never truncated: on read it is unreadable, and a
// write that would make one is `managed-binding-store-full` with nothing written.
// Sized for the declarations the file keeps. A group can hold its declaration up to three times: the committed
// `originalDeclaration`, a copy the feature keeps in its consumer state (a process flow's `declaration.flow`), and a
// pending attempt's `declaration`. A declaration at DECLARATION_MAX_BYTES is up to about 1.4 MiB once indented, so one
// group at the cap takes about 4.2 MiB, and 32 MiB holds six such groups beside the reserve below — or about 18
// process flows at the documented ceiling (30 stages of 30 steps; about 1.5 MiB for all three copies). Every open reads
// and checks the whole file, so the bound stays well short of what would make a run slow.
const MAX_BYTES = 32 * (1 << 20);
// What a new obligation (prepareAttempt, markPublishDispatch; markSending when it acquires or enlarges a reservation)
// must leave free beyond every pending attempt's reservation (below). All are written before anything is sent, so a refusal here
// (`managed-binding-store-full`, nothing written) comes before the send it would have recorded. The shared part is
// room for the writes that follow a publish (notePublishOutcome, confirmPublished) and for the rest of the store's
// own bookkeeping, which no attempt owns.
const PREPARE_RESERVE_BYTES = 4 * (1 << 20);
// What each pending attempt keeps reserved, from its prepareAttempt until its commit or retirement removes it, for the
// writes from its send on (the expected proof, the counted dispatches, noteSaved, its workflow effects, and the commit
// that adds the feature's consumer state). The shared reserve above is free space at the moment of a check, so several attempts
// admitted against an almost full file could all rely on the same bytes and, once sent, not all complete. A
// reservation is per attempt instead: it is stored on the attempt (`completionReserve: { bytes, used }`), every
// admission (prepareAttempt, markPublishDispatch) must leave the shared reserve free beyond EVERY pending attempt's
// unused reservation, the attempt's own writes from markSending on spend its own reservation first,
// and no growing write may take the file into the bytes other attempts still hold. Commit and retirement release only
// the attempt they remove. An attempt with no reservation (prepared by an older build) or one smaller than its plan now
// asks for acquires or enlarges it at markSending, the write before any new send, as an admission like the ones above;
// one recovered read-only (never sent again) needs none. Its size: the feature's `completionBytes`, never less than COMPLETION_BASE_BYTES plus one
// copy of its declaration as a feature's consumer state keeps it (a process flow's `declaration.flow`, a rule's
// `declaration.rule`).
const COMPLETION_BASE_BYTES = 256 * (1 << 10);
// The largest reservation one attempt may hold, a quarter of the file. The compact cap on a declaration
// (DECLARATION_MAX_BYTES) does NOT bound its indented copy: the file is written with two spaces per level, so a deeply
// nested declaration within the cap can take many times its compact size (800 KB of nested arrays indents to about
// 16 MB). Each family's largest supported declaration needs well under this (the declaration budget tests); an attempt
// whose own minimum exceeds it is refused before it is prepared or sent (completionReserveFor), never reserved short.
const COMPLETION_MAX_BYTES = 8 * (1 << 20);
// How deep a feature's consumer state keeps its copy of the declaration in the file (env → groups → [i] →
// consumerState → declaration → flow → …), so the copy's indentation is counted; deeper than any family nests it.
const CONSUMER_COPY_DEPTH = 8;
// The reservation for an attempt: its `completionBytes`, never less than the base plus one indented copy of its
// declaration (`kept`, the plain-data snapshot checkDeclaration answered). A minimum above COMPLETION_MAX_BYTES is
// refused (`managed-binding-store-full`), never clamped: a reservation the store knows is too small would let the
// attempt send and then fail its own commit. `name` labels the refusal.
function completionReserveFor(kept, completionBytes, name) {
  let copy = 0;
  if (kept !== undefined) {
    const text = JSON.stringify(kept, null, 2);
    copy = Buffer.byteLength(text, 'utf8') + text.split('\n').length * 2 * CONSUMER_COPY_DEPTH;
  }
  const minimum = COMPLETION_BASE_BYTES + copy;
  if (minimum > COMPLETION_MAX_BYTES) {
    throw storeError(CODES.storeFull, `${name} needs at least ${minimum} bytes kept free for its completion (${COMPLETION_BASE_BYTES} plus ${copy} for the copy of its declaration a consumer state keeps, as the store writes it, indented), more than the ${COMPLETION_MAX_BYTES} one attempt may reserve. Nothing was written, and nothing was sent for it: declare it with less nesting or fewer entries`);
  }
  return Math.max(minimum, completionBytes === undefined ? 0 : completionBytes);
}

// A feature's estimate of what its completion adds to the store (`completionBytes`): absent, or a whole number up to
// COMPLETION_MAX_BYTES. A malformed one is refused, never skipped: an estimate the store ignored would leave the
// attempt the default reservation the feature said was too small. Shared by prepareAttempt, markSending and the wrapper
// (runManagedFeature checks every plan with it before anything is prepared, replaced or sent).
function checkCompletionBytes(completionBytes, where = 'completionBytes') {
  if (completionBytes === undefined) return undefined;
  if (!Number.isSafeInteger(completionBytes) || completionBytes < 0 || completionBytes > COMPLETION_MAX_BYTES) {
    throw storeError(CODES.notSettled, `${where} is the bytes the attempt's completion may add, a whole number up to ${COMPLETION_MAX_BYTES}`);
  }
  return completionBytes;
}

const CODES = Object.freeze({
  unreadable: 'managed-binding-store-unreadable',
  groupInvalid: 'managed-binding-group-invalid',
  busy: 'managed-binding-store-busy',
  conflict: 'managed-binding-generation-conflict',
  pending: 'managed-settlement-pending',
  writeFailed: 'managed-binding-write-failed',
  notSettled: 'managed-not-settled',
  completion: 'create-completion-required',
  // A root whose create no answer acknowledged, offered for a group not yet committed, without the feature's typed
  // adoption approval: a fresh read that proves the content shows what the row is, not that the maker agreed to
  // manage it.
  adoptionRequired: 'managed-adoption-required',
  // A new generation offered over a group whose publish may have been sent and is not proved live: committing it would
  // let a later read of the OLD dispatch's layer settle the NEW generation's debt. Confirm that dispatch first.
  publicationUncertain: 'managed-publication-unconfirmed',
  // A declaration offered with an attempt that the store will not keep (see validateDeclaration): refused before
  // anything is written, so before anything is sent.
  declarationRefused: 'managed-declaration-refused',
  // A write that would take the file past MAX_BYTES, a new obligation (prepareAttempt, markPublishDispatch, or a
  // markSending that acquires or enlarges a reservation) that would not leave PREPARE_RESERVE_BYTES free beyond every
  // pending attempt's reservation, a declaration whose own minimum reservation exceeds COMPLETION_MAX_BYTES, or a
  // growing write that would take bytes another attempt still holds: nothing is written. A refused new obligation was
  // never sent. After a send, an attempt whose writes stay within its
  // own reservation is never refused this way; one whose completion grows past it (a consumer state larger than its
  // `completionBytes`) may be, once the unreserved bytes are gone. Remedy: keep fewer or smaller declared groups in one
  // app and solution, or settle the pending ones first.
  storeFull: 'managed-binding-store-full',
  // A configuration request that its attempt's row protocol does not allow (a row it did not prepare under that id, a
  // second send of a row or effect): refused before the request leaves.
  requestMismatch: 'managed-create-request-mismatch',
});

// The configuration families (lib/configuration-create-bindings.js): one group per declared environment variable,
// connection reference, Custom API or duplicate-detection rule, holding its root and its own child rows. They exist only
// in a version-2 store and keep the row protocol (validateRowProtocol) on their attempts.
const ROW_FAMILIES = Object.freeze(['environmentVariable', 'connectionReference', 'customApi', 'duplicateRule']);
const FAMILIES = ['form', 'dashboard', 'rule', 'bpf', 'view', 'chart', ...ROW_FAMILIES];
// Forms and dashboards are rows of one table (systemform), rules and process flows of another (workflow): a root id
// may be bound once per table, whichever family claims it.
const NAMESPACE = {
  form: 'systemform', dashboard: 'systemform', rule: 'workflow', bpf: 'workflow', view: 'savedquery', chart: 'savedqueryvisualization',
  environmentVariable: 'environmentvariabledefinition', connectionReference: 'connectionreference', customApi: 'customapi', duplicateRule: 'duplicaterule',
};
// The physical table of each row kind a row family binds, root and child: a row id may be bound once per table across
// every group (an alias check by the record's own table, not its root family's).
const ROW_TABLE = Object.freeze({
  environmentVariable: 'environmentvariabledefinition', environmentVariableValue: 'environmentvariablevalue',
  connectionReference: 'connectionreference',
  customApi: 'customapi', customApiRequestParameter: 'customapirequestparameter', customApiResponseProperty: 'customapiresponseproperty',
  duplicateRule: 'duplicaterule', duplicateRuleCondition: 'duplicaterulecondition',
});
// The child kinds each row family may hold under its root.
const ROW_CHILD_KINDS = Object.freeze({
  environmentVariable: ['environmentVariableValue'], connectionReference: [],
  customApi: ['customApiRequestParameter', 'customApiResponseProperty'], duplicateRule: ['duplicateRuleCondition'],
});
const ROW_PROOF_SCHEMA = 'configuration-rows-v1';
// The binding kind of each family's root record. It is the kind the create catalog (lib/creates-catalog.js) hands a
// feature, so a feature records its root under the same spelling it was given: a business rule's group family is the
// short `rule`, but its root is a `business-rule` binding, never a `rule` one.
const ROOT_KIND = Object.freeze({
  form: 'form', dashboard: 'dashboard', rule: 'business-rule', bpf: 'bpf', view: 'view', chart: 'chart',
  environmentVariable: 'environmentVariable', connectionReference: 'connectionReference', customApi: 'customApi', duplicateRule: 'duplicateRule',
});
const PUBLISHING = new Set(['form', 'dashboard', 'view', 'chart']);
const PUBLICATION_STATES = new Set(['not-needed', 'owed', 'dispatching', 'unconfirmed', 'confirmed']);
// `fulfilled` is a state change this attempt never sent whose desired state a fresh read found already on its row: a
// terminal fact, kept until the attempt commits, so the change is never proposed or sent again (fulfillEffect).
const EFFECT_STATES = new Set(['definitely-unsent', 'dispatching', 'unconfirmed', 'confirmed', 'fulfilled']);
const UNCERTAIN = new Set(['dispatching', 'unconfirmed']);
const PHASES = new Set(['prepared', 'sending', 'saved', 'state-pending', 'membership-pending']);
const EFFECTS = new Set(['create', 'body', 'state']);
// What each family may keep as consumer state. Anything else (raw formxml, raw WFOM or XAML, tokens, service errors,
// environment URLs) is refused, so a careless consumer cannot turn the store into a copy of the service.
const CONSUMER_KEYS = {
  form: ['declaration', 'children', 'proofSchema'],
  dashboard: ['declaration', 'tiles', 'seedIds'],
  rule: ['declaration', 'slots'],
  bpf: ['declaration', 'stages'],
  view: ['baseline'],
  chart: ['baseline'],
  ...Object.fromEntries(ROW_FAMILIES.map((f) => [f, ['version', 'rows']])),
};
// The fixed control id of a form's timeline; it repeats on every form that has one, so it is not a physical alias.
const NOTES_CONTROL = 'notescontrol';
const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;
const groupId = (family, key) => `${family}\u0000${key}`;
const newToken = () => crypto.randomUUID();

function storeError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

// A schema check that names the first thing wrong. `where` is a path such as `groups[2].records[0]`.
function invalid(where, why) {
  return storeError(CODES.unreadable, `${where}: ${why}`);
}
function closedKeys(obj, allowed, where) {
  if (!isObj(obj)) throw invalid(where, 'is not an object');
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw invalid(where, `has an unexpected key "${k}"`);
}
function hashOrNull(v, where, nullable = true) {
  if (v === null && nullable) return;
  if (typeof v !== 'string' || !HEX64.test(v)) throw invalid(where, 'is not a sha256');
}
function tokenField(v, where, nullable = false) {
  if (v === null && nullable) return;
  if (!nonempty(v) || v.length > 128) throw invalid(where, 'is not a token');
}
function guidField(v, where) {
  if (typeof v !== 'string' || normalizeGuid(v) !== v) throw invalid(where, 'is not a lowercase GUID');
}

// The closed vocabulary of a publish scope, by its type. Shared with checkRowExtensions.
const SCOPE_KEYS = Object.freeze({ table: ['type', 'table'], dashboard: ['type', 'id'] });
function validateScope(scope, where) {
  if (!isObj(scope)) throw invalid(where, 'is not a scope');
  if (scope.type === 'table') {
    closedKeys(scope, SCOPE_KEYS.table, where);
    if (!/^[a-z0-9_]+$/.test(String(scope.table))) throw invalid(where, 'names no table');
  } else if (scope.type === 'dashboard') {
    closedKeys(scope, SCOPE_KEYS.dashboard, where);
    guidField(scope.id, `${where}.id`);
  } else {
    throw invalid(where, 'is not a table or dashboard scope');
  }
}

// Strings that would make the store a copy of service content or a credential carrier.
const XML_DOCUMENT = /^\s*<[A-Za-z?!][\s\S]*>\s*$/;
const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/;
const ENVIRONMENT_URL = /https?:\/\/[^\s"']*\.(?:dynamics|crm\d*\.dynamics)\.com/i;
function validateConsumerValue(value, where) {
  if (typeof value === 'string') {
    if (XML_DOCUMENT.test(value)) throw invalid(where, 'holds raw markup');
    if (JWT.test(value)) throw invalid(where, 'holds a token');
    if (ENVIRONMENT_URL.test(value)) throw invalid(where, 'holds an environment URL');
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => validateConsumerValue(v, `${where}[${i}]`)); return; }
  if (isObj(value)) { for (const [k, v] of Object.entries(value)) validateConsumerValue(v, `${where}.${k}`); return; }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  throw invalid(where, 'holds a value JSON cannot keep');
}

// The ORIGINAL declaration an attempt was planned from: the maker's authored input, which no hash can restore, so the
// store keeps it — with the attempt before anything is sent, then as the committed group's `originalDeclaration`. It is
// kept apart from `consumerState`, which holds what the feature derived and proved (a flow's applied state and backing
// identity, a rule's node history): the two are never merged or substituted for each other.
// Unlike consumer state it is authored text — names, descriptions, labels, a web resource or iframe URL, which may well
// name the environment's own dynamics.com host — so it is kept exactly as written (nothing is ever rewritten), and only
// what can carry a credential or a copy of service content is refused:
//   - a JWT anywhere in a string or a key;
//   - a URL whose authority holds userinfo, by the URL syntax (urlWithUserinfo): an `@` that can start a host anywhere
//     between the scheme and the first `/`, `?` or `#`, whitespace and a no-break space included, under any scheme.
//     Tabs and newlines are ignored first, as a URL parser ignores them, and http(s)/ws(s)/ftp/file need no `//` (a URL
//     parser accepts `https:user@host` too). In free text a bare link followed later by an address with no `/`, `?` or
//     `#` between them (`Visit https://contoso.com or write to sales@contoso.com`) is ambiguous and refused as well:
//     end the link with `/`, or quote or bracket it;
//   - a query or fragment parameter whose name, percent-decoded (`+` read as a space), is `access_token`, `id_token`,
//     `refresh_token`, `client_secret`, `password`, `passwd`, `pwd`, `sig` (an Azure SAS signature), `api_key` or
//     `apikey`. A name that does not decode cleanly, or still holds a `%` once decoded (`%2561ccess_token`), is
//     ambiguous and refused too;
//   - a connection-string secret (`AccountKey=`, `SharedAccessKey=`, `SharedAccessSignature=`, `ClientSecret=`, a
//     password or pwd key) at the start or after a `;`;
//   - a PEM private key;
//   - a string that is a service document (formxml, fetchxml, layoutxml, a chart's XML, WFOM or XAML): it opens with
//     `<?xml` or one of those roots. Authored markup such as `<b>Sales</b>` is free text and is kept;
//   - anything that is not plain JSON data: undefined, a function, a symbol key, a Date or other object that is not a
//     plain object or array, an accessor, a non-enumerable property (a hidden `toJSON` among them), extra properties
//     on an array, a non-finite number, a sparse array; a top level that is not a plain object; nesting deeper than
//     32; and more than DECLARATION_MAX_BYTES (1 MiB) of canonical JSON — a safety bound, so one declaration cannot take
//     a large share of the store (MAX_BYTES).
// The bound is sized from each family's largest declaration, with every name, label and description at its longest and
// written in three-byte UTF-8 text (sizes in canonical JSON; the margin is DECLARATION_MAX_BYTES over the size):
//   - bpf: the documented ceiling (references/app-spec-schema-advanced.md) of 30 stages of 30 steps, 64-character keys
//     and field names, 100-character names and a 2,000-character description: 445,901 bytes, a margin of 2.35;
//   - dashboard: 30 tiles (more components than a model-driven dashboard takes), every tile field set and a
//     2,000-character URL each: 110,353 bytes, a margin of 9.5;
//   - form and rule have no published ceiling, so the bound is a stated sizing model: a form of 1,000 fields in 25
//     tabs, 500 field options, 50 sub-grids, 50 quick views and 100 events is 442,654 bytes (a margin of 2.37); a rule
//     of 100 conditions and 100 actions, ten of them recommendations with ten apply-actions each, every literal 250
//     characters, is 333,738 bytes (a margin of 3.14);
//   - view and chart keep no declaration (only their consumer baseline), so only MAX_BYTES bounds them.
// Past the bound a declaration is `managed-declaration-refused` before anything is written or sent; the tests pin each
// family's largest declaration above.
// Validation reads every value exactly once and builds a plain-data snapshot from what it read; the snapshot, never
// the caller's object, is what is measured, compared and stored, so nothing can change between the check and the write.
// A token this process obtained is refused as well, whatever its shape (checkDeclaration, output-redaction.js).
const DECLARATION_MAX_BYTES = 1 << 20;
const DECLARATION_MAX_DEPTH = 32;
const SERVICE_DOCUMENT = /^\s*<(?:\?xml|form|fetch|grid|savedquery|columnset|visualization|datadefinition|presentationdescription|workflow|Activity)\b/i;
// Where a URL's authority starts: after `scheme://` for any scheme, and also after `scheme:` (slashes and backslashes in
// any number) for the special schemes, which a URL parser reads the same way.
const URL_START = /\b(?:(?:https?|wss?|ftp|file):[\\/]*|[a-z][a-z0-9+.-]*:[\\/]{2})/gi;
// A URL quoted or bracketed in authored text ends at the matching closer: `href="https://contoso.com"`, `<https://...>`,
// `[help](https://...)`.
const URL_CLOSERS = { '"': '"', "'": "'", '<': '>', '(': ')', '[': ']', '`': '`' };
// A parameter: `name=` right after `?`, `&`, `#` or `;`, wherever it stands (a URL, a hash route, plain text).
const PARAMETER = /[?&#;]([^=&#;?\s]*)=/g;
const SECRET_PARAMETERS = new Set(['access_token', 'id_token', 'refresh_token', 'client_secret', 'password', 'passwd', 'pwd', 'sig', 'api_key', 'apikey']);
const CONNECTION_SECRET = /(?:^|;)\s*(?:AccountKey|SharedAccessKey|SharedAccessSignature|ClientSecret|Password|Pwd)\s*=/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const isPlain = (v) => isObj(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
// Whether a URL in `text` has userinfo, by the URL syntax rather than its spelling. A parser's authority runs from the
// scheme to the first `/`, `?` or `#` (a backslash too, for a special scheme; it is not a stop here, which refuses more,
// never less), and the LAST `@` in it ends the userinfo. Whitespace is no stop: a parser percent-encodes a space or a
// no-break space in userinfo and keeps it (`new URL('https://fixture secret@contoso.com/').username` is
// `fixture%20secret`), so `scheme:// … @host` is userinfo however the part before the `@` is spelled.
// See: https://url.spec.whatwg.org/#authority-state
// In free text that also makes the end of a bare link ambiguous: `Visit https://contoso.com or write to
// sales@contoso.com` IS a URL with a user name to a parser handed the whole string. Rather than guess where the author
// meant it to end, any `@` followed by a host character inside that span is refused; the remedy is to end the link with
// `/`, or to quote or bracket it. An `@` followed by a space or by nothing cannot start a host, so it is not userinfo.
// A link opened by a quote or bracket ends at the matching closer (URL_CLOSERS), as markup and Markdown links do.
// One right-to-left pass records, for every position, the next stop and the next `@` that can start a host, so a long
// text with many scheme-like words is scanned in linear time.
function urlWithUserinfo(text) {
  if (!text.includes('@')) return false;
  const n = text.length;
  const nextStop = new Int32Array(n + 1);
  const nextAt = new Int32Array(n + 1);
  nextStop[n] = n;
  nextAt[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    const c = text[i];
    nextStop[i] = c === '/' || c === '?' || c === '#' ? i : nextStop[i + 1];
    nextAt[i] = c === '@' && i + 1 < n && text[i + 1] !== ' ' ? i : nextAt[i + 1];
  }
  const nextCloser = {};
  const nextOf = (ch) => {
    if (!nextCloser[ch]) {
      const a = new Int32Array(n + 1);
      a[n] = n;
      for (let i = n - 1; i >= 0; i -= 1) a[i] = text[i] === ch ? i : a[i + 1];
      nextCloser[ch] = a;
    }
    return nextCloser[ch];
  };
  for (const m of text.matchAll(URL_START)) {
    const start = m.index + m[0].length;
    let end = nextStop[start];
    const closer = m.index > 0 ? URL_CLOSERS[text[m.index - 1]] : undefined;
    if (closer) end = Math.min(end, nextOf(closer)[start]);
    if (nextAt[start] < end) return true;
  }
  return false;
}
function declarationText(s, where) {
  if (JWT.test(s)) throw invalid(where, 'holds a token');
  // WHATWG URL parsing removes every ASCII tab and newline before it reads a URL, so they cannot hide userinfo here.
  // See: https://url.spec.whatwg.org/#concept-basic-url-parser
  const flat = s.replace(/[\t\n\r]/g, '');
  if (urlWithUserinfo(flat)) throw invalid(where, 'holds a URL with credentials, or a URL whose end is ambiguous');
  for (const m of flat.matchAll(PARAMETER)) {
    let name;
    try {
      name = decodeURIComponent(m[1].replace(/\+/g, ' '));
    } catch {
      throw invalid(where, 'holds a parameter whose name does not decode');
    }
    if (name.includes('%')) throw invalid(where, 'holds a parameter whose name is encoded more than once');
    if (SECRET_PARAMETERS.has(name.trim().toLowerCase())) throw invalid(where, 'holds a secret');
  }
  if (CONNECTION_SECRET.test(s)) throw invalid(where, 'holds a secret');
  if (PRIVATE_KEY.test(s)) throw invalid(where, 'holds a private key');
  if (SERVICE_DOCUMENT.test(s)) throw invalid(where, 'holds a service document');
}
// One own data property, read once through its descriptor: an accessor (a getter could answer differently each time),
// a non-enumerable property (JSON.stringify would run a hidden `toJSON`, or drop the property) or a symbol key is not
// plain data.
function dataValue(v, key, where) {
  if (typeof key !== 'string') throw invalid(where, 'has a symbol key');
  const d = Object.getOwnPropertyDescriptor(v, key);
  if (!d || !d.enumerable || !Object.prototype.hasOwnProperty.call(d, 'value')) throw invalid(where, `has "${key}", which is not plain data`);
  return d.value;
}
function declarationSnapshot(v, where, depth) {
  if (depth > DECLARATION_MAX_DEPTH) throw invalid(where, `is nested deeper than ${DECLARATION_MAX_DEPTH}`);
  if (typeof v === 'string') { declarationText(v, where); return v; }
  if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) throw invalid(where, 'holds a value JSON cannot keep');
    const length = v.length;
    // Only its indexes and `length`: a hole has no descriptor (JSON would write null and read back something else),
    // and any other own property would be dropped.
    for (const k of Reflect.ownKeys(v)) {
      if (k !== 'length' && !(typeof k === 'string' && /^(?:0|[1-9]\d*)$/.test(k) && Number(k) < length)) throw invalid(where, 'has a property that is not an item');
    }
    const out = [];
    for (let i = 0; i < length; i += 1) out.push(declarationSnapshot(dataValue(v, String(i), where), `${where}[${i}]`, depth + 1));
    return out;
  }
  if (isPlain(v)) {
    const out = {};
    for (const k of Reflect.ownKeys(v)) {
      const value = dataValue(v, k, where);
      declarationText(k, `${where} (a key)`);
      // defineProperty, not assignment: a key named `__proto__` is data here, never the snapshot's prototype.
      Object.defineProperty(out, k, { value: declarationSnapshot(value, `${where}.${k}`, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  throw invalid(where, 'holds a value JSON cannot keep');
}
// The one declaration rule, for a declaration offered (checkDeclaration) and for one read back from disk: answers the
// plain-data snapshot.
function validateDeclaration(value, where) {
  if (!isPlain(value)) throw invalid(where, 'is not a plain object');
  const snapshot = declarationSnapshot(value, where, 0);
  const bytes = Buffer.byteLength(canonicalJson(snapshot), 'utf8');
  if (bytes > DECLARATION_MAX_BYTES) throw invalid(where, `is ${bytes} bytes, more than ${DECLARATION_MAX_BYTES}`);
  return snapshot;
}
/**
 * Check a declaration offered for an attempt of `family` (prepareAttempt `declaration`) and answer the plain-data
 * snapshot that is kept: the family must keep one (form, dashboard, rule, bpf), the value must pass the declaration
 * rule above, and it must hold no access token this process obtained (the atomic writer takes those out of every
 * write, so the declaration would be written changed and fail its read-back). Anything else is
 * `managed-declaration-refused`. Pure: it reads and writes nothing, so a caller may check before it changes anything.
 */
function checkDeclaration(family, key, declaration) {
  try {
    if (!CONSUMER_KEYS[family] || !CONSUMER_KEYS[family].includes('declaration')) throw invalid('the declaration', `has no place in a ${family} group`);
    const snapshot = validateDeclaration(declaration, 'the declaration');
    const text = JSON.stringify(snapshot);
    if (redactOutput(text) !== text) throw invalid('the declaration', 'holds an access token this process obtained');
    return snapshot;
  } catch (e) {
    throw storeError(CODES.declarationRefused, `the declaration of the managed ${family} "${key}" is refused: ${e.message}`, { cause: e });
  }
}

const ROOT_KEYS = ['kind', 'key', 'id'];
function validateRoot(root, family, key, where) {
  closedKeys(root, ROOT_KEYS, where);
  if (!nonempty(root.kind) || root.key !== key) throw invalid(where, 'is not this group\'s root');
  guidField(root.id, `${where}.id`);
  if (root.kind !== ROOT_KIND[family]) throw invalid(where, `is a ${root.kind} root, and a ${family} group's root is a ${ROOT_KIND[family]}`);
}

// The proof a committed group keeps. Every field is required: the saved, semantic and preservation hashes are never
// null, because a group that cannot show them was not proved; the child-set hash is null only for a group that
// expects no child (a business rule, a form whose declaration places no control).
const PROOF_KEYS = ['savedSha256', 'semanticSha256', 'preservationSha256', 'expectedChildrenSha256'];
function validateProof(proof, where) {
  closedKeys(proof, PROOF_KEYS, where);
  for (const k of PROOF_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(proof, k)) throw invalid(where, `has no ${k}`);
    hashOrNull(proof[k], `${where}.${k}`, k === 'expectedChildrenSha256');
  }
}

// The closed field vocabulary of each persisted shape. The validators hold every unit to it, and checkRowExtensions
// holds a configuration unit to it BEFORE that unit's own validation can isolate it (see there).
const RECORD_KEYS = ['formatVersion', 'appUniqueName', 'environmentFingerprint', 'kind', 'key', 'id', 'intentSha256', 'origin', 'parentKey', 'partsSha256', 'localCreateDraft'];
const GROUP_KEYS = ['family', 'key', 'generation', 'previousGeneration', 'root', 'proofSchema', 'records', 'proof', 'consumerState', 'originalDeclaration', 'publication'];
const ATTEMPT_KEYS = ['family', 'key', 'token', 'baseGeneration', 'phase', 'root', 'knownScopes', 'declarationSha256', 'declaration', 'expected', 'acknowledgedRoot', 'acknowledgedChildCreates', 'savedObservation', 'publication', 'sendWindow', 'completionReserve', 'dashboardCreate', 'rowProtocol'];
const EXPECTED_KEYS = ['proofVersion', 'proofSchema', 'rootId', 'baseProofSha256', 'sentProjectionSha256', 'preservationSha256', 'baseObservation', 'children'];
const EXPECTED_CHILD_KEYS = ['kind', 'key', 'namespaceParentId', 'id', 'associationSha256'];
const BASE_OBSERVATION_KEYS = ['rowVersion', 'savedSha256'];
const SAVED_OBSERVATION_KEYS = ['phase', 'proof', 'acknowledgedRoot'];
const CHILD_RECEIPT_KEYS = ['kind', 'key', 'id'];
const PUBLICATION_KEYS = ['scope', 'state', 'desiredSha256', 'dispatchToken', 'carriedFrom'];
const ATTEMPT_PUBLICATION_KEYS = ['scope', 'state'];
// A carried publication's `carriedFrom`: the current shape, and the older one (only state and dispatch token).
const CARRIED_FROM_KEYS = ['state', 'dispatchToken', 'publishedSha256', 'savedSha256'];
const LEGACY_CARRIED_FROM_KEYS = ['state', 'dispatchToken'];
const SEND_WINDOW_KEYS = ['possible', 'notStarted', 'epoch'];
const COMPLETION_RESERVE_KEYS = ['bytes', 'used'];

function validateRecord(rec, header, where) {
  // `localCreateDraft` is placed only by the store (commitGroup) and only on a created dashboard root; validateGroup
  // checks where it sits (validateLocalCreateDraft).
  closedKeys(rec, RECORD_KEYS, where);
  if (rec.formatVersion !== 1) throw invalid(where, 'has an unknown format');
  if (rec.appUniqueName !== header.appUniqueName || rec.environmentFingerprint !== header.environmentFingerprint) throw invalid(where, 'belongs to another app or environment');
  if (!nonempty(rec.kind) || !nonempty(rec.key)) throw invalid(where, 'has no kind or key');
  // A rule's body is proved by its whole projection, not by node records: a node id the bundle replaces on every
  // read cannot be a binding.
  if (rec.kind === 'business-rule-node') throw invalid(where, 'binds a business-rule node');
  if (!nonempty(rec.id) || rec.id.length > 200 || /[<>]/.test(rec.id)) throw invalid(where, 'has no usable id');
  hashOrNull(rec.intentSha256, `${where}.intentSha256`, false);
  if (rec.origin !== 'created' && rec.origin !== 'adopted') throw invalid(where, 'has an origin other than created or adopted');
  if (rec.parentKey !== undefined && !nonempty(rec.parentKey)) throw invalid(where, 'has an empty parentKey');
  if (rec.partsSha256 !== undefined) {
    if (!isObj(rec.partsSha256)) throw invalid(where, 'has unreadable partsSha256');
    for (const [k, v] of Object.entries(rec.partsSha256)) hashOrNull(v, `${where}.partsSha256.${k}`, false);
  }
}

function validateRecords(records, root, header, where) {
  if (!Array.isArray(records)) throw invalid(where, 'is not a list');
  const keys = new Set();
  const ids = new Set();
  records.forEach((rec, i) => {
    validateRecord(rec, header, `${where}[${i}]`);
    const k = `${rec.kind}\u0000${rec.key}`;
    if (keys.has(k)) throw invalid(`${where}[${i}]`, 'repeats a (kind, key) of this group');
    keys.add(k);
    const id = rec.id.toLowerCase();
    if (id !== NOTES_CONTROL && ids.has(id)) throw invalid(`${where}[${i}]`, 'repeats an id of this group');
    ids.add(id);
    if (rec.kind === root.kind && rec.key === root.key && rec.id !== root.id) throw invalid(`${where}[${i}]`, 'binds the root to another id');
  });
  const recordKeys = new Set(records.map((r) => r.key));
  records.forEach((rec, i) => {
    if (rec.parentKey !== undefined && !recordKeys.has(rec.parentKey)) throw invalid(`${where}[${i}]`, 'names a parent this group does not hold');
  });
}

function validatePublication(pub, family, where, { attempt = false } = {}) {
  if (!PUBLISHING.has(family)) {
    if (pub !== null) throw invalid(where, 'is set for a family that is not published');
    return;
  }
  if (attempt) {
    if (pub === null) return;
    closedKeys(pub, ATTEMPT_PUBLICATION_KEYS, where);
    if (pub.state !== 'owed') throw invalid(where, 'is not owed');
  } else {
    closedKeys(pub, PUBLICATION_KEYS, where);
    if (!PUBLICATION_STATES.has(pub.state)) throw invalid(where, 'has an unknown state');
    hashOrNull(pub.desiredSha256, `${where}.desiredSha256`);
    // A dispatch token is written only in the branch that actually sends, so it exists exactly when a send may have run.
    const sent = pub.state === 'dispatching' || pub.state === 'unconfirmed' || pub.state === 'confirmed';
    if (sent) tokenField(pub.dispatchToken, `${where}.dispatchToken`); else if (pub.dispatchToken !== null) throw invalid(where, 'carries a dispatch token it never sent');
    // A carried dispatch (markPublishDispatch `carried`): a covered group whose debt this publish does not pay, swept
    // into a publish of its scope. It keeps the publication it had, so a send that never started puts exactly that
    // back, and the layers read just before the send: `publishedSha256` (what was live) and `savedSha256` (what the
    // publish ships). Its desired intent is left as it was committed, null included. A record from before that
    // evidence existed (only `state` and `dispatchToken`) still needs a desired hash, and is never a witness.
    if (pub.carriedFrom !== undefined) {
      if (!UNCERTAIN.has(pub.state)) throw invalid(where, 'keeps a carried state outside a dispatch');
      const cf = pub.carriedFrom;
      const w = `${where}.carriedFrom`;
      if (isObj(cf) && ('publishedSha256' in cf || 'savedSha256' in cf)) {
        closedKeys(cf, CARRIED_FROM_KEYS, w);
        hashOrNull(cf.publishedSha256, `${w}.publishedSha256`, false);
        hashOrNull(cf.savedSha256, `${w}.savedSha256`, false);
        if (cf.state === 'confirmed') tokenField(cf.dispatchToken, `${w}.dispatchToken`);
        else if ((cf.state !== 'not-needed' && cf.state !== 'owed') || cf.dispatchToken !== null) throw invalid(w, 'is not a publication a publish can carry');
      } else {
        if (typeof pub.desiredSha256 !== 'string') throw invalid(where, 'is carried with no desired hash to confirm');
        closedKeys(cf, LEGACY_CARRIED_FROM_KEYS, w);
        if (cf.state === 'confirmed') tokenField(cf.dispatchToken, `${w}.dispatchToken`);
        else if (cf.state !== 'not-needed' || cf.dispatchToken !== null) throw invalid(w, 'is not a settled publication');
      }
    }
  }
  validateScope(pub.scope, `${where}.scope`);
  if (family === 'dashboard' && pub.scope.type !== 'dashboard') throw invalid(where, 'publishes a dashboard as a table');
  if (family !== 'dashboard' && pub.scope.type !== 'table') throw invalid(where, 'publishes a table artifact as a dashboard');
}

function validateExpected(exp, where) {
  closedKeys(exp, EXPECTED_KEYS, where);
  if (exp.proofVersion !== 1) throw invalid(where, 'has an unknown proof version');
  if (!nonempty(exp.proofSchema)) throw invalid(where, 'names no proof schema');
  guidField(exp.rootId, `${where}.rootId`);
  hashOrNull(exp.baseProofSha256, `${where}.baseProofSha256`);
  hashOrNull(exp.sentProjectionSha256, `${where}.sentProjectionSha256`, false);
  hashOrNull(exp.preservationSha256, `${where}.preservationSha256`, false);
  if (exp.baseObservation !== null) {
    closedKeys(exp.baseObservation, BASE_OBSERVATION_KEYS, `${where}.baseObservation`);
    if (exp.baseObservation.rowVersion !== null && !nonempty(exp.baseObservation.rowVersion)) throw invalid(`${where}.baseObservation`, 'has an empty row version');
    hashOrNull(exp.baseObservation.savedSha256, `${where}.baseObservation.savedSha256`);
  }
  if (!Array.isArray(exp.children)) throw invalid(where, 'has no child list');
  const seen = new Set();
  exp.children.forEach((c, i) => {
    const w = `${where}.children[${i}]`;
    closedKeys(c, EXPECTED_CHILD_KEYS, w);
    if (!nonempty(c.kind) || !nonempty(c.key) || !nonempty(c.id)) throw invalid(w, 'is incomplete');
    if (c.kind === 'business-rule-node') throw invalid(w, 'expects a business-rule node');
    guidField(c.namespaceParentId, `${w}.namespaceParentId`);
    hashOrNull(c.associationSha256, `${w}.associationSha256`, false);
    const k = `${c.kind}\u0000${c.key}`;
    if (seen.has(k)) throw invalid(w, 'repeats a (kind, key)');
    seen.add(k);
  });
}

function validateGroup(g, header, where) {
  closedKeys(g, GROUP_KEYS, where);
  tokenField(g.generation, `${where}.generation`);
  tokenField(g.previousGeneration, `${where}.previousGeneration`, true);
  validateRoot(g.root, g.family, g.key, `${where}.root`);
  if (!nonempty(g.proofSchema)) throw invalid(where, 'names no proof schema');
  validateRecords(g.records, g.root, header, `${where}.records`);
  if (!g.records.some((r) => r.kind === g.root.kind && r.key === g.root.key)) throw invalid(where, 'holds no record of its root');
  g.records.forEach((r, i) => { if (r.localCreateDraft !== undefined) validateLocalCreateDraft(g, r, `${where}.records[${i}].localCreateDraft`); });
  validateProof(g.proof, `${where}.proof`);
  closedKeys(g.consumerState, CONSUMER_KEYS[g.family], `${where}.consumerState`);
  if (isRowFamily(g.family)) {
    if (g.proofSchema !== ROW_PROOF_SCHEMA) throw invalid(where, `names the proof schema ${g.proofSchema}, not ${ROW_PROOF_SCHEMA}`);
    for (const rec of g.records) if (!rowKindAllowed(g.family, rec.kind)) throw invalid(where, `binds a ${rec.kind} row, which a ${g.family} group does not hold`);
    validateRowConsumer(g.consumerState, g.family, g.records, `${where}.consumerState`);
  }
  validateConsumerValue(g.consumerState, `${where}.consumerState`);
  // The original declaration of the attempt that committed this generation, when it recorded one: kept beside the
  // feature's consumer state, never inside it (a feature's derived state is checked by the stricter rule above).
  if (g.originalDeclaration !== undefined) {
    if (!CONSUMER_KEYS[g.family].includes('declaration')) throw invalid(where, 'keeps a declaration its family has no place for');
    validateDeclaration(g.originalDeclaration, `${where}.originalDeclaration`);
  }
  validatePublication(g.publication, g.family, `${where}.publication`);
}

// A dashboard create's durable receipt, kept on its attempt (noteDashboardCreateDraft / Dispatch / Answer), e.g.
//   { formatVersion: 1, rootId: '<guid>', sendEpoch: 1, draftSha256: '<64 hex>', bodySha256: '<64 hex>',
//     dispatchToken: null | '<uuid>', acknowledged: false }
// draftSha256 is the canonical hash of the whole local artifact the build assembled and sent; bodySha256 that of the
// create request body it produced. The hashes canonicalize object-key order only: the XML strings inside are compared
// byte for byte. `acknowledged` is true only once the observed transport saw a successful answer to that exact POST.
// It is valid only on a create of a new dashboard root, after its send window was armed, under the window's epoch.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DASHBOARD_CREATE_KEYS = ['formatVersion', 'rootId', 'sendEpoch', 'draftSha256', 'bodySha256', 'dispatchToken', 'acknowledged'];
function validateDashboardCreate(a, where) {
  const d = a.dashboardCreate;
  closedKeys(d, DASHBOARD_CREATE_KEYS, where);
  for (const k of DASHBOARD_CREATE_KEYS) if (!Object.prototype.hasOwnProperty.call(d, k)) throw invalid(where, `has no ${k}`);
  if (d.formatVersion !== 1) throw invalid(where, 'has an unknown format');
  if (a.family !== 'dashboard') throw invalid(where, 'is kept on an attempt that is not a dashboard\'s');
  guidField(d.rootId, `${where}.rootId`);
  if (d.rootId !== a.root.id) throw invalid(where, 'names another root than its attempt');
  if (a.baseGeneration !== null || !a.expected || a.expected.baseProofSha256 !== null || a.expected.baseObservation !== null) throw invalid(where, 'is kept on an attempt that is not a create of a new root');
  if (a.phase === 'prepared') throw invalid(where, 'is kept on an attempt never marked sending');
  if (!a.sendWindow || !Number.isSafeInteger(d.sendEpoch) || d.sendEpoch < 1 || d.sendEpoch !== a.sendWindow.epoch) throw invalid(where, 'is not under its attempt\'s send epoch');
  hashOrNull(d.draftSha256, `${where}.draftSha256`, false);
  hashOrNull(d.bodySha256, `${where}.bodySha256`, false);
  if (d.dispatchToken !== null && !(typeof d.dispatchToken === 'string' && UUID_RE.test(d.dispatchToken))) throw invalid(`${where}.dispatchToken`, 'is not a dispatch token');
  if (typeof d.acknowledged !== 'boolean') throw invalid(where, 'has no acknowledged flag');
  if (d.acknowledged && d.dispatchToken === null) throw invalid(where, 'is acknowledged without a dispatch');
  // An older acknowledgement on the same attempt is only ever the receipt's own: it cannot stand beside an
  // unacknowledged receipt.
  if ((a.acknowledgedRoot || (a.savedObservation && a.savedObservation.acknowledgedRoot)) && !d.acknowledged) throw invalid(where, 'is unacknowledged under an attempt that says its root was acknowledged');
}

// The create evidence a committed dashboard root keeps (commitGroup mints it from an acknowledged receipt and keeps it
// on every later generation of the same root): { formatVersion: 1, rootId, attemptToken, draftSha256, bodySha256 }.
// Only the root record of a dashboard group, with origin `created`, may carry it.
const LOCAL_CREATE_DRAFT_KEYS = ['formatVersion', 'rootId', 'attemptToken', 'draftSha256', 'bodySha256'];
function validateLocalCreateDraft(g, rec, where) {
  const m = rec.localCreateDraft;
  closedKeys(m, LOCAL_CREATE_DRAFT_KEYS, where);
  for (const k of LOCAL_CREATE_DRAFT_KEYS) if (!Object.prototype.hasOwnProperty.call(m, k)) throw invalid(where, `has no ${k}`);
  if (m.formatVersion !== 1) throw invalid(where, 'has an unknown format');
  if (g.family !== 'dashboard' || rec.kind !== g.root.kind || rec.key !== g.root.key) throw invalid(where, 'is kept on a record that is not a dashboard root');
  if (rec.origin !== 'created') throw invalid(where, 'is kept on a root this build did not create');
  guidField(m.rootId, `${where}.rootId`);
  if (m.rootId !== g.root.id || rec.id !== g.root.id) throw invalid(where, 'names another root');
  if (typeof m.attemptToken !== 'string' || !UUID_RE.test(m.attemptToken)) throw invalid(`${where}.attemptToken`, 'is not an attempt token');
  hashOrNull(m.draftSha256, `${where}.draftSha256`, false);
  hashOrNull(m.bodySha256, `${where}.bodySha256`, false);
}

function validateAttempt(a, where) {
  closedKeys(a, ATTEMPT_KEYS, where);
  // The completion reservation (prepareAttempt; see COMPLETION_BASE_BYTES), e.g. { bytes: 434176, used: 1290 }. Absent
  // on an attempt an older build prepared: it holds nothing until a new send under it acquires one (markSending, as an
  // admission); an attempt already sent with none (read-only recovery, a commit) uses only unreserved bytes.
  if (a.completionReserve !== undefined) {
    closedKeys(a.completionReserve, COMPLETION_RESERVE_KEYS, `${where}.completionReserve`);
    const { bytes, used } = a.completionReserve;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > COMPLETION_MAX_BYTES || !Number.isSafeInteger(used) || used < 0 || used > bytes) throw invalid(`${where}.completionReserve`, 'is not a reservation');
  }
  tokenField(a.token, `${where}.token`);
  tokenField(a.baseGeneration, `${where}.baseGeneration`, true);
  if (!PHASES.has(a.phase)) throw invalid(where, 'has an unknown phase');
  validateRoot(a.root, a.family, a.key, `${where}.root`);
  if (!Array.isArray(a.knownScopes)) throw invalid(where, 'has no known scopes');
  a.knownScopes.forEach((s, i) => validateScope(s, `${where}.knownScopes[${i}]`));
  hashOrNull(a.declarationSha256, `${where}.declarationSha256`, false);
  // The original declaration (prepareAttempt `declaration`): optional, and only for a family whose group keeps one.
  if (a.declaration !== undefined) {
    if (!CONSUMER_KEYS[a.family].includes('declaration')) throw invalid(where, 'keeps a declaration its family has no place for');
    validateDeclaration(a.declaration, `${where}.declaration`);
  }
  // Only a prepared attempt may lack `expected`: nothing is sent before it is written (markSending).
  if (a.expected === null) {
    if (a.phase !== 'prepared') throw invalid(where, 'was sent without an expected proof');
  } else {
    validateExpected(a.expected, `${where}.expected`);
    if (a.expected.rootId !== a.root.id) throw invalid(where, 'expects another root');
  }
  if (typeof a.acknowledgedRoot !== 'boolean') throw invalid(where, 'has no acknowledged-root flag');
  if (a.savedObservation !== null) {
    closedKeys(a.savedObservation, SAVED_OBSERVATION_KEYS, `${where}.savedObservation`);
    if (!PHASES.has(a.savedObservation.phase) || typeof a.savedObservation.acknowledgedRoot !== 'boolean') throw invalid(`${where}.savedObservation`, 'is incomplete');
    validateConsumerValue(a.savedObservation.proof, `${where}.savedObservation.proof`);
  }
  // The child-create receipt (noteSaved `acknowledgedChildCreates`): written only with a saved observation, and only for
  // children the expected proof named under the same id, never the root.
  if (a.acknowledgedChildCreates !== undefined) {
    if (a.savedObservation === null || !a.expected) throw invalid(where, 'keeps a child-create receipt it never saved');
    validateChildReceipt(a.acknowledgedChildCreates, a, `${where}.acknowledgedChildCreates`);
  }
  validatePublication(a.publication, a.family, `${where}.publication`, { attempt: true });
  // The send window (markSending with an observer; lib/managed-feature-contract.js createAttemptSendObserver). Absent on
  // an attempt sent without one — nothing then says what reached the service, and recovery only proves.
  //   { possible: 0, notStarted: 2, epoch: 3 }
  //     possible    mutations that reached the transport in the attempt's windows and were not answered by a
  //                 not-started rejection (sent, answer pending or lost, or applied);
  //     notStarted  those the service answered with one;
  //     epoch       the fencing token of the run that owns the attempt's sends: 1 when it was first marked sending, one
  //                 more at every claim to continue or resume it (markSending `claim`). A dispatch counted under any
  //                 other epoch is refused unsent (noteAttemptDispatch), so an older run is fenced at the transport.
  if (a.sendWindow !== undefined) {
    closedKeys(a.sendWindow, SEND_WINDOW_KEYS, `${where}.sendWindow`);
    for (const k of ['possible', 'notStarted']) if (!Number.isSafeInteger(a.sendWindow[k]) || a.sendWindow[k] < 0) throw invalid(`${where}.sendWindow.${k}`, 'is not a count');
    if (!Number.isSafeInteger(a.sendWindow.epoch) || a.sendWindow.epoch < 1) throw invalid(`${where}.sendWindow.epoch`, 'is not an epoch');
    if (a.phase === 'prepared') throw invalid(where, 'has a send window but was never marked sending');
  }
  if (a.dashboardCreate !== undefined) validateDashboardCreate(a, `${where}.dashboardCreate`);
  // The row protocol: required on every attempt of a configuration family, refused on any other.
  if (isRowFamily(a.family)) {
    if (a.rowProtocol === undefined) throw invalid(where, 'has no row protocol');
    validateRowProtocol(a.rowProtocol, a, `${where}.rowProtocol`);
    if (a.expected) {
      if (a.expected.proofSchema !== ROW_PROOF_SCHEMA) throw invalid(where, `expects the proof schema ${a.expected.proofSchema}, not ${ROW_PROOF_SCHEMA}`);
      for (const c of a.expected.children) {
        const row = a.rowProtocol.rows.find((r) => r.kind === c.kind && r.key === c.key);
        if (!row || row.id !== rowIdKey(c.id)) throw invalid(where, `expects the ${c.kind} "${c.key}" its row protocol does not name under that id`);
      }
    }
  } else if (a.rowProtocol !== undefined) throw invalid(where, 'keeps a row protocol its family has no place for');
}

// The workflow effects the attempt `a` owns.
const ownedEffects = (a, effects) => (effects || []).filter((x) => x.attemptToken === a.token);

// A workflow effect as recordWorkflowEffect persists it: definitely-unsent, with a fresh token and no dispatch token.
function effectRecord(effect) {
  if (!isObj(effect)) throw storeError(CODES.notSettled, 'a workflow effect must be an object');
  const request = isObj(effect.request) ? { method: String(effect.request.method || '').toUpperCase(), shape: effect.request.shape } : effect.request;
  return {
    token: newToken(), attemptToken: effect.attemptToken, baseGeneration: effect.baseGeneration === undefined ? null : effect.baseGeneration,
    family: effect.family, key: effect.key, rowId: normalizeGuid(effect.rowId) || effect.rowId, effect: effect.effect, request,
    desiredSha256: effect.desiredSha256 === undefined ? null : effect.desiredSha256, desiredState: effect.desiredState === undefined ? null : effect.desiredState,
    expectedVersion: effect.expectedVersion === undefined ? null : effect.expectedVersion, state: 'definitely-unsent', dispatchToken: null,
  };
}

// The record of `rec`'s attempt that already reached `rec`'s target — a state change of the same row to the same state —
// without this attempt sending it (fulfilled), or, with `confirmedToo`, by a send a read proved (confirmed).
function fulfilledTarget(env, rec, confirmedToo = false) {
  if (rec.effect !== 'state') return null;
  return env.workflowEffects.find((e) => e.attemptToken === rec.attemptToken && e.rowId === rec.rowId && e.effect === 'state'
    && e.desiredState === rec.desiredState && (e.state === 'fulfilled' || (confirmedToo && e.state === 'confirmed'))) || null;
}

// Turn the unsent state change `e` into the fulfilled fact a read made: checked whole before anything of `e` changes.
function fulfilInto(e, observedState, observedVersion) {
  if (!nonempty(observedState) || !nonempty(e.desiredState) || observedState !== e.desiredState) {
    throw storeError(CODES.notSettled, 'the observed workflow row is not in the state the change asks for');
  }
  if (!nonempty(observedVersion)) throw storeError(CODES.notSettled, 'a change found fulfilled needs the row version of the read that found it');
  e.state = 'fulfilled';
  e.dispatchToken = null;
  e.observedState = observedState;
  e.observedVersion = observedVersion;
}

/**
 * Does the attempt's own record prove that nothing it sent was carried out (lib/managed-feature-contract.js
 * recoverManagedAttempt, route 1)? Only with a send window, which markSending arms in the same write that marks it
 * sending and only for an observed send: no counted mutation is still possibly applied, no answer acknowledged a root or
 * a save, and every workflow effect it owns is still unsent with no dispatch token, or fulfilled by a read (it was never
 * sent either, and is never sent again). A `sending` phase alone is no such
 * proof, and neither is a later read that finds nothing: either may sit in front of a write still on its way. Pure: the
 * store applies it again to the record it rereads under the lease when a run claims the attempt (markSending `claim`).
 */
function attemptProvenUnsent(a, effects) {
  if (!a || a.phase !== 'sending' || !a.expected) return false;
  if (a.acknowledgedRoot || a.savedObservation !== null) return false;
  // An acknowledged dashboard create landed: it never continues, whatever the counts say. A dispatched one that was not
  // acknowledged is judged by the counts like any mutation (its dispatch was counted; only a not-started answer lowers it).
  if (a.dashboardCreate && a.dashboardCreate.acknowledged) return false;
  const w = a.sendWindow;
  if (!w || w.possible !== 0) return false;
  // A row or completion effect marked dispatched may have reached the service even when no generic counter moved.
  if (a.rowProtocol && (a.rowProtocol.rows.some((r) => r.dispatched) || a.rowProtocol.effects.some((e) => e.dispatched))) return false;
  return ownedEffects(a, effects).every((x) => (x.state === 'definitely-unsent' || x.state === 'fulfilled') && x.dispatchToken === null);
}

/**
 * What a read-only acceptance (commitReadOnlyGroupSet) is checked against, captured BEFORE the fresh read that proves
 * the rows: { token, generation, epoch, digest } of the attempt `token` in `envelope` — its group's generation (null
 * when none is committed), its send window epoch (null when it has none) and the sha256 of the attempt, its group and
 * every workflow effect it owns, so any write to any of them between the capture and the acceptance refuses it.
 * Answers null when the envelope holds no such attempt.
 */
function readOnlyCapture(envelope, token) {
  const a = envelope && Array.isArray(envelope.attempts) ? envelope.attempts.find((x) => x.token === token) : null;
  if (!a) return null;
  const group = envelope.groups.find((g) => g.family === a.family && g.key === a.key) || null;
  const effects = (envelope.workflowEffects || []).filter((e) => e.attemptToken === token);
  return {
    token, generation: group ? group.generation : null, epoch: a.sendWindow ? a.sendWindow.epoch : null,
    digest: sha256(canonicalJson({ attempt: a, group, effects })),
  };
}

/**
 * May the attempt be resumed as a create (runManagedFeature's `resumeCreate`)? Only when its record says it was a create
 * of a new root and that no answer ever acknowledged it: no committed group and no base generation, an expected proof
 * with no base, phase `sending` with no acknowledgement or saved observation, and every workflow effect it owns a create
 * still definitely-unsent. A body or state effect, or one that may have been dispatched, is never resumed.
 */
function resumableCreate(group, a, effects) {
  if (group || !a || a.baseGeneration !== null) return false;
  const e = a.expected;
  if (!e || e.baseProofSha256 !== null || e.baseObservation !== null) return false;
  if (a.phase !== 'sending' || a.acknowledgedRoot || a.savedObservation !== null) return false;
  return ownedEffects(a, effects).every((x) => x.effect === 'create' && x.state === 'definitely-unsent' && x.dispatchToken === null);
}

/**
 * Did an answer acknowledge that this attempt CREATED its root (noteSaved `acknowledgedRoot`, kept on the attempt and on
 * its saved observation)? Only a create can. An attempt whose expected proof, persisted before the send, records a base
 * observation (the live row it read before it changed it) edited an existing row, and no answer to that edit makes the
 * row its creation: it was adopted, and binding it needs the adoption approval. noteSaved refuses the flag on such an
 * attempt; this is the same rule for a record an older build wrote. A base PROOF alone is not the sign: a create that
 * re-makes a committed group's vanished root under its stable id carries the committed proof as its base.
 */
function rootCreateAcknowledged(a) {
  if (!a || !a.expected || a.expected.baseObservation !== null) return false;
  if (a.acknowledgedRoot || (a.savedObservation && a.savedObservation.acknowledgedRoot)) return true;
  return dashboardCreateAcknowledged(a);
}

/**
 * Did the observed transport durably receipt a successful answer to this attempt's own dashboard create
 * (noteDashboardCreateAnswer), under the attempt's current send epoch? A receipt is about the exact POST of the root it
 * names, on an attempt that creates a new root; it says the row was created, never what it holds now.
 */
function dashboardCreateAcknowledged(a) {
  const d = a && a.dashboardCreate;
  if (!isObj(d) || a.family !== 'dashboard' || d.acknowledged !== true || d.dispatchToken === null) return false;
  if (a.baseGeneration !== null || !a.expected || a.expected.baseObservation !== null || a.expected.baseProofSha256 !== null) return false;
  return d.rootId === a.root.id && !!a.sendWindow && a.sendWindow.epoch === d.sendEpoch;
}

/**
 * May the attempt take the early-receipt absence branch (runManagedFeature: a dashboard create whose answer was receipted,
 * read absent by its id in both layers, then sent again under the same root)? Only a receipted create of a new root that
 * nothing has committed or saved yet, with no owned workflow effect still open. Unlike resumableCreate it admits the
 * create's own counted send: the receipt says it landed, and the absence read says the row is gone since.
 */
function dashboardCreateResumable(group, a, effects) {
  if (group || !a || a.phase !== 'sending' || a.savedObservation !== null || a.acknowledgedRoot) return false;
  if (!dashboardCreateAcknowledged(a)) return false;
  return ownedEffects(a, effects).every((x) => x.state === 'confirmed' || x.state === 'fulfilled');
}

// What an early-receipt absence read was made against (observeDashboardCreateResume, then markSending `resumeObservation`):
// the group, the attempt and its key's workflow effects, as for a retirement (retirementObservation).
const DASHBOARD_CREATE_RESUME = /^dashboard-create-resume-v1:[0-9a-f]{64}$/;
function dashboardCreateResumeObservation(env, family, key) {
  const group = env.groups.find((x) => x.family === family && x.key === key) || null;
  const attempt = env.attempts.find((x) => x.family === family && x.key === key) || null;
  const effects = env.workflowEffects.filter((e) => e.family === family && e.key === key);
  return `dashboard-create-resume-v1:${sha256(canonicalJson({ family, key, group, attempt, effects }))}`;
}

// The child-create receipt of an attempt: [{ kind, key, id }], each a child its expected proof named under that same
// id, never the root, never twice.
// The identity a child receipt compares row ids by: a GUID in any of its spellings (`{MAIN}`, upper case) is the one
// row normalizeGuid names, so a braced root id is still the root; any other id (an opaque control or cell name) keeps
// the case-insensitive exact comparison it always had.
const rowIdKey = (id) => normalizeGuid(id) || String(id).toLowerCase();
function validateChildReceipt(list, a, where) {
  if (!Array.isArray(list)) throw invalid(where, 'is not a list');
  const seen = new Set();
  const rootId = rowIdKey(a.root.id);
  list.forEach((c, i) => {
    const w = `${where}[${i}]`;
    closedKeys(c, CHILD_RECEIPT_KEYS, w);
    if (!nonempty(c.kind) || !nonempty(c.key) || !nonempty(c.id)) throw invalid(w, 'is incomplete');
    const id = rowIdKey(c.id);
    if ((c.kind === a.root.kind && c.key === a.root.key) || id === rootId) throw invalid(w, 'names the root, which only a root create acknowledges');
    if (!a.expected.children.some((x) => x.kind === c.kind && x.key === c.key && rowIdKey(x.id) === id)) throw invalid(w, 'is a child the expected proof does not name under that id');
    const k = `${c.kind}\u0000${c.key}`;
    if (seen.has(k) || seen.has(id)) throw invalid(w, 'repeats a child');
    seen.add(k);
    seen.add(id);
  });
}

// ---------------------------------------------------------------------------------------------
// The row protocol of the configuration families (ROW_FAMILIES). An attempt of one of them carries, besides the
// common expected proof, one closed record of every physical row it creates or edits, written BEFORE anything is sent:
//   rowProtocol: {
//     version: 1,
//     rows: [{ kind, key, id, parentId, mode: 'create' | 'update', expectedSha256, sensitiveInput,
//              sentFields: null | ['<field>', ...], sentSha256: null | '<sha256>', dispatched }],
//     preserved: [],                                       // foreign rows a command bar keeps; none for configuration
//     completion: { ruleState: null | 'published' | 'unpublished', members: [{ kind, id, componentType }] },
//     effects: [{ kind: 'membership' | 'rule-state', id, dispatched }],
//     cohort: null,
//   }
// `expectedSha256` is the semantic row the plan expects (never a private value or its digest; `sensitiveInput` only
// says the row carries one). `sentFields`/`sentSha256` are the non-private projection of the request that actually
// left, sealed with `dispatched: true` under the lease before the transport is called (sealRowDispatch); a sealed row
// is never sealed again, so a second request for it is refused unsent. `completion.ruleState` is the rule state the
// ORIGINAL plan wanted (a new rule's default included), so a retry never reinterprets it from the row as it now looks.
const ROW_PROTOCOL_KEYS = ['version', 'rows', 'preserved', 'completion', 'effects', 'cohort'];
const ROW_KEYS = ['kind', 'key', 'id', 'parentId', 'mode', 'expectedSha256', 'sensitiveInput', 'sentFields', 'sentSha256', 'dispatched'];
const ROW_COMPLETION_KEYS = ['ruleState', 'members'];
const ROW_MEMBER_KEYS = ['kind', 'id', 'componentType'];
const ROW_EFFECT_KEYS = ['kind', 'id', 'dispatched'];
const ROW_CONSUMER_ROW_KEYS = ['kind', 'key', 'id', 'parentId', 'projectionSha256', 'sensitiveInput'];
const ROW_EFFECT_KINDS = new Set(['membership', 'rule-state']);
const isRowFamily = (family) => ROW_FAMILIES.includes(family);
const rowKindAllowed = (family, kind) => kind === ROOT_KIND[family] || (ROW_CHILD_KINDS[family] || []).includes(kind);
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_@.]{0,127}$/;

function validateRowProtocol(p, a, where) {
  closedKeys(p, ROW_PROTOCOL_KEYS, where);
  if (p.version !== 1) throw invalid(where, 'has an unknown row protocol version');
  if (!Array.isArray(p.rows) || p.rows.length === 0) throw invalid(where, 'names no row');
  const keys = new Set();
  const ids = new Set();
  p.rows.forEach((r, i) => {
    const w = `${where}.rows[${i}]`;
    closedKeys(r, ROW_KEYS, w);
    for (const k of ROW_KEYS) if (!Object.prototype.hasOwnProperty.call(r, k)) throw invalid(w, `has no ${k}`);
    if (!rowKindAllowed(a.family, r.kind)) throw invalid(w, `is a ${r.kind} row, which a ${a.family} group does not hold`);
    if (!nonempty(r.key)) throw invalid(w, 'has no key');
    guidField(r.id, `${w}.id`);
    if (r.parentId !== null) guidField(r.parentId, `${w}.parentId`);
    if (r.mode !== 'create' && r.mode !== 'update') throw invalid(w, 'has an unknown mode');
    hashOrNull(r.expectedSha256, `${w}.expectedSha256`, false);
    if (typeof r.sensitiveInput !== 'boolean' || typeof r.dispatched !== 'boolean') throw invalid(w, 'has no sensitive-input or dispatched flag');
    if (r.sentFields === null) {
      if (r.sentSha256 !== null || r.dispatched) throw invalid(w, 'is dispatched without the request it sent');
    } else {
      if (!Array.isArray(r.sentFields) || !r.sentFields.every((f) => typeof f === 'string' && FIELD_NAME.test(f))) throw invalid(w, 'has unreadable sent fields');
      if (r.sentFields.some((f, j) => j > 0 && r.sentFields[j - 1] >= f)) throw invalid(w, 'has sent fields that are not sorted and unique');
      hashOrNull(r.sentSha256, `${w}.sentSha256`, false);
      if (!r.dispatched) throw invalid(w, 'keeps a sealed request it never dispatched');
    }
    if (a.phase === 'prepared' && r.dispatched) throw invalid(w, 'was dispatched before its attempt was marked sending');
    const k = `${r.kind}\u0000${r.key}`;
    if (keys.has(k) || ids.has(r.id)) throw invalid(w, 'repeats a row');
    keys.add(k);
    ids.add(r.id);
  });
  const root = p.rows.find((r) => r.kind === a.root.kind && r.key === a.root.key);
  if (!root || root.id !== a.root.id || root.parentId !== null) throw invalid(where, 'does not name the attempt\'s root as its top-level row');
  p.rows.forEach((r, i) => {
    if (r !== root && r.parentId !== root.id) throw invalid(`${where}.rows[${i}]`, 'is not a child of the attempt\'s root');
  });
  if (!Array.isArray(p.preserved) || p.preserved.length) throw invalid(where, 'preserves rows a configuration group never holds');
  closedKeys(p.completion, ROW_COMPLETION_KEYS, `${where}.completion`);
  if (p.completion.ruleState !== null && !(a.family === 'duplicateRule' && (p.completion.ruleState === 'published' || p.completion.ruleState === 'unpublished'))) {
    throw invalid(`${where}.completion`, 'has a rule state for something that is not a duplicate rule');
  }
  if (a.family === 'duplicateRule' && p.completion.ruleState === null) throw invalid(`${where}.completion`, 'has no rule state for a duplicate rule');
  if (!Array.isArray(p.completion.members)) throw invalid(`${where}.completion`, 'has no member list');
  const members = new Set();
  p.completion.members.forEach((m, i) => {
    const w = `${where}.completion.members[${i}]`;
    closedKeys(m, ROW_MEMBER_KEYS, w);
    guidField(m.id, `${w}.id`);
    if (!p.rows.some((r) => r.kind === m.kind && r.id === m.id)) throw invalid(w, 'is not a row of this attempt');
    if (!Number.isSafeInteger(m.componentType) || m.componentType <= 0) throw invalid(w, 'has no component type');
    if (members.has(m.id)) throw invalid(w, 'repeats a member');
    members.add(m.id);
  });
  if (!Array.isArray(p.effects)) throw invalid(where, 'has no effect list');
  const effects = new Set();
  p.effects.forEach((e, i) => {
    const w = `${where}.effects[${i}]`;
    closedKeys(e, ROW_EFFECT_KEYS, w);
    if (!ROW_EFFECT_KINDS.has(e.kind)) throw invalid(w, 'has an unknown kind');
    guidField(e.id, `${w}.id`);
    if (typeof e.dispatched !== 'boolean') throw invalid(w, 'has no dispatched flag');
    if (a.phase === 'prepared' && e.dispatched) throw invalid(w, 'was dispatched before its attempt was marked sending');
    if (e.kind === 'membership' && !members.has(e.id)) throw invalid(w, 'adds a member the completion does not name');
    if (e.kind === 'rule-state' && (a.family !== 'duplicateRule' || e.id !== a.root.id)) throw invalid(w, 'changes the state of another row than its rule');
    const k = `${e.kind}\u0000${e.id}`;
    if (effects.has(k)) throw invalid(w, 'repeats an effect');
    effects.add(k);
  });
  // Configuration items are independent groups; only the command bar (not shipped by this store version) keeps cohorts.
  if (p.cohort !== null) throw invalid(where, 'names a cohort, which a configuration group never joins');
}

// What a committed configuration group keeps as consumer state: the last confirmed semantic baseline of each row,
//   { version: 1, rows: [{ kind, key, id, parentId, projectionSha256, sensitiveInput }] }
// It grants no ownership of its own (the records do) and never holds a value, a connection id or a digest of either.
function validateRowConsumer(state, family, records, where) {
  closedKeys(state, CONSUMER_KEYS[family], where);
  if (state.version !== 1) throw invalid(where, 'has an unknown version');
  if (!Array.isArray(state.rows)) throw invalid(where, 'has no rows');
  const seen = new Set();
  state.rows.forEach((r, i) => {
    const w = `${where}.rows[${i}]`;
    closedKeys(r, ROW_CONSUMER_ROW_KEYS, w);
    if (!rowKindAllowed(family, r.kind) || !nonempty(r.key)) throw invalid(w, 'is not a row of this family');
    guidField(r.id, `${w}.id`);
    if (r.parentId !== null) guidField(r.parentId, `${w}.parentId`);
    hashOrNull(r.projectionSha256, `${w}.projectionSha256`, false);
    if (typeof r.sensitiveInput !== 'boolean') throw invalid(w, 'has no sensitive-input flag');
    if (!records.some((rec) => rec.kind === r.kind && rec.key === r.key && rowIdKey(rec.id) === r.id)) throw invalid(w, 'is a row the group does not bind');
    const k = `${r.kind}\u0000${r.key}`;
    if (seen.has(k)) throw invalid(w, 'repeats a row');
    seen.add(k);
  });
}

// The version and vocabulary of a configuration unit, checked BEFORE its own validation and outside the catch that
// isolates one invalid unit (parseEnvelope). A known-format unit that is merely wrong (a field missing or mistyped, a
// hash that is not one) is isolated like any other; but a protocol, consumer, record or proof version this build does
// not know, a proof schema it does not know, or a field outside the closed vocabulary of the unit or of any closed shape
// nested in it (a root, a proof, a record and its create evidence, the consumer state and its rows, a publication and
// its scope, the expected proof, the saved observation, the send window, the completion reservation, the dashboard
// create receipt, the row protocol and its rows, completion and effects) is what a NEWER plugin writes. The open values
// (a saved observation's proof, a declaration, a record's partsSha256 map) have no closed vocabulary to check.
// Isolating such a unit would let this build write the rest of the file around a unit it cannot read, and a later
// write of its own would then carry that unit forward as this build understood it. So the whole store is refused
// (managed-binding-store-unreadable), on open, on refresh and on the reread inside every write, and no sibling unit
// (a form, a view) can be written either. Nothing is discarded: a compatible plugin reads the file as it was.
// Only numbers and strings are compared here: a version or schema of the wrong type is a malformed unit, not a newer one.
function checkRowExtensions(x, unit, where) {
  if (!isRowFamily(x.family)) return;
  const newer = (w, why) => invalid(w, `${why}: it was written by a newer plugin, so the whole store is refused`);
  const closed = (obj, allowed, w) => {
    if (!isObj(obj)) return;
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw newer(w, `has the unknown field "${k}"`);
  };
  const each = (list, allowed, w) => { if (Array.isArray(list)) list.forEach((v, i) => closed(v, allowed, `${w}[${i}]`)); };
  const version = (obj, field, w) => {
    if (isObj(obj) && typeof obj[field] === 'number' && obj[field] !== 1) throw newer(w, `has ${field} ${obj[field]}`);
  };
  const schema = (obj, w) => {
    if (isObj(obj) && typeof obj.proofSchema === 'string' && obj.proofSchema !== ROW_PROOF_SCHEMA) throw newer(w, `names the proof schema ${obj.proofSchema}`);
  };
  // A scope of a type this build knows is held to that type's vocabulary; a type it does not know is a malformed scope.
  // Only a string type is looked up: a persisted type is untrusted, and using any other value as a property key would
  // coerce it (an object such as { "toString": null } throws a raw TypeError there, before the per-unit catch). A
  // missing or mistyped type is left to validateScope, which isolates the unit.
  const scope = (s, w) => {
    if (isObj(s) && typeof s.type === 'string' && Object.prototype.hasOwnProperty.call(SCOPE_KEYS, s.type)) closed(s, SCOPE_KEYS[s.type], w);
  };
  // A configuration family is never published, so its publication is null; one that is not is held to the vocabulary
  // anyway, because a field this build does not know there is still what a newer plugin writes.
  const publication = (pub, w, keys) => {
    if (!isObj(pub)) return;
    closed(pub, keys, w);
    scope(pub.scope, `${w}.scope`);
    if (isObj(pub.carriedFrom)) closed(pub.carriedFrom, CARRIED_FROM_KEYS, `${w}.carriedFrom`);
  };
  if (unit === 'group') {
    closed(x, GROUP_KEYS, where);
    schema(x, where);
    closed(x.root, ROOT_KEYS, `${where}.root`);
    closed(x.proof, PROOF_KEYS, `${where}.proof`);
    each(x.records, RECORD_KEYS, `${where}.records`);
    if (Array.isArray(x.records)) {
      x.records.forEach((r, i) => {
        version(r, 'formatVersion', `${where}.records[${i}]`);
        if (isObj(r)) {
          closed(r.localCreateDraft, LOCAL_CREATE_DRAFT_KEYS, `${where}.records[${i}].localCreateDraft`);
          version(r.localCreateDraft, 'formatVersion', `${where}.records[${i}].localCreateDraft`);
        }
      });
    }
    closed(x.consumerState, CONSUMER_KEYS[x.family], `${where}.consumerState`);
    version(x.consumerState, 'version', `${where}.consumerState`);
    if (isObj(x.consumerState)) each(x.consumerState.rows, ROW_CONSUMER_ROW_KEYS, `${where}.consumerState.rows`);
    publication(x.publication, `${where}.publication`, PUBLICATION_KEYS);
    return;
  }
  closed(x, ATTEMPT_KEYS, where);
  closed(x.root, ROOT_KEYS, `${where}.root`);
  if (Array.isArray(x.knownScopes)) x.knownScopes.forEach((s, i) => scope(s, `${where}.knownScopes[${i}]`));
  closed(x.sendWindow, SEND_WINDOW_KEYS, `${where}.sendWindow`);
  closed(x.completionReserve, COMPLETION_RESERVE_KEYS, `${where}.completionReserve`);
  closed(x.dashboardCreate, DASHBOARD_CREATE_KEYS, `${where}.dashboardCreate`);
  version(x.dashboardCreate, 'formatVersion', `${where}.dashboardCreate`);
  publication(x.publication, `${where}.publication`, ATTEMPT_PUBLICATION_KEYS);
  const exp = x.expected;
  closed(exp, EXPECTED_KEYS, `${where}.expected`);
  version(exp, 'proofVersion', `${where}.expected`);
  schema(exp, `${where}.expected`);
  if (isObj(exp)) {
    closed(exp.baseObservation, BASE_OBSERVATION_KEYS, `${where}.expected.baseObservation`);
    each(exp.children, EXPECTED_CHILD_KEYS, `${where}.expected.children`);
  }
  closed(x.savedObservation, SAVED_OBSERVATION_KEYS, `${where}.savedObservation`);
  each(x.acknowledgedChildCreates, CHILD_RECEIPT_KEYS, `${where}.acknowledgedChildCreates`);
  const p = x.rowProtocol;
  closed(p, ROW_PROTOCOL_KEYS, `${where}.rowProtocol`);
  version(p, 'version', `${where}.rowProtocol`);
  if (isObj(p)) {
    each(p.rows, ROW_KEYS, `${where}.rowProtocol.rows`);
    each(p.effects, ROW_EFFECT_KEYS, `${where}.rowProtocol.effects`);
    closed(p.completion, ROW_COMPLETION_KEYS, `${where}.rowProtocol.completion`);
    if (isObj(p.completion)) each(p.completion.members, ROW_MEMBER_KEYS, `${where}.rowProtocol.completion.members`);
  }
}

// The frozen workflow mutation shapes (lib/workflow-effect-context.js classifies requests into them), with the method
// each is sent with and the effects it may carry.
const REQUEST_SHAPES = Object.freeze({
  'rule-create': Object.freeze({ method: 'POST', effects: Object.freeze(['create']) }),
  'rule-update': Object.freeze({ method: 'POST', effects: Object.freeze(['body']) }),
  'bpf-create': Object.freeze({ method: 'POST', effects: Object.freeze(['create']) }),
  'workflow-patch': Object.freeze({ method: 'PATCH', effects: Object.freeze(['body', 'state']) }),
});

function validateEffect(e, where) {
  closedKeys(e, ['token', 'attemptToken', 'baseGeneration', 'family', 'key', 'rowId', 'effect', 'request', 'desiredSha256', 'desiredState', 'expectedVersion', 'state', 'dispatchToken', 'observedState', 'observedVersion'], where);
  tokenField(e.token, `${where}.token`);
  tokenField(e.attemptToken, `${where}.attemptToken`);
  tokenField(e.baseGeneration, `${where}.baseGeneration`, true);
  if (e.family !== 'rule' && e.family !== 'bpf') throw invalid(where, 'is not a workflow family');
  if (!nonempty(e.key)) throw invalid(where, 'has no key');
  guidField(e.rowId, `${where}.rowId`);
  if (!EFFECTS.has(e.effect)) throw invalid(where, 'has an unknown effect');
  closedKeys(e.request, ['method', 'shape'], `${where}.request`);
  const shape = REQUEST_SHAPES[e.request.shape];
  if (!shape || shape.method !== e.request.method || !shape.effects.includes(e.effect)) throw invalid(`${where}.request`, 'is not a supported request shape for this effect');
  if ((e.request.shape === 'rule-create' || e.request.shape === 'rule-update') && e.family !== 'rule') throw invalid(`${where}.request`, 'is a rule request for another family');
  if (e.request.shape === 'bpf-create' && e.family !== 'bpf') throw invalid(`${where}.request`, 'is a process-flow request for another family');
  // A create or body effect is identified by the body it sends; a state effect by the state it asks for, and only that.
  if (e.effect === 'state') {
    if (e.desiredSha256 !== null) throw invalid(where, 'is a state effect with a body hash');
    if (!nonempty(e.desiredState)) throw invalid(where, 'is a state effect without a desired state');
  } else {
    hashOrNull(e.desiredSha256, `${where}.desiredSha256`, false);
    if (e.desiredState !== null) throw invalid(where, 'sets a desired state on a body or create effect');
  }
  // A create has no prior row, so it has no version to send; an edit of an existing row may carry one.
  if (e.effect === 'create' && e.expectedVersion !== null) throw invalid(where, 'is a create with a row version');
  if (e.expectedVersion !== null && !nonempty(e.expectedVersion)) throw invalid(where, 'has an empty row version');
  if (!EFFECT_STATES.has(e.state)) throw invalid(where, 'has an unknown state');
  if (e.state === 'definitely-unsent' || e.state === 'fulfilled') { if (e.dispatchToken !== null) throw invalid(where, 'carries a dispatch token it never sent'); } else tokenField(e.dispatchToken, `${where}.dispatchToken`);
  // Only a fulfilled effect records the read that fulfilled it: the state it found (the one the effect asks for) and the
  // row version that read answered. Every other record keeps the shape it always had, without the two keys.
  if (e.state === 'fulfilled') {
    if (e.effect !== 'state') throw invalid(where, 'is fulfilled by a read but is not a state change');
    if (!nonempty(e.observedState) || e.observedState !== e.desiredState) throw invalid(where, 'is fulfilled by a read that did not find its desired state');
    if (!nonempty(e.observedVersion)) throw invalid(where, 'is fulfilled by a read with no row version');
  } else if (e.observedState !== undefined || e.observedVersion !== undefined) {
    throw invalid(where, 'records a fulfilling read but is not fulfilled');
  }
}

/**
 * Parse and validate the text of a store file. Returns { envelope, invalidGroups: Map(groupId -> message) }.
 * Throws `managed-binding-store-unreadable` for anything wrong outside one group.
 */
// The maker's recorded acceptance of an unproved publication (acceptUncertainPublication): which dispatch, of which
// scope, under which typed approval, and the groups it released. Kept as an audit trail, newest last, at most
// RISK_ACCEPTANCES_KEPT; it grants nothing by itself.
const RISK_ACCEPTANCES_KEPT = 32;
// The typed approval names the scope AND the one dispatch it was printed for, e.g.
//   publication-risk:table:new_ticket/0f8fad5b-d9cb-469f-a165-70867728950e
//   publication-risk:dashboard:00000000-0000-0000-0000-000000000000/0f8fad5b-d9cb-469f-a165-70867728950e
// A scope alone cannot tell a decision about one lost publish from a decision about the next one of the same scope, so a key
// copied from an earlier stop must never release a later dispatch: the dispatch is part of what the maker approves.
// '/' splits them: a table name and a dashboard id never hold one, and a dispatch token is a UUID.
const publicationRiskApproval = (scope, dispatchToken) => `publication-risk:${scopeKey(scope)}/${dispatchToken}`;
// The way out of an unconfirmed publish, named wherever one blocks a change: a fresh read that shows a layer the publish
// changed settles it on its own (confirmUncertainPublication); when none can (the publish carried only layers that
// were already live), the maker checks what is live and accepts the risk with that dispatch's typed approval.
const publicationRemedy = (scope, dispatchToken) => `it settles when a fresh read shows a layer that publish changed; if none can, check what is live on ${scopeKey(scope)} and accept the risk of dispatch ${dispatchToken} with the approval "${publicationRiskApproval(scope, dispatchToken)}" (acceptUncertainPublication)`;
// The fields every refusal over an unconfirmed publish carries, so a caller offers the maker that dispatch's decision
// from data, never by parsing a token out of the message: the blocked dispatch, its own typed approval
// (acceptUncertainPublication takes both) and the remedy text.
const blockedPublication = (scope, dispatchToken) => ({ dispatchToken, approval: publicationRiskApproval(scope, dispatchToken), remedy: publicationRemedy(scope, dispatchToken) });
function validateRiskAcceptances(list, where) {
  if (!Array.isArray(list) || list.length > RISK_ACCEPTANCES_KEPT) throw invalid(where, `is not a list of at most ${RISK_ACCEPTANCES_KEPT} acceptances`);
  list.forEach((x, i) => {
    const w = `${where}[${i}]`;
    closedKeys(x, ['scope', 'dispatchToken', 'approval', 'groups'], w);
    validateScope(x.scope, `${w}.scope`);
    tokenField(x.dispatchToken, `${w}.dispatchToken`);
    if (x.approval !== publicationRiskApproval(x.scope, x.dispatchToken)) throw invalid(w, 'does not carry the approval for its scope and dispatch');
    if (!Array.isArray(x.groups) || !x.groups.length) throw invalid(w, 'names no group');
    x.groups.forEach((g, j) => {
      closedKeys(g, ['family', 'key', 'generation'], `${w}.groups[${j}]`);
      if (!FAMILIES.includes(g.family) || !nonempty(g.key)) throw invalid(`${w}.groups[${j}]`, 'has no family and key');
      tokenField(g.generation, `${w}.groups[${j}].generation`);
    });
  });
}

// The audit of groups retired because their root was proved gone (retireAbsentGroup): which group, at which
// generation (null for a group never committed), bound to which root, with the publication state it was retired in,
// the pending workflow attempt retired with it (its token, phase and each effect's kind and state: a `state` effect still
// `definitely-unsent` says the row was never activated by it), and when. It records that the root was proved absent
// and the group retired: NOT that its content was published, its debt paid or its activation made
// (`publication: 'owed'` says the debt was dropped unpaid, with nothing left to publish). Newest last, at most
// RETIRED_GROUPS_KEPT; it grants nothing by itself. A build that predates it reads the key as unexpected and refuses the
// whole file (fail closed).
const RETIRED_GROUPS_KEPT = 32;
const RETIRABLE_PUBLICATIONS = new Set(['owed', 'not-needed', 'confirmed']);
// The families whose every write to their root is a journaled workflow effect (recordWorkflowEffect, marked dispatching
// before it leaves): only their pending attempt can be shown, from its own record, to have nothing still on its way.
// The other families push through the SDK, whose writes no record names one by one.
const WORKFLOW_FAMILIES = new Set(['rule', 'bpf']);
// The effect states of a retired attempt: nothing in them can still land (a dispatching or unconfirmed one can).
const SETTLED_EFFECT_STATES = new Set(['definitely-unsent', 'confirmed', 'fulfilled']);
const RETIRED_EFFECTS_KEPT = 16;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function validateRetiredGroups(list, where) {
  if (!Array.isArray(list) || list.length > RETIRED_GROUPS_KEPT) throw invalid(where, `is not a list of at most ${RETIRED_GROUPS_KEPT} retired groups`);
  list.forEach((x, i) => {
    const w = `${where}[${i}]`;
    closedKeys(x, ['family', 'key', 'generation', 'rootId', 'reason', 'publication', 'attempt', 'at'], w);
    if (!FAMILIES.includes(x.family) || !nonempty(x.key)) throw invalid(w, 'has no family and key');
    tokenField(x.generation, `${w}.generation`, true);
    guidField(x.rootId, `${w}.rootId`);
    if (x.reason !== 'root-absent') throw invalid(w, 'has an unknown reason');
    if (x.publication !== null && !RETIRABLE_PUBLICATIONS.has(x.publication)) throw invalid(w, 'names a publication no group is retired in');
    if (x.attempt !== null) {
      if (!WORKFLOW_FAMILIES.has(x.family)) throw invalid(`${w}.attempt`, 'is an attempt of a family whose attempts are never retired with their group');
      closedKeys(x.attempt, ['token', 'phase', 'effects'], `${w}.attempt`);
      tokenField(x.attempt.token, `${w}.attempt.token`);
      if (!PHASES.has(x.attempt.phase)) throw invalid(`${w}.attempt.phase`, 'is not a phase');
      if (!Array.isArray(x.attempt.effects) || x.attempt.effects.length > RETIRED_EFFECTS_KEPT) throw invalid(`${w}.attempt.effects`, 'is not a short list');
      x.attempt.effects.forEach((e, j) => {
        closedKeys(e, ['effect', 'state'], `${w}.attempt.effects[${j}]`);
        if (!EFFECTS.has(e.effect) || !SETTLED_EFFECT_STATES.has(e.state)) throw invalid(`${w}.attempt.effects[${j}]`, 'is not an effect that could no longer land');
      });
    } else if (x.generation === null) {
      throw invalid(w, 'retired neither a committed group nor an attempt');
    }
    if (typeof x.at !== 'string' || !ISO_INSTANT.test(x.at) || Number.isNaN(Date.parse(x.at))) throw invalid(w, 'has no time');
  });
}

// The create identity a key takes once its root was retired (retireAbsentGroup): { family, key, identity, rootId, after,
// epoch }, at most one per key and one per identity. The create catalog derives a declared key's root id from its spec
// alone (creates-identity.js stableCreateIdV1), so without this a key declared again after its root was proved gone would
// be created again under the very id that was just retired: a row the service deleted, and one a retained SDK workspace
// still holds a synced baseline for (its push of that id reads the missing row and stops the build).
//   rootId    a fresh random id written in the same lease-held write that retires the group, so every later run, retry
//             and recovery of that incarnation reads the same one (lib/creates-catalog.js createIntentCatalog
//             `incarnations`), and every child is derived under it.
//   identity  the first root this lineage retired. A root the declared path created is the catalog's stable id of its
//             declaration, so a declaration whose stable id is `identity` takes this incarnation even under another
//             authored key: two spellings the identity algorithm folds to one artifact (a case-only change of a rule or
//             flow name, an accent in a form name) can never fall back to the retired stable id. It is carried
//             unchanged by every later retirement of the lineage. A root that was adopted, not created, is not any
//             declaration's stable id, so nothing else ever selects it by identity.
//   after     the root retired last; prepareAttempt refuses it for the key.
//   epoch     1 at the first retirement, one more at each later one. A plan carries the epoch (and rootId) of the
//             incarnation it selected (prepareAttempt `incarnation`), and the store refuses it under the lease when the
//             lineage has moved on since, however many retirements later: never only the last retired id, never the
//             bounded retirement audit.
// An entry is replaced only by the next retirement of its lineage, never dropped. No entry's `rootId` is any entry's
// `after` or `identity` (a retired id), so an incarnation never names a row proved gone. A build that predates the key
// reads it as unexpected and refuses the whole file (fail closed); a file without it opens as it always did.
const INCARNATIONS_KEPT = 512;
function validateIncarnations(list, where) {
  if (!Array.isArray(list) || list.length > INCARNATIONS_KEPT) throw invalid(where, `is not a list of at most ${INCARNATIONS_KEPT} incarnations`);
  const keys = new Set();
  const identities = new Set();
  const roots = new Set();
  const retired = new Set();
  const ns = (x, id) => `${NAMESPACE[x.family]}\u0000${id}`;
  list.forEach((x, i) => {
    const w = `${where}[${i}]`;
    closedKeys(x, ['family', 'key', 'identity', 'rootId', 'after', 'epoch'], w);
    if (!FAMILIES.includes(x.family) || !nonempty(x.key)) throw invalid(w, 'has no family and key');
    guidField(x.identity, `${w}.identity`);
    guidField(x.rootId, `${w}.rootId`);
    guidField(x.after, `${w}.after`);
    if (!Number.isSafeInteger(x.epoch) || x.epoch < 1) throw invalid(w, 'has no epoch (a whole number from 1)');
    const id = groupId(x.family, x.key);
    if (keys.has(id)) throw invalid(w, 'repeats a key');
    keys.add(id);
    const identity = `${x.family}\u0000${x.identity}`;
    if (identities.has(identity)) throw invalid(w, 'repeats an identity');
    identities.add(identity);
    if (roots.has(ns(x, x.rootId))) throw invalid(w, `gives the ${NAMESPACE[x.family]} id ${x.rootId} to two keys`);
    roots.add(ns(x, x.rootId));
    retired.add(ns(x, x.after)).add(ns(x, x.identity));
  });
  list.forEach((x, i) => {
    if (retired.has(ns(x, x.rootId))) throw invalid(`${where}[${i}]`, 'takes a root that was retired');
  });
}

// The incarnation a declaration selects: its own key's first, else the one whose identity is the declaration's stable id
// (validateIncarnations `identity`). lib/creates-catalog.js incarnationIndex selects by the same rule, from the list
// incarnations() answers, so a plan and the store's check under the lease agree on which lineage a declaration is.
function incarnationOf(list, family, key, identity) {
  const all = Array.isArray(list) ? list : [];
  return all.find((x) => x.family === family && x.key === key)
    || (typeof identity === 'string' && identity ? all.find((x) => x.family === family && x.identity === identity) : undefined)
    || null;
}
// prepareAttempt `incarnation`: the plan's token, { identity: <a GUID or null>, epoch: <0 or more>, rootId: <a GUID, or
// null exactly when epoch is 0> }. A malformed one is refused with nothing written, never read as "no incarnation".
function checkIncarnationToken(t) {
  if (t === undefined) return;
  const guidOrNull = (v) => v === null || (typeof v === 'string' && normalizeGuid(v) === v);
  if (!isObj(t) || !guidOrNull(t.identity) || !Number.isSafeInteger(t.epoch) || t.epoch < 0 || !guidOrNull(t.rootId) || (t.epoch === 0) !== (t.rootId === null)) {
    throw storeError(CODES.notSettled, 'prepareAttempt `incarnation` needs { identity, epoch, rootId } as the create catalog derived it');
  }
}

// The caller's proof that a group's root row is gone (retireAbsentGroup). The store cannot read the service, so the
// caller must have proved it from a FRESH read, by exactly this id, that answered the missing-row 404 (Dataverse
// 0x80040217, "does not exist") in every layer the row has:
//   a family that publishes (form, dashboard, view, chart) has a saved and a published layer, and both must say so:
//     { kind: 'root-absent', rootId: '<guid>', saved: 'not-found', published: 'not-found' }
//     (for a systemform: readSystemFormRootPresence(client, id) === 'absent');
//   a workflow (rule, bpf) has one row, read by its id:
//     { kind: 'root-absent', rootId: '<guid>', row: 'not-found' }
// A missing published layer alone is NOT absence (a never-published row still has its saved layer), and neither is a
// 403, a timeout, an unreadable or malformed answer or a query that found nothing: only the typed shape of the
// family is accepted, never inferred.
function checkAbsenceEvidence(family, evidence, rootId) {
  const layered = PUBLISHING.has(family);
  const shape = layered ? "{ kind: 'root-absent', rootId, saved: 'not-found', published: 'not-found' }" : "{ kind: 'root-absent', rootId, row: 'not-found' }";
  const refuse = (why) => storeError(CODES.notSettled, `retiring a managed ${family} needs typed evidence that its root ${rootId} is gone (${shape}): ${why}`);
  if (!isObj(evidence)) throw refuse('none was given');
  const keys = Object.keys(evidence).sort().join(',');
  if (keys !== (layered ? 'kind,published,rootId,saved' : 'kind,rootId,row')) throw refuse(`it has the fields ${keys || 'none'}`);
  if (evidence.kind !== 'root-absent') throw refuse(`its kind is ${JSON.stringify(evidence.kind)}`);
  if (layered ? (evidence.saved !== 'not-found' || evidence.published !== 'not-found') : evidence.row !== 'not-found') {
    throw refuse(layered ? 'both the saved and the published layer must have answered not-found' : 'the row must have answered not-found');
  }
  if (typeof evidence.rootId !== 'string' || !normalizeGuid(evidence.rootId) || normalizeGuid(evidence.rootId) !== normalizeGuid(rootId)) throw refuse(`it is about ${JSON.stringify(evidence.rootId)}`);
}

// What a retirement's absence proof was read against (observeRetirement, then retireAbsentGroup): the group, its pending
// attempt (phase, acknowledgements, send window) and every workflow effect of the key, as one fingerprint. Any progress
// a cooperating managed writer makes on them changes it: an attempt prepared or marked sending, an effect recorded,
// dispatched or confirmed, a send counted, a root acknowledged, a publish marked, a commit. A sibling's write does not.
const RETIREMENT_OBSERVATION = /^retirement-v1:[0-9a-f]{64}$/;
function retirementObservation(env, family, key) {
  const group = env.groups.find((x) => x.family === family && x.key === key) || null;
  const attempt = env.attempts.find((x) => x.family === family && x.key === key) || null;
  const effects = env.workflowEffects.filter((e) => e.family === family && e.key === key);
  return `retirement-v1:${sha256(canonicalJson({ family, key, group, attempt, effects }))}`;
}

function parseEnvelope(text, expect) {
  let data;
  try {
    // JSON.parse accepts CRLF and LF alike; a BOM is the one prefix a Windows editor may add.
    data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (e) {
    throw storeError(CODES.unreadable, `the managed binding store is not valid JSON (${e.message})`);
  }
  closedKeys(data, ['schemaVersion', 'environmentFingerprint', 'appUniqueName', 'solutionUniqueName', 'revision', 'groups', 'attempts', 'workflowEffects', 'publicationRiskAcceptances', 'retiredGroups', 'incarnations'], 'the managed binding store');
  if (data.schemaVersion !== SCHEMA_VERSION && data.schemaVersion !== SCHEMA_VERSION_ROWS) throw invalid('the managed binding store', `has schema version ${data.schemaVersion}, not ${SCHEMA_VERSION} or ${SCHEMA_VERSION_ROWS}`);
  if (data.environmentFingerprint !== expect.environmentFingerprint || data.appUniqueName !== expect.appUniqueName || data.solutionUniqueName !== expect.solutionUniqueName) {
    throw invalid('the managed binding store', 'belongs to another environment, app or solution');
  }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw invalid('the managed binding store', 'has no revision');
  for (const list of ['groups', 'attempts', 'workflowEffects']) if (!Array.isArray(data[list])) throw invalid('the managed binding store', `has no ${list} list`);
  if (data.publicationRiskAcceptances !== undefined) validateRiskAcceptances(data.publicationRiskAcceptances, 'publicationRiskAcceptances');
  if (data.retiredGroups !== undefined) validateRetiredGroups(data.retiredGroups, 'retiredGroups');
  if (data.incarnations !== undefined) validateIncarnations(data.incarnations, 'incarnations');

  const header = { appUniqueName: data.appUniqueName, environmentFingerprint: data.environmentFingerprint };
  const invalidGroups = new Map();
  const identity = (x, where) => {
    if (!isObj(x) || !FAMILIES.includes(x.family) || !nonempty(x.key)) throw invalid(where, 'has no family and key');
    // A configuration family is a version-2 unit: a version-1 file holding one was not written by this store, and the
    // whole file is refused rather than read with a protocol its version does not promise.
    if (isRowFamily(x.family) && data.schemaVersion !== SCHEMA_VERSION_ROWS) throw invalid(where, `is a ${x.family} unit in a version ${data.schemaVersion} store`);
    return groupId(x.family, x.key);
  };
  const markInvalid = (id, e) => { if (!invalidGroups.has(id)) invalidGroups.set(id, e.message); };
  const groupIds = new Set();
  data.groups.forEach((g, i) => {
    const id = identity(g, `groups[${i}]`);
    if (groupIds.has(id)) throw invalid(`groups[${i}]`, 'repeats a group');
    groupIds.add(id);
    checkRowExtensions(g, 'group', `groups[${i}]`);
    try { validateGroup(g, header, `groups[${i}]`); } catch (e) { markInvalid(id, e); }
  });
  const attemptIds = new Set();
  const attemptTokens = new Map();
  data.attempts.forEach((a, i) => {
    const id = identity(a, `attempts[${i}]`);
    // One attempt per group: a second would mean two different intents both waiting to be proved.
    if (attemptIds.has(id)) throw invalid(`attempts[${i}]`, 'repeats an attempt for one group');
    attemptIds.add(id);
    checkRowExtensions(a, 'attempt', `attempts[${i}]`);
    try {
      validateAttempt(a, `attempts[${i}]`);
      if (attemptTokens.has(a.token)) throw invalid(`attempts[${i}]`, 'repeats an attempt token');
      attemptTokens.set(a.token, a);
      const committed = data.groups.find((g) => groupId(g.family, g.key) === id);
      if ((committed ? committed.generation : null) !== a.baseGeneration) throw invalid(`attempts[${i}]`, 'is based on a generation the group does not have');
    } catch (e) { markInvalid(id, e); }
  });
  const effectTokens = new Set();
  data.workflowEffects.forEach((e, i) => {
    const where = `workflowEffects[${i}]`;
    const id = identity(e, where);
    // Ownership is checked for the whole file, not one group: an effect whose owner does not resolve, whose generation
    // differs from its owner's, or whose token repeats could settle another row's outcome, so the store is unreadable.
    if (isObj(e) && effectTokens.has(e.token)) throw invalid(where, 'repeats an effect token');
    if (isObj(e)) effectTokens.add(e.token);
    const owner = isObj(e) ? attemptTokens.get(e.attemptToken) : null;
    if (!owner || owner.family !== e.family || owner.key !== e.key) throw invalid(where, 'names no pending attempt of its group');
    if (owner.baseGeneration !== e.baseGeneration) throw invalid(where, 'names another generation than its attempt');
    // An effect changes its own attempt's row and no other: an attempt for one workflow cannot carry, and later settle
    // or block, a write of another.
    if (!isObj(owner.root) || typeof e.rowId !== 'string' || e.rowId !== owner.root.id) throw invalid(where, 'changes another row than its attempt\'s root');
    try {
      validateEffect(e, where);
      // An edit of a row the store already binds is an existing-row edit, and must say which version it edits.
      const bound = data.groups.find((g) => groupId(g.family, g.key) === id);
      if (e.effect !== 'create' && bound && bound.root.id === e.rowId && e.expectedVersion === null) throw invalid(where, 'edits an existing row without its version');
    } catch (err) { markInvalid(id, err); }
  });
  // Two roots that are one physical row would let two groups claim it: refuse the whole file, since neither group can
  // be trusted over the other. Attempts count too (a pending create may already hold the id).
  const rootOwner = new Map();
  const claim = (x, where) => {
    if (!isObj(x.root) || typeof x.root.id !== 'string') return;
    const k = `${NAMESPACE[x.family]}\u0000${x.root.id.toLowerCase()}`;
    const owner = rootOwner.get(k);
    const id = groupId(x.family, x.key);
    if (owner && owner !== id) throw invalid(where, `binds the ${NAMESPACE[x.family]} row ${x.root.id} that another group binds`);
    rootOwner.set(k, id);
  };
  data.groups.forEach((g, i) => claim(g, `groups[${i}]`));
  data.attempts.forEach((a, i) => claim(a, `attempts[${i}]`));
  // The child rows of the configuration families, by their own table: a value, parameter, property or condition row
  // bound by two groups (or reserved by one group's attempt and bound by another) is refused for the whole file.
  const rowOwner = new Map();
  const claimRow = (x, kind, id, where) => {
    if (!isRowFamily(x.family) || !ROW_TABLE[kind] || typeof id !== 'string') return;
    const k = `${ROW_TABLE[kind]}\u0000${rowIdKey(id)}`;
    const owner = rowOwner.get(k);
    const gid = groupId(x.family, x.key);
    if (owner && owner !== gid) throw invalid(where, `binds the ${ROW_TABLE[kind]} row ${id} that another group binds`);
    rowOwner.set(k, gid);
  };
  data.groups.forEach((g, i) => { if (isObj(g) && Array.isArray(g.records)) g.records.forEach((r) => isObj(r) && claimRow(g, r.kind, r.id, `groups[${i}]`)); });
  data.attempts.forEach((a, i) => {
    if (isObj(a) && isObj(a.rowProtocol) && Array.isArray(a.rowProtocol.rows)) a.rowProtocol.rows.forEach((r) => isObj(r) && claimRow(a, r.kind, r.id, `attempts[${i}]`));
  });
  return { envelope: data, invalidGroups };
}

function storeFileName(fp, appUniqueName, solutionUniqueName) {
  return `${PREFIX}${sha256(JSON.stringify([fp, String(appUniqueName).toLowerCase(), String(solutionUniqueName).toLowerCase()]))}.json`;
}

function resolveContext({ workspaceDir, environment, appUniqueName, solutionUniqueName }) {
  if (!nonempty(appUniqueName) || !nonempty(solutionUniqueName)) throw storeError(CODES.notSettled, 'the managed binding store needs the app and solution unique names');
  const fp = environmentFingerprint(environment);
  const root = workspaceRoot(workspaceDir, false);
  const file = storeFileName(fp, appUniqueName, solutionUniqueName);
  return { fp, root, file, full: root ? path.join(root, file) : null, expect: { environmentFingerprint: fp, appUniqueName, solutionUniqueName } };
}

/** Read the store file: null when it is absent, the parsed state otherwise. Throws for anything unsafe or invalid. */
function readStoreFile(ctx) {
  if (!ctx.full) return null;
  let st;
  try { st = fs.lstatSync(ctx.full); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw storeError(CODES.unreadable, `the managed binding store ${ctx.file} could not be inspected (${e.code || e.message})`);
  }
  // The file is the authority for rows the build may change: it must be the file that was named, not a link to
  // another (a symbolic link, a junction) or one of several names of the same file (a hard link).
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) throw storeError(CODES.unreadable, `the managed binding store ${ctx.file} is not a plain file`);
  if (st.size > MAX_BYTES) throw storeError(CODES.unreadable, `the managed binding store ${ctx.file} is larger than ${MAX_BYTES} bytes`);
  let text;
  try { text = fs.readFileSync(ctx.full, 'utf8'); } catch (e) {
    throw storeError(CODES.unreadable, `the managed binding store ${ctx.file} could not be read (${e.code || e.message})`);
  }
  const parsed = parseEnvelope(text, ctx.expect);
  return { ...parsed, sha256: sha256(canonicalJson(parsed.envelope)), bytes: Buffer.byteLength(text, 'utf8') };
}

function emptyEnvelope(expect) {
  return { schemaVersion: SCHEMA_VERSION, ...expect, revision: 0, groups: [], attempts: [], workflowEffects: [] };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v); }
  return value;
}
const clone = (v) => JSON.parse(JSON.stringify(v));

function unitsOf(envelope, invalidGroups) {
  const units = new Map();
  const unit = (family, key) => {
    const id = groupId(family, key);
    if (!units.has(id)) units.set(id, { family, key, group: null, attempt: null, effects: [], invalid: invalidGroups.get(id) || null });
    return units.get(id);
  };
  for (const g of envelope.groups) unit(g.family, g.key).group = g;
  for (const a of envelope.attempts) unit(a.family, a.key).attempt = a;
  for (const e of envelope.workflowEffects) unit(e.family, e.key).effects.push(e);
  for (const id of invalidGroups.keys()) { const [family, key] = id.split('\u0000'); unit(family, key); }
  return [...units.values()];
}

function scopeKey(s) { return s.type === 'table' ? `table:${s.table}` : `dashboard:${s.id}`; }
function addScope(list, s) { if (s && !list.some((x) => scopeKey(x) === scopeKey(s))) list.push({ ...s }); }

/**
 * The one classification of a persisted group, used by the build's initializer and by the settlement wrapper alike.
 * Input: one unit of the store — { family, key, group, attempt, effects, invalid } (see `units` of a snapshot).
 * Result: { kind, targets: { scopes, ids }, token? } where `kind` is
 *   'corrupt'   the group failed validation: its overlap is withheld for this invocation;
 *   'uncertain' a publication or workflow effect may have been sent (dispatching/unconfirmed): withheld until a fresh
 *               proof confirms it without sending; `token` is the dispatch token;
 *   'hold'      an attempt is pending: withheld under the attempt's token until that attempt is proved and committed;
 *   'eligible'  a committed group owes a publication that was definitely not sent: no hold, one scoped publish allowed;
 *   'settled'   a committed group with nothing owed: no hold, no publish.
 * Healthy records install nothing, and eligible debt never gets a synthetic hold that nothing could release.
 */
function classifyPersisted(unit) {
  const scopes = [];
  const ids = [];
  const pushId = (id) => { if (typeof id === 'string' && !ids.includes(id.toLowerCase())) ids.push(id.toLowerCase()); };
  const { group, attempt, effects = [] } = unit || {};
  if (isObj(group)) {
    if (isObj(group.publication) && isObj(group.publication.scope)) addScope(scopes, group.publication.scope);
    if (isObj(group.root)) pushId(group.root.id);
  }
  if (isObj(attempt)) {
    for (const s of Array.isArray(attempt.knownScopes) ? attempt.knownScopes : []) if (isObj(s)) addScope(scopes, s);
    if (isObj(attempt.publication) && isObj(attempt.publication.scope)) addScope(scopes, attempt.publication.scope);
    if (isObj(attempt.root)) pushId(attempt.root.id);
  }
  for (const e of effects) if (isObj(e)) pushId(e.rowId);
  if (unit && unit.family === 'dashboard') for (const id of ids) addScope(scopes, { type: 'dashboard', id });
  const targets = { scopes, ids };
  if (unit && unit.invalid) return { kind: 'corrupt', targets };
  const uncertainEffect = effects.find((e) => UNCERTAIN.has(e.state));
  if (uncertainEffect) return { kind: 'uncertain', targets, token: uncertainEffect.dispatchToken };
  if (group && group.publication && UNCERTAIN.has(group.publication.state)) return { kind: 'uncertain', targets, token: group.publication.dispatchToken };
  if (attempt) return { kind: 'hold', targets, token: attempt.token };
  if (group && group.publication && group.publication.state === 'owed') return { kind: 'eligible', targets };
  return { kind: 'settled', targets };
}

function snapshotOf(state) {
  const envelope = deepFreeze(clone(state.envelope));
  const invalidGroups = new Map(state.invalidGroups);
  return Object.freeze({
    revision: envelope.revision,
    envelope,
    invalidGroups,
    units: () => unitsOf(envelope, invalidGroups),
  });
}

/**
 * Read-only discovery for a publishing or app-writing invocation. Never creates or changes the file.
 * Answers { absent: true } when there is no store, or { loaded: snapshot, debt: [{ family, key, ...classification }] }
 * listing every group that is not settled. Throws `managed-binding-store-unreadable` for a store it cannot trust.
 */
function discoverManagedStore(args) {
  const ctx = resolveContext(args);
  const state = readStoreFile(ctx);
  if (!state) return { absent: true };
  const loaded = snapshotOf(state);
  const debt = [];
  for (const unit of loaded.units()) {
    const c = classifyPersisted(unit);
    if (c.kind !== 'settled') debt.push({ family: unit.family, key: unit.key, ...c });
  }
  return { loaded, debt };
}

/**
 * Open the store of one environment, app and solution in a workspace. Nothing is created until the first write.
 * `barrier` (lib/publication-barrier.js) receives the scope registrations, holds and quarantines the handle forwards.
 * `deps`, for tests: `writeFileAtomic(path, text)` and `lease` (the record-lease.js deps).
 */
// Charge one write's growth to SEVERAL attempts' reservations (a set mutation: mutate's `spend` named more than one).
// Each participant first pays its own positive growth — the bytes of its attempt as this write leaves it against the
// bytes it had on disk, its reservation left out so the charge does not chase itself. What the file grew by beyond
// those (the envelope's own fields, indentation, the digits the charges add) is then given out in the order the
// participants were named, each up to what is left of its reservation, and the text is settled again until the charges
// stop changing. An attempt the change never named is never charged: its reservation is for its own completion.
// A participant with no reservation (an attempt an older build prepared) pays nothing, as with one spender.
// Answers the text to write.
function chargeParticipants(next, was, tokens, prevBytes, text) {
  const sized = (a) => {
    if (!a) return 0;
    const { completionReserve, ...rest } = a;
    return Buffer.byteLength(JSON.stringify(rest, null, 2), 'utf8');
  };
  const parts = tokens.map((t) => next.attempts.find((a) => a.token === t)).filter((a) => a && a.completionReserve);
  const start = parts.map((a) => a.completionReserve.used);
  const self = parts.map((a, i) => {
    const before = sized(was.attempts.find((x) => x.token === a.token));
    return Math.min(a.completionReserve.bytes - start[i], Math.max(0, sized(a) - before));
  });
  const selfTotal = self.reduce((s, n) => s + n, 0);
  let out = text;
  for (let pass = 0; pass < 8; pass += 1) {
    let residual = Math.max(0, Buffer.byteLength(out, 'utf8') - prevBytes - selfTotal);
    let changed = false;
    parts.forEach((a, i) => {
      const base = start[i] + self[i];
      const take = Math.min(a.completionReserve.bytes - base, residual);
      residual -= take;
      if (a.completionReserve.used !== base + take) {
        a.completionReserve.used = base + take;
        changed = true;
      }
    });
    if (!changed) break;
    out = `${JSON.stringify(next, null, 2)}\n`;
  }
  return out;
}

function openManagedBindings({ workspaceDir, environment, appUniqueName, solutionUniqueName, barrier = null, deps = {} }) {
  const ctx = resolveContext({ workspaceDir, environment, appUniqueName, solutionUniqueName });
  const write = typeof deps.writeFileAtomic === 'function' ? deps.writeFileAtomic : writeFileAtomic;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  let state = readStoreFile(ctx) || { envelope: emptyEnvelope(ctx.expect), invalidGroups: new Map(), sha256: null };

  const unitOf = (st, family, key) => unitsOf(st.envelope, st.invalidGroups).find((u) => u.family === family && u.key === key)
    || { family, key, group: null, attempt: null, effects: [], invalid: null };
  const usable = (unit) => {
    if (unit.invalid) throw storeError(CODES.groupInvalid, `the managed group ${unit.family} "${unit.key}" is not usable: ${unit.invalid}`);
    return unit;
  };
  const needBarrier = () => {
    if (!barrier) throw storeError(CODES.notSettled, 'the managed binding store was opened without the publication barrier');
    return barrier;
  };

  // One change: take the lease, reread the disk, apply `change` to a copy, write, reread and compare.
  // `admit: true`: the write is a new obligation, written before its send (prepareAttempt, markPublishDispatch):
  // it must leave PREPARE_RESERVE_BYTES free beyond every pending attempt's unused reservation, its own included.
  // `change(next, disk, spend, admitHere)`: a write made for an attempt after its send calls `spend(token)` to charge
  // what it adds to that attempt's own reservation (see COMPLETION_BASE_BYTES); a change that acquires or enlarges a
  // reservation (markSending) calls `admitHere()`, and is then admitted exactly as `admit: true`: the new reservation
  // and the shared reserve must both fit beside every other one.
  function mutate(change, { admit = false } = {}) {
    const root = workspaceRoot(workspaceDir, true);
    const full = path.join(root, ctx.file);
    // A workspace created after the store was opened: later reads (refresh) must look at the file this write makes.
    ctx.root = root;
    ctx.full = full;
    const lease = withRecordLease(root, ctx.file, () => {
      const disk = readStoreFile({ ...ctx, root, full }) || { envelope: emptyEnvelope(ctx.expect), invalidGroups: new Map() };
      const next = clone(disk.envelope);
      // Every attempt the change spent for, in the order it first said so. A set mutation (markAttemptSetSending, a
      // seal for several rows) names more than one, and each of them must pay for what it adds.
      const spenders = [];
      let admitNow = false;
      const answer = change(next, disk, (token) => { if (!spenders.includes(token)) spenders.push(token); }, () => { admitNow = true; });
      if (answer && typeof answer.then === 'function') throw storeError(CODES.notSettled, 'a managed binding change must be synchronous');
      next.revision = disk.envelope.revision + 1;
      // The first configuration-family unit upgrades the file to version 2 in this same write; a version-2 file stays 2,
      // and a version-1 file written only for the original families stays 1, byte for byte what an older build writes.
      const rowUnits = next.groups.some((g) => isRowFamily(g.family)) || next.attempts.some((a) => isRowFamily(a.family));
      next.schemaVersion = disk.envelope.schemaVersion === SCHEMA_VERSION_ROWS || rowUnits ? SCHEMA_VERSION_ROWS : SCHEMA_VERSION;
      const prevBytes = typeof disk.bytes === 'number' ? disk.bytes : 0;
      let text = `${JSON.stringify(next, null, 2)}\n`;
      // Charge the growth to the spending attempt's reservation. Recording the charge changes the text by a few digits,
      // so it is settled again until the size is stable (two or three passes; the base reservation covers the digits).
      const admitting = admit === true || admitNow;
      const own = spenders.length === 1 ? findAttempt(next, spenders[0]) : null;
      if (own && own.completionReserve && !admitting) {
        const start = own.completionReserve.used;
        for (let pass = 0; pass < 4; pass += 1) {
          const grown = Buffer.byteLength(text, 'utf8') - prevBytes;
          const used = Math.min(own.completionReserve.bytes, start + Math.max(0, grown));
          if (used === own.completionReserve.used && pass > 0) break;
          own.completionReserve.used = used;
          text = `${JSON.stringify(next, null, 2)}\n`;
        }
      } else if (spenders.length > 1 && !admitting) {
        text = chargeParticipants(next, disk.envelope, spenders, prevBytes, text);
      }
      // A file larger than any open reads back (readStoreFile: MAX_BYTES) would be written, then refused by every later
      // run, the attempt it records with it: refuse the change instead, before the disk is touched. A write that does
      // not grow the file can take no one's bytes. A growing one must leave every pending attempt's unused reservation
      // free, so each attempt already sent can still complete; a new obligation must also leave the shared reserve.
      const bytes = Buffer.byteLength(text, 'utf8');
      const fail = (detail) => storeError(CODES.storeFull, `the managed binding store would be ${bytes} bytes${detail}; it may hold ${MAX_BYTES}. Nothing was written${admitting ? ', and nothing was sent for it' : ''}: keep fewer or smaller declared groups in this app and solution, or settle the pending ones first`);
      if (bytes > MAX_BYTES) throw fail('');
      if (admitting || bytes > prevBytes) {
        const held = next.attempts.reduce((sum, a) => sum + (a.completionReserve ? a.completionReserve.bytes - a.completionReserve.used : 0), 0);
        const shared = admitting ? PREPARE_RESERVE_BYTES : 0;
        if (bytes + held + shared > MAX_BYTES) throw fail(` with ${held} more held for the completion of pending attempts${shared ? ` and ${shared} kept free for a new attempt or publish` : ''}`);
      }
      // Validate in memory before anything touches the disk: an invalid group may stay as it was, never become one.
      const checked = parseEnvelope(text, ctx.expect);
      for (const id of checked.invalidGroups.keys()) {
        if (!disk.invalidGroups.has(id)) throw storeError(CODES.groupInvalid, `a managed binding change would make ${id.replace('\u0000', ' ')} invalid: ${checked.invalidGroups.get(id)}`);
      }
      const wanted = sha256(canonicalJson(checked.envelope));
      try { write(full, text); } catch (e) {
        throw storeError(CODES.writeFailed, `the managed binding store could not be written (${e.code || e.message})`, { cause: e });
      }
      // Reopen and compare: the atomic writer redacts token-shaped text, so a write that changed an authoritative
      // field is a failure, and so is a file this process cannot read back. Never conclude the old file is intact.
      let reread;
      try { reread = readStoreFile({ ...ctx, root, full }); } catch (e) {
        throw storeError(CODES.writeFailed, `the managed binding store did not reopen clean after the write (${e.message})`, { cause: e });
      }
      if (!reread || reread.sha256 !== wanted) throw storeError(CODES.writeFailed, 'the managed binding store did not read back what was written');
      return { reread, answer };
    }, deps.lease);
    if (!lease.ok) throw storeError(CODES.busy, `the managed binding store is busy: ${lease.reason}`);
    state = lease.value.reread;
    return lease.value.answer;
  }

  const findAttempt = (env, token) => env.attempts.find((a) => a.token === token);
  const requireAttempt = (env, disk, token) => {
    const a = findAttempt(env, token);
    if (!a) throw storeError(CODES.conflict, 'the managed attempt is no longer pending in the store');
    usable(unitOf(disk, a.family, a.key));
    return a;
  };
  // A workflow effect (`rec`, from effectRecord) must belong to its own pending attempt, at its generation, on its root.
  const checkEffectOwner = (env, disk, rec) => {
    const a = requireAttempt(env, disk, rec.attemptToken);
    if (a.family !== rec.family || a.key !== rec.key) throw storeError(CODES.notSettled, 'a workflow effect must belong to its own attempt');
    if (a.baseGeneration !== rec.baseGeneration) throw storeError(CODES.conflict, 'a workflow effect must name its attempt\'s generation');
    if (rec.rowId !== a.root.id) throw storeError(CODES.notSettled, `a workflow effect changes its attempt's own row ${a.root.id}, not ${rec.rowId}`);
    return a;
  };
  // The retire rules, inside a lease-held change (retireUnsentAttempt, and prepareAttempt `replaces`): the attempt must
  // still be based on `baseGeneration`, which must still be its group's generation, and must prove nothing of it
  // started. Removes the attempt and the effects it owns from `env`; answers how many effects went with it.
  const retireInto = (env, a, baseGeneration) => {
    if (a.baseGeneration !== baseGeneration) throw storeError(CODES.conflict, 'the managed attempt is based on another generation');
    const g = env.groups.find((x) => x.family === a.family && x.key === a.key);
    if ((g ? g.generation : null) !== baseGeneration) throw storeError(CODES.conflict, `the managed ${a.family} "${a.key}" changed since the attempt was prepared`);
    if (a.phase !== 'prepared' || a.expected !== null || a.acknowledgedRoot || a.savedObservation !== null) {
      throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" attempt may have been sent; it is recovered, never retired`);
    }
    const owned = env.workflowEffects.filter((e) => e.attemptToken === a.token);
    // Only effects still unsent let the attempt go. A fulfilled one never left either, but it is the record that its
    // target was reached: it settles only with the attempt's commit, so retiring the attempt would drop it and let a
    // later attempt send that change again.
    if (owned.some((e) => e.state !== 'definitely-unsent' || e.dispatchToken !== null)) {
      throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" attempt has a workflow effect that may have been sent, or a change a read found already made; it is never retired`);
    }
    env.attempts = env.attempts.filter((x) => x !== a);
    env.workflowEffects = env.workflowEffects.filter((e) => e.attemptToken !== a.token);
    return owned.length;
  };

  // A sending attempt of a configuration family, at the window epoch the caller claimed (sealRowDispatch, markRowEffectDispatch).
  const sendingRowAttempt = (env, disk, token, epoch) => {
    const a = requireAttempt(env, disk, token);
    if (!isRowFamily(a.family) || !a.rowProtocol) throw storeError(CODES.requestMismatch, 'the request names an attempt that keeps no row protocol');
    if (a.phase !== 'sending' || !a.expected) throw storeError(CODES.requestMismatch, `the managed ${a.family} "${a.key}" attempt is not sending; nothing is sent under it`);
    if (a.sendWindow && epoch !== undefined && epoch !== null && a.sendWindow.epoch !== epoch) throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" attempt was claimed by another run since this send began; the request is not sent`);
    return a;
  };

  // A commit proposal (commitGroup, commitGroupSet) is checked whole before anything else: a list that repeats a
  // (kind, key) or an id must be refused, not folded into a map where the last record silently wins, and a proof must
  // carry every field it promises.
  function checkCommitProposal({ records, proof, adoptionApprovedChildren } = {}) {
    try {
      if (!Array.isArray(records)) throw invalid('the proposed records', 'is not a list');
      const keys = new Set();
      const ids = new Set();
      records.forEach((rec, i) => {
        const where = `the proposed records[${i}]`;
        validateRecord(rec, ctx.expect, where);
        const k = `${rec.kind}\u0000${rec.key}`;
        if (keys.has(k)) throw invalid(where, `repeats ${rec.kind} "${rec.key}"`);
        keys.add(k);
        const id = rec.id.toLowerCase();
        if (id !== NOTES_CONTROL && ids.has(id)) throw invalid(where, `repeats the id ${rec.id}`);
        ids.add(id);
      });
      validateProof(proof, 'the proposed proof');
      if (adoptionApprovedChildren !== undefined) {
        if (!Array.isArray(adoptionApprovedChildren)) throw invalid('the approved child adoptions', 'is not a list');
        adoptionApprovedChildren.forEach((c, i) => {
          closedKeys(c, ['kind', 'key', 'id'], `the approved child adoptions[${i}]`);
          if (!nonempty(c.kind) || !nonempty(c.key) || !nonempty(c.id)) throw invalid(`the approved child adoptions[${i}]`, 'is incomplete');
        });
      }
    } catch (e) {
      throw storeError(CODES.groupInvalid, `a managed group commit was refused before it was written: ${e.message}`);
    }
  }

  // The commit of one attempt inside a lease-held change (see commitGroup): answers the committed group.
  // For a configuration family (ROW_FAMILIES) every NEW record proves its own origin: a root `created` needs this
  // attempt's acknowledged root create, a root `adopted` the root's exact `adoptionApproved`; a child `created` needs
  // its OWN child-create receipt (an acknowledged root never stands in for it), a child `adopted` an exact
  // { kind, key, id } entry of `adoptionApprovedChildren`. A parent's approval or acknowledgement never mints a child.
  function commitInto(env, disk, { token, baseGeneration, records, proof, consumerState, publication = null, proofSchema, adoptionApproved = false, adoptionApprovedChildren = [] }) {
    const a = requireAttempt(env, disk, token);
    if (a.baseGeneration !== baseGeneration) throw storeError(CODES.conflict, 'the managed attempt is based on another generation');
    if (!a.expected) throw storeError(CODES.notSettled, 'an attempt that was never sent has nothing to commit');
    const rowFamily = isRowFamily(a.family);
    const effects = env.workflowEffects.filter((e) => e.attemptToken === token);
    // Every workflow effect this attempt owns retires in this same write, so none must still be open: an effect
    // that may have reached the server must be proved first, and one never sent must be sent and proved, or found
    // fulfilled by a read (fulfillEffect). The refusal leaves the attempt and its effects as they are, and no other
    // attempt's effects are read or touched.
    if (effects.some((e) => e.state !== 'confirmed' && e.state !== 'fulfilled')) throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" has a workflow effect that is not confirmed`);
    const old = env.groups.find((g) => g.family === a.family && g.key === a.key) || null;
    // A publish of the old generation that may have been sent is settled first (a read-only confirmation, or it stays
    // blocked). Carried over a new generation, a later read of the OLD layer would confirm the NEW group and drop
    // the new generation's own debt; the new debt is never folded into the old dispatch either.
    if (old && old.publication && UNCERTAIN.has(old.publication.state)) {
      throw storeError(CODES.publicationUncertain, `the managed ${a.family} "${a.key}" has a publish that may have been sent and is not proved live; a new generation is committed only after it is confirmed`, blockedPublication(old.publication.scope, old.publication.dispatchToken));
    }
    const acknowledged = rootCreateAcknowledged(a);
    const receipt = a.acknowledgedChildCreates || [];
    // Strictly `true`: a truthy flag computed carelessly ('yes', 1) must not stand in for the maker's approval.
    if (!old && !acknowledged && adoptionApproved !== true) {
      throw storeError(CODES.adoptionRequired, `the managed ${a.family} "${a.key}" root was never acknowledged as created; binding it needs its adoption approval`);
    }
    // The create evidence of a dashboard root is the store's to mint and keep, never a caller's to propose: a record
    // read back from the group and handed in again may carry it, but only exactly as the store keeps it on that root
    // in this commit (checked below); it is set from the store's own, never from the caller's.
    const echoedMarkers = [];
    const proposed = (records || []).map((rec) => {
      if (rec.localCreateDraft === undefined) return rec;
      const { localCreateDraft, ...rest } = rec;
      echoedMarkers.push({ kind: rec.kind, key: rec.key, marker: localCreateDraft });
      return rest;
    });
    const merged = [];
    const byKey = new Map();
    for (const rec of proposed) byKey.set(`${rec.kind}\u0000${rec.key}`, rec);
    for (const rec of old ? old.records : []) {
      const k = `${rec.kind}\u0000${rec.key}`;
      const next = byKey.get(k);
      if (!next) { merged.push(rec); continue; }
      if (String(next.id).toLowerCase() !== String(rec.id).toLowerCase()) {
        throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" would bind ${rec.kind} "${rec.key}" to another row than it holds`);
      }
      // A configuration record keeps the origin it was first bound with, whatever the proposal says.
      merged.push({ ...next, origin: rowFamily || rec.origin === 'adopted' ? rec.origin : next.origin });
      byKey.delete(k);
    }
    for (const rec of byKey.values()) {
      // A new record claims `created` only on this attempt's acknowledged root create, or, for a child, on this
      // attempt's child-create receipt naming that same (kind, key, id); a lost answer needs adoption. A receipt
      // never covers the root.
      const isRoot = rec.kind === a.root.kind && rec.key === a.root.key;
      const receipted = !isRoot && rowIdKey(rec.id) !== rowIdKey(a.root.id)
        && receipt.some((c) => c.kind === rec.kind && c.key === rec.key && rowIdKey(c.id) === rowIdKey(rec.id));
      if (rec.origin === 'created' && !acknowledged && !receipted) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" cannot record ${rec.kind} "${rec.key}" as created without an acknowledged create`);
      if (rowFamily) {
        if (isRoot && rec.origin === 'adopted' && adoptionApproved !== true) throw storeError(CODES.adoptionRequired, `the managed ${a.family} "${a.key}" root is recorded adopted without its adoption approval`);
        if (isRoot && rec.origin === 'created' && !acknowledged) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" root was never acknowledged as created`);
        if (!isRoot && rec.origin === 'created' && !receipted) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" cannot record ${rec.kind} "${rec.key}" as created without its own child-create receipt`);
        if (!isRoot && rec.origin === 'adopted' && !adoptionApprovedChildren.some((c) => c.kind === rec.kind && c.key === rec.key && rowIdKey(c.id) === rowIdKey(rec.id))) {
          throw storeError(CODES.adoptionRequired, `the managed ${a.family} "${a.key}" ${rec.kind} "${rec.key}" is recorded adopted without its own adoption approval`);
        }
      }
      // A child the group did not hold before is bound only when the expected proof, persisted before the send,
      // named it under that id: an observation cannot add a binding the attempt never said it would make.
      const planned = isRoot || a.expected.children.some((c) => c.kind === rec.kind && c.key === rec.key && String(c.id).toLowerCase() === String(rec.id).toLowerCase());
      if (!planned) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" would bind ${rec.kind} "${rec.key}", which its expected proof does not name`);
      merged.push(rec);
    }
    const rootRec = merged.find((r) => r.kind === a.root.kind && r.key === a.root.key);
    if (!rootRec || String(rootRec.id).toLowerCase() !== a.root.id) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" root was not observed under its expected id`);
    // The created dashboard root's create evidence: minted from this attempt's acknowledged receipt, or kept from
    // the generation before for the same root. Never carried to another root, and gone with a retired group.
    const oldRoot = old ? old.records.find((r) => r.kind === a.root.kind && r.key === a.root.key) : null;
    let marker = null;
    if (oldRoot && oldRoot.localCreateDraft && String(oldRoot.id).toLowerCase() === a.root.id) marker = clone(oldRoot.localCreateDraft);
    else if (!old && dashboardCreateAcknowledged(a)) {
      const d = a.dashboardCreate;
      marker = { formatVersion: 1, rootId: a.root.id, attemptToken: a.token, draftSha256: d.draftSha256, bodySha256: d.bodySha256 };
    }
    const kept = marker && rootRec.origin === 'created' ? marker : null;
    if (kept) merged[merged.indexOf(rootRec)] = { ...rootRec, localCreateDraft: kept };
    for (const e of echoedMarkers) {
      if (!(kept && e.kind === a.root.kind && e.key === a.root.key && canonicalJson(e.marker) === canonicalJson(kept))) {
        throw storeError(CODES.groupInvalid, `a managed group commit was refused before it was written: the proposed ${e.kind} "${e.key}" carries create evidence only the store records`);
      }
    }
    for (const child of a.expected.children) {
      const got = merged.find((r) => r.kind === child.kind && r.key === child.key);
      if (!got || String(got.id).toLowerCase() !== String(child.id).toLowerCase()) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" lacks the expected ${child.kind} "${child.key}"`);
    }
    // The original declaration is the attempt's own, recorded before it sent, and nothing the caller passes here can
    // replace it; the feature's consumer state is kept exactly as proved. A generation whose attempt recorded none
    // keeps none: an older generation's original never describes this one.
    const committed = {
      family: a.family, key: a.key, generation: newToken(), previousGeneration: old ? old.generation : null,
      root: a.root, proofSchema: proofSchema || a.expected.proofSchema, records: merged, proof, consumerState,
      ...(a.declaration !== undefined ? { originalDeclaration: clone(a.declaration) } : {}), publication,
    };
    env.groups = env.groups.filter((g) => g !== old);
    env.groups.push(committed);
    env.attempts = env.attempts.filter((x) => x !== a);
    env.workflowEffects = env.workflowEffects.filter((e) => e.attemptToken !== token);
    return committed;
  }

  const handle = {
    get file() { return ctx.full; },
    snapshot() { return snapshotOf(state); },
    /**
     * The create identity each retired lineage takes when it is declared again (see validateIncarnations), as the file
     * was last read or written by this handle: [{ family, key, identity, rootId, epoch }]. Hand it to the create catalog
     * (creates-catalog.js createIntentCatalog `incarnations`), and the token the catalog derives from it to prepareAttempt
     * (`incarnation`): a plan made from a stale copy cannot reuse a retired id, since prepareAttempt rereads the file
     * under the lease and refuses it.
     */
    incarnations() {
      const list = Array.isArray(state.envelope.incarnations) ? state.envelope.incarnations : [];
      return list.map(({ family, key, identity, rootId, epoch }) => ({ family, key, identity, rootId, epoch }));
    },
    /** Re-read the file (another process may have changed it). */
    refresh() {
      state = readStoreFile(ctx) || { envelope: emptyEnvelope(ctx.expect), invalidGroups: new Map(), sha256: null };
      return snapshotOf(state);
    },
    lookup(kind, key) {
      // Which group a record belongs to is the caller's business: any group that holds (kind, key) answers, but only
      // when that group has no pending attempt — an older root must not authorize a plan past an interrupted change.
      for (const unit of unitsOf(state.envelope, state.invalidGroups)) {
        const rec = unit.group && !unit.invalid ? unit.group.records.find((r) => r.kind === kind && r.key === key) : null;
        const isRoot = unit.attempt && unit.attempt.root.kind === kind && unit.attempt.root.key === key;
        if (!rec && !isRoot && !(unit.invalid && unit.key === key)) continue;
        usable(unit);
        if (unit.attempt) throw storeError(CODES.pending, `the managed ${unit.family} "${unit.key}" has an attempt that must be proved first`);
        if (rec) return clone(rec);
      }
      return null;
    },
    readGroup(family, key) {
      const unit = usable(unitOf(state, family, key));
      return { committed: unit.group ? clone(unit.group) : null, pending: unit.attempt ? clone(unit.attempt) : null, effects: clone(unit.effects) };
    },
    /**
     * Persist an attempt's intent before anything is sent. `declaration`: optional, for the families whose group keeps
     * one (form, dashboard, rule, bpf) — the ORIGINAL declaration the attempt was planned from, as a plain JSON object.
     * It is checked first (checkDeclaration), so an unsafe one is `managed-declaration-refused` with nothing written
     * and nothing sent; its plain-data snapshot is kept with the attempt and becomes the group's `originalDeclaration`
     * at commit (commitGroup). A group whose publish may have been sent and is not proved live (dispatching /
     * unconfirmed), read here under the lease, is `managed-publication-unconfirmed`: an attempt is never prepared over
     * it, whatever the caller read before.
     * `replaces: { token, baseGeneration }`: the group's prepared attempt this one takes the place of. In the same
     * lease-held write that adds the new attempt, the old one is retired by the rules of retireUnsentAttempt (it must
     * prove nothing of it started) together with the effects it owns; any refusal — the new declaration, a conflict,
     * an uncertain publish, an old attempt that may have been sent — writes nothing, so the old attempt, its token and
     * its hold all stay. The old hold ends only after the write (when the store has the barrier).
     * `completionBytes`: optional, the bytes the feature's completion may add after the send (its consumer state, saved
     * proof and workflow effects). The attempt reserves the larger of it and COMPLETION_BASE_BYTES plus one copy of its
     * declaration until its commit or retirement; a minimum above COMPLETION_MAX_BYTES is refused, never clamped. The
     * write is refused
     * (`managed-binding-store-full`, nothing written, nothing sent) unless it leaves PREPARE_RESERVE_BYTES free beyond
     * every pending attempt's unused reservation, this one's included.
     * A `root` whose id is the one this key was retired from (its incarnation's `after`, see validateIncarnations) is
     * `managed-binding-generation-conflict`, nothing written: a retired root is never prepared again under its key.
     * `incarnation: { identity, epoch, rootId }`: optional, the incarnation the plan was made for, as the create catalog
     * derived it (creates-catalog.js entry `incarnation`; epoch 0 and rootId null when it selected none). Under the lease
     * the store selects the incarnation the same way (incarnationOf) from the file as it is now, and from the file as this
     * handle last read it; when either differs in epoch or rootId the plan was made for an earlier incarnation, and it is
     * `managed-binding-generation-conflict`, nothing written, however many retirements ago that was. Without it the
     * handle's own last read is the plan's (selected by key only).
     */
    prepareAttempt({ family, key, baseGeneration = null, revision, root, expected = null, knownScopes = [], declarationSha256, declaration, publication = null, replaces, completionBytes, incarnation }) {
      const kept = declaration !== undefined ? checkDeclaration(family, key, declaration) : undefined;
      checkCompletionBytes(completionBytes, 'prepareAttempt `completionBytes`');
      checkIncarnationToken(incarnation);
      const completionReserve = { bytes: completionReserveFor(kept, completionBytes, `the managed ${family} "${key}"`), used: 0 };
      if (replaces !== undefined && (!isObj(replaces) || typeof replaces.token !== 'string' || !replaces.token || replaces.baseGeneration === undefined)) {
        throw storeError(CODES.notSettled, 'prepareAttempt `replaces` needs the old attempt token and the generation it was based on');
      }
      const token = newToken();
      mutate((env, disk) => {
        if (revision !== undefined && revision !== disk.envelope.revision) throw storeError(CODES.conflict, `the managed binding store changed since the plan was made (revision ${disk.envelope.revision}, plan ${revision})`);
        const unit = usable(unitOf(disk, family, key));
        if (replaces) {
          const old = requireAttempt(env, disk, replaces.token);
          if (old.family !== family || old.key !== key) throw storeError(CODES.conflict, 'the attempt to replace belongs to another group');
          retireInto(env, old, replaces.baseGeneration);
        } else if (unit.attempt) throw storeError(CODES.pending, `the managed ${family} "${key}" already has a pending attempt`);
        if ((unit.group ? unit.group.generation : null) !== baseGeneration) throw storeError(CODES.conflict, `the managed ${family} "${key}" changed since the plan was made`);
        // A root this key retired (retireAbsentGroup) is never taken again by it, whatever the plan read before: its
        // next create uses the key's incarnation, written in the same change that retired the old root.
        const reborn = (env.incarnations || []).find((x) => x.family === family && x.key === key);
        if (reborn && isObj(root) && normalizeGuid(root.id) === reborn.after) {
          throw storeError(CODES.conflict, `the managed ${family} "${key}" was retired from the root ${reborn.after}; declared again it is created under ${reborn.rootId}, never under the retired root. Nothing was written or sent: run the build again`);
        }
        // The epoch fence: the incarnation the plan was made for must still be the one the file selects now. Comparing
        // only the last retired id (`after` above) would let a plan two retirements old through, and the retirement
        // audit is bounded; the epoch only grows, so every earlier incarnation differs from the current one.
        const identity = incarnation ? incarnation.identity : null;
        const current = incarnationOf(env.incarnations, family, key, identity);
        const plans = [incarnationOf(state.envelope.incarnations, family, key, identity)];
        if (incarnation) plans.push(incarnation.epoch ? incarnation : null);
        const at = (x) => (x ? `epoch ${x.epoch} (root ${x.rootId})` : 'no incarnation');
        for (const plan of plans) {
          if ((plan ? plan.epoch : 0) !== (current ? current.epoch : 0) || (plan ? plan.rootId : null) !== (current ? current.rootId : null)) {
            throw storeError(CODES.conflict, `the managed ${family} "${key}" was planned for ${at(plan)} of its create identity, and it is now at ${at(current)}: a root retired since the plan was made is never prepared again. Nothing was written or sent: run the build again`);
          }
        }
        // Under the lease, against the file as it is now: markPublishDispatch refuses a group with an attempt, and this
        // refuses an attempt over a dispatched publish, so the two never stand together.
        if (unit.group && unit.group.publication && UNCERTAIN.has(unit.group.publication.state)) {
          throw storeError(CODES.publicationUncertain, `the managed ${family} "${key}" has a publish that may have been sent and is not proved live; no change is prepared over it until a fresh read confirms it`, blockedPublication(unit.group.publication.scope, unit.group.publication.dispatchToken));
        }
        env.attempts.push({
          family, key, token, baseGeneration, phase: expected ? 'sending' : 'prepared', root, knownScopes, declarationSha256,
          ...(kept !== undefined ? { declaration: kept } : {}), expected,
          acknowledgedRoot: false, savedObservation: null, publication, completionReserve,
        });
      }, { admit: true });
      // Durable and read back: only now may the replaced attempt's own hold end.
      if (replaces && barrier) barrier.release(replaces.token);
      return token;
    },
    /**
     * Persist the complete expected proof before the push. A failure here means the push is not sent. `observed`: the
     * caller sends this attempt's mutations through a send observer (createAttemptSendObserver), so the same write that
     * marks a prepared attempt sending arms its send window at zero, epoch 1. Only then: an attempt already sending keeps
     * the window it has, or none — a send that was not observed is never shown unsent afterwards.
     * `claim` makes this write the run's claim on the attempt's sends, checked against the record reread under the lease
     * (never against what the run read before its awaited steps):
     *   'first'     the attempt must still be `prepared`: a second run on the same prepared attempt is refused;
     *   'continue'  the attempt must still prove nothing it sent was carried out (attemptProvenUnsent: a window at zero,
     *               no acknowledgement or saved observation, its effects unsent) and the caller must observe its sends;
     *   'resume'    the attempt must still be a create no answer acknowledged (resumableCreate);
     * otherwise `managed-settlement-pending`, nothing written. Any mark, claimed or not, over a group whose publish may
     * have been sent and is not proved live is `managed-publication-unconfirmed` (carrying blockedPublication's fields), nothing written. 'continue' and 'resume' move the window to a new epoch, so
     * a dispatch counted under the old one — a run that read the same zero earlier, or a retry of an older run — is
     * refused unsent (noteAttemptDispatch). A claim takes over a zero window rather than waiting for an earlier claimant:
     * a run that died between its claim and its first send would otherwise strand the attempt, and the epoch already
     * stops that claimant at its next send. Answers { epoch }: the window's epoch, or null with no window.
     * `completionBytes`: the plan's estimate, as for prepareAttempt (checkCompletionBytes). This write is the last before
     * any new send under the attempt, on every path (a first send, a reused prepared attempt, 'continue', 'resume'), so
     * it is where the reservation is made adequate: an attempt that holds none (prepared by an older build), or less
     * than its declaration's minimum or the plan's estimate, acquires or enlarges it here, admitted under the lease as
     * a new obligation (every other reservation and the shared reserve kept free). A refusal (`managed-binding-store-full`)
     * writes nothing and comes before the send: the attempt, its phase, window, token and hold stay as they were.
     */
    markSending(token, expected, { observed = false, claim, completionBytes, resumeObservation } = {}) {
      if (claim !== undefined && claim !== 'first' && claim !== 'continue' && claim !== 'resume') throw storeError(CODES.notSettled, `markSending cannot claim an attempt to "${claim}"`);
      if (resumeObservation !== undefined && (claim !== 'resume' || typeof resumeObservation !== 'string' || !DASHBOARD_CREATE_RESUME.test(resumeObservation))) {
        throw storeError(CODES.notSettled, 'markSending takes resumeObservation only with claim "resume", as observeDashboardCreateResume answered it');
      }
      checkCompletionBytes(completionBytes, 'markSending `completionBytes`');
      let epoch = null;
      // Written before the send, with the expected proof, so a refusal here comes before the send. An attempt whose
      // reservation is already adequate spends it, so content written since its prepare cannot strand it unsent.
      mutate((env, disk, spend, admitHere) => {
        const a = requireAttempt(env, disk, token);
        // Taken before anything below changes `env`: the observation is of the file as it was reread under the lease.
        const observedNow = resumeObservation !== undefined ? dashboardCreateResumeObservation(env, a.family, a.key) : null;
        if (a.expected !== null && canonicalJson(a.expected) !== canonicalJson(expected)) {
          throw storeError(CODES.completion, 'a sent attempt keeps the expected proof it was sent with');
        }
        const group = env.groups.find((g) => g.family === a.family && g.key === a.key) || null;
        const name = `the managed ${a.family} "${a.key}"`;
        // Every claim, and a mark with none, is checked against the group's CURRENT publication, here under the lease: a
        // publish dispatched after the run read the group (while its preflight, resolve or plan was awaited) would put
        // this attempt's saved change live before it is proved. prepareAttempt makes the same check; this one also covers
        // an attempt an older store holds beside such a publish.
        if (group && group.publication && UNCERTAIN.has(group.publication.state)) {
          throw storeError(CODES.publicationUncertain, `${name} has a publish that may have been sent and is not proved live; nothing is sent under its attempt until a fresh read confirms it`, blockedPublication(group.publication.scope, group.publication.dispatchToken));
        }
        if (claim === 'first' && a.phase !== 'prepared') throw storeError(CODES.pending, `${name} attempt was marked sending by another run`);
        if (claim === 'continue' && !(observed === true && attemptProvenUnsent(a, env.workflowEffects))) throw storeError(CODES.pending, `${name} attempt no longer shows that nothing it sent was carried out; it is not sent again`);
        if (claim === 'resume' && resumeObservation !== undefined) {
          // The early-receipt branch: a receipted dashboard create read absent in both layers since `resumeObservation`.
          // Anything that moved since (a send counted, a receipt, a commit) may have put the row back after that read.
          if (!(observed === true && dashboardCreateResumable(group, a, env.workflowEffects))) throw storeError(CODES.pending, `${name} attempt is no longer a receipted create that may be sent again; it is not sent again`);
          if (observedNow !== resumeObservation) throw storeError(CODES.conflict, `${name} changed since its root was read absent; it is not sent again in this run`);
        } else if (claim === 'resume') {
          if (!resumableCreate(group, a, env.workflowEffects)) throw storeError(CODES.pending, `${name} attempt is no longer a create no answer acknowledged; it is not sent again`);
          // A receipted create is resumed only through its fenced branch above.
          if (dashboardCreateAcknowledged(a)) throw storeError(CODES.pending, `${name} create was acknowledged; it is sent again only after a fenced absence read`);
        }
        const need = completionReserveFor(a.declaration, completionBytes, name);
        if (!a.completionReserve || a.completionReserve.bytes < need) {
          a.completionReserve = { bytes: need, used: a.completionReserve ? a.completionReserve.used : 0 };
          admitHere();
        } else {
          spend(token);
        }
        a.expected = expected;
        if (a.phase === 'prepared') {
          a.phase = 'sending';
          if (observed === true) a.sendWindow = { possible: 0, notStarted: 0, epoch: 1 };
        } else if ((claim === 'continue' || claim === 'resume') && a.sendWindow) {
          a.sendWindow.epoch += 1;
          // The receipt follows the epoch in the same write: the new send has neither dispatched nor been answered, and
          // an answer to an older epoch's POST never acknowledges it. The root and the draft and body hashes stay.
          if (a.dashboardCreate) Object.assign(a.dashboardCreate, { sendEpoch: a.sendWindow.epoch, dispatchToken: null, acknowledged: false });
        }
        epoch = a.sendWindow ? a.sendWindow.epoch : null;
      });
      return { epoch };
    },
    /**
     * The send observer, synchronously before a mutation leaves the transport inside the attempt's window: count it as
     * possibly applied. A throw (the attempt is gone, the store cannot be written, or `epoch` is not the window's current
     * epoch because another run has claimed the attempt since) leaves the request unsent. An attempt with no window (sent
     * unobserved) is left as it is: nothing it could say would make it provable. A window opened without an epoch (a
     * direct caller; runManagedFeature always passes the one markSending answered) is counted but not fenced.
     */
    noteAttemptDispatch(token, epoch) {
      mutate((env, disk, spend) => {
        const a = requireAttempt(env, disk, token);
        spend(token);
        if (!a.sendWindow) return;
        if (epoch !== undefined && epoch !== null && a.sendWindow.epoch !== epoch) throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" attempt was claimed by another run since this send began; the request is not sent`);
        a.sendWindow.possible += 1;
      });
    },
    /**
     * The send observer, after the service answered one counted mutation with a rejection that says it was not carried
     * out (lib/managed-feature-contract.js notStartedAnswer), while the window that counted it was still open: move it
     * from possible to notStarted. Nothing else lowers `possible`, so a lost answer, a crash, an answer under another
     * epoch or a failed write here leaves the attempt possibly sent.
     */
    noteAttemptNotStarted(token, epoch) {
      mutate((env, disk, spend) => {
        const a = requireAttempt(env, disk, token);
        spend(token);
        if (!a.sendWindow || a.sendWindow.possible < 1) throw storeError(CODES.notSettled, 'the managed attempt has no counted send to answer');
        if (epoch !== undefined && epoch !== null && a.sendWindow.epoch !== epoch) throw storeError(CODES.pending, 'the managed attempt was claimed by another run since this send was counted; it stays possibly applied');
        a.sendWindow.possible -= 1;
        a.sendWindow.notStarted += 1;
      });
    },
    /**
     * Record, before the create POST of a new dashboard root leaves, what it sends (the receipt's immutable part):
     * `rootId`, `draftSha256` (the whole local artifact the build assembled, as canonical JSON) and `bodySha256` (the
     * create request body it produces), under the send epoch markSending answered. Only for an attempt marked sending
     * with an observed window at that epoch, creating a new root (no committed group, no base). A repeated call in the
     * same epoch must name the same root and hashes; an attempt whose receipt is kept never takes other ones.
     * Refusals write nothing: `managed-settlement-pending` (another epoch), `create-completion-required` (other hashes),
     * `managed-not-settled` (not such an attempt).
     */
    noteDashboardCreateDraft(token, { sendEpoch, rootId, draftSha256, bodySha256 } = {}) {
      const root = normalizeGuid(rootId);
      if (!root || !HEX64.test(String(draftSha256)) || !HEX64.test(String(bodySha256)) || !Number.isSafeInteger(sendEpoch) || sendEpoch < 1) {
        throw storeError(CODES.notSettled, 'noteDashboardCreateDraft needs the send epoch, the root id and the draft and body hashes');
      }
      mutate((env, disk, spend) => {
        const a = requireAttempt(env, disk, token);
        spend(token);
        const name = `the managed ${a.family} "${a.key}"`;
        const group = env.groups.find((g) => g.family === a.family && g.key === a.key) || null;
        if (a.family !== 'dashboard' || group || a.baseGeneration !== null || !a.expected || a.expected.baseProofSha256 !== null || a.expected.baseObservation !== null) {
          throw storeError(CODES.notSettled, `${name} is not a create of a new dashboard root; it keeps no create receipt`);
        }
        if (a.phase !== 'sending' || a.savedObservation !== null || !a.sendWindow) throw storeError(CODES.notSettled, `${name} is not being sent under an observed window`);
        if (a.sendWindow.epoch !== sendEpoch) throw storeError(CODES.pending, `${name} attempt was claimed by another run since this send began; nothing is sent`);
        if (root !== a.root.id) throw storeError(CODES.notSettled, `${name} creates ${a.root.id}, not ${root}`);
        const d = a.dashboardCreate;
        if (d) {
          if (d.sendEpoch !== sendEpoch || d.rootId !== root || d.draftSha256 !== draftSha256 || d.bodySha256 !== bodySha256) {
            throw storeError(CODES.completion, `${name} keeps the draft and body its create was sent with; another one is not sent under it`);
          }
          return;
        }
        a.dashboardCreate = { formatVersion: 1, rootId: root, sendEpoch, draftSha256, bodySha256, dispatchToken: null, acknowledged: false };
      });
    },
    /**
     * The observed transport, synchronously before the exact create POST of the receipt leaves (createAttemptSendObserver
     * withDashboardCreateReceipt): the receipt's dispatch token, minted once per epoch and kept by a retry of that same
     * POST. Answers { dispatchToken }. Grants no acknowledgement and lowers no count. A refusal leaves the POST unsent.
     */
    noteDashboardCreateDispatch(token, { sendEpoch, bodySha256 } = {}) {
      let dispatchToken = null;
      mutate((env, disk, spend) => {
        const a = requireAttempt(env, disk, token);
        spend(token);
        const d = a.dashboardCreate;
        if (!d) throw storeError(CODES.notSettled, `the managed ${a.family} "${a.key}" keeps no create receipt to dispatch`);
        if (!a.sendWindow || a.sendWindow.epoch !== sendEpoch || d.sendEpoch !== sendEpoch) throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" attempt was claimed by another run since this send began; the request is not sent`);
        if (d.bodySha256 !== bodySha256) throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" create body is not the one its receipt was recorded for; it is not sent`);
        if (d.dispatchToken === null) d.dispatchToken = newToken();
        dispatchToken = d.dispatchToken;
      });
      return { dispatchToken };
    },
    /**
     * The observed transport, after a successful answer to the exact POST it dispatched (`dispatchToken`), before the
     * answer is handed back: the receipt is acknowledged. Idempotent. It is not a save: no phase, saved observation,
     * group or hold changes. A refusal (another epoch, dispatch or body) acknowledges nothing.
     */
    noteDashboardCreateAnswer(token, { sendEpoch, dispatchToken, bodySha256 } = {}) {
      mutate((env, disk, spend) => {
        const a = requireAttempt(env, disk, token);
        spend(token);
        const d = a.dashboardCreate;
        if (!d || d.dispatchToken === null || d.dispatchToken !== dispatchToken) throw storeError(CODES.notSettled, `the managed ${a.family} "${a.key}" answer is not to the create its receipt dispatched`);
        if (!a.sendWindow || a.sendWindow.epoch !== sendEpoch || d.sendEpoch !== sendEpoch) throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" attempt was claimed by another run since this send began; its answer acknowledges nothing`);
        if (d.bodySha256 !== bodySha256) throw storeError(CODES.notSettled, `the managed ${a.family} "${a.key}" answer is to another create body`);
        d.acknowledged = true;
      });
    },
    /**
     * Before the early-receipt branch reads its root by id in both layers: rereads the file and answers { observation },
     * a fingerprint of the group, the attempt and the key's workflow effects. Hand it to markSending (`claim: 'resume'`,
     * `resumeObservation`), which refuses when anything changed since. As for observeRetirement: never observe again to
     * get past a refusal in the same invocation. Writes nothing.
     */
    observeDashboardCreateResume({ family, key } = {}) {
      if (family !== 'dashboard' || !nonempty(key)) throw storeError(CODES.notSettled, 'observeDashboardCreateResume needs a dashboard key');
      handle.refresh();
      const unit = usable(unitOf(state, family, key));
      if (!unit.attempt) throw storeError(CODES.notSettled, `the managed ${family} "${key}" has no attempt to resume`);
      return { observation: dashboardCreateResumeObservation(state.envelope, family, key) };
    },
    /**
     * Record what an acknowledged answer to this attempt's send proved, under its token, before anything else uses it:
     *   proof                     the saved observation (feature-owned plain data);
     *   acknowledgedRoot          true only when the answer acknowledged that this attempt CREATED its root. An answer
     *                             to an EDIT never does: an attempt whose expected proof records a base observation (an
     *                             existing row it read) is refused (`managed-not-settled`), nothing written;
     *   acknowledgedChildCreates  [{ kind, key, id }] the child-create receipt: children this attempt reserved as NEW,
     *                             sent, and proved after this acknowledged write. Each must be a child the expected proof
     *                             (persisted before the send) names under that id, never the root; anything else is
     *                             `create-completion-required`, nothing written. Receipts are kept for the attempt's
     *                             life (a later call adds, never forgets), so a recovery reads them from the original
     *                             attempt, never from a later run's spec. A receipt lets commitGroup record exactly those
     *                             children `origin: 'created'`; it never acknowledges the root, never stands in for the
     *                             root's adoption approval, never turns a child the group already holds into a creation,
     *                             and grants no deletion.
     *   epoch                     optional: the send window epoch the caller's answer came under; another epoch (the
     *                             attempt was claimed by another run since) is `managed-settlement-pending`, nothing written.
     * A configuration attempt's ROOT RECEIPT alone — { proof: null, acknowledgedRoot: true, phase: 'sending', epoch } —
     * is written the moment a checked save acknowledged the root create, before any read-back or membership request:
     * it sets only the acknowledgement, and the attempt stays `sending` (no saved observation), so its remaining
     * requests can still be sent under it. It needs the current epoch and a root the row protocol prepared as a create.
     */
    noteSaved(token, { proof, acknowledgedRoot = false, acknowledgedChildCreates = [], phase = 'saved', epoch } = {}) {
      const rootReceipt = phase === 'sending';
      if (rootReceipt && !(proof === null && acknowledgedRoot === true && Array.isArray(acknowledgedChildCreates) && acknowledgedChildCreates.length === 0 && epoch !== undefined)) {
        throw storeError(CODES.notSettled, 'a receipt written while an attempt is still sending records its acknowledged root create alone, under its epoch');
      }
      if (!rootReceipt && phase !== 'saved' && phase !== 'state-pending' && phase !== 'membership-pending') throw storeError(CODES.notSettled, `noteSaved cannot move an attempt to ${phase}`);
      if (!Array.isArray(acknowledgedChildCreates)) throw storeError(CODES.completion, 'a child-create receipt is a list of { kind, key, id }');
      mutate((env, disk, spend) => {
        const a = requireAttempt(env, disk, token);
        spend(token);
        if (!a.expected) throw storeError(CODES.notSettled, 'an attempt cannot be saved before it was sent');
        if (epoch !== undefined && !(a.sendWindow && a.sendWindow.epoch === epoch)) {
          throw storeError(CODES.pending, `the managed ${a.family} "${a.key}" attempt was claimed by another run since this send began; its answer is not recorded`);
        }
        if (rootReceipt) {
          const root = a.rowProtocol ? a.rowProtocol.rows.find((r) => r.parentId === null && r.kind === a.root.kind && r.key === a.root.key) : null;
          if (!isRowFamily(a.family) || a.phase !== 'sending' || !root || root.mode !== 'create' || rowIdKey(root.id) !== rowIdKey(a.root.id) || a.expected.baseObservation !== null) {
            throw storeError(CODES.notSettled, `the managed ${a.family} "${a.key}" has no root this sending attempt prepared as a create; nothing acknowledges it`);
          }
          a.acknowledgedRoot = true;
          return;
        }
        if (acknowledgedRoot === true && a.expected.baseObservation !== null) {
          throw storeError(CODES.notSettled, `the managed ${a.family} "${a.key}" edited an existing root; an answer to an edit never acknowledges a create`);
        }
        // A create sent under a receipt is acknowledged by the receipt alone: an SDK result (saved, adopted, a no-op)
        // that the observed transport did not receipt never makes the root this build's creation.
        if (acknowledgedRoot === true && a.dashboardCreate && !dashboardCreateAcknowledged(a)) {
          throw storeError(CODES.notSettled, `the managed ${a.family} "${a.key}" create has no receipt of its answer; nothing else acknowledges it`);
        }
        const receipt = (a.acknowledgedChildCreates || []).map((c) => ({ ...c }));
        try {
          for (const c of acknowledgedChildCreates) {
            closedKeys(c, ['kind', 'key', 'id'], 'the child-create receipt entry');
            if (!nonempty(c.kind) || !nonempty(c.key) || !nonempty(c.id)) throw invalid('the child-create receipt entry', 'is incomplete');
            const entry = { kind: c.kind, key: c.key, id: c.id.toLowerCase() };
            // The same child in another valid spelling (a braced or upper-case GUID) is the receipt already held,
            // compared as validateChildReceipt compares it; the spelling first stored is kept.
            if (!receipt.some((x) => x.kind === entry.kind && x.key === entry.key && rowIdKey(x.id) === rowIdKey(entry.id))) receipt.push(entry);
          }
          validateChildReceipt(receipt, a, 'the child-create receipt');
        } catch (e) {
          throw storeError(CODES.completion, `the managed ${a.family} "${a.key}" cannot record that receipt: ${e.message}`);
        }
        if (receipt.length) a.acknowledgedChildCreates = receipt;
        // An acknowledged create is never forgotten by a later observation that lost the answer.
        a.acknowledgedRoot = a.acknowledgedRoot || acknowledgedRoot === true;
        a.savedObservation = { phase, proof: proof === undefined ? null : proof, acknowledgedRoot: a.acknowledgedRoot };
        a.phase = phase;
      });
    },
    /**
     * Replace the whole group of the attempt `token` with the observed complete set, remove the attempt, and bump the
     * revision — one atomic write. Records the old group held that this set omits are kept (removing a declaration
     * never forgets a row). A record whose id differs from the one the group or the expected proof holds, or an
     * expected child the set lacks, is `create-completion-required`: no substitute is bound. A group not yet committed
     * whose root create this attempt never had acknowledged (an answer to its own root create; noteSaved refuses the
     * flag on an edit, and a flag an older build left on an edit is not honoured) is committed only with
     * `adoptionApproved: true` — the
     * feature's own typed adoption approval, never inferred here — and is otherwise `managed-adoption-required`,
     * nothing written and the attempt kept. A NEW record may say `origin: 'created'` only for that acknowledged root
     * create or, for a child, when the attempt's child-create receipt (noteSaved) names that (kind, key, id); a record
     * the group already holds keeps an `adopted` origin. A group whose publication may have been sent and is not proved live
     * (dispatching / unconfirmed) is not committed again: `managed-publication-unconfirmed`, nothing written and the
     * attempt kept, until that dispatch is confirmed read-only (confirmPublished). An attempt that recorded its
     * declaration (prepareAttempt `declaration`) commits it as the group's `originalDeclaration`, beside — never
     * inside — `consumerState`, which is kept exactly as passed; a group committed by an attempt that recorded none has
     * no `originalDeclaration`.
     */
    commitGroup(proposal) {
      checkCommitProposal(proposal);
      let committed;
      mutate((env, disk) => { committed = commitInto(env, disk, proposal); });
      return clone(committed);
    },
    /**
     * Commit several configuration groups in ONE write (each proposal as commitGroup takes it, plus, for a row family,
     * `adoptionApprovedChildren`): either every group of the set is committed and its attempt removed, or nothing is
     * written. A partial set never exposes some new generations without the others.
     */
    commitGroupSet(proposals) {
      if (!Array.isArray(proposals) || proposals.length === 0) throw storeError(CODES.notSettled, 'commitGroupSet needs a non-empty list of proposals');
      proposals.forEach(checkCommitProposal);
      if (new Set(proposals.map((p) => p.token)).size !== proposals.length) throw storeError(CODES.notSettled, 'commitGroupSet names one attempt twice');
      const out = [];
      mutate((env, disk) => { for (const p of proposals) out.push(commitInto(env, disk, p)); });
      return clone(out);
    },
    /**
     * Accept configuration attempts that were deliberately never sent — a plan of existing rows only, each read fresh
     * and found exactly as planned — in ONE write: each proposal as commitGroupSet takes it, plus the `capture`
     * (readOnlyCapture) taken before that fresh read. Under the lease every capture is checked again: the attempt, its
     * group and its effects byte-for-byte as captured (same digest, generation and epoch), the expected proof of an
     * existing-row plan (a base observation), and nothing of it dispatched (attemptProvenUnsent). Then each is committed
     * exactly as commitGroupSet commits it, consuming its prepared proof. Nothing is acknowledged, no dispatch flag
     * moves, and a record the group does not already hold is bound only as `adopted` under its own approval — never
     * `created`. Any refusal writes nothing and leaves every attempt held.
     */
    commitReadOnlyGroupSet(proposals) {
      if (!Array.isArray(proposals) || proposals.length === 0) throw storeError(CODES.notSettled, 'commitReadOnlyGroupSet needs a non-empty list of proposals');
      proposals.forEach(checkCommitProposal);
      if (new Set(proposals.map((p) => p.token)).size !== proposals.length) throw storeError(CODES.notSettled, 'commitReadOnlyGroupSet names one attempt twice');
      const out = [];
      mutate((env, disk) => {
        for (const p of proposals) {
          const now = readOnlyCapture(disk.envelope, p.token);
          const was = p.capture || {};
          if (!now || now.digest !== was.digest || now.generation !== was.generation || now.epoch !== was.epoch) {
            throw storeError(CODES.conflict, 'a managed group changed since its read-only acceptance was captured; nothing was accepted');
          }
          const a = requireAttempt(env, disk, p.token);
          const name = `the managed ${a.family} "${a.key}"`;
          if (!isRowFamily(a.family) || !a.expected || !isObj(a.expected.baseObservation) || a.rowProtocol.rows.some((r) => r.mode !== 'update')) {
            throw storeError(CODES.notSettled, `${name} is not a plan of existing rows with a base observation; it cannot be accepted without a send`);
          }
          if (!attemptProvenUnsent(a, env.workflowEffects)) throw storeError(CODES.pending, `${name} attempt may have sent something; it is recovered from its original expectation, never accepted read-only`);
          const old = env.groups.find((g) => g.family === a.family && g.key === a.key) || null;
          for (const rec of p.records) {
            const held = old && old.records.some((r) => r.kind === rec.kind && r.key === rec.key);
            if (!held && rec.origin !== 'adopted') throw storeError(CODES.adoptionRequired, `${name} ${rec.kind} "${rec.key}" was never created by this attempt; accepted without a send it can only be adopted`);
          }
          out.push(commitInto(env, disk, p));
        }
      });
      return clone(out);
    },
    /**
     * Prepare the attempts of several configuration groups (ROW_FAMILIES) in ONE write, before anything is sent. Each
     * plan: { family, key, baseGeneration, revision?, root, declarationSha256, rowProtocol, completionBytes? }. Every
     * check of prepareAttempt applies to each (a usable group, no pending attempt, the generation it was planned on);
     * any refusal writes nothing. The first such write upgrades a version-1 store to version 2. Answers the tokens, in
     * order. `cohort` is reserved for command bars, which this store version does not hold: it must be null.
     */
    prepareAttemptSet(plans, { cohort = null } = {}) {
      if (!Array.isArray(plans) || plans.length === 0) throw storeError(CODES.notSettled, 'prepareAttemptSet needs a non-empty list of plans');
      if (cohort !== null) throw storeError(CODES.notSettled, 'prepareAttemptSet takes no cohort for configuration groups');
      const prepared = plans.map((p) => {
        if (!isObj(p) || !isRowFamily(p.family) || !nonempty(p.key)) throw storeError(CODES.notSettled, 'prepareAttemptSet prepares configuration groups only');
        checkCompletionBytes(p.completionBytes, 'prepareAttemptSet `completionBytes`');
        return { plan: p, token: newToken(), reserve: { bytes: completionReserveFor(undefined, p.completionBytes, `the managed ${p.family} "${p.key}"`), used: 0 } };
      });
      if (new Set(plans.map((p) => groupId(p.family, p.key))).size !== plans.length) throw storeError(CODES.notSettled, 'prepareAttemptSet names one group twice');
      mutate((env, disk) => {
        for (const { plan, token, reserve } of prepared) {
          const { family, key, baseGeneration = null, revision, root, declarationSha256, rowProtocol } = plan;
          if (revision !== undefined && revision !== disk.envelope.revision) throw storeError(CODES.conflict, `the managed binding store changed since the plan was made (revision ${disk.envelope.revision}, plan ${revision})`);
          const unit = usable(unitOf(disk, family, key));
          if (unit.attempt) throw storeError(CODES.pending, `the managed ${family} "${key}" already has a pending attempt`);
          if ((unit.group ? unit.group.generation : null) !== baseGeneration) throw storeError(CODES.conflict, `the managed ${family} "${key}" changed since the plan was made`);
          env.attempts.push({
            family, key, token, baseGeneration, phase: 'prepared', root, knownScopes: [], declarationSha256, expected: null,
            acknowledgedRoot: false, savedObservation: null, publication: null, completionReserve: reserve, rowProtocol: clone(rowProtocol),
          });
        }
      }, { admit: true });
      return prepared.map((x) => x.token);
    },
    /**
     * Mark several prepared configuration attempts sending in ONE write, each with its complete expected proof:
     * entries [{ token, expected }]. `claim` as markSending: 'first' (each must still be prepared) or 'continue' (each
     * must prove that nothing it sent was carried out — attemptProvenUnsent, which a dispatched row or effect of its
     * row protocol defeats). `observed: true` arms each send window at zero. Answers [{ token, epoch }].
     */
    markAttemptSetSending(entries, { claim = 'first', observed = true } = {}) {
      if (!Array.isArray(entries) || entries.length === 0) throw storeError(CODES.notSettled, 'markAttemptSetSending needs a non-empty list');
      if (claim !== 'first' && claim !== 'continue') throw storeError(CODES.notSettled, `markAttemptSetSending cannot claim an attempt to "${claim}"`);
      const out = [];
      mutate((env, disk, spend) => {
        for (const { token, expected } of entries) {
          const a = requireAttempt(env, disk, token);
          if (!isRowFamily(a.family)) throw storeError(CODES.notSettled, 'markAttemptSetSending marks configuration attempts only');
          const name = `the managed ${a.family} "${a.key}"`;
          if (a.expected !== null && canonicalJson(a.expected) !== canonicalJson(expected)) throw storeError(CODES.completion, 'a sent attempt keeps the expected proof it was sent with');
          if (claim === 'first' && a.phase !== 'prepared') throw storeError(CODES.pending, `${name} attempt was marked sending by another run`);
          if (claim === 'continue' && !(observed === true && attemptProvenUnsent(a, env.workflowEffects))) throw storeError(CODES.pending, `${name} attempt no longer shows that nothing it sent was carried out; it is not sent again`);
          spend(token);
          a.expected = expected;
          if (a.phase === 'prepared') {
            a.phase = 'sending';
            if (observed === true) a.sendWindow = { possible: 0, notStarted: 0, epoch: 1 };
          } else if (claim === 'continue' && a.sendWindow) {
            a.sendWindow.epoch += 1;
          }
          out.push({ token, epoch: a.sendWindow ? a.sendWindow.epoch : null });
        }
      });
      return out;
    },
    /**
     * Seal what ONE request is about to carry for the rows of a sending configuration attempt, and mark them dispatched,
     * in one write before the request leaves (lib/managed-create-transport.js). rows: [{ kind, key, id, sentFields,
     * sentSha256 }] — every row the request contains (a deep insert seals its root and children together). A row the
     * protocol does not name under that id, a row already dispatched (its first sealed request is kept), or an epoch
     * that is not the window's current one is refused: nothing is written and the request is not sent.
     */
    sealRowDispatch({ token, epoch, rows } = {}) {
      if (!Array.isArray(rows) || rows.length === 0) throw storeError(CODES.notSettled, 'sealRowDispatch needs the rows the request carries');
      mutate((env, disk, spend) => {
        const a = sendingRowAttempt(env, disk, token, epoch);
        spend(token);
        for (const s of rows) {
          const r = a.rowProtocol.rows.find((x) => x.kind === s.kind && x.key === s.key);
          if (!r || r.id !== normalizeGuid(s.id)) throw storeError(CODES.requestMismatch, `the request carries a ${s.kind} row the attempt of the managed ${a.family} "${a.key}" did not prepare under that id`);
          if (r.dispatched) throw storeError(CODES.requestMismatch, `the ${s.kind} row ${r.id} of the managed ${a.family} "${a.key}" was already sent once; it is not sent again`);
          r.sentFields = [...s.sentFields].sort();
          r.sentSha256 = s.sentSha256;
          r.dispatched = true;
        }
        if (a.sendWindow) a.sendWindow.possible += 1;
      });
    },
    /** Mark one completion effect (a solution membership, a rule's state) of a sending configuration attempt dispatched, before it leaves. */
    markRowEffectDispatch({ token, epoch, kind, id } = {}) {
      mutate((env, disk, spend) => {
        const a = sendingRowAttempt(env, disk, token, epoch);
        spend(token);
        const e = a.rowProtocol.effects.find((x) => x.kind === kind && x.id === normalizeGuid(id));
        if (!e) throw storeError(CODES.requestMismatch, `the ${kind} of ${id} is not an effect the attempt of the managed ${a.family} "${a.key}" prepared`);
        if (e.dispatched) throw storeError(CODES.requestMismatch, `the ${kind} of ${id} was already sent once for the managed ${a.family} "${a.key}"; it is not sent again`);
        e.dispatched = true;
        if (a.sendWindow) a.sendWindow.possible += 1;
      });
    },
    /**
     * Claim ONE completion effect of a configuration attempt that its own record proves was never dispatched, after the
     * rest of the attempt was sent: a duplicate rule's initial publication (`rule-state`), owed by a create whose root an
     * answer acknowledged (noteSaved), when the run that saved it stopped before the publish left (a crash, a lost
     * process). Checked against the record reread under the lease, never against what the caller read before:
     *   - the attempt keeps a row protocol, an expected proof and an observed send window, and its root create was
     *     acknowledged by its own answer;
     *   - its phase is `sending` or `state-pending` (its members are complete or still being added, never
     *     `membership-pending`), and the effect is the rule-state of its own root and still `dispatched: false`.
     * Anything else is `managed-settlement-pending`, nothing written. The claim moves the window to a new epoch (an older
     * run's dispatch under the old one is refused, as for 'continue') and puts the attempt back to `sending`, so the one
     * publish goes through the same fenced transport as the original (markRowEffectDispatch seals it dispatched before
     * it leaves, once): a publish that was, or may have been, dispatched is never claimed again. Answers { epoch }.
     */
    claimUnsentRowEffect({ token, kind, id } = {}) {
      if (kind !== 'rule-state') throw storeError(CODES.notSettled, `claimUnsentRowEffect claims a rule's state only, not a ${kind}`);
      let epoch = null;
      mutate((env, disk, spend) => {
        const a = requireAttempt(env, disk, token);
        if (!isRowFamily(a.family) || !a.rowProtocol) throw storeError(CODES.notSettled, 'claimUnsentRowEffect claims configuration attempts only');
        const name = `the managed ${a.family} "${a.key}"`;
        if (!a.expected || !a.sendWindow || a.acknowledgedRoot !== true || (a.phase !== 'sending' && a.phase !== 'state-pending')) {
          throw storeError(CODES.pending, `${name} attempt is not a saved create whose rule state alone is owed; nothing is sent under it`);
        }
        const e = a.rowProtocol.effects.find((x) => x.kind === kind && x.id === normalizeGuid(id));
        if (!e || e.id !== rowIdKey(a.root.id)) throw storeError(CODES.requestMismatch, `the ${kind} of ${id} is not an effect the attempt of ${name} prepared for its root`);
        if (e.dispatched) throw storeError(CODES.pending, `the ${kind} of ${id} was already sent once for ${name}; it is not sent again`);
        spend(token);
        a.sendWindow.epoch += 1;
        a.phase = 'sending';
        epoch = a.sendWindow.epoch;
      });
      return { epoch };
    },
    /**
     * Mark, in one write immediately before the one send of `scope` under `token`:
     *   groups   [{ family, key }] the owed, unsent publication each of them pays: owed -> dispatching. The caller read
     *            each of them not yet live at its desired hash (publishManagedScope `due`), so a later read that shows it
     *            live shows the publish changed it;
     *   carried  [{ family, key, generation, publishedSha256, savedSha256 }] every OTHER group the same publish puts
     *            live again (a table publish ships every form and view of the table), whatever its publication: owed
     *            and not paid by this call, confirmed, or not-needed, a null desired hash included. `generation` is the
     *            one the caller read, and the two hashes are its published and saved layers read just before the send.
     *            It becomes dispatching under the same token, keeps the publication it had and that evidence
     *            (`carriedFrom`), and keeps its desired hash as committed — nothing is invented or rewritten. The send
     *            is then fenced like any other: a later run quarantines the scope, no change is prepared or claimed
     *            over it, and only confirmPublished (a witness) or acceptUncertainPublication (the maker) settles it.
     * Any group that is pending, invalid, not as described, or committed again since it was read refuses the whole
     * mark and nothing is written, so nothing is sent.
     */
    markPublishDispatch({ groups = [], scope, token, carried = [] }) {
      tokenField(token, 'the dispatch token');
      if (!Array.isArray(groups) || !Array.isArray(carried) || !groups.length && !carried.length) throw storeError(CODES.notSettled, 'markPublishDispatch needs the groups the publish pays or carries');
      mutate((env, disk) => {
        const seen = new Set();
        const find = (family, key) => {
          const id = groupId(family, key);
          if (seen.has(id)) throw storeError(CODES.notSettled, `the managed ${family} "${key}" is named twice in one dispatch`);
          seen.add(id);
          const unit = usable(unitOf(disk, family, key));
          if (unit.attempt) throw storeError(CODES.pending, `the managed ${family} "${key}" has a pending attempt`);
          const g = env.groups.find((x) => x.family === family && x.key === key);
          if (g && g.publication && scopeKey(g.publication.scope) !== scopeKey(scope)) throw storeError(CODES.notSettled, `the managed ${family} "${key}" is published in another scope`);
          return g;
        };
        for (const { family, key } of groups) {
          const g = find(family, key);
          if (!g || !g.publication || g.publication.state !== 'owed' || g.publication.dispatchToken !== null) throw storeError(CODES.notSettled, `the managed ${family} "${key}" owes no unsent publication`);
          g.publication.state = 'dispatching';
          g.publication.dispatchToken = token;
        }
        for (const { family, key, generation, publishedSha256, savedSha256 } of carried) {
          const g = find(family, key);
          const p = g && g.publication;
          if (!p || !(p.state === 'confirmed' || p.state === 'not-needed' || (p.state === 'owed' && p.dispatchToken === null))) {
            throw storeError(CODES.notSettled, `the managed ${family} "${key}" has no publication a publish can carry`);
          }
          // The layer evidence is optional only for the earlier shape: a settled carried group with a desired hash, which a later
          // read must then show and which is never a witness. A group without one (not-needed, a null desired hash)
          // needs the evidence, since nothing else could ever be read against it.
          const legacy = publishedSha256 === undefined && savedSha256 === undefined && typeof p.desiredSha256 === 'string' && p.state !== 'owed';
          if (!legacy && (typeof publishedSha256 !== 'string' || !HEX64.test(publishedSha256) || typeof savedSha256 !== 'string' || !HEX64.test(savedSha256))) {
            throw storeError(CODES.notSettled, `the managed ${family} "${key}" is carried without the layers read before the send`);
          }
          if (g.generation !== generation) throw storeError(CODES.conflict, `the managed ${family} "${key}" was committed again since its layers were read`);
          p.carriedFrom = legacy ? { state: p.state, dispatchToken: p.dispatchToken } : { state: p.state, dispatchToken: p.dispatchToken, publishedSha256, savedSha256 };
          p.state = 'dispatching';
          p.dispatchToken = token;
        }
      }, { admit: true });
    },
    /**
     * After the send: 'definite-no-start' returns the debt to owed, and a carried group to the settled state it had;
     * 'unconfirmed' keeps it uncertain. A group of the send that a fresh read already confirmed (confirmUncertainPublication,
     * while this send's answer was outstanding) stays confirmed: an outcome that arrives later is not evidence against a
     * read that proved the layer live.
     */
    notePublishOutcome({ token, outcome }) {
      if (outcome !== 'definite-no-start' && outcome !== 'unconfirmed') throw storeError(CODES.notSettled, `unknown publish outcome ${outcome}`);
      mutate((env) => {
        const owned = env.groups.filter((g) => g.publication && g.publication.dispatchToken === token);
        if (!owned.length) throw storeError(CODES.notSettled, 'no publication was dispatched under this token');
        for (const g of owned) {
          if (g.publication.state === 'confirmed') continue;
          if (outcome !== 'definite-no-start') { g.publication.state = 'unconfirmed'; continue; }
          const was = g.publication.carriedFrom;
          delete g.publication.carriedFrom;
          if (was) { g.publication.state = was.state; g.publication.dispatchToken = was.dispatchToken; } else { g.publication.state = 'owed'; g.publication.dispatchToken = null; }
        }
      });
    },
    /**
     * A fresh published read settles a publication without sending.
     * `token` null: debt that was never sent and whose published layer already equals what is owed becomes not-needed.
     * `token` a dispatch token: the dispatch is settled WHOLE — `groups` must name every group still uncertain under
     * it — and only when its outcome is shown, never from an observation that was already true before the send:
     *   - every group's read must be consistent with the send: debt (dispatched owed) shows its desired hash; a carried
     *     group shows the saved layer the send shipped (`carriedFrom.savedSha256`; a record without that evidence, its
     *     desired hash);
     *   - and at least one group must be a WITNESS, a layer the send changed: debt (it was read not live before the
     *     send, markPublishDispatch), or a carried group whose published layer before the send differed from the
     *     saved layer it shipped. A carry-only dispatch over layers that were already live has no witness;
     *   - `answered: true` stands in for the witness, and only in the invocation that dispatched the publish and saw it
     *     answer success (a synchronous publish that answered success has completed); it is never a later run's.
     * Otherwise `managed-publication-unconfirmed`, and nothing is written. Settling: debt becomes confirmed; a carried
     * group becomes confirmed under this token when its desired hash is live, and otherwise gets back the publication
     * it had before the send. A desired hash is never rewritten. `proof.publishedSha256` is the read for every group
     * unless an entry carries its own; an entry may name the `generation` its read was judged against: a group
     * committed again since then is `managed-binding-generation-conflict`, and nothing is settled.
     */
    confirmPublished({ groups, token = null, proof = {}, answered = false }) {
      mutate((env) => {
        const named = new Set();
        let witnessed = answered === true;
        const settle = [];
        for (const entry of groups) {
          const { family, key } = entry;
          const published = typeof entry.publishedSha256 === 'string' ? entry.publishedSha256 : proof.publishedSha256;
          const g = env.groups.find((x) => x.family === family && x.key === key);
          if (!g || !g.publication) throw storeError(CODES.notSettled, `the managed ${family} "${key}" has no publication`);
          if (entry.generation !== undefined && g.generation !== entry.generation) throw storeError(CODES.conflict, `the managed ${family} "${key}" was committed again since its published layer was read`);
          if (g.publication.dispatchToken !== token) throw storeError(CODES.notSettled, `the managed ${family} "${key}" publication carries another dispatch token`);
          named.add(groupId(family, key));
          const p = g.publication;
          const cf = p.carriedFrom;
          if (token !== null && cf && typeof cf.savedSha256 === 'string') {
            if (published !== cf.savedSha256) throw storeError(CODES.publicationUncertain, `the managed ${family} "${key}" published layer is not the one its scope's publish shipped`);
            if (cf.publishedSha256 !== cf.savedSha256) witnessed = true;
          } else if (cf) {
            if (published !== p.desiredSha256) throw storeError(CODES.publicationUncertain, `the managed ${family} "${key}" published layer does not equal what was carried`);
          } else {
            if (token !== null && typeof p.desiredSha256 !== 'string') throw storeError(CODES.publicationUncertain, `the managed ${family} "${key}" names no desired hash to confirm`);
            if (p.desiredSha256 && published !== p.desiredSha256) throw storeError(CODES.notSettled, `the managed ${family} "${key}" published layer does not equal what was owed`);
            if (token !== null && UNCERTAIN.has(p.state)) witnessed = true;
          }
          settle.push({ p, published });
        }
        if (token !== null) {
          const open = env.groups.filter((g) => g.publication && g.publication.dispatchToken === token && UNCERTAIN.has(g.publication.state));
          const missing = open.filter((g) => !named.has(groupId(g.family, g.key)));
          if (missing.length) throw storeError(CODES.publicationUncertain, `a publish is settled whole: ${missing.map((g) => `${g.family} "${g.key}"`).join(', ')} shares its dispatch and was not read`);
          if (open.length && !witnessed) {
            throw storeError(CODES.publicationUncertain, 'the publish carried only layers that were already live, so no read can show it ended; it stays unconfirmed until the maker accepts the risk (acceptUncertainPublication)');
          }
        }
        for (const { p, published } of settle) {
          if (p.state === 'owed') { p.state = 'not-needed'; continue; }
          if (!UNCERTAIN.has(p.state)) continue;
          const cf = p.carriedFrom;
          delete p.carriedFrom;
          if (!cf || (typeof p.desiredSha256 === 'string' && published === p.desiredSha256)) { p.state = 'confirmed'; continue; }
          p.state = cf.state;
          p.dispatchToken = cf.dispatchToken;
        }
      });
    },
    /**
     * The maker's way out of a publish no read can settle (a carry-only dispatch over layers that were already live,
     * or any dispatch whose witness never shows): `approval` must be exactly publicationRiskApproval(scope, dispatchToken),
     * `publication-risk:table:<table>/<dispatch>` or `publication-risk:dashboard:<id>/<dispatch>`, and stands for "I checked what
     * is live on this scope and accept that THIS lost publish may still complete"; a key for another dispatch is refused. It is the feature's typed approval, never
     * inferred. Under the lease, every group still uncertain under `dispatchToken` on `scope` is released in one write:
     * dispatched debt is owed again (a later publish pays it after the usual layer checks), and a carried group gets
     * back the publication it had. Nothing is sent and no desired hash changes; the acceptance is recorded in the
     * store (`publicationRiskAcceptances`). It does not clear this run's quarantine (the barrier is in memory): the
     * next invocation finds no uncertain publication. There is no time-based or run-based release.
     * It releases ONLY the publication. A pending attempt on a released group (prepared, sending or saved; an older
     * store can hold one beside an uncertain publish) is left exactly as it is: its phase, expected proof, saved
     * observation, effects and hold. Retiring a sending or saved attempt is refused, and recovering it is refused while
     * the publish is uncertain, so requiring either first would leave no way out; normal recovery settles it afterwards.
     * Answers { released: [{ family, key }] }. Every error it throws carries `refusedBeforeWrite`: true when it was refused before
     * the replacement was attempted (the checks above, the lease not taken, the store full), so nothing was recorded; false when
     * the replacement was attempted and its answer or read-back failed, so the acceptance MAY be durable — a caller must not
     * treat that as "nothing recorded".
     */
    acceptUncertainPublication({ scope, dispatchToken, approval } = {}) {
      let changed = false;
      try {
        validateScope(scope, 'the scope');
        tokenField(dispatchToken, 'the dispatch token');
        if (approval !== publicationRiskApproval(scope, dispatchToken)) throw storeError(CODES.notSettled, `accepting the unproved publish ${dispatchToken} of ${scopeKey(scope)} needs its own typed approval (${publicationRiskApproval(scope, dispatchToken)})`);
        const released = [];
        mutate((env, disk) => {
          const open = env.groups.filter((g) => g.publication && g.publication.dispatchToken === dispatchToken && UNCERTAIN.has(g.publication.state));
          if (!open.length) throw storeError(CODES.notSettled, `no publish of ${scopeKey(scope)} is unconfirmed under that dispatch token`);
          for (const g of open) {
            if (scopeKey(g.publication.scope) !== scopeKey(scope)) throw storeError(CODES.notSettled, `the dispatch also covers ${g.family} "${g.key}" in another scope`);
          }
          for (const g of open) {
            const p = g.publication;
            const cf = p.carriedFrom;
            delete p.carriedFrom;
            if (cf) { p.state = cf.state; p.dispatchToken = cf.dispatchToken; } else { p.state = 'owed'; p.dispatchToken = null; }
            released.push({ family: g.family, key: g.key });
          }
          const list = Array.isArray(env.publicationRiskAcceptances) ? env.publicationRiskAcceptances : [];
          list.push({ scope: { ...scope }, dispatchToken, approval, groups: open.map((g) => ({ family: g.family, key: g.key, generation: g.generation })) });
          env.publicationRiskAcceptances = list.slice(-RISK_ACCEPTANCES_KEPT);
          changed = true;
        });
        return { released };
      } catch (e) {
        // The change callback runs under the lease, after every check of its own; mutate's own pre-write refusals (the store
        // full, a group made invalid) come after it but still before the disk is touched. Anything else after the callback (a
        // write that failed or did not read back, a lease release that threw) may have left the replacement on disk.
        const before = !changed || Boolean(e && (e.code === CODES.storeFull || e.code === CODES.groupInvalid));
        if (e && typeof e === 'object') Object.defineProperty(e, 'refusedBeforeWrite', { value: before, enumerable: false, configurable: true });
        throw e;
      }
    },
    /**
     * Retire the attempt `token` when its record proves no protected mutation started: phase `prepared`, never marked
     * sending, no expected proof, no acknowledgement or saved observation, and every workflow effect it owns still
     * definitely-unsent with no dispatch token. Under the record lease the file is reread, and the attempt must still be
     * based on `baseGeneration`, which must still be the group's generation. One write removes only that attempt and
     * the effects it owns; the committed group, its publication debt and every other attempt and effect stay. Then,
     * and only after the write, its own hold ends — a quarantine or an uncertain-send block is never cleared.
     * A `sending` attempt is never retired (it may have reached the service; runManagedFeature recovers or resumes it),
     * and a later read that finds nothing is not evidence that nothing started: `managed-settlement-pending`.
     * Answers { retired: true, effects } (the count of effect records removed with it).
     */
    retireUnsentAttempt({ token, baseGeneration } = {}) {
      if (typeof token !== 'string' || !token) throw storeError(CODES.notSettled, 'retireUnsentAttempt needs the attempt token');
      if (baseGeneration === undefined) throw storeError(CODES.notSettled, 'retireUnsentAttempt needs the generation the attempt was based on');
      let removed = 0;
      mutate((env, disk) => {
        removed = retireInto(env, requireAttempt(env, disk, token), baseGeneration);
      });
      // The write is durable and read back (mutate): only now may the attempt's own hold end. A store opened without the
      // barrier has no hold to end; the caller releases its own.
      if (barrier) barrier.release(token);
      return { retired: true, effects: removed };
    },
    /**
     * Step 1 of a retirement: observe the group (`family`, `key`) BEFORE the fresh service reads that prove its root
     * absent. Rereads the file and answers { observation }: an opaque fingerprint of the group, its pending attempt and
     * its workflow effects as they are now. Pass it to retireAbsentGroup, which refuses when they changed since. The
     * order is the contract: observe, then read every layer by the root id, then retire. An observation taken AFTER
     * the read proves nothing (a create may have landed between the read and it), so never refresh it to get past a
     * refusal: stop this invocation instead, and let a later invocation observe again, read every layer again, then
     * retire. Refuses (`managed-not-settled`) when there is nothing to retire, and as
     * readGroup for a group the file cannot vouch for. Writes nothing.
     */
    observeRetirement({ family, key } = {}) {
      if (!FAMILIES.includes(family) || !nonempty(key)) throw storeError(CODES.notSettled, 'observeRetirement needs the group\'s family and key');
      handle.refresh();
      const unit = usable(unitOf(state, family, key));
      if (!unit.group && !unit.attempt) throw storeError(CODES.notSettled, `the managed ${family} "${key}" has no group to retire`);
      return { observation: retirementObservation(state.envelope, family, key) };
    },
    /**
     * Retire the group (`family`, `key`) whose root row is gone from the service, so a group that can no longer be
     * published, used, verified or re-proved stops blocking every later build: for example a declared dashboard with an
     * owed, never-sent publish whose declaration was removed and whose row the maker then deleted; a committed rule or
     * process flow whose row was deleted (every verify fails on it); or a workflow create whose create effect was
     * confirmed and whose activation never left (an answered, unapplied 412), whose row was then deleted (its attempt
     * holds every run, and declaring it again can never prove it).
     * `evidence` is REQUIRED and typed by family (checkAbsenceEvidence): two layers, `saved` and `published`, each
     * 'not-found' for a family that publishes; one, `row: 'not-found'`, for a workflow. The store cannot read the
     * service: the CALLER must prove it from a fresh read by exactly `rootId` that answered the missing-row 404 in every
     * layer (for a systemform, readSystemFormRootPresence(client, rootId) === 'absent'). A missing published layer
     * alone is not absence, nor is a 403, a timeout or an unreadable or malformed answer.
     * `observation` is REQUIRED: what observeRetirement answered BEFORE those reads. Under the lease the group, its
     * attempt and its effects must be exactly as observed; any progress since (a send counted, an effect dispatched or
     * confirmed, a root acknowledged) may have put the row back after the read, so the retirement is refused
     * (`managed-binding-generation-conflict`, nothing written, no hold released). The caller stops this invocation
     * and keeps what it holds; a later invocation observes again, reads every layer again, then retires. Never retry
     * in the same invocation with a fresh observation: it would be taken after the read.
     * `generation` is the committed group's generation, or null for a group never committed. `attemptToken` names the
     * pending attempt to retire with it: required when one is pending, refused when none is, and accepted only for a
     * workflow family (rule, bpf), whose every write is a journaled effect (sent through withWorkflowEffect, which
     * records it before it leaves), so its own record shows nothing on its way:
     * every effect it owns `confirmed`, `fulfilled` or `definitely-unsent` with no dispatch token, AND an affirmative
     * record that nothing it may have sent outside that journal can still land: it is still `prepared` (never marked
     * sending), or its send window counted no possibly applied mutation (attemptProvenUnsent), or its own create of
     * the root was confirmed by a read. An empty or all-unsent journal is no such record by itself: a `sending` attempt
     * with no send window, or one that counted a possible send, may have a write on its way (a create whose answer
     * was lost), so it stays on its recovery path (runManagedFeature). A pending attempt of
     * another family is never retired here (its SDK push is not journaled write by write): it is recovered, or retired
     * with retireUnsentAttempt first. A run that still holds the retired attempt's send claim is fenced by the same
     * write: its next effect dispatch or counted send names an attempt that is gone and is refused unsent.
     * Under the record lease the file is reread, and in that one change the group must still be valid, at `generation`
     * (the attempt based on it), bound to the root `rootId` (GUID spellings compare equal; the attempt's root too), with
     * a publication that is `owed` with no dispatch token, `not-needed` or `confirmed` (or none, for a workflow).
     * Otherwise it refuses with nothing written: `managed-not-settled` (bad arguments or evidence, or nothing to
     * retire), `managed-binding-group-invalid`, `managed-binding-generation-conflict` (another generation, root or
     * attempt), `managed-settlement-pending` (an attempt or an effect that could still land) or
     * `managed-publication-unconfirmed` (a publish that may have been sent; it carries { dispatchToken, approval,
     * remedy }). The normal write rules apply, including `managed-binding-store-full`.
     * One write removes that group, its attempt and the effects that attempt owns, and appends { family, key,
     * generation, rootId, reason: 'root-absent', publication, attempt: null | { token, phase, effects: [{ effect,
     * state }] }, at } to `retiredGroups` (newest last, at most RETIRED_GROUPS_KEPT). The entry says the root was proved
     * gone and the group retired: NOT that its content was published, its debt paid or an activation made; the effect
     * states say what each change was when it was dropped. The same write moves the retired root's incarnation lineages
     * on (see validateIncarnations): each lineage of the key, or whose root or identity the retired root is, takes a fresh
     * random rootId, `after: <the retired root>` and the next epoch; a root no lineage knows starts { family, key,
     * identity: <the retired root>, rootId: <a fresh random id>, after: <the retired root>, epoch: 1 }. So a declaration
     * of the key, or of the same identity under another key, made later is created under that fresh root, and every child
     * under it, by every run until it commits; prepareAttempt refuses the retired root and any plan made for an earlier
     * epoch. Every other group, attempt, effect, publication and risk
     * acceptance stays as it was. After the write the retired attempt's own hold ends (as retireUnsentAttempt); a
     * quarantine this run installed is never cleared, so the invocation that met it stays stopped and the next one
     * proceeds from the file. Answers { retired: { family, key, generation, attempt: <token or null> } }.
     */
    retireAbsentGroup({ family, key, generation, rootId, evidence, attemptToken, observation } = {}) {
      if (!FAMILIES.includes(family) || !nonempty(key)) throw storeError(CODES.notSettled, 'retireAbsentGroup needs the group\'s family and key');
      if (generation !== null && (typeof generation !== 'string' || !generation)) throw storeError(CODES.notSettled, 'retireAbsentGroup needs the generation the root was proved absent for (null for a group never committed)');
      if (attemptToken !== undefined && !nonempty(attemptToken)) throw storeError(CODES.notSettled, 'retireAbsentGroup takes attemptToken only as the pending attempt\'s token');
      if (generation === null && attemptToken === undefined) throw storeError(CODES.notSettled, 'a group never committed is retired only with its pending attempt (attemptToken)');
      if (typeof rootId !== 'string' || !normalizeGuid(rootId)) throw storeError(CODES.notSettled, 'retireAbsentGroup needs the id of the root proved absent');
      checkAbsenceEvidence(family, evidence, rootId);
      if (typeof observation !== 'string' || !RETIREMENT_OBSERVATION.test(observation)) throw storeError(CODES.notSettled, 'retireAbsentGroup needs the observation observeRetirement answered before the root was read');
      const name = `the managed ${family} "${key}"`;
      const sameRoot = (id) => normalizeGuid(id) === normalizeGuid(rootId);
      mutate((env, disk) => {
        usable(unitOf(disk, family, key));
        const g = env.groups.find((x) => x.family === family && x.key === key) || null;
        const a = env.attempts.find((x) => x.family === family && x.key === key) || null;
        if (!g && !a) throw storeError(CODES.notSettled, `${name} has no group to retire`);
        if (retirementObservation(env, family, key) !== observation) {
          throw storeError(CODES.conflict, `${name} changed since it was observed for this retirement; its root may have been written after it was read: observe it again, read the root again, then retire`);
        }
        if ((g ? g.generation : null) !== generation) throw storeError(CODES.conflict, `${name} is at another generation than the one its root was proved absent for`);
        if (g && !sameRoot(g.root.id)) throw storeError(CODES.conflict, `${name} is bound to the root ${g.root.id}, not ${rootId}`);
        let owned = [];
        if (a) {
          if (attemptToken === undefined) throw storeError(CODES.pending, `${name} has a pending attempt; it is recovered, or retired with its group only when named (attemptToken)`);
          if (a.token !== attemptToken) throw storeError(CODES.conflict, `${name} has another pending attempt than the one named`);
          if (!WORKFLOW_FAMILIES.has(family)) throw storeError(CODES.pending, `${name} has a pending attempt whose push may still land; it is recovered, or retired as unsent (retireUnsentAttempt) first, never with its group`);
          if (a.baseGeneration !== generation) throw storeError(CODES.conflict, `${name} attempt is based on another generation`);
          if (!sameRoot(a.root.id)) throw storeError(CODES.conflict, `${name} attempt changes the root ${a.root.id}, not ${rootId}`);
          owned = env.workflowEffects.filter((e) => e.attemptToken === a.token);
          if (owned.some((e) => !SETTLED_EFFECT_STATES.has(e.state) || (e.state === 'definitely-unsent' && e.dispatchToken !== null))) {
            throw storeError(CODES.pending, `${name} has a workflow effect that may have been sent and is not proved; it is never retired`);
          }
          if (owned.length > RETIRED_EFFECTS_KEPT) throw storeError(CODES.notSettled, `${name} attempt has more effects than a retirement records`);
          const neverSent = a.phase === 'prepared' && a.expected === null;
          const ownCreateProved = owned.some((e) => e.effect === 'create' && e.state === 'confirmed');
          if (!neverSent && !ownCreateProved && !attemptProvenUnsent(a, env.workflowEffects)) {
            throw storeError(CODES.pending, `${name} attempt may have sent a write its record does not account for (no send window, or one that counted a possible send, and no confirmed create of its own); it is recovered, never retired`);
          }
        } else if (attemptToken !== undefined) {
          throw storeError(CODES.conflict, `${name} has no pending attempt to retire`);
        }
        // Every effect names a pending attempt of its group (parseEnvelope), so with none pending there is none left.
        if (env.workflowEffects.some((e) => e.family === family && e.key === key && !owned.includes(e))) throw storeError(CODES.pending, `${name} has a workflow effect that is not settled; it is never retired`);
        const p = g ? g.publication : null;
        if (p && UNCERTAIN.has(p.state)) {
          throw storeError(CODES.publicationUncertain, `${name} has a publish that may have been sent and is not proved live; it is never retired over it`, blockedPublication(p.scope, p.dispatchToken));
        }
        if (p && (!RETIRABLE_PUBLICATIONS.has(p.state) || (p.state === 'owed' && p.dispatchToken !== null))) {
          throw storeError(CODES.pending, `${name} has a publication in state ${p.state} that is not settled; it is never retired`);
        }
        env.groups = env.groups.filter((x) => x !== g);
        if (a) {
          env.attempts = env.attempts.filter((x) => x !== a);
          env.workflowEffects = env.workflowEffects.filter((e) => e.attemptToken !== a.token);
        }
        const list = Array.isArray(env.retiredGroups) ? env.retiredGroups : [];
        list.push({
          family, key, generation, rootId: normalizeGuid(g ? g.root.id : a.root.id), reason: 'root-absent', publication: p ? p.state : null,
          attempt: a ? { token: a.token, phase: a.phase, effects: owned.map((e) => ({ effect: e.effect, state: e.state })) } : null,
          at: new Date(now()).toISOString(),
        });
        env.retiredGroups = list.slice(-RETIRED_GROUPS_KEPT);
        // The key's next create identity, in this same write: declared again, it is created under a fresh root, never
        // under the one just proved gone (validateIncarnations). Every lineage the retired root belongs to moves on: the
        // key's own, the one whose current root it was (a declaration that selected it by identity under another key),
        // and the one whose identity it is. Each keeps its key and identity, takes a fresh root and the next epoch, so a
        // plan made for any earlier incarnation of it is refused by prepareAttempt however many retirements ago that was.
        // A root no lineage knows yet starts one, whose identity is that root: the declaration's stable id when the
        // declared path created it.
        const retiredRoot = normalizeGuid(g ? g.root.id : a.root.id);
        const all = env.incarnations || [];
        const touched = all.filter((x) => x.family === family && (x.key === key || x.rootId === retiredRoot || x.identity === retiredRoot));
        if (!touched.length && all.length >= INCARNATIONS_KEPT) throw storeError(CODES.storeFull, `${name} cannot be retired: the store already keeps the create identity of ${INCARNATIONS_KEPT} retired keys. Nothing was written`);
        const taken = new Set(all.flatMap((x) => [x.rootId, x.after, x.identity]).concat(retiredRoot));
        // Not named `rootId`: a `let` of that name here would shadow the parameter for this whole callback, so every refusal
        // above that quotes it would throw a ReferenceError (temporal dead zone) instead of its coded store error.
        const freshRoot = () => {
          let id;
          do { id = crypto.randomUUID().toLowerCase(); } while (taken.has(id));
          taken.add(id);
          return id;
        };
        env.incarnations = touched.length
          ? all.map((x) => (touched.includes(x) ? { ...x, rootId: freshRoot(), after: retiredRoot, epoch: x.epoch + 1 } : x))
          : all.concat([{ family, key, identity: retiredRoot, rootId: freshRoot(), after: retiredRoot, epoch: 1 }]);
      });
      // The write is durable and read back (mutate): only now may the retired attempt's own hold end.
      if (attemptToken !== undefined && barrier) barrier.release(attemptToken);
      return { retired: { family, key, generation, attempt: attemptToken === undefined ? null : attemptToken } };
    },
    /**
     * Persist one workflow effect as definitely-unsent; it must belong to the pending attempt `attemptToken`.
     * The same effect asked for again by the same attempt (every field that says what it is equal), while its record is
     * still definitely-unsent with no dispatch token, answers that record instead of a second one: it never started, so
     * a resumed create or a continued attempt (recoverManagedAttempt) sends it under its own token. A state change the
     * attempt already has fulfilled (fulfillEffect: the same row and desired state) answers that fulfilled record,
     * whatever row version the new proposal carries: its target was reached, and a change the row has had since (a
     * maker's deactivation, say) is never undone by sending it again. Any other unsettled effect of the same kind on the
     * row is refused.
     */
    recordWorkflowEffect(effect) {
      const rec = effectRecord(effect);
      const same = (e) => canonicalJson([e.attemptToken, e.baseGeneration, e.family, e.key, e.rowId, e.effect, e.request, e.desiredSha256, e.desiredState, e.expectedVersion])
        === canonicalJson([rec.attemptToken, rec.baseGeneration, rec.family, rec.key, rec.rowId, rec.effect, rec.request, rec.desiredSha256, rec.desiredState, rec.expectedVersion]);
      let reused = null;
      mutate((env, disk, spend) => {
        checkEffectOwner(env, disk, rec);
        spend(rec.attemptToken);
        const reached = fulfilledTarget(env, rec);
        if (reached) { reused = clone(reached); return; }
        const open = env.workflowEffects.filter((e) => e.rowId === rec.rowId && e.effect === rec.effect && e.state !== 'confirmed');
        if (open.length === 1 && open[0].state === 'definitely-unsent' && open[0].dispatchToken === null && same(open[0])) { reused = clone(open[0]); return; }
        if (open.length) throw storeError(CODES.pending, `the workflow row ${rec.rowId} already has an unsettled ${rec.effect} effect`);
        env.workflowEffects.push(rec);
      });
      return reused || clone(rec);
    },
    markEffectDispatching(token, dispatchToken) {
      tokenField(dispatchToken, 'the dispatch token');
      mutate((env, disk, spend) => {
        const e = env.workflowEffects.find((x) => x.token === token);
        if (!e || e.state !== 'definitely-unsent') throw storeError(CODES.notSettled, 'the workflow effect is not waiting to be sent');
        spend(e.attemptToken);
        e.state = 'dispatching';
        e.dispatchToken = dispatchToken;
      });
    },
    noteEffectOutcome(token, outcome) {
      if (outcome !== 'definite-no-start' && outcome !== 'unconfirmed') throw storeError(CODES.notSettled, `unknown effect outcome ${outcome}`);
      mutate((env, disk, spend) => {
        const e = env.workflowEffects.find((x) => x.token === token);
        if (!e || !UNCERTAIN.has(e.state)) throw storeError(CODES.notSettled, 'the workflow effect was not dispatched');
        spend(e.attemptToken);
        if (outcome === 'definite-no-start') { e.state = 'definitely-unsent'; e.dispatchToken = null; } else e.state = 'unconfirmed';
      });
    },
    /** A fresh read proved the effect's desired body (create, body) or state on its row: confirm it without sending again. */
    confirmEffect(token, { observedSha256, observedState } = {}) {
      mutate((env, disk, spend) => {
        const e = env.workflowEffects.find((x) => x.token === token);
        // A fulfilled change was never sent by this attempt, so it is never called confirmed (a confirmed effect claims
        // a dispatch of ours).
        if (!e || e.state === 'definitely-unsent' || e.state === 'fulfilled') throw storeError(CODES.notSettled, 'the workflow effect was not dispatched');
        spend(e.attemptToken);
        const proved = e.effect === 'state' ? observedState === e.desiredState : observedSha256 === e.desiredSha256;
        if (!proved) throw storeError(CODES.notSettled, 'the observed workflow row does not prove the effect');
        e.state = 'confirmed';
      });
    },
    /**
     * A state change this attempt never sent (definitely-unsent, no dispatch token) whose desired state a fresh read
     * finds already on its row, put there by someone else: there is nothing left to send, so the record becomes
     * `fulfilled` — a terminal fact that keeps the read's `observedState` and `observedVersion` (the row version that
     * read answered), keeps no dispatch token and is never called confirmed. It stays on disk with its attempt, through
     * any failure or restart, until the attempt's commit retires it (commitGroup accepts it); until then the change is
     * never proposed or sent again: recordWorkflowEffect answers the fulfilled record for the same target at any row
     * version, the transport and markEffectDispatching refuse it, and withWorkflowEffect refuses it unsent
     * (`workflow-effect-fulfilled`). A row the maker changed since (deactivated, say) is therefore never changed back.
     * Only a state effect: a body is never settled this way. The caller has proved, from the same read, that the row
     * carries exactly the attempt's own body; the store cannot see the row.
     * Every condition is checked on the record reread under the lease, in one write, so a run that claimed and
     * dispatched the change since the caller's read (it is then dispatching, with a token) is never overwritten, and a
     * write that fails leaves the effect unsent. The owning attempt must still be pending, and it stays so: its token,
     * its other effects and the barrier hold under that token are untouched. Answers the fulfilled record.
     */
    fulfillEffect(token, { observedState, observedVersion } = {}) {
      let out = null;
      mutate((env, disk, spend) => {
        const e = env.workflowEffects.find((x) => x.token === token);
        if (!e || e.effect !== 'state' || e.state !== 'definitely-unsent' || e.dispatchToken !== null) {
          throw storeError(CODES.notSettled, 'only a state change that was never sent can be found fulfilled without sending it');
        }
        requireAttempt(env, disk, e.attemptToken);
        spend(e.attemptToken);
        fulfilInto(e, observedState, observedVersion);
        out = clone(e);
      });
      return out;
    },
    /**
     * The same fact when no change was recorded first: the row a fresh read found already in the state the attempt
     * wants (its own create may have left it so), before any state effect was proposed. `effect` is what
     * recordWorkflowEffect takes (a state effect of the pending attempt `attemptToken`, on its own root); it is recorded
     * as `fulfilled` in ONE write, never as a sendable change first, so no failure in between can leave one to send.
     * The same target already on the attempt — fulfilled, or confirmed — answers that record; the same change still
     * unsent and never dispatched is fulfilled in place; any other unsettled state effect on the row is refused.
     * Answers the fulfilled (or answered) record.
     */
    recordFulfilledEffect(effect, { observedState, observedVersion } = {}) {
      const rec = effectRecord(effect);
      if (rec.effect !== 'state') throw storeError(CODES.notSettled, 'only a state change can be found fulfilled without sending it');
      let out = null;
      mutate((env, disk, spend) => {
        checkEffectOwner(env, disk, rec);
        spend(rec.attemptToken);
        const reached = fulfilledTarget(env, rec, true);
        if (reached) { out = clone(reached); return; }
        const open = env.workflowEffects.filter((e) => e.rowId === rec.rowId && e.effect === rec.effect && e.state !== 'confirmed');
        if (open.length === 1 && open[0].attemptToken === rec.attemptToken && open[0].state === 'definitely-unsent' && open[0].dispatchToken === null
          && open[0].desiredState === rec.desiredState) {
          fulfilInto(open[0], observedState, observedVersion);
          out = clone(open[0]);
          return;
        }
        if (open.length) throw storeError(CODES.pending, `the workflow row ${rec.rowId} already has an unsettled ${rec.effect} effect`);
        fulfilInto(rec, observedState, observedVersion);
        env.workflowEffects.push(rec);
        out = clone(rec);
      });
      return out;
    },
    // The barrier operations, forwarded so one handle carries the whole contract of a managed feature.
    registerKnown(scopes, ids) { return needBarrier().registerKnown(scopes, ids); },
    hold(token, scopes, ids, label) { return needBarrier().hold(token, scopes, ids, label); },
    release(token) { return needBarrier().release(token); },
    quarantine(scopes, ids, label) { return needBarrier().quarantine(scopes, ids, label); },
    allowScope(scope, path) { return needBarrier().allowScope(scope, path); },
    blockScope(scope, label) { return needBarrier().blockScope(scope, label); },
    withSendPermit(permit, fn) { return needBarrier().withSendPermit(permit, fn); },
  };
  return handle;
}

/**
 * The only opener a build uses. Reuses `existing` (a handle the CLI already opened) instead of opening a second writer.
 * Discovery is read-only: a missing file creates nothing and installs nothing. An existing file is classified unit by
 * unit with classifyPersisted, and the barrier gets: every target registered; a token-owned hold for a pending attempt
 * (released only by the recovery of that attempt); a block for the rest of this invocation for uncertain and corrupt
 * groups. A settled group or eligible debt installs nothing. Answers { store, debt, absent }.
 */
function openManagedContext({ workspaceDir, environment, appUniqueName, solutionUniqueName, existing = null, barrier = null, deps } = {}) {
  if (existing) return existing;
  const found = discoverManagedStore({ workspaceDir, environment, appUniqueName, solutionUniqueName });
  const store = openManagedBindings({ workspaceDir, environment, appUniqueName, solutionUniqueName, barrier, deps });
  const debt = found.absent ? [] : found.debt;
  if (barrier) {
    for (const d of debt) {
      const { scopes, ids } = d.targets;
      barrier.registerKnown(scopes, ids);
      const label = `managed ${d.family} "${d.key}"`;
      if (d.kind === 'hold') barrier.hold(d.token, scopes, ids, `${label} (an earlier change is not yet proved)`);
      else if (d.kind === 'uncertain') {
        const pub = store.readGroup(d.family, d.key).committed;
        const p = pub && pub.publication;
        const why = p && UNCERTAIN.has(p.state)
          ? `its publish may have been sent and is not yet confirmed; ${publicationRemedy(p.scope, p.dispatchToken)}`
          : 'a workflow change may have been sent and is not yet confirmed';
        barrier.quarantine(scopes, ids, `${label} (${why})`);
      } else if (d.kind === 'corrupt') {
        // A group whose targets cannot be read cannot be fenced by scope: nothing it may cover can be shown safe.
        if (!scopes.length) throw storeError(CODES.unreadable, `${label} is not usable and names no scope the build could withhold`);
        barrier.quarantine(scopes, ids, `${label} (its stored record is not usable)`);
      }
    }
  }
  return { store, debt, absent: !!found.absent };
}

/**
 * What verify and download may read: the committed, usable groups, their declarations (the feature's
 * `consumerState.declaration`) and, when the committing attempt recorded one, the original authored declaration
 * (`originalDeclaration`). Pending and invalid groups
 * are listed apart and are not verified. Pure: it reads the snapshot it is given and never writes.
 */
function managedManifestView(snapshot) {
  const view = { revision: snapshot ? snapshot.revision : 0, groups: [], pending: [], invalid: [] };
  if (!snapshot) return view;
  for (const unit of snapshot.units()) {
    if (unit.invalid) { view.invalid.push({ family: unit.family, key: unit.key, reason: unit.invalid }); continue; }
    if (unit.attempt) { view.pending.push({ family: unit.family, key: unit.key, code: CODES.pending }); continue; }
    if (!unit.group) continue;
    const g = unit.group;
    view.groups.push({
      family: g.family, key: g.key, generation: g.generation, root: clone(g.root), proofSchema: g.proofSchema,
      records: clone(g.records), proof: clone(g.proof),
      declaration: g.consumerState && g.consumerState.declaration !== undefined ? clone(g.consumerState.declaration) : undefined,
      originalDeclaration: g.originalDeclaration !== undefined ? clone(g.originalDeclaration) : undefined,
      // A configuration group (ROW_FAMILIES) keeps no declaration: verify reads its rows' last confirmed baselines.
      ...(isRowFamily(g.family) ? { rows: clone(g.consumerState.rows) } : {}),
    });
  }
  return view;
}

/**
 * Whether `environment` is one a store can be kept for: an https origin without credentials (page-ownership-records.js
 * environmentFingerprint refuses anything else). A build or verify against any other target never opens or reads one.
 */
function isStoreEnvironment(environment) {
  try {
    const url = new URL(environment);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * What verify reads for one workspace: managedManifestView of the store discovered there (read-only; nothing is created). No store, or
 * a workspace with no folder, is an empty view, and so is a target no store can be kept for (isStoreEnvironment). A store verify cannot
 * trust is not an error of the verify run — it is listed as one invalid entry, so the report says the managed bindings were not verified
 * instead of passing them by silence.
 */
function readManagedManifest(args) {
  if (!isStoreEnvironment(args && args.environment)) return managedManifestView(null);
  try {
    const found = discoverManagedStore(args);
    return managedManifestView(found.absent ? null : found.loaded);
  } catch (e) {
    const view = managedManifestView(null);
    view.invalid.push({ family: 'store', key: 'managed-bindings', reason: e && e.message ? e.message : String(e), code: (e && e.code) || CODES.unreadable });
    return view;
  }
}

module.exports = {
  PREFIX,
  MAX_BYTES,
  PREPARE_RESERVE_BYTES,
  COMPLETION_BASE_BYTES,
  COMPLETION_MAX_BYTES,
  DECLARATION_MAX_BYTES,
  CODES,
  FAMILIES,
  ROW_FAMILIES,
  ROW_TABLE,
  ROW_PROOF_SCHEMA,
  SCHEMA_VERSION_ROWS,
  ROOT_KIND,
  storeFileName,
  parseEnvelope,
  classifyPersisted,
  discoverManagedStore,
  openManagedBindings,
  openManagedContext,
  managedManifestView,
  checkDeclaration,
  checkCompletionBytes,
  readManagedManifest,
  isStoreEnvironment,
  REQUEST_SHAPES,
  attemptProvenUnsent,
  readOnlyCapture,
  resumableCreate,
  rootCreateAcknowledged,
  dashboardCreateAcknowledged,
  dashboardCreateResumable,
  publicationRiskApproval,
  publicationRemedy,
  blockedPublication,
  RETIRED_GROUPS_KEPT,
  INCARNATIONS_KEPT,
};
